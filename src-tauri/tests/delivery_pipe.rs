// ABOUTME: Integration tests for the J1 Phase B delivery pipe (#346) — a `propose_changes` call
// ABOUTME: arriving over the real loopback MCP server raises a `DeliveryNotice` carrying everything
// ABOUTME: the open editor and the timeline card need, and only ever for a complete landed set.

//! The backend half of the pipe, driven the way a real agent drives it: JSON-RPC `tools/call` over
//! `ProjectMcpServer`'s loopback+bearer socket, on the server's own thread, with a
//! `DeliveryObserver` standing in for the app's frontend bridge.
//!
//! This is deliberately *not* run through `fake-agent`'s `claude-mcp-propose` scenario, though that
//! scenario is the closest existing fixture: its `propose_changes` step is anchored to the stub
//! server's canned `rev-stub-0001` and asserts a canned `cs-stub-0001` change-set id, neither of
//! which a real `McpContext` can produce — against the real tool surface that revision has no
//! recoverable base, so the scenario delivers *nothing* (the wholly-stale path) and there is no
//! delivery left to observe. Driving the real server directly is what actually exercises the seam;
//! the fake-agent scenario keeps covering what it was built for (P0-7's schema-validated round-trip
//! against the stub).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tempfile::TempDir;

use cowrite_lib::agent::delivery::{DeliveryNotice, DeliveryObserver};
use cowrite_lib::agent::mcp::ProjectMcpServer;

mod common;
use common::mcp_call_ok;

/// Captures every notice, plus the document text as it stood when that notice arrived.
struct RecordingObserver {
    doc_path: PathBuf,
    seen: Mutex<Vec<(DeliveryNotice, String)>>,
}

impl RecordingObserver {
    fn new(doc_path: PathBuf) -> Arc<RecordingObserver> {
        Arc::new(RecordingObserver {
            doc_path,
            seen: Mutex::new(Vec::new()),
        })
    }

    fn seen(&self) -> Vec<(DeliveryNotice, String)> {
        self.seen.lock().unwrap().clone()
    }
}

impl DeliveryObserver for RecordingObserver {
    fn delivered(&self, notice: &DeliveryNotice) {
        let on_disk = std::fs::read_to_string(&self.doc_path).unwrap_or_default();
        self.seen.lock().unwrap().push((notice.clone(), on_disk));
    }
}

/// A project with `draft.md`, its server bound with a recording observer, and the bearer token.
fn project(content: &str) -> (TempDir, ProjectMcpServer, String, Arc<RecordingObserver>) {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), content).unwrap();
    let observer = RecordingObserver::new(dir.path().join("draft.md"));
    let server = ProjectMcpServer::open_observing(
        dir.path(),
        Arc::clone(&observer) as Arc<dyn DeliveryObserver>,
    )
    .expect("bind the project's MCP server");
    let token = server.mcp_server().token;
    (dir, server, token, observer)
}

/// Written first (#346 acceptance): a completed `propose_changes` arriving over the wire reaches the
/// app as one notice carrying the delivered markup, its revision, and the change-set identity the
/// timeline card renders — the whole reason this seam exists.
#[test]
fn a_delivery_over_the_wire_reaches_the_app_as_one_complete_notice() {
    let (_dir, server, token, observer) = project("hello world\n");

    // The agent reads the doc first, exactly as J1 Phase A does — that read is what makes the
    // revision it anchors its proposal to a recoverable base (TD-7).
    let state = mcp_call_ok(
        server.local_addr(),
        &token,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let revision = state["result"]["structuredContent"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let response = mcp_call_ok(
        server.local_addr(),
        &token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": revision,
            "summary": "Tightened the opening.",
            "edits": [
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]
        }),
    );
    let result = &response["result"]["structuredContent"];
    assert_eq!(result["applied"].as_array().unwrap().len(), 1);

    let seen = observer.seen();
    assert_eq!(seen.len(), 1, "one landed delivery, one notice");
    let (notice, on_disk_when_notified) = &seen[0];

    assert_eq!(notice.doc, "draft.md");
    assert_eq!(
        notice.change_set_id,
        result["change_set_id"].as_str().unwrap()
    );
    assert_eq!(notice.revision, result["revision"].as_str().unwrap());
    assert_eq!(notice.summary, "Tightened the opening.");
    assert_eq!(notice.content, "hello {++brave ++}world\n");
    assert_eq!(notice.changes.len(), 1);
    assert_eq!(notice.changes[0].note.as_deref(), Some("clarity"));

    // FR-AGENT-6 end to end at this seam: by the time anything can observe the delivery, the
    // complete set is already the document — never a half-written intermediate.
    assert_eq!(on_disk_when_notified, &notice.content);
}

/// FR-AGENT-6's "or nothing" half, over the wire: a delivery anchored to a revision the server never
/// served has no recoverable base, lands nothing, and must raise no notice — otherwise the timeline
/// grows an empty change-set card for a revision that never happened.
#[test]
fn a_delivery_that_lands_nothing_raises_no_notice() {
    let (dir, server, token, observer) = project("hello world\n");

    let response = mcp_call_ok(
        server.local_addr(),
        &token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": "rev-never-served",
            "summary": "Nothing survives this.",
            "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }]
        }),
    );

    assert!(response["result"]["structuredContent"]["applied"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(observer.seen().is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        "hello world\n",
        "a wholly stale delivery leaves the document untouched"
    );
}

/// TD-7 over the wire: the user keeps typing while the agent works, so part of the proposal can no
/// longer be rebased. What lands is still one complete attributed set, and the notice reports the
/// stale remainder honestly rather than implying the whole proposal applied.
#[test]
fn a_partly_stale_delivery_notifies_the_applied_subset_and_its_stale_count() {
    let (dir, server, token, observer) = project("one two three four five\n");

    let state = mcp_call_ok(
        server.local_addr(),
        &token,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let revision = state["result"]["structuredContent"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    // The drift: "five" -> "FIVE", under the agent's feet.
    std::fs::write(dir.path().join("draft.md"), "one two three four FIVE\n").unwrap();

    let response = mcp_call_ok(
        server.local_addr(),
        &token,
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": revision,
            "summary": "Two edits, one of them overtaken.",
            "edits": [
                { "range": { "offset": 0, "length": 3 }, "replacement": "ONE" },
                { "range": { "offset": 19, "length": 4 }, "replacement": "cinq" }
            ]
        }),
    );
    let result = &response["result"]["structuredContent"];

    let seen = observer.seen();
    assert_eq!(seen.len(), 1);
    let (notice, on_disk_when_notified) = &seen[0];

    assert_eq!(
        notice.changes.len(),
        result["applied"].as_array().unwrap().len()
    );
    assert_eq!(notice.stale, result["stale"].as_array().unwrap().len());
    assert!(notice.stale > 0, "the overtaken edit is genuinely stale");
    assert!(!notice.changes.is_empty(), "the surviving edit still lands");
    // The partial outcome is itself atomic: complete on disk before anyone hears about it.
    assert_eq!(on_disk_when_notified, &notice.content);
}
