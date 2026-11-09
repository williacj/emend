// ABOUTME: The comment thread wire shapes (P2a-18/P2a-19, TD-4) — mirrors Rust `commands::comments`'s
// ABOUTME: `ThreadWire`/`ReplyWire`/`LinkedChangeWire` (cross-boundary types defined in Rust, mirrored
// ABOUTME: here) — plus the pure derivations ux-design.md §2 defines over them: which state a thread
// ABOUTME: displays, which rung of the acknowledgment ladder it sits at, and whether it collapses.

/** Mirrors `textops::Anchor` (`Serialize`) — TD-4/TD-6's shared anchor shape. */
export interface Anchor {
  offset: number;
  length: number;
  text_snapshot: string;
  context_before: string;
  context_after: string;
  base_revision: string;
}

/** Mirrors `commands::comments::ReplyWire`. `published` (FR-CMT-4/D20) is a defense reply's
 * publish-to-external-reviewer flag — local visibility state only (D20's sync mechanics are Phase
 * 4); meaningless (always `false`) on a non-defense reply. */
export interface CommentReply {
  id: string;
  /** The direct parent id; a withdrawn intermediary still preserves nested ancestry. */
  parent_id: string;
  author: string;
  body: string;
  defense: boolean;
  published: boolean;
  /** D24/J10: latest superseding-body and withdrawal times; null on untouched replies. */
  edited_at: number | null;
  withdrawn_at: number | null;
}

/** Keep (`accept`) or discard (`reject`) a linked tracked change — mirrors
 * `store::comments::LinkedChangeDecision`/`editor/trackedChanges.ts`'s `Decision`. */
export type LinkedChangeDecision = "accept" | "reject";

/** Latest admitted Address-with-AI run for a comment, including its submit-time D31 fact. */
export interface CommentRunLink { runId: string; sentText: boolean }

/** How an address run ended without delivering — mirrors `store::comments::RunConclusion`
 * (`#[serde(rename_all = "snake_case")]`). `"failed"` also covers ux-design.md §2's last exit row:
 * a marker reconciled at load time because no live run answers to it any more (issue #1381). */
export type RunConclusionOutcome = "stopped" | "failed";

/** The most recent address run this thread saw end without delivering — mirrors
 * `commands::comments::ConcludedRunWire`. `null` while a run is pending (`pending_run` set) or
 * none has ever concluded that way; see `CommentThread.concluded_run`'s own doc for when this
 * clears. */
export interface ConcludedRun {
  run_id: string;
  outcome: RunConclusionOutcome;
}

/** Every still-pending Address, including a deliberately overlapping queued target (J4). */
export interface PendingRun {
  run_id: string;
  address_event_id: string;
  started: boolean;
  guidance: string | null;
  corrected: boolean;
}

/** One tracked change an "Address with AI" run linked to a thread, and its outcome so far
 * (FR-CMT-7) — mirrors `commands::comments::LinkedChangeWire`. `decision: null` is undecided.
 *
 * `delivery_id`/`run_id`/`delivered_at` attribute the change to the delivery that produced it
 * (ux-design.md §2, #1380). A re-delegated
 * thread can carry undecided changes from more than one delivery (FR-CMT-7 preserves per-change
 * outcomes across reopenings) — group on `delivery_id` (unique per delivery, stable even when
 * `run_id` is `null`) to render each under its own name where §2 requires it, in J1's vocabulary
 * (`↳ 2 changes from Agent · 12m ago · [Go to →] [Accept both] [Reject]`). `run_id` is `null` only
 * for a delivery with no preceding "Address with AI"
 * run on this thread (not expected from a conforming writer; tolerated, not assumed).
 * `delivered_at` is milliseconds since the Unix epoch, the same clock as every other comment-event
 * timestamp (`store::comments::CommentEvent.timestamp`). */
export interface LinkedChange {
  change_id: string;
  decision: LinkedChangeDecision | null;
  delivery_id: string;
  run_id: string | null;
  delivered_at: number;
}

/**
 * Mirrors `commands::comments::ThreadWire` — a folded thread (`store::comments::Thread`) with its
 * anchor re-checked against the document's *live* text. `anchor: null` is a document-level thread
 * (FR-CMT-1); `orphaned` is true only for an anchored thread whose text no longer fuzzy-matches
 * (D17) — see the Rust type's doc comment for the exact rule. The original quote is always
 * preserved on `anchor` even when `orphaned` (never silently dropped).
 *
 * `pending_runs` lists every still-pending Address. `pending_run` is the legacy scalar projection,
 * `null` when none or more than one remains; `pending_guidance` belongs to that scalar.
 * `pending_run_started` (issue #1778) is whether `pending_run` has begun genuine per-thread work,
 * as opposed to merely targeting this thread — meaningless while `pending_run` is `null`. See
 * `deriveThreadState`'s own doc for exactly how the two combine.
 * `linked_changes` (FR-CMT-7) accumulates every tracked change any address round linked to this
 * thread; `reopened` is `true` exactly when at least one is rejected and the thread isn't
 * currently `resolved` (ux-design.md §2: "Reopened — a linked change was rejected").
 */
