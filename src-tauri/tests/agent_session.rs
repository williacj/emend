// ABOUTME: Integration tests for the Claude Code adapter's session lifecycle (P2a-15, TD-5) —
// ABOUTME: stdin prompts, spawn/stream/resume, activity feed, and process-group stop behavior.

use std::path::{Path, PathBuf};

use cowrite_lib::agent::claude::{self, McpServer, SpawnRequest};
use cowrite_lib::agent::session::AgentSession;

mod common;
use common::{fake_agent_bin, fake_agent_scenario, workdir};

/// Path to a scenario fixture local to these tests (`tests/fixtures/`).
fn local_scenario(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn spawn(scenario: &Path, cwd: &Path) -> AgentSession {
    spawn_with_extra_args(scenario, cwd, &[])
}

/// Like [`spawn`], with extra argv appended after `--scenario <path>` — used by tests that need
/// a fake-agent flag beyond the scenario itself (e.g. `--noisy-stderr`).
fn spawn_with_extra_args(scenario: &Path, cwd: &Path, extra: &[&str]) -> AgentSession {
    let mut args = vec![
        "--scenario".to_string(),
        scenario.to_str().unwrap().to_string(),
    ];
    args.extend(extra.iter().map(|s| s.to_string()));
    AgentSession::spawn(fake_agent_bin().to_str().unwrap(), &args, cwd)
        .expect("spawn the fake-agent stand-in")
}

/// Drains every remaining event from `session`, returning the fully rendered activity-feed lines
/// in stream order.
fn drain_activity_lines(session: &mut AgentSession) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(event) = session.next_event().expect("read a stream-json line") {
        for line in event.activity {
            lines.push(line.label());
        }
    }
    lines
}

/// Issue #803 / D13 / FR-X-1: the prompt must cross the real process boundary on stdin, where it
/// is not subject to Windows' 32,767-character command-line ceiling. This integration-test binary
/// uses the existing cross-platform fake-agent binary as the child, with its test-support mode
/// reporting stdin verbatim as one JSON event for `AgentSession` to parse.
#[test]
fn a_large_prompt_crosses_the_process_boundary_on_stdin() {
    let prompt = "x".repeat(1024 * 1024);
    let args = vec![
        "--scenario".to_string(),
        fake_agent_scenario("claude-minimal-success.json")
            .to_str()
            .unwrap()
            .to_string(),
        "--report-stdin".to_string(),
    ];
    let dir = workdir("large-prompt-stdin");
    let mut session = AgentSession::spawn_with_stdin(
        fake_agent_bin().to_str().unwrap(),
        &args,
        &dir,
        prompt.as_bytes(),
    )
    .expect("spawn the stdin-reading child");

    let event = session
        .next_event()
        .expect("read the child's JSON event")
        .expect("the child reports the received prompt");
    assert_eq!(event.value["stdin"], prompt);
    while session.next_event().unwrap().is_some() {}
    session.stop().unwrap();
}

#[test]
fn spawn_and_stream_renders_the_j1_activity_feed_in_order() {
    let dir = workdir("activity-feed");
    let mut session = spawn(&fake_agent_scenario("claude-read-then-answer.json"), &dir);

    let lines = drain_activity_lines(&mut session);
    // The scenario: reads README.md, then answers in prose — the feed renders both, in order.
    assert_eq!(
        lines,
        vec![
            "Reading /tmp/project/README.md".to_string(),
            "Drafting…".to_string()
        ]
    );
}

/// Issue #1820 review finding 1: drive the production spawn -> stored cwd -> `next_event` path,
/// not `activity_lines` directly. The fake agent expands `${PROJECT_ROOT}` to its canonical cwd;
/// changing `next_event` to derive against `.` therefore loses this project-relative identity.
#[test]
fn spawned_session_threads_its_project_root_into_read_activity_identity() {
    let dir = workdir("session-project-root-activity-identity");
    std::fs::write(dir.join("sermon.md"), "text").unwrap();
    let mut session = spawn(&local_scenario("claude-project-root-read.json"), &dir);

    let event = session
        .next_event()
        .expect("read the fake agent's stream-json line")
        .expect("the fake agent emits its Read event");

    assert_eq!(event.activity.len(), 1);
    assert_eq!(
        event.activity[0].path_identity.as_deref(),
        Some("sermon.md"),
        "AgentSession threads its project root into Read identity derivation"
    );
    while session.next_event().unwrap().is_some() {}
}

