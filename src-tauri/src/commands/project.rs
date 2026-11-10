// ABOUTME: Thin IPC (§3.1) for TD-17 project lifecycle and TD-18 refresh/visibility queries.
// ABOUTME: The app-held `OpenProject` owns every service; commands only validate, call, and return.

//! The transition TD-17 gave the backend so TD-1 injection and D21 runtime protection have a
//! lifecycle to hang on. Before this, "a project is open" was purely client-side folder-picker
//! state in `App.tsx` and the backend never learned of it — which is why `ProjectMcpServer` had no
//! production caller at all (#472).
//!
//! **M7 (tech-design §3.5): one project per app instance.** User project choices enter through
//! TD-20's app-scoped router, which adopts only into an empty session and never replaces one in
//! place. The direct open seam remains for startup/test-driver construction. Closing still shares
//! the run queue's idle lock, so its D21 server/watchdog boundary cannot end mid-turn.

use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::birth::DocumentBirthObserver;
use crate::agent::delivery::DeliveryObserver;
use crate::agent::project::{OpenProject, ProjectObservers, SharedOpenProject};
use crate::agent::run_queue::{ProjectTransition, RunQueue};
use crate::commands::agent::{TauriDeliveryEmitter, TauriDocumentBirthEmitter};
use crate::instances::activator::{OwnerActivationService, OwnerWindow};
use crate::instances::{
    ProjectRouteOutcome, ProjectRouter, ProjectRoutingNotice, ProjectRoutingObserver,
};
use crate::project_files::{
    is_project_path_enumerable, ProjectFilesError, ProjectFilesObserver, ProjectFilesRefreshNotice,
    ProjectFilesSnapshot,
};
use crate::store::lock as store_lock;
use crate::store::lock::ProjectLockGuard;

/// A command-level error (§3.1 typed errors).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    InvalidArguments(String),
    /// The project's MCP server could not be bound, so the project is not open. Surfaced as a
    /// rejected call rather than a silently half-open project: TD-1's contract is that a spawned
    /// CLI is *always* auto-wired, and a project with no server can never satisfy it (D21, FR-X-3's
    /// "never a silent gap").
    Bind(String),
    /// Closing the project would tear down the active run's MCP server and watchdog mid-turn,
    /// leaving the child alive without its D21 delivery/enforcement boundary.
    RunActive(String),
}

/// The channel [`TauriProjectFilesEmitter`] pushes every automatic project-files refresh transition
/// on (TD-18). The D23 driver also places this exact name in its event envelope, mechanically
/// binding `src/stores/project.ts`'s mirror through the browser acceptance path.
pub const PROJECT_FILES_EVENT: &str = "emend://project/files";
pub const PROJECT_ROUTING_EVENT: &str = "emend://project/routing";

/// Carries TD-20(9)'s backend-owned request ordering and terminal outcomes to the shared app status
/// state. The frontend observes policy; it never serializes project routes itself.
pub struct TauriProjectRoutingEmitter(pub AppHandle);

impl ProjectRoutingObserver for TauriProjectRoutingEmitter {
    fn announce(&self, notice: ProjectRoutingNotice) {
        let _ = Emitter::emit(&self.0, PROJECT_ROUTING_EVENT, notice);
    }
}

/// Carries TD-18's automatic-refresh lifecycle to the webview, mirroring the J1/J2 emitters in
/// `commands::agent`. Nothing here decides anything: the completed snapshot is the backend's, and a
/// failed refresh reports the typed failure while the last completed generation stays current.
pub struct TauriProjectFilesEmitter(pub AppHandle);

impl TauriProjectFilesEmitter {
    fn announce(&self, notice: ProjectFilesRefreshNotice) {
        // Inert on failure, exactly as the delivery/birth pipes are: no window may have mounted a
        // listener yet, and the next completed snapshot carries the whole tree regardless.
        let _ = Emitter::emit(&self.0, PROJECT_FILES_EVENT, notice);
    }
}

