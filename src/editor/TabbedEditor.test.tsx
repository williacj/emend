// @vitest-environment jsdom
// ABOUTME: FR-ED-3 at the tab layer (P2a-6) — multi-tab open, switching, session restore
// ABOUTME: (incl. dirty content), and the dirty-close guard (save/discard/cancel).
import { createRef } from "react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest } from "../testHarness";
import type {
  ProjectFileEntry,
  ProjectFileMove,
  ProjectFilesSnapshot,
} from "../stores/project";
import type { ParsedChange } from "./trackedChanges";
import type { Anchor, CommentThread } from "../comments/types";
import { thread } from "../comments/threadFixture";
import type { SelectionSnapshot } from "./selectionWatcher";
import { SESSION_UNSAVED_CONTENT_CAP_BYTES } from "../stores/tabs";
import { UserFacingError } from "../backend";
import { getAppStatus } from "../stores/appStatus";
import { revealAtCursorEnabledField } from "./structuralDecorations";
import { serializeDocumentState } from "./document";
import { beginEditorDictation, commitEditorDictationFinal, showEditorDictationPartial } from "./dictationGhost";

function activeTextboxView(): EditorView {
  const textbox = screen.getByRole("textbox");
  const editor = textbox.closest<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("Expected the active textbox to belong to a CM6 editor");
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("Expected a mounted CM6 EditorView");
  return view;
}

function replaceActiveTextbox(value: string): void {
  const view = activeTextboxView();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
}

function expectActiveTextbox(value: string): void {
  expect(activeTextboxView().state.doc.toString()).toBe(value);
}

const openDocumentMock = vi.fn();
const saveDocumentMock = vi.fn();
const saveTabSessionMock = vi.fn();
const proveTabSessionMock = vi.fn();
const beginTabSessionMock = vi.fn();
const endTabSessionMock = vi.fn();
const setOpenTabsMock = vi.fn();
const loadTabSessionMock = vi.fn();
const parseChangesMock = vi.fn();
const captureAnchorMock = vi.fn();
const resolveAnchorMock = vi.fn();
// J2's Missing-on-disk recovery boundary (#933) — the capability query answers "no" by default
// (macOS, and every unsupported filesystem), so a suite that drives a missing document without
// saying otherwise gets the no-Recreate chrome the majority of installs actually see.
const recreateCapabilityMock = vi.fn<
  (path: string) => Promise<import("./ipc").RecreateCapability>
>(async (path: string) => ({ path, status: "confinement_unavailable" }));
const recreateMock = vi.fn();
const saveDocumentAsMock = vi.fn();
const isProjectPathEnumerableMock = vi.fn(async (_path: string) => true);
const prepareAdoptionMock = vi.fn();
const landAdoptionMock = vi.fn();
const commitAdoptionMock = vi.fn();
const cancelAdoptionMock = vi.fn();
const reconcileAdoptionsMock = vi.fn();
const mintUntitledDocIdMock = vi.fn();
const loadCommentThreadsMock = vi.fn();

vi.mock("../stores/adoption", () => ({
  prepareAdoption: (...args: unknown[]) => prepareAdoptionMock(...args),
  landAdoption: (...args: unknown[]) => landAdoptionMock(...args),
  commitAdoption: (...args: unknown[]) => commitAdoptionMock(...args),
  cancelAdoption: (...args: unknown[]) => cancelAdoptionMock(...args),
  reconcileAdoptions: (...args: unknown[]) => reconcileAdoptionsMock(...args),
  mintUntitledDocId: (...args: unknown[]) => mintUntitledDocIdMock(...args),
}));

// The composition-seam quit-flush witness below keeps the real appLifecycle implementation and
// supplies the same Tauri close-request boundary its own tests use. Most tests stay on the ordinary
// dev-mode path (`isTauri() === false`); the one wiring test opts in explicitly.
const isTauriMock = vi.fn(() => false);
let closeRequestedHandler: ((event: { preventDefault: () => void }) => void) | null = null;
const onCloseRequestedMock = vi.fn(
  async (handler: (event: { preventDefault: () => void }) => void) => {
    closeRequestedHandler = handler;
    return vi.fn();
  },
);
const destroyWindowMock = vi.fn();
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: onCloseRequestedMock, destroy: destroyWindowMock }),
}));

// Preserve the real scheduler while exposing its flush calls. These assertions cover explicit
// blur/tab-set flush points; native close instead composes live buffers through the final receipt
// path (the scheduler's own timer algebra remains covered in autosave.test.ts).
const schedulerFlushMocks: ReturnType<typeof vi.fn>[] = [];
const schedulerCancelMocks: ReturnType<typeof vi.fn>[] = [];
vi.mock("./autosave", async (importActual) => {
  const actual = await importActual<typeof import("./autosave")>();
  return {
    ...actual,
    createAutosaveScheduler: (save: () => void, intervalMs?: number) => {
      const scheduler = actual.createAutosaveScheduler(save, intervalMs);
      const flush = vi.fn(scheduler.flush);
      const cancel = vi.fn(scheduler.cancel);
      schedulerFlushMocks.push(flush);
      schedulerCancelMocks.push(cancel);
      return { ...scheduler, flush, cancel };
    },
  };
});
vi.mock("./ipc", () => ({
  openDocument: (...args: unknown[]) => openDocumentMock(...args),
  saveDocument: (...args: unknown[]) => saveDocumentMock(...args),
  saveDocumentAs: (...args: unknown[]) => saveDocumentAsMock(...args),
  recreateMissingDocumentCapability: (path: string) => recreateCapabilityMock(path),
  recreateMissingDocument: (...args: unknown[]) => recreateMock(...args),
  saveTabSession: (...args: unknown[]) => saveTabSessionMock(...args),
  proveTabSession: (...args: unknown[]) => proveTabSessionMock(...args),
  beginTabSession: (...args: unknown[]) => beginTabSessionMock(...args),
  endTabSession: (...args: unknown[]) => endTabSessionMock(...args),
  setOpenTabs: (...args: unknown[]) => setOpenTabsMock(...args),
  loadTabSession: (...args: unknown[]) => loadTabSessionMock(...args),
  // Defaults to "no changes" (set in each describe block's `beforeEach`) so the redline seed never
  // throws on a module that doesn't otherwise care about it — only the #410 wiring suite below
  // overrides it per test.
  parseChanges: (...args: unknown[]) => parseChangesMock(...args),
  // The quote-bar's capture/deep-link-back round trip (#492) — only the suites below exercise
  // these; every other describe block never mounts a selection/quote surface.
  captureAnchor: (...args: unknown[]) => captureAnchorMock(...args),
  resolveAnchor: (...args: unknown[]) => resolveAnchorMock(...args),
}));

vi.mock("../stores/project", async (importActual) => {
  const actual = await importActual<typeof import("../stores/project")>();
  return {
    ...actual,
    isProjectPathEnumerable: (path: string) => isProjectPathEnumerableMock(path),
  };
});

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue({ active: null, queued: [], lastFinished: null });
  proveTabSessionMock.mockReset();
  prepareAdoptionMock.mockReset().mockResolvedValue(undefined);
  landAdoptionMock.mockReset().mockImplementation(async () => ({
    revision: "blake3:new",
    destination: prepareAdoptionMock.mock.calls[prepareAdoptionMock.mock.calls.length - 1]?.[3],
    pending: false,
  }));
  commitAdoptionMock.mockReset().mockResolvedValue(undefined);
  cancelAdoptionMock.mockReset().mockResolvedValue(undefined);
  reconcileAdoptionsMock.mockReset().mockResolvedValue({ published: [], pendingDestinations: [] });
  mintUntitledDocIdMock.mockReset().mockResolvedValue("4c7be32a-45f8-476f-a175-8fd48cab51d3");
  loadCommentThreadsMock.mockReset().mockResolvedValue([]);
});

// The native save panel behind J2's `[Save As…]` (#933) — replaced (the real one needs a Tauri
// webview) while `relativeToProjectRoot`, which decides whether the chosen path is even inside the
// project, stays real: that refusal is part of what this layer's Save As must honor.
const pickSaveAsPathMock = vi.fn(async (_root: string, _suggested: string) => null as string | null);
vi.mock("../stores/menu", async (importActual) => {
  const actual = await importActual<typeof import("../stores/menu")>();
  return { ...actual, pickSaveAsPath: (...args: [string, string]) => pickSaveAsPathMock(...args) };
});

// #411 (editor→owner direction): the editor-anchored comment popover's own IPC boundary, mocked
// the same way `EditorShell.test.tsx` mocks it, only so the comment-ownership suite below can drive
// a real create through it — every other suite in this file never opens a comment surface.
const createCommentMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  loadCommentThreads: (...args: unknown[]) => loadCommentThreadsMock(...args),
  createComment: (...args: unknown[]) => createCommentMock(...args),
  replyToComment: vi.fn(),
  resolveComment: vi.fn(),
  reopenComment: vi.fn(),
  reAnchorComment: vi.fn(),
  addressWithAI: vi.fn(),
  decideLinkedChanges: vi.fn(),
}));

// Captures the most recently mounted `EditorShell`'s own selection-change callback — lets a test
// fire a selection change directly rather than driving real CM6 mouse/keyboard selection through
// jsdom, mirroring `EditorShell.test.tsx`'s identical capture. Only used by the single-tab #411
// comment-ownership suite below (one shell mounted at a time), so "most recent" is unambiguous there.
let capturedOnSelectionChange: ((selection: SelectionSnapshot | null) => void) | null = null;
vi.mock("./selectionWatcher", async (importActual) => {
  const actual = await importActual<typeof import("./selectionWatcher")>();
  return {
    ...actual,
    selectionWatcherExtension: (onChange: (selection: SelectionSnapshot | null) => void) => {
      capturedOnSelectionChange = onChange;
      return actual.selectionWatcherExtension(onChange);
    },
  };
});

const { TabbedEditor, quotedExcerptFor } = await import("./TabbedEditor");
type TabbedEditorHandle = import("./TabbedEditor").TabbedEditorHandle;

beforeEach(() => {
  isTauriMock.mockReturnValue(false);
  onCloseRequestedMock.mockClear();
  closeRequestedHandler = null;
  destroyWindowMock.mockReset().mockResolvedValue(undefined);
  schedulerFlushMocks.length = 0;
  schedulerCancelMocks.length = 0;
  beginTabSessionMock.mockReset().mockImplementation((root: string) => loadTabSessionMock(root));
  endTabSessionMock.mockReset().mockResolvedValue(undefined);
});

let nextId = 0;
function request(root: string, path: string): OpenRequest {
  return { root, path, id: nextId++ };
}

function contentFor(path: string): string {
  return `# ${path}\n`;
}

/** One file row as the backend publishes it. */
function fileRow(path: string): ProjectFileEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "file",
    children: [],
    warning: null,
  };
}

/**
 * A folder row as a completed generation publishes it. `enumerated: false` is the shape the backend
 * emits when `read_dir` failed: the row is present, carries its typed warning, and has no children
 * — so nothing beneath it is enumerated and nothing beneath it can be proved missing (#933).
 */
function folderRow(path: string, children: string[], enumerated = true): ProjectFileEntry {
  return {
    ...fileRow(path),
    kind: "directory",
    children: children.map(fileRow),
    warning: enumerated ? null : { kind: "unreadable", message: "permission denied" },
  };
}

let nextGenerationNumber = 0;
/**
 * One completed project-files generation as `ProjectRail` funnels it (#932/#933): the rows it
 * enumerated, plus the transitions it proved. What it lists is load-bearing in both directions — a
 * path listed as a file still has one, and an open tab absent from a place this generation actually
 * enumerated is exactly what J2 calls Missing on disk — so a move test lists the *destinations*:
 * those documents did not disappear, they moved.
 */
function generationOf(entries: ProjectFileEntry[], moves: ProjectFileMove[] = []): ProjectFilesSnapshot {
  nextGenerationNumber += 1;
  return { generation: nextGenerationNumber, entries, moves };
}

/** The same, for the common case of a flat list of file paths. */
function generation(present: string[], moves: ProjectFileMove[] = []): ProjectFilesSnapshot {
  return generationOf(present.map(fileRow), moves);
}

describe("editor/TabbedEditor — opening + switching", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("opening a second path adds a second tab rather than replacing the first", async () => {
    const { rerender } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    rerender(<TabbedEditor request={request("/project", "b.md")} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument();
  });

  it("retires a ghost before switching the active tab", async () => {
    const { rerender } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("textbox");
    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await screen.findByRole("tab", { name: /b\.md/ });
    fireEvent.click(screen.getByRole("tab", { name: /a\.md/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("aria-selected", "true"));
    const original = activeTextboxView();
    const originalText = original.state.doc.toString();
    act(() => {
      original.dispatch({ selection: { anchor: original.state.doc.length } });
      expect(beginEditorDictation(original, 51)).toBe(true);
      expect(showEditorDictationPartial(original, 51, "spoken draft")).toBe(true);
    });
    expect(original.dom.querySelector(".cm-dictation-ghost")).toHaveTextContent("spoken draft");

    fireEvent.click(screen.getByRole("tab", { name: /b\.md/ }));
    expect(original.dom.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(commitEditorDictationFinal(original, 51, "stale")).toBe(false);
    expect(original.state.doc.toString()).toBe(originalText);
    expect(activeTextboxView().state.doc.toString()).toBe(contentFor("b.md"));
  });

  it("retires a ghost when a request opens another active tab", async () => {
    const { rerender } = render(<TabbedEditor request={request("/project", "a.md")} />);
    const original = await waitFor(() => activeTextboxView());
    const originalText = original.state.doc.toString();
    act(() => {
      original.dispatch({ selection: { anchor: original.state.doc.length } });
      expect(beginEditorDictation(original, 54)).toBe(true);
      expect(showEditorDictationPartial(original, 54, "spoken draft")).toBe(true);
    });
    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("aria-selected", "true"));
    expect(original.dom.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(commitEditorDictationFinal(original, 54, "stale")).toBe(false);
    expect(original.state.doc.toString()).toBe(originalText);
  });

  it("fans a live reveal preference change out to every mounted author pane", async () => {
    const first = request("/project", "a.md");
    const rendered = render(
      <TabbedEditor request={first} revealMarkupAtCursor={false} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    await waitFor(() => expectActiveTextbox("# a.md\n"));
    const firstView = activeTextboxView();
    expect(firstView.state.field(revealAtCursorEnabledField)).toBe(false);

    const second = request("/project", "b.md");
    rendered.rerender(
      <TabbedEditor request={second} revealMarkupAtCursor={false} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    await waitFor(() => expectActiveTextbox("# b.md\n"));
    const secondView = activeTextboxView();
    expect(secondView.state.field(revealAtCursorEnabledField)).toBe(false);

    rendered.rerender(
      <TabbedEditor request={second} revealMarkupAtCursor />,
    );

    expect(firstView.state.field(revealAtCursorEnabledField)).toBe(true);
    expect(secondView.state.field(revealAtCursorEnabledField)).toBe(true);
    expect(EditorView.findFromDOM(firstView.dom)).toBe(firstView);
    expect(EditorView.findFromDOM(secondView.dom)).toBe(secondView);
  });

  it("keeps the owned project intact when the next acquisition fails and retries authority", async () => {
    beginTabSessionMock
      .mockResolvedValueOnce({ tabs: [], activePath: null })
      .mockRejectedValueOnce({ kind: "WriterBusy", message: "owned elsewhere" })
      .mockResolvedValueOnce({ tabs: [], activePath: null });
    const onError = vi.fn();
    const rendered = render(
      <TabbedEditor request={request("/project", "a.md")} onError={onError} />,
    );
    await screen.findByRole("tab", { name: /a\.md/ });
    saveTabSessionMock.mockClear();

    rendered.rerender(
      <TabbedEditor request={request("/next-project", "b.md")} onError={onError} />,
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith({ kind: "WriterBusy", message: "owned elsewhere" }),
    );
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /b\.md/ })).not.toBeInTheDocument();
    expect(saveTabSessionMock.mock.calls.some(([root]) => root === "/next-project")).toBe(false);

    rendered.rerender(
      <TabbedEditor request={request("/next-project", "c.md")} onError={onError} />,
    );

    await screen.findByRole("tab", { name: /c\.md/ });
    expect(beginTabSessionMock.mock.calls.filter(([root]) => root === "/next-project")).toHaveLength(
      2,
    );
    expect(screen.queryByRole("tab", { name: /a\.md/ })).not.toBeInTheDocument();
  });

  it("persists the acquired project's first payload after the old root release finishes", async () => {
    let releaseOldRoot!: () => void;
    const oldRootRelease = new Promise<void>((resolve) => {
      releaseOldRoot = resolve;
    });
    endTabSessionMock.mockImplementation((root: string) =>
      root === "/project" ? oldRootRelease : Promise.resolve(),
    );
    const rendered = render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("tab", { name: /a\.md/ });
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({ activePath: "a.md" }),
      ),
    );
    saveTabSessionMock.mockClear();

    rendered.rerender(<TabbedEditor request={request("/next-project", "b.md")} />);

    await screen.findByRole("tab", { name: /b\.md/ });
    await waitFor(() => expect(endTabSessionMock).toHaveBeenCalledWith("/project"));
    expect(saveTabSessionMock.mock.calls.some(([root]) => root === "/next-project")).toBe(false);

    releaseOldRoot();

    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/next-project",
        expect.objectContaining({
          tabs: [{ path: "b.md", unsavedContent: null, recoveredFrom: null }],
          activePath: "b.md",
        }),
      ),
    );
    expect(saveTabSessionMock.mock.calls.every(([root]) => root === "/next-project")).toBe(true);
  });

  it("switching tabs shows the other tab's own content and coming back preserves it", async () => {
    const { rerender, container } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "b.md"));

    // Both editors are mounted (kept alive, CSS-hidden when inactive) — b.md is active now.
    await waitFor(() => {
      const visible = [...container.querySelectorAll(".tabbed-editor__pane")].find(
        (el) => (el as HTMLElement).style.display !== "none",
      );
      expect(visible).toHaveTextContent("# b.md");
    });

    screen.getByRole("tab", { name: /a\.md/ }).click();

    await waitFor(() => {
      const visible = [...container.querySelectorAll(".tabbed-editor__pane")].find(
        (el) => (el as HTMLElement).style.display !== "none",
      );
      expect(visible).toHaveTextContent("# a.md");
    });
  });

  it("persists the tab session (open set + active path) as tabs open", async () => {
    render(<TabbedEditor request={request("/project", "a.md")} />);

    await waitFor(() => {
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({
          tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
          activePath: "a.md",
        }),
      );
    });
  });

  it("feeds the backend the complete live open-tab set as tabs open and close", async () => {
    const { rerender } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenCalledWith("/project", ["a.md"], "a.md"),
    );

    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenCalledWith("/project", ["a.md", "b.md"], "b.md"),
    );

    screen.getByRole("button", { name: "Close b.md" }).click();
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenCalledWith("/project", ["a.md"], "a.md"),
    );
  });

  it("serializes session writes so a slow in-flight save cannot be overtaken by a later one (#1393)", async () => {
    // Unlike `setOpenTabs` (serialized via `tabFeedRef`, see its own "Serialize whole-set
    // snapshots" comment), `saveTabSession` used to be called directly on every `tabs` change with
    // no ordering guarantee at all. Two real IPC round trips issued back to back can complete out
    // of call order — the backend/network has no obligation to answer them in the order they were
    // sent — so a slower *earlier* snapshot (here: just "a.md") could land on disk *after* a faster
    // *later* one (here: "a.md" + "b.md"), silently reverting the persisted session and losing the
    // second tab. This is what e2e/acceptance.spec.mjs:661 caught intermittently (open two tabs ->
    // reload -> only one tab restores).
    let resolveFirstSave!: () => void;
    saveTabSessionMock
      .mockReset()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveFirstSave = resolve; }),
      )
      .mockResolvedValue(undefined);

    const { rerender } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalledTimes(1));

    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    // The second tab's own snapshot must not reach the backend until the first save has actually
    // resolved — issuing it any earlier is exactly the unserialized race this test pins.
    expect(saveTabSessionMock).toHaveBeenCalledTimes(1);

    resolveFirstSave();
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalledTimes(2));
    expect(saveTabSessionMock).toHaveBeenLastCalledWith(
      "/project",
      expect.objectContaining({
        tabs: [
          { path: "a.md", unsavedContent: null, recoveredFrom: null },
          { path: "b.md", unsavedContent: null, recoveredFrom: null },
        ],
        activePath: "b.md",
      }),
    );
  });
});

