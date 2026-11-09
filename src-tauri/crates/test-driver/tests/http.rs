// ABOUTME: Integration tests for the D23 headless test driver's HTTP surface — proves the
// ABOUTME: loopback server dispatches to the real backend commands (open/save), never a mock.

use std::fs;
use std::io::{BufRead, Cursor, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use emend_lib::agent::run_queue::{RunQueue, RunRequest};
use emend_lib::agent::session::{AgentSession, SessionError};
use emend_lib::commands::agent::{DELIVERY_EVENT, DOCUMENT_BIRTH_EVENT};
use emend_lib::commands::project::PROJECT_FILES_EVENT;
use emend_lib::voice::model_download::{
    DownloadFailure, DownloadResponse, DownloadTransport, ResponseRange,
};
use emend_lib::voice::settings::VoiceError;
use emend_lib::{OPEN_DOCUMENT_EVENT, SAVE_DOCUMENT_AS_EVENT};
use tempfile::TempDir;

/// Binds an ephemeral loopback port, serves it on a background thread, and returns the bound
/// address. The thread is not joined: it outlives the test (killed with the test process), which
/// is fine for a per-test throwaway server on its own OS-assigned port.
fn spawn_driver() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || test_driver::serve(listener));
    addr
}

#[test]
fn render_failure_diagnostic_route_reaches_the_fixed_backend_command() {
    let addr = spawn_driver();
    let (status, body) = post(
        addr,
        "/report_render_failure",
        r#"{"input":{"phase":"initial"}}"#,
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "null");
}

#[test]
fn render_failure_diagnostic_route_rejects_unknown_payload_without_echoing_values() {
    let addr = spawn_driver();
    let (status, body) = post(
        addr,
        "/report_render_failure",
        r#"{"input":{"phase":"remount","message":"AcquisitionPlan"}}"#,
    );
    assert_eq!(status, 400, "{body}");
    assert!(!body.contains("AcquisitionPlan"), "{body}");
}

#[test]
fn render_failure_diagnostic_route_rejects_unknown_payload_without_echoing_keys() {
    let addr = spawn_driver();
    let (status, body) = post(
        addr,
        "/report_render_failure",
        r#"{"input":{"phase":"remount","ghp_abc123":"ordinary"}}"#,
    );
    assert_eq!(status, 400, "{body}");
    assert!(!body.contains("ghp_abc123"), "{body}");
}

/// A spawner that never actually spawns a process — mirrors `agent::run_queue`'s and
/// `commands::agent`'s own test doubles of the same name. P2a integration (#345): the agent-run
/// tests below drive the driver through `serve_with_queue` with this injected instead of the real
/// `spawn_claude_run` `spawn_driver` above wires — see `serve_with_queue`'s own docs for why
/// spawning the real CLI from `cargo test` is never acceptable.
fn always_fails(_request: &RunRequest) -> Result<AgentSession, SessionError> {
    Err(SessionError::Spawn(std::io::Error::other(
        "no such provider in this test",
    )))
}

/// Like [`spawn_driver`], but serving `queue` (P2a integration #345's agent-run coverage) instead
/// of a fresh real-`spawn_claude_run` one.
fn spawn_driver_with_queue(queue: RunQueue) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || test_driver::serve_with_queue(listener, queue));
    addr
}

/// Builds the workspace's real `fake-agent` binary once — the same cross-platform stand-in
/// `src-tauri/tests/common::fake_agent_bin` uses for a `claude` process elsewhere in this
/// workspace, reused here as [`ChildDriver::spawn_with_fake_claude_on_path`]'s payload since it is
/// a genuine, safe-to-run native executable on every platform this project ships (no network I/O;
/// without `--scenario` it errors out on stderr and exits immediately). Mirrors that helper's own
/// `--release` branch (`src-tauri/tests/common/mod.rs`) so a `cargo test --release` run finds the
/// binary it just built instead of a stale (or absent) debug one.
fn built_fake_agent_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let workspace_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
        let mut build = Command::new(env!("CARGO"));
        build.args([
            "build",
            "--manifest-path",
            workspace_manifest.to_str().expect("manifest path is utf8"),
            "--package",
            "fake-agent",
            "--bin",
            "fake-agent",
        ]);
        if !cfg!(debug_assertions) {
            build.arg("--release");
        }
        let status = build.status().expect("run cargo build for fake-agent");
        assert!(status.success(), "failed to build the fake-agent binary");

        let exe = std::env::current_exe().expect("this test binary's own path");
        let mut dir = exe
            .parent()
            .expect("test binary has a parent dir")
            .to_path_buf();
        if dir.ends_with("deps") {
            dir.pop();
        }
        let name = if cfg!(windows) {
            "fake-agent.exe"
        } else {
            "fake-agent"
        };
        dir.join(name)
    })
    .clone()
}

/// The real `test-driver` binary (`src/main.rs` — the exact one Playwright's e2e config runs),
/// spawned as a genuine child process rather than run in-thread like [`spawn_driver`]. Only this
/// gives a test a `PATH` to plant a fake `claude` on without mutating *this test process's* own
/// environment: `std::env::set_var`/`remove_var` on a shared process is unsound the moment another
/// thread reads env concurrently (std's own Safety doc — "the only sound option is to not use
/// `set_var` or `remove_var` in multi-threaded programs at all"), and `cargo test` runs every test
/// in this binary, including this one's ~40 siblings, as threads sharing one process — several of
/// which read the environment on every `TempDir::new()` call (`tempfile::env::temp_dir()` →
/// `std::env::temp_dir()` → a `TMPDIR` lookup). The variable read need not be the one written:
/// std's Safety text forbids *any* concurrent env reader, not only readers of `PATH`. A child
/// process's environment is set once at spawn and never touched again, so no such race exists here
/// (#1149 PR review, round 2).
struct ChildDriver {
    child: std::process::Child,
    addr: SocketAddr,
    _stderr: std::process::ChildStderr,
    _bin_dir: Option<TempDir>,
}

impl ChildDriver {
    /// Spawns the real `test-driver` binary against an OS-assigned ephemeral port (`0`), reading
    /// its actual bound address off the startup line it already prints on `stderr`
    /// (`src/main.rs`) rather than guessing a port and racing the child for it. `path` becomes
    /// *that child's* `PATH` and nothing else's.
    fn spawn(path: impl AsRef<std::ffi::OsStr>) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_test-driver"))
            .arg("0")
            .env("PATH", path)
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn the real test-driver binary");

        let stderr = child.stderr.take().expect("piped stderr");
        let mut reader = std::io::BufReader::new(stderr);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("read the driver's startup line");
        let addr: SocketAddr = line
            .trim()
            .strip_prefix("test-driver: listening on http://")
            .unwrap_or_else(|| panic!("unexpected test-driver startup line: {line:?}"))
            .parse()
            .expect("parse the driver's bound address");

        Self {
            child,
            addr,
            _stderr: reader.into_inner(),
            _bin_dir: None,
        }
    }

    /// [`Self::spawn`] with a genuine, runnable `claude`/`claude.exe` (a copy of the real
    /// `fake-agent` binary, [`built_fake_agent_bin`]) prepended onto the *child's* `PATH` —
    /// proves #1149's guard refuses even when the hazard's actual precondition holds ("`claude`
    /// genuinely on `PATH`", the issue's own testing note), rather than only when a CI box happens
    /// to lack one. If the guard were ever bypassed, the worst outcome is a fast, side-effect-free
    /// failure — never a real network call.
    fn spawn_with_fake_claude_on_path() -> Self {
        let bin_dir = TempDir::new().expect("temp bin dir");
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        fs::copy(built_fake_agent_bin(), bin_dir.path().join(name))
            .expect("copy fake-agent into place as claude");

        let mut dirs: Vec<PathBuf> = vec![bin_dir.path().to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&existing));
        }
        let path = std::env::join_paths(dirs).expect("join PATH entries");

        let mut driver = Self::spawn(path);
        driver._bin_dir = Some(bin_dir);
        driver
    }
}

impl Drop for ChildDriver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A minimal hand-rolled HTTP/1.1 client: writes one request, reads the whole response, and
/// splits status/headers/body. The driver only ever needs POST/OPTIONS + Content-Length, so a
/// full HTTP client dependency isn't warranted for testing it.
fn request(method: &str, addr: SocketAddr, path: &str, body: &str) -> (u16, Vec<String>, String) {
    let mut stream = TcpStream::connect(addr).expect("connect to driver");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).expect("send request");

    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    let mut sections = response.splitn(2, "\r\n\r\n");
    let head = sections.next().unwrap_or("");
    let response_body = sections.next().unwrap_or("").to_string();
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("status line");
    let headers = lines.map(|l| l.to_string()).collect();
    (status, headers, response_body)
}

fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, String) {
    let (status, _, body) = request("POST", addr, path, body);
    (status, body)
}

#[test]
fn open_document_round_trips_the_files_exact_text_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello\n").unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/open_document",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md" }).to_string(),
    );

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["content"], "hello\n");
}

#[test]
fn save_document_without_an_open_project_writes_content_verbatim_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, _) = post(
        addr,
        "/save_document",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md", "content": "new content\n" })
            .to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(
        fs::read_to_string(dir.path().join("doc.md")).unwrap(),
        "new content\n"
    );
}