/// Issue #1118 / J2 ("agent asks a clarifying question instead of drafting — normal chat") /
/// Principle 5: the agent's answer is the point of a chat turn, so the session has to capture it
/// off the stream. Driven against the read-then-answer scenario — the fake-agent stand-in for
/// exactly the failing case: a run whose whole output is prose, with one tool call along the way.
#[test]
fn a_turns_reply_text_is_captured_off_the_terminal_result_event() {
    let dir = workdir("reply-capture");
    let mut session = spawn(&fake_agent_scenario("claude-read-then-answer.json"), &dir);

    // Nothing is captured before the terminal event has been read.
    assert_eq!(session.reply(), None);

    while session.next_event().unwrap().is_some() {}

    assert_eq!(session.reply(), Some("The project is a sample project."));
}

/// The near-match: a run whose stream ends before any terminal `result` event (this scenario exits
/// code 37 mid-delivery) must leave the reply empty rather than inventing one.
#[test]
fn a_turn_that_never_answers_captures_no_reply() {
    let dir = workdir("reply-absent");
    let mut session = spawn(&fake_agent_scenario("claude-mid-delivery-death.json"), &dir);

    while session.next_event().unwrap().is_some() {}

    assert_eq!(session.reply(), None);
}

/// The session reports facts; policy is the run queue's. A delivering turn's answer is still
/// captured here — and `saw_delivery` alongside it — so the seam stays honest about what the
/// provider actually said, and CJ's #1118 ruling (no chat card beside a delivery) is decided in
/// one place, `agent::run_queue::drain_and_advance`, from both facts together.
#[test]
fn a_delivering_turn_captures_both_its_reply_and_the_delivery() {
    let dir = workdir("reply-with-delivery");
    let mut session = spawn(&local_scenario("claude-propose-then-answer.json"), &dir);

    assert!(!session.saw_delivery());

    while session.next_event().unwrap().is_some() {}

    assert_eq!(
        session.reply(),
        Some("Tightened the hook and fixed two citations in draft.md.")
    );
    assert!(session.saw_delivery());
}

/// The discriminating negative for the same signal: a turn that read the document and answered —
/// no `propose_changes`, no `add_comments` — is not a delivery, so its reply is the one thing it
/// produced and must survive.
#[test]
fn a_prose_only_turn_reports_no_delivery() {
    let dir = workdir("reply-without-delivery");
    let mut session = spawn(&fake_agent_scenario("claude-read-then-answer.json"), &dir);

    while session.next_event().unwrap().is_some() {}

    assert!(!session.saw_delivery());
    assert_eq!(session.reply(), Some("The project is a sample project."));
}

#[test]
fn spawn_captures_the_session_id_and_provider_version_from_system_init() {
    let dir = workdir("session-id-and-version");
    let mut session = spawn(&fake_agent_scenario("claude-minimal-success.json"), &dir);

    // Nothing is captured before the first event is read.
    assert_eq!(session.session_id(), None);

    while session.next_event().unwrap().is_some() {}

    assert_eq!(
        session.session_id(),
        Some("e6639704-0d4d-497d-8898-ef5a938ef849")
    );
    assert_eq!(session.provider_version(), Some("2.1.200"));
    // TD §3.4 version-detect: this scenario's version is exactly the pinned minimum, so no drift
    // warning fires.
    assert_eq!(
        claude::version_warning(session.provider_version().unwrap()),
        None
    );
}

#[test]
fn a_captured_session_id_flows_into_the_next_spawns_resume_flag() {
    // Run 1: capture the provider session id off a completed run.
    let dir = workdir("resume-flow");
    let mut first = spawn(&fake_agent_scenario("claude-minimal-success.json"), &dir);
    while first.next_event().unwrap().is_some() {}
    let session_id = first.session_id().expect("session id captured").to_string();
    first.stop().expect("stop a fully-exited session cleanly");

    // Run 2: our side must reattach to the *same* provider session (D4 continuity) — assert the
    // adapter's own argv construction carries the id forward as `--resume`.
    let request = SpawnRequest {
        project_dir: dir,
        mcp_server: Some(McpServer {
            addr: "127.0.0.1:1".parse().unwrap(),
            token: "unused-in-this-test".to_string(),
            run_id: None,
        }),
        resume_session_id: Some(session_id.clone()),
    };
    let args = claude::build_args(&request);
    let idx = args
        .iter()
        .position(|a| a == "--resume")
        .expect("--resume present");
    assert_eq!(args[idx + 1], session_id);
}

