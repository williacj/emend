// @vitest-environment jsdom
// ABOUTME: Integration test binding a live CodeMirror view to the redline toolbar + popover (P2a-5):
// ABOUTME: click-any-redline and ◀ n/N ▶ nav both open the popover, and every entry point decides
// ABOUTME: through the one path, advancing to the next pending change.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { RedlineReview } from "./RedlineReview";
import { redlineExtensions, seedTrackedChanges, type ParsedChange } from "./trackedChanges";
import { rangeOf } from "./testRanges";

function ins(doc: string, id: string, inner: string): ParsedChange {
  const full = rangeOf(doc, `{++${inner}++}`);
  return { id, recorded: false, group: null, full, kind: "insertion", text: { from: full.from + 3, to: full.to - 3 } };
}
function del(doc: string, id: string, inner: string): ParsedChange {
  const full = rangeOf(doc, `{--${inner}--}`);
  return { id, recorded: false, group: null, full, kind: "deletion", text: { from: full.from + 3, to: full.to - 3 } };
}
function sub(doc: string, id: string, o: string, n: string): ParsedChange {
  const full = rangeOf(doc, `{~~${o}~>${n}~~}`);
  return {
    id,
    recorded: false,
    group: null,
    full,
    kind: "substitution",
    old: { from: full.from + 3, to: full.from + 3 + o.length },
    new: { from: full.to - 3 - n.length, to: full.to - 3 },
  };
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

/** Mount a live view + the review UI, returning a `bump()` that re-renders after a view change
 * (the real editor's updateListener does this) and the clickBridge the editor would call on click. */
function mount(doc: string, changes: ParsedChange[], embedded = false) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), redlineExtensions()] }),
    parent: document.body,
  });
  view.dispatch({ effects: seedTrackedChanges.of({ changes }) });
  views.push(view);
  const clickBridge: { current: ((pos: number) => void) | null } = { current: null };
  let version = 0;
  const { rerender } = render(
    <RedlineReview view={view} version={version} clickBridge={clickBridge} embedded={embedded} />,
  );
  const bump = () =>
    rerender(<RedlineReview view={view} version={++version} clickBridge={clickBridge} embedded={embedded} />);
  return { view, clickBridge, bump };
}

