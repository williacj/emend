// @vitest-environment jsdom
// ABOUTME: Perf benchmark for `timeline/VirtualList`'s scroll-path cost at scale (test-plan §6,
// ABOUTME: "Timeline with 5k cards: scroll jank-free (virtualization test)") — a tracked benchmark,
// ABOUTME: never a shared-CI gate. Run via `npm run test:perf` on a dedicated/consistent machine
// ABOUTME: (test-plan §6); excluded from `npm test`'s vitest.config.ts.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessageCard } from "../../src/timeline/ChatMessageCard";
import type { TimelineCard } from "../../src/timeline/types";
import { VirtualList } from "../../src/timeline/VirtualList";
import { sizeContainer } from "../../src/timeline/virtualListTestUtils";
import { buildTimelineCards } from "./fixtures/timelineCards";
import { percentile } from "./percentile";

const ITEM_HEIGHT = 96;
const CONTAINER_HEIGHT = 600;

/**
 * test-plan §6 states no literal millisecond figure for this budget (unlike the editor's "open +
 * render"/"keystroke" budgets, both of which carry one) — only "scroll jank-free." The natural
 * reading of "jank-free" is a single 60Hz frame, the same figure the editor rig's keystroke budget
 * already targets; `GROSS_REGRESSION_MS` follows the same "only gross regressions (>2× baseline)
 * hard-fail" anti-flake rule the rest of this suite uses (see structuralDecorationsViewport's own
 * docblock for the full reasoning) — the raw p95 is logged either way for a human to eyeball.
 */
const SCROLL_FRAME_TARGET_MS = 16;
const GROSS_REGRESSION_MS = SCROLL_FRAME_TARGET_MS * 2;

function renderItem(card: TimelineCard) {
  if (card.kind !== "chat-message") {
    throw new Error(`fixture only builds chat-message cards, got ${card.kind}`);
  }
  return <ChatMessageCard card={card} />;
}

/**
 * Mounts a `VirtualList` of `items` and drives its container to a real, measured height —
 * `sizeContainer` overrides `clientHeight` and then rides an actual scroll-event round trip (see
 * its own docblock) to let that measurement land, which is what keeps the windowing math off the
 * `containerHeight === 0` degenerate case (the same "force real state before measuring" discipline
 * `structuralDecorationsViewport.perf.test.ts`'s `mount` uses for the editor's syntax tree).
 */
function mountList(items: TimelineCard[]) {
  const { container } = render(
    <VirtualList items={items} itemKey={(card) => card.id} estimatedItemHeight={ITEM_HEIGHT} renderItem={renderItem} />,
  );
  const list = sizeContainer(container, CONTAINER_HEIGHT);
  return { container, list };
}

/** Scrolls to `count` positions spread evenly across the full scrollable range, returning each
 * scroll dispatch's wall-clock duration in milliseconds — the real re-render path (`onScroll` →
 * `setState` → windowing recompute → commit), the same measurement shape as the editor rig's
 * `typeKeystrokes`. */
function scrollThrough(list: HTMLElement, itemCount: number, count: number): number[] {
  const maxScrollTop = Math.max(0, itemCount * ITEM_HEIGHT - CONTAINER_HEIGHT);
  const durations: number[] = [];
  for (let i = 0; i < count; i++) {
    const target = Math.round((maxScrollTop * i) / Math.max(1, count - 1));
    const start = performance.now();
    fireEvent.scroll(list, { target: { scrollTop: target } });
    durations.push(performance.now() - start);
  }
  return durations;
}

describe("timeline/VirtualList — scroll-path perf benchmark at 5,000 cards (test-plan §6)", () => {
  it("scroll-driven redraw latency across a 5000-card stream stays within the jank-free gross-regression budget", () => {
    const items = buildTimelineCards(5000);
    const { list } = mountList(items);

    // Warm-up: the first scroll pays for the container's first real layout measurement (mirrors the
    // editor rig's mount-cost exclusion) — excluded from the measurement below.
    scrollThrough(list, items.length, 3);

    const durations = scrollThrough(list, items.length, 50);
    const p95 = percentile(durations, 95);

    console.log(
      `[perf] scroll dispatch p95 across a 5,000-card stream: ${p95.toFixed(2)}ms ` +
        `(frame target ${SCROLL_FRAME_TARGET_MS}ms, gross-regression line ${GROSS_REGRESSION_MS}ms)`,
    );
    expect(p95).toBeLessThan(GROSS_REGRESSION_MS);
  });

  it("scroll-driven redraw latency does not scale with total card count (the virtualization guarantee itself)", () => {
    // The real regression signal test-plan §6 calls for: relative, not absolute — proof that
    // scroll-redraw cost is bounded by the viewport, not by stream length (mirrors the editor rig's
    // own small-vs-large-doc scaling test for the identical reason).
    const smallItems = buildTimelineCards(50);
    const largeItems = buildTimelineCards(5000);

    const { list: smallList } = mountList(smallItems);
    const { list: largeList } = mountList(largeItems);

    scrollThrough(smallList, smallItems.length, 3); // warm-up, excluded below
    scrollThrough(largeList, largeItems.length, 3);

    const smallMedian = percentile(scrollThrough(smallList, smallItems.length, 30), 50);
    const largeMedian = percentile(scrollThrough(largeList, largeItems.length, 30), 50);

    console.log(
      `[perf] scroll dispatch median — 50 cards: ${smallMedian.toFixed(2)}ms, ` +
        `5,000 cards (100x): ${largeMedian.toFixed(2)}ms`,
    );

    // A generous ratio cap — not 1:1, sub-millisecond jsdom timings are genuinely noisy — that would
    // still catch an O(itemCount) regression (e.g. mounting every row instead of the windowed few).
    // The `+5` floor keeps the assertion meaningful when the small-list median itself rounds to ~0ms
    // (mirrors the editor rig's identical `+5` floor, same reasoning).
    expect(largeMedian).toBeLessThan(smallMedian * 10 + 5);
  });

  it("mounts only a bounded window of DOM rows regardless of scrolling deep into a 5000-card stream (the virtualization assertion itself)", () => {
    // test-plan §6 names this budget "the virtualization test" specifically — this is that direct,
    // non-timing structural assertion: however far into a 5000-card stream the user scrolls, the
    // mounted DOM never grows to match, which is what actually keeps the scroll-timing assertions
    // above flat regardless of stream length (`virtualization.ts`'s windowing contract).
    const items = buildTimelineCards(5000);
    const { container, list } = mountList(items);

    fireEvent.scroll(list, { target: { scrollTop: 2500 * ITEM_HEIGHT } });

    const mountedRows = container.querySelectorAll(".timeline-card");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(20);
  });
});
