// ABOUTME: Integration tests for required Emend MCP run binding (TD-1/TD-5/#472/#2396).
// ABOUTME: Exercise production config injection, real handshakes, and attributed queue failure.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;
use textops::Document;

use emend_lib::agent::claude::McpServer;
use emend_lib::agent::project::{OpenProjectRunObserver, ProjectObservers, SharedOpenProject};
use emend_lib::agent::run_queue::{NoopEmitter, RunObserver, RunPhase, RunQueue, RunRequest};
use emend_lib::agent::session::{AgentSession, SessionError};
use emend_lib::commands::agent::{claude_invocation, spawn_claude_run, start_run_on};
use emend_lib::commands::project::{close_project_on, new_session, open_project_on, CommandError};

mod common;
use common::{fake_agent_bin, fake_agent_scenario};

fn request(root: &Path) -> RunRequest {
    RunRequest {
        project_root: root.to_path_buf(),
        prompt: "Tighten the opening paragraph".to_string(),
        operation_targets: Vec::new(),
    }
}

fn spawn_scenario(request: &RunRequest) -> Result<AgentSession, SessionError> {
    AgentSession::spawn(
        fake_agent_bin().to_str().unwrap(),
        &["--scenario".to_string(), request.prompt.clone()],
        &request.project_root,
    )
}

fn queue() -> RunQueue {
    RunQueue::new(spawn_scenario as fn(&RunRequest) -> _)
}

/// A session with `root` open, over the real `commands::project` transition — the same call
/// `App.tsx`'s `openProjectRoot` seam makes over IPC. No observers: this suite asserts injection,
/// and the D23 driver opens the same way.
fn open_session(root: &Path) -> SharedOpenProject {
    let session = new_session();
    open_project_on(
        &session,
        root.display().to_string(),
        ProjectObservers::default(),
    )
    .expect("open the project");
    session
}

/// The open project's bound server — what `spawn_claude_run` injects for every run against it.
fn bound_server(session: &SharedOpenProject) -> McpServer {
    session
        .lock()
        .unwrap()
        .as_ref()
        .expect("a project is open")
        .mcp_server()
}

/// The `--mcp-config` JSON string out of a built argv — the single value carrying the whole
/// "the user configures nothing" contract (TD-1).
fn mcp_config_arg(args: &[String]) -> Value {
    let i = args
        .iter()
        .position(|a| a == "--mcp-config")
        .expect("a spawned run must carry --mcp-config");
    serde_json::from_str(&args[i + 1]).expect("--mcp-config is inline JSON")
}

/// The card's headline defect (#472): every card in #344's split pointed at another, so a spawned
/// run reached `AgentSession::spawn` with `mcp_server: None` and no agent could call an Emend
/// tool at all. The production argv builder must now always carry the open project's bound server.
#[test]
fn a_runs_invocation_carries_the_bound_servers_address_and_token() {
    let dir = TempDir::new().unwrap();
    let session = open_session(dir.path());
    let server = bound_server(&session);

    let (_binary, args, _cwd, _stdin) =
        claude_invocation(&request(dir.path()), server.clone(), None);

    let config = mcp_config_arg(&args);
    assert_eq!(
        config["mcpServers"]["cowrite"]["url"],
        format!("http://{}/", server.addr)
    );
    assert_eq!(
        config["mcpServers"]["cowrite"]["headers"]["Authorization"],
        format!("Bearer {}", server.token)
    );
    assert!(provider_contract::is_valid(
        provider_contract::Schema::McpServerConfig,
        &config
    ));
}

/// Issue #1206: the D23 driver's production `serve()` path uses `spawn_claude_run`, so its
/// test-only provider override must reach the process boundary rather than stopping at provider
/// detection. The subprocess keeps its `PATH` empty: reverting the override is a safe, deterministic
/// spawn failure even on a developer machine with a real, authenticated `claude` installed.
#[test]
fn spawn_claude_run_starts_the_binary_named_by_cowrite_claude_bin() {
    let status =
        Command::new(std::env::current_exe().expect("locate this integration test binary"))
            .args([
                "--ignored",
                "--exact",
                "spawn_claude_run_override_subprocess",
                "--nocapture",
            ])
            .env("PATH", "")
            .env("EMEND_CLAUDE_BIN", fake_agent_bin())
            .env("EMEND_COPILOT_BIN", "definitely-not-the-claude-provider")
            .status()
            .expect("run the isolated provider-override assertion");

    assert!(
        status.success(),
        "the production spawn edge must start EMEND_CLAUDE_BIN, not a near-match override or claude on PATH"
    );
}