#[test]
fn save_document_normalizes_crlf_to_lf_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, _) = post(
        addr,
        "/save_document",
        &serde_json::json!({
            "root": dir.path(),
            "path": "doc.md",
            "content": "line one\r\nline two\r\n",
            "normalizeLineEndings": true,
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(
        fs::read_to_string(dir.path().join("doc.md")).unwrap(),
        "line one\nline two\n"
    );
}

#[test]
fn save_document_returns_the_written_revision_through_http() {
    // The D23 surface is the dev-mode frontend's real save path (`editor/ipc.ts`'s fallback), so
    // the revision the shell re-declares after a save (#1121) has to survive this transport too —
    // and it must be the same string `/open_document` reports for the bytes that landed.
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/save_document",
        &serde_json::json!({
            "root": dir.path(),
            "path": "doc.md",
            "content": "line one\r\nline two\r\n",
            "normalizeLineEndings": true,
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    let revision: serde_json::Value = serde_json::from_str(&body).unwrap();
    let (_, opened) = post(
        addr,
        "/open_document",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md" }).to_string(),
    );
    let opened: serde_json::Value = serde_json::from_str(&opened).unwrap();
    assert!(
        revision.is_string(),
        "revision should be a JSON string: {revision}"
    );
    assert_eq!(revision, opened["revision"]);
}

#[test]
fn save_document_for_a_foreign_root_still_writes_through_http() {
    let open = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let addr = spawn_driver();
    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": open.path() }).to_string(),
        )
        .0,
        200
    );

    let (status, _) = post(
        addr,
        "/save_document",
        &serde_json::json!({
            "root": other.path(),
            "path": "doc.md",
            "content": "last edits\n",
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(
        fs::read_to_string(other.path().join("doc.md")).unwrap(),
        "last edits\n"
    );
}

#[test]
fn current_project_hydration_uses_the_same_driver_session_as_open_project() {
    let project = TempDir::new().unwrap();
    let addr = spawn_driver();
    assert_eq!(post(addr, "/current_project", "{}").1, "null");
    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": project.path() }).to_string(),
        )
        .0,
        200
    );

    let (status, body) = post(addr, "/current_project", "{}");
    assert_eq!(status, 200);
    let root: String = serde_json::from_str(&body).unwrap();
    assert_eq!(
        PathBuf::from(root).canonicalize().unwrap(),
        project.path().canonicalize().unwrap()
    );
}

#[test]
fn save_document_rejects_an_escaping_path_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/save_document",
        &serde_json::json!({ "root": dir.path(), "path": "../escape.md", "content": "x" })
            .to_string(),
    );

    assert_eq!(status, 422);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["kind"], "InvalidPath");
}

#[test]
fn an_invalid_path_returns_422_with_the_command_error_shape() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/open_document",
        &serde_json::json!({ "root": dir.path(), "path": "../escape.md" }).to_string(),
    );

    assert_eq!(status, 422);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["kind"], "InvalidPath");
}

#[test]
fn save_tab_session_then_load_tab_session_round_trips_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (begin_status, opened) = post(
        addr,
        "/begin_tab_session",
        &serde_json::json!({
            "root": dir.path(),
            "writerId": "http-writer",
            "attachmentId": "http-attachment",
        })
        .to_string(),
    );
    assert_eq!(begin_status, 200);
    let opened: serde_json::Value = serde_json::from_str(&opened).unwrap();

    let (save_status, receipt) = post(
        addr,
        "/save_tab_session",
        &serde_json::json!({
            "root": dir.path(),
            "writerId": "http-writer",
            "attachmentId": opened["attachmentId"],
            "expectedRevision": opened["revision"],
            "policy": "background",
            "session": {
                "tabs": [
                    { "path": "a.md", "unsavedContent": null },
                    { "path": "b.md", "unsavedContent": "unsaved b" },
                ],
                "activePath": "b.md",
            },
        })
        .to_string(),
    );
    assert_eq!(save_status, 200);
    let receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(receipt["outcomes"][1]["status"], "persisted_exact");

    let (load_status, body) = post(
        addr,
        "/load_tab_session",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );

    assert_eq!(load_status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["activePath"], "b.md");
    assert_eq!(payload["tabs"][1]["unsavedContent"], "unsaved b");
}

#[test]
fn load_tab_session_for_a_project_with_no_saved_session_returns_an_empty_one() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/load_tab_session",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["tabs"], serde_json::json!([]));
    assert_eq!(payload["activePath"], serde_json::Value::Null);
}

#[test]
fn capture_anchor_returns_the_selected_slice_and_its_base_revision_through_http() {
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/capture_anchor",
        &serde_json::json!({ "content": "before HELLO after", "utf16Offset": 7, "utf16Length": 5 })
            .to_string(),
    );

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["offset"], 7);
    assert_eq!(payload["text_snapshot"], "HELLO");
    assert!(payload["base_revision"].is_string());
}

#[test]
fn resolve_anchor_returns_the_utf16_position_through_http() {
    let addr = spawn_driver();

    let (capture_status, capture_body) = post(
        addr,
        "/capture_anchor",
        &serde_json::json!({ "content": "before HELLO after", "utf16Offset": 7, "utf16Length": 5 })
            .to_string(),
    );
    assert_eq!(capture_status, 200);
    let anchor: serde_json::Value = serde_json::from_str(&capture_body).unwrap();

    let (status, body) = post(
        addr,
        "/resolve_anchor",
        &serde_json::json!({ "content": "before HELLO after", "anchor": anchor }).to_string(),
    );

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["from"], 7);
    assert_eq!(payload["to"], 12);
}

#[test]
fn resolve_anchor_returns_null_through_http_when_the_live_text_has_moved_on() {
    let addr = spawn_driver();

    let (_, capture_body) = post(
        addr,
        "/capture_anchor",
        &serde_json::json!({ "content": "before HELLO after", "utf16Offset": 7, "utf16Length": 5 })
            .to_string(),
    );
    let anchor: serde_json::Value = serde_json::from_str(&capture_body).unwrap();

    let (status, body) = post(
        addr,
        "/resolve_anchor",
        &serde_json::json!({ "content": "before WORLDS after", "anchor": anchor }).to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(body, "null");
}

#[test]
fn an_unknown_command_returns_404() {
    let addr = spawn_driver();

    let (status, _) = post(addr, "/no_such_command", "{}");

    assert_eq!(status, 404);
}

#[test]
fn a_non_post_method_returns_405() {
    let addr = spawn_driver();
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .write_all(b"GET /open_document HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();

    assert!(response.starts_with("HTTP/1.1 405"));
}

/// The dev-mode e2e caller is the per-run Vite loopback page (`src/editor/ipc.ts` falling back to
/// this driver, D23) fetching the driver's *different* per-run loopback origin — the browser always
/// preflights a cross-origin POST with JSON content type, and refuses the real request unless the
/// driver answers both the preflight and the real response with CORS headers.
#[test]
fn a_cors_preflight_options_request_succeeds_with_the_allow_headers() {
    let addr = spawn_driver();

    let (status, headers, _) = request("OPTIONS", addr, "/open_document", "");

    assert_eq!(status, 204);
    assert!(headers
        .iter()
        .any(|h| h == "Access-Control-Allow-Origin: *"));
    assert!(headers
        .iter()
        .any(|h| h.starts_with("Access-Control-Allow-Methods:") && h.contains("POST")));
    assert!(headers
        .iter()
        .any(|h| h.starts_with("Access-Control-Allow-Headers:") && h.contains("Content-Type")));
}

#[test]
fn a_post_response_carries_the_cors_allow_origin_header() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hi\n").unwrap();
    let addr = spawn_driver();

    let (_, headers, _) = request(
        "POST",
        addr,
        "/open_document",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md" }).to_string(),
    );

    assert!(headers
        .iter()
        .any(|h| h == "Access-Control-Allow-Origin: *"));
}

// --- comments (P2b-11c: J4's e2e journeys drive `commands::comments` through here) -------------

#[test]
fn create_comment_then_load_comment_threads_round_trips_the_anchor_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (create_status, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(),
            "path": "doc.md",
            "author": "alice",
            "body": "why here?",
            "anchor": { "content": "hello world\n", "utf16Offset": 6, "utf16Length": 5 },
            "timestamp": 0,
        })
        .to_string(),
    );
    assert_eq!(create_status, 200);
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    assert_eq!(created[0]["anchor"]["text_snapshot"], "world");
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    let (load_status, load_body) = post(
        addr,
        "/load_comment_threads",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md" }).to_string(),
    );
    assert_eq!(load_status, 200);
    let loaded: serde_json::Value = serde_json::from_str(&load_body).unwrap();
    assert_eq!(loaded[0]["id"], thread_id);
    assert_eq!(loaded[0]["resolved"], false);
}

#[test]
fn start_address_run_forwards_exact_include_ids_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails));
    let (_, created_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "one",
            "anchor": null, "timestamp": 1,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&created_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap();
    let request = |include: Option<Vec<&str>>| {
        let mut body = serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadIds": [thread_id],
            "author": "alice", "timestamp": 2, "prompt": "batch",
            "referenceData": "", "batch": true, "guidance": null,
        });
        if let Some(ids) = include {
            body["includeHeldThreadIds"] = serde_json::json!(ids);
        }
        post(addr, "/start_address_run", &body.to_string())
    };
    let (invalid_status, invalid_body) = request(Some(vec!["outside-target-set"]));
    assert_eq!(invalid_status, 422, "{invalid_body}");
    let (loaded_status, loaded_body) = post(
        addr,
        "/load_comment_threads",
        &serde_json::json!({"root": dir.path(), "path": "doc.md"}).to_string(),
    );
    assert_eq!(loaded_status, 200);
    let loaded: serde_json::Value = serde_json::from_str(&loaded_body).unwrap();
    assert!(loaded[0]["pending_runs"].as_array().unwrap().is_empty());
    let (default_status, default_body) = request(None);
    assert_eq!(default_status, 200, "{default_body}");
    let admitted: serde_json::Value = serde_json::from_str(&default_body).unwrap();
    assert_eq!(
        admitted["progress"]["addressed"],
        serde_json::json!([thread_id])
    );
}

