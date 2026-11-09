// ABOUTME: FR-AGENT-7 run queue (TD-5) — one agent run active per project at a time; a start
// ABOUTME: request while one is running queues visibly and cancellably, executed in order.

//! `agent::session` owns spawn/stream/kill for *one* run (TD-5); this module orders many. M7's
//! one-project-per-app-instance invariant (tech-design §3.5) means "per project" collapses to "per
//! app process" — one [`RunQueue`] is the whole picture, no project keying needed.
//!
//! [`RunQueue::start`] spawns immediately when idle, or queues behind whatever's active
//! (FR-AGENT-7). A background thread drains the active session's stream to completion (or death)
//! and then decides its terminal [`RunPhase`] and, if anything is waiting, starts it next — all
//! visible through [`RunQueue::state`]. [`RunQueue::stop`] kills the active run (its phase resolves
//! to `Stopped` shortly after) or cancels a still-queued one outright.
//!
//! Finalizing a phase and starting the next run happen inside one lock acquisition, so a run with
//! a queued successor is never observable as `active` in its terminal phase. The cumulative
//! [`RunQueueState::finished`] ledger is what a poller reads instead, so several runs finishing
//! between two polls still reach the client in completion order (FR-X-3: never a silent gap).

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::activity::ActivityLine;
use super::session::{AgentSession, KillHandle, SessionError};

/// Identifies one run, spawned or still queued — a fresh `run-<uuid>` per [`RunQueue::start`] call.
pub type RunId = String;

/// The synchronous acknowledgement for one accepted request. `queued_position` is present when
/// another run was active at submission time, so the caller can surface FR-AGENT-7's visible,
/// cancellable queue immediately instead of waiting for this run to become active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
// @anchor:start-run-result-shape
pub struct StartRunResult {
    pub id: RunId,
    pub queued_position: Option<usize>,
}

/// One request to run the agent: what to say, and which project it runs against.
#[derive(Debug, Clone)]
// @anchor:run-request-shape
pub struct RunRequest {
    pub project_root: PathBuf,
    pub prompt: String,
    /// Project-relative documents this operation intends to touch. The run observer pins them for
    /// the run's full lifetime (D21), independently of whether they are currently open as tabs.
    pub operation_targets: Vec<String>,
}

/// Where a run currently stands (FR-X-3: always one of these, visibly — never a silent gap).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum RunPhase {
    Running,
    /// The run's stream ended cleanly. `reply` is the agent's own answer for the turn
    /// (`agent::reply`, captured off the provider's terminal `result` event) — the channel that
    /// carries a chat turn's prose to the timeline, where it renders as an agent chat message
    /// (#1118, J2's "normal chat, no special UI", Principle 5's one stream in both directions).
    /// `None` for a turn that produced no prose at all (a stream that ended before its terminal
    /// event, an unsuccessful or blank one) — never an invented or empty answer.
    ///
    /// **Scoped to runs whose output *is* prose** (CJ's ruling on #1118, 2026-08-12): `None` as
    /// well for a run that actually landed tracked changes or comments, however much prose its
    /// terminal event carried. Such a run already reports itself through its own change-set or
    /// comment card, and a real delivery's
    /// closing line routinely says the edits were made — which, beside a change set still pending
    /// triage, is a second and false provenance claim (Principle 1, FR-X-5). The J1 delivery flow
    /// is left exactly as it was; this channel adds a card only where there was none.
    ///
    /// Deliberately the only phase that carries a reply at all. A stopped run's card reports the
    /// J7 stop outcome and a failed run's reports its failure message; neither is a turn that
    /// answered the user, so neither puts prose in the chat stream even in the narrow case where a
    /// `result` event happened to arrive before the kill or the read error.
    Completed {
        reply: Option<String>,
    },
    /// A resumed provider identity was rejected before any delivery, then the queue's one fresh
    /// fallback completed successfully. Kept distinct so the timeline can persist the required
    /// continuity notice without changing every ordinary completion payload.
    Recovered {
        reply: Option<String>,
    },
    /// Resolved after [`RunQueue::stop`] signaled it (FR-X-3 cancellable). `delivered`
    /// distinguishes ux-design.md §2/J7's two honest stop outcomes — `false` renders "STOPPED —
    /// nothing applied", `true` renders "STOPPED — partial delivery" — from whether any TD-1 §3.2
    /// delivery call (`propose_changes`, `add_comments`, `reply_to_comment`) was ever observed in
    /// the stream before the kill ([`AgentSession::saw_delivery`], TD-1/FR-AGENT-6 by architecture).
    /// **#1404:** this used to read `AgentSession::saw_propose_changes` alone, so a run stopped
    /// after it had already filed a comment — durably on the TD-4 sidecar — reported "nothing
    /// applied" regardless; `saw_delivery` is the wider, comment-inclusive signal #1118 introduced
    /// for exactly this purpose. Per-section/per-comment completion accounting for the "partial"
    /// case (J7's fuller card copy) is P3-3's job, not this one.
    Stopped {
        delivered: bool,
    },
    /// The CLI never spawned, or its stream ended in a read error, rather than a clean exit —
    /// ux-design.md §2/J7's "unexpected CLI death".
    Failed {
        message: String,
    },
}

impl RunPhase {
    fn is_terminal(&self) -> bool {
        !matches!(self, RunPhase::Running)
    }
}

/// A run's full observable picture (FR-X-3): id, phase, the J1 Working-state activity feed
/// accumulated so far (`agent::activity`, in stream order), and how long it has been running —
/// frozen at whatever it reached the instant the run resolved to a terminal phase, rather than
/// drifting forward on every later poll. The one payload shape both [`RunQueue::state`]'s poll and
/// the live `agent://activity` push (`commands::agent::TauriActivityEmitter`) carry — a driver
/// polling `state()` and a GUI `listen()`ing both see the identical picture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
// @anchor:run-status-shape
pub struct RunStatus {
    pub id: RunId,
    pub phase: RunPhase,
    // @anchor:run-status-activity-field
    pub activity: Vec<ActivityLine>,
    pub elapsed_secs: u64,
}

/// A still-queued run and its 1-based position (FR-AGENT-7 "visibly" — position 1 runs next).
#[derive(Debug, Clone, Serialize)]
// @anchor:queued-run-shape
pub struct QueuedRun {
    pub id: RunId,
    pub position: usize,
}

