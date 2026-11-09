// ABOUTME: Protection watchdog (D21, FR-AGENT-2/5, TD §3.5 finding M11) — live protected paths,
// ABOUTME: TD-18 path rekey, attribution precedence, and raw-write detect-and-convert.

//! The D21 protection watchdog. A protected document (open tabs ∪ operation targets — review sets
//! arrive at M4) only ever receives agent changes as tracked changes via the MCP contract
//! (`agent::state::propose_changes`). This module is the FR-AGENT-5 *fallback* for the case that
//! rule is broken directly on disk: an agent that writes a protected doc itself instead of calling
//! `propose_changes`.
//!
//! On an external write to a protected doc the watchdog decides **attribution precedence** (finding
//! M11):
//!
//! - **Positive attribution** — the write is correlated with the agent's own streamed file-write
//!   events (a `Write`/`Edit`/`MultiEdit` tool call naming the same doc in-flight, TD-5). The raw
//!   overwrite is converted to *proposed* tracked changes, atomically, attributed to the agent
//!   ([`WriteOutcome::Converted`]). The document is never left with partial or untracked markup
//!   (FR-AGENT-6).
//! - **Unattributable** — no correlated stream event (an external editor, a `git checkout`, an
//!   autosave race). The write is **never** auto-converted; it surfaces the FR-ED-7 external-change
//!   signal ([`WriteOutcome::ExternalChange`]) for the banner P2a-21 owns. *Never convert on a
//!   guess.*
//!
//! What lives here is the detection + the never-convert-on-a-guess decision + the conversion. The
//! FS-watch that turns raw disk events into [`Watchdog::on_write`] calls is [`DocWatcher`]; the
//! banner UI is P2a-21's.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use textops::{Anchor, Document, Edit, Representability};
use uuid::Uuid;

use crate::commands::path_confine::{confine, identity_relative, ConfineError};
use crate::project_files::{
    is_event_path_visible, NativeEventSink, NativeRenameMode, NormalizedEvent, NormalizedEventKind,
};
use crate::store::atomic;
use crate::store::changes::{self, ChangeRecord, ChangeType};
use crate::store::service::{SidecarError, SidecarStore};

/// Identifies one in-flight agent run (a provider session). Its target docs stay protected for the
/// run's whole lifetime — even if their tab closes mid-run (D21) — and its streamed file-write
/// announcements are the correlation source for attribution precedence.
pub type RunId = String;

/// The live D21 protected set: the union of open tabs, current operation targets, docs pinned by
/// in-flight runs, and temporary reconciliation holds for announced writes. Pure membership
/// bookkeeping — no I/O — so it is exhaustively testable.
///
/// Run pinning is what makes protection *survive tab-close mid-run* (D21, FR-AGENT-2): a doc a run
/// targets stays protected until [`unpin_run`](Self::unpin_run), regardless of whether its tab is
/// still open.
#[derive(Debug, Default)]
pub struct ProtectedSet {
    tabs: BTreeSet<String>,
    operation_targets: BTreeSet<String>,
    run_pins: HashMap<RunId, BTreeSet<String>>,
    reconciliations: BTreeSet<String>,
}

impl ProtectedSet {
    pub fn new() -> ProtectedSet {
        ProtectedSet::default()
    }

    pub fn open_tab(&mut self, doc: &str) {
        self.tabs.insert(doc.to_string());
    }

    pub fn close_tab(&mut self, doc: &str) {
        self.tabs.remove(doc);
    }

    fn tabs(&self) -> BTreeSet<String> {
        self.tabs.clone()
    }

    pub fn add_operation_target(&mut self, doc: &str) {
        self.operation_targets.insert(doc.to_string());
    }

    pub fn remove_operation_target(&mut self, doc: &str) {
        self.operation_targets.remove(doc);
    }

    /// Pin `docs` as protected for the lifetime of `run` (D21). Adds to whatever the run already
    /// pins rather than replacing it.
    pub fn pin_run(&mut self, run: &str, docs: &[String]) {
        let pins = self.run_pins.entry(run.to_string()).or_default();
        pins.extend(docs.iter().cloned());
    }

    /// Drop a finished run's pins. A doc it pinned only stays protected if a tab or operation
    /// target still holds it.
    pub fn unpin_run(&mut self, run: &str) {
        self.run_pins.remove(run);
    }

    /// Whether `doc` is currently protected by a live source or a terminal-reconciliation hold.
    pub fn is_protected(&self, doc: &str) -> bool {
        self.tabs.contains(doc)
            || self.operation_targets.contains(doc)
            || self.run_pins.values().any(|pins| pins.contains(doc))
            || self.reconciliations.contains(doc)
    }

    fn is_protected_without_reconciliation(&self, doc: &str) -> bool {
        self.tabs.contains(doc)
            || self.operation_targets.contains(doc)
            || self.run_pins.values().any(|pins| pins.contains(doc))
    }

    fn retain_for_reconciliation(&mut self, doc: &str) {
        self.reconciliations.insert(doc.to_string());
    }

    fn release_reconciliation(&mut self, doc: &str) {
        self.reconciliations.remove(doc);
    }

    /// Every currently protected doc, deduplicated and sorted — the exact set an FS watch should
    /// subscribe to.
    pub fn members(&self) -> BTreeSet<String> {
        let mut all = self.tabs.clone();
        all.extend(self.operation_targets.iter().cloned());
        for pins in self.run_pins.values() {
            all.extend(pins.iter().cloned());
        }
        all.extend(self.reconciliations.iter().cloned());
        all
    }

    fn rekey_path(&mut self, old_path: &str, new_path: &str) {
        rekey_member(&mut self.tabs, old_path, new_path);
        rekey_member(&mut self.operation_targets, old_path, new_path);
        for pins in self.run_pins.values_mut() {
            rekey_member(pins, old_path, new_path);
        }
    }
}

fn rekey_member(paths: &mut BTreeSet<String>, old_path: &str, new_path: &str) {
    if paths.remove(old_path) {
        paths.insert(new_path.to_string());
    }
}

/// A [`ProtectedSet`] shared between whatever mutates it live — tab open/close, run pin/unpin, i.e.
/// the live open-tab set and the active run's operation targets (D21/FR-AGENT-2) — and any other
/// consumer that only needs to read current membership, e.g. the MCP tool boundary's protection
/// reporting (`agent::state::McpContext::with_shared_protection`). One `Arc<Mutex<_>>` is the single
/// source of truth, so the watchdog's own enforcement and the tool boundary's reporting can never
/// drift into disagreeing about the same live tabs/run (issue #414: "the union is genuinely a
/// union" — there is exactly one union, computed once, read everywhere).
pub type SharedProtectedSet = Arc<Mutex<ProtectedSet>>;

