// ABOUTME: Pins `rangeOf`'s own behavior (issue #563) — first-occurrence default, the `occurrence`
// ABOUTME: param, and the not-found throw — now that six test files share this one implementation.
import { describe, expect, it } from "vitest";
import { rangeOf } from "./testRanges";

describe("rangeOf", () => {
  it("locates the first occurrence by default", () => {
    expect(rangeOf("Hello {++brave ++}world\n", "{++brave ++}")).toEqual({ from: 6, to: 18 });
  });

  it("locates a later occurrence via the occurrence param", () => {
    const doc = "{++a++} middle {++a++} end";
    expect(rangeOf(doc, "{++a++}", 1)).toEqual({ from: 15, to: 22 });
  });

  it("throws when the substring isn't found", () => {
    expect(() => rangeOf("no markup here", "{++missing++}")).toThrow(/not found/);
  });

  it("throws when the requested occurrence doesn't exist", () => {
    expect(() => rangeOf("{++a++} once", "{++a++}", 1)).toThrow(/not found/);
  });
});
