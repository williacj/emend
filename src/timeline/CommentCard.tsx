// ABOUTME: The comment-thread card variant (P2a-18/P2a-19, §3.1 `timeline/`) — binds a
// ABOUTME: `CommentThread`'s reply/resolve/reopen/re-anchor/address-with-AI actions to the backend.
// ABOUTME: Given the owner's shared `threads` state (#411, `TimelinePanel`'s single-owner pair) it
// ABOUTME: renders and writes through that; otherwise it falls back to its own private copy.
import { useRef, useState } from "react";
import { errorDetail } from "../backend";
import { buildAddressPrompt } from "../comments/addressPrompt";
import { CommentThreadCard, type PendingReAnchorSelection } from "../comments/CommentThreadCard";
import {
  decideLinkedChanges,
  loadCommentThreads,
  reAnchorComment,
  replyToComment,
  reopenComment,
  resolveComment,
  reviseComment,
  withdrawComment,
} from "../comments/ipc";
import type { Anchor, CommentDocumentOwner, CommentThread, LinkedChangeDecision } from "../comments/types";
import { startAddressRun, type StartRunResult } from "./agentActivity";
import { activeDocumentContentSent, NO_OPEN_DOCUMENTS_READER, type OpenDocumentsSnapshot } from "./referenceData";
import type { CommentCard as CommentCardData } from "./types";

export interface CommentCardProps {
  card: CommentCardData;
  /**
   * The document's full comment-thread state (#411) — when supplied *together with*
   * `onThreadsChange`, this card renders its own thread by looking it up here (`card.thread.id`)
   * rather than seeding a `useState` copy from `card.thread` once, so a transition landed anywhere
   * else (another mounted card, the batch-address run, a rehydrate) is reflected the moment this
   * array's identity changes — the `useState(card.thread)`-seeds-once trap named in #411 is
   * structurally impossible in this mode, because there is no local copy to go stale. Falls back to
   * `card.thread` for an id this array doesn't (yet) carry, e.g. a caller seeding both from the same
   * snapshot before this card's own thread has round-tripped into it.
   *
   * Omitted (or supplied without `onThreadsChange`), this card owns a private copy exactly as
   * before — the standalone/no-owner degrade every other optional prop on this card already
   * follows, and what this component's own unit tests exercise directly. `TimelinePanel` is the one
   * caller that supplies both, passing its own single `threads` state through to every mounted
   * comment card (see that module's docs).
   */
  threads?: CommentThread[];
  /** Reports this card's own mutation result (the *document's whole* updated thread list every
   * `comments/ipc.ts` call already returns) up to the owner of `threads` above, instead of this
   * card applying it to a local copy — the write half of the single-owner pair. Only consulted
   * when `threads` is also given; see that prop's own docs. */
  onThreadsChange?: (threads: CommentThread[]) => void;
  /** Reports a `start_run` that rejected outright for this thread's Address-with-AI request
   * (#1777) — this card owns no error surface, so the owner that does is told rather than the
   * rejection being swallowed and the button reading as dead. `timeline/agentActivity.ts`'s
   * `failedRunStatus` owns the full rationale and names each of its callers. `TimelinePanel` supplies
   * this;
   * omitted in a standalone/no-owner caller, matching every other optional prop here, where the
   * worst case is the silence that shipped before — never a false pending claim. */
  onAddressRunFailed?: (root: string, error: unknown) => void;
  onAddressRunStarted?: (root: string, run: StartRunResult) => void;
  /** Reports only an admitted run for this card, with the fact read from its submit-time envelope. */
  onRunLink?: (link: import("../comments/types").CommentRunLink) => void;
  /** Supplied by the collapsed column for its one shown run link. */
  runLink?: { runId: string; sentText: boolean };
  onShowRun?: (runId: string) => void;
  /** Reads every open document at submit time for FR-CHAT-4's `open_documents` envelope (#1724) —
   * `TimelinePanel` supplies it from the same prop `App` feeds the composer's own submits with, so
   * both surfaces name the identical set. Defaults to "nothing open" in a standalone/no-owner
   * caller, matching every other optional prop here: an explicit empty envelope, never a missing
   * one. */
  openDocuments?: () => OpenDocumentsSnapshot;
  /** The acting local identity for replies/resolve/reopen/re-anchor/address events (TD-4: every
   * event carries its author). Real per-user identity is a follow-up — every comment authored
   * through this panel uses this label until an identity system exists. */
  author?: string;
  /** Injectable clock (CLAUDE.md: no reliance on real time in tests) — milliseconds since epoch,
   * matching `store::comments::CommentEvent.timestamp`. */
  now?: () => number;
  /** See `CommentThreadCard`'s own prop — threaded straight through. */
  pendingSelection?: PendingReAnchorSelection | null;
  /** See `CommentThreadCard`'s own prop — threaded straight through; omitted in a caller with no
   * live editor yet (mirrors `ChangeSetCard`'s identical `onFocusChange`). */
  onFocusChange?: (changeId: string) => boolean | void;
  /** See `CommentThreadCard`'s own prop — threaded straight through; omitted in a caller with no
   * live editor yet. */
  onFocusAnchor?: (anchor: Anchor) => void;
  onActivate?: () => void;
  activationLabel?: string;
  selected?: boolean;
  /** See `CommentThreadCard`'s own prop — threaded straight through (P2b-1b collapse composition). */
  onCollapsedChange?: (collapsed: boolean, explicit: boolean) => void;
  /** See `CommentThreadCard`'s own prop — threaded straight through: `TimelinePanel` reads its
   * `pinnedCollapsedIds` map back down through here so a user's explicit collapse choice (and only
   * an explicit one) survives this card unmounting and remounting (review finding, PR #481). */
  initialCollapsed?: boolean;
  /** See `CommentThreadCard`'s own prop — threaded straight through: `TimelinePanel` derives it
   * from the queued-phase run cards it already keeps, which is what tells ux-design.md §2's rung 1
   * from its rung 2 (issue #2228). Omitted in a standalone/no-owner caller, which lands every
   * held thread on rung 2 — the fail-safe direction `deriveLadderRung` documents. */
  queuedRunIds?: readonly string[];
  liveRunIds?: readonly string[];
  terminalRunIds?: readonly string[];
  /** The live run currently blocked on J7 permission, passed through as identity only so the
   * thread can acknowledge the wait without rendering a second decision surface. */
  permissionRunId?: string | null;
}

