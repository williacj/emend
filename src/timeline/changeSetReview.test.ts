// ABOUTME: Pins the change-set card's 1-by-1 review pass state machine (P2a-14, J1 Phase C) in
// ABOUTME: isolation from any rendering — progress ("N of M"), advance-on-decide, and exit-mid-pass.
import { describe, expect, it } from "vitest";
import {
  advanceChangeSetReview,
  currentReviewChangeId,
  reviewProgress,
  startChangeSetReview,
} from "./changeSetReview";

describe("timeline/changeSetReview", () => {
  it("starts a pass on the first pending id and reports 1 of M", () => {
    const state = startChangeSetReview(["10", "20", "30"]);

    expect(currentReviewChangeId(state)).toBe("10");
    expect(reviewProgress(state)).toEqual({ position: 1, total: 3 });
  });

  it("advancing past a decided change moves to the next pending id and bumps position", () => {
    const state = startChangeSetReview(["10", "20", "30"]);
    const next = advanceChangeSetReview(state, "10");

    expect(currentReviewChangeId(next)).toBe("20");
    expect(reviewProgress(next)).toEqual({ position: 2, total: 3 });
  });

  it("total (M) never shrinks mid-pass even as changes are decided", () => {
    let state = startChangeSetReview(["10", "20", "30"]);
    state = advanceChangeSetReview(state, "10");
    state = advanceChangeSetReview(state, "20");

    expect(reviewProgress(state)).toEqual({ position: 3, total: 3 });
  });

  it("advancing past the last change ends the pass (no current id or progress)", () => {
    let state = startChangeSetReview(["10", "20"]);
    state = advanceChangeSetReview(state, "10");
    state = advanceChangeSetReview(state, "20");

    expect(currentReviewChangeId(state)).toBeUndefined();
    expect(reviewProgress(state)).toBeNull();
  });

  it("exiting mid-pass (no further advance calls) leaves the remaining ids pending — the caller simply stops reading currentReviewChangeId", () => {
    // The pass has no explicit "exit" mutation: a caller that stops calling advance/current has,
    // by construction, left the not-yet-decided ids exactly as they were (J1: "exit anytime;
    // partial triage is fine") — pinned here as the state's referential stability.
    const state = startChangeSetReview(["10", "20", "30"]);
    const decided = advanceChangeSetReview(state, "10");

    expect(decided.pendingIds).toEqual(["20", "30"]);
    // The original `state` object is untouched — advancing never mutates in place.
    expect(state.pendingIds).toEqual(["10", "20", "30"]);
  });

  it("advancing an id not present in the pending set is a no-op", () => {
    const state = startChangeSetReview(["10", "20"]);
    const next = advanceChangeSetReview(state, "999");

    expect(next.pendingIds).toEqual(["10", "20"]);
    expect(currentReviewChangeId(next)).toBe("10");
  });

  it("starting a pass with no pending ids reports no current id and no progress", () => {
    const state = startChangeSetReview([]);

    expect(currentReviewChangeId(state)).toBeUndefined();
    expect(reviewProgress(state)).toBeNull();
  });
});