/// FR-AGENT-6: a run stopped before any `propose_changes` call leaves the doc byte-identical.
/// `stop` kills the whole process group (TD-5) — proven here by a scenario that hangs forever
/// before ever reaching a delivery or raw write; without a group-kill this test would hang the
/// suite instead of passing.
#[test]
fn stop_kills_a_hung_session_and_the_protected_doc_is_left_untouched() {
    let dir = workdir("stop-before-delivery");
    let doc_path = dir.join("draft.md");
    let original = "# Draft\n\nOriginal content, never touched.\n";
    std::fs::write(&doc_path, original).unwrap();

    let mut session = spawn(&local_scenario("claude-hang-before-delivery.json"), &dir);

    // Read the two pre-hang events (a condition-based wait, not a sleep — test-plan §4).
    let init = session.next_event().unwrap().expect("system/init event");
    assert_eq!(init.value["type"], "system");
    let turn = session.next_event().unwrap().expect("assistant text event");
    assert_eq!(turn.value["type"], "assistant");

    // The agent never called propose_changes, and the doc is exactly as written.
    assert!(!session.saw_propose_changes());
    assert_eq!(std::fs::read_to_string(&doc_path).unwrap(), original);

    // The process is genuinely hung (parked forever past the `hang` step) — stop() must be able
    // to reap it via a process-group kill, not merely a `Child::kill` on a process that has
    // already exited on its own.
    session.stop().expect("stop kills the whole process group");

    // Untouched after stop, too — the invariant this test exists to pin.
    assert_eq!(std::fs::read_to_string(&doc_path).unwrap(), original);
}

/// The misbehavior repertoire's malformed-output case (test-plan §1): the consumer's line parser
/// must survive a non-JSON line rather than treat it as fatal.
#[test]
fn malformed_lines_in_the_stream_are_skipped_not_fatal() {
    let dir = workdir("malformed-output");
    let mut session = spawn(&fake_agent_scenario("claude-malformed-output.json"), &dir);

    let mut saw_at_least_one_event = false;
    while let Some(_event) = session
        .next_event()
        .expect("malformed lines never error next_event")
    {
        saw_at_least_one_event = true;
    }
    assert!(
        saw_at_least_one_event,
        "well-formed events around the garbage line still surface"
    );
}

/// `stop` is safe to call after the child has already exited on its own — a caller doesn't need
/// to check [`AgentSession::has_exited`] first.
#[test]
fn stop_after_a_natural_exit_is_still_safe() {
    let dir = workdir("stop-after-exit");
    let mut session = spawn(&fake_agent_scenario("claude-minimal-success.json"), &dir);
    while session.next_event().unwrap().is_some() {}
    session
        .stop()
        .expect("stop after natural exit does not error");
}

/// `has_exited` reports the child's completion once it has naturally finished — a bounded,
/// non-blocking poll (`try_wait`, no sleep) covers the tiny OS-scheduling gap between "stdout
/// closed" (what draining `next_event` waits on) and "wait() observes the exit".
#[test]
fn has_exited_reports_true_once_the_child_naturally_completes() {
    let dir = workdir("has-exited");
    let mut session = spawn(&fake_agent_scenario("claude-minimal-success.json"), &dir);
    while session.next_event().unwrap().is_some() {}

    let mut exited = false;
    for _ in 0..10_000 {
        if session.has_exited().unwrap() {
            exited = true;
            break;
        }
        std::thread::yield_now();
    }
    assert!(
        exited,
        "child should have exited shortly after closing stdout"
    );
    session.stop().unwrap();
}

/// A chatty stderr must never deadlock `next_event`'s stdout read. The fake-agent's own
/// `--noisy-stderr` writes its filler *before* the stdout event stream starts, so a spawn that
/// pipes-and-never-drains stderr would back up against the OS's bounded pipe buffer and block there
/// forever, starving the stdout reader in lockstep. `AgentSession::spawn` drains stderr on a
/// dedicated thread — proven here by draining stdout on another thread and bounding the wait, so a
/// regression fails loudly instead of hanging the suite (test-plan §4 condition-based wait, not a
/// sleep; the bound is a safety net, not pacing).
#[test]
fn a_noisy_stderr_never_blocks_draining_stdout() {
    let dir = workdir("noisy-stderr");
    // Comfortably larger than any platform's default pipe buffer (Linux/macOS: tens of KB;
    // Windows anonymous pipes: a few KB) — if stderr were still piped-and-undrained, the child
    // would block on this write well before ever reaching the scenario's stdout events.
    let mut session = spawn_with_extra_args(
        &fake_agent_scenario("claude-minimal-success.json"),
        &dir,
        &["--noisy-stderr", "4194304"],
    );

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut count = 0usize;
        while session.next_event().unwrap().is_some() {
            count += 1;
        }
        let reaped = session.reap().expect("reap the noisy child");
        let _ = tx.send((count, reaped.failure_message()));
    });

    let (count, failure) = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("draining stdout must not block on an undrained stderr pipe");
    assert!(count > 0, "the scenario's stdout events still arrived");
    assert_eq!(failure, None, "successful stderr chatter stays harmless");
}

