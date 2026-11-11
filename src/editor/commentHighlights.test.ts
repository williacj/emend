// @vitest-environment jsdom
// ABOUTME: Comment-anchor highlight tests (P2b-4a, FR-CMT-1/FR-CMT-6, D17, P2) — the anchor→live-range
// ABOUTME: field (document-level/orphaned/out-of-range threads draw nothing; survivors follow edits),
// ABOUTME: the viewport-scoped decoration plugin (mirrors #216's NI-viewport-scoped-decorations,
// ABOUTME: including "never mutates the document across a rebuild", P1), and the click deep-link
// ABOUTME: (Principle 6) that must not steal focus from the editor caret (Principle 2).
import { EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anchor, CommentThread } from "../comments/types";
import { thread as openThread } from "../comments/threadFixture";
import { revealCommentThreadInEditor } from "./focusAnchor";
import { markdownLanguage } from "./markdownLanguage";
import {
  commentAnchors,
  commentHighlightExtensions,
  commentHighlightsPlugin,
  setCommentThreads,
  setDocumentRevision,
  setSelectedCommentThread,
  severityOf,
} from "./commentHighlights";

const HERE = dirname(fileURLToPath(import.meta.url));

/** This module's own source, read as text so the theme test below can pin a structural fact (no raw
 * hex literal) directly on the `commentHighlightTheme` object — matching `structuralDecorations.test.ts`'s
 * `APP_STYLESHEET` precedent of reading the real file rather than reconstructing its content. */
const MODULE_SOURCE = readFileSync(join(HERE, "commentHighlights.ts"), "utf8");

/** The shipped app stylesheet — read once and shared by every test below that needs to check a
 * `--color-comment-highlight-*` token's declared light/dark value, matching `structuralDecorations
 * .test.ts`'s identical `APP_STYLESHEET` precedent (including reading the file rather than the raw
 * import, since Vite would otherwise inline `?inline`/CSS-module semantics this suite doesn't want). */
const APP_STYLESHEET = readFileSync(join(HERE, "..", "styles.css"), "utf8");

/** The revision every fixture anchor is expressed against — `anchorOn` stamps it as `base_revision`,
 * so a seed carrying it is honestly current for the buffer the tests build. */
const REVISION = "rev-1";

/** A thread whose anchor covers `substr` in `doc` — the readable way to place an anchor without
 * hand-counting offsets (matches `structuralDecorations.test.ts`'s `rangeOf` convention). */
function anchorOn(doc: string, substr: string): Anchor {
  const offset = doc.indexOf(substr);
  if (offset < 0) throw new Error(`substring ${JSON.stringify(substr)} not found in fixture`);
  return {
    offset,
    length: substr.length,
    text_snapshot: substr,
    context_before: doc.slice(Math.max(0, offset - 16), offset),
    context_after: doc.slice(offset + substr.length, offset + substr.length + 16),
    base_revision: REVISION,
  };
}

/** A folded thread in its simplest (open, anchored) shape; `overrides` selects the other five
 * ux-design.md §2 states or drops the anchor for a document-level thread. */
function thread(id: string, anchor: Anchor | null, overrides: Partial<CommentThread> = {}): CommentThread {
  return openThread(id, { author: "cj", anchor, body: "a note", ...overrides });
}

/** The honest shape of a load: the buffer's revision declared alongside the threads read against
 * that same revision, in one transaction. */
function seedEffects(threads: CommentThread[]) {
  return [setDocumentRevision.of(REVISION), setCommentThreads.of({ threads, revision: REVISION })];
}

/** State with the highlight extensions installed and `threads` seeded in-revision. */
function stateWith(doc: string, threads: CommentThread[]): EditorState {
  const state = EditorState.create({ doc, extensions: commentHighlightExtensions() });
  return state.update({ effects: seedEffects(threads) }).state;
}

const DOC = "The quick brown fox jumps over the lazy dog.";

describe("editor/commentHighlights — anchors → live ranges (FR-CMT-1/FR-CMT-6, D17)", () => {
  it("J10 withdrawn projection removes the anchor highlight even when the placeholder keeps its route", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"), {
      withdrawn_at: 9,
      visible_when_withdrawn: true,
    })]);
    expect(commentAnchors(state)).toEqual([]);
  });
  it("gives an anchored thread a live range over its anchor", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    expect(commentAnchors(state)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + anchor.length },
    ]);
  });

  it("gives a document-level thread no range — it has no anchor to highlight", () => {
    const state = stateWith(DOC, [thread("doc-level", null)]);

    expect(commentAnchors(state)).toEqual([]);
  });

  it("gives an orphaned thread no range rather than a wrong one (D17/P2)", () => {
    // The orphan card (P2a-18) is the honest surface for a thread whose text moved out from under
    // it; drawing a highlight at its stale offset would be exactly the "wrong silent position" P2
    // forbids.
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { orphaned: true })]);

    expect(commentAnchors(state)).toEqual([]);
  });

  it("gives an anchor reaching past the end of the document no range", () => {
    const stale: Anchor = { ...anchorOn(DOC, "lazy dog"), offset: DOC.length - 2, length: 40 };
    const state = stateWith(DOC, [thread("t1", stale)]);

    expect(commentAnchors(state)).toEqual([]);
  });

  it("gives a zero-length anchor no range — there is no text to highlight", () => {
    const empty: Anchor = { ...anchorOn(DOC, "brown fox"), length: 0 };
    const state = stateWith(DOC, [thread("t1", empty)]);

    expect(commentAnchors(state)).toEqual([]);
  });

  it("carries each thread's derived ux-design §2 state for state colouring", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [
      thread("open", anchor),
      thread("pending", anchor, { pending_run: "run-7", pending_run_started: true }),
      thread("reopened", anchor, { reopened: true }),
      thread("resolved", anchor, { resolved: true }),
    ]);

    expect(commentAnchors(state).map((a) => a.state)).toEqual([
      "open",
      "working",
      "reopened",
      "resolved",
    ]);
  });

  it("keeps anchors in document order regardless of the order threads arrive in", () => {
    const state = stateWith(DOC, [
      thread("late", anchorOn(DOC, "lazy dog")),
      thread("early", anchorOn(DOC, "quick")),
    ]);

    expect(commentAnchors(state).map((a) => a.threadId)).toEqual(["early", "late"]);
  });
});

