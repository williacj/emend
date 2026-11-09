// ABOUTME: Integration tests for the FR-AGENT-7 run queue (P2a integration #412, TD-5) — start/
// ABOUTME: stop/state, queueing + cancellation + auto-advance, driven against the real fake-agent binary.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use cowrite_lib::agent::activity::ActivityLine;
use cowrite_lib::agent::run_queue::{
    ActivityEmitter, NoopEmitter, RunObserver, RunPhase, RunQueue, RunRequest, RunStatus,
    StopOutcome,
};
use cowrite_lib::agent::session::{AgentSession, SessionError};

mod common;
use common::{fake_agent_bin, fake_agent_scenario, workdir};

/// Path to a scenario fixture local to this test file (`tests/fixtures/`).
fn local_scenario(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// A `RunRequest` whose `prompt` names the scenario the test spawner below dispatches on — a
/// test-only convention (the queue itself never interprets `prompt`).
fn request(project_root: &Path, scenario: &Path) -> RunRequest {
    RunRequest {
        project_root: project_root.to_path_buf(),
        prompt: scenario.to_str().unwrap().to_string(),
        operation_targets: Vec::new(),
    }
}

/// The `agent::run_queue::Spawn` every test in this file wires its `RunQueue` with: spawns
/// `fake-agent` against whichever scenario path `request.prompt` names (see [`request`]).
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

fn always_fails(_request: &RunRequest) -> Result<AgentSession, SessionError> {
    Err(SessionError::Spawn(io::Error::other(
        "provider unavailable",
    )))
}

#[cfg(unix)]
fn spawn_fatal_stderr(request: &RunRequest) -> Result<AgentSession, SessionError> {
    AgentSession::spawn(
        "sh",
        &[
            "-c".to_string(),
            "printf 'fatal provider diagnostic\\n' >&2; exit 23".to_string(),
        ],
        &request.project_root,
    )
}

const STDOUT_CLOSED_MARKER: &str = "stdout-closed";
const RELEASE_EXIT_MARKER: &str = "release-exit";

fn delayed_clean_exit_command() -> (String, Vec<String>) {
    (
        std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string(),
        vec![
            "--ignored".to_string(),
            "--exact".to_string(),
            "delayed_clean_exit_fixture".to_string(),
            "--nocapture".to_string(),
        ],
    )
}

/// A real provider-shaped child with stdout EOF before exit, on both supported platforms.
#[test]
#[ignore = "subprocess fixture for stdout EOF and process exit sequencing"]
fn delayed_clean_exit_fixture() {
    use std::io::Write;
    let mut stdout = io::stdout();
    writeln!(
        stdout,
        "\n{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}}"
    )
    .unwrap();
    stdout.flush().unwrap();
    close_fixture_stdout(&stdout);
    std::fs::write(STDOUT_CLOSED_MARKER, "").unwrap();
    while !Path::new(RELEASE_EXIT_MARKER).exists() {
        std::thread::yield_now();
    }
    std::process::exit(0);
}

fn close_fixture_stdout(stdout: &io::Stdout) {
    // SAFETY: this dedicated child closes its own flushed stdout and never writes it again.
    // The fixture uses process::exit so the test harness cannot print to the closed pipe.
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        assert_eq!(unsafe { libc::close(stdout.as_raw_fd()) }, 0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        assert_ne!(unsafe { CloseHandle(stdout.as_raw_handle()) }, 0);
    }
}

/// Readiness failures must stop the child too, so a failed test cannot leave an inherited CI pipe
/// open for the rest of the job. Stop is harmless after a run has already completed.
struct StopFixtureRun<'a> {
    queue: &'a RunQueue,
    run_id: &'a str,
}

impl Drop for StopFixtureRun<'_> {
    fn drop(&mut self) {
        self.queue.stop(self.run_id);
    }
}

#[cfg(windows)]
fn spawn_fatal_stderr(request: &RunRequest) -> Result<AgentSession, SessionError> {
    AgentSession::spawn(
        "cmd",
        &[
            "/C".to_string(),
            ">>&2 echo fatal provider diagnostic & exit /b 23".to_string(),
        ],
        &request.project_root,
    )
}

/// The terminal phase a cleanly-finished run resolves to, carrying the answer its scenario gave
/// (#1118): `claude-minimal-success.json` answers `"ok"`, `claude-read-then-answer.json` answers
/// `"The project is a sample project."` — each site names its own scenario's text, so a reply that
/// silently stopped riding out on the phase fails here rather than passing vacuously.
fn completed(reply: &str) -> RunPhase {
    RunPhase::Completed {
        reply: Some(reply.to_string()),
    }
}

/// A recording [`ActivityEmitter`] — captures every pushed [`RunStatus`] in order, observable via
/// the shared `Arc` a caller keeps alongside the queue it's wired into.
#[derive(Default)]
struct RecordingEmitter {
    statuses: Mutex<Vec<RunStatus>>,
    terminal_read_gate: Option<(Mutex<TerminalReadGate>, Condvar)>,
}

#[derive(Default)]
enum TerminalReadGate {
    #[default]
    Armed,
    Waiting,
    Released,
}

