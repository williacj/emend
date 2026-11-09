// @vitest-environment jsdom
// ABOUTME: Direct tests for `VirtualList`'s public `scrollRequest` seam (§3.1 `timeline/`) — the
// ABOUTME: module is exported from `index.ts`, so a consumer other than `TimelinePanel` can request
// ABOUTME: a jump at mount, before the container has ever been measured. Pins that such a request
// ABOUTME: is still clamped once the measurement lands, and that a later unrelated re-measure or
// ABOUTME: item append never re-scrolls the user (UX Principle 2 — no scroll stealing).
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VirtualList, type VirtualListScrollRequest } from "./VirtualList";
import {
  installResizeObserverStub,
  mockClientHeight,
  mockRowHeights,
  setContainerHeight,
  sizeContainer,
} from "./virtualListTestUtils";

const ITEM_HEIGHT = 96;
const CONTAINER_HEIGHT = 600;

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
}

/** The same tree every time, so a rerender is a pure re-commit — which is all `VirtualList` needs
 * to re-measure — rather than a prop change that could itself explain a scroll move. */
function listOf(itemCount: number, scrollRequest?: { index: number }) {
  return (
    <VirtualList
      items={rows(itemCount)}
      itemKey={(row) => row.id}
      estimatedItemHeight={ITEM_HEIGHT}
      renderItem={(row) => <div className="row">{row.id}</div>}
      scrollRequest={scrollRequest}
    />
  );
}

function listWithReveal(itemCount: number, scrollRequest?: VirtualListScrollRequest) {
  return (
    <VirtualList
      items={rows(itemCount)}
      itemKey={(row) => row.id}
      estimatedItemHeight={ITEM_HEIGHT}
      renderItem={(row) => <div className="row">{row.id}</div>}
      scrollRequest={scrollRequest}
    />
  );
}

describe("timeline/VirtualList — scrollRequest (P2b-1a facet-jump seam)", () => {
  it("#2539 follows measured submitted-card growth until the author scrolls away", () => {
    const heights = { "row-0": 96, "row-1": 96, "row-2": 96 };
    const restoreHeight = mockClientHeight(300);
    const restoreRows = mockRowHeights(heights);
    try {
      const request = { index: 2, reveal: "bottom-with-clearance", bottomClearance: 12 } as const;
      const { container, rerender } = render(listWithReveal(3, request));
      const list = container.querySelector<HTMLElement>('[data-testid="virtual-list"]')!;
      expect(list.scrollTop).toBe(0);

      heights["row-2"] = 120;
      rerender(listWithReveal(3, request));
      expect(list.scrollTop).toBe(24);

      fireEvent.scroll(list, { target: { scrollTop: 0 } });
      heights["row-2"] = 160;
      rerender(listWithReveal(3, request));
      expect(list.scrollTop).toBe(0);
    } finally {
      restoreRows();
      restoreHeight();
    }
  });

  it("gives a requested tail row 12px of real leading clearance instead of losing it to scroll clamping", () => {
    const request = { index: 9, reveal: "top-with-clearance", topClearance: 12 } as const;
    const { container, rerender } = render(listWithReveal(10, request));
    const list = setContainerHeight(container, 300);

    rerender(listWithReveal(10, request));

    expect(list.scrollTop).toBe(9 * ITEM_HEIGHT);
    const spacers = list.querySelectorAll('[aria-hidden="true"]');
    // Overscan mounts rows 5-9, so this spacer is their ordinary 5 * 96px offset plus the
    // request-owned 12px leading inset. The target itself therefore sits exactly 12px below the
    // viewport top: 492 + (4 * 96) - 864 = 12.
    expect((spacers[0] as HTMLElement).style.height).toBe("492px");
    expect((spacers[spacers.length - 1] as HTMLElement).style.height).toBe("192px");
  });

  it("clamps a request made before the container's first measurement — applied once that measurement lands", () => {
    // The jump is requested at mount, when `containerHeight` is still 0 — the state in which the
    // clamp has nothing to subtract and would otherwise resolve to the raw, unclamped target.
    const request = { index: 99 };
    const { container, rerender } = render(listOf(100, request));

    const list = setContainerHeight(container, CONTAINER_HEIGHT);
    rerender(listOf(100, request)); // the first real layout measurement lands here

    const maxScrollTop = 100 * ITEM_HEIGHT - CONTAINER_HEIGHT; // 9000
    expect(list.scrollTop).toBe(maxScrollTop);
    expect(list.scrollTop).toBeLessThan(99 * ITEM_HEIGHT); // unclamped would have been 9504
  });

  it("does not re-scroll on a later re-measure or append — the same request is applied only once", () => {
    // One stable request object held across every rerender below: the caller asked for exactly one
    // jump, so exactly one jump is all it may ever get.
    const request = { index: 99 };
    const { container, rerender } = render(listOf(100, request));
    const list = setContainerHeight(container, CONTAINER_HEIGHT);
    rerender(listOf(100, request));
    expect(list.scrollTop).toBe(9000);

    // The user scrolls away from the jump target...
    fireEvent.scroll(list, { target: { scrollTop: 480 } });

    // ...then background activity changes both effect dependencies: more cards arrive and the
    // container is re-measured (e.g. a window resize). Neither is the user asking to move.
    setContainerHeight(container, 400);
    rerender(listOf(140, request));

    expect(list.scrollTop).toBe(480);
  });

  it("re-applies a fresh request carrying the same index — a repeat facet click jumps again", () => {
    // The positive half of the identity contract the test above pins negatively. The mechanism rests
    // entirely on object identity, so memoizing the request payload on `index` would silently break
    // "click Comments, scroll up to read, click Comments again to get back to the newest" — the
    // feature's primary recovery gesture — while leaving the suite green (review finding, PR #392).
    const { container, rerender } = render(listOf(100, { index: 99 }));
    const list = setContainerHeight(container, CONTAINER_HEIGHT);
    rerender(listOf(100, { index: 99 }));
    expect(list.scrollTop).toBe(9000);

    // The user scrolls up to read, then asks for the same jump a second time.
    fireEvent.scroll(list, { target: { scrollTop: 480 } });
    rerender(listOf(100, { index: 99 })); // a new object, same index

    expect(list.scrollTop).toBe(9000);
  });
});

