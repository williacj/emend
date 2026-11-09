// ABOUTME: The TD-17 `OpenProject` aggregate — one open project's bound MCP server (TD-1), its D21
// ABOUTME: watchdog, shared protected set, TD-18 project-files service, and announcement seams,
// ABOUTME: all owned for exactly one project's open→close lifetime.

//! **TD-17, Option B (per-project bind).** Both halves of the P2a integration gap needed the same
//! missing thing: the backend had no project lifecycle. TD-1's MCP server had no production caller
//! because there was nothing that outlived a run to own it (#472), and the #496 watchdog machinery
//! had no producer because open tabs exist *before any run and between runs* (#497). One aggregate,
//! bound on project open and dropped on project close, is where both live.
//!
//! [`OpenProject`] owns, for that one lifetime:
//!
//! - the bound [`ProjectMcpServer`] — bind + serve-in-background on open, drop-and-unbind on close
//!   (#413's existing lifecycle), so the per-session bearer token lives exactly as long as the
//!   project session and no longer (FR-X-2);
//! - one [`Watchdog`] (#496);
//! - the single [`SharedProtectedSet`] those two share, so the tool boundary's protection reporting
//!   and the watchdog's enforcement read one union and can never drift (#414's design premise);
//! - TD-18's [`ProjectFiles`] service, so scanning and completed generations share the project's
//!   exact lifetime instead of becoming app-global or command-owned state;
//! - the #346 delivery / #420 birth observers the bound server announces landed tool calls through;
//! - **TD-20 ruling (2): this project's ownership claim** — the `store::lock::ProjectLockGuard` over
//!   the registry directory in per-user app-local data. `instances/` acquires it and hands it over;
//!   the aggregate owns it for the session and never lends it out again, so replace, close, and
//!   crash all release ownership through the same drop that unbinds the MCP server and the
//!   watchdog. There is no separate release step to forget, and no way for the project session and
//!   the ownership claim to disagree.
//!
//! **M7 (tech-design §3.5) keeps this small.** One project per app instance, so the app holds a
//! single [`SharedOpenProject`] — `Mutex<Option<OpenProject>>` — rather than a map keyed by root.
//! Opening replaces any prior project; closing clears it. `commands::project` owns the transition.
//!
//! **Not in this module:** what *populates* the protected set. The four producers (tab open/close,
//! run begin/end) are #497's, over the set [`OpenProject::protected_set`] hands out; the
//! `DocWatcher` FS-watch TD-17 also homes here is that card's sibling. This module is the mount
//! point they attach to, which is exactly why the set and the watchdog are reachable from it.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::{MutexGuard, PoisonError};

use uuid::Uuid;

use super::birth::DocumentBirthObserver;
use super::claude;
use super::delivery::{DeliveryObserver, DeliveryOutcomeObserver};
use super::mcp::ProjectMcpServer;
use super::run_queue::{RunObserver, RunRequest};
use super::watchdog::{DocWatcher, SharedProtectedSet, Watchdog};
use crate::instances::activator::OwnerActivationService;
use crate::project_files::{
    AutomaticRefresh, ProjectFiles, ProjectFilesObserver, ProjectPathRekeyer,
};
use crate::store::lock::ProjectLockGuard;
use crate::store::transcript;
use serde_json::Value;

/// The app-side seams a bound project announces through: #346 `propose_changes`, #420
/// `create_document`, and TD-18's automatic project-files refresh. All optional: the MCP server runs
/// on its own thread with no route back to a frontend, so a caller that has no frontend to reach
/// supplies none. The D23 driver supplies all three through its cursor-backed production event
/// transport, while Tauri supplies native emitters.
#[derive(Clone, Default)]
pub struct ProjectObservers {
    pub delivery: Option<Arc<dyn DeliveryObserver>>,
    pub births: Option<Arc<dyn DocumentBirthObserver>>,
    pub project_files: Option<Arc<dyn ProjectFilesObserver>>,
    pub permissions: Option<Arc<dyn super::permission::PermissionObserver>>,
}

#[derive(Default)]
struct RunDeliveryOutcomes(Mutex<Option<RunDeliveryOutcome>>);

struct RunDeliveryOutcome {
    run_id: String,
    landed: bool,
}

impl RunDeliveryOutcomes {
    fn begin(&self, run_id: &str) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(RunDeliveryOutcome {
            run_id: run_id.to_string(),
            landed: false,
        });
    }

    fn landed_for(&self, run_id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|outcome| outcome.run_id == run_id && outcome.landed)
    }

    fn end(&self, run_id: &str) {
        let mut outcome = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if outcome
            .as_ref()
            .is_some_and(|outcome| outcome.run_id == run_id)
        {
            *outcome = None;
        }
    }
}

impl DeliveryOutcomeObserver for RunDeliveryOutcomes {
    fn landed(&self) {
        if let Some(outcome) = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            outcome.landed = true;
        }
    }
}

struct WatchdogPathRekeyer {
    watchdog: Arc<Mutex<Watchdog>>,
}

impl ProjectPathRekeyer for WatchdogPathRekeyer {
    fn rekey_path(&self, old_path: &str, new_path: &str) {
        watchdog_lock(&self.watchdog).rekey_path(old_path, new_path);
    }
}

