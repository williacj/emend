// ABOUTME: Confirms the frontend IPC bridge stays thin (§3.1) — it shapes exactly the
// ABOUTME: `invoke()` call the backend commands expect and does nothing else. Also covers the
// ABOUTME: D23 dev-mode fallback: outside a Tauri webview, the same calls reach the headless
// ABOUTME: test driver's HTTP surface (test-plan §4 e2e walking skeleton) instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const isTauriMock = vi.fn(() => true);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));

const {
  openDocument,
  saveDocument,
  beginTabSession,
  saveTabSession,
  endTabSession,
  loadTabSession,
  captureAnchor,
  resolveAnchor,
  parseChanges,
} = await import("./ipc");

describe("editor/ipc", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockReset();
  });

  it("openDocument invokes open_document with the root and path", async () => {
    invokeMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "blake3:abc" });

    const payload = await openDocument("/project", "notes/outline.md");

    expect(invokeMock).toHaveBeenCalledWith("open_document", {
      root: "/project",
      path: "notes/outline.md",
    });
    expect(payload).toEqual({ content: "# Hi\n", revision: "blake3:abc" });
  });

  it("joins an untitled parse through its path-independent document id", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await parseChanges({ root: "/project", docId: "doc-1" }, "{++draft++}");

    expect(invokeMock).toHaveBeenCalledWith("parse_changes_by_id", {
      root: "/project", docId: "doc-1", content: "{++draft++}",
    });
  });

  it("saveDocument invokes save_document with the root path content and normalize flag and returns the written revision", async () => {
    invokeMock.mockResolvedValueOnce("blake3:written");

    const revision = await saveDocument("/project", "notes/outline.md", "# Hi\n", true);

    expect(invokeMock).toHaveBeenCalledWith("save_document", {
      root: "/project",
      path: "notes/outline.md",
      content: "# Hi\n",
      normalizeLineEndings: true,
    });
    expect(revision).toBe("blake3:written");
  });

  it("the tab-session lane carries the acquired revision into save and releases", async () => {
    const session = {
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    };

    invokeMock
      .mockResolvedValueOnce({
        canonicalRoot: "/project",
        attachmentId: "attachment-a",
        revision: "r0",
        session: { tabs: [], activePath: null },
      })
      .mockResolvedValueOnce({ revision: "r1", session, outcomes: [] })
      .mockResolvedValueOnce(undefined);

    await beginTabSession("/project");
    await saveTabSession("/project", session);
    await endTabSession("/project");

    expect(invokeMock).toHaveBeenCalledWith("save_tab_session", {
      root: "/project",
      writerId: expect.stringMatching(/^tab-session:/),
      attachmentId: "attachment-a",
      expectedRevision: "r0",
      session,
      policy: "background",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("end_tab_session", {
      root: "/project",
      writerId: expect.stringMatching(/^tab-session:/),
      attachmentId: "attachment-a",
    });
  });

  it("loadTabSession invokes load_tab_session with the root and returns the session", async () => {
    const session = { tabs: [], activePath: null };
    invokeMock.mockResolvedValueOnce(session);

    const payload = await loadTabSession("/project");

    expect(invokeMock).toHaveBeenCalledWith("load_tab_session", { root: "/project" });
    expect(payload).toEqual(session);
  });

  it("captureAnchor invokes capture_anchor with the content and UTF-16 offset/length", async () => {
    const anchor = {
      offset: 7,
      length: 5,
      text_snapshot: "HELLO",
      context_before: "before ",
      context_after: " after",
      base_revision: "blake3:abc",
    };
    invokeMock.mockResolvedValueOnce(anchor);

    const payload = await captureAnchor("before HELLO after", 7, 5);

    expect(invokeMock).toHaveBeenCalledWith("capture_anchor", {
      content: "before HELLO after",
      utf16Offset: 7,
      utf16Length: 5,
    });
    expect(payload).toEqual(anchor);
  });

  it("resolveAnchor invokes resolve_anchor with the content and anchor", async () => {
    const anchor = {
      offset: 7,
      length: 5,
      text_snapshot: "HELLO",
      context_before: "before ",
      context_after: " after",
      base_revision: "blake3:abc",
    };
    invokeMock.mockResolvedValueOnce({ from: 7, to: 12 });

    const payload = await resolveAnchor("before HELLO after", anchor);

    expect(invokeMock).toHaveBeenCalledWith("resolve_anchor", {
      content: "before HELLO after",
      anchor,
    });
    expect(payload).toEqual({ from: 7, to: 12 });
  });

  it("resolveAnchor resolves null when the backend reports the anchor no longer matches", async () => {
    const anchor = {
      offset: 7,
      length: 5,
      text_snapshot: "HELLO",
      context_before: "before ",
      context_after: " after",
      base_revision: "blake3:abc",
    };
    invokeMock.mockResolvedValueOnce(null);

    const payload = await resolveAnchor("before WORLDS after", anchor);

    expect(payload).toBeNull();
  });
});

