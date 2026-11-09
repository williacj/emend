// ABOUTME: Integration tests for #1723 — a completed run's captured provider session id (D4
// ABOUTME: continuity, TD-5) must reach the open project's *next* `claude_invocation` as `--resume`.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tempfile::TempDir;

use cowrite_lib::agent::project::{OpenProjectRunObserver, ProjectObservers, SharedOpenProject};
use cowrite_lib::agent::run_queue::{NoopEmitter, RunObserver, RunPhase, RunQueue, RunRequest};
use cowrite_lib::agent::session::{AgentSession, SessionError};
use cowrite_lib::commands::agent::claude_invocation;
use cowrite_lib::commands::project::{
    close_project_on, new_session, open_project_on, open_project_with_data_dir_on,
};
use cowrite_lib::store::transcript;

mod common;
use common::{fake_agent_bin, fake_agent_scenario};

/// The session id `crates/fake-agent/scenarios/claude-minimal-success.json` hardcodes on its own
/// `system`/`init` event — the one fact every test in this file resumes toward.
const SCENARIO_SESSION_ID: &str = "e6639704-0d4d-497d-8898-ef5a938ef849";

fn request(root: &Path, scenario: &Path) -> RunRequest {
    RunRequest {
        project_root: root.to_path_buf(),
        prompt: scenario.to_str().unwrap().to_string(),
        operation_targets: Vec::new(),
    }
}

/// Spawns `fake-agent` directly against the scenario `request.prompt` names — bypassing
/// `commands::agent::claude_invocation`'s real `claude`-shaped argv (which `fake-agent`'s own flag
/// parser does not understand, `crates/fake-agent/src/main.rs`), exactly as
/// `tests/agent_run_mcp_injection.rs`'s own `queue()` helper does. This proves the queue/observer
/// wiring against a *real* spawned process's genuine `system/init`-captured session id; the
/// production argv construction itself is asserted separately, directly against
/// `claude_invocation`.
fn spawn_scenario(request: &RunRequest) -> Result<AgentSession, SessionError> {
    AgentSession::spawn(
        fake_agent_bin().to_str().unwrap(),
        &["--scenario".to_string(), request.prompt.clone()],
        &request.project_root,
    )
}

/// Wired exactly as `lib.rs` wires the app's one production `RunQueue`: the same
/// `OpenProjectRunObserver` over the same `session`, so this suite proves the real
/// `RunObserver::session_established` wiring (`agent::run_queue::drain_and_advance` ->
/// `agent::project::OpenProjectRunObserver`), not a reimplementation of it.
fn production_queue(session: &SharedOpenProject) -> RunQueue {
    RunQueue::with_observers(
        spawn_scenario as fn(&RunRequest) -> _,
        Arc::new(NoopEmitter),
        Arc::new(OpenProjectRunObserver::new(session.clone())),
    )
}

/// A session with `root` open, over the real `commands::project` transition, and the one
/// production-shaped `RunQueue` (observer included) that both opened it and will run every turn
/// against it in the rest of the test — the same single queue instance `lib.rs` builds and reuses
/// for both `open_project`/`close_project` and `start_run`.
fn open_session(root: &Path) -> (SharedOpenProject, RunQueue) {
    let session = new_session();
    let queue = production_queue(&session);
    open_project_on(
        &session,
        root.display().to_string(),
        ProjectObservers::default(),
    )
    .expect("open the project");
    (session, queue)
}

struct RecoverySpawner {
    session: SharedOpenProject,
    calls: Arc<AtomicUsize>,
    prompts: Arc<Mutex<Vec<String>>>,
    fresh_scenario: &'static str,
    resumed_scenario: &'static str,
}

struct CountingRecoveryObserver {
    inner: OpenProjectRunObserver,
    begins: Arc<AtomicUsize>,
    ends: Arc<AtomicUsize>,
}