/// One open project's backend state (TD-17). Construct with [`open`](Self::open); drop it to close
/// the project — dropping the owned [`ProjectMcpServer`] stops its accept loop, closes the bound
/// socket, and joins the serving thread, so the token stops being honored before the drop returns.
pub struct OpenProject {
    /// This project's root in its canonical on-disk spelling — see [`canonical_root`].
    root: PathBuf,
    /// Dropped first so no new filesystem callback can race the rest of project teardown. It owns
    /// the only handle to this project's [`AutomaticRefresh`], so joining the watch worker also
    /// releases the coalescing scheduler and joins *its* worker before `project_files` goes away.
    /// Closing happens on a synchronous command thread, so that second join is bounded the same way
    /// the server's is: the scheduler's own [`Drop`] releases its quiet window and abandons refreshes
    /// that have not started, leaving at most one already-running scan to finish (FR-X-4).
    _doc_watcher: DocWatcher,
    server: ProjectMcpServer,
    /// TD-18's project-tree authority, tied to the same open→close lifetime as every other
    /// project-scoped backend service.
    project_files: Arc<ProjectFiles>,
    /// Owned, not merely constructed: it is the origin of the shared protected set below, and the
    /// mount point #497's producers (`open_tab`/`close_tab`/`begin_run`/`end_run`) attach to.
    watchdog: Arc<Mutex<Watchdog>>,
    /// Run-scoped persistence fact shared by the MCP server and run queue (#1420). Tool calls
    /// outside an active run are deliberately ignored; each serialized queue run starts fresh.
    delivery_outcomes: Arc<RunDeliveryOutcomes>,
    /// The provider session id to `--resume` on this project's *next* spawn (D4 continuity,
    /// #1723) — `None` until `OpenProjectRunObserver::session_established` records the first one.
    /// Loaded from machine-local project metadata in production, so close/reopen and app restart
    /// preserve continuity without writing provider state into the user's project.
    resume_session_id: Mutex<Option<String>>,
    /// Machine-local D15-adjacent metadata backing `resume_session_id`. `None` is reserved for
    /// isolated tests that construct an aggregate without an app-local-data directory.
    provider_session_file: Option<PathBuf>,
    /// The TD-20(6) request watcher for a routed owner. It is declared immediately before the
    /// lock so its bounded worker join completes before this process releases ownership.
    _activation_service: Option<OwnerActivationService>,
    /// TD-20 ruling (2): this session's ownership claim on the project, acquired by `instances/`
    /// and handed here. **Declared last on purpose** — Rust drops fields in declaration order, so
    /// ownership is released only after the MCP server is unbound and the watchdog is gone. The
    /// converse ordering would publish "nobody owns this project" while this process still served
    /// a bound token for it. There is deliberately no accessor and no take path: the guard cannot
    /// leave the aggregate, so the only way to release ownership is to end the session.
    ///
    /// `None` until the routing path that acquires it exists (P2a-11c..g) — a project opened
    /// without a claim simply never had one, which is not the same as releasing one it held.
    _ownership: Option<ProjectLockGuard>,
}

impl OpenProject {
    /// Opens `root`: builds this project's [`Watchdog`], takes its [`SharedProtectedSet`], and binds
    /// a [`ProjectMcpServer`] serving over that *same* set — so a doc that enters the set after the
    /// server is already serving is reported protected at the tool boundary immediately, with no
    /// rebind (#414). Fails only if the loopback bind fails; the caller decides what a project that
    /// cannot be opened means (`commands::project::open_project` surfaces it as a typed error, and
    /// leaves any already-open project untouched).
    pub fn open(root: impl AsRef<Path>, observers: ProjectObservers) -> io::Result<OpenProject> {
        Self::open_with(root, None, None, observers)
    }

    /// Opens a project with durable per-project provider continuity under app-local data.
    pub fn open_persisting_provider_session(
        root: impl AsRef<Path>,
        app_local_data_dir: &Path,
        observers: ProjectObservers,
    ) -> io::Result<OpenProject> {
        Self::open_with(
            root,
            None,
            Some(app_local_data_dir.to_path_buf()),
            observers,
        )
    }

    /// [`open`](Self::open), holding `ownership` — the `store::lock::ProjectLockGuard` `instances/`
    /// acquired for this root — for the whole session (TD-20 ruling (2)). The guard is stored, never
    /// exposed, so the session and the ownership claim end together: whichever way this project
    /// stops being the open one (replaced by another open, closed explicitly, or lost with the
    /// process), the same drop that unbinds the MCP server releases the claim.
    pub fn open_owning(
        root: impl AsRef<Path>,
        ownership: ProjectLockGuard,
        observers: ProjectObservers,
    ) -> io::Result<OpenProject> {
        Self::open_with(root, Some(ownership), None, observers)
    }

    /// The production routed-adoption constructor: retains TD-20 ownership and restores TD-5's
    /// provider-session continuity from the same app-local store as an ordinary project open.
    pub fn open_owning_persisting_provider_session(
        root: impl AsRef<Path>,
        ownership: ProjectLockGuard,
        app_local_data_dir: &Path,
        observers: ProjectObservers,
    ) -> io::Result<OpenProject> {
        Self::open_with(
            root,
            Some(ownership),
            Some(app_local_data_dir.to_path_buf()),
            observers,
        )
    }