/// The full FR-AGENT-7 picture: what's active (if anything), what's waiting behind it, and the
/// ordered terminal history for the currently open project's lifetime.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQueueState {
    pub active: Option<RunStatus>,
    // @anchor:run-queue-state-queued
    pub queued: Vec<QueuedRun>,
    /// Every terminal status in completion order. This is cumulative for one open-project lifetime so
    /// a polling client cannot skip an outcome when two runs finish between polls, and a newly
    /// mounted subscriber can replay outcomes that raced its mount. The deliberate cost is one
    /// frozen `RunStatus` (including that run's activity lines) per submitted run until that
    /// project is replaced or closed. `RunQueue` is app-process scoped, so the successful project
    /// transition clears the ledger under the same idle lock; one project's terminals never replay
    /// into another. Bounding it further without a durable per-subscriber acknowledgement cursor
    /// would reintroduce the lost-terminal class this field closes.
    pub finished: Vec<RunStatus>,
    /// The terminal status most recently recorded in `finished`.
    /// Without this, a run's `Completed`/`Stopped`/`Failed` outcome is unobservable through
    /// [`RunQueue::state`] whenever another run was already queued behind it — `drain_and_advance`
    /// finalizes the phase and starts the next run inside one lock acquisition, so no poll ever
    /// sees the intermediate state. This newest projection is always `finished.last()`.
    pub last_finished: Option<RunStatus>,
}

/// What the close-project operation did while holding the queue's idle lock.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProjectTransition<T> {
    Closed(T),
}

impl RunQueueState {
    /// Runs still holding their addressed comment targets for J10 correction eligibility.
    /// A completed run remains known for reconciliation, but no longer holds correction.
    pub fn live_run_ids(&self) -> HashSet<RunId> {
        let mut ids: HashSet<RunId> = self.queued.iter().map(|run| run.id.clone()).collect();
        if let Some(active) = &self.active {
            if matches!(active.phase, RunPhase::Running) {
                ids.insert(active.id.clone());
            }
        }
        ids
    }

    /// Every run id this queue has any record of at all — `active` **regardless of phase**, every
    /// still-queued run, and the cumulative `finished` ledger — the set
    /// `commands::comments::load_comment_threads`
    /// checks a document's persisted `pending_run` ids against before reconciling one to failed
    /// (issue #1381, ux-design.md §2's last exit row: "restart, lost completion").
    ///
    /// Deliberately **not** narrowed to "still running": a run's own terminal phase (`Completed`,
    /// `Stopped`, or `Failed`) does not by itself mean every thread it was addressing has finished
    /// reacting to it — a batch's per-thread `link_changes`/defense `reply` events land as separate,
    /// slightly-trailing store writes (P2a-15's real orchestration, and the D23/e2e convention of
    /// simulating a delivery via direct backend calls decoupled from the run's own process both
    /// share this shape) — and TimelinePanel's own live `agent://activity` listener
    /// (`concludeLostAddressRuns`) is what reconciles a **live session's own** stop/failure while a
    /// caller can still observe it happening. Reconciliation here exists for the run this process's
    /// queue has genuinely never heard of at all — true on every id after a restart, since a fresh
    /// process's `RunQueue` starts with no active, queued, or finished run, making
    /// this set empty and every persisted `pending_run` unknown. Narrowing to "not terminal" instead
    /// reconciled a thread mid-delivery the instant its batch's own run happened to resolve first —
    /// observed against the real D23 driver (e2e's batch address journey, #1381 review).
    pub fn known_run_ids(&self) -> HashSet<RunId> {
        let mut ids: HashSet<RunId> = self.queued.iter().map(|queued| queued.id.clone()).collect();
        if let Some(active) = &self.active {
            ids.insert(active.id.clone());
        }
        if let Some(last_finished) = &self.last_finished {
            ids.insert(last_finished.id.clone());
        }
        ids.extend(self.finished.iter().map(|status| status.id.clone()));
        ids
    }
}

/// What [`RunQueue::stop`] acted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopOutcome {
    /// The active run was signaled to stop — its phase resolves to `Stopped` shortly after (poll
    /// [`RunQueue::state`]).
    Stopped,
    /// A queued-but-not-yet-started run was cancelled outright — it never spawns.
    Cancelled,
    /// `run_id` names neither the active run nor a queued one (already finished, or unknown).
    NotFound,
}

/// Spawns the process behind one [`RunRequest`] — the seam a caller (production wiring, or a
/// test) plugs a provider or test double into. Any `Fn(&RunRequest) -> Result<AgentSession,
/// SessionError> + Send + Sync` (including a bare `fn` item) implements this automatically.
pub trait Spawn: Send + Sync {
    fn spawn(&self, request: &RunRequest) -> Result<AgentSession, SessionError>;
}

impl<F> Spawn for F
where
    F: Fn(&RunRequest) -> Result<AgentSession, SessionError> + Send + Sync,
{
    fn spawn(&self, request: &RunRequest) -> Result<AgentSession, SessionError> {
        self(request)
    }
}

/// A sink for [`RunStatus`] snapshots as a run progresses (FR-X-3: "observable, not a silent
/// spinner") — the seam through which the background thread that owns a run's lifecycle pushes
/// live updates out. `commands::agent::TauriActivityEmitter` is the real implementation, bridging
/// onto `AppHandle::emit` (this app's first event-emission pattern — see the P2a-21 journal entry:
/// prior to this card, nothing anywhere called `emit` on the backend or `listen()` on the
/// frontend). Every other `RunQueue` (every test in this module and `tests/agent_run_queue.rs`,
/// and the D23 `crates/test-driver`'s own instance, which has no Tauri runtime to push through)
/// gets [`NoopEmitter`] — [`RunQueue::state`] still returns the identical data either way, this
/// only controls whether it is also *pushed* as it happens.
///
/// Never called while `RunQueue`'s own lock is held (every call site emits only after its
/// `MutexGuard` has already dropped — see `start`, `drain_and_advance`) — a slow or blocking
/// implementation only ever delays that one run's next push, never a caller of `start`/`stop`/
/// `state` on any run.
pub trait ActivityEmitter: Send + Sync {
    fn emit(&self, status: &RunStatus);
}

/// Receives the exact lifecycle facts the D21 watchdog needs from the queue: the stable run id
/// minted here, its operation targets, every raw stream event, and the terminal edge. The default
/// is inert; the app wires `agent::project::OpenProjectRunObserver` over its TD-17 aggregate.
pub trait RunObserver: Send + Sync {
    fn begin_run(&self, run_id: &str, request: &RunRequest);
    fn observe(&self, run_id: &str, event: &Value);
    fn end_run(&self, run_id: &str);
    /// Revokes pending permission before the child kill can race a decision.
    fn stop_requested(&self, _run_id: &str) {}