impl RecordingEmitter {
    /// Holds the terminal push after queue finalization until an assertion reads the emitter.
    /// That first read returns the pre-push snapshot; an emitter-aware wait must read again.
    fn with_terminal_read_gate() -> Self {
        Self {
            statuses: Mutex::default(),
            terminal_read_gate: Some((Mutex::new(TerminalReadGate::Armed), Condvar::new())),
        }
    }

    fn statuses(&self) -> Vec<RunStatus> {
        let snapshot = self
            .statuses
            .lock()
            .expect("recording emitter mutex is never poisoned")
            .clone();
        if let Some((gate, wake)) = &self.terminal_read_gate {
            let mut state = gate.lock().expect("terminal gate mutex is never poisoned");
            if matches!(*state, TerminalReadGate::Waiting) {
                *state = TerminalReadGate::Released;
                wake.notify_one();
            }
        }
        snapshot
    }
}

impl ActivityEmitter for RecordingEmitter {
    fn emit(&self, status: &RunStatus) {
        if !matches!(status.phase, RunPhase::Running) {
            if let Some((gate, wake)) = &self.terminal_read_gate {
                let mut state = gate.lock().expect("terminal gate mutex is never poisoned");
                *state = TerminalReadGate::Waiting;
                while matches!(*state, TerminalReadGate::Waiting) {
                    state = wake
                        .wait(state)
                        .expect("terminal gate mutex is never poisoned");
                }
            }
        }
        self.statuses
            .lock()
            .expect("recording emitter mutex is never poisoned")
            .push(status.clone());
    }
}

fn queue_with_emitter(emitter: Arc<dyn ActivityEmitter>) -> RunQueue {
    RunQueue::with_emitter(spawn_scenario as fn(&RunRequest) -> _, emitter)
}

struct LandedDeliveryObserver;

impl RunObserver for LandedDeliveryObserver {
    fn begin_run(&self, _run_id: &str, _request: &RunRequest) {}
    fn observe(&self, _run_id: &str, _event: &serde_json::Value) {}
    fn end_run(&self, _run_id: &str) {}

    fn delivery_landed(&self, _run_id: &str) -> bool {
        true
    }
}

fn queue_with_landed_delivery(emitter: Arc<dyn ActivityEmitter>) -> RunQueue {
    RunQueue::with_observers(
        spawn_scenario as fn(&RunRequest) -> _,
        emitter,
        Arc::new(LandedDeliveryObserver),
    )
}

/// Issue #807 / FR-X-3 / TD-5: provider spawn must install the active run and its Stop handle
/// without waiting for the provider to drain a prompt larger than an OS pipe buffer. The fake
/// agent gates its stdin read on a file created by this test, making the backpressure condition
/// deterministic without sleeps.
#[test]
fn a_provider_not_reading_stdin_does_not_block_queue_state_or_stop() {
    let dir = workdir("stdin-backpressure");
    let read_gate = dir.join("read-stdin");
    let bin = fake_agent_bin().to_str().unwrap().to_string();
    // `--report-stdin` is cleanup support for the test's deliberately-red synchronous-writer
    // mutation: opening the gate then drains that blocked writer so its child can be reaped.
    // The passing assertion does not claim to exercise stdin reporting or scenario playback.
    let args = vec![
        "--scenario".to_string(),
        fake_agent_scenario("claude-never-terminates.json")
            .to_str()
            .unwrap()
            .to_string(),
        "--wait-before-stdin".to_string(),
        read_gate.to_str().unwrap().to_string(),
        "--report-stdin".to_string(),
    ];
    let prompt = vec![b'x'; 4 * 1024 * 1024];
    let queue = Arc::new(RunQueue::new(move |request: &RunRequest| {
        AgentSession::spawn_with_stdin(&bin, &args, &request.project_root, &prompt)
    }));
    let queue_for_start = Arc::clone(&queue);
    let request = request(&dir, &fake_agent_scenario("claude-never-terminates.json"));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(queue_for_start.start(request));
    });

    let start_result = rx.recv_timeout(Duration::from_secs(2));
    if start_result.is_err() {
        // Release the old synchronous writer before failing so the test leaves no child behind.
        std::fs::write(&read_gate, "").unwrap();
        let id = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("release lets the blocked start finish");
        let _ = queue.stop(&id);
        panic!("start stayed blocked while the provider was not reading stdin");
    }
    let id = start_result.unwrap();

    assert_eq!(
        queue.state().active.as_ref().map(|run| run.id.as_str()),
        Some(id.as_str()),
        "run state stays readable while prompt delivery is backpressured"
    );
    assert_eq!(queue.stop(&id), StopOutcome::Stopped);
    assert_eq!(
        wait_until_terminal(&queue, &id, Duration::from_secs(10)),
        RunPhase::Stopped { delivered: false }
    );
}

/// Issue #807 / FR-X-3 / FR-X-5: if a provider exits before draining a large prompt, the stdin
/// writer's failure wins deterministically over stdout EOF so the queue never reports a truncated
/// turn as Completed.
#[test]
fn a_provider_exiting_without_reading_the_prompt_resolves_to_failed() {
    let dir = workdir("stdin-write-failure");
    let bin = fake_agent_bin().to_str().unwrap().to_string();
    let args = vec![
        "--scenario".to_string(),
        fake_agent_scenario("claude-minimal-success.json")
            .to_str()
            .unwrap()
            .to_string(),
    ];
    let prompt = vec![b'x'; 4 * 1024 * 1024];
    let queue = RunQueue::new(move |request: &RunRequest| {
        AgentSession::spawn_with_stdin(&bin, &args, &request.project_root, &prompt)
    });

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    match phase {
        RunPhase::Failed { message } => {
            assert!(
                message.contains("writing agent prompt to stdin"),
                "failure identifies prompt delivery, got: {message}"
            );
        }
        other => panic!("provider that truncates its prompt must fail, got {other:?}"),
    }
}

