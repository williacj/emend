// ABOUTME: The timeline right-rail panel (§3.1 `timeline/`, UX §4) — composes the virtualized
// ABOUTME: stream, card renderers, and message input into the one live in-memory chat surface.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronsRight } from "lucide-react";
import { errorDetail } from "../backend";
import type { DecisionSource } from "../editor/trackedChanges";
import { isMac } from "../editor/keymap";
import {
  BatchAddressStatus,
  BatchAddressTrigger,
  unrunBatch,
  type Anchor,
  type BatchAddressOutcome,
  type CommentThread,
  type CommentDocumentOwner,
} from "../comments";
import { buildBatchAddressPrompt } from "../comments/addressPrompt";
import { concludeAddressRun } from "../comments/ipc";
import { mintRunId } from "../comments/runId";
import { type RunConclusionOutcome } from "../comments/types";
import {
  distinctFilesRead,
  failedRunStatus,
  listenToAgentActivity,
  startAddressRun,
  startRun,
  stopRun,
  type RunStatus,
  type StartRunResult,
} from "./agentActivity";
import { AgentWorkingCard } from "./AgentWorkingCard";
import { batchChangeSetCardFor } from "./batchChangeSetCard";
import { ChangeSetCard } from "./ChangeSetCard";
import { ChatMessageCard } from "./ChatMessageCard";
import { isAgentWorkingCollapsedByDefault, itemHeightFor } from "./collapse";
import { CommentCard } from "./CommentCard";
import { DocumentBirthCard } from "./DocumentBirthCard";
import { UntitledAdoptionCard } from "./UntitledAdoptionCard";
import { mergeDecidedIds, removeDecidedIds } from "./decidedIds";
import { ALL_FACET_ID, facetById, facetForCard, facetJumpIndex, filterCardsByFacet, type Facet } from "./facets";
import { FacetBar } from "./FacetBar";
import { appendTranscriptEvent, loadTranscript } from "./ipc";
import { MessageComposer } from "./MessageComposer";
import { NewInFacetAffordance } from "./NewInFacetAffordance";
import {
  decidePermission,
  getPermissionState,
  listenToPermissionState,
  type PermissionDecision,
  type PermissionState,
} from "./permission";
import { ProjectGroundingCard } from "./ProjectGroundingCard";
import { TimelineHostAction } from "./TimelineHostAction";
import { activeDocumentOutboundDisclosure, NO_OPEN_DOCUMENTS_READER, type OpenDocumentsSnapshot } from "./referenceData";
import {
  createAgentWorkingCard,
  createChatMessageCard,
  createCommentCard,
  type AgentWorkingCard as AgentWorkingCardData,
  type AgentRunCardStatus,
  type ChangeSetDecision,
  type ChangeSetTriageTarget,
  type CommentCard as CommentCardData,
  type QuotedExcerpt,
  type TimelineCard,
} from "./types";
import { VirtualList, type VirtualListScrollRequest } from "./VirtualList";

/** Height (pixels) to assume for an expanded card's row until `VirtualList` has measured it — see
 * `VirtualList`'s `estimatedItemHeight`; the row a card actually renders into is sized by what it
 * rendered, never by this (#1119). */
const DEFAULT_ITEM_HEIGHT = 96;

/**
 * Folds one `RunStatus` push into `cards` (P2a integration #345, J1 Phase A): the first push for a
 * given run id appends a fresh `agent-working` card (a plain append — exempt from auto-scroll/
 * focus-steal by construction, Principle 2, since nothing here touches `scrollRequest`); a later
 * push for the same run id updates that card's fields in place instead, never minting a second one.
 * Pure and outside the component so both native pushes and D23 `/run_state` polling fold through
 * identical logic.
 */
function isBackendRunStatus(status: AgentRunCardStatus): status is RunStatus {
  return status.phase.phase !== "queued" && status.phase.phase !== "cancelled";
}

// @anchor:test-plan-fold-run-status
function foldRunStatus(prev: TimelineCard[], status: AgentRunCardStatus, timestamp?: string): TimelineCard[] {
  const existingIndex = prev.findIndex((card) => card.kind === "agent-working" && card.runId === status.id);
  let next: TimelineCard[];
  if (existingIndex === -1) {
    next = [...prev, createAgentWorkingCard(status, { timestamp })];
  } else {
    next = [...prev];
    const existing = next[existingIndex] as AgentWorkingCardData;
    next[existingIndex] = {
      ...existing,
      phase: status.phase,
      activity: status.activity,
      elapsedSecs: status.elapsedSecs,
    };
  }
  if (!isBackendRunStatus(status)) return next;
  return appendAgentReply(appendContinuityNotice(next, status, timestamp), status, timestamp);
}

const CONTINUITY_LOST_NOTICE =
  "Couldn’t resume the previous agent session. A new session was started; your conversation history is still visible.";

function appendContinuityNotice(cards: TimelineCard[], status: RunStatus, timestamp?: string): TimelineCard[] {
  if (status.phase.phase !== "recovered") return cards;
  const id = `continuity-notice-${status.id}`;
  if (cards.some((card) => card.id === id)) return cards;
  return [...cards, createChatMessageCard("agent", CONTINUITY_LOST_NOTICE, { id, timestamp })];
}

/**
 * Which non-delivering conclusion, if any, `status` represents (issue #1381, ux-design.md §2's exit
 * table) — `null` for a phase this thread-clearing wiring has nothing to do about: still running,
 * or a clean completion, which the existing address/`link_changes`/defense-reply IPC calls already
 * conclude on their own (a `Completed` run only means the agent's *turn* ended cleanly; whether it
 * actually delivered anything for a given thread is that thread's own concern, not this run's).
 */
function nonDeliveringConclusion(status: RunStatus): RunConclusionOutcome | null {
  if (status.phase.phase === "stopped") return "stopped";
  if (status.phase.phase === "failed") return "failed";
  return null;
}

/** The final run-card facts D15 may persist. A live/queued card is intentionally session-only:
 * persisting an intermediate snapshot would replay stale work after reopen and could duplicate the
 * one final card later appended for the same run. */
function isTerminalAgentWorkingCard(card: TimelineCard): card is AgentWorkingCardData {
  return (
    card.kind === "agent-working" &&
    card.phase.phase !== "running" &&
    card.phase.phase !== "queued"
  );
}

/** A run this panel is still showing as queued — the phase `acknowledgeQueuedRun` writes and
 * `foldRunStatus` promotes in place on the run's first activity push. */
function isQueuedAgentWorkingCard(card: TimelineCard): card is AgentWorkingCardData {
  return card.kind === "agent-working" && card.phase.phase === "queued";
}

function isContinuityNoticeCard(card: TimelineCard): boolean {
  return card.kind === "chat-message" && card.id.startsWith("continuity-notice-");
}

/** Stable identities at the one boundary where independently timed card sources are composed.
 * Every card owns its durable `id`; an agent-working card additionally owns the run identity that
 * remains stable even when `loadTranscript` has to re-key a historical React row. Comparing both
 * prevents either an ordinary duplicate key or two snapshots of one run from entering the stream.
 */
function timelineCardIdentities(card: TimelineCard): string[] {
  const identities = [`card:${card.id}`];
  if (card.kind === "agent-working") identities.push(`run:${card.runId}`);
  return identities;
}

/**
 * Composes an independently produced card sequence with the current live stream. Current cards
 * always win an identity collision: they are the newer in-memory snapshot when initial D15
 * rehydrate races a live update. Among duplicate incoming snapshots, the later one wins while
 * every surviving card keeps its original relative order. Rehydrate prepends survivors; live and
 * owner-delivered sequences append them. All three paths use this boundary so none can reintroduce
 * the duplicate through a slightly different id-only fold.
 */
function mergeTimelineCards(
  current: TimelineCard[],
  incoming: TimelineCard[],
  placement: "before" | "after",
): TimelineCard[] {
  if (incoming.length === 0) return current;
  const claimed = new Set(current.flatMap(timelineCardIdentities));
  const survivors: TimelineCard[] = [];
  for (let index = incoming.length - 1; index >= 0; index -= 1) {
    const card = incoming[index];
    const identities = timelineCardIdentities(card);
    if (identities.some((identity) => claimed.has(identity))) continue;
    identities.forEach((identity) => claimed.add(identity));
    survivors.push(card);
  }
  if (survivors.length === 0) return current;
  survivors.reverse();
  return placement === "before" ? [...survivors, ...current] : [...current, ...survivors];
}

/**
 * Appends the agent's answer for `status`'s run as a `chat-message` card (#1118, J2's "normal chat,
 * no special UI"; Principle 5's one stream carries chat in *both* directions). Until this existed
 * the reply had nowhere to land: `createChatMessageCard("agent", …)` had no production caller, so a
 * chat question got an activity card and nothing else.
 *
 * Appended after the working card the same fold just wrote, which is the run's own stream order
 * (D4/D6) — the answer follows the work that produced it. A plain append, so it is exempt from
 * auto-scroll/focus-steal by construction (Principle 2), exactly like the working card beside it.
 *
 * Only a `completed` run carries prose to render — the backend puts a reply on no other phase, and
 * withholds it from a run that delivered tracked changes or comments, whose own change-set/comment
 * card already reports the outcome (CJ's ruling on #1118; `RunPhase::Completed`'s own docs hold the
 * rule, so it lives in one place rather than being re-decided here). A completed run whose `reply`
 * is absent mints nothing either: rendering an empty card would be a card saying nothing, not an
 * honest report of an answerless turn.
 *
 * The card's id derives from the run id — `foldCommentThreads`' own `comment-<thread.id>` shape one
 * screen down — so the same terminal status folded twice (a duplicate push, a `last_finished`
 * re-poll) recognises the answer it already minted instead of minting a second card for it.
 *
 * Carries J2's `[refs: N files read]` grounding chip (#1391): `status.activity` is the same list
 * the working card beside it renders, and `distinctFilesRead` derives the count from it
 * frontend-side rather than needing a second backend payload (CJ's cross-link ruling on #1391,
 * 2026-08-20 — the derivation is already proven available off this exact field). `createChatMessageCard`
 * omits the chip entirely when the count is zero, so a clarifying-question reply that read nothing
 * needs no separate handling here.
 */
function appendAgentReply(cards: TimelineCard[], status: RunStatus, timestamp?: string): TimelineCard[] {
  if (status.phase.phase !== "completed" && status.phase.phase !== "recovered") return cards;
  const reply = status.phase.reply;
  if (!reply) return cards;
  const id = `chat-message-${status.id}`;
  if (cards.some((card) => card.id === id)) return cards;
  const filesRead = distinctFilesRead(status.activity);
  return [...cards, createChatMessageCard("agent", reply, { id, timestamp, filesRead: filesRead || undefined })];
}

/**
 * Folds `threads` into `prev`'s `"comment"` cards (#1120): a thread with no card here yet gets one,
 * appended in `threads`' order. Matches `foldRunStatus`'s identical update-or-append shape one
 * screen up: pure, dedup by the caller's own stable key (`thread.id`, not `card.id`) rather than
 * object identity, so a re-seed — a document reopen handing back the same set, an owner re-render,
 * a batch run's own refreshed list — can never mint a second card for the same thread.
 *
 * A thread that already has a card gets that card's `.thread` snapshot refreshed in place whenever
 * the incoming array still carries it (round-2 review finding 1, PR #1329). That snapshot — not any
 * component-local copy — is what a mounted `CommentCard` ultimately renders, which matters because
 * this stream is virtualized: a card scrolled outside the window is genuinely unmounted, so any
 * state it kept to itself is gone when it scrolls back (round-3 review finding). Keeping it here
 * makes every comment card's state panel-owned for as long as the card exists, whether its document
 * is still the active one or not.
 *
 * The refresh is scoped to one document (`root`/`path`), so a write from a card whose document is no
 * longer active can only ever touch that document's own cards. `mint: false` is that write path: it
 * refreshes what is already in the stream and never appends, since a non-active document's response
 * carries its *whole* thread list and materializing all of it would put threads in the stream the
 * user never opened that document to see. The *dedup* deliberately spans documents instead: a thread
 * id is a v4 UUID minted per event (`commands/comments.rs::mint_id`), so it cannot collide across
 * this project's sidecars, and during a document switch this panel's `threads`
 * state can still hold the previous document's set for one fold pass after `path` has advanced (the
 * #498 desync window), which a path-scoped dedup would read as "not materialized here yet" and mint
 * a second card for under the new document's path.
 *
 * Before this function existed, nothing ever called `createCommentCard` outside a test: a created
 * or loaded thread reached this panel's `threads` state (#411) and stopped there, so the Comments
 * and Findings facets stayed empty no matter how many comments existed (the root cause this card
 * fixes).
 */
export function foldCommentThreads(
  prev: TimelineCard[],
  threads: CommentThread[],
  root: string,
  owner: CommentDocumentOwner,
  options: { mint: boolean; timestamp?: string; pruneMissingId?: string },
): TimelineCard[] {
  const incomingById = new Map(threads.map((thread) => [thread.id, thread]));
  const existingThreadIds = new Set<string>();
  let refreshed = false;
  const next = prev.flatMap<TimelineCard>((card): TimelineCard[] => {
    if (card.kind !== "comment") return [card];
    // Counted for dedup before the document check, never after: the dedup spans documents while
    // the refresh below does not (see this function's docs — the #498 desync window).
    existingThreadIds.add(card.thread.id);
    const sameOwner = owner.kind === "path"
      ? card.docId === undefined && card.path === owner.path
      : card.docId === owner.docId;
    if (card.root !== root || !sameOwner) return [card];
    const incoming = incomingById.get(card.thread.id);
    // A private root withdrawn in this document is omitted from the backend's fold; keeping
    // its old stream card would leave a blank virtual row and a phantom Comments facet item.
    if (!incoming) {
      // An inactive card can refresh from a local action while other historical cards for that
      // document are not in the response (e.g. a stream with synthetic imported history). Only
      // its own target is proven gone; the active owner below provides a complete list.
      if (options.pruneMissingId !== undefined && card.thread.id !== options.pruneMissingId) return [card];
      refreshed = true;
      return [];
    }
    if (incoming === card.thread) return [card];
    refreshed = true;
    return [{ ...card, thread: incoming }];
  });
  const fresh = options.mint ? threads.filter((thread) => !existingThreadIds.has(thread.id)) : [];
  if (!refreshed && fresh.length === 0) return prev;
  return [
    ...next,
    ...fresh.map((thread) => (
      {
        ...createCommentCard(root, owner.kind === "path" ? owner.path : owner.label, thread, {
          id: `comment-${thread.id}`,
          timestamp: options.timestamp,
        }),
        ...(owner.kind === "id" ? { docId: owner.docId } : {}),
      }
    )),
  ];
}

