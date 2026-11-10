// ABOUTME: Confirms the comment IPC bridge stays thin (§3.1) — it shapes exactly the `invoke()`
// ABOUTME: calls `commands::comments` expects, and (D23) reaches the headless test driver instead
// ABOUTME: outside a Tauri webview — same commands, no mocking.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "./types";
import { thread } from "./threadFixture";

const invokeMock = vi.fn();
const isTauriMock = vi.fn(() => true);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));

const {
  loadCommentThreads,
  createComment,
  replyToComment,
  reviseComment,
  withdrawComment,
  resolveComment,
  reopenComment,
  reAnchorComment,
  addressWithAI,
  concludeAddressRun,
  addressAllWithAI,
  linkChanges,
  decideLinkedChanges,
} = await import("./ipc");

const THREAD: CommentThread = thread("c1", { body: "why here?" });

describe("comments/ipc — inside a Tauri webview", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockReset();
  });

  it("loadCommentThreads invokes load_comment_threads with root and path", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    const threads = await loadCommentThreads("/project", "doc.md");
    expect(invokeMock).toHaveBeenCalledWith("load_comment_threads", { root: "/project", path: "doc.md" });
    expect(threads).toEqual([THREAD]);
  });

  it("routes an untitled owner through the UUID command with live content", async () => {
    invokeMock.mockResolvedValue([THREAD]);
    const owner = { kind: "id" as const, docId: "doc-1", label: "Untitled" };

    await loadCommentThreads("/project", owner, "live draft");
    await createComment(
      "/project",
      owner,
      "alice",
      "note",
      { content: "live draft", utf16Offset: 0, utf16Length: 4 },
      101,
      "live draft",
    );
    await replyToComment("/project", owner, "c1", "alice", "reply", false, false, 102, "edited draft");
    await resolveComment("/project", owner, "c1", "alice", 102, "edited draft");
    await reopenComment("/project", owner, "c1", "alice", 103, "edited draft again");
    await reAnchorComment(
      "/project",
      owner,
      "c1",
      "alice",
      104,
      { content: "new home", utf16Offset: 4, utf16Length: 4 },
      "new home",
    );
    await reviseComment("/project", owner, "c1", "revised", 105, "new home");
    await withdrawComment("/project", owner, "c1", 106, "new home");

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "load_comment_threads_by_id",
      "create_comment_by_id",
      "reply_comment_by_id",
      "resolve_comment_by_id",
      "reopen_comment_by_id",
      "re_anchor_comment_by_id",
      "revise_own_comment_by_id",
      "withdraw_own_comment_by_id",
    ]);
    expect(invokeMock.mock.calls.map(([, args]) => args.content)).toEqual([
      "live draft",
      "live draft",
      "edited draft",
      "edited draft",
      "edited draft again",
      "new home",
      "new home",
      "new home",
    ]);
  });

  it("J10 correction commands omit a caller-supplied actor from path-backed IPC", async () => {
    invokeMock.mockResolvedValue([THREAD]);
    await reviseComment("/project", "doc.md", "c1", "revised", 105);
    await withdrawComment("/project", "doc.md", "c1", 106);
    expect(invokeMock.mock.calls).toEqual([
      ["revise_own_comment", { root: "/project", path: "doc.md", targetId: "c1", body: "revised", timestamp: 105 }],
      ["withdraw_own_comment", { root: "/project", path: "doc.md", targetId: "c1", timestamp: 106 }],
    ]);
  });

  it("refuses an ID-targeted command without live content before IPC", async () => {
    await expect(loadCommentThreads(
      "/project",
      { kind: "id", docId: "doc-1", label: "Untitled" },
    )).rejects.toThrow("live content is required");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("createComment invokes create_comment with the anchor range (content + UTF-16 offsets) and timestamp", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    const threads = await createComment(
      "/project",
      "doc.md",
      "alice",
      "why here?",
      { content: "hello world", utf16Offset: 6, utf16Length: 5 },
      100,
    );
    expect(invokeMock).toHaveBeenCalledWith("create_comment", {
      root: "/project",
      path: "doc.md",
      author: "alice",
      body: "why here?",
      anchor: { content: "hello world", utf16Offset: 6, utf16Length: 5 },
      timestamp: 100,
    });
    expect(threads).toEqual([THREAD]);
  });

  it("createComment passes a null anchor for a document-level comment", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await createComment("/project", "doc.md", "alice", "general note", null, 100);
    expect(invokeMock).toHaveBeenCalledWith(
      "create_comment",
      expect.objectContaining({ anchor: null }),
    );
  });

  it("replyToComment invokes reply_comment with the thread id and both flags", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await replyToComment("/project", "doc.md", "c1", "bob", "on it", false, false, 101);
    expect(invokeMock).toHaveBeenCalledWith("reply_comment", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "bob",
      body: "on it",
      defense: false,
      published: false,
      timestamp: 101,
    });
  });

  it("resolveComment invokes resolve_comment with the thread id", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await resolveComment("/project", "doc.md", "c1", "alice", 102);
    expect(invokeMock).toHaveBeenCalledWith("resolve_comment", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "alice",
      timestamp: 102,
    });
  });

  it("reopenComment invokes reopen_comment with the thread id", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await reopenComment("/project", "doc.md", "c1", "bob", 103);
    expect(invokeMock).toHaveBeenCalledWith("reopen_comment", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "bob",
      timestamp: 103,
    });
  });

  it("reAnchorComment invokes re_anchor_comment with the anchor range (content + UTF-16 offsets)", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await reAnchorComment("/project", "doc.md", "c1", "alice", 104, {
      content: "a totally new home",
      utf16Offset: 2,
      utf16Length: 7,
    });
    expect(invokeMock).toHaveBeenCalledWith("re_anchor_comment", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "alice",
      timestamp: 104,
      anchor: { content: "a totally new home", utf16Offset: 2, utf16Length: 7 },
    });
  });

  it("addressWithAI invokes address_with_ai with the run id and defaults guidance to null", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await addressWithAI("/project", "doc.md", "c1", "you", 105, "run-1");
    expect(invokeMock).toHaveBeenCalledWith("address_with_ai", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "you",
      timestamp: 105,
      runId: "run-1",
      guidance: null,
    });
  });

  it("addressWithAI passes a guidance note through for a re-delegation", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await addressWithAI("/project", "doc.md", "c1", "you", 106, "run-2", "use ESV wording");
    expect(invokeMock).toHaveBeenCalledWith(
      "address_with_ai",
      expect.objectContaining({ runId: "run-2", guidance: "use ESV wording" }),
    );
  });

  it("concludeAddressRun invokes conclude_address_run with the run id and outcome", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await concludeAddressRun("/project", "doc.md", "c1", "emend", 109, "run-1", "stopped");
    expect(invokeMock).toHaveBeenCalledWith("conclude_address_run", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "emend",
      timestamp: 109,
      runId: "run-1",
      outcome: "stopped",
    });
  });

  it("linkChanges invokes link_changes with the thread id and change ids", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await linkChanges("/project", "doc.md", "c1", "agent", 107, ["chg-1", "chg-2"]);
    expect(invokeMock).toHaveBeenCalledWith("link_changes", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "agent",
      timestamp: 107,
      changeIds: ["chg-1", "chg-2"],
    });
  });

  it("decideLinkedChanges invokes decide_linked_changes with the change ids and decision", async () => {
    invokeMock.mockResolvedValueOnce([THREAD]);
    await decideLinkedChanges("/project", "doc.md", "c1", "you", 108, ["chg-1"], "accept");
    expect(invokeMock).toHaveBeenCalledWith("decide_linked_changes", {
      root: "/project",
      path: "doc.md",
      threadId: "c1",
      author: "you",
      timestamp: 108,
      changeIds: ["chg-1"],
      decision: "accept",
    });
  });
});