/// Issue #2395 / FR-X-3 / FR-X-5 / J7: a provider that aborts before emitting a terminal stream
/// result is a failed run, and the failure card carries the diagnostic it wrote to stderr.
/// This drives a real spawned child because a queue fake returning `SessionError` cannot represent
/// the defect: spawn succeeds here, then the process itself exits unsuccessfully.
#[test]
fn a_fatal_child_exit_reports_its_stderr_as_a_failed_run() {
    let dir = workdir("fatal-child-stderr");
    let queue = RunQueue::new(spawn_fatal_stderr as fn(&RunRequest) -> _);

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    match phase {
        RunPhase::Failed { message } => assert!(
            message.contains("fatal provider diagnostic"),
            "failed run carries the child's diagnostic, got: {message}"
        ),
        other => panic!("fatal provider exit must fail the run, got {other:?}"),
    }
}

/// The near-match for #2395: stderr is diagnostic evidence only when the process fails. Providers
/// routinely write warnings and MCP chatter there during successful turns, so stderr content by
/// itself must neither fail a run nor recreate the undrained-pipe deadlock guarded in
/// `agent_session::a_noisy_stderr_never_blocks_draining_stdout`.
#[test]
fn a_successful_run_with_noisy_stderr_still_completes() {
    let dir = workdir("successful-noisy-stderr");
    let bin = fake_agent_bin().to_str().unwrap().to_string();
    let scenario = fake_agent_scenario("claude-minimal-success.json")
        .to_str()
        .unwrap()
        .to_string();
    let queue = RunQueue::new(move |request: &RunRequest| {
        AgentSession::spawn(
            &bin,
            &[
                "--scenario".to_string(),
                scenario.clone(),
                "--noisy-stderr".to_string(),
                "4194304".to_string(),
            ],
            &request.project_root,
        )
    });

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));

    assert_eq!(
        wait_until_terminal(&queue, &id, Duration::from_secs(10)),
        completed("ok")
    );
}

/// Closing stdout and process exit are distinct edges. Reaping must observe the child's own clean
/// status instead of immediately killing it and reporting the parent's cleanup signal as failure.
#[test]
fn a_clean_child_that_exits_after_stdout_eof_still_completes() {
    let dir = workdir("clean-exit-after-stdout-eof");
    let ready = dir.join(STDOUT_CLOSED_MARKER);
    let release = dir.join(RELEASE_EXIT_MARKER);
    let (program, args) = delayed_clean_exit_command();
    let queue = RunQueue::new(move |request: &RunRequest| {
        AgentSession::spawn(&program, &args, &request.project_root)
    });

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let _cleanup = StopFixtureRun {
        queue: &queue,
        run_id: &id,
    };
    wait_until_file(&ready, Duration::from_secs(10));
    std::fs::write(&release, "").unwrap();

    assert_eq!(
        wait_until_terminal(&queue, &id, Duration::from_secs(10)),
        completed("ok")
    );
}

/// Prove the fixture's OS boundary itself: readiness alone cannot establish stdout EOF.
#[test]
fn delayed_exit_fixture_closes_stdout_before_its_process_exits() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let dir = workdir("delayed-exit-fixture-stdout-eof");
    let (program, args) = delayed_clean_exit_command();
    let mut child = Command::new(program)
        .args(args)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let (done, completed) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        let result = stdout.read_to_string(&mut output).map(|_| output);
        let _ = done.send(result);
    });
    let result = completed.recv_timeout(Duration::from_secs(2));
    let child_was_running = child.try_wait().unwrap().is_none();
    // Reap even a broken fixture before asserting, so its inherited pipe cannot strand CI.
    let _ = child.kill();
    child.wait().unwrap();
    reader.join().unwrap();
    let output = result
        .expect("the fixture must close real stdout before its process exits")
        .unwrap();
    assert!(
        child_was_running,
        "stdout EOF must precede the fixture's exit"
    );
    assert!(output.contains("\"result\":\"ok\""));
}

/// Stop must remain live while the drain thread is waiting for the child to exit after stdout
/// EOF. The normal reaper only takes the child mutex for nonblocking probes, leaving the existing
/// process-group kill handle able to interrupt the wait.
#[test]
fn stop_remains_live_while_a_child_lingers_after_stdout_eof() {
    let dir = workdir("stop-while-reaping-after-stdout-eof");
    let ready = dir.join(STDOUT_CLOSED_MARKER);
    let (program, args) = delayed_clean_exit_command();
    let queue = RunQueue::new(move |request: &RunRequest| {
        AgentSession::spawn(&program, &args, &request.project_root)
    });

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let _cleanup = StopFixtureRun {
        queue: &queue,
        run_id: &id,
    };
    wait_until_file(&ready, Duration::from_secs(10));

    assert_eq!(queue.stop(&id), StopOutcome::Stopped);
    assert_eq!(
        wait_until_terminal(&queue, &id, Duration::from_secs(10)),
        RunPhase::Stopped { delivered: false }
    );
}

