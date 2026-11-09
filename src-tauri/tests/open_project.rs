// ABOUTME: Integration tests for the TD-17 `OpenProject` aggregate (#472) — one open project's
// ABOUTME: bound MCP server serves over the *same* protected set its watchdog enforces, and
// ABOUTME: announces landed tool calls through the observers the aggregate was opened with.

//! The unit tests in `agent::project` cover the aggregate's identity and canonicalization without a
//! wire. These cover the two claims that are only meaningful *over* it: that the set the tool
//! boundary reads is the watchdog's own live one (TD-17 (c) — the whole point of a shared set is
//! that a tab opened after the server is serving is protected with no rebind), and that the #346/
//! #420 observers reach the bound server's own `McpContext` (TD-17 (d) — the server runs on its own
//! thread with no other route back to the app).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tempfile::TempDir;

use cowrite_lib::agent::birth::{DocumentBirthNotice, DocumentBirthObserver};
use cowrite_lib::agent::delivery::{DeliveryNotice, DeliveryObserver};
use cowrite_lib::agent::project::{OpenProject, ProjectObservers};
use cowrite_lib::agent::watchdog::WriteOutcome;
use cowrite_lib::project_files::{ProjectFilesError, ProjectFilesObserver, ProjectFilesSnapshot};

mod common;
use common::{mcp_call, mcp_call_ok};

/// Records what the bound server announced through each seam.
#[derive(Default)]
struct Recorder {
    delivered: Mutex<Vec<DeliveryNotice>>,
    created: Mutex<Vec<DocumentBirthNotice>>,
    refreshed: Mutex<Vec<ProjectFilesSnapshot>>,
}

impl DeliveryObserver for Recorder {
    fn delivered(&self, notice: &DeliveryNotice) {
        self.delivered.lock().unwrap().push(notice.clone());
    }
}

impl DocumentBirthObserver for Recorder {
    fn created(&self, notice: &DocumentBirthNotice) {
        self.created.lock().unwrap().push(notice.clone());
    }
}

impl ProjectFilesObserver for Recorder {
    fn refresh_started(&self) {}

    fn refresh_completed(&self, snapshot: &ProjectFilesSnapshot) {
        self.refreshed.lock().unwrap().push(snapshot.clone());
    }

    fn refresh_failed(&self, _error: &ProjectFilesError) {}
}

fn observing(recorder: &Arc<Recorder>) -> ProjectObservers {
    ProjectObservers {
        permissions: None,
        delivery: Some(Arc::clone(recorder) as Arc<dyn DeliveryObserver>),
        births: Some(Arc::clone(recorder) as Arc<dyn DocumentBirthObserver>),
        project_files: Some(Arc::clone(recorder) as Arc<dyn ProjectFilesObserver>),
    }
}

/// TD-18's structural claim, over the production aggregate rather than a constructed watcher: one
/// real OS notification reaches **both** consumers of the single root-recursive subscription.
///
/// The two halves are checked in the order the fanout guarantees. A completed automatic refresh
/// proves the project-files consumer saw the event; because the watchdog is fed first, from the same
/// event, in the same worker iteration, the D21 half is already done by then — so the `on_write`
/// below reports `Unchanged` only if the `DocWatcher` had itself already advanced that baseline.
/// (Were the watchdog not fed, this call would surface the write as `ExternalChange` instead.)
#[test]
fn one_real_native_write_reaches_both_the_watchdog_and_an_automatic_project_files_refresh() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), "# Draft\n").unwrap();
    let recorder = Arc::new(Recorder::default());
    let mut project = OpenProject::open(dir.path(), observing(&recorder)).unwrap();
    project.watchdog_mut().open_tab("draft.md");

    std::fs::write(
        dir.path().join("draft.md"),
        "# Draft\n\nExternally edited.\n",
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let refreshed = loop {
        if let Some(snapshot) = recorder.refreshed.lock().unwrap().last().cloned() {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the native event to reach the project-files consumer"
        );
        std::thread::yield_now();
    };

    assert!(
        refreshed
            .entries
            .iter()
            .any(|entry| entry.path == "draft.md"),
        "the automatic refresh published a completed generation of the real tree"
    );
    assert_eq!(
        project.watchdog_mut().on_write("draft.md").unwrap(),
        WriteOutcome::Unchanged,
        "the same native event had already reached the D21 watchdog"
    );
}

