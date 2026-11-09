// @vitest-environment jsdom
// ABOUTME: Integration proof for the shared document surface's J14 format keymap and parse refresh.
// ABOUTME: Pins pending-status ownership, read-only handling, and pathless/file-backed composition.
import { forceParsing } from "@codemirror/language";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { act, createRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAppStatusRequest,
  getAppStatus,
  setUserAppStatus,
  subscribeAppStatus,
} from "../stores/appStatus";
import { DocumentSurface, type DocumentSurfaceHandle } from "./DocumentSurface";
import { isMac } from "./keymap";
import { seedTrackedChanges, type ParsedChange } from "./trackedChanges";
import { setDisplayMode } from "./viewMode";

vi.mock("./ipc", async (importActual) => {
  const actual = await importActual<typeof import("./ipc")>();
  return { ...actual, parseChanges: vi.fn().mockResolvedValue([]) };
});

function pressMod(view: EditorView, key: "b" | "i"): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    }),
    "editor",
  );
}

function mount(content: string, parseDocument: null | { root: string; path: string } = null) {
  const ref = createRef<DocumentSurfaceHandle>();
  render(<DocumentSurface ref={ref} platform="win" />);
  let view!: EditorView;
  act(() => {
    view = ref.current!.mount({ content, parseDocument, parseGeneration: null });
  });
  return view;
}