    fn open_with(
        root: impl AsRef<Path>,
        ownership: Option<ProjectLockGuard>,
        app_local_data_dir: Option<PathBuf>,
        observers: ProjectObservers,
    ) -> io::Result<OpenProject> {
        let root = canonical_root(root.as_ref());
        let provider_session_file = app_local_data_dir
            .as_deref()
            .map(|dir| transcript::provider_session_file(dir, &root));
        let resume_session_id = provider_session_file
            .as_deref()
            .map(transcript::load_provider_session)
            .transpose()?
            .flatten();
        let watchdog = Arc::new(Mutex::new(Watchdog::new(root.clone())));
        let protected = watchdog_lock(&watchdog).protected_set();
        let project_files = Arc::new(ProjectFiles::with_rekeyer(
            &root,
            Arc::new(WatchdogPathRekeyer {
                watchdog: Arc::clone(&watchdog),
            }),
        ));
        // Built before the watch, because the one subscription fans to both of them (TD-18).
        let automatic_refresh = Arc::new(AutomaticRefresh::shipped(
            Arc::clone(&project_files),
            observers.project_files,
        ));
        let doc_watcher = DocWatcher::watch(&root, Arc::clone(&watchdog), automatic_refresh)
            .map_err(|error| io::Error::other(error.to_string()))?;
        let delivery_outcomes = Arc::new(RunDeliveryOutcomes::default());
        let server = ProjectMcpServer::open_with_protection_observing(
            root.clone(),
            protected,
            observers.delivery,
            observers.births,
            Some(Arc::clone(&delivery_outcomes) as Arc<dyn DeliveryOutcomeObserver>),
        )?;
        server.permissions().set_observer(observers.permissions);
        Ok(OpenProject {
            root,
            _doc_watcher: doc_watcher,
            server,
            project_files,
            watchdog,
            delivery_outcomes,
            resume_session_id: Mutex::new(resume_session_id),
            provider_session_file,
            _activation_service: None,
            _ownership: ownership,
        })
    }

    pub fn permissions(&self) -> Arc<super::permission::PermissionBroker> {
        self.server.permissions()
    }

    /// Installs the owner request watcher only while this aggregate owns the project's OS lock.
    /// It is crate-private because only `instances` startup/routing composition may construct the
    /// narrow focus-answering path; runs, deliveries, and notifications never receive it.
    pub(crate) fn install_owner_activation(&mut self, service: OwnerActivationService) -> bool {
        if self._ownership.is_none() || self._activation_service.is_some() {
            return false;
        }
        self._activation_service = Some(service);
        true
    }

    pub(crate) fn owns_project_lock(&self) -> bool {
        self._ownership.is_some()
    }

    /// This project's root, canonicalized.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether `root` names *this* open project — compared canonically, so two spellings of one
    /// directory (a trailing separator, a differing drive-letter case on Windows, a symlinked
    /// parent) are recognized as the same project rather than read as a project change.
    pub fn is_root(&self, root: impl AsRef<Path>) -> bool {
        self.root == canonical_root(root.as_ref())
    }

    /// The connection info the CLI-spawn adapter injects into every run's `--mcp-config` (TD-1,
    /// FR-X-2: backend-to-backend only, never surfaced to the frontend and never logged).
    pub fn mcp_server(&self) -> claude::McpServer {
        self.server.mcp_server()
    }

    /// The one live D21 protected set this project's watchdog enforces over and its MCP server
    /// reports from — the union #497's producers write into.
    pub fn protected_set(&self) -> SharedProtectedSet {
        watchdog_lock(&self.watchdog).protected_set()
    }

    /// The provider session this project's *next* spawn should `--resume` (D4 continuity,
    /// #1723) — `None` for a project that has not yet seen a run establish one, in which case the
    /// next spawn is honestly a fresh session, not a fabricated resume.
    pub fn resume_session_id(&self) -> Option<String> {
        resume_session_id_lock(&self.resume_session_id).clone()
    }

    /// Records a UUID-shaped `session_id` as this project's resume target, superseding whatever
    /// was recorded before — called by [`OpenProjectRunObserver::session_established`] once a run's
    /// stream announces one. Any other shape is untrusted provider output and is dropped without
    /// replacing the last known-good id: Claude's `--resume` argument is optional, so a value that
    /// begins with `-` would otherwise be parsed as another CLI flag (#1807). For headless `-p`
    /// Claude a resumed turn reports the same UUID back — executed against the real CLI (PR #1791
    /// review, 2026-08-20) — so recording each recognized latest id cannot drift while
    /// `--fork-session` is not passed.
    fn record_resume_session_id(&self, session_id: &str) -> io::Result<()> {
        if Uuid::parse_str(session_id).is_err() {
            eprintln!("Emend ignored a provider session id with an unrecognized shape");
            return Ok(());
        }
        if let Some(path) = &self.provider_session_file {
            transcript::save_provider_session(path, Some(session_id))?;
        }
        *resume_session_id_lock(&self.resume_session_id) = Some(session_id.to_string());
        Ok(())
    }

    fn clear_resume_session_id(&self) -> io::Result<()> {
        if let Some(path) = &self.provider_session_file {
            transcript::save_provider_session(path, None)?;
        }
        *resume_session_id_lock(&self.resume_session_id) = None;
        Ok(())
    }

    /// TD-18's one project-files service for this open project's lifetime. The cloned handle lets
    /// a caller release the project-session mutex before a filesystem walk begins (FR-X-4).
    pub fn project_files(&self) -> Arc<ProjectFiles> {
        Arc::clone(&self.project_files)
    }

    /// This project's watchdog, for the producers that drive it (#497: tab open/close, run
    /// begin/observe/end). `&mut` because every one of those is a mutation of live protection state.
    pub fn watchdog_mut(&mut self) -> MutexGuard<'_, Watchdog> {
        watchdog_lock(&self.watchdog)
    }
}

/// The app's single open project (M7: one per instance) — `None` before any project is opened and
/// after one is closed. Held in Tauri managed state and cloned into the run spawner, which reads
/// the bound server out of it for each run (`commands::agent::spawn_claude_run`).
pub type SharedOpenProject = Arc<Mutex<Option<OpenProject>>>;

/// The only open-project capabilities TD-20 routing receives: observe this instance's canonical
/// root and adopt an already-built aggregate if the slot is still empty. Keeping the shared
/// `Mutex<Option<OpenProject>>` private behind this view makes run/watchdog mutation unreachable
/// from the routing graph even though the full aggregate serves those capabilities elsewhere.
#[derive(Clone)]
pub(crate) struct ProjectRoutingSession {
    session: SharedOpenProject,
}

impl ProjectRoutingSession {
    pub(crate) fn new(session: SharedOpenProject) -> Self {
        Self { session }
    }

