// ABOUTME: Pure windowing math for the timeline's virtualized stream (§3.1 `timeline/`) — given a
// ABOUTME: scroll position, viewport size and each row's height, computes which rows to mount,
// ABOUTME: independent of total item count (D4 "one ever-growing stream" / UX §4 "timeline at scale").
export interface VisibleRange {
  /** Inclusive first index to render. */
  startIndex: number;
  /** Exclusive end index to render (i.e. render `[startIndex, endIndex)`). */
  endIndex: number;
}

/**
 * Prefix-sum cumulative offsets for a variable per-item height array (P2b-1b: a collapsed card's
 * row is shorter than an expanded one, so a single uniform row height can't size it) — `offsets[i]`
 * is the top of item `i`; the final entry (`offsets[itemHeights.length]`) is the total content
 * height. Pure arithmetic over whatever heights the caller has: `VirtualList` passes each row's
 * measured height where it has one and the caller's estimate elsewhere (#1119), so this module
 * stays free of the DOM either way.
 */
export function cumulativeOffsets(itemHeights: readonly number[]): number[] {
  const offsets = new Array<number>(itemHeights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < itemHeights.length; i++) {
    offsets[i + 1] = offsets[i] + Math.max(0, itemHeights[i]);
  }
  return offsets;
}

/** Total scrollable content height for a variable per-item height array. */
export function totalContentHeightVariable(itemHeights: readonly number[]): number {
  const offsets = cumulativeOffsets(itemHeights);
  return offsets[offsets.length - 1];
}

export interface VisibleRangeVariableParams {
  /** Per-item row height, in stream order — each row's measured height where `VirtualList` has one,
   * otherwise the caller's estimate (`collapse.ts`'s `itemHeightFor`). */
  itemHeights: readonly number[];
  containerHeight: number;
  scrollTop: number;
  overscan: number;
}

/**
 * Computes the `[startIndex, endIndex)` window of rows that should be mounted, for a per-item
 * height array. Convenience form of `computeVisibleRangeFromOffsets` below for a caller holding
 * heights rather than offsets; it pays an O(itemCount) `cumulativeOffsets` precompute to get
 * there, so a caller that scrolls the same list repeatedly should hold the offsets and use that
 * function directly, as `VirtualList` does.
 */
export function computeVisibleRangeVariable({
  itemHeights,
  containerHeight,
  scrollTop,
  overscan,
}: VisibleRangeVariableParams): VisibleRange {
  if (itemHeights.length === 0) return { startIndex: 0, endIndex: 0 };
  return computeVisibleRangeFromOffsets({
    offsets: cumulativeOffsets(itemHeights),
    containerHeight,
    scrollTop,
    overscan,
  });
}

export interface VisibleRangeFromOffsetsParams {
  /** `cumulativeOffsets` output for the stream: `itemCount + 1` entries, non-decreasing. */
  offsets: readonly number[];
  containerHeight: number;
  scrollTop: number;
  overscan: number;
}

/** The smallest index in `[lo, hi]` satisfying `reached`, or `hi + 1` when none does. `reached`
 * must be monotone (false for a prefix, then true) — which every "is this offset past X" question
 * is, since `cumulativeOffsets` clamps each height at 0 and so never decreases. */