impl ProjectFilesObserver for TauriProjectFilesEmitter {
    fn refresh_started(&self) {
        self.announce(ProjectFilesRefreshNotice::Started);
    }

    fn refresh_completed(&self, snapshot: &ProjectFilesSnapshot) {
        self.announce(ProjectFilesRefreshNotice::Completed {
            snapshot: snapshot.clone(),
        });
    }

    fn refresh_failed(&self, error: &ProjectFilesError) {
        self.announce(ProjectFilesRefreshNotice::Failed {
            error: error.clone(),
        });
    }
}

/// The app's three announcement seams, bound to a live `AppHandle` — what an [`OpenProject`] opened
/// through Tauri IPC announces landed `propose_changes` (#346) and `create_document` (#420) calls,
/// and TD-18's automatic project-files refreshes, through. The D23 headless driver supplies its
/// own project-files observer over a polled transport while carrying this same notice and name.
pub fn tauri_observers(app: &AppHandle) -> ProjectObservers {
    ProjectObservers {
        permissions: Some(Arc::new(crate::commands::agent::TauriPermissionEmitter(
            app.clone(),
        ))),
        delivery: Some(Arc::new(TauriDeliveryEmitter(app.clone())) as Arc<dyn DeliveryObserver>),
        births: Some(
            Arc::new(TauriDocumentBirthEmitter(app.clone())) as Arc<dyn DocumentBirthObserver>
        ),
        project_files: Some(
            Arc::new(TauriProjectFilesEmitter(app.clone())) as Arc<dyn ProjectFilesObserver>
        ),
    }
}

/// [`open_project`]'s logic without a Tauri `State`/`AppHandle` extractor — what the
/// `#[tauri::command]` wrapper calls, and what the D23 `crates/test-driver` calls directly against
/// its own session (mirroring `commands::agent::start_run_on`'s identical split).
///
/// Opening the project that is **already open** is a no-op, not a rebind: a rebind would mint a new
/// token and tear down the live server — under a running agent, if one is mid-turn. Identity is
/// compared canonically (`agent::project::canonical_root`), so two spellings of one directory are
/// one project.
///
/// A bind failure leaves any already-open project untouched: the new server is bound *before* the
/// old project is displaced, so a failed open cannot also close what was working.
pub fn open_project_on(
    session: &SharedOpenProject,
    root: String,
    observers: ProjectObservers,
) -> Result<(), CommandError> {
    open_project_with_data_dir_on(session, root, observers, None)
}

/// Production-shaped project open with the OS app-local-data directory needed to restore D4
/// provider continuity from the D15-adjacent conversation metadata.
pub fn open_project_with_data_dir_on(
    session: &SharedOpenProject,
    root: String,
    observers: ProjectObservers,
    app_local_data_dir: Option<&std::path::Path>,
) -> Result<(), CommandError> {
    if root.trim().is_empty() {
        return Err(CommandError::InvalidArguments(
            "root must not be empty".to_string(),
        ));
    }

    {
        let guard = lock(session);
        if guard.as_ref().is_some_and(|open| open.is_root(&root)) {
            return Ok(());
        }
    }

    open_project_after_fast_path(session, root, observers, app_local_data_dir)
}

/// Installs the ownership guard acquired by `instances::resolve` into an empty app session.
/// Routed adoption cannot replace: D26 permits it only in a process holding no project, and the
/// caller's resolver has already established that fact. The owning constructor also restores the
/// same durable provider session used by ordinary production opens (TD-5 / TD-20 ruling (2)).
pub fn adopt_project_with_ownership_on(
    session: &SharedOpenProject,
    root: &std::path::Path,
    ownership: ProjectLockGuard,
    observers: ProjectObservers,
    app_local_data_dir: &std::path::Path,
) -> Result<(), CommandError> {
    let project = OpenProject::open_owning_persisting_provider_session(
        root,
        ownership,
        app_local_data_dir,
        observers,
    )
    .map_err(|error| CommandError::Bind(error.to_string()))?;
    let mut guard = lock(session);
    if guard.is_some() {
        return Err(CommandError::InvalidArguments(
            "routed adoption requires an empty project session".to_string(),
        ));
    }
    *guard = Some(project);
    Ok(())
}

