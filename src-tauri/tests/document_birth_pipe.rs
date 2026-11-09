// ABOUTME: Integration tests for the J2 document-birth pipe (#420) — a `create_document` call
// ABOUTME: arriving over the real loopback MCP server raises a `DocumentBirthNotice` carrying the
// ABOUTME: created path and its size, and only once the write actually landed.

//! Mirrors `tests/delivery_pipe.rs`'s own driving style for the sibling pipe: JSON-RPC `tools/call`
//! over `ProjectMcpServer`'s loopback+bearer socket (`common::mcp_call_ok`), on the server's own
//! thread, with a `DocumentBirthObserver` standing in for the app's frontend bridge.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tempfile::TempDir;

use emend_lib::agent::birth::{DocumentBirthNotice, DocumentBirthObserver};
use emend_lib::agent::mcp::ProjectMcpServer;

mod common;
use common::mcp_call_ok;

/// Captures every birth notice this observer is handed.
struct RecordingBirthObserver {
    seen: Mutex<Vec<DocumentBirthNotice>>,
}

impl RecordingBirthObserver {
    fn new() -> Arc<RecordingBirthObserver> {
        Arc::new(RecordingBirthObserver {
            seen: Mutex::new(Vec::new()),
        })
    }

    fn seen(&self) -> Vec<DocumentBirthNotice> {
        self.seen.lock().unwrap().clone()
    }
}

impl DocumentBirthObserver for RecordingBirthObserver {
    fn created(&self, notice: &DocumentBirthNotice) {
        self.seen.lock().unwrap().push(notice.clone());
    }
}

/// Written first (#420 acceptance): a completed `create_document` arriving over the wire reaches
/// the app as one notice carrying the created path and its size — the whole reason this seam
/// exists (the app opens the path as a tab and raises the J2 birth card from it, out of this
/// backend seam's own scope).
#[test]
fn a_created_document_over_the_wire_reaches_the_app_as_one_birth_notice() {
    let dir = TempDir::new().unwrap();
    let observer = RecordingBirthObserver::new();
    let server = ProjectMcpServer::open_observing_births(
        dir.path(),
        Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>,
    )
    .expect("bind the project's MCP server");
    let token = server.mcp_server().token;

    let response = mcp_call_ok(
        server.local_addr(),
        &token,
        "create_document",
        json!({ "path": "drafts/outline.md", "content": "# Outline\n\nOnce upon a time.\n" }),
    );

    assert_eq!(
        response["result"]["structuredContent"]["path"],
        "drafts/outline.md"
    );

    let seen = observer.seen();
    assert_eq!(seen.len(), 1, "one landed create_document, one notice");
    assert_eq!(seen[0].path, "drafts/outline.md");
    assert_eq!(
        seen[0].size,
        "# Outline\n\nOnce upon a time.\n".len() as u64
    );
}

// D21's refusal path (a `path` naming an already-protected document raises no birth notice) needs
// a pre-seeded protected set, which this file's wire helper — `open_observing_births` always starts
// its own fresh, empty one — has no way to give it; `agent::state`'s own
// `create_document_refused_over_d21_protection_notifies_no_birth` already covers exactly this
// against `McpContext` directly, so it is not re-driven here just to claim wire coverage the setup
// can't actually provide.
