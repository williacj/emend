// @vitest-environment jsdom
// ABOUTME: The dirty/clean detection an editor tab needs (FR-ED-3) — a CM6 update-listener
// ABOUTME: extension comparing the live doc against a caller-supplied last-saved baseline.
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDocumentState } from "./document";
import { dirtyTrackingExtension, recheckDirty } from "./dirtyTracking";

function mount(initialContent: string, baseline: () => string) {
  const events: boolean[] = [];
  const view = new EditorView({
    state: createDocumentState(initialContent, [
      dirtyTrackingExtension(baseline, (dirty) => events.push(dirty)),
    ]),
    parent: document.createElement("div"),
  });
  return { view, events };
}

describe("editor/dirtyTracking", () => {
  it("does not fire on mount before any edit", () => {
    const { events } = mount("hello\n", () => "hello\n");
    expect(events).toEqual([]);
  });

  it("fires dirty=true the first time an edit diverges from the baseline", () => {
    const { view, events } = mount("hello\n", () => "hello\n");

    view.dispatch({ changes: { from: 5, insert: "!" } });

    expect(events).toEqual([true]);
  });

  it("fires dirty=false when an edit brings the doc back to exactly the baseline", () => {
    const { view, events } = mount("hello\n", () => "hello\n");
    view.dispatch({ changes: { from: 5, insert: "!" } });

    view.dispatch({ changes: { from: 5, to: 6 } });

    expect(events).toEqual([true, false]);
  });

  it("does not re-fire for a further edit that stays dirty", () => {
    const { view, events } = mount("hello\n", () => "hello\n");
    view.dispatch({ changes: { from: 5, insert: "!" } });

    view.dispatch({ changes: { from: 6, insert: "?" } });

    expect(events).toEqual([true]);
  });

  it("reads the baseline fresh on every change (e.g. after a save updates it)", () => {
    let saved = "hello\n";
    const { view, events } = mount("hello\n", () => saved);

    view.dispatch({ changes: { from: 5, insert: "!" } }); // doc: "hello!\n"
    expect(events).toEqual([true]);

    // A save landed: the baseline now matches the (still dirty-flagged) live doc.
    saved = "hello!\n";
    view.dispatch({ changes: { from: 6, insert: "?" } }); // doc: "hello!?\n" — still dirty
    view.dispatch({ changes: { from: 6, to: 7 } }); // removes "?" — back to "hello!\n"

    expect(events).toEqual([true, false]);
  });

  it("a transaction with no doc change (e.g. a bare selection move) never fires", () => {
    const { view, events } = mount("hello\n", () => "hello\n");

    view.dispatch({ selection: { anchor: 1 } });

    expect(events).toEqual([]);
  });

  it("a recheckDirty dispatch re-evaluates against a moved baseline with no doc change of its own", () => {
    let saved = "hello\n";
    const { view, events } = mount("hello\n", () => saved);
    view.dispatch({ changes: { from: 5, insert: "!" } }); // doc: "hello!\n", dirty
    expect(events).toEqual([true]);

    // A save just landed: the baseline moved to match the live doc exactly, signalled the way
    // `EditorShell.performSave` does — a dispatch carrying `recheckDirty` but no text changes.
    saved = "hello!\n";
    view.dispatch({ effects: recheckDirty.of() });

    expect(events).toEqual([true, false]);
  });

  it("stays internally consistent across a save-then-edit sequence (no missed transition)", () => {
    // Regression: the extension owns ONE `lastDirty` memory. If a save's `recheckDirty` dispatch
    // didn't feed back through the same memory as ordinary doc edits, a later genuinely-dirty
    // edit could be swallowed as a false "no change" against stale internal state.
    let saved = "hello\n";
    const { view, events } = mount("hello\n", () => saved);
    view.dispatch({ changes: { from: 5, insert: "!" } }); // dirty
    saved = "hello!\n";
    view.dispatch({ effects: recheckDirty.of() }); // clean again
    expect(events).toEqual([true, false]);

    view.dispatch({ changes: { from: 6, insert: "?" } }); // dirty again

    expect(events).toEqual([true, false, true]);
  });
});
