// ABOUTME: Comment thread IPC (P2a-18/P2a-19, FR-CMT-1/2/3/4/6/7, D17) — thin commands wiring
// ABOUTME: create/reply/resolve/reopen/re-anchor/address-with-AI through `store::service::SidecarStore`.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use textops::{Anchor, Document, ReAnchor};

use crate::agent::run_queue::{new_run_id, RunQueue, RunRequest, StartRunResult};
use crate::store::comments::{self, CommentEvent, EventKind, LinkedChangeDecision};
use crate::store::project_identity;
use crate::store::service::{SidecarError, SidecarStore};

use super::document::byte_range_from_utf16;
use super::path_confine::{confine, identity_relative, ConfineError};
use tauri::State;

/// A comment command failed. Serializable so it crosses the Tauri IPC boundary as a typed JS
/// error (§3.1's "validate → call → return, typed errors").
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    InvalidPath(String),
    InvalidDocument(String),
    CorrectionRefused(String),
    ClosureRefused(String),
    Io(String),
}

/// Human-readable form — what a user actually sees when a failure is surfaced in the UI (e.g. a
/// batch run's `interrupted` reason), as opposed to `Debug`'s variant-wrapped developer shape.
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandError::InvalidPath(m)
            | CommandError::InvalidDocument(m)
            | CommandError::CorrectionRefused(m)
            | CommandError::ClosureRefused(m)
            | CommandError::Io(m) => write!(f, "{m}"),
        }
    }
}

impl From<ConfineError> for CommandError {
    fn from(e: ConfineError) -> Self {
        CommandError::InvalidPath(e.to_string())
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        CommandError::Io(e.to_string())
    }
}

impl From<SidecarError> for CommandError {
    fn from(e: SidecarError) -> Self {
        CommandError::Io(e.to_string())
    }
}

/// A live selection captured at comment-create time (FR-CMT-1): `content` is the exact buffer
/// text CodeMirror held when the user took the action — dirty or not, never re-read from disk
/// (mirrors `commands::document::capture_anchor`'s identical "content, not path" contract, since
/// a `root`/`path` could name a stale disk copy the live buffer has since diverged from —
/// PR #495 review's Critical). `utf16_offset`/`utf16_length` are CodeMirror's own UTF-16
/// code-unit selection range within that `content`, exactly the shape `capture_anchor` already
/// takes; this command converts to `textops`' byte-indexed canonical space
/// (`byte_range_from_utf16`) before calling `Anchor::new` — the frontend never hand-rolls that
/// arithmetic or constructs an anchor itself (CLAUDE.md: anchor construction stays in `textops`;
/// TD-2/TD-6). `camelCase` on the wire (unlike this file's outgoing `ThreadWire`/etc.) to match
/// `capture_anchor`'s own `content`/`utf16Offset`/`utf16Length` command-argument names, since a
/// caller building this by hand from that command's args is exactly the intended use.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRange {
    pub content: String,
    pub utf16_offset: usize,
    pub utf16_length: usize,
}

/// Captures a `textops::Anchor` from `range`'s live buffer text and UTF-16 selection — the same
/// conversion `commands::document::capture_anchor` performs for the quote-bar (P2b-7), reused
/// here (not re-implemented) so the two anchored-capture paths can't drift into two different
/// notions of "the right coordinate space" (PR #495 review's Critical).
fn anchor_from_range(range: AnchorRange) -> Anchor {
    let doc = Document::new(range.content);
    let (start, end) = byte_range_from_utf16(
        doc.text(),
        range.utf16_offset,
        range.utf16_offset + range.utf16_length,
    );
    Anchor::new(&doc, start, end - start)
}

/// One reply, shaped for the wire (mirrors `store::comments::Reply`).
#[derive(Debug, Clone, Serialize)]
pub struct ReplyWire {
    pub id: String,
    pub parent_id: String,
    pub author: String,
    pub body: String,
    pub defense: bool,
    pub published: bool,
    pub edited_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
}

impl From<comments::Reply> for ReplyWire {
    fn from(reply: comments::Reply) -> Self {
        ReplyWire {
            id: reply.id,
            parent_id: reply.parent_id,
            author: reply.author,
            body: reply.body,
            defense: reply.defense,
            published: reply.published,
            edited_at: reply.edited_at,
            withdrawn_at: reply.withdrawn_at,
        }
    }
}

/// The most recent address run this thread saw end without delivering, shaped for the wire
/// (mirrors `store::comments::ConcludedRun`) — issue #1381, ux-design.md §2's exit table. Plain
/// (not camelCase) field names, matching every other outgoing wire struct in this file
/// (`ReplyWire`/`LinkedChangeWire`/`ThreadWire` itself); `outcome` serializes as `"stopped"` or
/// `"failed"` (`store::comments::RunConclusion`'s own `#[serde(rename_all = "snake_case")]`).
#[derive(Debug, Clone, Serialize)]
pub struct ConcludedRunWire {
    pub run_id: String,
    pub outcome: comments::RunConclusion,
}

/// Every pending Address is exposed separately for queue-aware J4 presentation. The old scalar
/// fields remain available only when exactly one pending Address exists.
#[derive(Debug, Clone, Serialize)]
pub struct PendingRunWire {
    pub run_id: String,
    pub address_event_id: String,
    pub started: bool,
    pub guidance: Option<String>,
    pub corrected: bool,
}

impl From<comments::PendingAddress> for PendingRunWire {
    fn from(pending: comments::PendingAddress) -> Self {
        PendingRunWire {
            run_id: pending.run_id,
            address_event_id: pending.event_id,
            started: pending.started,
            guidance: pending.guidance,
            corrected: pending.corrected,
        }
    }
}

impl From<comments::ConcludedRun> for ConcludedRunWire {
    fn from(concluded: comments::ConcludedRun) -> Self {
        ConcludedRunWire {
            run_id: concluded.run_id,
            outcome: concluded.outcome,
        }
    }
}

/// One linked tracked change's decision state, shaped for the wire (mirrors
/// `store::comments::LinkedChange`) — FR-CMT-7. `delivery_id`/`run_id`/`delivered_at` are the
/// attribution `store::comments::LinkedChange`'s own doc comment describes (#1380) — a frontend
/// caller can group on `delivery_id` wherever ux-design.md §2 requires each delivery's
/// undecided changes to render under its own name.
#[derive(Debug, Clone, Serialize)]
pub struct LinkedChangeWire {
    pub change_id: String,
    pub decision: Option<LinkedChangeDecision>,
    pub delivery_id: String,
    pub run_id: Option<String>,
    pub delivered_at: i64,
}

impl From<comments::LinkedChange> for LinkedChangeWire {
    fn from(linked: comments::LinkedChange) -> Self {
        LinkedChangeWire {
            change_id: linked.change_id,
            decision: linked.decision,
            delivery_id: linked.delivery_id,
            run_id: linked.run_id,
            delivered_at: linked.delivered_at,
        }
    }
}

/// A folded thread, shaped for the wire (mirrors `store::comments::Thread`) plus two pieces of
/// state this layer derives on top of the pure fold: `orphaned` (D17, re-checking the anchor
/// against the document's *current* text) and `reopened` (FR-CMT-7 — "a linked change was
/// rejected" per ux-design.md §2's short state definition, kept as a wire-only convenience so a
/// caller never has to re-derive it from `linked_changes` itself).
///
/// `orphaned` is only ever `true` for an anchored thread (`anchor: Some`) whose stored
/// `base_revision` no longer names the live text and whose snapshot/context no longer place
/// confidently (`textops::Anchor::fuzzy_reanchor` returning `Orphan`) — a document-level thread
/// (`anchor: None`) is never orphaned, and an anchor that still names the live revision, or that
/// fuzzy-reanchor confidently relocates, is not orphaned either (`anchor` reflects the relocated
/// position in that case). The original quote is always preserved: an orphaned thread's `anchor`
/// keeps its old `text_snapshot`/`context_before`/`context_after` untouched (ux-design.md §2 —
/// "Orphaned: anchor text gone; original quote preserved").
///
/// `reopened` is `true` when at least one linked change was rejected and the thread isn't
/// currently `resolved` (a later accept completing FR-CMT-7's "all decided, ≥1 accepted" rule
/// clears it back to `false` — `resolved` always wins over `reopened`, never both at once).
#[derive(Debug, Clone, Serialize)]
pub struct ThreadWire {
    pub id: String,
    pub author: String,
    pub last_activity_at: i64,
    pub published: bool,
    pub visible_when_withdrawn: bool,
    pub anchor: Option<Anchor>,
    pub body: String,
    pub edited_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
    pub resolved: bool,
    pub orphaned: bool,
    pub reopened: bool,
    pub replies: Vec<ReplyWire>,
    /// J4's three batch-filter dimensions (FR-CMT-5): `severity` and `skill` (the *source* that
    /// raised the finding — a review skill, or `None` for a human comment) and `workflow_run` (the
    /// *review pass* it came from). Carried on the wire so a caller can build FR-CMT-5's filter set
    /// without re-reading the sidecar; all three are `None` on an ordinary human comment.
    pub severity: Option<String>,
    pub skill: Option<String>,
    pub workflow_run: Option<String>,
    /// Legacy single-run projection; `None` when two or more Address runs remain pending.
    pub pending_run: Option<String>,
    pub pending_runs: Vec<PendingRunWire>,
    /// Durable Address target history. Intersect with the live queue ids to keep correction
    /// inert after delivery clears `pending_run` but before the run itself ends (FR-CMT-10).
    pub targeting_run_ids: Vec<String>,
    /// Whether `pending_run` has begun genuine per-thread work, as opposed to merely targeting
    /// this thread (issue #1778, ux-design.md §2 "Batch … Working means started, not targeted") —
    /// meaningless while `pending_run` is `None`. The frontend's *Working* derivation requires
    /// both `pending_run` and this together; see `store::comments::Thread::pending_run_started`'s
    /// own doc.
    pub pending_run_started: bool,
    /// The in-flight run's [Try again — add guidance…] note, if this is a re-delegation.
    pub pending_guidance: Option<String>,
    /// The most recent address run to end on this thread without delivering (issue #1381) — `Some`
    /// until the thread's next event; `None` while `pending_run` is set, or when no run has ever
    /// concluded that way. See `store::comments::Thread::concluded_run`'s own doc for the exact
    /// clearing rule.
    pub concluded_run: Option<ConcludedRunWire>,
    pub linked_changes: Vec<LinkedChangeWire>,
}

/// Confines `path` under `root`, reads its current text, and resolves (get-or-mints) this
/// document's sidecar id — the shared preamble every comment command needs before it can touch
/// the event log or re-check an anchor against live text.
fn open_doc(root: &str, path: &str) -> Result<(SidecarStore, Uuid, Document), CommandError> {
    let confined = confine(Path::new(root), path)?;
    let text = fs::read_to_string(&confined)?;
    let doc = Document::new(text);
    let store = SidecarStore::new(root);
    let identity = identity_relative(Path::new(root), &confined)?;
    let id = store.get_or_mint_for_path(&identity)?;
    Ok((store, id, doc))
}

/// Opens a pathless document by its already-checkpointed TD-4 identity and live CM6 text.
fn open_doc_by_id(
    root: &str,
    doc_id: &str,
    content: String,
) -> Result<(SidecarStore, Uuid, Document), CommandError> {
    let id = Uuid::parse_str(doc_id)
        .map_err(|_| CommandError::InvalidDocument("invalid untitled document id".into()))?;
    let canonical = project_identity::require_canonical_root(Path::new(root))
        .map_err(|error| CommandError::InvalidDocument(error.to_string()))?;
    Ok((SidecarStore::new(canonical), id, Document::new(content)))
}

/// Re-checks one folded thread's anchor against `doc`'s current text and shapes it for the wire.
/// See [`ThreadWire::orphaned`] for the exact rule.
fn resolve_thread(thread: comments::Thread, doc: &Document) -> ThreadWire {
    let visible_when_withdrawn = thread.keeps_withdrawn_placeholder();
    let (anchor, orphaned) = match thread.anchor {
        None => (None, false),
        Some(anchor) if anchor.base_revision == doc.revision() => (Some(anchor), false),
        Some(anchor) => match anchor.fuzzy_reanchor(doc.text(), doc.revision()) {
            ReAnchor::Anchored(placed) => (Some(placed), false),
            // Orphan: keep the *original* anchor (old quote/context) — never the orphan's bare
            // snapshot-only shape — so a later successful re-anchor still has real context to
            // fuzzy-match from if it's ever retried.
            ReAnchor::Orphan(_) => (Some(anchor), true),
        },
    };
    let reopened = !thread.resolved
        && thread
            .linked_changes
            .iter()
            .any(|c| c.decision == Some(comments::LinkedChangeDecision::Reject));
    ThreadWire {
        id: thread.id,
        author: thread.author,
        last_activity_at: thread.last_activity_at,
        published: thread.published,
        visible_when_withdrawn,
        anchor,
        body: thread.body,
        edited_at: thread.edited_at,
        withdrawn_at: thread.withdrawn_at,
        resolved: thread.resolved,
        orphaned,
        reopened,
        replies: thread.replies.into_iter().map(ReplyWire::from).collect(),
        severity: thread.severity,
        skill: thread.skill,
        workflow_run: thread.workflow_run,
        pending_run: thread.pending_run,
        pending_runs: thread
            .pending_addresses
            .into_iter()
            .map(PendingRunWire::from)
            .collect(),
        targeting_run_ids: thread.targeting_run_ids.into_iter().collect(),
        pending_run_started: thread.pending_run_started,
        pending_guidance: thread.pending_guidance,
        concluded_run: thread.concluded_run.map(ConcludedRunWire::from),
        linked_changes: thread
            .linked_changes
            .into_iter()
            .map(LinkedChangeWire::from)
            .collect(),
    }
}

/// Folds `id`'s current comment state and resolves every thread's anchor against `doc`'s live
/// text — the one place every mutating command (and the plain loader) shares so a caller always
/// sees the full, current, orphan-aware picture after any single event lands.
fn resolved_threads(
    store: &SidecarStore,
    id: Uuid,
    doc: &Document,
) -> Result<Vec<ThreadWire>, CommandError> {
    Ok(project_threads(store.fold_comments(id)?, doc))
}

fn project_threads(fold: comments::Fold, doc: &Document) -> Vec<ThreadWire> {
    let mut threads: Vec<ThreadWire> = fold
        .threads
        .into_values()
        .filter(|thread| thread.withdrawn_at.is_none() || thread.keeps_withdrawn_placeholder())
        .map(|thread| resolve_thread(thread, doc))
        .collect();
    // BTreeMap iteration is already id-ordered, but `into_values` after the intermediate `Vec`
    // collect doesn't guarantee that stays true through a future refactor — sort explicitly so
    // the wire order is deterministic regardless.
    threads.sort_by(|a, b| a.id.cmp(&b.id));
    threads
}

fn mint_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
fn assert_comment_validation_lane() {
    assert!(
        crate::store::service::comment_transaction_held(),
        "comment eligibility must be checked while this thread owns the write lane"
    );
}

/// The shape every mutating command below shares: open the document, build one `EventKind` (given
/// the live `Document` — `create`/`re_anchor` need it to capture a fresh `Anchor`; the others
/// ignore it), append the resulting event, and hand back the freshly resolved thread list. Factors
/// out that open→build→append→resolve shape so each command below is just its own event shape.
fn append_and_resolve(
    root: &str,
    path: &str,
    parent_id: Option<String>,
    author: String,
    timestamp: i64,
    build_kind: impl FnOnce(&Document) -> EventKind,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc(root, path)?;
    let event = CommentEvent {
        schema_version: comments::SCHEMA_VERSION,
        id: mint_id(),
        parent_id,
        author,
        timestamp,
        kind: build_kind(&doc),
    };
    store.append_comment_event(id, &event)?;
    resolved_threads(&store, id, &doc)
}

#[allow(clippy::too_many_arguments)]
fn append_and_resolve_by_id(
    root: &str,
    doc_id: &str,
    content: String,
    parent_id: Option<String>,
    author: String,
    timestamp: i64,
    build_kind: impl FnOnce(&Document) -> EventKind,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc_by_id(root, doc_id, content)?;
    let event = CommentEvent {
        schema_version: comments::SCHEMA_VERSION,
        id: mint_id(),
        parent_id,
        author,
        timestamp,
        kind: build_kind(&doc),
    };
    store.append_comment_event(id, &event)?;
    resolved_threads(&store, id, &doc)
}

/// Checks the current fold and appends a manual Resolve in one comment write transaction.
/// Auto-resolution by a linked-change decision has its own fold path and is not gated here.
fn append_manual_resolve_to_doc(
    opened: (SidecarStore, Uuid, Document),
    thread_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = opened;
    let transaction = store.comment_transaction();
    let fold = transaction.fold_comments(id)?;
    #[cfg(test)]
    assert_comment_validation_lane();
    if fold.threads.get(&thread_id).is_some_and(|thread| {
        thread
            .linked_changes
            .iter()
            .any(|change| change.decision.is_none())
    }) {
        return Err(CommandError::ClosureRefused(
            "Decide the linked changes first. Accept them to resolve this thread, or reject them to reopen it before dismissing."
                .into(),
        ));
    }
    transaction.append_comment_event(
        id,
        &CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: mint_id(),
            parent_id: Some(thread_id),
            author,
            timestamp,
            kind: EventKind::Resolve,
        },
    )?;
    drop(transaction);
    resolved_threads(&store, id, &doc)
}

/// Every reconciliation event [`reconcile_lost_runs`] writes is authored by this sentinel rather
/// than any human/agent name — it records a system-observed fact ("this marker's run is no longer
/// live"), not an action either of them took.
const RECONCILED_AUTHOR: &str = "emend";

/// Per-process record of which documents' `pending_run` markers [`load_comment_threads`] has
/// already reconciled once (issue #1381: "reconcile a marker with no live run **at startup**") —
/// `first_time` is true exactly once per sidecar doc id, for the life of this process, and false on
/// every call after. Managed Tauri state (`lib.rs`'s `.manage(ReconciledDocs::default())`); the D23
/// `crates/test-driver` holds its own instance alongside its `RunQueue`.
///
/// This is the actual gate that makes "startup" mean *once*, not *every load*: a document's threads
/// are examined against `RunQueueState::known_run_ids` only the first time this process ever loads
/// them. Without it, reconciliation raced a still-legitimately-delivering batch run the instant
/// *anything* reloaded the document — observed as a real e2e regression (the batch address journey,
/// #1381 review): a second `load_comment_threads` call mid-batch found the run's own id absent from
/// the queue's picture (in dev-mode/e2e, `timeline/agentActivity.ts`'s `startRun` never calls the
/// real backend at all — a pre-existing, deliberate, separately-tested D23 degrade, #696/#1721; the
/// resulting client-minted run id was therefore never going to be "known" to any `RunQueueState` on
/// *any* load, not just a later one) and reconciled away a thread whose per-thread delivery was
/// never going to come from that run in the first place, mid-test. Gating to the first load only
/// closes that race without touching `startRun`'s own ratified dev-mode contract: by the time a
/// batch run starts, its document has almost always already loaded at least once (the user has to
/// see a thread before addressing it), so the gate has already flipped and reconciliation never
/// revisits that document again this session — exactly the complement `TimelinePanel`'s own live
/// listener (`concludeLostAddressRuns`) owns for a run *this* session genuinely watches conclude.
#[derive(Default)]
pub struct ReconciledDocs(std::sync::Mutex<HashSet<Uuid>>);