/// TD-17 (c): the tool boundary and the watchdog read one union. A doc that enters the protected
/// set *after* the server is already serving is reported protected at the next tool call — no
/// rebind, no restart. This is what #414's design premise needs and what #497's producers will
/// drive for real.
#[test]
fn a_doc_protected_after_binding_is_reported_protected_at_the_tool_boundary() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), "# Draft\n").unwrap();

    let mut project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();
    let server = project.mcp_server();

    let before = mcp_call_ok(
        server.addr,
        &server.token,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    assert_eq!(
        before["result"]["structuredContent"]["protection"],
        "unprotected"
    );

    // The producer #497 will own; here it stands in for a tab opening while the server serves.
    project.watchdog_mut().open_tab("draft.md");

    let after = mcp_call_ok(
        server.addr,
        &server.token,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    assert_ne!(
        after["result"]["structuredContent"]["protection"], "unprotected",
        "the set the server reports from is the watchdog's own live set"
    );
}

/// TD-17 (d), the J2 birth pipe (#420): a `create_document` landing on the aggregate's bound server
/// reaches the observer the project was opened with — the app's only route back from that thread.
#[test]
fn a_create_document_on_the_bound_server_reaches_the_projects_birth_observer() {
    let dir = TempDir::new().unwrap();
    let recorder = Arc::new(Recorder::default());
    let project = OpenProject::open(dir.path(), observing(&recorder)).unwrap();
    let server = project.mcp_server();

    let response = mcp_call_ok(
        server.addr,
        &server.token,
        "create_document",
        json!({ "path": "drafts/outline.md", "content": "# Outline\n" }),
    );
    assert_eq!(
        response["result"]["structuredContent"]["path"],
        "drafts/outline.md"
    );

    let created = recorder.created.lock().unwrap();
    assert_eq!(created.len(), 1, "one landed create_document, one notice");
    assert_eq!(created[0].path, "drafts/outline.md");
    assert_eq!(created[0].size, "# Outline\n".len() as u64);
}

/// TD-17 (d), the J1 Phase B delivery pipe (#346): the sibling claim for `propose_changes`. Both
/// seams have to reach the *same* binding — before this card, `agent::mcp` could give a server a
/// shared protected set **or** an observer, never both, so an aggregate holding all of them was
/// not expressible.
#[test]
fn a_propose_changes_on_the_bound_server_reaches_the_projects_delivery_observer() {
    let dir = TempDir::new().unwrap();
    let base = "hello world\n";
    std::fs::write(dir.path().join("draft.md"), base).unwrap();

    let recorder = Arc::new(Recorder::default());
    let project = OpenProject::open(dir.path(), observing(&recorder)).unwrap();
    let server = project.mcp_server();

    // The agent reads first (which is what remembers the base revision), then proposes against it.
    let state = mcp_call_ok(
        server.addr,
        &server.token,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let revision = state["result"]["structuredContent"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let response = mcp_call_ok(
        server.addr,
        &server.token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": revision,
            "edits": [
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ],
            "summary": "Made it braver"
        }),
    );
    assert!(
        response["result"]["structuredContent"].is_object(),
        "{response}"
    );

    let delivered = recorder.delivered.lock().unwrap();
    assert_eq!(delivered.len(), 1, "one landed delivery, one notice");
    assert_eq!(delivered[0].doc, "draft.md");
    assert_eq!(delivered[0].summary, "Made it braver");
    assert!(delivered[0].content.contains("brave"));
}

/// The token guards the aggregate's server exactly as it guards a bare `ProjectMcpServer`: a call
/// with the wrong bearer is refused (401) before any tool runs, and nothing is announced.
#[test]
fn a_wrong_bearer_token_is_refused_before_any_tool_runs_on_an_open_project() {
    let dir = TempDir::new().unwrap();
    let recorder = Arc::new(Recorder::default());
    let project = OpenProject::open(dir.path(), observing(&recorder)).unwrap();
    let server = project.mcp_server();

    let (status, _) = mcp_call(
        server.addr,
        Some("not-the-minted-token"),
        "create_document",
        json!({ "path": "drafts/outline.md", "content": "# Outline\n" }),
    );

    assert_eq!(status, 401);
    assert!(recorder.created.lock().unwrap().is_empty());
    assert!(!dir.path().join("drafts/outline.md").exists());
}