/**
 * #1324 (UXR-Q2, CJ 2026-08-20): `TimelinePanel`'s own submit-scroll reuses this same seam, but with
 * `reveal: "full"` — reveal the *entire* submitted card when it fits the viewport, and just its top
 * when the card is itself taller than the viewport. `reveal` defaults to `"top"`, so the plain
 * facet-jump suite above is untouched by any of this.
 */
describe("timeline/VirtualList — scrollRequest reveal: 'full' (TimelinePanel submit-scroll, #1324)", () => {
  function listOfHeights(heights: Record<string, number>, scrollRequest?: VirtualListScrollRequest) {
    const ids = Object.keys(heights);
    return (
      <VirtualList
        items={ids.map((id) => ({ id }))}
        itemKey={(row) => row.id}
        // The estimate equals the eventual real height for every row here — isolating "which edge
        // does a fully-known card reveal" from the estimate/real-measurement mismatch the next
        // describe block covers.
        estimatedItemHeight={(row) => heights[row.id]}
        renderItem={(row) => <div className="row">{row.id}</div>}
        scrollRequest={scrollRequest}
      />
    );
  }

  it("bottom-anchors a card that fits the viewport — the whole card visible, not just its top", () => {
    const heights: Record<string, number> = {};
    for (let i = 0; i < 10; i++) heights[`row-${i}`] = 96; // 10 * 96 = 960 of content before the target
    heights["target"] = 150; // fits a 300px viewport
    heights["after"] = 96;
    const request = { index: 10, reveal: "full" as const };
    const { container, rerender } = render(listOfHeights(heights, request));
    const list = setContainerHeight(container, 300);
    rerender(listOfHeights(heights, request));

    expect(list.scrollTop).toBe(810); // (960 + 150) - 300 — the card's own bottom sits at the fold
  });

  it("reveals only the top when the card is itself taller than the viewport", () => {
    const heights: Record<string, number> = {};
    for (let i = 0; i < 10; i++) heights[`row-${i}`] = 96;
    heights["target"] = 500; // taller than the 300px viewport below
    heights["after"] = 96;
    const request = { index: 10, reveal: "full" as const };
    const { container, rerender } = render(listOfHeights(heights, request));
    const list = setContainerHeight(container, 300);
    rerender(listOfHeights(heights, request));

    expect(list.scrollTop).toBe(960); // the card's own top — reading starts there, not mid-card
  });

  it("#1324: corrects a fits-by-estimate jump once the card measures taller than the viewport it was estimated against", () => {
    // The actual defect: a just-submitted card has never been mounted when its own scrollRequest
    // first applies, so that first pass can only judge "does it fit" off `estimatedItemHeight` — a
    // uniform 96px guess, wildly short of what a message that wraps several lines really renders at.
    // The card's real height only arrives a commit later, once the jump has carried it into the
    // mounted window. Landing on the *estimate*-derived bottom-align and never correcting it would
    // reveal the wrong edge of an oversized card — its end, with the top (where reading starts) the
    // ~900 - 600 = 300px scrolled past. This is #1324's own repro shape, not a synthetic one.
    const ESTIMATE = 96;
    const REAL_HEIGHT = 900; // wraps far past the container
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = ESTIMATE;
    const restore = mockRowHeights({ "row-20": REAL_HEIGHT });
    try {
      const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
      const listOf = (count: number, scrollRequest?: VirtualListScrollRequest) => (
        <VirtualList
          items={rows(count)}
          itemKey={(row) => row.id}
          estimatedItemHeight={ESTIMATE}
          renderItem={(row) => <div className="row">{row.id}</div>}
          scrollRequest={scrollRequest}
        />
      );

      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, 600);

      // The submit: row-20 appends and its own `reveal: "full"` jump lands in the same commit —
      // `TimelinePanel.handleSubmit`'s exact shape.
      const request = { index: 20, reveal: "full" as const };
      rerender(listOf(21, request));

      // The card is taller (900) than the 600px viewport, so the correct, final resting place is its
      // own top — 20 * 96 = 1920 — once the real height is known, regardless of what the estimate
      // first suggested.
      expect(list.scrollTop).toBe(20 * ESTIMATE);
    } finally {
      restore();
    }
  });

  it("#1324: does not re-scroll once corrected, even when a later append/re-measure changes effect deps", () => {
    // Round-1 review finding (PR #1802): `fullRevealMeasuredRef` is the only thing bounding the
    // correction to one application per request, and the suite stayed green with the guard removed
    // — because a re-run against *unchanged* offsets recomputes the identical target, which is a
    // no-op `setScrollTop` regardless of the guard. The guard's real job only shows up once the
    // reader has since moved away from the corrected position: a later append/re-measure still
    // re-fires this effect (its deps are `items`/`measuredHeights`/`offsets`, none of which the
    // guard freezes), and without the guard it would call `setScrollTop` again with the *same*
    // computed target — silently yanking the reader back to it. That is exactly the scroll-stealing
    // the PR #392/#504 apply-once contract, and CJ's #1324 ruling, both forbid.
    const ESTIMATE = 96;
    const REAL_HEIGHT = 900; // taller than the viewport — corrects to its own top, 20 * 96 = 1920
    const restore = mockRowHeights({ "row-20": REAL_HEIGHT });
    try {
      const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
      const listOf = (count: number, scrollRequest?: VirtualListScrollRequest) => (
        <VirtualList
          items={rows(count)}
          itemKey={(row) => row.id}
          estimatedItemHeight={ESTIMATE}
          renderItem={(row) => <div className="row">{row.id}</div>}
          scrollRequest={scrollRequest}
        />
      );

      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, 600);

      const request = { index: 20, reveal: "full" as const };
      rerender(listOf(21, request));
      expect(list.scrollTop).toBe(20 * ESTIMATE); // corrected once, per the test above

      // The reader scrolls away from the corrected position — a standing choice this component
      // must never override on the reader's behalf (UX Principle 2).
      fireEvent.scroll(list, { target: { scrollTop: 200 } });

      // Unrelated background activity changes every one of the correction effect's own deps: a
      // further card arrives (`items`/`offsets` change) and the target row's own measurement is
      // re-read on the commit (`measuredHeights` is a fresh object even when its values agree) —
      // none of it is the reader asking to move again.
      rerender(listOf(22, request));

      expect(list.scrollTop).toBe(200);
    } finally {
      restore();
    }
  });

  it("still bottom-anchors once measured, when the card turns out to fit despite a smaller estimate", () => {
    // The converse of the test above: the estimate was too *small* but the real card still fits —
    // the one-time correction must not leave it stranded at a stale top-of-estimate position either.
    const ESTIMATE = 96;
    const REAL_HEIGHT = 500; // still fits a 600px viewport
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = ESTIMATE;
    const restore = mockRowHeights({ "row-20": REAL_HEIGHT });
    try {
      const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
      const listOf = (count: number, scrollRequest?: VirtualListScrollRequest) => (
        <VirtualList
          items={rows(count)}
          itemKey={(row) => row.id}
          estimatedItemHeight={ESTIMATE}
          renderItem={(row) => <div className="row">{row.id}</div>}
          scrollRequest={scrollRequest}
        />
      );

      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, 600);
      const request = { index: 20, reveal: "full" as const };
      rerender(listOf(21, request));

      // Total real content: 20 * 96 + 500 = 2420; bottom-anchored target is 2420 - 600 = 1820.
      expect(list.scrollTop).toBe(20 * ESTIMATE + REAL_HEIGHT - 600);
    } finally {
      restore();
    }
  });
});

