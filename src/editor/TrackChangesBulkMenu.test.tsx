// @vitest-environment jsdom
// ABOUTME: Component proof of the P2b-2 toolbar dropdown acceptance: "Accept/Reject all
// ABOUTME: insertions/deletions" scoped to the whole document, each a single group-atomic decision.
import { fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackChangesBulkMenu } from "./TrackChangesBulkMenu";
import { redlineExtensions, seedTrackedChanges, trackedChanges, type ParsedChange } from "./trackedChanges";
import { rangeOf } from "./testRanges";

function ins(doc: string, id: string, inner: string): ParsedChange {
  const full = rangeOf(doc, `{++${inner}++}`);
  return { id, recorded: false, group: null, full, kind: "insertion", text: { from: full.from + 3, to: full.to - 3 } };
}
function del(doc: string, id: string, inner: string): ParsedChange {
  const full = rangeOf(doc, `{--${inner}--}`);
  return { id, recorded: false, group: null, full, kind: "deletion", text: { from: full.from + 3, to: full.to - 3 } };
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mount(doc: string, changes: ParsedChange[], onFinalDecision?: () => void) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: redlineExtensions() }),
    parent: document.body,
  });
  view.dispatch({ effects: seedTrackedChanges.of({ changes }) });
  views.push(view);
  let version = 0;
  const { rerender } = render(
    <TrackChangesBulkMenu view={view} version={version} onFinalDecision={onFinalDecision} />,
  );
  const bump = () =>
    rerender(
      <TrackChangesBulkMenu view={view} version={++version} onFinalDecision={onFinalDecision} />,
    );
  return { view, bump };
}

describe("editor/TrackChangesBulkMenu", () => {
  it("renders nothing when there is no mounted view", () => {
    const { container } = render(<TrackChangesBulkMenu view={null} version={0} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists all four type-filtered options", () => {
    const doc = "A {++i1++} B {--d2--} C";
    mount(doc, [ins(doc, "0", "i1"), del(doc, "1", "d2")]);
    for (const label of [
      "Accept all insertions",
      "Reject all insertions",
      "Accept all deletions",
      "Reject all deletions",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("disables an option with no matching pending change", () => {
    const doc = "A {++i1++} B";
    mount(doc, [ins(doc, "0", "i1")]);
    expect(screen.getByRole("button", { name: "Accept all insertions" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept all deletions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject all deletions" })).toBeDisabled();
  });

  it("Accept all insertions decides every insertion in the document — deletions stay pending", () => {
    const doc = "A {++i1++} B {++i2++} C {--d3--} D";
    const onFinalDecision = vi.fn();
    const { view, bump } = mount(
      doc,
      [ins(doc, "0", "i1"), ins(doc, "1", "i2"), del(doc, "2", "d3")],
      onFinalDecision,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));
    bump();
    expect(view.state.doc.toString()).toBe("A i1 B i2 C {--d3--} D");
    expect(trackedChanges(view.state).map((c) => c.id)).toEqual(["2"]);
    expect(onFinalDecision).not.toHaveBeenCalled();
  });

  // Names what it checks: the resulting document. The one-undo-entry claim is asserted directly in
  // `trackedChanges.test.ts`, against the transaction rather than the rendered menu.
  it("Reject all deletions keeps every deleted text and leaves nothing pending", () => {
    const doc = "A {--d1--} B {--d2--} C";
    const { view, bump } = mount(doc, [del(doc, "0", "d1"), del(doc, "1", "d2")]);
    fireEvent.click(screen.getByRole("button", { name: "Reject all deletions" }));
    bump();
    expect(view.state.doc.toString()).toBe("A d1 B d2 C");
    expect(trackedChanges(view.state)).toHaveLength(0);
  });

  // The options panel is an absolutely-positioned overlay, so a pick that left it open would keep
  // covering the document. Native `<details>` dismisses on none of these three by itself.
  describe("dismissal", () => {
    function openMenu() {
      const menu = document.querySelector("details.track-changes-bulk-menu") as HTMLDetailsElement;
      // jsdom doesn't implement summary activation, so drive the `toggle` event React listens for.
      menu.open = true;
      fireEvent(menu, new Event("toggle"));
      return menu;
    }

    it("closes when an option is picked", () => {
      const doc = "A {++i1++} B";
      const { bump } = mount(doc, [ins(doc, "0", "i1")]);
      const menu = openMenu();
      expect(menu.open).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));
      bump();
      expect(menu.open).toBe(false);
    });

    it("closes on Escape", () => {
      const doc = "A {++i1++} B";
      mount(doc, [ins(doc, "0", "i1")]);
      const menu = openMenu();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(menu.open).toBe(false);
    });

    it("closes on a click outside it but not on a click inside", () => {
      const doc = "A {++i1++} B";
      mount(doc, [ins(doc, "0", "i1")]);
      const menu = openMenu();
      fireEvent.mouseDown(menu);
      expect(menu.open).toBe(true);
      fireEvent.mouseDown(document.body);
      expect(menu.open).toBe(false);
    });
  });
});