describe("editor/commentHighlights — anchors follow edits (FR-CMT-6, P1-4)", () => {
  it("shifts a highlight when text is inserted before it", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({ changes: { from: 0, insert: "Well, " } }).state;

    expect(commentAnchors(next)).toEqual([
      {
        threadId: "t1",
        state: "open",
        from: anchor.offset + "Well, ".length,
        to: anchor.offset + anchor.length + "Well, ".length,
      },
    ]);
  });

  it("leaves a highlight where it is when text is inserted after it", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({ changes: { from: DOC.length, insert: " Truly." } }).state;

    expect(commentAnchors(next)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + anchor.length },
    ]);
  });

  it("grows the highlight to absorb text typed strictly inside the anchor", () => {
    // The asymmetric counterpart to the edge rule below: text typed *within* the quote is part of
    // the quote (the anchored span still covers what the user selected, edited), so the mark grows.
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({ changes: { from: anchor.offset + "brown".length, insert: "-ish" } }).state;

    expect(commentAnchors(next)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + anchor.length + "-ish".length },
    ]);
  });

  it("does not swallow text typed at either edge of the anchor", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    // Typing right at the closing edge extends the sentence, not the anchored quote.
    const next = state.update({ changes: { from: anchor.offset + anchor.length, insert: "es" } }).state;

    expect(commentAnchors(next)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + anchor.length },
    ]);
  });

  it("drops the highlight when the anchored text is deleted outright", () => {
    // Nothing survives to highlight: no range beats a collapsed zero-width mark at the seam (P2).
    // The backend's own re-check (`fuzzy_reanchor`, D17) is what turns this thread into an orphan on
    // the next load; the editor simply stops drawing until then.
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({
      changes: { from: anchor.offset, to: anchor.offset + anchor.length, insert: "" },
    }).state;

    expect(commentAnchors(next)).toEqual([]);
  });

  it("shrinks the highlight to the surviving text when the anchor is partly deleted", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({
      changes: { from: anchor.offset, to: anchor.offset + "brown ".length, insert: "" },
    }).state;

    expect(commentAnchors(next)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + "fox".length },
    ]);
  });

  it("replaces the whole set when threads are re-seeded", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    const next = state.update({
      effects: setCommentThreads.of({
        threads: [thread("t2", anchorOn(DOC, "lazy dog"))],
        revision: REVISION,
      }),
    }).state;

    expect(commentAnchors(next).map((a) => a.threadId)).toEqual(["t2"]);
  });

  it("resolving a thread re-seeds its highlight with the new state rather than a stale one", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const next = state.update({
      effects: setCommentThreads.of({
        threads: [thread("t1", anchor, { resolved: true })],
        revision: REVISION,
      }),
    }).state;

    expect(commentAnchors(next).map((a) => a.state)).toEqual(["resolved"]);
  });
});