describe("editor/ipc — outside a Tauri webview (D23 headless test driver)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    invokeMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_TEST_DRIVER_URL", "http://127.0.0.1:4711");
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("openDocument posts to the test driver's /open_document endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: "# Hi\n", revision: "blake3:abc" }), { status: 200 }),
    );

    const payload = await openDocument("/project", "notes/outline.md");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/open_document",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ root: "/project", path: "notes/outline.md" }),
      }),
    );
    expect(payload).toEqual({ content: "# Hi\n", revision: "blake3:abc" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saveDocument posts to the test driver's /save_document endpoint and returns the written revision", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify("blake3:written"), { status: 200 }));

    const revision = await saveDocument("/project", "notes/outline.md", "# Hi\n", false);

    expect(revision).toBe("blake3:written");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/save_document",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "notes/outline.md",
          content: "# Hi\n",
          normalizeLineEndings: false,
        }),
      }),
    );
  });

  it("a driver error response rejects with the backend's typed CommandError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "InvalidPath", message: "escapes root" }), {
        status: 422,
      }),
    );

    await expect(openDocument("/project", "../escape.md")).rejects.toEqual({
      kind: "InvalidPath",
      message: "escapes root",
    });
  });

  it("saveTabSession posts to the test driver's /save_tab_session endpoint", async () => {
    const session = {
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            canonicalRoot: "/project",
            attachmentId: "attachment-a",
            revision: "r0",
            session: { tabs: [], activePath: null },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: "r1", session, outcomes: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("null", { status: 200 }));

    await beginTabSession("/project");
    await saveTabSession("/project", session);
    await endTabSession("/project");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/save_tab_session",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"expectedRevision":"r0"'),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4711/end_tab_session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loadTabSession posts to the test driver's /load_tab_session endpoint", async () => {
    const session = { tabs: [], activePath: null };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }));

    const payload = await loadTabSession("/project");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/load_tab_session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ root: "/project" }),
      }),
    );
    expect(payload).toEqual(session);
  });

  it("captureAnchor posts to the test driver's /capture_anchor endpoint", async () => {
    const anchor = {
      offset: 0,
      length: 5,
      text_snapshot: "hello",
      context_before: "",
      context_after: " world",
      base_revision: "blake3:abc",
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(anchor), { status: 200 }));

    const payload = await captureAnchor("hello world", 0, 5);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/capture_anchor",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "hello world", utf16Offset: 0, utf16Length: 5 }),
      }),
    );
    expect(payload).toEqual(anchor);
  });

  it("resolveAnchor posts to the test driver's /resolve_anchor endpoint", async () => {
    const anchor = {
      offset: 0,
      length: 5,
      text_snapshot: "hello",
      context_before: "",
      context_after: " world",
      base_revision: "blake3:abc",
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ from: 0, to: 5 }), { status: 200 }));

    const payload = await resolveAnchor("hello world", anchor);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/resolve_anchor",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "hello world", anchor }),
      }),
    );
    expect(payload).toEqual({ from: 0, to: 5 });
  });
});
