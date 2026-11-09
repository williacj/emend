// @vitest-environment jsdom
// ABOUTME: Direct tests for `VirtualList`'s tail-follow (P2b-1c, UXR-Q2 — ux-design §4 "Scroll
// ABOUTME: motion"): a reader still at the tail is carried by content growing — an append, or a row
// ABOUTME: measuring taller than the estimate it was laid out at; a scrolled-up reader never is; a
// ABOUTME: same-commit `scrollRequest` owns that commit rather than racing for the `scrollTop` state.
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

function listOf(itemCount: number, scrollRequest?: VirtualListScrollRequest) {
  return listOfKeys(rows(itemCount).map((row) => row.id), scrollRequest);
}

/** The same list over an explicit set of keys — the route to a stream whose items are *replaced*
 * rather than appended to (a facet switch), which `listOf`'s positional `row-N` ids cannot express:
 * a measurement is remembered per key, so reusing those ids would silently reuse the old heights. */
function listOfKeys(
  ids: string[],
  scrollRequest?: VirtualListScrollRequest,
  preserveScrollKey?: string,
) {
  return (
    <VirtualList
      items={ids.map((id) => ({ id }))}
      itemKey={(row) => row.id}
      estimatedItemHeight={ITEM_HEIGHT}
      renderItem={(row) => <div className="row">{row.id}</div>}
      scrollRequest={scrollRequest}
      preserveScrollKey={preserveScrollKey}
    />
  );
}