/// A live native filesystem watch for one open project (TD-17). It watches the project root through
/// the platform's `notify` backend, but filters every event through the watchdog's current protected
/// set before doing any I/O — the watched *membership* remains exactly D21's dynamic union even
/// though one stable recursive OS subscription avoids racy unwatch/rewatch churn as tabs and run
/// targets change.
///
/// **It is also the sole native subscription for TD-18.** Rather than open a second recursive
/// `notify` watch for `project_files/`, this one watcher normalizes each event once and fans it to
/// both consumers: the D21 watchdog above, and the [`NativeEventSink`] that coalesces project-tree
/// refreshes. The two see the same evidence from the same OS notification, so they can never
/// disagree about what the disk did.
///
/// Dropping the value stops the native subscription and joins its worker before the containing
/// [`OpenProject`](crate::agent::project::OpenProject) finishes closing.
pub struct DocWatcher {
    watcher: Option<RecommendedWatcher>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl DocWatcher {
    pub fn watch(
        root: impl AsRef<Path>,
        watchdog: Arc<Mutex<Watchdog>>,
        native_events: Arc<dyn NativeEventSink>,
    ) -> notify::Result<DocWatcher> {
        let root = root
            .as_ref()
            .canonicalize()
            .unwrap_or_else(|_| root.as_ref().to_path_buf());
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx)?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let worker = std::thread::spawn(move || {
            for result in rx {
                let event = match result {
                    Ok(event) => event,
                    Err(error) => {
                        eprintln!("Emend document watchdog notification failed: {error}");
                        continue;
                    }
                };
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                let docs: Vec<String> = event
                    .paths
                    .iter()
                    .filter_map(|path| path.strip_prefix(&root).ok())
                    .map(|relative| {
                        crate::commands::path_confine::canonical_relative(
                            &relative.to_string_lossy(),
                        )
                    })
                    .collect();
                for doc in &docs {
                    let mut watchdog = watchdog
                        .lock()
                        .expect("document watchdog mutex is never poisoned");
                    if !watchdog.is_protected(doc) {
                        continue;
                    }
                    if let Err(error) = watchdog.on_native_write(doc) {
                        eprintln!("Emend document watchdog could not inspect {doc}: {error}");
                    }
                }
                if let Some(normalized) = normalized_event(&event, docs) {
                    native_events.observe(normalized);
                }
            }
        });

        Ok(DocWatcher {
            watcher: Some(watcher),
            worker: Some(worker),
        })
    }
}

/// The `notify` event, reduced to the backend-neutral evidence TD-18 reconciles over: whether this
/// was a rename-class notification (and which side, where the backend says), which project-relative
/// paths it named, and any backend correlation tracker.
///
/// Returns `None` when nothing about the event can change what a snapshot shows — every path was
/// outside the root or inside hidden tooling structure — so a `.emend/` sidecar write Emend
/// itself performs never schedules a refresh.
///
/// `docs` is the caller's already-computed project-relative spelling of `event.paths`, in the same
/// order, so one event is normalized exactly once for both consumers.
fn normalized_event(event: &notify::Event, mut docs: Vec<String>) -> Option<NormalizedEvent> {
    docs.retain(|doc| is_event_path_visible(doc));
    if docs.is_empty() {
        return None;
    }
    Some(NormalizedEvent {
        kind: normalized_kind(event.kind),
        paths: docs,
        tracker: event.tracker(),
    })
}

/// Rename classification, preserved exactly as the shipped backends report it (TD-18): macOS
/// FSEvents cannot associate the two sides and reports one-path `Any`; Windows reports separate
/// tracker-less `From`/`To`. A rename whose specific kind the backend knows but cannot express
/// (`Other`) still carries no side information, so it normalizes to `Any` rather than being dropped
/// — the reconciler needs the *fact* of a rename, and unique stable identity supplies the pairing.
fn normalized_kind(kind: EventKind) -> NormalizedEventKind {
    match kind {
        EventKind::Modify(ModifyKind::Name(mode)) => NormalizedEventKind::Rename(match mode {
            RenameMode::From => NativeRenameMode::From,
            RenameMode::To => NativeRenameMode::To,
            RenameMode::Both => NativeRenameMode::Both,
            RenameMode::Any | RenameMode::Other => NativeRenameMode::Any,
        }),
        _ => NormalizedEventKind::Other,
    }
}

