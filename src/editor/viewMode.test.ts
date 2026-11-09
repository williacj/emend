// @vitest-environment jsdom
// ABOUTME: Pins the P2a-8 view-mode state itself: source-view + display-mode default, effect
// ABOUTME: dispatch, the None/Original read-only facets, and that none of it ever touches `doc`.
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { setDisplayMode, setSourceView, viewModeExtensions, viewModeField } from "./viewMode";

function stateFor(doc = "raw {++markup++} text"): EditorState {
  return EditorState.create({ doc, extensions: viewModeExtensions() });
}

describe("editor/viewMode — defaults", () => {
  it("starts in source-view-off and display-mode All", () => {
    const state = stateFor();
    expect(state.field(viewModeField)).toEqual({ sourceView: false, displayMode: "All" });
  });

  it("is editable and not state-read-only by default", () => {
    const state = stateFor();
    expect(state.readOnly).toBe(false);
  });
});

describe("editor/viewMode — setSourceView", () => {
  it("flips sourceView without touching displayMode or the document", () => {
    const before = stateFor();
    const after = before.update({ effects: setSourceView.of(true) }).state;
    expect(after.field(viewModeField)).toEqual({ sourceView: true, displayMode: "All" });
    expect(after.doc.toString()).toBe(before.doc.toString());
  });

  it("round-trips back to the exact same value", () => {
    let state = stateFor();
    state = state.update({ effects: setSourceView.of(true) }).state;
    state = state.update({ effects: setSourceView.of(false) }).state;
    expect(state.field(viewModeField)).toEqual({ sourceView: false, displayMode: "All" });
  });
});

describe("editor/viewMode — setDisplayMode", () => {
  it.each(["Simple", "None", "Original", "All"] as const)("selects %s without touching the document", (mode) => {
    const before = stateFor();
    const after = before.update({ effects: setDisplayMode.of(mode) }).state;
    expect(after.field(viewModeField).displayMode).toBe(mode);
    expect(after.field(viewModeField).sourceView).toBe(false);
    expect(after.doc.toString()).toBe(before.doc.toString());
  });
});

describe("editor/viewMode — None/Original are read-only projections (§3.3)", () => {
  it.each(["None", "Original"] as const)("%s sets EditorState.readOnly", (mode) => {
    const state = stateFor().update({ effects: setDisplayMode.of(mode) }).state;
    expect(state.readOnly).toBe(true);
  });

  it.each(["All", "Simple"] as const)("%s stays editable", (mode) => {
    const state = stateFor().update({ effects: setDisplayMode.of(mode) }).state;
    expect(state.readOnly).toBe(false);
  });

  it("returning from a read-only mode to All restores editability", () => {
    let state = stateFor();
    state = state.update({ effects: setDisplayMode.of("None") }).state;
    expect(state.readOnly).toBe(true);
    state = state.update({ effects: setDisplayMode.of("All") }).state;
    expect(state.readOnly).toBe(false);
  });
});

describe("editor/viewMode — never mutates the document (TD-2/P1)", () => {
  it("an arbitrary sequence of source/display toggles never changes doc.toString()", () => {
    const raw = "The {++quick++} {--slow--} fox {~~jumps~>leaps~~}.";
    let state = EditorState.create({ doc: raw, extensions: viewModeExtensions() });
    const sequence: Array<{ source?: boolean; mode?: "All" | "Simple" | "None" | "Original" }> = [
      { mode: "None" },
      { source: true },
      { mode: "Original" },
      { source: false },
      { mode: "Simple" },
      { mode: "All" },
      { source: true },
      { source: false },
    ];
    for (const step of sequence) {
      const effects = [];
      if (step.source !== undefined) effects.push(setSourceView.of(step.source));
      if (step.mode !== undefined) effects.push(setDisplayMode.of(step.mode));
      state = state.update({ effects }).state;
      expect(state.doc.toString()).toBe(raw);
    }
  });
});
