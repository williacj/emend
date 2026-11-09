// ABOUTME: The change-set card's [Review 1-by-1] pass (P2a-14, J1 Phase C) — a pure state machine
// ABOUTME: over pending change ids, decoupled from rendering and from any live CM6 view so the
// ABOUTME: progress/advance/exit-mid-pass semantics are directly unit-testable.

/**
 * A 1-by-1 review pass in progress. `pendingIds` is the review-order queue of ids not yet decided
 * *during this pass*; `total` is fixed at the pass's start (M in "N of M") and never shrinks as
 * changes are decided, matching J1's "progress reads N of M" (M is the size of the pass entered,
 * not a live pending count).
 */
export interface ChangeSetReviewState {
  pendingIds: string[];
  total: number;
}

/** Enters a pass over `pendingIds` (in review order — typically document order). */
export function startChangeSetReview(pendingIds: string[]): ChangeSetReviewState {
  return { pendingIds: [...pendingIds], total: pendingIds.length };
}

/** The change the pass is currently on, or `undefined` once every id has been decided. */
export function currentReviewChangeId(state: ChangeSetReviewState): string | undefined {
  return state.pendingIds[0];
}

/** "N of M" for the pass's current position, or `null` once nothing remains to review. */
export function reviewProgress(state: ChangeSetReviewState): { position: number; total: number } | null {
  if (state.pendingIds.length === 0) return null;
  return { position: state.total - state.pendingIds.length + 1, total: state.total };
}

/**
 * Drops `decidedId` from the pass's queue (Accept & next / Reject & next both call this — the
 * actual accept/reject apply is the caller's concern, this only advances the pass). A no-op if
 * `decidedId` isn't the pass's own — never mutates `state` in place, so a caller that stops
 * advancing (exits mid-pass) leaves every remaining id exactly as it was, undecided.
 */
export function advanceChangeSetReview(state: ChangeSetReviewState, decidedId: string): ChangeSetReviewState {
  return { ...state, pendingIds: state.pendingIds.filter((id) => id !== decidedId) };
}