describe("comments/ipc — batch address (P2b-3a, FR-CMT-5)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockReset();
  });

  it("addressAllWithAI invokes address_all_with_ai with the target ids and one shared run id", async () => {
    const outcome = {
      run_id: "batch-1",
      addressed: ["c1", "c2"],
      skipped: [],
      untouched: [],
      interrupted: null,
      threads: [THREAD],
    };
    invokeMock.mockResolvedValueOnce(outcome);

    const result = await addressAllWithAI("/project", "doc.md", ["c1", "c2"], "alice", 7, "batch-1");

    expect(invokeMock).toHaveBeenCalledWith("address_all_with_ai", {
      root: "/project",
      path: "doc.md",
      threadIds: ["c1", "c2"],
      author: "alice",
      timestamp: 7,
      runId: "batch-1",
    });
    expect(result).toEqual(outcome);
  });

  it("surfaces an interrupted run's completed/untouched split verbatim (FR-AGENT-6)", async () => {
    invokeMock.mockResolvedValueOnce({
      run_id: "batch-1",
      addressed: ["c1"],
      skipped: [],
      untouched: ["c2", "c3"],
      // The backend's `Display`, not its `Debug`: this string is shown to the user verbatim, so the
      // fixture pins the user-facing shape rather than the variant-wrapped developer one.
      interrupted: "disk went away",
      threads: [THREAD],
    });

    const result = await addressAllWithAI("/project", "doc.md", ["c1", "c2", "c3"], "alice", 7, "batch-1");

    expect(result.addressed).toEqual(["c1"]);
    expect(result.untouched).toEqual(["c2", "c3"]);
    expect(result.interrupted).not.toBeNull();
  });
});