impl Drop for DocWatcher {
    fn drop(&mut self) {
        drop(self.watcher.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// The attribution verdict for a detected write to a protected doc (finding M11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attribution {
    /// Positively attributed to the agent: a correlated in-flight `Write`/`Edit`/`MultiEdit`
    /// stream event named this doc. The FR-AGENT-5 convert-to-tracked-changes path.
    Agent,
    /// Unattributable — no correlated stream event (external editor, git checkout, autosave race).
    /// Surfaces the FR-ED-7 banner; never converted on a guess.
    External,
}

/// The file paths named by an agent's file-write tool calls in one stream event (TD-5). `Write`,
/// `Edit`, and `MultiEdit` `tool_use` blocks carry the `file_path` they target — the correlation
/// source for attribution precedence. Non-`assistant` events and non-write tool calls contribute
/// none. Paths are returned exactly as the provider stream carried them. Real providers may report
/// absolute, filesystem-canonicalized paths; [`Watchdog::observe`] confines and normalizes them to
/// the project-relative identity vocabulary before they enter the attribution ledger.
pub fn announced_write_targets(event: &Value) -> Vec<String> {
    if event.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    event["message"]["content"]
        .as_array()
        .map(|blocks| blocks.iter().filter_map(write_target).collect())
        .unwrap_or_default()
}

fn write_target(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    match block.get("name").and_then(Value::as_str) {
        Some("Write" | "Edit" | "MultiEdit") => block["input"]
            .get("file_path")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// The in-flight record of which docs each run has announced a write to (TD-5). A detected write is
/// positively attributed to the agent only if some in-flight run announced a write to that same doc
/// — and the announcement is *consumed* on match, so one announced write attributes exactly one
/// detected write. A run's announcements are dropped when it ends, so they can never mis-attribute
/// an external write that lands after the run.
#[derive(Debug, Default)]
struct AttributionLedger {
    /// Runs whose event streams can still provide attribution for an already-observed disk write.
    active_runs: BTreeSet<RunId>,
    /// run → the still-unmatched write targets it announced (a multiset, order-independent).
    announced: HashMap<RunId, Vec<String>>,
}

impl AttributionLedger {
    fn new() -> AttributionLedger {
        AttributionLedger::default()
    }

    fn begin_run(&mut self, run: &str) {
        self.active_runs.insert(run.to_string());
    }

    /// Record the already-confined, project-relative write targets announced by `run`. Events for
    /// a run this watchdog never accepted are ignored: a run against another project must never
    /// contribute attribution to the currently-open project's ledger.
    fn observe(&mut self, run: &str, targets: Vec<String>) {
        if !self.active_runs.contains(run) {
            return;
        }
        if targets.is_empty() {
            return;
        }
        self.announced
            .entry(run.to_string())
            .or_default()
            .extend(targets);
    }

    fn is_active(&self, run: &str) -> bool {
        self.active_runs.contains(run)
    }

    /// Attribute a detected write to `doc`. If any in-flight run announced a write to `doc`,
    /// consume one such announcement and return [`Attribution::Agent`]; otherwise
    /// [`Attribution::External`] (never convert on a guess).
    fn attribute(&mut self, doc: &str) -> Attribution {
        for targets in self.announced.values_mut() {
            if let Some(pos) = targets.iter().position(|t| t == doc) {
                targets.remove(pos);
                return Attribution::Agent;
            }
        }
        Attribution::External
    }

    fn end_run(&mut self, run: &str) {
        self.active_runs.remove(run);
        self.announced.remove(run);
    }

    fn has_active_runs(&self) -> bool {
        !self.active_runs.is_empty()
    }

    fn has_outstanding_announcement(&self, doc: &str) -> bool {
        self.announced
            .values()
            .any(|targets| targets.iter().any(|target| target == doc))
    }
}

/// What a detected write to a protected doc resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The doc is not in the protected set — outside the watchdog's concern.
    Unprotected,
    /// The on-disk content matches the tracked baseline: no external change to act on (typically
    /// the echo of Emend's own atomic write).
    Unchanged,
    /// Positive attribution (finding M11): the raw write was converted to tracked changes,
    /// attributed to the agent, atomically (FR-AGENT-5, FR-AGENT-6).
    Converted {
        change_set_id: String,
        change_ids: Vec<String>,
    },
    /// Unattributable — or not cleanly representable as round-tripping CriticMarkup — so surfaced
    /// as an FR-ED-7 external change, never auto-converted (finding M11). P2a-21 renders the banner.
    ExternalChange,
    /// A native disk notification arrived while a run was still live. The terminal scan retries it
    /// after the child exits, so conversion cannot capture a truncate-before-replacement window.
    AwaitingRunCompletion,
}

/// Why a watchdog operation could not complete.
#[derive(Debug)]
pub enum WatchdogError {
    /// A doc path was refused by path confinement (§3.5).
    Confinement(ConfineError),
    /// Reading or atomically writing the document failed.
    Io(String),
    /// A sidecar attribution write failed.
    Sidecar(String),
}

impl std::fmt::Display for WatchdogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WatchdogError::Confinement(e) => write!(f, "{e}"),
            WatchdogError::Io(msg) => write!(f, "{msg}"),
            WatchdogError::Sidecar(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for WatchdogError {}

impl From<ConfineError> for WatchdogError {
    fn from(e: ConfineError) -> WatchdogError {
        WatchdogError::Confinement(e)
    }
}

impl From<SidecarError> for WatchdogError {
    fn from(e: SidecarError) -> WatchdogError {
        WatchdogError::Sidecar(e.to_string())
    }
}

/// One project's protection watchdog. Owns a [`SharedProtectedSet`] (shared so this watchdog's own
/// enforcement and the MCP tool boundary's protection reporting read exactly one live union, issue
/// #414), a per-doc *baseline* (the last content Emend considers canonical — what a detected write
/// is diffed against), the in-flight [`AttributionLedger`], and the sidecar store the converted
/// changes are attributed to.
///
/// The baseline for a doc is snapshotted from disk when it *enters* the protected set and updated
/// to the delivered markup after a conversion. It is forgotten once the doc leaves the set, except
/// while an outstanding run announcement still needs that original baseline for reconciliation.
pub struct Watchdog {
    root: PathBuf,
    store: SidecarStore,
    protected: SharedProtectedSet,
    baselines: HashMap<String, String>,
    ledger: AttributionLedger,
}

impl Watchdog {
    /// A watchdog with its own private, freshly empty protected set. Use
    /// [`with_protected_set`](Self::with_protected_set) instead when another consumer (e.g. an
    /// `McpContext`) needs to observe the exact same live membership.
    pub fn new(root: impl Into<PathBuf>) -> Watchdog {
        Watchdog::with_protected_set(root, Arc::new(Mutex::new(ProtectedSet::new())))
    }

    /// Like [`new`](Self::new), but sharing an existing [`SharedProtectedSet`] rather than starting
    /// a private one — the constructor a live app uses so this watchdog's enforcement and an
    /// `McpContext`'s protection reporting (`agent::state::McpContext::with_shared_protection`)
    /// consult exactly the same membership, fed by the same tab-open/close and run begin/end calls
    /// (issue #414).
    pub fn with_protected_set(root: impl Into<PathBuf>, protected: SharedProtectedSet) -> Watchdog {
        let root = root.into();
        let store = SidecarStore::new(root.clone());
        Watchdog {
            root,
            store,
            protected,
            baselines: HashMap::new(),
            ledger: AttributionLedger::new(),
        }
    }

    /// A clone of this watchdog's live protected set — hand to
    /// `McpContext::with_shared_protection` (or any other reader) so it observes every tab
    /// open/close and run pin/unpin this watchdog makes, live, with no restart and no second copy
    /// to keep in sync (issue #414).
    pub fn protected_set(&self) -> SharedProtectedSet {
        Arc::clone(&self.protected)
    }

    fn protected_lock(&self) -> MutexGuard<'_, ProtectedSet> {
        self.protected
            .lock()
            .expect("protected set mutex is never poisoned")
    }

    // --- the live D21 protected set (acceptance 1) ---------------------------------------------

    /// A doc opened in a tab joins the protected set (D21). Its current on-disk content becomes the
    /// baseline if it wasn't already protected.
    pub fn open_tab(&mut self, doc: &str) {
        let fresh = {
            let mut protected = self.protected_lock();
            let fresh = !protected.is_protected(doc);
            protected.open_tab(doc);
            protected.release_reconciliation(doc);
            fresh
        };
        if fresh {
            self.refresh_baseline(doc);
        }
    }

    /// A closed tab drops out of the protected set unless a run still pins it (D21) or an
    /// outstanding write announcement needs its protection identity through terminal reconciliation.
    pub fn close_tab(&mut self, doc: &str) {
        self.protected_lock().close_tab(doc);
        self.forget_if_unprotected(doc);
    }

    /// Replaces the complete live tab source with `docs`. The frontend reports the whole set from
    /// one state transition, so a missed/delayed individual close cannot leave a stale protection
    /// entry behind. Run pins and operation targets are untouched: this replaces one source of the
    /// D21 union, not the union itself.
    pub fn set_open_tabs(&mut self, docs: &[String]) {
        let next: BTreeSet<String> = docs.iter().cloned().collect();
        let current = self.protected_lock().tabs();
        for doc in next.difference(&current) {
            self.open_tab(doc);
        }
        for doc in current.difference(&next) {
            self.close_tab(doc);
        }
    }

    /// A doc named as the target of the current agent operation joins the protected set (D21).
    pub fn add_operation_target(&mut self, doc: &str) {
        let fresh = {
            let mut protected = self.protected_lock();
            let fresh = !protected.is_protected(doc);
            protected.add_operation_target(doc);
            protected.release_reconciliation(doc);
            fresh
        };
        if fresh {
            self.refresh_baseline(doc);
        }
    }

    pub fn remove_operation_target(&mut self, doc: &str) {
        self.protected_lock().remove_operation_target(doc);
        self.forget_if_unprotected(doc);
    }

    // --- in-flight runs (D21 pinning + TD-5 correlation) ---------------------------------------

    /// Begin an agent run whose `targets` are pinned protected for its lifetime — even if their tab
    /// closes mid-run (D21). Newly-protected targets are baselined from disk.
    pub fn begin_run(&mut self, run: &str, targets: &[String]) {
        self.ledger.begin_run(run);
        let fresh_targets: Vec<String> = targets
            .iter()
            .filter(|doc| !self.is_protected(doc))
            .cloned()
            .collect();
        for doc in &fresh_targets {
            self.refresh_baseline(doc);
        }
        self.protected_lock().pin_run(run, targets);
    }

    /// Fold one of `run`'s stream events into the attribution ledger (the correlation source for
    /// [`on_write`](Self::on_write)). Provider paths are confined and normalized here, before they
    /// can become attribution evidence.
    ///
    /// Events from a run this watchdog never accepted are ignored. In production that means a run
    /// whose project root did not match the open project cannot contribute attribution to it.
    pub fn observe(&mut self, run: &str, event: &Value) {
        if !self.ledger.is_active(run) {
            return;
        }
        let targets: Vec<String> = announced_write_targets(event)
            .into_iter()
            .filter_map(|target| self.normalize_announced_target(&target))
            .collect();
        self.ledger.observe(run, targets);
    }

    /// End a run: drop its protection pins and unmatched write announcements, then release any
    /// tab-only protection retained for terminal reconciliation. A run this watchdog never accepted
    /// is a no-op, symmetric with [`observe`](Self::observe).
    pub fn end_run(&mut self, run: &str) {
        if !self.ledger.is_active(run) {
            return;
        }
        let cleanup: BTreeSet<String> = {
            let mut protected = self.protected_lock();
            let mut cleanup = protected.run_pins.get(run).cloned().unwrap_or_default();
            cleanup.extend(protected.reconciliations.iter().cloned());
            protected.unpin_run(run);
            cleanup
        };
        self.ledger.end_run(run);
        for doc in cleanup {
            self.forget_if_unprotected(&doc);
        }
    }

    /// Whether `run` successfully began against this watchdog's open project. The production
    /// observer checks this before its terminal reconciliation scan, so an unrelated run cannot
    /// cause side effects in the current project's watchdog merely by ending.
    pub fn is_run_active(&self, run: &str) -> bool {
        self.ledger.is_active(run)
    }

    pub fn is_protected(&self, doc: &str) -> bool {
        self.protected_lock().is_protected(doc)
    }

    /// The exact set of docs the watchdog is protecting — what an FS watch subscribes to.
    pub fn watched_paths(&self) -> BTreeSet<String> {
        self.protected_lock().members()
    }

    /// Moves live document state to one confidently reconciled path after durable `docs.json`
    /// history rekeying succeeds and before snapshot publication. Unconsumed write announcements
    /// remain path-scoped: an external rename cannot transfer agent attribution to the new path.
    pub fn rekey_path(&mut self, old_path: &str, new_path: &str) {
        self.protected_lock().rekey_path(old_path, new_path);
        if let Some(baseline) = self.baselines.remove(old_path) {
            self.baselines.insert(new_path.to_string(), baseline);
        }
    }

    // --- detect-and-convert (acceptance 2, 3, 4) -----------------------------------------------

    /// Handle a detected write to `doc`. Reads its current on-disk content, and:
    ///
    /// - if `doc` isn't protected → [`WriteOutcome::Unprotected`] (ignored);
    /// - if the content still matches the baseline → [`WriteOutcome::Unchanged`];
    /// - else decides attribution precedence (finding M11): a write positively attributed to the
    ///   agent is **converted** to tracked changes ([`WriteOutcome::Converted`]); an unattributable
    ///   write is surfaced as an [`WriteOutcome::ExternalChange`], never converted on a guess.
    pub fn on_write(&mut self, doc: &str) -> Result<WriteOutcome, WatchdogError> {
        self.on_write_with_attribution_grace(doc, false)
    }

    /// The native-watcher form of [`on_write`](Self::on_write). Every changed write is deferred
    /// while a run remains live: a provider can announce a Write before its truncate-and-replace
    /// sequence finishes, so only the terminal scan may consume attribution and convert bytes.
    fn on_native_write(&mut self, doc: &str) -> Result<WriteOutcome, WatchdogError> {
        self.on_write_with_attribution_grace(doc, true)
    }

    fn on_write_with_attribution_grace(
        &mut self,
        doc: &str,
        defer_to_terminal_scan: bool,
    ) -> Result<WriteOutcome, WatchdogError> {
        if !self.is_protected(doc) {
            return Ok(WriteOutcome::Unprotected);
        }
        let confined = confine(&self.root, doc)?;
        let raw_new = match fs::read_to_string(&confined) {
            Ok(text) => text,
            // A protected doc deleted out from under us is an external change, not a conversion
            // (there is nothing positively-attributable to convert into tracked changes).
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(WriteOutcome::ExternalChange)
            }
            Err(e) => return Err(WatchdogError::Io(e.to_string())),
        };

        let base = self.baselines.get(doc).cloned().unwrap_or_default();
        if raw_new == base {
            return Ok(WriteOutcome::Unchanged);
        }

        if defer_to_terminal_scan && self.ledger.has_active_runs() {
            return Ok(WriteOutcome::AwaitingRunCompletion);
        }

        match self.ledger.attribute(doc) {
            Attribution::Agent => self.convert(doc, &confined, &base, &raw_new),
            Attribution::External => {
                // Native backends may emit several notifications for one write. Surface it once,
                // then advance the disk baseline so duplicates are `Unchanged` and a later agent
                // write cannot claim this already-observed external/app autosave as its own diff.
                self.baselines.insert(doc.to_string(), raw_new);
                Ok(WriteOutcome::ExternalChange)
            }
        }
    }

    /// Convert a positively-attributed raw write into proposed tracked changes (FR-AGENT-5). The
    /// difference between the known-good `base` and the agent's raw `new_text` is rendered as
    /// CriticMarkup — so the write lands as tracked changes to accept/reject, never a silent
    /// overwrite — attributed to the agent and delivered atomically (FR-AGENT-6).
    fn convert(
        &mut self,
        doc: &str,
        confined: &Path,
        base: &str,
        new_text: &str,
    ) -> Result<WriteOutcome, WatchdogError> {
        let edits: Vec<Edit> = textops::diff(base, new_text)
            .iter()
            .map(|e| e.as_edit())
            .collect();

        // All-or-none (FR-AGENT-6): if any part of the diff can't be represented as
        // round-tripping CriticMarkup (a collision with markup already in `base`), we do not write
        // partial/untracked markup — surface it as an external change instead of converting a
        // fraction of it.
        let verdicts = textops::validate(base, &edits);
        if verdicts
            .iter()
            .any(|v| !matches!(v, Representability::Representable))
        {
            return Ok(WriteOutcome::ExternalChange);
        }

        let rendered = textops::render(base, &edits);
        if rendered.markers.is_empty() {
            // The diff was all no-ops (e.g. only a trailing-newline normalization textops folds
            // away) — nothing to track. Treat as unchanged rather than write an empty delivery.
            return Ok(WriteOutcome::Unchanged);
        }

        let new_doc = Document::new(rendered.text.clone());
        let now = changes::now_millis();
        let change_set_id = format!("cs-{}", Uuid::new_v4());
        let mut records = Vec::with_capacity(rendered.markers.len());
        let mut change_ids = Vec::with_capacity(rendered.markers.len());
        for marker in &rendered.markers {
            let id = format!("chg-{}", Uuid::new_v4());
            records.push(ChangeRecord {
                schema_version: changes::SCHEMA_VERSION,
                id: id.clone(),
                kind: ChangeType::from(marker.kind),
                author: changes::AGENT_AUTHOR.to_string(),
                anchor: Anchor::new(&new_doc, marker.span.start, marker.span.len()),
                created_at: now,
                updated_at: now,
                group: None,
                change_set: Some(change_set_id.clone()),
                note: None,
            });
            change_ids.push(id);
        }

        // Atomic delivery (FR-AGENT-6), mirroring `propose_changes`: attribution batch first, then
        // the source of truth via a single atomic rename — no observable partial/untracked state.
        let doc_id = self.store.get_or_mint_for_path(doc)?;
        self.store.append_change_records(doc_id, &records)?;
        atomic::write(confined, rendered.text.as_bytes())
            .map_err(|e| WatchdogError::Io(e.to_string()))?;

        // The delivered markup is now the known-good baseline; a later write diffs against it.
        self.baselines.insert(doc.to_string(), rendered.text);

        Ok(WriteOutcome::Converted {
            change_set_id,
            change_ids,
        })
    }

    /// Snapshot `doc`'s current on-disk content as its baseline (overwriting any prior one). A doc
    /// that doesn't exist on disk yet has no baseline (a first write is then wholly an insertion).
    pub(crate) fn refresh_baseline(&mut self, doc: &str) {
        let Ok(confined) = confine(&self.root, doc) else {
            return;
        };
        match fs::read_to_string(&confined) {
            Ok(text) => self.refresh_baseline_to(doc, text),
            Err(_) => {
                self.baselines.remove(doc);
            }
        }
    }

    /// Seeds `doc` from bytes already known to have landed rather than rereading disk. The save
    /// command uses this while holding the watchdog lock so a later agent write cannot enter the
    /// baseline in the rename-to-refresh window (FR-AGENT-5).
    pub(crate) fn refresh_baseline_to(&mut self, doc: &str, text: String) {
        if confine(&self.root, doc).is_ok() {
            self.baselines.insert(doc.to_string(), text);
        }
    }

    fn forget_if_unprotected(&mut self, doc: &str) {
        let outstanding = self.ledger.has_outstanding_announcement(doc);
        let forget_baseline = {
            let mut protected = self.protected_lock();
            if protected.is_protected_without_reconciliation(doc) {
                return;
            }
            if outstanding {
                protected.retain_for_reconciliation(doc);
                false
            } else {
                protected.release_reconciliation(doc);
                true
            }
        };
        if forget_baseline {
            self.baselines.remove(doc);
        }
    }

    /// Turn a provider-announced path into the same project-relative filesystem identity used by
    /// tabs, operation targets, native watch events, and sidecars. Relative paths ride the normal
    /// IPC/tool confinement pipeline. Absolute paths — the spelling real Claude Code emits — are
    /// canonicalized (including the root, e.g. macOS `/var` → `/private/var`) and admitted only
    /// when they resolve beneath this project. Invalid/out-of-project paths contribute no
    /// attribution: never convert on a guess.
    fn normalize_announced_target(&self, target: &str) -> Option<String> {
        let target_path = Path::new(target);
        let confined = if target_path.is_absolute() {
            let root = self.root.canonicalize().ok()?;
            let resolved = canonicalize_with_missing_tail(target_path).ok()?;
            if !resolved.starts_with(&root) {
                return None;
            }
            resolved
        } else {
            confine(&self.root, target).ok()?
        };
        identity_relative(&self.root, &confined).ok()
    }
}

/// Canonicalize an absolute provider path even when its final write target does not exist yet.
/// The deepest existing ancestor supplies the filesystem identity (symlinks, case, `/var`
/// spelling); the missing tail is then reattached. The caller still must prove the result is under
/// the canonical project root before using it.
fn canonicalize_with_missing_tail(path: &Path) -> io::Result<PathBuf> {
    let mut ancestor = path;
    let mut missing = Vec::new();
    while !ancestor.exists() {
        let name = ancestor.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "path has no existing ancestor")
        })?;
        missing.push(name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "path has no existing ancestor")
        })?;
    }
    let mut resolved = ancestor.canonicalize()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[cfg(test)]
