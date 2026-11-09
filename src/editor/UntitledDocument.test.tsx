// @vitest-environment jsdom
// ABOUTME: The untitled document pane (D12, FR-ED-8, #1379) — an editable buffer with no file
// ABOUTME: behind it yet, offering `[Save As…]` as its only path into the project.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { act, createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UntitledDocument } from "./UntitledDocument";
import type { EditorShellHandle } from "./EditorShell";
import type { CommentThread } from "../comments/types";
import { linkedChange, thread } from "../comments/threadFixture";
import { trackedChanges, type ParsedChange } from "./trackedChanges";
import { revealAtCursorEnabledField } from "./structuralDecorations";

const {
  parseChangesMock,
  openDocumentMock,
  saveDocumentMock,
  saveDocumentAsMock,
  loadCommentThreadsMock,
  createCommentMock,
  resolveAnchorMock,
} = vi.hoisted(
  () => ({
    parseChangesMock: vi.fn<(doc: unknown, content: string) => Promise<ParsedChange[]>>(async () => []),
    openDocumentMock: vi.fn(),
    saveDocumentMock: vi.fn(),
    saveDocumentAsMock: vi.fn(),
    loadCommentThreadsMock: vi.fn(),
    createCommentMock: vi.fn(),
    resolveAnchorMock: vi.fn(),
  }),
);

vi.mock("../comments/ipc", async (importActual) => {
  const actual = await importActual<typeof import("../comments/ipc")>();
  return {
    ...actual,
    loadCommentThreads: (...args: unknown[]) => loadCommentThreadsMock(...args),
    createComment: (...args: unknown[]) => createCommentMock(...args),
  };
});

vi.mock("./ipc", async (importActual) => {
  const actual = await importActual<typeof import("./ipc")>();
  return {
    ...actual,
    parseChanges: (doc: unknown, content: string) => parseChangesMock(doc, content),
    openDocument: openDocumentMock,
    saveDocument: saveDocumentMock,
    saveDocumentAs: saveDocumentAsMock,
    resolveAnchor: (...args: unknown[]) => resolveAnchorMock(...args),
  };
});