describe("editor/TabbedEditor — session restore", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset();
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset();
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("never writes an empty session out from under an in-flight restore read (#1393)", async () => {
    // The persist effect (keyed on `tabs`) fires unconditionally on every mount, including this
    // component's very first one — by which point the sibling restore effect has already
    // synchronously pointed `rootRef.current` at the new root, moments before its own
    // `await loadTabSession` actually resolves. A naive persist effect fires right then, with
    // `tabs` still empty, and its `saveTabSession(root, { tabs: [], activePath: null })` write can
    // race — and beat — the restore's own read, silently clobbering the very session about to be
    // restored. This is what e2e/acceptance.spec.mjs:661 caught intermittently as "reload restores
    // only one tab" (or, on the wrong ordering, none at all).
    type LoadedSession = { tabs: { path: string; unsavedContent: string | null }[]; activePath: string | null };
    let resolveLoad!: (session: LoadedSession) => void;
    loadTabSessionMock.mockImplementationOnce(
      () =>
        new Promise<LoadedSession>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(<TabbedEditor request={request("/project", "a.md")} />);

    // The restore read is still in flight — nothing may have reached the backend yet.
    expect(saveTabSessionMock).not.toHaveBeenCalled();
    await waitFor(() => expect(resolveLoad).toBeTypeOf("function"));

    resolveLoad({
      tabs: [
        { path: "a.md", unsavedContent: null },
        { path: "b.md", unsavedContent: null },
      ],
      activePath: "a.md",
    });

    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    // Every call this mount ever makes carries the fully restored set — never an empty clobber.
    for (const [, payload] of saveTabSessionMock.mock.calls) {
      expect(payload.tabs.length).toBeGreaterThan(0);
    }
  });

  it("keeps tab protection and persistence live after a session restore read fails (#1393)", async () => {
    loadTabSessionMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ tabs: [], activePath: null });
    const onError = vi.fn();
    const { rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} onError={onError} />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(new Error("permission denied")));
    expect(saveTabSessionMock).not.toHaveBeenCalled();

    rerender(<TabbedEditor request={request("/project", "b.md")} onError={onError} />);

    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenCalledWith("/project", ["b.md"], "b.md"),
    );
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({
          tabs: [{ path: "b.md", unsavedContent: null, recoveredFrom: null }],
          activePath: "b.md",
        }),
      ),
    );
  });

  it("a fresh mount restores every previously open tab — not just the one requested", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [
        { path: "a.md", unsavedContent: null },
        { path: "b.md", unsavedContent: null },
      ],
      activePath: "b.md",
    });

    render(<TabbedEditor request={request("/project", "b.md")} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument();
  });

  it("a restored tab with unsaved content shows that content and the dirty indicator", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: "# a.md\n\nan in-flight edit" }],
      activePath: "a.md",
    });

    const { container } = render(<TabbedEditor request={request("/project", "a.md")} />);

    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveTextContent("an in-flight edit");
    });
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("data-dirty", "true");
  });

  it("restoring a dirty tab never re-persists it with empty content before its editor has mounted", async () => {
    // The persist effect (keyed off `tabs`) can run before the restored tab's `EditorShell` has
    // finished its async `openDocument` load — every `saveTabSession` call made in that window
    // must still carry the tab's real restored content, never an empty clobber.
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: "# a.md\n\nan in-flight edit" }],
      activePath: "a.md",
    });

    render(<TabbedEditor request={request("/project", "a.md")} />);

    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    for (const [, payload] of saveTabSessionMock.mock.calls) {
      const tab = payload.tabs.find((t: { path: string }) => t.path === "a.md");
      if (tab) expect(tab.unsavedContent).toBe("# a.md\n\nan in-flight edit");
    }
  });

  it("does not bring discarded work back when a restored dirty tab is closed and reopened", async () => {
    // The restore override is a one-shot hydration seed. Left behind by a close, it is handed
    // straight back to the reopened tab's `EditorShell` as `initialContent` — so the edit the
    // author explicitly discarded returns instead of the file on disk (FR-ED-3).
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: "DISCARDED-EDIT", recoveredFrom: null }],
      activePath: "a.md",
    });
    const { container, rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("DISCARDED-EDIT"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());

    // Reopening it — the rail, the strip, `File > Open…`, all one request seam.
    rerender(<TabbedEditor request={request("/project", "a.md")} />);

    const reopened = await screen.findByRole("tab", { name: "a.md" });
    expect(reopened).toHaveAttribute("data-dirty", "false");
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("# a.md"),
    );
    expect(container).not.toHaveTextContent("DISCARDED-EDIT");
  });

  it("retains a restored dirty tab and its unsaved content when the disk load fails", async () => {
    const unsavedContent = "# a.md\n\nan in-flight edit whose disk file disappeared";
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent }],
      activePath: "a.md",
    });
    openDocumentMock.mockRejectedValueOnce(new Error("file disappeared"));
    const onError = vi.fn();

    render(<TabbedEditor request={request("/project", "a.md")} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("data-dirty", "true");
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    const persistedTabs = saveTabSessionMock.mock.calls.flatMap(([, payload]) => payload.tabs);
    expect(persistedTabs).toContainEqual({ path: "a.md", unsavedContent, recoveredFrom: null });
    expect(persistedTabs).not.toContainEqual({
      path: "a.md",
      unsavedContent: null,
      recoveredFrom: null,
    });
  });

  it("D27 converts a dirty unsupported restored tab into an editable untitled recovery document", async () => {
    const unsavedContent = "fn main() { /* retained \u00e9 */ }\r\n";
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "draft.rs", unsavedContent, recoveredFrom: null }],
      activePath: "draft.rs",
    });
    openDocumentMock.mockRejectedValue({
      kind: "InvalidDocument",
      message: "Emend supports only Markdown and plain-text documents",
    });
    pickSaveAsPathMock.mockReset().mockResolvedValue("/project/drafts/recovered.md");

    const first = render(<TabbedEditor request={request("/project", "draft.rs")} />);

    const recovered = await screen.findByRole("tab", {
      name: /Untitled — recovered from draft\.rs, editable/,
    });
    expect(recovered).toHaveAttribute("data-dirty", "false");
    expect(screen.queryByRole("tab", { name: "draft.rs" })).not.toBeInTheDocument();
    // The tab and notice can render before UntitledDocument's effect mounts its CM6 textbox.
    await waitFor(() => expect(serializeDocumentState(activeTextboxView().state)).toBe(unsavedContent));
    expect(saveDocumentMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
        payload.activePath === "untitled:1:draft.rs" &&
        payload.tabs.some((tab: { path: string; recoveredFrom: string | null; unsavedContent: string | null }) =>
          tab.path === "untitled:1:draft.rs" &&
          tab.recoveredFrom === "draft.rs" &&
          tab.unsavedContent === unsavedContent,
        ),
      )).toBe(true),
    );
    const saved = saveTabSessionMock.mock.calls.find(([, payload]) =>
      payload.activePath === "untitled:1:draft.rs" &&
      payload.tabs.some((tab: { unsavedContent: string | null }) => tab.unsavedContent === unsavedContent),
    )?.[1];
    first.unmount();
    loadTabSessionMock.mockResolvedValueOnce(saved);

    render(<TabbedEditor request={request("/project", "untitled:1:draft.rs")} />);

    await screen.findByRole("region", { name: /recovered from draft\.rs/ });
    await waitFor(() => expect(serializeDocumentState(activeTextboxView().state)).toBe(unsavedContent));
    replaceActiveTextbox(`${unsavedContent}more work`);
    expect(serializeDocumentState(activeTextboxView().state)).toBe(`${unsavedContent}more work`);
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(landAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
      `${unsavedContent}more work`,
    ));
    expect(prepareAdoptionMock.mock.calls[0]).toEqual([
      "/project",
      expect.any(String),
      "draft.rs",
      "drafts/recovered.md",
      expect.any(String),
      false,
      `${unsavedContent}more work`,
      expect.any(String),
    ]);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "drafts/recovered.md" })).toBeInTheDocument(),
    );
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("D27 shows the retained unsupported-source notice in the editable pane", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "research/survey-export.csv", unsavedContent: "retained rows", recoveredFrom: null }],
      activePath: "research/survey-export.csv",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    pickSaveAsPathMock.mockReset().mockResolvedValue("/project/research/recovered.md");
    render(<TabbedEditor request={request("/project", "research/survey-export.csv")} />);

    const notice = await screen.findByRole("region", { name: "Unsupported document recovery notice" });
    const toolbar = await screen.findByRole("toolbar", { name: "Editor view controls" });
    expect(toolbar.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice).toHaveTextContent("research/survey-export.csv can’t open as an Emend document.");
    expect(notice).toHaveTextContent("The unsaved text this tab held is here, in an untitled document you can edit.");
    expect(notice).toHaveTextContent("Save As… saves it to a supported document path in this project — not to the original file.");
    expect(screen.getByRole("textbox")).toHaveTextContent("retained rows");
    expect(screen.getByText("Saved nowhere yet")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Untitled — recovered from research\/survey-export\.csv/ }))
      .not.toHaveAttribute("data-recovery-content-omitted");

    fireEvent.click(within(notice).getByRole("button", { name: "Hide message" }));
    expect(screen.queryByRole("region", { name: "Unsupported document recovery notice" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveTextContent("retained rows");
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "research/recovered.md" })).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Unsupported document recovery notice" })).toBeNull();
  });

  it("D27 composes the source notice with a separate earlier omission fact", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "research/survey-export.csv", unsavedContent: "current rows", unsavedContentOmitted: true, recoveredFrom: null }],
      activePath: "research/survey-export.csv",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    render(<TabbedEditor request={request("/project", "research/survey-export.csv")} />);

    const source = await screen.findByRole("region", { name: "Unsupported document recovery notice" });
    const omission = screen.getByRole("region", { name: "Recovery notice, untitled document from research/survey-export.csv" });
    expect(source.compareDocumentPosition(omission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(source).toHaveTextContent("The unsaved text this tab held is here");
    expect(omission).toHaveTextContent("Some earlier unsaved work in this tab couldn’t be preserved.");
    expect(omission).toHaveTextContent("What is here is the text that was kept. It doesn’t bring back what wasn’t.");
    expect(screen.getByRole("tab", { name: /earlier unsaved work was not preserved/ }))
      .toHaveAttribute("data-recovery-content-omitted", "true");
  });

  it("D27 source notice follows the toolbar and precedes the standing strip", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "research/survey-export.csv", unsavedContent: "current rows", unsavedContentOmitted: true, recoveredFrom: null }],
      activePath: "research/survey-export.csv",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    render(<TabbedEditor request={request("/project", "research/survey-export.csv")} />);

    const toolbar = await screen.findByRole("toolbar", { name: "Editor view controls" });
    const source = await screen.findByRole("region", { name: "Unsupported document recovery notice" });
    const loss = screen.getByRole("region", { name: "Recovery notice, untitled document from research/survey-export.csv" });
    const standing = screen.getByLabelText("Untitled document status");
    const buffer = screen.getByRole("textbox", { name: "Untitled document text" });
    for (const [first, second] of [[toolbar, source], [source, loss], [loss, standing], [standing, buffer]]) {
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("D27 recovers an explicitly retained empty buffer without treating it as a clean tab", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "empty.rs", unsavedContent: "", recoveredFrom: null }],
      activePath: "empty.rs",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });

    render(<TabbedEditor request={request("/project", "empty.rs")} />);

    await screen.findByRole("tab", { name: /Untitled — recovered from empty\.rs, editable/ });
    // On Windows the tab can paint before UntitledDocument's effect mounts its CM6 textbox.
    await screen.findByRole("textbox", { name: "Untitled document text" });
    expect(serializeDocumentState(activeTextboxView().state)).toBe("");
    await waitFor(() =>
      expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
        payload.tabs.some((tab: { path: string; recoveredFrom: string | null; unsavedContent: string | null }) =>
          tab.path === "untitled:1:empty.rs" &&
          tab.recoveredFrom === "empty.rs" &&
          tab.unsavedContent === "",
        ),
      )).toBe(true),
    );
  });

  it("D27 clears its recovery status after Save As adopts the retained buffer", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "draft.rs", unsavedContent: "retained work", recoveredFrom: null }],
      activePath: "draft.rs",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    pickSaveAsPathMock.mockReset().mockResolvedValue("/project/draft.md");

    render(<TabbedEditor request={request("/project", "draft.rs")} />);

    await screen.findByRole("tab", { name: /Untitled — recovered from draft\.rs, editable/ });
    expect(getAppStatus()?.authorMessage).toMatch(/retained text is editable in an untitled tab; use Save As/);
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "draft.md" })).toBeInTheDocument());
    expect(getAppStatus()).toBeNull();
  });

  it("D27 does not invent a recovered buffer from an omission-only legacy snapshot", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{
        path: "oversize.rs",
        unsavedContent: null,
        unsavedContentOmitted: true,
        recoveredFrom: null,
      }],
      activePath: "oversize.rs",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    const onError = vi.fn();

    const { container } = render(
      <TabbedEditor request={request("/project", "oversize.rs")} onError={onError} />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toBeInstanceOf(UserFacingError);
    expect(onError.mock.calls[0][0].message).toBe(
      "oversize.rs can’t open as an Emend document. Its unsaved work was over the session limit and wasn’t kept.",
    );
    expect(screen.getByRole("tab", { name: "oversize.rs — earlier unsaved work was not preserved" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /recovered from oversize\.rs/ })).toBeNull();
    expect(container.querySelector(".cm-content")).toBeNull();
    await waitFor(() =>
      expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
        payload.tabs.some((tab: { path: string; unsavedContent: string | null; unsavedContentOmitted?: boolean }) =>
          tab.path === "oversize.rs" &&
          tab.unsavedContent === null &&
          tab.unsavedContentOmitted === true,
        ),
      )).toBe(true),
    );
  });

  it("D27 retains an earlier omission fact beside the current recovered text", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{
        path: "oversize.rs",
        unsavedContent: "later retained work",
        unsavedContentOmitted: true,
        recoveredFrom: null,
      }],
      activePath: "oversize.rs",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });
    pickSaveAsPathMock.mockReset().mockResolvedValue("/project/recovered.md");

    render(<TabbedEditor request={request("/project", "oversize.rs")} />);

    const recovered = await screen.findByRole("tab", {
      name: /Untitled — recovered from oversize\.rs, editable/,
    });
    expect(recovered).toHaveAttribute("data-recovery-content-omitted", "true");
    await screen.findByRole("textbox", { name: "Untitled document text" });
    expect(serializeDocumentState(activeTextboxView().state)).toBe("later retained work");
    await waitFor(() =>
      expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
        payload.tabs.some((tab: { path: string; unsavedContent: string | null; unsavedContentOmitted?: boolean }) =>
          tab.path === "untitled:1:oversize.rs" &&
          tab.unsavedContent === "later retained work" &&
          tab.unsavedContentOmitted === true,
        ),
      )).toBe(true),
    );
    replaceActiveTextbox("");
    fireEvent.blur(screen.getByRole("textbox"));
    await waitFor(() => expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
      payload.tabs.some((tab: { path: string; unsavedContent: string | null; unsavedContentOmitted?: boolean }) =>
        tab.path === "untitled:1:oversize.rs" && tab.unsavedContent === "" &&
        tab.unsavedContentOmitted === true),
    )).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(prepareAdoptionMock).toHaveBeenCalled());
    expect(prepareAdoptionMock.mock.calls[0][5]).toBe(true);
  });

  it("D27 preserves a retained empty buffer even beside an earlier omission fact", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{
        path: "empty-after-omission.rs",
        unsavedContent: "",
        unsavedContentOmitted: true,
        recoveredFrom: null,
      }],
      activePath: "empty-after-omission.rs",
    });
    openDocumentMock.mockRejectedValue({ kind: "InvalidDocument", message: "Unsupported document type" });

    render(<TabbedEditor request={request("/project", "empty-after-omission.rs")} />);

    await screen.findByRole("tab", {
      name: /Untitled — recovered from empty-after-omission\.rs, editable/,
    });
    await screen.findByRole("textbox", { name: "Untitled document text" });
    expect(serializeDocumentState(activeTextboxView().state)).toBe("");
    const notice = screen.getByRole("region", {
      name: "Recovery notice, untitled document from empty-after-omission.rs",
    });
    expect(notice).not.toHaveTextContent("a moved document took that path");
    expect(notice).not.toHaveTextContent("a new, empty untitled document");
    await waitFor(() => expect(saveTabSessionMock.mock.calls.some(([, payload]) =>
      payload.tabs.some((tab: {
        path: string;
        unsavedContent: string | null;
        unsavedContentOmitted?: boolean;
      }) => tab.path === "untitled:1:empty-after-omission.rs" &&
        tab.unsavedContent === "" && tab.unsavedContentOmitted === true),
    )).toBe(true));
  });

  it("restoring an over-cap recovery document states plainly that its buffer was too large to preserve", async () => {
    // #1421: the per-tab session cap dropped this buffer before restore, and a recovery document has
    // no disk copy to fall back to — an unqualified empty pane would read as "there was nothing to
    // recover" rather than "the buffer existed and was lost".
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: null,
          recoveredFrom: "b.md",
          unsavedContentOmitted: true,
        },
      ],
      activePath: "untitled:1:b.md",
    });

    render(<TabbedEditor request={request("/project", "untitled:1:b.md")} />);

    const pane = await screen.findByRole("region", { name: /recovered from b\.md/ });
    expect(pane).toHaveTextContent(/larger than the 2 MiB Emend keeps per tab/);
    expect(pane).toHaveTextContent(/Emend can’t restore it/);
  });
});