impl ReconciledDocs {
    /// Records `id` as reconciled and returns whether this is the first time — call exactly once
    /// per [`load_comment_threads`] invocation, after `open_doc` has resolved the sidecar id.
    pub fn first_time(&self, id: Uuid) -> bool {
        let mut seen = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        seen.insert(id)
    }
}

/// Milliseconds since the Unix epoch, real wall-clock time — [`load_comment_threads`]'s default
/// `now` for [`reconcile_lost_runs`]. Kept as its own function (rather than inlined) so
/// [`load_comment_threads_on`] can take an injected one instead (CLAUDE.md: no reliance on real
/// time in tests) without this command's own signature ever needing a caller-supplied timestamp —
/// unlike every other mutating command here, nothing user-facing drives *when* a reconciliation
/// fires, only *whether* one is due.
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reconciles every thread's `pending_run` against `known_run_ids` (issue #1381, ux-design.md §2's
/// last exit row: "An in-flight marker outlives its run … must never present as Working
/// indefinitely") — a thread whose pending run id is *not* in `known_run_ids` gets an
/// [`EventKind::AddressFailed`] appended for it, authored by [`RECONCILED_AUTHOR`], before the fold
/// is next read. A fresh process's `RunQueue` starts with nothing known at all (`RunQueueState::
/// known_run_ids`'s own doc), so this reconciles *every* marker a restart-mid-run left behind the
/// first time its document loads.
///
/// Deliberately not the primary mechanism for a run this *same* process's queue actually saw
/// stop/fail — that is `TimelinePanel`'s own live `agent://activity` listener
/// (`concludeLostAddressRuns`), which reconciles it the moment the push arrives, while any earlier
/// per-thread events from the same run are already on the log. This function is the load-time
/// backstop for whatever that listener could never have seen (`known_run_ids`'s own doc has the
/// full reasoning, including why "still running" was too narrow a definition to check against).
///
/// Runs once per [`load_comment_threads`] call — the "startup" moment for a given document —
/// rather than on every mutating command's shared [`resolved_threads`] tail, so an ordinary
/// reply/resolve/etc. never pays this extra fold-and-maybe-append pass.
fn reconcile_lost_runs(
    store: &SidecarStore,
    id: Uuid,
    known_run_ids: &HashSet<String>,
    timestamp: i64,
) -> Result<(), CommandError> {
    let fold = store.fold_comments(id)?;
    for thread in fold.threads.values() {
        for pending in &thread.pending_addresses {
            if known_run_ids.contains(&pending.run_id) {
                continue;
            }
            let event = CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: mint_id(),
                parent_id: Some(thread.id.clone()),
                author: RECONCILED_AUTHOR.to_string(),
                timestamp,
                kind: EventKind::AddressFailed {
                    run_id: pending.run_id.clone(),
                },
            };
            store.append_comment_event(id, &event)?;
        }
    }
    Ok(())
}

/// [`load_comment_threads`]'s business logic without a Tauri `State` extractor — what that command
/// wrapper calls, and what the D23 `crates/test-driver` (no Tauri runtime, so no `State<RunQueue>`
/// to extract) calls directly against its own `RunQueue`'s `known_run_ids()` and its own
/// `ReconciledDocs`, mirroring `commands::agent::start_run_on`'s identical split. `now` is
/// `timestamp`'s source for any reconciliation event this load triggers.
pub fn load_comment_threads_on(
    root: &str,
    path: &str,
    known_run_ids: &HashSet<String>,
    reconciled: &ReconciledDocs,
    now: impl FnOnce() -> i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc(root, path)?;
    if reconciled.first_time(id) {
        reconcile_lost_runs(&store, id, known_run_ids, now())?;
    }
    resolved_threads(&store, id, &doc)
}

/// Loads `path`'s current thread state — what a timeline mount reads to seed its comment cards.
/// Reconciles any marker whose run this process's queue has no record of at all, the first time
/// (and only the first time, [`ReconciledDocs`]) this document loads in this process's lifetime
/// ([`reconcile_lost_runs`]), against `queue`'s own picture of what's active, queued, or was most
/// recently displaced.
#[tauri::command]
pub fn load_comment_threads(
    root: String,
    path: String,
    queue: tauri::State<crate::agent::run_queue::RunQueue>,
    reconciled: tauri::State<ReconciledDocs>,
) -> Result<Vec<ThreadWire>, CommandError> {
    load_comment_threads_on(
        &root,
        &path,
        &queue.state().known_run_ids(),
        &reconciled,
        now_millis,
    )
}

/// Creates a new thread: anchored (`anchor: Some`, a live selection) or document-level
/// (`anchor: None`) per FR-CMT-1. An anchored create captures the `textops::Anchor` from the
/// [`AnchorRange`]'s own `content`/UTF-16 range (`anchor_from_range`) rather than from `path`'s
/// on-disk text: the two can differ (an unsaved edit, or plain UTF-16-vs-byte offset confusion),
/// and capturing against the wrong text is exactly the silently-wrong position P2/D17 forbid
/// (PR #495 review's Critical).
#[tauri::command]
pub fn create_comment(
    root: String,
    path: String,
    author: String,
    body: String,
    anchor: Option<AnchorRange>,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve(&root, &path, None, author, timestamp, |_doc| {
        EventKind::Create {
            anchor: anchor.map(anchor_from_range),
            body,
            severity: None,
            skill: None,
            workflow_run: None,
        }
    })
}

/// Appends a reply to `thread_id` (FR-CMT-1's thread support). `defense` distinguishes FR-CMT-4's
/// reply-only defense (no edit proposed) from an ordinary reply; `published` is that defense's
/// publish-to-external-reviewer flag (FR-CMT-4/D20) — meaningless (pass `false`) on a non-defense
/// reply. A defense reply also concludes whatever [`address_with_ai`] run was pending on this
/// thread, same as [`link_changes`] does for a fix-producing delivery.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reply_comment(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_reply_comment(
        root, path, thread_id, author, body, defense, published, timestamp, None,
    )
}

/// Binds a defense to its Address run when multiple runs target one thread. Ordinary replies
/// still use their existing parent hierarchy and ignore this run-specific entry point.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reply_comment_for_run(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
    run_id: String,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_reply_comment(
        root,
        path,
        thread_id,
        author,
        body,
        defense,
        published,
        timestamp,
        Some(&run_id),
    )
}

#[allow(clippy::too_many_arguments)]
fn append_reply_comment(
    root: String,
    path: String,
    target_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
    run_id: Option<&str>,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_reply_to_doc(
        open_doc(&root, &path)?,
        target_id,
        author,
        body,
        defense,
        published,
        timestamp,
        run_id,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_reply_to_doc(
    opened: (SidecarStore, Uuid, Document),
    target_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
    run_id: Option<&str>,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = opened;
    let transaction = store.comment_transaction();
    let fold = transaction.fold_comments(id)?;
    let run_id = if defense {
        let thread = fold.threads.values().find(|thread| {
            thread.id == target_id || thread.replies.iter().any(|reply| reply.id == target_id)
        });
        match (run_id, thread) {
            (Some(run_id), Some(thread)) if thread.targeting_run_ids.contains(run_id) => {
                if thread
                    .address_event_runs
                    .values()
                    .filter(|id| id.as_str() == run_id)
                    .count()
                    != 1
                {
                    return Err(CommandError::InvalidDocument(
                        "Run has more than one Address event for this comment.".into(),
                    ));
                }
                Some(run_id.to_string())
            }
            (Some(_), _) => {
                return Err(CommandError::InvalidDocument(
                    "Run did not target this comment.".into(),
                ))
            }
            (None, Some(thread)) if thread.pending_addresses.len() > 1 => {
                return Err(CommandError::InvalidDocument(
                    "A run ID is required when this comment has more than one pending run.".into(),
                ));
            }
            (None, Some(thread)) => thread
                .pending_addresses
                .first()
                .map(|address| address.run_id.clone()),
            (None, None) => None,
        }
    } else {
        None
    };
    let event = CommentEvent {
        schema_version: comments::SCHEMA_VERSION,
        id: mint_id(),
        parent_id: Some(target_id),
        author,
        timestamp,
        kind: EventKind::Reply {
            body,
            defense,
            published,
            run_id,
        },
    };
    transaction.append_comment_event(id, &event)?;
    drop(transaction);
    resolved_threads(&store, id, &doc)
}

/// Validates a correction against the current on-disk fold before appending an event to the
/// target author's own log. The caller's `author` is the actor identity used by existing comment
/// commands; no authenticated reviewer identity exists in this IPC yet.
fn append_correction_to_doc(
    opened: (SidecarStore, Uuid, Document),
    target_id: String,
    author: String,
    timestamp: i64,
    kind: EventKind,
    live_run_ids: impl FnOnce() -> Option<HashSet<String>>,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = opened;
    let transaction = store.comment_transaction();
    let fold = transaction.fold_comments(id)?;
    #[cfg(test)]
    assert_comment_validation_lane();
    let target = fold
        .threads
        .values()
        .find_map(|thread| {
            if thread.id == target_id {
                Some((thread, thread.author.as_str(), thread.withdrawn_at))
            } else {
                thread
                    .replies
                    .iter()
                    .find(|reply| reply.id == target_id)
                    .map(|reply| (thread, reply.author.as_str(), reply.withdrawn_at))
            }
        })
        .ok_or_else(|| CommandError::CorrectionRefused("Comment or reply not found.".into()))?;
    if target.1 != author {
        return Err(CommandError::CorrectionRefused(
            "Only the author can edit or delete this comment.".into(),
        ));
    }
    if target.2.is_some() {
        return Err(CommandError::CorrectionRefused(
            "A deleted comment cannot be restored or edited.".into(),
        ));
    }
    let targeted_by_live_run = match live_run_ids() {
        Some(live) => target
            .0
            .targeting_run_ids
            .iter()
            .any(|run_id| live.contains(run_id)),
        None => !target.0.pending_addresses.is_empty(),
    };
    if targeted_by_live_run {
        return Err(CommandError::CorrectionRefused(
            "Addressing with AI — you can edit or delete this comment once the run finishes."
                .into(),
        ));
    }
    if matches!(kind, EventKind::Withdraw) && target.0.has_live_descendant(&target_id) {
        return Err(CommandError::CorrectionRefused(
            "Delete replies first.".into(),
        ));
    }
    if matches!(kind, EventKind::Withdraw)
        && target
            .0
            .linked_changes
            .iter()
            .any(|change| change.decision.is_none())
    {
        return Err(CommandError::CorrectionRefused(
            "Decide the linked changes before deleting this comment.".into(),
        ));
    }
    if let EventKind::Revise { body } = &kind {
        if body.trim().is_empty() {
            return Err(CommandError::CorrectionRefused(
                "A comment cannot have an empty body.".into(),
            ));
        }
    }
    transaction.append_comment_event(
        id,
        &CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: mint_id(),
            parent_id: Some(target_id),
            author,
            timestamp,
            kind,
        },
    )?;
    drop(transaction);
    resolved_threads(&store, id, &doc)
}

/// Supersedes only the body of an authored comment or reply (FR-CMT-12/13, J10).
#[tauri::command]
pub fn revise_comment(
    root: String,
    path: String,
    target_id: String,
    author: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc(&root, &path)?,
        target_id,
        author,
        timestamp,
        EventKind::Revise { body },
        || None,
    )
}

/// Production correction path: samples the queue after acquiring the comment write lane, so a
/// run cannot enter between target validation and append (FR-CMT-10).
#[allow(clippy::too_many_arguments)]
pub fn revise_comment_on(
    queue: &RunQueue,
    root: String,
    path: String,
    target_id: String,
    author: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc(&root, &path)?,
        target_id,
        author,
        timestamp,
        EventKind::Revise { body },
        || Some(queue.state().live_run_ids()),
    )
}

/// Local correction command. The IPC caller supplies no author; the current single-user actor
/// is chosen here until reviewer identities are introduced by the permissions model.
#[tauri::command]
pub fn revise_own_comment(
    queue: State<'_, RunQueue>,
    root: String,
    path: String,
    target_id: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    revise_comment_on(&queue, root, path, target_id, "you".into(), body, timestamp)
}

/// Records the confirmed Delete action as a terminal withdrawal (FR-CMT-8..11, J10).
#[tauri::command]
pub fn withdraw_comment(
    root: String,
    path: String,
    target_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc(&root, &path)?,
        target_id,
        author,
        timestamp,
        EventKind::Withdraw,
        || None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw_comment_on(
    queue: &RunQueue,
    root: String,
    path: String,
    target_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc(&root, &path)?,
        target_id,
        author,
        timestamp,
        EventKind::Withdraw,
        || Some(queue.state().live_run_ids()),
    )
}

#[tauri::command]
pub fn withdraw_own_comment(
    queue: State<'_, RunQueue>,
    root: String,
    path: String,
    target_id: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    withdraw_comment_on(&queue, root, path, target_id, "you".into(), timestamp)
}

/// The run acknowledgement and the comment fold produced by one Address admission. The queue
/// receives only runs whose Address transition has landed under the same comment write lane.
#[derive(Debug, Serialize)]
pub struct StartAddressRunOutcome {
    pub run: Option<StartRunResult>,
    pub threads: Vec<ThreadWire>,
    pub progress: BatchProgress,
}

/// Builds a batch request from the exact targets whose Address records landed. Caller-supplied
/// text can name skipped or untouched comments after eligibility and filesystem failures; the
/// provider must see only the durable target set (FR-AGENT-6).
fn admitted_batch_prompt(fold: &comments::Fold, addressed: &[String]) -> String {
    let mut prompt = format!(
        "Address the following {} comment thread(s): for each, propose a tracked change, or reply explaining why none is needed.",
        addressed.len()
    );
    for (index, id) in addressed.iter().enumerate() {
        let thread = &fold.threads[id];
        prompt.push_str(&format!("\n\n{}. ", index + 1));
        append_thread_summary(&mut prompt, thread);
    }
    prompt
}

fn admitted_single_prompt(thread: &comments::Thread, guidance: Option<&str>) -> String {
    let mut prompt = "Address this comment thread: propose a tracked change, or reply explaining why none is needed.\n\n".to_string();
    append_thread_summary(&mut prompt, thread);
    if let Some(note) = guidance.filter(|note| !note.is_empty()) {
        prompt.push_str(&format!("\n\nGuidance for this attempt: {note}"));
    }
    prompt
}

fn append_thread_summary(prompt: &mut String, thread: &comments::Thread) {
    if let Some(anchor) = &thread.anchor {
        prompt.push_str(&format!("Quoted passage: \"{}\"\n", anchor.text_snapshot));
    }
    prompt.push_str(&format!("Comment: {}", thread.body));
}

/// Records the target set before admitting its run while holding the comment write lane. A
/// concurrent correction therefore sees either a still-correctable thread before admission, or
/// the Address event that makes it ineligible (D24, FR-CMT-10). Batch writes retain FR-AGENT-6's
/// partial progress: a failure after earlier targets landed starts the run for those targets;
/// failure before the first write leaves no queued run.
#[allow(clippy::too_many_arguments)]
pub fn start_address_run_on(
    queue: &RunQueue,
    root: String,
    path: String,
    thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
) -> Result<StartAddressRunOutcome, CommandError> {
    start_address_run_on_watching(
        queue,
        root,
        path,
        thread_ids,
        author,
        timestamp,
        prompt,
        reference_data,
        batch,
        guidance,
        |_, _| {},
    )
}

/// Admits only the held thread IDs the caller deliberately selected for a second batch. The
/// write lane rechecks both the fold and queue before any Address event is appended.
#[allow(clippy::too_many_arguments)]
pub fn start_address_run_on_with_inclusions(
    queue: &RunQueue,
    root: String,
    path: String,
    thread_ids: Vec<String>,
    include_held_thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
) -> Result<StartAddressRunOutcome, CommandError> {
    start_address_run_on_watching_with_inclusions(
        queue,
        root,
        path,
        thread_ids,
        include_held_thread_ids,
        author,
        timestamp,
        prompt,
        reference_data,
        batch,
        guidance,
        |_, _| {},
    )
}