/// Child half of [`spawn_claude_run_starts_the_binary_named_by_cowrite_claude_bin`]. Kept ignored
/// so an ordinary test run executes it only through the parent that supplies the isolated env.
#[test]
#[ignore]
fn spawn_claude_run_override_subprocess() {
    let dir = TempDir::new().unwrap();
    let session = open_session(dir.path());

    assert!(
        spawn_claude_run(&session, &request(dir.path())).is_ok(),
        "EMEND_CLAUDE_BIN must be the executable handed to AgentSession"
    );
}

/// TD-17's shape (Option B): the binding is **per open project**, not per run (M7 — one MCP server
/// per project, one project per app instance). Two runs against the same open project share one
/// server and one token; nothing rebinds, nothing churns a port per turn.
///
/// Asserted on what the two runs' *invocations* actually carry, not on two reads of the session:
/// comparing `mcp_server()` to itself is true however the production path behaves, so an earlier
/// version of this test passed even with the injection reverted to `mcp_server: None` (PR #513
/// review round 2, Important). Routing both runs through `claude_invocation` puts the production
/// seam inside the assertion, and `mcp_config_arg` panics outright on an argv with no
/// `--mcp-config` — so a regression that stops injecting fails here too.
#[test]
fn two_runs_against_the_same_project_share_one_binding() {
    let dir = TempDir::new().unwrap();
    let session = open_session(dir.path());

    let (_binary, first_args, _cwd, _stdin) =
        claude_invocation(&request(dir.path()), bound_server(&session), None);
    let (_binary, second_args, _cwd, _stdin) =
        claude_invocation(&request(dir.path()), bound_server(&session), None);

    let first_config = mcp_config_arg(&first_args);
    let second_config = mcp_config_arg(&second_args);
    assert_eq!(
        first_config, second_config,
        "both runs must be wired to the same address and the same token"
    );

    // And that shared value is genuinely this project's live binding, not two copies of a default.
    let server = bound_server(&session);
    assert_eq!(
        first_config["mcpServers"]["cowrite"]["url"],
        format!("http://{}/", server.addr)
    );
    assert_eq!(
        first_config["mcpServers"]["cowrite"]["headers"]["Authorization"],
        format!("Bearer {}", server.token)
    );
}

/// Issue #1420: the production project aggregate is the bridge from an MCP persistence outcome
/// back to the queue. A successful delivery marks only its active run; a wholly-stale call on the
/// next run announces the same tool name but persists nothing and must remain unmarked.
#[test]
fn the_open_project_reports_landed_mcp_outcomes_per_run_not_tool_announcements() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), "hello world\n").unwrap();
    let session = open_session(dir.path());
    let observer = OpenProjectRunObserver::new(session.clone());
    let server = bound_server(&session);
    let run_request = request(dir.path());

    observer.begin_run("run-landed", &run_request);
    let revision = Document::new("hello world\n")
        .revision()
        .as_str()
        .to_string();
    common::mcp_call_ok(
        server.addr,
        &server.token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": revision,
            "edits": [{
                "range": { "offset": 6, "length": 0 },
                "replacement": "brave "
            }],
            "summary": "tighten"
        }),
    );
    assert!(
        observer.delivery_landed("run-landed"),
        "a persisted proposal must mark its active run"
    );
    observer.end_run("run-landed");

    observer.begin_run("run-stale", &run_request);
    let result = common::mcp_call_ok(
        server.addr,
        &server.token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": "rev-never-served",
            "edits": [{
                "range": { "offset": 0, "length": 0 },
                "replacement": "x"
            }],
            "summary": "cannot land"
        }),
    );
    assert!(result["result"]["structuredContent"]["applied"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!observer.delivery_landed("run-stale"));
    observer.end_run("run-stale");
}

/// The other half of "per open project": closing the project unbinds its server, so #413's "the
/// token does not outlive the session it was minted for" holds against a real lifecycle hook —
/// which is exactly what TD-17 gave this card and the pre-TD-17 attempt had to work around.
#[test]
fn closing_the_project_unbinds_the_server_a_run_would_have_been_injected_with() {
    let dir = TempDir::new().unwrap();
    let session = open_session(dir.path());
    let server = bound_server(&session);

    // Live while the project is open: the tool surface answers on this address with this token.
    let (status, _) = common::mcp_call(
        server.addr,
        Some(&server.token),
        "list_documents",
        json!({}),
    );
    assert_eq!(
        status, 200,
        "the bound server serves while the project is open"
    );

    close_project_on(&session, &queue()).unwrap();

    assert!(
        common::still_refuses(server.addr),
        "closing the project must unbind the server a run would have been injected with"
    );
}