/// Bounded, condition-based wait (test-plan §4 — no sleep) for `run_id` to leave `Running`.
/// Panics past `timeout` rather than hanging the suite on a regression.
fn wait_until_terminal(queue: &RunQueue, run_id: &str, timeout: Duration) -> RunPhase {
    let deadline = Instant::now() + timeout;
    loop {
        let state = queue.state();
        if let Some(active) = state.active {
            if active.id == run_id && !matches!(active.phase, RunPhase::Running) {
                return active.phase;
            }
        }
        if Instant::now() >= deadline {
            panic!("run {run_id} did not resolve to a terminal phase within {timeout:?}");
        }
        std::thread::yield_now();
    }
}

fn wait_until_file(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} did not appear within {timeout:?}",
            path.display()
        );
        std::thread::yield_now();
    }
}

/// Bounded wait for `recorder` to have been pushed `run_id`'s terminal status, returning the exact
/// snapshot that was waited on so a caller asserts against what it observed rather than re-reading.
///
/// The queue turns terminal *before* that push happens, and deliberately so: the run thread writes
/// the phase under the queue lock, drops the lock, and only then calls `emit`, because
/// [`ActivityEmitter`] must never be called while the lock is held. So [`wait_until_terminal`]
/// returning says nothing about the emitter, and reading `recorder.statuses()` straight after it
/// races that window — which is what the loaded Windows runner lost (#2329). Wait on the transport
/// you are about to assert on.
///
/// **Precondition: `run_id` is the only run.** This matches on `statuses.last()` rather than
/// scanning, because `last()` is exactly what the callers go on to assert — waiting and asserting
/// on the same entry is the point of returning the snapshot. Where a run is queued behind this one,
/// its `Running` spawn push lands immediately after this one's terminal, so the last entry is never
/// this run's terminal and the wait times out instead of passing. Scan the whole feed for that
/// case, the way [`wait_until_failed_status_is_emitted`] does.
fn wait_until_emitter_terminal(
    recorder: &RecordingEmitter,
    run_id: &str,
    timeout: Duration,
) -> Vec<RunStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        let statuses = recorder.statuses();
        if let Some(last) = statuses.last() {
            if last.id == run_id && !matches!(last.phase, RunPhase::Running) {
                return statuses;
            }
        }
        if Instant::now() >= deadline {
            panic!(
                "emitter was not pushed a terminal status for {run_id} within {timeout:?}: {statuses:?}"
            );
        }
        std::thread::yield_now();
    }
}

/// Bounded wait for `run_id` to become the active run (used for auto-advance assertions, where
/// the run ahead of it may already have overwritten the active slot with its own terminal record
/// by the time this polls — waiting on identity, not on ever observing that intermediate state,
/// is what avoids the race).
fn wait_until_active(queue: &RunQueue, run_id: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if queue.state().active.map(|a| a.id) == Some(run_id.to_string()) {
            return;
        }
        if Instant::now() >= deadline {
            panic!("run {run_id} never became the active run within {timeout:?}");
        }
        std::thread::yield_now();
    }
}

/// Bounded wait for `run_id`'s accumulated activity feed to carry a line whose verb is `verb` —
/// needed wherever a test must stop a run *after* a particular stream event has actually been
/// processed by the background drain thread, not merely after `start` returned (spawning and
/// installing `active` happens synchronously in `start`, well before that thread has read
/// anything off the child's stdout).
fn wait_until_activity_carries(queue: &RunQueue, run_id: &str, verb: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(active) = queue.state().active {
            if active.id == run_id && active.activity.iter().any(|line| line.verb == verb) {
                return;
            }
        }
        if Instant::now() >= deadline {
            panic!("run {run_id} never reported a {verb:?} activity line within {timeout:?}");
        }
        std::thread::yield_now();
    }
}

/// Bounded wait for the emitter to observe `run_id` in a failed phase. Queue advance may replace
/// the active slot immediately, so the pushed status is the durable observation point (FR-X-3).
fn wait_until_failed_status_is_emitted(
    recorder: &RecordingEmitter,
    run_id: &str,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
    loop {
        if recorder
            .statuses()
            .iter()
            .any(|status| status.id == run_id && matches!(status.phase, RunPhase::Failed { .. }))
        {
            return;
        }
        if Instant::now() >= deadline {
            panic!("run {run_id} did not emit a failed status within {timeout:?}");
        }
        std::thread::yield_now();
    }
}

#[test]
fn starting_when_idle_spawns_immediately_and_is_reported_running() {
    let dir = workdir("start-idle");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));

    wait_until_active(&queue, &id, Duration::from_secs(5));
    let state = queue.state();
    assert_eq!(state.active.unwrap().phase, RunPhase::Running);
    assert!(state.queued.is_empty());

    // Clean up the hung child so the test process doesn't leak it.
    queue.stop(&id);
    wait_until_terminal(&queue, &id, Duration::from_secs(10));
}