/// The D23 driver's filesystem fault window at the same real append boundary as the historical
/// batch route. It changes the sidecar file after an Address event lands, so the next real append
/// can fail and exercise partial completion without replacing any production participant.
#[allow(clippy::too_many_arguments)]
pub fn start_address_run_on_watching(
    queue: &RunQueue,
    root: String,
    path: String,
    thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
    after_append: impl FnMut(usize, &Path),
) -> Result<StartAddressRunOutcome, CommandError> {
    start_address_run_on_watching_with_inclusions(
        queue,
        root,
        path,
        thread_ids,
        Vec::new(),
        author,
        timestamp,
        prompt,
        reference_data,
        batch,
        guidance,
        after_append,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn start_address_run_on_watching_with_inclusions(
    queue: &RunQueue,
    root: String,
    path: String,
    thread_ids: Vec<String>,
    include_held_thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
    mut after_append: impl FnMut(usize, &Path),
) -> Result<StartAddressRunOutcome, CommandError> {
    if prompt.trim().is_empty() {
        return Err(CommandError::InvalidDocument(
            "prompt must not be empty".into(),
        ));
    }
    let requested: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
    if thread_ids.is_empty()
        || (!batch && (thread_ids.len() != 1 || !include_held_thread_ids.is_empty()))
        || (batch && guidance.is_some())
        || include_held_thread_ids
            .iter()
            .any(|id| !requested.contains(id.as_str()))
    {
        return Err(CommandError::InvalidDocument(
            "Invalid Address targets.".into(),
        ));
    }
    let confined = confine(Path::new(&root), &path)?;
    let target = identity_relative(Path::new(&root), &confined)?;
    let (store, id, doc) = open_doc(&root, &target)?;
    let transaction = store.comment_transaction();
    let mut fold = transaction.fold_comments(id)?;
    #[cfg(test)]
    assert_comment_validation_lane();
    let run_id = new_run_id();
    // Delivery clears `pending_run` before the run necessarily ends. Retain every Address target
    // in the fold and intersect it with the queue's current live ids while holding the comment
    // transaction, so a stale caller cannot admit a second run for that thread.
    let live_run_ids = queue.state().live_run_ids();
    let included: HashSet<&str> = include_held_thread_ids.iter().map(String::as_str).collect();
    let eligible: HashSet<String> = fold
        .threads
        .values()
        .filter(|thread| {
            let held_by_live_run = thread
                .targeting_run_ids
                .iter()
                .any(|run_id| live_run_ids.contains(run_id));
            !thread.resolved
                && thread.withdrawn_at.is_none()
                && ((thread.pending_addresses.is_empty() && !held_by_live_run)
                    || (included.contains(thread.id.as_str()) && held_by_live_run))
        })
        .map(|thread| thread.id.clone())
        .collect();
    if !batch && !eligible.contains(&thread_ids[0]) {
        return Err(CommandError::InvalidDocument(
            "Comment thread is not addressable.".into(),
        ));
    }
    let sidecar = store.comment_author_file(id, &author);
    let mut landed = 0usize;
    let mut landed_events = Vec::new();
    let progress = run_batch_address(
        &thread_ids,
        |thread_id| eligible.contains(thread_id),
        |thread_id| {
            let event = CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: mint_id(),
                parent_id: Some(thread_id.to_string()),
                author: author.clone(),
                timestamp,
                kind: address_event(&run_id, guidance.as_deref(), !batch),
            };
            transaction.append_comment_event(id, &event)?;
            landed_events.push(event);
            landed += 1;
            after_append(landed, &sidecar);
            Ok(())
        },
    );
    if progress.addressed.is_empty() && !batch {
        return Err(CommandError::Io(
            progress
                .interrupted
                .unwrap_or_else(|| "No comment was addressed.".into()),
        ));
    }
    fold.apply(landed_events);
    if progress.addressed.is_empty() {
        return Ok(StartAddressRunOutcome {
            run: None,
            threads: project_threads(fold, &doc),
            progress,
        });
    }
    let mut admitted_prompt = if batch {
        admitted_batch_prompt(&fold, &progress.addressed)
    } else {
        admitted_single_prompt(&fold.threads[&thread_ids[0]], guidance.as_deref())
    };
    admitted_prompt.push_str(&reference_data);
    let run = queue.start_with_reserved_id(
        run_id,
        RunRequest {
            project_root: root.into(),
            prompt: admitted_prompt,
            operation_targets: vec![target],
        },
    );
    drop(transaction);
    Ok(StartAddressRunOutcome {
        run: Some(run),
        threads: project_threads(fold, &doc),
        progress,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_address_run(
    queue: State<'_, RunQueue>,
    root: String,
    path: String,
    thread_ids: Vec<String>,
    include_held_thread_ids: Option<Vec<String>>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
) -> Result<StartAddressRunOutcome, CommandError> {
    start_address_run_on_with_inclusions(
        &queue,
        root,
        path,
        thread_ids,
        include_held_thread_ids.unwrap_or_default(),
        author,
        timestamp,
        prompt,
        reference_data,
        batch,
        guidance,
    )
}

/// Starts an "Address with AI" run against `thread_id` (FR-CMT-2, ux-design.md J4): the thread
/// reads "addressed — pending review" until the run's delivery lands ([`link_changes`] and/or a
/// defense [`reply_comment`]). Spawning/streaming the run itself is P2a-15's job, out of scope
/// here — this command only records the pending state a caller starting one owns. `guidance` is
/// the [Try again — add guidance…] re-delegation note on a reopened thread (`None` for a first
/// address); a caller re-delegating passes it alongside `run_id` naming the new run.
///
/// This is the single-thread path: once its Address event lands, this run has no target other than
/// `thread_id`, so the event carries per-thread start evidence (issue #1778; contrast batch
/// [`address_all_with_ai`]). This historical command remains for D23 driver fixtures; production
/// UI uses [`start_address_run`] so queue acceptance and the Address event share one write lane.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn address_with_ai(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    run_id: String,
    guidance: Option<String>,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc(&root, &path)?;
    let transaction = store.comment_transaction();
    let fold = transaction.fold_comments(id)?;
    #[cfg(test)]
    assert_comment_validation_lane();
    let thread = fold
        .threads
        .get(&thread_id)
        .ok_or_else(|| CommandError::InvalidDocument("Comment thread not found.".into()))?;
    if thread.withdrawn_at.is_some() {
        return Err(CommandError::InvalidDocument(
            "A deleted comment cannot be addressed.".into(),
        ));
    }
    transaction.append_comment_event(
        id,
        &CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: mint_id(),
            parent_id: Some(thread_id),
            author,
            timestamp,
            kind: address_event(&run_id, guidance.as_deref(), true),
        },
    )?;
    drop(transaction);
    resolved_threads(&store, id, &doc)
}

/// The one "this thread is now addressed — pending review" transition (FR-CMT-2). Both the single
/// path ([`address_with_ai`]) and the batch path ([`address_all_with_ai`]) build their event here
/// so the two can never drift into two different notions of "addressed" (issue #350). `started`
/// (issue #1778) is the only thing that differs between the two callers — see
/// [`store::comments::EventKind::Address`]'s own doc for exactly what it means.
fn address_event(run_id: &str, guidance: Option<&str>, started: bool) -> EventKind {
    EventKind::Address {
        run_id: run_id.to_string(),
        guidance: guidance.map(str::to_string),
        started,
    }
}

/// Concludes `thread_id`'s in-flight address run without a delivery (issue #1381, ux-design.md §2's
/// exit table) — the store event that clears `pending_run`/`pending_guidance` and records the exit
/// note when a run is stopped from the run card, fails (CLI spawn/read error), or is reconciled as
/// failed because no live run answers to it any more (`outcome: "failed"` covers both). A no-op if
/// `run_id` no longer names this thread's current pending run (see `store::comments::EventKind::
/// AddressStopped`/`AddressFailed`'s own docs) — the caller never has to check first.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn conclude_address_run(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    run_id: String,
    outcome: comments::RunConclusion,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve(
        &root,
        &path,
        Some(thread_id),
        author,
        timestamp,
        |_doc| match outcome {
            comments::RunConclusion::Stopped => EventKind::AddressStopped { run_id },
            comments::RunConclusion::Failed => EventKind::AddressFailed { run_id },
        },
    )
}

/// What a batch run did, per thread — FR-AGENT-6's "the card says which". Every targeted id lands
/// in exactly one of the three buckets, so a caller can always account for the full target set.
#[derive(Debug, Default, Serialize)]
pub struct BatchProgress {
    /// Threads whose address transition landed. These stand even if the batch died later.
    pub addressed: Vec<String>,
    /// Threads that weren't eligible (already resolved, or already mid-run) — never written.
    pub skipped: Vec<String>,
    /// Threads the batch never started, because it was interrupted before reaching them.
    pub untouched: Vec<String>,
    /// Why the batch stopped early, if it did (`None` on a clean run).
    pub interrupted: Option<String>,
}

/// FR-AGENT-6's partial-completion accounting, kept separate from the store so the invariant is
/// directly testable: walk the targets in order, skip the ineligible, address the rest, and the
/// moment one write fails **stop** — leaving the already-written threads addressed and every
/// remaining thread genuinely untouched rather than half-written.
///
/// Repeated ids collapse to their first occurrence. Eligibility is a snapshot taken before the loop
/// (it can't see this run's own writes), so a duplicate would otherwise still look open on its
/// second pass and take a second Address event — and land twice in one bucket, breaking the
/// contract that the three buckets partition the target set.
fn run_batch_address(
    thread_ids: &[String],
    eligible: impl Fn(&str) -> bool,
    mut address: impl FnMut(&str) -> Result<(), CommandError>,
) -> BatchProgress {
    let mut seen = HashSet::new();
    let thread_ids: Vec<String> = thread_ids
        .iter()
        .filter(|id| seen.insert(*id))
        .cloned()
        .collect();

    let mut progress = BatchProgress::default();
    for (i, thread_id) in thread_ids.iter().enumerate() {
        if !eligible(thread_id) {
            progress.skipped.push(thread_id.clone());
            continue;
        }
        match address(thread_id) {
            Ok(()) => progress.addressed.push(thread_id.clone()),
            Err(e) => {
                // The failed thread itself is untouched: its event never landed.
                progress.untouched = thread_ids[i..].to_vec();
                progress.interrupted = Some(e.to_string());
                break;
            }
        }
    }
    progress
}

/// The batch outcome as it crosses IPC: [`BatchProgress`]'s per-thread accounting plus the run id
/// and the document's full refreshed thread list.
#[derive(Debug, Serialize)]
pub struct BatchAddressOutcome {
    pub run_id: String,
    #[serde(flatten)]
    pub progress: BatchProgress,
    pub threads: Vec<ThreadWire>,
}

/// Starts one "Address all…" batch run across `thread_ids` (FR-CMT-5/D8, ux-design.md J4 Batch) —
/// the trigger half of P2b-3. Each targeted thread gets the *same* address event shape the single
/// path uses ([`address_event`]), under one shared `run_id` so the delivery can come back as one
/// reviewable grouped change-set card (rendering that card is the sibling card's job; spawning the
/// provider run rides the agent-run seam, not this command).
///
/// **`started: false` on every one of those events (issue #1778).** Dispatching a batch targets
/// every eligible thread, but this build has no per-thread signal yet to say when a provider
/// actually *starts* work on any one of them (P2a-15) — so per ux-design.md §2's "Batch … Working
/// means started, not targeted" (UXR-Q10/#1122), no thread claims Working merely for having been
/// targeted. `pending_run` still lands on every eligible target (eligibility gating, the run's
/// `LinkChanges` attribution, and FR-AGENT-6's own accounting all key off it, unchanged); only the
/// frontend's Working *derivation* additionally requires `pending_run_started`, which stays false
/// here and has no writer that could raise it for a batch target — see
/// [`store::comments::EventKind::Address`]'s `started` for why, and why this command invents no
/// seam for one.
///
/// Which threads to target — J4's source/severity/review-pass filter set, defaulting to *all* open
/// threads with no filter pre-applied (J4-Q1) — is the caller's selection; this command is
/// authoritative only over the state transitions. It re-derives eligibility from the fold as of the
/// start of the run rather than trusting the caller's view, so a stale selection can never drive an
/// Address event onto a resolved or already-pending thread.
///
/// Interruption is reported, never hidden (FR-AGENT-6): completed threads stay addressed, unstarted
/// threads are untouched, and the outcome names both sets.
#[tauri::command]
pub fn address_all_with_ai(
    root: String,
    path: String,
    thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    run_id: String,
) -> Result<BatchAddressOutcome, CommandError> {
    // A shipped batch has no fault window: the only failures it can report are the store's own.
    address_all_with_ai_watching(root, path, thread_ids, author, timestamp, run_id, |_, _| {})
}

/// [`address_all_with_ai`], with a window between the batch's own appends — the seam the D23 test
/// driver (`crates/test-driver`) drives so an e2e script can reach FR-AGENT-6's *partial* batch
/// for real (#538). Until an agent run is actually wired behind batch address, this is the only
/// way a caller outside this module can produce one: every target in a batch appends to the same
/// per-author sidecar, opened and closed fresh per thread, so failing that file up front fails the
/// *first* write rather than "some complete, then fail", and racing a filesystem mutation into the
/// gap would need a sleep (test-plan §4/§7 forbid both mocking and timing-dependent tests).
///
/// `after_append` is called once per landed append, with how many have landed so far and the
/// sidecar file this batch is writing to. It returns nothing, deliberately: it can change the
/// world — make that file unwritable, say — but it cannot fabricate a failure. Every error the
/// batch reports still comes from a real `store::service` write against a real file, so a partial
/// run provoked through this window exercises the production path rather than a mock of it.
#[allow(clippy::too_many_arguments)]
pub fn address_all_with_ai_watching(
    root: String,
    path: String,
    thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    run_id: String,
    mut after_append: impl FnMut(usize, &Path),
) -> Result<BatchAddressOutcome, CommandError> {
    let (store, id, doc) = open_doc(&root, &path)?;
    let transaction = store.comment_transaction();

    // Eligibility comes from the live fold, not the caller's view of it: a thread is batch-
    // addressable exactly when it's open — not resolved, and not already mid-run. Both bits come
    // straight off the fold, so this reads `fold_comments` rather than `resolved_threads` — the
    // latter would fuzzy-re-anchor every thread in the document to answer a question that never
    // looks at an anchor.
    let open_now: HashSet<String> = transaction
        .fold_comments(id)?
        .threads
        .into_values()
        .filter(|t| !t.resolved && t.pending_addresses.is_empty() && t.withdrawn_at.is_none())
        .map(|t| t.id)
        .collect();
    #[cfg(test)]
    assert_comment_validation_lane();

    let sidecar = store.comment_author_file(id, &author);
    let mut landed = 0usize;
    let progress = run_batch_address(
        &thread_ids,
        |thread_id| open_now.contains(thread_id),
        |thread_id| {
            let event = CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: mint_id(),
                parent_id: Some(thread_id.to_string()),
                author: author.clone(),
                timestamp,
                kind: address_event(&run_id, None, false),
            };
            transaction.append_comment_event(id, &event)?;
            landed += 1;
            after_append(landed, &sidecar);
            Ok(())
        },
    );
    drop(transaction);

    Ok(BatchAddressOutcome {
        run_id,
        progress,
        threads: resolved_threads(&store, id, &doc)?,
    })
}

/// Links `change_ids` (the tracked changes `propose_changes`, P2a-13, proposed) to `thread_id`'s
/// address-run delivery (FR-CMT-2/7) — pairs with a [`reply_comment`] call carrying the agent's
/// explanation for the same delivery. Each change starts undecided; [`decide_linked_changes`]
/// records the accept/reject outcome that drives FR-CMT-7's resolve/reopen rule. The event targets
/// the pending Address event itself, not merely the thread, so P5's existing buffer-until-parent
/// rule preserves their causal order under cross-machine clock skew and timestamp ties.
#[tauri::command]
pub fn link_changes(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_link_changes(root, path, thread_id, author, timestamp, change_ids, None)
}

/// Names the Address run for a delivery when a comment has multiple pending targets (J4).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn link_changes_for_run(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    run_id: String,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_link_changes(
        root,
        path,
        thread_id,
        author,
        timestamp,
        change_ids,
        Some(&run_id),
    )
}

#[allow(clippy::too_many_arguments)]
fn append_link_changes(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    run_id: Option<&str>,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc(&root, &path)?;
    let transaction = store.comment_transaction();
    let fold = transaction.fold_comments(id)?;
    let thread = fold.threads.get(&thread_id);
    let parent_id = match run_id {
        Some(run_id) => {
            let matches: Vec<&String> = thread
                .into_iter()
                .flat_map(|thread| thread.address_event_runs.iter())
                .filter_map(|(event_id, id)| (id == run_id).then_some(event_id))
                .collect();
            match matches.as_slice() {
                [event_id] => (*event_id).clone(),
                [] => {
                    return Err(CommandError::InvalidDocument(
                        "Run did not target this comment.".into(),
                    ))
                }
                _ => {
                    return Err(CommandError::InvalidDocument(
                        "Run has more than one Address event for this comment.".into(),
                    ))
                }
            }
        }
        None => match thread.map(|thread| thread.pending_addresses.as_slice()) {
            Some([address]) => address.event_id.clone(),
            Some(addresses) if addresses.len() > 1 => {
                return Err(CommandError::InvalidDocument(
                    "A run ID is required when this comment has more than one pending run.".into(),
                ));
            }
            _ => thread_id,
        },
    };
    let event = CommentEvent {
        schema_version: comments::SCHEMA_VERSION,
        id: mint_id(),
        parent_id: Some(parent_id),
        author,
        timestamp,
        kind: EventKind::LinkChanges { change_ids },
    };
    transaction.append_comment_event(id, &event)?;
    drop(transaction);
    resolved_threads(&store, id, &doc)
}

/// Records `decision` for every id in `change_ids`, linked to `thread_id` (FR-CMT-7) — one call
/// covers both the single-change accept/reject case and the multi-change "[Accept both]"/reject
/// bulk case; a future 1-by-1 caller can pass a single id just as well. The actual tracked-change
/// accept/reject (the live CM6 transaction, P2a-5/P2a-14) is the caller's concern — this command
/// only records the outcome so the thread can auto-resolve/reopen.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn decide_linked_changes(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    decision: LinkedChangeDecision,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc(&root, &path)?;
    for change_id in change_ids {
        let event = CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: mint_id(),
            parent_id: Some(thread_id.clone()),
            author: author.clone(),
            timestamp,
            kind: EventKind::DecideLinkedChange {
                change_id,
                decision,
            },
        };
        store.append_comment_event(id, &event)?;
    }
    resolved_threads(&store, id, &doc)
}

/// Manually resolves `thread_id` (the "resolve" action on an open thread; auto-resolve from
/// linked-change acceptance is P2a-19's job — this command is the manual half FR-CMT-1 asks for).
#[tauri::command]
pub fn resolve_comment(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_manual_resolve_to_doc(open_doc(&root, &path)?, thread_id, author, timestamp)
}

/// Reopens a previously resolved thread.
#[tauri::command]
pub fn reopen_comment(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve(&root, &path, Some(thread_id), author, timestamp, |_doc| {
        EventKind::Reopen
    })
}

/// Manually re-anchors an orphaned thread to a new home the user selected and confirmed
/// (ux-design.md J4: "click [Re-anchor] → select new home text in the doc → confirm"). Unlike
/// [`resolved_threads`]'s automatic fuzzy re-anchor (which only ever *reads* a relocated
/// position without persisting it), this command commits the user's explicit choice as a
/// `re_anchor` event — the original quote stays on the thread regardless (D17): only the *live*
/// anchor moves, `store::comments::EventKind::ReAnchor` never touches `body`/history.
///
/// Takes the same [`AnchorRange`] shape [`create_comment`] does — `content` is the live buffer
/// text the user's new-home selection was measured against, `utf16_offset`/`utf16_length` its
/// CodeMirror UTF-16 range within it — and captures the anchor from that via the same
/// `anchor_from_range` conversion, rather than reading `path`'s on-disk text and indexing it with
/// raw (UTF-16) offsets as though they were bytes. Both halves of that were the exact defect
/// PR #495 fixed in `create_comment` (issue #517: this command still had it, latent — unreachable
/// today because no production caller yet wires a real `pendingSelection`, but the fix belongs
/// here regardless of reachability so the hazard can't surface the moment one does).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn re_anchor_comment(
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    anchor: AnchorRange,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve(&root, &path, Some(thread_id), author, timestamp, |_doc| {
        EventKind::ReAnchor {
            anchor: anchor_from_range(anchor),
        }
    })
}

