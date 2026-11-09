// @vitest-environment jsdom
// ABOUTME: Component proof for FR-ED-4's status-bar Display projection control.
// ABOUTME: The visible and overflow forms preserve all four choices without mutating the document.
import { fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  DisplayModeControl,
  displayModeOverflowEntries,
} from "./DisplayModeControl";
import {
  revealAtCursorEnabledField,
  setRevealAtCursorEnabled,
} from "./structuralDecorations";
import {
  displayModeAllowsMarkupReveal,
  viewModeExtensions,
  viewModeField,
} from "./viewMode";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function mount(doc = "raw {++markup++} text") {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [...viewModeExtensions(), revealAtCursorEnabledField],
    }),
    parent: document.body,
  });
  views.push(view);
  let version = 0;
  const { rerender } = render(<DisplayModeControl view={view} version={version} />);
  const bump = () => rerender(<DisplayModeControl view={view} version={++version} />);
  return { view, bump };
}

describe("editor/DisplayModeControl (#2120, FR-ED-4)", () => {
  it("exposes all four display projections with All selected by default", () => {
    mount();
    const select = screen.getByLabelText("Display mode");
    expect(select).toHaveValue("All");
    expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "All",
      "Simple",
      "None",
      "Original",
    ]);
  });

  it("selecting a mode dispatches setDisplayMode without touching the document", () => {
    const { view, bump } = mount();
    const before = view.state.doc.toString();
    fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: "None" } });
    bump();
    expect(view.state.field(viewModeField).displayMode).toBe("None");
    expect(view.state.doc.toString()).toBe(before);
  });

  it("never rewrites the stored reveal preference while changing projections (#2389)", () => {
    const { view, bump } = mount();
    view.dispatch({ effects: setRevealAtCursorEnabled.of(false) });
    fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: "Simple" } });
    bump();
    expect(view.state.field(revealAtCursorEnabledField)).toBe(false);
    fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: "All" } });
    bump();
    expect(view.state.field(revealAtCursorEnabledField)).toBe(false);
  });

  it("suppresses reveal in clean projections and restores it for All", () => {
    const { view, bump } = mount();
    view.dispatch({ effects: setRevealAtCursorEnabled.of(true) });

    fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: "Simple" } });
    bump();
    expect(displayModeAllowsMarkupReveal(view.state)).toBe(false);
    expect(view.state.field(revealAtCursorEnabledField)).toBe(true);

    fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: "All" } });
    bump();
    expect(displayModeAllowsMarkupReveal(view.state)).toBe(true);
    expect(view.state.field(revealAtCursorEnabledField)).toBe(true);
  });

  it("cycling through every mode and back to All never mutates the document", () => {
    const { view, bump } = mount();
    const before = view.state.doc.toString();
    for (const mode of ["Simple", "None", "Original", "All"]) {
      fireEvent.change(screen.getByLabelText("Display mode"), { target: { value: mode } });
      bump();
      expect(view.state.doc.toString()).toBe(before);
    }
    expect(view.state.field(viewModeField).displayMode).toBe("All");
  });

  it("makes every overflow choice operable and identifies the active projection", () => {
    const { view } = mount();
    const entries = displayModeOverflowEntries(view, "Simple");
    expect(entries.map(({ label }) => label)).toEqual([
      "Display: All",
      "Display: Simple",
      "Display: None",
      "Display: Original",
    ]);
    expect(entries.map(({ checked }) => checked)).toEqual([false, true, false, false]);
    expect(entries[2].onSelect).toBeTypeOf("function");
    entries[2].onSelect?.();
    expect(view.state.field(viewModeField).displayMode).toBe("None");
  });
});