#[test]
fn a_second_start_while_one_is_running_queues_behind_it_at_position_one() {
    let dir = workdir("second-start-queues");
    let queue = queue();

    let active_id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &active_id, Duration::from_secs(5));

    let queued = queue.start_with_queue_position(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));

    let state = queue.state();
    assert_eq!(
        state.active.unwrap().id,
        active_id,
        "the first run is still the active one"
    );
    assert_eq!(state.queued.len(), 1);
    assert_eq!(state.queued[0].id, queued.id);
    assert_eq!(state.queued[0].position, 1);
    assert_eq!(
        queued.queued_position,
        Some(1),
        "the synchronous start result lets the submitter acknowledge its queued run immediately"
    );

    // Clean up: stopping the active run lets the queued one auto-advance and finish on its own
    // (proven separately by `stopping_the_active_run_auto_advances_the_queue_to_the_next_pending`)
    // — wait on the queued run's identity/completion here, not the now-superseded active one's.
    queue.stop(&active_id);
    wait_until_active(&queue, &queued.id, Duration::from_secs(10));
    wait_until_terminal(&queue, &queued.id, Duration::from_secs(10));
}

/// FR-AGENT-6: stopping the active run leaves its protected doc byte-identical (mirrors
/// `tests/agent_session.rs`'s own `stop_kills_a_hung_session_and_the_protected_doc_is_left_untouched`,
/// asserted at the run-queue seam this card owns). No second run is queued behind it, so this run's
/// terminal record stays put in `active` for the assertion (no auto-advance race to account for).
#[test]
fn stopping_the_active_run_leaves_the_protected_doc_untouched_and_resolves_to_stopped() {
    let dir = workdir("stop-leaves-doc-untouched");
    let doc_path = dir.join("draft.md");
    let original = "# Draft\n\nOriginal content, never touched.\n";
    std::fs::write(&doc_path, original).unwrap();

    let hang_fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-hang-before-delivery.json");
    let queue = queue();
    let id = queue.start(request(&dir, &hang_fixture));
    wait_until_active(&queue, &id, Duration::from_secs(5));

    assert_eq!(queue.stop(&id), StopOutcome::Stopped);
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, RunPhase::Stopped { delivered: false });
    assert_eq!(std::fs::read_to_string(&doc_path).unwrap(), original);
}

#[test]
fn stopping_the_active_run_auto_advances_the_queue_to_the_next_pending() {
    let dir = workdir("stop-advances-queue");
    let queue = queue();

    let first = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &first, Duration::from_secs(5));
    let second = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    assert_eq!(queue.state().queued.len(), 1);

    queue.stop(&first);

    // The second run starts on its own, with nothing further asked of the caller.
    wait_until_active(&queue, &second, Duration::from_secs(10));
    assert!(queue.state().queued.is_empty());

    let phase = wait_until_terminal(&queue, &second, Duration::from_secs(10));
    assert_eq!(phase, completed("ok"));
}

#[test]
fn a_spawn_failure_during_advance_does_not_strand_or_reorder_later_queued_runs() {
    let dir = workdir("spawn-failure-continues-advance");
    let recorder = Arc::new(RecordingEmitter::default());
    let spawn_count = Arc::new(Mutex::new(0_u8));
    let count_for_spawner = Arc::clone(&spawn_count);
    let queue = RunQueue::with_emitter(
        move |request: &RunRequest| {
            let mut count = count_for_spawner
                .lock()
                .expect("spawn count mutex is never poisoned");
            *count += 1;
            if *count == 2 {
                return Err(SessionError::Spawn(io::Error::other(
                    "transient provider spawn failure",
                )));
            }
            spawn_scenario(request)
        },
        Arc::clone(&recorder) as Arc<dyn ActivityEmitter>,
    );

    let first = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &first, Duration::from_secs(5));
    let failed = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let next = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));

    queue.stop(&first);
    wait_until_failed_status_is_emitted(&recorder, &failed, Duration::from_secs(10));

    let later = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    wait_until_active(&queue, &next, Duration::from_secs(10));
    let state = queue.state();
    assert_eq!(
        state.active.unwrap().id,
        next,
        "the older queued run starts first"
    );
    assert_eq!(
        state
            .queued
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        vec![later.as_str()],
        "a later submit stays behind every previously queued run"
    );

    queue.stop(&next);
    wait_until_active(&queue, &later, Duration::from_secs(10));
    assert_eq!(
        wait_until_terminal(&queue, &later, Duration::from_secs(10)),
        completed("ok")
    );
}

#[test]
fn a_run_that_completes_naturally_resolves_to_completed() {
    let dir = workdir("natural-completion");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));

    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));
    assert_eq!(phase, completed("ok"));
}

#[test]
fn cancelling_a_queued_run_removes_it_before_it_ever_spawns() {
    let dir = workdir("cancel-queued");
    let queue = queue();

    let active = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &active, Duration::from_secs(5));
    let queued = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));

    assert_eq!(queue.stop(&queued), StopOutcome::Cancelled);
    assert!(queue.state().queued.is_empty());
    // The active run is unaffected by cancelling the one behind it.
    assert_eq!(queue.state().active.unwrap().id, active);

    // Stopping the (still-only) active run resolves it, and nothing further starts — the
    // cancelled request never spawns, proving `Cancelled` really did remove it.
    queue.stop(&active);
    let phase = wait_until_terminal(&queue, &active, Duration::from_secs(10));
    assert_eq!(phase, RunPhase::Stopped { delivered: false });
    assert!(queue.state().queued.is_empty());
}

#[test]
fn stopping_an_unknown_run_id_reports_not_found() {
    let queue = queue();
    assert_eq!(queue.stop("run-never-existed"), StopOutcome::NotFound);
}

