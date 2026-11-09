// ABOUTME: Production-edge integration coverage for the TD-17 watchdog's app tab/run feed.
// ABOUTME: Real spawned runs and terminal reconciliation convert correlated raw agent writes.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cowrite_lib::agent::project::{OpenProjectRunObserver, ProjectObservers};
use cowrite_lib::agent::run_queue::{NoopEmitter, RunObserver, RunPhase, RunQueue, RunRequest};
use cowrite_lib::agent::session::{AgentSession, SessionError};
use cowrite_lib::commands::project::{new_session, open_project_on};
use cowrite_lib::commands::tabs::set_open_tabs_on;
use cowrite_lib::store::changes;
use cowrite_lib::store::service::SidecarStore;

mod common;
use common::{fake_agent_bin, fake_agent_scenario, workdir};

const PROTECTED_DOC: &str = "protected-notes.md";

fn spawn_scenario(request: &RunRequest) -> Result<AgentSession, SessionError> {
    AgentSession::spawn(
        fake_agent_bin().to_str().unwrap(),
        &["--scenario".to_string(), request.prompt.clone()],
        &request.project_root,
    )
}

fn wait_until(timeout: Duration, description: &str, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        std::thread::yield_now();
    }
}

fn open_production_project(
    root: &Path,
) -> (cowrite_lib::agent::project::SharedOpenProject, RunQueue) {
    let session = new_session();
    open_project_on(
        &session,
        root.display().to_string(),
        ProjectObservers::default(),
    )
    .expect("open the TD-17 project aggregate");
    let queue = RunQueue::with_observers(
        spawn_scenario as fn(&RunRequest) -> _,
        Arc::new(NoopEmitter),
        Arc::new(OpenProjectRunObserver::new(Arc::clone(&session))),
    );
    (session, queue)
}

#[test]
fn app_tab_and_run_state_feed_a_real_spawned_run_into_detect_and_convert() {
    let dir = workdir("watchdog-production-run-feed");
    let base = "# Notes\n\nThe original, human-authored notes.\n";
    std::fs::write(dir.join(PROTECTED_DOC), base).unwrap();
    let (session, queue) = open_production_project(&dir);

    set_open_tabs_on(
        &session,
        dir.display().to_string(),
        vec![PROTECTED_DOC.to_string()],
    )
    .expect("feed the live app tab set");

    let run_id = queue.start(RunRequest {
        project_root: dir.clone(),
        prompt: fake_agent_scenario("claude-raw-write-protected.json")
            .display()
            .to_string(),
        operation_targets: vec![PROTECTED_DOC.to_string()],
    });

    wait_until(
        Duration::from_secs(10),
        "the fake-agent run to finish",
        || {
            queue
                .state()
                .active
                .is_some_and(|run| run.id == run_id && !matches!(run.phase, RunPhase::Running))
        },
    );
    wait_until(
        Duration::from_secs(10),
        "the raw write to become tracked",
        || {
            std::fs::read_to_string(dir.join(PROTECTED_DOC)).is_ok_and(|text| {
                text.contains("{++") || text.contains("{--") || text.contains("{~~")
            })
        },
    );

    let converted = std::fs::read_to_string(dir.join(PROTECTED_DOC)).unwrap();
    assert!(
        converted.contains("# Notes"),
        "the original survives inside tracked markup"
    );
    assert!(
        textops::accept_all(&converted).contains("Rewritten by a misbehaving agent"),
        "accepting the tracked proposal reproduces the agent's intended write"
    );
    let store = SidecarStore::new(&dir);
    let doc_id = store.doc_id_for_path(PROTECTED_DOC).unwrap().unwrap();
    let changes = store.fold_changes(doc_id).unwrap();
    assert!(!changes.changes.is_empty());
    assert!(changes
        .changes
        .values()
        .all(|change| change.author == changes::AGENT_AUTHOR));
}

#[test]
fn the_open_projects_terminal_scan_converts_without_a_manual_on_write_call() {
    let dir = workdir("watchdog-production-fs-watch");
    let base = "# Notes\n\nOriginal.\n";
    std::fs::write(dir.join(PROTECTED_DOC), base).unwrap();
    let (session, _queue) = open_production_project(&dir);

    {
        let mut open = session.lock().unwrap();
        let project = open.as_mut().unwrap();
        project.watchdog_mut().open_tab(PROTECTED_DOC);
        project
            .watchdog_mut()
            .begin_run("run-native-watch", &[PROTECTED_DOC.to_string()]);
        project.watchdog_mut().observe(
            "run-native-watch",
            &serde_json::json!({
                "type": "assistant",
                "message": { "content": [{
                    "type": "tool_use",
                    "name": "Write",
                    "input": { "file_path": PROTECTED_DOC }
                }] }
            }),
        );
    }

    std::fs::write(
        dir.join(PROTECTED_DOC),
        "# Notes\n\nRewritten through a raw file write.\n",
    )
    .unwrap();
    OpenProjectRunObserver::new(Arc::clone(&session)).end_run("run-native-watch");

    wait_until(
        Duration::from_secs(10),
        "the terminal watchdog conversion",
        || {
            std::fs::read_to_string(dir.join(PROTECTED_DOC)).is_ok_and(|text| {
                text.contains("{++") || text.contains("{--") || text.contains("{~~")
            })
        },
    );
}