describe("editor/TabbedEditor — dirty-close guard", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset();
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  async function renderWithADirtyTab() {
    let releaseOpen: ((payload: { content: string; revision: string }) => void) | undefined;
    openDocumentMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOpen = resolve)),
    );
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: "# a.md\n\nunsaved" }],
      activePath: "a.md",
    });
    const utils = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("data-dirty", "true"),
    );
    await waitFor(() => expect(releaseOpen).toBeTypeOf("function"));
    await waitFor(() => { // Dirty-close actions require the restored EditorShell handle.
      const release = releaseOpen;
      releaseOpen = undefined;
      release?.({ content: contentFor("a.md"), revision: "blake3:x" });
      expect(utils.container.querySelector(".cm-content")).toHaveTextContent("unsaved");
    });
    return utils;
  }

  it("closing a clean tab needs no guard", async () => {
    loadTabSessionMock.mockResolvedValueOnce({ tabs: [], activePath: null });
    render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    screen.getByRole("button", { name: "Close a.md" }).click();

    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("closing a dirty tab shows the guard", async () => {
    await renderWithADirtyTab();

    screen.getByRole("button", { name: "Close a.md" }).click();

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
  });

  it("Cancel leaves the dirty tab open and untouched", async () => {
    await renderWithADirtyTab();
    screen.getByRole("button", { name: "Close a.md" }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());

    screen.getByRole("button", { name: "Cancel" }).click();

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument();
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("Discard closes the tab without saving", async () => {
    await renderWithADirtyTab();
    screen.getByRole("button", { name: "Close a.md" }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());

    screen.getByRole("button", { name: "Discard" }).click();

    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("Save writes the tab's current content to disk and then closes it", async () => {
    await renderWithADirtyTab();
    screen.getByRole("button", { name: "Close a.md" }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());

    screen.getByRole("button", { name: "Save" }).click();

    await waitFor(() =>
      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "a.md",
        expect.stringContaining("unsaved"),
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
  });

  it("a failed Save keeps the tab and the guard open rather than discarding the edit", async () => {
    saveDocumentMock.mockReset().mockRejectedValueOnce(new Error("disk full"));
    await renderWithADirtyTab();
    screen.getByRole("button", { name: "Close a.md" }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());

    screen.getByRole("button", { name: "Save" }).click();

    await waitFor(() => expect(saveDocumentMock).toHaveBeenCalled());
    // The write failed — the tab must still be open (the edit is not lost) and the guard still
    // showing, not silently closed on top of the error.
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("Save returns from the dirty-close guard to an unresolved external-change choice without writing", async () => {
    let disk = "Original disk bytes";
    openDocumentMock.mockImplementation(async () => ({ content: disk, revision: "r1" }));
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: "Original disk bytesX" }],
      activePath: "a.md",
    });
    render(
      <TabbedEditor
        request={request("/project", "a.md")}
        externalChangePollMs={10}
      />,
    );
    const tab = await screen.findByRole("tab", { name: /a\.md/ });
    await waitFor(() => expect(tab).toHaveAttribute("data-dirty", "true"));

    disk = "A concurrent creator's bytes";
    await waitFor(() =>
      expect(screen.getByText("This file changed outside the editor")).toBeInTheDocument(),
    );
    screen.getByRole("button", { name: "Close a.md" }).click();
    const guard = await screen.findByRole("alertdialog");

    within(guard).getByRole("button", { name: "Save" }).click();

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("data-dirty", "true");
    expect(saveDocumentMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Keep mine" })).toHaveFocus(),
    );
  });
});

// P2b-6b: `App`'s workshop/authoring layout state needs to know when the tab set becomes/stops
// being empty — the only source that can flip the layout back to workshop after "close the last
// tab", a fact `App` has no other way to observe (no in-app affordance touches `tabs` directly).
describe("editor/TabbedEditor — onTabsChange (P2b-6b)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("reports true once the requested tab opens", async () => {
    const onTabsChange = vi.fn();
    render(<TabbedEditor request={request("/project", "a.md")} onTabsChange={onTabsChange} />);

    await waitFor(() => expect(onTabsChange).toHaveBeenCalledWith(true));
  });

  it("reports false again once the only open tab closes", async () => {
    const onTabsChange = vi.fn();
    render(<TabbedEditor request={request("/project", "a.md")} onTabsChange={onTabsChange} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    onTabsChange.mockClear();

    screen.getByRole("button", { name: "Close a.md" }).click();

    await waitFor(() => expect(onTabsChange).toHaveBeenCalledWith(false));
  });

  it("does not report false while a second tab is still open", async () => {
    const onTabsChange = vi.fn();
    const { rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} onTabsChange={onTabsChange} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    rerender(<TabbedEditor request={request("/project", "b.md")} onTabsChange={onTabsChange} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    onTabsChange.mockClear();

    screen.getByRole("button", { name: "Close b.md" }).click();

    await waitFor(() => expect(onTabsChange).toHaveBeenCalledWith(true));
  });
});

// #411: `App`'s single-owner comment-thread state is keyed on the active document path — this is
// the only source that reports it, since a `request` alone under-reports (switching to an
// already-open tab via the tab bar never mints a fresh `request`).
describe("editor/TabbedEditor — onActivePathChange (#411)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("reports the requested path once it opens as the active tab", async () => {
    const onActivePathChange = vi.fn();
    render(
      <TabbedEditor request={request("/project", "a.md")} onActivePathChange={onActivePathChange} />,
    );

    await waitFor(() => expect(onActivePathChange).toHaveBeenCalledWith("a.md"));
  });

  it("reports the newly focused path when the tab bar switches to an already-open tab", async () => {
    const onActivePathChange = vi.fn();
    const { rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} onActivePathChange={onActivePathChange} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    // Opens b.md as a second tab (focusing it) — a fresh `request`, same as any other open.
    rerender(<TabbedEditor request={request("/project", "b.md")} onActivePathChange={onActivePathChange} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    onActivePathChange.mockClear();

    // Switching back to a.md via the tab bar mints no new `request` at all — this callback is the
    // only thing that can tell `App` the active document changed.
    screen.getByRole("tab", { name: /a\.md/ }).click();

    await waitFor(() => expect(onActivePathChange).toHaveBeenCalledWith("a.md"));
  });

  it("reports null once the last open tab closes", async () => {
    const onActivePathChange = vi.fn();
    render(
      <TabbedEditor request={request("/project", "a.md")} onActivePathChange={onActivePathChange} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    onActivePathChange.mockClear();

    screen.getByRole("button", { name: "Close a.md" }).click();

    await waitFor(() => expect(onActivePathChange).toHaveBeenCalledWith(null));
  });
});

describe("editor/TabbedEditor — active save-state projection (#2109)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: `blake3:${path}` }),
    );
  });

  it("selects each active tab's cached save state instead of leaking the background tab's time", async () => {
    const onActiveSaveStateChange = vi.fn();
    const now = vi.fn().mockReturnValueOnce(111).mockReturnValueOnce(222);
    const { rerender } = render(
      <TabbedEditor
        request={request("/project", "a.md")}
        onActiveSaveStateChange={onActiveSaveStateChange}
        commentNow={now}
      />,
    );
    await waitFor(() =>
      expect(onActiveSaveStateChange).toHaveBeenLastCalledWith({ kind: "saved", at: 111 }),
    );

    rerender(
      <TabbedEditor
        request={request("/project", "b.md")}
        onActiveSaveStateChange={onActiveSaveStateChange}
        commentNow={now}
      />,
    );
    await waitFor(() =>
      expect(onActiveSaveStateChange).toHaveBeenLastCalledWith({ kind: "saved", at: 222 }),
    );

    fireEvent.click(screen.getByRole("tab", { name: /a\.md/ }));
    await waitFor(() =>
      expect(onActiveSaveStateChange).toHaveBeenLastCalledWith({ kind: "saved", at: 111 }),
    );
  });
});

describe("editor/TabbedEditor — confirmed active path (#931)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("removes a failed optimistic tab and never confirms it over the loaded document", async () => {
    const onConfirmedActivePathChange = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(
      <TabbedEditor
        request={request("/project", "a.md")}
        externalChangePollMs={60_000}
        onConfirmedActivePathChange={onConfirmedActivePathChange}
        onError={onError}
      />,
    );
    await waitFor(() => expect(onConfirmedActivePathChange).toHaveBeenCalledWith("a.md"));

    openDocumentMock.mockRejectedValueOnce(new Error("file disappeared"));
    rerender(
      <TabbedEditor
        request={request("/project", "missing.md")}
        externalChangePollMs={60_000}
        onConfirmedActivePathChange={onConfirmedActivePathChange}
        onError={onError}
      />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /missing\.md/ })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(onConfirmedActivePathChange).not.toHaveBeenCalledWith("missing.md");
    expect(onConfirmedActivePathChange).toHaveBeenLastCalledWith("a.md");
  });
});

describe("editor/TabbedEditor — ref.decideChanges() routes to the active tab (#410)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
  });

  it("decides against the active tab's document and returns the full id set decided", async () => {
    const content = "Hello {++brave ++}world\n";
    openDocumentMock.mockResolvedValueOnce({ content, revision: "blake3:x" });
    parseChangesMock.mockResolvedValueOnce([
      { id: "7", recorded: false, group: null, full: { from: 6, to: 18 }, kind: "insertion", text: { from: 9, to: 15 } },
    ] satisfies ParsedChange[]);
    const ref = createRef<TabbedEditorHandle>();

    const { container } = render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());

    expect(ref.current?.decideChanges(["7"], "accept")).toEqual(["7"]);
    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveTextContent("Hello brave world");
    });
  });

  it("returns null when there is no active tab", () => {
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    // No `await` on the open — assert against the window before any tab has actually opened.
    expect(ref.current?.decideChanges(["1"], "accept")).toBeNull();
  });

  it("a background tab's decisions do not reach onChangesDecided — only the active tab's do", async () => {
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    const onChangesDecided = vi.fn();
    const { rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} onChangesDecided={onChangesDecided} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    rerender(
      <TabbedEditor request={request("/project", "b.md")} onChangesDecided={onChangesDecided} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    // a.md is now the backgrounded tab; nothing decided anything, but this pins that its
    // `EditorShell` was mounted with no `onChangesDecided` at all (see the `undefined` prop wiring)
    // rather than merely "happened not to fire yet".
    expect(onChangesDecided).not.toHaveBeenCalled();
  });
});

describe("editor/TabbedEditor — routing an agent delivery to the right tab (#346)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    parseChangesMock.mockReset().mockResolvedValue([]);
  });

  /** A delivery target carrying its own parse, the way the app shell assembles one. */
  const delivery = (doc: string, content: string) => {
    const from = content.indexOf("{++");
    const to = content.indexOf("++}") + 3;
    return {
      doc,
      content,
      changeSetId: `cs-${doc}`,
      generation: `rev-${doc}`,
      changes: [
        { id: "chg-0", recorded: true, group: null, full: { from, to }, kind: "insertion" as const, text: { from: from + 3, to: to - 3 } },
      ],
    };
  };

  it("lands the delivery in the tab naming the delivered document", async () => {
    const { rerender, container } = render(
      <TabbedEditor request={request("/project", "a.md")} />,
    );
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));

    rerender(
      <TabbedEditor
        request={request("/project", "a.md")}
        delivery={delivery("a.md", "# a.md {++delivered++}\n")}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("delivered"),
    );
  });

  it("ignores a delivery for a document this project has no tab open on", async () => {
    // A delivery to an unopened doc is not an error — the change set is on disk and attributed;
    // there is simply no buffer to reseed. The card still lands (that is the panel's job).
    const { rerender, container } = render(
      <TabbedEditor request={request("/project", "a.md")} />,
    );
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));

    rerender(
      <TabbedEditor
        request={request("/project", "a.md")}
        delivery={delivery("elsewhere.md", "# elsewhere {++x++}\n")}
      />,
    );

    // A delivery the open tab *does* accept is the barrier (test-plan §7: no sleeps). Deliveries
    // are routed in the order they arrive, so once this one is visible the unaddressed one has
    // already been passed over — the absence below is a real absence, not an early wait.
    rerender(
      <TabbedEditor
        request={request("/project", "a.md")}
        delivery={delivery("a.md", "# a.md {++addressed++}\n")}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("addressed"),
    );

    expect(container.querySelector(".cm-content")).not.toHaveTextContent("elsewhere");
  });

  it("applies each distinct delivery exactly once even across unrelated re-renders", async () => {
    // Two tabs: a.md receives the deliveries, b.md only ever receives the barrier.
    const { rerender, container } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    const req = request("/project", "b.md");

    const first = delivery("a.md", "# a.md {++once++}\n");
    rerender(<TabbedEditor request={req} delivery={first} />);
    await waitFor(() => expect(container.textContent).toContain("once"));

    // A later set supersedes it, so a re-application of `first` is *visible* — reverting the buffer
    // to the older text. (Re-applying the newest set is undetectable in the text: a delivery
    // replaces the whole doc, so it is idempotent. This ordering is what gives the test teeth.)
    const second = { ...delivery("a.md", "# a.md {++twice++}\n"), changeSetId: "cs-second" };
    rerender(<TabbedEditor request={req} delivery={second} />);
    await waitFor(() => expect(container.textContent).toContain("twice"));

    // A re-render carrying an already-applied delivery (even rebuilt as a fresh object) must not
    // re-apply it: the handle reseeds the whole tracked-change snapshot, so a second application
    // would silently undo triage decisions the user had already made against this set.
    rerender(<TabbedEditor request={req} delivery={{ ...first }} />);

    // The barrier is a delivery to the *other* tab (test-plan §7: no sleeps). It proves routing has
    // moved past the duplicate without overwriting a.md's buffer — which is the buffer under test,
    // and which a same-tab barrier would clobber, masking exactly the regression this test exists
    // to catch.
    rerender(
      <TabbedEditor request={req} delivery={delivery("b.md", "# b.md {++barrier++}\n")} />,
    );
    await waitFor(() => expect(container.textContent).toContain("barrier"));

    // a.md still holds the newest set, not the re-applied older one.
    expect(container.textContent).toContain("twice");
    expect(container.textContent).not.toContain("once");
  });

  it("delivers to a background tab without switching away from the active one", async () => {
    // UX Principle 2: a delivery to a doc the user is not looking at must not yank them to it.
    const { rerender, container } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    rerender(<TabbedEditor request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    rerender(
      <TabbedEditor
        request={request("/project", "b.md")}
        delivery={delivery("a.md", "# a.md {++background++}\n")}
      />,
    );
    // It landed — in a.md's pane, which is the hidden one.
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".cm-content")].some((el) =>
          el.textContent?.includes("background"),
        ),
      ).toBe(true),
    );

    expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("aria-selected", "true");
  });
});

// #411 review round 3 (PR #498 @ 3442e9e1): the rebase that brought in #495's editor-anchored
// comment popover left it unreconciled with this card's single owner — `EditorShell` already
// accepts `commentThreads`/`onCommentThreadsChanged` (#495) but nothing forwarded either through
// this layer, so a comment created from the editor never reached `App`'s state and an owner-loaded
// thread never highlighted in the editor. These pin the fix, scoped exactly like `onChangesDecided`
// above: the active tab only.
describe("editor/TabbedEditor — comment-thread wiring to the active tab (#411)", () => {
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
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    createCommentMock.mockReset();
    capturedOnSelectionChange = null;
  });

  it("supplies commentThreads only to the active tab's editor — a tab that was never active never highlights it", async () => {
    openDocumentMock.mockImplementation((_root: string, _path: string) =>
      Promise.resolve({ content: "hello world\n", revision: "r0" }),
    );
    const { rerender, container } = render(
      <TabbedEditor request={request("/project", "a.md")} commentThreads={[]} />,
    );
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));

    // b.md opens and becomes active, its own comment threads not yet loaded (mirrors `App`'s own
    // synchronous clear-before-load, #498 round-1) — settle on b.md as the active pane *before* the
    // thread arrives, exactly as `App`'s async `loadCommentThreads` always lags its own
    // `activeDocumentPath` update in the real app.
    const bReq = request("/project", "b.md");
    rerender(<TabbedEditor request={bReq} commentThreads={[]} />);
    await waitFor(() => {
      const visible = [...container.querySelectorAll(".tabbed-editor__pane")].find(
        (el) => (el as HTMLElement).style.display !== "none",
      );
      expect(visible?.querySelector(".cm-content")).toHaveTextContent("hello world");
    });

    // Now the owner's load resolves, carrying the thread — b.md is already the settled active tab.
    rerender(<TabbedEditor request={bReq} commentThreads={[THREAD]} />);

    await waitFor(() => {
      const visible = [...container.querySelectorAll(".tabbed-editor__pane")].find(
        (el) => (el as HTMLElement).style.display !== "none",
      );
      expect(visible?.querySelector(".cm-commentHighlight")).toBeTruthy();
    });
    const hidden = [...container.querySelectorAll(".tabbed-editor__pane")].find(
      (el) => (el as HTMLElement).style.display === "none",
    );
    expect(hidden?.querySelector(".cm-commentHighlight")).toBeNull();
  });

  it("bubbles a comment created through the active tab's editor-anchored popover via onCommentThreadsChanged", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "hello world\n", revision: "r0" });
    createCommentMock.mockResolvedValueOnce([THREAD]);
    const onCommentThreadsChanged = vi.fn();
    render(
      <TabbedEditor
        request={request("/project", "a.md")}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 6, length: 5, text: "world" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "please clarify" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith(
      "/project",
      "a.md",
      "you",
      "please clarify",
      { content: "hello world\n", utf16Offset: 6, utf16Length: 5 },
      expect.any(Number),
    );
    await waitFor(() => expect(onCommentThreadsChanged).toHaveBeenCalledWith([THREAD]));
  });

  it("a background tab's editor never reports through onCommentThreadsChanged — only the active tab's does", async () => {
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    const onCommentThreadsChanged = vi.fn();
    const { rerender } = render(
      <TabbedEditor
        request={request("/project", "a.md")}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    rerender(
      <TabbedEditor
        request={request("/project", "b.md")}
        onCommentThreadsChanged={onCommentThreadsChanged}
      />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    // a.md is now backgrounded; nothing was mutated, but this pins that its `EditorShell` was
    // mounted with no `onCommentThreadsChanged` at all (mirrors the identical `onChangesDecided`
    // scoping test above), not merely "happened not to fire yet".
    expect(onCommentThreadsChanged).not.toHaveBeenCalled();
  });
});

// Shared by both #492 suites below — the anchor a "world" selection in "hello world\n" captures.
const QUOTE_ANCHOR: Anchor = {
  offset: 6,
  length: 5,
  text_snapshot: "world",
  context_before: "hello ",
  context_after: "\n",
  base_revision: "r0",
};

// P2b-7 follow-up (#492): #446 built `EditorShell.onQuoteSelection`/`QuoteAffordance` and
// `TimelinePanel.incomingQuote`, but nothing forwarded a captured quote through this tab layer —
// scoped exactly like `onChangesDecided`/`commentThreads` above: the active tab only, since a
// background tab's own selection can never surface an affordance to click in the first place.
describe("editor/TabbedEditor — quote-selection wiring to the active tab (#492)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    captureAnchorMock.mockReset();
    capturedOnSelectionChange = null;
  });

  it("forwards a captured quote from the active tab's editor to onQuoteSelection", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "hello world\n", revision: "r0" });
    captureAnchorMock.mockResolvedValueOnce(QUOTE_ANCHOR);
    const onQuoteSelection = vi.fn();
    render(<TabbedEditor request={request("/project", "a.md")} onQuoteSelection={onQuoteSelection} />);
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 6, length: 5, text: "world" }));
    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    expect(captureAnchorMock).toHaveBeenCalledWith("hello world\n", 6, 5);
    await waitFor(() =>
      expect(onQuoteSelection).toHaveBeenCalledWith({
        documentPath: "a.md",
        text: "world",
        anchor: QUOTE_ANCHOR,
      }),
    );
  });

  it("withdraws the quote affordance the moment a tab stops being active — even with a live selection", async () => {
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    const onQuoteSelection = vi.fn();
    const { rerender, container } = render(
      <TabbedEditor request={request("/project", "a.md")} onQuoteSelection={onQuoteSelection} />,
    );
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());
    act(() => capturedOnSelectionChange?.({ offset: 0, length: 1, text: "#" }));
    expect(screen.getByRole("button", { name: "Quote to chat" })).toBeInTheDocument();

    rerender(
      <TabbedEditor request={request("/project", "b.md")} onQuoteSelection={onQuoteSelection} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    // a.md's `EditorShell` still holds its own live selection state (nothing reset it) — the
    // affordance is gone because this layer stopped supplying it `onQuoteSelection`, not because
    // the selection itself disappeared.
    expect(container.querySelector(".quote-affordance")).toBeNull();
  });

  it("a background tab's selection never reaches onQuoteSelection — only the active tab's does", async () => {
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    const onQuoteSelection = vi.fn();
    const { rerender } = render(
      <TabbedEditor request={request("/project", "a.md")} onQuoteSelection={onQuoteSelection} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    rerender(
      <TabbedEditor request={request("/project", "b.md")} onQuoteSelection={onQuoteSelection} />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());

    expect(onQuoteSelection).not.toHaveBeenCalled();
  });

  // #2304 item 4 (D33/J12 Phase E, unblocked by #2342's shared `DocumentSurface`): the untitled
  // pane now mounts the same selection popover a project document's editor does, so a quote taken
  // there must resolve through `quotedExcerptFor`'s pathless arm, not the path-bearing one above.
  it("forwards a captured quote from the active untitled pane as D33's pathless form", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "untitled:1:b.md", unsavedContent: "hello world\n", recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    });
    captureAnchorMock.mockResolvedValueOnce(QUOTE_ANCHOR);
    const onQuoteSelection = vi.fn();
    render(
      <TabbedEditor
        request={request("/project", "untitled:1:b.md")}
        onQuoteSelection={onQuoteSelection}
      />,
    );
    await waitFor(() => expect(capturedOnSelectionChange).not.toBeNull());

    act(() => capturedOnSelectionChange?.({ offset: 6, length: 5, text: "world" }));
    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    expect(captureAnchorMock).toHaveBeenCalledWith("hello world\n", 6, 5);
    await waitFor(() =>
      expect(onQuoteSelection).toHaveBeenCalledWith({
        documentPath: null,
        label: "Untitled — recovered from b.md",
        text: "world",
        anchor: QUOTE_ANCHOR,
      }),
    );
  });
});