mod protected_set_tests {
    use super::*;

    #[test]
    fn an_open_tab_is_protected_and_closing_it_releases_protection() {
        let mut set = ProtectedSet::new();
        assert!(!set.is_protected("a.md"));
        set.open_tab("a.md");
        assert!(set.is_protected("a.md"));
        set.close_tab("a.md");
        assert!(!set.is_protected("a.md"));
    }

    #[test]
    fn an_operation_target_is_protected_independently_of_tabs() {
        let mut set = ProtectedSet::new();
        set.add_operation_target("op.md");
        assert!(set.is_protected("op.md"));
        set.remove_operation_target("op.md");
        assert!(!set.is_protected("op.md"));
    }

    #[test]
    fn protection_survives_tab_close_while_a_run_pins_the_doc() {
        // D21 / FR-AGENT-2: a doc a run targets stays protected even if its tab closes mid-run.
        let mut set = ProtectedSet::new();
        set.open_tab("draft.md");
        set.pin_run("run-1", &["draft.md".to_string()]);
        set.close_tab("draft.md");
        assert!(
            set.is_protected("draft.md"),
            "the run pin still protects it"
        );
        set.unpin_run("run-1");
        assert!(
            !set.is_protected("draft.md"),
            "run over and tab closed → released"
        );
    }

