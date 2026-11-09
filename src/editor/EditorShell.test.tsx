// @vitest-environment jsdom
// ABOUTME: Covers the P2a-6 additions to the CM6 shell — session-restore content override, dirty
// ABOUTME: tracking, the imperative getContent/save handle the tab layer drives — the P2a-21
// ABOUTME: integrity banners (CRLF-on-open, external-change reload/keep-mine/compare) — and (#259)
// ABOUTME: the editor-anchored comment popover's wiring: the create trigger, the highlight click
// ABOUTME: deep-link, and the revision-gated seed the highlight layer reads.
import { createRef } from "react";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorShellHandle } from "./EditorShell";
import type { SelectionSnapshot } from "./selectionWatcher";
import type { AutosaveScheduler } from "./autosave";
import { seedTrackedChanges, type ParsedChange } from "./trackedChanges";
import type { CommentThread } from "../comments/types";
import { linkedChange, thread } from "../comments/threadFixture";
import { revealAtCursorEnabledField } from "./structuralDecorations";
import { setSourceView } from "./viewMode";

const createCommentMock = vi.fn();
const replyToCommentMock = vi.fn();
const resolveCommentMock = vi.fn();
const loadCommentThreadsMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  loadCommentThreads: (...args: unknown[]) => loadCommentThreadsMock(...args),
  createComment: (...args: unknown[]) => createCommentMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
  reopenComment: vi.fn(),
  reAnchorComment: vi.fn(),
  addressWithAI: vi.fn(),
  decideLinkedChanges: vi.fn(),
}));

// Captures the `onChange` callback `EditorShell` wires into `selectionWatcherExtension` on each
// mount, while still installing the *real* extension (so CM6 selection dispatches keep working
// normally) — lets a test fire a selection change directly rather than driving real CM6 mouse/
// keyboard selection through jsdom, the same way `selectionWatcher.test.ts` already covers that
// extension's own correctness in isolation.
let capturedOnSelectionChange: ((selection: SelectionSnapshot | null) => void) | null = null;
// The real extension's own `onChange` calls, spied rather than replaced — this is what lets a
// `ref.focusAnchor()` test assert the *actual* CM6 selection a real `view.dispatch` produced
// (offset/length/text from the live doc), rather than only the mocked `resolveAnchor` call args or
// `focusAnchor`'s boolean return. A prior round of this suite asserted only those two, which passed
// even with the `view.dispatch(...)` that does the selecting deleted entirely (#492 review).
const realSelectionReports = vi.fn<(selection: SelectionSnapshot | null) => void>();
vi.mock("./selectionWatcher", async (importActual) => {
  const actual = await importActual<typeof import("./selectionWatcher")>();
  return {
    ...actual,
    selectionWatcherExtension: (onChange: (selection: SelectionSnapshot | null) => void) => {
      capturedOnSelectionChange = onChange;
      return actual.selectionWatcherExtension((next) => {
        realSelectionReports(next);
        onChange(next);
      });
    },
  };
});

// The exact `check` callback `createExternalChangePoller` was constructed with (#1701, review
// Important 1). The real poller is still installed underneath — every existing FR-ED-7 test keeps
// polling through the genuine `.finally()`/rearm chain unchanged — but capturing the callback
// itself lets a test call `checkDiskForExternalChange` directly and `await` its rejection, which
// *consumes* that rejection instead of letting it escape. That is the only way to pin "re-throws
// past a missing `onError`" without also provoking the very unhandled rejection the property is
// about: awaiting the poller's own `.finally()` chain (as every other test here does) can only ever
// observe the escape, never assert on it in-process. Same `importActual` capture shape as
// `selectionWatcherExtension` above.
let capturedCheck: (() => Promise<void>) | null = null;
vi.mock("./externalChange", async (importActual) => {
  const actual = await importActual<typeof import("./externalChange")>();
  return {
    ...actual,
    createExternalChangePoller: (check: () => Promise<void>, intervalMs?: number) => {
      capturedCheck = check;
      return actual.createExternalChangePoller(check, intervalMs);
    },
  };
});

// FR-ED-7's external-change poll re-reads the file for as long as the tab is mounted and rearms
// after every read settles, so no test bounds how many reads it takes. Answer one this fixture did
// not queue with a read that has not come back yet — real (`openDocument` resolves a
// `DocumentPayload` or rejects, and a read in flight is the state the poller itself waits in),
// inert, and never `undefined`, which the shell would read `.content` off inside a poll nobody
// awaits (#1690). `mockReset()` restores this default, so a fixture that resets mid-test keeps it.
const pendingDocumentRead = (
  _root: string,
  _path: string,
): Promise<import("./ipc").DocumentPayload> => new Promise(() => {});
const openDocumentMock = vi.fn(pendingDocumentRead);
const saveDocumentMock = vi.fn();
const parseChangesMock = vi.fn();
const captureAnchorMock = vi.fn();
const resolveAnchorMock = vi.fn();
// J2's Missing-on-disk recovery boundary (#933). The capability query defaults to the answer macOS
// and every unqualified filesystem give, so a shell that goes missing without a test saying
// otherwise renders the no-Recreate chrome most installs actually see.
const recreateCapabilityMock = vi.fn<
  (path: string) => Promise<import("./ipc").RecreateCapability>
>(async (path: string) => ({ path, status: "confinement_unavailable" }));
const recreateMock = vi.fn();
const saveDocumentAsMock = vi.fn();
vi.mock("./ipc", () => ({
  openDocument: (root: string, path: string) => openDocumentMock(root, path),
  saveDocument: (...args: unknown[]) => saveDocumentMock(...args),
  saveDocumentAs: (...args: unknown[]) => saveDocumentAsMock(...args),
  recreateMissingDocumentCapability: (path: string) => recreateCapabilityMock(path),
  recreateMissingDocument: (...args: unknown[]) => recreateMock(...args),
  // The redline snapshot parse — default to "no changes" so the shell mounts cleanly; the redline
  // behavior itself is covered by trackedChanges/RedlineReview, not this session-restore suite.
  parseChanges: (...args: unknown[]) => parseChangesMock(...args),
  captureAnchor: (...args: unknown[]) => captureAnchorMock(...args),
  resolveAnchor: (...args: unknown[]) => resolveAnchorMock(...args),
}));

// Spy on the scheduler factory while keeping its real debounce behavior — lets us assert which
// interval EditorShell arms autosave with (the injectable-clock seam the D23 hook drives) without
// racing a real timer.
vi.mock("./autosave", async (importActual) => {
  const actual = await importActual<typeof import("./autosave")>();
  return { ...actual, createAutosaveScheduler: vi.fn(actual.createAutosaveScheduler) };
});

const getSettingsMock = vi.fn();
vi.mock("../settings", async (importActual) => {
  const actual = await importActual<typeof import("../settings")>();
  getSettingsMock.mockImplementation(async () => actual.DEFAULT_SETTINGS);
  return { ...actual, getSettings: () => getSettingsMock() };
});

const { EditorShell } = await import("./EditorShell");
const { createAutosaveScheduler, DEFAULT_AUTOSAVE_INTERVAL_MS } = await import("./autosave");

describe("editor/EditorShell — session restore + dirty tracking", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    captureAnchorMock.mockReset();
    vi.mocked(createAutosaveScheduler).mockClear();
  });

  it("routes provisional dictation through the loaded file-backed editor", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "draft", revision: "r1" });
    const onDirtyChange = vi.fn();
    const ref = createRef<EditorShellHandle>();
    const { container } = render(<EditorShell ref={ref} root="/project" path="chapter.md"
      onDirtyChange={onDirtyChange} autosaveIntervalMs={3_600_000} />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("draft"));
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => {
      view.dispatch({ effects: setSourceView.of(true), selection: { anchor: 2 } });
      expect(ref.current!.beginDictation(41)).toBe(true);
      expect(ref.current!.showDictationPartial(41, "working")).toBe(true);
    });
    expect(container.querySelector(".cm-dictation-ghost")).toHaveTextContent("working");
    expect(ref.current!.getContent()).toBe("draft");
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(saveDocumentMock).not.toHaveBeenCalled();

    act(() => expect(ref.current!.commitDictationFinal(41, "voice")).toBe(true));
    expect(ref.current!.getContent()).toBe("drvoiceaft");
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("shows live Markdown, word, tracked-change, open-comment, and provider facts", async () => {
    const content = "Hello {++grace++}";
    const parsed = {
      id: "snap:a.md:1:0",
      recorded: false,
      group: null,
      kind: "insertion",
      full: { from: 6, to: 17 },
      text: { from: 9, to: 14 },
    } satisfies ParsedChange;
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([parsed]);

    render(
      <EditorShell
        root="/project"
        path="a.md"
        commentThreads={[thread("open"), thread("resolved", { resolved: true })]}
        providerStatuses={[{ provider: "claude_code", state: "signed_in", account: null }]}
      />,
    );

    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() => expect(status).toHaveTextContent("1 tracked change"));
    expect(status).toHaveTextContent("Markdown");
    expect(status).toHaveTextContent("2 words");
    expect(status).toHaveTextContent("1 open comment");
    expect(status).toHaveTextContent("Claude Code · connected");
  });

  it("updates counts from the live CM6 field without reparsing decisions or edits", async () => {
    const content = "Hello {++grace++}";
    const parsed = {
      id: "snap:a.md:1:0",
      recorded: false,
      group: null,
      kind: "insertion",
      full: { from: 6, to: 17 },
      text: { from: 9, to: 14 },
    } satisfies ParsedChange;
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([parsed]);
    const ref = createRef<EditorShellHandle>();

    const { container } = render(<EditorShell ref={ref} root="/project" path="a.md" />);
    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() => expect(status).toHaveTextContent("1 tracked change"));
    const editor = container.querySelector<HTMLElement>(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({
        changes: { from: content.length, insert: " again" },
      });
    });
    await waitFor(() => expect(status).toHaveTextContent("3 words"));

    act(() => {
      expect(ref.current?.decideChanges([parsed.id], "accept")).toEqual([parsed.id]);
    });
    await waitFor(() => expect(status).not.toHaveTextContent(/tracked change/));
    expect(parseChangesMock).toHaveBeenCalledTimes(1);
  });

  it("releases a current content-stale parse so later tracked-state updates resume status", async () => {
    let resolveInitial!: (changes: ParsedChange[]) => void;
    parseChangesMock.mockReturnValueOnce(
      new Promise<ParsedChange[]>((resolve) => (resolveInitial = resolve)),
    );
    openDocumentMock.mockResolvedValueOnce({ content: "Hello", revision: "blake3:abc" });
    const parsed = {
      id: "delivered-after-stale-parse",
      recorded: true,
      group: "delivery",
      kind: "insertion",
      full: { from: 5, to: 6 },
      text: { from: 5, to: 6 },
    } satisfies ParsedChange;
    const ref = createRef<EditorShellHandle>();
    const { container } = render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(parseChangesMock).toHaveBeenCalledTimes(1));
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }));
    await act(async () => resolveInitial([]));
    act(() =>
      view.dispatch({
        effects: seedTrackedChanges.of({ changes: [parsed], generation: "delivery" }),
      }),
    );

    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() =>
      expect(status, "content-stale completion must release status projection").toHaveTextContent(
        "1 tracked change",
      ),
    );
    act(() => expect(ref.current?.decideChanges([parsed.id], "accept")).toEqual([parsed.id]));
    await waitFor(() => expect(status).not.toHaveTextContent(/tracked change/));
  });

  it("updates, resolves, and reopens the live comment count without remounting the editor", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "Hello", revision: "blake3:abc" });
    const open = thread("open");
    const second = thread("second");
    const rendered = render(
      <EditorShell root="/project" path="a.md" commentThreads={[open, second]} />,
    );
    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() => expect(status).toHaveTextContent("2 open comments"));

    rendered.rerender(
      <EditorShell
        root="/project"
        path="a.md"
        commentThreads={[{ ...open, resolved: true }, second]}
      />,
    );
    await waitFor(() => expect(status).toHaveTextContent("1 open comment"));

    rendered.rerender(
      <EditorShell
        root="/project"
        path="a.md"
        commentThreads={[{ ...open, resolved: true }, { ...second, resolved: true }]}
      />,
    );
    await waitFor(() => expect(status).not.toHaveTextContent(/open comment/));
    rendered.rerender(
      <EditorShell
        root="/project"
        path="a.md"
        commentThreads={[open, { ...second, resolved: true }]}
      />,
    );
    await waitFor(() => expect(status).toHaveTextContent("1 open comment"));
  });

  it("projects live open and resolved counts in comment mode without remounting", async () => {
    const parsed = {
      id: "hidden-in-comment-mode",
      recorded: true,
      group: "delivery",
      kind: "insertion",
      full: { from: 0, to: 5 },
      text: { from: 0, to: 5 },
    } satisfies ParsedChange;
    openDocumentMock.mockResolvedValueOnce({ content: "Hello", revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([parsed]);
    const open = thread("open");
    const second = thread("second");
    const rendered = render(
      <EditorShell
        root="/project"
        path="a.md"
        commentMode
        commentThreads={[open, { ...second, resolved: true }]}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".cm-editor")).not.toBeNull());
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() => expect(status).toHaveTextContent("1 open comment1 resolved"));
    expect(status).not.toHaveTextContent(/tracked change/);

    rendered.rerender(
      <EditorShell
        root="/project"
        path="a.md"
        commentMode
        commentThreads={[{ ...open, resolved: true }, { ...second, resolved: true }]}
      />,
    );
    await waitFor(() => expect(status).toHaveTextContent("2 resolved"));
    expect(status).not.toHaveTextContent(/open comment/);
    expect(EditorView.findFromDOM(editor)).toBe(view);

    rendered.rerender(
      <EditorShell
        root="/project"
        path="a.md"
        commentMode
        commentThreads={[open, { ...second, resolved: true }]}
      />,
    );
    await waitFor(() => expect(status).toHaveTextContent("1 open comment1 resolved"));
    expect(EditorView.findFromDOM(editor)).toBe(view);
  });

  it("arms autosave with the default interval when none is injected", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });

    render(<EditorShell root="/project" path="a.md" />);

    await waitFor(() => expect(createAutosaveScheduler).toHaveBeenCalled());
    expect(createAutosaveScheduler).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_AUTOSAVE_INTERVAL_MS,
    );
  });

  it("arms autosave with the injected interval (the D23 pause hook) instead of the default", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });

    render(<EditorShell root="/project" path="a.md" autosaveIntervalMs={3_600_000} />);

    await waitFor(() => expect(createAutosaveScheduler).toHaveBeenCalled());
    expect(createAutosaveScheduler).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
  });

  it("applies committed autosave settings live without remounting the document", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    const schedulers = Array.from({ length: 3 }, () => ({
      schedule: vi.fn(),
      flush: vi.fn(),
      cancel: vi.fn(),
    }));
    schedulers.forEach((scheduler) =>
      vi.mocked(createAutosaveScheduler).mockImplementationOnce(() => scheduler),
    );
    const ref = createRef<EditorShellHandle>();
    const rendered = render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("# Hi\n"));

    act(() => ref.current?.setAutosaveSettings({ enabled: false, interval_ms: 5000 }));
    expect(schedulers[0].cancel).toHaveBeenCalledTimes(1);
    expect(createAutosaveScheduler).toHaveBeenLastCalledWith(expect.any(Function), 5000);

    const view = EditorView.findFromDOM(
      rendered.container.querySelector(".cm-editor") as HTMLElement,
    );
    act(() =>
      view?.dispatch({
        changes: { from: view.state.doc.length, insert: " disabled" },
        selection: { anchor: view.state.doc.length + " disabled".length },
      }),
    );
    expect(schedulers[1].schedule).not.toHaveBeenCalled();
    const dirtySelection = view?.state.selection.main.anchor;
    const dirtyUndoDepth = view ? undoDepth(view.state) : -1;
    expect(dirtyUndoDepth).toBe(1);

    act(() => ref.current?.setAutosaveSettings({ enabled: true, interval_ms: 2000 }));
    expect(schedulers[1].cancel).toHaveBeenCalledTimes(1);
    expect(createAutosaveScheduler).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    // Re-enabling while the buffer is already dirty arms the newly chosen interval immediately;
    // the user does not need to type one more character before autosave becomes live.
    expect(schedulers[2].schedule).toHaveBeenCalledTimes(1);
    expect(EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement)).toBe(
      view,
    );
    expect(view?.state.selection.main.anchor).toBe(dirtySelection);
    expect(view ? undoDepth(view.state) : -1).toBe(dirtyUndoDepth);
    act(() => view?.dispatch({ changes: { from: view.state.doc.length, insert: " enabled" } }));
    expect(schedulers[2].schedule).toHaveBeenCalledTimes(2);
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
    expect(ref.current?.getContent()).toBe("# Hi\n disabled enabled");
  });

  it("applies reveal-at-cursor preference changes without remounting the file-backed editor", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Heading\n", revision: "blake3:abc" });
    const rendered = render(
      <EditorShell root="/project" path="a.md" revealMarkupAtCursor={false} />,
    );
    const editor = await waitFor(() => {
      const element = rendered.container.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editor)!;
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    const selection = view.state.selection;

    expect(view.state.field(revealAtCursorEnabledField)).toBe(false);

    rendered.rerender(
      <EditorShell root="/project" path="a.md" revealMarkupAtCursor />,
    );

    expect(EditorView.findFromDOM(editor)).toBe(view);
    expect(view.state.field(revealAtCursorEnabledField)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
  });

  it("mounts with the newest reveal preference when hydration changes during document load", async () => {
    let resolveOpen!: (payload: { content: string; revision: string }) => void;
    openDocumentMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOpen = resolve; }),
    );
    const rendered = render(
      <EditorShell root="/project" path="a.md" revealMarkupAtCursor={false} />,
    );

    rendered.rerender(
      <EditorShell root="/project" path="a.md" revealMarkupAtCursor />,
    );
    resolveOpen({ content: "# Heading\n", revision: "blake3:abc" });

    const editor = await waitFor(() => {
      const element = rendered.container.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editor)!;
    expect(view.state.field(revealAtCursorEnabledField)).toBe(true);
  });

  it("with no initialContent mounts the loaded text and starts clean", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    const onDirtyChange = vi.fn();

    const { container } = render(
      <EditorShell root="/project" path="a.md" onDirtyChange={onDirtyChange} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveTextContent("# Hi");
    });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("wraps long document lines within the editor viewport", async () => {
    openDocumentMock.mockResolvedValueOnce({
      content: "A long prose line that should wrap instead of scrolling horizontally.\n",
      revision: "blake3:abc",
    });

    const { container } = render(<EditorShell root="/project" path="a.md" />);

    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveClass("cm-lineWrapping");
    });
  });

  it("focus redispatches the saved editor selection without adding undo history (#1401)", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# One two three\n", revision: "blake3:abc" });
    saveDocumentMock.mockResolvedValueOnce("blake3:def");
    const { container } = render(<EditorShell root="/project" path="a.md" />);
    const editor = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editor)!;
    view.dispatch({ changes: { from: 7, insert: "!" }, selection: { anchor: 8 } });
    const savedSelection = view.state.selection;
    const savedUndoDepth = undoDepth(view.state);
    expect(savedUndoDepth).toBe(1);
    view.contentDOM.blur();
    const dispatch = vi.spyOn(view, "dispatch");

    view.contentDOM.focus();

    expect(dispatch).toHaveBeenCalledWith({ selection: savedSelection });
    expect(view.state.selection.main.anchor).toBe(8);
    expect(undoDepth(view.state)).toBe(savedUndoDepth);
  });

  it("with an initialContent that differs from disk mounts the override text and starts dirty", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    const onDirtyChange = vi.fn();

    const { container } = render(
      <EditorShell
        root="/project"
        path="a.md"
        initialContent={"# Hi (unsaved edit)\n"}
        onDirtyChange={onDirtyChange}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveTextContent("# Hi (unsaved edit)");
    });
    expect(onDirtyChange).toHaveBeenCalledWith(true);
    expect(
      within(screen.getByRole("region", { name: "Document status" })).queryByText(/^Saved · /),
    ).toBeNull();
  });

  it("an initialContent equal to the loaded text starts clean not dirty", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    const onDirtyChange = vi.fn();

    render(
      <EditorShell
        root="/project"
        path="a.md"
        initialContent={"# Hi\n"}
        onDirtyChange={onDirtyChange}
      />,
    );

    await waitFor(() => expect(openDocumentMock).toHaveBeenCalled());
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("ref.getContent() reads back the mounted doc text verbatim", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);

    await waitFor(() => expect(ref.current?.getContent()).toBe("# Hi\n"));
  });

  it("ref.save() saves the current doc content and reports onSaved", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    saveDocumentMock.mockResolvedValueOnce(undefined);
    const ref = createRef<EditorShellHandle>();
    const onSaved = vi.fn();

    render(<EditorShell ref={ref} root="/project" path="a.md" onSaved={onSaved} />);
    await waitFor(() => expect(ref.current).not.toBeNull());

    await ref.current?.save();

    expect(saveDocumentMock).toHaveBeenCalledWith("/project", "a.md", "# Hi\n", true);
    expect(onSaved).toHaveBeenCalled();
  });

  it("ref.getContent() is undefined before the doc has loaded — never a false-empty string", () => {
    openDocumentMock.mockImplementation(() => new Promise(() => {})); // never resolves in this test
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);

    expect(ref.current?.getContent()).toBeUndefined();
  });

  it("ref.save() resolves false and reports onError when the write fails without silently succeeding", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    saveDocumentMock.mockRejectedValueOnce(new Error("disk full"));
    const ref = createRef<EditorShellHandle>();
    const onError = vi.fn();
    const onSaved = vi.fn();

    render(<EditorShell ref={ref} root="/project" path="a.md" onSaved={onSaved} onError={onError} />);
    await waitFor(() => expect(ref.current).not.toBeNull());

    const succeeded = await ref.current?.save();

    expect(succeeded).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("after ref.save() the tab is reported clean again (baseline moves to the saved text)", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });
    saveDocumentMock.mockResolvedValueOnce(undefined);
    const ref = createRef<EditorShellHandle>();
    const onDirtyChange = vi.fn();

    render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        initialContent={"# Hi (unsaved edit)\n"}
        onDirtyChange={onDirtyChange}
      />,
    );
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));

    await ref.current?.save();

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe("editor/EditorShell — ref.decideChanges(): the ids-in seam for a caller outside editor/ (#410)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveDocumentMock.mockResolvedValue(undefined);
    parseChangesMock.mockReset();
  });

  it("decides the passed id against the live document and returns the full id set decided", async () => {
    const content = "Hello {++brave ++}world\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "7", full: { from: 6, to: 18 }, kind: "insertion", text: { from: 9, to: 15 } },
    ]);
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    // Wait for the async redline seed to land (the toolbar's "1 of 1" is this suite's existing
    // signal for that, see the regression block below) before deciding against it.
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());

    expect(ref.current?.decideChanges(["7"], "accept")).toEqual(["7"]);
    expect(ref.current?.getContent()).toBe("Hello brave world\n");
  });

  it("returns an empty array and changes nothing when none of the ids is a live change", async () => {
    const content = "Hello world\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([]);
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe(content));

    expect(ref.current?.decideChanges(["99"], "accept")).toEqual([]);
    expect(ref.current?.getContent()).toBe(content);
  });

  it("returns null before the view has mounted", () => {
    openDocumentMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);

    expect(ref.current?.decideChanges(["1"], "accept")).toBeNull();
  });

  it("reports every id decided (including a swept-in group co-member — P4b) via onChangesDecided from any entry point", async () => {
    const content = "Name {--Tina--}{++CJ++} here\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "1", full: { from: 5, to: 15 }, kind: "deletion", text: { from: 8, to: 12 } },
      { id: "2", full: { from: 15, to: 23 }, kind: "insertion", text: { from: 18, to: 20 } },
    ]);
    const ref = createRef<EditorShellHandle>();
    const onChangesDecided = vi.fn();

    render(<EditorShell ref={ref} root="/project" path="a.md" onChangesDecided={onChangesDecided} />);
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeTruthy());

    // Auto-grouping links the adjacent deletion→insertion pair (module docs,
    // `TrackedChangesSeed.groups`) — deciding id 1 alone must still sweep in co-member id 2, and
    // `onChangesDecided` must report both, not just the id this call named.
    const decided = ref.current?.decideChanges(["1"], "accept");

    expect(decided?.slice().sort()).toEqual(["1", "2"]);
    expect(onChangesDecided).toHaveBeenCalledWith(expect.arrayContaining(["1", "2"]), "card");
  });
});