    pub(crate) fn current_root(&self) -> Option<PathBuf> {
        self.session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|project| project.root().to_path_buf())
    }

    pub(crate) fn adopt_if_empty(&self, project: OpenProject) -> bool {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if session.is_some() {
            return false;
        }
        *session = Some(project);
        true
    }
}

/// The production run→watchdog edge for one app-held TD-17 project. `RunQueue` is the only layer
/// that owns the stable run id and sees every raw stream event, so it announces those facts here;
/// this observer does no lifecycle bookkeeping of its own. Also the D4 continuity edge (#1723):
/// [`session_established`](RunObserver::session_established) persists a run's captured provider
/// session id onto the same open project, so the next spawn can `--resume` it.
pub struct OpenProjectRunObserver {
    session: SharedOpenProject,
}

impl OpenProjectRunObserver {
    pub fn new(session: SharedOpenProject) -> OpenProjectRunObserver {
        OpenProjectRunObserver { session }
    }

    fn with_watchdog(&self, operation: impl FnOnce(&mut Watchdog)) {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(project) = session.as_mut() {
            let mut watchdog = project.watchdog_mut();
            operation(&mut watchdog);
        }
    }
}

impl RunObserver for OpenProjectRunObserver {
    fn begin_run(&self, run_id: &str, request: &RunRequest) {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(project) = session.as_mut() else {
            return;
        };
        if project.is_root(&request.project_root) {
            project.permissions().begin(run_id);
            project.delivery_outcomes.begin(run_id);
            project
                .watchdog_mut()
                .begin_run(run_id, &request.operation_targets);
        }
    }

    fn stop_requested(&self, run_id: &str) {
        if let Some(project) = self
            .session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            project.permissions().end(run_id);
        }
    }

    fn observe(&self, run_id: &str, event: &Value) {
        self.with_watchdog(|watchdog| {
            // A provider announces Write before its filesystem writer necessarily closes. Record
            // attribution here, but leave conversion to the terminal scan after the child exits;
            // reading now can observe the truncate-before-replacement window (FR-AGENT-6).
            watchdog.observe(run_id, event);
        });
    }

    fn end_run(&self, run_id: &str) {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(project) = session.as_mut() {
            project.permissions().end(run_id);
            let delivery_outcomes = Arc::clone(&project.delivery_outcomes);
            {
                let mut watchdog = project.watchdog_mut();
                if watchdog.is_run_active(run_id) {
                    // The child has exited by this edge. One final inspection handles a native
                    // notification still queued behind EOF before unmatched announcements are
                    // discarded.
                    for doc in watchdog.watched_paths() {
                        if let Err(error) = watchdog.on_write(&doc) {
                            eprintln!("Emend document watchdog could not inspect {doc}: {error}");
                        }
                    }
                    watchdog.end_run(run_id);
                }
            }
            delivery_outcomes.end(run_id);
        }
    }

    fn delivery_landed(&self, run_id: &str) -> bool {
        self.session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|project| project.delivery_outcomes.landed_for(run_id))
    }

    /// D4 continuity (#1723): persists the run's captured provider session id as this project's
    /// next `resume_session_id`. No `is_root`/`is_run_active` gate is needed here (unlike
    /// `begin_run`/`end_run`, which key off a request or a watchdog registry this call has
    /// neither) — TD-20's product open route never replaces this instance's project, while
    /// `close_project_on` retains `RunQueue::run_if_idle`; `drain_and_advance` calls this before
    /// that run's phase turns terminal, so the open project cannot change under this call.
    fn session_established(&self, _run_id: &str, session_id: &str) -> Result<(), String> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(project) = session.as_mut() {
            project
                .record_resume_session_id(session_id)
                .map_err(|error| format!("persisting provider session continuity: {error}"))?;
        }
        Ok(())
    }

    fn clear_provider_session(&self, _run_id: &str) -> Result<(), String> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(project) = session.as_mut() {
            project
                .clear_resume_session_id()
                .map_err(|error| format!("clearing stale provider session continuity: {error}"))?;
        }
        Ok(())
    }
}

fn watchdog_lock(watchdog: &Mutex<Watchdog>) -> MutexGuard<'_, Watchdog> {
    watchdog
        .lock()
        .expect("open-project watchdog mutex is never poisoned")
}

fn resume_session_id_lock(slot: &Mutex<Option<String>>) -> MutexGuard<'_, Option<String>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `root` in its canonical on-disk spelling — [`crate::store::project_identity::canonical_root`],
/// the one implementation of the "canonicalize, or keep the raw form" rule, re-exposed under the
/// name this module's callers already use. Project identity and the app-local-data keying
/// (`project_key`, `store::lock::registry_dir`) therefore cannot drift apart by construction.
///
/// Load-bearing for project *identity*, not just tidiness: `is_root` and `commands::project`'s
/// already-open check compare paths, and on Windows two spellings of one directory that differ only
/// in case compare unequal as raw `PathBuf`s. Without this, reopening the project you already have
/// open reads as a project *change* — which tears down a live MCP server out from under a running
/// agent (PR #513 review 2026-07-21, Important).
pub fn canonical_root(root: &Path) -> PathBuf {
    crate::store::project_identity::canonical_root(root)
}