/// The current backend-owned project root, used to hydrate a frontend that mounted after startup
/// routing adopted the project while the configured window was still hidden.
pub fn current_project_on(session: &SharedOpenProject) -> Option<String> {
    lock(session)
        .as_ref()
        .map(|project| project.root().to_string_lossy().into_owned())
}

/// Attaches TD-20(6)'s owner request listener to a routed, lock-owning project. The aggregate
/// owns the listener and drops it before its lock; non-routed historical opens have no ownership
/// guard and intentionally receive no foreground capability.
pub(crate) fn install_owner_activation_on(
    session: &SharedOpenProject,
    app_local_data_dir: &std::path::Path,
    window: std::sync::Arc<dyn OwnerWindow + Send + Sync>,
) -> Result<bool, CommandError> {
    let mut session = lock(session);
    let Some(project) = session.as_mut() else {
        return Ok(false);
    };
    if !project.owns_project_lock() {
        return Ok(false);
    }
    let registry_dir = store_lock::registry_dir(app_local_data_dir, project.root());
    let service = OwnerActivationService::start(registry_dir, window)
        .map_err(|error| CommandError::Bind(error.to_string()))?;
    Ok(project.install_owner_activation(service))
}

/// Completes an open after its optimistic same-root check missed. Keeping this race-closing half
/// explicit lets the under-lock recheck remain the authority when two openers overlap.
fn open_project_after_fast_path(
    session: &SharedOpenProject,
    root: String,
    observers: ProjectObservers,
    app_local_data_dir: Option<&std::path::Path>,
) -> Result<(), CommandError> {
    let project = match app_local_data_dir {
        Some(dir) => OpenProject::open_persisting_provider_session(&root, dir, observers),
        None => OpenProject::open(&root, observers),
    }
    .map_err(|e| CommandError::Bind(e.to_string()))?;
    let mut guard = lock(session);
    if guard.as_ref().is_some_and(|open| open.is_root(&root)) {
        return Ok(());
    }
    let previous = guard.replace(project);
    drop(guard);
    // The direct open seam is retained for startup/test-driver construction. Product project
    // choices reach `route_project_open`, so D26 never replaces this session in place.
    drop(previous);
    Ok(())
}

/// [`close_project`]'s logic without a Tauri `State` extractor. Closing with nothing open is a
/// no-op, so a frontend need not track whether it already closed.
pub fn close_project_on(session: &SharedOpenProject, queue: &RunQueue) -> Result<(), CommandError> {
    if lock(session).is_none() {
        return Ok(());
    }

    queue
        .run_if_idle(|| {
            let previous = lock(session).take();
            drop(previous);
            Ok::<_, CommandError>(ProjectTransition::Closed(()))
        })
        .ok_or_else(run_active)??;
    Ok(())
}

/// TD-18's extractor-free first-load/explicit-refresh seam. Both UI triggers call this same
/// serialized service operation; the D23 driver dispatches here too. The session mutex protects
/// only the service lookup — the serialized filesystem walk runs after that guard is dropped, so
/// synchronous open/close/tab commands do not wait behind it (FR-X-4).
pub fn refresh_project_files_on(
    session: &SharedOpenProject,
) -> Result<ProjectFilesSnapshot, ProjectFilesError> {
    let project_files = lock(session)
        .as_ref()
        .map(OpenProject::project_files)
        .ok_or_else(|| ProjectFilesError::ProjectUnavailable("no project is open".to_string()))?;
    project_files
        .refresh()
        .map(|snapshot| snapshot.as_ref().clone())
}

/// Reports whether TD-18's backend visibility rule permits a document path to appear in a
/// completed snapshot. This is extractor-free so the D23 driver reaches the same classifier.
pub fn project_path_is_enumerable_on(path: &str) -> bool {
    is_project_path_enumerable(path)
}

