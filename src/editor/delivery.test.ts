// @vitest-environment jsdom
// ABOUTME: Tests for the agent-delivery undo policy (P2a-21, TD §3.3 finding M9) — a delivery
// ABOUTME: replaces the doc and reseeds tracked changes without ever entering CM6's undo history.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";
import { applyAgentDelivery, deliveryTransaction } from "./delivery";
import { redlineExtensions, trackedChanges, type ParsedChange } from "./trackedChanges";

function ins(doc: string, id: string, inner: string): ParsedChange {
  const from = doc.indexOf(`{++${inner}++}`);
  const full = { from, to: from + inner.length + 6 };
  return { id, recorded: false, group: null, full, kind: "insertion", text: { from: full.from + 3, to: full.to - 3 } };
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function viewWith(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), redlineExtensions()] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe("editor/delivery — agent-delivery undo policy (TD §3.3 finding M9)", () => {
  it("replaces the document with the delivered content and reseeds the tracked-change snapshot", () => {
    const view = viewWith("Hello world");
    const delivered = "Hello {++brave ++}world";
    applyAgentDelivery(view, delivered, { changes: [ins(delivered, "0", "brave ")] });

    expect(view.state.doc.toString()).toBe(delivered);
    expect(trackedChanges(view.state).map((c) => c.id)).toEqual(["0"]);
  });

  it("dispatches with addToHistory:false — a bare Ctrl/Cmd+Z immediately after a delivery leaves the delivered content in place", () => {
    const view = viewWith("Hello world");
    const delivered = "Hello {++brave ++}world";
    applyAgentDelivery(view, delivered, { changes: [ins(delivered, "0", "brave ")] });

    const handled = undo(view);

    expect(handled).toBe(false); // nothing in the undo history to pop
    expect(view.state.doc.toString()).toBe(delivered);
  });

  it("does not itself add a step to the undo history — undoDepth never grows from a delivery alone", () => {
    const view = viewWith("Hello world");
    expect(undoDepth(view.state)).toBe(0);

    const delivered = "Hello {++brave ++}world";
    applyAgentDelivery(view, delivered, { changes: [ins(delivered, "0", "brave ")] });

    expect(undoDepth(view.state)).toBe(0);
  });

  it("deliveryTransaction is a pure builder that dispatches nothing and yields the delivered text", () => {
    const state = EditorState.create({ doc: "x", extensions: redlineExtensions() });
    const spec = deliveryTransaction(state, "y", { changes: [] });

    // Applied, the spec produces exactly the delivered content — the shape of the change set that
    // gets there is `deliveryTransaction`'s business (see the Principle 2 cases below), the
    // resulting document is its contract.
    expect(state.update(spec).state.doc.toString()).toBe("y");
    expect(state.doc.toString()).toBe("x"); // the builder dispatched nothing
  });
});

