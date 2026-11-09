// ABOUTME: TD-18's automatic refresh — the sink the sole `DocWatcher` fans normalized native events
// ABOUTME: to, its injected coalescing scheduler, and the started/completed/failed observer seam.

//! The half of TD-18 that turns native filesystem evidence into completed generations without a
//! user asking. `agent::watchdog::DocWatcher` stays the one root-recursive OS subscription and fans
//! each normalized event here; this module batches those events, coalesces the burst through an
//! injected [`RefreshScheduler`], and refreshes through [`ProjectFiles::refresh_with_events`] — the
//! **same serialized service operation** first load and `[Refresh]` reach through
//! [`ProjectFiles::refresh`], carrying the native batch as its only extra input, so the automatic
//! path can never publish a generation out of order with a user-triggered one.
//!
//! Three properties are load-bearing and are what the seams exist to make testable without sleeps:
//!
//! - **A burst is one refresh.** Saving one file emits several native events on both shipped
//!   platforms; scanning the tree once per event would be pure churn.
//! - **Nothing is consumed early.** The batch is handed to the service, which retains it (and any
//!   retained rename candidate) when a refresh cannot complete — so an event that arrives while a
//!   refresh is running causes a *subsequent* reconciliation rather than being folded into a run
//!   that has already drained its batch.
//! - **A failure keeps the last completed snapshot.** [`ProjectFiles`] already guarantees this; the
//!   observer reports the typed failure so J2 can show `Update failed` without the frontend ever
//!   becoming the authority on what the tree contains.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

use super::{NormalizedEvent, ProjectFiles, ProjectFilesError, ProjectFilesSnapshot};

/// How long the shipped scheduler lets a native burst settle before it refreshes. Long enough that
/// one editor save (write, metadata, close) is one refresh; short enough that a rail update still
/// reads as immediate.
const NATIVE_EVENT_QUIET_WINDOW: Duration = Duration::from_millis(150);

/// The seam the sole [`DocWatcher`] subscription fans normalized native evidence to besides the D21
/// watchdog (TD-18). Implementations must not block: the call happens on the watcher's own worker,
/// and a stalled sink would delay protected-document detection.
///
/// [`DocWatcher`]: crate::agent::watchdog::DocWatcher
pub trait NativeEventSink: Send + Sync {
    fn observe(&self, event: NormalizedEvent);
}

/// The automatic-refresh lifecycle, addressed to whatever surfaces J2's Loading/Updating/Update
/// failed states. The frontend is told what happened; it never decides *whether* a refresh happens
/// and never holds an authoritative tree — the completed snapshot it receives is the backend's.
pub trait ProjectFilesObserver: Send + Sync {
    /// A coalesced batch has begun refreshing (J2 `Updating`).
    fn refresh_started(&self);
    /// A generation completed. This snapshot is the whole truth for the rail; nothing is merged.
    fn refresh_completed(&self, snapshot: &ProjectFilesSnapshot);
    /// The refresh could not produce a trustworthy result. The last completed snapshot is still the
    /// one to show (J2 `Update failed`), and no focus moves.
    fn refresh_failed(&self, error: &ProjectFilesError);
}

/// One automatic-refresh lifecycle transition on the wire. Mirrored in TS as `stores/project.ts`'s
/// `ProjectFilesRefreshNotice` (CLAUDE.md: cross-boundary types are defined in Rust with
/// `Serialize` and mirrored there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProjectFilesRefreshNotice {
    Started,
    Completed { snapshot: ProjectFilesSnapshot },
    Failed { error: ProjectFilesError },
}

/// The injected coalescing seam (TD-18). One `request` arrives per normalized native batch; every
/// request that arrives while a run is still pending must fold into that one run.
pub trait RefreshScheduler: Send + Sync {
    fn request(&self, task: Arc<dyn Fn() + Send + Sync>);
}