describe("editor/EditorShell — the async redline seed refreshes the toolbar on its own (regression)", () => {
  // `parseChanges` is a genuine IPC/HTTP round trip in the real app — it always resolves strictly
  // after the mount effect's `setReviewView` render has already committed with no context group, never
  // in the same microtask a same-tick-resolving mock would (a `mockResolvedValueOnce` here would
  // pass even on the buggy code, since React's deferred re-render happens to read the already-seeded
  // `view.state` by scheduling luck — masking exactly the timing this regression depends on). A
  // manually-resolved promise, resolved only *after* the initial absent state is observed, pins the
  // real ordering: a pure `seedTrackedChanges` dispatch (no doc edit, no selection move) must still
  // surface in the React-rendered toolbar with no other doc/selection change to nudge a re-render.
  // Before the fix, `EditorShell`'s `updateListener` bump only watched `docChanged`/`selectionSet`,
  // so a document opened with pending changes on disk silently kept its context group absent forever.
  it("shows the pending-change count once the seed lands with no other trigger", async () => {
    const content = "Hello {++brave ++}world\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:abc" });
    let resolveParse!: (changes: ParsedChange[]) => void;
    parseChangesMock.mockImplementationOnce(
      () => new Promise<ParsedChange[]>((resolve) => (resolveParse = resolve)),
    );

    render(<EditorShell root="/project" path="a.md" />);

    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());
    expect(screen.queryByRole("group", { name: "Review changes" })).toBeNull();

    resolveParse([{ id: "0", recorded: false, group: null, full: { from: 6, to: 18 }, kind: "insertion", text: { from: 9, to: 15 } }]);

    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());
  });
});

describe("editor/EditorShell — redline seed offsets on a CRLF document (#447)", () => {
  // `parse_changes` reports offsets into *the exact string it was handed* (UTF-16, via `Utf16Map`).
  // Those offsets are consumed straight as CM6 decoration positions and, on accept/reject, as the
  // range `decisionsTransaction` replaces. CM6 counts every line break — CRLF included — as one
  // position, so the text handed to the parse must be the same LF-joined string CM6 positions index
  // (`editorOffsetText`), never the CRLF-serialized disk text: that drifts by one unit per preceding
  // line break, misplacing redlines and — worse — editing the wrong range on accept (invariant 1).
  //
  // A CriticMarkup-aware stand-in for the real parser: it derives offsets from whatever content it
  // is given, exactly as the backend does, so a wrong-coordinate-space argument produces
  // wrong-coordinate-space offsets here too instead of being papered over by a fixed mock.
  const OPEN = "{++";
  const CLOSE = "++}";
  const parseInsertion = async (_doc: unknown, content: string): Promise<ParsedChange[]> => {
    const from = content.indexOf(OPEN);
    if (from === -1) return [];
    const to = content.indexOf(CLOSE) + CLOSE.length;
    return [
      {
        id: "7",
        recorded: false,
        group: null,
        full: { from, to },
        kind: "insertion",
        text: { from: from + OPEN.length, to: to - CLOSE.length },
      },
    ];
  };

  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveDocumentMock.mockResolvedValue(undefined);
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
  });

  it("parses against the LF-joined buffer text rather than the CRLF-serialized disk text", async () => {
    const content = "line one\r\nline two\r\nHello {++brave ++}world\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r1" });

    render(<EditorShell root="/project" path="a.md" />);

    await waitFor(() => expect(parseChangesMock).toHaveBeenCalled());
    // The document is named too (TD-16 ruling 3) — without it the parse joins no records and every
    // change opens under a fresh snapshot-scoped id instead of its durable one.
    expect(parseChangesMock).toHaveBeenCalledWith(
      { root: "/project", path: "a.md" },
      "line one\nline two\nHello {++brave ++}world\n",
    );
  });

  it("accepts a change at the right range on a CRLF document and leaves its line endings intact", async () => {
    const content = "line one\r\nline two\r\nHello {++brave ++}world\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r1" });
    parseChangesMock.mockImplementationOnce(parseInsertion);
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());

    expect(ref.current?.decideChanges(["7"], "accept")).toEqual(["7"]);
    // Off-by-two-per-line-break offsets would replace a window starting mid-`two\r\n`, mangling the
    // prose and the markup alike. P1 round-trip fidelity also requires the CRLF endings survive.
    expect(ref.current?.getContent()).toBe("line one\r\nline two\r\nHello brave world\r\n");
  });

  it("re-parses against the LF-joined buffer text after an external-change Reload too", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "line one\r\nline two\r\n", revision: "r1" });
    openDocumentMock.mockResolvedValue({
      content: "line one\r\nline two\r\nHello {++brave ++}world\r\n",
      revision: "r2",
    });

    render(<EditorShell root="/project" path="a.md" externalChangePollMs={10} />);
    await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() =>
      expect(parseChangesMock).toHaveBeenCalledWith(
        { root: "/project", path: "a.md" },
        "line one\nline two\nHello {++brave ++}world\n",
      ),
    );
  });
});

