// ABOUTME: Tests the delivery-attribution grouping and relative-time formatting used by
// ABOUTME: CommentThreadCard wherever ux-design.md §2 requires attributed linked changes (#1380).
import { describe, expect, it } from "vitest";
import { formatDeliveryRelativeTime, groupLinkedChangesByDelivery } from "./deliveryAttribution";
import { linkedChange } from "./threadFixture";

describe("comments/deliveryAttribution groupLinkedChangesByDelivery", () => {
  it("groups every change from one delivery together", () => {
    const groups = groupLinkedChangesByDelivery([
      linkedChange("chg-1", { delivery_id: "d1", run_id: "run-1", delivered_at: 100 }),
      linkedChange("chg-2", { delivery_id: "d1", run_id: "run-1", delivered_at: 100 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].deliveryId).toBe("d1");
    expect(groups[0].deliveredAt).toBe(100);
    expect(groups[0].changes.map((c) => c.change_id)).toEqual(["chg-1", "chg-2"]);
  });

  it("splits changes from two different deliveries into two groups, each under its own name (FR-CMT-7 re-delegation)", () => {
    const groups = groupLinkedChangesByDelivery([
      linkedChange("chg-1", { delivery_id: "d1", run_id: "run-1", delivered_at: 100 }),
      linkedChange("chg-2", { delivery_id: "d2", run_id: "run-2", delivered_at: 500 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].deliveryId).toBe("d1");
    expect(groups[0].changes.map((c) => c.change_id)).toEqual(["chg-1"]);
    expect(groups[1].deliveryId).toBe("d2");
    expect(groups[1].changes.map((c) => c.change_id)).toEqual(["chg-2"]);
  });

  it("preserves first-appearance order of deliveries — never re-sorted by count or recency", () => {
    const groups = groupLinkedChangesByDelivery([
      linkedChange("chg-1", { delivery_id: "d1", delivered_at: 500 }),
      linkedChange("chg-2", { delivery_id: "d2", delivered_at: 100 }),
      linkedChange("chg-3", { delivery_id: "d1", delivered_at: 500 }),
    ]);
    expect(groups.map((g) => g.deliveryId)).toEqual(["d1", "d2"]);
    expect(groups[0].changes.map((c) => c.change_id)).toEqual(["chg-1", "chg-3"]);
  });

  it("returns an empty list for no linked changes", () => {
    expect(groupLinkedChangesByDelivery([])).toEqual([]);
  });
});

describe("comments/deliveryAttribution formatDeliveryRelativeTime", () => {
  it("reads 'just now' for under a minute", () => {
    expect(formatDeliveryRelativeTime(0, 30_000)).toBe("just now");
    expect(formatDeliveryRelativeTime(1_000, 1_000)).toBe("just now");
  });

  it("reads minutes for under an hour", () => {
    expect(formatDeliveryRelativeTime(0, 12 * 60_000)).toBe("12m ago");
    expect(formatDeliveryRelativeTime(0, 59 * 60_000)).toBe("59m ago");
  });

  it("reads hours for under a day", () => {
    expect(formatDeliveryRelativeTime(0, 3 * 60 * 60_000)).toBe("3h ago");
  });

  it("reads days at and beyond 24 hours", () => {
    expect(formatDeliveryRelativeTime(0, 2 * 24 * 60 * 60_000)).toBe("2d ago");
  });

  it("floors clock skew (delivered_at in the future) to 'just now' rather than a negative duration", () => {
    expect(formatDeliveryRelativeTime(10_000, 0)).toBe("just now");
  });
});