export interface CommentThread {
  id: string;
  author: string;
  /** Most recent accepted TD-4 event in this thread, for the collapsed column's Recency order. */
  last_activity_at: number;
  anchor: Anchor | null;
  body: string;
  /** D24/J10: latest superseding-body and terminal-withdrawal times. */
  edited_at: number | null;
  withdrawn_at: number | null;
  /** Durable D20 publication fact; a root is private until explicitly published. */
  published: boolean;
  /** The fold's FR-CMT-9 placeholder decision after withdrawal. */
  visible_when_withdrawn: boolean;
  /** Every run that has targeted this thread; correction checks these against the live queue. */
  targeting_run_ids: string[];
  resolved: boolean;
  orphaned: boolean;
  reopened: boolean;
  replies: CommentReply[];
  /** J4's three batch-filter dimensions (FR-CMT-5): `severity` and `skill` (the source that raised
   * the finding — a review skill, or `null` for a human comment) and `workflow_run` (the review
   * pass). All three are `null` on an ordinary human comment. See `batchAddress.ts`. */
  severity: string | null;
  skill: string | null;
  workflow_run: string | null;
  pending_run: string | null;
  /** All pending targets. The scalar above is null when more than one remains. */
  pending_runs: PendingRun[];
  pending_run_started: boolean;
  pending_guidance: string | null;
  /** The most recent address run to end on this thread without delivering — stopped, failed, or
   * reconciled as failed at load time (issue #1381, ux-design.md §2's exit table). `null` while
   * `pending_run` is set, or when nothing has ever concluded that way. Persists until the thread's
   * next event (a reply, resolve, reopen, re-anchor, a fresh address, or a linked-change decision)
   * clears it on the backend — "the user's next action on the thread" the exit table names. */
  concluded_run: ConcludedRun | null;
  linked_changes: LinkedChange[];
}

/** A targeted run holds the comment through partial delivery. A pending marker is conservative
 * until a positive terminal observation clears it, including the admission/event race. */
export function isHeldByLiveRun(
  thread: CommentThread,
  liveRunIds?: readonly string[],
  terminalRunIds?: readonly string[],
): boolean {
  return (thread.targeting_run_ids ?? []).some((id) => liveRunIds?.includes(id) && !terminalRunIds?.includes(id)) ||
    thread.pending_runs.some((pending) => Boolean(pending.run_id) && !terminalRunIds?.includes(pending.run_id)) ||
    (thread.pending_run != null && !terminalRunIds?.includes(thread.pending_run));
}

/** Applies positive terminal queue observations before a delayed sidecar conclusion arrives. */
export function withoutTerminalPendingRuns(
  thread: CommentThread,
  terminalRunIds?: readonly string[],
): CommentThread {
  if (!terminalRunIds?.length) return thread;
  const pending_runs = thread.pending_runs.filter((pending) => !terminalRunIds.includes(pending.run_id));
  const pending_run = thread.pending_runs.length > 0
    ? (pending_runs.length === 1 ? pending_runs[0].run_id : null)
    : (thread.pending_run && terminalRunIds.includes(thread.pending_run) ? null : thread.pending_run);
  const pending_run_started = thread.pending_runs.length > 0
    ? (pending_runs.length === 1 && pending_runs[0].started)
    : (pending_run !== null && thread.pending_run_started);
  const pending_guidance = thread.pending_runs.length > 0
    ? (pending_runs.length === 1 ? pending_runs[0].guidance : null)
    : (pending_run !== null ? thread.pending_guidance : null);
  return { ...thread, pending_runs, pending_run, pending_run_started, pending_guidance };
}

/** J10's working-document status excludes every withdrawn root, including a visible placeholder. */
export function commentCounts(threads: readonly CommentThread[]): { open: number; resolved: number } {
  let open = 0;
  let resolved = 0;
  for (const thread of threads) {
    if (thread.withdrawn_at != null) continue;
    if (thread.resolved) resolved += 1;
    else open += 1;
  }
  return { open, resolved };
}

/**
 * What one `[Address all…]` batch run did, per thread — mirrors
 * `commands::comments::BatchAddressOutcome` (its `BatchProgress` is flattened into this shape).
 *
 * FR-AGENT-6's honesty requirement lives here: every targeted id lands in exactly one of
 * `addressed` (the transition landed — these stand even if the run died later), `skipped` (not
 * eligible: already resolved or already mid-run, never written) or `untouched` (the run was
 * interrupted before reaching them). `interrupted` is the reason it stopped early, `null` on a
 * clean run.
 */