/// The full single-thread J4 lifecycle through http alone: address (pending) -> link a delivered
/// change + an explanatory reply -> accept resolves the thread (FR-CMT-2/3/7).
#[test]
fn address_with_ai_link_changes_and_accept_resolve_the_thread_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (_, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "why here?",
            "anchor": serde_json::Value::Null, "timestamp": 0,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    let (address_status, address_body) = post(
        addr,
        "/address_with_ai",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 1, "runId": "run-1", "guidance": serde_json::Value::Null,
        })
        .to_string(),
    );
    assert_eq!(address_status, 200);
    let pending: serde_json::Value = serde_json::from_str(&address_body).unwrap();
    assert_eq!(pending[0]["pending_run"], "run-1");

    let (_, link_body) = post(
        addr,
        "/link_changes",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "agent",
            "timestamp": 2, "changeIds": ["chg-1"],
        })
        .to_string(),
    );
    let linked: serde_json::Value = serde_json::from_str(&link_body).unwrap();
    assert_eq!(linked[0]["pending_run"], serde_json::Value::Null);
    assert_eq!(linked[0]["linked_changes"][0]["change_id"], "chg-1");

    let (decide_status, decide_body) = post(
        addr,
        "/decide_linked_changes",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 3, "changeIds": ["chg-1"], "decision": "accept",
        })
        .to_string(),
    );
    assert_eq!(decide_status, 200);
    let decided: serde_json::Value = serde_json::from_str(&decide_body).unwrap();
    assert_eq!(decided[0]["resolved"], true);
}

/// FR-CMT-4: a defense reply concludes the pending run without linking any change, and the reply
/// itself carries the durable `defense`/`published` flags across http exactly as the direct
/// command-layer unit tests pin.
#[test]
fn reply_comment_as_a_defense_concludes_the_pending_run_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (_, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "why here?",
            "anchor": serde_json::Value::Null, "timestamp": 0,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    post(
        addr,
        "/address_with_ai",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 1, "runId": "run-1", "guidance": serde_json::Value::Null,
        })
        .to_string(),
    );

    let (reply_status, reply_body) = post(
        addr,
        "/reply_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "agent",
            "body": "the wording is already correct", "defense": true, "published": true,
            "timestamp": 2,
        })
        .to_string(),
    );
    assert_eq!(reply_status, 200);
    let after: serde_json::Value = serde_json::from_str(&reply_body).unwrap();
    assert_eq!(after[0]["pending_run"], serde_json::Value::Null);
    assert_eq!(after[0]["replies"][0]["defense"], true);
    assert_eq!(after[0]["replies"][0]["published"], true);
}

/// issue #1381, ux-design.md §2's exit table: a run stopped from the run card clears `pending_run`
/// through the real `/conclude_address_run` HTTP route, not just the direct Rust call the store's
/// own unit suite already exercises — this is the production IPC edge (the composition an actual
/// frontend reaches).
#[test]
fn conclude_address_run_stopped_clears_pending_and_carries_the_note_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (_, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "why here?",
            "anchor": serde_json::Value::Null, "timestamp": 0,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    post(
        addr,
        "/address_with_ai",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 1, "runId": "run-1", "guidance": serde_json::Value::Null,
        })
        .to_string(),
    );

    let (status, body) = post(
        addr,
        "/conclude_address_run",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 2, "runId": "run-1", "outcome": "stopped",
        })
        .to_string(),
    );
    assert_eq!(status, 200);
    let after: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(after[0]["pending_run"], serde_json::Value::Null);
    assert_eq!(after[0]["concluded_run"]["run_id"], "run-1");
    assert_eq!(after[0]["concluded_run"]["outcome"], "stopped");

    // The negative case this route exists to guard: a conclusion naming a run this thread has since
    // moved past (a re-delegation already minted a new id) must be rejected as a no-op rather than
    // clearing the *new* run's pending state.
    post(
        addr,
        "/address_with_ai",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 3, "runId": "run-2", "guidance": serde_json::Value::Null,
        })
        .to_string(),
    );
    let (_, stale_body) = post(
        addr,
        "/conclude_address_run",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 4, "runId": "run-1", "outcome": "failed",
        })
        .to_string(),
    );
    let stale: serde_json::Value = serde_json::from_str(&stale_body).unwrap();
    assert_eq!(
        stale[0]["pending_run"], "run-2",
        "a stale conclusion for the superseded run-1 must not touch run-2's still-live pending state"
    );
}

/// issue #1381's startup-reconciliation half, through the real `/load_comment_threads` route: a
/// marker whose `run_id` this driver's own `RunQueue` never spawned (the D23 equivalent of "a fresh
/// process's queue starts empty" — this driver's queue simply never ran it) is reconciled to failed
/// the moment the document next loads.
#[test]
fn load_comment_threads_reconciles_a_pending_run_the_driver_never_spawned_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (_, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "why here?",
            "anchor": serde_json::Value::Null, "timestamp": 0,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    // Stamps the thread pending against a run id this driver's queue never spawned (mirrors what a
    // stale sidecar left on disk from a previous process looks like — `/address_with_ai` only ever
    // writes the store event, it never touches the queue itself).
    post(
        addr,
        "/address_with_ai",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "you",
            "timestamp": 1, "runId": "run-orphaned", "guidance": serde_json::Value::Null,
        })
        .to_string(),
    );

    let (status, body) = post(
        addr,
        "/load_comment_threads",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md" }).to_string(),
    );
    assert_eq!(status, 200);
    let reloaded: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        reloaded[0]["pending_run"],
        serde_json::Value::Null,
        "a marker with no live run behind it must not read Working forever"
    );
    assert_eq!(reloaded[0]["concluded_run"]["outcome"], "failed");
}

/// Seeds `n` document-level threads through the driver and returns their ids in load order — the
/// batch tests all need a set of open threads before they can address anything.
fn seed_open_threads(addr: SocketAddr, root: &std::path::Path, n: i64) -> Vec<String> {
    for i in 0..n {
        post(
            addr,
            "/create_comment",
            &serde_json::json!({
                "root": root, "path": "doc.md", "author": "alice",
                "body": format!("finding {i}"), "anchor": serde_json::Value::Null, "timestamp": i,
            })
            .to_string(),
        );
    }
    let (_, loaded_body) = post(
        addr,
        "/load_comment_threads",
        &serde_json::json!({ "root": root, "path": "doc.md" }).to_string(),
    );
    let loaded: serde_json::Value = serde_json::from_str(&loaded_body).unwrap();
    loaded
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect()
}

/// Arms the driver's one-shot batch fault window (#538): the next batch may land `fail_after`
/// appends before its sidecar goes read-only under it.
fn arm_batch_address_fault(addr: SocketAddr, fail_after: usize) -> (u16, String) {
    post(
        addr,
        "/arm_batch_address_fault",
        &serde_json::json!({ "failAfter": fail_after }).to_string(),
    )
}

/// Posts one `/address_all_with_ai` batch and returns its status alongside the parsed outcome —
/// the call every batch test below makes, differing only in targets and run id.
fn address_all(
    addr: SocketAddr,
    root: &std::path::Path,
    thread_ids: &[String],
    timestamp: i64,
    run_id: &str,
) -> (u16, serde_json::Value) {
    let (status, body) = post(
        addr,
        "/address_all_with_ai",
        &serde_json::json!({
            "root": root, "path": "doc.md", "threadIds": thread_ids, "author": "you",
            "timestamp": timestamp, "runId": run_id,
        })
        .to_string(),
    );
    (status, serde_json::from_str(&body).unwrap())
}

/// J4 batch (P2b-3a/#350, FR-CMT-5/FR-AGENT-6): one `address_all_with_ai` call marks every
/// targeted open thread pending under the same run id and reports the accounting.
#[test]
fn address_all_with_ai_batches_every_open_thread_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();
    let thread_ids = seed_open_threads(addr, dir.path(), 2);
    assert_eq!(thread_ids.len(), 2);

    let (status, outcome) = address_all(addr, dir.path(), &thread_ids, 10, "batch-1");

    assert_eq!(status, 200);
    assert_eq!(outcome["addressed"], serde_json::json!(thread_ids));
    assert_eq!(outcome["interrupted"], serde_json::Value::Null);
    assert_eq!(outcome["run_id"], "batch-1");
}

/// FR-AGENT-6 end to end over the driver (#538): arming the one-shot fault window makes the very
/// next batch stop after the named number of appends — a real store write failure, not a mocked
/// one — and the accounting names what completed and what was never started.
#[test]
fn an_armed_fault_window_makes_the_next_batch_stop_early_and_report_the_partial_truth() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();
    let thread_ids = seed_open_threads(addr, dir.path(), 3);

    let (arm_status, _) = arm_batch_address_fault(addr, 1);
    assert_eq!(arm_status, 200);

    let (status, outcome) = address_all(addr, dir.path(), &thread_ids, 10, "batch-1");

    assert_eq!(
        status, 200,
        "a stopped batch is a reported outcome, never a failed call"
    );
    assert_eq!(outcome["addressed"], serde_json::json!([thread_ids[0]]));
    assert_eq!(
        outcome["untouched"],
        serde_json::json!([thread_ids[1], thread_ids[2]]),
        "the thread whose write failed, and everything after it, were never started"
    );
    assert!(
        outcome["interrupted"].is_string(),
        "the run says why it stopped: {outcome}"
    );
}

