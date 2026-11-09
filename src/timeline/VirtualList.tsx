// ABOUTME: A measured-row-height virtualized scroll container (§3.1 `timeline/`) — mounts only the
// ABOUTME: visible window (+ overscan) of `items` (D4/UX §4), and tail-follows a reader still there.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  computeVisibleRangeFromOffsets,
  cumulativeOffsets,
  scrollLayoutForReveal,
  scrollTargetForReveal,
} from "./virtualization";

/** An imperative "bring this index into view" request (P2b-1a facet-jump). A fresh object each
 * time — even re-requesting the same `index` — so the effect below always re-fires; two clicks of
 * the same facet button in a row must both jump, not just the first. */
export interface VirtualListScrollRequest {
  index: number;
  /**
   * `"top"` (the default) pins `index`'s own top to the viewport's top — P2b-1a's facet-jump, and
   * every existing caller of this seam before #1324. `"full"` is `TimelinePanel`'s own submit-scroll
   * (UXR-Q2, #1324): reveal the entire item when it fits the viewport, falling back to `"top"` once
   * the item is itself taller than the viewport. `"top-with-clearance"` is J9's run-card reveal;
   * `"bottom-with-clearance"` is 4g's submitted-turn landing. Both add edge space when the browser
   * would otherwise clamp the request. See `virtualization.ts` for the arithmetic.
   */
  reveal?: "top" | "full" | "top-with-clearance" | "bottom-with-clearance";
  /** Required visual space above a `top-with-clearance` target. */
  topClearance?: number;
  /** Required visual space below a `bottom-with-clearance` target. */
  bottomClearance?: number;
}

export interface VirtualListProps<T> {
  items: T[];
  /** Stable React key per item. */
  itemKey: (item: T) => string;
  /** The height in pixels to assume for a row this list has **not measured yet** — a single number,
   * or a pure per-item function (P2b-1b's collapse composition: a collapsed card's single-line
   * height differs from its expanded one, and both are knowable ahead of render from the card's own
   * data — `collapse.ts`'s `itemHeightFor`). It is an estimate, not a contract: once a row has been
   * mounted, its own rendered height is what positions it and everything after it (#1119). */
  estimatedItemHeight: number | ((item: T) => number);
  /** Extra rows mounted beyond the viewport on each side. */
  overscan?: number;
  renderItem: (item: T) => ReactNode;
  className?: string;
  /** When set, imperatively scrolls `index` into view — the seam P2b-1a's facet-jump uses to
   * bring the most recent card of a facet's kind into the mounted window (UX §4 "Timeline at
   * scale") without the caller reimplementing windowing math. */
  scrollRequest?: VirtualListScrollRequest;
  /** Identity of a passive in-place content change whose measured growth must preserve the exact
   * scroll position instead of using ordinary tail-follow. #2429 supplies the permission FIFO. */
  preserveScrollKey?: string;
}

const DEFAULT_OVERSCAN = 3;

/** Slack (px) `atTailRef` tolerates between `scrollTop` and the container's actual max scroll before
 * treating the reader as "not at the tail". Cumulative offsets over per-row heights can land a
 * sub-pixel off `totalHeight - containerHeight` — the more so now that those heights are fractional
 * measurements of what each row rendered rather than whole-pixel constants (#1119). */
const TAIL_EPSILON = 1;

/**
 * One mounted row. Two things make it the unit #1119 turns on:
 *
 * - It is an ordinary **content-sized** block. A row used to be a box clamped to the caller's
 *   constant, so any card that rendered taller than the constant overflowed it and painted over its
 *   neighbour — a chat message that wrapped, a run card with several activity lines. Nothing is
 *   clamped here, so that overlap cannot occur regardless of what the card renders, and it holds
 *   from the very first paint rather than once a measurement catches up.
 * - It reports its own rendered height back to the list. `display: flow-root` is what makes that
 *   number the row's whole flow contribution: without it the card's own vertical margins collapse
 *   straight through this wrapper and out of the measurement, so every spacer standing in for an
 *   unmounted row would come up short by exactly those margins and the mounted window would drift
 *   away from the scroll position it was computed for.
 */
