// ABOUTME: Integration tests for feeding the D21 watchdog's `ProtectedSet` from the live open-tab
// ABOUTME: set + a run's operation targets (issue #414, split of #344) — one shared live union, not
// ABOUTME: two independently-fed copies, enforced identically by the watchdog and the MCP tool boundary.

//! Issue #414 acceptance, driven end-to-end rather than against a hand-populated set (already
//! covered by `agent::watchdog`'s and `agent::state`'s own unit tests):
//!
//! - The `ProtectedSet` the watchdog consults is populated from the live open-tab set and the
//!   active run's operation targets, and tracks tab open/close during a run — a document opened
//!   mid-run becomes protected with no restart (`a_tab_opened_mid_run_...`).
//! - The union is genuine: an operation-target-only doc (never a tab) is still protected
//!   (`an_operation_target_never_opened_as_a_tab_...`).
//! - A direct-write attempt against a document in the set is refused — never left a silent
//!   overwrite, converted to tracked changes — at the tool boundary (D21); the same write against
//!   an unopened, untargeted file is allowed (D3). Both directions are tested
//!   (`raw_write_to_a_doc_protected_only_via_the_live_feed_...`,
//!   `raw_write_to_an_unopened_untargeted_file_...`).
//! - Driven through the real `fake-agent` binary against a bound `ProjectMcpServer`, no network
//!   (every test here; the positive-attribution case additionally spawns the real fake-agent, as
//!   `tests/protection_watchdog.rs` does for the hand-populated case).

use std::sync::{Arc, Mutex};

use serde_json::json;

use emend_lib::agent::mcp::ProjectMcpServer;
use emend_lib::agent::session::AgentSession;
use emend_lib::agent::watchdog::{ProtectedSet, Watchdog, WriteOutcome};
use emend_lib::store::changes;
use emend_lib::store::service::SidecarStore;

mod common;
use common::{fake_agent_bin, fake_agent_scenario, mcp_call_ok, workdir};

/// The doc the `raw-write-protected` scenario writes (relative to the run's cwd).
const PROTECTED_DOC: &str = "protected-notes.md";