// P2b-1b: `estimatedItemHeight` as a per-item function — the seam collapse composes with
// virtualization through (`collapse.ts`'s `itemHeightFor`). The spacer sizing and a facet-jump's
// scroll target must honor each item's *own* height, not a uniform assumption.
describe("timeline/VirtualList — per-item height function (P2b-1b collapse composition)", () => {
  function rowsOfHeight(heights: number[]) {
    return heights.map((height, i) => ({ id: `row-${i}`, height }));
  }

  function variableListOf(heights: number[], scrollRequest?: { index: number }) {
    return (
      <VirtualList
        items={rowsOfHeight(heights)}
        itemKey={(row) => row.id}
        estimatedItemHeight={(row) => row.height}
        renderItem={(row) => <div className="row">{row.id}</div>}
        scrollRequest={scrollRequest}
      />
    );
  }

  // A mounted row used to be rendered inside a box clamped to its item height; that clamp is what
  // let a taller-than-assumed card paint over its neighbour, so #1119 replaced it with a
  // content-sized, measured row (see the measured-height suite below). The per-item *estimate* is
  // still what sizes every row this list has not measured, which the two tests below assert.

  it("sizes the top spacer from the cumulative offset of the mounted window's start, not index * a uniform height", () => {
    // 50 collapsed (32px) rows ahead of the mounted window: a uniform-height assumption using the
    // caller's largest row (96px) would wildly overshoot the spacer and desync the scrollbar.
    const heights = [...Array.from({ length: 50 }, () => 32), ...Array.from({ length: 10 }, () => 96)];
    const { container } = render(variableListOf(heights));
    const list = setContainerHeight(container, 200);
    fireEvent.scroll(list, { target: { scrollTop: 50 * 32 } }); // scrolled exactly past every collapsed row

    const topSpacer = container.querySelector('[data-testid="virtual-list"] > div[aria-hidden]') as HTMLElement;
    // The mounted window starts at/near row 50 (the first 96px row) — its offset is 50*32, not
    // 50*96 (which a uniform assumption would produce for a `containerHeight`-sized top spacer).
    const spacerHeight = parseInt(topSpacer.style.height, 10);
    expect(spacerHeight).toBeLessThanOrEqual(50 * 32);
    expect(spacerHeight).toBeGreaterThan(0);
  });

  it("a facet-jump scroll target lands on the requested row's own cumulative offset, not index * a uniform height", () => {
    const heights = [96, 96, 32, 96]; // row 3's real top offset is 96+96+32 = 224, not 3*96 = 288
    const { container, rerender } = render(variableListOf(heights, { index: 3 }));
    const list = setContainerHeight(container, 50);
    rerender(variableListOf(heights, { index: 3 }));

    expect(list.scrollTop).toBe(224);
  });
});