/// The shipped scheduler: one owned worker that lets each burst settle, drains every request that
/// arrived meanwhile, and runs the task once.
///
/// The settle barrier is injected rather than hardcoded to `sleep` so coalescing is provable
/// without a test ever sleeping (test-plan: no sleeps): a test's barrier blocks until the test has
/// queued the rest of the burst, which is exactly the window the shipped quiet period approximates.
///
/// Dropping the value ends the worker and joins it, so a closed project cannot refresh after the
/// drop returns. Because that drop happens on the **synchronous** command thread the webview is
/// awaiting (`commands::project`'s close and replace-on-open paths), it is bounded deliberately:
/// [`Drop`] signals the shutdown first, which releases the quiet window immediately and abandons
/// every run that has not started, leaving the join to wait on at most one refresh already under
/// way (FR-X-4).
pub struct QuietWindowScheduler {
    requests: Option<Sender<Arc<dyn Fn() + Send + Sync>>>,
    shutdown: Arc<SchedulerShutdown>,
    worker: Option<JoinHandle<()>>,
}

/// The scheduler's stop signal, shared with its worker: a waitable flag rather than a plain one, so
/// the shipped quiet window can be *released* by shutdown instead of merely observed after it ends.
#[derive(Default)]
struct SchedulerShutdown {
    stopping: Mutex<bool>,
    changed: Condvar,
}

impl SchedulerShutdown {
    fn begin(&self) {
        *lock(&self.stopping) = true;
        self.changed.notify_all();
    }

    fn is_stopping(&self) -> bool {
        *lock(&self.stopping)
    }

    /// The shipped quiet window: `window`, or until shutdown begins — whichever comes first.
    /// `wait_timeout_while` evaluates the predicate *before* it waits, so a shutdown that already
    /// began by the time this is called returns at once instead of waiting on a notification that
    /// has been and gone.
    fn settle_for(&self, window: Duration) {
        let stopping = lock(&self.stopping);
        let _ = self
            .changed
            .wait_timeout_while(stopping, window, |stopping| !*stopping);
    }
}

impl QuietWindowScheduler {
    /// The shipped scheduler, coalescing every request that arrives within `window` of the first.
    pub fn new(window: Duration) -> QuietWindowScheduler {
        let shutdown = Arc::new(SchedulerShutdown::default());
        let quiet_window = Arc::clone(&shutdown);
        QuietWindowScheduler::stopping_with(
            shutdown,
            Arc::new(move || quiet_window.settle_for(window)),
        )
    }

    /// The same scheduler with an injected settle barrier — the deterministic test seam.
    pub fn settling(settle: Arc<dyn Fn() + Send + Sync>) -> QuietWindowScheduler {
        QuietWindowScheduler::stopping_with(Arc::new(SchedulerShutdown::default()), settle)
    }

    fn stopping_with(
        shutdown: Arc<SchedulerShutdown>,
        settle: Arc<dyn Fn() + Send + Sync>,
    ) -> QuietWindowScheduler {
        let (requests, incoming): (Sender<Arc<dyn Fn() + Send + Sync>>, _) = mpsc::channel();
        let worker = std::thread::spawn({
            let shutdown = Arc::clone(&shutdown);
            move || run_scheduler(incoming, settle, shutdown)
        });
        QuietWindowScheduler {
            requests: Some(requests),
            shutdown,
            worker: Some(worker),
        }
    }
}

fn run_scheduler(
    incoming: Receiver<Arc<dyn Fn() + Send + Sync>>,
    settle: Arc<dyn Fn() + Send + Sync>,
    shutdown: Arc<SchedulerShutdown>,
) {
    for task in &incoming {
        settle();
        // Every request that arrived while the burst settled names the same task and is already
        // represented by the batch this run will drain, so folding them in costs one refresh, not
        // one per event. Requests that arrive *after* this drain stay queued and win their own run.
        while incoming.try_recv().is_ok() {}
        // A run that has not started is abandoned once the project is closing: its result could
        // only describe a project that is no longer open, and the thread joining this one is the
        // command thread the user is waiting on. Shutdown also *ends* the settle above, so every
        // remaining request reaches this check rather than costing a window apiece.
        if shutdown.is_stopping() {
            break;
        }
        task();
    }
}