describe("editor/commentHighlights — a seed only lands on the revision it was read against (D17/P2)", () => {
  /** A bare state with the layer installed but nothing seeded and no revision declared. */
  function bare(doc: string): EditorState {
    return EditorState.create({ doc, extensions: commentHighlightExtensions() });
  }

  it("accepts a seed dispatched atomically with the revision it was read at", () => {
    // The honest shape of a load: the backend hands back text and threads read together, so both
    // facts reach the editor in one transaction.
    const anchor = anchorOn(DOC, "brown fox");
    const state = bare(DOC).update({
      effects: [
        setDocumentRevision.of(REVISION),
        setCommentThreads.of({ threads: [thread("t1", anchor)], revision: REVISION }),
      ],
    }).state;

    expect(commentAnchors(state).map((a) => a.threadId)).toEqual(["t1"]);
  });

  it("accepts a load that replaces the text and seeds against it in one transaction", () => {
    // The shape `setDocumentRevision`'s docblock actually prescribes, and the one #259's load path
    // will use: the new text, its revision, and the threads read against it all arrive together.
    // The offsets must be measured against `tr.newDoc` — the text this transaction *produces* —
    // not the empty buffer it replaces, which would put every anchor out of range and drop it.
    const loaded = "A different document entirely, with a quoted phrase inside it.";
    const anchor = anchorOn(loaded, "quoted phrase");

    const state = bare("").update({
      changes: { from: 0, insert: loaded },
      effects: [
        setDocumentRevision.of(REVISION),
        setCommentThreads.of({ threads: [thread("t1", anchor)], revision: REVISION }),
      ],
    }).state;

    expect(commentAnchors(state)).toEqual([
      { threadId: "t1", state: "open", from: anchor.offset, to: anchor.offset + anchor.length },
    ]);
  });

  it("drops a seed whose revision is not the one the buffer holds", () => {
    // The offsets in that list were computed against different text; drawing them here would be
    // exactly the confidently-wrong position P2 forbids and D17's orphan flow exists to avoid.
    const state = bare(DOC).update({ effects: setDocumentRevision.of(REVISION) }).state;

    const next = state.update({
      effects: setCommentThreads.of({
        threads: [thread("t1", anchorOn(DOC, "brown fox"))],
        revision: "rev-from-another-document-state",
      }),
    }).state;

    expect(commentAnchors(next)).toEqual([]);
  });

  it("drops a seed when the buffer's revision was never declared", () => {
    // Unknown is not "probably fine": with nothing to check the offsets against, the only honest
    // move is to draw nothing. A missing highlight is visible and cheap; a wrong one is neither.
    const next = bare(DOC).update({
      effects: setCommentThreads.of({ threads: [thread("t1", anchorOn(DOC, "brown fox"))], revision: REVISION }),
    }).state;

    expect(commentAnchors(next)).toEqual([]);
  });

  it("drops a seed that raced an edit — the buffer is no longer any known revision", () => {
    // `loadCommentThreads` is async. If the user types between the backend's read and the effect's
    // dispatch, every offset in that list is one revision stale.
    const state = stateWith(DOC, []);

    const typed = state.update({ changes: { from: 0, insert: "Well, " } }).state;
    const seeded = typed.update({
      effects: setCommentThreads.of({ threads: [thread("t1", anchorOn(DOC, "brown fox"))], revision: REVISION }),
    }).state;

    expect(commentAnchors(seeded)).toEqual([]);
  });

  it("keeps the anchors it already has when a stale seed is dropped", () => {
    // Dropping the seed must not erase live highlights: the anchors already in the field were
    // mapped through those same edits by CM6 and are still honestly positioned. Their thread
    // *state* may lag until the next in-revision seed — a stale colour, never a stale position.
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor)]);

    const typed = state.update({ changes: { from: 0, insert: "Well, " } }).state;
    const seeded = typed.update({
      effects: setCommentThreads.of({ threads: [], revision: "some-other-revision" }),
    }).state;

    expect(commentAnchors(seeded)).toEqual([
      {
        threadId: "t1",
        state: "open",
        from: anchor.offset + "Well, ".length,
        to: anchor.offset + anchor.length + "Well, ".length,
      },
    ]);
  });

  it("accepts seeds again once the buffer's new revision is declared (as a save does)", () => {
    const state = stateWith(DOC, []);
    const typed = state.update({ changes: { from: 0, insert: "Well, " } }).state;

    const next = typed.update({
      effects: [
        setDocumentRevision.of("rev-2"),
        setCommentThreads.of({
          threads: [thread("t1", anchorOn(typed.doc.toString(), "brown fox"))],
          revision: "rev-2",
        }),
      ],
    }).state;

    expect(commentAnchors(next).map((a) => a.threadId)).toEqual(["t1"]);
  });
});

describe("editor/commentHighlights — severityOf (P2b-4b, D6)", () => {
  it("reports a seeded thread's severity", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { severity: "high" })]);

    expect(severityOf(state, "t1")).toBe("high");
  });

  it("reports null for an ordinary human comment (no severity)", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(severityOf(state, "t1")).toBeNull();
  });

  it("reports undefined for a thread id the current seed doesn't carry", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(severityOf(state, "unknown")).toBeUndefined();
  });

  it("reports undefined when the field isn't installed", () => {
    const bare = EditorState.create({ doc: DOC });

    expect(severityOf(bare, "t1")).toBeUndefined();
  });

  it("keeps a thread's document-level severity even though it has no anchor to draw", () => {
    // A document-level finding (no `anchor`) has nothing for `commentAnchors` to position, but it
    // still has a severity worth looking up should a future surface need it — this join table is
    // deliberately not filtered to anchored threads the way `commentAnchorsField` is.
    const state = stateWith(DOC, [thread("t1", null, { severity: "low" })]);

    expect(severityOf(state, "t1")).toBe("low");
  });

  it("drops a stale-revision seed's severities exactly as it drops its positions", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { severity: "high" })]);

    const next = state.update({
      effects: setCommentThreads.of({
        threads: [thread("t1", anchorOn(DOC, "brown fox"), { severity: "low" })],
        revision: "rev-from-another-document-state",
      }),
    }).state;

    expect(severityOf(next, "t1")).toBe("high");
  });
});