describe("editor/EditorShell — integrity banners (P2a-21)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    // A benign fallback beyond whatever a test explicitly queues via `mockResolvedValueOnce` — the
    // external-change poller can still be mid-flight when a test ends and `cleanup()` tears the
    // component down (a real `setTimeout`, not fake-timer-controlled here), so a stray extra poll
    // must resolve to *something* shaped right rather than `undefined` (an unhandled rejection).
    openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r0" });
    saveDocumentMock.mockReset();
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    saveDocumentMock.mockResolvedValue(undefined);
  });

  it("shows the CRLF banner once for a CRLF file — OK dismisses it without changing the normalize policy", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "line one\r\nline two\r\n", revision: "r1" });
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);

    await waitFor(() => expect(screen.getByText(/normalized to LF/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText(/normalized to LF/)).toBeNull();

    await ref.current?.save();
    expect(saveDocumentMock).toHaveBeenCalledWith("/project", "a.md", expect.any(String), true);
  });

  it("a normalizing save of a CRLF file still reports the tab clean (dirty baseline stays in the view's own line endings)", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "line one\r\nline two\r\n", revision: "r1" });
    saveDocumentMock.mockResolvedValueOnce(undefined);
    const ref = createRef<EditorShellHandle>();
    const onDirtyChange = vi.fn();

    render(
      <EditorShell ref={ref} root="/project" path="a.md" onDirtyChange={onDirtyChange} />,
    );
    await waitFor(() => expect(ref.current?.getContent()).toBe("line one\r\nline two\r\n"));

    const succeeded = await ref.current?.save();

    expect(succeeded).toBe(true);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("no CRLF banner for an LF-only file", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });

    render(<EditorShell root="/project" path="a.md" />);

    await waitFor(() => expect(openDocumentMock).toHaveBeenCalled());
    expect(screen.queryByText(/normalized to LF/)).toBeNull();
  });

  it("Don't convert this file suppresses LF normalization on the next save", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "line\r\n", revision: "r1" });
    const ref = createRef<EditorShellHandle>();

    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(screen.getByText(/normalized to LF/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Don't convert this file" }));
    expect(screen.queryByText(/normalized to LF/)).toBeNull();

    await ref.current?.save();
    expect(saveDocumentMock).toHaveBeenCalledWith("/project", "a.md", expect.any(String), false);
  });

  // Real timers + condition-based `waitFor` (test-plan §7), matching `autosave.test.ts`'s save-
  // runner suite: the poll interval is injected small (`POLL_MS`) so each test resolves in
  // milliseconds without racing a wall-clock default, rather than mixing fake timers with the
  // poller's real promise chain (`openDocument` round trips through an async mock either way).
  describe("external-change detection (FR-ED-7)", () => {
    const POLL_MS = 10;
    // An agent delivery's bytes as they land on disk, and the parse the backend returns for them —
    // what the poller reads when a delivery arrived while this tab was dirty (the UXR-Q3 path).
    const DELIVERED = "# Hi {++tightened++}\n";
    const DELIVERED_PARSE: ParsedChange[] = [
      {
        id: "0",
        recorded: false,
        group: null,
        full: { from: DELIVERED.indexOf("{++"), to: DELIVERED.indexOf("++}") + 3 },
        kind: "insertion",
        text: { from: DELIVERED.indexOf("{++") + 3, to: DELIVERED.indexOf("++}") },
      },
    ];

    const mountUndecidedAutosave = async () => {
      // Model one real disk boundary: the poll and save both observe/mutate the same durable bytes.
      // A captured scheduler callback is the deterministic clock seam here. The scheduler's own
      // debounce is covered in autosave.test.ts; these tests ask what EditorShell does when that
      // scheduled callback fires after an edit while the FR-ED-7 banner is still unresolved.
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      saveDocumentMock.mockImplementation(async (_root, _path, content: string) => {
        disk.content = content;
        disk.revision = "r3";
        return disk.revision;
      });
      let callback: (() => void) | undefined;
      let pending = false;
      const scheduler: AutosaveScheduler = {
        schedule: vi.fn(() => {
          pending = true;
        }),
        flush: vi.fn(() => {
          if (!pending) return;
          pending = false;
          callback?.();
        }),
        cancel: vi.fn(() => {
          pending = false;
        }),
      };
      vi.mocked(createAutosaveScheduler).mockImplementationOnce((save) => {
        callback = save;
        return scheduler;
      });
      const ref = createRef<EditorShellHandle>();
      const onDirtyChange = vi.fn();
      const rendered = render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onDirtyChange={onDirtyChange}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));

      disk.content = "A concurrent creator's bytes";
      disk.revision = "r2";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      const view = EditorView.findFromDOM(
        rendered.container.querySelector(".cm-editor") as HTMLElement,
      );
      act(() => {
        view?.dispatch({ changes: { from: view.state.doc.length, insert: "X" } });
      });
      expect(scheduler.schedule).toHaveBeenCalled();
      expect(callback).toBeTypeOf("function");
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      // Detection already cancelled work that predated the banner; the assertions below measure
      // whether the action under test also clears the edit scheduled after detection.
      vi.mocked(scheduler.cancel).mockClear();
      return {
        ...rendered,
        disk,
        ref,
        scheduler,
        onDirtyChange,
        fireAutosave: () => {
          pending = false;
          callback?.();
        },
      };
    };

    const mountInFlightSaveBarrier = async () => {
      // The mock owns publication, not merely promise settlement. Releasing a request makes its
      // bytes land unconditionally, matching CJ's detection-bound v1: cancellation cannot retract
      // an already-issued atomic save, so the editor must preserve the captured divergent side and
      // refuse every not-yet-issued request instead (#1599).
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      const releases: Array<() => void> = [];
      let saveCount = 0;
      saveDocumentMock.mockImplementation(
        (_root, _path, content: string) =>
          new Promise<string>((resolve) => {
            releases.push(() => {
              saveCount += 1;
              disk.content = content;
              disk.revision = `saved-${saveCount}`;
              resolve(disk.revision);
            });
          }),
      );
      let callback: (() => void) | undefined;
      let pending = false;
      const scheduler: AutosaveScheduler = {
        schedule: vi.fn(() => {
          pending = true;
        }),
        flush: vi.fn(() => {
          if (!pending) return;
          pending = false;
          callback?.();
        }),
        cancel: vi.fn(() => {
          pending = false;
        }),
      };
      vi.mocked(createAutosaveScheduler).mockImplementationOnce((save) => {
        callback = save;
        return scheduler;
      });
      const ref = createRef<EditorShellHandle>();
      const onDirtyChange = vi.fn();
      const rendered = render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onDirtyChange={onDirtyChange}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));
      const view = EditorView.findFromDOM(
        rendered.container.querySelector(".cm-editor") as HTMLElement,
      );
      const edit = (text: string) => {
        act(() => {
          view?.dispatch({ changes: { from: view.state.doc.length, insert: text } });
        });
      };
      const fireAutosave = () => {
        pending = false;
        callback?.();
      };
      const releaseNext = async () => {
        const release = releases.shift();
        expect(release).toBeTypeOf("function");
        await act(async () => release?.());
      };
      return { ...rendered, disk, edit, fireAutosave, onDirtyChange, ref, releaseNext };
    };

    it("never answers a poll read with a value openDocument cannot return (#1690)", async () => {
      // Queue one answer and let the poll outrun it, which is what a contended machine does to any
      // fixture here that injects a fast poll (see this mock's declaration for why nothing bounds
      // that). Resetting first is the shape that caused #1690: a helper that resets mid-test to
      // install its own reads must still leave the fake able to answer the ones it did not queue.
      //
      // Forcing that unqueued read deterministically is half the guard on its own — vitest fails
      // the run over an unhandled rejection, so a default the shell cannot consume reddens this
      // file whether or not the assertion below is the thing that catches it.
      openDocumentMock.mockReset();
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });

      render(<EditorShell root="/project" path="a.md" externalChangePollMs={1} />);

      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThan(1));
      for (const read of openDocumentMock.mock.results) {
        expect(read.value).toBeInstanceOf(Promise);
      }
    });

    it("states a tail failure once — not every tick — when the poll's read resolves but processing it throws (#1701)", async () => {
      // Reproduces #1690's exact shape — the read itself succeeds, but something downstream of it
      // (here, accessing `disk.content`) throws — without the `undefined` the type forbids. With an
      // `onError` consumer wired, the guarded tail (`EditorShell.tsx`'s `checkDiskForExternalChange`)
      // reports the failure exactly once rather than once per tick, which would make a persistent
      // failure indistinguishable from a fresh one.
      const onError = vi.fn();
      const throwingPayload = {
        get content(): string {
          throw new Error("boom");
        },
        revision: "r1",
      };
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" }); // initial load
      openDocumentMock.mockResolvedValue(
        throwingPayload as unknown as { content: string; revision: string },
      );

      render(<EditorShell root="/project" path="a.md" onError={onError} externalChangePollMs={1} />);

      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThan(4));
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("re-throws past a missing onError consumer rather than swallowing the tail's failure (#1701)", async () => {
      // The property this diff exists to guarantee — "with no `onError` consumer, the tail's
      // rejection escapes rather than getting swallowed" — cannot be pinned by awaiting the poller's
      // own `.finally()` chain the way the two cases above do: that path can only ever *observe* an
      // escaped rejection (as an unhandled one, after the fact), never assert on it in-process.
      // Calling the captured `check` callback directly and awaiting its rejection *consumes* it
      // instead, which is what lets this pass at this head, fail under a `throw` → `return` swallow
      // regression, and still emit no unhandled rejection of its own. A large poll interval keeps
      // the poller's own real timer from independently firing a second, concurrent invocation during
      // the test (review Important 1, #1701).
      capturedCheck = null;
      const throwingPayload = {
        get content(): string {
          throw new Error("boom");
        },
        revision: "r1",
      };
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" }); // initial load
      openDocumentMock.mockResolvedValue(
        throwingPayload as unknown as { content: string; revision: string },
      );

      render(<EditorShell root="/project" path="a.md" externalChangePollMs={100_000} />);
      await waitFor(() => expect(capturedCheck).not.toBeNull());

      await expect(capturedCheck!()).rejects.toThrow("boom");
    });

    it("re-arms the tail-failure report after an intervening check that completes normally (#1701)", async () => {
      const onError = vi.fn();
      const throwingPayload = {
        get content(): string {
          throw new Error("boom");
        },
        revision: "r1",
      };
      openDocumentMock.mockReset();
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" }); // initial load
      openDocumentMock.mockResolvedValueOnce(
        throwingPayload as unknown as { content: string; revision: string },
      ); // poll 1: tail throws
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" }); // poll 2: no divergence, completes normally
      openDocumentMock.mockResolvedValue(
        throwingPayload as unknown as { content: string; revision: string },
      ); // poll 3+: tail throws again

      render(<EditorShell root="/project" path="a.md" onError={onError} externalChangePollMs={1} />);

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
      // Stays at 2: every poll from here on is the same repeating failure, already reported for
      // this run — not news on every tick (FR-X-5).
      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThan(5));
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it("resets the tail-failure report between documents — the next document's first failure is not silently carried over (#1701)", async () => {
      // The consequence if `checkFailureReportedRef`'s per-document reset (the mount effect's reset
      // block, alongside `pauseReadFailureReportedRef` and the rest) ever regresses is the worst
      // outcome available here: a stale `true` inherited from the PRIOR document makes the NEXT
      // document's first tail failure neither reported to `onError` nor re-thrown (an `onError`
      // consumer is wired below, so the guard's `if (!checkFailureReportedRef.current)` is the only
      // thing standing between this failure and total silence) — precisely what this card forbids.
      // Modeled on "leaves no part of one document's pause behind for the next document" above,
      // extended to this new ref (review Important 2, #1701).
      const onError = vi.fn();
      const throwingPayload = {
        get content(): string {
          throw new Error("boom");
        },
        revision: "r1",
      };
      openDocumentMock.mockResolvedValueOnce({ content: "# A\n", revision: "ra" }); // A's initial load
      openDocumentMock.mockResolvedValue(
        throwingPayload as unknown as { content: string; revision: string },
      );

      const { rerender } = render(
        <EditorShell root="/project" path="notes/a.md" onError={onError} externalChangePollMs={1} />,
      );
      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

      // A different document. Its own first tail failure must be reported on its own terms, not
      // suppressed by A's already-`true` flag.
      openDocumentMock.mockReset();
      openDocumentMock.mockResolvedValueOnce({ content: "# B\n", revision: "rb" }); // B's initial load
      openDocumentMock.mockResolvedValue(
        throwingPayload as unknown as { content: string; revision: string },
      );
      rerender(
        <EditorShell root="/project" path="notes/b.md" onError={onError} externalChangePollMs={1} />,
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    });

    it("polls and shows the banner once the disk content diverges from the editor's known baseline", async () => {
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" }); // initial load
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi (edited elsewhere)\n", revision: "r2" }); // poll

      render(<EditorShell root="/project" path="a.md" externalChangePollMs={POLL_MS} />);

      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
    });

    it("does not let a later edit autosave over disk while the external-change choice is undecided (#1599)", async () => {
      const { disk, fireAutosave, onDirtyChange, ref } = await mountUndecidedAutosave();

      act(() => fireAutosave());

      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(disk.content).toBe("A concurrent creator's bytes");
      expect(ref.current?.getContent()).toBe("Original disk bytesX");
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });

    it("does not flush the pending autosave over divergent disk when the editor unmounts (#1599)", async () => {
      const { disk, ref, scheduler, unmount } = await mountUndecidedAutosave();
      expect(ref.current?.getContent()).toBe("Original disk bytesX");

      unmount();

      expect(scheduler.flush).toHaveBeenCalledOnce();
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(disk.content).toBe("A concurrent creator's bytes");
    });

    it("still writes a trailing edit queued behind an in-flight save when the editor unmounts with no divergence (#1599)", async () => {
      // The non-divergent mirror of the test above: no FR-ED-7 pause is ever raised here, so
      // unmount's flush must not drop the final edit either. Review finding: the unconditional
      // `runSave.cancelTrailing()` that used to follow `scheduler?.flush()` cancelled the flush's
      // own just-coalesced trailing write whenever an ordinary save was already in flight at
      // teardown — losing edits FR-ED-7/ux-design never scoped this pause to touch.
      const { disk, edit, fireAutosave, releaseNext, unmount } = await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      expect(saveDocumentMock).toHaveBeenCalledTimes(1);
      edit("B");
      act(() => fireAutosave());
      // "B" arrived while "A" was still in flight, so it coalesced into a trailing write rather than
      // issuing a second concurrent `save_document` call.
      expect(saveDocumentMock).toHaveBeenCalledTimes(1);

      unmount();

      // Releasing the in-flight "A" write lets the runner issue the coalesced trailing "AB" write.
      await releaseNext();
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(2));
      await releaseNext();

      expect(disk.content).toBe("Original disk bytesAB");
    });

    it("manual Save writes nothing and returns attention to Keep mine while the choice is undecided (#1599)", async () => {
      const { container, disk, scheduler } = await mountUndecidedAutosave();

      fireEvent.keyDown(container.querySelector(".cm-content") as HTMLElement, {
        key: "s",
        metaKey: /Mac/.test(navigator.platform),
        ctrlKey: !/Mac/.test(navigator.platform),
      });

      expect(scheduler.cancel).toHaveBeenCalledOnce();
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(disk.content).toBe("A concurrent creator's bytes");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Keep mine" })).toHaveFocus(),
      );
    });

    it("manual Save (Ctrl/Cmd+S) rewrites both banner lines to the exact blocked-Save copy, not only the focus move (AC3, review Important 2, PR #2108)", async () => {
      const { container } = await mountUndecidedAutosave();

      fireEvent.keyDown(container.querySelector(".cm-content") as HTMLElement, {
        key: "s",
        metaKey: /Mac/.test(navigator.platform),
        ctrlKey: !/Mac/.test(navigator.platform),
      });

      await waitFor(() =>
        expect(
          screen.getByText("Not saved — this file changed outside the editor"),
        ).toBeTruthy(),
      );
      expect(
        screen.getByText("Cowrite didn’t write over it. Choose Reload, Keep mine, or Compare."),
      ).toBeTruthy();
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("imperative Save reports refusal and returns attention while the choice is undecided (#1599)", async () => {
      const { disk, ref, scheduler } = await mountUndecidedAutosave();

      await expect(ref.current?.save()).resolves.toBe(false);

      expect(scheduler.cancel).toHaveBeenCalledOnce();
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(disk.content).toBe("A concurrent creator's bytes");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Keep mine" })).toHaveFocus(),
      );
    });

    it("Keep mine immediately saves edits accumulated while autosave was paused (#1599)", async () => {
      const { disk, onDirtyChange, scheduler } = await mountUndecidedAutosave();

      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

      await waitFor(() =>
        expect(saveDocumentMock).toHaveBeenCalledWith(
          "/project",
          "a.md",
          "Original disk bytesX",
          true,
        ),
      );
      expect(scheduler.cancel).toHaveBeenCalledOnce();
      expect(disk.content).toBe("Original disk bytesX");
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it("does not launch a queued trailing save after divergence is detected while the first save settles (#1599)", async () => {
      const { disk, edit, fireAutosave, releaseNext } = await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      edit("B");
      act(() => fireAutosave());
      expect(saveDocumentMock).toHaveBeenCalledTimes(1);

      disk.content = "External bytes C";
      disk.revision = "rC";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      await releaseNext();

      expect(saveDocumentMock).toHaveBeenCalledTimes(1);
      // Detection-bound v1 permits already-issued A to publish; B was never issued.
      expect(disk).toEqual({ content: "Original disk bytesA", revision: "saved-1" });
    });

    it("an already-issued completion leaves the captured banner and Compare side intact (#1599)", async () => {
      const { disk, edit, fireAutosave, onDirtyChange, ref, releaseNext } =
        await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      expect(saveDocumentMock).toHaveBeenCalledTimes(1);

      disk.content = "External bytes C";
      disk.revision = "rC";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
      expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent("External bytes C");
      const readsBeforeIssuedCompletion = openDocumentMock.mock.calls.length;
      await releaseNext();
      // Prove a later poll cannot replace the first capture with the issued save's payload.
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThan(readsBeforeIssuedCompletion),
      );

      expect(disk).toEqual({ content: "Original disk bytesA", revision: "saved-1" });
      expect(ref.current?.getContent()).toBe("Original disk bytesA");
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent("External bytes C");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
    });

    it("Reload recovers the captured disk bytes after an already-issued save publishes (#1599)", async () => {
      getSettingsMock.mockResolvedValueOnce({
        schema_version: 1,
        autosave: { enabled: false, interval_ms: 1_000 },
        notifications: { completion: true },
        provider_default: null,
      });
      const { disk, edit, fireAutosave, onDirtyChange, ref, releaseNext, unmount } =
        await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      disk.content = "External bytes C";
      disk.revision = "rC";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      await releaseNext();
      expect(disk.content).toBe("Original disk bytesA");

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      expect(ref.current?.getContent()).toBe("External bytes C");
      // Reload selected C, but C is not durable and the buffer is not honestly clean until this
      // explicit recovery write lands. No autosave setting is available to rescue it later.
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      // The banner itself stays mounted, busy, for one microtask (#2074 AC4's `reloading` phase)
      // before yielding to the bannerless `reload-write-pending` window (AC5) — so its disappearance
      // is asserted once the recovery write has actually been issued, not in the same tick as the
      // click.
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(2));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(disk.content).toBe("Original disk bytesA");
      await releaseNext();
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
      expect(disk.content).toBe("External bytes C");

      unmount();
      const reopenedRef = createRef<EditorShellHandle>();
      render(
        <EditorShell
          ref={reopenedRef}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
        />,
      );
      await waitFor(() => expect(reopenedRef.current?.getContent()).toBe("External bytes C"));
      expect(disk.content).toBe("External bytes C");
    });

    it("ignores issued A but advances the captured side from external C to later external D (#1599)", async () => {
      const { disk, edit, fireAutosave, releaseNext } = await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      disk.content = "External bytes C";
      disk.revision = "rC";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
      expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent("External bytes C");

      await releaseNext();
      const readsBeforeA = openDocumentMock.mock.calls.length;
      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThan(readsBeforeA));
      expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent("External bytes C");

      disk.content = "Later external bytes D";
      disk.revision = "rD";
      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent(
          "Later external bytes D",
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(2));
      await releaseNext();

      expect(disk.content).toBe("Original disk bytesA");
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("Keep mine is the sole authorized next write after an already-issued save publishes (#1599)", async () => {
      const { disk, edit, fireAutosave, onDirtyChange, releaseNext } =
        await mountInFlightSaveBarrier();
      edit("A");
      act(() => fireAutosave());
      edit("B");
      act(() => fireAutosave());
      disk.content = "External bytes C";
      disk.revision = "rC";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      await releaseNext();
      expect(saveDocumentMock).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(2));
      // Hold Keep mine's write while at least one poll observes issued A's completed publication.
      // That publication is known Cowrite output, not a new external side that may revoke B.
      const readsBeforeKeepMineCompletion = openDocumentMock.mock.calls.length;
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThan(readsBeforeKeepMineCompletion),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      await releaseNext();
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
      expect(disk.content).toBe("Original disk bytesAB");
    });

    it("does not let an issued completion from a prior document identity poison the next disk baseline (#1599)", async () => {
      const disks = new Map([
        ["a.md", { content: "Document A", revision: "ra1" }],
        ["b.md", { content: "Document B", revision: "rb1" }],
      ]);
      openDocumentMock.mockImplementation(async (_root, path: string) => ({
        ...(disks.get(path) as { content: string; revision: string }),
      }));
      let releaseA: () => void = () => {};
      saveDocumentMock.mockImplementation(
        (_root, path: string, content: string) =>
          new Promise<string>((resolve) => {
            releaseA = () => {
              disks.set(path, { content, revision: "ra2" });
              resolve("ra2");
            };
          }),
      );
      const ref = createRef<EditorShellHandle>();
      const rendered = render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          autosaveIntervalMs={3_600_000}
          externalChangePollMs={POLL_MS}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Document A"));
      const view = EditorView.findFromDOM(
        rendered.container.querySelector(".cm-editor") as HTMLElement,
      );
      act(() => view?.dispatch({ changes: { from: view.state.doc.length, insert: " saved" } }));
      const issuedA = ref.current?.save();
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(1));

      rendered.rerender(
        <EditorShell
          ref={ref}
          root="/project"
          path="b.md"
          autosaveIntervalMs={3_600_000}
          externalChangePollMs={POLL_MS}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Document B"));
      // The new outside bytes deliberately equal A's issued payload. Only document identity can
      // distinguish them from A's known publication; content equality cannot.
      disks.set("b.md", { content: "Document A saved", revision: "rb2" });
      await act(async () => {
        releaseA();
        await issuedA;
      });

      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());
      expect(ref.current?.getContent()).toBe("Document B");
    });

    it("does not show the banner while the disk content still matches the known baseline", async () => {
      openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" }); // every call, same content

      render(<EditorShell root="/project" path="a.md" externalChangePollMs={POLL_MS} />);

      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("Reload replaces the buffer with the disk content and the banner clears", async () => {
      const initial = "---\ntitle: Local\n---\n\n# Hi\n";
      const disk = "---\ntitle: Disk\n---\n\n# Hi (edited elsewhere)\n";
      openDocumentMock.mockResolvedValueOnce({ content: initial, revision: "r1" });
      // Every read after mount sees the same durable disk revision. Leaving later poll reads
      // undefined makes this interval-driven test model an impossible filesystem and can obscure
      // whether Reload itself kept the banner cleared.
      openDocumentMock.mockResolvedValue({ content: disk, revision: "r2" });
      const ref = createRef<EditorShellHandle>();

      const { container } = render(
        <EditorShell ref={ref} root="/project" path="a.md" externalChangePollMs={POLL_MS} />,
      );
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      // `dispatch` updates the authoritative EditorState synchronously. CodeMirror projects that
      // state into its contenteditable DOM on its own update boundary, though, so the React banner
      // disappearing is not a completion signal for the separate CM6 surface (#1541). Pin both:
      // callers can read the disk revision immediately, and the visible editor eventually paints
      // that same revision without a timer or arbitrary delay.
      expect(ref.current?.getContent()).toBe(disk);
      await waitFor(() =>
        expect(container.querySelector(".cm-content")).toHaveTextContent("# Hi (edited elsewhere)"),
      );
      // The banner's own busy `reloading` phase (#2074 AC4) shares the CM6 paint's timing with
      // nothing — it is a separate async chain that settles once the recovery write is actually
      // issued, not once CM6 has painted. Waiting for the write's own issuance (rather than relying
      // on CM6's paint as an implicit proxy for it) is what makes this deterministic instead of a
      // race between the two.
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("Reload seeds the field's UXR-Q4 generation with the revision it just took off disk", async () => {
      // The recovery path UXR-Q3 exists to provide: a delivery landed on disk while this tab was
      // dirty, so the in-buffer apply was suppressed and the change-set card carries the delivered
      // revision. Reload puts exactly the delivered bytes (and their parse) into the buffer — so
      // the field's generation must move to *that* revision, or the card the delivery raised stays
      // permanently untriageable against the very content it now holds (#346 round-5 review).
      // Seeding no generation here would fail closed forever rather than re-enabling when provable.
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValueOnce({ content: DELIVERED, revision: "rev-2" });
      const onChangeGenerationChange = vi.fn();

      render(
        <EditorShell
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onChangeGenerationChange={onChangeGenerationChange}
        />,
      );
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      parseChangesMock.mockResolvedValueOnce(DELIVERED_PARSE);
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      await waitFor(() => expect(onChangeGenerationChange).toHaveBeenLastCalledWith("rev-2"));
    });

    it("Keep mine dismisses the banner and does not re-show it for the same disk content", async () => {
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: "# Hi (edited elsewhere)\n", revision: "r2" }); // every poll after

      render(<EditorShell root="/project" path="a.md" externalChangePollMs={POLL_MS} />);
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();

      // Several further polls, all still reporting the same (now-dismissed) disk content.
      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(4));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("Keep mine is the highlighted default when the tab has unsaved local edits", async () => {
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: "# Hi (edited elsewhere)\n", revision: "r2" });

      render(
        <EditorShell
          root="/project"
          path="a.md"
          initialContent={"# Hi (my unsaved edit)\n"}
          externalChangePollMs={POLL_MS}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Keep mine" }).className).toContain("--default"),
      );
    });

    it("resets the blocked-Save copy once a fresh divergence replaces the blocked one (review Minor, PR #2108)", async () => {
      // `updateExternalChange`'s own `setSaveBlocked(false)` reset — without it, a stale blocked-
      // Save rewrite from an already-resolved episode would bleed into a brand-new, unrelated one.
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi (edited elsewhere)\n", revision: "r2" });
      const ref = createRef<EditorShellHandle>();

      render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          initialContent={"# Hi (my unsaved edit)\n"}
          externalChangePollMs={POLL_MS}
        />,
      );
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      await ref.current?.save();
      await waitFor(() =>
        expect(screen.getByText("Not saved — this file changed outside the editor")).toBeTruthy(),
      );

      // A genuinely different disk revision replaces the episode.
      openDocumentMock.mockResolvedValue({ content: "# Hi (edited again, differently)\n", revision: "r3" });

      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      expect(screen.queryByText("Not saved — this file changed outside the editor")).toBeNull();
    });

    it("a normalizing save of a CRLF file does not itself trip a spurious external-change banner (review finding)", async () => {
      // The editor mounts CRLF (as the file is on disk); saving normalizes it to LF backend-side
      // (FR-ED-2, normalization on by default). The baseline the poll compares against must track
      // the LF bytes the save actually wrote, not the pre-normalization CRLF editor text, or every
      // subsequent poll (reading back the now-LF disk) falsely reports an out-of-band edit.
      // The mocks model the *disk*, not a fixed call sequence: it holds CRLF until the normalizing
      // save rewrites it as LF. Queueing the LF read up front instead would claim the file was
      // already normalized before the save ran, so any poll tick landing in the (10ms) window
      // before `save()` would compare LF against the CRLF baseline and trip the very banner this
      // test asserts is absent — a race, not a behavior (#368). Driving reads off the same state
      // the save mutates makes the assertion hold whatever order the poll and the save interleave.
      const disk = { content: "line one\r\nline two\r\n", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      saveDocumentMock.mockImplementation(async () => {
        disk.content = "line one\nline two\n";
        disk.revision = "r2";
      });
      const ref = createRef<EditorShellHandle>();

      render(<EditorShell ref={ref} root="/project" path="a.md" externalChangePollMs={POLL_MS} />);
      await waitFor(() => expect(ref.current?.getContent()).toBe("line one\r\nline two\r\n"));

      await ref.current?.save();
      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "a.md",
        "line one\r\nline two\r\n",
        true,
      );

      await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("a poll tick landing before the normalizing save still reports no external change (#368)", async () => {
      // Pins the *shape* of the mocks above, not just their happy path. The disk-model mocks are
      // load-bearing precisely in the interleaving the previous test cannot force: a poll that
      // fires in the window before `save()` runs. Here that tick is forced deterministically
      // (wait for a post-mount poll, then save) rather than left to timing. Modelling the disk
      // keeps the pre-save read CRLF — matching the baseline — so no banner appears. A queued
      // sequence that hands out the post-save LF content up front instead claims the file was
      // normalized before the save wrote it, and this pre-save tick then compares LF against the
      // CRLF baseline and trips the banner: this test fails against that shape, which is what
      // stops it from coming back.
      const disk = { content: "line one\r\nline two\r\n", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      saveDocumentMock.mockImplementation(async () => {
        disk.content = "line one\nline two\n";
        disk.revision = "r2";
      });
      const ref = createRef<EditorShellHandle>();

      render(<EditorShell ref={ref} root="/project" path="a.md" externalChangePollMs={POLL_MS} />);
      await waitFor(() => expect(ref.current?.getContent()).toBe("line one\r\nline two\r\n"));

      // Force at least one poll to complete *before* the save runs (the racy window).
      const callsBeforeSave = openDocumentMock.mock.calls.length;
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThan(callsBeforeSave),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();

      const callsAtSave = openDocumentMock.mock.calls.length;
      await ref.current?.save();

      // Wait for a poll that read the disk *after* the save rewrote it as LF — that read is the one
      // that would trip the banner if the baseline had not tracked the normalized bytes. Two calls,
      // not one: a poll already in flight when `save()` ran captured the disk before the mutation,
      // so only the second is guaranteed to have observed LF content.
      const callsForPostSaveRead = callsAtSave + 2;
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(callsForPostSaveRead),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("Compare shows both versions and Close returns to the banner without resolving it", async () => {
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: "# Hi (edited elsewhere)\n", revision: "r2" });

      render(
        <EditorShell
          root="/project"
          path="a.md"
          initialContent={"# Hi (my unsaved edit)\n"}
          externalChangePollMs={POLL_MS}
        />,
      );
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
      expect(screen.getByText("# Hi (my unsaved edit)")).toBeTruthy();
      expect(screen.getByText("# Hi (edited elsewhere)")).toBeTruthy();
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
    });
  });

  /**
   * The presentation phases #2074 adds around the existing FR-ED-7 episode (AC1): `reloading`
   * (AC4), the bannerless `reload-write-pending` dirty window (AC5), and the CJ-ratified `failed`
   * disposition (AC6/AC7, #1641, 2026-08-28). Every case reuses the *same* atomic save runner —
   * `saveDocumentMock` — never a second one; there is no separate mock to install for "the recovery
   * write" versus "an ordinary save".
   */
  describe("Reload recovery-write phases (#2074)", () => {
    const POLL_MS = 10;
    const mountDiverged = async (onError?: (error: unknown) => void) => {
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      let callback: (() => void) | undefined;
      let pending = false;
      const scheduler: AutosaveScheduler = {
        schedule: vi.fn(() => {
          pending = true;
        }),
        flush: vi.fn(() => {
          if (!pending) return;
          pending = false;
          callback?.();
        }),
        cancel: vi.fn(() => {
          pending = false;
        }),
      };
      vi.mocked(createAutosaveScheduler).mockImplementationOnce((save) => {
        callback = save;
        return scheduler;
      });
      const ref = createRef<EditorShellHandle>();
      const onDirtyChange = vi.fn();
      const rendered = render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onDirtyChange={onDirtyChange}
          onError={onError}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));
      disk.content = "External bytes C";
      disk.revision = "r2";
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      return {
        ...rendered,
        disk,
        ref,
        onDirtyChange,
        fireAutosave: () => {
          pending = false;
          callback?.();
        },
      };
    };

    it("observed external-change replaces the old Saved claim with writes paused", async () => {
      await mountDiverged();
      const status = within(screen.getByRole("region", { name: "Document status" }));
      expect(status.getByText("Not saved — writes paused")).toBeVisible();
      expect(status.queryByText(/^Saved · /)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await waitFor(() => expect(status.queryByText("Not saved — writes paused")).toBeNull());
    });

    it("Reload enters aria-busy with the three actions dimmed but mounted, not removed (AC4)", async () => {
      await mountDiverged();
      // Held forever — the row's own busy render (synchronous with the click, before even the first
      // microtask `attemptRecoveryWrite` yields on its way to the bannerless AC5 window) is what
      // this pins, not the write settling.
      saveDocumentMock.mockImplementationOnce(() => new Promise(() => {}));

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("Reloading…")).toBeTruthy();
      expect(within(screen.getByRole("region", { name: "Document status" }))
        .getByText("Reloaded from disk · not saved yet")).toBeVisible();
      expect(
        screen.getByText(
          "Bringing in the version from disk and saving it in place. Your earlier text is being replaced.",
        ),
      ).toBeTruthy();
      for (const name of ["Reload", "Keep mine", "Compare"]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    });

    it("the reload-write-pending window carries its status readout while the recovery write is held (11c.4, AC5)", async () => {
      const { onDirtyChange } = await mountDiverged();
      let releaseSave: ((revision: string) => void) | undefined;
      saveDocumentMock.mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          releaseSave = resolve;
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledTimes(1));

      // Bannerless (11c.4 draws the tab dot and a status readout, no amber bar) — but honestly
      // dirty, not resolved: the absence of a banner must never be mistaken for "saved".
      const pendingReadout =
        within(screen.getByRole("region", { name: "Document status" })).getByText(
          "Reloaded from disk · not saved yet",
        );
      expect(pendingReadout).toBeVisible();
      expect(pendingReadout).not.toHaveClass("document-save-status--failed");
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      await act(async () => {
        releaseSave?.("r3");
      });
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
      // No transient state reported success early, and success restores the ordinary Windows state.
      expect(
        within(screen.getByRole("region", { name: "Document status" })).getByText(/^Saved · /),
      ).toBeVisible();
      expect(screen.queryByText("Reloaded from disk · not saved yet")).toBeNull();
    });

    it("a failed recovery write shows the honest heading, the real reason, and omits Keep mine (AC6, #1641)", async () => {
      await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      await waitFor(() =>
        expect(
          screen.getByText("The version from disk is here, but it isn’t saved"),
        ).toBeTruthy(),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(
        screen.getByText(
          (_, node) =>
            node?.textContent ===
            "Couldn’t save the reloaded file. Permission denied. Nothing was lost — the text on screen is the disk version.",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Compare" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
      expect(
        within(screen.getByRole("region", { name: "Document status" })).getByText(
          "Reloaded from disk · not saved yet",
        ),
      ).toHaveClass("document-save-status--failed");
    });

    it("recovery-write errors stay in the contextual banner on Reload and Try again", async () => {
      const onError = vi.fn();
      await mountDiverged(onError);
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByText((_, node) =>
        node?.classList.contains("integrity-banner__failure") === true &&
        node.textContent?.includes("Couldn’t save the reloaded file. Permission denied.") === true,
      )).toBeVisible());
      expect(onError).not.toHaveBeenCalled();

      saveDocumentMock.mockRejectedValueOnce(new Error("Disk full."));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByText((_, node) =>
        node?.classList.contains("integrity-banner__failure") === true &&
        node.textContent?.includes("Couldn’t save the reloaded file. Disk full.") === true,
      )).toBeVisible());
      expect(onError).not.toHaveBeenCalled();
    });

    it("preserves the reloaded buffer verbatim after a failed recovery write", async () => {
      const { ref } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );
      // The captured disk bytes Reload swapped in — not reverted, not altered, not re-fetched.
      expect(ref.current?.getContent()).toBe("External bytes C");
    });

    it("stays honestly dirty and keeps the write pause active after a failed recovery write", async () => {
      const { onDirtyChange, fireAutosave, ref } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      const callsAfterFailure = saveDocumentMock.mock.calls.length;

      // An ordinary autosave tick must not slip a write through the failure — only Try again/Save
      // As… may.
      act(() => fireAutosave());
      expect(saveDocumentMock).toHaveBeenCalledTimes(callsAfterFailure);

      // Nor may an explicit Cmd/Ctrl+S / dirty-close-guard save — it refuses honestly instead,
      // leaving the guard (and the buffer it protects) open.
      const saved = await ref.current?.save();
      expect(saved).toBe(false);
      expect(saveDocumentMock).toHaveBeenCalledTimes(callsAfterFailure);
    });

    it("Try again resubmits the current buffer and clears the episode on success (AC7)", async () => {
      const { ref, onDirtyChange } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );

      saveDocumentMock.mockResolvedValueOnce("r3");
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
      expect(screen.queryByRole("status")).toBeNull();
      expect(saveDocumentMock).toHaveBeenLastCalledWith(
        "/project",
        "a.md",
        "External bytes C",
        true,
      );
      expect(ref.current?.getContent()).toBe("External bytes C");
    });

    it("Try again resubmits whatever the buffer holds now, including an edit made since the failure", async () => {
      const { container } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );

      // Typing is never blocked while this banner is up (ux-design Principle 2).
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: view.state.doc.length, insert: " and more" } });
      });

      saveDocumentMock.mockResolvedValueOnce("r3");
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() =>
        expect(saveDocumentMock).toHaveBeenLastCalledWith(
          "/project",
          "a.md",
          "External bytes C and more",
          true,
        ),
      );
    });

    it("a repeat failure on Try again shows the new real reason, not the first one", async () => {
      await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByText(/Permission denied\./)).toBeTruthy());

      saveDocumentMock.mockRejectedValueOnce(new Error("Disk full."));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(screen.getByText(/Disk full\./)).toBeTruthy());
      expect(screen.queryByText(/Permission denied\./)).toBeNull();
      // Still the honest failure state — Keep mine is still absent on the repeat failure.
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
    });

    it("Try again is bounded to one in-flight attempt", async () => {
      await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );

      let releaseRetry: ((revision: string) => void) | undefined;
      saveDocumentMock.mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          releaseRetry = resolve;
        }),
      );
      const callsBeforeRetry = saveDocumentMock.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      // A second click lands on the now-disabled button — the same "dimmed and stop responding"
      // treatment AC4 specifies for the busy phase, reused here for a retry in flight.
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() =>
        expect(saveDocumentMock).toHaveBeenCalledTimes(callsBeforeRetry + 1),
      );
      await act(async () => {
        releaseRetry?.("r3");
      });
      // Still exactly one further write — the second click never submitted a second one.
      expect(saveDocumentMock).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    });

    // Review CRITICAL (PR #2108): the `failed` phase must never turn FR-ED-7 detection off. A
    // third party's write landing while the failure banner sits there — unbounded in time — has to
    // be observed, and `Try again` must never be free to overwrite it silently. What genuinely
    // needs suppressing is only a re-raise of the *same* bytes Reload already captured (the axis
    // `dismissedDiskContentRef` now covers identically to Keep mine), never a truly different
    // disk revision.
    it("a genuinely new external divergence during the failed state is still observed — the ordinary banner supersedes it", async () => {
      const { disk } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );

      // A genuinely different disk revision — not a re-read of the bytes Reload already captured.
      disk.content = "A third party's newer bytes";
      disk.revision = "r-third-party";

      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      // The stale failed-Reload UI is gone — a fresh divergence supersedes it rather than leaving
      // `Try again` offered against information that is no longer current.
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
    });

    it("does not re-raise the same captured bytes as a fresh divergence once a recovery attempt has failed", async () => {
      // The companion property to the test above, proven from the opposite direction: the *same*
      // bytes Reload just captured must not keep re-triggering as if they were a brand-new
      // surprise on every later poll tick — the exact failure mode a naive "advance diskContentRef
      // on Reload click" fix reintroduces (review CRITICAL, PR #2108's own review comment on the
      // first attempt at this fix). Deliberately probed from the *failed* phase, not the in-flight
      // `reloading`/`pending` window: while a write is held open, `ownPublication` (the existing
      // #1599 mechanism) already keeps the poll from misreading it as external on its own, so a
      // test only covering that window cannot tell `dismissedDiskContentRef`'s own contribution
      // apart from a mechanism that already existed — this reddened at merge-base-shaped code with
      // `ownPublication` faked away, and did not reveal itself against the shared in-flight window.
      // Once a write actually *fails*, `ownPublication` is cleared (the write callback's own catch
      // branch), so only `dismissedDiskContentRef` stands between the poll and a spurious re-raise.
      const { disk } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      // Captured *before* the click: `mountDiverged` itself already drives several polls
      // (establishing the divergence), so a bound taken from zero would already be satisfied and
      // prove nothing about ticks that land *after* Reload. `mountDiverged`'s poller is already
      // running on a real (unmocked) timer, so a spurious re-capture — were the fix broken — could
      // in principle land at any point from here on; deliberately no intermediate assertion (e.g.
      // "Try again" appearing) is taken as a checkpoint, since that would itself race the very
      // defect this test exists to catch. Only the end state after real polls have had time to land
      // is asserted, with `waitFor`'s own retry absorbing exactly when that state settles.
      const readsBeforeReload = openDocumentMock.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      // Several fresh poll ticks land, post-failure, while the disk still reads exactly the bytes
      // Reload already captured — none of them may resurrect the ordinary banner over the failed one.
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(readsBeforeReload + 5),
      );
      await waitFor(() =>
        expect(
          screen.getByText("The version from disk is here, but it isn’t saved"),
        ).toBeTruthy(),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(disk.content).toBe("External bytes C");
    });

    it("a new external divergence captured while a retry is in flight is not silently overwritten by that retry landing", async () => {
      const { disk, onDirtyChange } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );
      onDirtyChange.mockClear();

      let releaseRetry: ((revision: string) => void) | undefined;
      saveDocumentMock.mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          releaseRetry = resolve;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(releaseRetry).toBeTypeOf("function"));

      // A third party writes different bytes while the retry's own write is still outstanding.
      disk.content = "A third party's newer bytes";
      disk.revision = "r-third-party";
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );

      // The retry's already-issued write is allowed to land (detection-bound v1 — the same rule an
      // ordinary already-issued save already follows), but its completion must not claim the
      // document is saved, and must not dismiss the fresh divergence it landed after.
      await act(async () => {
        releaseRetry?.("r-retry");
      });
      expect(onDirtyChange).not.toHaveBeenCalledWith(false);
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
    });

    it("a superseded recovery-write error cannot become a global error", async () => {
      const onError = vi.fn();
      const { disk } = await mountDiverged(onError);
      let rejectSave: ((reason: Error) => void) | undefined;
      saveDocumentMock.mockImplementationOnce(
        () => new Promise<string>((_resolve, reject) => {
          rejectSave = reject;
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(rejectSave).toBeTypeOf("function"));
      disk.content = "A later external revision";
      disk.revision = "r-later";
      await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeVisible());

      await act(async () => rejectSave?.(new Error("Old recovery write failed")));
      expect(screen.getByText("This file changed outside the editor")).toBeVisible();
      expect(screen.queryByText("The version from disk is here, but it isn’t saved")).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    });

    it("Save As… cancellation leaves the failed state and buffer intact", async () => {
      const onSavedAs = vi.fn();
      const pickSaveAsPath = vi.fn().mockResolvedValue(null);
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      const ref = createRef<EditorShellHandle>();
      render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onSavedAs={onSavedAs}
          pickSaveAsPath={pickSaveAsPath}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));
      disk.content = "External bytes C";
      disk.revision = "r2";
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(pickSaveAsPath).toHaveBeenCalled());
      expect(onSavedAs).not.toHaveBeenCalled();
      expect(saveDocumentAsMock).not.toHaveBeenCalled();
      // Still the failed banner, still Keep mine-less, still holding the reloaded buffer.
      expect(
        screen.getByText("The version from disk is here, but it isn’t saved"),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
      expect(ref.current?.getContent()).toBe("External bytes C");
    });

    it("Save As… failure leaves the failed state and buffer intact", async () => {
      const onSavedAs = vi.fn();
      const onError = vi.fn();
      const pickSaveAsPath = vi.fn().mockResolvedValue("/project/rescued.md");
      saveDocumentAsMock.mockRejectedValueOnce({ kind: "History", message: "path already claimed" });
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      const ref = createRef<EditorShellHandle>();
      render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onSavedAs={onSavedAs}
          onError={onError}
          pickSaveAsPath={pickSaveAsPath}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));
      disk.content = "External bytes C";
      disk.revision = "r2";
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onSavedAs).not.toHaveBeenCalled();
      expect(
        screen.getByText("The version from disk is here, but it isn’t saved"),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
      expect(ref.current?.getContent()).toBe("External bytes C");
    });

    it("Save As… success reuses the existing single Save-As path, carrying history to the chosen destination", async () => {
      const onSavedAs = vi.fn();
      const pickSaveAsPath = vi.fn().mockResolvedValue("/project/rescued.md");
      const disk = { content: "Original disk bytes", revision: "r1" };
      openDocumentMock.mockImplementation(async () => ({ ...disk }));
      const ref = createRef<EditorShellHandle>();
      render(
        <EditorShell
          ref={ref}
          root="/project"
          path="a.md"
          externalChangePollMs={POLL_MS}
          onSavedAs={onSavedAs}
          pickSaveAsPath={pickSaveAsPath}
        />,
      );
      await waitFor(() => expect(ref.current?.getContent()).toBe("Original disk bytes"));
      disk.content = "External bytes C";
      disk.revision = "r2";
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(onSavedAs).toHaveBeenCalledWith("rescued.md"));
      expect(saveDocumentAsMock).toHaveBeenCalledWith(
        "/project",
        "a.md",
        "rescued.md",
        "External bytes C",
        true,
      );
    });

    it("Compare still works from the failed state, against the bytes Reload captured", async () => {
      await mountDiverged();
      let rejectReload: ((reason: Error) => void) | undefined;
      saveDocumentMock.mockImplementationOnce(
        () => new Promise<string>((_resolve, reject) => (rejectReload = reject)),
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      const compareButton = screen.getByRole("button", { name: "Compare" });
      expect(compareButton).toBeDisabled();

      // Settle the write on the next task so the reloading banner's disabled Compare exists long
      // enough to discriminate an existence-only wait from the failed banner's enabled control.
      setTimeout(() => rejectReload?.(new Error("Permission denied.")), 0);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Compare" })).toBeEnabled(),
      );

      fireEvent.click(screen.getByRole("button", { name: "Compare" }));

      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Compare a.md" })).toHaveTextContent(
          "External bytes C",
        ),
      );
    });

    it("Compare's On disk pane shows the real disk side, not the submitted buffer, after a failed retry with further edits (review Important 2, PR #2108)", async () => {
      const { container } = await mountDiverged();
      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
      );

      // Typing is never blocked while this banner is up (ux-design Principle 2) — this is the
      // exact edit that must never leak into the "On disk" pane.
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: view.state.doc.length, insert: " and more" } });
      });

      saveDocumentMock.mockRejectedValueOnce(new Error("Permission denied."));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(saveDocumentMock).toHaveBeenLastCalledWith(
          "/project",
          "a.md",
          "External bytes C and more",
          true,
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Compare" }));

      const region = screen.getByRole("region", { name: "Compare a.md" });
      const onDiskPane = within(region).getByText("On disk").closest("section") as HTMLElement;
      expect(onDiskPane).toHaveTextContent("External bytes C");
      expect(onDiskPane).not.toHaveTextContent("and more");
      const yourVersionPane = within(region)
        .getByText("Your version")
        .closest("section") as HTMLElement;
      expect(yourVersionPane).toHaveTextContent("External bytes C and more");
    });
  });
});

