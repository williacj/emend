// @vitest-environment jsdom
// ABOUTME: Component proof for the Rich text/Markdown view control and display-mode selector.
// ABOUTME: Their effects change only editor projections, never document text or cursor position.
import { fireEvent, render, screen } from "@testing-library/react";
import { history } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchAddressTrigger } from "../comments/BatchAddressTrigger";
import { NO_BATCH_FILTER, type BatchAddressFilter } from "../comments/batchAddress";
import { thread } from "../comments/threadFixture";
import {
  beginAppStatusRequest,
  getAppStatus,
  setUserAppStatus,
  subscribeAppStatus,
} from "../stores/appStatus";
import { formatCommandExtensions } from "./formatCommands";
import { markdownLanguage } from "./markdownLanguage";
import { ViewModeToolbar, type TimelineReturnControl } from "./ViewModeToolbar";
import { revealAtCursorEnabledField } from "./structuralDecorations";
import { setDisplayMode, setSourceView, viewModeExtensions, viewModeField } from "./viewMode";

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mount(
  doc = "raw {++markup++} text",
  selection: number | { anchor: number; head?: number } = 5,
  extensions: Extension = [],
  publish = true,
  platform?: "win" | "mac",
  timelineReturn?: TimelineReturnControl,
  batchAddressControl?: ReactNode,
) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: typeof selection === "number" ? { anchor: selection } : selection,
      extensions: [
        history(),
        markdownLanguage.extension,
        ...formatCommandExtensions(),
        ...viewModeExtensions(),
        revealAtCursorEnabledField,
        extensions,
      ],
    }),
    parent: document.body,
  });
  if (publish) forceParsing(view, view.state.doc.length, 2_000);
  views.push(view);
  let version = 0;
  const { rerender, unmount } = render(
    <ViewModeToolbar view={view} version={version} platform={platform} timelineReturn={timelineReturn} batchAddressControl={batchAddressControl} />,
  );
  const bump = () =>
    rerender(<ViewModeToolbar view={view} version={++version} platform={platform} timelineReturn={timelineReturn} batchAddressControl={batchAddressControl} />);
  const setTimelinePending = (pending: boolean) => {
    if (!timelineReturn) throw new Error("No Timeline return control");
    timelineReturn = { ...timelineReturn, pending };
    rerender(<ViewModeToolbar view={view} version={++version} platform={platform} timelineReturn={timelineReturn} batchAddressControl={batchAddressControl} />);
  };
  return { view, bump, setTimelinePending, unmount };
}

function withNarrowToolbarMeasurement(width: 600 | 446 | 364 | 263, run: (setWidth: (next: number) => void) => void) {
  let measuredWidth: number = width;
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const getComputedStyle = window.getComputedStyle;
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = getComputedStyle.call(window, element, pseudo);
    if (!(element instanceof HTMLElement) || !element.classList.contains("view-mode-toolbar")) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "paddingLeft" || key === "paddingRight") return "14px";
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.classList.contains("view-mode-toolbar")) return measuredWidth;
      return clientWidth?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement) {
        if (this.classList.contains("view-mode-toolbar__editor-view")) return 140;
        if (this.dataset.toolbarControl === "editor-view") return 140;
        if (this.dataset.toolbarControl === "format-group") return 130;
        if (this.dataset.toolbarControl === "comment-address-all") return 118;
        if (this.dataset.toolbarControl === "timeline") {
          if (measuredWidth === 263) return 44;
          if (measuredWidth === 446) return this.querySelector(".timeline-host__permission-space") ? 140 :
            this.querySelector(".timeline-host__permission-badge") ? 140 : 120;
          return 120;
        }
      }
      return offsetWidth?.get?.call(this) ?? 0;
    },
  });
  try {
    run((next) => {
      measuredWidth = next;
      fireEvent(window, new Event("resize"));
    });
  } finally {
    window.getComputedStyle = getComputedStyle;
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
    else delete (HTMLElement.prototype as unknown as { offsetWidth?: number }).offsetWidth;
  }
}

beforeEach(() => beginAppStatusRequest());