/** A long fixture with one anchored quote near the top and one far below the initial viewport —
 * the #216 shape, reused so the viewport guarantee is asserted the same way for both decoration
 * families. */
function farFixture(): { doc: string; near: string; far: string } {
  const lines = Array.from({ length: 150 }, (_, i) => `paragraph line ${i}`);
  lines[2] = "a near quote here";
  lines[120] = "a far quote here";
  return { doc: lines.join("\n"), near: "near quote", far: "far quote" };
}

describe("editor/commentHighlights — viewport-scoped decorations (TD-13/#216, FR-X-4)", () => {
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  function mount(doc: string, threads: CommentThread[], onSelectThread?: (id: string) => void): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: commentHighlightExtensions(onSelectThread) }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects(threads) });
    return view;
  }

  function decorations(view: EditorView): DecorationSet {
    const plugin = view.plugin(commentHighlightsPlugin);
    if (!plugin) throw new Error("commentHighlightsPlugin is not installed on this view");
    return plugin.decorations;
  }

  function decoratedRanges(view: EditorView): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    decorations(view).between(0, view.state.doc.length, (from, to) => {
      out.push({ from, to });
    });
    return out;
  }

  it("decorates an anchor inside the viewport", () => {
    const { doc, near } = farFixture();
    const view = mount(doc, [thread("t1", anchorOn(doc, near))]);
    const offset = doc.indexOf(near);

    expect(decoratedRanges(view)).toEqual([{ from: offset, to: offset + near.length }]);
  });

  it("does not build a decoration for an anchor far below the viewport", () => {
    // The guarantee #216 bought for structural markup, held for this family too: build cost is
    // bounded by what is on screen, so hundreds of threads cannot blow the FR-X-4 keystroke budget.
    const { doc, near, far } = farFixture();
    const view = mount(doc, [thread("near", anchorOn(doc, near)), thread("far", anchorOn(doc, far))]);

    expect(view.viewport.to).toBeLessThan(doc.indexOf(far)); // sanity: far is genuinely offscreen
    expect(decoratedRanges(view)).toEqual([{ from: doc.indexOf(near), to: doc.indexOf(near) + near.length }]);
  });

  it("decorates the far anchor once it is scrolled into view", () => {
    const { doc, far } = farFixture();
    const view = mount(doc, [thread("far", anchorOn(doc, far))]);
    const before = decorations(view);

    view.dispatch({ effects: EditorView.scrollIntoView(doc.indexOf(far)) });

    expect(decorations(view)).not.toBe(before);
    expect(decoratedRanges(view)).toEqual([{ from: doc.indexOf(far), to: doc.indexOf(far) + far.length }]);
  });

  it("never mutates the document across a rebuild (P1)", () => {
    // Mirrors NI-viewport-scoped-decorations' own invariant test: this is a read-only decoration
    // layer, so no seed, edit, or viewport move it reacts to may ever alter the source string.
    const { doc, near, far } = farFixture();
    const view = mount(doc, [thread("near", anchorOn(doc, near)), thread("far", anchorOn(doc, far))]);
    const before = view.state.doc.toString();

    view.dispatch({ effects: EditorView.scrollIntoView(doc.indexOf(far)) });
    view.dispatch({ effects: seedEffects([thread("near", anchorOn(doc, near))]) });

    expect(view.state.doc.toString()).toBe(before);
  });

  it("tags each highlight with its thread id and derived state", () => {
    const { doc, near } = farFixture();
    const view = mount(doc, [thread("t1", anchorOn(doc, near), { resolved: true })]);

    const element = view.dom.querySelector(".cm-commentHighlight");
    expect(element?.getAttribute("data-comment-thread")).toBe("t1");
    expect(element?.classList.contains("cm-commentHighlight-resolved")).toBe(true);
  });
});