/** Adds the synchronous queued acknowledgement unless a live activity push for the same run
 * already won the race. A late command response must never regress a running card to queued.
 *
 * A `queuedPosition` of `null` is `start_run` saying the run was accepted rather than queued, so
 * there is no queued card to add — answered here rather than at each caller, beside the race guard
 * below, so the FR-AGENT-7 rule has one home for every dispatch path that takes it (#2228). */
function acknowledgeQueuedRun(
  prev: TimelineCard[],
  result: { id: string; queuedPosition: number | null },
  timestamp?: string,
): TimelineCard[] {
  if (result.queuedPosition === null) return prev;
  if (prev.some((card) => card.kind === "agent-working" && card.runId === result.id)) return prev;
  return [
    ...prev,
    createAgentWorkingCard(
      {
        id: result.id,
        phase: { phase: "queued", position: result.queuedPosition },
        activity: [],
        elapsedSecs: 0,
      },
      { timestamp },
    ),
  ];
}

function acknowledgeAddressRun(prev: TimelineCard[], run: StartRunResult, timestamp?: string): TimelineCard[] {
  if (prev.some((card) => card.kind === "agent-working" && card.runId === run.id)) return prev;
  if (run.queuedPosition !== null) return acknowledgeQueuedRun(prev, run, timestamp);
  return [...prev, createAgentWorkingCard({
    id: run.id,
    phase: { phase: "running" },
    activity: [],
    elapsedSecs: 0,
  }, { timestamp })];
}

/** The still-queued run ids in the card stream, as one order-preserving string — a value whose
 * identity survives every card change that leaves the queued set alone, which is what lets the
 * list at the call site be memoized without `cards` in its dependencies.
 *
 * JSON rather than a joined separator: a run id reaches this module as `start_run`'s `result.id`,
 * an unvalidated value from another process, so any separator's safety would rest on a spelling
 * this code does not enforce. JSON round-trips every string, whatever it contains. */
function queuedRunIdKey(cards: TimelineCard[]): string {
  return JSON.stringify(cards.filter(isQueuedAgentWorkingCard).map((card) => card.runId));
}

/** The same card-owned queue projection, including a running card after partial delivery. */
function liveRunIdKey(cards: TimelineCard[]): string {
  return JSON.stringify(cards.filter((card): card is AgentWorkingCardData =>
    card.kind === "agent-working" &&
    (card.phase.phase === "queued" || card.phase.phase === "running")
  ).map((card) => card.runId));
}

function terminalRunIdKey(cards: TimelineCard[]): string {
  return JSON.stringify(cards.filter(isTerminalAgentWorkingCard).map((card) => card.runId));
}

/** Resolves a queued card from `stop_run`'s synchronous `cancelled` outcome. Queued runs never
 * spawn, so no later activity push exists to perform this transition for them. */
function markQueuedRunCancelled(prev: TimelineCard[], runId: string): TimelineCard[] {
  const index = prev.findIndex((card) => isQueuedAgentWorkingCard(card) && card.runId === runId);
  if (index === -1) return prev;
  const next = [...prev];
  next[index] = { ...(next[index] as AgentWorkingCardData), phase: { phase: "cancelled" } };
  return next;
}

function removeCardDecidedIds(
  previous: Record<string, Set<string>>,
  removedIds: readonly string[],
  exceptCardId?: string,
): Record<string, Set<string>> {
  let next = previous;
  for (const [cardId, ids] of Object.entries(previous)) {
    if (cardId === exceptCardId) continue;
    const remaining = removeDecidedIds(ids, removedIds);
    if (remaining === ids) continue;
    if (next === previous) next = { ...previous };
    if (remaining.size > 0) next[cardId] = remaining;
    else delete next[cardId];
  }
  return next;
}

export interface TimelineRunRevealRequest {
  /** Backend-owned run identity; the matching agent card may arrive after this request. */
  runId: string;
  /** Caller-owned activation identity. A fresh nonce deliberately replays the same reveal. */
  nonce: number;
  /** A collapsed non-comment submission lands at the feed bottom with the 4g outer focus ring. */
  landing?: "submitted-turn";
}

export interface TimelinePanelProps {
  /** Reports an admitted comment run with the card's own owner, including inactive documents. */
  onCommentRunLink?: (root: string, owner: CommentDocumentOwner, threadId: string, link: import("../comments/types").CommentRunLink) => void;
  /** App-owned platform for the 3a/3b timeline rail treatment. */
  platform?: "win" | "mac";
  /** The window's rail preference; workshop keeps the same panel visible regardless. */
  collapsed?: boolean;
  workshopMode?: boolean;
  onCollapse?: () => void;
  /** A keyboard return to the rail focuses its existing composer after it becomes visible. */
  focusComposerRequest?: number;
  onFocusComposerRequestConsumed?: (nonce: number) => void;
  /** The shell mirrors J7's pending badge while the panel is hidden. */
  onPendingPermissionChange?: (pending: boolean) => void;
  /** Activates J7 navigation after a badged collapsed host reveals this panel. */
  permissionAttentionRequest?: number;
  onPermissionAttentionRequestConsumed?: (nonce: number) => void;
  /** Seed cards (e.g. an in-memory history a caller already has); empty stream by default. When
   * `root` is also given, this is prepended to — not replaced by — the rehydrated history. */
  initialCards?: TimelineCard[];
  /** Projects this panel's sole active-facet state to authoring chrome without duplicating it. */
  onCommentModeChange?: (active: boolean) => void;
  /** Reports active and queued runs to the editor popover, which shares J10 correction gating. */
  onLiveRunIdsChange?: (runIds: readonly string[]) => void;
  /** Projects the panel's queued-phase cards to App's other comment surfaces (#2258, TD-15). */
  onQueuedRunIdsChange?: (runIds: readonly string[]) => void;
  onTerminalRunIdsChange?: (runIds: readonly string[]) => void;
  /** Height to assume for an expanded card's row before it has been mounted and measured (#1119). */
  itemHeight?: number;
  /** Injectable id generator for deterministic tests (CLAUDE.md: no reliance on real randomness in
   * tests). Defaults to `createChatMessageCard`'s own generator, which mints an id unique for the
   * lifetime of the transcript the card is persisted into, not merely this session (#1728). */
  createId?: () => string;
  /** Injectable clock for deterministic tests (CLAUDE.md: injectable clocks, no test flakiness on
   * real time). Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Project root (P2a-17, D15): when given, the panel rehydrates its prior history from the local
   * transcript store on mount and persists every newly submitted card plus one final snapshot of
   * each resolved agent run. Omitted for a surface with no project yet (FR-CHAT-1's pre-document
   * brainstorm) or in tests — the stream then stays purely in-memory, matching P2a-16's original
   * behavior. */
  root?: string;
  /** App-owned focus handoff from a permission navigation in the project this keyed panel replaced. */
  permissionProjectFocusRestore?: { target: HTMLElement | null };
  /** Records where focus sat before this panel's explicit permission navigation. */
  onPermissionNavigationActivate?: (origin: HTMLElement | null) => void;
  /** Clears the App-owned handoff after this newly mounted panel consumes it. */
  onPermissionProjectFocusRestored?: () => void;
  /** Project-relative documents this turn intends to touch (D21 operation targets). */
  operationTargets?: string[];
  /**
   * Reads every open document at submit time for FR-CHAT-4's `open_documents` envelope (#1724).
   *
   * A function, not a value: the envelope is captured when a run is *submitted*, and the active
   * document's buffer changes on every keystroke — a prop recomputed on this shell's renders would
   * name whatever was open the last time it happened to re-render. `App` supplies it by reading
   * `TabbedEditorHandle.openDocuments`, the tab layer that owns the set.
   *
   * Threaded down to every mounted `CommentCard` too, so the composer's submits and a thread's
   * `[Address with AI]` name the identical set. Defaults to "nothing open" for a panel rendered
   * without an editor beside it (FR-CHAT-1's pre-document brainstorm, and this panel's own unit
   * tests) — an explicit empty envelope, never a missing one.
   */
  openDocuments?: () => OpenDocumentsSnapshot;
  /** The open document's comment threads, for J4's batch entry point on the header (P2b-3a). The
   * header renders `[Address all… ▾]` only when `root`/`commentPath` are also given and more than
   * one of these is open; a panel with no comment surface (e.g. FR-CHAT-1's pre-document
   * brainstorm) omits them and gets no header. The panel tracks this prop — supplying a new set
   * (e.g. after a `CommentCard` in the stream resolves its own thread) re-seeds the header — and
   * between prop changes it tracks the threads a batch run itself returns.
   *
   * **The owner owes this array referential stability.** Re-seeding keys on identity, not contents,
   * precisely so a run's own refreshed threads survive the owner's next re-render. An owner that
   * rebuilds the array inline every render (`threads.filter(…)` in JSX) therefore re-seeds on every
   * render and reverts those transitions — visibly, since the reverted targets come back from the
   * next run as `skipped`. Memoize it, or hold it in the owner's state.
   *
   * **Single owner (#411).** This prop plus `onCommentThreadsChange` below are the one place this
   * document's thread state lives in the mounted app — see this file's own module doc for why that
   * pairing (not a separate global store) is the chosen design. Every mounted `CommentCard` reads
   * its own thread out of this panel's resulting `threads` state (never a `useState(card.thread)`
   * copy of its own) and reports a mutation back into it, so a transition taken on one card is
   * visible on every other card and on the header's own count in the same render pass — the named
   * defect (#350 round-3 review) this card fixes. */
  commentThreads?: CommentThread[];
  /** The document `commentThreads` belong to, relative to `root` — the batch writes against it. */
  commentPath?: string;
  /** Discriminated active owner; UUID owners omit every agent-address control. */
  commentOwner?: import("../comments/types").CommentDocumentOwner;
  /**
   * Reports this panel's own `threads` state up to the owner (#411) whenever it changes — from a
   * `CommentCard`'s mutation, or this panel's own batch-address run reading back its outcome.
   * Letting the owner (`App`) fold this into the same state it seeds `commentThreads` from is what
   * makes `App` the actual single owner across the whole mounted app, not just within one
   * `TimelinePanel` instance: without it, a document reopened in a fresh `TimelinePanel` (a new
   * project, `key={project}`) would rehydrate from whatever `App` last had — stale if a card's own
   * mutation never reached it. Omitted for a caller with no comment surface at all, matching every
   * other comment-related prop's degrade here. */
  onCommentThreadsChange?: (threads: CommentThread[]) => void;
  /** The acting local identity for batch address events (TD-4: every event carries its author),
   * matching `CommentCard`'s prop of the same name. */
  author?: string;
  /** Injectable clock for comment events — milliseconds since epoch, matching
   * `store::comments::CommentEvent.timestamp`. Distinct from `now`, which stamps chat cards with an
   * ISO string. */
  commentNow?: () => number;
  /**
   * Supplied as every mounted `ChangeSetCard`'s `onDecide` (#410) — the app shell's seam into the
   * live editor's `decisionsTransaction` (`editor/trackedChanges.ts`), reached through ids alone so
   * this module never touches a CM6 view directly (TD-13, tech-design §3.3: the timeline never
   * writes text itself). Omitted in a caller with no live editor yet (e.g. this panel's own tests),
   * leaving every change-set card's triage buttons wired to nothing, matching today's behavior.
   */
  onChangeSetDecide?: (ids: string[], decision: ChangeSetDecision) => string[] | undefined;
  /**
   * The most recent batch of ids the live editor decided (#410's editor→card direction), as a
   * one-shot event: the owner passes a *fresh array* each time (identity, not contents, is what
   * re-triggers the merge below — matching `commentThreads`' own re-seed-on-identity contract in
   * this file), never an ever-growing set it manages itself. This panel accumulates every batch it
   * sees into its own `changeSetDecidedIds` state and forwards that running set as every mounted
   * `ChangeSetCard`'s `externallyDecidedIds`, so accumulation resets exactly when this panel itself
   * remounts (`key={project}`, `App`'s own doc comment) rather than needing a second reset path the
   * owner would have to keep in lockstep. Harmless for a card whose own ids don't intersect a given
   * batch (see that prop's own superset-only contract); this panel has no per-card document linkage
   * to scope batches further with yet — a known limitation, not a promise every change-set card
   * mounted at once belongs to the same open document.
   */
  decidedChangeIds?: string[];
  /** Origin of `decidedChangeIds`: fresh editor decisions replace dormant card attribution,
   * card decisions transfer it through `onChangeSetDecide`, and redo restores it unchanged. */
  decidedChangeSource?: DecisionSource;
  /** The most recent undo batch; removed once from the running decided-id account and forwarded
   * as a one-shot event to cards already mounted for that reversal (UXR-Q5 Reversed). */
  reversedChangeIds?: string[];
  /** The active tab's triage target (UXR-Q4) — which document a change-set card's ids may be decided
   * against, and the parse generation the live field holds. Threaded straight to every `ChangeSetCard`
   * (its own `triageTarget` prop owns the three-way meaning): `undefined`/omitted leaves cards
   * ungated — a panel with no live editor wired, e.g. tests; explicit `null` means an editor is wired
   * but no tab is active, so every change-set card reads as mismatched (fail-closed); a value gates
   * each card on its own `doc`/`generation` matching it. */
  triageTarget?: ChangeSetTriageTarget | null;
  /** A newly quoted editor selection to attach to the composer (P2b-7) — see
   * `MessageComposer`'s identical prop for the attach/dismiss/replace semantics. Omitted for a
   * panel with no live editor to quote from yet (e.g. tests, or before the timeline right rail is
   * mounted — #409). */
  incomingQuote?: QuotedExcerpt | null;
  /**
   * Forwarded straight to every mounted `ChatMessageCard.onFocusQuote` (P2b-7 follow-up, #492) —
   * the deep-link-back half of Principle 6: clicking a message's quoted excerpt calls this with
   * the anchor it carries, and the owner (`App`) scrolls/selects that range in the live editor.
   * Omitted for a panel with no live editor to focus into (e.g. tests, or before `App` wires a
   * destination) — every quoted excerpt then renders as inert text, matching `ChangeSetCard`'s
   * identical "no destination, no dead click" convention for its own `onFocusChange`.
   */
  onFocusQuote?: (anchor: Anchor) => void;
  /** Opens a comment's recorded passage in its owning document. */
  onFocusCommentAnchor?: (root: string, path: string, anchor: Anchor) => void;
  /** Opens a passage in the currently active UUID-owned untitled document. */
  onFocusPathlessCommentAnchor?: (root: string, docId: string, anchor: Anchor) => void;
  /** Navigates a linked change ID in the active editor, without deciding it. */
  onFocusCommentChange?: (root: string, path: string, changeId: string) => boolean;
  /** Focuses a linked change in the currently active UUID-owned untitled tab. */
  onFocusPathlessCommentChange?: (root: string, docId: string, changeId: string) => boolean;
  /**
   * Cards the owner wants appended to the stream — how an agent-originated card (the change-set
   * card a `propose_changes` delivery raises, #346, or the document-birth card a `create_document`
   * raises, #420) reaches a panel that otherwise only ever appends the user's own submissions. Each
   * distinct stable card/run identity is appended exactly once (`appendedCardIds` and the canonical
   * merge boundary below), so an owner re-rendering with the same cards (or rebuilding the
   * array/objects) never duplicates one.
   *
   * A *list*, not a single most-recent card: the owner has more than one independent producer
   * feeding this (one Tauri event subscription per agent-notice pipe), and a single slot that a
   * later producer's write replaces is lossy — React 18 batches state updates by microtask drain
   * rather than by callsite, so two producers writing the same render can collapse into one and
   * silently lose whichever card a single slot held first (review of PR #552 @ 9e456349, Important).
   * Appending to a list means every producer's card survives that collapse; this panel already
   * dedupes by id, so it simply appends whichever entries it hasn't seen yet, in order, each time
   * the list changes.
   *
   * Deliberately does *not* touch the facet or scroll position, unlike `handleSubmit`: the user did
   * not act here, and moving their viewport or filter because the agent finished is exactly what UX
   * Principle 2 rules out. A card filtered out by the active facet stays filtered out — that is the
   * filter doing its job, not a silent no-op.
   */
  incomingCards?: TimelineCard[];
  /** Cards already appended by an authoritative backend lifecycle; merge without appending again. */
  persistedIncomingCards?: TimelineCard[];
  /**
   * Declarative project-open outcome navigation. The request remains pending until this panel owns
   * the matching run card, then reveals and focuses that card without announcing a second status.
   */
  runRevealRequest?: TimelineRunRevealRequest;
  /** Reports that the matching card, not merely its virtual-list position, received focus. */
  onRunRevealConsumed?: (nonce: number) => void;
  /** The active editor toolbar invokes this panel's single batch admission path. */
  onRegisterBatchAddress?: (action: ((threadIds: string[], includeHeldThreadIds?: string[]) => void) | null) => void;
  onBatchAddressRunningChange?: (running: boolean) => void;
  onBatchRunAccepted?: (runId: string) => void;
  onBatchAddressFailed?: (detail: string) => void;
  /** The mounted editor owns the visible trigger; keep one batch chooser per window. */
  batchAddressInEditor?: boolean;
  /** Active-run refusal whose status should clear when this panel observes its terminal card. */
  watchedRunId?: string;
  /** Reports the watched run's first observed terminal projection exactly once. */
  onWatchedRunTerminal?: (runId: string) => void;
}