/// Opens `root` as *the* project: binds its TD-1 MCP server, stands up its D21 watchdog over the
/// one protected set they share, and replaces whatever project was open before while idle (M7).
#[tauri::command]
pub fn open_project(
    app: AppHandle,
    session: State<SharedOpenProject>,
    root: String,
) -> Result<(), CommandError> {
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| CommandError::Bind(error.to_string()))?;
    open_project_with_data_dir_on(
        session.inner(),
        root,
        tauri_observers(&app),
        Some(&app_local_data_dir),
    )
}

/// Routes one user project choice through TD-20's app-scoped serializer. The command owns no
/// resolver, deadline, ownership, activation, or launch policy; all of that stays in `instances/`.
#[tauri::command]
pub async fn route_project_open(
    router: State<'_, Arc<ProjectRouter>>,
    root: String,
) -> Result<ProjectRouteOutcome, CommandError> {
    if root.trim().is_empty() {
        return Err(CommandError::InvalidArguments(
            "root must not be empty".to_string(),
        ));
    }
    let router = Arc::clone(router.inner());
    tauri::async_runtime::spawn_blocking(move || router.route(std::path::Path::new(&root)))
        .await
        .map_err(|_| CommandError::Bind("project routing task panicked".to_string()))
}

/// Closes the open project: the bound MCP server is unbound (accept loop stopped, socket closed) and
/// its per-session bearer token stops being honored before this returns (FR-X-2).
#[tauri::command]
pub fn close_project(
    session: State<SharedOpenProject>,
    queue: State<RunQueue>,
) -> Result<(), CommandError> {
    close_project_on(session.inner(), queue.inner())
}

#[tauri::command]
pub fn current_project(session: State<SharedOpenProject>) -> Option<String> {
    current_project_on(session.inner())
}

/// Returns one completed immutable project-files generation. A failed refresh returns a typed
/// error and leaves the service's last completed snapshot untouched.
///
/// `async` + `spawn_blocking` keeps a large or slow project walk off Tauri's main thread (FR-X-4).
/// The synchronous helper remains the one operation the D23 driver calls from its own worker.
#[tauri::command]
pub async fn refresh_project_files(
    session: State<'_, SharedOpenProject>,
) -> Result<ProjectFilesSnapshot, ProjectFilesError> {
    let session = Arc::clone(session.inner());
    tauri::async_runtime::spawn_blocking(move || refresh_project_files_on(&session))
        .await
        .unwrap_or_else(|_| {
            Err(ProjectFilesError::UpdateFailed(
                "project-files refresh task panicked".to_string(),
            ))
        })
}

/// Answers the visibility question a completed generation cannot encode for a path hidden before
/// it produces any row. The frontend asks before claiming J2's Missing-on-disk state.
#[tauri::command]
pub fn project_path_is_enumerable(path: String) -> bool {
    project_path_is_enumerable_on(&path)
}

fn run_active() -> CommandError {
    CommandError::RunActive("finish or stop the active run before closing the project".to_string())
}

/// The session lock, recovering from poisoning. A panic in some *other* command holding this lock
/// cannot corrupt the state — it is one `Option`, replaced or taken wholesale — so recovering beats
/// turning it into a permanent "no project can ever be opened again in this session" failure.
pub(super) fn lock(session: &SharedOpenProject) -> std::sync::MutexGuard<'_, Option<OpenProject>> {
    session.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A session with no project open — the app's initial state, and what `crates/test-driver` and the