/// The window is one-shot and self-repairing: it belongs to the single batch it was armed for, so
/// the retry a user makes after an interruption completes the threads left untouched (J4/#538).
#[test]
fn the_fault_window_is_consumed_by_one_batch_so_a_retry_completes_the_untouched_threads() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("doc.md"), "hello world\n").unwrap();
    let addr = spawn_driver();
    let thread_ids = seed_open_threads(addr, dir.path(), 3);

    arm_batch_address_fault(addr, 1);
    let (_, first) = address_all(addr, dir.path(), &thread_ids, 10, "batch-1");
    let untouched: Vec<String> = first["untouched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();

    let (status, retry) = address_all(addr, dir.path(), &untouched, 20, "batch-2");

    assert_eq!(status, 200);
    assert_eq!(retry["addressed"], serde_json::json!(untouched));
    assert_eq!(
        retry["interrupted"],
        serde_json::Value::Null,
        "the fault died with the batch it was armed for"
    );
}

/// Manual resolve/reopen (FR-CMT-1) and re-anchor (D17/J4) round-trip through http too.
#[test]
fn resolve_reopen_and_re_anchor_round_trip_through_http() {
    let dir = TempDir::new().unwrap();
    let content = "Hello world, this stays put as anchor context padding";
    fs::write(dir.path().join("doc.md"), content).unwrap();
    let addr = spawn_driver();

    let (_, create_body) = post(
        addr,
        "/create_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "author": "alice", "body": "x",
            "anchor": { "content": content, "utf16Offset": 0, "utf16Length": 5 }, "timestamp": 0,
        })
        .to_string(),
    );
    let created: serde_json::Value = serde_json::from_str(&create_body).unwrap();
    let thread_id = created[0]["id"].as_str().unwrap().to_string();

    let (resolve_status, resolve_body) = post(
        addr,
        "/resolve_comment",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "alice", "timestamp": 1 })
            .to_string(),
    );
    assert_eq!(resolve_status, 200);
    let resolved: serde_json::Value = serde_json::from_str(&resolve_body).unwrap();
    assert_eq!(resolved[0]["resolved"], true);

    let (reopen_status, reopen_body) = post(
        addr,
        "/reopen_comment",
        &serde_json::json!({ "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "bob", "timestamp": 2 })
            .to_string(),
    );
    assert_eq!(reopen_status, 200);
    let reopened: serde_json::Value = serde_json::from_str(&reopen_body).unwrap();
    assert_eq!(reopened[0]["resolved"], false);

    let rewritten = "A totally different paragraph replaces every single word in here now.";
    fs::write(dir.path().join("doc.md"), rewritten).unwrap();

    let (reanchor_status, reanchor_body) = post(
        addr,
        "/re_anchor_comment",
        &serde_json::json!({
            "root": dir.path(), "path": "doc.md", "threadId": thread_id, "author": "alice",
            "timestamp": 3,
            "anchor": { "content": rewritten, "utf16Offset": 2, "utf16Length": 7 },
        })
        .to_string(),
    );
    assert_eq!(reanchor_status, 200);
    let reanchored: serde_json::Value = serde_json::from_str(&reanchor_body).unwrap();
    assert_eq!(reanchored[0]["orphaned"], false);
    assert_eq!(reanchored[0]["anchor"]["text_snapshot"], "totally");
}

/// P2a integration (#345): the D23 driver's `/run_state` poll is how a headless e2e script (no
/// GUI, no `agent://activity` push transport) observes an agent run — this is the acceptance
/// criteria's own required coverage that the driver "must be able to observe the same run state".
#[test]
fn run_state_on_a_fresh_driver_reports_no_active_no_queued_and_no_last_finished() {
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails as fn(&RunRequest) -> _));

    let (status, body) = post(addr, "/run_state", "{}");

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["active"], serde_json::Value::Null);
    assert_eq!(payload["queued"], serde_json::json!([]));
    assert_eq!(payload["finished"], serde_json::json!([]));
    assert!(payload.get("lastFinished").is_some());
    assert_eq!(payload["lastFinished"], serde_json::Value::Null);
    assert!(payload.get("last_finished").is_none());
}

#[test]
fn start_run_then_run_state_observes_the_run_resolve_to_failed_when_the_provider_never_spawns() {
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails as fn(&RunRequest) -> _));

    let (start_status, start_body) = post(
        addr,
        "/start_run",
        &serde_json::json!({
            "root": "/tmp/some-project",
            "prompt": "revise the opening",
            "operationTargets": []
        })
        .to_string(),
    );
    assert_eq!(start_status, 200);
    let start: serde_json::Value = serde_json::from_str(&start_body).unwrap();
    assert_eq!(start["queuedPosition"], serde_json::Value::Null);

    let (state_status, state_body) = post(addr, "/run_state", "{}");
    assert_eq!(state_status, 200);
    let payload: serde_json::Value = serde_json::from_str(&state_body).unwrap();
    assert_eq!(payload["active"]["id"], start["id"]);
    assert_eq!(payload["active"]["phase"]["phase"], "failed");
    assert_eq!(payload["active"]["activity"], serde_json::json!([]));
}

#[test]
fn run_state_preserves_two_terminals_that_finish_between_http_polls_in_order() {
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails as fn(&RunRequest) -> _));
    let start_body = |prompt: &str| {
        serde_json::json!({
            "root": "/tmp/some-project",
            "prompt": prompt,
            "operationTargets": []
        })
        .to_string()
    };

    let (first_status, first_body) = post(addr, "/start_run", &start_body("first"));
    let (second_status, second_body) = post(addr, "/start_run", &start_body("second"));
    assert_eq!(first_status, 200);
    assert_eq!(second_status, 200);
    let first: serde_json::Value = serde_json::from_str(&first_body).unwrap();
    let second: serde_json::Value = serde_json::from_str(&second_body).unwrap();

    let (state_status, state_body) = post(addr, "/run_state", "{}");
    assert_eq!(state_status, 200);
    let payload: serde_json::Value = serde_json::from_str(&state_body).unwrap();
    assert_eq!(payload["finished"][0]["id"], first["id"]);
    assert_eq!(payload["finished"][1]["id"], second["id"]);
    assert_eq!(payload["finished"][0]["phase"]["phase"], "failed");
    assert_eq!(payload["finished"][1]["phase"]["phase"], "failed");
    assert_eq!(payload["lastFinished"]["id"], second["id"]);
    assert!(payload.get("last_finished").is_none());
}

/// #1149's own regression test: drives `/start_run` through the *real* [`serve`](test_driver::serve)
/// path (spawned as a genuine child process, [`ChildDriver`] — not `serve_with_queue`'s injected
/// `always_fails` double every other agent-run test here uses, and not this test process's own
/// thread like [`spawn_driver`]) with a project actually open — [`spawn_claude_run`]'s real
/// precondition for ever reaching `claude_invocation`/`PATH` at all (`bound_server`,
/// `src/commands/agent.rs`; #472) — and a genuine, runnable `claude` binary on that child's `PATH`.
/// That is the exact hazard condition the issue names, held in full: every dev box has a
/// real `claude` on `PATH`, and an e2e script opens a project before starting a run. Before #1149's
/// fix this would have spawned it for real, billing a provider turn; the fail-closed guard must
/// refuse before that ever happens, regardless of what's on `PATH` or whether a project is open —
/// proven here by holding both halves of the precondition, so a regression that deletes or reorders
/// the guard would fail this test by actually reaching the planted `claude` binary rather than by
/// failing to open a project first (#1149 PR review, round 2: the original version of this test
/// held neither half, so the plant never influenced its outcome).
///
/// [`spawn_claude_run`]: emend_lib::commands::agent::spawn_claude_run
#[test]
fn start_run_through_serve_never_spawns_the_real_claude_cli_even_when_one_is_genuinely_on_path() {
    let dir = TempDir::new().expect("project dir");
    let driver = ChildDriver::spawn_with_fake_claude_on_path();

    let (open_status, open_body) = post(
        driver.addr,
        "/open_project",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );
    assert_eq!(open_status, 200, "{open_body}");

    let (start_status, start_body) = post(
        driver.addr,
        "/start_run",
        &serde_json::json!({
            "root": dir.path(),
            "prompt": "revise the opening",
            "operationTargets": []
        })
        .to_string(),
    );
    assert_eq!(start_status, 200);
    let start: serde_json::Value = serde_json::from_str(&start_body).unwrap();

    let (state_status, state_body) = post(driver.addr, "/run_state", "{}");
    assert_eq!(state_status, 200);
    let payload: serde_json::Value = serde_json::from_str(&state_body).unwrap();
    assert_eq!(payload["active"]["id"], start["id"]);
    assert_eq!(payload["active"]["phase"]["phase"], "failed");
    let message = payload["active"]["phase"]["message"]
        .as_str()
        .expect("failed phase carries a message");
    assert!(
        message.contains("#1149"),
        "expected the fail-closed guard's own refusal (never the real `claude` CLI actually \
         running, and never bound_server's \"no project is open\" — a project genuinely is), \
         got: {message}"
    );
}