describe("editor/commentHighlights — click deep-links to the thread (Principle 6/Principle 2)", () => {
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  function mountWithHandler(onSelectThread: (id: string) => void): { view: EditorView; doc: string } {
    const doc = DOC;
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: commentHighlightExtensions(onSelectThread) }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([thread("t1", anchorOn(doc, "brown fox"))]) });
    view.focus();
    return { view, doc };
  }

  function clickHighlight(view: EditorView): void {
    const element = view.dom.querySelector(".cm-commentHighlight");
    if (!element) throw new Error("no comment highlight rendered");
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  }

  it("calls the deep-link handler with the clicked thread's id", () => {
    const onSelectThread = vi.fn();
    const { view } = mountWithHandler(onSelectThread);

    clickHighlight(view);

    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("selects the clicked open anchor until the thread selection is cleared (#1781)", () => {
    const { view } = mountWithHandler(vi.fn());

    clickHighlight(view);

    expect(view.dom.querySelector(".cm-commentHighlight-selected")?.getAttribute("data-comment-thread")).toBe(
      "t1",
    );

    view.dispatch({ effects: setSelectedCommentThread.of(null) });

    expect(view.dom.querySelector(".cm-commentHighlight-selected")).toBeNull();
  });

  it("composes Selected with every thread state and keeps the state's own class (comments.md anchor highlights)", () => {
    // comments.md: "Selected composes with every state; it is not an Open-only style." Each
    // derivable state is checked unselected and selected; Suggestion is not derivable yet (P2b-3),
    // so its selected rule is covered by the theme cell below.
    const overrides: [string, Partial<CommentThread>][] = [
      ["open", {}],
      ["working", { pending_run: "run-7", pending_run_started: true }],
      [
        "addressed-pending",
        { linked_changes: [{ change_id: "c1", decision: null, delivery_id: "d1", run_id: "run-1", delivered_at: 0 }] },
      ],
      ["reopened", { reopened: true }],
      ["resolved", { resolved: true }],
    ];
    for (const [state, fields] of overrides) {
      const view = new EditorView({
        state: EditorState.create({ doc: DOC, extensions: commentHighlightExtensions(vi.fn()) }),
        parent: document.body.appendChild(document.createElement("div")),
      });
      mounted.push(view);
      view.dispatch({ effects: seedEffects([thread("t1", anchorOn(DOC, "brown fox"), fields)]) });
      const classes = () => [...(view.dom.querySelector(".cm-commentHighlight")?.classList ?? [])].sort();

      expect({ state, classes: classes() }).toEqual({
        state,
        classes: ["cm-commentHighlight", `cm-commentHighlight-${state}`].sort(),
      });

      view.dispatch({ effects: setSelectedCommentThread.of("t1") });

      expect({ state, classes: classes() }).toEqual({
        state,
        classes: ["cm-commentHighlight", `cm-commentHighlight-${state}`, "cm-commentHighlight-selected"].sort(),
      });
    }
  });

  it("leaves focus with the editor caret rather than stealing it (Principle 2)", () => {
    // The timeline scrolls to the thread; the caret stays where the user put it, so typing
    // continues uninterrupted. Note this is asserted as *focus retention*, not via
    // `event.defaultPrevented`: CM6's own mousedown handler calls `preventDefault` to drive its
    // selection/drag handling, so a bare `EditorView` with none of this card's extensions already
    // reports `defaultPrevented === true` (probed directly). That flag therefore says nothing about
    // whether this layer consumed the click; where focus ends up does.
    const onSelectThread = vi.fn();
    const { view } = mountWithHandler(onSelectThread);

    clickHighlight(view);

    expect(onSelectThread).toHaveBeenCalledWith("t1");
    expect(view.hasFocus).toBe(true);
    expect(view.contentDOM.contains(document.activeElement)).toBe(true);
  });

  it("never mutates the document on a click (P1)", () => {
    const { view } = mountWithHandler(vi.fn());
    const before = view.state.doc.toString();

    clickHighlight(view);

    expect(view.state.doc.toString()).toBe(before);
  });

  it("ignores a click on ordinary text outside every highlight", () => {
    const onSelectThread = vi.fn();
    const { view } = mountWithHandler(onSelectThread);

    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("is inert when no deep-link handler is wired", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: commentHighlightExtensions() }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([thread("t1", anchorOn(DOC, "brown fox"))]) });

    expect(() => clickHighlight(view)).not.toThrow();
  });
});