/// TD-20 ruling (2)'s **ordering** half, which the behavioural tests cannot reach.
///
/// Ownership must never be released while this process still serves a bound token for the project —
/// publishing "nobody owns this" to another instance that would then adopt it, with our MCP server
/// still accepting, is the falsifier. The mechanism is Rust's field-declaration drop order:
/// `_ownership` is declared **last** in [`OpenProject`], so it drops after `server`.
///
/// `commands::project`'s release tests assert only the *end* state — server unbound **and**
/// ownership free — which a field reshuffle leaves green: moving `_ownership` to first was measured
/// (PR #2233 review) to keep the whole lib target at 671 passed / 0 failed. So the declaration order
/// itself is pinned here by reading it, in the same style as `store::gitignore::caller_set_tests`,
/// rather than by making the teardown sequence explicit — that would need `server:
/// Option<ProjectMcpServer>` and a hand-written `Drop`, rippling through the aggregate for a
/// property one assertion can hold.
///
/// # What this does not pin
///
/// Reading the source is a weaker mechanism than the compiler, and the boundary is worth stating
/// exactly, because round 2 of the PR #2233 review found the first version of it claiming a
/// narrower blind spot than it had:
///
/// - **A hand-written `Drop` for [`OpenProject`].** Field order would stop deciding teardown
///   order and this assertion would keep passing.
/// - **A field this line-based parser cannot see** — one introduced by a macro expansion, or a
///   declaration split across lines so its name and its `:` are not on one line. The
///   `pub`-qualified case *was* in this class and is now read; the rest is a real residual, not a
///   hypothetical, and it fails **open**.
/// - **Whether each field genuinely must precede the claim.** "Last" is a position, not a reason.
///   [`RELEASED_BEFORE_OWNERSHIP`] names the three whose ordering carries the D21/FR-X-2 argument;
///   a fourth added later inherits the position without anyone restating why.
#[cfg(test)]
mod drop_order_tests {
    /// Declared **after** every one of these, so it is dropped after all of them: the MCP server
    /// whose bound token must stop being honored first, and the watchdog and doc-watch that enforce
    /// D21 protection for as long as this process holds the project.
    const RELEASED_BEFORE_OWNERSHIP: &[&str] = &["_doc_watcher", "server", "watchdog"];

    /// The field whose drop releases the ownership claim.
    const OWNERSHIP: &str = "_ownership";

    /// `OpenProject`'s field names, in declaration order — which *is* drop order (Rust reference,
    /// "Destructors": struct fields drop in declaration order).
    ///
    /// A name is the **last whitespace-separated token** before the colon, so a qualifier or a
    /// same-line attribute (`pub x: T`, `#[cfg(unix)] x: T`) still yields `x`. Round 2 of the
    /// PR #2233 review found the first version *discarding* such a declaration instead: a
    /// `pub`-qualified field added after `_ownership` — the exact hazard this test exists to
    /// catch — parsed to the name `pub probe_marker`, was filtered out for containing whitespace,
    /// and left the assertion green. A parser that drops what it cannot read fails **open**, so
    /// this one reads more and what it still cannot read is named on the test below.
    fn declared_fields() -> Vec<String> {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent/project.rs"),
        )
        .expect("this module's own source is readable");
        let body = source
            .split_once("pub struct OpenProject {")
            .expect("`pub struct OpenProject` is this module's aggregate")
            .1
            .split_once("\n}")
            .expect("the struct body is brace-terminated")
            .0;
        body.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .filter_map(|line| line.split_once(':'))
            .filter_map(|(name, _)| name.split_whitespace().next_back().map(str::to_string))
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[test]
    fn the_ownership_claim_is_declared_last_so_it_is_released_after_the_server_unbinds() {
        let fields = declared_fields();

        // Non-vacuity: an extraction that silently found nothing would satisfy every claim below.
        for expected in RELEASED_BEFORE_OWNERSHIP {
            assert!(
                fields.iter().any(|field| field == expected),
                "the field extraction did not find `{expected}`, so this assertion would be \
                 vacuous — fields read: {fields:?}"
            );
        }

        assert_eq!(
            fields.last().map(String::as_str),
            Some(OWNERSHIP),
            "`{OWNERSHIP}` must be `OpenProject`'s LAST field: fields drop in declaration order, so \
             any field after it is torn down while this process still holds the project's ownership \
             claim — and any field before it that publishes availability (`server`) would let a \
             second instance adopt a project this one is still serving. Fields read: {fields:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project::refresh_project_files_on;
    use crate::project_files::{ProjectFileEntry, ProjectFilesError, ProjectFilesScanner};
    use crate::store::lock::{self, LockOutcome, LockOwner};
    use crate::store::service::SidecarStore;
    use crate::store::tab_session;
    use crate::test_support::{spawn_ignored_test, tree, tree_with_contents};
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::sync::mpsc::{self, Receiver, Sender};

    const DRAFT: &str = "draft.md";
    const SESSION_ID: &str = "e6639704-657d-4f23-8225-2f41647dbe31";

    /// The only paths an ordinary project open may leave under the project root's `.emend/`.
    /// TD-12 (amended 2026-08-14) narrows the machine-local list to exactly `tab-session.json`,
    /// which `store::tab_session` writes when a *tab session* is saved — opening a project writes
    /// none of it, so an open leaves `.emend/` exactly as it found it and this list is empty.
    ///
    /// Deliberately an allowlist. A list of forbidden names (`lock`, `lock.owner`, …) proves only
    /// what it lists, and would keep passing while the open path wrote some *other* new runtime
    /// file into the user's repo. A sanctioned future addition has to name itself here, which is
    /// TD-12's standing rule expressed as a test.
    const SANCTIONED_EMEND_PATHS_AFTER_OPEN: &[&str] = &[];

    /// The env vars the ownership-release subprocess reads. The child is a second *process*, not a
    /// second thread: releasing on process exit is the one session-end path no in-process test can
    /// honestly assert.
    const CHILD_ROOT_ENV: &str = "EMEND_OWNERSHIP_CHILD_ROOT";
    const CHILD_REGISTRY_ENV: &str = "EMEND_OWNERSHIP_CHILD_REGISTRY";
    const CHILD_HELD_MARKER: &str = "EMEND_OWNERSHIP_HELD";

    /// Takes ownership of a root, holds it inside a live [`OpenProject`], and blocks — so the
    /// parent can kill this process and observe what an abrupt exit leaves behind.
    #[test]
    #[ignore = "subprocess helper invoked by the parent ownership-release test"]
    fn open_project_ownership_holder_subprocess() {
        let Ok(root) = std::env::var(CHILD_ROOT_ENV) else {
            return;
        };
        let registry = std::env::var(CHILD_REGISTRY_ENV)
            .expect("the parent supplies an isolated registry root");
        let root = PathBuf::from(root);
        let ownership = lock::test_support::take(
            &lock::registry_dir(Path::new(&registry), &root),
            &root,
            "child-instance",
        );
        let _project =
            OpenProject::open_owning(&root, ownership, ProjectObservers::default()).unwrap();
        println!("{CHILD_HELD_MARKER}");
        std::io::stdout().flush().unwrap();
        let mut release = [0_u8; 1];
        let _ = std::io::stdin().read_exact(&mut release);
    }

    /// Criterion 1 (#1746): opening a project must not write runtime state into the user's repo.
    #[test]
    fn an_ordinary_project_open_leaves_only_sanctioned_files_under_the_projects_emend_dir() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let ownership = lock::test_support::take(
            &lock::registry_dir(registry.path(), project.path()),
            project.path(),
            "instance-a",
        );

        let _open =
            OpenProject::open_owning(project.path(), ownership, ProjectObservers::default())
                .unwrap();

        assert_eq!(
            tree(&project.path().join(".emend")),
            SANCTIONED_EMEND_PATHS_AFTER_OPEN,
            "an ordinary project open left unsanctioned paths under the user's `.emend/`"
        );
    }

    /// TD-29: a project that holds only Cowrite's `.cowrite/` opens as a project with no sidecar
    /// state. Real sidecar data and a saved tab session are written where Emend keeps them, then
    /// moved to where Cowrite did; the open must restore none of it and leave it byte-identical.
    #[test]
    fn a_project_holding_only_dot_cowrite_opens_with_no_state_and_leaves_it_untouched() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        fs::write(project.path().join("a.md"), "# a\n").unwrap();
        let old_id = SidecarStore::new(project.path())
            .get_or_mint_for_path("a.md")
            .unwrap();
        tab_session::save(
            project.path(),
            &tab_session::Session::new(
                vec![tab_session::TabSnapshot::new("a.md", None)],
                Some("a.md".to_string()),
            ),
        )
        .unwrap();
        fs::rename(
            project.path().join(".emend"),
            project.path().join(".cowrite"),
        )
        .unwrap();
        let before = tree_with_contents(&project.path().join(".cowrite"));
        assert!(before.iter().any(|(path, _)| path == "tab-session.json"));
        let ownership = lock::test_support::take(
            &lock::registry_dir(registry.path(), project.path()),
            project.path(),
            "instance-a",
        );

        let _open =
            OpenProject::open_owning(project.path(), ownership, ProjectObservers::default())
                .unwrap();

        assert_eq!(
            tab_session::load(project.path()).unwrap(),
            tab_session::Session::default()
        );
        assert_eq!(
            SidecarStore::new(project.path())
                .doc_id_for_path("a.md")
                .unwrap(),
            None,
            "the open adopted the .cowrite/ document id {old_id}"
        );
        assert_eq!(tree_with_contents(&project.path().join(".cowrite")), before);
        assert_eq!(
            tree(&project.path().join(".emend")),
            SANCTIONED_EMEND_PATHS_AFTER_OPEN
        );
    }