/**
 * J2's Missing-on-disk lifecycle inside the shell that holds the buffer (#933): the banner and its
 * capability gate, the paused autosave, the manual save that writes nothing, and every exit of
 * `[Recreate]` and `[Save As…]`. The tab layer owns *deciding* a document is missing (a completed
 * generation proves it); this suite owns what the editor does once told.
 */
describe("editor/EditorShell — Missing on disk (#933)", () => {
  const isMac = /Mac/.test(navigator.platform);

  beforeEach(() => {
    openDocumentMock.mockReset();
    openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
    saveDocumentMock.mockReset().mockResolvedValue("r1");
    saveDocumentAsMock.mockReset().mockResolvedValue("r2");
    parseChangesMock.mockReset().mockResolvedValue([]);
    recreateMock.mockReset();
    recreateCapabilityMock.mockReset().mockImplementation(async (path) => ({
      path,
      status: "confinement_unavailable",
    }));
  });

  const mountMissing = async (
    props: Partial<React.ComponentProps<typeof EditorShell>> = {},
  ) => {
    const ref = createRef<EditorShellHandle>();
    const rendered = render(<EditorShell ref={ref} root="/project" path="notes/a.md" {...props} />);
    await waitFor(() => expect(rendered.container.querySelector(".cm-content")).toBeTruthy());
    rendered.rerender(
      <EditorShell ref={ref} root="/project" path="notes/a.md" missing {...props} />,
    );
    await screen.findByRole("status");
    return { ...rendered, ref, remount: rendered.rerender };
  };

  it("keeps the whole buffer and shows the recovery banner, with no Recreate on an unsupported filesystem", async () => {
    const { container } = await mountMissing();

    expect(container.querySelector(".cm-content")).toHaveTextContent("Hi");
    expect(
      screen.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeTruthy();
    expect(screen.getByText("Autosave paused — file missing")).toBeTruthy();
    expect(recreateCapabilityMock).toHaveBeenCalledWith("notes/a.md");
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
  });

  it("offers Recreate once the backend reports confinement for this exact path", async () => {
    recreateCapabilityMock.mockImplementation(async (path) => ({
      path,
      status: "available",
    }));

    await mountMissing();

    expect(await screen.findByRole("button", { name: "Recreate" })).toBeTruthy();
  });

  it("pauses autosave and writes nothing on a manual save, reopening the guarded choice instead", async () => {
    const { container } = await mountMissing({ autosaveIntervalMs: 1 });
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);

    act(() => {
      view?.dispatch({ changes: { from: 0, insert: "edited while missing\n" } });
    });
    // The debounce is 1ms: a resumed autosave would have written by the time the manual save below
    // has been asked for and refused.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.keyDown(container.querySelector(".cm-content") as HTMLElement, {
      key: "s",
      metaKey: isMac,
      ctrlKey: !isMac,
    });

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/is missing from disk/)).toBeTruthy();
    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(container.querySelector(".cm-content")).toHaveTextContent("edited while missing");
  });

  it("refuses the imperative save the close/quit guard drives, rather than reporting a write that never happened", async () => {
    const { ref } = await mountMissing();

    await expect(ref.current?.save()).resolves.toBe(false);
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("Keep editing dismisses the banner and the tab status brings it back", async () => {
    const { ref } = await mountMissing();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => ref.current?.showMissingActions());

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(
      screen.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeTruthy();
  });

  describe("[Recreate]", () => {
    beforeEach(() => {
      recreateCapabilityMock.mockImplementation(async (path: string) => ({
        path,
        status: "available" as const,
      }));
    });

    it("sends the live buffer, clears Missing, and leaves the tab clean on Created", async () => {
      recreateMock.mockResolvedValue({ status: "created", snapshot: null, refresh_error: null });
      const onMissingResolved = vi.fn();
      const onDirtyChange = vi.fn();
      // The document loads as it is on disk; every later read — the polls running throughout this
      // test — reads what Recreate is about to write, so the boundary is read repeatedly rather than
      // at a single lucky moment.
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: "rescued\n# Hi\n", revision: "r2" });
      const { container, rerender } = await mountMissing({
        onMissingResolved,
        onDirtyChange,
        externalChangePollMs: 10,
      });
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "rescued\n" } });
      });
      onDirtyChange.mockClear();

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));

      await waitFor(() => expect(onMissingResolved).toHaveBeenCalledTimes(1));
      expect(recreateMock).toHaveBeenCalledWith("notes/a.md", "rescued\n# Hi\n", true);
      // The file now holds exactly this buffer, so the tab is clean against it ...
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
      // ... and the FR-ED-7 poller has nothing to report about the bytes Cowrite itself just wrote:
      // the disk baseline moved with the write, so reading exactly them back is not a change, and a
      // divergence noticed before the file vanished (the polls above, reading what Recreate is about
      // to write) describes bytes this write replaced. The shell is told the document is no longer
      // missing — as the tab layer does on `onMissingResolved` — so nothing is merely suppressed.
      rerender(
        <EditorShell
          root="/project"
          path="notes/a.md"
          externalChangePollMs={10}
          onMissingResolved={onMissingResolved}
          onDirtyChange={onDirtyChange}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("exits to the FR-ED-7 flow on Reappeared without reading or overwriting the file itself", async () => {
      recreateMock.mockResolvedValue({ status: "reappeared" });
      const onMissingResolved = vi.fn();
      openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
      await mountMissing({ onMissingResolved, externalChangePollMs: 10_000 });
      const readsBefore = openDocumentMock.mock.calls.length;
      openDocumentMock.mockResolvedValue({ content: "# someone else's version\n", revision: "r9" });

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));

      await waitFor(() => expect(onMissingResolved).toHaveBeenCalledTimes(1));
      // The Recreate itself neither read nor wrote the target: the only read that follows is the
      // changed-contents poll it handed the disk side to — which happens immediately rather than an
      // interval later (the poll interval here is 10s; this resolves in milliseconds).
      await waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThan(readsBefore),
      );
      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("preserves the buffer and the Missing state when confinement disappeared", async () => {
      recreateMock.mockResolvedValue({ status: "confinement_unavailable" });
      const onMissingResolved = vi.fn();
      const { container } = await mountMissing({ onMissingResolved });

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));

      expect(
        await screen.findByText("Cowrite can’t safely recreate this file at its original path."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
      expect(onMissingResolved).not.toHaveBeenCalled();
      expect(container.querySelector(".cm-content")).toHaveTextContent("Hi");
    });

    it("shows the detail of any other failure, still Missing and still recoverable", async () => {
      recreateMock.mockResolvedValue({ status: "failed", message: "disk full" });
      const onMissingResolved = vi.fn();
      await mountMissing({ onMissingResolved });

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));

      expect(
        await screen.findByText("Cowrite couldn’t complete the requested action. disk full"),
      ).toBeTruthy();
      expect(onMissingResolved).not.toHaveBeenCalled();
    });
  });

  describe("[Save As…]", () => {
    it("writes the buffer to the chosen in-project path and reports where it landed", async () => {
      const onSavedAs = vi.fn();
      const pickSaveAsPath = vi.fn().mockResolvedValue("/project/archive/rescued.md");
      const { container } = await mountMissing({ onSavedAs, pickSaveAsPath });
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "rescued\n" } });
      });

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(onSavedAs).toHaveBeenCalledWith("archive/rescued.md"));
      expect(pickSaveAsPath).toHaveBeenCalledWith("/project", "notes/a.md");
      // Through the Save As command, which carries the document's history — never a plain save at
      // the new path, which would leave its comments and change records behind.
      expect(saveDocumentAsMock).toHaveBeenCalledWith(
        "/project",
        "notes/a.md",
        "archive/rescued.md",
        "rescued\n# Hi\n",
        true,
      );
      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("changes nothing when the panel is cancelled", async () => {
      const onSavedAs = vi.fn();
      const onError = vi.fn();
      await mountMissing({ onSavedAs, onError, pickSaveAsPath: vi.fn().mockResolvedValue(null) });

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(saveDocumentAsMock).not.toHaveBeenCalled());
      expect(onSavedAs).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      // Still missing, still offering the same recovery.
      expect(screen.getByRole("status")).toBeTruthy();
    });

    it("refuses a destination outside the project instead of writing it", async () => {
      const onSavedAs = vi.fn();
      const onError = vi.fn();
      await mountMissing({
        onSavedAs,
        onError,
        pickSaveAsPath: vi.fn().mockResolvedValue("/elsewhere/rescued.md"),
      });

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(saveDocumentAsMock).not.toHaveBeenCalled();
      expect(onSavedAs).not.toHaveBeenCalled();
    });

    it("reports a failed write and keeps the document exactly where it was", async () => {
      const onSavedAs = vi.fn();
      const onError = vi.fn();
      saveDocumentAsMock.mockRejectedValue({ kind: "History", message: "path already claimed" });
      await mountMissing({
        onSavedAs,
        onError,
        pickSaveAsPath: vi.fn().mockResolvedValue("/project/taken.md"),
      });

      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onSavedAs).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toBeTruthy();
    });
  });

  it("shows no changed-contents banner while the file is absent — there is no disk version to compare", async () => {
    // A poll that read the path a moment before the generation proving its absence landed must not
    // leave FR-ED-7 chrome on screen offering a Reload from a file that is gone.
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
    openDocumentMock.mockResolvedValue({ content: "# changed elsewhere\n", revision: "r2" });
    const ref = createRef<EditorShellHandle>();
    const { rerender } = render(
      <EditorShell ref={ref} root="/project" path="notes/a.md" externalChangePollMs={10} />,
    );
    await waitFor(() =>
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
    );

    rerender(
      <EditorShell ref={ref} root="/project" path="notes/a.md" externalChangePollMs={10} missing />,
    );

    await waitFor(() =>
      expect(screen.queryByText("This file changed outside the editor")).toBeNull(),
    );
    expect(
      screen.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeTruthy();
  });

  it("resumes autosave once the document is no longer missing", async () => {
    const ref = createRef<EditorShellHandle>();
    const { container, rerender } = render(
      <EditorShell ref={ref} root="/project" path="notes/a.md" autosaveIntervalMs={1} missing />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    rerender(
      <EditorShell ref={ref} root="/project" path="notes/a.md" autosaveIntervalMs={1} />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    act(() => {
      view?.dispatch({ changes: { from: 0, insert: "back on disk\n" } });
    });

    await waitFor(() => expect(saveDocumentMock).toHaveBeenCalled());
  });

  /**
   * Leaving **Missing on disk** (#1595). The absent path can be occupied again at any instant —
   * including by a concurrent creator — so the write pause J2 raises has to outlast the missing
   * state itself. Until a completed read establishes what is actually at the path, a write landing
   * first overwrites bytes nobody has looked at: the disk side FR-ED-7 exists to preserve, and the
   * source of truth TD-2 makes the file (ux-design: a reappearance with differing content
   * "transitions to the ordinary changed-contents banner above, preserving both sides").
   *
   * That read is held open here, so the transition can be driven through the exact ordering that
   * loses those bytes, and the autosave debounce runs on a fake clock rather than a sleep
   * (test-plan §7 "injectable clock"). Both halves are needed: the barrier fixes *where* in the
   * ordering the transition lands, and the clock fixes *when* the armed debounce comes due.
   */
  describe("leaving Missing on disk (#1595)", () => {
    const paused = { autosaveIntervalMs: 1_000, externalChangePollMs: 10_000 } as const;

    beforeEach(() => {
      recreateCapabilityMock.mockImplementation(async (path: string) => ({
        path,
        status: "available" as const,
      }));
      openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** The FR-ED-7 read the transition waits on — settled by hand, never by elapsed time. */
    function heldRead() {
      let settle!: (payload: { content: string; revision: string }) => void;
      const promise = new Promise<{ content: string; revision: string }>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    }

    /** The tab layer's own answer to a reappearance: this document is no longer missing. */
    const notMissing = (props: Partial<React.ComponentProps<typeof EditorShell>> = {}) => (
      <EditorShell root="/project" path="notes/a.md" {...paused} {...props} />
    );

    /**
     * Types into a document while its file is gone (arming autosave against the buffer J2 keeps),
     * then hands back the barrier every disk read in this ordering will block on.
     */
    function editWhileMissing(container: HTMLElement) {
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      vi.useFakeTimers();
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "typed while the file was gone\n" } });
      });
      const read = heldRead();
      openDocumentMock.mockReturnValue(read.promise);
      return read;
    }

    /** Starts one scheduled read before the tab enters Missing, then holds it across the entry. */
    async function enterMissingWithOlderRead(
      olderRead: ReturnType<typeof heldRead>,
      props: Partial<React.ComponentProps<typeof EditorShell>> = {},
    ) {
      openDocumentMock.mockReset();
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockReturnValueOnce(olderRead.promise);
      const ref = createRef<EditorShellHandle>();
      const rendered = render(
        <EditorShell
          ref={ref}
          root="/project"
          path="notes/a.md"
          autosaveIntervalMs={paused.autosaveIntervalMs}
          externalChangePollMs={1}
          {...props}
        />,
      );
      await waitFor(() => expect(rendered.container.querySelector(".cm-content")).toBeTruthy());
      await waitFor(() => expect(openDocumentMock).toHaveBeenCalledTimes(2));
      rendered.rerender(
        <EditorShell
          ref={ref}
          root="/project"
          path="notes/a.md"
          autosaveIntervalMs={paused.autosaveIntervalMs}
          externalChangePollMs={1}
          missing
          {...props}
        />,
      );
      await screen.findByRole("status");
      return { ...rendered, ref };
    }

    it("ignores a pre-Missing read that returns after the current reappearance read started", async () => {
      const olderRead = heldRead();
      const currentRead = heldRead();
      const { container, rerender } = await enterMissingWithOlderRead(olderRead);
      openDocumentMock.mockReturnValueOnce(currentRead.promise);

      vi.useFakeTimers();
      await act(async () => {
        rerender(notMissing());
      });
      expect(openDocumentMock).toHaveBeenCalledTimes(3);
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "edit waiting on the current read\n" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      // This read started before the path went missing. Its old, non-diverged answer cannot clear
      // the current episode's pause or flush the edit waiting behind it.
      await act(async () => {
        olderRead.settle({ content: "# Hi\n", revision: "r1" });
        await Promise.resolve();
      });
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();

      // Only the read started for this reappearance may settle the disk side. It sees another
      // writer's bytes, so the edit remains in Cowrite and no write lands over them.
      await act(async () => {
        currentRead.settle({ content: "current occupant bytes\n", revision: "r9" });
        await Promise.resolve();
      });
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "edit waiting on the current read",
      );
    });

    it("invalidates a pre-Missing read when Recreate publishes the current bytes without another read", async () => {
      recreateMock.mockResolvedValue({ status: "created", snapshot: null, refresh_error: null });
      const olderRead = heldRead();
      const onMissingResolved = vi.fn();
      const { rerender } = await enterMissingWithOlderRead(olderRead, { onMissingResolved });

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));
      await waitFor(() => expect(onMissingResolved).toHaveBeenCalledTimes(1));
      await act(async () => {
        rerender(notMissing({ onMissingResolved }));
      });

      // `created` established the current disk bytes itself, so leaving Missing starts no new
      // read. The older read is still stale by episode and cannot resurrect a pre-Recreate banner.
      await act(async () => {
        olderRead.settle({ content: "bytes from before Missing\n", revision: "r0" });
        await Promise.resolve();
      });
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("ends an open Compare when the file it was comparing vanishes", async () => {
      // Compare shows two versions of a file. When that file goes missing one of the two stops
      // existing, so there is nothing left to compare — and J2's recovery surface is rendered only
      // while nothing is comparing, so a Compare left open does not merely go stale: it swallows
      // the Missing banner entirely, and the author is shown a disk version of a file that is gone
      // instead of the actions that recover it.
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: "# someone else's copy\n", revision: "r2" });
      const shared = {
        root: "/project",
        path: "notes/a.md",
        autosaveIntervalMs: 1_000,
        externalChangePollMs: 1,
      } as const;
      const { rerender } = render(<EditorShell {...shared} />);
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Compare" }));
      expect(screen.getByText("# someone else's copy")).toBeTruthy();

      rerender(<EditorShell {...shared} missing />);

      expect(
        await screen.findByText(
          "This file is missing from its project path. Your open copy is safe.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("# someone else's copy")).toBeNull();
    });

    it("does not offer the vanished file's version back once the path returns", async () => {
      // A divergence is about a specific file, and nothing clears one once raised — only a newer
      // read replaces it. Left in place across the disappearance it comes back with the path and
      // offers `[Reload]` of a version belonging to a file that no longer exists, which would put
      // those bytes into the buffer over the author's retained copy.
      const shared = {
        root: "/project",
        path: "notes/a.md",
        autosaveIntervalMs: 1_000,
        externalChangePollMs: 1,
      } as const;
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValueOnce({ content: "# the old occupant\n", revision: "r2" });
      // Every read after the reappearance returns exactly what this editor last knew, so nothing
      // new can diverge — only a divergence that outlived the file could raise the banner again.
      openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
      const { rerender } = render(<EditorShell {...shared} />);
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );

      rerender(<EditorShell {...shared} missing />);
      await screen.findByRole("status");
      const readsWhileMissing = openDocumentMock.mock.calls.length;
      rerender(<EditorShell {...shared} />);

      // Wait for the read the transition takes, so this asserts on a settled reappearance.
      await vi.waitFor(() =>
        expect(openDocumentMock.mock.calls.length).toBeGreaterThan(readsWhileMissing),
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("does not carry a Keep-mine dismissal across the loss of the path's identity", async () => {
      // "Keep mine" says *these disk bytes* have been considered — about the file that was at this
      // path. Once that file is gone the path is anyone's, so a new occupant arriving with the same
      // bytes is a fresh question. Carried across, the dismissal suppresses the banner AND reports
      // no divergence, which lifts the pause and writes the buffer over that occupant.
      const shared = "bytes the author already dismissed\n";
      openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
      openDocumentMock.mockResolvedValue({ content: shared, revision: "r2" });
      const { container, rerender } = await render(
        <EditorShell root="/project" path="notes/a.md" autosaveIntervalMs={1_000} externalChangePollMs={1} />,
      );
      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

      rerender(
        <EditorShell
          root="/project"
          path="notes/a.md"
          autosaveIntervalMs={1_000}
          externalChangePollMs={1}
          missing
        />,
      );
      await screen.findByRole("status");
      const read = editWhileMissing(container);
      await act(async () => {
        rerender(notMissing());
      });
      const readsAtReappearance = openDocumentMock.mock.calls.length;
      openDocumentMock.mockImplementation(pendingDocumentRead);
      await act(async () => {
        read.settle({ content: shared, revision: "r9" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(openDocumentMock.mock.calls.length - readsAtReappearance).toBeLessThanOrEqual(1);
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
    });

    it("refuses the close guard's save over the divergence its own read just raised", async () => {
      // The pause delays an explicit save rather than dropping it — but the read it waited for is
      // allowed to come back with another writer's bytes, and then writing is the very overwrite
      // the automatic path refuses. The guard's user is answering "save before closing?", not
      // "overwrite the stranger's file", and `false` is what keeps that guard, and the buffer, open.
      const ref = createRef<EditorShellHandle>();
      const { container, rerender } = await mountMissing({ ...paused, ref });
      const read = editWhileMissing(container);
      await act(async () => {
        rerender(notMissing({ ref }));
      });

      const saved = ref.current?.save();
      await act(async () => {
        read.settle({ content: "A concurrent creator's bytes\n", revision: "r9" });
        await Promise.resolve();
      });

      await expect(saved).resolves.toBe(false);
      expect(saveDocumentMock).not.toHaveBeenCalled();
      // This save is exactly the blocked-Save case #2074 AC3 governs: an explicit Save (here, the
      // close guard's imperative one) refused because the choice this same read just raised is
      // unresolved. The banner rewrites both lines rather than showing the ordinary observed copy.
      expect(screen.getByText("Not saved — this file changed outside the editor")).toBeTruthy();
      expect(
        screen.getByText("Cowrite didn’t write over it. Choose Reload, Keep mine, or Compare."),
      ).toBeTruthy();
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "typed while the file was gone",
      );
    });

    it("says so when the read that would lift the pause cannot complete", async () => {
      // The pause makes an ordinarily transient poll failure load-bearing: this read is the only
      // thing that lifts it, so an unreadable path stops autosave for good. FR-X-5 forbids letting
      // that be silent — availability reflects reality, never a silent no-op.
      const onError = vi.fn();
      const ref = createRef<EditorShellHandle>();
      const { container, rerender } = await mountMissing({ ...paused, onError, ref });
      editWhileMissing(container);
      openDocumentMock.mockRejectedValue(new Error("path is unreadable"));

      await act(async () => {
        rerender(notMissing({ onError, ref }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(saveDocumentMock).not.toHaveBeenCalled();
      await expect(ref.current?.save()).resolves.toBe(false);
      // Once per episode, not once per tick: the same failure repeating is not news.
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("does not lift the write pause when the settling read succeeds but its tail throws (#1701)", async () => {
      // Distinct from the read-failure test above: the disk *read* itself succeeds here (no
      // rejection reaches `pauseReadFailureReportedRef`'s guard) — it is the unguarded tail
      // downstream of it that throws. Resuming writes off a tick that never established the disk
      // side would be exactly the silent overwrite FR-ED-7 forbids.
      const onError = vi.fn();
      const ref = createRef<EditorShellHandle>();
      const { container, rerender } = await mountMissing({ ...paused, ref, onError });
      editWhileMissing(container);
      openDocumentMock.mockResolvedValue({
        get content(): string {
          throw new Error("boom");
        },
        revision: "r9",
      } as unknown as { content: string; revision: string });

      await act(async () => {
        rerender(notMissing({ ref, onError }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(saveDocumentMock).not.toHaveBeenCalled();
      await expect(ref.current?.save()).resolves.toBe(false);
      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("ref.save() resolves false rather than rejecting when the settling poll's own tail throws (#1701)", async () => {
      // No `onError` wired here on purpose: the tail's catch has no consumer to report to, so it
      // re-throws and the rejection escapes as the unhandled rejection `createExternalChangePoller`
      // deliberately does not catch (#1701, #1690). `saveNow` is a distinct caller of that same tail
      // (`pollNowRef.current()`), reached through `EditorShellHandle.save()` — and unlike the
      // poller's own `.finally()` chain, `saveNow` awaits that call directly. Without its own guard,
      // this exact rejection would also reject `saveNow()` and, through it, `ref.save()` — which the
      // tab layer's dirty-close guard (`TabbedEditor.tsx`) awaits with no try/catch, so it would
      // neither close the tab nor report anything. `saveNow`'s catch keeps this an honest `false`.
      const ref = createRef<EditorShellHandle>();
      const { container, rerender } = await mountMissing({ ...paused, ref });
      const read = editWhileMissing(container);
      await act(async () => {
        rerender(notMissing({ ref }));
      });

      const saved = ref.current?.save();
      await act(async () => {
        read.settle({
          get content(): string {
            throw new Error("boom");
          },
          revision: "r9",
        } as unknown as { content: string; revision: string });
        await Promise.resolve();
      });

      await expect(saved).resolves.toBe(false);
      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("leaves no part of one document's pause behind for the next document", async () => {
      // These refs are per-document, and the mount effect that resets every other per-document ref
      // has to reset them too. Left behind, the pause silently kills the next document's autosave —
      // and a deferred bit left set makes that document's first settling read save a buffer nobody
      // asked to write.
      const { container, rerender } = await mountMissing(paused);
      editWhileMissing(container);
      await act(async () => {
        rerender(notMissing());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(saveDocumentMock).not.toHaveBeenCalled();

      // A different document, present all along and never missing.
      openDocumentMock.mockResolvedValue({ content: "# B\n", revision: "rb" });
      await act(async () => {
        rerender(<EditorShell root="/project" path="notes/b.md" {...paused} />);
      });
      // The clock is already fake here, so the remount is driven on it rather than through a
      // real-timer `waitFor`, which could never tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(container.querySelector(".cm-content")).toHaveTextContent("# B");
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "an edit in the next document\n" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "notes/b.md",
        "an edit in the next document\n# B\n",
        true,
      );
    });

    it("retires a read taken during the episode when Recreate publishes the bytes itself", async () => {
      // `created` is the one exit that establishes the disk side without reading, so it is the one
      // exit where no later read is there to supersede an outstanding one — and a poll that started
      // while the file was still absent is outstanding across exactly that window. Its answer
      // predates the publication, so reporting it would raise FR-ED-7 against bytes Recreate has
      // already replaced (finding M11's rule, arrived at from the other side).
      recreateMock.mockResolvedValue({ status: "created", snapshot: null, refresh_error: null });
      const duringEpisode = heldRead();
      const { rerender } = await mountMissing({ ...paused, externalChangePollMs: 1 });
      // The poller arms its next tick only once the previous read settles, so holding this one
      // leaves exactly one read outstanding for the rest of the episode — but only from the tick
      // that actually takes it. Wait for that tick, not merely for "more than one read": the mount
      // has already issued reads of its own, and counting while one of those is still in flight
      // captures a total the rearm behind it is about to exceed (#1690).
      openDocumentMock.mockReturnValue(duringEpisode.promise);
      await waitFor(() => {
        const reads = openDocumentMock.mock.results;
        expect(reads[reads.length - 1]?.value).toBe(duringEpisode.promise);
      });
      const readsIssued = openDocumentMock.mock.calls.length;

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));
      await waitFor(() => expect(recreateMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        rerender(notMissing({ externalChangePollMs: 1 }));
      });
      // Nothing else read the path: `created` established the disk side itself, so leaving Missing
      // starts no read of its own and the poller is still parked on the held one. Assert that HERE
      // rather than after the settle below — settling rearms the poll, and the ordinary reads it
      // then takes are not what this case asks about (#1690).
      expect(openDocumentMock.mock.calls.length).toBe(readsIssued);

      // Park the poll again before releasing the held read, so the tick the settle rearms cannot
      // take a read of its own and answer with these same pre-Recreate bytes — a banner from that
      // read would be a different fact than the one asserted below, arriving on machine timing.
      const afterEpisode = heldRead();
      openDocumentMock.mockReturnValue(afterEpisode.promise);
      await act(async () => {
        duringEpisode.settle({ content: "the absent path, read before Recreate\n", revision: "r0" });
        await Promise.resolve();
      });

      // So this is the only answer available — and it still says nothing, because the publication
      // has already superseded the question.
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("lets only the newest overlapping direct reappearance read settle the episode", async () => {
      recreateMock.mockResolvedValue({ status: "reappeared" });
      const onMissingResolved = vi.fn();
      const { container, rerender } = await mountMissing({ ...paused, onMissingResolved });
      const olderRead = heldRead();
      const currentRead = heldRead();
      openDocumentMock.mockReturnValueOnce(olderRead.promise);
      openDocumentMock.mockReturnValueOnce(currentRead.promise);
      openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });

      fireEvent.click(await screen.findByRole("button", { name: "Recreate" }));
      await waitFor(() => expect(onMissingResolved).toHaveBeenCalledTimes(1));
      vi.useFakeTimers();
      await act(async () => {
        rerender(notMissing({ onMissingResolved }));
      });
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "deferred behind the newest read\n" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await act(async () => {
        olderRead.settle({ content: "stale foreign bytes\n", revision: "r0" });
        await Promise.resolve();
      });
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
      expect(saveDocumentMock).not.toHaveBeenCalled();

      await act(async () => {
        currentRead.settle({ content: "# Hi\n", revision: "r1" });
        await Promise.resolve();
      });
      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "notes/a.md",
        "deferred behind the newest read\n# Hi\n",
        true,
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("never lets an autosave armed while Missing write once the path is occupied again", async () => {
      const { container, rerender } = await mountMissing(paused);
      const read = editWhileMissing(container);

      // The completed generation ends Missing before anything has read what came back.
      await act(async () => {
        rerender(notMissing());
      });
      // The debounce armed while the file was gone comes due with that read still in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).not.toHaveBeenCalled();

      // It stays refused once the read proves the path belongs to a concurrent creator: the disk
      // side is now FR-ED-7's to offer, and both sides are still intact.
      await act(async () => {
        read.settle({ content: "a concurrent creator's bytes\n", revision: "r9" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "typed while the file was gone",
      );
    });

    it("keeps writes paused across a Recreate that reappeared, until its own read has landed", async () => {
      recreateMock.mockResolvedValue({ status: "reappeared" });
      const onMissingResolved = vi.fn();
      const { container, rerender } = await mountMissing({ ...paused, onMissingResolved });
      const recreate = await screen.findByRole("button", { name: "Recreate" });
      const read = editWhileMissing(container);

      await act(async () => {
        fireEvent.click(recreate);
      });
      expect(onMissingResolved).toHaveBeenCalledTimes(1);
      // The tab layer answers `onMissingResolved` at once — before the read Recreate handed the
      // disk side to has come back with anything.
      await act(async () => {
        rerender(notMissing({ onMissingResolved }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(recreateMock).toHaveBeenCalledTimes(1);
      expect(saveDocumentMock).not.toHaveBeenCalled();

      // Recreate wrote nothing and read nothing itself; the read it handed the disk side to is what
      // reports the concurrent creator, and the buffer is still whole beside it.
      await act(async () => {
        read.settle({ content: "a concurrent creator's bytes\n", revision: "r9" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "typed while the file was gone",
      );
    });

    /**
     * The other half of the ordering: an edit typed *after* Missing ended but before the read that
     * settles the disk side has come back. Autosave is no longer paused by J2 — the document has a
     * file again — but what is in that file is still unread, so the write waits for the answer
     * rather than racing it.
     */
    async function typeIntoThePause(container: HTMLElement, rerender: (ui: React.ReactElement) => void) {
      const read = editWhileMissing(container);
      await act(async () => {
        rerender(notMissing());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "and kept typing\n" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      // Nothing has been written yet in either case: the read has not said what it would land on.
      expect(saveDocumentMock).not.toHaveBeenCalled();
      return read;
    }

    it("runs an edit made during that read once it proves the file came back as Cowrite knew it", async () => {
      const { container, rerender } = await mountMissing(paused);
      const read = await typeIntoThePause(container, rerender);

      await act(async () => {
        read.settle({ content: "# Hi\n", revision: "r1" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "notes/a.md",
        "and kept typing\ntyped while the file was gone\n# Hi\n",
        true,
      );
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("drops an edit made during that read rather than writing it over a concurrent creator", async () => {
      const { container, rerender } = await mountMissing(paused);
      const read = await typeIntoThePause(container, rerender);

      await act(async () => {
        read.settle({ content: "a concurrent creator's bytes\n", revision: "r9" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      // Both sides survive: the disk keeps its bytes, the buffer keeps every edit, and the choice
      // between them is the user's to make on FR-ED-7's banner.
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
      expect(container.querySelector(".cm-content")).toHaveTextContent("and kept typing");
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "typed while the file was gone",
      );
    });

    it("holds the edit made while Missing even when the file came back exactly as it was", async () => {
      const { container, rerender } = await mountMissing(paused);
      const read = editWhileMissing(container);

      await act(async () => {
        rerender(notMissing());
      });
      await act(async () => {
        read.settle({ content: "# Hi\n", revision: "r1" });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      // Nothing diverged here, so nothing was at risk — and the debounce still does not cross. It
      // was armed against a document that had no file, and a transition is not a decision to act on
      // it; the author's next edit or explicit save is. The buffer is whole and still dirty.
      expect(saveDocumentMock).not.toHaveBeenCalled();
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "typed while the file was gone",
      );
    });

    it("does not let a read taken while the document is still Missing resume its writes", async () => {
      recreateMock.mockResolvedValue({ status: "reappeared" });
      const onMissingResolved = vi.fn();
      const { container, rerender } = await mountMissing({ ...paused, onMissingResolved });
      const recreate = await screen.findByRole("button", { name: "Recreate" });
      const read = editWhileMissing(container);

      // Recreate hands the disk side to FR-ED-7 immediately, so its read lands while the tab layer
      // has not yet ended Missing. A read says what is at the path; it does not say that this
      // document may write there — only a read taken after the transition does.
      await act(async () => {
        fireEvent.click(recreate);
      });
      // Deliberately no clock advance yet: the debounce has to still be armed when Missing ends,
      // which is the whole ordering under test.
      await act(async () => {
        read.settle({ content: "# Hi\n", revision: "r1" });
      });
      expect(saveDocumentMock).not.toHaveBeenCalled();

      await act(async () => {
        rerender(notMissing({ onMissingResolved }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).not.toHaveBeenCalled();
    });

    it("resumes autosave after a Recreate created the file even if the path cannot be read", async () => {
      recreateMock.mockResolvedValue({ status: "created", snapshot: null, refresh_error: null });
      const { container, rerender } = await mountMissing(paused);
      const recreate = await screen.findByRole("button", { name: "Recreate" });
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
      // Nothing after this may depend on reading the path: Recreate published these bytes itself,
      // under transaction-long confinement with replacement disabled, so what is at the path is
      // known without looking — which is why an unreadable path cannot strand autosave here
      // (ux-design: Recreate "clears the missing state, and resumes autosave").
      openDocumentMock.mockRejectedValue(new Error("unreadable"));

      await act(async () => {
        fireEvent.click(recreate);
      });
      await act(async () => {
        rerender(notMissing());
      });
      vi.useFakeTimers();
      act(() => {
        view?.dispatch({ changes: { from: 0, insert: "and kept writing\n" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(saveDocumentMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("editor/EditorShell — quote-bar selection affordance (P2b-7)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    openDocumentMock.mockResolvedValue({ content: "hello world\n", revision: "r0" });
    saveDocumentMock.mockReset();
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    captureAnchorMock.mockReset();
    capturedOnSelectionChange = null;
  });

  it("shows no affordance while the caret has no selection", async () => {
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={vi.fn()} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    expect(screen.queryByRole("button", { name: "Quote to chat" })).toBeNull();
  });

  it("shows the quote affordance once a non-empty selection is reported", async () => {
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={vi.fn()} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    expect(screen.getByRole("button", { name: "Quote to chat" })).toBeTruthy();
  });

  it("hides the affordance again once the selection collapses back to a caret", async () => {
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={vi.fn()} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));
    expect(screen.getByRole("button", { name: "Quote to chat" })).toBeTruthy();

    act(() => capturedOnSelectionChange?.(null));

    expect(screen.queryByRole("button", { name: "Quote to chat" })).toBeNull();
  });

  it("renders no affordance at all when no onQuoteSelection destination is wired", async () => {
    render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    expect(screen.queryByRole("button", { name: "Quote to chat" })).toBeNull();
  });

  it("positions the quote affordance and the comment trigger via one shared wrapper rather than two identically-positioned buttons (PR #495 review round 4 Important)", async () => {
    // Both affordances anchor to the same selection-end point. Giving each its own copy of that
    // same style used to stack one directly on top of the other at equal z-index — occluding
    // whichever rendered second. A shared, singly-positioned flex wrapper is the fix; this pins
    // the structural shape of that fix (jsdom does no layout, so it cannot see the overlap itself
    // — see the review's A6 note — but it can see whether the two buttons now share one wrapper
    // instead of each carrying its own duplicate position style).
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={vi.fn()} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    const quoteButton = screen.getByRole("button", { name: "Quote to chat" });
    const commentButton = screen.getByRole("button", { name: "Comment" });
    const wrapper = quoteButton.closest(".editor-shell__selection-affordances");

    expect(wrapper).not.toBeNull();
    expect(commentButton.closest(".editor-shell__selection-affordances")).toBe(wrapper);
    // Positioning lives on the shared wrapper, not duplicated on each button.
    expect(quoteButton.getAttribute("style")).toBeNull();
    expect(commentButton.getAttribute("style")).toBeNull();
  });

  it("clicking the affordance captures the anchor against the live buffer text and reports text + anchor", async () => {
    const onQuoteSelection = vi.fn();
    const anchor = {
      offset: 0,
      length: 5,
      text_snapshot: "hello",
      context_before: "",
      context_after: " world\n",
      base_revision: "blake3:abc",
    };
    captureAnchorMock.mockResolvedValueOnce(anchor);
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={onQuoteSelection} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    expect(captureAnchorMock).toHaveBeenCalledWith("hello world\n", 0, 5);
    await waitFor(() =>
      expect(onQuoteSelection).toHaveBeenCalledWith({ text: "hello", anchor }),
    );
  });

  it("on a CRLF file captures the anchor against LF-joined content instead of the CRLF-serialized disk text (#358 review fix)", async () => {
    // Regression for PR #446's Critical: CM6 counts every line break (CRLF included) as exactly
    // one position, but `serializeDocumentState` re-joins lines with the document's real CRLF
    // separator (two UTF-16 units). Pairing a CM6 offset with that CRLF-joined string drifts by one
    // unit per preceding line break — a well-formed but wrong anchor. `state.doc.toString()` is
    // always LF-joined, so it stays in the same coordinate space as the CM6 selection offset below.
    const onQuoteSelection = vi.fn();
    openDocumentMock.mockResolvedValueOnce({
      content: "line one\r\nline two\r\nHELLO there\r\n",
      revision: "r1",
    });
    const anchor = {
      offset: 18,
      length: 5,
      text_snapshot: "HELLO",
      context_before: "line two\n",
      context_after: " there\n",
      base_revision: "blake3:abc",
    };
    captureAnchorMock.mockResolvedValueOnce(anchor);
    render(<EditorShell root="/project" path="a.md" onQuoteSelection={onQuoteSelection} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    // CM6 offset of "HELLO" on line 3, each of the two preceding CRLF line breaks counted once.
    act(() => capturedOnSelectionChange?.({ offset: 18, length: 5, text: "HELLO" }));

    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    expect(captureAnchorMock).toHaveBeenCalledWith(
      "line one\nline two\nHELLO there\n",
      18,
      5,
    );
    await waitFor(() =>
      expect(onQuoteSelection).toHaveBeenCalledWith({ text: "HELLO", anchor }),
    );
  });

  it("reports a capture failure through onError rather than silently dropping the quote", async () => {
    const onError = vi.fn();
    const onQuoteSelection = vi.fn();
    captureAnchorMock.mockRejectedValueOnce(new Error("backend unreachable"));
    render(
      <EditorShell
        root="/project"
        path="a.md"
        onQuoteSelection={onQuoteSelection}
        onError={onError}
      />,
    );
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect(onQuoteSelection).not.toHaveBeenCalled();
  });
});

describe("editor/EditorShell — ref.focusAnchor() deep-link-back (P2b-7 follow-up, #492)", () => {
  const ANCHOR = {
    offset: 6,
    length: 5,
    text_snapshot: "world",
    context_before: "hello ",
    context_after: "\n",
    base_revision: "r0",
  };

  beforeEach(() => {
    openDocumentMock.mockReset();
    openDocumentMock.mockResolvedValue({ content: "hello world\n", revision: "r0" });
    saveDocumentMock.mockReset();
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    resolveAnchorMock.mockReset();
    realSelectionReports.mockClear();
  });

  it("selects and scrolls to the resolved range and resolves true", async () => {
    resolveAnchorMock.mockResolvedValueOnce({ from: 6, to: 11 });
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("hello world\n"));

    const focused = await ref.current!.focusAnchor(ANCHOR);

    expect(focused).toBe(true);
    expect(resolveAnchorMock).toHaveBeenCalledWith("hello world\n", ANCHOR);
    // The post-condition, not just the mocked resolve call: a real CM6 `view.dispatch` actually
    // moved the live selection to `{from: 6, to: 11}` — observed through the genuine (unmocked)
    // `selectionWatcherExtension` update listener the suite installs on every mount, so this fails
    // if the `view.dispatch({ selection, effects })` call were ever deleted while `return true`
    // stayed behind.
    await waitFor(() =>
      expect(realSelectionReports).toHaveBeenCalledWith({ offset: 6, length: 5, text: "world" }),
    );
  });

  it("resolves false without touching the view when the anchor's text has moved on", async () => {
    resolveAnchorMock.mockResolvedValueOnce(null);
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("hello world\n"));

    const focused = await ref.current!.focusAnchor(ANCHOR);

    expect(focused).toBe(false);
    // No dispatch at all on the no-op path — the selection watcher never fires.
    expect(realSelectionReports).not.toHaveBeenCalled();
  });

  it("resolves false rather than a wrong selection when the buffer changes while resolveAnchor is in flight (review Minor)", async () => {
    // `content` is snapshotted before the `await resolveAnchor(...)` — a same-length concurrent
    // edit landing during that IPC round trip (e.g. an agent delivery) would leave the
    // `position.to > doc.length` guard alone satisfied, so pin the stronger guard directly: resolve
    // the anchor only after the buffer has already moved on underneath it.
    let settleResolveAnchor!: (position: { from: number; to: number } | null) => void;
    resolveAnchorMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleResolveAnchor = resolve;
        }),
    );
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("hello world\n"));

    const focusPromise = ref.current!.focusAnchor(ANCHOR);
    // Same length as "hello world\n" — the doc-length guard alone would not catch this.
    act(() => ref.current!.applyDelivery("hello xowld\n", [], "r1"));
    settleResolveAnchor({ from: 6, to: 11 });
    const focused = await focusPromise;

    expect(focused).toBe(false);
    expect(resolveAnchorMock).toHaveBeenCalledWith("hello world\n", ANCHOR);
    expect(ref.current?.getContent()).toBe("hello xowld\n");
  });

  it("resolves false when the view has not mounted yet", async () => {
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    // No `await` on the open — assert before `open_document` has resolved and mounted a view.

    const focused = await ref.current!.focusAnchor(ANCHOR);

    expect(focused).toBe(false);
    expect(resolveAnchorMock).not.toHaveBeenCalled();
  });

  it("resolves false rather than throwing when resolving the anchor rejects", async () => {
    resolveAnchorMock.mockRejectedValueOnce(new Error("backend unreachable"));
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("hello world\n"));

    await expect(ref.current!.focusAnchor(ANCHOR)).resolves.toBe(false);
  });
});

describe("editor/EditorShell — agent delivery lands in the open buffer (#346, J1 Phase B)", () => {
  const DELIVERED = "# Hi {++there++}\n";
  // An unsaved user edit sitting in the buffer: the override text differs from what `open_document`
  // returns, so the tab mounts dirty (savedContentRef = disk `# Hi\n`, buffer = this override).
  const UNSAVED = "# Hi (my unsaved edit)\n";

  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveDocumentMock.mockResolvedValue(undefined);
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    vi.mocked(createAutosaveScheduler).mockClear();
  });

  /**
   * Spies on the mounted shell's own autosave scheduler. "Autosave was not armed" is then asserted
   * by observing `schedule()` directly — deterministic, and true at the instant of the assertion.
   * The alternative (wait, then assert `save_document` was never called) is a wall-clock race that
   * also passes vacuously when the work under test never ran at all (test-plan §7: no sleeps).
   */
  function autosaveSpy() {
    const scheduler = vi.mocked(createAutosaveScheduler).mock.results[0]?.value as AutosaveScheduler;
    expect(scheduler, "the shell armed a scheduler to spy on").toBeTruthy();
    return vi.spyOn(scheduler, "schedule");
  }

  /** Mounts a shell on "# Hi\n" and returns its handle once the initial load has settled. */
  async function mounted(props: Record<string, unknown> = {}) {
    openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
    const ref = createRef<EditorShellHandle>();
    const rendered = render(<EditorShell ref={ref} root="/project" path="a.md" {...props} />);
    await waitFor(() => expect(ref.current?.getContent()).toBe("# Hi\n"));
    return { ref, ...rendered };
  }

  /** Mounts a shell whose buffer already holds an unsaved user edit (`UNSAVED`) over a disk state of
   *  "# Hi\n" — the UXR-Q3 precondition: the tab is dirty when the delivery lands. */
  async function mountedDirty(props: Record<string, unknown> = {}) {
    openDocumentMock.mockResolvedValue({ content: "# Hi\n", revision: "r1" });
    const ref = createRef<EditorShellHandle>();
    const rendered = render(
      <EditorShell ref={ref} root="/project" path="a.md" initialContent={UNSAVED} {...props} />,
    );
    await waitFor(() => expect(ref.current?.getContent()).toBe(UNSAVED));
    return { ref, ...rendered };
  }

  const parsed = (content: string): ParsedChange[] => {
    const from = content.indexOf("{++");
    return [
      {
        id: "0",
        recorded: false,
        group: null,
        full: { from, to: content.indexOf("++}") + 3 },
        kind: "insertion",
        text: { from: from + 3, to: content.indexOf("++}") },
      },
    ];
  };

  it("reseeds the buffer with the delivered markup through the delivery path", async () => {
    const { ref, container } = await mounted();

    ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

    expect(ref.current?.getContent()).toBe(DELIVERED);
    expect(container.querySelector(".cm-content")).toHaveTextContent("there");
  });

  it("brings the delivered text and its redline in together — never text without attribution", async () => {
    // FR-AGENT-6 at the editor seam. The single-transaction shape itself is `delivery.test.ts`'s
    // contract; what this asserts is that the shell actually routes through it, so the buffer never
    // ends up holding delivered markup with no tracked-change set behind it (which would render as
    // raw `{++…++}` braces the user cannot triage).
    const { ref, container } = await mounted();

    ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

    expect(ref.current?.getContent()).toBe(DELIVERED);
    // The insertion decoration only exists where the live tracked-change set says a change is —
    // the observable proof the seed rode in with the text rather than leaving raw `{++…++}` braces.
    await waitFor(() =>
      expect(container.querySelector(".cm-redlineInsert")).toBeInTheDocument(),
    );
  });

  it("leaves the tab clean — a delivery is already on disk not an unsaved edit", async () => {
    const onDirtyChange = vi.fn();
    const { ref } = await mounted({ onDirtyChange });

    ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("does not raise the external-change banner for the agent's own delivery", async () => {
    // Attribution precedence (tech-design finding M11): a write Cowrite itself delivered is a
    // tracked change, never the FR-ED-7 "changed outside the editor" banner. The delivery moves
    // the disk baseline, so the next poll sees no divergence.
    const { ref } = await mounted({ externalChangePollMs: 10 });
    openDocumentMock.mockResolvedValue({ content: DELIVERED, revision: "r2" });

    ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");
    await waitFor(() => expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(screen.queryByText("This file changed outside the editor")).toBeNull();
  });

  it("does not arm autosave — a delivery is already on disk and must not be written back", async () => {
    // The delivery changes the doc, which is normally exactly what arms autosave. Writing back
    // here would re-save bytes the backend just wrote through its own atomic path (FR-AGENT-6),
    // for no gain and with a real chance of racing the next delivery's write.
    const { ref } = await mounted();
    const schedule = autosaveSpy();

    ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

    // The delivery genuinely landed — so this is the doc-changed case that normally arms autosave,
    // not a vacuous pass in which nothing happened at all.
    expect(ref.current?.getContent()).toBe(DELIVERED);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("is a no-op before the view has mounted rather than throwing", async () => {
    // The handle exists from ref-attach, but the view only after `open_document` resolves. A
    // delivery arriving in that window has no buffer to land in — dropping it is correct (the set
    // is on disk and attributed; the tab's own mount will parse and show it).
    openDocumentMock.mockReset();
    openDocumentMock.mockReturnValue(new Promise(() => {})); // load never settles
    const ref = createRef<EditorShellHandle>();
    render(<EditorShell ref={ref} root="/project" path="a.md" />);

    expect(() => ref.current?.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered")).not.toThrow();
  });

  // UXR-Q3 (ux-design §5 + J1 Phase B edge state, "suppress + banner"): on a DIRTY tab a delivery
  // must NOT touch the buffer. The old code replaced the doc and moved both baselines unconditionally,
  // silently destroying the user's unsaved edit and marking the tab clean. The delivered set still
  // reaches disk/sidecar (and the timeline change-set card); the open tab simply does not absorb it —
  // the FR-ED-7 poller surfaces it as an external change for the user to resolve.
  describe("UXR-Q3 — a dirty tab suppresses the in-buffer apply and defers to the FR-ED-7 banner", () => {
    it("does NOT apply the delivery to the buffer — the unsaved edit survives intact", async () => {
      const { ref, container } = await mountedDirty();

      ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

      expect(ref.current?.getContent()).toBe(UNSAVED);
      expect(container.querySelector(".cm-content")).toHaveTextContent("my unsaved edit");
      // The delivered insertion text never enters the buffer — no data loss, not merely recoverable.
      expect(container.querySelector(".cm-content")).not.toHaveTextContent("there");
    });

    it("leaves the tab dirty — the delivery never marks an unsaved buffer clean", async () => {
      const onDirtyChange = vi.fn();
      const { ref } = await mountedDirty({ onDirtyChange });
      await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
      onDirtyChange.mockClear();

      ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

      // No transaction is dispatched and neither baseline moves, so the tab is never reported clean.
      expect(onDirtyChange).not.toHaveBeenCalledWith(false);
    });

    it("raises the FR-ED-7 banner — the poller sees disk diverge from the unmoved baseline", async () => {
      const { ref } = await mountedDirty({ externalChangePollMs: 10 });
      // The backend has written the delivery to disk; the poll now reads it back. Because the dirty
      // branch moved no baseline, `diskContentRef` still holds the pre-delivery disk text, so the
      // poll detects a genuine divergence and raises the banner (Keep mine the highlighted default).
      openDocumentMock.mockResolvedValue({ content: DELIVERED, revision: "r2" });

      ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

      await waitFor(() =>
        expect(screen.getByText("This file changed outside the editor")).toBeTruthy(),
      );
      // Keep mine is the highlighted safe default when the tab is dirty (never overwrite the edit).
      expect(screen.getByRole("button", { name: "Keep mine" }).className).toContain(
        "integrity-banner__action--default",
      );
    });

    it("does not arm autosave — nothing was written to the buffer to save back", async () => {
      const { ref } = await mountedDirty();
      const schedule = autosaveSpy();

      ref.current!.applyDelivery(DELIVERED, parsed(DELIVERED), "rev-delivered");

      // The suppressed delivery dispatches no transaction, so it cannot arm autosave — which would
      // otherwise write the user's unsaved edit over the delivery the backend just put on disk.
      expect(schedule).not.toHaveBeenCalled();
      // And the suppression is why: the buffer still holds the unsaved edit, untouched.
      expect(ref.current?.getContent()).toBe(UNSAVED);
    });
  });
});

describe("editor/EditorShell — editor-anchored comment popover (#259)", () => {
  const THREAD: CommentThread = {
    id: "c1",
    author: "alice",
    last_activity_at: 0,
    anchor: {
      offset: 6,
      length: 5,
      text_snapshot: "world",
      context_before: "hello ",
      context_after: "\n",
      base_revision: "r0",
    },
    body: "please clarify",
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

  beforeEach(() => {
    openDocumentMock.mockReset();
    openDocumentMock.mockResolvedValue({ content: "hello world\n", revision: "r0" });
    saveDocumentMock.mockReset();
    parseChangesMock.mockReset();
    parseChangesMock.mockResolvedValue([]);
    captureAnchorMock.mockReset();
    capturedOnSelectionChange = null;
    createCommentMock.mockReset();
    replyToCommentMock.mockReset();
    resolveCommentMock.mockReset();
    loadCommentThreadsMock.mockReset();
  });

  it("#2574 resolves a popover passage route into the live editor selection", async () => {
    resolveAnchorMock.mockReset().mockResolvedValueOnce({ from: 6, to: 11 });
    const { container } = render(<EditorShell root="/project" path="a.md" commentThreads={[THREAD]} />);
    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);

    fireEvent.click(screen.getByRole("button", { name: "“world”" }));

    await waitFor(() => expect(resolveAnchorMock).toHaveBeenCalledWith("hello world\n", THREAD.anchor));
    await waitFor(() => expect(realSelectionReports).toHaveBeenCalledWith({ offset: 6, length: 5, text: "world" }));
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    await waitFor(() => expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([6, 11]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("routes Go to changes from the popover to the live tracked-change ID", async () => {
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    const linked = { ...THREAD, linked_changes: [linkedChange("9")] };
    const { container } = render(<EditorShell root="/project" path="a.md" commentAuthor="alice" commentThreads={[linked]} />);
    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to changes" }));
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.selection.main.from).toBe(11);
    expect(view.state.selection.main.to).toBe(19);
  });

  it("shows no comment trigger while the caret has no selection", async () => {
    render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("shows the comment trigger once a non-empty selection is reported", async () => {
    render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  it("clicking the comment trigger opens the popover in create mode with the selection preview", async () => {
    render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(screen.getByText("Commenting on: “hello”")).toBeTruthy();
    // The trigger itself is hidden while the popover it opens is showing (no overlapping chrome)
    // — only the composer's own submit button (a distinct `type="submit"` button) remains, not
    // the floating trigger.
    expect(screen.getAllByRole("button", { name: "Comment" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Comment" })).toHaveProperty("type", "submit");
  });

  it("submitting the create popover calls createComment with the live buffer content and the selection's UTF-16 range and closes it", async () => {
    createCommentMock.mockResolvedValueOnce([THREAD]);
    const onCommentThreadsChanged = vi.fn();
    render(
      <EditorShell
        root="/project"
        path="a.md"
        commentAuthor="alice"
        now={() => 100}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 6, length: 5, text: "world" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "nice word" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith(
      "/project",
      "a.md",
      "alice",
      "nice word",
      { content: "hello world\n", utf16Offset: 6, utf16Length: 5 },
      100,
    );
    await waitFor(() => expect(onCommentThreadsChanged).toHaveBeenCalledWith([THREAD]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking a comment highlight opens the popover in view mode showing that thread", async () => {
    const { container } = render(<EditorShell root="/project" path="a.md" commentThreads={[THREAD]} />);

    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    expect(highlight).not.toHaveClass("cm-commentHighlight-selected");
    fireEvent.mouseDown(highlight);

    expect(screen.getByText("please clarify")).toBeTruthy();
    expect(container.querySelector(".cm-commentHighlight-selected")).toHaveTextContent("world");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".cm-commentHighlight-selected")).toBeNull();
  });

  it("resolving a thread through the popover bubbles the updated list via onCommentThreadsChanged", async () => {
    const resolved: CommentThread = { ...THREAD, resolved: true };
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    const onCommentThreadsChanged = vi.fn();
    render(
      <EditorShell
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        commentAuthor="alice"
        now={() => 200}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );

    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "a.md", "c1", "alice", 200);
    expect(await screen.findByText("Resolved")).toBeTruthy();
    expect(onCommentThreadsChanged).toHaveBeenCalledWith([resolved]);
  });

  it("resolving a thread after the buffer has been edited still bubbles onCommentThreadsChanged but leaves the stale highlight class in place (PR #495 review Important #2)", async () => {
    // A tracked-change insertion positioned strictly after "world" so accepting it edits the doc
    // (nulling `documentRevisionField`, per `dirtyTrackingExtension`/`documentRevisionField`'s
    // contract) without moving THREAD's anchor at all.
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    const resolved: CommentThread = { ...THREAD, resolved: true };
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    // The accept below dirties the buffer, and this shell's unmount-flush autosaves it — give
    // `saveDocument` a resolution so that flush doesn't reject (this test isn't exercising save).
    saveDocumentMock.mockResolvedValue(undefined);
    const onCommentThreadsChanged = vi.fn();
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        commentAuthor="alice"
        now={() => 200}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );

    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    expect(container.querySelector(".cm-commentHighlight")).toHaveClass("cm-commentHighlight-open");

    // Edits the live buffer — the revision `documentThreadsState`'s re-seed effect is gated on.
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);

    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "a.md", "c1", "alice", 200);
    expect(await screen.findByText("Resolved")).toBeTruthy();
    // The mutation still reaches the owner...
    expect(onCommentThreadsChanged).toHaveBeenCalledWith([resolved]);
    // ...but the in-editor highlight, whose re-seed was dropped as stale-revision, never picks up
    // the "resolved" state while the buffer is unsaved — it is still drawn "open" until the next
    // save names the buffer's text again (the test below), which is the honest position call: the
    // thread was anchored against text this buffer no longer holds.
    expect(container.querySelector(".cm-commentHighlight")).toHaveClass("cm-commentHighlight-open");
    expect(container.querySelector(".cm-commentHighlight-resolved")).toBeNull();
  });

  it("a save re-reads the threads and re-seeds the highlights at the revision it wrote (#1121)", async () => {
    // The card's own scenario: the buffer has been edited, so `documentRevisionField` is null and
    // every seed is refused. The save names the buffer's text again — and the re-read resolves
    // every anchor against exactly those just-written bytes, so both the position and the state
    // colour land.
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    saveDocumentMock.mockResolvedValue("r1");
    // Re-anchored against the saved text: the same thread, now resolved, and sitting on "hello".
    const reanchored: CommentThread = {
      ...THREAD,
      resolved: true,
      anchor: { ...THREAD.anchor!, offset: 0, length: 5, text_snapshot: "hello", base_revision: "r1" },
    };
    loadCommentThreadsMock.mockResolvedValue([reanchored]);
    const onCommentThreadsChanged = vi.fn();
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        onCommentThreadsChanged={onCommentThreadsChanged}
        autosaveIntervalMs={3_600_000}
      />,
    );

    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);

    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() =>
      expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull(),
    );
    expect(loadCommentThreadsMock).toHaveBeenCalledWith("/project", "a.md");
    // The seed's own offsets, not the pre-save ones CM6 had been mapping: the highlight moved.
    expect(container.querySelector(".cm-commentHighlight")?.textContent).toBe("hello");
    // The re-anchored list is reported to the single owner too, so no surface is left holding the
    // pre-save copy while this one draws the new anchors.
    expect(onCommentThreadsChanged).toHaveBeenCalledWith([reanchored]);
  });

  it("a mutation landing while the post-save re-read is in flight is not overwritten by it", async () => {
    const resolved: CommentThread = { ...THREAD, resolved: true };
    saveDocumentMock.mockResolvedValue("r1");
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    let finishRead: (threads: CommentThread[]) => void = () => {};
    loadCommentThreadsMock.mockReturnValueOnce(
      new Promise<CommentThread[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        commentAuthor="alice"
        now={() => 200}
        autosaveIntervalMs={3_600_000}
      />,
    );

    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    // The save lands, so the re-read is now in flight — and the resolve below happens inside it.
    await act(async () => {
      await ref.current?.save();
    });
    await waitFor(() => expect(loadCommentThreadsMock).toHaveBeenCalled());

    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("Resolved")).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull(),
    );

    // The read finally returns the pre-resolve list — older than what the shell now holds, so it
    // is dropped whole rather than flipping the thread back to "open".
    await act(async () => {
      finishRead([THREAD]);
    });
    expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull();
  });

  it("a comment created after a save is highlighted straight away — the declared revision moved with the write", async () => {
    // The other half of #1121: with the shell's revision refreshed by the save, the mutation's own
    // re-seed (the `commentThreadsState` effect) lands, so the created thread is reachable through
    // its anchor — the route `CommentPopover` deliberately leaves the user (it does not switch to
    // view mode after create).
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    saveDocumentMock.mockResolvedValue("r1");
    createCommentMock.mockResolvedValueOnce([THREAD]);
    const ref = createRef<EditorShellHandle>();
    render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentAuthor="alice"
        now={() => 100}
        autosaveIntervalMs={3_600_000}
      />,
    );

    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);
    await act(async () => {
      await ref.current?.save();
    });
    // A document with no threads yet costs no re-read on save — there is nothing to place.
    expect(loadCommentThreadsMock).not.toHaveBeenCalled();

    act(() => capturedOnSelectionChange?.({ offset: 6, length: 5, text: "world" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "nice word" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("world", { selector: ".cm-commentHighlight" })).toBeTruthy();
  });

  it("an edit during the save round trip leaves the highlights alone — the returned revision no longer names the buffer", async () => {
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    // Held open so the accept below lands *while the write is in flight* — the write carries the
    // pre-accept text, so its revision names bytes the buffer no longer holds.
    let finishSave: (revision: string) => void = () => {};
    saveDocumentMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishSave = resolve;
      }),
    );
    saveDocumentMock.mockResolvedValue("r2");
    loadCommentThreadsMock.mockResolvedValue([{ ...THREAD, resolved: true }]);
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        autosaveIntervalMs={3_600_000}
      />,
    );

    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    const saved = ref.current?.save();
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);
    await act(async () => {
      finishSave("r1");
      await saved;
    });

    await waitFor(() => expect(loadCommentThreadsMock).toHaveBeenCalled());
    expect(container.querySelector(".cm-commentHighlight")).toHaveClass("cm-commentHighlight-open");
    expect(container.querySelector(".cm-commentHighlight-resolved")).toBeNull();
  });

  it("a CRLF document's initial load projects its disk-space thread onto the exact CM6 word (#1799)", async () => {
    // `load_comment_threads` resolves every anchor against the on-disk text — here the raw CRLF
    // bytes, since this is the load moment, before any save has had a chance to normalize (or the
    // user opted out of ever letting one). "hello world" is 11 UTF-16 units, so on disk the "\r" is
    // at 11, the "\n" at 12 and "second" starts at 13 — and 13 is what the backend emits here:
    // `load_comment_threads` reads the file verbatim (`fs::read_to_string` → `Document::new`, no
    // normalization) and resolves every anchor against those raw bytes, so this fixture is a
    // response that command can actually produce. CM6 counts that same break as exactly one
    // position, so "second" is really at offset 12 in the buffer's own space, and seeding the disk
    // offset 13 unchanged would draw the highlight one unit late — over "econd " — the confidently
    // wrong position P2 forbids. Projecting it to CM6 position 12 restores FR-CMT-1 without changing
    // the CRLF bytes TD-2 keeps as the source of truth.
    const content = "hello world\r\nsecond line\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    const diskAnchored: CommentThread = {
      ...THREAD,
      anchor: { ...THREAD.anchor!, offset: 13, length: 6, text_snapshot: "second", base_revision: "r0" },
    };
    const { container } = render(
      <EditorShell root="/project" path="a.md" commentThreads={[diskAnchored]} />,
    );

    const highlight = await screen.findByText("second", { selector: ".cm-commentHighlight" });
    expect(highlight).toHaveTextContent("second");
    expect(container.querySelector(".cm-content")?.textContent).toContain("second line");
  });

  it("a comment-thread prop update on that same still-unsaved CRLF buffer projects the disk-space seed (#1799)", async () => {
    // The mount effect's initial seed is one dispatch site; `commentThreadsState`'s own re-seed
    // effect (the mutation-driven path #259's popover uses) is a second, independent one — both read
    // threads resolved against on-disk text, so both need the identical CRLF guard, not just the
    // first to run.
    const content = "hello world\r\nsecond line\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    const diskAnchored: CommentThread = {
      ...THREAD,
      anchor: { ...THREAD.anchor!, offset: 13, length: 6, text_snapshot: "second", base_revision: "r0" },
    };
    const { container, rerender } = render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(container.textContent).toContain("second line"));

    rerender(<EditorShell root="/project" path="a.md" commentThreads={[diskAnchored]} />);

    const highlight = await screen.findByText("second", { selector: ".cm-commentHighlight" });
    expect(highlight).toHaveTextContent("second");
    expect(container.querySelector(".cm-content")?.textContent).toContain("second line");
  });

  it("a non-normalizing CRLF save re-seeds its projected thread state without moving the highlight (#1799)", async () => {
    const content = "hello world\r\nsecond line\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    saveDocumentMock.mockResolvedValue("r1-crlf");
    const diskAnchored: CommentThread = {
      ...THREAD,
      anchor: { ...THREAD.anchor!, offset: 13, length: 6, text_snapshot: "second", base_revision: "r0" },
    };
    loadCommentThreadsMock.mockResolvedValue([
      {
        ...diskAnchored,
        resolved: true,
        anchor: { ...diskAnchored.anchor!, base_revision: "r1-crlf" },
      },
    ]);
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[diskAnchored]}
        autosaveIntervalMs={3_600_000}
      />,
    );

    // The dedicated load regression above owns the mount path. Wait only for the document here so
    // this cell reaches — and independently discriminates — the post-save re-seed even when raw
    // projection is broken at every seed entry point.
    await waitFor(() =>
      expect(container.querySelector(".cm-content")?.textContent).toContain("second line"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Don't convert this file" }));
    await act(async () => {
      await ref.current?.save();
    });

    expect(saveDocumentMock).toHaveBeenCalledWith("/project", "a.md", content, false);
    await waitFor(() =>
      expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull(),
    );
    expect(container.querySelector(".cm-commentHighlight")?.textContent).toBe("second");
  });

  it("a normalizing save of a CRLF buffer re-seeds at the LF revision — CM6 positions and the written LF bytes are one coordinate space (PR #1322 review Important)", async () => {
    // The Windows case this card was reported on, and the one the guard must *not* refuse. CM6
    // counts every line break — CRLF included — as exactly one position, so the buffer's position
    // space is already the LF text the normalizing write puts on disk: `load_comment_threads`
    // resolves against those very bytes, and offset 14 there is offset 14 here. (Measured against
    // the real `@codemirror/state`: `doc.toString()` is byte-identical to the written LF text,
    // while `serializeDocumentState` re-joins with CRLF and drifts one unit per preceding break.)
    const content = "hello world{++ !++}\r\nsecond line\r\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    saveDocumentMock.mockResolvedValue("r1-lf");
    // Re-anchored against the written LF text "hello world !\nsecond line\n" — "second" sits at
    // UTF-16 offset 14 there. Pairing that offset with the CRLF-serialized text instead would
    // decorate from 14 of "hello world !\r\nsecond line\r\n", i.e. one unit short of the word.
    const reanchored: CommentThread = {
      ...THREAD,
      resolved: true,
      anchor: {
        ...THREAD.anchor!,
        offset: 14,
        length: 6,
        text_snapshot: "second",
        base_revision: "r1-lf",
      },
    };
    loadCommentThreadsMock.mockResolvedValue([reanchored]);
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        autosaveIntervalMs={3_600_000}
      />,
    );

    // #1799 projects the document's initial raw-CRLF seed, so its existing "world" thread is
    // already highlighted before this save. The save below changes both the text and the source
    // coordinate form: the backend now resolves against LF bytes, which are CM6 position space
    // directly and therefore need no subtraction.
    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    // Edits the buffer, so `documentRevisionField` nulls out and only the save can re-declare it.
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);
    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() =>
      expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull(),
    );
    // Lands on the whole word, not one unit into it — the offsets are in the buffer's own space.
    expect(container.querySelector(".cm-commentHighlight")?.textContent).toBe("second");
  });

  it("a buffer holding a lone CR the save rewrote declares nothing — those bytes are not what landed", async () => {
    // The remaining FR-ED-2 fidelity gap, refused rather than approximated (P2). A lone `\r` is no
    // line break to CM6 (the separator is `\n` here), so it stays *inside* a line while the write
    // turns it into an LF on disk: the backend resolved its anchors against text this buffer does
    // not hold, and the honest answer is no seed. The next save cannot clear it either — the
    // buffer keeps the `\r` — so the highlights simply stay where CM6 mapped them.
    openDocumentMock.mockResolvedValueOnce({ content: "hello\rworld\nsecond\n", revision: "r0" });
    saveDocumentMock.mockResolvedValue("r1-lf");
    loadCommentThreadsMock.mockResolvedValue([{ ...THREAD, resolved: true }]);
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        autosaveIntervalMs={3_600_000}
      />,
    );

    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() => expect(loadCommentThreadsMock).toHaveBeenCalled());
    expect(container.querySelector(".cm-commentHighlight")).toHaveClass("cm-commentHighlight-open");
    expect(container.querySelector(".cm-commentHighlight-resolved")).toBeNull();
  });

  it("a failed post-save re-read still declares the revision so the next mutation's own seed lands (PR #1322 review Minor)", async () => {
    // The read and the declaration are independent: the revision names the bytes the write put on
    // disk whether or not the sidecar could be re-read. Withholding it would cost the *next*
    // mutation its highlight too — for no gain, since the failed read seeds nothing either way.
    const content = "hello world{++ !++}\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "r0" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "9", full: { from: 11, to: 19 }, kind: "insertion", text: { from: 14, to: 16 } },
    ]);
    saveDocumentMock.mockResolvedValue("r1");
    loadCommentThreadsMock.mockRejectedValue(new Error("sidecar unreadable"));
    const resolved: CommentThread = { ...THREAD, resolved: true };
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    const ref = createRef<EditorShellHandle>();
    const { container } = render(
      <EditorShell
        ref={ref}
        root="/project"
        path="a.md"
        commentThreads={[THREAD]}
        commentAuthor="alice"
        now={() => 200}
        autosaveIntervalMs={3_600_000}
      />,
    );

    await screen.findByText("world", { selector: ".cm-commentHighlight" });
    expect(ref.current?.decideChanges(["9"], "accept")).toEqual(["9"]);
    await act(async () => {
      await ref.current?.save();
    });
    await waitFor(() => expect(loadCommentThreadsMock).toHaveBeenCalled());

    // The failed read left the highlights exactly where CM6 mapped them — still "open", since
    // nothing was seeded...
    expect(container.querySelector(".cm-commentHighlight")).toHaveClass("cm-commentHighlight-open");
    // ...but the declared revision names this buffer, so the resolve below is seeded at once
    // rather than waiting for another save (contrast the unsaved-buffer test above, where the
    // revision is null and the same mutation leaves the highlight drawn "open").
    const highlight = await screen.findByText("world", { selector: ".cm-commentHighlight" });
    fireEvent.mouseDown(highlight);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(await screen.findByText("Resolved")).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector(".cm-commentHighlight-resolved")).not.toBeNull(),
    );
  });

  it("closing the popover (Escape) restores the comment trigger for the still-live selection", async () => {
    render(<EditorShell root="/project" path="a.md" />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 5, text: "hello" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  });
});