#[test]
fn start_run_rejects_a_blank_prompt_with_422_before_ever_touching_the_queue() {
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails as fn(&RunRequest) -> _));

    let (status, body) = post(
        addr,
        "/start_run",
        &serde_json::json!({
            "root": "/tmp/some-project",
            "prompt": "   ",
            "operationTargets": []
        })
        .to_string(),
    );

    assert_eq!(status, 422);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["kind"], "InvalidArguments");

    let (_, state_body) = post(addr, "/run_state", "{}");
    let state: serde_json::Value = serde_json::from_str(&state_body).unwrap();
    assert_eq!(
        state["active"],
        serde_json::Value::Null,
        "an invalid request never reaches the queue"
    );
}

#[test]
fn stop_run_against_an_unknown_run_id_reports_not_found() {
    let addr = spawn_driver_with_queue(RunQueue::new(always_fails as fn(&RunRequest) -> _));

    let (status, body) = post(
        addr,
        "/stop_run",
        &serde_json::json!({ "runId": "no-such-run" }).to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(body, "\"not_found\"");
}

#[test]
fn create_document_writes_the_file_and_returns_its_normalized_path_and_size_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/create_document",
        &serde_json::json!({
            "root": dir.path(),
            "path": "./drafts/outline.md",
            "content": "# Outline\n\nOnce upon a time.\n",
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["path"], "drafts/outline.md");
    assert_eq!(payload["size"], "# Outline\n\nOnce upon a time.\n".len());
    assert_eq!(
        fs::read_to_string(dir.path().join("drafts/outline.md")).unwrap(),
        "# Outline\n\nOnce upon a time.\n"
    );
}

#[test]
fn create_document_and_propose_changes_publish_ordered_production_events() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "hello\n").unwrap();
    let addr = spawn_driver();
    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": dir.path() }).to_string()
        )
        .0,
        200
    );

    // #2282's originally filed mechanism (a peer test case's events leaking onto this read) is
    // refuted: each `spawn_driver()` owns a private `Arc<DriverEventLog>`, and `project_opened()`
    // resets it on every `/open_project` (PR #2291 review). The real interferer is THIS test's own
    // project-files watcher: `/create_document` and `/propose_changes` both write under the
    // watched root, so `DocWatcher`'s `AutomaticRefresh` (a 150ms `QuietWindowScheduler`) publishes
    // `PROJECT_FILES_EVENT` `started`/`completed` notices into this same log, interleaved with the
    // two production events this test cares about. A cursor/epoch baseline cannot out-position that
    // race: it is captured before both commands run, so every watcher notice they cause still lands
    // inside the retained window (verified: the old scoped read still returned 4 events, not 2,
    // once the watcher's quiet window had elapsed). So this scopes by production event KIND
    // instead of by position — the driver already tags every notice with its event name, and
    // filtering to just `DOCUMENT_BIRTH_EVENT`/`DELIVERY_EVENT` is immune to how many
    // `PROJECT_FILES_EVENT` notices land in between. The baseline epoch is still captured (the
    // driver's own idiom — see `menu_requests_use_the_shared_rust_event_names_and_do_not_block_
    // each_other` below) so the final read can use a bounded, condition-based long poll
    // (`waitMs`) rather than assuming both production events have already landed.
    let (baseline_status, baseline_body) = post(addr, "/events", r#"{"cursor":0,"waitMs":0}"#);
    assert_eq!(baseline_status, 200, "{baseline_body}");
    let baseline: serde_json::Value = serde_json::from_str(&baseline_body).unwrap();
    let epoch = baseline["epoch"].as_str().unwrap().to_string();

    assert_eq!(
        post(
            addr,
            "/create_document",
            &serde_json::json!({
                "root": dir.path(), "path": "born.md", "content": "born\n"
            })
            .to_string()
        )
        .0,
        200
    );
    assert_eq!(
        post(
            addr,
            "/propose_changes",
            &serde_json::json!({
                "root": dir.path(),
                "doc": "draft.md",
                "baseContent": "hello\n",
                "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "Hi " }],
                "summary": "greet"
            })
            .to_string()
        )
        .0,
        200
    );

    // `waitMs` here is a bounded, condition-based long poll on the driver's own `/events` wait
    // mechanism (not a fixed sleep, docs/test-plan.md §4) — it returns as soon as the epoch-scoped
    // cursor has advanced, which by this point it already has, since both commands dispatch their
    // observer notices synchronously before their HTTP response returns.
    let (status, body) = post(
        addr,
        "/events",
        &serde_json::json!({ "cursor": 0, "epoch": epoch, "waitMs": 1000 }).to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let batch: serde_json::Value = serde_json::from_str(&body).unwrap();
    let notices: Vec<&serde_json::Value> = batch["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| {
            let kind = event["event"].as_str().unwrap_or_default();
            kind == DOCUMENT_BIRTH_EVENT || kind == DELIVERY_EVENT
        })
        .collect();
    assert_eq!(notices.len(), 2, "{body}");
    assert_eq!(notices[0]["event"], DOCUMENT_BIRTH_EVENT);
    assert_eq!(notices[0]["payload"]["path"], "born.md");
    assert_eq!(notices[1]["event"], DELIVERY_EVENT);
    assert_eq!(notices[1]["payload"]["doc"], "draft.md");
    assert!(notices[0]["cursor"].as_u64() < notices[1]["cursor"].as_u64());
}

#[test]
fn a_direct_call_for_another_root_cannot_reach_the_open_projects_subscribers() {
    let open = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let addr = spawn_driver();
    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": open.path() }).to_string()
        )
        .0,
        200
    );
    assert_eq!(
        post(
            addr,
            "/create_document",
            &serde_json::json!({
                "root": other.path(), "path": "private.md", "content": "not this project\n"
            })
            .to_string()
        )
        .0,
        200
    );

    let (_, body) = post(addr, "/events", r#"{"cursor":0,"waitMs":0}"#);
    let batch: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(batch["events"].as_array().unwrap().is_empty());
}