/**
 * Maps a card to its renderer by `kind`. A `switch` whose `default` assigns to a `never` local —
 * with 2+ literal `kind` members TS narrows an unhandled case to `never` there, so a future card
 * kind that forgets its case here fails the build instead of throwing at runtime. `onCollapsedChange`
 * (P2b-1b) is threaded to whichever kind carries a collapse rule — the panel's own seam into
 * `collapse.ts`'s `itemHeightFor`; a kind with no collapse rule just ignores it. Completed
 * agent-working cards consume the same seam; running and unsuccessful cards remain expanded.
 * `initialCollapsed` is the same seam read back the other way: the panel's record of a choice the
 * user *explicitly* made for this card, seeded into it on (re)mount so that choice survives the card
 * leaving and re-entering the virtualized window (review finding, PR #481). Only explicit choices
 * travel this way — see `pinnedCollapsedIds` below.
 */
interface RenderCardOptions {
  batchAccounting?: { outcome: BatchAddressOutcome; batchNumber: number; conclusion?: "cancelled" };
  onCommentRunLink: TimelinePanelProps["onCommentRunLink"];
  onStopRun: (runId: string) => void;
  permissionState: PermissionState | null;
  onPermissionDecision: (runId: string, requestId: string, decision: PermissionDecision) => Promise<void>;
  permissionRunId: string | null;
  focusPermissionRequest: { runId: string; requestId: string; nonce: number } | null;
  onFocusPermissionRequestConsumed: (nonce: number) => void;
  focusRunRequest: TimelineRunRevealRequest | null;
  focusedRunLanding: TimelineRunRevealRequest | null;
  onFocusRunRequestConsumed: (nonce: number) => void;
  initialCollapsed: boolean | undefined;
  onCollapsedChange: (collapsed: boolean, explicit: boolean) => void;
  onChangeSetDecide:
    | ((
        card: Extract<TimelineCard, { kind: "change-set" }>,
        ids: string[],
        decision: ChangeSetDecision,
      ) => string[] | undefined)
    | undefined;
  externallyDecidedChangeIds: ReadonlySet<string> | undefined;
  externallyReversedChangeIds: readonly string[] | undefined;
  reachedChangeCount: number;
  decidedElsewhereCount: number;
  triageTarget: ChangeSetTriageTarget | null | undefined;
  commentThreads: CommentThread[];
  onCommentThreadsChange: (threads: CommentThread[]) => void;
  /**
   * The document `commentThreads`/`onCommentThreadsChange` currently answer for (round-2 review
   * finding 2, PR #1329) — `undefined` when this panel has no comment surface at all (mirrors the
   * `root`/`commentPath` guard everywhere else on this panel). A `"comment"` card whose own
   * `root`/`path` don't match is for a document that is no longer active: wiring the shared pair to
   * it anyway would let its actions still call the backend correctly (against *its own* root/path)
   * but broadcast the response into the *active* document's shared state through
   * `onCommentThreadsChange` — corrupting the header's open-comment count and the live editor's
   * comment set for the document that *is* active with a different document's data. This is the
   * exact pairing #498 round 1 fixed, reachable again by this route. Such a card is instead owned by
   * the panel directly (`onInactiveCommentThreadsChange` below) — it still mutates its own thread
   * through the backend, and the result still lands in state this panel holds, just its own card's
   * rather than the active document's shared set.
   */
  activeCommentDocument: { root: string; owner: CommentDocumentOwner } | undefined;
  /**
   * Where a comment card for a *non*-active document reports its own mutation (round-3 review
   * finding, PR #1329). Such a card must not reach `onCommentThreadsChange` (see above), but it
   * cannot keep the result to itself either: `CommentCard`'s standalone copy is component-local
   * `useState`, and this stream is virtualized, so scrolling the card out of the window unmounts it
   * and the next remount re-seeds from `card.thread` — rendering a thread the user has already
   * resolved as "Open", with live actions on it (a confidently-wrong position, P2/D17). Folding the
   * result into `cards` instead keeps the card's state panel-owned for its whole life.
   */
  onInactiveCommentThreadsChange: (card: CommentCardData, threads: CommentThread[]) => void;
  /**
   * Where a comment card's `[Address with AI]` reports a `start_run` that rejected outright
   * (#1777) — see `CommentCard`'s own prop. Supplied unconditionally, unlike the thread-state pair
   * above: a failure to start names no document state, so the active/non-active split those props
   * exist for does not apply to it.
   */
  onAddressRunFailed: (root: string, error: unknown) => void;
  onAddressRunStarted: (root: string, run: StartRunResult) => void;
  /** Every run this panel currently holds a *queued* card for — what tells ux-design.md §2's rung 1
   * apart from its rung 2 on a comment card (issue #2228). Derived from `cards` rather than polled:
   * the queued phase is already modelled there (`ClientRunPhase`, written from `start_run`'s
   * synchronous `queuedPosition` and promoted in place by the run's first activity push), so this
   * reuses that seam instead of adding a second run-queue reader. Supplied unconditionally, like the
   * two props above: which runs are queued is a property of the app, not of a card's document. */
  queuedRunIds: readonly string[];
  liveRunIds: readonly string[];
  terminalRunIds: readonly string[];
  /** Where a comment card's `[Address with AI]` reads FR-CHAT-4's open-document set (#1724) — see
   * `CommentCard`'s own prop. Supplied unconditionally for the same reason as the failure reporter
   * above: what is open is a property of the app, not of the card's own document. */
  openDocuments: () => OpenDocumentsSnapshot;
  onFocusQuote: ((anchor: Anchor) => void) | undefined;
  onFocusCommentAnchor: ((root: string, path: string, anchor: Anchor) => void) | undefined;
  onFocusPathlessCommentAnchor: ((root: string, docId: string, anchor: Anchor) => void) | undefined;
  onFocusCommentChange: ((root: string, path: string, changeId: string) => boolean) | undefined;
  onFocusPathlessCommentChange: ((root: string, docId: string, changeId: string) => boolean) | undefined;
}