/// Issue #2395 review: a process leader can exit cleanly while one of its descendants keeps only
/// stderr open. Reaping requests group cleanup and finishes stderr collection within its bound,
/// even when a surviving descriptor does not immediately reach EOF after the group kill.
#[cfg(unix)]
#[test]
fn reap_contains_a_descendant_that_keeps_only_stderr_open() {
    let dir = workdir("reap-descendant-held-stderr");
    let args = vec![
        "-c".to_string(),
        "(exec 1>&-; sleep 20) & exit 0".to_string(),
    ];
    let mut session = AgentSession::spawn("sh", &args, &dir).expect("spawn the process group");
    let kill = session.kill_handle();
    while session.next_event().unwrap().is_some() {}

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(session.reap());
    });

    let exit = match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(exit) => exit.expect("reap the clean leader after containing its remaining group"),
        Err(error) => {
            let _ = kill.kill();
            let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
            panic!("reap exceeded its containment bound: {error}");
        }
    };
    assert_eq!(
        exit.failure_message(),
        None,
        "containing a lingering descriptor must preserve the leader's clean status"
    );
}

/// An inherited pipe can outlive the provider's process group. A real child creates another
/// process group; a FIFO keeps that descriptor open until test cleanup.
#[cfg(unix)]
#[test]
fn reap_finishes_when_stderr_outlives_the_process_group() {
    let dir = workdir("reap-stderr-outlives-group");
    let fifo = dir.join("release");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let args = vec![
        "--ignored".to_string(),
        "--exact".to_string(),
        "stderr_inheritor_fixture".to_string(),
        "--nocapture".to_string(),
    ];
    let mut session = AgentSession::spawn(
        std::env::current_exe().unwrap().to_str().unwrap(),
        &args,
        &dir,
    )
    .unwrap();
    let child = session.next_event().unwrap().unwrap().value["child"]
        .as_u64()
        .unwrap();
    while session.next_event().unwrap().is_some() {}
    let (tx, rx) = std::sync::mpsc::channel();
    let reaper = std::thread::spawn(move || {
        let _ = tx.send(session.reap());
    });
    let result = rx.recv_timeout(std::time::Duration::from_secs(2));
    // Always release the escaped fixture before asserting, including on the red implementation.
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &child.to_string()])
        .status();
    reaper.join().unwrap();
    let exit = result
        .expect("stderr collection must finish without waiting for inherited pipe EOF")
        .unwrap();
    assert_eq!(
        exit.failure_message(),
        None,
        "bounded stderr collection preserves clean leader exit"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "subprocess fixture for inherited stderr regression"]
#[expect(
    clippy::zombie_processes,
    reason = "the fixture leader must exit first; the outer test kills its orphaned child"
)]
fn stderr_inheritor_fixture() {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("COWRITE_STDERR_DESCENDANT").is_some() {
        let _ = std::fs::File::open("release").unwrap();
        return;
    }
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "stderr_inheritor_fixture",
            "--nocapture",
        ])
        .env("COWRITE_STDERR_DESCENDANT", "1")
        .process_group(0)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    println!("\n{{\"child\":{}}}", child.id());
}

/// P2a integration (#412): the run queue drains a session's stream on one thread while `stop`
/// is called from another — `kill_handle()` must let the second thread kill the child without
/// contending with the first's blocking `next_event` read (a `Mutex` around the whole session
/// would deadlock: the reader would hold it while parked in a blocking read, and the killer could
/// never acquire it). Proven against a scenario that hangs forever, so this test would itself hang
/// if `kill_handle` regressed to needing exclusive access to the session.
#[test]
fn kill_handle_stops_a_hung_session_being_drained_on_another_thread() {
    let dir = workdir("kill-handle-cross-thread");
    let mut session = spawn(&fake_agent_scenario("claude-never-terminates.json"), &dir);
    let kill = session.kill_handle();

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Drains to end-of-stream; only returns once the killed child's pipe closes.
        while session.next_event().unwrap().is_some() {}
        let _ = tx.send(());
    });

    // Give the reader thread a moment to actually be parked in its blocking read before killing —
    // not required for correctness (kill is safe at any point), just makes the regression case
    // (kill blocking behind the reader's lock) unmistakably the cause of a timeout below.
    std::thread::sleep(std::time::Duration::from_millis(50));
    kill.kill()
        .expect("kill from a thread other than the reader");

    rx.recv_timeout(std::time::Duration::from_secs(10))
        .expect("the reader thread must observe end-of-stream once kill_handle().kill() runs");
}