    #[test]
    fn members_is_the_deduplicated_union_of_every_source() {
        let mut set = ProtectedSet::new();
        set.open_tab("a.md");
        set.add_operation_target("b.md");
        set.pin_run("run-1", &["a.md".to_string(), "c.md".to_string()]); // a.md overlaps the tab
        let members: Vec<String> = set.members().into_iter().collect();
        assert_eq!(members, vec!["a.md", "b.md", "c.md"]);
    }

    #[test]
    fn a_proven_move_rekeys_tabs_operation_targets_and_every_run_pin() {
        let mut set = ProtectedSet::new();
        set.open_tab("draft.md");
        set.add_operation_target("draft.md");
        set.pin_run("run-1", &["draft.md".to_string()]);
        set.pin_run("run-2", &["draft.md".to_string()]);

        set.rekey_path("draft.md", "archive/draft.md");

        assert!(!set.is_protected("draft.md"));
        assert!(set.is_protected("archive/draft.md"));
        assert_eq!(
            set.run_pins.get("run-1").unwrap(),
            &BTreeSet::from(["archive/draft.md".to_string()])
        );
        assert_eq!(
            set.run_pins.get("run-2").unwrap(),
            &BTreeSet::from(["archive/draft.md".to_string()])
        );
    }
}

#[cfg(test)]
mod shared_protection_tests {
    // Issue #414: a `SharedProtectedSet` is the single live union a watchdog and any other reader
    // (the MCP tool boundary, `agent::state::McpContext`) consult — never two independently-fed
    // copies that could drift.
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_reader_holding_the_shared_set_observes_a_tab_opened_on_the_watchdog_live() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("draft.md"), "hello\n").unwrap();
        let mut watchdog = Watchdog::new(dir.path());
        let reader = watchdog.protected_set();

        assert!(!reader.lock().unwrap().is_protected("draft.md"));
        watchdog.open_tab("draft.md");
        // No restart, no re-fetch of a snapshot — the same handle now reports it protected.
        assert!(reader.lock().unwrap().is_protected("draft.md"));

        watchdog.close_tab("draft.md");
        assert!(!reader.lock().unwrap().is_protected("draft.md"));
    }

    #[test]
    fn two_watchdogs_built_over_the_same_shared_set_agree_on_operation_targets() {
        // `with_protected_set` is how a second consumer (or, in a real app, the same live set the
        // MCP tool boundary reads) shares one union with the watchdog that mutates it.
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("op.md"), "x\n").unwrap();
        let shared = Arc::new(Mutex::new(ProtectedSet::new()));
        let mut writer = Watchdog::with_protected_set(dir.path(), Arc::clone(&shared));
        let reader = Watchdog::with_protected_set(dir.path(), Arc::clone(&shared));

        assert!(!reader.is_protected("op.md"));
        writer.add_operation_target("op.md");
        assert!(
            reader.is_protected("op.md"),
            "the reader shares the writer's live set"
        );
    }

    #[test]
    fn a_run_pinned_target_that_was_never_a_tab_is_still_protected_the_union_is_genuine() {
        // Acceptance 3 (#414): a document that is an operation target but not an open tab is still
        // protected — the permissive half (an untargeted, unopened file staying direct-writable) is
        // exercised alongside it so a wrong implementation (e.g. "protected ⇒ must be a tab") can't
        // hide.
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("targeted.md"), "x\n").unwrap();
        std::fs::write(dir.path().join("untouched.md"), "y\n").unwrap();
        let mut watchdog = Watchdog::new(dir.path());
        let reader = watchdog.protected_set();

        watchdog.begin_run("run-1", &["targeted.md".to_string()]);

        assert!(reader.lock().unwrap().is_protected("targeted.md"));
        assert!(!reader.lock().unwrap().is_protected("untouched.md"));
    }
}

