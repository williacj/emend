// @vitest-environment jsdom
// ABOUTME: Perf benchmark for structuralDecorationsPlugin's viewport scoping (test-plan §6, TD-13/
// ABOUTME: SPIKE-3, #216) — a tracked benchmark, never a shared-CI gate. Run via `npm run test:perf`
// ABOUTME: on a dedicated/consistent machine (test-plan §6); excluded from `npm test`'s vitest.config.ts.
// ABOUTME: `mount` forces a full synchronous parse before measuring (PR #287 review finding) — see
// ABOUTME: its docblock for why an unforced tree makes this benchmark non-discriminating in jsdom.
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  frontmatterFoldExtensions,
  structuralMarkdownExtensions,
} from "../../src/editor/structuralDecorations";
import { viewModeField } from "../../src/editor/viewMode";
import { buildLargeMarkdownDoc } from "./fixtures/largeMarkdownDoc";
import { percentile } from "./percentile";

/** How long `forceParsing` is allowed to spend driving Lezer's parser to completion at mount — a
 * one-time cost excluded from the keystroke-path measurement below (same bucket as the "mount
 * cost" warm-up already excluded), generous enough for the ~1MB fixture's full parse. */
const FORCE_PARSE_TIMEOUT_MS = 20_000;

/**
 * test-plan §6's own policy: budgets are *tracked benchmarks on a dedicated/consistent runner* with
 * *relative* regression thresholds, not wall-clock PR gates — "only gross regressions (>2× baseline)
 * hard-fail." `FR_X_4_TARGET_MS` is that literal baseline (test-plan §6's keystroke-latency target,
 * itself SPIKE-3's measured number, <6.2ms in SPIKE-3's own run); `GROSS_REGRESSION_MS` is the actual
 * hard-fail line below, generous enough to absorb hardware/headless-environment variance without
 * becoming a source of institutionalized flakiness (test-plan §6's own warning against wall-clock
 * assertions on shared runners) while still catching a real regression — e.g. reverting to a
 * whole-document walk — by a wide margin. The raw p95 is logged either way so a human reviewing a
 * benchmark run can eyeball it against the tighter target.
 */
const FR_X_4_TARGET_MS = 16; // test-plan §6: "Keystroke latency under full decorations: p95 < 16ms."
const GROSS_REGRESSION_MS = FR_X_4_TARGET_MS * 2;

/**
 * test-plan §6's other editor budget: "Open + render 1MB doc with 500 markup regions: < target ms,
 * no frame over 100ms" (FR-X-4) — SPIKE-3's own measured basis for this exact fixture size (1MB doc
 * + 500 regions renders in 13–34ms, tech-design.md SPIKE-3 log). The assertion below is the *median*
 * of seven independent mounts, matching the keystroke budget's percentile approach rather than a
 * worst-case bound: a lone GC/scheduler hiccup on an otherwise-idle mount produced a one-off ~3x
 * outlier in local runs (worst has crossed 100ms even while the median stayed rock-stable at
 * 6-9ms), which is exactly the wall-clock-absolute flakiness test-plan §6 warns against asserting
 * on. `worst` is still computed and logged alongside the median so a human reviewing a run can see
 * that outlier, but it is deliberately not asserted — see the A6 note below for why "no frame over
 * 100ms" specifically cannot be measured, asserted or not, in this harness.
 *
 * `OPEN_RENDER_TARGET_MS` is the literal 100ms target from test-plan §6; `OPEN_RENDER_GROSS_
 * REGRESSION_MS` is the actual hard-fail line (test-plan §6: "only gross regressions (>2×
 * baseline) hard-fail"), generous enough over SPIKE-3's own 13-34ms figure to absorb this rig's
 * jsdom environment (no native layout, unlike SPIKE-3's real-browser prototype) without becoming a
 * source of institutionalized flakiness.
 *
 * A6 (unexecutable surface): §6's "no frame over 100ms" half of this budget is a per-*frame* cap,
 * and jsdom runs no layout and no frame scheduler — the initial `EditorView` mount is one
 * synchronous block with no frames to decompose into. What this test measures is a whole-mount
 * wall-clock proxy for that budget, not the frame-level guarantee itself; that guarantee is neither
 * measured nor assertable here by construction, only inferable by comparison to SPIKE-3's real-
 * browser figures (13-34ms), which this suite cannot reproduce.
 */