#[test]
fn close_side_run_active_refusal_keeps_the_open_project_identity() {
    let first = TempDir::new().unwrap();
    let session = open_session(first.path());
    let queue = queue();
    let run_id = queue.start(RunRequest {
        project_root: first.path().to_path_buf(),
        prompt: fake_agent_scenario("claude-never-terminates.json")
            .display()
            .to_string(),
        operation_targets: Vec::new(),
    });

    let close = close_project_on(&session, &queue);
    assert_eq!(
        queue.stop(&run_id),
        emend_lib::agent::run_queue::StopOutcome::Stopped
    );
    let error = close.unwrap_err();
    assert!(matches!(error, CommandError::RunActive(_)));
    assert!(session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_root(first.path()));
}

#[test]
fn closing_a_project_while_a_run_is_active_keeps_the_live_binding() {
    let dir = TempDir::new().unwrap();
    let session = open_session(dir.path());
    let server = bound_server(&session);
    let queue = queue();
    let run_id = queue.start(RunRequest {
        project_root: dir.path().to_path_buf(),
        prompt: fake_agent_scenario("claude-never-terminates.json")
            .display()
            .to_string(),
        operation_targets: Vec::new(),
    });

    let close = close_project_on(&session, &queue);
    assert_eq!(
        queue.stop(&run_id),
        emend_lib::agent::run_queue::StopOutcome::Stopped
    );
    let error = close.unwrap_err();
    assert!(matches!(error, CommandError::RunActive(_)));
    let still_live = bound_server(&session);
    assert_eq!(still_live.addr, server.addr);
    assert_eq!(still_live.token, server.token);
}

/// The card's acceptance test: a **real spawned binary** takes the `--mcp-config` the production
/// argv builder produced and reaches the **real** §3.2 tool surface over loopback with the bearer
/// token — the end-to-end claim none of #412/#413/#414 could make on its own.
///
/// The fake agent is a scriptable stand-in, not a `claude` clone (it has its own flag surface), so
/// the test hands it the exact `--mcp-config` value the production path built rather than the
/// whole `claude` argv. That value *is* the contract: address + bearer token, and nothing else.
///
/// The response is asserted against what only the **real** server can answer — the project's
/// actual file content at its actual revision. `fake-agent`'s in-process `StubToolServer` answers
/// canned stub text, so a regression that silently fell back to the stub fails here rather than
/// passing.
#[test]
fn a_spawned_agent_reaches_the_real_tool_surface_over_the_bound_server() {
    let dir = TempDir::new().unwrap();
    let content = "# Draft\n\nOne line to tighten.\n";
    std::fs::write(dir.path().join("draft.md"), content).unwrap();

    let session = open_session(dir.path());
    let (_binary, args, _cwd, _stdin) =
        claude_invocation(&request(dir.path()), bound_server(&session), None);
    let config = mcp_config_arg(&args);

    let scenario = write_scenario(
        dir.path(),
        Some(json!({
            "content": content,
            "revision": Document::new(content).revision().as_str(),
            "pending_changes": [],
            "comments": [],
            "protection": "unprotected"
        })),
    );

    let status = Command::new(fake_agent_bin())
        .args(["--scenario".as_ref(), scenario.as_os_str()])
        .arg("--validate")
        .arg("--mcp-config")
        .arg(config.to_string())
        .status()
        .expect("spawn the fake agent");

    assert!(
        status.success(),
        "the spawned agent's get_document_state must round-trip against the bound server"
    );
}