function findSelf(threads: CommentThread[], id: string): CommentThread | undefined {
  return threads.find((candidate) => candidate.id === id);
}

export function CommentCard({
  card,
  threads,
  onThreadsChange,
  onAddressRunFailed,
  onAddressRunStarted,
  onRunLink,
  runLink,
  onShowRun,
  openDocuments = NO_OPEN_DOCUMENTS_READER,
  author = "you",
  now,
  pendingSelection,
  onFocusChange,
  onFocusAnchor,
  onActivate,
  activationLabel,
  selected,
  onCollapsedChange,
  initialCollapsed,
  queuedRunIds,
  liveRunIds,
  terminalRunIds,
  permissionRunId,
}: CommentCardProps) {
  // Single-owner mode (#411) needs both halves of the pair — a `threads` array with no way to
  // report a mutation back (or vice versa) is not a coherent owner, so this card falls back to its
  // own private copy unless it has both.
  const owned = threads !== undefined && onThreadsChange !== undefined;
  const [ownThread, setOwnThread] = useState<CommentThread | null>(card.thread);
  const [admittingRun, setAdmittingRun] = useState(false);
  const seenInOwner = useRef(false);
  const inOwner = threads && findSelf(threads, card.thread.id);
  if (inOwner) seenInOwner.current = true;
  const thread = owned ? (inOwner ?? (seenInOwner.current ? null : card.thread)) : ownThread;
  const timestamp = () => now?.() ?? Date.now();
  if (!thread) return null;
  const owner: CommentDocumentOwner = card.docId
    ? { kind: "id", docId: card.docId, label: card.path }
    : { kind: "path", path: card.path };
  const liveContent = () => {
    const currentOpen = openDocuments().active;
    return owner.kind === "id" && currentOpen?.path === null && currentOpen.label === owner.label
      ? currentOpen.content
      : undefined;
  };
  const applyUpdated = (updatedThreads: CommentThread[]) => {
    if (owned) {
      onThreadsChange(updatedThreads);
      return;
    }
    const updated = findSelf(updatedThreads, thread.id);
    setOwnThread(updated ?? null);
  };

  // The missing half of FR-CMT-2's run (#1721, the 5th orphaned seam of #344): `address_with_ai`
  // only ever recorded the pending transition — nothing called `start_run`, so the thread flipped
  // to Working and stayed there forever, with no agent turn behind it. `start_run` mints the run's
  // real id; `resolvedRunId` is what gets stamped onto the pending event below, so the two calls
  // always name the same run (never the earlier client-minted id that had no relationship to what
  // the backend actually spawned) — see that helper's own doc for the defensive empty-response
  // fallback it shares with `editor/CommentPopover.tsx` and `TimelinePanel.handleAddressAll`.
  const dispatchAddress = async (guidance: string | null) => {
    if (owner.kind === "id") return;
    setAdmittingRun(true);
    const prompt = buildAddressPrompt(thread, guidance);
    let updated: CommentThread[];
    let admittedRun: StartRunResult | null;
    let submittedDocuments: OpenDocumentsSnapshot;
    try {
      submittedDocuments = openDocuments();
      // FR-CHAT-4: a single "Address with AI" run names the open documents exactly as a chat turn
      // does — read at submit, the same boundary as the `[card.path]` operation target beside it.
      ({ threads: updated, run: admittedRun } = await startAddressRun(
        card.root, card.path, [thread.id], author, timestamp(), prompt, false, guidance,
        { openDocuments: submittedDocuments },
      ));
    } catch (error: unknown) {
      // No run ever started — today a `confine` rejection, reachable whenever the project root has
      // been moved, deleted or unmounted under the app (`commands/commands/path_confine.rs`). So
      // nothing may claim the thread pending: [Address with AI] stays available to retry, rather
      // than stamping a run id that would name a run that doesn't exist (the false "Working" state
      // #1721 exists to prevent). Short-circuiting is only half the answer, though: #1721 left the
      // rejection swallowed here, so the button read as dead with no reason given. It is reported
      // to the owner that can render it honestly instead (#1777, FR-X-5, UX Principle 7).
      onAddressRunFailed?.(card.root, error);
      return;
    } finally {
      setAdmittingRun(false);
    }
    if (admittedRun) {
      onAddressRunStarted?.(card.root, admittedRun);
      onRunLink?.({ runId: admittedRun.id, sentText: activeDocumentContentSent(submittedDocuments) });
    }
    applyUpdated(updated);
  };

  return (
    <CommentThreadCard
      thread={thread}
      author={author}
      localOnly={owner.kind === "id"}
      correctionAdmissionPending={admittingRun}
      onRevise={async (targetId, body) => {
        const updated = await reviseComment(card.root, owner, targetId, body, timestamp(), liveContent());
        applyUpdated(updated);
      }}
      onWithdraw={async (targetId) => {
        try {
          const updated = await withdrawComment(card.root, owner, targetId, timestamp(), liveContent());
          applyUpdated(updated);
        } catch (error) {
          // Keep a late descendant visible beside the refusal even when this card owns a
          // private thread copy rather than the Timeline panel's shared list.
          if (errorDetail(error) === "Delete replies first.") {
            await loadCommentThreads(card.root, owner, liveContent()).then(applyUpdated, () => {});
          }
          throw error;
        }
      }}
      pendingSelection={pendingSelection}
      onReply={(body, defense) => {
        const updated = owner.kind === "id"
          ? replyToComment(card.root, owner, thread.id, author, body, defense, false, timestamp(), liveContent())
          : replyToComment(card.root, owner.path, thread.id, author, body, defense, false, timestamp());
        void updated.then(
          applyUpdated,
        );
      }}
      onResolve={async () => {
        const updated = owner.kind === "id"
          ? resolveComment(card.root, owner, thread.id, author, timestamp(), liveContent())
          : resolveComment(card.root, owner.path, thread.id, author, timestamp());
        applyUpdated(await updated);
      }}
      onReopen={() => {
        const updated = owner.kind === "id"
          ? reopenComment(card.root, owner, thread.id, author, timestamp(), liveContent())
          : reopenComment(card.root, owner.path, thread.id, author, timestamp());
        void updated.then(applyUpdated);
      }}
      onReAnchor={(content, offset, length) => {
        const anchor = {
          content,
          utf16Offset: offset,
          utf16Length: length,
        };
        const updated = owner.kind === "id"
          ? reAnchorComment(card.root, owner, thread.id, author, timestamp(), anchor, liveContent())
          : reAnchorComment(card.root, owner.path, thread.id, author, timestamp(), anchor);
        void updated.then(applyUpdated);
      }}
      onAddressWithAI={owner.kind === "path" ? () => {
        void dispatchAddress(null);
      } : undefined}
      onReDelegate={owner.kind === "path" ? (guidance) => {
        void dispatchAddress(guidance);
      } : undefined}
      onDecideLinkedChanges={owner.kind === "path" ? (changeIds: string[], decision: LinkedChangeDecision) => {
        void decideLinkedChanges(card.root, owner.path, thread.id, author, timestamp(), changeIds, decision).then(
          applyUpdated,
        );
      } : undefined}
      onFocusChange={onFocusChange}
      onFocusAnchor={onFocusAnchor}
      runLink={runLink && onShowRun ? { ...runLink, onShowRun } : undefined}
      onActivate={onActivate}
      activationLabel={activationLabel}
      selected={selected}
      onCollapsedChange={onCollapsedChange}
      initialCollapsed={initialCollapsed}
      queuedRunIds={queuedRunIds}
      liveRunIds={liveRunIds}
      terminalRunIds={terminalRunIds}
      permissionRunId={permissionRunId}
      now={now}
    />
  );
}