/// `get_document_state`'s `protection` field for `doc`, via a real loopback call to `server`.
fn protection_of(server: &ProjectMcpServer, token: &str, doc: &str) -> String {
    let body = mcp_call_ok(
        server.local_addr(),
        token,
        "get_document_state",
        json!({ "doc": doc }),
    );
    body["result"]["structuredContent"]["protection"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Acceptance 1: a doc opened as a tab *after* the server is already bound and serving is reported
/// protected at the tool boundary immediately — the live feed, not a snapshot taken at bind time —
/// and closing the tab again releases it. No restart, no rebind.
#[test]
fn a_tab_opened_mid_run_is_protected_at_the_tool_boundary_without_restarting_the_server() {
    let dir = workdir("live-feed-tab-open-mid-run");
    std::fs::write(dir.join("draft.md"), "hello\n").unwrap();

    let shared = Arc::new(Mutex::new(ProtectedSet::new()));
    let server = ProjectMcpServer::open_with_protection(&dir, Arc::clone(&shared))
        .expect("bind the project's MCP server");
    let token = server.mcp_server().token;
    let mut watchdog = Watchdog::with_protected_set(&dir, Arc::clone(&shared));

    assert_eq!(protection_of(&server, &token, "draft.md"), "unprotected");

    watchdog.open_tab("draft.md");
    assert_eq!(
        protection_of(&server, &token, "draft.md"),
        "protected",
        "opening the tab mid-session must be visible at the tool boundary with no restart"
    );

    watchdog.close_tab("draft.md");
    assert_eq!(protection_of(&server, &token, "draft.md"), "unprotected");
}

/// Acceptance 3: the union is genuine. A doc pinned only as a run's operation target — never opened
/// as a tab — is still reported protected; an unrelated, untargeted file stays unprotected (the
/// permissive half, so a wrong implementation that only wires tabs can't hide).
#[test]
fn an_operation_target_never_opened_as_a_tab_is_still_protected_the_union_is_genuine() {
    let dir = workdir("live-feed-operation-target-union");
    std::fs::write(dir.join("targeted.md"), "x\n").unwrap();
    std::fs::write(dir.join("untouched.md"), "y\n").unwrap();

    let shared = Arc::new(Mutex::new(ProtectedSet::new()));
    let server = ProjectMcpServer::open_with_protection(&dir, Arc::clone(&shared))
        .expect("bind the project's MCP server");
    let token = server.mcp_server().token;
    let mut watchdog = Watchdog::with_protected_set(&dir, Arc::clone(&shared));

    watchdog.begin_run("run-1", &["targeted.md".to_string()]);

    assert_eq!(protection_of(&server, &token, "targeted.md"), "protected");
    assert_eq!(
        protection_of(&server, &token, "untouched.md"),
        "unprotected"
    );
}

/// Acceptance 2 (positive direction) + 4: a doc protected *only* via the live tab-open/run-target
/// feed — never hand-populated into a `ProtectedSet` directly — still catches a raw write from the
/// real fake-agent binary and converts it to a tracked change, exactly as the hand-populated case in
/// `tests/protection_watchdog.rs` does. Driven against a bound `ProjectMcpServer` sharing the same
/// live set, loopback only, no network.
#[test]
fn raw_write_to_a_doc_protected_only_via_the_live_feed_is_converted_never_silently_overwritten() {
    let dir = workdir("live-feed-watchdog-positive");
    let base = "# Notes\n\nThe original, human-authored notes.\n";
    std::fs::write(dir.join(PROTECTED_DOC), base).unwrap();

    let shared = Arc::new(Mutex::new(ProtectedSet::new()));
    let server = ProjectMcpServer::open_with_protection(&dir, Arc::clone(&shared))
        .expect("bind the project's MCP server");
    let token = server.mcp_server().token;
    let mut watchdog = Watchdog::with_protected_set(&dir, Arc::clone(&shared));

    // The doc becomes protected purely through the live feed: opened as a tab, then targeted by
    // the run — exactly what a real J1 turn does, not a test-only shortcut.
    watchdog.open_tab(PROTECTED_DOC);
    watchdog.begin_run("run-1", &[PROTECTED_DOC.to_string()]);
    assert_eq!(
        protection_of(&server, &token, PROTECTED_DOC),
        "protected",
        "the bound server's tool boundary must see the same live set the watchdog enforces against"
    );

    // Drive the real fake-agent: it announces a Write tool_use and performs the raw disk write.
    let scenario = fake_agent_scenario("claude-raw-write-protected.json");
    let mut session = AgentSession::spawn(
        fake_agent_bin().to_str().unwrap(),
        &[
            "--scenario".to_string(),
            scenario.to_str().unwrap().to_string(),
        ],
        &dir,
    )
    .expect("spawn the fake-agent stand-in");

    while let Some(event) = session.next_event().expect("read a stream-json line") {
        watchdog.observe("run-1", &event.value);
    }
    session.stop().expect("reap the fake agent");

    let on_disk = std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap();
    assert!(on_disk.contains("Rewritten by a misbehaving agent"));

    let outcome = watchdog.on_write(PROTECTED_DOC).unwrap();
    let WriteOutcome::Converted { change_ids, .. } = &outcome else {
        panic!("expected a conversion, got {outcome:?}");
    };
    assert!(
        !change_ids.is_empty(),
        "at least one tracked change was created"
    );

    let converted = std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap();
    assert!(
        converted.contains("{++") || converted.contains("{--") || converted.contains("{~~"),
        "converted doc carries CriticMarkup, was: {converted:?}"
    );
    assert!(
        converted.contains("# Notes"),
        "original text survives inside the markup"
    );

    let store = SidecarStore::new(&dir);
    let id = store.doc_id_for_path(PROTECTED_DOC).unwrap().unwrap();
    let fold = store.fold_changes(id).unwrap();
    assert_eq!(fold.changes.len(), change_ids.len());
    for change in fold.changes.values() {
        assert_eq!(change.author, changes::AGENT_AUTHOR);
    }

    // The tool boundary now folds in the delivered attribution too — the watchdog's conversion and
    // the MCP context's reporting are reading the very same sidecar store, not two views that could
    // disagree.
    let body = mcp_call_ok(
        server.local_addr(),
        &token,
        "get_document_state",
        json!({ "doc": PROTECTED_DOC }),
    );
    assert_eq!(
        body["result"]["structuredContent"]["pending_changes"]
            .as_array()
            .unwrap()
            .len(),
        change_ids.len()
    );
}

/// Acceptance 2 (permissive direction, D3): a file that was never opened as a tab and never
/// targeted by a run stays direct-writable — the watchdog leaves a raw write to it completely
/// alone, and the bound server reports it unprotected throughout. This is the direction where a
/// wrong implementation (e.g. "protect everything" or a stale/duplicated union) most easily hides.
#[test]
fn raw_write_to_an_unopened_untargeted_file_is_left_alone_direct_writable_per_d3() {
    let dir = workdir("live-feed-watchdog-negative");
    std::fs::write(dir.join("loose.md"), "anything\n").unwrap();

    let shared = Arc::new(Mutex::new(ProtectedSet::new()));
    let server = ProjectMcpServer::open_with_protection(&dir, Arc::clone(&shared))
        .expect("bind the project's MCP server");
    let token = server.mcp_server().token;
    let mut watchdog = Watchdog::with_protected_set(&dir, Arc::clone(&shared));

    // A sibling doc *is* live-protected, so this isn't "nothing is ever protected" vacuously
    // passing — only `loose.md` is exempt.
    watchdog.open_tab("sibling.md");

    assert_eq!(protection_of(&server, &token, "loose.md"), "unprotected");

    let external = "edited directly, outside any tab or run\n";
    std::fs::write(dir.join("loose.md"), external).unwrap();

    assert_eq!(
        watchdog.on_write("loose.md").unwrap(),
        WriteOutcome::Unprotected,
        "an unopened, untargeted file must be left alone, not intercepted"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("loose.md")).unwrap(),
        external
    );

    let store = SidecarStore::new(&dir);
    assert_eq!(
        store.doc_id_for_path("loose.md").unwrap(),
        None,
        "no attribution was ever recorded for a direct-writable file"
    );
    assert_eq!(protection_of(&server, &token, "loose.md"), "unprotected");
}