/// tests below start from.
pub fn new_session() -> SharedOpenProject {
    Arc::new(Mutex::new(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::TcpStream;
    use std::time::Duration;

    use crate::agent::run_queue::RunRequest;
    use crate::agent::session::{AgentSession, SessionError};
    use crate::store::lock::{self, LockOutcome, LockOwner};
    use std::path::Path;

    fn idle_queue() -> RunQueue {
        RunQueue::new(
            |_request: &RunRequest| -> Result<AgentSession, SessionError> {
                unreachable!("project command tests never start a run")
            },
        )
    }

    /// A session slot holding `root` open **with its TD-20 ownership claim** — the shape
    /// `instances/` produces once it hands the guard to the aggregate (TD-20 ruling (2)).
    fn owning_session(app_local_data_dir: &Path, root: &Path) -> SharedOpenProject {
        let ownership = lock::test_support::take(
            &lock::registry_dir(app_local_data_dir, root),
            root,
            "instance-a",
        );
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open_owning(root, ownership, ProjectObservers::default()).unwrap());
        session
    }

    /// Whether a *fresh* claim on `root` succeeds — i.e. nobody holds the project any more. Probing
    /// takes and immediately drops a real OS lock, so it writes and deletes `owner.json` in the
    /// registry directory under test; assert with it last.
    fn ownership_is_free(app_local_data_dir: &Path, root: &Path) -> bool {
        matches!(
            lock::acquire(
                &lock::registry_dir(app_local_data_dir, root),
                &LockOwner::new("instance-probe", root),
            )
            .unwrap(),
            LockOutcome::Acquired(_)
        )
    }

    /// Whether `addr` still accepts connections. Retried briefly: closing a listener and the OS
    /// releasing its port are not the same instant (mirrors `tests/project_mcp_server.rs`'s own
    /// close assertion).
    fn still_accepting(addr: std::net::SocketAddr) -> bool {
        for _ in 0..20 {
            match TcpStream::connect_timeout(&addr, Duration::from_millis(50)) {
                Ok(_) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return false,
            }
        }
        true
    }

    #[test]
    fn open_project_binds_the_projects_server_and_makes_it_the_open_project() {
        let dir = tempfile::TempDir::new().unwrap();
        let session = new_session();
        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();

        let guard = session.lock().unwrap();
        let open = guard.as_ref().expect("a project is open");
        assert!(open.is_root(dir.path()));
        assert!(open.mcp_server().addr.ip().is_loopback());
    }

    #[test]
    fn routed_adoption_retains_ownership_and_restores_provider_session_continuity() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let metadata =
            crate::store::transcript::provider_session_file(app_data.path(), project.path());
        crate::store::transcript::save_provider_session(&metadata, Some(&session_id)).unwrap();
        let ownership = lock::test_support::take(
            &lock::registry_dir(app_data.path(), project.path()),
            project.path(),
            "arriving",
        );
        let session = new_session();

        adopt_project_with_ownership_on(
            &session,
            project.path(),
            ownership,
            ProjectObservers::default(),
            app_data.path(),
        )
        .unwrap();

        let guard = session.lock().unwrap();
        let open = guard.as_ref().unwrap();
        assert_eq!(
            open.resume_session_id().as_deref(),
            Some(session_id.as_str())
        );
        let expected_root = open.root().to_string_lossy().into_owned();
        drop(guard);
        assert_eq!(current_project_on(&session), Some(expected_root));
    }

    #[test]
    fn open_project_rejects_an_empty_root_before_binding_anything() {
        let session = new_session();
        let err =
            open_project_on(&session, "   ".to_string(), ProjectObservers::default()).unwrap_err();

        assert!(matches!(err, CommandError::InvalidArguments(_)));
        assert!(session.lock().unwrap().is_none());
    }

    /// M7: one project per app instance. Opening a second project displaces the first — and the
    /// first's server is genuinely unbound, so its bearer token cannot outlive its session (FR-X-2).
    #[test]
    fn opening_a_second_project_replaces_the_first_and_unbinds_its_server() {
        let first_dir = tempfile::TempDir::new().unwrap();
        let second_dir = tempfile::TempDir::new().unwrap();
        let session = new_session();
        open_project_on(
            &session,
            first_dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let first = session.lock().unwrap().as_ref().unwrap().mcp_server();

        open_project_on(
            &session,
            second_dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let second = session.lock().unwrap().as_ref().unwrap().mcp_server();

        assert!(session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_root(second_dir.path()));
        assert_ne!(first.addr, second.addr);
        assert_ne!(
            first.token, second.token,
            "the displaced project's token must not carry over"
        );
        // That the displaced server genuinely stops *accepting* is asserted in
        // `close_project_clears_the_session_and_unbinds_the_server` below rather than here: the OS
        // is free to hand the freed ephemeral port straight to the replacement's own bind, which
        // would make a connect-succeeds check on the old address a flake rather than a signal.
    }

    /// The 2026-07-21 review's Important finding, as a test: re-opening the project that is already
    /// open must not rebind. A rebind mints a new token and tears the live server down — under a
    /// running agent, whose `--mcp-config` still names the old address and old token.
    #[test]
    fn reopening_the_already_open_project_keeps_the_live_binding() {
        let dir = tempfile::TempDir::new().unwrap();
        let session = new_session();
        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let first = session.lock().unwrap().as_ref().unwrap().mcp_server();

        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let second = session.lock().unwrap().as_ref().unwrap().mcp_server();

        assert_eq!(first.addr, second.addr);
        assert_eq!(first.token, second.token);
    }

    /// The same finding's sharper half: two *spellings* of one directory are one project. As raw
    /// paths they differ, so without canonicalization the reopen reads as a project change and
    /// tears down a live server — see `agent::project`'s own test for why the spelling is
    /// `<root>/sub/..` rather than `<root>/.`.
    #[test]
    fn reopening_under_a_different_spelling_of_the_same_root_keeps_the_live_binding() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let session = new_session();
        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let first = session.lock().unwrap().as_ref().unwrap().mcp_server();

        open_project_on(
            &session,
            dir.path().join("sub").join("..").display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let second = session.lock().unwrap().as_ref().unwrap().mcp_server();

        assert_eq!(
            first.addr, second.addr,
            "the same directory is the same project"
        );
        assert_eq!(first.token, second.token);
    }

    #[test]
    fn close_project_clears_the_session_and_unbinds_the_server() {
        let dir = tempfile::TempDir::new().unwrap();
        let session = new_session();
        let queue = idle_queue();
        open_project_on(
            &session,
            dir.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();
        let server = session.lock().unwrap().as_ref().unwrap().mcp_server();

        close_project_on(&session, &queue).unwrap();

        assert!(session.lock().unwrap().is_none());
        assert!(!still_accepting(server.addr));
    }

    #[test]
    fn closing_with_no_project_open_is_a_no_op() {
        let session = new_session();
        close_project_on(&session, &idle_queue()).unwrap();
        assert!(session.lock().unwrap().is_none());
    }

    /// Criterion 4 (#1746), first session-end path: replace. TD-20 ruling (2) puts the ownership
    /// claim inside the aggregate precisely so the displaced project cannot keep it.
    #[test]
    fn replacing_the_open_project_releases_the_replaced_sessions_ownership() {
        let app_data = tempfile::TempDir::new().unwrap();
        let first = tempfile::TempDir::new().unwrap();
        let second = tempfile::TempDir::new().unwrap();
        let session = owning_session(app_data.path(), first.path());
        let server = session.lock().unwrap().as_ref().unwrap().mcp_server();

        open_project_on(
            &session,
            second.path().display().to_string(),
            ProjectObservers::default(),
        )
        .unwrap();

        assert!(session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_root(second.path()));
        // The claim and the bound server end together — neither outlives the session that held it.
        assert!(!still_accepting(server.addr));
        assert!(
            ownership_is_free(app_data.path(), first.path()),
            "the replaced session still holds the first project"
        );
    }

    /// Criterion 4 (#1746), second session-end path: explicit close. The falsifier the ordering
    /// guards against is an ownership release that leaves the MCP server bound, so both are
    /// asserted over the one teardown.
    #[test]
    fn closing_the_open_project_releases_its_ownership_and_unbinds_its_server() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let session = owning_session(app_data.path(), project.path());
        let server = session.lock().unwrap().as_ref().unwrap().mcp_server();

        close_project_on(&session, &idle_queue()).unwrap();

        assert!(session.lock().unwrap().is_none());
        assert!(!still_accepting(server.addr));
        assert!(
            ownership_is_free(app_data.path(), project.path()),
            "closing the project left its ownership claim held"
        );
    }
}