function firstIndexWhere(lo: number, hi: number, reached: (index: number) => boolean): number {
  let low = lo;
  let high = hi + 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (reached(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

export interface RevealScrollTargetParams {
  /** `cumulativeOffsets` output for the stream: `itemCount + 1` entries, non-decreasing. */
  offsets: readonly number[];
  /** Index of the item the request targets. */
  index: number;
  containerHeight: number;
  /**
   * `"top"` pins the item's own top to the viewport's top (P2b-1a facet-jump's only mode, unchanged
   * by #1324) — clamped to the container's actual max scroll, the same bound a real `scrollTop`
   * assignment gets from the browser. `"full"` is `TimelinePanel`'s own submit-scroll (UXR-Q2,
   * #1324): reveal the entire item, bottom-anchored, whenever it fits the viewport — so as much
   * preceding context as fits stays visible above it, and nothing below the fold is unread — and
   * fall back to `"top"` once the item is itself taller than the viewport, so reading still begins
   * at its natural start rather than landing mid-card. `"top-with-clearance"` is the J9 run-card
   * reveal: align the card's top with the requested clearance and promise the whole card only when
   * the card plus that clearance fits. `"bottom-with-clearance"` is 4g's submitted-turn reveal:
   * bottom-align a fitting card with the specified clearance, or begin a taller one at its top.
   */
  // @anchor:virtual-list-reveal-kind
  reveal: "top" | "full" | "top-with-clearance" | "bottom-with-clearance";
  /** Space kept between the viewport top and the target for `top-with-clearance`. */
  topClearance?: number;
  /** Space kept beneath a submitted card for `bottom-with-clearance`. */
  bottomClearance?: number;
}

export interface RevealScrollLayout {
  scrollTop: number;
  /** Temporary content insets that make the requested clearance reachable at either stream edge. */
  leadingInset: number;
  trailingInset: number;
}

/**
 * Scroll position plus the request-owned content insets needed to make it a real browser scroll
 * position. A normal scroll container cannot place its first row below the viewport top or its
 * final row near the viewport top without content beyond those edges, so the J9 run reveal owns
 * exactly that temporary space instead of asking the DOM for a scrollTop it will clamp away.
 */
export function scrollLayoutForReveal({
  offsets,
  index,
  containerHeight,
  reveal,
  topClearance = 0,
  bottomClearance = 0,
}: RevealScrollTargetParams): RevealScrollLayout {
  const totalHeight = offsets[offsets.length - 1];
  const itemTop = offsets[index];
  if (reveal === "top-with-clearance") {
    const leadingInset = Math.max(0, topClearance);
    // The leading inset shifts the row down by the same amount the viewport leaves above it. The
    // resulting target is therefore the row's ordinary pre-inset offset, including for row zero.
    const scrollTop = Math.max(0, itemTop);
    const trailingInset = Math.max(
      0,
      scrollTop + containerHeight - (leadingInset + totalHeight),
    );
    return { scrollTop, leadingInset, trailingInset };
  }

  if (reveal === "bottom-with-clearance") {
    const clearance = Math.max(0, bottomClearance);
    const itemBottom = offsets[index + 1];
    const itemHeight = itemBottom - itemTop;
    // A taller-than-viewport submitted card begins at its top, with room for the focus ring.
    // Otherwise its bottom lands above the requested clearance, even for a short feed or a
    // card near either content edge where an ordinary scrollTop would be clamped.
    const leadingInset = itemHeight + clearance > containerHeight
      ? clearance
      : Math.max(0, containerHeight - itemBottom - clearance);
    const scrollTop = itemHeight + clearance > containerHeight
      ? itemTop
      : Math.max(0, leadingInset + itemBottom + clearance - containerHeight);
    const trailingInset = Math.max(0, scrollTop + containerHeight - leadingInset - totalHeight);
    return { scrollTop, leadingInset, trailingInset };
  }

  const maxScrollTop = Math.max(0, totalHeight - containerHeight);
  if (reveal === "full") {
    const itemBottom = offsets[index + 1];
    const itemHeight = itemBottom - itemTop;
    const raw = itemHeight <= containerHeight ? itemBottom - containerHeight : itemTop;
    return {
      scrollTop: Math.max(0, Math.min(raw, maxScrollTop)),
      leadingInset: 0,
      trailingInset: 0,
    };
  }
  return {
    scrollTop: Math.max(0, Math.min(itemTop, maxScrollTop)),
    leadingInset: 0,
    trailingInset: 0,
  };
}

/**
 * The scroll target for a `VirtualList` `scrollRequest` (`VirtualList.tsx`'s two request-applying
 * effects both reduce to this). Pure so the "which edge does this reveal" arithmetic — the part
 * CJ's #1324 ruling actually decided — is directly testable without a DOM.
 */
// @anchor:scroll-target-for-reveal
export function scrollTargetForReveal({
  offsets,
  index,
  containerHeight,
  reveal,
  topClearance,
  bottomClearance,
}: RevealScrollTargetParams): number {
  return scrollLayoutForReveal({
    offsets,
    index,
    containerHeight,
    reveal,
    topClearance,
    bottomClearance,
  }).scrollTop;
}

/**
 * The `[startIndex, endIndex)` window for a stream whose cumulative offsets are already known —
 * the mounted window stays bounded by the viewport, not by the stream, for variable heights too
 * (test-plan §6's virtualization budget). Both edges of the visible band are binary-searched over
 * the offsets rather than scanned from index 0, so a scroll costs O(log itemCount) here; the
 * caller's own O(itemCount) offset precompute happens when a *height* changes, not on every scroll
 * event (review finding, PR #481, resolved by #1119 rather than merely documented).
 */
export function computeVisibleRangeFromOffsets({
  offsets,
  containerHeight,
  scrollTop,
  overscan,
}: VisibleRangeFromOffsetsParams): VisibleRange {
  const itemCount = offsets.length - 1;
  if (itemCount <= 0) return { startIndex: 0, endIndex: 0 };

  // First index whose bottom edge sits past scrollTop — the first (partially-)visible row. Row `i`'s
  // bottom edge is `offsets[i + 1]`, so this searches the bottom edges and steps back. Every row
  // above the scroll position leaves `firstVisible === itemCount`, the same over-scrolled answer a
  // scan from 0 gives (a stale scroll position over content that shrank).
  const viewportBottom = scrollTop + containerHeight;
  const firstVisible = firstIndexWhere(1, itemCount, (bottomEdge) => offsets[bottomEdge] > scrollTop) - 1;

  // Last (exclusive) index whose top edge is still inside the viewport's bottom edge.
  let lastVisible = Math.min(
    itemCount,
    firstIndexWhere(firstVisible, itemCount, (topEdge) => offsets[topEdge] >= viewportBottom),
  );
  // Always cover at least the first visible row itself — mirrors the fixed-height case's "+1"
  // partial-row allowance, and keeps a `containerHeight` of 0 (pre-measurement) from degenerating
  // to an empty window.
  if (lastVisible <= firstVisible) lastVisible = Math.min(itemCount, firstVisible + 1);

  return {
    startIndex: Math.max(0, firstVisible - overscan),
    endIndex: Math.min(itemCount, lastVisible + overscan),
  };
}