// #2304 (D33): `quotedExcerptFor` resolves a captured quote's identity — the path-bearing form for
// an ordinary project document, `document_path: null` plus a `label` for a document with no file.
// Unit-tested directly here (in addition to the render-level coverage below, which now exercises the
// pathless branch through `UntitledDocument`'s own quote affordance, #2304 item 4/#2342).
describe("editor/TabbedEditor — quotedExcerptFor resolves a quote's D33 identity (#2304)", () => {
  it("names an ordinary project document by its path, carrying no label", () => {
    const tab = { path: "a.md", dirty: false };
    expect(quotedExcerptFor(tab, { text: "world", anchor: QUOTE_ANCHOR }, [tab])).toEqual({
      documentPath: "a.md",
      text: "world",
      anchor: QUOTE_ANCHOR,
    });
  });

  it("names a document with no file as document_path: null plus its tab-strip label", () => {
    const tab = {
      path: "untitled:1:notes.md",
      dirty: false,
      recoveredFrom: "notes.md",
    };
    expect(quotedExcerptFor(tab, { text: "world", anchor: QUOTE_ANCHOR }, [tab])).toEqual({
      documentPath: null,
      label: "Untitled — recovered from notes.md",
      text: "world",
      anchor: QUOTE_ANCHOR,
    });
  });

  it("never sends the internal untitled:<n>: identity as document_path", () => {
    const tab = { path: "untitled:1:notes.md", dirty: false, recoveredFrom: "notes.md" };
    const quote = quotedExcerptFor(tab, { text: "world", anchor: QUOTE_ANCHOR }, [tab]);
    expect(quote.documentPath).toBeNull();
  });

  it("disambiguates two documents displaced from the same path, forwarding openTabs to tabLabel", () => {
    const first = {
      path: "untitled:1:b.md",
      dirty: false,
      recoveredFrom: "b.md",
      displacedLabelOrdinal: 1,
    };
    const second = {
      path: "untitled:2:b.md",
      dirty: false,
      recoveredFrom: "b.md",
      displacedLabelOrdinal: 2,
    };
    expect(
      quotedExcerptFor(second, { text: "world", anchor: QUOTE_ANCHOR }, [first, second]),
    ).toEqual({
      documentPath: null,
      label: "Untitled — recovered from b.md (2)",
      text: "world",
      anchor: QUOTE_ANCHOR,
    });
  });
});

describe("editor/TabbedEditor — ref.focusAnchor() routes to the active tab (P2b-7 follow-up, #492)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    resolveAnchorMock.mockReset();
  });

  it("resolves false when there is no active tab", async () => {
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    // No `await` on the open — assert against the window before any tab has actually opened.

    await expect(ref.current!.focusAnchor(QUOTE_ANCHOR)).resolves.toBe(false);
    expect(resolveAnchorMock).not.toHaveBeenCalled();
  });

  it("delegates to the active tab's editor and resolves what it resolves", async () => {
    let finishOpen!: (document: { content: string; revision: string }) => void;
    openDocumentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    resolveAnchorMock.mockResolvedValue({ from: 6, to: 11 });
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    await waitFor(() => expect(finishOpen).toBeTypeOf("function"));

    await act(async () => finishOpen({ content: "hello world\n", revision: "r0" }));
    await waitFor(() => expect(ref.current!.focusAnchor(QUOTE_ANCHOR)).resolves.toBe(true));
    expect(resolveAnchorMock).toHaveBeenCalledWith("hello world\n", QUOTE_ANCHOR);
  });

  it("never routes to a background tab — only the active tab's editor is asked to focus", async () => {
    let finishOpenB!: (document: { content: string; revision: string }) => void;
    openDocumentMock.mockImplementation((_root: string, path: string) => {
      if (path === "b.md") {
        return new Promise((resolve) => {
          finishOpenB = resolve;
        });
      }
      return Promise.resolve({ content: contentFor(path), revision: "blake3:x" });
    });
    resolveAnchorMock.mockResolvedValue(null);
    const ref = createRef<TabbedEditorHandle>();
    const { rerender } = render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());

    rerender(<TabbedEditor ref={ref} request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument());
    await waitFor(() => expect(finishOpenB).toBeTypeOf("function"));

    // Whatever content resolveAnchor was asked to resolve against, it must be b.md's own —
    // a.md is now the backgrounded tab and this handle only ever reaches the active one.
    await act(async () =>
      finishOpenB({ content: contentFor("b.md"), revision: "blake3:x" }),
    );
    await waitFor(async () => {
      await ref.current!.focusAnchor(QUOTE_ANCHOR);
      expect(resolveAnchorMock).toHaveBeenCalledWith(contentFor("b.md"), QUOTE_ANCHOR);
    });
  });
});

describe("editor/TabbedEditor — reciprocal comment reveal (#2537)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset().mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }));
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    resolveAnchorMock.mockReset();
  });

  it("does not complete a withdrawn passage reveal after switching A→B→A", async () => {
    let finishResolve!: (range: { from: number; to: number }) => void;
    resolveAnchorMock.mockImplementationOnce(() => new Promise((resolve) => { finishResolve = resolve; }));
    const ref = createRef<TabbedEditorHandle>();
    const { rerender } = render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument());
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    const withdrawn = thread("withdrawn-a", { anchor: QUOTE_ANCHOR, withdrawn_at: 1 });
    const pending = ref.current!.revealCommentThread(withdrawn);
    await waitFor(() => expect(finishResolve).toBeTypeOf("function"));

    rerender(<TabbedEditor ref={ref} request={request("/project", "b.md")} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: /a\.md/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("aria-selected", "true"));
    await act(async () => finishResolve({ from: 6, to: 11 }));
    await expect(pending).resolves.toBe(false);
  });

  it("keeps a newer live comment selected when an older withdrawn lookup finishes", async () => {
    openDocumentMock.mockResolvedValue({ content: "hello world\n", revision: "r0" });
    let finishResolve!: (range: { from: number; to: number }) => void;
    resolveAnchorMock.mockImplementationOnce(() => new Promise((resolve) => { finishResolve = resolve; }));
    const withdrawn = thread("withdrawn-a", { anchor: QUOTE_ANCHOR, withdrawn_at: 1 });
    const live = thread("live-a", { anchor: { ...QUOTE_ANCHOR, offset: 0, length: 5,
      text_snapshot: "hello", context_before: "", context_after: " world" } });
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "a.md")}
      commentThreads={[withdrawn, live]} />);
    await waitFor(() => expect(document.querySelector(".cm-commentHighlight")).toBeInTheDocument());
    const pending = ref.current!.revealCommentThread(withdrawn);
    await waitFor(() => expect(finishResolve).toBeTypeOf("function"));

    await expect(ref.current!.revealCommentThread(live)).resolves.toBe(true);
    expect(document.querySelector(".cm-commentHighlight-selected")?.textContent).toBe("hello");
    await act(async () => finishResolve({ from: 6, to: 11 }));
    await expect(pending).resolves.toBe(false);
    expect(document.querySelector(".cm-commentHighlight-selected")?.textContent).toBe("hello");
  });
});

/**
 * TD-18's confidently correlated external path transitions reaching the open-tab set (#932). The
 * rail owns the tree and funnels each newly applied generation's moves here; this layer owns what a
 * move means for document *identity* — the tab, its buffer, and the active marker.
 */
describe("editor/TabbedEditor — external path transitions", () => {
  const move = (
    oldPath: string,
    newPath: string,
    kind: "file" | "directory" = "file",
  ) => ({ old_path: oldPath, new_path: newPath, kind });

  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue(undefined);
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  it("D27 restored clean eligibility cannot discard later edits after a move to an unsupported path", async () => {
    loadTabSessionMock.mockResolvedValue({
      tabs: [{ path: "drafts/a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "drafts/a.md",
    });
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      path === "archive/a.html"
        ? Promise.reject({
            kind: "InvalidDocument",
            message: "Emend supports only Markdown and plain-text documents",
          })
        : Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
    const onError = vi.fn();
    const ref = createRef<TabbedEditorHandle>();
    const { container } = render(
      <TabbedEditor ref={ref} request={request("/project", "drafts/a.md")} onError={onError} />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).toHaveTextContent("# drafts/a.md"));

    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    act(() => view?.dispatch({ changes: { from: 0, insert: "unsaved work\n" } }));
    const unsaved = "unsaved work\n# drafts/a.md\n";
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "drafts/a.md" })).toHaveAttribute("data-dirty", "true"),
    );

    act(() => ref.current?.applyCompletedGeneration(
      generation(["archive/a.html"], [move("drafts/a.md", "archive/a.html")]),
    ));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "InvalidDocument" }),
    ));
    expect(screen.getByRole("tab", { name: "archive/a.html" })).toHaveAttribute("data-dirty", "true");
    await waitFor(() =>
      expect(saveTabSessionMock.mock.lastCall?.[1].tabs).toContainEqual(
        expect.objectContaining({ path: "archive/a.html", unsavedContent: unsaved }),
      ),
    );
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === "archive/a.html")).toBe(false);
  });

  it("carries a moved document's tab, unsaved buffer, and active marker to its new path", async () => {
    // A tab opened fresh this session and edited in the editor — deliberately *not* a restored
    // dirty tab. `restoredContent` only ever holds a session-restore override, so for this tab it
    // holds nothing at all: the only place the in-flight edit exists is the live CM6 buffer, which
    // is exactly the copy a rename must not drop. A restored-tab fixture would carry the text
    // through the restore map and pass no matter what the rekey did with the live editor.
    const ref = createRef<TabbedEditorHandle>();
    const onConfirmedActivePathChange = vi.fn();
    const { container } = render(
      <TabbedEditor
        ref={ref}
        request={request("/project", "drafts/a.md")}
        onConfirmedActivePathChange={onConfirmedActivePathChange}
      />,
    );
    await waitFor(() =>
      expect(onConfirmedActivePathChange).toHaveBeenLastCalledWith("drafts/a.md"),
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    act(() => {
      view?.dispatch({ changes: { from: 0, insert: "an in-flight edit\n" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /drafts\/a\.md/ })).toHaveAttribute(
        "data-dirty",
        "true",
      ),
    );
    const confirmedBeforeMove = onConfirmedActivePathChange.mock.calls.length;

    act(() => {
      ref.current?.applyCompletedGeneration(
        generation(["archive/a.md"], [move("drafts/a.md", "archive/a.md")]),
      );
    });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /archive\/a\.md/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("tab", { name: /drafts\/a\.md/ })).not.toBeInTheDocument();
    // The document moved, not the work: the buffer follows it and stays unsaved against the new
    // path, rather than being re-read from disk (which would silently discard the edit).
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("an in-flight edit"),
    );
    expect(screen.getByRole("tab", { name: /archive\/a\.md/ })).toHaveAttribute(
      "data-dirty",
      "true",
    );
    // The rail's active marker follows without a trip through "nothing is active" or back through
    // the old path — the document never stopped being loaded, only its path changed.
    const confirmedAfterMove = onConfirmedActivePathChange.mock.calls
      .slice(confirmedBeforeMove)
      .map((call) => call[0] as string | null);
    expect(confirmedAfterMove.length).toBeGreaterThan(0);
    expect([...new Set(confirmedAfterMove)]).toEqual(["archive/a.md"]);
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith(
        "/project",
        ["archive/a.md"],
        "archive/a.md",
      ),
    );
  });

  it("J2 moved dirty tab retires old-path autosave before unmount", async () => {
    const ref = createRef<TabbedEditorHandle>();
    const { container } = render(
      <TabbedEditor
        ref={ref}
        request={request("/project", "drafts/a.md")}
        autosaveIntervalMs={60_000}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("# drafts/a.md"),
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    act(() => view?.dispatch({ changes: { from: 0, insert: "unsaved move\n" } }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /drafts\/a\.md/ })).toHaveAttribute("data-dirty", "true"),
    );
    expect(saveDocumentMock).not.toHaveBeenCalled();

    act(() => ref.current?.applyCompletedGeneration(
      generation(["archive/a.md"], [move("drafts/a.md", "archive/a.md")]),
    ));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /archive\/a\.md/ })).toHaveAttribute(
        "data-dirty",
        "true",
      ),
    );
    // The moved tab is a fresh pane (its key follows the path), and `EditorShell` mounts its view
    // only after its async `openDocument` read resolves, so the carried buffer appears a tick
    // after the tab label changes.
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved move"),
    );
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === "drafts/a.md")).toBe(false);

    screen.getByRole("button", { name: "Close archive/a.md" }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    screen.getByRole("button", { name: "Save" }).click();
    await waitFor(() =>
      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        "archive/a.md",
        "unsaved move\n# drafts/a.md\n",
        true,
      ),
    );
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === "drafts/a.md")).toBe(false);
  });

  it("carries a restored buffer whose editor has not hydrated yet", async () => {
    // The other half of the buffer carry: a restored dirty tab whose `openDocument` has not landed
    // has no view to read, so `getContent()` is `undefined` and the restore override is the only
    // copy of that text in the app. Losing it here would discard the buffer the dirty-close guard
    // exists to protect.
    const unsavedContent = "# drafts/a.md\n\nrestored but not yet hydrated";
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "drafts/a.md", unsavedContent }],
      activePath: "drafts/a.md",
    });
    openDocumentMock.mockImplementationOnce(() => new Promise(() => {}));
    const ref = createRef<TabbedEditorHandle>();
    const { container } = render(
      <TabbedEditor ref={ref} request={request("/project", "drafts/a.md")} />,
    );
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "drafts/a.md"));
    expect(container.querySelector(".cm-content")).toBeNull();

    act(() => {
      ref.current?.applyCompletedGeneration(
        generation(["archive/a.md"], [move("drafts/a.md", "archive/a.md")]),
      );
    });

    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent(
        "restored but not yet hydrated",
      ),
    );
    expect(screen.getByRole("tab", { name: /archive\/a\.md/ })).toHaveAttribute(
      "data-dirty",
      "true",
    );
  });

  it("leaves a tab whose own move was never proven on its old path", async () => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [
        { path: "drafts/proven.md", unsavedContent: null },
        { path: "drafts/ambiguous.md", unsavedContent: null },
      ],
      activePath: "drafts/ambiguous.md",
    });
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "drafts/ambiguous.md")} />);
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith(
        "/project",
        ["drafts/proven.md", "drafts/ambiguous.md"],
        "drafts/ambiguous.md",
      ),
    );

    // The directory's move plus the one descendant TD-18 could independently prove. The ambiguous
    // descendant has no move of its own, so its identity was never established — repointing its
    // buffer at `archive/ambiguous.md` would be a guess about which file it is.
    act(() => {
      ref.current?.applyCompletedGeneration(
        // The ambiguous descendant is present at its *new* path, which the backend could not prove
        // is the same document — so its open tab, still on the old path, is genuinely missing.
        generation(["archive/proven.md", "archive/ambiguous.md"], [
          move("drafts", "archive", "directory"),
          move("drafts/proven.md", "archive/proven.md"),
        ]),
      );
    });

    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith(
        "/project",
        ["archive/proven.md", "drafts/ambiguous.md"],
        "drafts/ambiguous.md",
      ),
    );
    expect(openDocumentMock).not.toHaveBeenCalledWith("/project", "archive/ambiguous.md");
    expect(screen.getByRole("tab", { name: /drafts\/ambiguous\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // A move whose destination is another *open* document's path — `mv a.md b.md` with both open, the
  // case TD-18 proves confidently (the moved file keeps its inode at the destination). CJ's ruling
  // (2026-08-11, J2): the moved document becomes the sole document at that path, and the displaced
  // document's unsaved work is preserved rather than discarded or written to the destination.
  describe("a move onto an open document's own path", () => {
    // Two tabs, the second edited in its real CM6 view, then the second is moved onto the first's
    // path. Returns the container so each case can read what is actually rendered.
    const displaceOnMove = async (options: { editMovedTab: boolean }) => {
      loadTabSessionMock.mockResolvedValueOnce({
        tabs: [
          { path: "b.md", unsavedContent: null },
          { path: "a.md", unsavedContent: null },
        ],
        activePath: "a.md",
      });
      const ref = createRef<TabbedEditorHandle>();
      const rendered = render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
      await waitFor(() =>
        expect(setOpenTabsMock).toHaveBeenLastCalledWith(
          "/project",
          ["b.md", "a.md"],
          "a.md",
        ),
      );
      await waitFor(() => expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(2));
      if (options.editMovedTab) {
        const panes = rendered.container.querySelectorAll<HTMLElement>(".cm-editor");
        const moved = EditorView.findFromDOM(panes[1]);
        act(() => {
          moved?.dispatch({ changes: { from: 0, insert: "UNSAVED-WORK-IN-A\n" } });
        });
        await waitFor(() =>
          expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("data-dirty", "true"),
        );
      }
      act(() => {
        ref.current?.applyCompletedGeneration(generation(["b.md"], [move("a.md", "b.md")]));
      });
      return { ...rendered, ref };
    };

    it("remounts the destination on the moved document, carrying its unsaved buffer", async () => {
      // React keys a pane by path, so without evicting the destination's own editor state the
      // displaced document's mounted `EditorShell` is simply reused under the moved document's
      // identity: its text stays on screen, the carried buffer is never read, and a save writes the
      // wrong document's content to `b.md`.
      const { container } = await displaceOnMove({ editMovedTab: true });

      await waitFor(() =>
        expect(container.querySelector(".cm-content")).toHaveTextContent("UNSAVED-WORK-IN-A"),
      );
      expect(container.querySelector(".cm-content")).not.toHaveTextContent("# b.md");
      expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("data-dirty", "true");
    });

    it("keeps a displaced document's unsaved work as an untitled recovery document", async () => {
      loadTabSessionMock.mockResolvedValueOnce({
        tabs: [
          { path: "b.md", unsavedContent: "DISPLACED-UNSAVED-WORK" },
          { path: "a.md", unsavedContent: null },
        ],
        activePath: "b.md",
      });
      const ref = createRef<TabbedEditorHandle>();
      const { container } = render(
        <TabbedEditor ref={ref} request={request("/project", "b.md")} />,
      );
      await waitFor(() =>
        expect(setOpenTabsMock).toHaveBeenLastCalledWith(
          "/project",
          ["b.md", "a.md"],
          "b.md",
        ),
      );
      await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(2));

      act(() => {
        ref.current?.applyCompletedGeneration(generation(["b.md"], [move("a.md", "b.md")]));
      });

      // The work is still on screen, under an identity that is no longer that path.
      const recovered = await screen.findByRole("tab", { name: /recovered from b\.md/ });
      expect(recovered).toBeInTheDocument();
      expect(await screen.findByRole("region", { name: /recovered from b\.md/ })).toHaveTextContent(
        "DISPLACED-UNSAVED-WORK",
      );
      // ...and never written anywhere: not to the destination the moved document now owns, and not
      // into the backend's protected open-tab set, which names project documents only.
      expect(saveDocumentMock).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(setOpenTabsMock).toHaveBeenLastCalledWith("/project", ["b.md"], null),
      );
      // Save As follows the active ordinary document, not merely the presence of one in the
      // background: switching off the recovery enables it, and switching back disables it again.
      fireEvent.click(screen.getByRole("tab", { name: /^b\.md/ }));
      await waitFor(() =>
        expect(setOpenTabsMock).toHaveBeenLastCalledWith("/project", ["b.md"], "b.md"),
      );
      fireEvent.click(recovered);
      await waitFor(() =>
        expect(setOpenTabsMock).toHaveBeenLastCalledWith("/project", ["b.md"], null),
      );
      // The session is its only durable copy, so quitting cannot discard it.
      await waitFor(() =>
        expect(saveTabSessionMock).toHaveBeenLastCalledWith("/project", {
          tabs: [
            {
              path: "untitled:1:b.md",
              unsavedContent: "DISPLACED-UNSAVED-WORK",
              // The identity is opaque; this is what re-identifies the tab after a relaunch, and
              // what keeps a real document named `untitled:…` from being mistaken for one.
              recoveredFrom: "b.md",
              displacedLabelOrdinal: 1,
              docId: expect.any(String),
            },
            { path: "b.md", unsavedContent: null, recoveredFrom: null },
          ],
          activePath: "untitled:1:b.md",
        }),
      );
    });

    it("closes a displaced document that had nothing unsaved to preserve", async () => {
      const { container } = await displaceOnMove({ editMovedTab: false });

      await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(1));
      expect(screen.queryByRole("tab", { name: /recovered from/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    });

    // CJ, 2026-08-12: the ✕ on a recovery tab is the single destructive route in this whole
    // feature. Quit is safe (the session persists the buffer), there is no second copy anywhere by
    // construction, and the strip shows no ● because the tab is deliberately clean — so a misclick
    // would otherwise destroy unrecoverable work with no friction, in a feature built to not lose
    // exactly that work.
    describe("closing an untitled recovery document", () => {
      // Displaces a dirty `b.md` onto which `a.md` is moved, then clicks the recovery tab's ✕.
      const requestCloseOfRecoveredTab = async () => {
        loadTabSessionMock.mockResolvedValueOnce({
          tabs: [
            { path: "b.md", unsavedContent: "DISPLACED-UNSAVED-WORK", recoveredFrom: null },
            { path: "a.md", unsavedContent: null, recoveredFrom: null },
          ],
          activePath: "b.md",
        });
        const ref = createRef<TabbedEditorHandle>();
        const rendered = render(<TabbedEditor ref={ref} request={request("/project", "b.md")} />);
        await waitFor(() =>
          expect(setOpenTabsMock).toHaveBeenLastCalledWith(
            "/project",
            ["b.md", "a.md"],
            "b.md",
          ),
        );
        await waitFor(() =>
          expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(2),
        );

        act(() => {
          ref.current?.applyCompletedGeneration(generation(["b.md"], [move("a.md", "b.md")]));
        });
        await screen.findByRole("tab", { name: /recovered from b\.md/ });

        fireEvent.click(screen.getByRole("button", { name: /Close Untitled — recovered from/ }));
        return rendered;
      };

      /** The most recent session snapshot this layer wrote — never none, since the displacement
       *  itself writes one, so an assertion about it cannot pass by there being nothing to check. */
      const lastPersistedTabs = () => {
        const calls = saveTabSessionMock.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        return calls[calls.length - 1][1].tabs;
      };

      it("asks before discarding it instead of closing on the first click", async () => {
        await requestCloseOfRecoveredTab();

        const guard = await screen.findByRole("alertdialog");
        expect(guard).toHaveTextContent(/discards that work permanently/i);
        expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
        // And the session still holds the buffer: it is this work's only durable home, so a click
        // that merely *asks* must not already have erased it.
        expect(lastPersistedTabs()).toContainEqual({
          path: "untitled:1:b.md",
          unsavedContent: "DISPLACED-UNSAVED-WORK",
          recoveredFrom: "b.md",
          displacedLabelOrdinal: 1,
          docId: expect.any(String),
        });
      });

      it("offers Save As for the untitled buffer while preserving Discard and Cancel", async () => {
        await requestCloseOfRecoveredTab();

        const guard = await screen.findByRole("alertdialog");
        expect(within(guard).getByRole("button", { name: "Save As…" })).toBeInTheDocument();
        expect(
          within(guard).getByRole("button", { name: "Discard this untitled document" }),
        ).toBeInTheDocument();
        expect(within(guard).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      });

      it("Save As from the close guard adopts the buffer and does not close the rescued document", async () => {
        pickSaveAsPathMock.mockResolvedValue("/project/drafts/rescued.md");
        await requestCloseOfRecoveredTab();

        fireEvent.click(
          within(await screen.findByRole("alertdialog")).getByRole("button", {
            name: "Save As…",
          }),
        );

        await waitFor(() =>
          expect(screen.getByRole("tab", { name: "drafts/rescued.md" })).toBeInTheDocument(),
        );
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "drafts/rescued.md" })).toBeInTheDocument();
      });

      it("a cancelled or failed close-guard Save As keeps the guard and untitled buffer intact", async () => {
        await requestCloseOfRecoveredTab();
        const guard = await screen.findByRole("alertdialog");

        // The picker stays open until the test answers it, as a real dialog does. While it is open
        // the guard is busy and its Save As is disabled. React re-enables the button in a scheduled
        // render after the cancel, not synchronously, so the second attempt must wait for that; a
        // click on the still-disabled button is dropped (#44).
        let cancelPicker: (chosen: string | null) => void = () => {};
        // Calls from earlier tests in this file are not reset, so count from here.
        const picksBefore = pickSaveAsPathMock.mock.calls.length;
        pickSaveAsPathMock.mockImplementationOnce(
          () => new Promise<string | null>((resolve) => { cancelPicker = resolve; }),
        );
        fireEvent.click(within(guard).getByRole("button", { name: "Save As…" }));
        await waitFor(() => expect(pickSaveAsPathMock).toHaveBeenCalledTimes(picksBefore + 1));
        expect(within(guard).getByRole("button", { name: "Save As…" })).toBeDisabled();
        cancelPicker(null);
        await waitFor(() =>
          expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save As…" })).toBeEnabled(),
        );
        expect(screen.getByRole("alertdialog")).toBeInTheDocument();
        expectActiveTextbox("DISPLACED-UNSAVED-WORK");

        pickSaveAsPathMock.mockResolvedValueOnce("/project/drafts/rescued.md");
        landAdoptionMock.mockRejectedValueOnce(new Error("disk full"));
        fireEvent.click(
          within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save As…" }),
        );
        expect(pickSaveAsPathMock).toHaveBeenCalledTimes(picksBefore + 2);
        const failedGuard = screen.getByRole("alertdialog");
        expect(await within(failedGuard).findByRole("status")).toHaveTextContent(
          "Couldn’t save to drafts/rescued.md — disk full. Nothing was written, and this document is unchanged.",
        );
        expectActiveTextbox("DISPLACED-UNSAVED-WORK");
      });

      it("names the document by what it is, never by its raw identity", async () => {
        await requestCloseOfRecoveredTab();

        const guard = await screen.findByRole("alertdialog");
        expect(guard).toHaveTextContent("Untitled — recovered from b.md");
        expect(guard).not.toHaveTextContent("untitled:1:");
      });

      it("Cancel keeps the work open and unchanged", async () => {
        await requestCloseOfRecoveredTab();

        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(screen.getByRole("region", { name: /recovered from b\.md/ })).toHaveTextContent(
          "DISPLACED-UNSAVED-WORK",
        );
      });

      it("Discard is what closes it, and only then does it leave the session", async () => {
        await requestCloseOfRecoveredTab();

        fireEvent.click(
          await screen.findByRole("button", { name: "Discard this untitled document" }),
        );

        await waitFor(() =>
          expect(screen.queryByRole("tab", { name: /recovered from b\.md/ })).not.toBeInTheDocument(),
        );
        await waitFor(() =>
          expect(saveTabSessionMock).toHaveBeenLastCalledWith("/project", {
            tabs: [{ path: "b.md", unsavedContent: null, recoveredFrom: null }],
            activePath: "b.md",
          }),
        );
      });
    });
  });

  // A project document whose own project-relative path looks like a recovery identity. §3.5
  // confinement accepts it and macOS/Linux allow the filename, so classifying by prefix dropped a
  // real document out of D21's protected set and rendered it as an empty recovery pane (CJ,
  // 2026-08-12). The record's `recoveredFrom` is what decides, and this document has none.
  it("treats a project document named like a recovery identity as the real document it is", async () => {
    const path = "untitled:1:notes.md";
    const { container } = render(<TabbedEditor request={request("/project", path)} />);

    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent(`# ${path}`),
    );
    // Protected (D21/TD-1): an agent must deliver into it as tracked changes like any other.
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith("/project", [path], path),
    );
    expect(openDocumentMock).toHaveBeenCalledWith("/project", path);
    expect(screen.queryByRole("region", { name: /recovered from/ })).not.toBeInTheDocument();
  });

  it("reloads a clean moved document from its new path instead of carrying its buffer", async () => {
    // FR-ED-7: carrying a clean tab's buffer would hide a genuinely changed file behind text that
    // matches neither disk nor an edit the author made — and with `diskContentRef` seeded from the
    // *new* path, the poller compares disk against disk and never offers reload/keep-mine/merge.
    const ref = createRef<TabbedEditorHandle>();
    const { container } = render(
      <TabbedEditor ref={ref} request={request("/project", "drafts/a.md")} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("# drafts/a.md"),
    );

    act(() => {
      ref.current?.applyCompletedGeneration(
        generation(["archive/a.md"], [move("drafts/a.md", "archive/a.md")]),
      );
    });

    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("# archive/a.md"),
    );
    expect(screen.getByRole("tab", { name: /archive\/a\.md/ })).toHaveAttribute(
      "data-dirty",
      "false",
    );
  });

  it("touches nothing when an uncorrelated remove and add left every open tab alone", async () => {
    const ref = createRef<TabbedEditorHandle>();
    render(<TabbedEditor ref={ref} request={request("/project", "a.md")} />);
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith("/project", ["a.md"], "a.md"),
    );
    const loads = openDocumentMock.mock.calls.length;
    const feeds = setOpenTabsMock.mock.calls.length;

    act(() => {
      ref.current?.applyCompletedGeneration(
        generation(["a.md", "moved.md"], [move("elsewhere.md", "moved.md")]),
      );
    });

    expect(openDocumentMock.mock.calls.length).toBe(loads);
    expect(setOpenTabsMock.mock.calls.length).toBe(feeds);
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeInTheDocument();
  });
});

