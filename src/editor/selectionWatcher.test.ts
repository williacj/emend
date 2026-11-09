// @vitest-environment jsdom
// ABOUTME: Editor selection observation (P2b-7) — a CM6 update-listener extension reporting the
// ABOUTME: live non-empty selection, purely read-only (Principle 2: never moves the caret or scrolls).
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDocumentState } from "./document";
import { selectionSnapshot, selectionWatcherExtension } from "./selectionWatcher";

describe("editor/selectionWatcher — selectionSnapshot (pure)", () => {
  it("is null for a bare caret (no selection)", () => {
    const state = EditorState.create({ doc: "hello world" });
    expect(selectionSnapshot(state)).toBeNull();
  });

  it("reports the offset, length, and text of a non-empty selection", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: { anchor: 0, head: 5 },
    });
    expect(selectionSnapshot(state)).toEqual({ offset: 0, length: 5, text: "hello" });
  });

  it("reports a reversed selection (head before anchor) the same as a forward one", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: { anchor: 5, head: 0 },
    });
    expect(selectionSnapshot(state)).toEqual({ offset: 0, length: 5, text: "hello" });
  });

  it("uses only the main range of a multi-range selection", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(6, 11)],
        1, // mainIndex — "world" is the main range, "hello" the secondary one
      ),
    });
    expect(selectionSnapshot(state)).toEqual({ offset: 6, length: 5, text: "world" });
  });
});

describe("editor/selectionWatcher — selectionWatcherExtension", () => {
  function mount(initialContent: string) {
    const events: (ReturnType<typeof selectionSnapshot>)[] = [];
    const view = new EditorView({
      state: createDocumentState(initialContent, [
        selectionWatcherExtension((selection) => events.push(selection)),
      ]),
      parent: document.createElement("div"),
    });
    return { view, events };
  }

  it("does not fire on mount before any selection", () => {
    const { events } = mount("hello world");
    expect(events).toEqual([]);
  });

  it("fires with a snapshot when a non-empty selection is made", () => {
    const { view, events } = mount("hello world");

    view.dispatch({ selection: { anchor: 0, head: 5 } });

    expect(events).toEqual([{ offset: 0, length: 5, text: "hello" }]);
  });

  it("fires null when the selection collapses back to a bare caret", () => {
    const { view, events } = mount("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    view.dispatch({ selection: { anchor: 2 } });

    expect(events).toEqual([{ offset: 0, length: 5, text: "hello" }, null]);
  });

  it("does not fire again for a bare caret move (no selection either before or after)", () => {
    const { view, events } = mount("hello world");

    view.dispatch({ selection: { anchor: 1 } });
    view.dispatch({ selection: { anchor: 3 } });

    expect(events).toEqual([]);
  });

  it("does not re-fire for a dispatch that leaves the exact same selection unchanged", () => {
    const { view, events } = mount("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    // A transaction that touches nothing relevant (no doc change, selection already set to the
    // same range) — CM6 itself would normally not even schedule an update for a no-op selection
    // set to its current value, but the dedupe guards against it regardless.
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    expect(events).toEqual([{ offset: 0, length: 5, text: "hello" }]);
  });

  it("re-fires when an edit inside the selected range changes its text", () => {
    const { view, events } = mount("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    // Replace "hello" with "howdy" — the selection's range is unaffected by the edit's own
    // replace-in-place length, but its text changed, so a caller quoting it must see the new text.
    view.dispatch({ changes: { from: 0, to: 5, insert: "howdy" }, selection: { anchor: 0, head: 5 } });

    expect(events).toEqual([
      { offset: 0, length: 5, text: "hello" },
      { offset: 0, length: 5, text: "howdy" },
    ]);
  });

  it("never dispatches a transaction of its own (Principle 2: read-only, no caret steal / scroll)", () => {
    const { view } = mount("hello world");
    const dispatchSpy = view.dispatch.bind(view);
    let dispatchCallsFromExtension = 0;
    // The only way this extension could steal focus/scroll is by calling `view.dispatch` itself
    // from inside the listener — assert the listener never does, by counting dispatches that
    // happen synchronously *during* another dispatch's update-listener phase.
    let insideListener = false;
    view.dispatch = ((...args: Parameters<typeof dispatchSpy>) => {
      if (insideListener) dispatchCallsFromExtension++;
      insideListener = true;
      try {
        return dispatchSpy(...args);
      } finally {
        insideListener = false;
      }
    }) as typeof dispatchSpy;

    view.dispatch({ selection: { anchor: 0, head: 5 } });

    expect(dispatchCallsFromExtension).toBe(0);
  });
});
