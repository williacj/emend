// ABOUTME: Integration tests for the protection watchdog (P2a-20, D21, FR-AGENT-2/5, finding M11) —
// ABOUTME: attribution precedence over the real fake-agent misbehavior stream + detect-and-convert.

//! End-to-end attribution precedence, both directions (test-plan §3 security bullet), driven
//! against the shipped fake-agent misbehavior scenario `raw-write-protected` (P0-8):
//!
//! - **Positive** — the fake agent announces a `Write` tool_use for a protected doc *and* performs
//!   a real raw disk write bypassing MCP. The watchdog correlates the two and converts the write to
//!   a tracked change, attributed to the agent (FR-AGENT-5), atomically (FR-AGENT-6).
//! - **Negative** — the same protected doc is overwritten with no correlated stream event (an
//!   external editor / git checkout). The watchdog never converts on a guess; it surfaces the
//!   FR-ED-7 external-change signal (finding M11).

use emend_lib::agent::session::AgentSession;
use emend_lib::agent::watchdog::{Watchdog, WriteOutcome};
use emend_lib::store::changes;
use emend_lib::store::service::SidecarStore;

mod common;
use common::{fake_agent_bin, fake_agent_scenario, workdir};

/// The doc the `raw-write-protected` scenario writes (relative to the run's cwd).
const PROTECTED_DOC: &str = "protected-notes.md";

/// Positive attribution: the fake agent writes a protected doc directly while announcing the write
/// in its stream — the watchdog converts the raw write to a tracked change attributed to the agent.
#[test]
fn raw_write_with_correlated_events_is_converted_to_a_tracked_change() {
    let dir = workdir("watchdog-positive");
    let base = "# Notes\n\nThe original, human-authored notes.\n";
    std::fs::write(dir.join(PROTECTED_DOC), base).unwrap();

    // The doc is open (protected, D21) and targeted by the run.
    let mut watchdog = Watchdog::new(&dir);
    watchdog.open_tab(PROTECTED_DOC);
    watchdog.begin_run("run-1", &[PROTECTED_DOC.to_string()]);

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

    // Feed every streamed event to the watchdog's attribution ledger (as the run loop would).
    while let Some(event) = session.next_event().expect("read a stream-json line") {
        watchdog.observe("run-1", &event.value);
    }
    session.stop().expect("reap the fake agent");

    // The raw write landed on disk (the scenario bypassed MCP).
    let on_disk = std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap();
    assert!(on_disk.contains("Rewritten by a misbehaving agent"));

    // Attribution precedence resolves the detected write to the agent → convert.
    let outcome = watchdog.on_write(PROTECTED_DOC).unwrap();
    let WriteOutcome::Converted { change_ids, .. } = &outcome else {
        panic!("expected a conversion, got {outcome:?}");
    };
    assert!(
        !change_ids.is_empty(),
        "at least one tracked change was created"
    );

    // The doc is no longer the raw overwrite: it carries CriticMarkup (proposed, not applied),
    // and accepting the whole markup would reproduce the agent's intended text.
    let converted = std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap();
    assert!(
        converted.contains("{++") || converted.contains("{--") || converted.contains("{~~"),
        "converted doc carries CriticMarkup, was: {converted:?}"
    );
    let accepted = textops::accept_all(&converted);
    assert!(accepted.contains("Rewritten by a misbehaving agent"));
    // The original text survives inside the markup (nothing silently discarded).
    assert!(converted.contains("# Notes"));

    // Every created change is attributed to the agent (TD-4), and no document is left with partial
    // or untracked markup (FR-AGENT-6) — the on-disk markup round-trips through a clean parse.
    let store = SidecarStore::new(&dir);
    let id = store.doc_id_for_path(PROTECTED_DOC).unwrap().unwrap();
    let fold = store.fold_changes(id).unwrap();
    assert_eq!(fold.changes.len(), change_ids.len());
    for change in fold.changes.values() {
        assert_eq!(change.author, changes::AGENT_AUTHOR);
    }
}

/// Negative attribution: the protected doc is overwritten with no correlated stream event. The
/// watchdog never converts on a guess — it surfaces the FR-ED-7 signal and leaves the doc untouched.
#[test]
fn an_uncorrelated_external_write_is_surfaced_never_converted() {
    let dir = workdir("watchdog-negative");
    let base = "# Notes\n\nThe original, human-authored notes.\n";
    std::fs::write(dir.join(PROTECTED_DOC), base).unwrap();

    let mut watchdog = Watchdog::new(&dir);
    watchdog.open_tab(PROTECTED_DOC);
    watchdog.begin_run("run-1", &[PROTECTED_DOC.to_string()]);
    // The run is live and the doc protected, but no Write is ever announced for it — this write
    // comes from an external editor / git checkout, not the agent.

    let external = "# Notes\n\nEdited in another editor entirely.\n";
    std::fs::write(dir.join(PROTECTED_DOC), external).unwrap();

    assert_eq!(
        watchdog.on_write(PROTECTED_DOC).unwrap(),
        WriteOutcome::ExternalChange
    );

    // Left exactly as the external writer left it — no conversion, no markup, no attribution.
    assert_eq!(
        std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap(),
        external
    );
    let store = SidecarStore::new(&dir);
    assert_eq!(store.doc_id_for_path(PROTECTED_DOC).unwrap(), None);
}