#[test]
fn menu_requests_use_the_shared_rust_event_names_and_do_not_block_each_other() {
    let addr = spawn_driver();
    let (_, initial_body) = post(addr, "/events", r#"{"cursor":0,"waitMs":0}"#);
    let initial: serde_json::Value = serde_json::from_str(&initial_body).unwrap();
    let epoch = initial["epoch"].as_str().unwrap();
    // Put the wait request into the accept backlog before the producer connects. If `/events`
    // runs inline on the serial command loop, the producer cannot be accepted until the full
    // second expires; the elapsed assertion below is therefore the deadlock discriminator.
    let body = serde_json::json!({ "cursor": 0, "epoch": epoch, "waitMs": 1000 }).to_string();
    let mut waiting = TcpStream::connect(addr).unwrap();
    waiting.write_all(format!(
        "POST /events HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    ).as_bytes()).unwrap();
    let poller = thread::spawn(move || {
        let mut response = String::new();
        waiting.read_to_string(&mut response).unwrap();
        let body = response.split_once("\r\n\r\n").unwrap().1.to_string();
        (200, body)
    });
    let started = Instant::now();
    assert_eq!(post(addr, "/request_open_document", "{}").0, 200);
    assert!(
        started.elapsed() < Duration::from_millis(750),
        "a waiting /events request blocked the serial command lane for {:?}",
        started.elapsed()
    );
    assert_eq!(post(addr, "/request_save_document_as", "{}").0, 200);
    let (status, body) = poller.join().unwrap();
    assert_eq!(status, 200, "{body}");
    let first: serde_json::Value = serde_json::from_str(&body).unwrap();
    let cursor = first["cursor"].as_u64().unwrap();
    let epoch = first["epoch"].as_str().unwrap();
    let (_, remainder) = post(
        addr,
        "/events",
        &serde_json::json!({
            "cursor": cursor, "epoch": epoch, "waitMs": 0
        })
        .to_string(),
    );
    let mut names: Vec<String> = first["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["event"].as_str().unwrap().to_string())
        .collect();
    names.extend(
        serde_json::from_str::<serde_json::Value>(&remainder).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["event"].as_str().unwrap().to_string()),
    );
    assert_eq!(names, vec![OPEN_DOCUMENT_EVENT, SAVE_DOCUMENT_AS_EVENT]);
}

/// The J1 acceptance script's own delivery seam (#365, `commands::agent::propose_changes_direct`):
/// a clean insertion lands, the atomic write is real, and the response carries the same
/// `DeliveryNotice` shape `stores/delivery.ts` mirrors on the frontend.
#[test]
fn propose_changes_delivers_a_clean_insertion_and_returns_the_delivery_notice_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "hello world\n").unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/propose_changes",
        &serde_json::json!({
            "root": dir.path(),
            "doc": "draft.md",
            "baseContent": "hello world\n",
            "edits": [
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ],
            "summary": "Made it braver",
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    let notice: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(notice["doc"], "draft.md");
    assert_eq!(notice["summary"], "Made it braver");
    assert_eq!(notice["stale"], 0);
    assert_eq!(notice["changes"].as_array().unwrap().len(), 1);
    let on_disk = fs::read_to_string(dir.path().join("draft.md")).unwrap();
    assert_eq!(notice["content"], on_disk);
    assert!(on_disk.contains("brave"));
}

/// TD-7 partial apply, over HTTP: an edit anchored to text the live document has since diverged
/// under goes stale; the rest still lands as one complete attributed subset (FR-AGENT-6).
#[test]
fn propose_changes_reports_the_applied_subset_when_the_live_text_has_moved_on_through_http() {
    let dir = TempDir::new().unwrap();
    let base = "one two three four five\n";
    fs::write(dir.path().join("draft.md"), base).unwrap();
    let addr = spawn_driver();
    // The user keeps typing while the agent works: "five" -> "FIVE" — a real write, before the
    // delivery is proposed against the base captured above.
    fs::write(dir.path().join("draft.md"), "one two three four FIVE\n").unwrap();

    let (status, body) = post(
        addr,
        "/propose_changes",
        &serde_json::json!({
            "root": dir.path(),
            "doc": "draft.md",
            "baseContent": base,
            "edits": [
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " },
                { "range": { "offset": 19, "length": 4 }, "replacement": "5" }
            ],
            "summary": "renumber",
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    let notice: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(notice["stale"], 1);
    assert_eq!(notice["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        "{++zero ++}one two three four FIVE\n"
    );
}

/// FR-AGENT-6's "a delivery that lands nothing raises no notice" through HTTP: every edit collides
/// with what the user typed, so the response is `null` and the live document is genuinely untouched.
#[test]
fn propose_changes_returns_null_and_leaves_the_document_untouched_when_wholly_stale_through_http() {
    let dir = TempDir::new().unwrap();
    let base = "one two three\n";
    fs::write(dir.path().join("draft.md"), base).unwrap();
    let addr = spawn_driver();
    fs::write(dir.path().join("draft.md"), "ONE TWO THREE\n").unwrap();

    let (status, body) = post(
        addr,
        "/propose_changes",
        &serde_json::json!({
            "root": dir.path(),
            "doc": "draft.md",
            "baseContent": base,
            "edits": [{ "range": { "offset": 0, "length": 13 }, "replacement": "rewritten" }],
            "summary": "rewrite",
        })
        .to_string(),
    );

    assert_eq!(status, 200);
    assert_eq!(body, "null");
    assert_eq!(
        fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        "ONE TWO THREE\n"
    );
}

// --- the TD-17 project lifecycle (#472) ----------------------------------------------------------

/// D23's direct document fixture calls `open_project`, and outside a Tauri webview that lands here.
/// Product folder choices use `/route_project_open` below; keeping this route distinct prevents the
/// acceptance fixture from pretending it is production routing policy.
#[test]
fn open_project_opens_the_project_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/open_project",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );

    assert_eq!(status, 200, "{body}");
}

/// Re-opening the same project is a no-op, not an error and not a rebind (the 2026-07-21 review's
/// canonicalization finding, seen from the transport a script actually drives).
#[test]
fn re_opening_the_same_project_through_http_succeeds() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();
    let args = serde_json::json!({ "root": dir.path() }).to_string();

    assert_eq!(post(addr, "/open_project", &args).0, 200);
    assert_eq!(post(addr, "/open_project", &args).0, 200);
}

/// Product folder choices use TD-20's route command rather than the D23 direct-construction seam.
/// The headless driver supplies the deliberately fake router boundary that §3.7 calls for: an
/// empty driver adopts locally, while a driver already holding another root reports that a new
/// independent instance would be opened without replacing its live session.
#[test]
fn route_project_open_adopts_an_empty_driver_and_does_not_replace_a_busy_one() {
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/route_project_open",
        &serde_json::json!({ "root": first.path() }).to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let adopted: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(adopted["status"], "adopted_here");

    let (status, body) = post(
        addr,
        "/route_project_open",
        &serde_json::json!({ "root": second.path() }).to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let opened: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(opened["status"], "opened_new");

    let (_, current) = post(addr, "/current_project", "{}");
    let current: serde_json::Value = serde_json::from_str(&current).unwrap();
    assert_eq!(
        std::path::Path::new(current.as_str().unwrap()),
        first.path().canonicalize().unwrap()
    );
}

#[test]
fn route_project_open_repeats_the_backend_notice_vocabulary_through_d23() {
    let root = TempDir::new().unwrap();
    let addr = spawn_driver();

    assert_eq!(
        post(
            addr,
            "/route_project_open",
            &serde_json::json!({ "root": root.path() }).to_string(),
        )
        .0,
        200
    );
    let (status, body) = post(
        addr,
        "/events",
        &serde_json::json!({ "cursor": 0, "waitMs": 0 }).to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let batch: serde_json::Value = serde_json::from_str(&body).unwrap();
    let events = batch["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["event"], "cowrite://project/routing");
    assert_eq!(events[0]["payload"]["status"], "requesting");
    assert_eq!(events[1]["payload"]["status"], "finished");
    assert_eq!(events[1]["payload"]["outcome"]["status"], "adopted_here");
}

/// TD-18 uses the same backend operation for first load and explicit `[Refresh]`; D23 mirrors that
/// thin IPC path so a future J2 acceptance script drives production scanning rather than a fake.
#[test]
fn refresh_project_files_returns_monotonic_completed_snapshots_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("first.md"), "# First\n").unwrap();
    let addr = spawn_driver();
    let open = serde_json::json!({ "root": dir.path() }).to_string();

    assert_eq!(post(addr, "/open_project", &open).0, 200);
    let (first_status, first_body) = post(addr, "/refresh_project_files", "{}");
    fs::write(dir.path().join("second.md"), "# Second\n").unwrap();
    let (second_status, second_body) = post(addr, "/refresh_project_files", "{}");

    assert_eq!(first_status, 200, "{first_body}");
    assert_eq!(second_status, 200, "{second_body}");
    let first: serde_json::Value = serde_json::from_str(&first_body).unwrap();
    let second: serde_json::Value = serde_json::from_str(&second_body).unwrap();
    assert_eq!(first["generation"], 1);
    assert_eq!(second["generation"], 2);
    assert_eq!(first["entries"][0]["path"], "first.md");
    assert_eq!(second["entries"][1]["path"], "second.md");
}

/// D23 substitutes only the event transport: a native filesystem notification is still produced
/// by the real watcher, folded by the real automatic refresh, and serialized from Rust's own
/// `ProjectFilesRefreshNotice`. The envelope binds the channel name to the same constant Tauri
/// emits, so the browser consumer cannot silently follow a hand-mirrored second spelling.
#[test]
fn automatic_project_files_events_cross_d23_with_the_tauri_event_name() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("first.md"), "# First\n").unwrap();
    let addr = spawn_driver();
    let open = serde_json::json!({ "root": dir.path() }).to_string();

    assert_eq!(post(addr, "/open_project", &open).0, 200);
    assert_eq!(post(addr, "/refresh_project_files", "{}").0, 200);
    fs::write(dir.path().join("automatic.md"), "# Automatic\n").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut notices = Vec::new();
    let mut cursor = 0;
    let mut epoch: Option<String> = None;
    while Instant::now() < deadline {
        let (status, body) = post(
            addr,
            "/events",
            &serde_json::json!({
                "cursor": cursor, "epoch": epoch, "waitMs": 250
            })
            .to_string(),
        );
        assert_eq!(status, 200, "{body}");
        let batch: serde_json::Value = serde_json::from_str(&body).unwrap();
        cursor = batch["cursor"].as_u64().unwrap();
        epoch = Some(batch["epoch"].as_str().unwrap().to_string());
        notices.extend(batch["events"].as_array().unwrap().iter().cloned());
        if notices
            .iter()
            .any(|event| event["payload"]["status"] == "completed")
        {
            break;
        }
        thread::yield_now();
    }

    assert!(
        !notices.is_empty(),
        "the real native write announced no transitions"
    );
    assert!(
        notices
            .iter()
            .all(|event| event["event"] == PROJECT_FILES_EVENT),
        "every envelope must carry the Tauri channel name: {notices:?}"
    );
    assert!(notices
        .iter()
        .any(|event| event["payload"]["status"] == "started"));
    let completed = notices
        .iter()
        .find(|event| event["payload"]["status"] == "completed")
        .expect("a completed transition before the deadline");
    assert_eq!(completed["payload"]["snapshot"]["generation"], 2);
    assert_eq!(
        completed["payload"]["snapshot"]["entries"][0]["path"],
        "automatic.md"
    );
}

#[test]
fn refresh_project_files_without_an_open_project_is_typed_project_unavailable_through_http() {
    let addr = spawn_driver();

    let (status, body) = post(addr, "/refresh_project_files", "{}");

    assert_eq!(status, 422, "{body}");
    let error: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(error["kind"], "ProjectUnavailable");
}

#[test]
fn project_path_enumerability_reaches_the_backend_visibility_rule_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();
    let open = serde_json::json!({ "root": dir.path() }).to_string();
    assert_eq!(post(addr, "/open_project", &open).0, 200);

    for (path, expected) in [
        ("node_modules/pkg/README.md", false),
        ("notes/deleted.md", true),
    ] {
        let (status, body) = post(
            addr,
            "/project_path_is_enumerable",
            &serde_json::json!({ "path": path }).to_string(),
        );
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            serde_json::from_str::<bool>(&body).unwrap(),
            expected,
            "{path}"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn recreate_missing_document_refuses_through_the_production_command_edge() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();
    let open = serde_json::json!({ "root": dir.path() }).to_string();
    assert_eq!(post(addr, "/open_project", &open).0, 200);

    let (capability_status, capability_body) = post(
        addr,
        "/recreate_missing_document_capability",
        &serde_json::json!({ "path": "missing.md" }).to_string(),
    );
    let (recreate_status, recreate_body) = post(
        addr,
        "/recreate_missing_document",
        &serde_json::json!({
            "path": "missing.md",
            "content": "unsaved buffer",
            "normalizeLineEndings": true
        })
        .to_string(),
    );

    assert_eq!(capability_status, 200, "{capability_body}");
    assert_eq!(recreate_status, 200, "{recreate_body}");
    let capability: serde_json::Value = serde_json::from_str(&capability_body).unwrap();
    let recreate: serde_json::Value = serde_json::from_str(&recreate_body).unwrap();
    assert_eq!(capability["path"], "missing.md");
    assert_eq!(capability["status"], "confinement_unavailable");
    assert_eq!(recreate["status"], "confinement_unavailable");
    assert!(!dir.path().join("missing.md").exists());
}

#[cfg(windows)]
#[test]
fn recreate_missing_document_creates_through_the_production_command_edge_on_windows() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();
    let open = serde_json::json!({ "root": dir.path() }).to_string();
    assert_eq!(post(addr, "/open_project", &open).0, 200);

    let (capability_status, capability_body) = post(
        addr,
        "/recreate_missing_document_capability",
        &serde_json::json!({ "path": "missing.md" }).to_string(),
    );
    let (recreate_status, recreate_body) = post(
        addr,
        "/recreate_missing_document",
        &serde_json::json!({
            "path": "missing.md",
            "content": "line one\r\nline two\r",
            "normalizeLineEndings": true
        })
        .to_string(),
    );

    assert_eq!(capability_status, 200, "{capability_body}");
    assert_eq!(recreate_status, 200, "{recreate_body}");
    let capability: serde_json::Value = serde_json::from_str(&capability_body).unwrap();
    let recreate: serde_json::Value = serde_json::from_str(&recreate_body).unwrap();
    assert_eq!(capability["path"], "missing.md");
    assert_eq!(capability["status"], "available");
    assert_eq!(recreate["status"], "created");
    assert_eq!(
        fs::read_to_string(dir.path().join("missing.md")).unwrap(),
        "line one\nline two\n"
    );
}

#[test]
fn set_open_tabs_updates_an_open_project_through_http() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "# Draft\n").unwrap();
    let addr = spawn_driver();

    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": dir.path() }).to_string()
        )
        .0,
        200
    );
    let (status, body) = post(
        addr,
        "/set_open_tabs",
        &serde_json::json!({ "root": dir.path(), "paths": ["draft.md"] }).to_string(),
    );

    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "null");
}