/// The bearer token is load-bearing over the real wire, not just in `agent::mcp`'s unit tests: an
/// agent handed a tampered config cannot reach the tool surface (§3.5 — only children Emend
/// spawned, with the token Emend minted, get in).
///
/// The spawned agent's exit status alone cannot distinguish "refused with 401" from "never reached
/// the server at all" (PR #513 review round 2, Minor), so the *same* tampered config is first driven
/// straight over the wire and pinned to 401 — proving the address is live and the token is what
/// refuses — before the spawned binary is asked to fail on it.
#[test]
fn a_spawned_agent_with_the_wrong_bearer_token_is_refused_by_the_bound_server() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), "# Draft\n").unwrap();

    let session = open_session(dir.path());
    let server = bound_server(&session);
    let (_binary, args, _cwd, _stdin) =
        claude_invocation(&request(dir.path()), server.clone(), None);

    let mut config = mcp_config_arg(&args);
    config["mcpServers"]["cowrite"]["headers"]["Authorization"] =
        json!("Bearer not-the-minted-token");

    // The bound server is up and it is the *token* that refuses — not a dead address, a malformed
    // config, or a connect failure, all of which the exit status below would report identically.
    let (status, body) = common::mcp_call(
        server.addr,
        Some("not-the-minted-token"),
        "list_documents",
        json!({}),
    );
    assert_eq!(status, 401, "{body}");

    let scenario = write_scenario(dir.path(), None);
    let status = Command::new(fake_agent_bin())
        .args(["--scenario".as_ref(), scenario.as_os_str()])
        .arg("--mcp-config")
        .arg(config.to_string())
        .status()
        .expect("spawn the fake agent");

    assert!(
        !status.success(),
        "a wrong bearer token must fail the call, not quietly succeed"
    );
}

/// Writes a one-step scenario that calls `get_document_state` on `draft.md`. `expect` is the
/// response the call must return; `None` asserts nothing about the response — the call still has
/// to succeed — which is what the wrong-token case needs.
fn write_scenario(dir: &Path, expect: Option<Value>) -> PathBuf {
    let mut call = json!({ "tool": "get_document_state", "arguments": { "doc": "draft.md" } });
    if let Some(expect) = expect {
        call["expect"] = expect;
    }
    let scenario = json!({
        "name": "mcp-injection",
        "steps": [{ "mcp_call": call }]
    });

    let path = dir.join("scenario.json");
    std::fs::write(&path, scenario.to_string()).expect("write the scenario");
    path
}

/// The child stands in only for the external provider CLI. Its advertised Emend status comes
/// from the real HttpToolServer initialize/initialized/tools-list handshake against OpenProject.
#[test]
#[ignore]
fn mcp_binding_provider_subprocess() {
    use fake_agent::{HttpToolServer, ToolServer};
    use std::io::{Read, Write};

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    if let Some(gate) = input["gate"].as_str() {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !Path::new(gate).exists() {
            assert!(
                Instant::now() < deadline,
                "parent never released provider gate"
            );
            std::thread::yield_now();
        }
    }
    let mut tools = HttpToolServer::from_mcp_config(&input["config"]).unwrap();
    let initialized = tools.initialize();
    let connected = initialized.is_ok();
    if !connected {
        assert_eq!(
            initialized.unwrap_err().to_string(),
            "tool call failed: MCP HTTP status 401"
        );
    }
    std::fs::write(
        input["proof"].as_str().unwrap(),
        if connected {
            "initialize and tools/list succeeded"
        } else {
            "initialize refused: HTTP 401"
        },
    )
    .unwrap();
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", json!({
        "type": "system", "subtype": "init", "session_id": "11111111-2222-4333-8444-555555555555",
        "model": "provider-fixture", "claude_code_version": "2.1.200",
        "mcp_servers": [
            {"name": "cowrite-other", "status": "failed"},
            {"name": "cowrite", "status": if connected { "connected" } else { "failed" }},
            {"name": "calendar", "status": "needs-auth"}
        ]
    })).unwrap();
    if connected {
        let document = tools
            .call("get_document_state", &json!({"doc": "draft.md"}))
            .unwrap();
        writeln!(stdout, "{}", json!({
            "type": "result", "subtype": "success", "session_id": "11111111-2222-4333-8444-555555555555",
            "is_error": false, "result": document["content"]
        })).unwrap();
        stdout.flush().unwrap();
    } else {
        writeln!(
            stdout,
            "{}",
            json!({
                "type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": "tool-less-read", "name": "Read",
                    "input": {"file_path": "draft.md"}
                }]}
            })
        )
        .unwrap();
        stdout.flush().unwrap();
        // Keep stdout open: a terminal Failed requires the production queue to stop/reap us.
        loop {
            std::thread::park();
        }
    }
}