    /// Criterion 4 (#1746), third session-end path: the process itself goes away. The OS releases
    /// the lock when the owning handle closes, so no cleanup step has to run — and none can.
    ///
    /// This is *not* the cross-process rendezvous proof: nothing here races two acquires, and the
    /// genuinely concurrent cross-process case remains P2a-11d's. The second process exists only
    /// because "ownership survives no longer than the process" is unassertable inside one.
    #[test]
    fn losing_the_owning_process_releases_the_projects_ownership() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let registry_dir = lock::registry_dir(registry.path(), project.path());
        let mut child = spawn_ignored_test(
            "agent::project::tests::open_project_ownership_holder_subprocess",
            &[
                (CHILD_ROOT_ENV, project.path().as_os_str()),
                (CHILD_REGISTRY_ENV, registry.path().as_os_str()),
            ],
            CHILD_HELD_MARKER,
        );

        // The precondition: without it the release below would pass vacuously against a child that
        // never took ownership at all.
        let while_held = lock::acquire(
            &registry_dir,
            &LockOwner::new("instance-parent", project.path()),
        )
        .unwrap();
        assert!(matches!(
            while_held,
            LockOutcome::HeldByAnotherInstance { .. }
        ));

        child.0.kill().unwrap();
        child.0.wait().unwrap();

