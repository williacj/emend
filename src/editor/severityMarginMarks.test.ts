// @vitest-environment jsdom
// ABOUTME: Severity margin mark tests (P2b-4b, NI-a11y-severity, D6, D17/P2) — the marker set is
// ABOUTME: derived from `commentHighlights.ts`'s live anchors (never re-derives a position of its
// ABOUTME: own, so a mark can never point at a different line than its sibling highlight), skips
// ABOUTME: ordinary human-comment threads, and renders `● {letter}` — colour and letter both — over
// ABOUTME: a mounted `EditorView`.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { commentAnchors, commentHighlightExtensions, setCommentThreads, setDocumentRevision } from "./commentHighlights";
import { buildSeverityMarkers, severityMarginMarks } from "./severityMarginMarks";
import type { Anchor, CommentThread } from "../comments/types";
import { thread as openThread } from "../comments/threadFixture";

const REVISION = "rev-1";

/** A thread whose anchor covers `substr` in `doc` — matches `commentHighlights.test.ts`'s
 * `anchorOn` convention. */
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

function thread(id: string, anchor: Anchor | null, overrides: Partial<CommentThread> = {}): CommentThread {
  return openThread(id, { author: "cj", anchor, body: "a note", ...overrides });
}

function seedEffects(threads: CommentThread[]) {
  return [setDocumentRevision.of(REVISION), setCommentThreads.of({ threads, revision: REVISION })];
}

/** State with both the highlight layer's fields (the anchors/severity join `severityMarginMarks`
 * reads) and `threads` seeded in-revision — the two cards' extensions are always installed
 * together, per `commentHighlightExtensions`' own docs. */
function stateWith(doc: string, threads: CommentThread[]): EditorState {
  const state = EditorState.create({ doc, extensions: commentHighlightExtensions() });
  return state.update({ effects: seedEffects(threads) }).state;
}

const DOC = "The quick brown fox\njumps over the lazy dog.";

/** The severities `buildSeverityMarkers` produced, as `{ line-start offset, severity }` pairs in
 * document order — the readable shape these tests assert against rather than raw `RangeSet`
 * iteration. */
function markerEntries(state: EditorState): { from: number; severity: string }[] {
  const out: { from: number; severity: string }[] = [];
  buildSeverityMarkers(state).between(0, state.doc.length, (from, _to, marker) => {
    out.push({ from, severity: (marker as unknown as { severity: string }).severity });
  });
  return out;
}

describe("editor/severityMarginMarks — buildSeverityMarkers (P2b-4b, D6)", () => {
  it("gives a severity-tagged thread a marker at its anchored line's start", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor, { severity: "high" })]);
    const line = state.doc.lineAt(anchor.offset);

    expect(markerEntries(state)).toEqual([{ from: line.from, severity: "high" }]);
  });

  it("gives an ordinary human comment (no severity) no marker — D6", () => {
    const state = stateWith(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(markerEntries(state)).toEqual([]);
  });

  // `severity: ""` is D6 finding provenance, not "no severity" — `severity.ts` keeps it "fully
  // representable end-to-end" (it renders a timeline chip and is selected by the Findings facet), so
  // it must get a margin mark too, not just `severity === null`.
  it("gives an agent-supplied empty-string severity a marker, not the no-severity treatment", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor, { severity: "" })]);
    const line = state.doc.lineAt(anchor.offset);

    expect(markerEntries(state)).toEqual([{ from: line.from, severity: "" }]);
  });

  it("gives a document-level severity-tagged thread no marker — nothing to anchor to", () => {
    const state = stateWith(DOC, [thread("t1", null, { severity: "high" })]);

    expect(markerEntries(state)).toEqual([]);
  });

  it("gives an orphaned severity-tagged thread no marker rather than a wrong one (D17/P2)", () => {
    const state = stateWith(DOC, [
      thread("t1", anchorOn(DOC, "brown fox"), { severity: "high", orphaned: true }),
    ]);

    expect(markerEntries(state)).toEqual([]);
  });

  it("is keyed to the exact same anchor the highlight uses", () => {
    const anchor = anchorOn(DOC, "lazy dog");
    const state = stateWith(DOC, [thread("t1", anchor, { severity: "low" })]);

    const [highlight] = commentAnchors(state);
    const [marker] = markerEntries(state);

    expect(marker.from).toBe(state.doc.lineAt(highlight.from).from);
  });

  it("collapses two severity-tagged anchors on the same line to one marker", () => {
    const state = stateWith(DOC, [
      thread("t1", anchorOn(DOC, "quick"), { severity: "high" }),
      thread("t2", anchorOn(DOC, "brown fox"), { severity: "low" }),
    ]);

    expect(markerEntries(state)).toHaveLength(1);
  });

  it("follows the anchor when text is inserted before it — inherited from the shared anchor field", () => {
    const anchor = anchorOn(DOC, "brown fox");
    const state = stateWith(DOC, [thread("t1", anchor, { severity: "high" })]);

    const next = state.update({ changes: { from: 0, insert: "Well, " } }).state;

    expect(markerEntries(next)).toEqual([
      { from: next.doc.lineAt(anchor.offset + "Well, ".length).from, severity: "high" },
    ]);
  });
});