    /// Whether this run actually persisted at least one tracked change or comment through the
    /// project's MCP boundary. This is deliberately an outcome, not the provider stream's
    /// `tool_use` announcement: a refused call or wholly-stale proposal lands no card and must not
    /// suppress the agent's only explanation (#1420, FR-X-5). The default keeps bare queue users
    /// prose-only unless their owning project supplies the persistence fact.
    fn delivery_landed(&self, _run_id: &str) -> bool {
        false
    }

    /// Called once, from [`drain_and_advance`], after that run's stream has fully drained and
    /// before [`end_run`](Self::end_run) — carrying the provider session id
    /// `AgentSession::session_id` folded off the stream's `system`/`init` event, and only when the
    /// stream produced one at all. The id is known as soon as that event arrives, which on a long
    /// turn is minutes earlier; announcing it at the drain edge is deliberate, and harmless because
    /// the queue serializes runs, so nothing could consume it sooner. This is the queue's half of
    /// D4 continuity (#1723): `agent::project::OpenProjectRunObserver` persists it as the open
    /// project's next `resume_session_id`, so the *next* spawn can `--resume` the same provider
    /// session instead of every turn cold-starting. The default is inert — a caller with no project
    /// to persist against (a bare `RunQueue` test) needs nothing here.
    fn session_established(&self, _run_id: &str, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

    /// Clears the saved resume identity durably before the one fresh fallback is spawned.
    fn clear_provider_session(&self, _run_id: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The default emitter: does nothing.
pub struct NoopEmitter;

impl ActivityEmitter for NoopEmitter {
    fn emit(&self, _status: &RunStatus) {}
}

pub struct NoopRunObserver;

impl RunObserver for NoopRunObserver {
    fn begin_run(&self, _run_id: &str, _request: &RunRequest) {}
    fn observe(&self, _run_id: &str, _event: &Value) {}
    fn end_run(&self, _run_id: &str) {}
}

struct ActiveRun {
    id: RunId,
    phase: RunPhase,
    /// `None` only when spawning itself failed (`phase` is then already `Failed` and terminal) —
    /// there is no process to kill.
    kill: Option<KillHandle>,
    stop_requested: Arc<AtomicBool>,
    /// The J1 Working-state activity feed accumulated so far, in stream order.
    activity: Vec<ActivityLine>,
    started_at: Instant,
    /// Set once the run resolves to a terminal phase — freezes [`RunStatus::elapsed_secs`] at that
    /// instant rather than letting it keep drifting forward on every later poll.
    finished_at: Option<Instant>,
}

impl ActiveRun {
    fn status(&self) -> RunStatus {
        RunStatus {
            id: self.id.clone(),
            phase: self.phase.clone(),
            activity: self.activity.clone(),
            elapsed_secs: self
                .finished_at
                .unwrap_or_else(Instant::now)
                .saturating_duration_since(self.started_at)
                .as_secs(),
        }
    }
}

struct PendingRun {
    id: RunId,
    request: RunRequest,
}

#[derive(Default)]
struct Inner {
    active: Option<ActiveRun>,
    pending: VecDeque<PendingRun>,
    /// The newest projection of `finished`, updated by the same insertion.
    last_finished: Option<RunStatus>,
    /// Current-project ordered terminal ledger backing polling delivery and startup reconciliation.
    finished: Vec<RunStatus>,
}

/// FR-AGENT-7's run queue. Holds its state behind `Arc`s internally (`spawner`, `emitter`,
/// `inner`) so the background thread each run's `drain_and_advance` runs on can keep updating it
/// after the `#[tauri::command]` call that started it has already returned.
// @anchor:test-plan-run-queue
pub struct RunQueue {
    spawner: Arc<dyn Spawn>,
    emitter: Arc<dyn ActivityEmitter>,
    observer: Arc<dyn RunObserver>,
    inner: Arc<Mutex<Inner>>,
}

impl RunQueue {
    /// A queue that never pushes ([`NoopEmitter`]) — [`state`](Self::state) polling still sees
    /// everything; use [`with_emitter`](Self::with_emitter) to also push live.
    pub fn new(spawner: impl Spawn + 'static) -> RunQueue {
        Self::with_observers(spawner, Arc::new(NoopEmitter), Arc::new(NoopRunObserver))
    }

    pub fn with_emitter(
        spawner: impl Spawn + 'static,
        emitter: Arc<dyn ActivityEmitter>,
    ) -> RunQueue {
        Self::with_observers(spawner, emitter, Arc::new(NoopRunObserver))
    }

    pub fn with_observers(
        spawner: impl Spawn + 'static,
        emitter: Arc<dyn ActivityEmitter>,
        observer: Arc<dyn RunObserver>,
    ) -> RunQueue {
        RunQueue {
            spawner: Arc::new(spawner),
            emitter,
            observer,
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    /// Test-facing convenience wrapper with no production callers. Starts (or queues) a run and
    /// returns its id. Call
    /// [`start_with_queue_position`](Self::start_with_queue_position) when the submitter also needs
    /// the synchronous queued acknowledgement.
    pub fn start(&self, request: RunRequest) -> RunId {
        self.start_with_queue_position(request).id
    }

    /// Start (or queue) a run. Spawns immediately if nothing is active (or the active slot only
    /// holds a past run's terminal outcome); otherwise `request` joins the back of the queue
    /// (FR-AGENT-7). Always returns an acknowledgement — a spawn failure surfaces as that run's
    /// `Failed` phase through [`state`](Self::state), never a rejected call (FR-X-3: async, never
    /// a blocking or silent failure).
    pub fn start_with_queue_position(&self, request: RunRequest) -> StartRunResult {
        self.start_with_reserved_id(new_run_id(), request)
    }

    /// Admit a request whose id already names a persisted Address event. The caller must hold
    /// the comment write lane from that event through this admission so correction cannot land
    /// between them (FR-CMT-10).
    pub(crate) fn start_with_reserved_id(&self, id: RunId, request: RunRequest) -> StartRunResult {
        let mut inner = lock(&self.inner);
        let (spawn_statuses, queued_position) = if active_is_running(&inner) {
            let position = inner.pending.len() + 1;
            inner.pending.push_back(PendingRun {
                id: id.clone(),
                request,
            });
            (Vec::new(), Some(position))
        } else if !inner.pending.is_empty() {
            let position = inner.pending.len() + 1;
            inner.pending.push_back(PendingRun {
                id: id.clone(),
                request,
            });
            (
                spawn_pending_until_running(
                    &self.spawner,
                    &self.emitter,
                    &self.observer,
                    &self.inner,
                    &mut inner,
                ),
                Some(position),
            )
        } else {
            let status = spawn_and_track(
                &self.spawner,
                &self.emitter,
                &self.observer,
                &self.inner,
                &mut inner,
                id.clone(),
                request,
            );
            if status.phase.is_terminal() {
                record_finished(&mut inner, &status);
            }
            (vec![status], None)
        };
        // Emitted only after the guard below drops — never while `inner` is locked (see
        // `ActivityEmitter`'s doc invariant).
        drop(inner);
        for status in spawn_statuses {
            self.emitter.emit(&status);
        }
        StartRunResult {
            id,
            queued_position,
        }
    }

    /// Stop `run_id`. If it's the active, still-running run, signals it to stop and returns
    /// `Stopped` (the phase itself resolves once the background reader observes the kill — poll
    /// [`state`](Self::state)). If it's still queued, removes it outright (`Cancelled`) before it
    /// ever spawns. Otherwise `NotFound` (already finished, or never existed).
    pub fn stop(&self, run_id: &str) -> StopOutcome {
        let mut inner = lock(&self.inner);
        if let Some(active) = &inner.active {
            if active.id == run_id && active.phase == RunPhase::Running {
                active.stop_requested.store(true, Ordering::SeqCst);
                self.observer.stop_requested(run_id);
                if let Some(kill) = &active.kill {
                    // Errors here are never surfaced (mirrors `AgentSession::stop`'s own
                    // already-exited-is-fine contract) — the background reader's finalize step is
                    // the single source of truth for the resulting phase.
                    let _ = kill.kill();
                }
                return StopOutcome::Stopped;
            }
        }
        if let Some(pos) = inner.pending.iter().position(|p| p.id == run_id) {
            inner.pending.remove(pos);
            return StopOutcome::Cancelled;
        }
        StopOutcome::NotFound
    }

    /// The current FR-AGENT-7 picture: the active run (if any) and the queue behind it, in order.
    pub fn state(&self) -> RunQueueState {
        let inner = lock(&self.inner);
        RunQueueState {
            active: inner.active.as_ref().map(ActiveRun::status),
            queued: inner
                .pending
                .iter()
                .enumerate()
                .map(|(i, p)| QueuedRun {
                    id: p.id.clone(),
                    position: i + 1,
                })
                .collect(),
            finished: inner.finished.clone(),
            last_finished: inner.last_finished.clone(),
        }
    }

    /// Runs a project-lifecycle transition only while no run is active.
    ///
    /// The queue lock stays held through `operation`, so [`Self::start`] cannot race between an
    /// idle check and the transition that closes the open project's TD-1 server and D21 watchdog.
    /// A terminal status does not count as active, matching [`Self::start`]. A successful close
    /// clears that terminal active slot and its history before releasing the lock; a failed close
    /// leaves both the project and its run history intact.
    pub(crate) fn run_if_idle<T, E>(
        &self,
        operation: impl FnOnce() -> Result<ProjectTransition<T>, E>,
    ) -> Option<Result<T, E>> {
        let mut inner = lock(&self.inner);
        if active_is_running(&inner) {
            return None;
        }
        let result = match operation() {
            Ok(ProjectTransition::Closed(value)) => {
                debug_assert!(inner.pending.is_empty());
                inner.active = None;
                inner.finished.clear();
                inner.last_finished = None;
                Ok(value)
            }
            Err(error) => Err(error),
        };
        Some(result)
    }
}

fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().expect("run queue mutex is never poisoned")
}

pub(crate) fn new_run_id() -> RunId {
    format!("run-{}", Uuid::new_v4())
}

fn active_is_running(inner: &Inner) -> bool {
    matches!(&inner.active, Some(a) if !a.phase.is_terminal())
}

/// Records one stable run id/outcome exactly once while preserving completion order. Polling
/// clients consume the cumulative ledger, so poll cadence cannot erase an earlier completion.
fn record_finished(inner: &mut Inner, status: &RunStatus) {
    if inner.finished.iter().any(|saved| saved.id == status.id) {
        return;
    }
    inner.finished.push(status.clone());
    inner.last_finished = Some(status.clone());
}

/// Spawn `request` under `id` and install it as `inner.active`. On success, hands the session to a
/// background thread that drains its stream to completion (or death), then finalizes the phase and
/// advances the queue ([`drain_and_advance`]). On failure, records `Failed` directly — there is no
/// process to track. Caller already holds `inner`'s lock; returns the newly active run's status
/// rather than emitting it directly, so every caller can push it to `emitter` only *after* dropping
/// that lock (`ActivityEmitter`'s "never called while the lock is held" invariant — see the call
/// sites in `start` and `drain_and_advance`).
fn spawn_and_track(
    spawner: &Arc<dyn Spawn>,
    emitter: &Arc<dyn ActivityEmitter>,
    observer: &Arc<dyn RunObserver>,
    queue_inner: &Arc<Mutex<Inner>>,
    inner: &mut Inner,
    id: RunId,
    request: RunRequest,
) -> RunStatus {
    observer.begin_run(&id, &request);
    let active = match spawner.spawn(&request) {
        Ok(session) => {
            let kill = session.kill_handle();
            let stop_requested = Arc::new(AtomicBool::new(false));
            let active = ActiveRun {
                id: id.clone(),
                phase: RunPhase::Running,
                kill: Some(kill),
                stop_requested: stop_requested.clone(),
                activity: Vec::new(),
                started_at: Instant::now(),
                finished_at: None,
            };
            let spawner = Arc::clone(spawner);
            let emitter_for_thread = Arc::clone(emitter);
            let observer_for_thread = Arc::clone(observer);
            let queue_inner = Arc::clone(queue_inner);
            std::thread::spawn(move || {
                drain_and_advance(
                    session,
                    id,
                    request,
                    stop_requested,
                    DrainContext {
                        spawner,
                        emitter: emitter_for_thread,
                        observer: observer_for_thread,
                        queue_inner,
                    },
                )
            });
            active
        }
        Err(e) => {
            observer.end_run(&id);
            ActiveRun {
                id,
                phase: RunPhase::Failed {
                    message: e.to_string(),
                },
                kill: None,
                stop_requested: Arc::new(AtomicBool::new(false)),
                activity: Vec::new(),
                started_at: Instant::now(),
                finished_at: Some(Instant::now()),
            }
        }
    };
    let status = active.status();
    inner.active = Some(active);
    status
}

/// Pops pending requests in order until one spawns successfully or none remain. A failed spawn is
/// still installed and returned for emission as that run's honest terminal status (FR-X-3); when
/// another request follows, it is recorded in the terminal ledger before that successor displaces it.
fn spawn_pending_until_running(
    spawner: &Arc<dyn Spawn>,
    emitter: &Arc<dyn ActivityEmitter>,
    observer: &Arc<dyn RunObserver>,
    queue_inner: &Arc<Mutex<Inner>>,
    inner: &mut Inner,
) -> Vec<RunStatus> {
    let mut statuses = Vec::new();
    while let Some(next) = inner.pending.pop_front() {
        let status = spawn_and_track(
            spawner,
            emitter,
            observer,
            queue_inner,
            inner,
            next.id,
            next.request,
        );
        let spawn_failed = status.phase.is_terminal();
        statuses.push(status.clone());
        if spawn_failed {
            record_finished(inner, &status);
        }
        if !spawn_failed || inner.pending.is_empty() {
            break;
        }
    }
    statuses
}

/// Drains `session`'s stream to end-of-stream (or a read error) — pushing `emitter` an updated
/// [`RunStatus`] every time a line carries a new J1 activity-feed entry — decides the terminal
/// [`RunPhase`] (`Stopped { delivered }` iff a stop was requested, `delivered` from
/// [`AgentSession::saw_delivery`]; else `Failed`, or `Completed { reply }` carrying
/// [`AgentSession::reply`] — but only for a run that landed no delivery, per
/// [`RunObserver::delivery_landed`] and `RunPhase::Completed`'s own docs), records it against `id`
/// if it's still the active run (pushing one final `emitter` update), and, if something is
/// waiting, immediately starts the next queued run.
struct DrainContext {
    spawner: Arc<dyn Spawn>,
    emitter: Arc<dyn ActivityEmitter>,
    observer: Arc<dyn RunObserver>,
    queue_inner: Arc<Mutex<Inner>>,
}

fn drain_and_advance(
    mut session: AgentSession,
    id: RunId,
    request: RunRequest,
    stop_requested: Arc<AtomicBool>,
    context: DrainContext,
) {
    let DrainContext {
        spawner,
        emitter,
        observer,
        queue_inner,
    } = context;
    let drain_session = |session: &mut AgentSession| loop {
        match session.next_event() {
            Ok(Some(event)) => {
                observer.observe(&id, &event.value);
                if event.activity.is_empty() {
                    // No new feed line (a bootstrap/telemetry/result event, `agent::activity`) —
                    // nothing changed worth a push.
                    continue;
                }
                let mut inner = lock(&queue_inner);
                let status = match &mut inner.active {
                    Some(active) if active.id == id => {
                        active.activity.extend(event.activity);
                        Some(active.status())
                    }
                    // No longer the active run (a race with a concurrent `stop`/advance) — nothing
                    // left to push against.
                    _ => None,
                };
                drop(inner);
                if let Some(status) = status {
                    emitter.emit(&status);
                }
            }
            Ok(None) => break None,
            Err(e) => break Some(e.to_string()),
        }
    };
    let mut read_error = drain_session(&mut session);
    // All three captured before `stop()` consumes `session`: `delivered` is the one signal this
    // layer has for J7's "nothing applied" vs. "partial delivery" distinction
    // (`RunPhase::Stopped`'s own docs) — `saw_delivery`, not `saw_propose_changes`, so a stop after
    // a filed comment reports honestly too (#1404: a comment is as durable on the TD-4 sidecar as a
    // change set is on the document, and reporting "nothing applied" over it was the same dishonest
    // stop card J7's two-outcome split exists to prevent, FR-X-5) — and `reply` is the agent's
    // answer for the turn — kept only for a run that landed no delivery, so the answer never
    // doubles as a second, competing report of a change set or comment the timeline is already
    // showing (`RunPhase::Completed`'s own docs, CJ's ruling on #1118).
    let mut delivered = session.saw_delivery();
    let mut delivery_landed = observer.delivery_landed(&id);
    let mut reply = session
        .reply()
        .filter(|_| !delivery_landed)
        .map(str::to_string);
    let resume_rejected = session.resume_rejected();
    let mut provider_error = session.provider_error().map(str::to_string);
    // Announce the provider session id (if the stream ever produced one) before `end_run` — D4
    // continuity (#1723): whatever this turn established, resumed or fresh, is what the *next*
    // spawn should try to resume, regardless of how this one's own phase resolves below. The CLI's
    // own session persistence is disk-based and outside this call's phase (spike1
    // §"Session resume"), so gating this on `Completed` only would silently drop continuity for
    // every stopped or failed turn for no evidenced reason — a killed mid-turn process's session
    // being resumable is confirmed by execution against the real `claude` CLI (PR #1791 review,
    // 2026-08-20): a headless run killed after `system/init` resumes cleanly by its captured id.
    // A *stale/expired* id measures differently: the CLI emits one `error_during_execution` result
    // with no `system/init`, so `session_id()` returns `None` and `session_established` is never
    // called. The positively classified result below clears the dead identity and retries once
    // without it (#1790).
    if let Some(session_id) = session.session_id() {
        if let Err(error) = observer.session_established(&id, session_id) {
            provider_error = Some(error);
        }
    }
    // Reap the child now that its stream is drained (mirrors `AgentSession::stop`'s own
    // wait-for-exit contract) and retain an unsuccessful process exit as failure evidence. The
    // dedicated stderr reader has drained concurrently with stdout, so collecting it here cannot
    // recreate the full-pipe deadlock #2395 fixes.
    let mut process_error = match session.reap() {
        Ok(exit) => exit.failure_message(),
        Err(error) => Some(format!("reaping agent process: {error}")),
    };

    // A provider can reject an expired resume identity as a cleanly drained result. Recovery is
    // intentionally narrower than generic failure handling: only the positively classified stale
    // resume, before any announced or persisted delivery, clears durable identity and receives one
    // fresh spawn for this same run/request. The fallback itself is never resume-eligible, so a
    // second failure cannot recurse.
    let mut recovered = false;
    if !stop_requested.load(Ordering::SeqCst)
        && read_error.is_none()
        && resume_rejected
        && !delivered
        && !delivery_landed
    {
        match observer.clear_provider_session(&id) {
            Err(error) => provider_error = Some(error),
            Ok(()) => match spawner.spawn(&request) {
                Err(error) => provider_error = Some(error.to_string()),
                Ok(mut fresh) => {
                    let fresh_kill = fresh.kill_handle();
                    {
                        let mut inner = lock(&queue_inner);
                        if let Some(active) = &mut inner.active {
                            if active.id == id {
                                active.kill = Some(fresh_kill.clone());
                            }
                        }
                    }
                    if stop_requested.load(Ordering::SeqCst) {
                        let _ = fresh_kill.kill();
                    }
                    read_error = drain_session(&mut fresh);
                    recovered = fresh.completed_successfully();
                    delivered |= fresh.saw_delivery();
                    delivery_landed = observer.delivery_landed(&id);
                    reply = fresh
                        .reply()
                        .filter(|_| !delivery_landed)
                        .map(str::to_string);
                    provider_error = fresh.provider_error().map(str::to_string);
                    if read_error.is_none() && provider_error.is_none() && !recovered {
                        provider_error = Some(
                            "fresh provider session ended before a successful result".to_string(),
                        );
                    }
                    if let Some(session_id) = fresh.session_id() {
                        if let Err(error) = observer.session_established(&id, session_id) {
                            provider_error = Some(error);
                        }
                    }
                    process_error = match fresh.reap() {
                        Ok(exit) => exit.failure_message(),
                        Err(error) => Some(format!("reaping agent process: {error}")),
                    };
                }
            },
        }
    }
    observer.end_run(&id);

    let phase = if stop_requested.load(Ordering::SeqCst) {
        RunPhase::Stopped { delivered }
    } else if let Some(message) = read_error {
        RunPhase::Failed { message }
    } else if let Some(message) = provider_error {
        RunPhase::Failed { message }
    } else if let Some(message) = process_error {
        RunPhase::Failed { message }
    } else if recovered {
        RunPhase::Recovered { reply }
    } else {
        RunPhase::Completed { reply }
    };

    let mut inner = lock(&queue_inner);
    let is_still_active = matches!(&inner.active, Some(active) if active.id == id);
    let mut final_status = None;
    if is_still_active {
        if let Some(active) = &mut inner.active {
            active.phase = phase;
            active.finished_at = Some(Instant::now());
        }
        let status = inner.active.as_ref().expect("just set above").status();
        // Recorded unconditionally (not only when a next run is about to overwrite `active`) so
        // the ordered ledger contains every terminal, including the final run in a batch.
        record_finished(&mut inner, &status);
        final_status = Some(status);
    }
    let spawn_statuses =
        spawn_pending_until_running(&spawner, &emitter, &observer, &queue_inner, &mut inner);
    // Every push waits until here — after `inner` drops — so none can hold the lock open for a
    // slow `emitter` (`ActivityEmitter`'s doc invariant).
    drop(inner);
    if let Some(status) = final_status {
        emitter.emit(&status);
    }
    for status in spawn_statuses {
        emitter.emit(&status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::Duration;

    /// A spawner that never actually spawns a process — every `start` resolves synchronously to
    /// `Failed`. Exercises the queue's pure bookkeeping (nothing here needs a real child).
    fn always_fails(_request: &RunRequest) -> Result<AgentSession, SessionError> {
        Err(SessionError::Spawn(io::Error::other(
            "no such provider in this test",
        )))
    }

    fn queue_with_a_spawner_that_always_fails() -> RunQueue {
        RunQueue::new(always_fails as fn(&RunRequest) -> _)
    }

    fn request() -> RunRequest {
        RunRequest {
            project_root: "/tmp/project".into(),
            prompt: "draft something".to_string(),
            operation_targets: Vec::new(),
        }
    }

    /// The exact wire spelling `src/timeline/agentActivity.ts`'s `RunPhase` union mirrors by hand
    /// (#1118). Every frontend test builds its own `RunStatus` literals against that mirror, so
    /// nothing over there can catch this enum's `Serialize` drifting away from it — a renamed field
    /// or a dropped `null` would leave both suites green and the timeline silent again, which is
    /// the whole defect. Only an assertion on the real derive closes that.
    #[test]
    fn a_completed_phase_serializes_with_its_reply_on_the_wire() {
        assert_eq!(
            serde_json::to_value(RunPhase::Completed {
                reply: Some("Answered.".to_string())
            })
            .unwrap(),
            serde_json::json!({ "phase": "completed", "reply": "Answered." })
        );
        assert_eq!(
            serde_json::to_value(RunPhase::Completed { reply: None }).unwrap(),
            serde_json::json!({ "phase": "completed", "reply": null }),
            "an answerless run still carries the field, as `reply: string | null` expects"
        );
    }

    #[test]
    fn a_fresh_queue_reports_no_active_run_and_an_empty_queue() {
        let queue = queue_with_a_spawner_that_always_fails();
        let state = queue.state();
        assert!(state.active.is_none());
        assert!(state.queued.is_empty());
    }

    // --- RunQueueState::known_run_ids (issue #1381 startup reconciliation) --------

    fn status(id: &str, phase: RunPhase) -> RunStatus {
        RunStatus {
            id: id.to_string(),
            phase,
            activity: Vec::new(),
            elapsed_secs: 0,
        }
    }

    #[test]
    fn known_run_ids_includes_the_active_id_every_queued_id_and_last_finished() {
        let state = RunQueueState {
            active: Some(status("run-1", RunPhase::Running)),
            queued: vec![QueuedRun {
                id: "run-2".to_string(),
                position: 1,
            }],
            finished: vec![status("run-0", RunPhase::Completed { reply: None })],
            last_finished: Some(status("run-0", RunPhase::Completed { reply: None })),
        };
        let known = state.known_run_ids();
        assert!(known.contains("run-1"));
        assert!(known.contains("run-2"));
        assert!(known.contains("run-0"));
        assert_eq!(known.len(), 3);
    }

    /// The case narrowing this method from an earlier "still running" definition exists to fix
    /// (#1381 review, against the real D23 driver): a run that has resolved (stopped, failed, or
    /// completed) but still occupies `active` is **still known** — its own trailing per-thread
    /// events (a batch's `link_changes`/defense `reply` for a target other than the one that just
    /// resolved) may still be landing, so reconciliation must not race ahead of them.
    #[test]
    fn known_run_ids_includes_a_terminal_active_run() {
        for phase in [
            RunPhase::Stopped { delivered: false },
            RunPhase::Failed {
                message: "crashed".to_string(),
            },
            RunPhase::Completed { reply: None },
        ] {
            let state = RunQueueState {
                active: Some(status("run-1", phase)),
                queued: Vec::new(),
                finished: Vec::new(),
                last_finished: None,
            };
            assert!(state.known_run_ids().contains("run-1"));
        }
    }

    #[test]
    fn live_run_ids_include_running_and_queued_but_exclude_terminal_history() {
        let state = RunQueueState {
            active: Some(status("run-a", RunPhase::Running)),
            queued: vec![QueuedRun {
                id: "run-b".into(),
                position: 1,
            }],
            finished: vec![status("run-old", RunPhase::Completed { reply: None })],
            last_finished: Some(status("run-old", RunPhase::Completed { reply: None })),
        };
        assert_eq!(
            state.live_run_ids(),
            HashSet::from(["run-a".into(), "run-b".into()])
        );
        let terminal = RunQueueState {
            active: Some(status("run-a", RunPhase::Stopped { delivered: false })),
            queued: Vec::new(),
            finished: Vec::new(),
            last_finished: None,
        };
        assert!(terminal.live_run_ids().is_empty());
    }

    #[test]
    fn delivered_comment_stays_uncorrectable_through_the_real_queue_sampler_until_terminal() {
        use crate::commands::comments;

        let project = tempfile::TempDir::new().unwrap();
        std::fs::write(project.path().join("doc.md"), "Hello world").unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let id = comments::create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "original".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        comments::address_with_ai(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "alice".into(),
            2,
            "run-live".into(),
            None,
        )
        .unwrap();
        comments::reply_comment(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "agent".into(),
            "defense".into(),
            true,
            false,
            3,
        )
        .unwrap();
        let queue = queue_with_a_spawner_that_always_fails();
        let mut active = active_run_finished_this_long_ago(1, 0);
        active.id = "run-live".into();
        active.phase = RunPhase::Running;
        active.finished_at = None;
        lock(&queue.inner).active = Some(active);

        assert!(matches!(
            comments::revise_comment_on(
                &queue,
                root.clone(),
                "doc.md".into(),
                id.clone(),
                "alice".into(),
                "too soon".into(),
                4,
            ),
            Err(comments::CommandError::CorrectionRefused(_))
        ));
        lock(&queue.inner).active.as_mut().unwrap().phase = RunPhase::Completed { reply: None };
        let revised = comments::revise_comment_on(
            &queue,
            root,
            "doc.md".into(),
            id,
            "alice".into(),
            "safe now".into(),
            5,
        )
        .unwrap();
        assert_eq!(revised[0].body, "safe now");
    }

    /// A fresh process's queue starts with nothing active, queued, or finished — every `pending_run`
    /// any document carries into it is therefore unknown by construction (the "restart" half of
    /// #1381's last exit row).
    #[test]
    fn known_run_ids_is_empty_on_a_fresh_queue_state() {
        assert!(RunQueueState::default().known_run_ids().is_empty());
    }

    #[test]
    fn starting_when_idle_attempts_to_spawn_immediately() {
        let queue = queue_with_a_spawner_that_always_fails();
        let id = queue.start(request());
        let state = queue.state();
        let active = state.active.expect("a spawn attempt was made");
        assert_eq!(active.id, id);
        assert!(matches!(active.phase, RunPhase::Failed { .. }));
    }

    #[test]
    fn a_terminal_active_slot_does_not_block_the_next_start() {
        // The first attempt fails immediately (terminal, not Running) — a second `start` must
        // still spawn right away rather than queuing behind a run that's already over.
        let queue = queue_with_a_spawner_that_always_fails();
        let first = queue.start(request());
        let second = queue.start(request());

        assert_ne!(first, second);
        let state = queue.state();
        assert_eq!(state.active.unwrap().id, second);
        assert!(
            state.queued.is_empty(),
            "nothing was ever actually running, so nothing queues"
        );
    }

    #[test]
    fn a_terminal_active_slot_with_pending_work_does_not_let_a_new_start_overtake_it() {
        let spawned_prompts = Arc::new(Mutex::new(Vec::new()));
        let prompts_for_spawner = Arc::clone(&spawned_prompts);
        let queue = RunQueue::new(move |request: &RunRequest| {
            prompts_for_spawner
                .lock()
                .expect("spawned prompts mutex is never poisoned")
                .push(request.prompt.clone());
            always_fails(request)
        });
        queue.start(request());
        lock(&queue.inner).pending.push_back(PendingRun {
            id: "older-pending".to_string(),
            request: RunRequest {
                project_root: "/tmp/project".into(),
                prompt: "older".to_string(),
                operation_targets: Vec::new(),
            },
        });

        let result = queue.start_with_queue_position(RunRequest {
            project_root: "/tmp/project".into(),
            prompt: "later".to_string(),
            operation_targets: Vec::new(),
        });

        assert_eq!(result.queued_position, Some(2));
        assert_eq!(
            *spawned_prompts
                .lock()
                .expect("spawned prompts mutex is never poisoned"),
            vec!["draft something", "older", "later"]
        );
        assert!(lock(&queue.inner).pending.is_empty());
    }

    #[test]
    fn an_idle_transition_holds_the_queue_lock_until_the_transition_finishes() {
        let queue = queue_with_a_spawner_that_always_fails();

        let result = queue.run_if_idle(|| {
            assert!(matches!(
                queue.inner.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            Ok::<_, ()>(ProjectTransition::Closed("transition complete"))
        });

        assert_eq!(result, Some(Ok("transition complete")));
    }

    #[test]
    fn an_active_run_blocks_the_close_transition_without_invoking_it() {
        let queue = queue_with_a_spawner_that_always_fails();
        lock(&queue.inner).active = Some(ActiveRun {
            id: "run-active".to_string(),
            phase: RunPhase::Running,
            kill: None,
            stop_requested: Arc::new(AtomicBool::new(false)),
            activity: Vec::new(),
            started_at: Instant::now(),
            finished_at: None,
        });
        let transition_ran = AtomicBool::new(false);

        let result = queue.run_if_idle(|| {
            transition_ran.store(true, Ordering::SeqCst);
            Ok::<_, ()>(ProjectTransition::Closed(()))
        });

        assert_eq!(result, None);
        assert!(!transition_ran.load(Ordering::SeqCst));
    }

    #[test]
    fn a_successful_close_transition_clears_the_projects_terminal_history() {
        let queue = queue_with_a_spawner_that_always_fails();
        queue.start(request());
        assert_eq!(queue.state().finished.len(), 1);

        assert_eq!(
            queue.run_if_idle(|| Ok::<_, ()>(ProjectTransition::Closed(()))),
            Some(Ok(()))
        );

        let state = queue.state();
        assert!(state.active.is_none());
        assert!(state.finished.is_empty());
        assert!(state.last_finished.is_none());
    }

    #[test]
    fn a_failed_project_transition_retains_the_current_projects_terminal_history() {
        let queue = queue_with_a_spawner_that_always_fails();
        let id = queue.start(request());

        assert_eq!(
            queue.run_if_idle(|| Err::<ProjectTransition<()>, _>("bind failed")),
            Some(Err("bind failed"))
        );

        let state = queue.state();
        assert_eq!(state.active.as_ref().map(|status| &status.id), Some(&id));
        assert_eq!(state.finished.len(), 1);
        assert_eq!(
            state.last_finished.as_ref().map(|status| &status.id),
            Some(&id)
        );
    }

    #[test]
    fn recording_the_same_terminal_twice_keeps_one_stable_outcome() {
        let terminal = status(
            "run-1",
            RunPhase::Failed {
                message: "first outcome".to_string(),
            },
        );
        let mut inner = Inner::default();
        record_finished(&mut inner, &terminal);
        record_finished(
            &mut inner,
            &status("run-1", RunPhase::Stopped { delivered: false }),
        );

        assert_eq!(inner.finished.len(), 1);
        assert!(matches!(inner.finished[0].phase, RunPhase::Failed { .. }));
        assert!(matches!(
            inner.last_finished.as_ref().map(|saved| &saved.phase),
            Some(RunPhase::Failed { .. })
        ));
    }

    #[test]
    fn stopping_an_unknown_run_id_is_not_found() {
        let queue = queue_with_a_spawner_that_always_fails();
        assert_eq!(queue.stop("run-does-not-exist"), StopOutcome::NotFound);
    }

    #[test]
    fn stopping_a_run_that_already_finished_is_not_found_not_stopped() {
        // `Failed` (like `Completed`/`Stopped`) is terminal — `stop` must not report `Stopped` for
        // a run that isn't actually running anymore.
        let queue = queue_with_a_spawner_that_always_fails();
        let id = queue.start(request());
        assert_eq!(queue.stop(&id), StopOutcome::NotFound);
    }

    #[test]
    fn a_freshly_spawned_run_carries_no_activity_and_a_computable_elapsed_reading() {
        let queue = queue_with_a_spawner_that_always_fails();
        let id = queue.start(request());
        let active = queue.state().active.expect("a spawn attempt was made");
        assert_eq!(active.id, id);
        assert!(active.activity.is_empty());
    }

    /// Builds an [`ActiveRun`] with `started_at`/`finished_at` placed relative to *real* now via
    /// plain `Instant` arithmetic (`Instant` supports `+`/`-` with `Duration` without needing an
    /// injected clock) — lets a test plant a run whose whole lifetime is already deep in the past
    /// without a sleep or a wall-clock race.
    fn active_run_finished_this_long_ago(total_secs: u64, finished_after_secs: u64) -> ActiveRun {
        let started_at = Instant::now() - Duration::from_secs(total_secs);
        ActiveRun {
            id: "run-fixture".to_string(),
            phase: RunPhase::Completed { reply: None },
            kill: None,
            stop_requested: Arc::new(AtomicBool::new(false)),
            activity: Vec::new(),
            started_at,
            finished_at: Some(started_at + Duration::from_secs(finished_after_secs)),
        }
    }

    /// FR-X-3 / `RunStatus::elapsed_secs`'s own doc: once a run resolves, its reading is frozen at
    /// `finished_at`, not the live wall clock. Review finding (PR #477 round 1): the prior
    /// integration-level version of this property (`elapsed_secs_is_present_while_running_and_
    /// frozen_once_terminal`) polled `state()` twice in a row, so it passed even with the freeze
    /// mechanism deleted outright (`last_finished` is a snapshot, never recomputed on read —
    /// the two reads were equal *by construction*, not because anything was actually frozen).
    /// This version can fail on that mutation: `started_at` is planted 100s in the past but
    /// `finished_at` only 5s after it, so a `status()` that (wrongly) measured against `Instant::
    /// now()` instead of `finished_at` would read ~100s here, not 5.
    #[test]
    fn elapsed_secs_is_frozen_at_finished_at_not_the_live_wall_clock() {
        let long_finished = active_run_finished_this_long_ago(100, 5);
        assert_eq!(long_finished.status().elapsed_secs, 5);
    }

    /// The mirror case: a run still running (`finished_at: None`) reads elapsed against the live
    /// wall clock, so the *same* `started_at` used above reads the full 100s here — proving the
    /// two `ActiveRun`s above genuinely diverge on how `elapsed_secs` is computed, not just on
    /// what value happens to be stored.
    #[test]
    fn elapsed_secs_tracks_the_live_wall_clock_while_still_running() {
        let mut still_running = active_run_finished_this_long_ago(100, 5);
        still_running.finished_at = None;
        assert_eq!(still_running.status().elapsed_secs, 100);
    }

    /// A recording [`ActivityEmitter`] — captures every pushed [`RunStatus`] in order, kept
    /// observable via a shared `Arc` (the queue itself owns the trait object).
    #[derive(Default)]
    struct RecordingEmitter(Mutex<Vec<RunStatus>>);

    impl RecordingEmitter {
        fn statuses(&self) -> Vec<RunStatus> {
            self.0
                .lock()
                .expect("recording emitter mutex is never poisoned")
                .clone()
        }
    }

    impl ActivityEmitter for RecordingEmitter {
        fn emit(&self, status: &RunStatus) {
            self.0
                .lock()
                .expect("recording emitter mutex is never poisoned")
                .push(status.clone());
        }
    }

    #[test]
    fn a_spawn_failure_still_pushes_the_failed_status_to_the_emitter() {
        let emitter = Arc::new(RecordingEmitter::default());
        let queue = RunQueue::with_emitter(
            always_fails as fn(&RunRequest) -> _,
            Arc::clone(&emitter) as Arc<dyn ActivityEmitter>,
        );

        let id = queue.start(request());

        let statuses = emitter.statuses();
        assert_eq!(
            statuses.len(),
            1,
            "exactly one push: the synchronous spawn failure"
        );
        assert_eq!(statuses[0].id, id);
        assert!(matches!(statuses[0].phase, RunPhase::Failed { .. }));
        assert!(statuses[0].activity.is_empty());
    }

    #[test]
    fn a_queue_with_no_emitter_given_never_pushes_anything() {
        // `RunQueue::new` defaults to `NoopEmitter` — this is really a compile-time proof (the
        // existing spawn-failure tests above already exercise `new` without an emitter) that
        // omitting one is not an error; documented here as its own test for discoverability.
        let queue = queue_with_a_spawner_that_always_fails();
        let id = queue.start(request());
        assert!(queue.state().active.is_some_and(|a| a.id == id));
    }
}