#[cfg(test)]
mod attribution_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn announced_write_targets_reads_write_edit_and_multiedit_file_paths() {
        for tool in ["Write", "Edit", "MultiEdit"] {
            let event = json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "name": tool, "input": { "file_path": "notes.md" } }
                ] }
            });
            assert_eq!(
                announced_write_targets(&event),
                vec!["notes.md".to_string()]
            );
        }
    }

    #[test]
    fn announced_write_targets_ignores_non_write_tools_and_non_assistant_events() {
        let read = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "notes.md" } }
            ] }
        });
        assert!(announced_write_targets(&read).is_empty());

        let result = json!({ "type": "result", "subtype": "success" });
        assert!(announced_write_targets(&result).is_empty());
    }

    #[test]
    fn an_announced_write_positively_attributes_a_matching_doc_once() {
        let mut ledger = AttributionLedger::new();
        ledger.begin_run("run-1");
        ledger.observe("run-1", vec!["draft.md".to_string()]);
        // First detected write to draft.md is the agent's; the announcement is then consumed.
        assert_eq!(ledger.attribute("draft.md"), Attribution::Agent);
        assert_eq!(ledger.attribute("draft.md"), Attribution::External);
    }

    #[test]
    fn a_write_with_no_correlated_announcement_is_external() {
        let mut ledger = AttributionLedger::new();
        ledger.begin_run("run-1");
        ledger.observe("run-1", vec!["draft.md".to_string()]);
        // A different doc was never announced — unattributable (finding M11).
        assert_eq!(ledger.attribute("other.md"), Attribution::External);
    }

    #[test]
    fn a_run_that_never_began_cannot_announce_attribution() {
        let mut ledger = AttributionLedger::new();
        ledger.observe("rejected-run", vec!["draft.md".to_string()]);

        assert_eq!(ledger.attribute("draft.md"), Attribution::External);
    }

    #[test]
    fn ending_a_run_drops_its_unmatched_announcements() {
        let mut ledger = AttributionLedger::new();
        ledger.begin_run("run-1");
        ledger.observe("run-1", vec!["draft.md".to_string()]);
        ledger.end_run("run-1");
        // The run is over; a later write to that doc can no longer be attributed to it.
        assert_eq!(ledger.attribute("draft.md"), Attribution::External);
    }

    #[test]
    fn an_unaccepted_runs_announcements_never_enter_the_ledger() {
        let mut ledger = AttributionLedger::new();
        ledger.begin_run("open-project-run");
        ledger.observe("other-project-run", vec!["draft.md".to_string()]);

        assert_eq!(ledger.attribute("draft.md"), Attribution::External);
        assert!(ledger.is_active("open-project-run"));
    }
}