/// Review finding (A1, PR #452): `drain_and_advance` finalizes the just-stopped run's phase and starts the
/// next queued run inside one lock acquisition, so `active` skips straight from the first run to
/// the second — terminal history is the only place the first run's outcome is ever visible, with
/// `last_finished` retaining the shared wire shape's newest projection.
#[test]
fn last_finished_reports_the_outcome_of_a_run_that_had_a_successor_queued_behind_it() {
    let dir = workdir("last-finished-after-advance");
    let queue = queue();

    let first = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &first, Duration::from_secs(5));
    let second = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));

    queue.stop(&first);

    // Auto-advance overwrites `active` with `second` in the very same locked step that finalizes
    // `first`'s phase — without terminal history, `first`'s `Stopped` outcome would never surface.
    wait_until_active(&queue, &second, Duration::from_secs(10));
    let state = queue.state();
    assert_eq!(
        state.active.unwrap().id,
        second,
        "second is now the active run"
    );
    let last_finished = state
        .last_finished
        .expect("first run's outcome must still be observable");
    assert_eq!(last_finished.id, first);
    assert_eq!(last_finished.phase, RunPhase::Stopped { delivered: false });

    // Clean up the deliberately non-terminating successor after the atomic observation window.
    assert_eq!(queue.stop(&second), StopOutcome::Stopped);
    assert_eq!(
        wait_until_terminal(&queue, &second, Duration::from_secs(10)),
        RunPhase::Stopped { delivered: false }
    );
}

#[test]
fn last_finished_also_reports_a_run_that_completed_with_nothing_queued_behind_it() {
    let dir = workdir("last-finished-no-successor");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    wait_until_terminal(&queue, &id, Duration::from_secs(10));

    let last_finished = queue
        .state()
        .last_finished
        .expect("recorded even without a queued successor");
    assert_eq!(last_finished.id, id);
    assert_eq!(last_finished.phase, completed("ok"));
}

/// #1826 review: a poll may see several runs finish since its previous sample. The queue's state
/// must retain each terminal in completion order rather than exposing only the most recent scalar.
#[test]
fn finished_history_preserves_two_spawn_failures_completed_between_polls_in_order() {
    let dir = workdir("finished-history-two-between-polls");
    let queue = RunQueue::new(always_fails as fn(&RunRequest) -> _);

    let first = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let second = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));

    let state = queue.state();
    assert_eq!(
        state
            .finished
            .iter()
            .map(|status| status.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.as_str(), second.as_str()]
    );
    assert!(state
        .finished
        .iter()
        .all(|status| matches!(status.phase, RunPhase::Failed { .. })));
    assert_eq!(
        state.last_finished.as_ref().map(|status| &status.id),
        Some(&second)
    );
    assert_eq!(
        queue.state().finished.len(),
        2,
        "reading state never inserts a terminal twice"
    );
}

/// The review probe's exact queue jump: A and B both become terminal without any intervening
/// state read, then the single next sample already sees C active. Both displaced terminals must
/// still be present, in completion order.
#[test]
fn one_poll_after_two_async_terminals_preserves_both_before_the_newly_active_run() {
    let dir = workdir("finished-history-two-async-before-poll");
    let queue = queue();

    let first = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &first, Duration::from_secs(5));
    let second = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    let third = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));

    assert_eq!(queue.stop(&first), StopOutcome::Stopped);
    wait_until_active(&queue, &third, Duration::from_secs(10));

    let state = queue.state();
    assert_eq!(state.active.as_ref().map(|status| &status.id), Some(&third));
    assert_eq!(
        state
            .finished
            .iter()
            .map(|status| status.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.as_str(), second.as_str()]
    );
    assert!(matches!(state.finished[0].phase, RunPhase::Stopped { .. }));
    assert!(matches!(
        state.finished[1].phase,
        RunPhase::Completed { .. }
    ));

    queue.stop(&third);
    wait_until_terminal(&queue, &third, Duration::from_secs(10));
}

/// P2a integration (#345, FR-X-3): the J1 Working-state activity feed accumulates across a run's
/// whole stream, in order — mirrors `agent::session`'s own per-line rendering
/// (`spawn_and_stream_renders_the_j1_activity_feed_in_order`), asserted here at the queue seam
/// that's actually reachable from the frontend/driver.
#[test]
fn a_completed_runs_activity_feed_accumulates_in_stream_order() {
    let dir = workdir("activity-accumulates");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-read-then-answer.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, completed("The project is a sample project."));
    let last_finished = queue.state().last_finished.expect("run finished");
    let labels: Vec<String> = last_finished
        .activity
        .iter()
        .map(ActivityLine::label)
        .collect();
    assert_eq!(
        labels,
        vec![
            "Reading /tmp/project/README.md".to_string(),
            "Drafting…".to_string()
        ]
    );
}