        let after_exit = lock::acquire(
            &registry_dir,
            &LockOwner::new("instance-parent", project.path()),
        )
        .unwrap();
        assert!(
            matches!(after_exit, LockOutcome::Acquired(_)),
            "a project whose owning process is gone must not stay held"
        );
    }

    fn project_without_a_native_watch_on_root(root: &Path) -> OpenProject {
        let root = canonical_root(root);
        let watchdog = Arc::new(Mutex::new(Watchdog::new(root.clone())));
        let protected = watchdog_lock(&watchdog).protected_set();
        let inert_root = root.join(".inert-watch");
        std::fs::create_dir(&inert_root).unwrap();
        let inert_watchdog = Arc::new(Mutex::new(Watchdog::new(inert_root.clone())));
        let project_files = Arc::new(ProjectFiles::with_rekeyer(
            &root,
            Arc::new(WatchdogPathRekeyer {
                watchdog: Arc::clone(&watchdog),
            }),
        ));
        let doc_watcher = DocWatcher::watch(
            inert_root,
            inert_watchdog,
            Arc::new(AutomaticRefresh::shipped(Arc::clone(&project_files), None)),
        )
        .unwrap();
        let delivery_outcomes = Arc::new(RunDeliveryOutcomes::default());
        let server = ProjectMcpServer::open_with_protection_observing(
            root.clone(),
            protected,
            None,
            None,
            Some(Arc::clone(&delivery_outcomes) as Arc<dyn DeliveryOutcomeObserver>),
        )
        .unwrap();
        OpenProject {
            root,
            _doc_watcher: doc_watcher,
            server,
            project_files,
            watchdog,
            delivery_outcomes,
            resume_session_id: Mutex::new(None),
            provider_session_file: None,
            _activation_service: None,
            _ownership: None,
        }
    }

    fn session_observer(root: &Path) -> (SharedOpenProject, OpenProjectRunObserver) {
        let session = Arc::new(Mutex::new(Some(
            OpenProject::open(root, ProjectObservers::default()).unwrap(),
        )));
        let observer = OpenProjectRunObserver::new(Arc::clone(&session));
        (session, observer)
    }

    fn resume_session_id(session: &SharedOpenProject) -> Option<String> {
        session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .resume_session_id()
    }

    struct BlockingScanner {
        started: Mutex<Option<Sender<()>>>,
        resume: Mutex<Receiver<()>>,
    }

    impl ProjectFilesScanner for BlockingScanner {
        fn scan(&self, _root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
            self.started
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            let _ = self.resume.lock().unwrap().recv();
            Ok(Vec::new())
        }
    }

    #[test]
    fn project_files_refresh_releases_the_session_lock_before_scanning() {
        let root = tempfile::TempDir::new().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let scanner = Arc::new(BlockingScanner {
            started: Mutex::new(Some(started_tx)),
            resume: Mutex::new(resume_rx),
        });
        let mut project = project_without_a_native_watch_on_root(root.path());
        project.project_files = Arc::new(ProjectFiles::with_scanner(root.path(), scanner));
        let session = Arc::new(Mutex::new(Some(project)));
        let refresh_session = Arc::clone(&session);
        let refresh = std::thread::spawn(move || refresh_project_files_on(&refresh_session));

        started_rx.recv().unwrap();
        assert!(
            session.try_lock().is_ok(),
            "synchronous project commands must not block behind the filesystem walk"
        );
        resume_tx.send(()).unwrap();
        refresh.join().unwrap().unwrap();
    }

    #[test]
    fn a_truncate_before_replacement_write_is_coalesced_until_the_run_finishes() {
        let root = tempfile::TempDir::new().unwrap();
        let doc = root.path().join(DRAFT);
        let base = "# Notes\n\nThe original, human-authored notes.\n";
        let replacement = "# Notes\n\nRewritten by a misbehaving agent.\n";
        std::fs::write(&doc, base).unwrap();

        let mut project = project_without_a_native_watch_on_root(root.path());
        project.watchdog_mut().open_tab(DRAFT);
        let session = Arc::new(Mutex::new(Some(project)));
        let observer = OpenProjectRunObserver::new(Arc::clone(&session));

        observer.begin_run("run-truncate", &request(root.path()));
        std::fs::write(&doc, "").unwrap();
        observer.observe("run-truncate", &write_event(DRAFT));
        std::fs::write(&doc, replacement).unwrap();
        observer.end_run("run-truncate");

        let tracked = std::fs::read_to_string(&doc).unwrap();
        assert_ne!(
            tracked, replacement,
            "the replacement must not remain untracked"
        );
        assert_eq!(textops::accept_all(&tracked), replacement);

        let store = crate::store::service::SidecarStore::new(root.path());
        let doc_id = store.doc_id_for_path(DRAFT).unwrap().unwrap();
        let changes = store.fold_changes(doc_id).unwrap();
        assert!(changes.changes.values().any(|change| {
            matches!(
                change.kind,
                crate::store::changes::ChangeType::Insertion
                    | crate::store::changes::ChangeType::Substitution
            )
        }));
    }

    fn request(root: &Path) -> RunRequest {
        RunRequest {
            project_root: root.to_path_buf(),
            prompt: "test".to_string(),
            operation_targets: vec![DRAFT.to_string()],
        }
    }

    fn write_event(path: &str) -> Value {
        json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "name": "Write",
                "input": { "file_path": path }
            }] }
        })
    }

    #[test]
    fn open_binds_a_loopback_server_with_a_token_for_the_project() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

        let server = project.mcp_server();
        assert!(server.addr.ip().is_loopback());
        assert!(!server.token.is_empty());
    }

    #[test]
    fn a_uuid_shaped_provider_session_id_becomes_the_resume_target() {
        let dir = tempfile::TempDir::new().unwrap();
        let (session, observer) = session_observer(dir.path());

        observer.session_established("run-1", SESSION_ID).unwrap();

        assert_eq!(resume_session_id(&session), Some(SESSION_ID.to_string()));
    }

    #[test]
    fn a_flag_shaped_provider_session_id_cannot_replace_the_resume_target() {
        let dir = tempfile::TempDir::new().unwrap();
        let (session, observer) = session_observer(dir.path());
        observer.session_established("run-1", SESSION_ID).unwrap();

        observer
            .session_established("run-2", "--permission-mode")
            .unwrap();

        assert_eq!(
            resume_session_id(&session),
            Some(SESSION_ID.to_string()),
            "an untrusted provider field must not become a CLI flag on the next spawn"
        );
    }

    #[test]
    fn a_non_uuid_provider_session_id_is_dropped_even_without_a_leading_dash() {
        let dir = tempfile::TempDir::new().unwrap();
        let (session, observer) = session_observer(dir.path());

        observer
            .session_established("run-1", "provider-session")
            .unwrap();

        assert_eq!(
            resume_session_id(&session),
            None,
            "the guard must recognize provider ids positively, not only deny leading dashes"
        );
    }

    /// TD-17's (c): the tool boundary and the watchdog must read *one* union, never two that drift.
    /// The aggregate is what guarantees it — the set the server serves over is the watchdog's own.
    #[test]
    fn the_servers_protected_set_is_the_watchdogs_own_live_set() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

        let shared = project.protected_set();
        assert!(!shared.lock().unwrap().is_protected("draft.md"));

        // A producer's mutation (#497 drives these for real) is visible through the same set the
        // server was bound over, with no rebind.
        project.watchdog_mut().open_tab("draft.md");
        assert!(shared.lock().unwrap().is_protected("draft.md"));
    }

    #[test]
    fn a_project_recognizes_its_own_root_and_rejects_a_different_one() {
        let dir = tempfile::TempDir::new().unwrap();
        let other = tempfile::TempDir::new().unwrap();
        let project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

        assert!(project.is_root(dir.path()));
        assert!(!project.is_root(other.path()));
    }

    #[test]
    fn a_run_rejected_for_another_project_cannot_announce_attribution() {
        let dir = tempfile::TempDir::new().unwrap();
        let other = tempfile::TempDir::new().unwrap();
        let base = "Original.\n";
        let raw_write = "Foreign run write.\n";
        std::fs::write(dir.path().join(DRAFT), base).unwrap();
        let session = Arc::new(Mutex::new(Some(project_without_a_native_watch_on_root(
            dir.path(),
        ))));
        let observer = OpenProjectRunObserver::new(Arc::clone(&session));

        observer.begin_run("foreign-run", &request(other.path()));
        std::fs::write(dir.path().join(DRAFT), raw_write).unwrap();
        observer.observe("foreign-run", &write_event(DRAFT));
        observer.end_run("foreign-run");

        assert_eq!(
            std::fs::read_to_string(dir.path().join(DRAFT)).unwrap(),
            raw_write
        );
    }

    #[test]
    fn ending_a_rejected_run_does_not_flush_an_accepted_runs_announcements() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = "Original.\n";
        let raw_write = "Accepted run write.\n";
        std::fs::write(dir.path().join(DRAFT), base).unwrap();
        let session = Arc::new(Mutex::new(Some(project_without_a_native_watch_on_root(
            dir.path(),
        ))));
        let observer = OpenProjectRunObserver::new(Arc::clone(&session));

        observer.begin_run("accepted-run", &request(dir.path()));
        observer.observe("accepted-run", &write_event(DRAFT));
        std::fs::write(dir.path().join(DRAFT), raw_write).unwrap();

        observer.end_run("foreign-run");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(DRAFT)).unwrap(),
            raw_write,
            "a rejected run's terminal edge must not inspect the open project's docs"
        );

        observer.end_run("accepted-run");
        let converted = std::fs::read_to_string(dir.path().join(DRAFT)).unwrap();
        assert!(
            converted.contains("{++") || converted.contains("{--") || converted.contains("{~~"),
            "the accepted run still owns and flushes its announcement"
        );
    }

    /// The review finding this card carries (PR #513, 2026-07-21, Important): two spellings of the
    /// same directory must be the same project.
    ///
    /// The spelling is `<root>/sub/..`, deliberately not `<root>/.`: Rust's own `Path` comparison
    /// already drops `CurDir` components, so a `.` spelling compares equal with **no**
    /// canonicalization at all and makes this test vacuous — confirmed by mutation (deleting the
    /// `canonicalize` call left the `.` version green). A `ParentDir` component is not normalized
    /// away, because resolving it correctly needs the filesystem — which is exactly what
    /// [`canonical_root`] consults.
    #[test]
    fn a_differently_spelled_path_to_the_same_directory_is_the_same_project() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let respelled = dir.path().join("sub").join("..");
        assert_ne!(
            respelled.as_path(),
            dir.path(),
            "the two spellings must differ as raw paths, or this proves nothing"
        );

        let project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

        assert!(project.is_root(&respelled));
    }

    #[test]
    fn open_records_the_canonical_root_not_the_spelling_it_was_handed() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let project = OpenProject::open(
            dir.path().join("sub").join(".."),
            ProjectObservers::default(),
        )
        .unwrap();

        assert_eq!(project.root(), canonical_root(dir.path()));
    }

    /// The *literal* scenario the 2026-07-21 reviewer executed a Windows probe for: two paths to one
    /// directory differing only in case.
    ///
    /// Gated to **both** of Cowrite's shipped platforms, not just Windows: macOS ships APFS/HFS+
    /// case-insensitive by default, so the guard is exactly as load-bearing there — `agent::state`'s
    /// own case-variant confinement tests use this same `any(windows, macos)` gate for the same
    /// reason. On a case-sensitive filesystem these two spellings are genuinely different
    /// directories and the assertion would be false, which is what the gate excludes.
    #[test]
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn a_case_differing_path_to_the_same_directory_is_the_same_project() {
        let dir = tempfile::TempDir::new().unwrap();
        // Uppercasing the last component only: the temp dir's own name, which is the part this
        // process created and can safely re-spell.
        let parent = dir.path().parent().expect("a temp dir has a parent");
        let name = dir
            .path()
            .file_name()
            .expect("a temp dir has a name")
            .to_string_lossy()
            .to_uppercase();
        let respelled = parent.join(name);
        assert_ne!(
            respelled.as_path(),
            dir.path(),
            "the two spellings must differ as raw paths, or this proves nothing"
        );

        let project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

        assert!(project.is_root(&respelled));
    }
}