/**
 * #1119: a row's height is a *measurement* of what it rendered, not the caller's constant. The
 * constant survives only as the estimate for a row this list has never had mounted — a real card
 * routinely renders taller than it (several activity lines, a chat message that wraps), and a row
 * box clamped to the constant let that overflow paint straight into the next row.
 */
describe("timeline/VirtualList — measured row heights (#1119)", () => {
  const ESTIMATE = 96;

  function listOfRows(count: number, scrollRequest?: { index: number }) {
    return (
      <VirtualList
        items={rows(count)}
        itemKey={(row) => row.id}
        estimatedItemHeight={ESTIMATE}
        renderItem={(row) => <div className="row">{row.id}</div>}
        scrollRequest={scrollRequest}
      />
    );
  }

  function mountedRowKeys(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-row-key]")).map(
      (row) => row.getAttribute("data-row-key") as string,
    );
  }

  function topSpacerHeight(container: HTMLElement): number {
    const spacer = container.querySelector('[data-testid="virtual-list"] > div[aria-hidden]') as HTMLElement;
    return parseFloat(spacer.style.height);
  }

  it("never clamps a mounted row to its estimated height — the box a taller card overflowed", () => {
    // The structural half of the fix, and the one that holds even before any measurement lands: a
    // mounted row is an ordinary content-sized block, so its card cannot paint over the next row
    // whatever it renders. `flow-root` keeps the card's own vertical margins inside that box, so
    // the measurement below is the row's whole flow contribution rather than its margins' remainder.
    const { container } = render(listOfRows(5));

    const mounted = Array.from(container.querySelectorAll("[data-row-key]")) as HTMLElement[];
    expect(mounted.length).toBeGreaterThan(0);
    for (const row of mounted) {
      expect(row.style.height).toBe("");
      expect(row.style.display).toBe("flow-root");
    }
  });

  it("reserves the scrollbar's gutter so a row's width never depends on how tall the content is", () => {
    // Measured rows close a loop constants could not: an appearing scrollbar narrows every row,
    // narrower rows wrap taller, and a stream sitting near the viewport height can then oscillate
    // across that threshold, re-measuring on every crossing. A reserved gutter has no such edge.
    const { container } = render(listOfRows(5));
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    expect(list.style.scrollbarGutter).toBe("stable");
  });

  it("offsets a row by the measured heights above it and by the estimate for rows never mounted", () => {
    // Rows 0-3 mount at the (unmeasured) first commit and report 200px each; rows 4+ have never been
    // mounted, so they keep the 96px estimate. Row 10's top is therefore 4*200 + 6*96, and a jump to
    // it lands there — not on the 10*96 a constant-height list would have computed.
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = 200;
    const restore = mockRowHeights(heights);
    try {
      const request = { index: 10 };
      const { container, rerender } = render(listOfRows(20, request));
      const list = setContainerHeight(container, 50);
      rerender(listOfRows(20, request));

      expect(list.scrollTop).toBe(4 * 200 + 6 * 96);
    } finally {
      restore();
    }
  });

  it("keeps a row's measured height after it leaves the mounted window", () => {
    // Measurements are the list's memory of the stream, not of the DOM currently in it: scrolling a
    // measured row out of the window must not revert it to the estimate, or every scroll back would
    // re-derive different offsets for content the reader has already seen.
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = 200;
    const restore = mockRowHeights(heights);
    try {
      const { container, rerender } = render(listOfRows(20));
      const list = setContainerHeight(container, 50);
      rerender(listOfRows(20));

      fireEvent.scroll(list, { target: { scrollTop: 1600 } });
      expect(mountedRowKeys(container)).not.toContain("row-0");

      // Rows 0-2 are unmounted, and a jump to row 3 still resolves through their measured heights.
      const request = { index: 3 };
      rerender(listOfRows(20, request));
      expect(list.scrollTop).toBe(3 * 200);
    } finally {
      restore();
    }
  });

  it("ignores a zero reading — a row with no layout yet keeps its estimate instead of collapsing to nothing", () => {
    // jsdom (and a display:none ancestor in a real browser) reports 0 for everything. Recording that
    // would stack the whole stream at offset 0 — every row on top of every other row.
    const restore = mockRowHeights({ "row-0": 0, "row-1": 0, "row-2": 0 });
    try {
      const request = { index: 2 };
      const { container, rerender } = render(listOfRows(20, request));
      const list = setContainerHeight(container, 50);
      rerender(listOfRows(20, request));

      expect(list.scrollTop).toBe(2 * 96);
    } finally {
      restore();
    }
  });

  it("re-reads a row that changes height with no re-render of the list at all (ResizeObserver)", () => {
    // The production edge a commit-time reading cannot cover: a card grows where nothing re-renders
    // this list — the window rewrapping its text, a font landing, a card's own internal state. The
    // mounted window is the observable, since taller rows fill the same viewport with fewer of them.
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = 100;
    const restoreHeights = mockRowHeights(heights);
    const restoreClientHeight = mockClientHeight(400);
    const observer = installResizeObserverStub();
    try {
      const { container } = render(listOfRows(20));
      const before = mountedRowKeys(container).length;
      expect(before).toBeGreaterThan(4);

      for (let i = 0; i < 20; i++) heights[`row-${i}`] = 400;
      act(() => observer.trigger());

      expect(mountedRowKeys(container).length).toBeLessThan(before);
    } finally {
      observer.restore();
      restoreClientHeight();
      restoreHeights();
    }
  });

  it("sizes the top spacer from measured heights so the mounted window sits where the scrollbar says", () => {
    const heights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) heights[`row-${i}`] = 200;
    const restore = mockRowHeights(heights);
    try {
      const { container, rerender } = render(listOfRows(20));
      const list = setContainerHeight(container, 200);
      rerender(listOfRows(20));

      fireEvent.scroll(list, { target: { scrollTop: 1000 } });

      // Every row the reader has scrolled past has been measured at 200px by now, so the spacer
      // standing in for them is a multiple of 200 — never the 96px-per-row a constant would give.
      const spacer = topSpacerHeight(container);
      expect(spacer % 200).toBe(0);
      expect(spacer).toBeGreaterThan(0);
      expect(spacer).toBeLessThanOrEqual(1000);
    } finally {
      restore();
    }
  });
});