#[test]
fn open_project_rejects_an_empty_root_through_http() {
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/open_project",
        &serde_json::json!({ "root": "" }).to_string(),
    );

    // 422 is this driver's shape for a command that returned a typed error (400 is a body it could
    // not deserialize at all) — the same shape `/start_run`'s blank-prompt refusal takes.
    assert_eq!(status, 422, "{body}");
    assert!(body.contains("InvalidArguments"), "{body}");
}

// --- settings/transcript (#1395: routes the `settings/ipc` and `timeline/ipc` production seams
// through `callBackend`/this driver rather than leaving them exempt) --------------------------

#[test]
fn get_settings_on_a_fresh_driver_returns_the_default_settings_through_http() {
    let addr = spawn_driver();

    let (status, body) = post(addr, "/get_settings", "{}");

    assert_eq!(status, 200, "{body}");
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["schema_version"], 4);
    assert_eq!(payload["autosave"]["enabled"], true);
    assert_eq!(payload["autosave"]["interval_ms"], 1000);
    assert_eq!(payload["provider_default"], serde_json::Value::Null);
    assert_eq!(payload["reveal_markup_at_cursor"], false);
    assert_eq!(payload["voice"]["enabled"], true);
    assert_eq!(payload["voice"]["input_device_id"], serde_json::Value::Null);
    assert_eq!(
        payload["voice"]["input_device_name"],
        serde_json::Value::Null
    );
}

#[test]
fn voice_settings_commands_report_backend_status_and_persist_enable_without_a_microphone() {
    let addr = spawn_driver();
    let (initial_status, initial_body) = post(addr, "/get_voice_status", "{}");
    assert_eq!(initial_status, 200, "{initial_body}");
    let initial: serde_json::Value = serde_json::from_str(&initial_body).unwrap();
    assert_eq!(initial["enabled"], true);
    assert_eq!(initial["model"], "absent");

    let (changed_status, changed_body) = post(addr, "/set_voice_enabled", r#"{"enabled":false}"#);
    assert_eq!(changed_status, 200, "{changed_body}");
    let changed: serde_json::Value = serde_json::from_str(&changed_body).unwrap();
    assert_eq!(changed["enabled"], false);
    assert_eq!(changed["selected_device_id"], serde_json::Value::Null);
    assert_eq!(changed["selected_device_name"], serde_json::Value::Null);

    let (settings_status, settings_body) = post(addr, "/get_settings", "{}");
    assert_eq!(settings_status, 200, "{settings_body}");
    let settings: serde_json::Value = serde_json::from_str(&settings_body).unwrap();
    assert_eq!(settings["voice"]["enabled"], false);
    assert_eq!(
        settings["voice"]["input_device_id"],
        serde_json::Value::Null
    );
    assert_eq!(
        settings["voice"]["input_device_name"],
        serde_json::Value::Null
    );
}

#[test]
fn conditional_voice_cancel_requires_generation_and_preserves_idle_status() {
    let addr = spawn_driver();
    let (missing_status, _) = post(addr, "/cancel_voice_dictation", "{}");
    assert_eq!(missing_status, 400);
    let (wrong_type_status, _) = post(
        addr,
        "/cancel_voice_dictation",
        r#"{"expectedGeneration":"7"}"#,
    );
    assert_eq!(wrong_type_status, 400);

    let (status, body) = post(
        addr,
        "/cancel_voice_dictation",
        r#"{"expectedGeneration":7}"#,
    );
    assert_eq!(status, 200, "{body}");
    let current: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(current["dictation"], serde_json::json!({ "kind": "idle" }));
    assert_eq!(current["dictation_generation"], serde_json::Value::Null);
    assert_eq!(current["capture_active"], false);

    let (events_status, events_body) = post(addr, "/events", r#"{"cursor":0}"#);
    assert_eq!(events_status, 200, "{events_body}");
    let events: serde_json::Value = serde_json::from_str(&events_body).unwrap();
    assert!(events["events"].as_array().unwrap().is_empty());
}

struct HeldVoiceTransport {
    opened: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

struct CancelledVoiceTransport {
    entered: mpsc::SyncSender<()>,
    stall: VoiceStall,
}

#[derive(Clone, Copy, Debug)]
enum VoiceStall {
    Connect,
    Body,
}

struct CancelledBodyReader {
    entered: mpsc::SyncSender<()>,
    cancel: emend_lib::voice::model_download::DownloadCancellation,
    sent_first: bool,
}

impl Read for CancelledBodyReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if !self.sent_first {
            self.sent_first = true;
            out[..5].copy_from_slice(&[1; 5]);
            return Ok(5);
        }
        self.entered.send(()).unwrap();
        self.cancel.wait_blocking();
        Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled body",
        ))
    }
}

impl DownloadTransport for CancelledVoiceTransport {
    fn open(
        &self,
        _url: &str,
        offset: u64,
        cancel: &emend_lib::voice::model_download::DownloadCancellation,
    ) -> Result<DownloadResponse, DownloadFailure> {
        match self.stall {
            VoiceStall::Connect => {
                self.entered.send(()).unwrap();
                cancel.wait_blocking();
                Err(DownloadFailure::Cancelled)
            }
            VoiceStall::Body => Ok(DownloadResponse {
                range: ResponseRange::From {
                    start: offset,
                    total: 59_721_011,
                },
                stream: Box::new(CancelledBodyReader {
                    entered: self.entered.clone(),
                    cancel: cancel.clone(),
                    sent_first: false,
                }),
            }),
        }
    }
}