describe("editor/delivery — UX Principle 2: a delivery never moves the user", () => {
  /** The J1 Phase B edge state: the user is typing mid-sentence when the set lands. */
  const original = "Alpha beta gamma.\n\nDelta epsilon zeta.\n";
  const delivered = "Alpha {++very ++}beta gamma.\n\nDelta epsilon zeta.\n";
  const seed = () => ({ changes: [ins(delivered, "0", "very ")] });

  it("leaves the caret where the user left it when the delivery lands after it", () => {
    const view = viewWith(original);
    // Caret parked in the *second* paragraph — well after everything the agent touched.
    const caret = original.indexOf("epsilon") + 3;
    view.dispatch({ selection: { anchor: caret } });

    applyAgentDelivery(view, delivered, seed());

    // The delivered markup inserted 9 characters ahead of the caret, so the caret's *offset* must
    // shift by exactly that much to stay on the same character. Anchoring the assertion on the
    // surrounding text rather than a number is what makes this a "didn't move" test rather than an
    // arithmetic restatement of the implementation.
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(0, head).endsWith("Delta eps")).toBe(true);
    expect(view.state.doc.sliceString(head)).toBe("ilon zeta.\n");
  });

  it("keeps a selection range intact across a delivery that lands elsewhere", () => {
    const view = viewWith(original);
    const from = original.indexOf("Delta");
    const to = from + "Delta epsilon".length;
    view.dispatch({ selection: { anchor: from, head: to } });
    const selectedBefore = view.state.doc.sliceString(from, to);

    applyAgentDelivery(view, delivered, seed());

    const { from: newFrom, to: newTo } = view.state.selection.main;
    expect(view.state.doc.sliceString(newFrom, newTo)).toBe(selectedBefore);
    expect(view.state.selection.main.empty).toBe(false);
  });

  it("never asks CM6 to scroll — the delivery transaction carries no scrollIntoView", () => {
    const state = EditorState.create({ doc: original, extensions: redlineExtensions() });
    const spec = deliveryTransaction(state, delivered, seed());

    // Principle 2: "no scroll, no focus steal, no animation on the text". `scrollIntoView` is the
    // one thing in a TransactionSpec that would move the viewport, so it must stay absent.
    expect(spec.scrollIntoView).toBeUndefined();
  });

  it("does not steal focus — an unfocused editor stays unfocused through a delivery", () => {
    const view = viewWith(original);
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    applyAgentDelivery(view, delivered, seed());

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("touches only the changed span so untouched text is never rewritten under the user", () => {
    // The mechanism behind every assertion above: a delivery that rewrote the whole document
    // (`{from: 0, to: len}`) would map every downstream position to the end of the replacement,
    // dumping the caret at the bottom of the file. The delivered text is still whole-document
    // (TD-2 — the backend's rebased result, no client-side patching); expressing it as the
    // minimal change is what keeps the user's position meaningful.
    const state = EditorState.create({ doc: original, extensions: redlineExtensions() });
    const spec = deliveryTransaction(state, delivered, seed());

    const touched: { from: number; to: number }[] = [];
    state.update(spec).changes.iterChangedRanges((from, to) => touched.push({ from, to }));

    expect(touched).toHaveLength(1);
    expect(touched[0].from).toBeGreaterThanOrEqual(original.indexOf("beta") - 1);
    expect(touched[0].to).toBeLessThanOrEqual(original.indexOf("gamma"));
  });

  it("still delivers correctly when the change is at the very start or end of the document", () => {
    // Prefix/suffix trimming has to cope with a delivery that shares no common prefix (or no
    // common suffix) with the live text — the boundary the trimming arithmetic gets wrong first.
    const atStart = viewWith("beta gamma.\n");
    applyAgentDelivery(atStart, "{++Alpha ++}beta gamma.\n", {
      changes: [ins("{++Alpha ++}beta gamma.\n", "0", "Alpha ")],
    });
    expect(atStart.state.doc.toString()).toBe("{++Alpha ++}beta gamma.\n");

    const atEnd = viewWith("alpha beta");
    applyAgentDelivery(atEnd, "alpha beta{++ gamma++}", {
      changes: [ins("alpha beta{++ gamma++}", "0", " gamma")],
    });
    expect(atEnd.state.doc.toString()).toBe("alpha beta{++ gamma++}");
  });

  it("delivers a document that shares nothing with the live text", () => {
    const view = viewWith("completely different\n");
    applyAgentDelivery(view, "{++fresh++}\n", { changes: [ins("{++fresh++}\n", "0", "fresh")] });
    expect(view.state.doc.toString()).toBe("{++fresh++}\n");
  });

  it("never splits a surrogate pair when trimming to the changed span", () => {
    // Trimming by UTF-16 code unit could cut an emoji in half and produce a lone surrogate —
    // corrupting text the delivery never intended to touch (TD-2 fidelity).
    const view = viewWith("keep 😀 and 🎉 too\n");
    const out = "keep 😀 and {++new ++}🎉 too\n";
    applyAgentDelivery(view, out, { changes: [ins(out, "0", "new ")] });
    expect(view.state.doc.toString()).toBe(out);
  });
});