function MeasuredRow({
  rowKey,
  onMeasure,
  children,
}: {
  rowKey: string;
  onMeasure: (rowKey: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const report = useCallback(() => {
    if (ref.current) onMeasure(rowKey, ref.current.getBoundingClientRect().height);
  }, [rowKey, onMeasure]);

  // Read on every commit, before paint — the same "re-measure on every commit, it is one property
  // read and `onMeasure` ignores an unchanged value" discipline the container's own measurement
  // uses below, and what makes a height change that *does* come with a render (a collapse toggle,
  // an activity line appended to a live run) land in the same frame the user sees it.
  useLayoutEffect(report);

  // A row can also change height with no re-render of this list at all: the window resizing and
  // rewrapping the card's text, a web font finishing loading, an image resolving. `ResizeObserver`
  // is the only thing that observes those; where it does not exist (jsdom) the commit-time reading
  // above is still the whole contract, just not a live one.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [report]);

  return (
    <div ref={ref} data-row-key={rowKey} style={{ display: "flow-root" }}>
      {children}
    </div>
  );
}

/**
 * Renders `items[startIndex, endIndex)` inside a scrollable `div`, padded above/below with spacer
 * elements sized to stand in for the un-mounted rows — so the scrollbar always reflects the full
 * list length even though only a small window is in the DOM. An `items` append moves `scrollTop`
 * for a reader at the tail, or for an active 4g submitted-turn landing whose owner is still being
 * measured. A reader who scrolls away is never carried, matching UX Principle 2.
 */
export function VirtualList<T>({
  items,
  itemKey,
  estimatedItemHeight,
  overscan = DEFAULT_OVERSCAN,
  renderItem,
  className,
  scrollRequest,
  preserveScrollKey,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const preservedScrollTop = useRef<number | null>(null);
  // What each row actually rendered at, by `itemKey` — the list's memory of the *stream*, not of
  // the DOM currently in it: a measurement deliberately outlives the row leaving the mounted window,
  // or scrolling back over content the reader has already seen would re-derive different offsets
  // for it every time. One number per card the reader has reached, so it is bounded by the stream.
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  // Identity of the `scrollRequest` this effect has already applied a jump for. Each request is
  // applied exactly once, and only a fresh `scrollRequest` object (identity, not value) earns
  // another jump — so `containerHeight`/`items.length` changing for an unrelated reason afterwards,
  // e.g. a background history rehydrate, a window resize, or a new card arriving under a different
  // facet, never re-scrolls the user: exactly the scroll-stealing UX Principle 2 forbids.
  const appliedScrollRequest = useRef<VirtualListScrollRequest | undefined>(undefined);
  // A just-submitted run can gain status text after its first measurement. Keep its explicit 4g
  // landing through that growth, but stop at the first reader scroll (UXR-Q2).
  const bottomReveal = useRef<{
    request: VirtualListScrollRequest;
    target: number;
    readerMoved: boolean;
  } | null>(null);

  // One height per item, in stream order: what the row was measured at if this list has ever had it
  // mounted, and the caller's estimate until then (P2b-1b's per-item estimate is itself computed
  // fresh each render — a card's collapse state is view state the caller owns, not something this
  // list caches). Every row of arithmetic below reduces to this array, so a measurement corrects
  // the spacers, the scrollbar, the mounted window and a facet-jump's target in one place (#1119).
  //
  // Building it is O(items), so it is memoized on the four things that can change it — never on
  // `scrollTop`. Scrolling a 5,000-card stream must stay bounded by the viewport (test-plan §6's
  // virtualization budget), and rebuilding every offset on every scroll event is precisely the
  // O(stream) scroll path that budget exists to forbid.
  const offsets = useMemo(() => {
    const estimateOf =
      typeof estimatedItemHeight === "function" ? estimatedItemHeight : () => estimatedItemHeight;
    return cumulativeOffsets(items.map((item) => measuredHeights[itemKey(item)] ?? estimateOf(item)));
  }, [items, measuredHeights, estimatedItemHeight, itemKey]);
  // `offsets[i]` is the top of row `i` — the one calculation the spacers, the scrollbar's extent
  // and a facet-jump's scroll target all reduce to.
  const totalHeight = offsets[offsets.length - 1];
  const requestedLayout = useMemo(() => {
    if (!scrollRequest || (scrollRequest.reveal !== "top-with-clearance"
      && scrollRequest.reveal !== "bottom-with-clearance")) {
      return { scrollTop: 0, leadingInset: 0, trailingInset: 0 };
    }
    return scrollLayoutForReveal({
      offsets,
      index: scrollRequest.index,
      containerHeight,
      reveal: scrollRequest.reveal,
      topClearance: scrollRequest.topClearance,
      bottomClearance: scrollRequest.bottomClearance,
    });
  }, [scrollRequest, offsets, containerHeight]);
  const layoutOffsets = useMemo(
    () => offsets.map((offset) => offset + requestedLayout.leadingInset),
    [offsets, requestedLayout.leadingInset],
  );

  // A zero reading is never recorded: it means "this has no layout" (jsdom, a `display: none`
  // ancestor, a row measured while detached), not "this row is 0px tall" — and recording it would
  // stack the whole stream at offset 0, every row on top of every other row. The estimate is a far
  // better answer for a row whose real height is not knowable yet. Stable identity: it is reached
  // through each mounted row's own effects, and a fresh one every render would rebuild every
  // `ResizeObserver` on every commit.
  const handleRowMeasured = useCallback((rowKey: string, height: number) => {
    if (!(height > 0)) return;
    setMeasuredHeights((prev) => (prev[rowKey] === height ? prev : { ...prev, [rowKey]: height }));
  }, []);

  const [preserveScrollRevision, setPreserveScrollRevision] = useState(0);
  const scheduledPreserveScrollRevision = useRef(0);
  const preserveScrollKeyMounted = useRef(false);

  // Measure on every commit and through ResizeObserver. A parent/sibling layout settling can resize
  // this flex child without rendering `VirtualList`; commit-only measurement would then leave its
  // viewport arithmetic stale indefinitely. Equal readings never trigger a render.
  const measureContainer = useCallback(() => {
    const measured = containerRef.current?.clientHeight ?? 0;
    setContainerHeight((prev) => (prev === measured ? prev : measured));
  }, []);

  // A changed key means content inside an existing row may be measured at a new height. React runs
  // this cleanup before the new layout effects, so it snapshots the reader's position before that
  // measurement can trigger ordinary tail-follow. The revision schedules one follow-up commit
  // after every mounted row has had its layout-effect measurement opportunity. The tail effect can
  // then distinguish real in-place growth from a filtered-out permission update that changed no
  // visible row, and clear the latter before an unrelated append arrives.
  useLayoutEffect(() => {
    if (preserveScrollKeyMounted.current) {
      const revision = scheduledPreserveScrollRevision.current + 1;
      scheduledPreserveScrollRevision.current = revision;
      setPreserveScrollRevision(revision);
    } else {
      preserveScrollKeyMounted.current = true;
    }
    return () => {
      preservedScrollTop.current = containerRef.current?.scrollTop ?? null;
    };
  }, [preserveScrollKey]);

  useLayoutEffect(measureContainer);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureContainer);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureContainer]);

  // Facet-jump (P2b-1a): honor an imperative scroll request by driving the same `scrollTop` state
  // a real user scroll would, so it flows through the identical windowing math below — and mirror
  // it onto the DOM node so a subsequent real scroll continues from the right place. Clamped to the
  // container's actual max scroll (`totalHeight - containerHeight`), the same bound a real
  // `scrollTop` assignment gets from the browser — jumping to the last row must not request more
  // scroll than the content has, which would otherwise leave the React state and the (browser-
  // clamped) DOM value disagreeing and the windowing math mounting a window short of what the
  // viewport actually shows (review finding, PR #392).
  useEffect(() => {
    if (!scrollRequest || appliedScrollRequest.current === scrollRequest) return;
    // Wait for a real measurement before applying: at `containerHeight === 0` the clamp below
    // degenerates to `totalHeight` — i.e. no clamp at all — so a request that arrives before
    // the container's first layout measurement (any consumer passing `scrollRequest` at mount;
    // `TimelinePanel` only sets one on a click, by which time the measurement has landed) would
    // otherwise reintroduce the unclamped target this effect exists to prevent. Deferring rather
    // than applying is what keeps `containerHeight` a live dependency instead of an inert one.
    if (containerHeight === 0) return;
    appliedScrollRequest.current = scrollRequest;
    const target = scrollTargetForReveal({
      offsets,
      index: scrollRequest.index,
      containerHeight,
      reveal: scrollRequest.reveal ?? "top",
      topClearance: scrollRequest.topClearance,
      bottomClearance: scrollRequest.bottomClearance,
    });
    bottomReveal.current = scrollRequest.reveal === "bottom-with-clearance"
      ? { request: scrollRequest, target, readerMoved: false }
      : null;
    setScrollTop(target);
    if (containerRef.current) containerRef.current.scrollTop = target;
    // `offsets`/`totalHeight` are recomputed every render (not stable references), so this effect
    // re-fires on every commit while a request is pending application — harmless: the guard above
    // (`appliedScrollRequest.current === scrollRequest`) makes every re-fire after the first a
    // no-op, exactly as it already did for `itemHeight`/`items.length` before rows were measured.
  }, [scrollRequest, offsets, totalHeight, containerHeight]);

  // Identity of the measured-height-sensitive request the correction effect below has corrected —
  // that effect's own "already corrected once" guard (declared here, ahead of it, purely so the
  // ref exists before it is read).
  const measuredRevealRef = useRef<VirtualListScrollRequest | undefined>(undefined);

  // Tail-follow (P2b-1c, UXR-Q2 — ux-design §4 "Scroll motion"): "motion the user did not ask for
  // never moves them ... a reader still at the tail **is** followed there; sitting at the tail is
  // itself a standing choice to watch what arrives." `atTailRef` is that standing choice. The effect
  // below only ever re-reads on a *real scroll* — the one event that actually expresses a change of
  // that choice. Everything else that moves the arithmetic is deliberately excluded, in both
  // directions: an append growing `totalHeight` must not retroactively relabel where the reader left
  // the scrollbar, and a container *shrinking* (the `N new in <Facet> →` affordance appearing below
  // this list, or a window resize) grows `maxScrollTop` under a reader who never moved — re-reading
  // there would silently revoke tail-follow until their next manual scroll (review finding, PR #504
  // round 2). `containerHeight` is still a dependency for exactly one reason: at mount it is 0 (the
  // measuring `useLayoutEffect` above hasn't landed yet), which degenerates `maxScrollTop` to
  // `totalHeight` and would conclude `atTailRef = false` for any non-empty `items`, never correcting
  // itself until the reader's first real scroll (review finding, PR #504 round 1). So the reading is
  // taken once, on the 0 → measured transition, and from then on `scrollTop` alone drives it.
  const atTailRef = useRef(true);
  // A tail-follow write can share a render with the row measurement that immediately supersedes
  // it. Until React observes the target we wrote, its older `scrollTop` state is not a user scroll
  // and must not revoke the reader's standing tail choice.
  const pendingTailFollowRef = useRef<number | null>(null);
  // The `scrollTop` this effect last took a reading at — `null` until the container's first real
  // measurement, which is what makes that first measurement re-read (any number differs from `null`)
  // without needing a separate "have we measured yet" flag.
  const lastReadScrollTopRef = useRef<number | null>(null);
  useEffect(() => {
    if (containerHeight === 0) return; // no real measurement yet — leave the safe mount default.
    // A resize alone never relabels a standing choice, so an unchanged `scrollTop` stops here. A
    // genuine scroll landing in the same commit as a resize still re-reads, though — otherwise a
    // reader who scrolled *away* stays labelled at-tail and gets yanked by the next append:
    // scroll-stealing, the direction UX Principle 2 actually forbids.
    if (scrollTop === lastReadScrollTopRef.current) return;
    if (pendingTailFollowRef.current !== null) {
      if (Math.abs(scrollTop - pendingTailFollowRef.current) <= TAIL_EPSILON) {
        pendingTailFollowRef.current = null;
        lastReadScrollTopRef.current = scrollTop;
      }
      return;
    }
    lastReadScrollTopRef.current = scrollTop;
    const maxScrollTop = Math.max(0, totalHeight - containerHeight);
    atTailRef.current = scrollTop >= maxScrollTop - TAIL_EPSILON;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `totalHeight` deliberately omitted: an
    // append growing it must not retrigger this on its own (only a real scroll, or the container's
    // first measurement, should); `totalHeight` is still read fresh whenever it does re-run.
  }, [scrollTop, containerHeight]);

  // The item count, the total content height and the `scrollRequest` identity as of the last commit
  // — together they tell this effect apart from every other reason `items` can change shape.
  //
  // What tail-follow follows is **the content growing**, not the item count growing (#1119). Once
  // rows are measured the two come apart, and gating on the count alone loses the reader: an
  // appended card has never been mounted, so the commit that grows `items.length` can only lay it
  // out at its *estimate*, and the real height arrives a commit later — by which time the count is
  // unchanged and a count-gated follow has already fired for the last time, stranding the reader
  // short by however much the card exceeded its estimate. Height growth with no count change is
  // also a first-class event in its own right, which a count-gated follow could never see at all: a
  // live run card gaining an activity line, a rewrap, a font landing (review finding, PR #1318).
  // A shrinking container is the same moving-tail geometry with no reader scroll. Observe and
  // follow it only while the standing choice is still tail; this covers a parent layout settling
  // after an arrival without granting any motion to a reader who deliberately scrolled away.
  //
  // A list that *lost* items is never followed, whatever happened to its height — tail-follow only
  // ever follows forward, and never chases a shrinking list back to its new end. Losing items also
  // *revokes the standing choice itself* rather than merely skipping the one commit: the reader's
  // "I am at the tail" was a choice about the stream that just went away, and the replacement's own
  // cards have never been mounted either, so their real heights land a commit later — an unchanged
  // count over a grown total, indistinguishable from the append case below. A facet switch to fewer
  // but taller cards would otherwise scroll the reader to the tail of a stream they had only just
  // arrived in. The choice re-establishes itself on their next real scroll, which includes the
  // browser's own clamp when the shorter content pulls `scrollTop` back.
  //
  // `requestChanged` defers to the dedicated `scrollRequest` effect above whenever the very same
  // commit also carries an explicit "the user asked for this" jump (a facet-jump, or
  // `TimelinePanel`'s own submit-scroll reusing that seam) — an unconditional, atTail-independent
  // jump that would otherwise race this one for the same `scrollTop` state.
  const prevItemCountRef = useRef(items.length);
  const prevTotalHeightRef = useRef(totalHeight);
  const prevContainerHeightRef = useRef(containerHeight);
  const prevScrollRequestRef = useRef(scrollRequest);
  useEffect(() => {
    const shrank = items.length < prevItemCountRef.current;
    const grew =
      items.length > prevItemCountRef.current || totalHeight > prevTotalHeightRef.current;
    const containerShrank =
      containerHeight > 0 &&
      prevContainerHeightRef.current > 0 &&
      containerHeight < prevContainerHeightRef.current;
    const requestChanged = scrollRequest !== prevScrollRequestRef.current;
    prevItemCountRef.current = items.length;
    prevTotalHeightRef.current = totalHeight;
    prevContainerHeightRef.current = containerHeight;
    prevScrollRequestRef.current = scrollRequest;
    if (shrank) atTailRef.current = false;
    // The key-change commit precedes the follow-up measurement commit scheduled above. Keep the
    // snapshot through that first pass; consuming it there would miss a row-height update whose
    // layout effect has queued, but not yet committed, its measured height.
    if (
      preservedScrollTop.current !== null &&
      preserveScrollRevision !== scheduledPreserveScrollRevision.current
    ) return;
    if (preservedScrollTop.current !== null) {
      if (grew || containerShrank) {
        const target = preservedScrollTop.current;
        preservedScrollTop.current = null;
        atTailRef.current = false;
        pendingTailFollowRef.current = null;
        lastReadScrollTopRef.current = target;
        setScrollTop(target);
        if (containerRef.current) containerRef.current.scrollTop = target;
        return;
      }
      // A key change whose rendered measurement did not move needs no correction and must not
      // suppress a later unrelated append.
      preservedScrollTop.current = null;
    }
    if ((!grew && !containerShrank) || requestChanged || !atTailRef.current
      || (bottomReveal.current !== null && bottomReveal.current.request === scrollRequest
        && !bottomReveal.current.readerMoved)) return;
    // A pending, not-yet-measured-corrected `reveal: "full"` request (#1324) needs no stand-down
    // here: this effect is declared *before* the correction effect below, so on the commit both
    // would fire, this one's pin (computed off the target's still-provisional estimate) always runs
    // first and the correction effect's own — always freshly recomputed from that same commit's
    // `offsets`, never from whatever this effect just wrote — runs immediately after and overwrites
    // it, both by state and by the direct `containerRef.current.scrollTop` write React effects apply
    // in declaration order for. Verified by mutation (review, PR #1802 round 1): forcing this branch
    // permanently `false` (i.e. never standing down) left the whole suite green, including the
    // `reveal: "full"` regression tests below, because no reachable case lets this effect's pin be
    // the *last* write for a `reveal: "full"` request — the correction effect either hasn't applied
    // yet (guarded on `appliedScrollRequest`, so it can't run before this one has) or runs straight
    // after it in the same commit.
    // Read the live measurement rather than `containerHeight` state: when a container re-measure
    // and this append land in the same commit, the measuring `useLayoutEffect` above hasn't flushed
    // yet, so the state is still the pre-resize value — targeting off it strands the reader short of
    // the true new tail and then permanently revokes tail-follow, since nothing else ever re-fires
    // this effect to correct it (review finding, PR #504 round 3).
    const liveHeight = containerRef.current?.clientHeight ?? containerHeight;
    // Same "wait for a real measurement" reasoning as the `scrollRequest` effect above: at
    // `liveHeight === 0` the target degenerates to `totalHeight` — no clamp at all.
    if (liveHeight === 0) return;
    const maxScrollTop = Math.max(0, totalHeight - liveHeight);
    // Record this pin as the reading the effect above would have taken. That effect re-reads on any
    // `scrollTop` change because a change means "a real scroll", the one event expressing a change
    // of the reader's standing choice — but this write is *ours*, not the reader's, and once rows
    // are measured it no longer lands on the final tail: an appended card is pinned to at its
    // estimate, and the measurement a commit later grows the content underneath the pin. The re-read
    // would then pair our own already-applied `scrollTop` with the grown `totalHeight`, conclude the
    // reader is short of the tail, and silently revoke tail-follow for the rest of the session —
    // right before the growth this effect exists to follow (review finding, PR #1318 round 1).
    pendingTailFollowRef.current = maxScrollTop;
    lastReadScrollTopRef.current = maxScrollTop;
    setScrollTop(maxScrollTop);
    if (containerRef.current) containerRef.current.scrollTop = maxScrollTop;
  }, [
    items.length,
    totalHeight,
    containerHeight,
    scrollRequest,
    preserveScrollKey,
    preserveScrollRevision,
  ]);

  // Measured reveal correction (UXR-Q2/J9): a target card has typically
  // never been mounted when the facet-jump effect above first applies, so that first pass can only
  // judge "does the card fit the viewport" off its *estimate* — a uniform per-kind guess, not what a
  // message that wraps several lines actually renders at. Once the card mounts (the jump above is
  // what carries it into the mounted window in the first place) and reports its real height, this
  // corrects the very same jump exactly once more against now-accurate numbers — never a second,
  // independent decision, and never for a plain `"top"` request. Declared *after* the tail-follow
  // "grew" effect above, so a
  // same-commit re-measurement of the target card cannot race it: effects fire in declaration
  // order, so the "grew" effect's own pin (if it fires at all in that commit — it needs `grew`,
  // which a re-measurement-only commit with no item-count/height-total change may not satisfy) is
  // always the earlier write, and this call — freshly computed from this same commit's `offsets`,
  // never from whatever the effect above just wrote — is always the one that determines `scrollTop`
  // for the render that follows. `measuredRevealRef` bounds *this* effect to one application per
  // request (see the `#1324: does not re-scroll once corrected` test); it plays no part in the race.
  useEffect(() => {
    if (
      !scrollRequest ||
      (scrollRequest.reveal !== "full" && scrollRequest.reveal !== "top-with-clearance"
        && scrollRequest.reveal !== "bottom-with-clearance")
    ) return;
    if (appliedScrollRequest.current !== scrollRequest) return; // not applied (even provisionally) yet
    if (scrollRequest.reveal === "bottom-with-clearance") {
      if (bottomReveal.current?.readerMoved) return;
    } else if (measuredRevealRef.current === scrollRequest) return; // apply-once (#392/#504)
    if (containerHeight === 0) return;
    const item = items[scrollRequest.index];
    if (!item) return;
    if (!(itemKey(item) in measuredHeights)) return; // still just the estimate
    if (scrollRequest.reveal !== "bottom-with-clearance") measuredRevealRef.current = scrollRequest;
    const target = scrollTargetForReveal({
      offsets,
      index: scrollRequest.index,
      containerHeight,
      reveal: scrollRequest.reveal,
      topClearance: scrollRequest.topClearance,
      bottomClearance: scrollRequest.bottomClearance,
    });
    if (scrollRequest.reveal === "bottom-with-clearance" && bottomReveal.current) {
      if (bottomReveal.current.target === target) return;
      bottomReveal.current.target = target;
    }
    setScrollTop(target);
    if (containerRef.current) containerRef.current.scrollTop = target;
  }, [scrollRequest, items, itemKey, measuredHeights, offsets, containerHeight]);

  const { startIndex, endIndex } = computeVisibleRangeFromOffsets({
    offsets: layoutOffsets,
    containerHeight,
    scrollTop,
    overscan,
  });

  const visibleItems = items.slice(startIndex, endIndex);
  const topSpacerHeight = layoutOffsets[startIndex];
  const bottomSpacerHeight = Math.max(
    0,
    totalHeight - offsets[endIndex] + requestedLayout.trailingInset,
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (bottomReveal.current && Math.abs(nextScrollTop - bottomReveal.current.target) > TAIL_EPSILON) {
      bottomReveal.current.readerMoved = true;
    }
    if (
      pendingTailFollowRef.current !== null &&
      Math.abs(nextScrollTop - pendingTailFollowRef.current) > TAIL_EPSILON
    ) {
      pendingTailFollowRef.current = null;
    }
    setScrollTop(nextScrollTop);
  };

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="virtual-list"
      onScroll={handleScroll}
      // `scrollbarGutter: stable` reserves the scrollbar's lane whether or not it is showing, which
      // breaks a feedback loop that only exists once rows are *measured* (#1119): a classic
      // `overflow-y: auto` container gains its scrollbar exactly when content outgrows the viewport,
      // that narrows every row, narrower rows wrap to *taller* ones — and a stream sitting within a
      // few pixels of the viewport height can then cross the threshold back and forth, each crossing
      // a new measurement, each measurement a re-render. Constant heights could never feed back this
      // way. Reserving the lane makes row width independent of content height, so the loop has no
      // edge to run round. (Ignored where unsupported, which is only ever the old behaviour back.)
      style={{ overflowY: "auto", height: "100%", scrollbarGutter: "stable" }}
    >
      <div aria-hidden="true" style={{ height: topSpacerHeight }} />
      {visibleItems.map((item) => {
        const key = itemKey(item);
        return (
          <MeasuredRow key={key} rowKey={key} onMeasure={handleRowMeasured}>
            {renderItem(item)}
          </MeasuredRow>
        );
      })}
      <div aria-hidden="true" style={{ height: bottomSpacerHeight }} />
    </div>
  );
}
