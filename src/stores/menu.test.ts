// ABOUTME: Tests for the native `File > Open…` and Missing-on-disk Save As dialog bridges
// ABOUTME: (#697/#1445), including platform path spelling and project-relative confinement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenForBackendEventMock = vi.fn();
const isTauriMock = vi.fn(() => true);
const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock("./driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEventMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

const {
  OPEN_DOCUMENT_MENU_EVENT,
  SAVE_DOCUMENT_AS_MENU_EVENT,
  listenForOpenDocumentRequests,
  listenForSaveDocumentAsRequests,
  pickDocumentFile,
  pickSaveAsPath,
  relativeToProjectRoot,
} = await import("./menu");

describe("stores/menu — subscribing to the backend's menu-fired signal", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("listens on the open-document menu event and calls the handler with no payload", async () => {
    let emit: (() => void) | undefined;
    const unlisten = vi.fn();
    listenForBackendEventMock.mockImplementation((_name: string, cb: () => void) => {
      emit = cb;
      return Promise.resolve(unlisten);
    });

    const handler = vi.fn();
    const stop = await listenForOpenDocumentRequests(handler);

    expect(listenForBackendEventMock).toHaveBeenCalledWith(
      OPEN_DOCUMENT_MENU_EVENT,
      expect.any(Function),
    );
    emit?.();
    expect(handler).toHaveBeenCalledWith(undefined);

    stop();
    expect(unlisten).toHaveBeenCalled();
  });

});

describe("stores/menu — subscribing to File > Save As…", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  it("listens on the Save As menu event and forwards each request", async () => {
    let emit: (() => void) | undefined;
    const unlisten = vi.fn();
    listenForBackendEventMock.mockImplementation((_name: string, cb: () => void) => {
      emit = cb;
      return Promise.resolve(unlisten);
    });
    const handler = vi.fn();

    const stop = await listenForSaveDocumentAsRequests(handler);

    expect(SAVE_DOCUMENT_AS_MENU_EVENT).toBe("emend://menu/save-document-as");
    expect(listenForBackendEventMock).toHaveBeenCalledWith(
      "emend://menu/save-document-as",
      expect.any(Function),
    );
    emit?.();
    expect(handler).toHaveBeenCalledOnce();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

});

describe("stores/menu — pickDocumentFile", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    openMock.mockReset();
  });

  it("opens the native picker at the project root with a markdown filter and returns the selected path", async () => {
    openMock.mockResolvedValueOnce("/project/notes/outline.md");

    const result = await pickDocumentFile("/project");

    expect(openMock).toHaveBeenCalledWith({
      defaultPath: "/project",
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    expect(result).toBe("/project/notes/outline.md");
  });

  it("returns null when the user cancels the dialog", async () => {
    openMock.mockResolvedValueOnce(null);

    expect(await pickDocumentFile("/project")).toBeNull();
  });

  it("returns null outside a Tauri webview without touching the dialog plugin", async () => {
    isTauriMock.mockReturnValue(false);

    expect(await pickDocumentFile("/project")).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });
});

describe("stores/menu — pickSaveAsPath", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    saveMock.mockReset().mockResolvedValue(null);
  });

  it("suggests the missing document's original in-project path for the user-confirmed Save As", async () => {
    await pickSaveAsPath("/project", "notes/outline.md");

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "/project/notes/outline.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  });

  it("uses Windows separators for a drive-letter project root", async () => {
    await pickSaveAsPath("C:\\Users\\cj\\project", "notes/outline.md");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "C:\\Users\\cj\\project\\notes\\outline.md" }),
    );
  });

  it("uses Windows separators for a UNC project root", async () => {
    await pickSaveAsPath("\\\\server\\share\\project", "notes/outline.md");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "\\\\server\\share\\project\\notes\\outline.md" }),
    );
  });

  it("keeps Unix separators when a Unix folder name contains a literal backslash", async () => {
    await pickSaveAsPath("/projects/drafts\\", "notes/outline.md");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/projects/drafts\\/notes/outline.md" }),
    );
  });
});

describe("stores/menu — relativeToProjectRoot", () => {
  it("strips the project root and a forward-slash separator", () => {
    expect(relativeToProjectRoot("/project", "/project/notes/outline.md")).toBe(
      "notes/outline.md",
    );
  });

  it("strips a trailing separator on the root before comparing", () => {
    expect(relativeToProjectRoot("/project/", "/project/notes/outline.md")).toBe(
      "notes/outline.md",
    );
  });

  it("normalizes a Windows backslash separator to the project's forward-slash spelling", () => {
    expect(relativeToProjectRoot("C:\\Users\\cj\\project", "C:\\Users\\cj\\project\\notes\\a.md")).toBe(
      "notes/a.md",
    );
  });

  it("accepts a native Windows drive path under a resumed extended-length project root", () => {
    expect(relativeToProjectRoot(
      "\\\\?\\C:\\Users\\cj\\Project",
      "c:\\users\\CJ\\project\\notes\\recovered.md",
    )).toBe("notes/recovered.md");
    expect(relativeToProjectRoot(
      "\\\\?\\C:\\Users\\cj\\Project",
      "C:\\Users\\cj\\Project-old\\recovered.md",
    )).toBeNull();
  });

  it("accepts a native UNC path under a resumed extended-length UNC project root", () => {
    expect(relativeToProjectRoot(
      "\\\\?\\UNC\\server\\share\\Project",
      "\\\\SERVER\\SHARE\\project\\recovered.md",
    )).toBe("recovered.md");
  });

  it("refuses a path outside the project root", () => {
    expect(relativeToProjectRoot("/project", "/other-project/notes/outline.md")).toBeNull();
  });

  it("refuses a sibling directory whose name merely starts with the root's (no separator boundary)", () => {
    expect(relativeToProjectRoot("/project", "/project-2/notes/outline.md")).toBeNull();
  });

  it("refuses the root path itself — there is no relative document to name", () => {
    expect(relativeToProjectRoot("/project", "/project")).toBeNull();
  });
});