export interface BatchAddressOutcome {
  run_id: string;
  addressed: string[];
  skipped: string[];
  untouched: string[];
  interrupted: string | null;
  threads: CommentThread[];
}

/**
 * The outcome of a batch that has nothing to show for itself — every target untouched, `reason`
 * naming why. Covers two different failures a caller (`TimelinePanel.handleAddressAll`) must not
 * conflate: no run ever existing at all (`start_run` itself rejecting — `runId` is then a fresh
 * client mint, since the backend never assigned one), and a
 * run the backend genuinely accepted whose result the frontend then failed to record (`runId` is
 * then the real id `start_run` returned, and `reason` should name it, so this outcome can't be
 * mistaken for the no-run-at-all case). Neither can be mistaken for a successful batch, and
 * neither has to restate FR-AGENT-6's shape.
 */
export function unrunBatch(runId: string, threadIds: string[], reason: string): BatchAddressOutcome {
  return {
    run_id: runId,
    addressed: [],
    skipped: [],
    untouched: [...threadIds],
    interrupted: reason,
    threads: [],
  };
}

/** The seven thread states ux-design.md §2 defines, with their visual signal:
 * Open (solid accent border) · Working (the `5a.5`/`5b.5` active-run status treatment — an
 * address run has started on this thread and delivered nothing yet, UXR-Q10/#1122) ·
 * Addressed — pending (pulsing/half-filled indicator) · Resolved (dimmed, collapsed) ·
 * Reopened (open + "reopened" badge) · Orphaned (warning chip: "original text changed") ·
 * Suggestion (diff preview + Apply button). */
export type ThreadState =
  | "open"
  | "working"
  | "addressed-pending"
  | "resolved"
  | "reopened"
  | "orphaned"
  | "suggestion";

/**
 * Whether any address run — live or queued, started on this thread or merely targeting it — holds
 * this comment (FR-CMT-2, ux-design.md §2's acknowledgment ladder).
 *
 * Deliberately **falsy**, not `!== null`: `comments/runId.ts` documents that `start_run`'s D23
 * degrade yields an empty id, which every reader must treat as "no run" — and one predicate is
 * what keeps two readers from disagreeing about that value (issue #2228).
 */
export function isHeldByRun(thread: CommentThread): boolean {
  return Boolean(thread.pending_run) || thread.pending_runs.some((pending) => Boolean(pending.run_id));
}

/**
 * Derives six of the seven ux-design.md §2 states from the fold data `ThreadWire` now carries
 * (P2a-19 closed the FR-CMT-7 gap the P2a-18 version of this function documented; UXR-Q10/#1122
 * split **Working** out of what this function used to fold into Addressed — pending): Orphaned
 * (D17, `thread.orphaned`), **Working** (`thread.pending_run` **and** `thread.pending_run_started`
 * — a run is in flight *and has started work on this specific thread*, regardless of what it may
 * also carry from an earlier delivery), Reopened (`thread.reopened`), Resolved/Open
 * (`thread.resolved`), Addressed — pending (linked changes delivered by an earlier run and still
 * awaiting a decision, with no run currently in flight). Only **Suggestion** still depends on data
 * no unit has built yet — a reviewer's proposed-replacement payload (D19) is P2b-3's job.
 *
 * **Targeted but not started (issue #1778, ux-design.md §2 "Batch … Working means started, not
 * targeted", UXR-Q10/#1122).** A batch's own per-thread dispatch sets `pending_run` on every
 * eligible target the moment it fires, but this build has no per-thread signal to say any one of
 * them has actually *started* — so `pending_run_started` stays `false` for the whole run, and
 * nothing here can raise it (reporting real per-thread progress behind a batch is P2a-15's work,
 * #148). A thread in that state is **not** Working: it falls through to whatever it
 * would otherwise be (reopened, resolved, addressed-pending, open) — the acknowledgment ladder's
 * "unchanged" rung, exactly as if no run existed, never a state of its own (the ladder "mints no
 * further states"). The single-thread path always sets `pending_run_started: true` in the same
 * event that sets `pending_run` — dispatch and start are the same event when a run only ever
 * targets one thread — so this distinction is invisible there.
 *
 * The precedence order below is ux-design.md §2's own ("Orphaned → Working → Reopened →
 * Resolved → Addressed — pending → Open") — Working outranks `thread.reopened`,
 * `thread.resolved`, and `thread.linked_changes` alike, because a live, started run is true
 * regardless of what an earlier delivery left behind; only an orphaned anchor outranks it (D17
 * drift mid-run still needs to say so — see `ux-design.md`'s "active-run status is not governed
 * by state precedence").
 *
 * `CommentThreadCard`'s `state` prop lets a caller override this default (e.g. to render
 * Suggestion once P2b-3 supplies that payload); this function only ever returns what's derivable
 * today.
 */
