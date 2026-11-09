// ABOUTME: The comment-thread card (P2a-18/P2a-19, J4, FR-CMT-1/2/3/4/6/7) — renders all seven
// ABOUTME: ux-design.md §2 thread states, every rung of its acknowledgment ladder in one status
// ABOUTME: slot, replies in causal order, resolve/reopen, the orphan [Re-anchor] flow, and
// ABOUTME: address-with-AI's working/pending/accept/reject/re-delegate/defense flow. Also collapses
// ABOUTME: a resolved thread to one line by default (P2b-1b) — a display layer, not a replacement.
import { Check, Pause, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { errorDetail } from "../backend";
import { TimelineCard } from "../timeline/TimelineCard";
import { formatDeliveryRelativeTime, groupLinkedChangesByDelivery } from "./deliveryAttribution";
import { severityLetter } from "./severity";
import {
  deriveLadderRung,
  deriveThreadState,
  isThreadCollapsedByDefault,
  isHeldByLiveRun,
  withoutTerminalPendingRuns,
  type AcknowledgmentRung,
  type Anchor,
  type CommentThread,
  type LinkedChangeDecision,
  type ThreadState,
} from "./types";

/** ux-design.md §2's rung-copy table, all three rungs in one place because §2 gives the ladder one
 * status slot and says "only its words change". Rungs 1-2 are worded name-free by UXR-Q17 (CJ,
 * 2026-09-02, issue #2228), no run display name existing anywhere in this app to put in them; rung
 * 3's line is J10's ratified string, unchanged. The second clause of each is J10's verbatim.
 *
 * Keyed on the whole [`AcknowledgmentRung`] union, not a hand-written subset: a rung the table did
 * not answer would render an empty status line, which is the silence this card exists to close. */
const RUNG_COPY: Record<AcknowledgmentRung, string> = {
  queued:
    "Queued behind an agent run — it already has this comment as written; you can edit or delete it once the run finishes.",
  targeted:
    "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.",
  working: "Addressing with AI — you can edit or delete this comment once the run finishes.",
};

/** The glyph beside each rung's line, `null` where §2 gives it none. Rung 2's absence is a
 * requirement rather than an omission — "no `◔`, no claim of activity" — and rung 1's `⏳` and rung
 * 3's `◔` are §2's own. Decorative in every case: the words carry the distinction, so no rung is
 * told apart by its glyph alone (§2's severity-encoding rule, applied to the ladder). */
const RUNG_GLYPH: Record<AcknowledgmentRung, string | null> = {
  queued: "⏳",
  targeted: null,
  working: "◔",
};

const STATE_LABEL: Record<ThreadState, string> = {
  open: "Open",
  working: "Working",
  "addressed-pending": "Addressed — pending",
  resolved: "Resolved",
  reopened: "Reopened",
  orphaned: "Orphaned",
  suggestion: "Suggestion",
};

/** ux-design.md §2's accessibility rule: severity is never colour alone — always colour + letter,
 * the letter as plain text content (not just an aria-label) so it reads without colour or a screen
 * reader either. Mirrors `timeline/ChangeSetCard.tsx`'s identical chip, kept separate rather than
 * shared: that one takes an already-normalized `ChangeSetSeverity` letter, this one a thread's
 * free-form wire string, and two call sites is Rule of Three's "not yet" (CLAUDE.md). */
function SeverityChip({ severity }: { severity: string }) {
  const letter = severityLetter(severity);
  return (
    <span className="comment-thread-card__severity" data-severity={letter} aria-label={`severity: ${letter}`}>
      ● {letter}
    </span>
  );
}

export interface PendingReAnchorSelection {
  /** The exact live buffer text the selection below was measured against — carried straight
   * through to `onReAnchor` so the backend can recapture the anchor from it (mirrors
   * `CommentPopoverTarget`'s identical `content` field for `create`, PR #495 review's Critical:
   * the backend must never re-derive this from a possibly-stale on-disk read, issue #517). */
  content: string;
  offset: number;
  length: number;
  /** The candidate new-home text, shown so the author can confirm before committing. */
  preview: string;
}

export interface CommentThreadCardProps {
  thread: CommentThread;
  /** Pathless documents support local comment operations only. This removes every agent-run and
   * linked-change decision surface structurally while leaving the component's historical default
   * (rendering inert seams for not-yet-wired callers) unchanged for path-backed documents. */
  localOnly?: boolean;
  /** Seven-way state override (ux-design.md §2); defaults to `deriveThreadState(thread)`. See that
   * function's docs for which states are derived from `thread` itself vs. supplied by a caller
   * that has data no unit has built yet (P2b-3's Suggestion payload). */
  state?: ThreadState;
  onReply: (body: string, defense: boolean) => void;
  onResolve: () => void | Promise<void>;
  onReopen: () => void;
  /** J10: revise/delete only the acting author's own body. Callers return the backend result's
   * completion so a refusal can be shown in this same card. */
  author?: string;
  onRevise?: (targetId: string, body: string) => Promise<void>;
  onWithdraw?: (targetId: string) => Promise<void>;
  /** Orphan-only (D17/J4): commits a confirmed [Re-anchor] — `content` is `pendingSelection`'s own
   * live buffer text, `offset`/`length` its UTF-16 selection within it (never re-derived from a
   * disk read; see `PendingReAnchorSelection`'s docs, issue #517). Omitting it (the default) still
   * renders the orphan card and its [Re-anchor] trigger, just with the confirm step permanently
   * disabled — a caller wires this in once it can supply `pendingSelection` for real. */
  onReAnchor?: (content: string, offset: number, length: number) => void;
  /** The live document selection to confirm into [Re-anchor], once the user picked one after
   * clicking [Re-anchor] (ux-design.md J4: click → select new home text in the doc → confirm).
   * `null`/omitted while nothing is selected yet — Confirm stays disabled. Capturing a real CM6
   * selection is a follow-up (P2a-1's text-selection surface doesn't exist yet); this prop lets
   * that future wiring hand the confirmed range straight through. */
  pendingSelection?: PendingReAnchorSelection | null;
  /** [Address with AI] (FR-CMT-2, J4) on a not-yet-addressed thread — starts the run; spawning it
   * is P2a-15's job (out of scope here), so this only fires the caller's own trigger. Omitting it
   * still renders the button, just inert, matching `onReAnchor`'s "trigger renders regardless"
   * convention. */
  onAddressWithAI?: () => void;
  /** [Try again — add guidance…] on a reopened thread (J4) — re-delegates with `guidance` (the
   * rejection context is already on `thread.linked_changes`, so the caller only needs the note). */
  onReDelegate?: (guidance: string) => void;
  /** [Accept…]/[Reject] on a delivered linked-change block (FR-CMT-3/7) — `changeIds` is every
   * currently-undecided change in that rendered block: thread-wide for J4's ordinary form, or one
   * delivery's subset for §2 attribution. */
  onDecideLinkedChanges?: (changeIds: string[], decision: LinkedChangeDecision) => void;
  /** [Go to →] — scrolls the live editor to a linked change. Never called outside that explicit
   * click (no focus steal, Principle 2); omitted in a caller with no live editor yet. */
  onFocusChange?: (changeId: string) => boolean | void;
  /** Injectable clock (CLAUDE.md: no reliance on real time in tests) — milliseconds since epoch,
   * read once per render to compute each delivery group's `formatDeliveryRelativeTime` (#1380).
   * Mirrors `CommentCard`'s identical `now` prop for stamping outgoing events; this one is
   * read-only (nothing here writes an event), so it defaults straight to `Date.now` rather than
   * threading an explicit override through from a caller that has none to give. */
  now?: () => number;
  /** Clicking a passage route (UX Principle 6: "everything in the panel deep-links into the
   * text") — resolves and scrolls the live editor to this thread's full recorded anchor, even
   * if the passage moved. Distinct from `onFocusChange`,
   * which targets a *linked tracked change*'s range, not the comment's own anchor. Rendered
   * (as a button) whenever `thread.anchor` is set, matching `onReAnchor`/`onAddressWithAI`'s
   * "trigger renders regardless" convention — omitting the callback just makes it inert. A
   * document-level thread (`anchor: null`) has no passage to jump to, so nothing renders. */
  onFocusAnchor?: (anchor: Anchor) => void;
  /** 4e collapsed-column navigation and its submit-time J13 fact; the owner supplies only its
   * latest accepted run, retaining it after completion and tab switches (UXR-Q13.3). The anchor
   * route remains a separate footer action. */
  runLink?: { runId: string; sentText: boolean; onShowRun: (runId: string) => void };
  /** Column-only selection of this whole thread, independent of its nested action controls. */
  onActivate?: () => void;
  activationLabel?: string;
  selected?: boolean;
  /** Fires whenever this card's own effective collapsed state changes — on mount (reporting the
   * initial value) and after every toggle (P2b-1b). Lets a caller (`timeline/CommentCard.tsx`)
   * bubble it up to `TimelinePanel`, which sizes this card's virtualized row from it
   * (`timeline/collapse.ts`'s `itemHeightFor`) without needing to keep this card mounted to know.
   * Omitting it just means the caller doesn't care (e.g. a standalone render in a test).
   *
   * `explicit` distinguishes a value the *user* chose (a click on Expand/Collapse) from one this
   * card's data-driven default merely produced. The caller needs both and must not conflate them:
   * the effective value sizes the row, but only an explicit choice may be pinned back via
   * `initialCollapsed` on remount. Feeding an observed default back as a pin turns every
   * collapse-by-default card into a pinned one after a single scroll cycle, and the default rule
   * never fires again (review finding, PR #481). */
  onCollapsedChange?: (collapsed: boolean, explicit: boolean) => void;
  /** Seeds this card's collapse override on mount from the caller's record of a choice **the user
   * explicitly made** for this card (`TimelinePanel`'s `pinnedCollapsedIds` map, keyed by card id,
   * threaded back down through `CommentCard`). Fixes the round trip through a card leaving the
   * virtualized window: without this, `collapsedOverride` reset to `null` on remount and a user's
   * explicit expand of a resolved thread was silently discarded — the row snapped back collapsed
   * (review finding, PR #481).
   *
   * Pass this **only** for a card whose `onCollapsedChange` reported `explicit: true`. `undefined`
   * (the default — every caller with no such record, and every card the user has merely looked at)
   * leaves the card following `defaultCollapsed`, which is what keeps the collapse-by-default rule
   * live across remounts. */
  initialCollapsed?: boolean;
  /** The backend-owned run queue's own still-queued run ids (`timeline/agentActivity.ts`'s
   * `RunQueueState.queued`, mirrored in `TimelinePanel`'s queued-phase run cards) — what tells
   * ux-design.md §2's rung 1 apart from its rung 2 when a run holds this comment. See
   * [`deriveLadderRung`] for why membership is read positively and what a caller that cannot see
   * the queue gets by passing nothing (the default): rung 2, which stays true either way. */
  queuedRunIds?: readonly string[];
  /** Active and queued run IDs from the timeline's existing run-card projection. A targeting run
   * still holds correction after its first delivery clears `pending_run`, until it is terminal. */
  liveRunIds?: readonly string[];
  /** Positive terminal observations, needed to release a lingering `pending_run` safely. */
  terminalRunIds?: readonly string[];
  /** A local Address command is in flight before its run ID can enter the queue projection. */
  correctionAdmissionPending?: boolean;
  /** The run currently blocked on J7 permission, when any. A matching addressing thread replaces
   * its ordinary Working sentence with the waiting acknowledgment; decision controls remain on
   * the run card, so this prop carries identity only. */
  permissionRunId?: string | null;
}

export function CommentThreadCard({
  thread,
  localOnly = false,
  state,
  onReply,
  onResolve,
  onReopen,
  author = "you",
  onRevise,
  onWithdraw,
  onReAnchor,
  pendingSelection = null,
  onAddressWithAI,
  onReDelegate,
  onDecideLinkedChanges,
  onFocusChange,
  onFocusAnchor,
  runLink,
  onActivate,
  activationLabel,
  selected,
  onCollapsedChange,
  initialCollapsed,
  queuedRunIds,
  liveRunIds,
  terminalRunIds,
  correctionAdmissionPending = false,
  permissionRunId,
  now,
}: CommentThreadCardProps) {
  // The queue can report terminal before the thread's conclusion event clears its pending marker.
  // Treat that marker as settled across state, collapse, and controls in this interim render.
  const effectiveThread = withoutTerminalPendingRuns(thread, terminalRunIds);
  const resolvedState = state ?? deriveThreadState(effectiveThread);
  const [replyBody, setReplyBody] = useState("");
  const [reAnchorArmed, setReAnchorArmed] = useState(false);
  const [guidanceArmed, setGuidanceArmed] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [correction, setCorrection] = useState<{ targetId: string; mode: "edit" | "delete"; body: string } | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const deleteRefusalSawLiveDescendant = useRef(false);
  const deleteRefusalTriggerRef = useRef<HTMLButtonElement>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const correctionRunHeld = correctionAdmissionPending || isHeldByLiveRun(effectiveThread, liveRunIds, terminalRunIds);
  const undecidedLinkedCount = thread.linked_changes.filter((change) => change.decision === null).length;
  const linkedChangePronoun = undecidedLinkedCount === 1 ? "it" : "them";
  const linkedChangeReason = undecidedLinkedCount === 0 ? null
    : `${undecidedLinkedCount} linked ${undecidedLinkedCount === 1 ? "change" : "changes"} still to decide. Accept ${linkedChangePronoun} and this thread resolves; reject ${linkedChangePronoun} and it reopens, and you can dismiss it then.`;
  const startCorrection = (targetId: string, mode: "edit" | "delete", body: string) => {
    setCorrection({ targetId, mode, body });
    setCorrectionError(null);
    setDeleteRefusal(null);
  };
  const cancelCorrection = () => {
    if (correctionBusy) return;
    setCorrection(null);
    setCorrectionError(null);
  };
  const submitResolve = async () => {
    if (resolving || thread.linked_changes.some((change) => change.decision === null)) return;
    setResolving(true);
    setResolutionError(null);
    try {
      await onResolve();
    } catch (error) {
      focusExpandAfterResolveRef.current = false;
      setResolutionError(errorDetail(error, "Could not resolve this comment."));
    } finally {
      setResolving(false);
    }
  };
  const submitRevision = async (targetId: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed || !onRevise || correctionBusy || correctionRunHeld) return;
    setCorrectionBusy(true);
    setCorrectionError(null);
    try {
      await onRevise(targetId, trimmed);
      setCorrection(null);
    } catch (error) {
      setCorrectionError(errorDetail(error, "Could not edit this comment."));
    } finally {
      setCorrectionBusy(false);
    }
  };
  const submitWithdrawal = async (targetId: string) => {
    if (!onWithdraw || correctionBusy || correctionRunHeld) return;
    setCorrectionBusy(true);
    setCorrectionError(null);
    try {
      await onWithdraw(targetId);
      setCorrection(null);
    } catch (error) {
      const detail = errorDetail(error, "Could not delete this comment.");
      if (detail === "Delete replies first.") {
        setCorrection(null);
        setDeleteRefusal(targetId);
      } else {
        setCorrectionError(detail);
      }
    } finally {
      setCorrectionBusy(false);
    }
  };
  // `null` follows the P2b-1b default (collapsed exactly when resolved); a click pins an explicit
  // choice that survives the thread staying resolved (never re-forced shut behind the user's back).
  // Seeded from `initialCollapsed` so that pinned choice also survives this component unmounting
  // and remounting — e.g. scrolling out of and back into the virtualized window. The caller passes
  // it only for a choice the user actually made; staying `null` for the rest is what keeps the
  // default rule live across remounts (review finding, PR #481).
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(initialCollapsed ?? null);
  // Shared with `timeline/collapse.ts`'s never-mounted row-height seed so the two cannot drift,
  // and `null`-safe about a live run: §2's collapse rule is "a thread with a live run is in none
  // of those sets", which is what keeps a resolve taken mid-run from collapsing the card over its
  // own acknowledgment rung (#2228).
  const defaultCollapsed = isThreadCollapsedByDefault(effectiveThread) && !correctionRunHeld;
  const collapsed = correctionRunHeld ? false : (collapsedOverride ?? defaultCollapsed);
  const toggleCollapse = () => setCollapsedOverride(!collapsed);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const focusExpandAfterResolveRef = useRef(false);

  // A successful Resolve changes the same card into its collapsed form. The focused Resolve
  // button then unmounts, so hand keyboard focus to the control that replaces it in that commit.
  // No focus moves on initial resolved render or while the backend request is still pending.
  useLayoutEffect(() => {
    if (!collapsed || !focusExpandAfterResolveRef.current) return;
    focusExpandAfterResolveRef.current = false;
    expandButtonRef.current?.focus();
  }, [collapsed]);

  // Reports the *effective* collapsed value (default or override) to the caller on mount and on
  // every change — the seam `TimelinePanel` sizes this card's virtualized row from without needing
  // to keep it mounted (`timeline/collapse.ts`'s `itemHeightFor` falls back to the same default
  // predicate for anything this never fires for, e.g. an off-screen card) — alongside whether that
  // value is the user's own choice, which is the only thing the caller may pin back on remount.
  useEffect(() => {
    onCollapsedChange?.(collapsed, collapsedOverride !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onCollapsedChange identity shouldn't retrigger
  }, [collapsed, collapsedOverride]);

  const submitReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = replyBody.trim();
    if (!trimmed) return;
    onReply(trimmed, false);
    setReplyBody("");
  };

  const confirmReAnchor = () => {
    if (!pendingSelection || !onReAnchor) return;
    onReAnchor(pendingSelection.content, pendingSelection.offset, pendingSelection.length);
    setReAnchorArmed(false);
  };

  const submitReDelegate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = guidance.trim();
    if (!trimmed) return;
    onReDelegate?.(trimmed);
    setGuidance("");
    setGuidanceArmed(false);
  };

  // FR-CMT-3/7: count-agnostic accept label — "Accept both" is only accurate for the ux-design
  // J4 wireframe's 2-change example; the single-linked-change case ("Address with AI **single**",
  // this card's headline scenario) must not claim to accept two. Computed over the rendered block:
  // per delivery for §2 attribution, thread-wide for J4's ordinary single block (#1380 ruling).
  const acceptLabelFor = (undecidedCount: number) =>
    undecidedCount === 1 ? "Accept" : undecidedCount === 2 ? "Accept both" : "Accept all";
  const linkedChangeGroups = groupLinkedChangesByDelivery(thread.linked_changes);
  const undecidedLinkedChangeIds = thread.linked_changes
    .filter((change) => change.decision === null)
    .map((change) => change.change_id);
  const hasMultipleUndecidedDeliveries =
    linkedChangeGroups.filter((group) => group.changes.some((change) => change.decision === null)).length > 1;
  // CJ's #1380 ruling keeps attribution scoped to §2: Working, or undecided changes from more than
  // one delivery. J4's ordinary single-delivery Addressed — pending card keeps its unattributed count.
  const showAttributedLinkedChanges = resolvedState === "working" || hasMultipleUndecidedDeliveries;
  const deliveryGroupLabelId = useId();
  // Deliberately read once per render, not on a ticking timer: every group's age shares one instant,
  // but an idle card's label stays stale until its next render. A timer is new mechanism not authorized
  // by #1380; this comment records that chosen property rather than leaving it accidental.
  const nowMs = now?.() ?? Date.now();

  const anchor = thread.anchor;
  const anchorLabel = anchor ? `“${anchor.text_snapshot}”` : "Document-level";
  // A run already targets this thread the moment `pending_run` is set — even before it's
  // genuinely started (issue #1778: a batch targets many threads before working any one of them,
  // and `resolvedState` alone can't tell "targeted" apart from no run at all, since the ladder
  // "mints no further states"). ux-design.md §2's acknowledgment ladder replaces every
  // thread-local run-starting affordance the moment a run targets a thread, at every rung — so no
  // run-starting trigger may render while a run holds this comment, regardless of whether it has
  // started (that would double-dispatch a run this thread already has).
  // Which rung of §2's ladder to state, read off the thread and the run queue rather than off
  // `resolvedState` — see the render block below for why the distinction matters.
  const ladderRung = correctionRunHeld
    ? (deriveLadderRung(effectiveThread, queuedRunIds) ?? "targeted")
    : null;
  const ownsRoot = thread.author === author && thread.withdrawn_at == null;
  const confirmingRootDelete = correction?.targetId === thread.id && correction.mode === "delete";
  const hasLiveDescendant = (targetId: string) => {
    const byId = new Map(thread.replies.map((reply) => [reply.id, reply]));
    return thread.replies.some((reply) => {
      if (reply.withdrawn_at != null) return false;
      let parentId = reply.parent_id ?? thread.id;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (parentId === targetId) return true;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parent_id ?? "";
      }
      return false;
    });
  };
  const hasHistoricalOtherReply = (targetId: string, targetAuthor: string) => {
    const byId = new Map(thread.replies.map((reply) => [reply.id, reply]));
    return thread.replies.some((reply) => {
      if (reply.author === targetAuthor) return false;
      let parentId = reply.parent_id ?? thread.id;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (parentId === targetId) return true;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parent_id ?? "";
      }
      return false;
    });
  };
  const deleteBlock = (targetId: string) => {
    if (hasLiveDescendant(targetId)) return "Delete replies first.";
    if (correctionRunHeld) return "You can edit or delete this comment once the run finishes.";
    if (undecidedLinkedCount) return `${undecidedLinkedCount} linked ${undecidedLinkedCount === 1 ? "change" : "changes"} still to decide.`;
    return null;
  };
  useLayoutEffect(() => {
    if (correction?.mode === "delete" && hasLiveDescendant(correction.targetId)) {
      setCorrection(null);
      setCorrectionError(null);
      setDeleteRefusal(correction.targetId);
    }
  }, [correction, thread.replies]);
  useLayoutEffect(() => {
    if (deleteRefusal === null) {
      deleteRefusalSawLiveDescendant.current = false;
    } else if (hasLiveDescendant(deleteRefusal)) {
      deleteRefusalSawLiveDescendant.current = true;
    } else if (deleteRefusalSawLiveDescendant.current) {
      // A refusal from a stale backend view remains until its child is loaded. Once the
      // blocking child has appeared, remove the transient refusal when that child is withdrawn.
      deleteRefusalSawLiveDescendant.current = false;
      setDeleteRefusal(null);
    }
  }, [deleteRefusal, thread.replies]);
  useLayoutEffect(() => {
    if (deleteRefusal !== null) deleteRefusalTriggerRef.current?.focus({ preventScroll: true });
  }, [deleteRefusal]);
  const renderActionsMenu = (targetId: string, body: string, label: string) => (
    <div className="comment-thread-card__menu-wrap">
      <button
        type="button"
        ref={deleteRefusal === targetId ? deleteRefusalTriggerRef : undefined}
        className="comment-thread-card__menu-trigger"
        aria-label={`${label} actions`}
        aria-expanded={actionsOpen === targetId}
        onClick={() => setActionsOpen(actionsOpen === targetId ? null : targetId)}
      >⋯</button>
      {actionsOpen === targetId && (
        <div className="comment-thread-card__menu" role="group" aria-label={`${label} actions menu`}>
          {targetId === thread.id && <button type="button" disabled={resolving || thread.resolved || thread.linked_changes.some((change) => change.decision === null)} onClick={() => {
            setActionsOpen(null);
            void submitResolve();
          }}>Mark as resolved</button>}
          <button type="button" disabled={Boolean(deleteBlock(targetId))} onClick={() => {
            setActionsOpen(null);
            startCorrection(targetId, "delete", body);
          }}>
            Delete {label.toLowerCase()}
          </button>
          {hasLiveDescendant(targetId) && <div className="comment-thread-card__menu-reason">
            <p>Delete replies first.</p>
          </div>}
        </div>
      )}
    </div>
  );
  const waitingOnPermission =
    ladderRung === "working" && Boolean(permissionRunId) &&
    (effectiveThread.pending_run === permissionRunId ||
      effectiveThread.pending_runs.some((pending) => pending.started && pending.run_id === permissionRunId));
  const statusGlyph = waitingOnPermission ? <Pause size="1em" aria-hidden="true" /> : ladderRung ? RUNG_GLYPH[ladderRung] : "";
  const canAddress = (resolvedState === "open" || resolvedState === "orphaned") && !correctionRunHeld;

  // P2b-1b: a resolved thread renders collapsed to a single line by default — a display layer over
  // the seven-state rendering below, not a replacement for it (expanding reveals the identical
  // rendering this early return skips). Still wrapped in the same `TimelineCard` shell so
  // `data-card-id`/`data-card-kind` stay stable for anything selecting this card by identity.
  if (collapsed && thread.withdrawn_at == null) {
    return (
      <TimelineCard id={thread.id} kind="comment" compact onActivate={onActivate}
        activationLabel={activationLabel} selected={selected}>
        {/* No `aria-label` here (review finding, PR #481): an `aria-label` on a button overrides
            its descendant text for the accessible name, which would erase the author/severity/
            state/summary spans below from assistive tech — every resolved thread in a mature
            timeline would announce as an indistinguishable "Expand, button". The visually-hidden
            "Expand" span instead becomes the *first word* of the name the spans already form,
            naturally: content and name stay one and the same thing. */}
        <button
          ref={expandButtonRef}
          type="button"
          className={`comment-thread-card__collapsed comment-thread-card--${resolvedState}`}
          data-thread-state={resolvedState}
          aria-expanded={false}
          onClick={toggleCollapse}
        >
          <span className="sr-only">Expand</span>
          <span className="comment-thread-card__author">{thread.author}</span>
          {thread.severity !== null && <SeverityChip severity={thread.severity} />}
          <span className="comment-thread-card__state" data-thread-state={resolvedState}>
            {STATE_LABEL[resolvedState]}
          </span>
          <span className="comment-thread-card__collapsed-summary">{thread.body}</span>
        </button>
      </TimelineCard>
    );
  }

  function renderReply(reply: CommentThread["replies"][number]) { return (
    <li key={reply.id} className={`comment-thread-card__reply${reply.withdrawn_at != null ? " comment-thread-card__reply--withdrawn" : ""}`}>
      <span className="comment-thread-card__reply-avatar" aria-hidden="true">
        {reply.author.trim().charAt(0).toLocaleUpperCase() || "?"}
      </span>
      <span className="comment-thread-card__reply-author">{reply.author}</span>
      {reply.withdrawn_at != null ? (
        <span className="comment-thread-card__reply-withdrawn">{reply.author} deleted a reply · {formatDeliveryRelativeTime(reply.withdrawn_at, nowMs)}</span>
      ) : reply.defense && (
        <>
          <span className="comment-thread-card__badge">Defense</span>
          <span className="comment-thread-card__chip">defended — no change proposed</span>
          {reply.published && (
            <span className="comment-thread-card__chip comment-thread-card__chip--published">
              published to reviewer
            </span>
          )}
        </>
      )}
      {reply.withdrawn_at == null && reply.edited_at != null && (
        (thread.published || reply.published || hasHistoricalOtherReply(reply.id, reply.author)) &&
        <span className="comment-thread-card__edited">edited {formatDeliveryRelativeTime(reply.edited_at, nowMs)}</span>
      )}
      {reply.withdrawn_at == null && correction?.targetId === reply.id ? (
        <span className="comment-thread-card__correction-state">
          {correction.mode === "edit" ? "Editing" : "Deleting"}
        </span>
      ) : reply.withdrawn_at == null && (
        <>
          {deleteRefusal === reply.id && <span className="comment-thread-card__correction-state">Not deleted</span>}
          {reply.author === author && <span className="comment-thread-card__reply-actions">
            {onWithdraw && renderActionsMenu(reply.id, reply.body, "Reply")}
            {onRevise && <button
            type="button"
            className="comment-thread-card__edit"
            aria-label="Edit reply"
            disabled={correctionRunHeld}
            onClick={() => startCorrection(reply.id, "edit", reply.body)}
            ><Pencil size={12} aria-hidden="true" /></button>}
          </span>}
        </>
      )}
      {reply.withdrawn_at == null && correction?.targetId === reply.id && correction.mode === "edit" ? (
        <form className="comment-thread-card__correction" onSubmit={(event) => {
          event.preventDefault();
          void submitRevision(reply.id, correction.body);
        }}>
          <textarea
            aria-label="Edit reply body"
            value={correction.body}
            onChange={(event) => setCorrection({ ...correction, body: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); cancelCorrection(); }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitRevision(reply.id, correction.body);
              }
            }}
          />
          {correctionError && <p role="alert">{correctionError}</p>}
          <div className="comment-thread-card__correction-actions">
            <button type="submit" disabled={!correction.body.trim() || correctionBusy || correctionRunHeld}>Save</button>
            <button type="button" onClick={cancelCorrection} disabled={correctionBusy}>Cancel</button>
          </div>
        </form>
      ) : reply.withdrawn_at == null && correction?.targetId === reply.id && correction.mode === "delete" ? (
        <div className="comment-thread-card__correction comment-thread-card__correction--delete" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); cancelCorrection(); }
        }}>
          <strong>Delete this reply?</strong>
          <p>{reply.published || hasHistoricalOtherReply(reply.id, reply.author)
            ? "Others may already have seen it. The reply keeps a note that you deleted it."
            : "It hasn't been shared and no one else has replied to it, so its text will disappear from view."}</p>
          <p>Emend keeps the original text in this document's history. Deleting removes it from view, not from the record. This can't be undone.</p>
          {correctionError && <p role="alert">{correctionError}</p>}
          <div className="comment-thread-card__correction-actions">
            <button type="button" autoFocus onClick={() => void submitWithdrawal(reply.id)} disabled={correctionBusy || Boolean(deleteBlock(reply.id))}>Delete</button>
            <button type="button" onClick={cancelCorrection} disabled={correctionBusy}>Cancel</button>
            <span className="comment-thread-card__cancel-hint">Esc cancels</span>
          </div>
          {deleteBlock(reply.id) && <p role="alert">{deleteBlock(reply.id)}</p>}
        </div>
      ) : reply.withdrawn_at == null && <p>{reply.body}</p>}
      {deleteRefusal === reply.id && <div className="comment-thread-card__delete-refusal" role="alert">Delete replies first.</div>}
    </li>
  ); }

  if (thread.withdrawn_at != null) {
    if (!thread.visible_when_withdrawn) return null;
    return (
      <TimelineCard
        id={thread.id}
        kind="comment"
        onActivate={onActivate}
        activationLabel={activationLabel}
        selected={selected}
        header={<div className="comment-thread-card__withdrawn">
          <span className="comment-thread-card__reply-avatar" aria-hidden="true">
            {thread.author.trim().charAt(0).toLocaleUpperCase() || "?"}
          </span>
          <span><strong>{thread.author}</strong> deleted a comment · {formatDeliveryRelativeTime(thread.withdrawn_at, nowMs)}</span>
        </div>}
        footer={thread.anchor && <button
          type="button"
          className="comment-thread-card__anchor comment-thread-card__anchor--withdrawn"
          onClick={() => onFocusAnchor?.(thread.anchor!)}
        >→ Go to passage</button>}
      >
        {thread.replies.length > 0 && <ul className="comment-thread-card__latest-reply">{thread.replies.map(renderReply)}</ul>}
      </TimelineCard>
    );
  }

  return (
    <TimelineCard
      id={thread.id}
      kind="comment"
      onActivate={onActivate}
      activationLabel={activationLabel}
      selected={selected}
      header={
        <div className={`comment-thread-card__header comment-thread-card--${resolvedState}`}>
          <span className="comment-thread-card__avatar" aria-hidden="true">
            {thread.author.trim().charAt(0).toLocaleUpperCase() || "?"}
          </span>
          <span className="comment-thread-card__author">{thread.author}</span>
          {thread.published && <span className="comment-thread-card__published">In review</span>}
          {thread.edited_at != null && (thread.published || hasHistoricalOtherReply(thread.id, thread.author)) && (
            <span className="comment-thread-card__edited">edited {formatDeliveryRelativeTime(thread.edited_at, nowMs)}</span>
          )}
          {/* J3 Phase C / FR-REVIEW-2: a review finding is an ordinary comment thread distinguished
              by provenance (D6) — severity chip + source skill name, rendered right on this same
              header, not a parallel "finding card". Both are `null` on a plain human comment. */}
          {thread.severity !== null && <SeverityChip severity={thread.severity} />}
          {thread.skill !== null && (
            <span className="comment-thread-card__skill" aria-label={`skill: ${thread.skill}`}>
              {thread.skill}
            </span>
          )}
          <span className="comment-thread-card__state" data-thread-state={resolvedState}>
            {resolvedState === "resolved" && <Check size={11} aria-hidden="true" />}
            {STATE_LABEL[resolvedState]}
          </span>
          {/* Only a thread the collapse rule actually applies to (Resolved) gets a manual
              re-collapse control — every other state has nothing to return to (P2b-1b). */}
          {resolvedState === "reopened" && <span className="comment-thread-card__badge">Reopened</span>}
          {resolvedState === "orphaned" && (
            <span className="comment-thread-card__chip comment-thread-card__chip--warning">
              original text changed
            </span>
          )}
          <div className="comment-thread-card__actions">
            {defaultCollapsed && (
              <button
                type="button"
                className="comment-thread-card__collapse-toggle"
                aria-expanded={true}
                aria-label="Collapse"
                onClick={toggleCollapse}
              >
                Collapse
              </button>
            )}
            {/* Use the folded resolution flag: a working run can outrank Resolved as a state, but
                offering Resolve again there would be a no-op. */}
            {deleteRefusal === thread.id && <span className="comment-thread-card__correction-state">Not deleted</span>}
            {correction?.targetId === thread.id ? (
              <span className="comment-thread-card__correction-state">
                {correction.mode === "edit" ? "Editing" : "Deleting"}
              </span>
            ) : ownsRoot && onRevise && (
              <button
                type="button"
                className="comment-thread-card__edit"
                aria-label="Edit comment"
                disabled={correctionRunHeld}
                onClick={() => startCorrection(thread.id, "edit", thread.body)}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            )}
            {!correction && ownsRoot && onWithdraw && renderActionsMenu(thread.id, thread.body, "Comment")}
            {!correction && <button
              type="button"
              className="comment-thread-card__resolve"
              aria-label={thread.resolved ? "Reopen" : linkedChangeReason ? `Resolve — ${undecidedLinkedCount} linked ${undecidedLinkedCount === 1 ? "change" : "changes"} still to decide` : "Resolve"}
              title={thread.resolved ? "Reopen" : "Resolve"}
              disabled={resolving || (!thread.resolved && thread.linked_changes.some((change) => change.decision === null))}
              onClick={() => {
                if (thread.resolved) {
                  onReopen();
                } else {
                  focusExpandAfterResolveRef.current = true;
                  void submitResolve();
                }
              }}
              onBlur={() => {
                focusExpandAfterResolveRef.current = false;
              }}
            >
              {thread.resolved ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            </button>}
          </div>
        </div>
      }
      footer={
        <>
          {anchor ? (
            // UX Principle 6 deep-link: the anchored quote is clickable, scrolling the live editor
            // to its passage. Renders regardless of `onFocusAnchor` (matching `onReAnchor`'s "trigger
            // renders regardless" convention) — a caller with no live editor yet gets an inert button.
            <button
              type="button"
              className="comment-thread-card__anchor"
              onClick={() => onFocusAnchor?.(anchor)}
            >
              {anchorLabel}
            </button>
          ) : (
            <span className="comment-thread-card__anchor">{anchorLabel}</span>
          )}
          {runLink && <div className="comment-thread-card__run-link">
            <button type="button" onClick={() => runLink.onShowRun(runLink.runId)}>Show the run</button>
            {runLink.sentText && <span>Unsaved text sent with this run</span>}
          </div>}
        </>
      }
    >
      {resolutionError && <p role="alert">{resolutionError}</p>}
      {correction?.targetId === thread.id && correction.mode === "edit" ? (
        <form className="comment-thread-card__correction" onSubmit={(event) => {
          event.preventDefault();
          void submitRevision(thread.id, correction.body);
        }}>
          <textarea
            aria-label="Edit comment body"
            value={correction.body}
            onChange={(event) => setCorrection({ ...correction, body: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); cancelCorrection(); }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitRevision(thread.id, correction.body);
              }
            }}
          />
          {correctionError && <p role="alert">{correctionError}</p>}
          <div className="comment-thread-card__correction-actions">
            <button type="submit" disabled={!correction.body.trim() || correctionBusy || correctionRunHeld}>Save</button>
            <button type="button" onClick={cancelCorrection} disabled={correctionBusy}>Cancel</button>
          </div>
        </form>
      ) : correction?.targetId === thread.id && correction.mode === "delete" ? (
        <div className="comment-thread-card__correction comment-thread-card__correction--delete" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); cancelCorrection(); }
        }}>
          <strong>Delete this comment?</strong>
          <p>{thread.published || thread.replies.some((reply) => reply.author !== thread.author)
            ? "Others may already have seen this comment. The thread will keep a note that you deleted it."
            : "This comment hasn't been shared and no one else has replied, so it will disappear from the document."}</p>
          <p>Emend keeps the original text in this document's history. Deleting removes it from view, not from the record. This can't be undone.</p>
          {correctionError && <p role="alert">{correctionError}</p>}
          <div className="comment-thread-card__correction-actions">
            <button type="button" autoFocus onClick={() => void submitWithdrawal(thread.id)} disabled={correctionBusy || Boolean(deleteBlock(thread.id))}>Delete</button>
            <button type="button" onClick={cancelCorrection} disabled={correctionBusy}>Cancel</button>
            <span className="comment-thread-card__cancel-hint">Esc cancels</span>
          </div>
          {deleteBlock(thread.id) && <p role="alert">{deleteBlock(thread.id)}</p>}
        </div>
      ) : <p className="comment-thread-card__body">{thread.body}</p>}
      {deleteRefusal === thread.id && <div className="comment-thread-card__delete-refusal" role="alert">Delete replies first.</div>}
      {linkedChangeReason && <div className="comment-thread-card__linked-refusal">
        <p>{linkedChangeReason}</p>
        {onFocusChange && <button type="button" onClick={() => {
          const changeId = thread.linked_changes.find((change) => change.decision === null)!.change_id;
          setNavigationError(onFocusChange(changeId) === false ? "This linked change is no longer available in the document." : null);
        }}>Go to changes</button>}
        {navigationError && <p role="alert">{navigationError}</p>}
      </div>}

      {/* Exit note (issue #1381, ux-design.md §2's last three exit-table rows): the most recent
          address run to end on this thread *without delivering* — stopped, failed, or reconciled as
          failed at load time because no live run answers to it any more. Rendered unconditionally
          (never gated on `resolvedState`, matching §2's "persistent until the user's next action on
          the thread"): the backend clears `thread.concluded_run` itself the moment any other event
          reaches this thread, so nothing here needs to track when to stop showing it. `[Try again]`
          only where `canAddress` already offers a route back in (open/orphaned) — a reopened thread
          already carries its own `[Try again — add guidance…]` further down, so this never doubles
          the affordance. */}
      {thread.concluded_run && (
        <div
          className="comment-thread-card__run-outcome"
          data-run-outcome={thread.concluded_run.outcome}
        >
          <p>
            {thread.concluded_run.outcome === "stopped"
              ? "Address run stopped — nothing proposed for this comment."
              : "Address run failed — nothing proposed for this comment."}
            {thread.concluded_run.outcome === "failed" && canAddress && !localOnly && !confirmingRootDelete && (
              <button type="button" onClick={() => onAddressWithAI?.()}>
                Try again
              </button>
            )}
          </p>
        </div>
      )}

      {/* ux-design.md §2's acknowledgment ladder — every rung, one block (issue #2228; rungs 1-2
          worded name-free by UXR-Q17, CJ 2026-09-02). §2 gives the ladder a single card-level
          status line and says "only its words change", so this is one box, one class and one
          `data-ladder-rung` hook driven off the copy and glyph tables above; that is why the class
          names the slot rather than a rung. `docs/design/specs/comments.md` `5a.5` draws it.

          A live or queued run holds this comment, so the card says so where its run-starting
          affordance used to be — "one acknowledgment ladder, so the request surface is never
          silent". Rungs 1-2 state that the run has *not* started on this thread; rung 3 is J10's
          ratified *Working* line, the only rung that also names a thread state (UXR-Q10/#1122),
          and the only one that claims activity.

          Gated on the rung, never on `resolvedState`: §2's "The active-run status is not governed
          by state precedence" keeps this line "regardless of which name it displays", and its exit
          table spells the case out — an anchor lost mid-run reads *Orphaned* "and keeps the
          active-run status line". Reading it off `resolvedState` dropped rung 3 entirely there,
          since `orphaned` outranks `working` in the presentation order. */}
      {ladderRung && (
        <div className="comment-thread-card__status" data-ladder-rung={ladderRung}>
          {statusGlyph && (
            <span className="comment-thread-card__status-icon" aria-hidden="true">
              {statusGlyph}
            </span>
          )}
          {/* The block is a row so the glyph sits beside `5a.5`'s status line; the text stacks in
              its own column, since §2's guidance note and resolve acknowledgment join that line
              inside the same box and belong under it, not beside it. */}
          <div className="comment-thread-card__status-text">
            <p>{waitingOnPermission ? "Waiting on permission" : RUNG_COPY[ladderRung]}</p>
            {/* Both notes belong to rung 3 alone, and for the same reason: they exist because
                *Working* outranks the fact they state. `pending_guidance` can only be set while
                `pending_run` is — both are written by `EventKind::Address` and cleared together by
                whichever conclusion reaches this thread first: delivery (`LinkChanges`), a defense
                `Reply`, or a stop/failure (`AddressStopped`/`AddressFailed`, issue #1381).

                And §2's "Manual resolve during a run is acknowledged, not swallowed": a resolve
                pressed at rung 3 would change nothing visible, because Working outranks Resolved in
                the presentation order — the silent no-op FR-X-5 forbids. At rungs 1-2 the thread's
                state is "unchanged", so the resolve simply lands, the chip says Resolved and
                [Reopen] replaces [Resolve]; nothing is swallowed and no copy §2 does not record has
                to be invented. No proposal content renders for *this* run either way — an earlier
                delivery's still-undecided linked changes stay visible via the unconditional
                `linked_changes` block further down, attributed to that delivery. */}
            {ladderRung === "working" && effectiveThread.pending_guidance && (
              <p className="comment-thread-card__guidance-note">You added: “{effectiveThread.pending_guidance}”</p>
            )}
            {ladderRung === "working" && thread.resolved && (
              <p className="comment-thread-card__resolved-note">
                ✓ Resolved — the agent is still working; anything it delivers will bring this thread
                back.
              </p>
            )}
          </div>
        </div>
      )}

      {resolvedState === "addressed-pending" && (
        <div className="comment-thread-card__pending">
          <p>Addressed — pending review.</p>
        </div>
      )}

      {resolvedState === "orphaned" && thread.anchor && (
        <div className="comment-thread-card__orphan">
          <p className="comment-thread-card__orphan-quote">
            Original text: <q>{thread.anchor.text_snapshot}</q>
          </p>
          {!reAnchorArmed ? (
            <button type="button" onClick={() => setReAnchorArmed(true)}>
              Re-anchor
            </button>
          ) : (
            <div className="comment-thread-card__reanchor-confirm">
              <p>
                {pendingSelection
                  ? `New home: “${pendingSelection.preview}”`
                  : "Select the new home text in the document…"}
              </p>
              <button type="button" onClick={confirmReAnchor} disabled={!pendingSelection}>
                Confirm
              </button>
              <button type="button" onClick={() => setReAnchorArmed(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {resolvedState === "suggestion" && (
        <div className="comment-thread-card__suggestion">
          {/* D19's diff-preview payload doesn't exist on `CommentThread` yet (P2b-3) — this is the
              state-rendering placeholder the state-driven test suite exercises; a future unit
              supplies the real diff and wires Apply. */}
          <button type="button" disabled>
            Apply
          </button>
        </div>
      )}

      {/* #1380 (ux-design.md §2): Working and multi-undecided-delivery threads name every count and
          control by delivery in J1's "N changes from Agent · <relative age>" vocabulary. J4's
          ordinary single-delivery Addressed — pending card keeps its unattributed linked-change
          block, exactly as CJ's ruling and the binding wireframe draw it. */}
      {showAttributedLinkedChanges
        ? linkedChangeGroups.map((group, index) => {
            const undecidedInGroup = group.changes
              .filter((change) => change.decision === null)
              .map((change) => change.change_id);
            const groupLabelId = `${deliveryGroupLabelId}-${index}`;
            return (
              <div
                key={group.deliveryId}
                className="comment-thread-card__linked-changes"
                role="group"
                aria-labelledby={groupLabelId}
              >
                <p id={groupLabelId}>
                  ↳ {group.changes.length} {group.changes.length === 1 ? "change" : "changes"} from Agent ·{" "}
                  {formatDeliveryRelativeTime(group.deliveredAt, nowMs)}
                </p>
                <button type="button" onClick={() => onFocusChange?.(group.changes[0].change_id)}>
                  Go to →
                </button>
                {undecidedInGroup.length > 0 && !localOnly && (
                  <>
                    <button type="button" onClick={() => onDecideLinkedChanges?.(undecidedInGroup, "accept")}>
                      {acceptLabelFor(undecidedInGroup.length)}
                    </button>
                    <button type="button" onClick={() => onDecideLinkedChanges?.(undecidedInGroup, "reject")}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            );
          })
        : thread.linked_changes.length > 0 && (
            <div className="comment-thread-card__linked-changes">
              <p>
                ↳ {thread.linked_changes.length} linked {thread.linked_changes.length === 1 ? "change" : "changes"}
              </p>
              <button type="button" onClick={() => onFocusChange?.(thread.linked_changes[0].change_id)}>
                Go to →
              </button>
              {undecidedLinkedChangeIds.length > 0 && !localOnly && (
                <>
                  <button
                    type="button"
                    onClick={() => onDecideLinkedChanges?.(undecidedLinkedChangeIds, "accept")}
                  >
                    {acceptLabelFor(undecidedLinkedChangeIds.length)}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecideLinkedChanges?.(undecidedLinkedChangeIds, "reject")}
                  >
                    Reject
                  </button>
                </>
              )}
            </div>
          )}

      {thread.replies.length > 1 && (
        <details className="comment-thread-card__replies">
          <summary>{thread.replies.length - 1} more replies</summary>
          <ul>{thread.replies.slice(0, -1).map(renderReply)}</ul>
        </details>
      )}
      {thread.replies.length > 0 && (
        <ul className="comment-thread-card__latest-reply">
          {thread.replies.slice(-1).map(renderReply)}
        </ul>
      )}
      {!thread.resolved && !confirmingRootDelete && (
        <form className="comment-thread-card__reply-form" onSubmit={submitReply}>
          <textarea
            aria-label={`Reply to ${thread.author}'s comment`}
            placeholder="Reply…"
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            rows={1}
          />
          <button type="submit">Reply</button>
        </form>
      )}

      {canAddress && !localOnly && !confirmingRootDelete && (
        <button type="button" className="comment-thread-card__address" onClick={() => onAddressWithAI?.()}>
          Address with AI
        </button>
      )}

      {resolvedState === "reopened" &&
        !correctionRunHeld &&
        !localOnly &&
        !confirmingRootDelete &&
        (!guidanceArmed ? (
          <button type="button" onClick={() => setGuidanceArmed(true)}>
            Try again — add guidance…
          </button>
        ) : (
          <form className="comment-thread-card__redelegate-form" onSubmit={submitReDelegate}>
            <textarea
              aria-label="Guidance for re-delegation"
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              rows={2}
            />
            <button type="submit">Try again</button>
            <button type="button" onClick={() => setGuidanceArmed(false)}>
              Cancel
            </button>
          </form>
        ))}
    </TimelineCard>
  );
}