/**
 * D12/FR-ED-8/#1379/#1803: an untitled document is editable, and `[Save As…]` is its one route into the
 * project — a landed save adopts it, exactly the way J2's Missing-on-disk `[Save As…]` above
 * carries an ordinary document, so the interim read-only pane #932 shipped becomes a real lifecycle.
 */
describe("editor/TabbedEditor — untitled document adoption (D12, FR-ED-8, #1379/#1803)", () => {
  const move = (oldPath: string, newPath: string, kind: "file" | "directory" = "file") => ({
    old_path: oldPath,
    new_path: newPath,
    kind,
  });

  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue("blake3:new");
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    pickSaveAsPathMock.mockReset().mockResolvedValue(null);
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  /** Displaces a dirty `displaced` (default `b.md`) onto which `a.md` is moved, landing an untitled
   * document recovered from `displaced` on screen and active. */
  const openUntitledDocument = async (
    displaced = "b.md",
    content = "DISPLACED-UNSAVED-WORK",
    externalChangePollMs?: number,
    editorProps: Pick<
      import("./TabbedEditor").TabbedEditorProps,
      "commentMode" | "commentThreads"
    > = {},
  ) => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [
        { path: displaced, unsavedContent: content },
        { path: "a.md", unsavedContent: null },
      ],
      activePath: displaced,
    });
    const ref = createRef<TabbedEditorHandle>();
    const openRequest = request("/project", displaced);
    const rendered = render(
      <TabbedEditor
        ref={ref}
        request={openRequest}
        externalChangePollMs={externalChangePollMs}
        {...editorProps}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(2));

    act(() => {
      ref.current?.applyCompletedGeneration(generation([displaced], [move("a.md", displaced)]));
    });
    await screen.findByRole("tab", {
      name: new RegExp(`recovered from ${displaced.replace(/\./g, "\\.")}`),
    });
    return { ...rendered, ref, openRequest };
  };

  const openOverCapUntitledDocument = async (
    content = "",
    collapsed = false,
    onError?: (error: unknown) => void,
  ) => {
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: content.length === 0 ? null : content,
          recoveredFrom: "b.md",
          unsavedContentOmitted: true,
          lossNoticeCollapsed: collapsed,
        },
      ],
      activePath: "untitled:1:b.md",
    });
    const rendered = render(
      <TabbedEditor request={request("/project", "untitled:1:b.md")} onError={onError} />,
    );
    await screen.findByRole("tab", { name: /earlier unsaved work was not preserved/ });
    await screen.findByRole("textbox");
    return rendered;
  };

  it("checkpoints one minted UUID before exposing comment persistence or reading its sidecar", async () => {
    let releaseCheckpoint!: () => void;
    saveTabSessionMock.mockImplementation((_root: string, payload: { tabs: { docId?: string }[] }) => {
      if (!payload.tabs.some((tab) => tab.docId)) return Promise.resolve(undefined);
      return new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    });

    await openUntitledDocument();
    await waitFor(() => expect(releaseCheckpoint).toBeTypeOf("function"));
    const view = activeTextboxView();
    act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));

    expect(mintUntitledDocIdMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
    expect(loadCommentThreadsMock).not.toHaveBeenCalled();

    act(() => releaseCheckpoint());
    await waitFor(() => expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument());
    await waitFor(() =>
      expect(loadCommentThreadsMock).toHaveBeenCalledWith(
        "/project",
        {
          kind: "id",
          docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
          label: "Untitled — recovered from b.md",
        },
        "DISPLACED-UNSAVED-WORK",
      ),
    );
    const checkpointIndex = saveTabSessionMock.mock.calls.findIndex(([, payload]) =>
      (payload as { tabs: { docId?: string }[] }).tabs.some((tab) => tab.docId),
    );
    expect(saveTabSessionMock.mock.invocationCallOrder[checkpointIndex]).toBeLessThan(
      loadCommentThreadsMock.mock.invocationCallOrder[0],
    );
  });

  it("uses the checkpointed UUID when identity settles while the native picker is open", async () => {
    let releaseCheckpoint!: () => void;
    let chooseDestination!: (path: string) => void;
    let identityCheckpointCount = 0;
    saveTabSessionMock.mockImplementation((_root: string, payload: { tabs: { docId?: string }[] }) => {
      if (!payload.tabs.some((tab) => tab.docId)) return Promise.resolve(undefined);
      if (identityCheckpointCount++ > 0) return Promise.resolve(undefined);
      return new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    });
    pickSaveAsPathMock.mockReturnValue(
      new Promise<string>((resolve) => { chooseDestination = resolve; }),
    );

    await openUntitledDocument();
    await waitFor(() => expect(releaseCheckpoint).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    expect(pickSaveAsPathMock).toHaveBeenCalledTimes(1);

    act(() => releaseCheckpoint());
    await waitFor(() => expect(loadCommentThreadsMock).toHaveBeenCalled());
    act(() => chooseDestination("/project/drafts/checkpointed.md"));

    await waitFor(() => expect(prepareAdoptionMock).toHaveBeenCalled());
    expect(mintUntitledDocIdMock).toHaveBeenCalledTimes(1);
    expect(prepareAdoptionMock.mock.calls[0][4]).toBe("4c7be32a-45f8-476f-a175-8fd48cab51d3");
  });

  it("restores 9c.2 from the explicit outcome and persists Hide message plus later edits", async () => {
    await openOverCapUntitledDocument();
    expect(
      screen.getByRole("region", { name: "Recovery notice, untitled document from b.md" }),
    ).toBeInTheDocument();
    expectActiveTextbox("");

    fireEvent.click(screen.getByRole("button", { name: "Hide message" }));
    await screen.findByRole("button", {
      name: "Earlier unsaved work not preserved — show details",
    });
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenLastCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              unsavedContent: null,
              unsavedContentOmitted: true,
              lossNoticeCollapsed: true,
            }),
          ]),
        }),
      ),
    );

    replaceActiveTextbox("new work after omission");
    fireEvent.blur(screen.getByRole("textbox"));
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenLastCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              unsavedContent: "new work after omission",
              unsavedContentOmitted: true,
              lossNoticeCollapsed: true,
            }),
          ]),
        }),
      ),
    );
    expect(screen.getByRole("tab")).toHaveAccessibleName(/earlier unsaved work was not preserved/);
  });

  it("uses the neutral truthful guard only while an over-cap recovery buffer is empty", async () => {
    await openOverCapUntitledDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close Untitled — recovered from b\.md/ }));

    let guard = await screen.findByRole("alertdialog", {
      name: "Close Untitled — recovered from b.md?",
    });
    expect(guard).toHaveTextContent(/Closing it discards no current content/);
    await waitFor(() => expect(within(guard).getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(
      within(guard).getByRole("button", { name: "Discard this untitled document" }),
    ).not.toHaveClass("dirty-close-guard__discard--destructive");
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));

    replaceActiveTextbox("new words");
    fireEvent.click(screen.getByRole("button", { name: /Close Untitled — recovered from b\.md/ }));
    guard = await screen.findByRole("alertdialog", {
      name: "Unsaved work in Untitled — recovered from b.md",
    });
    expect(guard).toHaveTextContent(/Closing it without saving discards it permanently/);
    expect(
      within(guard).getByRole("button", { name: "Discard this untitled document" }),
    ).toHaveClass("dirty-close-guard__discard--destructive");
  });

  it("switches a live over-cap buffer to the non-dismissible warning and its destructive guard", async () => {
    await openUntitledDocument();
    replaceActiveTextbox("x".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES + 1));

    expect(
      screen.getByRole("region", {
        name: "Session durability warning, untitled document from b.md",
      }),
    ).toHaveTextContent("Nothing has been lost — the text is in front of you.");
    expect(screen.queryByRole("button", { name: "Hide message" })).not.toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: /current work is present but not kept/ });
    expect(tab).not.toHaveAccessibleName(/not preserved/);

    fireEvent.click(screen.getByRole("button", { name: /Close Untitled — recovered from b\.md/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "This document holds unsaved work that Emend can't keep in your session — it's over the 2 MiB per-tab limit.",
    );
  });

  it("composes a live over-cap warning with the persisted earlier omission", async () => {
    await openOverCapUntitledDocument("x".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES + 1));

    const notice = screen.getByRole("region", {
      name: "Session durability and recovery notice, untitled document from b.md",
    });
    expect(notice).toHaveTextContent("What you have written since is larger than");
    expect(notice).toHaveTextContent("Separately: the earlier unsaved work");
    expect(screen.getByRole("tab")).toHaveAccessibleName(
      /current work is present but not kept in the session; earlier unsaved work was not preserved/,
    );
  });

  it("successful Save As drops both omission flags and every untitled visual", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/rebuilt.md");
    await openOverCapUntitledDocument("new work after omission", true);

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByRole("tab", { name: "drafts/rebuilt.md" });
    expect(screen.queryByRole("region", { name: /Recovery notice/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Saved nowhere yet")).not.toBeInTheDocument();
    await waitFor(() => {
      const calls = saveTabSessionMock.mock.calls;
      const saved = calls[calls.length - 1]?.[1];
      expect(saved.tabs).toContainEqual({
        path: "drafts/rebuilt.md",
        unsavedContent: null,
        recoveredFrom: null,
      });
    });
  });

  it("edits the buffer in place, debouncing the session write (FR-X-4) rather than writing on every keystroke", async () => {
    await openUntitledDocument();
    saveTabSessionMock.mockClear();

    const textbox = screen.getByRole("textbox");
    replaceActiveTextbox("DISPLACED-UNSAVED-WORK, now edited");
    // Not written synchronously on the keystroke: `setTimeout` schedules the write, so nothing has
    // called `saveTabSession` in this same synchronous tick.
    expect(saveTabSessionMock).not.toHaveBeenCalled();

    // Losing focus is a flush point: it lands the debounced write immediately rather than waiting
    // out the full debounce interval.
    fireEvent.blur(textbox);

    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenLastCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              path: "untitled:1:b.md",
              unsavedContent: "DISPLACED-UNSAVED-WORK, now edited",
              recoveredFrom: "b.md",
            }),
          ]),
        }),
      ),
    );
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("cancels a pending untitled session debounce when the editor unmounts", async () => {
    const rendered = await openUntitledDocument();

    replaceActiveTextbox("pending snapshot from the closing editor");
    const callsBeforeUnmount = schedulerCancelMocks.reduce(
      (count, cancel) => count + cancel.mock.calls.length,
      0,
    );
    rendered.unmount();

    expect(
      schedulerCancelMocks.reduce((count, cancel) => count + cancel.mock.calls.length, 0),
    ).toBe(callsBeforeUnmount + 1);
  });

  it("serializes an untitled blur flush behind an in-flight tab-set session save (#1393, #1379)", async () => {
    await openUntitledDocument();
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    // The mock resolves immediately, but the component's serialized promise lane settles on the
    // following microtask. Drain it before replacing the boundary so an earlier completed snapshot
    // cannot be mistaken for a call that bypassed the deliberately blocked write below.
    await act(async () => {});

    let resolveFirstSave!: () => void;
    saveTabSessionMock
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    fireEvent.click(screen.getByRole("tab", { name: /^b\.md/ }));
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("tab", { name: /recovered from b\.md/ }));
    const textbox = screen.getByRole("textbox");
    replaceActiveTextbox("edited behind the in-flight snapshot");
    fireEvent.blur(textbox);

    // The untitled flush shares the tab-set persistence lane: it must wait behind the first IPC
    // write rather than bypassing that lane with a direct `saveTabSession` call.
    await act(async () => {});
    expect(saveTabSessionMock).toHaveBeenCalledTimes(1);

    resolveFirstSave();
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenLastCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              path: "untitled:1:b.md",
              unsavedContent: "edited behind the in-flight snapshot",
            }),
          ]),
        }),
      ),
    );
  });

  it("suppresses an untitled blur flush while the next project session is still restoring (#1393, #1379)", async () => {
    const rendered = await openUntitledDocument();
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    await act(async () => {});
    saveTabSessionMock.mockClear();

    type LoadedSession = {
      tabs: { path: string; unsavedContent: string | null }[];
      activePath: string | null;
    };
    let resolveNextLoad!: (session: LoadedSession) => void;
    loadTabSessionMock.mockImplementationOnce(
      () =>
        new Promise<LoadedSession>((resolve) => {
          resolveNextLoad = resolve;
        }),
    );

    rendered.rerender(
      <TabbedEditor request={request("/next-project", "next.md")} />,
    );
    await waitFor(() => expect(loadTabSessionMock).toHaveBeenCalledWith("/next-project"));

    const textbox = screen.getByRole("textbox");
    replaceActiveTextbox("must not cross the project restore boundary");
    fireEvent.blur(textbox);
    await act(async () => {});
    expect(saveTabSessionMock).not.toHaveBeenCalled();

    resolveNextLoad({ tabs: [], activePath: null });
    await screen.findByRole("tab", { name: /next\.md/ });
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    expect(saveTabSessionMock.mock.calls.every(([projectRoot]) => projectRoot === "/next-project"))
      .toBe(true);
  });

  it("captures an untitled session root and payload before the shared save lane waits (#1393, #1379)", async () => {
    const rendered = await openUntitledDocument();
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());

    let resolveFirstSave!: () => void;
    saveTabSessionMock.mockReset().mockImplementation(
      (_root: string, payload: { activePath: string | null }) =>
        payload.activePath === "b.md"
          ? new Promise<void>((resolve) => { resolveFirstSave = resolve; })
          : Promise.resolve(),
    );

    fireEvent.click(screen.getByRole("tab", { name: /^b\.md/ }));
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({ activePath: "b.md" }),
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: /recovered from b\.md/ }));
    const textbox = screen.getByRole("textbox");
    replaceActiveTextbox("snapshot captured for the old project");
    fireEvent.blur(textbox);
    await act(async () => {});

    rendered.rerender(
      <TabbedEditor request={request("/next-project", "next.md")} />,
    );
    expect(screen.queryByRole("tab", { name: /next\.md/ })).not.toBeInTheDocument();

    resolveFirstSave();
    await screen.findByRole("tab", { name: /next\.md/ });
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/next-project",
        expect.objectContaining({ activePath: "next.md" }),
      ),
    );
    expect(saveTabSessionMock).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        tabs: expect.arrayContaining([
          expect.objectContaining({
            path: "untitled:1:b.md",
            unsavedContent: "snapshot captured for the old project",
          }),
        ]),
      }),
    );
    expect(
      saveTabSessionMock.mock.calls
        .filter(([projectRoot]) => projectRoot === "/next-project")
        .every(([, payload]) =>
          payload.tabs.every((tab: { path: string }) => tab.path === "next.md"),
        ),
    ).toBe(true);
  });

  it("captures edit B for the old project while an earlier untitled session write is in flight (#1393, #1379)", async () => {
    const rendered = await openUntitledDocument();
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());

    let resolveEditASave!: () => void;
    saveTabSessionMock.mockClear().mockImplementation(
      (_root: string, payload: { tabs: { path: string; unsavedContent?: string | null }[] }) => {
        const untitledContent = payload.tabs.find(
          (tab) => tab.path === "untitled:1:b.md",
        )?.unsavedContent;
        return untitledContent === "edit A already writing"
          ? new Promise<void>((resolve) => {
              resolveEditASave = resolve;
            })
          : Promise.resolve();
      },
    );

    const textbox = screen.getByRole("textbox");
    replaceActiveTextbox("edit A already writing");
    fireEvent.blur(textbox);
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              path: "untitled:1:b.md",
              unsavedContent: "edit A already writing",
            }),
          ]),
        }),
      ),
    );

    // Queue B while A's untitled-triggered write is still in flight, then leave the project before
    // A settles. B must already carry the old root and payload; a front queue holding only an empty
    // token would read the next project's refs when it finally runs and lose B's only durable copy.
    replaceActiveTextbox("edit B must stay with the old project");
    fireEvent.blur(textbox);
    rendered.rerender(
      <TabbedEditor request={request("/next-project", "next.md")} />,
    );
    expect(screen.queryByRole("tab", { name: /next\.md/ })).not.toBeInTheDocument();

    resolveEditASave();
    await screen.findByRole("tab", { name: /next\.md/ });
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenCalledWith(
        "/next-project",
        expect.objectContaining({
          activePath: "next.md",
        }),
      ),
    );

    const oldRootUntitledContents = saveTabSessionMock.mock.calls
      .filter(([root]) => root === "/project")
      .flatMap(([, payload]) =>
        payload.tabs
          .filter((tab: { path: string }) => tab.path === "untitled:1:b.md")
          .map((tab: { unsavedContent?: string }) => tab.unsavedContent),
      );
    expect(oldRootUntitledContents).toContain(
      "edit B must stay with the old project",
    );
  });

  it("adopts the document into the project on a successful Save As", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/kenosis-daily.md");
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() =>
      expect(landAdoptionMock).toHaveBeenCalledWith(
        "/project",
        expect.any(String),
        "DISPLACED-UNSAVED-WORK",
      ),
    );
    expect(prepareAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
      "b.md",
      "drafts/kenosis-daily.md",
      expect.any(String),
      false,
      "DISPLACED-UNSAVED-WORK",
      expect.any(String),
    );
    expect(commitAdoptionMock).not.toHaveBeenCalled();
    expect(pickSaveAsPathMock).toHaveBeenCalledWith("/project", "b.md");
    // The tab is now an ordinary project document at the chosen path, while the original surface
    // remains mounted so adoption cannot erase the editor's identity or interactive state.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "drafts/kenosis-daily.md" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("region", { name: /recovered from/ })).not.toBeInTheDocument();
    expect(openDocumentMock).not.toHaveBeenCalledWith("/project", "drafts/kenosis-daily.md");
    await waitFor(() =>
      expect(saveTabSessionMock).toHaveBeenLastCalledWith(
        "/project",
        expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({ path: "drafts/kenosis-daily.md", recoveredFrom: null }),
          ]),
        }),
      ),
    );
  });

  it("retires pathless dictation when Save As adopts the surface", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/spoken.md");
    await openUntitledDocument();
    const view = activeTextboxView();
    const originalText = view.state.doc.toString();
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(beginEditorDictation(view, 53)).toBe(true);
      expect(showEditorDictationPartial(view, 53, "uncommitted speech")).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: "drafts/spoken.md" });
    expect(activeTextboxView()).toBe(view);
    expect(view.dom.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(commitEditorDictationFinal(view, 53, "stale")).toBe(false);
    expect(view.state.doc.toString()).toBe(originalText);
  });

  it("retires an adopted ghost when its path moves", async () => {
    const adopted = "drafts/spoken.md";
    const moved = "drafts/moved-spoken.md";
    pickSaveAsPathMock.mockResolvedValue(`/project/${adopted}`);
    const { ref } = await openUntitledDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: adopted });
    const view = activeTextboxView();
    const originalText = view.state.doc.toString();
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(beginEditorDictation(view, 55)).toBe(true);
      expect(showEditorDictationPartial(view, 55, "spoken draft")).toBe(true);
    });
    act(() => ref.current?.applyCompletedGeneration(generation([moved], [move(adopted, moved)])));
    await screen.findByRole("tab", { name: moved });
    expect(activeTextboxView()).toBe(view);
    expect(view.dom.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(commitEditorDictationFinal(view, 55, "stale")).toBe(false);
    expect(view.state.doc.toString()).toBe(originalText);
  });

  it("J2 moved adopted tab resumes saving at its new path", async () => {
    const adopted = "drafts/kenosis-daily.md";
    const moved = "drafts/moved-daily.md";
    pickSaveAsPathMock.mockResolvedValue(`/project/${adopted}`);
    const { ref } = await openUntitledDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: adopted });
    const view = activeTextboxView();
    const initial = view.state.doc.toString();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " after move" } }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: adopted })).toHaveAttribute("data-dirty", "true"),
    );
    saveDocumentMock.mockClear();

    act(() => ref.current?.applyCompletedGeneration(generation([moved], [move(adopted, moved)])));
    await screen.findByRole("tab", { name: moved });
    expect(activeTextboxView()).toBe(view);
    expect(view.state.doc.toString()).toBe(`${initial} after move`);
    expect(screen.getByRole("tab", { name: moved })).toHaveAttribute("data-dirty", "true");
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === adopted)).toBe(false);

    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(initial);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " after move" } }));
    screen.getByRole("button", { name: `Close ${moved}` }).click();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    screen.getByRole("button", { name: "Save" }).click();
    await waitFor(() =>
      expect(saveDocumentMock).toHaveBeenCalledWith(
        "/project",
        moved,
        `${initial} after move`,
        true,
      ),
    );
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === adopted)).toBe(false);
  });

  it("J2 moves a clean adopted tab against its latest saved baseline", async () => {
    const adopted = "drafts/clean-a.md";
    const moved = "drafts/clean-b.md";
    const initial = "DISPLACED-UNSAVED-WORK";
    const saved = `${initial} saved edit`;
    let diskContent = initial;
    openDocumentMock.mockImplementation((_root: string, path: string) => Promise.resolve({
      content: path === adopted || path === moved ? diskContent : contentFor(path),
      revision: `blake3:${diskContent}`,
    }));
    saveDocumentMock.mockImplementation(async (_root: string, _path: string, content: string) => {
      diskContent = content;
      return "blake3:saved";
    });
    pickSaveAsPathMock.mockResolvedValue(`/project/${adopted}`);
    const { ref } = await openUntitledDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: adopted });
    const view = activeTextboxView();
    replaceActiveTextbox(saved);
    fireEvent.keyDown(view.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: adopted })).toHaveAttribute("data-dirty", "false"));
    expect(saveDocumentMock).toHaveBeenCalledWith("/project", adopted, saved, true);
    saveDocumentMock.mockClear();

    act(() => ref.current?.applyCompletedGeneration(generation([moved], [move(adopted, moved)])));
    await screen.findByRole("tab", { name: moved });
    expect(activeTextboxView()).toBe(view);
    expect(view.state.doc.toString()).toBe(saved);
    expect(screen.getByRole("tab", { name: moved })).toHaveAttribute("data-dirty", "false");
    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("J2 adopted Save As keeps its retained surface authorized at the destination", async () => {
    const adopted = "drafts/save-as-a.md";
    const destination = "drafts/save-as-b.md";
    pickSaveAsPathMock.mockResolvedValue(`/project/${adopted}`);
    const { ref } = await openUntitledDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: adopted });
    const view = activeTextboxView();
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    await act(async () => { await ref.current?.saveActiveDocumentAs(); });
    await screen.findByRole("tab", { name: destination });
    expect(activeTextboxView()).toBe(view);
    const saved = `${view.state.doc.toString()} after Save As`;
    replaceActiveTextbox(saved);
    saveDocumentMock.mockClear();
    fireEvent.keyDown(view.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });
    await waitFor(() => expect(saveDocumentMock).toHaveBeenCalledWith(
      "/project", destination, saved, true,
    ));
    expect(saveDocumentMock.mock.calls.some(([, path]) => path === adopted)).toBe(false);
  });

  it("keeps the adopted pathless surface mounted while Comments selects the binding status sequence", async () => {
    const destination = "drafts/commented.md";
    const open = thread("open");
    const resolved = { ...thread("resolved"), resolved: true };
    const parsed: ParsedChange = {
      id: "tracked-before-comment-mode",
      recorded: true,
      group: "delivery",
      kind: "insertion",
      full: { from: 0, to: 1 },
      text: { from: 0, to: 1 },
    };
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    parseChangesMock.mockResolvedValue([parsed]);
    const rendered = await openUntitledDocument(
      "b.md",
      "DISPLACED-UNSAVED-WORK",
      undefined,
      { commentThreads: [open, resolved] },
    );
    const retainedView = activeTextboxView();
    const status = screen.getByRole("region", { name: "Document status" });
    await waitFor(() => expect(status).toHaveTextContent("1 open comment"));
    expect(status).not.toHaveTextContent(/resolved/);

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: destination });
    rendered.rerender(
      <TabbedEditor
        request={rendered.openRequest}
        commentThreads={[open, resolved]}
        commentMode
      />,
    );

    await waitFor(() =>
      expect(
        [...status.querySelectorAll(".document-status-bar__leading-item")].map(
          (item) => item.getAttribute("data-status-item-id"),
        ),
        "adopted Comments mode must use the binding sequence without tracked changes",
      ).toEqual([
        "document-kind",
        "word-count",
        "open-comment-count",
        "resolved-comment-count",
      ]),
    );
    expect(activeTextboxView()).toBe(retainedView);
  });

  it("uses the backend-canonicalized filesystem spelling for the write and retained tab identity", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/notes/draft.md");
    prepareAdoptionMock.mockResolvedValueOnce("Notes/Draft.md");
    landAdoptionMock.mockResolvedValueOnce({
      revision: "blake3:new",
      destination: "Notes/Draft.md",
      pending: false,
    });
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(landAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
      "DISPLACED-UNSAVED-WORK",
    ));
    expect(await screen.findByRole("tab", { name: "Notes/Draft.md" })).toBeInTheDocument();
  });

  it("preserves the production EditorView and interactive state when Mod-S completes adoption", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/continuous.md");
    await openUntitledDocument();

    const view = activeTextboxView();
    const toolbar = screen.getByRole("toolbar", { name: "Editor view controls" });
    view.focus();
    view.scrollDOM.scrollTop = 23;
    act(() => view.dispatch({
      changes: { from: view.state.doc.length, insert: "!" },
      selection: { anchor: 3 },
    }));

    fireEvent.keyDown(view.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });

    await screen.findByRole("tab", { name: "drafts/continuous.md" });
    expect(activeTextboxView()).toBe(view);
    expect(screen.getByRole("toolbar", { name: "Editor view controls" })).toBe(toolbar);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.scrollDOM.scrollTop).toBe(23);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("DISPLACED-UNSAVED-WORK");
    expect(openDocumentMock).not.toHaveBeenCalledWith("/project", "drafts/continuous.md");
  });

  it("durably prepares an omitted-work adoption before the file and publishes its D15 projection after commit", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/recovered.md");
    const card = {
      id: "adoption-a1",
      kind: "untitled-adoption" as const,
      adoptionId: "a1",
      displacedPath: "b.md",
      destination: "drafts/recovered.md",
      timestamp: "2026-08-27T00:00:00.000Z",
    };
    reconcileAdoptionsMock
      .mockResolvedValueOnce({ published: [], pendingDestinations: [] })
      .mockResolvedValueOnce({ published: [card], pendingDestinations: [] });
    landAdoptionMock.mockResolvedValueOnce({
      revision: "blake3:new",
      destination: "drafts/recovered.md",
      pending: true,
    });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{
        path: "untitled:1:b.md",
        unsavedContent: "new work",
        recoveredFrom: "b.md",
        unsavedContentOmitted: true,
      }],
      activePath: "untitled:1:b.md",
    });
    const onPersistedTimelineCards = vi.fn();
    render(<TabbedEditor request={request("/project", "untitled:1:b.md")} onPersistedTimelineCards={onPersistedTimelineCards} />);
    await screen.findByRole("button", { name: "Save As…" });

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(commitAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
      "blake3:new",
    ));
    expect(prepareAdoptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      landAdoptionMock.mock.invocationCallOrder[0],
    );
    expect(landAdoptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      commitAdoptionMock.mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(onPersistedTimelineCards).toHaveBeenCalledWith([card]));
  });

  it("joins pane and close-guard Save As through one panel, write, and adoption", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    let choose!: (path: string) => void;
    pickSaveAsPathMock.mockReturnValue(new Promise((resolve) => { choose = resolve; }));
    await openOverCapUntitledDocument("new work");

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    const guard = await screen.findByRole("alertdialog");
    const paneSaveAs = screen.getAllByRole("button", { name: "Save As…" })[0];
    const guardSaveAs = within(guard).getByRole("button", { name: "Save As…" });
    act(() => {
      paneSaveAs.click();
      guardSaveAs.click();
    });

    expect(pickSaveAsPathMock).toHaveBeenCalledTimes(1);
    act(() => choose("/project/drafts/one.md"));
    await waitFor(() => expect(landAdoptionMock).toHaveBeenCalledTimes(1));
    expect(prepareAdoptionMock).toHaveBeenCalledTimes(1);
    expect(commitAdoptionMock).not.toHaveBeenCalled();
  });

  it("adopts the landed file with provenance pending when phase promotion fails", async () => {
    const onConfirmedActivePathChange = vi.fn();
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/pending.md");
    commitAdoptionMock.mockRejectedValue({ kind: "Io", message: "disk busy" });
    landAdoptionMock.mockResolvedValueOnce({
      revision: "blake3:new",
      destination: "drafts/pending.md",
      pending: true,
    });
    reconcileAdoptionsMock
      .mockResolvedValueOnce({ published: [], pendingDestinations: [] })
      .mockResolvedValueOnce({ published: [], pendingDestinations: ["drafts/pending.md"] });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{
        path: "untitled:1:b.md",
        unsavedContent: "new work",
        recoveredFrom: "b.md",
        unsavedContentOmitted: true,
      }],
      activePath: "untitled:1:b.md",
    });
    render(
      <TabbedEditor
        request={request("/project", "untitled:1:b.md")}
        onConfirmedActivePathChange={onConfirmedActivePathChange}
      />,
    );
    await screen.findByRole("button", { name: "Save As…" });

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(commitAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
      "blake3:new",
    ));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved to drafts/pending.md. Emend hasn't yet recorded that the earlier unsaved work wasn't part of it",
    );
    expect(screen.getByRole("tab", { name: "drafts/pending.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save As…" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("new work");
    expect(onConfirmedActivePathChange).toHaveBeenLastCalledWith("drafts/pending.md");
  });

  it("reports a late identity collision and keeps the landed path owned unambiguously by its incumbent", async () => {
    const destination = "drafts/colliding.md";
    const onError = vi.fn();
    const onActiveCommentOwnerChange = vi.fn();
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    reconcileAdoptionsMock
      .mockResolvedValueOnce({ published: [], pendingDestinations: [], collisions: [] })
      .mockResolvedValueOnce({
        published: [],
        pendingDestinations: [destination],
        collisions: [{
          destination,
          docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
          existingDocId: "9b6dbfca-ae88-4ae7-8f26-a60ce1c67ca7",
        }],
      });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "untitled:1:b.md", unsavedContent: "new work", recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    });
    render(
      <TabbedEditor
        request={request("/project", "untitled:1:b.md")}
        onError={onError}
        onActiveCommentOwnerChange={onActiveCommentOwnerChange}
      />,
    );
    await screen.findByRole("button", { name: "Save As…" });

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByRole("tab", { name: destination });
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("kept the existing comment and change history"),
    })));
    expect(onActiveCommentOwnerChange).toHaveBeenLastCalledWith({ kind: "path", path: destination });
    expect(await screen.findByRole("status")).toHaveTextContent("it will finish next time it can");
  });

  it("refuses a destination whose closed document already owns sidecar identity before writing", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/claimed.md");
    prepareAdoptionMock.mockRejectedValue({
      kind: "Invalid",
      message: "path is already claimed by another document",
    });
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn’t prepare Save As — path is already claimed by another document. Nothing was written, and this document is unchanged.",
    );
    expect(landAdoptionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
    expect(loadCommentThreadsMock).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ kind: "id", docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3" }),
      "DISPLACED-UNSAVED-WORK",
    );
  });

  it("restores the provenance-pending line when reconciliation reports a durable event on relaunch", async () => {
    reconcileAdoptionsMock.mockResolvedValueOnce({
      published: [],
      pendingDestinations: ["drafts/pending.md"],
    });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "drafts/pending.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "drafts/pending.md",
    });

    render(<TabbedEditor request={request("/project", "drafts/pending.md")} />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved to drafts/pending.md. Emend hasn't yet recorded that the earlier unsaved work wasn't part of it",
    );
  });

  it("preserves CRLF on adoption then offers and applies ordinary LF normalization", async () => {
    const crlfBuffer = "first line\r\nsecond line\r\n";
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/crlf.md");
    await openUntitledDocument("b.md", crlfBuffer);

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() =>
      expect(landAdoptionMock).toHaveBeenCalledWith(
        "/project",
        expect.any(String),
        crlfBuffer,
      ),
    );
    await screen.findByRole("tab", { name: "drafts/crlf.md" });
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(
      "Line endings will be normalized to LF on save",
    );

    replaceActiveTextbox(`${crlfBuffer}third line`);
    const view = activeTextboxView();
    fireEvent.keyDown(view.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });

    await waitFor(() =>
      expect(saveDocumentMock).toHaveBeenLastCalledWith(
        "/project",
        "drafts/crlf.md",
        `${crlfBuffer}third line`,
        true,
      ),
    );
  });

  it("detects an external write after adoption and blocks ordinary Save on the retained view", async () => {
    const destination = "drafts/external.md";
    let diskContent = "DISPLACED-UNSAVED-WORK";
    openDocumentMock.mockImplementation((_root: string, path: string) => Promise.resolve({
      content: path === destination ? diskContent : contentFor(path),
      revision: path === destination ? `blake3:${diskContent}` : "blake3:x",
    }));
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    await openUntitledDocument("b.md", diskContent, 1);

    const retainedView = activeTextboxView();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: destination });
    diskContent = "OUTSIDE WRITER";

    expect(await screen.findByText("This file changed outside the editor")).toBeInTheDocument();
    const documentStatus = within(screen.getByRole("region", { name: "Document status" }));
    expect(documentStatus.getByText("Not saved — writes paused")).toBeVisible();
    expect(documentStatus.queryByText(/^Saved · /)).toBeNull();
    replaceActiveTextbox("LOCAL EDIT");
    saveDocumentMock.mockClear();
    fireEvent.keyDown(retainedView.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });

    await waitFor(() =>
      expect(screen.getByText("Not saved — this file changed outside the editor")).toBeInTheDocument(),
    );
    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(activeTextboxView()).toBe(retainedView);
  });

  it("pauses every ordinary save after an adopted Reload write fails and retries on the retained view", async () => {
    const destination = "drafts/reload-retry.md";
    let diskContent = "DISPLACED-UNSAVED-WORK";
    openDocumentMock.mockImplementation((_root: string, path: string) => Promise.resolve({
      content: path === destination ? diskContent : contentFor(path),
      revision: path === destination ? `blake3:${diskContent}` : "blake3:x",
    }));
    saveDocumentMock
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce("blake3:retried");
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    await openUntitledDocument("b.md", diskContent, 1);
    const retainedView = activeTextboxView();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: destination });
    diskContent = "OUTSIDE WRITER";
    await screen.findByText("This file changed outside the editor");

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(within(screen.getByRole("region", { name: "Document status" }))
      .getByText("Reloaded from disk · not saved yet")).toBeVisible();

    await waitFor(() => expect(saveDocumentMock).toHaveBeenNthCalledWith(
      1,
      "/project",
      destination,
      "OUTSIDE WRITER",
      true,
    ));
    expect(await screen.findByText("The version from disk is here, but it isn’t saved")).toBeInTheDocument();
    expect(activeTextboxView()).toBe(retainedView);
    expect(retainedView.state.doc.toString()).toBe("OUTSIDE WRITER");
    replaceActiveTextbox("OUTSIDE WRITER + local note");

    // The failed recovery owns writes until an explicit recovery action succeeds. Exercise the
    // three production entry points that share `saveCurrent`: the close guard's imperative save,
    // platform Mod-S, and autosave's blur flush. None may bypass the recovery banner.
    fireEvent.click(screen.getByRole("button", { name: `Close ${destination}` }));
    const closeGuard = await screen.findByRole("alertdialog");
    fireEvent.click(within(closeGuard).getByRole("button", { name: "Save" }));
    await act(async () => Promise.resolve());
    expect(saveDocumentMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(closeGuard).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(retainedView.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });
    fireEvent.blur(retainedView.contentDOM);
    await act(async () => Promise.resolve());
    expect(saveDocumentMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(saveDocumentMock).toHaveBeenNthCalledWith(
      2,
      "/project",
      destination,
      "OUTSIDE WRITER + local note",
      true,
    ));
    await waitFor(() => expect(screen.queryByText("The version from disk is here, but it isn’t saved")).not.toBeInTheDocument());
    expect(activeTextboxView()).toBe(retainedView);
    expect(screen.getByRole("tab", { name: destination })).toHaveAttribute("data-dirty", "false");
  });

  it("keeps a newer external revision authoritative when it arrives during an adopted Reload write", async () => {
    const destination = "drafts/reload-race.md";
    let diskContent = "DISPLACED-UNSAVED-WORK";
    let finishRecovery!: (revision: string) => void;
    openDocumentMock.mockImplementation((_root: string, path: string) => Promise.resolve({
      content: path === destination ? diskContent : contentFor(path),
      revision: path === destination ? `blake3:${diskContent}` : "blake3:x",
    }));
    saveDocumentMock
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishRecovery = resolve; }));
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    await openUntitledDocument("b.md", diskContent, 1);
    const retainedView = activeTextboxView();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: destination });
    diskContent = "FIRST OUTSIDE WRITER";
    await screen.findByText("This file changed outside the editor");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(finishRecovery).toBeTypeOf("function"));

    diskContent = "NEWER OUTSIDE WRITER";
    await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeInTheDocument());
    act(() => finishRecovery("blake3:recovery"));

    await waitFor(() => expect(screen.getByText("This file changed outside the editor")).toBeInTheDocument());
    expect(activeTextboxView()).toBe(retainedView);
    expect(retainedView.state.doc.toString()).toBe("FIRST OUTSIDE WRITER");
    expect(screen.getByRole("tab", { name: destination })).toHaveAttribute("data-dirty", "true");
  });

  it("enters Missing after adoption and refuses file writes while preserving the retained buffer", async () => {
    const destination = "drafts/missing-after-adoption.md";
    pickSaveAsPathMock.mockResolvedValue(`/project/${destination}`);
    const { ref } = await openUntitledDocument();
    const retainedView = activeTextboxView();
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    await screen.findByRole("tab", { name: destination });
    saveDocumentMock.mockClear();

    act(() => ref.current?.applyCompletedGeneration(generation(["b.md"], [])));
    await screen.findByText("This file is missing from its project path. Your open copy is safe.");
    replaceActiveTextbox("ONLY LIVE COPY");
    fireEvent.keyDown(retainedView.contentDOM, {
      key: "s",
      metaKey: /Mac/.test(navigator.platform),
      ctrlKey: !/Mac/.test(navigator.platform),
    });

    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(activeTextboxView()).toBe(retainedView);
    expect(retainedView.state.doc.toString()).toBe("ONLY LIVE COPY");
  });

  it("synchronously intercepts native close and routes an untitled document through its guard", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    await openOverCapUntitledDocument("edited immediately before quit");
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));
    schedulerFlushMocks.forEach((flush) => flush.mockClear());
    saveTabSessionMock.mockClear();

    expect(saveTabSessionMock).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    act(() => closeRequestedHandler?.({ preventDefault }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "isn't saved anywhere",
    );
    expect(schedulerFlushMocks.every((flush) => flush.mock.calls.length === 0)).toBe(true);
  });

  it("latches repeated native close requests before the run-state preflight settles", async () => {
    isTauriMock.mockReturnValue(true);
    let resolveRunState!: (value: unknown) => void;
    invokeMock.mockImplementation(
      () => new Promise((resolve) => { resolveRunState = resolve; }),
    );
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) =>
        policy === "require_untitled_lossless"
          ? Promise.resolve({ revision: "r-final", session: payload, outcomes: [] })
          : Promise.resolve({ revision: "r-background", session: payload, outcomes: [] }),
    );
    await openOverCapUntitledDocument("");
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));
    saveTabSessionMock.mockClear();

    act(() => {
      closeRequestedHandler?.({ preventDefault: vi.fn() });
      closeRequestedHandler?.({ preventDefault: vi.fn() });
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    act(() => resolveRunState({ active: null, queued: [], lastFinished: null }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    expect(saveTabSessionMock.mock.calls.filter(([, , policy]) =>
      policy === "require_untitled_lossless")).toHaveLength(1);
  });

  it("commits a staged recovery discard only after the lossless final receipt", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    let resolveReceipt!: (receipt: unknown) => void;
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) =>
        policy === "require_untitled_lossless"
          ? new Promise((resolve) => { resolveReceipt = resolve; })
          : Promise.resolve({ revision: "r-background", session: payload, outcomes: [] }),
    );
    await openOverCapUntitledDocument("");
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalledWith(
      "/project",
      { tabs: [], activePath: null },
      "require_untitled_lossless",
    ));
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
    expect(destroyWindowMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Session close attempt")).toHaveFocus();
    resolveReceipt({
      revision: "r-final",
      session: { tabs: [], activePath: null },
      outcomes: [],
    });
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
  });

  it("retains the staged plan on final write failure and Stay open clears it without closing", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, _payload: unknown, policy?: string) => policy === "require_untitled_lossless"
        ? Promise.reject({ kind: "Io", message: "disk full" })
        : Promise.resolve(undefined),
    );
    await openOverCapUntitledDocument("");
    screen.getByRole("textbox").focus();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    const failure = await screen.findByRole("alertdialog", {
      name: "Couldn't save your latest session changes",
    });
    expect(failure).toHaveTextContent("disk full. No new session was committed.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Stay open" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Stay open" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    expect(destroyWindowMock).not.toHaveBeenCalled();
  });

  it("retries the same staged plan and closes only after the retry receipt", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    let finalAttempts = 0;
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) => {
        if (policy !== "require_untitled_lossless") return Promise.resolve(undefined);
        finalAttempts += 1;
        if (finalAttempts === 1) return Promise.reject({ kind: "Io", message: "disk full" });
        return Promise.resolve({ revision: "r-retry", session: payload, outcomes: [] });
      },
    );
    await openOverCapUntitledDocument("");

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(finalAttempts).toBe(2));
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
  });

  it("Quit anyway destroys without committing the retained staged plan", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    let finalAttempts = 0;
    saveTabSessionMock.mockImplementation(
      (_root: string, _payload: unknown, policy?: string) => {
        if (policy !== "require_untitled_lossless") return Promise.resolve(undefined);
        finalAttempts += 1;
        return Promise.reject({ kind: "Io", message: "disk full" });
      },
    );
    await openOverCapUntitledDocument("");

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quit anyway" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    expect(finalAttempts).toBe(1);
    expect(proveTabSessionMock).not.toHaveBeenCalled();
  });

  it("does not report a refused window close as a session that was never committed", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) =>
        policy === "require_untitled_lossless"
          ? Promise.resolve({ revision: "r-final", session: payload, outcomes: [] })
          : Promise.resolve(undefined),
    );
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    const onError = vi.fn();
    await openOverCapUntitledDocument("", false, onError);

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Command plugin:window|destroy not allowed by ACL"),
    })));
    const reported = onError.mock.calls[onError.mock.calls.length - 1][0];
    expect(reported.message).toContain("nothing was closed or discarded");
    // The whole sentence is this reporter's, so the shell must not relabel it a document action.
    expect(reported).toBeInstanceOf(UserFacingError);
    expect(screen.queryByRole("alertdialog", {
      name: "Couldn't save your latest session changes",
    })).not.toBeInTheDocument();
    // The discard was never carried out, so the session describing it must not be the one left on
    // disk: the last write puts back the window that is still open, under the ordinary policy the
    // over-cap buffer can survive.
    const writes = saveTabSessionMock.mock.calls;
    const reconciling = writes[writes.length - 1];
    expect(reconciling[2]).toBeUndefined();
    expect(reconciling[1]).toEqual({
      tabs: [expect.objectContaining({ path: "untitled:1:b.md", recoveredFrom: "b.md" })],
      activePath: "untitled:1:b.md",
    });
  });

  it("surfaces a refused window close after Quit anyway", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, _payload: unknown, policy?: string) =>
        policy === "require_untitled_lossless"
          ? Promise.reject({ kind: "Io", message: "disk full" })
          : Promise.resolve(undefined),
    );
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    const onError = vi.fn();
    await openOverCapUntitledDocument("", false, onError);

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quit anyway" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Command plugin:window|destroy not allowed by ACL"),
    })));
    expect(onError.mock.calls[0][0].message).toContain("window didn’t close");
    expect(onError.mock.calls[0][0]).toBeInstanceOf(UserFacingError);
  });

  it("puts the author back where they were when the window refuses to close", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) =>
        policy === "require_untitled_lossless"
          ? Promise.resolve({ revision: "r-final", session: payload, outcomes: [] })
          : Promise.resolve({ revision: "r-background", session: payload, outcomes: [] }),
    );
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    const onError = vi.fn();
    await openOverCapUntitledDocument("", false, onError);
    screen.getByRole("textbox").focus();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    // The attempt resolved having changed nothing, which is the state Stay open produces, so it
    // ends where Stay open ends: the author's recorded place, not the shell element that owned the
    // attempt and has stopped labelling one (UXR-Q20.4, CJ 2026-09-05).
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("puts the author back where they were when Quit anyway's close is refused", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, _payload: unknown, policy?: string) =>
        policy === "require_untitled_lossless"
          ? Promise.reject({ kind: "Io", message: "disk full" })
          : Promise.resolve(undefined),
    );
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    const onError = vi.fn();
    await openOverCapUntitledDocument("", false, onError);
    screen.getByRole("textbox").focus();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quit anyway" }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    // The dialog that held focus is gone and nothing closed, so the same destination applies here:
    // this branch differs from the one above only in having written nothing.
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("writes nothing when a refused close follows the no-write proof", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    });
    proveTabSessionMock.mockResolvedValue({
      revision: "r0",
      session: { tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }], activePath: "a.md" },
      outcomes: [{ path: "a.md", status: "restored_from_disk" }],
    });
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    const onError = vi.fn();
    render(<TabbedEditor request={request("/project", "a.md")} onError={onError} />);
    await screen.findByRole("tab", { name: /a\.md/ });
    // The tab rendering does not order the write the mount-time persistence effect queues on the
    // session lane: `findByRole` resolves on the render, while that write is still a `.then` behind
    // `sessionSaveRef`. Clearing before it lands leaves it to be counted below as though the refused
    // close had written it — a load-dependent false failure (#2335). Land it, drain, then clear, as
    // the untitled blur-suppression cell above already does.
    await waitFor(() => expect(saveTabSessionMock).toHaveBeenCalled());
    await act(async () => {});
    saveTabSessionMock.mockClear();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));

    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(onError).toHaveBeenCalled());
    // The proof path commits nothing, so a refused close has nothing to put back and J2's "it does
    // not write again" still holds.
    expect(saveTabSessionMock).not.toHaveBeenCalled();
  });

  it("restores the persisted baseline from the reconciling write so the next quit is not a false proof", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    saveTabSessionMock.mockImplementation(
      (_root: string, payload: { tabs: unknown[]; activePath: string | null }, policy?: string) =>
        Promise.resolve({
          revision: policy === "require_untitled_lossless" ? "r-final" : "r-live",
          session: payload,
          outcomes: [],
        }),
    );
    destroyWindowMock.mockRejectedValue(
      new Error("Command plugin:window|destroy not allowed by ACL"),
    );
    await openOverCapUntitledDocument("", false, vi.fn());

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());

    // The reconciling write put the still-open window back, so the next attempt's payload differs
    // from what is durable and must be written. A baseline left describing the closed window would
    // make this attempt believe it has nothing to write and prove an empty session the backend
    // refuses — the spurious failure dialog this whole path exists to avoid.
    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard this untitled document" }));

    await waitFor(() => expect(saveTabSessionMock.mock.calls.filter(([, , policy]) =>
      policy === "require_untitled_lossless")).toHaveLength(2));
    expect(proveTabSessionMock).not.toHaveBeenCalled();
  });

  it("uses authoritative no-write proof for an unchanged clean session before destroying", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    });
    proveTabSessionMock.mockResolvedValue({
      revision: "r0",
      session: { tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }], activePath: "a.md" },
      outcomes: [{ path: "a.md", status: "restored_from_disk" }],
    });
    render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("tab", { name: /a\.md/ });

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));

    await waitFor(() => expect(proveTabSessionMock).toHaveBeenCalled());
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
  });

  it("locks the tab strip as well as the panes while the immutable close payload awaits proof", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    const baseline = {
      tabs: [
        { path: "a.md", unsavedContent: null, recoveredFrom: null },
        { path: "b.md", unsavedContent: null, recoveredFrom: null },
      ],
      activePath: "a.md",
    };
    loadTabSessionMock.mockResolvedValueOnce(baseline);
    let resolveProof!: (value: unknown) => void;
    proveTabSessionMock.mockReturnValue(new Promise((resolve) => { resolveProof = resolve; }));
    const { container } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("tab", { name: /b\.md/ });

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    await waitFor(() => expect(proveTabSessionMock).toHaveBeenCalledOnce());
    expect(container.querySelector(".tabbed-editor__mutable-surface")).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("tab", { name: /b\.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close b.md" }));
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument();

    resolveProof({
      revision: "r0",
      session: baseline,
      outcomes: [
        { path: "a.md", status: "restored_from_disk" },
        { path: "b.md", status: "restored_from_disk" },
      ],
    });
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
  });

  it("freezes the mounted mic while immutable close proof is held", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockImplementation((command: string) => command === "get_settings"
      ? Promise.reject(new Error("use editor defaults"))
      : Promise.resolve({ active: null, queued: [], lastFinished: null }));
    const baseline = {
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    };
    loadTabSessionMock.mockResolvedValueOnce(baseline);
    let rejectProof!: (error: Error) => void;
    proveTabSessionMock.mockReturnValue(new Promise((_, reject) => { rejectProof = reject; }));
    const { container } = render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("tab", { name: /a\.md/ });
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "a.md"));
    await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(1));
    const mic = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(".view-mode-toolbar__dictation button");
      expect(button).not.toBeNull();
      return button!;
    });
    const originalLabel = mic.getAttribute("aria-label");
    expect(originalLabel).toMatch(/^Dictate — /);

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    await waitFor(() => expect(proveTabSessionMock).toHaveBeenCalledOnce());
    expect(container.querySelector(".tabbed-editor__mutable-surface")).toHaveAttribute("inert");
    expect(mic).toHaveAttribute("aria-label", "Dictate — unavailable while saving");
    expect(mic).toBeDisabled();

    await act(async () => rejectProof(new Error("proof refused")));
    await waitFor(() => expect(container.querySelector(".tabbed-editor__mutable-surface")).not.toHaveAttribute("inert"));
    expect(mic).toHaveAttribute("aria-label", originalLabel);
  });

  it("discards a dictation partial at the finalization freeze", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockImplementation((command: string) => command === "get_settings"
      ? Promise.reject(new Error("use editor defaults"))
      : Promise.resolve({ active: null, queued: [], lastFinished: null }));
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }], activePath: "a.md",
    });
    let rejectProof!: (error: Error) => void;
    proveTabSessionMock.mockReturnValue(new Promise((_, reject) => { rejectProof = reject; }));
    render(<TabbedEditor request={request("/project", "a.md")} />);
    const view = await waitFor(() => activeTextboxView());
    const originalText = view.state.doc.toString();
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(beginEditorDictation(view, 52)).toBe(true);
      expect(showEditorDictationPartial(view, 52, "uncommitted speech")).toBe(true);
    });
    expect(view.dom.querySelector(".cm-dictation-ghost")).toHaveTextContent("uncommitted speech");

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    await waitFor(() => expect(proveTabSessionMock).toHaveBeenCalledOnce());
    expect(view.dom.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(commitEditorDictationFinal(view, 52, "stale")).toBe(false);
    expect(view.state.doc.toString()).toBe(originalText);

    await act(async () => rejectProof(new Error("proof refused")));
  });

  it("refuses imperative and request mutations while the immutable close payload awaits proof", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    const baseline = {
      tabs: [{ path: "b.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "b.md",
    };
    loadTabSessionMock.mockResolvedValueOnce(baseline);
    let resolveProof!: (value: unknown) => void;
    proveTabSessionMock.mockReturnValue(new Promise((resolve) => { resolveProof = resolve; }));
    const ref = createRef<TabbedEditorHandle>();
    const initialRequest = request("/project", "b.md");
    const rendered = render(<TabbedEditor ref={ref} request={initialRequest} />);
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledWith("/project", "b.md"));
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));
    // Both clears are safe across the awaits below, measured rather than assumed (#2338), and they
    // are safe for two different reasons. `openDocument`: the `waitFor` above is on its own call, so
    // it is always already counted (probed at 1 every run under load, 0 more after a settle) — swap
    // that wait for one not downstream of the call and the probe is owed again. `pickSaveAsPath`:
    // nothing calls it anywhere in this window (0 and 0), which is a property of the code under
    // test, not of the wait. Neither negative assertion below can count someone else's work.
    pickSaveAsPathMock.mockClear();
    openDocumentMock.mockClear();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));
    await waitFor(() => expect(proveTabSessionMock).toHaveBeenCalledOnce());

    const saveAsResult = await ref.current?.saveActiveDocumentAs();
    const decideResult = ref.current?.decideChanges(["7"], "accept");
    act(() => {
      ref.current?.applyCompletedGeneration(
        generation(["c.md"], [move("b.md", "c.md")]),
      );
      rendered.rerender(
        <TabbedEditor ref={ref} request={request("/project", "requested.md")} />,
      );
    });
    await act(async () => {});

    expect(saveAsResult).toBe(false);
    expect(decideResult).toBeNull();
    expect(pickSaveAsPathMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /b\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /c\.md|requested\.md/ })).not.toBeInTheDocument();
    expect(openDocumentMock).not.toHaveBeenCalled();

    resolveProof({
      revision: "r0",
      session: baseline,
      outcomes: [{ path: "b.md", status: "restored_from_disk" }],
    });
    await waitFor(() => expect(destroyWindowMock).toHaveBeenCalledOnce());
  });

  it("uses the unverifiable-baseline copy when authoritative proof is unusable", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ active: null, queued: [], lastFinished: null });
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    });
    proveTabSessionMock.mockRejectedValue({
      kind: "SessionProofUnusable",
      message: "receipt could not be attributed",
    });
    render(<TabbedEditor request={request("/project", "a.md")} />);
    await screen.findByRole("tab", { name: /a\.md/ });

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Emend couldn't verify a usable previous session",
    );
  });

  it("applies FR-X-11 before staging or writing when a run is active", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({
      active: { id: "run-1", phase: { phase: "running" }, activity: [], elapsedSecs: 1 },
      queued: [],
      lastFinished: null,
    });
    const onError = vi.fn();
    const onRunActiveCloseRefused = vi.fn();
    loadTabSessionMock.mockResolvedValueOnce({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    });
    render(
      <TabbedEditor
        request={request("/project", "a.md")}
        onError={onError}
        onRunActiveCloseRefused={onRunActiveCloseRefused}
      />,
    );
    await screen.findByRole("tab", { name: /a\.md/ });
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));
    saveTabSessionMock.mockClear();
    const activeTab = screen.getByRole("tab", { name: /a\.md/ });
    activeTab.focus();
    onError.mockClear();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));

    await waitFor(() => expect(onRunActiveCloseRefused).toHaveBeenCalledWith({
      runId: "run-1",
      returnFocusTo: activeTab,
      fallbackFocusTarget: expect.any(HTMLElement),
    }));
    expect(onError).not.toHaveBeenCalled();
    expect(saveTabSessionMock).not.toHaveBeenCalledWith(
      "/project",
      expect.anything(),
      "require_untitled_lossless",
    );
    expect(proveTabSessionMock).not.toHaveBeenCalled();
    expect(destroyWindowMock).not.toHaveBeenCalled();
  });

  it("retains the generic RunActive error for a caller without the structured status seam", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({
      active: { id: "run-legacy", phase: { phase: "running" }, activity: [], elapsedSecs: 1 },
      queued: [],
      lastFinished: null,
    });
    const onError = vi.fn();
    loadTabSessionMock.mockResolvedValueOnce({ tabs: [], activePath: null });
    render(<TabbedEditor request={request("/project", "a.md")} onError={onError} />);
    await screen.findByRole("tab", { name: /a\.md/ });
    await waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalledTimes(1));
    onError.mockClear();

    act(() => closeRequestedHandler?.({ preventDefault: vi.fn() }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("run-legacy is still running"),
    })));
  });

  it("changes nothing when Save As is cancelled", async () => {
    pickSaveAsPathMock.mockResolvedValue(null);
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(pickSaveAsPathMock).toHaveBeenCalled());
    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
  });

  it("refuses a destination outside the project without writing anything", async () => {
    pickSaveAsPathMock.mockResolvedValue("/elsewhere/outside.md");
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByText(/outside the open project/);
    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
  });

  it("keeps the buffer and reports a write failure without adopting the tab", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/kenosis-daily.md");
    landAdoptionMock.mockRejectedValueOnce(new Error("disk full"));
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByText(/disk full/);
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
    expectActiveTextbox("DISPLACED-UNSAVED-WORK");
  });

  it("tombstones a prepared omission adoption when its file write fails", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/drafts/failed.md");
    landAdoptionMock.mockRejectedValueOnce(new Error("disk full"));
    await openOverCapUntitledDocument("new work");

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByText(/disk full/);
    await waitFor(() => expect(cancelAdoptionMock).toHaveBeenCalledWith(
      "/project",
      expect.any(String),
    ));
    expect(commitAdoptionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
  });

  it("seeds the picker with the displaced path's bare filename, not its full (occupied) path", async () => {
    // "drafts/b.md" is, by construction, the path a different open tab (the moved document) now
    // occupies — pre-filling the picker with that full path would default to overwriting it.
    await openUntitledDocument("drafts/b.md");

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(pickSaveAsPathMock).toHaveBeenCalledWith("/project", "b.md"));
  });

  it("refuses a destination that names an already-open tab, without writing or adopting", async () => {
    // "b.md" is exactly the path `recoveredFrom` names — the moved document (formerly "a.md") now
    // occupies it, so picking it back is the one destination guaranteed to collide.
    pickSaveAsPathMock.mockResolvedValue("/project/b.md");
    await openUntitledDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await screen.findByText(/already open in another tab/);
    expect(landAdoptionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /recovered from b\.md/ })).toBeInTheDocument();
    expectActiveTextbox("DISPLACED-UNSAVED-WORK");
  });
});