describe("editor/severityMarginMarks — mounted EditorView rendering (ux-design §2)", () => {
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  function mount(doc: string, threads: CommentThread[]): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [...commentHighlightExtensions(), ...severityMarginMarks()] }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    mounted.push(view);
    view.dispatch({ effects: seedEffects(threads) });
    return view;
  }

  it("renders both the colour hook and the letter — never colour alone", () => {
    const view = mount(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { severity: "high" })]);

    const mark = view.dom.querySelector(".cm-severityMark");
    expect(mark?.getAttribute("data-severity")).toBe("H");
    expect(mark?.textContent).toBe("● H");
  });

  it("maps every J3 severity level to its display letter", () => {
    const doc = "one\ntwo\nthree\nfour";
    const view = mount(doc, [
      thread("c", anchorOn(doc, "one"), { severity: "critical" }),
      thread("h", anchorOn(doc, "two"), { severity: "high" }),
      thread("m", anchorOn(doc, "three"), { severity: "medium" }),
      thread("l", anchorOn(doc, "four"), { severity: "low" }),
    ]);

    const letters = Array.from(view.dom.querySelectorAll(".cm-severityMark")).map((el) =>
      el.getAttribute("data-severity"),
    );
    expect(letters.sort()).toEqual(["C", "H", "L", "M"]);
  });

  it("renders no mark at all for a thread with no severity", () => {
    const view = mount(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(view.dom.querySelector(".cm-severityMark")).toBeNull();
  });

  it("renders the '?' fallback letter for an empty-string severity rather than dropping the mark", () => {
    const view = mount(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { severity: "" })]);

    const mark = view.dom.querySelector(".cm-severityMark");
    expect(mark?.getAttribute("data-severity")).toBe("?");
    expect(mark?.textContent).toBe("● ?");
  });

  /** The column is built by `SingleGutterView` on install, independent of `renderEmptyElements`
   * (which governs per-line elements only) — so a findings-free document still reserves the 2.2em
   * `.cm-severityGutter` width. Pinned rather than assumed because that width is unexecutable CSS:
   * without this test the module's docblock would be the only record of the reserved column, and a
   * future card could flip it to conditional — reintroducing the horizontal jitter UX Principle 2
   * forbids — with a fully green suite. */
  it("renders its gutter column even with no severity-tagged threads", () => {
    const view = mount(DOC, [thread("t1", anchorOn(DOC, "brown fox"))]);

    expect(view.dom.querySelectorAll(".cm-severityMark")).toHaveLength(0);
    expect(view.dom.querySelectorAll(".cm-severityGutter")).toHaveLength(1);
  });

  it("never mutates the document (P1)", () => {
    const view = mount(DOC, [thread("t1", anchorOn(DOC, "brown fox"), { severity: "high" })]);
    const before = view.state.doc.toString();

    view.dispatch({ effects: seedEffects([thread("t1", anchorOn(DOC, "brown fox"), { severity: "low" })]) });

    expect(view.state.doc.toString()).toBe(before);
  });
});