/// FR-X-3: elapsed time is present and computable the instant a run becomes active — not only
/// once it finishes.
///
/// The freeze-once-terminal half of this property (`RunStatus::elapsed_secs` stops advancing once
/// a run resolves, rather than drifting with the live wall clock) is *not* assertable at this
/// seam: `queue.state().last_finished` is a snapshot cloned once at finalize and never
/// recomputed, so two reads of it are equal by construction regardless of whether anything is
/// actually frozen (review finding, PR #477 round 1 — `finished_at` could be deleted wholesale and
/// a two-reads-equal assertion here would still pass). That property is pinned instead at the unit
/// level, where a fabricated `ActiveRun` can plant `started_at`/`finished_at` far enough apart from
/// real "now" to actually distinguish a frozen reading from a live one:
/// `agent::run_queue::tests::elapsed_secs_is_frozen_at_finished_at_not_the_live_wall_clock` (and
/// its still-running mirror, `elapsed_secs_tracks_the_live_wall_clock_while_still_running`).
#[test]
fn elapsed_secs_is_present_and_computable_while_a_run_is_active() {
    let dir = workdir("elapsed-secs");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-never-terminates.json"),
    ));
    wait_until_active(&queue, &id, Duration::from_secs(5));
    // Present and computable the instant the run is active — no panic, no missing field.
    let _ = queue.state().active.unwrap().elapsed_secs;

    // Clean up: this scenario never terminates on its own.
    queue.stop(&id);
    wait_until_terminal(&queue, &id, Duration::from_secs(10));
}

/// ux-design.md §2/J7: stopping a run *after* its stream already carried a `propose_changes`
/// announcement resolves `Stopped { delivered: true }` ("STOPPED — partial delivery"), distinct
/// from `stopping_the_active_run_leaves_the_protected_doc_untouched_and_resolves_to_stopped`'s
/// `delivered: false` ("STOPPED — nothing applied") — read off `AgentSession::saw_delivery`, the
/// TD-1 §3.2 delivery-lane signal (#1404; the sibling test below pins the `add_comments` half of
/// that same lane).
#[test]
fn stopping_a_run_after_a_propose_changes_announcement_resolves_delivered_true() {
    let dir = workdir("stop-after-propose");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &local_scenario("claude-hang-after-propose.json"),
    ));
    wait_until_active(&queue, &id, Duration::from_secs(5));
    // The fixture hangs right after its `propose_changes` tool_use announcement, but the
    // background thread still has to actually read that line before `saw_delivery` flips — wait
    // for it, or `stop` below can race ahead of the drain thread and see `delivered: false`.
    wait_until_activity_carries(&queue, &id, "Delivering", Duration::from_secs(5));

    assert_eq!(queue.stop(&id), StopOutcome::Stopped);
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, RunPhase::Stopped { delivered: true });
}

/// #1404: the comment-lane counterpart to the propose_changes test above. Stopping *after* the
/// stream already carried an `add_comments` announcement must resolve `Stopped { delivered: true }`
/// too — a filed comment is durably on the TD-4 sidecar exactly as a delivered change set is on the
/// document, so reporting "nothing applied" here would be the same dishonest stop card J7's
/// two-outcome split exists to prevent (FR-X-5). Before the fix, `delivered` was read off
/// `AgentSession::saw_propose_changes` alone — a superset-blind signal that this scenario would
/// fail (`delivered: false`) despite the comment already sitting on disk.
#[test]
fn stopping_a_run_after_an_add_comments_announcement_resolves_delivered_true() {
    let dir = workdir("stop-after-comment");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &local_scenario("claude-hang-after-comment.json"),
    ));
    wait_until_active(&queue, &id, Duration::from_secs(5));
    // Mirrors the propose_changes test's own wait: the background thread has to actually read the
    // `add_comments` line before `saw_delivery` flips, or `stop` below can race ahead of the drain
    // thread and see `delivered: false`.
    wait_until_activity_carries(&queue, &id, "Commenting on", Duration::from_secs(5));

    assert_eq!(queue.stop(&id), StopOutcome::Stopped);
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, RunPhase::Stopped { delivered: true });
}

/// Issue #1118 / J2 / Principle 5: a chat turn's answer has to survive the whole way out of the
/// queue, not just out of `AgentSession` — the terminal `Completed` phase is the channel the
/// timeline reads it from, through both the poll (`state().last_finished`) and the live push.
/// Before this, `RunPhase::Completed` had no payload at all and the answer was discarded here.
#[test]
fn a_completed_runs_reply_rides_out_on_its_terminal_phase() {
    let dir = workdir("reply-on-terminal-phase");
    let recorder = Arc::new(RecordingEmitter::with_terminal_read_gate());
    let queue = queue_with_emitter(Arc::clone(&recorder) as Arc<dyn ActivityEmitter>);

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-read-then-answer.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    let expected = RunPhase::Completed {
        reply: Some("The project is a sample project.".to_string()),
    };
    assert_eq!(phase, expected);
    // The same picture through both transports (`RunStatus`'s own contract).
    assert_eq!(
        queue.state().last_finished.expect("run finished").phase,
        expected
    );
    let pushed = wait_until_emitter_terminal(&recorder, &id, Duration::from_secs(10));
    assert_eq!(pushed.last().unwrap().phase, expected);
}

/// The negative this feature must not fabricate around: a process that exits successfully before
/// any terminal `result` event still completes with no reply — never an empty chat card or
/// invented text. An unsuccessful process exit is the distinct #2395 failure case above.
#[test]
fn a_completed_run_that_never_answered_carries_no_reply() {
    let dir = workdir("no-reply-on-terminal-phase");
    let queue = queue();

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-init-then-eof.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, RunPhase::Completed { reply: None });
}