#[test]
fn a_failed_real_mcp_handshake_fails_its_run_and_advances_to_a_connected_run() {
    let dir = TempDir::new().unwrap();
    let content = "# A real document\n\nThe bound tools must read these bytes.\n";
    std::fs::write(dir.path().join("draft.md"), content).unwrap();
    let session = open_session(dir.path());
    let spawn_session = Arc::clone(&session);
    let gate = dir.path().join("release-provider");
    let first_proof = dir.path().join("failed-handshake-proof");
    let second_proof = dir.path().join("connected-handshake-proof");
    let spawn_gate = gate.clone();
    let failed_proof = first_proof.clone();
    let connected_proof = second_proof.clone();
    let queue = RunQueue::with_observers(
        move |request: &RunRequest| {
            let (_, argv, cwd, _) = claude_invocation(request, bound_server(&spawn_session), None);
            let mut config = mcp_config_arg(&argv);
            let reject = request.prompt == "reject the binding";
            if reject {
                config["mcpServers"]["cowrite"]["headers"]["Authorization"] =
                    json!("Bearer intentionally-invalid-cowrite-token");
            }
            let input = json!({
                "config": config,
                "gate": if reject { Some(&spawn_gate) } else { None },
                "proof": if reject { &failed_proof } else { &connected_proof }
            });
            AgentSession::spawn_provider_turn_with_stdin(
                std::env::current_exe().unwrap().to_str().unwrap(),
                &[
                    "--ignored".into(),
                    "--exact".into(),
                    "mcp_binding_provider_subprocess".into(),
                    "--nocapture".into(),
                ],
                &cwd,
                input.to_string().as_bytes(),
                false,
            )
        },
        Arc::new(NoopEmitter),
        Arc::new(OpenProjectRunObserver::new(Arc::clone(&session))),
    );
    let first = start_run_on(
        &queue,
        dir.path().display().to_string(),
        "reject the binding".into(),
        vec!["draft.md".into()],
    )
    .unwrap();
    let second = start_run_on(
        &queue,
        dir.path().display().to_string(),
        "use the binding".into(),
        vec!["draft.md".into()],
    )
    .unwrap();
    assert_eq!(second.queued_position, Some(1));
    std::fs::write(&gate, "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while queue.state().finished.len() < 2 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    let state = queue.state();
    if state.finished.len() != 2 {
        // Always reap the deliberately live provider on the red path before asserting.
        queue.stop(&first.id);
        queue.stop(&second.id);
        let cleanup = Instant::now() + Duration::from_secs(5);
        while queue
            .state()
            .active
            .is_some_and(|active| active.phase == RunPhase::Running)
            && Instant::now() < cleanup
        {
            std::thread::yield_now();
        }
    }
    assert_eq!(
        std::fs::read_to_string(first_proof).unwrap(),
        "initialize refused: HTTP 401"
    );
    assert_eq!(
        state.finished.len(),
        2,
        "failed Emend binding did not terminate its live child and advance the queue"
    );
    assert_eq!(state.finished[0].id, first.id);
    assert!(
        matches!(&state.finished[0].phase, RunPhase::Failed { message } if message.contains("Emend") && message.contains("tools")),
        "failed Emend binding did not produce its attributed Failed state: {:?}",
        state.finished[0].phase
    );
    assert!(
        state.finished[0].activity.is_empty(),
        "tool-less activity continued after Emend initialization failed"
    );
    assert_eq!(state.finished[1].id, second.id);
    assert!(
        matches!(&state.finished[1].phase, RunPhase::Completed { reply: Some(reply) } if reply == content.trim()),
        "connected Emend binding was rejected because an unrelated server failed: {:?}",
        state.finished[1].phase
    );
    assert_eq!(
        std::fs::read_to_string(second_proof).unwrap(),
        "initialize and tools/list succeeded"
    );
    assert!(
        !state
            .active
            .is_some_and(|active| active.phase == RunPhase::Running)
            && state.queued.is_empty()
    );
    let mut project = session.lock().unwrap();
    let watchdog = project.as_mut().unwrap().watchdog_mut();
    assert!(!watchdog.is_run_active(&first.id));
    assert!(!watchdog.is_run_active(&second.id));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        content
    );
}

#[test]
#[ignore]
fn permission_provider_subprocess() {
    use fake_agent::tool_server::ToolServer;
    use std::io::{Read, Write};
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    let mut client =
        fake_agent::http_tool_server::HttpToolServer::from_mcp_config(&input["config"]).unwrap();
    client.initialize().unwrap();
    println!(
        "{}",
        json!({"type":"system","subtype":"init","session_id":"permission-fixture","mcp_servers":[{"name":"cowrite","status":"connected"}]})
    );
    std::io::stdout().flush().unwrap();
    let decision = client
        .call("permission_request", &input["callback"])
        .unwrap();
    assert_eq!(
        decision, input["expected"],
        "provider receives the human decision and original input or denial guidance"
    );
    println!(
        "{}",
        json!({"type":"result","subtype":"success","is_error":false,"result":"PERMISSION_DECIDED"})
    );
    std::io::stdout().flush().unwrap();
}