describe("editor/RedlineReview", () => {
  const doc = "The {++quick ++}fox {~~over~>above~~} it";
  const changes = () => [ins(doc, "0", "quick "), sub(doc, "1", "over", "above")];

  it("shows the pending count in the toolbar", () => {
    mount(doc, changes());
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("clicking a redline opens its popover (no mode required)", () => {
    const { clickBridge, bump } = mount(doc, changes());
    act(() => clickBridge.current?.(rangeOf(doc, "above").from));
    bump();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Removed text").textContent).toBe("over");
    expect(screen.getByLabelText("Added text").textContent).toBe("above");
  });

  it("stepping ▶ opens the popover for the next change", () => {
    const { bump } = mount(doc, changes());
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    bump();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Accept from the toolbar decides the current change and advances", () => {
    const { view, bump } = mount(doc, changes());
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));
    bump();
    expect(view.state.doc.toString()).toBe("The quick fox {~~over~>above~~} it");
    // One change left; toolbar now reads 1 / 1.
    expect(screen.getByText("1 / 1")).toBeTruthy();
  });

  function expectEmbeddedFinalDecision(label: string, detail: number, expected: string) {
    const source = "{++word++}";
    const change = ins(source, "only", "word");
    const { view, bump } = mount(source, [change], true);
    const button = screen.getByRole("button", { name: label });
    button.focus();

    fireEvent.click(button, { detail });
    bump();

    expect(view.state.doc.toString()).toBe(expected);
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.head).toBe(0);
  }

  it("embedded final Accept hands focus to the decided change in the document", () => {
    expectEmbeddedFinalDecision("✓ Accept", 0, "word");
  });

  it("embedded final Reject hands focus to the decided change in the document", () => {
    expectEmbeddedFinalDecision("✗ Reject", 1, "");
  });

  it("embedded final bulk decision hands focus to the first decided change in the document", () => {
    const source = "A {++word++}";
    const change = ins(source, "only", "word");
    const { view, bump } = mount(source, [change], true);
    const button = screen.getByRole("button", { name: "Accept all insertions" });
    button.focus();

    fireEvent.click(button);
    bump();

    expect(view.state.doc.toString()).toBe("A word");
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.head).toBe(change.full.from);
  });

  function expectMappedBulkFocus(
    label: string,
    source: string,
    makeChange: typeof ins,
  ) {
    const first = makeChange(source, "first", "one");
    const second = makeChange(source, "second", "two");
    const { view, clickBridge, bump } = mount(source, [first, second], true);
    act(() => clickBridge.current?.(second.full.from + 3));
    bump();
    const button = screen.getByRole("button", { name: label });
    button.focus();

    fireEvent.click(button);
    bump();

    expect(view.state.doc.toString()).toBe("A one B two C");
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.head).toBe(8);
    expect(view.state.selection.main.head).toBeLessThan(view.state.doc.length);
  }

  it("Accept all insertions maps a later current change through every bulk replacement before focusing", () => {
    expectMappedBulkFocus("Accept all insertions", "A {++one++} B {++two++} C", ins);
  });

  it("Reject all deletions maps a later current change through every bulk replacement before focusing", () => {
    expectMappedBulkFocus("Reject all deletions", "A {--one--} B {--two--} C", del);
  });

  function expectMappedGroupedDirectFocus(
    label: string,
    source: string,
    makeChange: typeof ins,
  ) {
    const group = "grp-related";
    const first = { ...makeChange(source, "first", "one"), recorded: true, group };
    const second = { ...makeChange(source, "second", "two"), recorded: true, group };
    const { view, clickBridge, bump } = mount(source, [first, second], true);
    act(() => clickBridge.current?.(second.full.from + 3));
    bump();
    const review = screen.getByRole("group", { name: "Review changes" });
    const button = within(review).getByRole("button", { name: label });
    button.focus();

    fireEvent.click(button);
    bump();

    expect(view.state.doc.toString()).toBe("A one B two C");
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
    return view;
  }

  it("direct Accept maps a later current insertion through its recorded group transaction before focusing", () => {
    const view = expectMappedGroupedDirectFocus("✓ Accept", "A {++one++} B {++two++} C", ins);
    expect(view.state.selection.main.head).toBe(8);
  });

  it("direct Reject maps a later current deletion through its recorded group transaction before focusing", () => {
    const view = expectMappedGroupedDirectFocus("✗ Reject", "A {--one--} B {--two--} C", del);
    expect(view.state.selection.main.head).toBe(8);
  });

  it("embedded toolbar focus stays on the same control while another change remains", () => {
    const { bump } = mount(doc, changes(), true);
    const button = screen.getByRole("button", { name: "✓ Accept" });
    button.focus();

    fireEvent.click(button);
    bump();

    expect(screen.getByRole("group", { name: "Review changes" })).toBeTruthy();
    expect(document.activeElement).toBe(button);
  });

  it("standalone final toolbar behavior remains inert at zero without forcing editor focus", () => {
    const source = "{++word++}";
    const { view, bump } = mount(source, [ins(source, "only", "word")]);
    const button = screen.getByRole("button", { name: "✓ Accept" });
    button.focus();

    fireEvent.click(button);
    bump();

    expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy();
    expect(screen.getByText("0 / 0")).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(view.contentDOM);
  });

  it("Reject from the popover decides that change and closes the popover when none remain", () => {
    const { view, clickBridge, bump } = mount(doc, changes());
    act(() => clickBridge.current?.(rangeOf(doc, "above").from));
    bump();
    // Both the toolbar and the open popover expose a Reject; decide via the popover's.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "✗ Reject" }));
    bump();
    expect(view.state.doc.toString()).toBe("The {++quick ++}fox over it");
  });

  it("Accept from the popover refocuses the editor so a subsequent Cmd/Ctrl+S still reaches it (P2a-5)", () => {
    const { view, clickBridge, bump } = mount(doc, changes());
    act(() => clickBridge.current?.(rangeOf(doc, "above").from));
    bump();
    const acceptButton = within(screen.getByRole("dialog")).getByRole("button", { name: "✓ Accept" });
    // Real browsers focus a button as part of clicking it; simulate that so the popover's unmount
    // (which drops the button along with whatever DOM focus it held) is exercised realistically.
    acceptButton.focus();
    fireEvent.click(acceptButton);
    bump();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("Reject from the popover refocuses the editor even when the popover stays open for the next change", () => {
    const { view, clickBridge, bump } = mount(doc, changes());
    act(() => clickBridge.current?.(rangeOf(doc, "above").from));
    bump();
    const rejectButton = within(screen.getByRole("dialog")).getByRole("button", { name: "✗ Reject" });
    rejectButton.focus();
    fireEvent.click(rejectButton);
    bump();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("the type-filtered bulk dropdown (P2b-2) decides every insertion — the substitution stays pending", () => {
    const { view, bump } = mount(doc, changes());
    fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));
    bump();
    expect(view.state.doc.toString()).toBe("The quick fox {~~over~>above~~} it");
    expect(screen.getByText("1 / 1")).toBeTruthy();
  });

  // ux-design §4's track-changes cluster ("nav / accept-reject / type-filtered bulk / display
  // mode") is one row — pin that the bulk dropdown lives inside the toolbar's own row, not as a
  // separate, unstyled sibling row.
  it("renders the type-filtered bulk dropdown inside the toolbar's own row (ux-design §4 cluster)", () => {
    mount(doc, changes());
    const toolbar = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(toolbar).getByRole("button", { name: "Accept all insertions" })).toBeTruthy();
  });

  it("renders an inert toolbar when there are no pending changes", () => {
    mount("clean text", []);
    expect(screen.getByText("0 / 0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "✓ Accept" })).toHaveProperty("disabled", true);
  });

  // The bridge is cleared on unmount so a late editor mousedown can't call into a dead component.
  it("clears the click bridge on unmount", () => {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: redlineExtensions() }),
      parent: document.body,
    });
    view.dispatch({ effects: seedTrackedChanges.of({ changes: changes() }) });
    views.push(view);
    const clickBridge: { current: ((pos: number) => void) | null } = { current: null };
    const { unmount } = render(<RedlineReview view={view} version={0} clickBridge={clickBridge} />);
    expect(clickBridge.current).not.toBeNull();
    unmount();
    expect(clickBridge.current).toBeNull();
  });
});