impl RefreshScheduler for QuietWindowScheduler {
    fn request(&self, task: Arc<dyn Fn() + Send + Sync>) {
        if let Some(requests) = self.requests.as_ref() {
            // A disconnected channel means the worker is gone while the project is still open, so
            // automatic refresh has silently stopped for the rest of the session. Never a silent
            // no-op (FR-X-5): the rail keeps showing the last completed generation, and this says
            // why. The user still has `[Refresh]`.
            if requests.send(task).is_err() {
                eprintln!(
                    "Cowrite project-files refresh scheduler is no longer running; this project's \
                     tree will only update when refreshed explicitly"
                );
            }
        }
    }
}

impl Drop for QuietWindowScheduler {
    fn drop(&mut self) {
        self.shutdown.begin();
        drop(self.requests.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// What the scheduled task needs, separated from the sink so the task never has to hold — or leak —
/// a reference back to the sink that queued it.
struct CoalescedRefresh {
    project_files: Arc<ProjectFiles>,
    observer: Option<Arc<dyn ProjectFilesObserver>>,
    pending: Mutex<Vec<NormalizedEvent>>,
    announcing: AtomicBool,
}

impl CoalescedRefresh {
    fn run(&self) {
        let events = std::mem::take(&mut *lock(&self.pending));
        if events.is_empty() {
            return;
        }
        if let Some(observer) = self.audience() {
            observer.refresh_started();
        }
        // The service owns retention: a refresh it cannot complete keeps this batch (and any
        // retained rename candidate) for the next one, so failing here consumes nothing.
        let outcome = self.project_files.refresh_with_events(events);
        // Re-read the audience rather than reusing the one above: the project can begin closing
        // *during* the scan, which is the whole window this guards.
        if let Some(observer) = self.audience() {
            match &outcome {
                Ok(snapshot) => observer.refresh_completed(snapshot),
                Err(error) => observer.refresh_failed(error),
            }
        }
    }

    /// Who this transition should be announced to — `None` once the project it describes has begun
    /// closing. The run itself still completes against its own service; it simply no longer has an
    /// audience it could tell the truth to.
    ///
    /// Read-then-announce, not one atomic act: a `silence()` landing between this load and the
    /// caller's own `refresh_completed`/`refresh_failed` call still lets that one notice out. What
    /// it removes is the whole scan-long window (a scan that starts before the close and finishes
    /// after it), not the few instructions after the check.
    fn audience(&self) -> Option<&Arc<dyn ProjectFilesObserver>> {
        if !self.announcing.load(Ordering::SeqCst) {
            return None;
        }
        self.observer.as_ref()
    }

    fn silence(&self) {
        self.announcing.store(false, Ordering::SeqCst);
    }
}

/// The [`NativeEventSink`] TD-18's fanout feeds: it batches normalized events and asks the injected
/// scheduler for one coalesced refresh of the project's [`ProjectFiles`] service.
pub struct AutomaticRefresh {
    refresh: Arc<CoalescedRefresh>,
    scheduler: Arc<dyn RefreshScheduler>,
}

impl AutomaticRefresh {
    /// The shipped wiring: coalesce through [`QuietWindowScheduler`] over the standard quiet window.
    /// Which scheduler production uses is this module's call, not the caller's — `OpenProject` mounts
    /// the sink, it does not choose the timing policy.
    pub fn shipped(
        project_files: Arc<ProjectFiles>,
        observer: Option<Arc<dyn ProjectFilesObserver>>,
    ) -> AutomaticRefresh {
        AutomaticRefresh::new(
            project_files,
            Arc::new(QuietWindowScheduler::new(NATIVE_EVENT_QUIET_WINDOW)),
            observer,
        )
    }

    pub fn new(
        project_files: Arc<ProjectFiles>,
        scheduler: Arc<dyn RefreshScheduler>,
        observer: Option<Arc<dyn ProjectFilesObserver>>,
    ) -> AutomaticRefresh {
        AutomaticRefresh {
            refresh: Arc::new(CoalescedRefresh {
                project_files,
                observer,
                pending: Mutex::new(Vec::new()),
                announcing: AtomicBool::new(true),
            }),
            scheduler,
        }
    }
}

/// Dropping this sink is how a project closes its automatic-refresh path (`OpenProject`'s
/// `DocWatcher` owns the only handle). The announcement channel carries no project identity and its
/// generations are per-service, so a transition announced after this point could only mislead: by
/// the time `commands::project::open_project_on` drops the outgoing project, the incoming one is
/// already installed, and a stale `completed` would paint the outgoing project's tree — under a
/// higher generation than the new project's first — into the project the user just opened.
///
/// Silencing here rather than in the scheduler is what makes it cover the one case abandoning
/// unstarted runs cannot: a scan already under way, which `QuietWindowScheduler::drop` deliberately
/// waits out. `Drop` runs before this value's own fields are dropped, so the silence is in place
/// before the scheduler field's drop joins that scan.
impl Drop for AutomaticRefresh {
    fn drop(&mut self) {
        self.refresh.silence();
    }
}

impl NativeEventSink for AutomaticRefresh {
    fn observe(&self, event: NormalizedEvent) {
        lock(&self.refresh.pending).push(event);
        let refresh = Arc::clone(&self.refresh);
        self.scheduler.request(Arc::new(move || refresh.run()));
    }
}

fn lock<T>(guarded: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    guarded.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod notice_wire_tests {
    use super::*;
    use crate::project_files::{EntryKind, PlatformFileId, ProjectFileEntry, ProjectFileMove};
    use serde_json::json;

    /// The exact JSON `stores/project.ts`'s `ProjectFilesRefreshNotice` is written against. Asserted
    /// here rather than assumed: the TS mirror is hand-written, so only the real `Serialize` output
    /// can prove the two sides agree on the tag name, the lower-cased status values, and the payload
    /// key each variant carries.
    #[test]
    fn each_refresh_transition_serializes_to_the_status_tagged_shape_the_frontend_mirrors() {
        assert_eq!(
            serde_json::to_value(ProjectFilesRefreshNotice::Started).unwrap(),
            json!({ "status": "started" })
        );
        assert_eq!(
            serde_json::to_value(ProjectFilesRefreshNotice::Completed {
                snapshot: ProjectFilesSnapshot {
                    generation: 3,
                    entries: Vec::new(),
                    moves: Vec::new(),
                },
            })
            .unwrap(),
            json!({
                "status": "completed",
                "snapshot": { "generation": 3, "entries": [], "moves": [] },
            })
        );
        assert_eq!(
            serde_json::to_value(ProjectFilesRefreshNotice::Failed {
                error: ProjectFilesError::UpdateFailed("enumeration failed".to_string()),
            })
            .unwrap(),
            json!({
                "status": "failed",
                "error": { "kind": "UpdateFailed", "message": "enumeration failed" },
            })
        );
    }

    /// Native identity is backend-only evidence (TD-18) — an announced snapshot must not carry it to
    /// the frontend, and the row/move keys must be the ones the TS mirror spells.
    #[test]
    fn an_announced_snapshot_carries_the_row_keys_without_native_identity() {
        let notice = ProjectFilesRefreshNotice::Completed {
            snapshot: ProjectFilesSnapshot {
                generation: 1,
                entries: vec![ProjectFileEntry {
                    path: "notes/draft.md".to_string(),
                    name: "draft.md".to_string(),
                    kind: EntryKind::File,
                    platform_file_id: Some(PlatformFileId::opaque(0, 1)),
                    children: Vec::new(),
                    warning: None,
                }],
                moves: vec![ProjectFileMove {
                    old_path: "notes/old.md".to_string(),
                    new_path: "notes/draft.md".to_string(),
                    kind: EntryKind::File,
                    platform_file_id: PlatformFileId::opaque(0, 1),
                }],
            },
        };

        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            json!({
                "status": "completed",
                "snapshot": {
                    "generation": 1,
                    "entries": [{
                        "path": "notes/draft.md",
                        "name": "draft.md",
                        "kind": "file",
                        "children": [],
                        "warning": null,
                    }],
                    "moves": [{
                        "old_path": "notes/old.md",
                        "new_path": "notes/draft.md",
                        "kind": "file",
                    }],
                },
            })
        );
    }
}