describe("editor/ViewModeToolbar — collapsed permission transitions (#2540)", () => {
  it("keeps Address all filter and held opt-in when the same document moves through toolbar overflow", () => {
    withNarrowToolbarMeasurement(600, (setWidth) => {
      const { view, unmount } = mount("word", 0, [], true, "win");
      unmount();
      function ToolbarWithBatch() {
        const [filter, setFilter] = useState<BatchAddressFilter>(NO_BATCH_FILTER);
        const [includedHeldKey, setIncludedHeldKey] = useState<string | null>(null);
        return <ViewModeToolbar view={view} version={0} platform="win" batchAddressControl={
          <BatchAddressTrigger threads={[thread("style", { skill: "style" }), thread("human"),
            thread("held", { skill: "style", pending_run: "run-live" })]}
            onAddressAll={vi.fn()} floatingPanel filter={filter} onFilterChange={setFilter}
            includedHeldKey={includedHeldKey} onIncludedHeldKeyChange={setIncludedHeldKey}
            liveRunIds={["run-live"]} />
        } />;
      }
      render(<ToolbarWithBatch />);
      fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
      fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
      fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
      expect(screen.getByRole("checkbox", { name: "include them too" })).toBeChecked();
      fireEvent.keyDown(screen.getByLabelText("Source"), { key: "Escape" });

      setWidth(263);
      expect(document.querySelector('[data-toolbar-control="comment-address-all"]'))
        .toHaveAttribute("data-overflowed", "true");
      fireEvent.keyDown(screen.getByRole("button", { name: "More editor controls" }), { key: "ArrowDown" });
      fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
      expect(screen.getByLabelText("Source")).toHaveValue("style");
      expect(screen.getByRole("checkbox", { name: "include them too" })).toBeChecked();

      fireEvent.keyDown(screen.getByLabelText("Source"), { key: "Escape" });
      setWidth(600);
      expect(document.querySelector('[data-toolbar-control="comment-address-all"]'))
        .not.toHaveAttribute("data-overflowed", "true");
      fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
      expect(screen.getByLabelText("Source")).toHaveValue("style");
      expect(screen.getByRole("checkbox", { name: "include them too" })).toBeChecked();
    });
  });

  it("returns Escape focus to the visible overflow invoker after opening Address all at 900px", () => {
    withNarrowToolbarMeasurement(263, () => {
      mount("word", 0, [], true, "win", {
        pending: false,
        onActivate: vi.fn(),
      }, <BatchAddressTrigger threads={[thread("a"), thread("b")]} onAddressAll={vi.fn()} floatingPanel />);
      expect(document.querySelector('[data-toolbar-control="comment-address-all"]'))
        .toHaveAttribute("data-overflowed", "true");
      const more = screen.getByRole("button", { name: "More editor controls" });
      fireEvent.keyDown(more, { key: "ArrowDown" });
      fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
      expect(screen.getByLabelText("Source")).toHaveFocus();
      expect(more).toHaveAttribute("aria-expanded", "false");
      fireEvent.keyDown(screen.getByLabelText("Source"), { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Address comments" })).toBeNull();
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more).toHaveFocus();
    });
  });

  it("#2641 900px moves editor view after format while keeping Timeline inline", () => {
    withNarrowToolbarMeasurement(263, () => {
      const { view, bump, setTimelinePending } = mount("word", { anchor: 0, head: 4 }, [], true, "win", {
        pending: false,
        onActivate: vi.fn(),
      });
      const beforeSelection = view.state.selection;
      const editorView = document.querySelector<HTMLElement>('[data-toolbar-control="editor-view"]');
      const format = document.querySelector<HTMLElement>('[data-toolbar-control="format-group"]');
      const timeline = document.querySelector<HTMLElement>('[data-toolbar-control="timeline"]');
      expect(editorView).toHaveAttribute("data-overflowed", "true");
      expect(format).toHaveAttribute("data-overflowed", "true");
      expect(timeline).not.toHaveAttribute("data-overflowed", "true");

      const more = screen.getByRole("button", { name: "More editor controls" });
      fireEvent.keyDown(more, { key: "ArrowDown" });
      const markdown = screen.getByRole("dialog", { name: "More editor controls" })
        .querySelector<HTMLButtonElement>('button[aria-pressed="false"]:not([aria-label])');
      expect(markdown).toHaveTextContent("Markdown");
      fireEvent.click(markdown!);
      bump();
      expect(view.state.field(viewModeField).sourceView).toBe(true);
      expect(view.state.doc.toString()).toBe("word");
      expect(view.state.selection.eq(beforeSelection)).toBe(true);
      expect(more).toHaveAttribute("aria-expanded", "false");

      setTimelinePending(true);
      expect(editorView).toHaveAttribute("data-overflowed", "true");
      expect(timeline).not.toHaveAttribute("data-overflowed", "true");
    });
  });

  function expectClearKeepsHost(width: 364 | 263) {
    withNarrowToolbarMeasurement(width, () => {
      const { setTimelinePending } = mount("word", 0, [], true, "win", {
        pending: true,
        onActivate: vi.fn(),
      });
      const chip = screen.getByRole("button", { name: "Show permission request in Timeline" });
      expect(chip.closest('[data-toolbar-control="timeline"]')).not.toHaveAttribute("data-overflowed", "true");
      chip.focus();

      setTimelinePending(false);

      expect(document.querySelector(".timeline-host__collapsed-action")).toBe(chip);
      expect(chip).toHaveAttribute("aria-label", "Show Timeline");
      expect(chip).toHaveFocus();
      expect(screen.getByRole("button", { name: "More editor controls" })).not.toHaveFocus();
    });
  }

  function expectArrivalKeepsHost(width: 364 | 263) {
    withNarrowToolbarMeasurement(width, () => {
      const { setTimelinePending } = mount("word", 0, [], true, "win", {
        pending: false,
        onActivate: vi.fn(),
      });
      const more = screen.getByRole("button", { name: "More editor controls" });
      fireEvent.keyDown(more, { key: "ArrowDown" });
      expect(more).toHaveAttribute("aria-expanded", "true");
      const chip = screen.getByRole("button", { name: "Show Timeline" });
      expect(chip.closest('[data-toolbar-control="timeline"]')).not.toHaveAttribute("data-overflowed", "true");
      chip.focus();
      expect(chip).toHaveFocus();

      setTimelinePending(true);

      expect(screen.getByRole("button", { name: "Show permission request in Timeline" })).toBe(chip);
      expect(chip).toHaveFocus();
      expect(more).toHaveAttribute("aria-expanded", "true");
    });
  }

  it("keeps focused Timeline host stable when permission clears", () => expectClearKeepsHost(364));
  it("does not move focus when permission arrives on an open narrow toolbar", () => expectArrivalKeepsHost(364));
  it("keeps the 900px compact host stable when permission clears", () => expectClearKeepsHost(263));
  it("keeps the 900px compact host focused when permission arrives with keyboard-open overflow", () => expectArrivalKeepsHost(263));

  it("preserves a focused format action across permission arrival at the fit threshold", () => {
    withNarrowToolbarMeasurement(446, () => {
      const { setTimelinePending } = mount("word", 0, [], true, "win", {
        pending: false,
        onActivate: vi.fn(),
      });
      const formatSlot = document.querySelector<HTMLElement>('[data-toolbar-control="format-group"]')!;
      expect(formatSlot).toHaveAttribute("data-overflowed", "true");
      const more = screen.getByRole("button", { name: "More editor controls" });
      fireEvent.keyDown(more, { key: "ArrowDown" });
      expect(more).toHaveAttribute("aria-expanded", "true");
      const bold = formatSlot.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')!;
      bold.focus();
      expect(bold).toHaveFocus();
      expect(formatSlot).toHaveAttribute("data-overflowed", "true");
      expect(document.querySelector<HTMLElement>('[data-toolbar-control="timeline"]')?.offsetWidth).toBe(140);
      expect(document.querySelector(".timeline-host__permission-badge")).toBeNull();

      setTimelinePending(true);
      expect(document.querySelector<HTMLElement>('[data-toolbar-control="timeline"]')?.offsetWidth).toBe(140);

      expect(document.querySelector('[data-toolbar-control="format-group"]')).toBe(formatSlot);
      expect(document.querySelector('button[aria-label="Bold"]')).toBe(bold);
      expect(bold).toHaveFocus();
      expect(formatSlot).toHaveAttribute("data-overflowed", "true");
      expect(more).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector('[data-toolbar-control="timeline"]')).not.toHaveAttribute("data-overflowed", "true");
    });
  });
});