describe("editor/UntitledDocument", () => {
  beforeEach(() => {
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveDocumentAsMock.mockReset();
    loadCommentThreadsMock.mockReset().mockResolvedValue([]);
    createCommentMock.mockReset().mockResolvedValue([]);
    resolveAnchorMock.mockReset();
  });

  it("routes provisional dictation through the pathless shared editor", () => {
    const ref = createRef<EditorShellHandle>();
    const onChange = vi.fn();
    const rendered = render(<UntitledDocument ref={ref} displacedPath="draft.md"
      content="draft" onChange={onChange} onSaveAs={() => {}} />);
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => {
      view.dispatch({ selection: { anchor: 2 } });
      expect(ref.current!.beginDictation(31)).toBe(true);
      expect(ref.current!.showDictationPartial(31, "working")).toBe(true);
    });
    expect(rendered.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("working");
    expect(ref.current!.getContent()).toBe("draft");
    expect(onChange).not.toHaveBeenCalled();

    act(() => expect(ref.current!.commitDictationFinal(31, "voice")).toBe(true));
    expect(ref.current!.getContent()).toBe("drvoiceaft");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("drvoiceaft");
    expect(rendered.container.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(saveDocumentMock).not.toHaveBeenCalled();
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getContent()).toBe("draft");
  });

  it("#2574 resolves a pathless popover passage route in its live buffer", async () => {
    const content = "hello world\n";
    const anchored = thread("c1", {
      anchor: { offset: 6, length: 5, text_snapshot: "world", context_before: "hello ", context_after: "\n", base_revision: "r0" },
    });
    resolveAnchorMock.mockResolvedValueOnce({ from: 6, to: 11 });
    const rendered = render(<UntitledDocument displacedPath="b.md" content={content}
      docId="4c7be32a-45f8-476f-a175-8fd48cab51d3" root="/project"
      onChange={() => {}} onSaveAs={() => {}}
      commentProjection={{ revision: "r0", threads: [anchored] }} />);
    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);

    fireEvent.click(screen.getByRole("button", { name: "“world”" }));

    await vi.waitFor(() => expect(resolveAnchorMock).toHaveBeenCalledWith(content, anchored.anchor));
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement)!;
    await vi.waitFor(() => expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([6, 11]));
  });

  it("focuses a pathless popover's linked change by its live editor ID", async () => {
    const content = "hello world{++ !++}\n";
    parseChangesMock.mockResolvedValue([
      { id: "9", recorded: true, group: null, full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    const linkedThread = thread("c1", {
      author: "you",
      anchor: { offset: 6, length: 5, text_snapshot: "world", context_before: "hello ", context_after: "{++", base_revision: "r0" },
      linked_changes: [linkedChange("9")],
    });
    const rendered = render(<UntitledDocument displacedPath="b.md" content={content}
      docId="4c7be32a-45f8-476f-a175-8fd48cab51d3" root="/project"
      onChange={() => {}} onSaveAs={() => {}}
      commentProjection={{ revision: "r0", threads: [linkedThread] }} />);

    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement)!;
    await vi.waitFor(() => expect(trackedChanges(view.state).map((change) => change.id)).toContain("9"));

    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to changes" }));
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([11, 19]);
  });

  it("uses the shared CM6 surface, parses CriticMarkup pathlessly, and never reaches disk IPC", async () => {
    const content = "Hello {++shared++} surface";
    const rendered = render(
      <UntitledDocument
        displacedPath="drafts/b.md"
        content={content}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    expect(rendered.container.querySelector("textarea")).toBeNull();
    expect(rendered.container.querySelector(".cm-editor")).not.toBeNull();
    await vi.waitFor(() => expect(parseChangesMock).toHaveBeenCalledWith(null, content));
    const diskIpcMocks = [openDocumentMock, saveDocumentMock, saveDocumentAsMock];
    expect(diskIpcMocks.some((mock) => mock.mock.calls.length > 0)).toBe(false);
  });

  it("applies reveal-at-cursor preference changes without remounting the pathless editor", () => {
    const props = {
      displacedPath: "draft.md",
      content: "# Heading\n",
      onChange: () => {},
      onSaveAs: () => {},
    };
    const rendered = render(
      <UntitledDocument {...props} revealMarkupAtCursor={false} />,
    );
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    const selection = view.state.selection;

    expect(view.state.field(revealAtCursorEnabledField)).toBe(false);

    rendered.rerender(
      <UntitledDocument {...props} revealMarkupAtCursor />,
    );

    expect(EditorView.findFromDOM(editor)).toBe(view);
    expect(view.state.field(revealAtCursorEnabledField)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
  });

  it("adoption preserves the exact EditorView, undo, caret, scroll, toolbar, and focus", () => {
    const props = {
      displacedPath: "draft.md",
      content: "draft",
      onChange: () => {},
      onSaveAs: () => {},
      docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
      root: "/project",
      commentProjection: { revision: "r1", threads: [thread("open")] },
    };
    const rendered = render(<UntitledDocument {...props} />);
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const toolbar = screen.getByRole("toolbar", { name: "Editor view controls" });
    const formatGroup = within(toolbar).getByRole("group", { name: "Formatting" });
    expect(within(formatGroup).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "B",
      "I",
      "H1",
      "≔",
    ]);
    const status = screen.getByRole("region", { name: "Document status" });
    expect(status).toHaveTextContent("1 open comment");
    view.focus();
    view.scrollDOM.scrollTop = 19;
    act(() => view.dispatch({
      changes: { from: view.state.doc.length, insert: "!" },
      selection: { anchor: 2 },
    }));

    rendered.rerender(
      <UntitledDocument
        {...props}
        content="draft!"
        adoptedPath="notes/draft.md"
        onSaveAdopted={async () => true}
      />,
    );

    expect(EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    expect(screen.getByRole("toolbar", { name: "Editor view controls" })).toBe(toolbar);
    expect(within(toolbar).getByRole("group", { name: "Formatting" })).toBe(formatGroup);
    expect(screen.getByRole("region", { name: "Document status" })).toBe(status);
    expect(status).toHaveTextContent("1 open comment");
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.scrollDOM.scrollTop).toBe(19);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("draft");
    expect(screen.queryByText("Saved nowhere yet")).not.toBeInTheDocument();
  });

  it("keeps one CM6 instance across controlled updates and reports edits to the session owner", () => {
    const onChange = vi.fn();
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content="first"
        onChange={onChange}
        onSaveAs={() => {}}
      />,
    );
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " edit" } }));
    expect(onChange).toHaveBeenLastCalledWith("first edit");

    rendered.rerender(
      <UntitledDocument
        displacedPath="b.md"
        content="replacement"
        onChange={onChange}
        onSaveAs={() => {}}
      />,
    );
    expect(EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)).toBe(
      view,
    );
    expect(view.state.doc.toString()).toBe("replacement");
  });

  it("reparses a controlled replacement and rejects the late initial parse", async () => {
    let resolveInitial!: (changes: ParsedChange[]) => void;
    let resolveReplacement!: (changes: ParsedChange[]) => void;
    parseChangesMock
      .mockImplementationOnce(
        () => new Promise<ParsedChange[]>((resolve) => (resolveInitial = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<ParsedChange[]>((resolve) => (resolveReplacement = resolve)),
      );
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content="Old {++stale++}"
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
    await vi.waitFor(() => expect(parseChangesMock).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <UntitledDocument
        displacedPath="b.md"
        content="New {++fresh++}"
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );
    await vi.waitFor(() =>
      expect(parseChangesMock).toHaveBeenLastCalledWith(null, "New {++fresh++}"),
    );
    await act(async () => {
      resolveReplacement([
        {
          id: "replacement",
          recorded: false,
          group: null,
          full: { from: 4, to: 15 },
          kind: "insertion",
          text: { from: 7, to: 12 },
        },
      ]);
    });
    await vi.waitFor(() =>
      expect(trackedChanges(view.state).map((change) => change.id)).toEqual(["replacement"]),
    );
    expect(screen.getByRole("group", { name: "Review changes" })).toHaveTextContent("1 of 1");

    await act(async () => {
      resolveInitial([
        {
          id: "stale-initial",
          recorded: false,
          group: null,
          full: { from: 4, to: 15 },
          kind: "insertion",
          text: { from: 7, to: 12 },
        },
      ]);
    });
    expect(trackedChanges(view.state).map((change) => change.id)).toEqual(["replacement"]);
  });

  it("projects pathless status from CM6 and keeps its last known count when a newer parse rejects", async () => {
    const parsed: ParsedChange = {
      id: "known-pathless",
      recorded: false,
      group: null,
      kind: "insertion",
      full: { from: 7, to: 18 },
      text: { from: 10, to: 15 },
    };
    const onError = vi.fn();
    parseChangesMock.mockResolvedValueOnce([parsed]);
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content="Before {++after++}"
        revealMarkupAtCursor={false}
        onChange={() => {}}
        onSaveAs={() => {}}
        onError={onError}
        providerStatuses={[{ provider: "claude_code", state: "installed_signed_out" }]}
        commentProjection={{
          revision: "r1",
          threads: [{
            id: "pathless-comment",
            author: "you",
            last_activity_at: 0,
            anchor: null,
            body: "Waiting for a checkpointed comment identity",
            edited_at: null,
            withdrawn_at: null,
            published: false,
            visible_when_withdrawn: false,
            targeting_run_ids: [],
            resolved: false,
            orphaned: false,
            reopened: false,
            replies: [],
            severity: null,
            skill: null,
            workflow_run: null,
            pending_run: null,
    pending_runs: [],
            pending_run_started: false,
            pending_guidance: null,
            concluded_run: null,
            linked_changes: [],
          }],
        }}
      />,
    );
    const status = screen.getByRole("region", { name: "Document status" });
    await vi.waitFor(() =>
      expect(status).toHaveTextContent("1 tracked change · no author recorded"),
    );
    expect(status).toHaveTextContent("Markdown");
    expect(status).toHaveTextContent("2 words");
    expect(status).toHaveTextContent("Claude Code · signed out");
    expect(status, "before the UUID checkpoint, comments cannot load into this pane").not.toHaveTextContent(/open comment/);

    const rejection = new Error("parse transport unavailable");
    parseChangesMock.mockRejectedValueOnce(rejection);
    rendered.rerender(
      <UntitledDocument
        displacedPath="b.md"
        content="Before {++after++} now"
        revealMarkupAtCursor={false}
        onChange={() => {}}
        onSaveAs={() => {}}
        onError={onError}
        providerStatuses={[{ provider: "claude_code", state: "installed_signed_out" }]}
      />,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(rejection));
    expect(status, "rejected parse must retain the last established count").toHaveTextContent(
      "1 tracked change · no author recorded",
    );
    expect(status).toHaveTextContent("3 words");

    rendered.rerender(
      <UntitledDocument
        displacedPath="b.md"
        content="Before {++after++} now"
        revealMarkupAtCursor
        onChange={() => {}}
        onSaveAs={() => {}}
        onError={onError}
        providerStatuses={[{ provider: "claude_code", state: "installed_signed_out" }]}
      />,
    );
    expect(
      status,
      "a presentation-only preference update must retain the last established count",
    ).toHaveTextContent("1 tracked change · no author recorded");
  });

  it("offers all four pathless Display projections without mutating the buffer", () => {
    const content = "Hello {++shared++} surface";
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content={content}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );
    const view = EditorView.findFromDOM(
      rendered.container.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    const display = screen.getByRole("combobox", { name: "Display mode" });

    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();
    expect(within(display).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All",
      "Simple",
      "None",
      "Original",
    ]);
    fireEvent.change(display, { target: { value: "None" } });
    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toBe(content);
    fireEvent.change(display, { target: { value: "All" } });
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toBe(content);
  });

  it("projects supplied pathless comment anchors without exposing comment creation or persistence", async () => {
    const content = "hello anchored text";
    const thread: CommentThread = {
      id: "thread-1",
      author: "reviewer",
      last_activity_at: 0,
      anchor: {
        offset: 6,
        length: 8,
        text_snapshot: "anchored",
        context_before: "hello ",
        context_after: " text",
        base_revision: "r1",
      },
      body: "Check this",
      edited_at: null,
      withdrawn_at: null,
      published: false,
      visible_when_withdrawn: false,
      targeting_run_ids: [],
      resolved: false,
      orphaned: false,
      reopened: false,
      replies: [],
      severity: null,
      skill: null,
      workflow_run: null,
      pending_run: null,
    pending_runs: [],
      pending_run_started: false,
      pending_guidance: null,
      concluded_run: null,
      linked_changes: [],
    };
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content={content}
        onChange={() => {}}
        onSaveAs={() => {}}
        commentProjection={{ revision: "r1", threads: [thread] }}
      />,
    );

    await vi.waitFor(() =>
      expect(rendered.container.querySelector(".cm-commentHighlight")).not.toBeNull(),
    );
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    act(() => view.dispatch({ selection: { anchor: 6, head: 14 } }));
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(openDocumentMock).not.toHaveBeenCalled();
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("loads and creates comments by checkpointed UUID with live CM6 text and no agent controls", async () => {
    const content = "hello 😀 world";
    const onCommentThreadsChanged = vi.fn();
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content={content}
        docId="4c7be32a-45f8-476f-a175-8fd48cab51d3"
        root="/project"
        onChange={() => {}}
        onSaveAs={() => {}}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );
    const owner = {
      kind: "id",
      docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
      label: "Untitled — recovered from b.md",
    };
    await vi.waitFor(() =>
      expect(loadCommentThreadsMock).toHaveBeenCalledWith("/project", owner, content),
    );

    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => view.dispatch({ selection: { anchor: 6, head: 8 } }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "emoji note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith(
      "/project",
      owner,
      "you",
      "emoji note",
      { content, utf16Offset: 6, utf16Length: 2 },
      expect.any(Number),
      content,
    );
    expect(screen.queryByRole("button", { name: "Address with AI" })).not.toBeInTheDocument();
  });

  it("#2594 enables gutter add after UUID without remounting or losing the selection", () => {
    const content = "hello selected text";
    const props = { displacedPath: "b.md", content, root: "/project",
      onChange: () => {}, onSaveAs: () => {} };
    const rendered = render(<UntitledDocument {...props} />);
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    act(() => view.dispatch({ selection: { anchor: 6, head: 14 } }));
    const selected = view.state.selection;
    expect(rendered.container.querySelector("[data-comment-gutter-add]")).toBeNull();

    rendered.rerender(<UntitledDocument {...props} docId="4c7be32a-45f8-476f-a175-8fd48cab51d3" />);
    expect(EditorView.findFromDOM(editor)).toBe(view);
    expect(view.state.selection.eq(selected)).toBe(true);
    const add = screen.getByRole("button", { name: "Add comment to selected text" });
    fireEvent.click(add);
    const composer = screen.getByRole("dialog", { name: "New comment" });
    expect(composer).toHaveTextContent("Commenting on: “selected”");
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(view.state.selection.eq(selected)).toBe(true);
  });

  it("shows the displaced buffer verbatim, naming the path it was displaced from", () => {
    const content = "# Sermonette\n\nunsaved second paragraph";
    render(
      <UntitledDocument
        displacedPath="drafts/b.md"
        content={content}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const pane = screen.getByRole("region", { name: "Untitled document, recovered from drafts/b.md" });
    expect(pane).toHaveAccessibleName("Untitled document, recovered from drafts/b.md");
    expect(pane).not.toHaveTextContent(/couldn’t be preserved/);
    expect(screen.getByRole("textbox")).toHaveTextContent("# Sermonetteunsaved second paragraph");
  });

  it("is editable — autosave off by construction, because there is no file to autosave to", () => {
    const onChange = vi.fn();
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="displaced work"
        onChange={onChange}
        onSaveAs={() => {}}
      />,
    );

    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }));

    expect(onChange).toHaveBeenLastCalledWith("displaced work!");
  });

  it("offers Save As, the only path this buffer has into the project", () => {
    const onSaveAs = vi.fn();
    render(
      <UntitledDocument displacedPath="b.md" content="displaced work" onChange={() => {}} onSaveAs={onSaveAs} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    expect(onSaveAs).toHaveBeenCalledTimes(1);
  });

  it("routes the platform Mod-S binding through Save As and prevents the native default", () => {
    const onSaveAs = vi.fn();
    const rendered = render(
      <UntitledDocument
        displacedPath="b.md"
        content="displaced work"
        onChange={() => {}}
        onSaveAs={onSaveAs}
      />,
    );
    const event = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
      bubbles: true,
      cancelable: true,
    });

    act(() => rendered.container.querySelector<HTMLElement>(".cm-content")!.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onSaveAs).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    expect(onSaveAs).toHaveBeenCalledTimes(2);
  });

  it("disables Save As while a save is in flight, so a double-click cannot race two writes", () => {
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="displaced work"
        onChange={() => {}}
        onSaveAs={() => {}}
        saving
      />,
    );

    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
  });

  it("shows a save failure without discarding the buffer or the failed content", () => {
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="displaced work"
        onChange={() => {}}
        onSaveAs={() => {}}
        saveError="That file is outside the open project."
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Emend couldn’t complete the requested action. That file is outside the open project.",
    );
    expect(screen.getByRole("textbox")).toHaveTextContent("displaced work");
  });

  it("renders 9c.2's exact standing over-cap state without turning the placeholder into content", () => {
    render(
      <UntitledDocument
        displacedPath="drafts/b.md"
        content=""
        recoveryContentOmitted
        onChange={() => {}}
        onSaveAs={() => {}}
        platform="win"
      />,
    );

    const notice = screen.getByRole("region", {
      name: "Recovery notice, untitled document from drafts/b.md",
    });
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent("Your earlier unsaved work couldn’t be preserved.");
    expect(notice).toHaveTextContent("larger than the 2 MiB Emend keeps per tab in its session");
    expect(notice).toHaveTextContent("It doesn’t bring back what wasn’t kept.");
    expect(screen.getByText("Nothing was recovered into this document — you can start writing here.")).toHaveClass(
      "cm-placeholder",
    );
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.doc.toString()).toBe("");
    expect(screen.getByText("Saved nowhere yet")).toBeInTheDocument();
    expect(screen.getByText("No autosave — there is no project path yet.")).toBeInTheDocument();
  });

  it("keeps the narrow 9c.2 loss reason brief without dropping its final caution", () => {
    render(
      <UntitledDocument
        displacedPath="drafts/b.md"
        content=""
        recoveryContentOmitted
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const notice = screen.getByRole("region", {
      name: "Recovery notice, untitled document from drafts/b.md",
    });
    const reason = notice.querySelector(".untitled-document__loss-reason")!;
    expect(reason.querySelector(".untitled-document__loss-provenance")).toHaveTextContent(
      "This untitled tab holds work from drafts/b.md.",
    );
    expect(reason.textContent).toContain("An earlier unsaved buffer was larger than the 2 MiB Emend keeps per tab");
    expect(reason.textContent?.endsWith("It doesn’t bring back what wasn’t kept.")).toBe(true);
  });

  it("keeps one toggle focused while Hide message and Details persist the standing fact", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = render(
      <UntitledDocument
        displacedPath="b.md"
        content="new words"
        recoveryContentOmitted
        onRecoveryNoticeCollapsedChange={onCollapsedChange}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const hide = screen.getByRole("button", { name: "Hide message" });
    hide.focus();
    fireEvent.click(hide);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(
      <UntitledDocument
        displacedPath="b.md"
        content="new words"
        recoveryContentOmitted
        lossNoticeCollapsed
        onRecoveryNoticeCollapsedChange={onCollapsedChange}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );
    const details = screen.getByRole("button", {
      name: "Earlier unsaved work not preserved — show details",
    });
    expect(details).toHaveFocus();
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it("Esc in the expanded notice hides the explanation without moving focus", () => {
    const onCollapsedChange = vi.fn();
    render(
      <UntitledDocument
        displacedPath="b.md"
        content=""
        recoveryContentOmitted
        onRecoveryNoticeCollapsedChange={onCollapsedChange}
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const hide = screen.getByRole("button", { name: "Hide message" });
    hide.focus();
    fireEvent.keyDown(hide, { key: "Escape" });
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(hide).toHaveFocus();
  });

  it("9c.1 stays neutral when the recovery buffer was preserved", () => {
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="preserved work"
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    expect(screen.queryByRole("region", { name: /Recovery notice/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("preserved work");
    expect(screen.getByText("Saved nowhere yet")).toBeInTheDocument();
    const status = screen.getByRole("region", { name: "Document status" });
    expect(status).toHaveAttribute("data-platform", "win");
    expect(status.previousElementSibling).toHaveClass("untitled-document__actions");
    expect(status.previousElementSibling?.previousElementSibling).toHaveClass(
      "untitled-document__buffer",
    );
    expect(status.nextElementSibling).toBeNull();
  });

  it("renders 9e.1's exact live-over-cap warning without loss or dismissal wording", () => {
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="work still in front of me"
        liveOverCap
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const notice = screen.getByRole("region", {
      name: "Session durability warning, untitled document from b.md",
    });
    expect(notice).toHaveTextContent("This work is here, but Emend can't keep it in your session.");
    expect(notice).toHaveTextContent(
      "It's larger than the 2 MiB Emend can hold per tab, so it won't be there after you quit. Nothing has been lost — the text is in front of you. Save As… puts it in the project, and that is the only way to keep it.",
    );
    expect(notice).not.toHaveTextContent(/not preserved/i);
    expect(within(notice).queryByRole("button", { name: /Hide message/i })).not.toBeInTheDocument();
  });

  it("renders 9e.2 as separate live risk and earlier omission facts", () => {
    render(
      <UntitledDocument
        displacedPath="b.md"
        content="new work"
        recoveryContentOmitted
        liveOverCap
        onChange={() => {}}
        onSaveAs={() => {}}
      />,
    );

    const notice = screen.getByRole("region", {
      name: "Session durability and recovery notice, untitled document from b.md",
    });
    expect(notice).toHaveTextContent("This work is here, but Emend can't keep it in your session.");
    expect(notice).toHaveTextContent("What you have written since is larger than");
    expect(notice).toHaveTextContent(
      "Separately: the earlier unsaved work this tab was opened to hold was not preserved, and Emend can't restore it. Saving now keeps what you wrote — it doesn't bring that back.",
    );
    expect(notice.querySelector(".untitled-document__loss-separator")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hide message" })).toBeInTheDocument();
  });
});