/// Issue #1420 / FR-X-5: announcing `propose_changes` is not the delivery outcome. A wholly-stale
/// call raises no change-set card, so its terminal explanation is the only honest user-visible
/// outcome and must survive on both `RunStatus` transports.
#[test]
fn an_announced_delivery_that_landed_nothing_keeps_the_agents_explanation() {
    let dir = workdir("empty-delivery-keeps-reply");
    let recorder = Arc::new(RecordingEmitter::with_terminal_read_gate());
    let queue = queue_with_emitter(Arc::clone(&recorder) as Arc<dyn ActivityEmitter>);

    let id = queue.start(request(
        &dir,
        &local_scenario("claude-propose-then-answer.json"),
    ));
    let expected = completed("Tightened the hook and fixed two citations in draft.md.");
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(
        phase, expected,
        "a delivery announcement without persisted work must retain the explanation"
    );
    assert_eq!(
        queue.state().last_finished.expect("run finished").phase,
        expected
    );
    let pushed = wait_until_emitter_terminal(&recorder, &id, Duration::from_secs(10));
    assert_eq!(pushed.last().unwrap().phase, expected);
    assert!(
        pushed
            .iter()
            .any(|status| status.activity.iter().any(|line| line.verb == "Delivering")),
        "the fixture must announce propose_changes without manufacturing a landed outcome"
    );
}

/// CJ's ruling on #1118 (2026-08-12): the reply channel carries a run whose primary output *is*
/// prose. A run that delivered tracked changes already reports itself through its own change-set
/// card — appending the provider's closing line beside it duplicates the delivery, and that prose
/// routinely claims the edits are done ("Tightened the hook…") while the change set next to it is
/// still pending review. So a delivering run completes with no reply at all, even though its
/// terminal `result` carried text `agent::reply` was perfectly able to read.
#[test]
fn a_run_that_delivered_tracked_changes_completes_with_no_reply_beside_its_change_set() {
    let dir = workdir("delivery-suppresses-reply");
    let recorder = Arc::new(RecordingEmitter::with_terminal_read_gate());
    let queue = queue_with_landed_delivery(Arc::clone(&recorder) as Arc<dyn ActivityEmitter>);

    let id = queue.start(request(
        &dir,
        &local_scenario("claude-propose-then-answer.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(
        phase,
        RunPhase::Completed { reply: None },
        "a persisted tracked-change delivery must suppress its duplicate explanation"
    );
    // Both transports agree (`RunStatus`'s own contract) — a poller must not see the reply the
    // live push withheld.
    assert_eq!(
        queue.state().last_finished.expect("run finished").phase,
        RunPhase::Completed { reply: None }
    );
    let pushed = wait_until_emitter_terminal(&recorder, &id, Duration::from_secs(10));
    assert_eq!(
        pushed.last().unwrap().phase,
        RunPhase::Completed { reply: None }
    );
    // Not vacuous: the delivery really was announced on this run's stream (the feed shows it), so
    // the missing reply is the suppression rule and not a scenario that never delivered.
    assert!(
        pushed
            .iter()
            .any(|status| status.activity.iter().any(|line| line.verb == "Delivering")),
        "the fixture announces propose_changes: {pushed:?}"
    );
}

/// The comment half of the same ruling — "tracked changes *or* comments". A run that filed a
/// finding has its own comment card; its closing line is not a second chat message.
#[test]
fn a_run_that_filed_comments_completes_with_no_reply_either() {
    let dir = workdir("comments-suppress-reply");
    let queue = queue_with_landed_delivery(Arc::new(NoopEmitter));

    let id = queue.start(request(
        &dir,
        &local_scenario("claude-comment-then-answer.json"),
    ));
    let phase = wait_until_terminal(&queue, &id, Duration::from_secs(10));

    assert_eq!(phase, RunPhase::Completed { reply: None });
}

/// FR-X-3's "observable, not a silent spinner": an injected [`ActivityEmitter`] is pushed an
/// initial `Running` status the instant a run spawns, at least one further push as its activity
/// feed grows, and a final push carrying the terminal phase — the live-push counterpart to
/// `a_completed_runs_activity_feed_accumulates_in_stream_order`'s poll-based assertion.
#[test]
fn the_activity_emitter_is_pushed_on_spawn_progress_and_completion() {
    let dir = workdir("activity-emitter-pushes");
    let recorder = Arc::new(RecordingEmitter::with_terminal_read_gate());
    let queue = queue_with_emitter(Arc::clone(&recorder) as Arc<dyn ActivityEmitter>);

    let id = queue.start(request(
        &dir,
        &fake_agent_scenario("claude-read-then-answer.json"),
    ));
    let statuses = wait_until_emitter_terminal(&recorder, &id, Duration::from_secs(10));
    assert!(
        statuses.len() >= 3,
        "expected at least spawn + one activity push + a terminal push, got {statuses:?}"
    );
    assert!(matches!(statuses.first().unwrap().phase, RunPhase::Running));
    assert!(
        statuses.first().unwrap().activity.is_empty(),
        "nothing streamed yet at spawn"
    );
    assert_eq!(
        statuses.last().unwrap().phase,
        completed("The project is a sample project.")
    );
    assert_eq!(
        statuses.last().unwrap().activity.len(),
        2,
        "the full accumulated feed by the end"
    );
    assert!(statuses.iter().all(|s| s.id == id));
}