#[cfg(test)]
mod watchdog_tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn project(path: &str, contents: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(path), contents).unwrap();
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    fn write_event(file_path: &str) -> Value {
        json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Write", "input": { "file_path": file_path } }
            ] }
        })
    }

    fn read(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap()
    }

    /// The TD-18 half of the fanout, recorded rather than refreshed, so a `DocWatcher` test can
    /// assert exactly what the second consumer received from one real OS notification.
    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<NormalizedEvent>>,
    }

    impl RecordingSink {
        fn saw(&self, path: &str) -> bool {
            self.events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event.paths.iter().any(|seen| seen == path))
        }
    }

    impl NativeEventSink for RecordingSink {
        fn observe(&self, event: NormalizedEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[test]
    fn every_shipped_rename_shape_survives_normalization_and_other_kinds_do_not_claim_one() {
        // macOS FSEvents emits one-path `Any`; Windows emits separate tracker-less `From`/`To`
        // (TD-18). A backend that knows a rename happened but cannot name the side (`Other`) still
        // carries the rename *fact*, which is the evidence reconciliation needs.
        for (mode, expected) in [
            (RenameMode::Any, NativeRenameMode::Any),
            (RenameMode::From, NativeRenameMode::From),
            (RenameMode::To, NativeRenameMode::To),
            (RenameMode::Both, NativeRenameMode::Both),
            (RenameMode::Other, NativeRenameMode::Any),
        ] {
            assert_eq!(
                normalized_kind(EventKind::Modify(ModifyKind::Name(mode))),
                NormalizedEventKind::Rename(expected)
            );
        }

        assert_eq!(
            normalized_kind(EventKind::Create(notify::event::CreateKind::File)),
            NormalizedEventKind::Other
        );
        assert_eq!(
            normalized_kind(EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            NormalizedEventKind::Other
        );
    }

    #[test]
    fn a_normalized_event_carries_the_visible_paths_and_the_backends_tracker() {
        let mut event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)));
        event.attrs.set_tracker(7);

        let normalized = normalized_event(
            &event,
            vec!["notes/draft.md".to_string(), ".git/index".to_string()],
        )
        .expect("a visible path remains");

        assert_eq!(normalized.paths, vec!["notes/draft.md".to_string()]);
        assert_eq!(normalized.tracker, Some(7));
        assert_eq!(
            normalized.kind,
            NormalizedEventKind::Rename(NativeRenameMode::From)
        );
    }

    /// Emend writes `.emend/` itself on every tracked change it lands. Scheduling a project-tree
    /// refresh for that would be pure churn, and no hidden path can change what a snapshot shows.
    #[test]
    fn an_event_confined_to_hidden_structure_schedules_nothing() {
        assert!(normalized_event(
            &notify::Event::new(EventKind::Modify(ModifyKind::Any)),
            vec![".emend/docs.json".to_string(), "node_modules".to_string()],
        )
        .is_none());
        assert!(normalized_event(
            &notify::Event::new(EventKind::Modify(ModifyKind::Any)),
            Vec::new(),
        )
        .is_none());
    }

    /// TD-18's central structural claim: **one** root-recursive subscription, two consumers. A
    /// single real OS notification must reach the D21 watchdog *and* the project-files sink.
    #[test]
    fn one_real_native_notification_reaches_both_the_watchdog_and_the_project_files_sink() {
        let replacement = "after\n";
        let (_dir, root) = project("draft.md", "before\n");
        let watchdog = Arc::new(Mutex::new(Watchdog::new(root.clone())));
        watchdog.lock().unwrap().open_tab("draft.md");
        let sink = Arc::new(RecordingSink::default());
        let _watcher =
            DocWatcher::watch(&root, Arc::clone(&watchdog), Arc::clone(&sink) as Arc<_>).unwrap();

        fs::write(root.join("draft.md"), replacement).unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let watchdog_saw = watchdog
                .lock()
                .unwrap()
                .baselines
                .get("draft.md")
                .is_some_and(|baseline| baseline == replacement);
            if watchdog_saw && sink.saw("draft.md") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for one native notification to reach both consumers"
            );
            std::thread::yield_now();
        }
    }

    /// The rename classification is the one claim in the fanout whose truth lives in the `notify`
    /// backend rather than in our own code, and the tests above drive it from *constructed* events.
    /// This one renames a real file and asserts the shipped backend's own notification still reaches
    /// the sink as rename-class evidence — without which TD-18's reconciler can never correlate a
    /// move, however good its identity matching is. Which side the backend names is deliberately not
    /// asserted: macOS reports one-path `Any` and Windows separate `From`/`To`, and TD-18 requires
    /// exactly that both are accepted.
    #[test]
    fn a_real_rename_reaches_the_project_files_sink_as_rename_class_evidence() {
        let (_dir, root) = project("draft.md", "before\n");
        let watchdog = Arc::new(Mutex::new(Watchdog::new(root.clone())));
        let sink = Arc::new(RecordingSink::default());
        let _watcher =
            DocWatcher::watch(&root, Arc::clone(&watchdog), Arc::clone(&sink) as Arc<_>).unwrap();

        fs::rename(root.join("draft.md"), root.join("renamed.md")).unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let renamed = sink.events.lock().unwrap().iter().any(|event| {
                matches!(event.kind, NormalizedEventKind::Rename(_))
                    && event
                        .paths
                        .iter()
                        .any(|path| path == "draft.md" || path == "renamed.md")
            });
            if renamed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for a real rename to arrive as rename-class evidence"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn a_write_to_an_unprotected_doc_is_ignored() {
        let (_dir, root) = project("free.md", "anything\n");
        let mut wd = Watchdog::new(root);
        // Never protected — the watchdog leaves it alone (all other files are direct-writable).
        assert_eq!(wd.on_write("free.md").unwrap(), WriteOutcome::Unprotected);
    }

    #[test]
    fn a_write_matching_the_baseline_is_unchanged() {
        let (_dir, root) = project("draft.md", "hello\n");
        let mut wd = Watchdog::new(root);
        wd.open_tab("draft.md");
        // No disk change since the tab opened.
        assert_eq!(wd.on_write("draft.md").unwrap(), WriteOutcome::Unchanged);
    }

    #[test]
    fn a_positively_attributed_raw_write_converts_to_a_tracked_change() {
        // FR-AGENT-5 fallback: the agent wrote a protected doc directly, but announced the write
        // in its stream — attribution precedence converts it to a tracked change (finding M11).
        let base = "hello world\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));

        // The agent's raw overwrite lands on disk (bypassing propose_changes).
        fs::write(root.join("draft.md"), "hello brave world\n").unwrap();

        let outcome = wd.on_write("draft.md").unwrap();
        let WriteOutcome::Converted { change_ids, .. } = &outcome else {
            panic!("expected a conversion, got {outcome:?}");
        };
        assert_eq!(change_ids.len(), 1);

        // The doc now carries the change as CriticMarkup — proposed, not silently applied.
        assert_eq!(read(&root, "draft.md"), "hello {++brave ++}world\n");

        // Attribution folded into the sidecar, authored to the agent (TD-4).
        let store = SidecarStore::new(&root);
        let id = store.doc_id_for_path("draft.md").unwrap().unwrap();
        let fold = store.fold_changes(id).unwrap();
        assert_eq!(fold.changes.len(), 1);
        let change = fold.changes.values().next().unwrap();
        assert_eq!(change.author, changes::AGENT_AUTHOR);
        assert_eq!(change.kind, ChangeType::Insertion);
    }

    #[test]
    fn an_external_move_does_not_rekey_unconsumed_write_attribution() {
        let (_dir, root) = project("draft.md", "hello world\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));

        fs::rename(root.join("draft.md"), root.join("renamed.md")).unwrap();
        wd.rekey_path("draft.md", "renamed.md");
        fs::write(root.join("renamed.md"), "user edit\n").unwrap();

        assert_eq!(
            wd.on_write("renamed.md").unwrap(),
            WriteOutcome::ExternalChange
        );
        assert_eq!(read(&root, "renamed.md"), "user edit\n");
    }

    #[test]
    fn an_absolute_provider_path_is_normalized_to_the_project_relative_identity() {
        // Real Claude Code reports canonical absolute Write paths. Give the watchdog a deliberately
        // non-canonical root spelling to prove both sides converge before attribution.
        let base = "hello world\n";
        let (_dir, root) = project("draft.md", base);
        fs::create_dir(root.join("sub")).unwrap();
        let respelled_root = root.join("sub").join("..");
        let absolute = root.join("draft.md").canonicalize().unwrap();
        let mut wd = Watchdog::new(respelled_root);
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);

        wd.observe("run-1", &write_event(&absolute.to_string_lossy()));

        fs::write(root.join("draft.md"), "hello brave world\n").unwrap();
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));
    }

    #[test]
    fn an_absolute_provider_path_outside_the_project_is_not_attribution_evidence() {
        let (_dir, root) = project("draft.md", "hello\n");
        let outside = TempDir::new().unwrap();
        let outside_doc = outside.path().join("draft.md");
        fs::write(&outside_doc, "elsewhere\n").unwrap();
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);

        wd.observe("run-1", &write_event(&outside_doc.to_string_lossy()));
        fs::write(root.join("draft.md"), "after\n").unwrap();
        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn events_and_end_for_a_run_the_open_project_never_accepted_are_no_ops() {
        let (_dir, root) = project("draft.md", "before\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("open-project-run", &["draft.md".to_string()]);

        wd.observe("other-project-run", &write_event("draft.md"));
        wd.end_run("other-project-run");
        assert!(wd.is_run_active("open-project-run"));

        fs::write(root.join("draft.md"), "after\n").unwrap();
        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn an_unattributable_raw_write_is_surfaced_never_converted() {
        // Negative path (finding M11): an external editor / git checkout wrote the protected doc,
        // with no correlated stream event. Never convert on a guess — surface FR-ED-7 instead.
        let base = "hello world\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        // No `observe` — the run announced no write to this doc.

        fs::write(root.join("draft.md"), "hello brave world\n").unwrap();

        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
        // The file is left exactly as the external writer left it — no conversion, no markup.
        assert_eq!(read(&root, "draft.md"), "hello brave world\n");
        // ...and nothing was attributed to the agent.
        let store = SidecarStore::new(&root);
        assert_eq!(store.doc_id_for_path("draft.md").unwrap(), None);
    }

    #[test]
    fn duplicate_notifications_for_one_external_write_surface_it_once() {
        let (_dir, root) = project("draft.md", "before\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        fs::write(root.join("draft.md"), "after\n").unwrap();

        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
        assert_eq!(wd.on_write("draft.md").unwrap(), WriteOutcome::Unchanged);
    }

    #[test]
    fn an_explicit_baseline_seed_uses_the_supplied_text_not_a_disk_reread() {
        let (_dir, root) = project("draft.md", "before\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        fs::write(root.join("draft.md"), "agent write\n").unwrap();

        wd.refresh_baseline_to("draft.md", "app save\n".to_string());

        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn the_real_doc_watcher_advances_an_out_of_run_write_baseline() {
        let replacement = "after\n";
        let (_dir, root) = project("draft.md", "before\n");
        let watchdog = Arc::new(Mutex::new(Watchdog::new(root.clone())));
        watchdog.lock().unwrap().open_tab("draft.md");
        let _watcher = DocWatcher::watch(
            &root,
            Arc::clone(&watchdog),
            Arc::new(RecordingSink::default()),
        )
        .unwrap();

        fs::write(root.join("draft.md"), replacement).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let advanced = watchdog
                .lock()
                .unwrap()
                .baselines
                .get("draft.md")
                .is_some_and(|baseline| baseline == replacement);
            if advanced {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for the real DocWatcher worker"
            );
            std::thread::yield_now();
        }

        assert_eq!(
            watchdog.lock().unwrap().on_write("draft.md").unwrap(),
            WriteOutcome::Unchanged
        );
    }

    #[test]
    fn a_native_notification_during_a_run_waits_for_terminal_reconciliation() {
        let (_dir, root) = project("draft.md", "before\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        fs::write(root.join("draft.md"), "after\n").unwrap();

        assert_eq!(
            wd.on_native_write("draft.md").unwrap(),
            WriteOutcome::AwaitingRunCompletion
        );
        wd.observe("run-1", &write_event("draft.md"));
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));
    }

    #[test]
    fn an_attributed_native_truncate_waits_for_the_completed_replacement() {
        let base = "# Notes\n\nOriginal.\n";
        let replacement = "# Notes\n\nReplacement.\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));

        fs::write(root.join("draft.md"), "").unwrap();
        assert_eq!(
            wd.on_native_write("draft.md").unwrap(),
            WriteOutcome::AwaitingRunCompletion
        );

        fs::write(root.join("draft.md"), replacement).unwrap();
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));
        assert_eq!(textops::accept_all(&read(&root, "draft.md")), replacement);

        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("draft.md").unwrap().unwrap();
        let changes = store.fold_changes(doc_id).unwrap();
        assert!(changes
            .changes
            .values()
            .any(|change| change.kind != ChangeType::Deletion));
    }

    #[test]
    fn one_announced_write_attributes_exactly_one_raw_write() {
        // A single announced write must not license a *second*, later unattributable write to the
        // same doc — the second is external (finding M11: never on a guess).
        let base = "one\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));

        fs::write(root.join("draft.md"), "one two\n").unwrap();
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));

        // A second raw write with no fresh announcement is unattributable.
        fs::write(root.join("draft.md"), "one two three\n").unwrap();
        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn a_deleted_protected_doc_is_surfaced_not_converted() {
        let (_dir, root) = project("draft.md", "hello\n");
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));
        fs::remove_file(root.join("draft.md")).unwrap();
        // Nothing to convert into tracked changes — surface it.
        assert_eq!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn protection_and_conversion_survive_a_tab_closing_mid_run() {
        // D21: the tab closes while the run is still live; the run pin keeps the doc protected, so
        // its raw write is still caught and converted.
        let base = "hello world\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &["draft.md".to_string()]);
        wd.observe("run-1", &write_event("draft.md"));

        wd.close_tab("draft.md");
        assert!(wd.is_protected("draft.md"), "the run pin still protects it");

        fs::write(root.join("draft.md"), "hello brave world\n").unwrap();
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));
    }

    #[test]
    fn an_announced_tab_only_write_survives_tab_close_until_terminal_reconciliation() {
        let base = "hello world\n";
        let replacement = "hello brave world\n";
        let (_dir, root) = project("draft.md", base);
        let mut wd = Watchdog::new(root.clone());
        let protected = wd.protected_set();
        wd.open_tab("draft.md");
        wd.begin_run("run-1", &[]);
        wd.observe("run-1", &write_event("draft.md"));

        fs::write(root.join("draft.md"), replacement).unwrap();
        wd.close_tab("draft.md");

        assert!(
            wd.watched_paths().contains("draft.md"),
            "the outstanding announcement retains terminal-scan identity"
        );
        assert!(
            protected.lock().unwrap().is_protected("draft.md"),
            "the shared protection union retains the same identity"
        );
        assert!(matches!(
            wd.on_write("draft.md").unwrap(),
            WriteOutcome::Converted { .. }
        ));
        assert_eq!(textops::accept_all(&read(&root, "draft.md")), replacement);
        assert_eq!(textops::reject_all(&read(&root, "draft.md")), base);

        wd.end_run("run-1");
        assert!(!wd.watched_paths().contains("draft.md"));
        assert!(!protected.lock().unwrap().is_protected("draft.md"));
        assert!(!wd.baselines.contains_key("draft.md"));
    }

    #[test]
    fn a_path_escaping_the_root_is_refused() {
        let (_dir, root) = project("draft.md", "x\n");
        let mut wd = Watchdog::new(root);
        // Protect the escaping path so on_write proceeds to confinement (which must refuse it).
        wd.open_tab("../escape.md");
        assert!(matches!(
            wd.on_write("../escape.md"),
            Err(WatchdogError::Confinement(_))
        ));
    }
}