describe("editor/ViewModeToolbar — rendering", () => {
  it("renders nothing before the view has mounted", () => {
    const { container } = render(<ViewModeToolbar view={null} version={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows exactly Rich text and Markdown with Rich text selected by default and no Display control", () => {
    mount();
    const options = screen.getByRole("group", { name: "Editor view" }).querySelectorAll("button");
    expect([...options].map((option) => option.textContent)).toEqual(["Rich text", "Markdown"]);
    expect(screen.getByRole("button", { name: "Rich text" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("Display mode")).toBeNull();
  });

  it("renders exact glyphs, names, and platform-resolved native titles", () => {
    const { unmount } = mount("word", { anchor: 0, head: 4 }, [], true, "win");
    const group = screen.getByRole("group", { name: "Formatting" });
    const buttons = [...group.querySelectorAll("button")];

    expect(buttons.map((button) => button.textContent)).toEqual(["B", "I", "H1", "≔"]);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Heading 1",
      "Bulleted list",
    ]);
    expect(buttons.map((button) => button.title)).toEqual([
      "Bold (Ctrl+B)",
      "Italic (Ctrl+I)",
      "Heading 1",
      "Bulleted list",
    ]);
    expect(buttons.map((button) => button.className)).toEqual([
      "view-mode-toolbar__format-option view-mode-toolbar__format-option--inline",
      "view-mode-toolbar__format-option view-mode-toolbar__format-option--inline",
      "view-mode-toolbar__format-option view-mode-toolbar__format-option--block",
      "view-mode-toolbar__format-option view-mode-toolbar__format-option--block",
    ]);

    unmount();
    mount("word", { anchor: 0, head: 4 }, [], true, "mac");
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("title", "Bold (⌘B)");
    expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("title", "Italic (⌘I)");
  });

  it("reports semantic pressed truth and keeps it across Rich text/Markdown projection changes", () => {
    const { view, bump } = mount("***word***\n\n# heading\n\n- item", { anchor: 3, head: 7 });
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Heading 1" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Bulleted list" })).toHaveAttribute("aria-pressed", "false");

    view.dispatch({ effects: setSourceView.of(true) });
    bump();
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true");
  });

  it("maps each control's exact semantic state to its own pressed truth", () => {
    const cases = [
      ["Bold", "**word**", { anchor: 2, head: 6 }],
      ["Italic", "*word*", { anchor: 1, head: 5 }],
      ["Heading 1", "# heading", { anchor: 3 }],
      ["Bulleted list", "- item", { anchor: 3 }],
    ] as const;
    for (const [name, doc, selection] of cases) {
      const { unmount } = mount(doc, selection);
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
      unmount();
    }
  });

  it("keeps each pending control focusable, neutral, stable, and silently inert", () => {
    const prefix = "plain prose\n\n".repeat(80_000);
    const { view } = mount(`${prefix}word`, { anchor: prefix.length, head: prefix.length + 4 }, [], false);
    const bold = screen.getByRole("button", { name: "Bold" });
    const before = { doc: view.state.doc.toString(), selection: view.state.selection };

    expect(bold).not.toHaveAttribute("aria-pressed");
    expect(bold).toHaveAttribute("aria-disabled", "true");
    expect(bold).toHaveAttribute("aria-busy", "true");
    expect(bold).not.toBeDisabled();
    expect(document.getElementById(bold.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Formatting state is still loading.",
    );
    setUserAppStatus("Existing requested-action status.");
    const existingStatus = getAppStatus();
    bold.focus();
    fireEvent.click(bold, { detail: 0 });
    expect(document.activeElement).toBe(bold);
    expect(getAppStatus()).toBe(existingStatus);

    view.focus();
    expect(document.activeElement).toBe(view.contentDOM);
    // A browser focuses a pointer target before dispatching click; model that transfer explicitly.
    bold.focus();
    fireEvent.click(bold, { detail: 1 });
    expect(document.activeElement).toBe(view.contentDOM);
    expect(getAppStatus()).toBe(existingStatus);
    expect(view.state.doc.toString()).toBe(before.doc);
    expect(view.state.selection.eq(before.selection)).toBe(true);
  });

  it("resolves pending controls in place after publication without moving focus, selection, or scroll", () => {
    const prefix = "plain prose\n\n".repeat(80_000);
    const { view, bump } = mount(
      `${prefix}**word**`,
      { anchor: prefix.length + 2, head: prefix.length + 6 },
      [],
      false,
    );
    const bold = screen.getByRole("button", { name: "Bold" });
    const selection = view.state.selection;
    bold.focus();
    view.scrollDOM.scrollTop = 23;

    expect(bold).toHaveAttribute("aria-busy", "true");
    expect(forceParsing(view, view.state.doc.length, 20_000)).toBe(true);
    bump();

    expect(screen.getByRole("button", { name: "Bold" })).toBe(bold);
    expect(bold).toHaveAttribute("aria-pressed", "true");
    expect(bold).not.toHaveAttribute("aria-disabled");
    expect(document.activeElement).toBe(bold);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(view.scrollDOM.scrollTop).toBe(23);
  });

  it("routes every format control through its source command", () => {
    const cases = [
      ["Bold", "word", { anchor: 0, head: 4 }, "**word**"],
      ["Italic", "word", { anchor: 0, head: 4 }, "*word*"],
      ["Heading 1", "word", { anchor: 1 }, "# word"],
      ["Bulleted list", "word", { anchor: 1 }, "- word"],
    ] as const;
    for (const [name, doc, selection, expected] of cases) {
      const { view, unmount } = mount(doc, selection);
      fireEvent.click(screen.getByRole("button", { name }), { detail: 1 });
      expect(view.state.doc.toString(), name).toBe(expected);
      unmount();
    }
  });

  it("routes a command's exact refusal sentence to the shared app status", () => {
    mount("`code`", { anchor: 1, head: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Italic" }), { detail: 1 });
    expect(getAppStatus()?.authorMessage).toBe(
      "Italic isn't available for this selection because it includes code.",
    );
  });

  it("starts every format request so a repeated refusal re-announces and later success clears it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppStatus(listener);
    const { view, bump } = mount("`code`", { anchor: 1, head: 5 });
    const italic = screen.getByRole("button", { name: "Italic" });

    fireEvent.click(italic, { detail: 1 });
    const first = getAppStatus();
    fireEvent.click(italic, { detail: 1 });
    expect(getAppStatus()).not.toBe(first);
    expect(getAppStatus()?.authorMessage).toBe(
      "Italic isn't available for this selection because it includes code.",
    );
    expect(listener).toHaveBeenCalledTimes(3);

    setUserAppStatus("An older requested-action status.");
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "word" },
      selection: { anchor: 0, head: 4 },
    });
    forceParsing(view, view.state.doc.length, 2_000);
    bump();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }), { detail: 1 });
    expect(view.state.doc.toString()).toBe("**word**");
    expect(getAppStatus()).toBeNull();
    unsubscribe();
  });

  it("restores editor focus after pointer activation and retains button focus for keyboard activation", () => {
    const { view, bump } = mount("word", { anchor: 0, head: 4 });
    const bold = screen.getByRole("button", { name: "Bold" });
    view.focus();
    fireEvent.click(bold, { detail: 1 });
    expect(document.activeElement).toBe(view.contentDOM);

    bump();
    const updatedBold = screen.getByRole("button", { name: "Bold" });
    updatedBold.focus();
    fireEvent.click(updatedBold, { detail: 0 });
    expect(document.activeElement).toBe(updatedBold);
  });

  it("preserves known pressed truth while read-only controls are disabled", () => {
    const { view, bump } = mount("**word**", { anchor: 2, head: 6 });
    view.dispatch({ effects: setDisplayMode.of("None") });
    bump();
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold).toHaveAttribute("aria-pressed", "true");
    expect(bold).toBeDisabled();
    fireEvent.click(bold);
    expect(view.state.doc.toString()).toBe("**word**");
  });
});

describe("editor/ViewModeToolbar — editor view", () => {
  it("clicking Markdown dispatches setSourceView without touching the document or selection", () => {
    const { view, bump } = mount("raw {++markup++} text", 5);
    const before = { doc: view.state.doc.toString(), cursor: view.state.selection.main.head };

    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    bump();

    expect(view.state.field(viewModeField).sourceView).toBe(true);
    expect(screen.getByRole("button", { name: "Rich text" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "true");
    expect(view.state.doc.toString()).toBe(before.doc);
    expect(view.state.selection.main.head).toBe(before.cursor);
  });

  it("clicking Rich text switches source view back off", () => {
    const { view, bump } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    bump();
    fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
    bump();
    expect(view.state.field(viewModeField).sourceView).toBe(false);
  });

  it("reflects live viewModeField state after an external dispatch", () => {
    const { view, bump } = mount();
    view.dispatch({ effects: setSourceView.of(true) });
    bump();
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switching editor view leaves the separate Display projection unchanged", () => {
    const { view, bump } = mount();
    view.dispatch({ effects: setDisplayMode.of("Simple") });
    bump();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    bump();
    expect(view.state.field(viewModeField)).toEqual({ sourceView: true, displayMode: "Simple" });
  });
});