// @anchor:derive-thread-state
export function deriveThreadState(thread: CommentThread): ThreadState {
  if (thread.orphaned) return "orphaned";
  if ((Boolean(thread.pending_run) && thread.pending_run_started) ||
      thread.pending_runs.some((pending) => Boolean(pending.run_id) && pending.started)) return "working";
  if (thread.reopened) return "reopened";
  if (thread.resolved) return "resolved";
  if (thread.linked_changes.length > 0) return "addressed-pending";
  return "open";
}

/**
 * Whether a thread card collapses to one line by default (P2b-1b, ux-design.md §2: Resolved =
 * "Dimmed, collapsed") — every other state (open, working, addressed-pending, reopened, orphaned,
 * suggestion) stays expanded. Collapse is a display-only layer over the seven states, never a
 * replacement for their rendering, so `CommentThreadCard` and `timeline/collapse.ts`'s
 * never-mounted row-height seed both read it here rather than restating the rule and drifting.
 *
 * **Unless a run holds the comment**, which is §2's collapse rule verbatim: "A thread with a live
 * run is in none of those sets." Load-bearing rather than decorative — a resolve taken while a live
 * or queued run holds the thread recomputes it to *resolved*, and collapsing it there would hide
 * the acknowledgment rung underneath, the one thing "the ladder never withdraws a live
 * acknowledgment" forbids (issue #2228). At rung 3 this changes nothing: a started run already
 * reads as *Working*, which was never in the collapse set.
 */
export function isThreadCollapsedByDefault(thread: CommentThread): boolean {
  return thread.withdrawn_at == null && deriveThreadState(thread) === "resolved" && !isHeldByRun(thread);
}

/** Which rung of ux-design.md §2's acknowledgment ladder a thread sits at, or `null` for a thread
 * no run holds. `"queued"` is rung 1, `"targeted"` rung 2, `"working"` rung 3 (the one that is
 * also a [`ThreadState`]). See [`deriveLadderRung`]. */
export type AcknowledgmentRung = "queued" | "targeted" | "working";

/**
 * The rung ux-design.md §2's acknowledgment ladder puts this thread on (UXR-Q10/#1122; issue
 * #2228 built rungs 1-2 and UXR-Q17 worded them name-free — CJ, 2026-09-02). The ladder "mints no
 * further states", so this is deliberately *not* a [`ThreadState`]: it is a second, independent
 * reading of the same thread, and only rung 3 coincides with a state.
 *
 * `queuedRunIds` is the backend-owned run queue's own list (`timeline/agentActivity.ts`'s
 * `RunQueueState.queued`, supplied by `TimelinePanel` from the queued-phase run cards it
 * already keeps, then projected through App props to the editor popover (#2258/TD-15). Rung 1 is claimed on
 * **positive** membership only: a caller that cannot see the queue passes nothing and every held
 * thread reads rung 2. That direction is
 * chosen, not incidental — §2's ladder "never trades a rung down" and forbids claiming what
 * Cowrite cannot observe (Principle 7, FR-X-5), and "queued behind" asserts a run has *not*
 * started, which is exactly the kind of claim a stale or absent queue read would get wrong. Rung
 * 2's line stays true either way, because it says only that a run holds the comment.
 *
 * Unlike [`deriveThreadState`] this is **not** governed by state precedence — §2's exit table
 * keeps the active-run status line on a thread that orphans mid-run, and its "the card never falls
 * silent" guarantee binds whatever the thread would otherwise present as.
 */
export function deriveLadderRung(
  thread: CommentThread,
  queuedRunIds: readonly string[] = [],
): AcknowledgmentRung | null {
  if (!isHeldByRun(thread)) return null;
  if ((Boolean(thread.pending_run) && thread.pending_run_started) ||
      thread.pending_runs.some((pending) => Boolean(pending.run_id) && pending.started)) return "working";
  const pendingIds = thread.pending_runs.map((pending) => pending.run_id).filter(Boolean);
  if (pendingIds.length > 0) return pendingIds.every((id) => queuedRunIds.includes(id)) ? "queued" : "targeted";
  return thread.pending_run && queuedRunIds.includes(thread.pending_run) ? "queued" : "targeted";
}
/** One comment history owner: either a project path or a path-independent untitled UUID. */
export type CommentDocumentOwner =
  | { kind: "path"; path: string }
  | { kind: "id"; docId: string; label: string };