/// Pathless counterparts to the locally valid comment actions. They resolve anchors against the
/// live CM6 content supplied by the caller and never read a synthetic path from disk. Agent-run
/// commands intentionally have no ID variant: an untitled buffer has no addressable operation
/// target (J12 Phase E).
#[tauri::command]
pub fn load_comment_threads_by_id(
    root: String,
    doc_id: String,
    content: String,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc_by_id(&root, &doc_id, content)?;
    resolved_threads(&store, id, &doc)
}

#[tauri::command]
pub fn create_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    author: String,
    body: String,
    anchor: Option<AnchorRange>,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve_by_id(&root, &doc_id, content, None, author, timestamp, |_doc| {
        EventKind::Create {
            anchor: anchor.map(anchor_from_range),
            body,
            severity: None,
            skill: None,
            workflow_run: None,
        }
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reply_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_reply_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        thread_id,
        author,
        body,
        defense,
        published,
        timestamp,
        None,
    )
}

/// Corrects an already-minted pathless document using the same guarded append as a file-backed
/// comment. The caller supplies the live buffer for anchor projection; no path is read or minted.
#[allow(clippy::too_many_arguments)]
pub fn revise_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    author: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        target_id,
        author,
        timestamp,
        EventKind::Revise { body },
        || None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn revise_comment_by_id_on(
    queue: &RunQueue,
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    author: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        target_id,
        author,
        timestamp,
        EventKind::Revise { body },
        || Some(queue.state().live_run_ids()),
    )
}

#[tauri::command]
pub fn revise_own_comment_by_id(
    queue: State<'_, RunQueue>,
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    body: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    revise_comment_by_id_on(
        &queue,
        root,
        doc_id,
        content,
        target_id,
        "you".into(),
        body,
        timestamp,
    )
}

/// Records a confirmed pathless Delete after the shared owner, descendant, linked-change and
/// in-flight run checks. The command's caller-owned author is retained only as an internal seam.
#[allow(clippy::too_many_arguments)]
pub fn withdraw_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        target_id,
        author,
        timestamp,
        EventKind::Withdraw,
        || None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw_comment_by_id_on(
    queue: &RunQueue,
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_correction_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        target_id,
        author,
        timestamp,
        EventKind::Withdraw,
        || Some(queue.state().live_run_ids()),
    )
}

#[tauri::command]
pub fn withdraw_own_comment_by_id(
    queue: State<'_, RunQueue>,
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    withdraw_comment_by_id_on(
        &queue,
        root,
        doc_id,
        content,
        target_id,
        "you".into(),
        timestamp,
    )
}

#[tauri::command]
pub fn resolve_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_manual_resolve_to_doc(
        open_doc_by_id(&root, &doc_id, content)?,
        thread_id,
        author,
        timestamp,
    )
}