/**
 * J2's Missing-on-disk lifecycle where the open-tab set lives (#933): a completed generation is what
 * decides a document has no file, the tab and its buffer survive that, and the recovery exits
 * (Recreate, Save As, Close) land back here as tab-set transitions.
 */
describe("editor/TabbedEditor — missing on disk (#933)", () => {
  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue("r1");
    saveDocumentAsMock.mockReset().mockResolvedValue("r2");
    saveTabSessionMock.mockReset().mockResolvedValue(undefined);
    setOpenTabsMock.mockReset().mockResolvedValue(undefined);
    loadTabSessionMock.mockReset().mockResolvedValue({ tabs: [], activePath: null });
    parseChangesMock.mockReset().mockResolvedValue([]);
    recreateMock.mockReset();
    isProjectPathEnumerableMock.mockReset().mockResolvedValue(true);
    recreateCapabilityMock.mockReset().mockImplementation(async (path) => ({
      path,
      status: "confinement_unavailable",
    }));
    openDocumentMock.mockImplementation((_root: string, path: string) =>
      Promise.resolve({ content: contentFor(path), revision: "blake3:x" }),
    );
  });

  /** An open document, edited, whose path a later generation no longer lists. */
  const openThenLose = async () => {
    const ref = createRef<TabbedEditorHandle>();
    const rendered = render(
      <TabbedEditor ref={ref} request={request("/project", "notes/a.md")} />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-content")).toHaveTextContent("# notes/a.md"),
    );
    const view = EditorView.findFromDOM(
      rendered.container.querySelector(".cm-editor") as HTMLElement,
    );
    act(() => {
      view?.dispatch({ changes: { from: 0, insert: "unsaved work\n" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /notes\/a\.md/ })).toHaveAttribute(
        "data-dirty",
        "true",
      ),
    );
    act(() => {
      ref.current?.applyCompletedGeneration(generation(["notes/other.md"]));
    });
    return { ...rendered, ref };
  };

  it("keeps the tab and its unsaved buffer, and marks the tab Missing on disk", async () => {
    const { container } = await openThenLose();

    expect(
      await screen.findByRole("button", { name: /Missing on disk: notes\/a\.md/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /notes\/a\.md/ })).toBeInTheDocument();
    expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved work");
    expect(
      screen.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeTruthy();
  });

  /** One open document with no generation applied yet. */
  const openOnly = async (path = "notes/a.md") => {
    const ref = createRef<TabbedEditorHandle>();
    const rendered = render(
      <TabbedEditor ref={ref} request={request("/project", path)} />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-content")).toHaveTextContent(`# ${path}`),
    );
    return { ...rendered, ref };
  };

  it("does not claim a document under a backend-hidden tooling directory is missing", async () => {
    const path = "node_modules/pkg/README.md";
    isProjectPathEnumerableMock.mockResolvedValue(false);
    const { ref, container } = await openOnly(path);

    act(() => {
      ref.current?.applyCompletedGeneration(generation(["readme.md"]));
    });

    await waitFor(() => expect(isProjectPathEnumerableMock).toHaveBeenCalledWith(path));
    expect(screen.queryByRole("button", { name: /Missing on disk/ })).toBeNull();
    expect(container.querySelector(".cm-content")).toHaveTextContent(`# ${path}`);
  });

  it("does not let a slower old enumerability answer overwrite a newer generation", async () => {
    let answer: ((enumerable: boolean) => void) | undefined;
    isProjectPathEnumerableMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const { ref } = await openOnly();

    act(() => {
      ref.current?.applyCompletedGeneration(generation(["notes/other.md"]));
    });
    await waitFor(() => expect(isProjectPathEnumerableMock).toHaveBeenCalledWith("notes/a.md"));
    await act(async () => {
      ref.current?.applyCompletedGeneration(generation(["notes/a.md"]));
      answer?.(true);
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Missing on disk/ })).toBeNull();
  });

  it("keeps a candidate deletion Missing and unsaved when the enumerability query fails", async () => {
    const queryError = new Error("visibility unavailable");
    isProjectPathEnumerableMock.mockRejectedValue(queryError);
    const onError = vi.fn();
    const ref = createRef<TabbedEditorHandle>();
    const { container } = render(
      <TabbedEditor
        ref={ref}
        request={request("/project", "notes/a.md")}
        autosaveIntervalMs={1}
        onError={onError}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("# notes/a.md"),
    );

    act(() => {
      ref.current?.applyCompletedGeneration(generation(["notes/other.md"]));
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith(queryError));
    expect(
      await screen.findByRole("button", { name: /Missing on disk: notes\/a\.md/ }),
    ).toBeInTheDocument();
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    act(() => {
      view?.dispatch({ changes: { from: 0, insert: "edited after the failed query\n" } });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(saveDocumentMock).not.toHaveBeenCalled();
    expect(container.querySelector(".cm-content")).toHaveTextContent("edited after the failed query");
  });

  it("does not claim a document is missing when its folder was listed but never enumerated", async () => {
    // A completed generation is not an exhaustive listing (`project_files` publishes a directory it
    // could not read as a present, warned, childless row), so absence beneath such a row is
    // ignorance rather than the proof J2 enters this state on. Claiming it would pause autosave and
    // refuse saves for a file that is still on disk.
    const { ref, container } = await openOnly();

    act(() => {
      ref.current?.applyCompletedGeneration(generationOf([folderRow("notes", [], false)]));
    });

    expect(screen.queryByRole("button", { name: /Missing on disk/ })).toBeNull();
    expect(screen.queryByText(/Your open copy is safe/)).toBeNull();
    expect(container.querySelector(".cm-content")).toHaveTextContent("# notes/a.md");
  });

  it("still claims it when the folder was enumerated and the file is not in it", async () => {
    // The discriminating half: the same folder row, read successfully this time. Its enumeration is
    // what makes the file's absence evidence.
    const { ref } = await openOnly();

    act(() => {
      ref.current?.applyCompletedGeneration(generationOf([folderRow("notes", ["notes/other.md"])]));
    });

    expect(
      await screen.findByRole("button", { name: /Missing on disk: notes\/a\.md/ }),
    ).toBeInTheDocument();
  });

  it("clears Missing when a later generation lists the path again", async () => {
    const { ref } = await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });

    act(() => {
      ref.current?.applyCompletedGeneration(generation(["notes/a.md", "notes/other.md"]));
    });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Missing on disk/ })).toBeNull(),
    );
    expect(
      screen.queryByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeNull();
  });

  it("reopens the recovery actions when the persistent tab status is activated", async () => {
    await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(/Your open copy is safe/)).toBeNull();
    // The status itself is what persists past the dismissal — that is what it is for.
    const status = screen.getByRole("button", { name: /Missing on disk/ });

    fireEvent.click(status);

    expect(await screen.findByText(/Your open copy is safe/)).toBeTruthy();
  });

  it("asks the destructive confirmation before closing, and only Close without saving discards the buffer", async () => {
    const { container } = await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });

    fireEvent.click(screen.getByRole("button", { name: "Close…" }));

    const guard = await screen.findByRole("alertdialog");
    expect(guard).toHaveTextContent("Close and discard Emend’s open copy?");
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("tab", { name: /notes\/a\.md/ })).toBeInTheDocument();
    expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved work");

    fireEvent.click(screen.getByRole("button", { name: "Close…" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Close without saving",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /notes\/a\.md/ })).not.toBeInTheDocument(),
    );
  });

  it("routes the tab strip's own close button through that same confirmation, not the unsaved-changes guard", async () => {
    await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });

    fireEvent.click(screen.getByRole("button", { name: /^Close notes\/a\.md/ }));

    const guard = await screen.findByRole("alertdialog");
    expect(guard).toHaveTextContent("Close and discard Emend’s open copy?");
    // FR-ED-3's guard would offer `Save`, which for a document with no file is a write Emend
    // cannot perform.
    expect(within(guard).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("carries the tab, its buffer, the Missing state, and the backend's open-tab set to a Save As destination", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/archive/rescued.md");
    const { container } = await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /archive\/rescued\.md/ })).toBeInTheDocument(),
    );
    expect(saveDocumentAsMock).toHaveBeenCalledWith(
      "/project",
      "notes/a.md",
      "archive/rescued.md",
      "unsaved work\n# notes/a.md\n",
      true,
    );
    // The document has a file again, so the Missing surface is gone with it — and the work is the
    // work, not a re-read of whatever happens to be at the new path. Waited for rather than read
    // once: the tab appears with the rekey, while the editor under it is remounting and has no DOM
    // at all until the destination's own load lands — an order the suite hit intermittently.
    expect(screen.queryByRole("button", { name: /Missing on disk/ })).toBeNull();
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved work"),
    );
    await waitFor(() =>
      expect(setOpenTabsMock).toHaveBeenLastCalledWith(
        "/project",
        ["archive/rescued.md"],
        "archive/rescued.md",
      ),
    );
  });

  it("changes nothing when the save panel is cancelled", async () => {
    pickSaveAsPathMock.mockResolvedValue(null);
    const { container } = await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });

    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(saveDocumentAsMock).not.toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: /notes\/a\.md/ })).toBeInTheDocument();
    expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved work");
    expect(screen.getByRole("button", { name: /Missing on disk/ })).toBeInTheDocument();
  });

  it("offers Save As from the close confirmation, and saving there keeps the rescued document open", async () => {
    pickSaveAsPathMock.mockResolvedValue("/project/archive/rescued.md");
    const { container } = await openThenLose();
    await screen.findByRole("button", { name: /Missing on disk/ });
    fireEvent.click(screen.getByRole("button", { name: "Close…" }));

    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save As…" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /archive\/rescued\.md/ })).toBeInTheDocument(),
    );
    // The buffer was rescued, not discarded: closing on top of it would defeat the choice just made.
    // Waited for, for the same reason as the sibling above — the remount lands after the tab does.
    await waitFor(() =>
      expect(container.querySelector(".cm-content")).toHaveTextContent("unsaved work"),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