describe("comments/ipc — outside a Tauri webview (D23 headless test driver)", () => {
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

  it("loadCommentThreads posts to the test driver's /load_comment_threads endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([THREAD]), { status: 200 }));

    const threads = await loadCommentThreads("/project", "doc.md");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/load_comment_threads",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ root: "/project", path: "doc.md" }) }),
    );
    expect(threads).toEqual([THREAD]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("createComment posts to the test driver's /create_comment endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([THREAD]), { status: 200 }));

    await createComment("/project", "doc.md", "alice", "why here?", null, 100);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/create_comment",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "doc.md",
          author: "alice",
          body: "why here?",
          anchor: null,
          timestamp: 100,
        }),
      }),
    );
  });

  it("addressWithAI posts to the test driver's /address_with_ai endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([THREAD]), { status: 200 }));

    await addressWithAI("/project", "doc.md", "c1", "you", 105, "run-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/address_with_ai",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "doc.md",
          threadId: "c1",
          author: "you",
          timestamp: 105,
          runId: "run-1",
          guidance: null,
        }),
      }),
    );
  });

  it("concludeAddressRun posts to the test driver's /conclude_address_run endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([THREAD]), { status: 200 }));

    await concludeAddressRun("/project", "doc.md", "c1", "emend", 109, "run-1", "failed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/conclude_address_run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "doc.md",
          threadId: "c1",
          author: "emend",
          timestamp: 109,
          runId: "run-1",
          outcome: "failed",
        }),
      }),
    );
  });

  it("linkChanges posts to the test driver's /link_changes endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([THREAD]), { status: 200 }));

    await linkChanges("/project", "doc.md", "c1", "agent", 107, ["chg-1", "chg-2"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/link_changes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "doc.md",
          threadId: "c1",
          author: "agent",
          timestamp: 107,
          changeIds: ["chg-1", "chg-2"],
        }),
      }),
    );
  });

  it("a driver error response rejects with the backend's typed CommandError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "InvalidPath", message: "escapes root" }), { status: 422 }),
    );

    await expect(loadCommentThreads("/project", "../escape.md")).rejects.toEqual({
      kind: "InvalidPath",
      message: "escapes root",
    });
  });

  it("addressAllWithAI posts to the test driver's /address_all_with_ai endpoint and rejects honestly on a driver error (FR-AGENT-6 is the caller's job here not this bridge's)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "Io", message: "disk went away" }), { status: 422 }),
    );

    await expect(addressAllWithAI("/project", "doc.md", ["c1", "c2"], "alice", 0, "batch-1")).rejects.toEqual({
      kind: "Io",
      message: "disk went away",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/address_all_with_ai",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          root: "/project",
          path: "doc.md",
          threadIds: ["c1", "c2"],
          author: "alice",
          timestamp: 0,
          runId: "batch-1",
        }),
      }),
    );
  });
});