impl RunObserver for CountingRecoveryObserver {
    fn begin_run(&self, run_id: &str, request: &RunRequest) {
        self.begins.fetch_add(1, Ordering::SeqCst);
        self.inner.begin_run(run_id, request);
    }

    fn observe(&self, run_id: &str, event: &Value) {
        self.inner.observe(run_id, event);
    }

    fn end_run(&self, run_id: &str) {
        self.ends.fetch_add(1, Ordering::SeqCst);
        self.inner.end_run(run_id);
    }

    fn delivery_landed(&self, run_id: &str) -> bool {
        self.inner.delivery_landed(run_id)
    }

    fn session_established(&self, run_id: &str, session_id: &str) -> Result<(), String> {
        self.inner.session_established(run_id, session_id)
    }

    fn clear_provider_session(&self, run_id: &str) -> Result<(), String> {
        self.inner.clear_provider_session(run_id)
    }
}

impl cowrite_lib::agent::run_queue::Spawn for RecoverySpawner {
    fn spawn(&self, request: &RunRequest) -> Result<AgentSession, SessionError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.prompts.lock().unwrap().push(request.prompt.clone());
        let resumed = resume_session_id(&self.session).is_some();
        let scenario = fake_agent_scenario(if resumed {
            self.resumed_scenario
        } else {
            self.fresh_scenario
        });
        AgentSession::spawn_provider_turn_with_stdin(
            fake_agent_bin().to_str().unwrap(),
            &[
                "--scenario".to_string(),
                scenario.display().to_string(),
                "--report-stdin".to_string(),
            ],
            &request.project_root,
            request.prompt.as_bytes(),
            resumed,
        )
    }
}

struct RecoveryHarness {
    session: SharedOpenProject,
    queue: RunQueue,
    calls: Arc<AtomicUsize>,
    prompts: Arc<Mutex<Vec<String>>>,
    begins: Arc<AtomicUsize>,
    ends: Arc<AtomicUsize>,
}

fn recovery_queue(
    root: &Path,
    app_data: &Path,
    fresh_scenario: &'static str,
    resumed_scenario: &'static str,
) -> RecoveryHarness {
    transcript::save_provider_session(
        &transcript::provider_session_file(app_data, root),
        Some(SCENARIO_SESSION_ID),
    )
    .unwrap();
    let session = new_session();
    let calls = Arc::new(AtomicUsize::new(0));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let begins = Arc::new(AtomicUsize::new(0));
    let ends = Arc::new(AtomicUsize::new(0));
    let queue = RunQueue::with_observers(
        RecoverySpawner {
            session: session.clone(),
            calls: calls.clone(),
            prompts: prompts.clone(),
            fresh_scenario,
            resumed_scenario,
        },
        Arc::new(NoopEmitter),
        Arc::new(CountingRecoveryObserver {
            inner: OpenProjectRunObserver::new(session.clone()),
            begins: begins.clone(),
            ends: ends.clone(),
        }),
    );
    open_project_with_data_dir_on(
        &session,
        root.display().to_string(),
        ProjectObservers::default(),
        Some(app_data),
    )
    .unwrap();
    RecoveryHarness {
        session,
        queue,
        calls,
        prompts,
        begins,
        ends,
    }
}