describe("editor/commentHighlights — column navigation (#2537)", () => {
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  it("reveals the live mapped anchor by thread id without moving the editor caret or focus", async () => {
    const doc = "First passage.\n\nSecond passage.\n";
    const comment = thread("second", anchorOn(doc, "Second"));
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: commentHighlightExtensions() }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([comment]) });
    view.dispatch({ changes: { from: 0, insert: "New opening.\n" }, selection: { anchor: 2 } });
    view.focus();
    const before = view.state.selection;

    expect(await revealCommentThreadInEditor(view, comment)).toBe(true);
    expect(view.state.selection).toEqual(before);
    expect(view.hasFocus).toBe(true);
    expect(view.dom.querySelector(".cm-commentHighlight-selected")?.textContent).toBe("Second");
    expect(await revealCommentThreadInEditor(view, { ...comment, id: "missing" })).toBe(false);
    expect(view.state.selection).toEqual(before);
  });

  it("does not select or scroll a thread after its tab becomes inactive", async () => {
    const comment = thread("second", anchorOn(DOC, "brown fox"));
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: commentHighlightExtensions() }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([comment]) });

    expect(await revealCommentThreadInEditor(view, comment, () => false)).toBe(false);
    expect(view.dom.querySelector(".cm-commentHighlight-selected")).toBeNull();
  });

  it("places separate keyboard-reachable icons on their paragraph and nudges a shared paragraph", () => {
    const doc = "First anchor and second anchor.\nContinued paragraph.\n\nThird anchor.\n";
    const selected = thread("first", anchorOn(doc, "First"));
    const beside = thread("second", anchorOn(doc, "Continued"));
    const following = thread("third", anchorOn(doc, "Third"));
    const onSelect = vi.fn();
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdownLanguage.extension, ...commentHighlightExtensions(onSelect)] }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([selected, beside, following]) });

    const first = view.dom.querySelector<HTMLButtonElement>('[data-comment-gutter-thread="first"]');
    const second = view.dom.querySelector<HTMLButtonElement>('[data-comment-gutter-thread="second"]');
    const third = view.dom.querySelector<HTMLButtonElement>('[data-comment-gutter-thread="third"]');
    expect(first?.tagName).toBe("BUTTON");
    expect(second?.tagName).toBe("BUTTON");
    expect(third?.tagName).toBe("BUTTON");
    expect(first?.getAttribute("aria-label")).toBe("Show comment thread 1 of 3");
    expect(second?.getAttribute("aria-label")).toBe("Show comment thread 2 of 3");
    expect(third?.getAttribute("aria-label")).toBe("Show comment thread 3 of 3");
    expect(first?.closest(".cm-line")).toBe(second?.closest(".cm-line"));
    expect(first?.closest(".cm-line")).not.toBe(third?.closest(".cm-line"));
    expect(Number.parseInt(second!.style.top, 10)).toBeGreaterThan(Number.parseInt(first!.style.top, 10) + 19);
    second?.click();
    expect(onSelect).toHaveBeenCalledWith("second");
  });

  it("live add affordance reports the current selection and preserves it when activated", () => {
    const doc = "First passage and second passage.\n\nAnother paragraph.\n";
    const onAdd = vi.fn();
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdownLanguage.extension, ...commentHighlightExtensions(vi.fn(), onAdd)],
      }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    expect(view.dom.querySelector("[data-comment-gutter-add]")).toBeNull();

    const first = doc.indexOf("First passage");
    view.dispatch({ selection: { anchor: first, head: first + "First passage".length } });
    const button = view.dom.querySelector<HTMLButtonElement>("[data-comment-gutter-add]");
    expect(button).toHaveAttribute("aria-label", "Add comment to selected text");
    expect(button?.closest(".cm-line")?.textContent).toContain("First passage");
    const before = view.state.selection;
    button?.click();
    expect(onAdd).toHaveBeenCalledWith({
      offset: first,
      length: "First passage".length,
      text: "First passage",
    });
    expect(view.state.selection).toEqual(before);

    view.dispatch({ selection: { anchor: first, head: first } });
    expect(view.dom.querySelector("[data-comment-gutter-add]")).toBeNull();
  });

  it("live add affordance follows a later selection after an edit and shares a paragraph without covering its thread icon", () => {
    const doc = "First passage and second passage.\n";
    const onAdd = vi.fn();
    const anchored = thread("first", anchorOn(doc, "First passage"));
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdownLanguage.extension, ...commentHighlightExtensions(vi.fn(), onAdd)],
      }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects([anchored]) });
    view.dispatch({ selection: { anchor: 0, head: "First".length } });
    view.dispatch({ changes: { from: 0, insert: "New " } });
    const second = view.state.doc.toString().indexOf("second passage");
    view.dispatch({ selection: { anchor: second, head: second + "second passage".length } });

    const icon = view.dom.querySelector<HTMLButtonElement>('[data-comment-gutter-thread="first"]');
    const add = view.dom.querySelector<HTMLButtonElement>("[data-comment-gutter-add]");
    expect(add?.closest(".cm-line")).toBe(icon?.closest(".cm-line"));
    expect(Number.parseInt(add!.style.top, 10)).toBeGreaterThan(Number.parseInt(icon!.style.top, 10) + 19);
    add?.click();
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({
      offset: second,
      length: "second passage".length,
      text: "second passage",
    });
  });
});