#[test]
fn spawned_permission_callback_carries_allow_deny_stop_and_provider_exit() {
    use emend_lib::agent::permission::{PermissionDecision, PermissionObserver, PermissionState};
    use emend_lib::commands::agent::{decide_permission_on, permission_state_on};
    use std::sync::mpsc;
    for mode in ["allow", "deny", "stop", "exit"] {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("draft.md"), "Protected draft.\n").unwrap();
        let session = new_session();
        let (notice_tx, notice_rx) = mpsc::channel();
        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers {
                permissions: Some(Arc::new(move |state: &PermissionState| {
                    let _ = notice_tx.send(state.clone());
                }) as Arc<dyn PermissionObserver>),
                ..ProjectObservers::default()
            },
        )
        .unwrap();
        let spawn_session = Arc::clone(&session);
        let (kill_tx, kill_rx) = mpsc::channel();
        let callback = json!({"tool_name":"Bash","input":{"command":"python3 verify.py","description":"Verify citations"},"tool_use_id":"tool-fixture"});
        let expected = if mode == "allow" {
            json!({"behavior":"allow","updatedInput":callback["input"]})
        } else {
            json!({"behavior":"deny","message":"Use the existing report instead"})
        };
        let queue = RunQueue::with_observers(
            move |request: &RunRequest| {
                let (_, argv, cwd, _) =
                    claude_invocation(request, bound_server(&spawn_session), None);
                let input =
                    json!({"config":mcp_config_arg(&argv),"callback":callback,"expected":expected});
                let child = AgentSession::spawn_provider_turn_with_stdin(
                    std::env::current_exe().unwrap().to_str().unwrap(),
                    &[
                        "--ignored".into(),
                        "--exact".into(),
                        "permission_provider_subprocess".into(),
                        "--nocapture".into(),
                    ],
                    &cwd,
                    input.to_string().as_bytes(),
                    false,
                )?;
                kill_tx.send(child.kill_handle()).unwrap();
                Ok(child)
            },
            Arc::new(NoopEmitter),
            Arc::new(OpenProjectRunObserver::new(Arc::clone(&session))),
        );
        let run = start_run_on(
            &queue,
            dir.path().display().to_string(),
            "Verify citations".into(),
            vec!["draft.md".into()],
        )
        .unwrap();
        let pending = notice_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("real provider callback must reach the project broker");
        assert_eq!(pending.run_id.as_deref(), Some(run.id.as_str()));
        assert_eq!(pending.requests.len(), 1);
        assert_eq!(
            queue.state().active.unwrap().phase,
            RunPhase::Running,
            "an ignored callback keeps its run active"
        );
        let request_id = pending.requests[0].id.clone();
        match mode {
            "allow" => decide_permission_on(
                &session,
                run.id.clone(),
                request_id.clone(),
                PermissionDecision::AllowOnce,
            )
            .unwrap(),
            "deny" => decide_permission_on(
                &session,
                run.id.clone(),
                request_id.clone(),
                PermissionDecision::Deny {
                    reason: "Use the existing report instead".into(),
                },
            )
            .unwrap(),
            "stop" => {
                assert_eq!(
                    queue.stop(&run.id),
                    emend_lib::agent::run_queue::StopOutcome::Stopped
                );
            }
            "exit" => kill_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .kill()
                .unwrap(),
            _ => unreachable!(),
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = queue
                .state()
                .finished
                .iter()
                .find(|s| s.id == run.id)
                .cloned()
            {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "{mode}: callback terminal cleanup must complete"
            );
            std::thread::yield_now();
        };
        match mode {
            "allow" | "deny" => assert!(
                matches!(status.phase, RunPhase::Completed { .. }),
                "{mode}: {status:?}"
            ),
            "stop" => assert_eq!(status.phase, RunPhase::Stopped { delivered: false }),
            "exit" => assert!(
                matches!(status.phase, RunPhase::Failed { .. }),
                "provider death must not report completion"
            ),
            _ => unreachable!(),
        }
        assert!(
            permission_state_on(&session).requests.is_empty(),
            "terminal cleanup must remove every decision control"
        );
        assert!(
            decide_permission_on(
                &session,
                run.id.clone(),
                request_id,
                PermissionDecision::AllowOnce
            )
            .is_err(),
            "a terminal run must reject stale approval"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
            "Protected draft.\n",
            "a permission decision never changes a protected document"
        );
    }
}