#[test]
fn stale_looking_failure_after_a_delivery_is_not_replayed() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let RecoveryHarness { queue, calls, .. } = recovery_queue(
        root.path(),
        app_data.path(),
        "claude-minimal-success.json",
        "claude-stale-resume-after-delivery.json",
    );
    let run = queue.start(request(root.path(), Path::new("same turn")));

    assert!(matches!(
        wait_for_terminal(&queue, &run),
        RunPhase::Failed { .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// The open project's stored D4 continuity target, read the same way
/// `commands::agent::bound_server` reads it in production.
fn resume_session_id(session: &SharedOpenProject) -> Option<String> {
    session
        .lock()
        .unwrap()
        .as_ref()
        .expect("a project is open")
        .resume_session_id()
}

/// Polls `queue.state()` until `run_id` reaches a terminal phase — condition-based, not a sleep
/// (test-plan §4) — as either the still-`active` slot or (once auto-advance has moved on)
/// `last_finished`.
fn wait_for_terminal(queue: &RunQueue, run_id: &str) -> RunPhase {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = queue.state();
        if let Some(active) = &state.active {
            if active.id == run_id && !matches!(active.phase, RunPhase::Running) {
                return active.phase.clone();
            }
        }
        if let Some(last) = &state.last_finished {
            if last.id == run_id {
                return last.phase.clone();
            }
        }
        assert!(
            Instant::now() < deadline,
            "run {run_id} never reached a terminal phase"
        );
        std::thread::yield_now();
    }
}

/// The card's headline defect (#1723): the *queue's* half of the wire — a completed run's captured
/// `system/init` session id must land on the open project it ran against, through the real
/// `RunObserver` the production queue is wired with, not a `build_args`-only unit test where the
/// caller's hardcoded `None` stays invisible.
#[test]
fn a_completed_runs_captured_session_id_is_stored_on_the_open_project() {
    let dir = TempDir::new().unwrap();
    let (session, queue) = open_session(dir.path());

    assert_eq!(
        resume_session_id(&session),
        None,
        "a fresh project has completed no run yet"
    );

    let scenario = fake_agent_scenario("claude-minimal-success.json");
    let run_id = queue.start(request(dir.path(), &scenario));
    let phase = wait_for_terminal(&queue, &run_id);
    assert!(
        matches!(phase, RunPhase::Completed { .. }),
        "unexpected phase: {phase:?}"
    );

    assert_eq!(
        resume_session_id(&session),
        Some(SCENARIO_SESSION_ID.to_string()),
        "the scenario's own system/init session id must be persisted onto the open project"
    );
}

/// The other half of the wire, and the one `build_args`-only coverage can never reach (#1723's own
/// "Tests" section): the *next* run's built invocation must actually carry the stored id as
/// `--resume`, read straight off `OpenProject::resume_session_id` the same way
/// `commands::agent::bound_server` does in production.
#[test]
fn the_next_invocation_carries_the_stored_session_id_as_resume() {
    let dir = TempDir::new().unwrap();
    let (session, queue) = open_session(dir.path());

    let scenario = fake_agent_scenario("claude-minimal-success.json");
    let run_id = queue.start(request(dir.path(), &scenario));
    wait_for_terminal(&queue, &run_id);

    let (mcp_server, resume) = {
        let guard = session.lock().unwrap();
        let project = guard.as_ref().expect("a project is open");
        (project.mcp_server(), project.resume_session_id())
    };
    let next_request = request(dir.path(), &scenario);
    let (_binary, args, _cwd, _stdin) = claude_invocation(&next_request, mcp_server, resume);

    let idx = args
        .iter()
        .position(|a| a == "--resume")
        .expect("--resume must be present once a session id has been established");
    assert_eq!(args[idx + 1], SCENARIO_SESSION_ID);
}

/// The honest negative: a project that has never seen a completed run must not fabricate a resume
/// id — its first turn is genuinely fresh, and `claude_invocation` must say so by omitting
/// `--resume` entirely (not, say, an empty string).
#[test]
fn a_fresh_project_with_no_completed_run_carries_no_resume_flag() {
    let dir = TempDir::new().unwrap();
    let (session, _queue) = open_session(dir.path());

    let (mcp_server, resume) = {
        let guard = session.lock().unwrap();
        let project = guard.as_ref().expect("a project is open");
        (project.mcp_server(), project.resume_session_id())
    };
    assert_eq!(resume, None);
    let scenario = fake_agent_scenario("claude-minimal-success.json");
    let (_binary, args, _cwd, _stdin) =
        claude_invocation(&request(dir.path(), &scenario), mcp_server, resume);

    assert!(
        !args.contains(&"--resume".to_string()),
        "no run has completed against this project yet: {args:?}"
    );
}

#[test]
fn provider_identity_survives_close_and_app_restart_but_isolated_per_project() {
    let app_data = TempDir::new().unwrap();
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    let (session, queue) = {
        let session = new_session();
        let queue = production_queue(&session);
        open_project_with_data_dir_on(
            &session,
            first.path().display().to_string(),
            ProjectObservers::default(),
            Some(app_data.path()),
        )
        .unwrap();
        (session, queue)
    };
    let run = queue.start(request(
        first.path(),
        &fake_agent_scenario("claude-minimal-success.json"),
    ));
    wait_for_terminal(&queue, &run);
    close_project_on(&session, &queue).unwrap();

    let restarted = new_session();
    let restarted_queue = production_queue(&restarted);
    open_project_with_data_dir_on(
        &restarted,
        first.path().display().to_string(),
        ProjectObservers::default(),
        Some(app_data.path()),
    )
    .unwrap();
    assert_eq!(
        resume_session_id(&restarted),
        Some(SCENARIO_SESSION_ID.into())
    );
    close_project_on(&restarted, &restarted_queue).unwrap();
    open_project_with_data_dir_on(
        &restarted,
        second.path().display().to_string(),
        ProjectObservers::default(),
        Some(app_data.path()),
    )
    .unwrap();
    assert_eq!(resume_session_id(&restarted), None);
}

#[test]
fn stale_resume_is_cleared_and_retried_fresh_exactly_once() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let RecoveryHarness {
        session,
        queue,
        calls,
        prompts,
        begins,
        ends,
    } = recovery_queue(
        root.path(),
        app_data.path(),
        "claude-minimal-success.json",
        "claude-stale-resume.json",
    );
    let run = queue.start(RunRequest {
        project_root: root.path().to_path_buf(),
        prompt: "Keep the same submitted turn".into(),
        operation_targets: Vec::new(),
    });

    assert_eq!(
        wait_for_terminal(&queue, &run),
        RunPhase::Recovered {
            reply: Some("ok".into())
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(begins.load(Ordering::SeqCst), 1);
    assert_eq!(ends.load(Ordering::SeqCst), 1);
    assert_eq!(
        prompts.lock().unwrap().as_slice(),
        ["Keep the same submitted turn"; 2]
    );
    assert_eq!(
        resume_session_id(&session),
        Some(SCENARIO_SESSION_ID.into())
    );
}

#[test]
fn failed_fresh_fallback_is_failed_and_never_retried_again() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let RecoveryHarness {
        session,
        queue,
        calls,
        begins,
        ends,
        ..
    } = recovery_queue(
        root.path(),
        app_data.path(),
        "claude-fresh-session-failure.json",
        "claude-stale-resume.json",
    );
    let run = queue.start(request(root.path(), Path::new("same turn")));

    assert_eq!(
        wait_for_terminal(&queue, &run),
        RunPhase::Failed {
            message: "Provider network unavailable".into()
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(begins.load(Ordering::SeqCst), 1);
    assert_eq!(ends.load(Ordering::SeqCst), 1);
    assert_eq!(resume_session_id(&session), None);
    assert_eq!(
        transcript::load_provider_session(&transcript::provider_session_file(
            app_data.path(),
            root.path()
        ))
        .unwrap(),
        None
    );
}

#[test]
fn fresh_fallback_that_ends_after_init_without_a_result_is_failed() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let RecoveryHarness {
        queue,
        calls,
        begins,
        ends,
        ..
    } = recovery_queue(
        root.path(),
        app_data.path(),
        "claude-init-then-eof.json",
        "claude-stale-resume.json",
    );
    let run = queue.start(request(root.path(), Path::new("same turn")));

    assert_eq!(
        wait_for_terminal(&queue, &run),
        RunPhase::Failed {
            message: "fresh provider session ended before a successful result".into()
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(begins.load(Ordering::SeqCst), 1);
    assert_eq!(ends.load(Ordering::SeqCst), 1);
}
