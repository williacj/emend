// ABOUTME: Unit coverage for the shared decided-id folds: decision batches merge monotonically,
// ABOUTME: explicit reversal batches subtract, and both preserve references on no-op updates.
import { describe, expect, it } from "vitest";
import { mergeDecidedIds, removeDecidedIds } from "./decidedIds";

describe("timeline/decidedIds — mergeDecidedIds", () => {
  it("adds every new id from the batch", () => {
    const prev = new Set(["1"]);
    const next = mergeDecidedIds(prev, ["2", "3"]);
    expect([...next].sort()).toEqual(["1", "2", "3"]);
  });

  it("returns the same reference when the batch adds nothing new", () => {
    const prev = new Set(["1", "2"]);
    const next = mergeDecidedIds(prev, ["1", "2"]);
    expect(next).toBe(prev);
  });

  it("returns the same reference for an empty batch", () => {
    const prev = new Set(["1"]);
    expect(mergeDecidedIds(prev, [])).toBe(prev);
  });

  it("never removes an id already present — a smaller/empty batch can't un-decide anything", () => {
    const prev = new Set(["1", "2", "3"]);
    const next = mergeDecidedIds(prev, []);
    expect([...next].sort()).toEqual(["1", "2", "3"]);
  });

  it("does not mutate the set it was given", () => {
    const prev = new Set(["1"]);
    mergeDecidedIds(prev, ["2"]);
    expect([...prev]).toEqual(["1"]);
  });
});

describe("timeline/decidedIds — removeDecidedIds", () => {
  it("removes every reversed id without mutating the previous set", () => {
    const prev = new Set(["chg-1", "chg-2", "chg-3"]);
    const next = removeDecidedIds(prev, ["chg-1", "chg-3"]);
    expect([...next]).toEqual(["chg-2"]);
    expect([...prev]).toEqual(["chg-1", "chg-2", "chg-3"]);
  });

  it("returns the same reference when no reversed id was decided", () => {
    const prev = new Set(["chg-1"]);
    expect(removeDecidedIds(prev, ["chg-2"])).toBe(prev);
  });
});