describe("editor/commentHighlights — theme colours resolve through tokens, not literals (#1719)", () => {
  // #1719: the washes were hardcoded light-mode hex with no dark variant, so dark mode painted a
  // near-white wash under near-white text (1.01-1.11:1 contrast). jsdom applies no stylesheet, so
  // the resulting contrast itself is unassertable (the module's own doc comment says so) — but
  // "every colour is a var(--color-*) token, never a literal" is a structural fact this suite can
  // pin, and pinning it is exactly what would have caught the bug: a literal has no dark variant by
  // construction, a token always does (`styles.css` supplies both themes' values).
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  function mount(threads: CommentThread[]): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: commentHighlightExtensions() }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects(threads) });
    return view;
  }

  function element(view: EditorView, selector: string): HTMLElement {
    const el = view.dom.querySelector(selector);
    if (!el) throw new Error(`no ${selector} rendered`);
    return el as HTMLElement;
  }

  it("declares no raw hex literal anywhere in commentHighlightTheme", () => {
    const start = MODULE_SOURCE.indexOf("const commentHighlightTheme = EditorView.baseTheme({");
    const end = MODULE_SOURCE.indexOf("\n});", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const themeSource = MODULE_SOURCE.slice(start, end);

    expect(themeSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("resolves each state's background through its own dedicated comment-highlight token", () => {
    // Distinct anchors per thread — a shared anchor would nest four marks over the same text and
    // leave `querySelector` unable to tell one state's element from another's.
    const view = mount([
      thread("open", anchorOn(DOC, "quick brown")),
      thread("working", anchorOn(DOC, "brown fox"), { pending_run: "run-7", pending_run_started: true }),
      thread("reopened", anchorOn(DOC, "jumps over"), { reopened: true }),
      thread("resolved", anchorOn(DOC, "lazy dog"), { resolved: true }),
    ]);

    expect(getComputedStyle(element(view, ".cm-commentHighlight-working")).backgroundColor).toBe(
      "var(--color-comment-highlight-working-bg)",
    );
    expect(getComputedStyle(element(view, ".cm-commentHighlight-reopened")).backgroundColor).toBe(
      "var(--color-comment-highlight-reopened-bg)",
    );
    // Resolved's wash is deliberately transparent in both themes (the file's own doc comment) —
    // that is a keyword, not a hex literal, so it carries no dark-mode risk and needs no token.
    // jsdom normalizes the `transparent` keyword to its equivalent rgba() on read-back.
    expect(getComputedStyle(element(view, ".cm-commentHighlight-resolved")).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
  });

  it("gives addressed-pending its own background token rather than working's (refresh (32))", () => {
    // `deriveThreadState` reaches "addressed-pending" from a non-empty `linked_changes` with no run
    // currently in flight (`pending_run` outranks it, per that function's own precedence order).
    const view = mount([
      thread("t1", anchorOn(DOC, "brown fox"), {
        linked_changes: [{ change_id: "c1", decision: null, delivery_id: "d1", run_id: "run-1", delivered_at: 0 }],
      }),
    ]);

    expect(getComputedStyle(element(view, ".cm-commentHighlight-addressed-pending")).backgroundColor).toBe(
      "var(--color-comment-highlight-addressed-pending-bg)",
    );
  });

  /** The anchor-relevant computed style of a span carrying `classes`, placed inside the mounted
   * editor so the scoped theme rules match it. Suggestion is not derivable from a thread yet
   * (P2b-3), so a span is the one way to reach its rules; using it for every state keeps the table
   * below uniform. */
  function anchorStyle(view: EditorView, classes: string[]) {
    const span = view.dom.appendChild(document.createElement("span"));
    span.className = ["cm-commentHighlight", ...classes].join(" ");
    const style = getComputedStyle(span);
    const result = {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      // jsdom reports CSS initial values for unset properties; "" stands for "this state draws none".
      line: style.borderBottomStyle === "none"
        ? ""
        : [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor].join(" "),
      decoration: style.textDecorationLine === "none"
        ? ""
        : [style.textDecorationLine, style.textDecorationStyle, style.textDecorationColor].join(" "),
    };
    span.remove();
    return result;
  }

  const token = (name: string) => `var(--color-comment-highlight-${name})`;

  it("draws each state's line by pattern and weight and keeps it when selected (comments.md anchor highlights)", () => {
    // Oracle: comments.md *Anchor highlights in the text* table. The fill carries selection; the
    // line carries state. Working and Addressed — pending redraw their pattern in the accent when
    // selected; Reopened and Suggestion keep their own colour; Resolved's line darkens.
    const view = mount([]);
    const selectedFill = token("selected-bg");
    const expected: Record<string, ReturnType<typeof anchorStyle>> = {
      open: { background: token("open-bg"), shadow: `0 1px 0 ${token("open-border")}`, line: "", decoration: "" },
      working: { background: token("working-bg"), shadow: "", line: `1px dotted ${token("working-border")}`, decoration: "" },
      "addressed-pending": {
        background: token("addressed-pending-bg"),
        shadow: "",
        line: `2px dashed ${token("addressed-pending-border")}`,
        decoration: "",
      },
      reopened: { background: token("reopened-bg"), shadow: "", line: `3px double ${token("reopened-border")}`, decoration: "" },
      suggestion: {
        background: token("suggestion-bg"),
        shadow: "",
        line: `1px solid ${token("suggestion-border")}`,
        decoration: `underline wavy ${token("suggestion-border")}`,
      },
      resolved: { background: "rgba(0, 0, 0, 0)", shadow: "", line: `1px dashed ${token("resolved-border")}`, decoration: "" },
    };
    const expectedSelected: Record<string, ReturnType<typeof anchorStyle>> = {
      open: { background: selectedFill, shadow: `0 1px 0 ${token("selected-border")}`, line: "", decoration: "" },
      working: { background: selectedFill, shadow: "", line: `1px dotted ${token("selected-pattern-border")}`, decoration: "" },
      "addressed-pending": {
        background: selectedFill,
        shadow: "",
        line: `2px dashed ${token("selected-pattern-border")}`,
        decoration: "",
      },
      reopened: { background: selectedFill, shadow: "", line: `3px double ${token("reopened-border")}`, decoration: "" },
      suggestion: {
        background: selectedFill,
        shadow: "",
        line: `1px solid ${token("suggestion-border")}`,
        decoration: `underline wavy ${token("suggestion-border")}`,
      },
      resolved: { background: selectedFill, shadow: "", line: `1px dashed ${token("selected-resolved-border")}`, decoration: "" },
    };

    for (const state of Object.keys(expected)) {
      expect({ state, ...anchorStyle(view, [`cm-commentHighlight-${state}`]) }).toEqual({ state, ...expected[state] });
      expect({ state, selected: true, ...anchorStyle(view, [`cm-commentHighlight-${state}`, "cm-commentHighlight-selected"]) })
        .toEqual({ state, selected: true, ...expectedSelected[state] });
    }
  });

  it("tells Working from Addressed — pending by line pattern and weight, not colour alone, selected or not (ux-design §2 carrier 4)", () => {
    const view = mount([]);
    for (const selected of [[], ["cm-commentHighlight-selected"]]) {
      const lineOf = (state: string) => {
        const span = view.dom.appendChild(document.createElement("span"));
        span.className = ["cm-commentHighlight", `cm-commentHighlight-${state}`, ...selected].join(" ");
        const style = getComputedStyle(span);
        const line = { width: style.borderBottomWidth, style: style.borderBottomStyle };
        span.remove();
        return line;
      };
      const working = lineOf("working");
      const pending = lineOf("addressed-pending");

      expect({ selected: selected.length > 0, differ: working.style !== pending.style && working.width !== pending.width })
        .toEqual({ selected: selected.length > 0, differ: true });
      // Neither may fall back to the shadow line, which Windows High Contrast drops (comments.md
      // *Forced colours*): both must draw a real border.
      expect([working.style, pending.style].every((style) => style && style !== "none")).toBe(true);
    }
  });

  it("resolves the open state's background through its own token", () => {
    const view = mount([thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(getComputedStyle(element(view, ".cm-commentHighlight")).backgroundColor).toBe(
      "var(--color-comment-highlight-open-bg)",
    );

    view.dispatch({ effects: setSelectedCommentThread.of("t1") });

    expect(getComputedStyle(element(view, ".cm-commentHighlight-selected")).backgroundColor).toBe(
      "var(--color-comment-highlight-selected-bg)",
    );
    expect(document.head.textContent).toContain(
      "0 1px 0 var(--color-comment-highlight-open-border)",
    );
    expect(document.head.textContent).toContain(
      "0 1px 0 var(--color-comment-highlight-selected-border)",
    );
  });

  it("injects every state's border token into the mounted document (styles.css supplies the values)", () => {
    // `border`/`textDecoration` are shorthands; jsdom's computed-style parser does not reliably keep
    // a `var()` reference inside a shorthand's expansion (`structuralDecorations.test.ts`'s own
    // border assertions use this same textContent check for that reason), so the injected style
    // module's own text is the honest place to look.
    mount([thread("t1", anchorOn(DOC, "brown fox"))]);

    for (const token of [
      "--color-comment-highlight-open-border",
      "--color-comment-highlight-selected-border",
      "--color-comment-highlight-working-border",
      "--color-comment-highlight-addressed-pending-border",
      "--color-comment-highlight-selected-pattern-border",
      "--color-comment-highlight-selected-resolved-border",
      "--color-comment-highlight-reopened-border",
      "--color-comment-highlight-suggestion-border",
      "--color-comment-highlight-resolved-border",
    ]) {
      expect(document.head.textContent).toContain(`var(${token})`);
    }
  });

  it("declares light and dark values for every comment-highlight token in styles.css", () => {
    const darkStart = APP_STYLESHEET.indexOf(':root[data-theme="dark"]');
    const lightBlock = APP_STYLESHEET.slice(0, darkStart);
    const darkBlock = APP_STYLESHEET.slice(darkStart);

    // Oracle: tokens.md *Comment-anchor states* (refreshes (32)–(34)), which specifies both themes.
    // A token may name another core token (`var(--color-warning-bg)`); it is resolved within its
    // own theme block, so the cell pins the colour drawn rather than how it is spelled.
    //
    // Every token is checked in both blocks: a deleted dark override (the #1719 defect shape — the
    // light literal silently wins by inheritance) fails here rather than going unnoticed.
    function resolved(block: string, name: string): string | undefined {
      const value = block.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1].trim();
      const reference = value?.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
      return reference ? resolved(block, reference) : value;
    }
    const spec: [string, string, string][] = [
      ["open-bg", "#fbf3e1", "#78350f"],
      ["open-border", "#e0c98c", "#fcd34d"],
      ["working-bg", "#f0ede6", "#26282c"],
      ["working-border", "#6b665c", "#9aa0a6"],
      ["addressed-pending-bg", "#fbf3e1", "#78350f"],
      ["addressed-pending-border", "#8a6614", "#fcd34d"],
      ["reopened-bg", "#ffe0d6", "#3a3d42"],
      ["reopened-border", "#cf5b22", "#f87171"],
      ["suggestion-bg", "#d8f0dd", "#14532d"],
      ["suggestion-border", "#1a7f37", "#86efac"],
      ["resolved-border", "#8c8779", "#6b7075"],
      ["selected-bg", "#e1e0f8", "#23284d"],
      ["selected-border", "#a19ce9", "#a5b0ff"],
      ["selected-pattern-border", "#4f46e5", "#a5b0ff"],
      ["selected-resolved-border", "#6b665c", "#9aa0a6"],
    ];
    const darkDeclared = (name: string) =>
      new RegExp(`\\n\\s*--color-comment-highlight-${name}:`).test(darkBlock);
    for (const [name, light, dark] of spec) {
      const token = `--color-comment-highlight-${name}`;
      expect({ token, light: resolved(lightBlock, token), dark: resolved(darkBlock, token), darkDeclared: darkDeclared(name) })
        .toEqual({ token, light, dark, darkDeclared: true });
    }
  });
});