const OPEN_RENDER_TARGET_MS = 100; // test-plan §6: "no frame over 100ms."
const OPEN_RENDER_GROSS_REGRESSION_MS = OPEN_RENDER_TARGET_MS * 2;

/**
 * Mounts `doc` and drives Lezer's parser to completion before returning (review finding on #216's
 * first pass, PR #287: without this, `syntaxTree(state)` stays whatever Lezer's *synchronous*
 * initial-parse budget covers — a few KB — regardless of `doc`'s actual length, because the
 * background parse worker that would finish the rest never runs inside a synchronous vitest test.
 * A whole-document walk over that truncated tree is cheap no matter how large `doc` is, which is
 * exactly why the benchmark passed unchanged against #153's pre-migration `StateField` (whole-doc
 * walk) as well as this PR's viewport-scoped `ViewPlugin` — it wasn't measuring "walks the whole
 * doc" vs. "walks only the viewport," it was measuring two reads of the same ~4KB tree. Forcing the
 * full parse here makes the fixture's actual size reach the code under test; `view.viewport`/
 * `view.visibleRanges` are untouched by this (jsdom's zero-height layout bounds them to a small
 * span regardless), which is what still lets the viewport-scoped plugin's cost stay flat below.
 */
function mount(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [...structuralMarkdownExtensions(), viewModeField] }),
    parent: document.createElement("div"),
  });
  const parsed = forceParsing(view, doc.length, FORCE_PARSE_TIMEOUT_MS);
  if (!parsed || syntaxTree(view.state).length < doc.length) {
    view.destroy();
    throw new Error(
      `forceParsing did not reach the end of a ${doc.length}-char document within ${FORCE_PARSE_TIMEOUT_MS}ms — ` +
        "the benchmark would silently measure a partially-parsed tree again; raise the timeout rather than " +
        "letting this pass quietly.",
    );
  }
  return view;
}

/** Types `count` single characters at `pos`, one dispatch per keystroke (the real editing path —
 * every dispatch runs `structuralDecorationsPlugin.update`), returning each dispatch's wall-clock
 * duration in milliseconds. */
function typeKeystrokes(view: EditorView, pos: number, count: number): number[] {
  const durations: number[] = [];
  let at = pos;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    view.dispatch({ changes: { from: at, to: at, insert: "x" }, userEvent: "input.type" });
    durations.push(performance.now() - start);
    at += 1;
  }
  return durations;
}