describe("timeline/VirtualList — tail-follow (P2b-1c, UXR-Q2)", () => {
  it("clears a no-growth permission snapshot before a later ordinary append", () => {
    const ids = rows(20).map(({ id }) => id);
    const { container, rerender } = render(listOfKeys(ids, undefined, "initial"));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } });

    rerender(listOfKeys(ids, undefined, "pending-outside-facet"));
    rerender(listOfKeys([...ids, "another-row"], undefined, "pending-outside-facet"));

    expect(list.scrollTop).toBe(21 * ITEM_HEIGHT - CONTAINER_HEIGHT);
  });

  it("carries a reader still at the tail when items append", () => {
    const { container, rerender } = render(listOf(100));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    const maxScrollTop = 100 * ITEM_HEIGHT - CONTAINER_HEIGHT; // 9000
    fireEvent.scroll(list, { target: { scrollTop: maxScrollTop } });
    expect(list.scrollTop).toBe(maxScrollTop);

    rerender(listOf(101));

    const newMaxScrollTop = 101 * ITEM_HEIGHT - CONTAINER_HEIGHT; // 9096
    expect(list.scrollTop).toBe(newMaxScrollTop);
  });

  it("never carries a reader who has scrolled away from the tail", () => {
    const { container, rerender } = render(listOf(100));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 480 } });
    expect(list.scrollTop).toBe(480);

    rerender(listOf(101));

    expect(list.scrollTop).toBe(480);
  });

  it("a fresh mount starts at the tail of an empty/short stream — the first append does carry it", () => {
    const { container, rerender } = render(listOf(0));
    sizeContainer(container, CONTAINER_HEIGHT);
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    expect(list.scrollTop).toBe(0);

    rerender(listOf(1));

    // One 96px row never exceeds the 600px viewport — the tail and the top coincide, so following
    // it is a no-op scrollTop-wise, but it must not have thrown or desynced from a real max scroll.
    expect(list.scrollTop).toBe(0);
  });

  // The two tests below use `mockClientHeight` rather than `sizeContainer`/`setContainerHeight`: both
  // of those only override `clientHeight` *after* `render()` returns, i.e. after the first commit
  // already measured 0 — indistinguishable, scrollTop-wise, from a real browser mount only by
  // accident (review finding, PR #504: the test above passes whether tail-follow fires or is deleted
  // outright, since a single 96px row never exceeds the 600px viewport either way). A real browser
  // has layout before `VirtualList`'s first `useLayoutEffect` runs — `mockClientHeight` reproduces
  // that ordering, and neither test below ever fires a `scroll` event.
  //
  // Of the two, only the 3-row one discriminates: a 0-row mount has `totalHeight === 0`, which makes
  // even a broken mount-time reading come out `true`, so that test passes with or without the fix
  // (review finding, PR #504 round 2 — the earlier claim here that *either* would catch a regression
  // was wrong). Keep the 3-row test: it is the sole coverage of the mount-time `atTailRef` reading.
  // Its 0-row sibling is a cheaper smoke check that the empty-mount path scrolls at all.

  // Shared by the two tests below: mount `initialItemCount` rows under a browser-shaped (layout-
  // before-first-paint) measurement, confirm the mount itself never scrolled, then append past the
  // 600px viewport and confirm tail-follow carried the reader — the only difference between them is
  // whether the mount was empty or already had content that happened to fit.
  function expectFollowsAnAppendPastTheViewport(initialItemCount: number) {
    const restore = mockClientHeight(CONTAINER_HEIGHT);
    try {
      const { container, rerender } = render(listOf(initialItemCount));
      const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
      expect(list.scrollTop).toBe(0);

      rerender(listOf(20)); // 20 * 96 = 1920px, well past the 600px viewport

      const maxScrollTop = 20 * ITEM_HEIGHT - CONTAINER_HEIGHT; // 1320
      expect(list.scrollTop).toBe(maxScrollTop);
    } finally {
      restore();
    }
  }

  it("follows an append past the viewport for a reader at the tail of a stream whose only measurement ever came from layout — no scroll event ever fired", () => {
    expectFollowsAnAppendPastTheViewport(0);
  });

  it("follows an append past the viewport for a reader at the tail of a stream that fit the viewport at mount and was never scrolled", () => {
    expectFollowsAnAppendPastTheViewport(3); // 3 * 96 = 288px, fits the 600px viewport
  });

  it("keeps following a reader at the tail after the container shrinks under them — a resize is not a scroll", () => {
    // The `N new in <Facet> →` affordance is a `flex: none` sibling of this list, so it shrinks the
    // container exactly this way when it appears — and a card matching the *active* facet can land
    // while it is up. A shrink grows `maxScrollTop` without moving `scrollTop` and without firing a
    // `scroll` event, so re-reading `atTailRef` on it would silently revoke a standing choice the
    // reader never changed (review finding, PR #504 round 2).
    const observer = installResizeObserverStub();
    try {
      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } }); // 1320

      const shrunkHeight = CONTAINER_HEIGHT - 40;
      setContainerHeight(container, shrunkHeight);
      act(() => observer.trigger());
      expect(list.scrollTop).toBe(20 * ITEM_HEIGHT - shrunkHeight); // 1360

      rerender(listOf(21));

      expect(list.scrollTop).toBe(21 * ITEM_HEIGHT - shrunkHeight); // 1456
    } finally {
      observer.restore();
    }
  });

  it("carries a reader at the tail to the new tail when a container shrink and an append land in the SAME commit", () => {
    // Round-3 review, probe G: unlike the test above, there is no intervening `rerender` between
    // `setContainerHeight` and the append below, so the shrink's re-measurement and the append's
    // `items.length` growth land in one commit together — no real browser event ever separates them
    // (a window resize is only ever observed on the next commit for some other reason, and an append
    // is exactly such a commit; the affordance's own appearance is the same shape). The follow effect
    // must compute its target off the *live* `clientHeight`, not the (in this commit, still-stale)
    // `containerHeight` state, or the reader is stranded short of the new tail and tail-follow is
    // silently revoked until their next manual scroll.
    const { container, rerender } = render(listOf(20));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } }); // 1320

    const shrunkHeight = CONTAINER_HEIGHT - 40; // 560
    setContainerHeight(container, shrunkHeight);
    rerender(listOf(21)); // the shrink re-measure and the append share this one commit

    const newTail = 21 * ITEM_HEIGHT - shrunkHeight; // 1456
    expect(list.scrollTop).toBe(newTail);

    // Tail-follow must not have been silently revoked by the earlier stranding either.
    rerender(listOf(22));
    expect(list.scrollTop).toBe(22 * ITEM_HEIGHT - shrunkHeight); // 1552
  });

  it("still stops following a reader who scrolls away from the tail in the same commit as a resize", () => {
    // The converse guard: skipping the reading on a resize must not swallow a genuine `scrollTop`
    // change that lands with one, which would leave a scrolled-away reader labelled at-tail and get
    // them yanked by the next append — scroll-stealing, the direction UX Principle 2 actually forbids.
    const { container, rerender } = render(listOf(20));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } });

    setContainerHeight(container, CONTAINER_HEIGHT - 40);
    fireEvent.scroll(list, { target: { scrollTop: 480 } }); // resize + real scroll, one commit

    rerender(listOf(21));

    expect(list.scrollTop).toBe(480);
  });

  it("an explicit scrollRequest arriving in the same commit as an append is what moves a reader who was NOT at the tail — not tail-follow", () => {
    // The user's own submit: a new card lands (append) and, in the same commit, an explicit
    // facet-jump-shaped request targets it (`TimelinePanel`'s submit-scroll reuses this seam).
    // Starting the reader scrolled well away from the tail isolates which mechanism actually moved
    // them — tail-follow alone would never carry a reader here, so a landed jump proves the
    // `scrollRequest` effect fired instead of (or racing) this one.
    const { container, rerender } = render(listOf(100));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 480 } });

    const request = { index: 100 };
    rerender(listOf(101, request));

    const newMaxScrollTop = 101 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    expect(list.scrollTop).toBe(newMaxScrollTop);
  });

  it("never chases a shrinking list — a facet switch to a narrower filter doesn't move scrollTop", () => {
    const { container, rerender } = render(listOf(100));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    const maxScrollTop = 100 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    fireEvent.scroll(list, { target: { scrollTop: maxScrollTop } });

    rerender(listOf(10)); // e.g. a facet narrows the stream

    // Shrinking is not "grew" — tail-follow is a no-op; the container itself would clamp separately.
    expect(list.scrollTop).toBe(maxScrollTop);
  });

  it("resumes following once the reader scrolls back to the new shorter tail after a shrink", () => {
    const { container, rerender } = render(listOf(100));
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 100 * ITEM_HEIGHT - CONTAINER_HEIGHT } });

    rerender(listOf(10));
    const shortMax = 10 * ITEM_HEIGHT - CONTAINER_HEIGHT; // negative -> clamped to 0 by the browser/us
    fireEvent.scroll(list, { target: { scrollTop: Math.max(0, shortMax) } });

    rerender(listOf(11));

    const newMax = Math.max(0, 11 * ITEM_HEIGHT - CONTAINER_HEIGHT);
    expect(list.scrollTop).toBe(newMax);
  });

  // The three tests below are the only ones in this file where a row's *measured* height differs
  // from the caller's estimate. Every test above runs with `measuredHeights` permanently `{}`: jsdom
  // answers 0 from every `getBoundingClientRect()` and `handleRowMeasured` correctly refuses a zero,
  // so estimate and measurement coincide by accident and the whole class of "the tail moved after
  // the count stopped changing" is invisible to them (review finding, PR #1318 round 1).
  const TALL_ROW = 300; // a chat send that wrapped — well past the 96px estimate

  /** Every row at exactly the estimate, so any arithmetic below is attributable to the one row a
   * test deliberately makes taller rather than to measurement noise. Mutable in place: `mockRowHeights`
   * re-reads it on every call, which is how a row is made to *grow* mid-test. */
  function heightsFor(count: number): Record<string, number> {
    const heights: Record<string, number> = {};
    for (let i = 0; i < count; i += 1) heights[`row-${i}`] = ITEM_HEIGHT;
    return heights;
  }

  it("re-pins the tail when the appended card MEASURES taller than its estimate", () => {
    // The defect this guards: an appended card has never been mounted, so the commit that grows
    // `items.length` lays it out at its *estimate* and tail-follow pins to that estimate's tail. The
    // real height only arrives a commit later — by which time the item count is unchanged, so a
    // follow gated on "the count grew" has already fired and never fires again. The reader is left
    // short by exactly the amount the card exceeded its estimate, permanently (in Chromium, three
    // arriving cards put the newest one 534px below the fold — off screen entirely).
    const heights = heightsFor(20);
    heights["row-20"] = TALL_ROW;
    const restore = mockRowHeights(heights);
    try {
      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } }); // 1320

      rerender(listOf(21));

      // 20 * 96 + 300 = 2220 of content, so the tail is 1620 — not the 1416 the estimate implied.
      expect(list.scrollTop).toBe(20 * ITEM_HEIGHT + TALL_ROW - CONTAINER_HEIGHT);
    } finally {
      restore();
    }
  });

  it("re-pins the tail when a card already on screen grows in place — no re-render of the list at all", () => {
    // The same "the tail moved while the count did not" shape, reached through the one path that
    // carries no re-render of the list at all: a card rewrapping on a width change, a web font
    // landing, an image resolving. `ResizeObserver` is the only thing that observes those, so this
    // drives the reading through the stub rather than through a commit. (A live run card gaining an
    // activity line is the *other* half of "count unchanged, total grown" — its card data changes,
    // so it arrives with a render and the commit-time reading sees it. Either way a follow gated on
    // the item count cannot fire even once, which is what this asserts.)
    const heights = heightsFor(20);
    const restore = mockRowHeights(heights);
    const observer = installResizeObserverStub();
    try {
      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } }); // 1320

      heights["row-19"] = ITEM_HEIGHT + 200; // the live card at the tail grows by 200px
      act(() => observer.trigger());
      rerender(listOf(20)); // nothing about the items changed — this only lets the reading land

      expect(list.scrollTop).toBe(20 * ITEM_HEIGHT + 200 - CONTAINER_HEIGHT); // 1520
    } finally {
      observer.restore();
      restore();
    }
  });

  it("preserves the reader's exact position when a permission FIFO change grows a visible run card (#2429)", () => {
    const heights = heightsFor(20);
    const restore = mockRowHeights(heights);
    try {
      const ids = rows(20).map(({ id }) => id);
      const { container, rerender } = render(listOfKeys(ids, undefined, "no-permission"));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      const oldTail = 20 * ITEM_HEIGHT - CONTAINER_HEIGHT;
      fireEvent.scroll(list, { target: { scrollTop: oldTail } });

      heights["row-19"] = ITEM_HEIGHT + 200;
      rerender(listOfKeys(ids, undefined, "project-a/run-1/request-1"));

      expect(list.scrollTop).toBe(oldTail);
    } finally {
      restore();
    }
  });

  it("a facet switch to fewer but TALLER cards still never moves the reader — even though the total grows", () => {
    // The shrink guard has to outlast the commit the count drops in. The replacement cards have
    // never been mounted either, so the switch commit lays them out at their estimates and their
    // real (larger) heights land a commit later — by which time the count is unchanged and the total
    // has grown, which is precisely the shape tail-follow now follows. Without the standing choice
    // being revoked at the switch, a facet change would scroll the reader to the tail of a stream
    // they just arrived in: motion they never asked for, and a behaviour question `ux-design.md`
    // does not answer, so this fix must not decide it by accident.
    const heights = heightsFor(20);
    for (let i = 0; i < 5; i += 1) heights[`tall-${i}`] = 500; // 5 * 500 = 2500 > 20 * 96 = 1920
    const restore = mockRowHeights(heights);
    try {
      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 20 * ITEM_HEIGHT - CONTAINER_HEIGHT } }); // 1320

      rerender(listOfKeys(["tall-0", "tall-1", "tall-2", "tall-3", "tall-4"]));

      expect(list.scrollTop).toBe(20 * ITEM_HEIGHT - CONTAINER_HEIGHT);
    } finally {
      restore();
    }
  });

  it("never carries a reader who has scrolled away when a measurement grows the stream", () => {
    // The converse guard on the broadened follow condition: "the content grew" must still be
    // subordinate to the reader's standing choice, or a card measuring taller anywhere in the stream
    // yanks a reader who is reading history — the scroll-stealing UX Principle 2 forbids outright.
    const heights = heightsFor(20);
    heights["row-20"] = TALL_ROW;
    const restore = mockRowHeights(heights);
    try {
      const { container, rerender } = render(listOf(20));
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 480 } });

      rerender(listOf(21));

      expect(list.scrollTop).toBe(480);
    } finally {
      restore();
    }
  });

  it("does not apply before the container has ever been measured (containerHeight still 0)", () => {
    const { container, rerender } = render(listOf(0));
    // No sizeContainer call — containerHeight is still its initial 0.
    rerender(listOf(1));
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    expect(list.scrollTop).toBe(0);
  });
});