function renderCard(card: TimelineCard, options: RenderCardOptions) {
  const {
    batchAccounting,
    onStopRun,
    initialCollapsed,
    onCollapsedChange,
    onChangeSetDecide,
    externallyDecidedChangeIds,
    externallyReversedChangeIds,
    reachedChangeCount,
    decidedElsewhereCount,
    triageTarget,
    commentThreads,
    onCommentThreadsChange,
    activeCommentDocument,
    onInactiveCommentThreadsChange,
    onAddressRunFailed,
    onAddressRunStarted,
    onCommentRunLink,
    openDocuments,
    onFocusQuote,
    onFocusCommentAnchor,
    onFocusPathlessCommentAnchor,
    onFocusCommentChange,
    onFocusPathlessCommentChange,
    queuedRunIds,
    liveRunIds,
    terminalRunIds,
    permissionState,
    onPermissionDecision,
    permissionRunId,
    focusPermissionRequest,
    onFocusPermissionRequestConsumed,
    focusRunRequest,
    focusedRunLanding,
    onFocusRunRequestConsumed,
  } = options;
  switch (card.kind) {
    case "chat-message":
      return <ChatMessageCard card={card} onFocusQuote={onFocusQuote} />;
    case "comment": {
      const isActiveDocument =
        activeCommentDocument !== undefined &&
        card.root === activeCommentDocument.root &&
        (activeCommentDocument.owner.kind === "path"
          ? card.docId === undefined && card.path === activeCommentDocument.owner.path
          : card.docId === activeCommentDocument.owner.docId);
      return (
        <CommentCard
          card={card}
          // Owned either way — by the active document's shared set, or (for a card whose document
          // is no longer active) by this panel's own `cards` entry, which is all such a card needs
          // to know about and the only copy of its state that survives virtualized unmounting.
          threads={isActiveDocument ? commentThreads : [card.thread]}
          onThreadsChange={
            isActiveDocument
              ? onCommentThreadsChange
              : (updated) => onInactiveCommentThreadsChange(card, updated)
          }
          onAddressRunFailed={onAddressRunFailed}
          onAddressRunStarted={onAddressRunStarted}
          onRunLink={(link) => onCommentRunLink?.(
            card.root,
            card.docId ? { kind: "id", docId: card.docId, label: card.path } : { kind: "path", path: card.path },
            card.thread.id,
            link,
          )}
          onFocusChange={card.docId
            ? (onFocusPathlessCommentChange
              ? (changeId) => onFocusPathlessCommentChange(card.root, card.docId!, changeId)
              : undefined)
            : (onFocusCommentChange
              ? (changeId) => onFocusCommentChange(card.root, card.path, changeId)
              : undefined)}
          onFocusAnchor={card.docId
            ? (onFocusPathlessCommentAnchor
              ? (anchor) => onFocusPathlessCommentAnchor(card.root, card.docId!, anchor)
              : undefined)
            : (onFocusCommentAnchor
              ? (anchor) => onFocusCommentAnchor(card.root, card.path, anchor)
              : undefined)}
          openDocuments={openDocuments}
          initialCollapsed={initialCollapsed}
          onCollapsedChange={onCollapsedChange}
          queuedRunIds={queuedRunIds}
          liveRunIds={liveRunIds}
          terminalRunIds={terminalRunIds}
          permissionRunId={permissionRunId}
        />
      );
    }
    case "change-set":
      return (
        <ChangeSetCard
          card={card}
          initialCollapsed={initialCollapsed}
          onCollapsedChange={onCollapsedChange}
          onDecide={
            onChangeSetDecide
              ? (ids, decision) => onChangeSetDecide(card, ids, decision)
              : undefined
          }
          externallyDecidedIds={externallyDecidedChangeIds}
          externallyReversedIds={externallyReversedChangeIds}
          reachedChangeCount={reachedChangeCount}
          decidedElsewhereCount={decidedElsewhereCount}
          triageTarget={triageTarget}
        />
      );
    case "agent-working":
      return (
        <AgentWorkingCard
          card={card}
          batchAccounting={batchAccounting}
          onStop={onStopRun}
          permissionState={permissionState}
          onPermissionDecision={onPermissionDecision}
          focusPermissionRequest={
            focusPermissionRequest?.runId === card.runId ? focusPermissionRequest : undefined
          }
          onFocusPermissionRequestConsumed={onFocusPermissionRequestConsumed}
          focusCardRequest={focusRunRequest?.runId === card.runId ? focusRunRequest : undefined}
          submittedTurnLanding={focusedRunLanding?.runId === card.runId
            && focusedRunLanding.landing === "submitted-turn"}
          onFocusCardRequestConsumed={onFocusRunRequestConsumed}
          initialCollapsed={initialCollapsed}
          onCollapsedChange={onCollapsedChange}
        />
      );
    case "document-birth":
      return <DocumentBirthCard card={card} />;
    case "untitled-adoption":
      return <UntitledAdoptionCard card={card} />;
    case "project-grounding":
      return <ProjectGroundingCard card={card} />;
    default: {
      const exhaustive: never = card;
      throw new Error(`Unknown timeline card kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The right-rail panel: a virtualized card stream over `MessageInput`, optionally backed by the
 * per-project local transcript store (P2a-17, D15 — `root` prop) for rehydrate-on-reopen and
 * append-on-submit/final-run. A facet bar (P2b-1a) filters the stream by card kind and jumps to the
 * most recent card of the selected kind on select; comment, decided-change, and successfully
 * completed-run cards share the panel-owned collapse/virtualization seam. Submit (P2b-1c, UXR-Q2)
 * never changes the active facet: it scrolls to the user's own card when the facet includes it, or
 * surfaces the `N new in <Facet> →` affordance when it doesn't — and `VirtualList` itself
 * tail-follows a reader still at the stream's end for every other append (an agent delivery, a
 * remote collaborator's edit).
 *
 * **Design decision (#411): prop-as-source-of-truth, not a separate global store.** The #411 issue
 * named two options for giving comment threads a single owner in the mounted app — a shared
 * store for the whole document, or the owner's own state threaded down as a prop the way
 * `decidedChangeIds` (#410) already is. This module takes the second: `App` (the mounted app
 * shell) holds the current document's `CommentThread[]` in its own state, loaded from
 * `store::comments` through the existing `comments/ipc.ts` bridge, and passes it down as
 * `commentThreads`/`onCommentThreadsChange`. This panel is the one place that state fans out to
 * every reader within a document (the header's `[Address all… ▾]` trigger and every mounted
 * `CommentCard`) and the one place a card's mutation fans back in, but it holds no state `App`
 * doesn't ultimately own — the `threads` local state below exists only because `App` can't
 * synchronously see this panel's own batch-run/card-mutation results without this panel relaying
 * them back up (`onCommentThreadsChange`), not because this panel is a second, independent owner.
 * Chosen over a dedicated `stores/comments.ts` singleton/context because: (1) it matches the
 * pattern this exact prop set already established for `decidedChangeIds`/`onChangeSetDecide`
 * (#410) rather than introducing a second state-sharing mechanism for one sibling concern; (2)
 * `stores/` (tech-design §3.1) is documented as *display state only, all authority in Rust* — a
 * plain prop/state pair over the existing IPC fold is that, unchanged, where a module-level
 * singleton would be new frontend-owned authority with its own lifecycle to reason about; (3) the
 * "one store, not one per surface" reading of D6/UX Principle 5 is about *how many independent
 * copies exist*, not about the copy living in a specifically-named module — a single `useState` in
 * `App`, threaded through props with no other copy anywhere, already satisfies it. The cost this
 * choice accepts: every reader between `App` and a `CommentCard` (here, `TimelinePanel`) must
 * thread both halves of the pair through by hand rather than a context/store read reaching
 * arbitrarily deep — acceptable at today's one-level nesting, and revisit if a third comment
 * surface needs the same state without sitting inside this panel.
 *
 * **Ratified as TD-15** (`docs/tech-design.md` decision log, 2026-07-21): the §3.1 `stores/` list is
 * logical, not mandatory, and this App-sited `useState`-over-IPC-fold idiom is the recorded home for
 * this class of display state — precedent extending to the `changes`/`review` stores too. The
 * reasoning above is preserved verbatim from round 1's review; this paragraph is only the pointer a
 * later reader needs to know it's no longer an open question.
 * #2258 reached the recorded third-surface revisit trigger. CJ kept the App prop path: this
 * panel projects its queued-card IDs upward, and App forwards those exact IDs to the active editor
 * popover and collapsed comments column. `docs/tech-design.md` TD-15's revisit row owns the call.
 */
// @anchor:timeline-panel-td15-doc
export function TimelinePanel({
  onCommentRunLink,
  platform = isMac ? "mac" : "win",
  collapsed = false,
  workshopMode = false,
  onCollapse,
  focusComposerRequest = 0,
  onFocusComposerRequestConsumed,
  onPendingPermissionChange,
  permissionAttentionRequest = 0,
  onPermissionAttentionRequestConsumed,
  initialCards = [],
  onCommentModeChange,
  onLiveRunIdsChange,
  onQueuedRunIdsChange,
  onTerminalRunIdsChange,
  itemHeight = DEFAULT_ITEM_HEIGHT,
  createId,
  now,
  root,
  permissionProjectFocusRestore,
  onPermissionNavigationActivate,
  onPermissionProjectFocusRestored,
  operationTargets,
  openDocuments = NO_OPEN_DOCUMENTS_READER,
  commentThreads,
  commentPath,
  commentOwner,
  onCommentThreadsChange,
  author = "you",
  commentNow,
  onChangeSetDecide,
  decidedChangeIds,
  decidedChangeSource,
  reversedChangeIds,
  triageTarget,
  incomingQuote,
  onFocusQuote,
  onFocusCommentAnchor,
  onFocusPathlessCommentAnchor,
  onFocusCommentChange,
  onFocusPathlessCommentChange,
  incomingCards,
  persistedIncomingCards,
  runRevealRequest,
  onRunRevealConsumed,
  onRegisterBatchAddress,
  onBatchAddressRunningChange,
  onBatchRunAccepted,
  onBatchAddressFailed,
  batchAddressInEditor = false,
  watchedRunId,
  onWatchedRunTerminal,
}: TimelinePanelProps) {
  const [cards, setCards] = useState<TimelineCard[]>(initialCards);
  const composerRef = useRef<HTMLDivElement>(null);
  const handledFocusComposerRequest = useRef(0);
  const handledPermissionAttentionRequest = useRef(0);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const [activeFacetId, setActiveFacetId] = useState<string>(ALL_FACET_ID);
  const [scrollRequest, setScrollRequest] = useState<VirtualListScrollRequest | undefined>(undefined);
  const [threads, setThreads] = useState<CommentThread[]>(commentThreads ?? []);
  const [batchOutcomes, setBatchOutcomes] = useState<{
    root: string;
    path: string;
    outcome: BatchAddressOutcome;
    hasRun: boolean;
    conclusion?: "cancelled";
  }[]>([]);
  const recordBatchOutcome = (ownerRoot: string, ownerPath: string, outcome: BatchAddressOutcome, hasRun: boolean) => {
    setBatchOutcomes((previous) => {
      const entry = { root: ownerRoot, path: ownerPath, outcome, hasRun,
        ...(cancelledRunIdsRef.current.has(outcome.run_id) ? { conclusion: "cancelled" as const } : {}) };
      const index = previous.findIndex((item) => item.outcome.run_id === outcome.run_id);
      if (index < 0) return [...previous, entry];
      return previous.map((item, at) => at === index ? entry : item);
    });
  };
  const currentBatchOutcomes = useMemo(() => batchOutcomes
    .filter((entry) => entry.root === root && entry.path === commentPath)
    .map((entry, index) => ({ ...entry, batchNumber: index + 1 })), [batchOutcomes, root, commentPath]);
  const batchAccountingByRun = useMemo(() => new Map(currentBatchOutcomes
    .filter((entry) => entry.hasRun)
    .map(({ outcome, batchNumber, conclusion }) => [outcome.run_id, { outcome, batchNumber, conclusion }] as const)),
  [currentBatchOutcomes]);
  // A no-run failure has no card of its own. Once a later admission succeeds, its run card owns
  // the visible status and the old header warning can retire.
  const lastBatchOutcome = currentBatchOutcomes[currentBatchOutcomes.length - 1];
  const latestNoRunBatch = lastBatchOutcome?.hasRun ? undefined : lastBatchOutcome;
  const [running, setRunning] = useState(false);
  const [separateAdmissionRevision, setSeparateAdmissionRevision] = useState(0);
  // A terminal activity push can beat the atomic batch admission response. Hold only a run that
  // may be that batch until its response supplies the id and J13 disclosure. Known other runs
  // retain their normal D15 append path during the admission.
  const batchAdmissionPending = useRef<{ knownOtherRunIds: Set<string> } | null>(null);
  // J7 permission requests are live broker state, not transcript cards. Keeping the snapshot
  // beside the run-card stream lets the matching card render it without ever passing the payload
  // through D15's append path. The App remounts this panel per project; the root-keyed effect
  // below also resets explicitly so a standalone caller that reuses the instance cannot carry a
  // revision floor or request across projects.
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);
  const permissionRevision = useRef(-1);
  // P2b-1b: which card ids a mounted card has actually reported as collapsed (or not) — see
  // `collapse.ts`'s `itemHeightFor`, which falls back to a purely data-driven default for any card
  // id absent here (never yet mounted, e.g. still off-screen in the virtualized window). Per-card
  // view state, never persisted: it lives only in this panel's memory, exactly like `activeFacetId`.
  const [effectiveCollapsedIds, setEffectiveCollapsedIds] = useState<Record<string, boolean>>({});
  // The strict subset of the above the user *chose* by clicking Expand/Collapse, read back down as
  // `initialCollapsed` so that choice survives a card unmounting (scrolling out of the virtualized
  // window) and remounting, instead of snapping back to the default.
  //
  // Deliberately a second map, and named for the distinction: `effectiveCollapsedIds` records each
  // card's *current* state, which every mounted card reports whether or not the user ever touched it.
  // Seeding a card from it pins an override the user never chose, so after one scroll cycle the
  // card stops following its collapse-by-default rule entirely — a resolved thread or fully-decided
  // change-set pinned open forever (review finding, PR #481). The two answer different questions
  // and only the explicit one may be pinned.
  const [pinnedCollapsedIds, setPinnedCollapsedIds] = useState<Record<string, boolean>>({});
  // #410's editor→card direction: every id `decidedChangeIds` reports, plus every settled batch a
  // card action returns directly, is accumulated across this panel's own lifetime until an explicit
  // UXR-Q5 reversal removes it (resets on remount, `key={project}`, exactly like `cards` itself —
  // see this prop's own module docs for why accumulating here rather than in the owner is correct).
  // @anchor:timeline-panel-change-set-decided-ids
  const [changeSetDecidedIds, setChangeSetDecidedIds] = useState<Set<string>>(new Set());
  // The ids each card last retired through its own controls. Visibility is their intersection with
  // the current document-wide set above: reversal withdraws the claim while redo can restore its
  // attribution, without teaching the editor layer about timeline-card ownership (UXR-Q5).
  // `decidedChangeSource` now distinguishes redo from a fresh in-editor decision after reversal;
  // the latter removes this dormant attribution before it becomes visible again (#798).
  const [selfDecidedIdsByCard, setSelfDecidedIdsByCard] = useState<Record<string, Set<string>>>({});
  // UXR-Q5's acting-card provenance: every outside-set id each card's last decision outcome reached.
  // This belongs beside the panel's decided-id accumulator, not in a virtualized card instance, so
  // scrolling cannot erase it. Reversal hides the association; redo restores it, while an explicit
  // later action from another card transfers ownership in `handleChangeSetDecide`.
  const [reachedIdsByCard, setReachedIdsByCard] = useState<Record<string, Set<string>>>({});
  // The `N new in <Facet> →` affordance (P2b-1c, UXR-Q2): set when the user's own submit lands a
  // card the active facet excludes (nothing to scroll to — see `handleSubmit`), `undefined` when
  // there is nothing pending. Per-card view state, never persisted, exactly like `activeFacetId`.
  const [newInFacet, setNewInFacet] = useState<{ facet: Facet; count: number } | undefined>(undefined);
  const [focusPermissionRequest, setFocusPermissionRequest] = useState<{
    runId: string;
    requestId: string;
    nonce: number;
  } | null>(null);
  const [focusRunRequest, setFocusRunRequest] = useState<TimelineRunRevealRequest | null>(null);
  const [focusedRunLanding, setFocusedRunLanding] = useState<TimelineRunRevealRequest | null>(null);
  const preparedRunReveal = useRef<string | null>(null);
  const reportedTerminalRun = useRef<string | null>(null);
  const permissionActivationNonce = useRef(0);
  const timelineHostRef = useRef<HTMLElement | null>(null);
  const announcedPermissionHeads = useRef(new Set<string>());
  const [permissionAnnouncement, setPermissionAnnouncement] = useState<string | null>(null);
  // ux-design §2 "Timeline facet empty states" (#1727/#1813): an empty claim may only follow a
  // successful, settled answer about the project's history. A rejection is a distinct unavailable
  // state, not completed-empty; without a `root`, there is nothing to rehydrate and the answer is
  // already loaded. `root` is fixed for this component's lifetime (the owner remounts on
  // `key={project}`, `App.tsx`). The attempt counter lets the unavailable treatment retry this read
  // alone without disturbing any cards already in memory.
  const [transcriptLoadState, setTranscriptLoadState] = useState<"loading" | "loaded" | "failed">(
    root ? "loading" : "loaded",
  );
  const [transcriptLoadAttempt, setTranscriptLoadAttempt] = useState(0);
  // D15 stores one final agent-working snapshot per run, never a live/queued intermediate one.
  // Seeded from caller-owned history so an `initialCards` terminal is not mistaken for a fresh
  // lifecycle transition on the first effect pass. Rehydrated history joins this set before it is
  // added to state below; the key is the run identity, not a card id `loadTranscript` may re-key.
  const persistedTerminalRunIds = useRef(
    new Set(
      initialCards
        .filter(isTerminalAgentWorkingCard)
        .map((card) => card.runId),
    ),
  );
  const persistedContinuityNoticeIds = useRef(
    new Set(initialCards.filter(isContinuityNoticeCard).map((card) => card.id)),
  );

  const filteredCards = useMemo(() => filterCardsByFacet(cards, activeFacetId), [cards, activeFacetId]);

  useEffect(() => {
    if (reportedTerminalRun.current !== watchedRunId) reportedTerminalRun.current = null;
    if (!watchedRunId || reportedTerminalRun.current === watchedRunId) return;
    const watched = cards.find(
      (card): card is AgentWorkingCardData =>
        card.kind === "agent-working" && card.runId === watchedRunId,
    );
    if (!watched || watched.phase.phase === "running" || watched.phase.phase === "queued") return;
    reportedTerminalRun.current = watchedRunId;
    onWatchedRunTerminal?.(watchedRunId);
  }, [cards, watchedRunId, onWatchedRunTerminal]);

  // J9 project-open outcome navigation can race the run card's activity/terminal push. Keep the
  // declarative request untouched until that card exists, then choose the narrowest current view
  // that still contains it. A fresh nonce is a fresh user navigation, including to the same run;
  // a rerender carrying the same pair is inert and cannot steal focus a second time.
  useEffect(() => {
    if (!runRevealRequest) return;
    const requestKey = `${runRevealRequest.runId}\u0000${runRevealRequest.nonce}`;
    if (preparedRunReveal.current === requestKey) return;

    const runCard = cards.find(
      (card): card is AgentWorkingCardData =>
        card.kind === "agent-working" && card.runId === runRevealRequest.runId,
    );
    if (!runCard) return;

    const targetFacetId =
      filterCardsByFacet([runCard], activeFacetId).length > 0 ? activeFacetId : ALL_FACET_ID;
    const targetCards = filterCardsByFacet(cards, targetFacetId);
    const index = targetCards.findIndex(
      (card) => card.kind === "agent-working" && card.runId === runRevealRequest.runId,
    );
    if (index < 0) return;

    preparedRunReveal.current = requestKey;
    if (targetFacetId !== activeFacetId) {
      setActiveFacetId(targetFacetId);
      onCommentModeChange?.(false);
      setNewInFacet(undefined);
    }
    // VirtualList aligns its measured row box. A run card sits inside it with a 6px margin
    // (2px when compact), so request the remaining 4g bottom or J9 top clearance for the visible
    // card box. The virtualizer supplies edge space when the feed itself is too short.
    const compact = pinnedCollapsedIds[runCard.id] ?? isAgentWorkingCollapsedByDefault(runCard);
    setScrollRequest(runRevealRequest.landing === "submitted-turn"
      ? { index, reveal: "bottom-with-clearance", bottomClearance: compact ? 10 : 6 }
      : { index, reveal: "top-with-clearance", topClearance: compact ? 10 : 6 });
    setFocusedRunLanding(runRevealRequest);
    setFocusRunRequest(runRevealRequest);
  }, [runRevealRequest, cards, activeFacetId, onCommentModeChange, pinnedCollapsedIds]);
  // ux-design.md §2's rung 1 (issue #2228): which of the runs this panel knows about are still
  // *queued*, so a comment card holding one of them can say "Queued behind an agent run" rather
  // than the rung 2 it would otherwise fall back to. Read off `cards`, the one place the queued
  // phase is already modelled (`acknowledgeQueuedRun` writes it from `start_run`'s synchronous
  // `queuedPosition`; `foldRunStatus` promotes it in place on the run's first activity push, and
  // `markQueuedRunCancelled` resolves a cancelled one) — never a second run-queue reader beside it.
  // Derived from the unfiltered `cards`, not `filteredCards`: whether a run is queued is a fact
  // about the run, not about which facet the user is looking at.
  //
  // Memoized on the *content* rather than on `cards`, which changes on every activity push: this
  // value feeds `renderTimelineCard`'s dependency array, whose identity stability across renders
  // that change nothing it reads is itself a recorded finding (PR #477 round 1). Keying on `cards`
  // would invalidate every card's render callback on every pushed `RunStatus`.
  // Two memos, not one: keying the *string* on `cards` keeps the O(n) walk off every render this
  // panel does for a reason unrelated to its card stream (a mounted card reporting its collapse
  // state, a thread change), while keying the *list* on the string keeps its identity stable
  // across the card changes that leave the queued set alone.
  const queuedRunIdsKey = useMemo(() => queuedRunIdKey(cards), [cards]);
  const queuedRunIds = useMemo(() => JSON.parse(queuedRunIdsKey) as string[], [queuedRunIdsKey]);
  useEffect(() => onQueuedRunIdsChange?.(queuedRunIds), [queuedRunIds, onQueuedRunIdsChange]);
  const liveRunIdsKey = useMemo(() => liveRunIdKey(cards), [cards]);
  const liveRunIds = useMemo(() => JSON.parse(liveRunIdsKey) as string[], [liveRunIdsKey]);
  useEffect(() => onLiveRunIdsChange?.(liveRunIds), [liveRunIds, onLiveRunIdsChange]);
  const terminalRunIdsKey = useMemo(() => terminalRunIdKey(cards), [cards]);
  const terminalRunIds = useMemo(() => JSON.parse(terminalRunIdsKey) as string[], [terminalRunIdsKey]);
  useEffect(() => onTerminalRunIdsChange?.(terminalRunIds), [terminalRunIds, onTerminalRunIdsChange]);
  const permissionRunId = useMemo(() => {
    if (!permissionState?.runId || permissionState.requests.length === 0) return null;
    return cards.some(
      (card) =>
        card.kind === "agent-working" &&
        card.runId === permissionState.runId &&
        card.phase.phase === "running",
    )
      ? permissionState.runId
      : null;
  }, [cards, permissionState]);
  const pendingPermission =
    permissionRunId && permissionState?.runId === permissionRunId
      ? permissionState.requests[0] ?? null
      : null;
  const hasPendingPermission = pendingPermission !== null;
  useEffect(() => onPendingPermissionChange?.(hasPendingPermission), [hasPendingPermission, onPendingPermissionChange]);
  useLayoutEffect(() => {
    if (collapsed || workshopMode || focusComposerRequest <= handledFocusComposerRequest.current) return;
    const composer = composerRef.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) return;
    composer.focus({ preventScroll: true });
    handledFocusComposerRequest.current = focusComposerRequest;
    onFocusComposerRequestConsumed?.(focusComposerRequest);
  }, [collapsed, focusComposerRequest, onFocusComposerRequestConsumed, workshopMode]);
  const permissionScrollKey =
    permissionRunId && permissionState
      ? `${permissionState.projectId ?? ""}\u0000${permissionRunId}\u0000${permissionState.requests
          .map(({ id }) => id)
          .join("\u0000")}`
      : "";
  const cardItemHeight = (card: TimelineCard) => itemHeightFor(card, effectiveCollapsedIds, itemHeight, liveRunIds, terminalRunIds);
  // Stable identity for the same reason `handleStopRun` has one (PR #477 round 1, Minor): it is
  // reached through `renderItem`'s closure. Both setters are themselves stable, so this has no deps.
  const handleCardCollapsedChange = useCallback((id: string, collapsed: boolean, explicit: boolean) => {
    setEffectiveCollapsedIds((prev) => (prev[id] === collapsed ? prev : { ...prev, [id]: collapsed }));
    // A card only ever gains an explicit choice (a click), so there is nothing to un-pin here.
    if (explicit) {
      setPinnedCollapsedIds((prev) => (prev[id] === collapsed ? prev : { ...prev, [id]: collapsed }));
    }
  }, []);

  const handleFacetSelect = (facetId: string) => {
    setActiveFacetId(facetId);
    onCommentModeChange?.(facetId === "comments");
    // Every facet change dismisses a pending `N new in <Facet> →` affordance (P2b-1c, UXR-Q2's
    // dismiss-on-"any facet change" rule) — whether the click came from this affordance itself (see
    // its own `onClick` below, wired straight to this handler) or directly from `FacetBar`. The
    // remaining dismiss rule the acceptance criteria names, "scrolling to the card manually", isn't
    // separately reachable: the affordance only ever exists for a card the *active* facet excludes,
    // so nothing under the current filter can scroll to it without a facet change happening first —
    // and the facet-jump immediately below is what lands on it the moment that happens.
    setNewInFacet(undefined);
    // Facet-jump (ux-design §4 "Timeline at scale"): bring the most recent card of the newly
    // selected facet's kind into view. A facet with no matching cards (e.g. Findings before
    // P2b-5b) or "All" (no single "most recent kind") clears any pending jump instead — a no-op,
    // never a throw.
    const index = facetJumpIndex(facetId, filterCardsByFacet(cards, facetId));
    setScrollRequest(index === undefined ? undefined : { index });
  };

  const handlePermissionAttentionActivate = useCallback((origin: HTMLElement | null) => {
    if (!permissionRunId || !pendingPermission) return;
    const chatCards = filterCardsByFacet(cards, "chat");
    const index = chatCards.findIndex(
      (card) => card.kind === "agent-working" && card.runId === permissionRunId,
    );
    if (index < 0) return;
    const runCard = chatCards[index];
    const active = document.activeElement;
    const focusOrigin = origin ?? (active instanceof HTMLElement ? active : null);
    onPermissionNavigationActivate?.(
      focusOrigin && focusOrigin !== document.body && focusOrigin !== timelineHostRef.current
        ? focusOrigin : null,
    );
    setActiveFacetId("chat");
    onCommentModeChange?.(false);
    setNewInFacet(undefined);
    setPinnedCollapsedIds((prev) => ({ ...prev, [runCard.id]: false }));
    setEffectiveCollapsedIds((prev) => ({ ...prev, [runCard.id]: false }));
    setScrollRequest({ index });
    permissionActivationNonce.current += 1;
    setFocusPermissionRequest({
      runId: permissionRunId,
      requestId: pendingPermission.id,
      nonce: permissionActivationNonce.current,
    });
  }, [cards, onCommentModeChange, onPermissionNavigationActivate, pendingPermission, permissionRunId]);

  useEffect(() => {
    if (collapsed || workshopMode || permissionAttentionRequest <= handledPermissionAttentionRequest.current) return;
    handledPermissionAttentionRequest.current = permissionAttentionRequest;
    handlePermissionAttentionActivate(null);
    onPermissionAttentionRequestConsumed?.(permissionAttentionRequest);
  }, [collapsed, handlePermissionAttentionActivate, onPermissionAttentionRequestConsumed, permissionAttentionRequest, workshopMode]);

  const handlePermissionRequestFocusConsumed = useCallback((nonce: number) => {
    setFocusPermissionRequest((current) => current?.nonce === nonce ? null : current);
  }, []);

  const handleRunCardFocusConsumed = useCallback((nonce: number) => {
    setFocusRunRequest((current) => current?.nonce === nonce ? null : current);
    onRunRevealConsumed?.(nonce);
  }, [onRunRevealConsumed]);

  // Three things move these threads, and each has to reach this one state or the header/cards
  // disagree (#411, the #350 round-3 review finding this card fixes): this panel's own batch runs
  // (`handleAddressAll` below), a mounted `CommentCard`'s own mutation (`handleThreadsChange` below
  // — every card reads/writes this same `threads` state instead of a private copy), and the owner
  // re-rendering with a fresh set (e.g. after its own rehydrate, or a document switch). Seeding
  // `threads` once would track only the last of these, leaving the header asserting J4's ">1 open
  // comment" against a set it stopped following: still counting a resolved comment as open, and
  // still naming it as a batch target. Re-seeding on a new prop identity keeps every source live, and
  // keying on identity (not contents) is what lets a run's own refreshed threads (or a card's own)
  // survive the owner's next re-render — the owner passing the same array is not new information.
  useEffect(() => {
    if (!commentThreads) return;
    setThreads(commentThreads);
    // The second writer of this state, and it needs the same mutation-time ref write as
    // `handleThreadsChange` for the same reason: a conclusion racing this re-seed would otherwise
    // read the list one render behind. Every writer of `threads`, not only the one a defect was
    // reported through (round-3 review, PR #2260).
    commentContextRef.current.threads = commentThreads;
  }, [commentThreads]);

  // Materializes every thread this panel's `threads` state carries into exactly one `"comment"`
  // stream card (#1120) — see `foldCommentThreads` for the dedup/refresh contract itself. Runs
  // whenever `threads` changes: a fresh thread arriving via the effect just above (a create, or a
  // document's threads loading for the first time), or a mounted card's/batch run's own mutation
  // reaching this same state. Guarded on `root`/`commentPath` exactly like the header trigger
  // below — the same "no comment surface at all" degrade every other comment-related prop on this
  // panel already follows. Only the *active* document's threads are materialized, and a comment
  // card is never persisted to the transcript, so reopening a project re-derives comment cards one
  // document at a time as each is opened — deliberate: the transcript rehydrate prepends its cards
  // without a thread-id dedup, so persisting them is what would double them.
  useEffect(() => {
    const owner = commentOwner ?? (commentPath ? { kind: "path" as const, path: commentPath } : undefined);
    if (!root || !owner) return;
    setCards((prev) => foldCommentThreads(prev, threads, root, owner, { mint: true, timestamp: now?.() }));
    // `now` is a per-render seam (the D23 test clock), not a re-fold trigger — mirrors the
    // agent-activity subscription effect's identical reasoning elsewhere in this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, root, commentPath, commentOwner]);

  // The write half of the single-owner pair (#411): a mounted `CommentCard`'s mutation result (the
  // *document's whole* updated thread list every `comments/ipc.ts` call already returns, per that
  // module's own docs) lands here — the same state the header's `[Address all… ▾]` trigger and
  // every other mounted `CommentCard` read — and is forwarded to the owner so a document reopened in
  // a fresh `TimelinePanel` rehydrates from a set that actually reflects it (see `onCommentThreadsChange`'s
  // own docs for why that matters beyond this one panel instance).
  const handleThreadsChange = useCallback(
    (updated: CommentThread[]) => {
      setThreads(updated);
      // The conclusion path reads this document's threads out of `commentContextRef`, which the
      // component body assigns — so a reader running before the next render would see the
      // pre-mutation list. Writing it here as well makes the ref *mutation*-current rather than
      // render-current, which is what lets a conclusion that races this call still find its
      // targets (round-3 review, PR #2260). The body's own assignment then rewrites the identical
      // value on the next render.
      commentContextRef.current.threads = updated;
      onCommentThreadsChange?.(updated);
    },
    [onCommentThreadsChange],
  );

  // The same write half for a comment card whose document is no longer active (round-3 review
  // finding, PR #1329). Its mutation is legitimate — the backend call targets that card's own
  // `root`/`path` — but it must not reach the *active* document's shared set (`handleThreadsChange`
  // above), so it lands in that card's own `cards` entry instead: refresh-only, scoped to the card's
  // document, which is what keeps the card's state panel-owned across the unmount/remount cycle
  // virtualization puts every off-window row through.
  const handleInactiveThreadsChange = useCallback((card: CommentCardData, updated: CommentThread[]) => {
    setCards((prev) => foldCommentThreads(
      prev,
      updated,
      card.root,
      card.docId
        ? { kind: "id", docId: card.docId, label: card.path }
        : { kind: "path", path: card.path },
      { mint: false, pruneMissingId: card.thread.id },
    ));
  }, []);

  // Subscribe before asking for the initial snapshot so a request raised during hydration cannot
  // fall into the gap. Events wait in a short-lived buffer until hydration names this project
  // broker; snapshots from the broker for a project we just left are then discarded before their
  // project-local revisions can compete with the current project's revision floor.
  useEffect(() => {
    permissionRevision.current = -1;
    announcedPermissionHeads.current.clear();
    setPermissionAnnouncement(null);
    setFocusPermissionRequest(null);
    setPermissionState(null);
    if (!root) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let projectId: string | null | undefined;
    const buffered = new Map<string | null, PermissionState>();
    let hydrationInFlight = false;
    let hydrationRetryPending = false;
    const acceptRevision = (next: PermissionState) => {
      if (cancelled || next.revision < permissionRevision.current) return;
      permissionRevision.current = next.revision;
      setPermissionState(next);
    };
    const acceptEvent = (next: PermissionState) => {
      if (cancelled) return;
      if (projectId === undefined) {
        const previous = buffered.get(next.projectId);
        if (!previous || next.revision >= previous.revision) buffered.set(next.projectId, next);
        identifyProject();
        return;
      }
      if (next.projectId !== projectId) return;
      acceptRevision(next);
    };
    const hydrate = (initial: PermissionState) => {
      if (cancelled) return;
      projectId = initial.projectId;
      const pending = buffered.get(projectId);
      const newest = pending && pending.revision >= initial.revision ? pending : initial;
      buffered.clear();
      acceptRevision(newest);
    };
    function identifyProject() {
      if (cancelled || projectId !== undefined) return;
      if (hydrationInFlight) {
        hydrationRetryPending = true;
        return;
      }
      hydrationInFlight = true;
      void getPermissionState()
        .then(hydrate)
        .catch(() => {})
        .finally(() => {
          hydrationInFlight = false;
          if (cancelled || projectId !== undefined || !hydrationRetryPending) return;
          hydrationRetryPending = false;
          identifyProject();
        });
    }

    void listenToPermissionState(acceptEvent)
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        identifyProject();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [root]);

  useLayoutEffect(() => {
    if (!permissionProjectFocusRestore) return;
    const target = permissionProjectFocusRestore.target?.isConnected
      ? permissionProjectFocusRestore.target
      : timelineHostRef.current;
    target?.focus({ preventScroll: true });
    onPermissionProjectFocusRestored?.();
  }, [onPermissionProjectFocusRestored, permissionProjectFocusRestore]);

  const permissionHeadIdentity =
    permissionRunId && pendingPermission && permissionState?.projectId
      ? `${permissionState.projectId}\u0000${permissionRunId}\u0000${pendingPermission.id}`
      : null;
  useEffect(() => {
    if (!permissionHeadIdentity) {
      setPermissionAnnouncement(null);
      return;
    }
    if (announcedPermissionHeads.current.has(permissionHeadIdentity)) return;
    announcedPermissionHeads.current.add(permissionHeadIdentity);
    setPermissionAnnouncement(permissionHeadIdentity);
  }, [permissionHeadIdentity]);

  const handlePermissionDecision = useCallback(
    (runId: string, requestId: string, decision: PermissionDecision) =>
      decidePermission(runId, requestId, decision),
    [],
  );

  // A mounted `CommentCard`'s `[Address with AI]` reporting a `start_run` that rejected outright
  // (#1777). Folded through the *same* `failedRunStatus`/`foldRunStatus` pair `handleSubmit`'s own
  // rejected composer call uses below, so the user gets one honest terminal-state rendering of "no
  // run started, here is why" wherever they asked for the run — never a second error presentation
  // bolted onto the thread card. `failedRunStatus`'s own doc carries the rest, including why no
  // thread state is touched on this path.
  const handleAddressRunFailed = useCallback(
    (_root: string, error: unknown) => {
      setCards((prev) => foldRunStatus(prev, failedRunStatus(error), now?.()));
    },
    [now],
  );
  const handleAddressRunStarted = useCallback((_root: string, run: StartRunResult) => {
    if (batchAdmissionPending.current) {
      batchAdmissionPending.current.knownOtherRunIds.add(run.id);
      setSeparateAdmissionRevision((revision) => revision + 1);
    }
    setCards((prev) => acknowledgeAddressRun(prev, run, now?.()));
  }, [now]);

  // Merges each new `decidedChangeIds` batch into the running set every mounted `ChangeSetCard`
  // reconciles against. A fresh editor decision also clears dormant card/reach attribution for
  // those ids; a card action transfers attribution in `handleChangeSetDecide`, while redo preserves
  // it. Decision batches only add; the explicit reversal effect below is the sole subtractive path.
  useEffect(() => {
    if (!decidedChangeIds || decidedChangeIds.length === 0) return;
    setChangeSetDecidedIds((prev) => mergeDecidedIds(prev, decidedChangeIds));
    if (decidedChangeSource === "editor") {
      setSelfDecidedIdsByCard((prev) => removeCardDecidedIds(prev, decidedChangeIds));
      setReachedIdsByCard((prev) => removeCardDecidedIds(prev, decidedChangeIds));
    }
  }, [decidedChangeIds, decidedChangeSource]);

  useEffect(() => {
    if (!reversedChangeIds || reversedChangeIds.length === 0) return;
    setChangeSetDecidedIds((prev) => removeDecidedIds(prev, reversedChangeIds));
    // Attribution remains dormant while its visibility is derived from `changeSetDecidedIds`.
    // Redo restores it; a fresh editor report clears it in the effect above; and a later card
    // action transfers ownership explicitly in `handleChangeSetDecide`.
  }, [reversedChangeIds]);

  const handleChangeSetDecide = useCallback(
    (
      card: Extract<TimelineCard, { kind: "change-set" }>,
      ids: string[],
      decision: ChangeSetDecision,
    ) => {
      if (!onChangeSetDecide) return undefined;
      const settled = onChangeSetDecide(ids, decision);
      if (!settled || settled.length === 0) return settled;

      // The callback return is the live editor's authoritative settled set. Record it immediately;
      // the sibling `decidedChangeIds` event reports the same transaction and dedupes naturally.
      setChangeSetDecidedIds((prev) => mergeDecidedIds(prev, settled));
      const ownIds = new Set(card.changes.map((change) => change.id));
      const settledOwnIds = settled.filter((id) => ownIds.has(id));
      setSelfDecidedIdsByCard((prev) => {
        const transferred = removeCardDecidedIds(prev, settled, card.id);
        if (settledOwnIds.length === 0) return transferred;
        const selfDecided = mergeDecidedIds(transferred[card.id] ?? new Set(), settledOwnIds);
        return selfDecided === transferred[card.id]
          ? transferred
          : { ...transferred, [card.id]: selfDecided };
      });
      const outsideIds = settled.filter((id) => !ownIds.has(id));
      setReachedIdsByCard((prev) => {
        const transferred = removeCardDecidedIds(prev, settled, card.id);
        if (outsideIds.length === 0) return transferred;
        const reached = mergeDecidedIds(transferred[card.id] ?? new Set(), outsideIds);
        return reached === transferred[card.id]
          ? transferred
          : { ...transferred, [card.id]: reached };
      });
      return settled;
    },
    [onChangeSetDecide],
  );

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    loadTranscript(root)
      .then((history) => {
        if (cancelled) return;
        history.filter(isTerminalAgentWorkingCard).forEach((card) => {
          persistedTerminalRunIds.current.add(card.runId);
        });
        history.filter(isContinuityNoticeCard).forEach((card) => {
          persistedContinuityNoticeIds.current.add(card.id);
        });
        if (history.length > 0) setCards((prev) => mergeTimelineCards(prev, history, "before"));
        setTranscriptLoadState("loaded");
      })
      // Ratified #1813: a failed read leaves every in-memory card intact but cannot establish that
      // earlier history is empty. Keep rejection handled and expose the retryable unavailable state.
      .catch(() => {
        if (!cancelled) setTranscriptLoadState("failed");
      });
    return () => {
      cancelled = true;
    };
    // Rehydrates once per mount and once per explicit retry. Nothing else increments the attempt,
    // so "Try again" cannot restart agent activity, persistence writes, or another panel concern.
  }, [root, transcriptLoadAttempt]);

  // D15's existing append seam owns the durable representation: after any production path folds a
  // run to Completed, Stopped, Failed, or Cancelled, append the exact card now on screen once. This
  // effect observes committed React state instead of performing I/O inside a state updater, and it
  // deliberately excludes Running/Queued so reopen can never claim an old run is still live.
  useEffect(() => {
    if (!root) return;
    for (const card of cards) {
      if (!isTerminalAgentWorkingCard(card) || persistedTerminalRunIds.current.has(card.runId)) {
        continue;
      }
      if (batchAdmissionPending.current && !batchAdmissionPending.current.knownOtherRunIds.has(card.runId)) continue;
      persistedTerminalRunIds.current.add(card.runId);
      void appendTranscriptEvent(root, card).catch(() => {});
    }
    // `root` changes remount this panel; the ref is therefore scoped to exactly one project open.
  }, [cards, root, running, separateAdmissionRevision]);

  // A recovered provider turn contributes one ordinary successful run snapshot plus one durable
  // chat notice. Its stable run-derived id makes repeated terminal pushes idempotent.
  useEffect(() => {
    if (!root) return;
    for (const card of cards) {
      if (!isContinuityNoticeCard(card) || persistedContinuityNoticeIds.current.has(card.id)) continue;
      persistedContinuityNoticeIds.current.add(card.id);
      void appendTranscriptEvent(root, card).catch(() => {});
    }
  }, [cards, root]);

  const handleTranscriptRetry = () => {
    setTranscriptLoadState("loading");
    setTranscriptLoadAttempt((attempt) => attempt + 1);
  };

  /** Every run this panel has seen `stop_run` answer `cancelled` for. Recorded at the instant the
   * outcome arrives rather than read back off the cancelled *card*, because the card is state and
   * every reader of state is only as fresh as the last render — the same trap `commentContextRef`
   * below has to be kept current against. A cancel is a fact about a user act, so it needs no
   * render to be true. Session-scoped and one short string per cancelled run, released with the
   * panel; deliberately never pruned, since the batch's late read may arrive arbitrarily after the
   * conclusion. The cancelled *card* remains the display. */
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());

  // issues #1381/#1812: the latest comment cards plus active-document context, including
  // `threads`/`root`/`commentPath`/`author`/`commentNow`/`handleThreadsChange`, read from
  // inside the subscribe-once effects below instead of closed over —
  // mirrors `EditorShell.tsx`'s identical "assign a ref every render, read `.current` from a stable
  // callback" pattern for values a subscribe-once effect must see fresh without resubscribing (or,
  // for `concludeLostAddressRuns` below, re-memoizing) on every change. The assignment below is
  // per-render; `threads` is additionally written by each of its own writers at mutation time, so
  // it is current for a reader that runs before the next render (see `concludeAddressRunsFor`).
  const commentContextRef = useRef({
    cards,
    threads,
    root,
    commentPath,
    author,
    commentNow,
    handleThreadsChange,
  });
  commentContextRef.current = { cards, threads, root, commentPath, author, commentNow, handleThreadsChange };
  const concludingLostAddressRunIds = useRef(new Set<string>());

  // issue #1381, ux-design.md §2's last three exit-table rows: a run that ends *without delivering*
  // (stopped from the run card, or failed/crashed) must clear `pending_run` on every thread it was
  // addressing, or that thread asserts an acknowledgment forever — no store event does this on its
  // own, so something has to notice the run ended and write it. This is that something: the shared
  // **worker**, taking the run id and the exit-table outcome directly, because its callers learn a
  // run ended in different ways — a terminal phase reported to the production activity
  // subscription, a synchronous cancel outcome, or a batch discovering on return that the run it
  // was stamping had been cancelled meanwhile (see each call site below).
  //
  // The active document comes from `threads`; documents opened earlier in this panel come from
  // their retained `CommentCard` snapshots, the same panel-owned state
  // `handleInactiveThreadsChange` already refreshes after a background card mutation (#1329).
  // A thread this session never loaded into either remains the startup reconciliation's concern.
  //
  // **Every read here is off `commentContextRef`, which the component body assigns — so each one
  // is only as fresh as the last render unless something keeps it current at mutation time.**
  // Reading one render-stale value on this path is how the same stranding was reached three times
  // (rounds 1-3, PR #2260), so all eight reads are enumerated rather than left to inference:
  //
  //  - `threads` — **kept current at mutation time.** Both of its writers mirror the ref alongside
  //    `setThreads` (`handleThreadsChange`, and the effect that re-seeds from the `commentThreads`
  //    prop), because a conclusion routinely races the call that stamps it. Any further writer owes
  //    the same mirror.
  //  - `cards` — **render-fresh is enough.** It is read only to reach *other* documents' retained
  //    snapshots, and no path in flight during a conclusion mutates those: a run concludes against
  //    the document it targeted.
  //  - `root`, `commentPath`, `author`, `commentNow`, `handleThreadsChange` — **structurally
  //    immune.** Each is a prop or derived from one, and a prop cannot change without a render, so
  //    there is no window in which the ref could hold a superseded value. Nothing arranges this and
  //    nothing can break it short of one of them becoming panel state.
  //  - the cancelled fact — **not read from here at all.** `cancelledRunIdsRef` records it where it
  //    is learned, so it never enters this ref's freshness question.
  // Reads everything through `commentContextRef` rather than taking a dependency array, so its own
  // identity stays stable for this component's lifetime — which is what lets its memoized callers
  // depend on it without losing the stable identities they each need.
  const concludeAddressRunsFor = useCallback(
    (runId: string, outcome: RunConclusionOutcome) => {
      // One conclusion per run, whichever entry point gets there first (#2265) — main's guard,
      // moved into the shared worker so all three entry points get it rather than only the
      // `RunStatus` one. Its real work is on the `RunStatus`/state-derived-retry axis, where the
      // same terminal run can arrive repeatedly; the cancel and batch paths cannot double-conclude
      // *each other* (no await separates `handleAddressAll`'s cancel check from its call), so for
      // them this is defence against a repeat arrival rather than against that pair interleaving.
      if (concludingLostAddressRunIds.current.has(runId)) return;
      const {
        cards: currentCards,
        threads: currentThreads,
        root: currentRoot,
        commentPath: currentPath,
        author: currentAuthor,
        commentNow: currentCommentNow,
      } = commentContextRef.current;
      const targetDocuments: { root: string; path: string; threads: CommentThread[] }[] = [];
      const targetsRun = (thread: CommentThread) =>
        thread.pending_run === runId || thread.pending_runs.some((pending) => pending.run_id === runId);
      if (currentRoot && currentPath) {
        const targets = currentThreads.filter(targetsRun);
        if (targets.length > 0) {
          targetDocuments.push({ root: currentRoot, path: currentPath, threads: targets });
        }
      }
      for (const card of currentCards) {
        if (card.kind !== "comment" || !targetsRun(card.thread)) continue;
        if (card.root === currentRoot && card.path === currentPath) continue;
        const document = targetDocuments.find(({ root, path }) => root === card.root && path === card.path);
        if (document) document.threads.push(card.thread);
        else targetDocuments.push({ root: card.root, path: card.path, threads: [card.thread] });
      }
      if (targetDocuments.length === 0) return;
      concludingLostAddressRunIds.current.add(runId);
      // Sequenced, not `Promise.all` — every target in a document shares one run id (a batch address)
      // and appends to the same per-author sidecar. Awaiting one before starting the next keeps every
      // append (and the full thread list each call returns) strictly ordered rather than racing
      // concurrent writers against one file.
      void (async () => {
        for (const document of targetDocuments) {
          let latest: CommentThread[] | undefined;
          for (const target of document.threads) {
            latest = await concludeAddressRun(
              document.root,
              document.path,
              target.id,
              currentAuthor,
              // The run can end in the same clock tick as `address_with_ai`. Comment events sort by
              // `(timestamp, id)`, so a same-timestamp conclusion could fold before the pending event
              // despite being appended later. Make this causally subsequent without wall-clock sleeps.
              (currentCommentNow?.() ?? Date.now()) + 1,
              runId,
              outcome,
            );
          }
          if (!latest) continue;
          const activeContext = commentContextRef.current;
          if (activeContext.root === document.root && activeContext.commentPath === document.path) {
            activeContext.handleThreadsChange(latest);
          } else {
            setCards((prev) =>
              foldCommentThreads(prev, latest, document.root, { kind: "path", path: document.path }, { mint: false }),
            );
          }
        }
      })().catch(() => {
        // Releasing the guard is what lets a retry happen at all — but only the `RunStatus` entry
        // point actually has one: its state-derived effect re-runs on every `cards`/`threads`
        // change. The two entry points this card added do not. `handleStopRun`'s card is folded to
        // `cancelled`, which that effect excludes, and `handleAddressAll` runs once — so a failed
        // conclusion write on either is released here and then never retried. Not a regression
        // (before this card neither path concluded at all), and not currently executable by the
        // suite; recorded so the gap is known rather than implied by this line.
        concludingLostAddressRunIds.current.delete(runId);
      });
    },
    [],
  );

  /** The `RunStatus` entry point — the run reported its own terminal phase. Called from the
   * production activity subscription below; it reads the exit-table outcome off the phase and
   * delegates. Identity stays stable — its only dependency is a `[]`-memoized callback — which is
   * what that subscribe-once effect requires. */
  const concludeLostAddressRuns = useCallback(
    (status: RunStatus) => {
      const outcome = nonDeliveringConclusion(status);
      if (!outcome) return;
      concludeAddressRunsFor(status.id, outcome);
    },
    [concludeAddressRunsFor],
  );

  // A D23 run may reach a terminal phase before the Address-with-AI response has persisted its
  // `pending_run` id. Reconsider terminal cards whenever the owned thread snapshot changes, so the
  // production subscription cannot lose that conclusion merely because the two backend responses
  // crossed. The in-flight set above keeps the state-derived retry idempotent.
  useEffect(() => {
    for (const card of cards) {
      if (!isTerminalAgentWorkingCard(card)) continue;
      const status: AgentRunCardStatus = {
        id: card.runId,
        phase: card.phase,
        activity: card.activity,
        elapsedSecs: card.elapsedSecs,
      };
      if (isBackendRunStatus(status)) concludeLostAddressRuns(status);
    }
  }, [cards, threads, concludeLostAddressRuns]);

  // P2a integration (#345, FR-X-3): subscribes once per mount to the live `agent://activity`
  // push and folds every `RunStatus` into an `agent-working` card through `foldRunStatus` (module
  // scope, below) — the first push for a given run id appends a fresh card (through the same
  // `setCards` append `handleSubmit` already uses, so it is exempt from auto-scroll/focus-steal by
  // construction, Principle 2 — nothing here ever touches `scrollRequest`); a later push for the
  // same run id updates that card's fields in place instead. In D23 the same subscription polls the
  // headless driver's `/run_state` projection because the HTTP transport cannot push.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenToAgentActivity((status: AgentRunCardStatus) => {
      if (cancelled) return;
      setCards((prev) => foldRunStatus(prev, status, now?.()));
      if (isBackendRunStatus(status)) concludeLostAddressRuns(status);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Subscribes once per mount — a fresh panel mount (e.g. a project reopen) resubscribes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe-once; `now` is a per-render seam, not a resubscribe trigger
  }, []);

  /** Wired to every `AgentWorkingCard` action. An active run's next activity push supplies its
   * terminal phase; a queued cancellation never spawns and therefore resolves from `stop_run`'s
   * synchronous `cancelled` outcome instead — which this records in `cancelledRunIdsRef`, folds
   * onto the card, and concludes the run's threads from. Other outcomes and failures are inert. */
  // Stable identity (review finding, PR #477 round 1, Minor): `VirtualList`'s `renderItem` below
  // closes over this, and a fresh closure every render would be a real perf regression the moment
  // `VirtualList` starts memoizing on `renderItem`'s identity — harmless today, but free to avoid.
  // @anchor:test-plan-handle-stop-run
  const handleStopRun = useCallback(
    (runId: string) => {
      void stopRun(runId)
        .then((outcome) => {
          if (outcome !== "cancelled") return;
          cancelledRunIdsRef.current.add(runId);
          setBatchOutcomes((previous) => previous.map((item) => item.outcome.run_id === runId
            ? { ...item, conclusion: "cancelled" }
            : item));
          setCards((prev) => markQueuedRunCancelled(prev, runId));
          // The synchronous entry point: a queued run is cancelled by removing it from the
          // backend deque, so it never spawns and never reports a phase — this outcome is the only
          // notice the *backend* will give that it ended (ux-design.md §2's exit table, "Run
          // stopped by the user from the run card → prior state"). A cancel that lands before the
          // batch has stamped its targets is finished by `handleAddressAll` instead; both are
          // recorded on `docs/test-matrix.md`'s two FR-AGENT-7/FR-X-5 rows.
          concludeAddressRunsFor(runId, "stopped");
        })
        .catch(() => {});
    },
    [concludeAddressRunsFor],
  );

  // Identity is stable across renders that change no explicit collapse choice (PR #477 round 1,
  // Minor); it must change when `pinnedCollapsedIds` does, since that is what seeds each card's
  // `initialCollapsed` on remount — memoizing past it would serve a remounted card a stale choice
  // (PR #481). It deliberately does *not* depend on `effectiveCollapsedIds`: that map changes on
  // every card's own self-report, which no card reads back.
  const renderTimelineCard = useCallback(
    (card: TimelineCard) =>
      renderCard(card, {
        batchAccounting: card.kind === "agent-working" ? batchAccountingByRun.get(card.runId) : undefined,
        onStopRun: handleStopRun,
        permissionState,
        onPermissionDecision: handlePermissionDecision,
        permissionRunId,
        focusPermissionRequest,
        onFocusPermissionRequestConsumed: handlePermissionRequestFocusConsumed,
        focusRunRequest,
        focusedRunLanding,
        onFocusRunRequestConsumed: handleRunCardFocusConsumed,
        initialCollapsed: pinnedCollapsedIds[card.id],
        onCollapsedChange: (collapsed, explicit) => handleCardCollapsedChange(card.id, collapsed, explicit),
        onChangeSetDecide: onChangeSetDecide ? handleChangeSetDecide : undefined,
        externallyDecidedChangeIds: changeSetDecidedIds,
        externallyReversedChangeIds: reversedChangeIds,
        reachedChangeCount:
          card.kind === "change-set"
            ? [...(reachedIdsByCard[card.id] ?? [])].filter((id) => changeSetDecidedIds.has(id)).length
            : 0,
        decidedElsewhereCount:
          card.kind === "change-set"
            ? card.changes.filter(
                ({ id }) =>
                  changeSetDecidedIds.has(id) &&
                  !(selfDecidedIdsByCard[card.id]?.has(id) ?? false),
              ).length
            : 0,
        triageTarget,
        commentThreads: threads,
        onCommentThreadsChange: handleThreadsChange,
        activeCommentDocument: root && (commentOwner || commentPath)
          ? { root, owner: commentOwner ?? { kind: "path", path: commentPath! } }
          : undefined,
        onInactiveCommentThreadsChange: handleInactiveThreadsChange,
        onAddressRunFailed: handleAddressRunFailed,
        onAddressRunStarted: handleAddressRunStarted,
        onCommentRunLink,
        openDocuments,
        onFocusQuote,
        onFocusCommentAnchor,
        onFocusPathlessCommentAnchor,
        onFocusCommentChange,
        onFocusPathlessCommentChange,
        queuedRunIds,
        liveRunIds,
        terminalRunIds,
      }),
    [
      handleStopRun,
      batchAccountingByRun,
      permissionState,
      handlePermissionDecision,
      permissionRunId,
      focusPermissionRequest,
      handlePermissionRequestFocusConsumed,
      focusRunRequest,
      focusedRunLanding,
      handleRunCardFocusConsumed,
      handleCardCollapsedChange,
      pinnedCollapsedIds,
      onChangeSetDecide,
      handleChangeSetDecide,
      changeSetDecidedIds,
      reversedChangeIds,
      reachedIdsByCard,
      selfDecidedIdsByCard,
      triageTarget,
      threads,
      handleThreadsChange,
      handleInactiveThreadsChange,
      handleAddressRunFailed,
      handleAddressRunStarted,
      onCommentRunLink,
      openDocuments,
      root,
      commentPath,
      commentOwner,
      onFocusQuote,
      onFocusCommentAnchor,
      onFocusPathlessCommentAnchor,
      onFocusCommentChange,
      onFocusPathlessCommentChange,
      queuedRunIds,
      liveRunIds,
      terminalRunIds,
    ],
  );

  // Appends every owner-supplied card (today: an agent delivery's change-set card, #346, a
  // document-birth card, #420, or a project-grounding card, #360) not already appended, in order,
  // exactly once per id. Keyed on the id rather than object/array identity so a re-rendering owner
  // can't duplicate one, and persisted to the transcript store on the same best-effort terms as a
  // submitted card — an agent-originated card is part of the conversation history a reopened
  // project rehydrates (D15).
  //
  // One deliberate narrowing of that D15 precedent: a project-grounding card is session-scoped
  // state — "what grounding the agent has right now" — not conversation history. `App`'s own
  // `[project]`-keyed effect already raises a fresh one on every open (J8 Screen 2's literal
  // "one-time per project open" acceptance), so persisting it too would accumulate one copy per
  // open forever (CJ's own transcript held eight, #1718) and a rehydrated copy would also be stale
  // (its skill/workflow counts can change between opens). It is excluded from the persist below;
  // `timeline/ipc.ts`'s `loadTranscript` makes the matching exclusion on read, for a store a
  // pre-fix launch already accumulated copies into.
  //
  // Walking the whole list every time (not just its latest entry) is what makes two producers
  // writing `incomingCards` in the same render collapse harmless: `appendedCardIds` already dedupes
  // by id, so a card that was already appended on an earlier pass through this effect is skipped,
  // and any not-yet-seen entries — however many landed since the last run — are appended together
  // (review of PR #552 @ 9e456349, Important).
  const appendedCardIds = useRef(new Set<string>());
  useEffect(() => {
    if (!incomingCards || incomingCards.length === 0) return;
    const fresh = incomingCards.filter((card) => !appendedCardIds.current.has(card.id));
    if (fresh.length === 0) return;
    fresh.forEach((card) => appendedCardIds.current.add(card.id));
    fresh.filter(isTerminalAgentWorkingCard).forEach((card) => {
      persistedTerminalRunIds.current.add(card.runId);
    });
    setCards((prev) => mergeTimelineCards(prev, fresh, "after"));
    fresh.forEach((card) => {
      if (root && card.kind !== "project-grounding") void appendTranscriptEvent(root, card).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `root` changes remount the panel
  }, [incomingCards]);

  useEffect(() => {
    if (!persistedIncomingCards || persistedIncomingCards.length === 0) return;
    persistedIncomingCards.filter(isTerminalAgentWorkingCard).forEach((card) => {
      persistedTerminalRunIds.current.add(card.runId);
    });
    setCards((prev) => mergeTimelineCards(prev, persistedIncomingCards, "after"));
  }, [persistedIncomingCards]);

  // @anchor:timeline-panel-handle-submit
  const handleSubmit = (text: string, quote: QuotedExcerpt | null) => {
    const card = createChatMessageCard("user", text, {
      id: createId?.(),
      timestamp: now?.(),
      quote: quote ?? undefined,
    });
    setCards((prev) => [...prev, card]);
    // UXR-Q2 (ux-design §4 "Scroll motion", §1 Principle 2's *auto-scrolls* verb: "the user's own
    // deliberate act may scroll"): submit no longer restores "All" the way the PR #392 shipped
    // behavior did (ratified away, 2026-07-20 — the earlier comment here reasoned this was
    // unresolved; it is now resolved the other way). The active facet survives a submit unchanged.
    //
    // When the card the user just sent is included by that (unchanged) facet, jump to it — reusing
    // the identical `scrollRequest` seam the facet-jump above uses. It is always the most recent
    // card of its kind (it was just appended), so its index in the freshly filtered stream is
    // exactly `filteredCards.length` — one past whatever `filteredCards` (this render's, i.e.
    // pre-submit) already computed. Unconditional on the reader's own scroll position: a submit is
    // the user's own deliberate act, which auto-scrolls even for a reader who had scrolled up
    // (distinct from tail-follow's atTail gate in `VirtualList`, which only ever carries a reader
    // who did nothing).
    //
    // When the facet excludes it (e.g. sent while "Changes" is active), there is nothing under the
    // current view to scroll to — surface the `N new in <Facet> →` affordance instead of silently
    // dropping the card out of sight (FR-X-5 "never silently no-op", UX Principle 7 "degrade
    // honestly"). `facetForCard` is `undefined` only for a kind no ratified facet claims, which no
    // card the composer can produce today ever is.
    if (filterCardsByFacet([card], activeFacetId).length > 0) {
      // UXR-Q2 (ratified by CJ, 2026-08-20, #1324): submit reveals the *entire* card when it fits
      // the viewport, and just its top when the card is itself taller than the viewport —
      // `reveal: "full"` on the shared `scrollRequest` seam (`VirtualList`'s `scrollTargetForReveal`
      // carries the actual arithmetic, including the one-time correction once this just-appended
      // card's real height — not yet known at submit time — lands). Distinct from the plain `"top"`
      // facet-jump immediately above, whose "does it fit" question this issue never applied to.
      setScrollRequest({ index: filteredCards.length, reveal: "full" });
    } else {
      const facet = facetForCard(card);
      if (facet) {
        setNewInFacet((prev) => ({ facet, count: prev && prev.facet.id === facet.id ? prev.count + 1 : 1 }));
      }
    }
    // Best-effort persistence: the card already landed in the in-memory stream above, so a write
    // failure (e.g. disk full) must never look to the user like their message vanished, and must
    // never surface as an unhandled rejection — matching `createSaveRunner`'s own
    // catch-to-keep-the-chain-alive precedent for a write this module doesn't otherwise react to.
    if (root) void appendTranscriptEvent(root, card).catch(() => {});

    // P2a integration (#696, the composer→start_run seam #344 left orphaned): actually spawn the
    // turn this message names. Every submit calls this — including one sent while another run is
    // still active — since FR-AGENT-7's queue is what decides ordering, not this composer; the
    // synchronous result raises a queued card immediately when needed; the eventual
    // `agent://activity` push updates that same run-id-keyed card when it starts. Omitted without
    // a `root`: there is no project to run the agent against yet (FR-CHAT-1's pre-document
    // brainstorm), matching every other `root`-gated call in this handler. A rejected call (today
    // only `CommandError::InvalidArguments`, a blank prompt neither `MessageInput` nor this module
    // ever actually sends) is never silently swallowed (FR-X-5, UX Principle 7) — it renders
    // through the identical honest terminal-state path a spawn/queue failure already does.
    if (root) {
      void startRun(root, text, operationTargets ?? [], {
        // FR-CHAT-4 (ambient) and FR-CHAT-3 (the quote) both ride this turn; `startRun` composes
        // them onto the prompt in that order — see `referenceData.ts`. Read *here*, at the submit,
        // so a run queued behind an active one (FR-AGENT-7) still names what the user was looking
        // at when they pressed Send rather than what happens to be open at dequeue.
        openDocuments: openDocuments(),
        quote,
      })
        .then((result) => {
          // Destructured here, not inside the `setCards` updater: the updater runs during React's
          // own state processing, so a malformed response read there throws past this chain's
          // `.catch` and takes the panel down instead of landing as a failed run card.
          const { id, queuedPosition } = result;
          if (batchAdmissionPending.current) {
            batchAdmissionPending.current.knownOtherRunIds.add(id);
            setSeparateAdmissionRevision((revision) => revision + 1);
          }
          setCards((prev) => acknowledgeQueuedRun(prev, { id, queuedPosition }, now?.()));
        })
        .catch((error: unknown) => {
          setCards((prev) => foldRunStatus(prev, failedRunStatus(error), now?.()));
        });
    }
  };

  /**
   * Runs J4's batch address against the trigger's filtered target ids (FR-CMT-5/D8). The backend
   * admits the run and its Address records together, so J10 correction is refused from queue
   * acceptance rather than after a second IPC call.
   *
   * A clean or partial run also raises J4 Batch's one grouped-by-comment change-set card
   * (ux-design.md §2/§3, `batchChangeSetCard.ts`, #537) alongside the header accounting — the
   * `BatchAddressStatus` sibling names *which* threads the run touched, this card is the reviewable
   * artifact those threads produced. Its groups carry no changes yet: no MCP tool ties a delivered
   * `propose_changes` back to a comment id yet (the P2a-15 gap #1721 does not close), so this is
   * the honest, forward-compatible shape today (`batchChangeSetCardFor`'s own docs) — a run that
   * addressed nothing raises no card at all.
   */
  const handleAddressAll = (root: string, path: string) => (threadIds: string[], includeHeldThreadIds: string[] = []) => {
    batchAdmissionPending.current = {
      knownOtherRunIds: new Set(cards.flatMap((card) => card.kind === "agent-working" ? [card.runId] : [])),
    };
    setRunning(true);
    onBatchAddressRunningChange?.(true);
    const targets = threads.filter((thread) => threadIds.includes(thread.id));
    const prompt = buildBatchAddressPrompt(targets);

    const run = async () => {
      try {
        // FR-CHAT-4 captures open documents at submission, beside the operation target. The
        // Address fold and run admission are one backend transaction (FR-CMT-10).
        const submittedDocuments = openDocuments();
        const result = await startAddressRun(
          root, path, threadIds, author, commentNow?.() ?? Date.now(), prompt, true, null,
          { openDocuments: submittedDocuments }, includeHeldThreadIds,
        );
        const outcome: BatchAddressOutcome = {
          run_id: result.run?.id ?? mintRunId(),
          ...result.progress,
          threads: result.threads,
        };
        recordBatchOutcome(root, path, outcome, result.run !== null);
        if (result.threads.length > 0) {
          const current = commentContextRef.current;
          if (current.root === root && current.commentPath === path) {
            current.handleThreadsChange(result.threads);
          } else {
            // App re-reads this document's sidecar when its tab becomes active again. Until then,
            // update only its retained stream cards; the active tab's thread owner is different.
            setCards((previous) => foldCommentThreads(previous, result.threads, root,
              { kind: "path", path }, { mint: false }));
          }
        }
        // A queued run has no activity push until it dequeues; acknowledge it from the admission
        // result so the user can cancel it immediately.
        const admittedRun = result.run;
        if (admittedRun) {
          const outboundContext = activeDocumentOutboundDisclosure(submittedDocuments);
          setCards((prev) => acknowledgeAddressRun(prev, admittedRun, now?.()).map((card) =>
            card.kind === "agent-working" && card.runId === admittedRun.id
              ? { ...card, ...(outboundContext ? { outboundContext } : {}) }
              : card,
          ));
          onBatchRunAccepted?.(admittedRun.id);
          if (cancelledRunIdsRef.current.has(admittedRun.id)) {
            concludeAddressRunsFor(admittedRun.id, "stopped");
          }
        }
        const card = batchChangeSetCardFor(outcome, { timestamp: now?.() });
        if (card) {
          setCards((prev) => [...prev, card]);
          void appendTranscriptEvent(root, card).catch(() => {});
        }
      } catch (error: unknown) {
        // A rejected atomic admission has neither a run nor an Address event. The backend returns
        // a partial batch as an accepted run with explicit progress instead of rejecting it.
        const detail = errorDetail(error, String(error));
        recordBatchOutcome(root, path, unrunBatch(mintRunId(), threadIds, detail), false);
        onBatchAddressFailed?.(detail);
      } finally {
        // Cleared on every path: a run that failed still ended, and leaving the trigger inert after
        // a failure would strand the user with no way to retry.
        batchAdmissionPending.current = null;
        setRunning(false);
        onBatchAddressRunningChange?.(false);
      }
    };

    void run();
  };

  useLayoutEffect(() => {
    if (!root || !commentPath) {
      onRegisterBatchAddress?.(null);
      return;
    }
    onRegisterBatchAddress?.(handleAddressAll(root, commentPath));
    return () => onRegisterBatchAddress?.(null);
  });

  return (
    <section className="timeline-panel" aria-label="Timeline" data-platform={platform} hidden={collapsed && !workshopMode}>
      <header className="timeline-panel__header">
        <TimelineHostAction
          mode="expanded"
          pending={pendingPermission !== null}
          onActivate={handlePermissionAttentionActivate}
          hostRef={(node) => {
            timelineHostRef.current = node;
          }}
          clearedFocusTargetRef={collapseToggleRef}
        />
        {((commentThreads && root && commentPath) || (!workshopMode && onCollapse)) && (
          <div className="timeline-panel__header-actions">
            {commentThreads && root && commentPath && !batchAddressInEditor && (
              <BatchAddressTrigger
                key={commentPath}
                threads={threads}
                liveRunIds={liveRunIds}
                terminalRunIds={terminalRunIds}
                onAddressAll={handleAddressAll(root, commentPath)}
                running={running}
                floatingPanel
              />
            )}
            {/* A refused admission has no run card, so keep its latest status beside the trigger.
                Admitted outcomes belong to their matching run cards below (FR-AGENT-6). */}
            {latestNoRunBatch && <BatchAddressStatus outcome={latestNoRunBatch.outcome}
              batchNumber={latestNoRunBatch.batchNumber} conclusion={latestNoRunBatch.conclusion} />}
            {!workshopMode && onCollapse && (
              <button
                ref={collapseToggleRef}
                type="button"
                className="timeline-panel__collapse"
                aria-label="Hide Timeline"
                onClick={onCollapse}
              >
                <ChevronsRight aria-hidden="true" size={14} />
              </button>
            )}
          </div>
        )}
      </header>
      {permissionAnnouncement && (
        <span
          key={permissionAnnouncement}
          className="sr-only"
          role="status"
          aria-label="Permission attention"
          aria-live="polite"
          aria-atomic="true"
        >
          Agent is waiting for permission.
        </span>
      )}
      <FacetBar activeFacetId={activeFacetId} onSelect={handleFacetSelect} />
      {transcriptLoadState === "failed" && (
        <div className="timeline-panel__unavailable" role="status">
          <strong>Activity unavailable</strong>
          <span>Earlier activity could not be loaded.</span>
          <button type="button" onClick={handleTranscriptRetry}>
            Try again
          </button>
        </div>
      )}
      <div className="timeline-panel__stream">
        {filteredCards.length === 0 && transcriptLoadState === "loaded" ? (
          // Issue #1727: a facet that filters the stream down to nothing used to render a bare,
          // empty `VirtualList` — `text=""`, indistinguishable from a broken panel. Each facet
          // states its own emptiness instead (Principle 7, `ProjectRail`'s "No files yet"
          // precedent) rather than a copy-pasted generic message. ux-design §2 (review round 2):
          // gated on a successful load so the claim never fires while rehydrate is in flight or
          // unavailable — in either case, an empty stream has not been established as true-empty.
          <p className="timeline-panel__empty">{facetById(activeFacetId).emptyLabel}</p>
        ) : (
          <VirtualList
            items={filteredCards}
            itemKey={(card) => card.id}
            estimatedItemHeight={cardItemHeight}
            renderItem={renderTimelineCard}
            scrollRequest={scrollRequest}
            preserveScrollKey={permissionScrollKey}
          />
        )}
      </div>
      {newInFacet && (
        <NewInFacetAffordance
          facetLabel={newInFacet.facet.label}
          count={newInFacet.count}
          onClick={() => handleFacetSelect(newInFacet.facet.id)}
        />
      )}
      <MessageComposer containerRef={composerRef} incomingQuote={incomingQuote} onSubmit={handleSubmit}
        dictationActive={!collapsed || workshopMode} dictationIdentity={commentPath} />
    </section>
  );
}