describe("editor/DocumentSurface — shared format UI integration (#2414)", () => {
  beforeEach(() => beginAppStatusRequest());

  it("installs inventory Mod-B/Mod-I ahead of defaults and keeps focus and mapped target", () => {
    const view = mount("one two");
    act(() => {
      forceParsing(view, view.state.doc.length, 2_000);
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 3 } });
      expect(pressMod(view, "b")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("**one** two");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("one");
    expect(document.activeElement).toBe(view.contentDOM);

    act(() => expect(pressMod(view, "i")).toBe(true));
    expect(view.state.doc.toString()).toBe("***one*** two");
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("handles a cold pending shortcut once, never edits or replays it, and clears only its owned status", async () => {
    const prefix = "plain prose\n\n".repeat(80_000);
    const view = mount(`${prefix}word`);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: prefix.length, head: prefix.length + 4 } });
    });
    const selection = view.state.selection;
    const source = view.state.doc.toString();

    act(() => expect(pressMod(view, "b")).toBe(true));
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    expect(document.activeElement).toBe(view.contentDOM);
    expect(getAppStatus()?.authorMessage).toBe(
      "Formatting is still loading for this part of the document. Try again in a moment.",
    );

    act(() => forceParsing(view, view.state.doc.length, 20_000));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false"),
    );
    expect(getAppStatus()).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.toJSON()).toEqual(selection.toJSON());

    act(() => expect(pressMod(view, "b")).toBe(true));
    expect(view.state.doc.toString()).toBe(`${prefix}**word**`);
  });

  it("does not clear a newer shared status when an earlier pending target resolves", () => {
    const prefix = "plain prose\n\n".repeat(80_000);
    const view = mount(`${prefix}word`);
    act(() => {
      view.dispatch({ selection: { anchor: prefix.length, head: prefix.length + 4 } });
      expect(pressMod(view, "i")).toBe(true);
    });
    setUserAppStatus("A newer requested action owns this line.");

    act(() => forceParsing(view, view.state.doc.length, 20_000));
    expect(getAppStatus()?.authorMessage).toBe("A newer requested action owns this line.");
  });

  it("clears its pending status when the exact target changes and does not replay the shortcut", () => {
    const prefix = "plain prose\n\n".repeat(80_000);
    const view = mount(`${prefix}word`);
    act(() => {
      view.dispatch({ selection: { anchor: prefix.length, head: prefix.length + 4 } });
      expect(pressMod(view, "b")).toBe(true);
    });
    expect(getAppStatus()).not.toBeNull();

    act(() => view.dispatch({ selection: { anchor: 0 } }));
    expect(getAppStatus()).toBeNull();
    expect(view.state.doc.toString()).toBe(`${prefix}word`);
  });

  it("routes the command layer's known shortcut refusal verbatim and leaves focus and selection", () => {
    const view = mount("`code`");
    act(() => {
      forceParsing(view, view.state.doc.length, 2_000);
      view.focus();
      view.dispatch({ selection: { anchor: 1, head: 5 } });
      expect(pressMod(view, "b")).toBe(true);
    });
    expect(getAppStatus()?.authorMessage).toBe(
      "Bold isn't available for this selection because it includes code.",
    );
    expect(view.state.doc.toString()).toBe("`code`");
    expect(view.state.selection.toJSON()).toEqual({
      ranges: [{ anchor: 1, head: 5 }],
      main: 0,
    });
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("handles read-only shortcuts without mutation while preserving pressed toolbar truth", () => {
    const view = mount("**word**");
    act(() => {
      forceParsing(view, view.state.doc.length, 2_000);
      view.dispatch({ selection: { anchor: 2, head: 6 }, effects: setDisplayMode.of("None") });
      expect(pressMod(view, "b")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("**word**");
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
    expect(getAppStatus()).toBeNull();
  });

  it("renders the same live format group for pathless and file-backed surface owners", () => {
    mount("pathless");
    expect(screen.getAllByRole("group", { name: "Formatting" })).toHaveLength(1);

    mount("file backed", { root: "/project", path: "draft.md" });
    expect(screen.getAllByRole("group", { name: "Formatting" })).toHaveLength(2);
  });

  it("composes live redline controls into the one document toolbar before notices and omits an empty context", () => {
    const ref = createRef<DocumentSurfaceHandle>();
    render(
      <DocumentSurface
        ref={ref}
        platform="win"
        beforeHost={<div data-testid="document-notice">Notice</div>}
      />,
    );
    let view!: EditorView;
    act(() => {
      view = ref.current!.mount({
        content: "{++change++} rest",
        parseDocument: null,
        parseGeneration: null,
      });
    });
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();

    const parsed: ParsedChange = {
      id: "change-1",
      recorded: false,
      group: null,
      full: { from: 0, to: 12 },
      kind: "insertion",
      text: { from: 3, to: 9 },
    };
    act(() => view.dispatch({ effects: seedTrackedChanges.of({ changes: [parsed] }) }));

    const toolbar = screen.getByRole("toolbar", { name: "Editor view controls" });
    expect(screen.getAllByRole("toolbar")).toEqual([toolbar]);
    expect(within(toolbar).getByRole("group", { name: "Formatting" })).toBeTruthy();
    const review = within(toolbar).getByRole("group", { name: "Review changes" });
    expect(within(review).getByRole("button", { name: "✓ Accept" })).toBeTruthy();
    expect(
      toolbar.compareDocumentPosition(screen.getByTestId("document-notice")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const accept = within(review).getByRole("button", { name: "✓ Accept" });
    accept.focus();
    fireEvent.click(accept);
    expect(view.state.doc.toString()).toBe("change rest");
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("starts every shortcut request so identical refusals re-announce and success clears the old line", () => {
    const view = mount("`code`");
    const listener = vi.fn();
    const unsubscribe = subscribeAppStatus(listener);
    try {
      act(() => {
        forceParsing(view, view.state.doc.length, 2_000);
        view.dispatch({ selection: { anchor: 1, head: 5 } });
        expect(pressMod(view, "b")).toBe(true);
      });
      const first = getAppStatus();
      act(() => expect(pressMod(view, "b")).toBe(true));
      expect(getAppStatus()).not.toBe(first);
      expect(getAppStatus()?.authorMessage).toBe(
        "Bold isn't available for this selection because it includes code.",
      );
      expect(listener).toHaveBeenCalledTimes(3);

      act(() => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "word" },
          selection: { anchor: 0, head: 4 },
        });
        forceParsing(view, view.state.doc.length, 2_000);
        expect(pressMod(view, "b")).toBe(true);
      });
      expect(view.state.doc.toString()).toBe("**word**");
      expect(getAppStatus()).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
