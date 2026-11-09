// ABOUTME: Pure collapse-boundary predicates for the timeline's collapse-by-default rule (P2b-1b,
// ABOUTME: ux-design §4 "Timeline at scale") — decoupled from rendering so the "fully decided, not
// ABOUTME: any decision" boundary is directly unit-testable (NI-timeline-correctness). A comment
// ABOUTME: thread's own boundary is a comment-domain rule and lives in `comments/types`.
import { isHeldByLiveRun, isThreadCollapsedByDefault, withoutTerminalPendingRuns } from "../comments/types";
import type { AgentWorkingCard, ChangeSetChange, TimelineCard } from "./types";

/**
 * A change-set card collapses to a single line only once **every** one of its changes has been
 * decided — the issue's "fully decided, not any decision" boundary: one still-pending change keeps
 * the whole card expanded. `decidedIds` is the card's own session-local decided set (never
 * persisted — collapse state is view state, not sidecar state). A change-set with **no** changes
 * at all never collapses by this rule — there is no "every change decided" to have reached (the
 * acceptance criteria's "one still-pending change keeps it expanded" presupposes at least one
 * change existed to begin with); `Array.prototype.every`'s vacuous truth on an empty array would
 * otherwise collapse a card whose `changes` is merely absent/not-yet-populated, which is not the
 * same claim as "fully decided".
 */
// @anchor:change-set-collapsed-by-default
export function isChangeSetCollapsedByDefault(
  changes: readonly ChangeSetChange[],
  decidedIds: ReadonlySet<string>,
): boolean {
  return changes.length > 0 && changes.every((change) => decidedIds.has(change.id));
}

/** A run card collapses only after a successful completion. Running/queued work stays visible, and
 * every unsuccessful terminal phase stays expanded so J7's failure reason and recovery context are
 * never hidden behind a disclosure (#1725). */
export function isAgentWorkingCollapsedByDefault(card: AgentWorkingCard): boolean {
  return card.phase.phase === "completed" || card.phase.phase === "recovered";
}

/** Dispatches to the right predicate for `card.kind`, assuming nothing has been decided yet (the
 * only thing knowable about a change-set from its data alone — decisions are ephemeral local
 * state a card only accumulates once mounted, never carried on the card's own persisted shape).
 * A chat-message card carries no collapse rule at all. Used to seed a row's height *before* it has
 * ever been mounted (e.g. a long resolved-thread history, or any card still off-screen in the
 * virtualized window) — see `itemHeightFor`. */
export function isCardCollapsedByDefault(card: TimelineCard): boolean {
  switch (card.kind) {
    case "comment":
      return isThreadCollapsedByDefault(card.thread);
    case "change-set":
      return isChangeSetCollapsedByDefault(card.changes, new Set());
    case "agent-working":
      return isAgentWorkingCollapsedByDefault(card);
    case "chat-message":
      return false;
    default:
      // Deliberately lenient (unlike `TimelinePanel`'s render-switch): this predicate runs over
      // every card in the stream to size the virtualized window, including kinds this card was
      // never updated to know about — throwing here would break windowing for the whole list over
      // one unrecognized card, not just fail to render it.
      return false;
  }
}

/** Estimated row height (pixels) for a card rendered fully collapsed — a single line, always
 * shorter than any expanded card's estimate. It is what `VirtualList` positions the row by until
 * the row has actually been mounted and measured (#1119); a collapsed card is the one case where
 * the estimate is close to exact, since a single line's height genuinely is known ahead of render. */
export const COLLAPSED_ITEM_HEIGHT = 32;

/**
 * The row height `VirtualList` should assume for `card` until it has measured the row itself
 * (#1119) — the seam that lets collapse compose with virtualization (P2b-1b): a collapsed card
 * occupies its collapsed height in the windowing calculation, so cards below it don't jump when it
 * collapses/expands, and an off-screen card is sized from its data alone. `collapsedOverrides` is
 * the panel's live record of which card ids it has actually been told are collapsed (by a mounted
 * card reporting its own current state, e.g. after a user resolves it or decides its last pending
 * change) — checked first since it reflects the truth for anything that has ever been mounted.
 * A card id absent from that map (never yet mounted, or mounted but never collapsed/expanded)
 * falls back to `isCardCollapsedByDefault`, which is exactly right pre-mount: a rehydrated
 * resolved thread is correctly sized without ever having been on screen, and a change-set with
 * pending changes has no decided ids to know about yet regardless.
 */
export function itemHeightFor(
  card: TimelineCard,
  collapsedOverrides: Readonly<Record<string, boolean>>,
  expandedHeight: number,
  liveRunIds?: readonly string[],
  terminalRunIds?: readonly string[],
): number {
  if (card.kind === "comment" && card.thread.withdrawn_at != null) return expandedHeight;
  if (card.kind === "comment" && isHeldByLiveRun(card.thread, liveRunIds, terminalRunIds)) return expandedHeight;
  const settledCard = card.kind === "comment"
    ? { ...card, thread: withoutTerminalPendingRuns(card.thread, terminalRunIds) }
    : card;
  const collapsed = collapsedOverrides[card.id] ?? isCardCollapsedByDefault(settledCard);
  if (collapsed && card.kind === "agent-working" && card.outboundContext) return 56;
  return collapsed ? COLLAPSED_ITEM_HEIGHT : expandedHeight;
}