#[test]
fn stalled_voice_download_cancel_publishes_revisioned_cancelling_and_cancelled_without_releasing_network(
) {
    for stall in [VoiceStall::Connect, VoiceStall::Body] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let factory: test_driver::VoiceTransportFactory = Arc::new(move || {
            Ok::<_, VoiceError>(Box::new(CancelledVoiceTransport {
                entered: entered_tx.clone(),
                stall,
            }))
        });
        thread::spawn(move || {
            test_driver::serve_with_queue_and_voice_transport(
                listener,
                RunQueue::new(always_fails as fn(&RunRequest) -> _),
                factory,
            )
        });
        let (finished_tx, finished_rx) = mpsc::channel();
        let download = thread::spawn(move || {
            finished_tx
                .send(post(addr, "/download_voice_model", "{}"))
                .unwrap()
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (cancel_tx, cancel_rx) = mpsc::channel();
        let cancel_call = thread::spawn(move || {
            cancel_tx
                .send(post(addr, "/cancel_voice_download", "{}"))
                .unwrap();
        });
        let (cancel_status, cancel_body) = cancel_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(cancel_status, 200, "{stall:?}: {cancel_body}");
        cancel_call.join().unwrap();
        let (result_status, result_body) =
            finished_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(result_status, 200, "{stall:?}: {result_body}");
        download.join().unwrap();
        let (status_code, body) = post(addr, "/get_voice_status", "{}");
        assert_eq!(status_code, 200, "{stall:?}: {body}");
        let status: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(status["download"]["kind"], "cancelled", "{stall:?}");
        assert_eq!(status["model"], "absent", "{stall:?}");
        let (events_status, events_body) = post(addr, "/events", r#"{"cursor":0}"#);
        assert_eq!(events_status, 200, "{stall:?}: {events_body}");
        let events: serde_json::Value = serde_json::from_str(&events_body).unwrap();
        let notices: Vec<&serde_json::Value> = events["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["event"] == emend_lib::commands::voice::VOICE_DOWNLOAD_EVENT)
            .map(|event| &event["payload"])
            .collect();
        let phases: Vec<&str> = notices
            .iter()
            .map(|notice| notice["phase"]["kind"].as_str().unwrap())
            .collect();
        let cancelling_at = phases
            .iter()
            .position(|phase| *phase == "cancelling")
            .unwrap();
        let cancelled_at = phases
            .iter()
            .position(|phase| *phase == "cancelled")
            .unwrap();
        let cancelling_revision = notices[cancelling_at]["revision"].as_u64().unwrap();
        let cancelled_revision = notices[cancelled_at]["revision"].as_u64().unwrap();
        assert!(
            cancelling_revision < cancelled_revision,
            "{stall:?}: {phases:?}"
        );
        assert_eq!(status["download_revision"], cancelled_revision);
        assert!(notices.iter().all(|notice| {
            notice["revision"].as_u64().unwrap() <= cancelled_revision
                && !matches!(
                    notice["phase"]["kind"].as_str(),
                    Some("completed" | "failed")
                )
        }));
    }
}

impl DownloadTransport for HeldVoiceTransport {
    fn open(
        &self,
        _url: &str,
        offset: u64,
        _cancel: &emend_lib::voice::model_download::DownloadCancellation,
    ) -> Result<DownloadResponse, DownloadFailure> {
        self.opened.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        Ok(DownloadResponse {
            range: ResponseRange::From {
                start: offset,
                total: 59_721_011,
            },
            stream: Box::new(Cursor::new(vec![0u8])),
        })
    }
}

#[test]
fn status_and_cancel_reach_a_driver_download_before_its_transport_finishes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (opened_tx, opened_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let factory: test_driver::VoiceTransportFactory = Arc::new(move || {
        Ok::<_, VoiceError>(Box::new(HeldVoiceTransport {
            opened: opened_tx.clone(),
            release: Mutex::new(release.lock().unwrap().take().unwrap()),
        }))
    });
    thread::spawn(move || {
        test_driver::serve_with_queue_and_voice_transport(
            listener,
            RunQueue::new(always_fails as fn(&RunRequest) -> _),
            factory,
        )
    });

    let download = thread::spawn(move || post(addr, "/download_voice_model", "{}"));
    opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (status_tx, status_rx) = mpsc::channel();
    let status_call = thread::spawn(move || {
        status_tx
            .send(post(addr, "/get_voice_status", "{}"))
            .unwrap();
    });
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let cancel_call = thread::spawn(move || {
        cancel_tx
            .send(post(addr, "/cancel_voice_download", "{}"))
            .unwrap();
    });

    let status_before_release = status_rx.recv_timeout(Duration::from_secs(5));
    let cancel_before_release = cancel_rx.recv_timeout(Duration::from_secs(5));
    release_tx.send(()).unwrap();
    let download_result = download.join().unwrap();
    status_call.join().unwrap();
    cancel_call.join().unwrap();
    assert_eq!(status_before_release.unwrap().0, 200);
    assert_eq!(cancel_before_release.unwrap().0, 200);
    assert_eq!(download_result.0, 200, "{}", download_result.1);
    let (final_status, final_body) = post(addr, "/get_voice_status", "{}");
    assert_eq!(final_status, 200, "{final_body}");
    let final_payload: serde_json::Value = serde_json::from_str(&final_body).unwrap();
    assert_eq!(final_payload["download"]["kind"], "cancelled");
    assert_eq!(final_payload["model"], "absent");
}

#[test]
fn patch_settings_returns_the_complete_snapshot_and_uses_camel_case_patch_fields() {
    let addr = spawn_driver();

    let (patch_status, patch_body) = post(
        addr,
        "/patch_settings",
        &serde_json::json!({
            "patch": {
                "autosave": { "enabled": false, "intervalMs": 5000 },
                "notifications": { "completion": false },
                "providerDefault": "claude",
                "revealMarkupAtCursor": true
            }
        })
        .to_string(),
    );
    assert_eq!(patch_status, 200, "{patch_body}");
    let patched: serde_json::Value = serde_json::from_str(&patch_body).unwrap();
    assert_eq!(patched["schema_version"], 4);
    assert_eq!(patched["autosave"]["interval_ms"], 5000);
    assert_eq!(patched["provider_default"], "claude");
    assert_eq!(patched["reveal_markup_at_cursor"], true);
    assert_eq!(
        patched["voice"]["input_device_name"],
        serde_json::Value::Null
    );

    let (status, body) = post(addr, "/get_settings", "{}");

    assert_eq!(status, 200, "{body}");
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["autosave"]["enabled"], false);
    assert_eq!(payload["autosave"]["interval_ms"], 5000);
    assert_eq!(payload["notifications"]["completion"], false);
    assert_eq!(payload["provider_default"], "claude");
    assert_eq!(payload["reveal_markup_at_cursor"], true);
}

#[test]
fn patch_settings_publishes_the_same_complete_snapshot_on_the_cursor_event_stream() {
    let addr = spawn_driver();
    let (_, baseline_body) = post(addr, "/events", r#"{"cursor":0,"waitMs":0}"#);
    let baseline: serde_json::Value = serde_json::from_str(&baseline_body).unwrap();

    let (status, body) = post(
        addr,
        "/patch_settings",
        r#"{"patch":{"revealMarkupAtCursor":true}}"#,
    );
    assert_eq!(status, 200, "{body}");

    let (_, event_body) = post(
        addr,
        "/events",
        &serde_json::json!({
            "cursor": baseline["cursor"],
            "epoch": baseline["epoch"],
            "waitMs": 1000
        })
        .to_string(),
    );
    let batch: serde_json::Value = serde_json::from_str(&event_body).unwrap();
    assert_eq!(batch["events"].as_array().unwrap().len(), 1);
    assert_eq!(batch["events"][0]["event"], "settings://changed");
    assert_eq!(batch["events"][0]["payload"]["schema_version"], 4);
    assert_eq!(
        batch["events"][0]["payload"]["voice"]["input_device_name"],
        serde_json::Value::Null
    );
    assert_eq!(
        batch["events"][0]["payload"]["reveal_markup_at_cursor"],
        true
    );
}

#[test]
fn patch_settings_rejects_snake_case_patch_input_instead_of_silently_ignoring_it() {
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/patch_settings",
        r#"{"patch":{"reveal_markup_at_cursor":true}}"#,
    );

    assert_eq!(status, 400, "{body}");
}

#[test]
fn load_transcript_for_a_project_with_no_history_returns_an_empty_list_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    let (status, body) = post(
        addr,
        "/load_transcript",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );

    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "[]");
}

#[test]
fn append_transcript_event_then_load_transcript_round_trips_in_append_order_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();
    let event = |id: &str, body: &str| {
        serde_json::json!({
            "schema_version": 1,
            "id": id,
            "kind": "chat-message",
            "timestamp": "2026-08-21T00:00:00.000Z",
            "author": "user",
            "body": body,
        })
    };

    for (id, body) in [("card-1", "first"), ("card-2", "second")] {
        let (status, resp_body) = post(
            addr,
            "/append_transcript_event",
            &serde_json::json!({ "root": dir.path(), "event": event(id, body) }).to_string(),
        );
        assert_eq!(status, 200, "{resp_body}");
    }

    let (status, body) = post(
        addr,
        "/load_transcript",
        &serde_json::json!({ "root": dir.path() }).to_string(),
    );

    assert_eq!(status, 200, "{body}");
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    let ids: Vec<&str> = payload
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["card-1", "card-2"]);
    assert_eq!(payload[0]["body"], "first");
}

#[test]
fn transcripts_for_distinct_project_roots_never_mix_through_http() {
    // The negative this route must reject: two projects' histories are keyed separately (the
    // production `project_key(root)` hash), so appending to one root's transcript must never leak
    // into another root's `/load_transcript` read.
    let root_a = TempDir::new().unwrap();
    let root_b = TempDir::new().unwrap();
    let addr = spawn_driver();

    post(
        addr,
        "/append_transcript_event",
        &serde_json::json!({
            "root": root_a.path(),
            "event": {
                "schema_version": 1,
                "id": "card-a",
                "kind": "chat-message",
                "timestamp": "2026-08-21T00:00:00.000Z",
                "author": "user",
                "body": "in root a",
            }
        })
        .to_string(),
    );

    let (status, body) = post(
        addr,
        "/load_transcript",
        &serde_json::json!({ "root": root_b.path() }).to_string(),
    );

    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "[]", "root b must not see root a's transcript");
}

/// Closing is idempotent from a script's point of view: it never has to track whether a project is
/// currently open before tearing one down.
#[test]
fn close_project_succeeds_whether_or_not_a_project_is_open_through_http() {
    let dir = TempDir::new().unwrap();
    let addr = spawn_driver();

    assert_eq!(post(addr, "/close_project", "{}").0, 200);

    assert_eq!(
        post(
            addr,
            "/open_project",
            &serde_json::json!({ "root": dir.path() }).to_string()
        )
        .0,
        200
    );
    assert_eq!(post(addr, "/close_project", "{}").0, 200);
}
