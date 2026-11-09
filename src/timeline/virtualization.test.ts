// ABOUTME: Pins the windowing math a virtualized timeline stream depends on — the mounted range
// ABOUTME: must stay bounded by viewport size, never by total item count (docs/test-matrix.md NI-timeline-correctness).
import { describe, expect, it } from "vitest";
import {
  computeVisibleRangeFromOffsets,
  computeVisibleRangeVariable,
  cumulativeOffsets,
  scrollLayoutForReveal,
  scrollTargetForReveal,
  totalContentHeightVariable,
  type VisibleRange,
  type VisibleRangeFromOffsetsParams,
} from "./virtualization";

// P2b-1b: a collapsed card's row height differs from an expanded one, so a single uniform row
// height can't size it correctly — these establish the windowing contract for a per-item height
// array (still fully known ahead of render, never DOM-measured; see `collapse.ts`).
describe("timeline/virtualization — variable per-item heights (P2b-1b collapse composition)", () => {
  it("cumulativeOffsets is a running prefix sum, with a final entry equal to the total height", () => {
    expect(cumulativeOffsets([32, 96, 32])).toEqual([0, 32, 128, 160]);
    expect(cumulativeOffsets([])).toEqual([0]);
  });

  it("totalContentHeightVariable sums every item's height", () => {
    expect(totalContentHeightVariable([32, 96, 32])).toBe(160);
    expect(totalContentHeightVariable([])).toBe(0);
  });

  it("returns an empty range for an empty list", () => {
    const range = computeVisibleRangeVariable({ itemHeights: [], containerHeight: 600, scrollTop: 0, overscan: 3 });
    expect(range).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it("mounts only the rows whose offsets fall inside the viewport + overscan, uniform heights matching the fixed-height case", () => {
    // 5000 uniform 80px rows — same shape as the fixed-height "mounts only a small window" test —
    // should mount an equivalent window via the variable-height path.
    const itemHeights = Array.from({ length: 5000 }, () => 80);
    const range = computeVisibleRangeVariable({ itemHeights, containerHeight: 600, scrollTop: 0, overscan: 3 });
    expect(range.startIndex).toBe(0);
    expect(range.endIndex - range.startIndex).toBeLessThan(20);
  });

  it("the mounted window size does not grow with total item count", () => {
    const small = computeVisibleRangeVariable({
      itemHeights: Array.from({ length: 100 }, () => 80),
      containerHeight: 600,
      scrollTop: 4000,
      overscan: 3,
    });
    const huge = computeVisibleRangeVariable({
      itemHeights: Array.from({ length: 50_000 }, () => 80),
      containerHeight: 600,
      scrollTop: 4000,
      overscan: 3,
    });
    expect(huge.endIndex - huge.startIndex).toBe(small.endIndex - small.startIndex);
    expect(huge.endIndex - huge.startIndex).toBeLessThan(20);
  });

  it("clamps the window to the item count at the end of the list", () => {
    const range = computeVisibleRangeVariable({
      itemHeights: Array.from({ length: 10 }, () => 80),
      containerHeight: 600,
      scrollTop: 100_000,
      overscan: 3,
    });
    expect(range.endIndex).toBe(10);
    expect(range.startIndex).toBeLessThanOrEqual(10);
  });

  it("a run of collapsed (32px) rows ahead of a scrolled-past point mounts a wider index range for the same viewport than expanded (96px) rows would", () => {
    // The whole point of per-item heights: a collapsed card takes less vertical space, so more of
    // them fit in one viewport-full than the same count of expanded cards would.
    const collapsed = computeVisibleRangeVariable({
      itemHeights: Array.from({ length: 200 }, () => 32),
      containerHeight: 600,
      scrollTop: 0,
      overscan: 0,
    });
    const expanded = computeVisibleRangeVariable({
      itemHeights: Array.from({ length: 200 }, () => 96),
      containerHeight: 600,
      scrollTop: 0,
      overscan: 0,
    });
    expect(collapsed.endIndex - collapsed.startIndex).toBeGreaterThan(expanded.endIndex - expanded.startIndex);
  });

  it("scrolling past a collapsed card lands on the offset its *own* (shorter) height produces, not a uniform assumption", () => {
    // Two 96px cards then a 32px collapsed one: the third card's top offset is 192, not 288 — the
    // scroll-jump `itemHeightFor`/`VirtualList` exist to prevent.
    const itemHeights = [96, 96, 32, 96];
    const offsets = cumulativeOffsets(itemHeights);
    expect(offsets[2]).toBe(192);
    const range = computeVisibleRangeVariable({ itemHeights, containerHeight: 50, scrollTop: 192, overscan: 0 });
    expect(range.startIndex).toBe(2);
  });
});

/**
 * #1119 made the offsets a precompute the caller holds across scrolls and the band search a binary
 * one, so that a scroll costs O(log itemCount) instead of a scan from index 0 — the property
 * test-plan §6's virtualization budget actually asks for, now that every stream has per-row heights.
 * A search is only worth having if it answers exactly what the scan answered, so these tests hold it
 * against a direct transcription of the scan for every shape the stream can take.
 */
describe("timeline/virtualization — computeVisibleRangeFromOffsets", () => {
  /** The pre-#1119 scan, verbatim, as the oracle. */
  function scanRange({ offsets, containerHeight, scrollTop, overscan }: VisibleRangeFromOffsetsParams): VisibleRange {
    const itemCount = offsets.length - 1;
    if (itemCount <= 0) return { startIndex: 0, endIndex: 0 };
    let firstVisible = 0;
    while (firstVisible < itemCount && offsets[firstVisible + 1] <= scrollTop) firstVisible++;
    const viewportBottom = scrollTop + containerHeight;
    let lastVisible = firstVisible;
    while (lastVisible < itemCount && offsets[lastVisible] < viewportBottom) lastVisible++;
    if (lastVisible <= firstVisible) lastVisible = Math.min(itemCount, firstVisible + 1);
    return { startIndex: Math.max(0, firstVisible - overscan), endIndex: Math.min(itemCount, lastVisible + overscan) };
  }

  const streams: Record<string, number[]> = {
    "uniform expanded rows": Array.from({ length: 200 }, () => 96),
    "collapsed rows ahead of expanded ones": [...Array.from({ length: 50 }, () => 32), ...Array.from({ length: 30 }, () => 96)],
    "measured rows of every height": Array.from({ length: 120 }, (_, i) => 24 + ((i * 37) % 260)),
    "fractional measured heights": Array.from({ length: 80 }, (_, i) => 61.5 + (i % 7) * 0.25),
    "zero-height rows among real ones": [96, 0, 0, 96, 0, 200, 0, 96],
    "a single row": [96],
  };

  // One test rather than one per stream: each case's identity travels in the compared object, so a
  // failure still names the stream, the viewport and the scroll position it disagreed at — and the
  // matrix can trace a literal test title (`scripts/check-test-matrix.mjs` reads them statically).
  it("matches a scan from index 0 at every scroll position over every stream shape", () => {
    for (const [stream, itemHeights] of Object.entries(streams)) {
      const offsets = cumulativeOffsets(itemHeights);
      const total = offsets[offsets.length - 1];
      for (const containerHeight of [0, 50, 600, total * 2]) {
        // Every row boundary, either side of it, plus past both ends of the content.
        const positions = [-10, 0, total, total + 500, ...offsets.flatMap((offset) => [offset - 1, offset, offset + 1])];
        for (const scrollTop of positions) {
          for (const overscan of [0, 3]) {
            const params = { offsets, containerHeight, scrollTop, overscan };
            const where = { stream, containerHeight, scrollTop, overscan };
            expect({ ...where, ...computeVisibleRangeFromOffsets(params) }).toEqual({
              ...where,
              ...scanRange(params),
            });
          }
        }
      }
    }
  });

  it("returns an empty range for an empty stream — offsets holding only the zero origin", () => {
    expect(computeVisibleRangeFromOffsets({ offsets: [0], containerHeight: 600, scrollTop: 0, overscan: 3 })).toEqual({
      startIndex: 0,
      endIndex: 0,
    });
  });

  it("reads only a logarithmic number of offsets rather than walking the stream", () => {
    // The budget assertion itself (test-plan §6): the pre-#1119 scan touched every offset ahead of
    // the scroll position, which at the tail of a 50,000-row stream is 50,000 reads per scroll.
    const itemHeights = Array.from({ length: 50_000 }, () => 96);
    const offsets = cumulativeOffsets(itemHeights);
    let reads = 0;
    const counted = new Proxy(offsets, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });

    computeVisibleRangeFromOffsets({ offsets: counted, containerHeight: 600, scrollTop: 49_000 * 96, overscan: 3 });

    // 2 * ceil(log2(50_001)) is 34; the scan's answer would be ~49,000.
    expect(reads).toBeLessThan(50);
  });
});

/**
 * #1324 (UXR-Q2, CJ 2026-08-20): the user's own submit reveals the *entire* submitted card when it
 * fits the viewport, and just its top when the card is itself taller than the viewport. `"top"` is
 * the pre-existing facet-jump behaviour (P2b-1a) and stays exactly what it was.
 */
describe("timeline/virtualization — scrollTargetForReveal (UXR-Q2 submit-scroll edge, #1324)", () => {
  it("'top' pins the item's own top, clamped to the container's actual max scroll — unchanged facet-jump behaviour", () => {
    const offsets = cumulativeOffsets(Array.from({ length: 10 }, () => 96)); // total 960
    expect(scrollTargetForReveal({ offsets, index: 3, containerHeight: 600, reveal: "top" })).toBe(288); // 3 * 96, unclamped
    // Near the tail: the literal top would overshoot the container's actual max scroll.
    expect(scrollTargetForReveal({ offsets, index: 9, containerHeight: 600, reveal: "top" })).toBe(360); // 960 - 600
  });

  it("'full' bottom-anchors a card that fits the viewport — the whole card visible, extra space above it", () => {
    const offsets = cumulativeOffsets([200, 200, 96, 200]); // item 2 (96px) is the target, offsets [0,200,400,496,696]
    const target = scrollTargetForReveal({ offsets, index: 2, containerHeight: 300, reveal: "full" });
    expect(target).toBe(196); // itemBottom(496) - containerHeight(300)
    expect(offsets[2]).toBeGreaterThanOrEqual(target); // top of the card is inside the view
    expect(offsets[3]).toBeLessThanOrEqual(target + 300); // bottom of the card is inside the view
  });

  it("'full' falls back to the item's own top when the item is itself taller than the viewport", () => {
    const offsets = cumulativeOffsets([200, 900, 200]); // item 1 (900px) is taller than any viewport below
    const target = scrollTargetForReveal({ offsets, index: 1, containerHeight: 600, reveal: "full" });
    expect(target).toBe(200); // the item's own top (offsets[1]) — reading starts there, not mid-card
  });

  it("'full' still clamps to the container's actual max scroll when the fitting card sits at the very tail", () => {
    const offsets = cumulativeOffsets([96, 96]); // last item's own bottom-align would want scrollTop 96-300 (negative)
    const target = scrollTargetForReveal({ offsets, index: 1, containerHeight: 300, reveal: "full" });
    expect(target).toBe(0);
  });

  it("'top-with-clearance' reserves exactly 12px above a fitting run card, including at either stream edge", () => {
    const offsets = cumulativeOffsets([96, 96, 96]);

    for (const index of [0, 2]) {
      const layout = scrollLayoutForReveal({
        offsets,
        index,
        containerHeight: 300,
        reveal: "top-with-clearance",
        topClearance: 12,
      });
      const cardTop = layout.leadingInset + offsets[index] - layout.scrollTop;
      const cardBottom = layout.leadingInset + offsets[index + 1] - layout.scrollTop;

      expect(cardTop).toBe(12);
      expect(cardBottom).toBeLessThanOrEqual(300);
      expect(layout.trailingInset).toBe(index === 0 ? 0 : 192);
    }
  });

  it("'top-with-clearance' uses cardHeight + clearance as the exact whole-card boundary", () => {
    for (const [height, whole] of [[288, true], [289, false]] as const) {
      const offsets = cumulativeOffsets([120, height, 120]);
      const layout = scrollLayoutForReveal({
        offsets,
        index: 1,
        containerHeight: 300,
        reveal: "top-with-clearance",
        topClearance: 12,
      });
      const cardTop = layout.leadingInset + offsets[1] - layout.scrollTop;
      const cardBottom = layout.leadingInset + offsets[2] - layout.scrollTop;

      expect(cardTop).toBe(12);
      expect(cardBottom <= 300).toBe(whole);
    }
  });

  it("#2539 bottom-aligns a fitting submitted run with 12px below it, even at either feed edge", () => {
    for (const { heights, index } of [
      { heights: [100], index: 0 },
      { heights: [200, 100], index: 1 },
      { heights: [200, 100, 200], index: 1 },
    ]) {
      const offsets = cumulativeOffsets(heights);
      const layout = scrollLayoutForReveal({
        offsets,
        index,
        containerHeight: 300,
        reveal: "bottom-with-clearance",
        bottomClearance: 12,
      });
      const cardTop = layout.leadingInset + offsets[index] - layout.scrollTop;
      const cardBottom = layout.leadingInset + offsets[index + 1] - layout.scrollTop;
      expect(cardTop).toBeGreaterThanOrEqual(0);
      expect(cardBottom).toBe(288);
      expect(layout.scrollTop).toBeLessThanOrEqual(
        layout.leadingInset + offsets[offsets.length - 1] + layout.trailingInset - 300,
      );
    }
  });

  it("#2539 begins a run taller than the feed viewport 12px below its top", () => {
    const offsets = cumulativeOffsets([200, 400]);
    const layout = scrollLayoutForReveal({
      offsets,
      index: 1,
      containerHeight: 300,
      reveal: "bottom-with-clearance",
      bottomClearance: 12,
    });
    expect(layout.leadingInset + offsets[1] - layout.scrollTop).toBe(12);
  });
});