#[tauri::command]
pub fn reopen_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve_by_id(
        &root,
        &doc_id,
        content,
        Some(thread_id),
        author,
        timestamp,
        |_doc| EventKind::Reopen,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn re_anchor_comment_by_id(
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    anchor: AnchorRange,
) -> Result<Vec<ThreadWire>, CommandError> {
    append_and_resolve_by_id(
        &root,
        &doc_id,
        content,
        Some(thread_id),
        author,
        timestamp,
        |_doc| EventKind::ReAnchor {
            anchor: anchor_from_range(anchor),
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn decide_linked_changes_by_id(
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    decision: LinkedChangeDecision,
) -> Result<Vec<ThreadWire>, CommandError> {
    let (store, id, doc) = open_doc_by_id(&root, &doc_id, content)?;
    for change_id in change_ids {
        store.append_comment_event(
            id,
            &CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: mint_id(),
                parent_id: Some(thread_id.clone()),
                author: author.clone(),
                timestamp,
                kind: EventKind::DecideLinkedChange {
                    change_id,
                    decision,
                },
            },
        )?;
    }
    resolved_threads(&store, id, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::run_queue::{RunQueue, RunRequest};
    use crate::agent::session::AgentSession;
    use crate::agent::session::SessionError;
    use tempfile::TempDir;

    fn project(content: &str) -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), content).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        (dir, root)
    }

    fn held_agent_session(request: &RunRequest) -> Result<AgentSession, SessionError> {
        #[cfg(unix)]
        {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        }
        #[cfg(windows)]
        {
            AgentSession::spawn(
                "powershell.exe",
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    "Start-Sleep -Seconds 60".into(),
                ],
                &request.project_root,
            )
        }
    }

    #[test]
    fn accepted_address_run_blocks_correction_before_returning_its_run_id() {
        let (_dir, root) = project("Hello world");
        let id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let observed_root = root.clone();
        let observed_id = id.clone();
        let queue = RunQueue::new(move |_request: &RunRequest| {
            let store = SidecarStore::new(&observed_root);
            let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
            let thread = &store.fold_comments(doc_id).unwrap().threads[&observed_id];
            assert!(
                thread.pending_run.is_some(),
                "provider startup must see Address on disk"
            );
            Err(SessionError::Spawn(std::io::Error::other("no provider")))
        });

        let outcome = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![id.clone()],
            "alice".into(),
            2,
            "Address this comment".into(),
            "".into(),
            false,
            None,
        )
        .unwrap();

        assert_eq!(outcome.progress.addressed, vec![id.clone()]);
        let run = outcome.run.as_ref().unwrap();
        assert_eq!(
            outcome.threads[0].pending_run.as_deref(),
            Some(run.id.as_str())
        );
        assert_eq!(queue.state().active.unwrap().id, run.id);
        assert!(matches!(
            revise_comment(
                root,
                "doc.md".into(),
                id,
                "alice".into(),
                "changed".into(),
                3
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn production_correction_guard_tracks_a_queued_run_after_delivery() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "you".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let holding_run = queue.start(RunRequest {
            project_root: root.clone().into(),
            prompt: "hold the active slot".into(),
            operation_targets: vec![],
        });
        let outcome = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![thread_id.clone()],
            "you".into(),
            2,
            "address".into(),
            "".into(),
            false,
            None,
        )
        .unwrap();
        let addressing_run = outcome.run.unwrap().id;
        assert!(queue
            .state()
            .queued
            .iter()
            .any(|run| run.id == addressing_run));

        reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            "delivered".into(),
            true,
            false,
            3,
        )
        .unwrap();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        assert!(store.fold_comments(doc_id).unwrap().threads[&thread_id]
            .pending_run
            .is_none());
        assert!(matches!(
            revise_comment_on(
                &queue,
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                "too early".into(),
                4,
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert_eq!(
            queue.stop(&addressing_run),
            crate::agent::run_queue::StopOutcome::Cancelled
        );
        assert_eq!(
            revise_comment_on(
                &queue,
                root.clone(),
                "doc.md".into(),
                thread_id,
                "you".into(),
                "now allowed".into(),
                5,
            )
            .unwrap()[0]
                .body,
            "now allowed"
        );
        queue.stop(&holding_run);
    }

    /// A delivery clears the presentation `pending_run`, but the queued run still owns the target.
    /// A stale single or batch Address request must not reserve the same thread a second time.
    #[cfg(unix)]
    #[test]
    fn live_target_run_blocks_duplicate_address_after_early_delivery() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let holding_run = queue.start(RunRequest {
            project_root: root.clone().into(),
            prompt: "hold the active slot".into(),
            operation_targets: vec![],
        });
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![thread_id.clone()],
            "alice".into(),
            2,
            "address".into(),
            "".into(),
            false,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            3,
            vec!["change-1".into()],
        )
        .unwrap();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        assert!(store.fold_comments(doc_id).unwrap().threads[&thread_id]
            .pending_run
            .is_none());

        let duplicate = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![thread_id.clone()],
            "alice".into(),
            4,
            "stale single".into(),
            "".into(),
            false,
            None,
        );
        assert!(matches!(duplicate, Err(CommandError::InvalidDocument(_))));
        let batch = start_address_run_on(
            &queue,
            root,
            "doc.md".into(),
            vec![thread_id.clone()],
            "alice".into(),
            5,
            "stale batch".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert!(batch.run.is_none());
        assert_eq!(batch.progress.skipped, vec![thread_id]);
        assert!(batch.progress.addressed.is_empty());
        assert_eq!(queue.state().queued.len(), 1);
        queue.stop(&first.id);
        queue.stop(&holding_run);
    }

    #[test]
    fn exact_held_ids_join_a_second_atomic_batch_without_replacing_the_first() {
        let (_dir, root) = project("Hello world");
        let one = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "one".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let two = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "two".into(),
            None,
            2,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.body == "two")
        .unwrap()
        .id;
        let queue = RunQueue::new(held_agent_session);
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![one.clone()],
            "alice".into(),
            3,
            "first batch".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let second = start_address_run_on_with_inclusions(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![one.clone(), two.clone()],
            vec![one.clone()],
            "alice".into(),
            4,
            "second batch".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(second.progress.addressed, vec![one.clone(), two.clone()]);
        assert!(second.progress.skipped.is_empty());
        let second_run = second.run.unwrap();
        assert_eq!(second_run.queued_position, Some(1));
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        let folded = store.fold_comments(id).unwrap();
        let one_pending = &folded.threads[&one].pending_addresses;
        assert_eq!(one_pending.len(), 2);
        assert!(one_pending.iter().any(|pending| pending.run_id == first.id));
        assert!(one_pending
            .iter()
            .any(|pending| pending.run_id == second_run.id));
        assert_eq!(
            folded.threads[&two].pending_run.as_deref(),
            Some(second_run.id.as_str())
        );
        queue.stop(&second_run.id);
        queue.stop(&first.id);
    }

    #[test]
    fn newly_held_unselected_id_is_skipped_by_a_deliberate_second_batch() {
        let (_dir, root) = project("Hello world");
        let mut ids = Vec::new();
        for (time, body) in [(1, "one"), (2, "two"), (3, "three")] {
            let id = create_comment(
                root.clone(),
                "doc.md".into(),
                "alice".into(),
                body.into(),
                None,
                time,
            )
            .unwrap()
            .into_iter()
            .find(|thread| thread.body == body)
            .unwrap()
            .id;
            ids.push(id);
        }
        let queue = RunQueue::new(held_agent_session);
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            4,
            "first".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let newly_held = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[1].clone()],
            "alice".into(),
            5,
            "newly held".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let second = start_address_run_on_with_inclusions(
            &queue,
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            vec![ids[0].clone()],
            "alice".into(),
            6,
            "second".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(
            second.progress.addressed,
            vec![ids[0].clone(), ids[2].clone()]
        );
        assert_eq!(second.progress.skipped, vec![ids[1].clone()]);
        assert!(second.progress.untouched.is_empty());
        let second_run = second.run.unwrap();
        let (store, doc_id, _) = open_doc(&root, "doc.md").unwrap();
        let folded = store.fold_comments(doc_id).unwrap();
        assert_eq!(folded.threads[&ids[1]].pending_addresses.len(), 1);
        assert_eq!(
            folded.threads[&ids[1]].pending_addresses[0].run_id,
            newly_held.id
        );
        queue.stop(&second_run.id);
        queue.stop(&newly_held.id);
        queue.stop(&first.id);
    }

    #[cfg(unix)]
    #[test]
    fn delivered_first_run_still_requires_exact_opt_in_while_it_is_live() {
        let (_dir, root) = project("Hello world");
        let ids: Vec<String> = [(1, "one"), (2, "two")]
            .into_iter()
            .map(|(time, body)| {
                create_comment(
                    root.clone(),
                    "doc.md".into(),
                    "alice".into(),
                    body.into(),
                    None,
                    time,
                )
                .unwrap()
                .into_iter()
                .find(|thread| thread.body == body)
                .unwrap()
                .id
            })
            .collect();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            3,
            "first".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        link_changes_for_run(
            root.clone(),
            "doc.md".into(),
            ids[0].clone(),
            "agent".into(),
            4,
            vec!["change-a".into()],
            first.id.clone(),
        )
        .unwrap();
        let (store, doc_id, _) = open_doc(&root, "doc.md").unwrap();
        let delivered = store.fold_comments(doc_id).unwrap();
        assert!(delivered.threads[&ids[0]].pending_addresses.is_empty());
        assert!(delivered.threads[&ids[0]]
            .targeting_run_ids
            .contains(&first.id));
        let default = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            5,
            "default batch".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert!(default.run.is_none());
        assert_eq!(default.progress.skipped, vec![ids[0].clone()]);
        let second = start_address_run_on_with_inclusions(
            &queue,
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            vec![ids[0].clone()],
            "alice".into(),
            6,
            "second".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(second.progress.addressed, ids);
        let second_run = second.run.unwrap();
        assert_eq!(second_run.queued_position, Some(1));
        let reloaded = open_doc(&root, "doc.md").unwrap();
        let folded = reloaded.0.fold_comments(reloaded.1).unwrap();
        assert_eq!(folded.threads[&ids[0]].pending_addresses.len(), 1);
        assert_eq!(
            folded.threads[&ids[0]].pending_addresses[0].run_id,
            second_run.id
        );
        assert_eq!(
            folded.threads[&ids[0]].linked_changes[0].run_id.as_deref(),
            Some(first.id.as_str())
        );
        queue.stop(&second_run.id);
        queue.stop(&first.id);
    }

    #[cfg(unix)]
    #[test]
    fn opted_in_overlapping_targets_reconcile_both_runs_after_restart() {
        let (_dir, root) = project("Hello world");
        let ids: Vec<String> = [(1, "one"), (2, "two")]
            .into_iter()
            .map(|(time, body)| {
                create_comment(
                    root.clone(),
                    "doc.md".into(),
                    "alice".into(),
                    body.into(),
                    None,
                    time,
                )
                .unwrap()
                .into_iter()
                .find(|thread| thread.body == body)
                .unwrap()
                .id
            })
            .collect();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            3,
            "first".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let second = start_address_run_on_with_inclusions(
            &queue,
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            vec![ids[0].clone()],
            "alice".into(),
            4,
            "second".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let loaded = load_comment_threads_on(
            &root,
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 10,
        )
        .unwrap();
        for id in &ids {
            let thread = loaded.iter().find(|thread| &thread.id == id).unwrap();
            assert!(thread.pending_runs.is_empty());
            assert!(thread.pending_run.is_none());
            assert_eq!(
                thread.concluded_run.as_ref().unwrap().outcome,
                comments::RunConclusion::Failed
            );
        }
        let (store, doc_id, _) = open_doc(&root, "doc.md").unwrap();
        let events: Vec<CommentEvent> =
            fs::read_to_string(store.comment_author_file(doc_id, RECONCILED_AUTHOR))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        let concluded_run_ids: HashSet<_> = events
            .iter()
            .filter_map(|event| match &event.kind {
                EventKind::AddressFailed { run_id } => Some(run_id.as_str()),
                _ => None,
            })
            .collect();
        assert!(concluded_run_ids.contains(first.id.as_str()));
        assert!(concluded_run_ids.contains(second.id.as_str()));
        queue.stop(&second.id);
        queue.stop(&first.id);
    }

    #[cfg(unix)]
    #[test]
    fn opted_in_partial_batch_keeps_skipped_and_untouched_distinct() {
        let (_dir, root) = project("Hello world");
        let ids: Vec<String> = [(1, "included"), (2, "newly held"), (3, "untouched")]
            .into_iter()
            .map(|(time, body)| {
                create_comment(
                    root.clone(),
                    "doc.md".into(),
                    "alice".into(),
                    body.into(),
                    None,
                    time,
                )
                .unwrap()
                .into_iter()
                .find(|thread| thread.body == body)
                .unwrap()
                .id
            })
            .collect();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            4,
            "first".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let holding = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[1].clone()],
            "alice".into(),
            5,
            "newly held".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let result = start_address_run_on_watching_with_inclusions(
            &queue,
            root,
            "doc.md".into(),
            vec![ids[1].clone(), ids[0].clone(), ids[2].clone()],
            vec![ids[0].clone()],
            "alice".into(),
            6,
            "second".into(),
            "".into(),
            true,
            None,
            |landed, sidecar| {
                if landed == 1 {
                    fs::rename(sidecar, sidecar.with_extension("saved.jsonl")).unwrap();
                    fs::create_dir(sidecar).unwrap();
                }
            },
        )
        .unwrap();
        assert_eq!(result.progress.skipped, vec![ids[1].clone()]);
        assert_eq!(result.progress.addressed, vec![ids[0].clone()]);
        assert_eq!(result.progress.untouched, vec![ids[2].clone()]);
        assert!(result.progress.interrupted.is_some());
        let second = result.run.unwrap();
        assert_eq!(second.queued_position, Some(2));
        queue.stop(&second.id);
        queue.stop(&holding.id);
        queue.stop(&first.id);
    }

    #[test]
    fn exact_held_opt_in_rejects_ids_outside_batch_and_single_address() {
        let (_dir, root) = project("Hello world");
        let id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "one".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let queue = RunQueue::new(|_: &RunRequest| panic!("invalid opt-in cannot reach provider"));
        for (batch, included) in [(true, vec!["other".to_string()]), (false, vec![id.clone()])] {
            let refused = start_address_run_on_with_inclusions(
                &queue,
                root.clone(),
                "doc.md".into(),
                vec![id.clone()],
                included,
                "alice".into(),
                2,
                "request".into(),
                "".into(),
                batch,
                None,
            );
            assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        }
        let (store, doc_id, _) = open_doc(&root, "doc.md").unwrap();
        assert!(store.fold_comments(doc_id).unwrap().threads[&id]
            .pending_addresses
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_opt_in_preserves_duplicate_target_set_semantics() {
        let (_dir, root) = project("Hello world");
        let ids: Vec<String> = [(1, "held"), (2, "open")]
            .into_iter()
            .map(|(time, body)| {
                create_comment(
                    root.clone(),
                    "doc.md".into(),
                    "alice".into(),
                    body.into(),
                    None,
                    time,
                )
                .unwrap()
                .into_iter()
                .find(|thread| thread.body == body)
                .unwrap()
                .id
            })
            .collect();
        let queue = RunQueue::new(|request: &RunRequest| {
            AgentSession::spawn("sleep", &["60".into()], &request.project_root)
        });
        let first = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone()],
            "alice".into(),
            3,
            "first".into(),
            "".into(),
            true,
            None,
        )
        .unwrap()
        .run
        .unwrap();
        let second = start_address_run_on_with_inclusions(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![ids[0].clone(), ids[1].clone(), ids[0].clone()],
            vec![ids[0].clone()],
            "alice".into(),
            4,
            "second".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(second.progress.addressed, ids);
        assert!(second.progress.skipped.is_empty());
        let second_run = second.run.unwrap();
        let (store, doc_id, _) = open_doc(&root, "doc.md").unwrap();
        let folded = store.fold_comments(doc_id).unwrap();
        assert_eq!(folded.threads[&ids[0]].pending_addresses.len(), 2);
        assert_eq!(folded.threads[&ids[1]].pending_addresses.len(), 1);
        queue.stop(&second_run.id);
        queue.stop(&first.id);
    }

    #[test]
    fn accepted_address_run_returns_its_id_when_sidecar_cannot_be_reread_after_append() {
        let (_dir, root) = project("Hello world");
        let id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let queue = RunQueue::new(|_: &RunRequest| {
            Err(SessionError::Spawn(std::io::Error::other("no provider")))
        });

        let outcome = start_address_run_on_watching(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![id.clone()],
            "alice".into(),
            2,
            "Address this comment".into(),
            "".into(),
            false,
            None,
            |_, sidecar| {
                fs::create_dir(sidecar.parent().unwrap().join("broken.jsonl")).unwrap();
            },
        )
        .expect("an admitted run must return its run id even if a later sidecar read fails");

        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        assert!(
            store.fold_comments(doc_id).is_err(),
            "the post-append disk read really fails"
        );
        let run = outcome.run.as_ref().unwrap();
        assert_eq!(run.id, queue.state().active.unwrap().id);
        assert_eq!(
            outcome.threads[0].pending_run.as_deref(),
            Some(run.id.as_str())
        );
    }

    #[test]
    fn accepted_batch_admits_only_addressed_threads_with_one_queue_run() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 3);
        resolve_comment(
            root.clone(),
            "doc.md".into(),
            ids[1].clone(),
            "alice".into(),
            2,
        )
        .unwrap();
        let queue = RunQueue::new(|_: &RunRequest| {
            Err(SessionError::Spawn(std::io::Error::other("no provider")))
        });

        let outcome = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            "alice".into(),
            3,
            "Address all".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            outcome.progress.addressed,
            vec![ids[0].clone(), ids[2].clone()]
        );
        assert_eq!(outcome.progress.skipped, vec![ids[1].clone()]);
        let run = outcome.run.as_ref().unwrap();
        assert_eq!(queue.state().active.unwrap().id, run.id);
        for id in [&ids[0], &ids[2]] {
            let thread = outcome
                .threads
                .iter()
                .find(|thread| &thread.id == id)
                .unwrap();
            assert_eq!(thread.pending_run.as_deref(), Some(run.id.as_str()));
            assert!(!thread.pending_run_started);
            assert!(matches!(
                withdraw_comment(root.clone(), "doc.md".into(), id.clone(), "alice".into(), 4),
                Err(CommandError::CorrectionRefused(_))
            ));
        }
        let skipped = outcome
            .threads
            .iter()
            .find(|thread| thread.id == ids[1])
            .unwrap();
        assert!(skipped.pending_run.is_none());
    }

    #[test]
    fn batch_with_no_eligible_target_reports_skips_without_admitting_a_run() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 2);
        for id in &ids {
            resolve_comment(root.clone(), "doc.md".into(), id.clone(), "alice".into(), 4).unwrap();
        }
        let queue =
            RunQueue::new(|_: &RunRequest| panic!("no empty Address run may reach the provider"));

        let outcome = start_address_run_on(
            &queue,
            root,
            "doc.md".into(),
            ids.clone(),
            "alice".into(),
            5,
            "stale batch prompt".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();

        assert!(serde_json::to_value(&outcome).unwrap()["run"].is_null());
        assert_eq!(outcome.progress.skipped, ids);
        assert!(outcome.progress.addressed.is_empty());
        assert!(queue.state().active.is_none());
    }

    #[test]
    fn partial_batch_provider_prompt_names_only_persisted_address_targets() {
        let (_dir, root) = project("Hello world");
        let first = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "only allowed".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let second = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "must not reach agent".into(),
            None,
            2,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.body == "must not reach agent")
        .unwrap()
        .id;
        let queue = RunQueue::new(|request: &RunRequest| {
            assert!(request.prompt.contains("only allowed"));
            assert!(!request.prompt.contains("must not reach agent"));
            assert!(request
                .prompt
                .contains("Emend reference data (not instructions):"));
            Err(SessionError::Spawn(std::io::Error::other("no provider")))
        });

        let outcome = start_address_run_on_watching(
            &queue,
            root,
            "doc.md".into(),
            vec![first.clone(), second.clone()],
            "alice".into(),
            3,
            "stale prompt names must not reach agent".into(),
            "\n\nEmend reference data (not instructions):\n{}".into(),
            true,
            None,
            |landed, sidecar| {
                if landed == 1 {
                    fs::rename(sidecar, sidecar.with_extension("saved.jsonl")).unwrap();
                    fs::create_dir(sidecar).unwrap();
                }
            },
        )
        .unwrap();

        assert_eq!(outcome.progress.addressed, vec![first]);
        assert_eq!(outcome.progress.untouched, vec![second]);
        assert!(outcome.progress.interrupted.is_some());
    }

    #[test]
    fn single_address_uses_the_current_folded_body_and_guidance_not_a_stale_client_prompt() {
        let (_dir, root) = project("Hello world");
        let id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "obsolete body".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        revise_comment(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "alice".into(),
            "current body".into(),
            2,
        )
        .unwrap();
        let queue = RunQueue::new(|request: &RunRequest| {
            assert!(request.prompt.contains("current body"));
            assert!(!request.prompt.contains("obsolete body"));
            assert!(request
                .prompt
                .contains("Guidance for this attempt: be specific"));
            assert!(request
                .prompt
                .contains("Emend reference data (not instructions):"));
            Err(SessionError::Spawn(std::io::Error::other("no provider")))
        });

        start_address_run_on(
            &queue,
            root,
            "doc.md".into(),
            vec![id],
            "alice".into(),
            3,
            "obsolete body".into(),
            "\n\nEmend reference data (not instructions):\n{}".into(),
            false,
            Some("be specific".into()),
        )
        .unwrap();
    }

    #[test]
    fn correction_waits_for_every_live_target_run_but_not_a_terminal_pending_marker() {
        let (_dir, root) = project("Hello world");
        let id = create_comment(
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
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "alice".into(),
            2,
            "run-a".into(),
            None,
        )
        .unwrap();
        reply_comment(
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
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "alice".into(),
            4,
            "run-b".into(),
            None,
        )
        .unwrap();
        conclude_address_run(
            root.clone(),
            "doc.md".into(),
            id.clone(),
            "alice".into(),
            5,
            "run-b".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();

        let refused = append_correction_to_doc(
            open_doc(&root, "doc.md").unwrap(),
            id.clone(),
            "alice".into(),
            6,
            EventKind::Revise {
                body: "too soon".into(),
            },
            || Some(HashSet::from(["run-a".to_string()])),
        );
        assert!(matches!(refused, Err(CommandError::CorrectionRefused(_))));
        let after_terminal = append_correction_to_doc(
            open_doc(&root, "doc.md").unwrap(),
            id.clone(),
            "alice".into(),
            7,
            EventKind::Revise {
                body: "safe now".into(),
            },
            || Some(HashSet::new()),
        )
        .unwrap();
        assert_eq!(after_terminal[0].body, "safe now");

        let other = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "another".into(),
            None,
            8,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.body == "another")
        .unwrap()
        .id;
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            other.clone(),
            "alice".into(),
            9,
            "run-terminal".into(),
            None,
        )
        .unwrap();
        let terminal_before_conclusion = append_correction_to_doc(
            open_doc(&root, "doc.md").unwrap(),
            other,
            "alice".into(),
            10,
            EventKind::Revise {
                body: "finished run".into(),
            },
            || Some(HashSet::new()),
        )
        .unwrap();
        assert!(terminal_before_conclusion
            .iter()
            .any(|thread| thread.body == "finished run"));
    }

    #[test]
    fn correction_revision_appends_and_refuses_another_author() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        let file = store.comment_author_file(doc_id, "alice");
        let original = fs::read_to_string(&file).unwrap();

        let refused = revise_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "bob".into(),
            "forged".into(),
            2,
        );
        assert!(matches!(refused, Err(CommandError::CorrectionRefused(_))));
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        assert!(!store.comment_author_file(doc_id, "bob").exists());

        let revised = revise_comment(
            root,
            "doc.md".into(),
            thread_id,
            "alice".into(),
            "second".into(),
            3,
        )
        .unwrap();
        assert_eq!(revised[0].body, "second");
        let after = fs::read_to_string(file).unwrap();
        assert!(after.starts_with(&original));
        assert_eq!(after.lines().count(), 2);
    }

    #[test]
    fn correction_late_reply_restores_private_root_placeholder() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "private".into(),
            None,
            1,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        let own = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            "my reply".into(),
            false,
            false,
            2,
        )
        .unwrap();
        assert_eq!(own[0].replies.len(), 1);
        let own_id = own[0].replies[0].id.clone();
        withdraw_comment(root.clone(), "doc.md".into(), own_id, "alice".into(), 3).unwrap();

        let hidden = withdraw_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            4,
        )
        .unwrap();
        assert!(hidden.is_empty());

        let visible = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            "late own reply".into(),
            false,
            false,
            5,
        )
        .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].body, "");
        assert_eq!(visible[0].withdrawn_at, Some(4));
        assert_eq!(visible[0].replies[0].withdrawn_at, Some(3));
        assert_eq!(visible[0].replies[1].body, "late own reply");

        let visible = reply_comment(
            root,
            "doc.md".into(),
            thread_id,
            "bob".into(),
            "late other reply".into(),
            false,
            false,
            6,
        )
        .unwrap();
        assert_eq!(
            visible[0]
                .replies
                .iter()
                .map(|r| r.body.as_str())
                .collect::<Vec<_>>(),
            vec!["", "late own reply", "late other reply"]
        );
    }

    #[test]
    fn correction_serializes_with_address_and_replies() {
        use std::sync::mpsc;

        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "root".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        let transaction = store.comment_transaction();
        let (started, ready) = mpsc::channel();
        let concurrent_root = root.clone();
        let concurrent_id = thread_id.clone();
        let address = std::thread::spawn(move || {
            started.send(()).unwrap();
            address_with_ai(
                concurrent_root,
                "doc.md".into(),
                concurrent_id,
                "alice".into(),
                3,
                "run-1".into(),
                None,
            )
        });
        ready.recv().unwrap();
        transaction
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: mint_id(),
                    parent_id: Some(thread_id.clone()),
                    author: "alice".into(),
                    timestamp: 2,
                    kind: EventKind::Withdraw,
                },
            )
            .unwrap();
        drop(transaction);
        assert!(matches!(
            address.join().unwrap(),
            Err(CommandError::InvalidDocument(_))
        ));
        assert!(store.fold_comments(doc_id).unwrap().threads[&thread_id]
            .pending_run
            .is_none());

        let second_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "second".into(),
            None,
            4,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.id != thread_id)
        .unwrap()
        .id;
        let transaction = store.comment_transaction();
        let (started, ready) = mpsc::channel();
        let concurrent_root = root.clone();
        let concurrent_id = second_id.clone();
        let correction = std::thread::spawn(move || {
            started.send(()).unwrap();
            withdraw_comment(
                concurrent_root,
                "doc.md".into(),
                concurrent_id,
                "alice".into(),
                6,
            )
        });
        ready.recv().unwrap();
        transaction
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: mint_id(),
                    parent_id: Some(second_id.clone()),
                    author: "alice".into(),
                    timestamp: 5,
                    kind: address_event("run-2", None, false),
                },
            )
            .unwrap();
        drop(transaction);
        assert!(matches!(
            correction.join().unwrap(),
            Err(CommandError::CorrectionRefused(reason)) if reason.contains("Addressing with AI")
        ));
        assert!(store.fold_comments(doc_id).unwrap().threads[&second_id]
            .withdrawn_at
            .is_none());

        let third_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "third".into(),
            None,
            7,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.body == "third")
        .unwrap()
        .id;
        let transaction = store.comment_transaction();
        let (started, ready) = mpsc::channel();
        let concurrent_root = root.clone();
        let concurrent_id = third_id.clone();
        let correction = std::thread::spawn(move || {
            started.send(()).unwrap();
            withdraw_comment(
                concurrent_root,
                "doc.md".into(),
                concurrent_id,
                "alice".into(),
                9,
            )
        });
        ready.recv().unwrap();
        transaction
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: mint_id(),
                    parent_id: Some(third_id.clone()),
                    author: "bob".into(),
                    timestamp: 8,
                    kind: EventKind::Reply {
                        body: "known child".into(),
                        defense: false,
                        published: false,
                        run_id: None,
                    },
                },
            )
            .unwrap();
        drop(transaction);
        assert!(matches!(
            correction.join().unwrap(),
            Err(CommandError::CorrectionRefused(reason)) if reason == "Delete replies first."
        ));
        let third = &store.fold_comments(doc_id).unwrap().threads[&third_id];
        assert_eq!(third.body, "third");
        assert_eq!(third.replies[0].body, "known child");

        let fourth_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "fourth".into(),
            None,
            10,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.body == "fourth")
        .unwrap()
        .id;
        let transaction = store.comment_transaction();
        let (started, ready) = mpsc::channel();
        let concurrent_root = root.clone();
        let concurrent_id = fourth_id.clone();
        let batch = std::thread::spawn(move || {
            started.send(()).unwrap();
            address_all_with_ai(
                concurrent_root,
                "doc.md".into(),
                vec![concurrent_id],
                "alice".into(),
                12,
                "batch-1".into(),
            )
        });
        ready.recv().unwrap();
        transaction
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: mint_id(),
                    parent_id: Some(fourth_id.clone()),
                    author: "alice".into(),
                    timestamp: 11,
                    kind: EventKind::Withdraw,
                },
            )
            .unwrap();
        drop(transaction);
        let outcome = batch.join().unwrap().unwrap();
        assert_eq!(outcome.progress.skipped, vec![fourth_id]);
        assert!(outcome.progress.addressed.is_empty());
    }

    #[test]
    fn ordinary_reply_uses_the_comment_write_lane() {
        let (_dir, root) = project("Hello world");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("doc.md").unwrap();
        let thread_id = mint_id();
        let transaction = store.comment_transaction();
        transaction
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: thread_id.clone(),
                    parent_id: None,
                    author: "alice".into(),
                    timestamp: 1,
                    kind: EventKind::Create {
                        anchor: None,
                        body: "root".into(),
                        severity: None,
                        skill: None,
                        workflow_run: None,
                    },
                },
            )
            .unwrap();
        drop(transaction);
        let threads = reply_comment(
            root,
            "doc.md".into(),
            thread_id,
            "bob".into(),
            "child".into(),
            false,
            false,
            2,
        )
        .unwrap();
        assert_eq!(threads[0].replies[0].body, "child");
    }

    #[test]
    fn correction_requires_descendants_to_be_withdrawn_first() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "root".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let bob_id = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "bob".into(),
            "Bob's reply".into(),
            false,
            false,
            2,
        )
        .unwrap()[0]
            .replies[0]
            .id
            .clone();
        let carol_id = reply_comment(
            root.clone(),
            "doc.md".into(),
            bob_id.clone(),
            "carol".into(),
            "Carol's nested reply".into(),
            false,
            false,
            3,
        )
        .unwrap()[0]
            .replies[1]
            .id
            .clone();
        let dana_id = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "dana".into(),
            "Dana's sibling reply".into(),
            false,
            false,
            4,
        )
        .unwrap()[0]
            .replies[2]
            .id
            .clone();
        resolve_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            5,
        )
        .unwrap();

        for (target, author) in [(&thread_id, "alice"), (&bob_id, "bob")] {
            assert!(matches!(
                withdraw_comment(
                    root.clone(), "doc.md".into(), target.clone(), author.into(), 6,
                ),
                Err(CommandError::CorrectionRefused(reason)) if reason == "Delete replies first."
            ));
        }
        let (store, id, doc) = open_doc(&root, "doc.md").unwrap();
        let current = resolved_threads(&store, id, &doc).unwrap();
        assert_eq!(current[0].body, "root");
        assert_eq!(
            current[0]
                .replies
                .iter()
                .map(|reply| reply.body.as_str())
                .collect::<Vec<_>>(),
            [
                "Bob's reply",
                "Carol's nested reply",
                "Dana's sibling reply"
            ]
        );

        withdraw_comment(root.clone(), "doc.md".into(), carol_id, "carol".into(), 7).unwrap();
        withdraw_comment(
            root.clone(),
            "doc.md".into(),
            bob_id.clone(),
            "bob".into(),
            8,
        )
        .unwrap();
        let late_grandchild_id = reply_comment(
            root.clone(),
            "doc.md".into(),
            bob_id,
            "eve".into(),
            "late grandchild".into(),
            false,
            false,
            9,
        )
        .unwrap()[0]
            .replies[3]
            .id
            .clone();
        assert!(matches!(
            withdraw_comment(
                root.clone(), "doc.md".into(), thread_id.clone(), "alice".into(), 10,
            ),
            Err(CommandError::CorrectionRefused(reason)) if reason == "Delete replies first."
        ));
        withdraw_comment(root.clone(), "doc.md".into(), dana_id, "dana".into(), 11).unwrap();
        assert!(matches!(
            withdraw_comment(
                root.clone(), "doc.md".into(), thread_id.clone(), "alice".into(), 12,
            ),
            Err(CommandError::CorrectionRefused(reason)) if reason == "Delete replies first."
        ));
        withdraw_comment(
            root.clone(),
            "doc.md".into(),
            late_grandchild_id,
            "eve".into(),
            13,
        )
        .unwrap();
        let historical =
            withdraw_comment(root, "doc.md".into(), thread_id, "alice".into(), 14).unwrap();
        assert_eq!(historical.len(), 1);
        assert_eq!(historical[0].body, "");
        assert_eq!(historical[0].withdrawn_at, Some(14));
        assert!(historical[0]
            .replies
            .iter()
            .all(|reply| reply.body.is_empty()));
    }

    #[test]
    fn correction_refuses_targeted_runs_and_only_withdrawal_for_undecided_changes() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "first".into(),
            None,
            1,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        let file = store.comment_author_file(doc_id, "alice");
        store
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: "targeted".into(),
                    parent_id: Some(thread_id.clone()),
                    author: "alice".into(),
                    timestamp: 2,
                    kind: EventKind::Address {
                        run_id: "run-1".into(),
                        guidance: None,
                        started: false,
                    },
                },
            )
            .unwrap();
        let before = fs::read_to_string(&file).unwrap();
        assert!(matches!(
            revise_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                "second".into(),
                3
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert!(matches!(
            withdraw_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                3
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert_eq!(fs::read_to_string(&file).unwrap(), before);

        conclude_address_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            4,
            "run-1".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            5,
            vec!["change-1".into()],
        )
        .unwrap();
        let revised = revise_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            "second".into(),
            6,
        )
        .unwrap();
        assert_eq!(revised[0].body, "second");
        let before_withdraw = fs::read_to_string(&file).unwrap();
        assert!(matches!(
            withdraw_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                7
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert_eq!(fs::read_to_string(&file).unwrap(), before_withdraw);

        decide_linked_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            8,
            vec!["change-1".into()],
            LinkedChangeDecision::Reject,
        )
        .unwrap();
        assert!(
            withdraw_comment(root, "doc.md".into(), thread_id, "alice".into(), 9)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn correction_withdrawn_root_is_skipped_by_batch_address() {
        let (_dir, root) = project("Hello world");
        let hidden_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "remove".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let live_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "keep".into(),
            None,
            2,
        )
        .unwrap()
        .into_iter()
        .find(|thread| thread.id != hidden_id)
        .unwrap()
        .id;
        withdraw_comment(
            root.clone(),
            "doc.md".into(),
            hidden_id.clone(),
            "alice".into(),
            3,
        )
        .unwrap();
        assert!(matches!(
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                hidden_id.clone(),
                "alice".into(),
                4,
                "run-1".into(),
                None
            ),
            Err(CommandError::InvalidDocument(_))
        ));
        let outcome = address_all_with_ai(
            root,
            "doc.md".into(),
            vec![hidden_id.clone(), live_id.clone()],
            "alice".into(),
            4,
            "batch-1".into(),
        )
        .unwrap();
        assert_eq!(outcome.progress.skipped, vec![hidden_id]);
        assert_eq!(outcome.progress.addressed, vec![live_id]);
    }

    #[test]
    fn pathless_id_commands_accumulate_and_resolve_against_live_unicode_content() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let id = SidecarStore::new(&root).mint_doc_id().to_string();
        let content = "🎉 hello".to_string();

        let created = create_comment_by_id(
            root.clone(),
            id.clone(),
            content.clone(),
            "alice".into(),
            "note".into(),
            Some(AnchorRange {
                content: content.clone(),
                utf16_offset: 3,
                utf16_length: 5,
            }),
            1,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        assert_eq!(created[0].anchor.as_ref().unwrap().text_snapshot, "hello");
        assert!(!dir.path().join("doc.md").exists());

        let replied = reply_comment_by_id(
            root.clone(),
            id.clone(),
            content.clone(),
            thread_id.clone(),
            "bob".into(),
            "reply".into(),
            false,
            false,
            2,
        )
        .unwrap();
        assert_eq!(replied[0].replies.len(), 1);
        assert!(
            resolve_comment_by_id(
                root.clone(),
                id.clone(),
                content.clone(),
                thread_id.clone(),
                "alice".into(),
                3,
            )
            .unwrap()[0]
                .resolved
        );
        assert!(
            !reopen_comment_by_id(
                root.clone(),
                id.clone(),
                content.clone(),
                thread_id.clone(),
                "alice".into(),
                4,
            )
            .unwrap()[0]
                .resolved
        );
        let moved_content = "🎉 hello again".to_string();
        let reanchored = re_anchor_comment_by_id(
            root.clone(),
            id.clone(),
            moved_content.clone(),
            thread_id,
            "alice".into(),
            5,
            AnchorRange {
                content: moved_content.clone(),
                utf16_offset: 9,
                utf16_length: 5,
            },
        )
        .unwrap();
        assert_eq!(
            reanchored[0].anchor.as_ref().unwrap().text_snapshot,
            "again"
        );
        assert_eq!(
            load_comment_threads_by_id(root, id, moved_content)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn pathless_legacy_defense_refuses_two_pending_runs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let doc_id = SidecarStore::new(&root).mint_doc_id().to_string();
        let created = create_comment_by_id(
            root.clone(),
            doc_id.clone(),
            "text".into(),
            "alice".into(),
            "note".into(),
            None,
            1,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        let (store, id, _) = open_doc_by_id(&root, &doc_id, "text".into()).unwrap();
        for (run_id, timestamp) in [("run-1", 2), ("run-2", 3)] {
            store
                .append_comment_event(
                    id,
                    &CommentEvent {
                        schema_version: comments::SCHEMA_VERSION,
                        id: mint_id(),
                        parent_id: Some(thread_id.clone()),
                        author: "you".into(),
                        timestamp,
                        kind: address_event(run_id, None, false),
                    },
                )
                .unwrap();
        }

        let refused = reply_comment_by_id(
            root.clone(),
            doc_id,
            "text".into(),
            thread_id.clone(),
            "agent".into(),
            "No change needed".into(),
            true,
            false,
            4,
        );
        assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        assert!(store.fold_comments(id).unwrap().threads[&thread_id]
            .replies
            .is_empty());
    }

    #[test]
    fn pathless_manual_resolve_refuses_a_stale_direct_call_with_undecided_changes() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let doc_id = store.mint_doc_id();
        let id = doc_id.to_string();
        let content = "draft".to_string();
        let thread_id = create_comment_by_id(
            root.clone(),
            id.clone(),
            content.clone(),
            "alice".into(),
            "Fix this".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let address_id = mint_id();
        store
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: address_id.clone(),
                    parent_id: Some(thread_id.clone()),
                    author: "alice".into(),
                    timestamp: 2,
                    kind: EventKind::Address {
                        run_id: "old-run".into(),
                        guidance: None,
                        started: true,
                    },
                },
            )
            .unwrap();
        store
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: mint_id(),
                    parent_id: Some(address_id),
                    author: "agent".into(),
                    timestamp: 3,
                    kind: EventKind::LinkChanges {
                        change_ids: vec!["change-1".into()],
                    },
                },
            )
            .unwrap();
        assert!(store.fold_comments(doc_id).unwrap().threads[&thread_id]
            .linked_changes
            .iter()
            .any(|change| change.decision.is_none()));

        let refused =
            resolve_comment_by_id(root, id, content, thread_id.clone(), "alice".into(), 4);
        assert!(matches!(refused, Err(CommandError::ClosureRefused(_))));
        assert!(!store.fold_comments(doc_id).unwrap().threads[&thread_id].resolved);
    }

    #[test]
    fn pathless_correction_uses_the_existing_id_and_same_refusals() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let doc_id = store.mint_doc_id();
        let id = doc_id.to_string();
        let original_content = "🎉 hello".to_string();
        let root_id = create_comment_by_id(
            root.clone(),
            id.clone(),
            original_content.clone(),
            "alice".into(),
            "first".into(),
            Some(AnchorRange {
                content: original_content,
                utf16_offset: 3,
                utf16_length: 5,
            }),
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        let alice_log = store.comment_author_file(doc_id, "alice");
        let original_log = fs::read_to_string(&alice_log).unwrap();
        let live_content = "prefix 🎉 hello".to_string();

        assert!(matches!(
            revise_comment_by_id(
                root.clone(),
                id.clone(),
                live_content.clone(),
                root_id.clone(),
                "bob".into(),
                "forged".into(),
                2,
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert_eq!(fs::read_to_string(&alice_log).unwrap(), original_log);
        assert!(!store.comment_author_file(doc_id, "bob").exists());

        let revised = revise_comment_by_id(
            root.clone(),
            id.clone(),
            live_content.clone(),
            root_id.clone(),
            "alice".into(),
            "second".into(),
            3,
        )
        .unwrap();
        assert_eq!(revised[0].body, "second");
        assert_eq!(
            revised[0].anchor.as_ref().unwrap().offset,
            "prefix 🎉 ".len()
        );

        let replied = reply_comment_by_id(
            root.clone(),
            id.clone(),
            live_content.clone(),
            root_id.clone(),
            "alice".into(),
            "child".into(),
            false,
            false,
            4,
        )
        .unwrap();
        let child_id = replied[0].replies[0].id.clone();
        let before_refusal = fs::read_to_string(&alice_log).unwrap();
        assert!(matches!(
            withdraw_comment_by_id(
                root.clone(),
                id.clone(),
                live_content.clone(),
                root_id.clone(),
                "alice".into(),
                5,
            ),
            Err(CommandError::CorrectionRefused(_))
        ));
        assert_eq!(fs::read_to_string(&alice_log).unwrap(), before_refusal);

        withdraw_comment_by_id(
            root.clone(),
            id.clone(),
            live_content.clone(),
            child_id,
            "alice".into(),
            6,
        )
        .unwrap();
        assert!(withdraw_comment_by_id(
            root.clone(),
            id.clone(),
            live_content.clone(),
            root_id,
            "alice".into(),
            7,
        )
        .unwrap()
        .is_empty());
        assert!(load_comment_threads_by_id(root, id, live_content)
            .unwrap()
            .is_empty());
        assert!(fs::read_to_string(alice_log)
            .unwrap()
            .starts_with(&original_log));
        assert!(!dir.path().join("doc.md").exists());
    }

    /// `src/comments/types.ts`'s `CommentThread` mirrors `ThreadWire` by hand in plain (not
    /// camelCase) field names — nothing on the TS side catches this struct's `Serialize` drifting
    /// into camelCase the way `run_queue.rs`'s identical pinned-wire-shape tests explain (a
    /// `ConcludedRunWire` field renamed to `runId` would leave both suites green and the frontend
    /// silently reading `undefined`).
    #[test]
    fn concluded_run_wire_serializes_with_plain_snake_case_field_names() {
        let wire = ConcludedRunWire {
            run_id: "run-1".to_string(),
            outcome: comments::RunConclusion::Stopped,
        };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!({ "run_id": "run-1", "outcome": "stopped" })
        );
    }

    // --- create -----------------------------------------------------------------

    #[test]
    fn create_comment_with_no_anchor_makes_a_document_level_thread() {
        let (_dir, root) = project("Hello world");
        let threads = create_comment(
            root,
            "doc.md".into(),
            "alice".into(),
            "please clarify".into(),
            None,
            0,
        )
        .unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].body, "please clarify");
        assert_eq!(threads[0].last_activity_at, 0);
        assert_eq!(
            serde_json::to_value(&threads[0]).unwrap()["last_activity_at"],
            0
        );
        assert!(threads[0].anchor.is_none());
        assert!(!threads[0].resolved);
        assert!(!threads[0].orphaned);
    }

    #[test]
    fn create_comment_with_an_anchor_captures_the_selected_range() {
        let (_dir, root) = project("Hello world");
        let threads = create_comment(
            root,
            "doc.md".into(),
            "alice".into(),
            "why here?".into(),
            Some(AnchorRange {
                content: "Hello world".into(),
                utf16_offset: 6,
                utf16_length: 5,
            }),
            0,
        )
        .unwrap();
        let anchor = threads[0].anchor.as_ref().unwrap();
        assert_eq!(anchor.text_snapshot, "world");
    }

    // Pins PR #495's review Critical: CodeMirror's selection is a UTF-16 code-unit range, but
    // `create_comment` used to feed it straight to `Anchor::new`, which indexes a UTF-8 **byte**
    // string — no bounds check, no char-boundary check. With one 2-byte character ("é") before
    // the selection, UTF-16 offset 6 (the true start of "world") lands one byte early if misread
    // as a byte offset, silently capturing " worl" instead — the non-panicking, confidently-wrong
    // case P2/D17 forbid. (Confirmed RED pre-fix, against the then-`offset`/`length`-only
    // `AnchorRange`: failed with " worl", not "world".)
    #[test]
    fn create_comment_with_non_ascii_content_before_the_selection_captures_the_correct_text() {
        let (_dir, root) = project("héllo world");
        let threads = create_comment(
            root,
            "doc.md".into(),
            "alice".into(),
            "why here?".into(),
            Some(AnchorRange {
                content: "héllo world".into(),
                utf16_offset: 6,
                utf16_length: 5,
            }),
            0,
        )
        .unwrap();
        let anchor = threads[0].anchor.as_ref().unwrap();
        assert_eq!(anchor.text_snapshot, "world");
    }

    // Pins the other half of the same Critical: the anchor must come from the live buffer text
    // the frontend actually measured its selection against, not a re-read of `path`'s on-disk
    // copy — an unsaved edit is the ordinary state of an editing session (no save-before-create),
    // so the two are routinely different. Deliberately a shorter disk file than the live buffer,
    // so an offset valid in the buffer would be out of bounds (or land on the wrong text) if
    // this command still read from disk.
    #[test]
    fn create_comment_anchors_against_the_live_buffer_text_not_a_stale_disk_copy() {
        let (_dir, root) = project("Hello world");
        let live_buffer = "Hello brave new world";
        let threads = create_comment(
            root,
            "doc.md".into(),
            "alice".into(),
            "why here?".into(),
            Some(AnchorRange {
                content: live_buffer.into(),
                utf16_offset: 12,
                utf16_length: 3,
            }), // "new"
            0,
        )
        .unwrap();
        let anchor = threads[0].anchor.as_ref().unwrap();
        assert_eq!(anchor.text_snapshot, "new");
    }

    #[test]
    fn create_comment_rejects_a_path_escaping_root() {
        let (_dir, root) = project("Hello world");
        let err = create_comment(
            root,
            "../escape.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        );
        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    // --- reply / resolve / reopen -------------------------------------------------

    #[test]
    fn reply_appends_in_causal_order_and_resolve_marks_the_thread_resolved() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "please clarify".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = created[0].id.clone();

        let after_reply = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "bob".into(),
            "on it".into(),
            false,
            false,
            1,
        )
        .unwrap();
        assert_eq!(after_reply[0].replies.len(), 1);
        assert_eq!(after_reply[0].replies[0].author, "bob");
        assert!(!after_reply[0].resolved);

        let after_resolve =
            resolve_comment(root, "doc.md".into(), thread_id, "alice".into(), 2).unwrap();
        assert!(after_resolve[0].resolved);
    }

    #[test]
    fn reopen_after_resolve_unresolves_the_thread() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = created[0].id.clone();
        resolve_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            1,
        )
        .unwrap();

        let after_reopen =
            reopen_comment(root, "doc.md".into(), thread_id, "bob".into(), 2).unwrap();

        assert!(!after_reopen[0].resolved);
    }

    // --- orphan detection + manual re-anchor --------------------------------------

    #[test]
    fn an_anchor_whose_text_survives_unchanged_is_never_orphaned() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            Some(AnchorRange {
                content: "Hello world".into(),
                utf16_offset: 6,
                utf16_length: 5,
            }),
            0,
        )
        .unwrap();
        // Re-load without touching the document at all: same revision, definitely not orphaned.
        let reloaded = load_comment_threads_on(
            &root,
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();
        assert_eq!(reloaded[0].id, created[0].id);
        assert!(!reloaded[0].orphaned);
    }

    #[test]
    fn an_anchor_whose_text_is_completely_rewritten_orphans_on_reload() {
        let (dir, root) = project("Hello world, this stays put as anchor context padding");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            Some(AnchorRange {
                content: "Hello world, this stays put as anchor context padding".into(),
                utf16_offset: 0,
                utf16_length: 5,
            }), // "Hello"
            0,
        )
        .unwrap();
        assert!(!created[0].orphaned);

        // Rewrite the document so the anchored text ("Hello") is gone entirely and nothing
        // shares tokens with its old snapshot/context (D17 rule (a): no candidate clears the
        // similarity threshold).
        fs::write(
            dir.path().join("doc.md"),
            "A totally different paragraph replaces every single word that used to be here.",
        )
        .unwrap();

        let reloaded = load_comment_threads_on(
            &root,
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();
        assert!(reloaded[0].orphaned);
        // The original quote survives the orphan (D17: "never silently dropped").
        assert_eq!(reloaded[0].anchor.as_ref().unwrap().text_snapshot, "Hello");
    }

    #[test]
    fn manual_re_anchor_commits_a_new_live_position_and_clears_orphaned() {
        let (dir, root) = project("Hello world, this stays put as anchor context padding");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            Some(AnchorRange {
                content: "Hello world, this stays put as anchor context padding".into(),
                utf16_offset: 0,
                utf16_length: 5,
            }),
            0,
        )
        .unwrap();
        let thread_id = created[0].id.clone();

        let rewritten = "A totally different paragraph replaces every single word in here now.";
        fs::write(dir.path().join("doc.md"), rewritten).unwrap();
        let orphaned = load_comment_threads_on(
            &root.clone(),
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();
        assert!(orphaned[0].orphaned);

        // User selects "totally" (utf16 offset 2, length 7) as the new home and confirms.
        let after = re_anchor_comment(
            root,
            "doc.md".into(),
            thread_id,
            "alice".into(),
            5,
            AnchorRange {
                content: rewritten.into(),
                utf16_offset: 2,
                utf16_length: 7,
            },
        )
        .unwrap();

        assert!(!after[0].orphaned);
        assert_eq!(after[0].anchor.as_ref().unwrap().text_snapshot, "totally");
    }

    // Pins issue #517: `re_anchor_comment` had `create_comment`'s exact pre-#495 defect, latent —
    // a raw offset/length treated as UTF-8 bytes when CodeMirror hands them over in UTF-16 code
    // units. Mirrors `create_comment_with_non_ascii_content_before_the_selection_captures_the_
    // correct_text`'s exact numbers: "héllo world"'s "wo" starts at UTF-16 offset 6 but byte
    // offset 7 ('é' is 2 bytes/1 UTF-16 unit) — an unconverted offset lands one byte short, on the
    // space before "world", not "world" itself.
    #[test]
    fn re_anchor_comment_anchors_against_utf16_offsets_not_byte_offsets() {
        let (dir, root) = project("Hello world, this stays put as anchor context padding");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            Some(AnchorRange {
                content: "Hello world, this stays put as anchor context padding".into(),
                utf16_offset: 0,
                utf16_length: 5,
            }), // "Hello"
            0,
        )
        .unwrap();
        let thread_id = created[0].id.clone();

        let rewritten = "héllo world, replaced entirely for this test's own good";
        fs::write(dir.path().join("doc.md"), rewritten).unwrap();
        let orphaned = load_comment_threads_on(
            &root.clone(),
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();
        assert!(orphaned[0].orphaned);

        let after = re_anchor_comment(
            root,
            "doc.md".into(),
            thread_id,
            "alice".into(),
            5,
            AnchorRange {
                content: rewritten.into(),
                utf16_offset: 6,
                utf16_length: 5,
            }, // "world"
        )
        .unwrap();

        assert!(!after[0].orphaned);
        assert_eq!(after[0].anchor.as_ref().unwrap().text_snapshot, "world");
    }

    // Pins the other half of #517's latent defect: the anchor must come from the live buffer text
    // the frontend measured its new-home selection against, not a re-read of `path`'s on-disk
    // copy (mirrors `create_comment_anchors_against_the_live_buffer_text_not_a_stale_disk_copy`).
    // Deliberately a shorter/different disk file than the live buffer, so an offset valid in the
    // buffer would be out of bounds (or land on the wrong text) if this command still read from
    // disk instead of `content`.
    #[test]
    fn re_anchor_comment_anchors_against_the_live_buffer_text_not_a_stale_disk_copy() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = created[0].id.clone();

        // Disk still holds "Hello world" — the live buffer the user actually selected the new
        // home text against has since diverged (an unsaved edit).
        let live_buffer = "Hello brave new world";
        let after = re_anchor_comment(
            root,
            "doc.md".into(),
            thread_id,
            "alice".into(),
            5,
            AnchorRange {
                content: live_buffer.into(),
                utf16_offset: 12,
                utf16_length: 3,
            }, // "new"
        )
        .unwrap();

        assert_eq!(after[0].anchor.as_ref().unwrap().text_snapshot, "new");
    }

    #[test]
    fn resolving_an_unknown_thread_id_is_a_quiet_no_op_not_an_error() {
        // A resolve event whose parent_id never arrives buffers forever (P5's defined dangling
        // semantics) rather than erroring — this command layer doesn't add its own validation on
        // top, it just reflects the fold's own defined behavior.
        let (_dir, root) = project("Hello world");
        let threads = resolve_comment(
            root,
            "doc.md".into(),
            "nonexistent".into(),
            "alice".into(),
            0,
        )
        .unwrap();
        assert!(threads.is_empty());
    }

    // --- address with AI: pending / delivery / decide (P2a-19, FR-CMT-2/3/4/7) ----

    fn thread_id_for(threads: &[ThreadWire]) -> String {
        threads[0].id.clone()
    }

    #[test]
    fn address_with_ai_marks_the_thread_pending() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);

        let pending = address_with_ai(
            root,
            "doc.md".into(),
            thread_id,
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        assert_eq!(pending[0].pending_run.as_deref(), Some("run-1"));
        assert!(pending[0].linked_changes.is_empty());
        // The single-thread path's dispatch *is* its start (issue #1778) — contrast the batch
        // path's own `pending_run_started: false` fallback, pinned above.
        assert!(pending[0].pending_run_started);
    }

    #[test]
    fn link_changes_clears_pending_and_exposes_undecided_linked_changes() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let delivered = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            2,
            vec!["chg-1".into(), "chg-2".into()],
        )
        .unwrap();

        assert!(delivered[0].pending_run.is_none());
        assert_eq!(delivered[0].linked_changes.len(), 2);
        assert!(delivered[0]
            .linked_changes
            .iter()
            .all(|c| c.decision.is_none()));
    }

    #[test]
    fn link_changes_requires_run_identity_when_two_targets_are_pending() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let refused = link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            3,
            vec!["chg-1".into()],
        );
        assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        let (store, id, doc) = open_doc(&root, "doc.md").unwrap();
        let after = resolved_threads(&store, id, &doc).unwrap();
        assert!(after[0].linked_changes.is_empty());
    }

    #[test]
    fn link_changes_for_run_keeps_the_other_target_pending() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let delivered = link_changes_for_run(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            3,
            vec!["chg-1".into()],
            "run-1".into(),
        )
        .unwrap();
        assert_eq!(
            delivered[0].linked_changes[0].run_id.as_deref(),
            Some("run-1")
        );
        assert_eq!(delivered[0].pending_run.as_deref(), Some("run-2"));
    }

    #[test]
    fn duplicate_address_events_refuse_ambiguous_explicit_delivery() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for timestamp in [1, 2] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                "run-1".into(),
                None,
            )
            .unwrap();
        }
        let refused = link_changes_for_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            3,
            vec!["chg-1".into()],
            "run-1".into(),
        );
        assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        assert!(store.fold_comments(id).unwrap().threads[&thread_id]
            .linked_changes
            .is_empty());
    }

    #[test]
    fn duplicate_address_events_refuse_explicit_defense() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for timestamp in [1, 2] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                "run-1".into(),
                None,
            )
            .unwrap();
        }
        let refused = reply_comment_for_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            "No change needed".into(),
            true,
            false,
            3,
            "run-1".into(),
        );
        assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        assert!(store.fold_comments(id).unwrap().threads[&thread_id]
            .replies
            .is_empty());
    }

    #[test]
    fn defense_requires_run_identity_when_two_targets_are_pending() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let refused = reply_comment(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "agent".into(),
            "No change needed".into(),
            true,
            false,
            3,
        );
        assert!(matches!(refused, Err(CommandError::InvalidDocument(_))));
        let (store, id, doc) = open_doc(&root, "doc.md").unwrap();
        let after = resolved_threads(&store, id, &doc).unwrap();
        assert!(after[0].replies.is_empty());
    }

    #[test]
    fn reply_comment_for_run_concludes_only_the_named_target() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let delivered = reply_comment_for_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            "No change needed".into(),
            true,
            false,
            3,
            "run-1".into(),
        )
        .unwrap();
        assert_eq!(delivered[0].pending_run.as_deref(), Some("run-2"));
        assert_eq!(delivered[0].replies[0].parent_id, thread_id);
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        let log = std::fs::read_to_string(store.comment_author_file(id, "agent")).unwrap();
        let defense: CommentEvent = serde_json::from_str(log.lines().last().unwrap()).unwrap();
        assert!(matches!(defense.kind,
            EventKind::Reply { run_id: Some(run), defense: true, .. } if run == "run-1"));
    }

    #[test]
    fn late_explicit_delivery_for_stopped_run_keeps_new_target_pending() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();
        conclude_address_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            2,
            "run-1".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            3,
            "run-2".into(),
            None,
        )
        .unwrap();

        let linked = link_changes_for_run(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            4,
            vec!["chg-1".into()],
            "run-1".into(),
        )
        .unwrap();
        assert_eq!(linked[0].linked_changes[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(linked[0].pending_run.as_deref(), Some("run-2"));

        let defended = reply_comment_for_run(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            "No further change".into(),
            true,
            false,
            5,
            "run-1".into(),
        )
        .unwrap();
        assert_eq!(defended[0].pending_run.as_deref(), Some("run-2"));
        assert_eq!(defended[0].replies.len(), 1);
    }

    // --- conclude_address_run: stop/fail without delivery (issue #1381) -----------

    #[test]
    fn conclude_address_run_stopped_clears_pending_and_carries_the_stopped_outcome() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let after = conclude_address_run(
            root,
            "doc.md".into(),
            thread_id,
            "emend".into(),
            2,
            "run-1".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();

        assert!(after[0].pending_run.is_none());
        let concluded = after[0]
            .concluded_run
            .as_ref()
            .expect("a stopped run leaves a note");
        assert_eq!(concluded.run_id, "run-1");
        assert_eq!(concluded.outcome, comments::RunConclusion::Stopped);
    }

    #[test]
    fn conclude_address_run_failed_carries_the_failed_outcome() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let after = conclude_address_run(
            root,
            "doc.md".into(),
            thread_id,
            "emend".into(),
            2,
            "run-1".into(),
            comments::RunConclusion::Failed,
        )
        .unwrap();

        assert!(after[0].pending_run.is_none());
        assert_eq!(
            after[0].concluded_run.as_ref().unwrap().outcome,
            comments::RunConclusion::Failed
        );
    }

    /// The correctness guard this command exists to protect at the IPC boundary (mirrors
    /// `store::comments`'s own fold-level guard): a conclusion naming a run this thread has since
    /// moved past — a re-delegation already minted a new run id — must not clear the new run's
    /// pending state.
    #[test]
    fn conclude_address_run_for_a_superseded_run_id_is_a_no_op() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            2,
            "run-2".into(),
            Some("try the other wording".into()),
        )
        .unwrap();

        let after = conclude_address_run(
            root,
            "doc.md".into(),
            thread_id,
            "emend".into(),
            3,
            "run-1".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();

        assert_eq!(after[0].pending_run.as_deref(), Some("run-2"));
        assert!(after[0].concluded_run.is_none());
    }

    // --- load_comment_threads_on: startup reconciliation (issue #1381) ------------

    /// The card's own headline guarantee: a marker naming a run id absent from `known_run_ids` (a
    /// restart's fresh, empty `RunQueue`) is reconciled to failed the moment the document is next
    /// loaded, rather than reading Working forever.
    #[test]
    fn load_comment_threads_on_reconciles_a_pending_run_with_no_live_run_backing_it() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let reloaded = load_comment_threads_on(
            &root,
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 5,
        )
        .unwrap();

        assert!(
            reloaded[0].pending_run.is_none(),
            "a marker with no live run behind it must not read Working forever"
        );
        assert_eq!(
            reloaded[0].concluded_run.as_ref().unwrap().outcome,
            comments::RunConclusion::Failed,
            "§2's last exit row: reconciled markers carry the failed note regardless of the original cause"
        );
    }

    #[test]
    fn load_reconciles_each_missing_run_without_failing_a_known_target() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let known: HashSet<String> = ["run-2".into()].into_iter().collect();
        let loaded =
            load_comment_threads_on(&root, "doc.md", &known, &ReconciledDocs::default(), || 5)
                .unwrap();
        assert_eq!(loaded[0].pending_run.as_deref(), Some("run-2"));
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        let folded = store.fold_comments(id).unwrap();
        assert_eq!(folded.threads[&thread_id].pending_addresses.len(), 1);
        assert_eq!(
            folded.threads[&thread_id].pending_addresses[0].run_id,
            "run-2"
        );
    }

    #[test]
    fn revision_remains_refused_with_two_pending_runs() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "original".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let refused = revise_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            "rewritten".into(),
            3,
        );
        assert!(matches!(refused, Err(CommandError::CorrectionRefused(_))));
        let (store, id, _) = open_doc(&root, "doc.md").unwrap();
        assert_eq!(
            store.fold_comments(id).unwrap().threads[&thread_id].body,
            "original"
        );
    }

    #[test]
    fn default_batch_admission_still_skips_two_pending_targets() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let queue = RunQueue::new(|_request: &RunRequest| {
            Err(SessionError::Spawn(std::io::Error::other("must not spawn")))
        });
        let outcome = start_address_run_on(
            &queue,
            root.clone(),
            "doc.md".into(),
            vec![thread_id.clone()],
            "you".into(),
            3,
            "address".into(),
            "".into(),
            true,
            None,
        )
        .unwrap();
        assert_eq!(outcome.progress.skipped, vec![thread_id]);
        assert!(outcome.run.is_none());
    }

    #[test]
    fn thread_wire_exposes_both_pending_runs_without_a_false_primary() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        for (run, timestamp) in [("run-1", 1), ("run-2", 2)] {
            address_with_ai(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                timestamp,
                run.into(),
                None,
            )
            .unwrap();
        }
        let (store, id, doc) = open_doc(&root, "doc.md").unwrap();
        let both = resolved_threads(&store, id, &doc).unwrap();
        assert!(both[0].pending_run.is_none());
        assert_eq!(
            both[0]
                .pending_runs
                .iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-1", "run-2"]
        );
        conclude_address_run(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "emend".into(),
            3,
            "run-1".into(),
            comments::RunConclusion::Stopped,
        )
        .unwrap();
        let one = resolved_threads(&store, id, &doc).unwrap();
        assert_eq!(one[0].pending_run.as_deref(), Some("run-2"));
        assert_eq!(one[0].pending_runs.len(), 1);
    }

    /// The negative case a naive "always reconcile" implementation would get wrong: a thread whose
    /// run genuinely is still running (its id is in `known_run_ids`) must be left exactly as
    /// Working — this is the guard that keeps an ordinary in-progress run from being reconciled
    /// away out from under the user mid-turn.
    #[test]
    fn load_comment_threads_on_leaves_a_pending_run_alone_while_its_id_is_still_live() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let known: HashSet<String> = ["run-1".to_string()].into_iter().collect();
        let reloaded =
            load_comment_threads_on(&root, "doc.md", &known, &ReconciledDocs::default(), || 5)
                .unwrap();

        assert_eq!(reloaded[0].pending_run.as_deref(), Some("run-1"));
        assert!(reloaded[0].concluded_run.is_none());
    }

    /// `known_run_ids` itself treats a run as known regardless of phase (a resolved-but-not-yet-
    /// evicted run stays in the set) — this pins that a *reconciling* load honours that inclusion
    /// exactly like the still-running case above. (The load-time race this shape of defect can
    /// cause — a batch's own trailing per-thread delivery events racing a reconciling load — is
    /// closed at a different layer: `ReconciledDocs`' once-per-process gate below means a document
    /// already reconciled never re-checks `known_run_ids` at all on a later load, which is what the
    /// real #1381-review e2e regression needed. This test covers `known_run_ids`' own inclusion
    /// rule for the one case where a reconciling load *does* still consult it — its very first.)
    #[test]
    fn load_comment_threads_on_leaves_a_pending_run_alone_while_its_run_is_known_but_resolved() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        // "run-1" is known (e.g. it sits in the queue's own `active` slot, already `Failed`) but not
        // "still running" — exactly `RunQueueState::known_run_ids`'s contract for a resolved-but-not-
        // yet-evicted run.
        let known: HashSet<String> = ["run-1".to_string()].into_iter().collect();
        let reloaded =
            load_comment_threads_on(&root, "doc.md", &known, &ReconciledDocs::default(), || 5)
                .unwrap();

        assert_eq!(
            reloaded[0].pending_run.as_deref(),
            Some("run-1"),
            "a resolved-but-known run must not be reconciled away — its own trailing delivery events \
             may still be landing for another thread"
        );
        assert!(reloaded[0].concluded_run.is_none());
    }

    /// Reconciliation must not fire twice for the same lost run across two consecutive loads of the
    /// *same* `ReconciledDocs` (the production shape — one instance, managed Tauri state, for the
    /// life of the process): the second load skips `reconcile_lost_runs` outright (the gate), and
    /// the state it already wrote on the first load stands — this pins that the *reload itself* is
    /// idempotent end to end, including the note, without asserting a second append happened.
    #[test]
    fn load_comment_threads_on_is_idempotent_across_repeated_loads_of_a_lost_run() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id,
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let reconciled = ReconciledDocs::default();
        let _first =
            load_comment_threads_on(&root, "doc.md", &HashSet::new(), &reconciled, || 5).unwrap();
        let second =
            load_comment_threads_on(&root, "doc.md", &HashSet::new(), &reconciled, || 6).unwrap();

        assert!(second[0].pending_run.is_none());
        assert_eq!(
            second[0].concluded_run.as_ref().unwrap().outcome,
            comments::RunConclusion::Failed
        );
    }

    /// The exact real-world sequence #1381's own review caught as a regression against the D23
    /// driver (the e2e batch address journey): a document's *first* load happens before anything is
    /// pending (a no-op reconciliation that still flips the gate); a batch then marks two threads
    /// pending under a run id `known_run_ids` has never heard of (in dev-mode/e2e a UI-triggered run
    /// never reaches the real backend queue at all — `timeline/agentActivity.ts`'s `startRun`, D23/
    /// #696/#1721 — so this is the everyday case there, not an edge case); one thread's delivery
    /// lands for real; a *second* load (mirroring `reopenAfterBackendChange`) must leave the other,
    /// still-undelivered thread exactly as Working — the gate having already flipped on the first
    /// load is what stops this second load from ever consulting `known_run_ids` (which would
    /// otherwise, correctly by its own contract, call an unknown id stale and reconcile it away
    /// mid-delivery).
    #[test]
    fn load_comment_threads_on_never_reconciles_a_documents_second_load_even_against_an_unknown_run_id(
    ) {
        let (_dir, root) = project("Hello world");
        let reconciled = ReconciledDocs::default();

        // First load: nothing pending yet — a no-op reconciliation, but the gate flips regardless.
        let first =
            load_comment_threads_on(&root, "doc.md", &HashSet::new(), &reconciled, || 0).unwrap();
        assert!(first.is_empty());

        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "finding A".into(),
            None,
            1,
        )
        .unwrap();
        let thread_a = created[0].id.clone();
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "finding B".into(),
            None,
            2,
        )
        .unwrap();
        let thread_b = created
            .iter()
            .find(|t| t.id != thread_a)
            .unwrap()
            .id
            .clone();

        // A batch stamps both threads pending under one run id `known_run_ids` has never named —
        // the empty set stands in for dev-mode/e2e's client-minted id, never registered anywhere.
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_a.clone(),
            "you".into(),
            3,
            "run-batch".into(),
            None,
        )
        .unwrap();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_b.clone(),
            "you".into(),
            4,
            "run-batch".into(),
            None,
        )
        .unwrap();

        // Thread A's delivery lands for real; thread B's never does — the FR-AGENT-6/J4 shape the
        // e2e journey exercises.
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_a,
            "agent".into(),
            5,
            vec!["chg-1".into()],
        )
        .unwrap();

        let second =
            load_comment_threads_on(&root, "doc.md", &HashSet::new(), &reconciled, || 6).unwrap();
        let reloaded_b = second.iter().find(|t| t.id == thread_b).unwrap();
        assert_eq!(
            reloaded_b.pending_run.as_deref(),
            Some("run-batch"),
            "a document's second load must not reconcile a thread whose delivery may still be \
             landing, even against a run id this process's queue never knew about at all"
        );
        assert!(reloaded_b.concluded_run.is_none());
    }

    #[test]
    fn a_clock_skewed_link_changes_delivery_still_clears_and_names_its_address_run() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            3_000,
            "run-skew".into(),
            None,
        )
        .unwrap();

        let delivered = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            2_000,
            vec!["chg-1".into()],
        )
        .unwrap();

        assert_eq!(
            (
                delivered[0].pending_run.as_deref(),
                delivered[0].linked_changes[0].run_id.as_deref(),
            ),
            (None, Some("run-skew")),
        );
    }

    #[test]
    fn a_delivered_change_carries_its_run_and_delivery_attribution_on_the_wire() {
        // #1380: the wire must carry enough for a caller to name the delivery, not just the count.
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let delivered = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            2,
            vec!["chg-1".into()],
        )
        .unwrap();

        let change = &delivered[0].linked_changes[0];
        assert_eq!(change.run_id.as_deref(), Some("run-1"));
        assert_eq!(change.delivered_at, 2);
        assert!(!change.delivery_id.is_empty());
    }

    #[test]
    fn re_delegated_deliveries_carry_distinct_attribution_on_the_wire() {
        // FR-CMT-7: a twice-re-delegated thread's undecided changes must each name their own
        // delivery, never collapse onto one shared attribution.
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            2,
            vec!["chg-1".into()],
        )
        .unwrap();
        decide_linked_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            3,
            vec!["chg-1".into()],
            comments::LinkedChangeDecision::Reject,
        )
        .unwrap();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            4,
            "run-2".into(),
            None,
        )
        .unwrap();

        let delivered = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            5,
            vec!["chg-2".into()],
        )
        .unwrap();

        let by_id: std::collections::HashMap<&str, &LinkedChangeWire> = delivered[0]
            .linked_changes
            .iter()
            .map(|c| (c.change_id.as_str(), c))
            .collect();
        let first = by_id["chg-1"];
        let second = by_id["chg-2"];
        assert_eq!(first.run_id.as_deref(), Some("run-1"));
        assert_eq!(second.run_id.as_deref(), Some("run-2"));
        assert_ne!(first.delivery_id, second.delivery_id);
    }

    #[test]
    fn accepting_both_linked_changes_resolves_the_thread_and_clears_reopened() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            1,
            vec!["chg-1".into(), "chg-2".into()],
        )
        .unwrap();

        let after = decide_linked_changes(
            root,
            "doc.md".into(),
            thread_id,
            "you".into(),
            2,
            vec!["chg-1".into(), "chg-2".into()],
            comments::LinkedChangeDecision::Accept,
        )
        .unwrap();

        assert!(after[0].resolved);
        assert!(!after[0].reopened);
    }

    #[test]
    fn manual_resolve_refuses_undecided_linked_change_without_appending() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "Please revise".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            2,
            vec!["change-1".into()],
        )
        .unwrap();
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("doc.md").unwrap().unwrap();
        let before = store.fold_comments(doc_id).unwrap();
        let author_log = store.comment_author_file(doc_id, "alice");
        let before_log = fs::read(&author_log).unwrap();

        let refused = resolve_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            3,
        );
        assert!(matches!(
            refused,
            Err(CommandError::ClosureRefused(reason))
                if reason.contains("Accept") && reason.contains("reject")
        ));
        let after = store.fold_comments(doc_id).unwrap();
        assert!(!after.threads[&thread_id].resolved);
        assert_eq!(fs::read(author_log).unwrap(), before_log);
        assert_eq!(
            after.threads[&thread_id].linked_changes,
            before.threads[&thread_id].linked_changes
        );
    }

    #[test]
    fn delivery_after_manual_resolve_reopens_the_thread_with_undecided_work() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "Please revise".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            2,
            "run-1".into(),
            None,
        )
        .unwrap();
        let closed = resolve_comment(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            3,
        )
        .unwrap();
        assert!(closed[0].resolved);
        assert_eq!(closed[0].pending_run.as_deref(), Some("run-1"));

        let delivered = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            4,
            vec!["change-1".into()],
        )
        .unwrap();
        assert!(!delivered[0].resolved);
        assert!(delivered[0].linked_changes[0].decision.is_none());
    }

    #[test]
    fn empty_link_changes_after_manual_resolve_preserves_the_closure() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "Please revise".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            2,
            "run-1".into(),
            None,
        )
        .unwrap();
        assert!(
            resolve_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                3,
            )
            .unwrap()[0]
                .resolved
        );

        let after =
            link_changes(root, "doc.md".into(), thread_id, "agent".into(), 4, vec![]).unwrap();
        assert!(after[0].resolved);
        assert!(after[0].linked_changes.is_empty());
    }

    #[test]
    fn duplicate_only_link_changes_after_manual_resolve_preserves_the_closure() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "Please revise".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            2,
            vec!["change-1".into()],
        )
        .unwrap();
        decide_linked_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            3,
            vec!["change-1".into()],
            LinkedChangeDecision::Reject,
        )
        .unwrap();
        assert!(
            resolve_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                4,
            )
            .unwrap()[0]
                .resolved
        );

        let after = link_changes(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            5,
            vec!["change-1".into()],
        )
        .unwrap();
        assert!(after[0].resolved);
        assert_eq!(after[0].linked_changes.len(), 1);
        assert_eq!(
            after[0].linked_changes[0].decision,
            Some(LinkedChangeDecision::Reject)
        );
    }

    #[test]
    fn defense_reply_after_manual_resolve_preserves_the_closure() {
        let (_dir, root) = project("Hello world");
        let thread_id = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "Please revise".into(),
            None,
            1,
        )
        .unwrap()[0]
            .id
            .clone();
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "alice".into(),
            2,
            "run-1".into(),
            None,
        )
        .unwrap();
        assert!(
            resolve_comment(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "alice".into(),
                3,
            )
            .unwrap()[0]
                .resolved
        );

        let delivered = reply_comment(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            "No change needed".into(),
            true,
            false,
            4,
        )
        .unwrap();
        assert!(delivered[0].resolved);
        assert!(delivered[0].pending_run.is_none());
        assert!(delivered[0].replies[0].defense);
    }

    #[test]
    fn rejecting_a_linked_change_reopens_the_thread() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        link_changes(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "agent".into(),
            1,
            vec!["chg-1".into()],
        )
        .unwrap();

        let after = decide_linked_changes(
            root,
            "doc.md".into(),
            thread_id,
            "you".into(),
            2,
            vec!["chg-1".into()],
            comments::LinkedChangeDecision::Reject,
        )
        .unwrap();

        assert!(!after[0].resolved);
        assert!(after[0].reopened);
    }

    #[test]
    fn a_defense_reply_carries_its_publish_flag_and_a_defense_reply_is_marked() {
        let (_dir, root) = project("Hello world");
        let created = create_comment(
            root.clone(),
            "doc.md".into(),
            "alice".into(),
            "x".into(),
            None,
            0,
        )
        .unwrap();
        let thread_id = thread_id_for(&created);
        address_with_ai(
            root.clone(),
            "doc.md".into(),
            thread_id.clone(),
            "you".into(),
            1,
            "run-1".into(),
            None,
        )
        .unwrap();

        let after = reply_comment(
            root,
            "doc.md".into(),
            thread_id,
            "agent".into(),
            "the wording is already correct".into(),
            true,
            true,
            2,
        )
        .unwrap();

        assert!(
            after[0].pending_run.is_none(),
            "the defense concludes the pending run"
        );
        let reply = &after[0].replies[0];
        assert!(reply.defense);
        assert!(reply.published);
    }

    // --- batch address (P2b-3a, FR-CMT-5/D8, J4 Batch, FR-AGENT-6) -----------------

    /// Creates `n` open document-level threads and returns their ids in wire (id-sorted) order.
    fn open_threads(root: &str, n: usize) -> Vec<String> {
        let mut threads = Vec::new();
        for i in 0..n {
            threads = create_comment(
                root.into(),
                "doc.md".into(),
                "alice".into(),
                format!("finding {i}"),
                None,
                i as i64,
            )
            .unwrap();
        }
        threads.into_iter().map(|t| t.id).collect()
    }

    /// FR-AGENT-6, the invariant this card exists to protect: a batch that dies part-way leaves the
    /// threads it finished **addressed**, the threads it never started **untouched**, and says
    /// which is which. Exercised against the real accounting loop with an append that fails on the
    /// third thread — the failure mode being guarded is silent sidecar corruption across N threads.
    #[test]
    fn an_interrupted_batch_keeps_completed_threads_and_leaves_unstarted_ones_untouched() {
        let ids: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
        let mut attempted = Vec::new();

        let progress = run_batch_address(
            &ids,
            |id| !id.is_empty(),
            |id| {
                attempted.push(id.to_string());
                if id == "t2" {
                    Err(CommandError::Io("disk went away".into()))
                } else {
                    Ok(())
                }
            },
        );

        // Completed groups stand.
        assert_eq!(progress.addressed, vec!["t0", "t1"]);
        // The thread that failed and everything after it are untouched — never half-addressed.
        assert_eq!(progress.untouched, vec!["t2", "t3", "t4"]);
        // And the outcome is honest that it stopped early, with the reason.
        assert!(
            progress.interrupted.is_some(),
            "an interrupted batch must say so"
        );
        // It really did stop: t3/t4 were never even attempted.
        assert_eq!(attempted, vec!["t0", "t1", "t2"]);
    }

    #[test]
    fn a_batch_that_completes_reports_every_thread_addressed_and_nothing_interrupted() {
        let ids: Vec<String> = (0..3).map(|i| format!("t{i}")).collect();

        let progress = run_batch_address(&ids, |_| true, |_| Ok(()));

        assert_eq!(progress.addressed, ids);
        assert!(progress.untouched.is_empty());
        assert!(progress.skipped.is_empty());
        assert!(progress.interrupted.is_none());
    }

    /// The accounting contract is "every targeted id lands in **exactly one** bucket". A repeated
    /// id would otherwise be addressed twice against a single pre-loop eligibility snapshot — two
    /// Address events on one thread, and the id listed twice in `addressed`. Collapsing repeats
    /// keeps the buckets a true partition of the target set no matter what the caller passes.
    #[test]
    fn a_repeated_target_id_is_addressed_once_and_counted_once() {
        let ids = vec!["t0".to_string(), "t1".to_string(), "t0".to_string()];
        let mut addressed = Vec::new();

        let progress = run_batch_address(
            &ids,
            |_| true,
            |id| {
                addressed.push(id.to_string());
                Ok(())
            },
        );

        assert_eq!(
            addressed,
            vec!["t0", "t1"],
            "a repeated id is written once, not twice"
        );
        assert_eq!(progress.addressed, vec!["t0", "t1"]);
        assert!(
            progress.skipped.is_empty(),
            "a repeat is not a skip — it is not a distinct target"
        );
    }

    /// An ineligible thread (already resolved, or already mid-run) is *skipped*, not addressed —
    /// and skipping never stops the batch. A stray Address event on a resolved thread would
    /// mis-resolve a real user comment, which is exactly the corruption this guard prevents.
    #[test]
    fn ineligible_threads_are_skipped_without_stopping_the_batch() {
        let ids: Vec<String> = (0..4).map(|i| format!("t{i}")).collect();
        let mut addressed = Vec::new();

        let progress = run_batch_address(
            &ids,
            |id| id != "t1",
            |id| {
                addressed.push(id.to_string());
                Ok(())
            },
        );

        assert_eq!(progress.addressed, vec!["t0", "t2", "t3"]);
        assert_eq!(progress.skipped, vec!["t1"]);
        assert!(progress.untouched.is_empty());
        assert!(
            !addressed.contains(&"t1".to_string()),
            "a skipped thread is never written"
        );
    }

    /// Every targeted thread carries the batch run id — the transition landed on the same
    /// `pending_run` field the single path uses (issue #350: single and batch cannot drift). But
    /// **not** the single path's own claim of Working (issue #1778, ux-design.md §2 "Batch …
    /// Working means started, not targeted", UXR-Q10/#1122): this build has no per-thread signal
    /// to say any one of these three has actually started, so none of them may claim it —
    /// `pending_run_started` stays false on every one, and the run card is the only progress
    /// surface for the whole run.
    #[test]
    fn batch_address_targets_every_thread_without_claiming_any_of_them_started() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 3);

        let outcome = address_all_with_ai(
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            "you".into(),
            10,
            "batch-run-1".into(),
        )
        .unwrap();

        assert_eq!(outcome.progress.addressed, ids);
        assert!(outcome.progress.interrupted.is_none());
        for thread in &outcome.threads {
            assert_eq!(
                thread.pending_run.as_deref(),
                Some("batch-run-1"),
                "every targeted thread carries the batch run id"
            );
            assert!(
                !thread.pending_run_started,
                "targeting alone is not per-thread start evidence — no thread may claim Working"
            );
        }
    }

    /// A resolved thread handed to the batch is skipped, and — critically — stays resolved.
    #[test]
    fn batch_address_skips_a_resolved_thread_and_leaves_it_resolved() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 2);
        resolve_comment(
            root.clone(),
            "doc.md".into(),
            ids[0].clone(),
            "you".into(),
            5,
        )
        .unwrap();

        let outcome = address_all_with_ai(
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            "you".into(),
            10,
            "batch-run-1".into(),
        )
        .unwrap();

        assert_eq!(outcome.progress.skipped, vec![ids[0].clone()]);
        assert_eq!(outcome.progress.addressed, vec![ids[1].clone()]);
        let resolved = outcome.threads.iter().find(|t| t.id == ids[0]).unwrap();
        assert!(
            resolved.resolved,
            "a skipped thread keeps its resolved state"
        );
        assert!(
            resolved.pending_run.is_none(),
            "and never gains a pending run"
        );
    }

    /// J4's filter dimensions (source / severity / review pass) are selected frontend-side, so the
    /// wire has to actually carry them — without these three fields the filter set cannot exist.
    #[test]
    fn the_wire_carries_the_three_filter_dimensions() {
        let (_dir, root) = project("Hello world");
        let store = SidecarStore::new(&root);
        let id = store.get_or_mint_for_path("doc.md").unwrap();
        store
            .append_comment_event(
                id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: "thread-1".into(),
                    parent_id: None,
                    author: "reviewer".into(),
                    timestamp: 0,
                    kind: EventKind::Create {
                        anchor: None,
                        body: "quote is off".into(),
                        severity: Some("high".into()),
                        skill: Some("biblical-accuracy".into()),
                        workflow_run: Some("run-42".into()),
                    },
                },
            )
            .unwrap();

        let threads = load_comment_threads_on(
            &root,
            "doc.md",
            &HashSet::new(),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();

        assert_eq!(threads[0].severity.as_deref(), Some("high"));
        assert_eq!(threads[0].skill.as_deref(), Some("biblical-accuracy"));
        assert_eq!(threads[0].workflow_run.as_deref(), Some("run-42"));
    }

    /// J4 edge state: two comments targeting overlapping text get **one shared change** linked to
    /// both threads, and both resolve when it's accepted. No new primitive — this pins that the
    /// existing link/decide path already satisfies the edge case, so batch can rely on it.
    #[test]
    fn one_shared_change_linked_to_two_threads_resolves_both_on_accept() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 2);

        for thread_id in &ids {
            link_changes(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "agent".into(),
                10,
                vec!["shared-chg".into()],
            )
            .unwrap();
        }

        let mut after = Vec::new();
        for thread_id in &ids {
            after = decide_linked_changes(
                root.clone(),
                "doc.md".into(),
                thread_id.clone(),
                "you".into(),
                11,
                vec!["shared-chg".into()],
                comments::LinkedChangeDecision::Accept,
            )
            .unwrap();
        }

        assert!(
            after.iter().all(|t| t.resolved),
            "both threads sharing the accepted change resolve"
        );
        assert!(after.iter().all(|t| t.linked_changes.len() == 1));
    }

    // --- the batch's append window (#538) -------------------------------------------------------

    /// Makes `path` unwritable and returns its original permissions, so a test can put it back.
    /// The fault a batch then hits is a real `store::service` write failure against a real file —
    /// nothing about the batch's own code path is substituted (test-plan §4: never mock in e2e,
    /// and this seam exists to serve exactly that e2e). Assumes the suite runs as an ordinary user;
    /// as root the read-only bit is ignored, and the tests using this fail loudly rather than pass
    /// vacuously.
    fn make_unwritable(path: &Path) -> fs::Permissions {
        let original = fs::metadata(path).unwrap().permissions();
        let mut read_only = original.clone();
        read_only.set_readonly(true);
        fs::set_permissions(path, read_only).unwrap();
        original
    }

    /// #538: the window fires once per *landed* append, naming the sidecar file the batch is
    /// appending to — the two facts a caller needs to place a fault between two specific appends.
    #[test]
    fn the_append_window_fires_once_per_landed_append_and_names_the_sidecar_written() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 3);
        let mut window = Vec::new();

        let outcome = address_all_with_ai_watching(
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            "you".into(),
            10,
            "batch-run-1".into(),
            |landed, sidecar| window.push((landed, sidecar.to_path_buf())),
        )
        .unwrap();

        assert_eq!(outcome.progress.addressed, ids);
        assert_eq!(
            window.iter().map(|(landed, _)| *landed).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "one call per landed append, counting up"
        );
        let sidecar = &window[0].1;
        assert!(
            window.iter().all(|(_, path)| path == sidecar),
            "every append in one batch targets the same per-author log"
        );
        assert!(
            sidecar.is_file(),
            "and that file is the one really being written"
        );
    }

    /// FR-AGENT-6 end to end, without a mock (#538): a fault landing in the window makes the very
    /// next *real* append fail, and the batch reports the partial truth — the completed thread
    /// stays addressed on disk, the unstarted ones are genuinely untouched.
    #[test]
    fn a_fault_in_the_append_window_interrupts_the_batch_against_the_real_store() {
        let (_dir, root) = project("Hello world");
        let ids = open_threads(&root, 3);
        let mut restore = None;

        let outcome = address_all_with_ai_watching(
            root.clone(),
            "doc.md".into(),
            ids.clone(),
            "you".into(),
            10,
            "batch-run-1".into(),
            |landed, sidecar| {
                if landed == 1 {
                    restore = Some((sidecar.to_path_buf(), make_unwritable(sidecar)));
                }
            },
        )
        .unwrap();

        // Put the file back before asserting, so a failing assertion can't strand a read-only
        // file in the temp dir this test still has to clean up.
        let (sidecar, original) = restore.expect("the window ran at least once");
        fs::set_permissions(&sidecar, original).unwrap();

        assert_eq!(outcome.progress.addressed, vec![ids[0].clone()]);
        assert_eq!(
            outcome.progress.untouched,
            vec![ids[1].clone(), ids[2].clone()],
            "the failed thread and everything after it are untouched"
        );
        assert!(
            outcome.progress.interrupted.is_some(),
            "an interrupted batch says so, with the real store's own reason"
        );

        // The truth on disk, re-read from the store: exactly one thread is pending under the run.
        let threads = load_comment_threads_on(
            &root,
            "doc.md",
            // The batch is still known/live here. An empty queue would correctly reconcile its
            // marker as a lost run; this cell tests partial append truth before that lifecycle.
            &HashSet::from(["batch-run-1".to_string()]),
            &ReconciledDocs::default(),
            || 0,
        )
        .unwrap();
        let pending: Vec<&ThreadWire> = threads
            .iter()
            .filter(|t| t.pending_run.as_deref() == Some("batch-run-1"))
            .collect();
        assert_eq!(
            pending.len(),
            1,
            "the completed thread keeps its address event"
        );
        assert_eq!(pending[0].id, ids[0]);
    }
}