describe("editor/structuralDecorations — viewport-scoping perf benchmark (test-plan §6, TD-13/SPIKE-3)", () => {
  it("unclosed-frontmatter user-input latency does not scale with document line count", () => {
    const buildUnclosedFrontmatter = (lineCount: number): string =>
      `---\n${Array.from({ length: lineCount }, (_, index) => `key_${index}: value`).join("\n")}`;
    const measure = (doc: string): number => {
      let state = EditorState.create({
        doc,
        // This is the exact state/filter/fold sub-bundle whose three synchronous rescans caused the
        // regression. Lezer's separate unclosed-block parse cost is intentionally outside this
        // measurement; the viewport benchmarks below continue to exercise the complete bundle.
        extensions: [...frontmatterFoldExtensions(), viewModeField],
      });
      const durations: number[] = [];
      for (let index = 0; index < 30; index++) {
        const at = 4 + index;
        const start = performance.now();
        const tr = state.update({
          changes: { from: at, insert: "x" },
          userEvent: "input.type",
        });
        state = tr.state;
        durations.push(performance.now() - start);
      }
      return percentile(durations.slice(5), 95);
    };

    const smallDoc = buildUnclosedFrontmatter(1_000);
    const largeDoc = buildUnclosedFrontmatter(250_000);
    const smallP95 = measure(smallDoc);
    const largeP95 = measure(largeDoc);

    console.log(
      `[perf] unclosed-frontmatter state-update p95 — small (${smallDoc.length}b): ${smallP95.toFixed(2)}ms, ` +
        `large (${largeDoc.length}b/250k lines): ${largeP95.toFixed(2)}ms ` +
        `(test-plan §6 target ${FR_X_4_TARGET_MS}ms)`,
    );

    expect(largeP95).toBeLessThan(smallP95 * 10 + 5);
  });

  it("open + render (initial synchronous mount) of a 1MB/500-region document stays within the FR-X-4 gross-regression budget", () => {
    const doc = buildLargeMarkdownDoc({ targetBytes: 1_000_000, regionCount: 500 });

    // Deliberately *not* `mount()` here: `mount`'s `forceParsing` call drives Lezer's background
    // parser to completion synchronously, which is exactly what a real open never blocks on — CM6's
    // real initial render parses/paints only the visible viewport and finishes the rest across idle
    // time, which is what "no frame over 100ms" is actually a budget for (a per-frame cap on the
    // *initial* render, not on background work that was never on the frame path to begin with). This
    // benchmark measures that same initial-render cost: constructing the `EditorView`, unforced.
    //
    // Seven independent mounts (fresh `EditorView`, destroyed between). Measured on this rig's own
    // machine (see the PR this test landed with for the recorded hardware): an isolated single-mount
    // "worst of N" is exactly the wall-clock-absolute flakiness test-plan §6 warns against — a lone
    // GC/scheduler hiccup on an otherwise-idle mount produced a one-off ~3x outlier in local runs,
    // over a machine plainly idle the rest of the time. The median is this rig's stable, repeatable
    // reading; the max is still logged alongside it so a human reviewing a run can see the same
    // outlier the reasoning above describes, without it being the one number gating the benchmark.
    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const view = new EditorView({
        state: EditorState.create({ doc, extensions: [...structuralMarkdownExtensions(), viewModeField] }),
        parent: document.createElement("div"),
      });
      durations.push(performance.now() - start);
      view.destroy();
    }
    const median = percentile(durations, 50);
    const worst = Math.max(...durations);

    console.log(
      `[perf] open+render (initial mount) of a 1MB/500-region doc — median of 7: ${median.toFixed(2)}ms, ` +
        `worst: ${worst.toFixed(2)}ms (test-plan §6 target ${OPEN_RENDER_TARGET_MS}ms, ` +
        `gross-regression line ${OPEN_RENDER_GROSS_REGRESSION_MS}ms)`,
    );
    expect(median).toBeLessThan(OPEN_RENDER_GROSS_REGRESSION_MS);
  });

  it("keystroke-path latency on a ~1MB/500-region document stays within the FR-X-4 gross-regression budget", () => {
    const doc = buildLargeMarkdownDoc({ targetBytes: 1_000_000, regionCount: 500 });
    const view = mount(doc);
    try {
      // Warm-up: mount cost (first parse/build) is a separate concern (test-plan §6's "open + render"
      // budget) — excluded from the keystroke-path measurement below.
      typeKeystrokes(view, 0, 5);

      const durations = typeKeystrokes(view, 0, 100);
      const p95 = percentile(durations, 95);

      console.log(
        `[perf] keystroke p95 over a 1MB/500-region doc: ${p95.toFixed(2)}ms ` +
          `(test-plan §6 target ${FR_X_4_TARGET_MS}ms, gross-regression line ${GROSS_REGRESSION_MS}ms)`,
      );
      expect(p95).toBeLessThan(GROSS_REGRESSION_MS);
    } finally {
      view.destroy();
    }
  });

  it("keystroke-path latency does not scale with document size (the viewport-scoping guarantee itself)", () => {
    // The real regression signal test-plan §6 calls for: relative, not absolute — hardware-
    // independent proof that rebuild cost is bounded by the viewport, not by document length. Both
    // fixtures are fully parsed by `mount`'s `forceParsing` call before any keystroke is measured, so
    // this genuinely exercises a full-size tree, not Lezer's few-KB synchronous-parse budget (see
    // `mount`'s docblock) — without that, a whole-document walk over the truncated tree would be
    // just as flat as the viewport-scoped one, and this assertion would pass for the wrong reason.
    //
    // The syntax-tree node count a whole-doc walk pays for tracks `regionCount`, not raw byte size:
    // `buildLargeMarkdownDoc`'s prose filler between constructs is one contiguous CommonMark
    // paragraph (no blank line inside it), so it parses down to a handful of large text-span leaves
    // regardless of how many bytes of filler it holds — `targetBytes` alone barely moves node count.
    // Measured directly (`syntaxTree(state).iterate` node count): a 10-region/20KB doc has ~50 nodes,
    // a 500-region/1MB doc (the SPIKE-3 basis, test 1 above) has ~2,500 — only 50x, and at that node
    // count a full walk costs a fraction of a millisecond, dwarfed by CodeMirror's own per-dispatch
    // overhead (state creation, position mapping, redraw scheduling) in this jsdom harness. That's
    // exactly why an *unforced*, *un-scaled* version of this test passed unchanged on both #153's
    // `StateField` and this PR's `ViewPlugin` (PR #287 review finding) — neither the truncated tree
    // nor a merely-50x-larger real one produced enough of a differential to clear dispatch noise.
    // 20,000 regions (~100,000 nodes, confirmed by the same direct node count) is where a whole-doc
    // walk's cost becomes large enough to dominate that overhead and actually show up on the
    // keystroke path — measured against #153's pre-migration `StateField` in a detached worktree
    // (`git worktree add --detach ... <pre-migration sha>`), this fixture pair's median keystroke
    // latency there is small ~0.8ms vs. large ~34ms (a ~41x ratio, and the large figure alone already
    // exceeds test 1's `GROSS_REGRESSION_MS`), while this PR's viewport-scoped `ViewPlugin` stays
    // small ~0.8ms vs. large ~4ms (a ~5x ratio, from CodeMirror's own sub-linear doc-length costs —
    // e.g. heightmap/position-mapping — not from walking more syntax nodes). If this layer ever
    // regresses to a whole-document walk, a much larger document's keystroke latency would scale up
    // with its region count while a small one's would not, and that ratio would blow out regardless
    // of what machine runs the suite.
    const smallDoc = buildLargeMarkdownDoc({ targetBytes: 20_000, regionCount: 10 });
    const largeDoc = buildLargeMarkdownDoc({ targetBytes: 4_000_000, regionCount: 20_000 });

    const smallView = mount(smallDoc);
    const largeView = mount(largeDoc);
    try {
      typeKeystrokes(smallView, 0, 5); // warm-up, excluded below
      typeKeystrokes(largeView, 0, 5);

      const smallMedian = percentile(typeKeystrokes(smallView, 0, 50), 50);
      const largeMedian = percentile(typeKeystrokes(largeView, 0, 50), 50);

      console.log(
        `[perf] keystroke median — small doc (${smallDoc.length}b, 10 regions): ${smallMedian.toFixed(2)}ms, ` +
          `large doc (${largeDoc.length}b, 20,000 regions, ~2000x): ${largeMedian.toFixed(2)}ms`,
      );

      // A generous ratio cap — not 1:1, sub-millisecond jsdom timings are genuinely noisy — that
      // would still catch an O(doc) regression: a whole-doc walk over 2000x more regions measured
      // ~41x slower above (comfortably over this line), while the viewport-scoped `ViewPlugin`
      // measured ~5x (comfortably under it — see the block comment above for both figures and how
      // they were obtained). The `+5` floor keeps the assertion meaningful when the small-doc median
      // itself rounds to ~0ms.
      expect(largeMedian).toBeLessThan(smallMedian * 10 + 5);
    } finally {
      smallView.destroy();
      largeView.destroy();
    }
  });
});
