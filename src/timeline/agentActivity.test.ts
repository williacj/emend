// ABOUTME: Confirms the P2a integration (#345, #696) frontend bridge stays thin (§3.1) — it wraps
// ABOUTME: exactly the `listen()`/`invoke()` calls `commands::agent`'s `ACTIVITY_EVENT`/`stop_run`/
// ABOUTME: queue-aware `start_run` expect, including D23's `/run_state` polling transport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityLine, RunQueueState, RunStatus } from "./agentActivity";
import { NO_OPEN_DOCUMENTS } from "./referenceData";

const invokeMock = vi.fn();
const isTauriMock = vi.fn(() => true);
const listenMock = vi.fn();
const callBackendMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  callBackend: (...args: unknown[]) => callBackendMock(...args),
}));

const {
  ACTIVITY_EVENT,
  distinctFilesRead,
  getRunState,
  listenToAgentActivity,
  startAddressRun,
  startRun,
  stopRun,
  summarizeRunActivity,
} = await import("./agentActivity");

const STATUS: RunStatus = {
  id: "run-1",
  phase: { phase: "running" },
  activity: [{ verb: "Reading", detail: "claude.md" }],
  elapsedSecs: 5,
};

const IDLE_STATE: RunQueueState = { active: null, queued: [], finished: [], lastFinished: null };

afterEach(() => {
  vi.useRealTimers();
});

describe("timeline/agentActivity — inside a Tauri webview", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockReset();
    listenMock.mockReset();
    callBackendMock.mockReset();
  });

  it("listenToAgentActivity subscribes to ACTIVITY_EVENT and forwards each pushed RunStatus", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const onStatus = vi.fn();

    const returnedUnlisten = await listenToAgentActivity(onStatus);
    expect(listenMock).toHaveBeenCalledWith(ACTIVITY_EVENT, expect.any(Function));

    // Simulate the backend pushing an event: the handler `listen()` was called with forwards the
    // event's `payload` (not the whole event envelope) to `onStatus`.
    const handler = listenMock.mock.calls[0][1] as (event: { payload: RunStatus }) => void;
    handler({ payload: STATUS });
    expect(onStatus).toHaveBeenCalledWith(STATUS);

    expect(returnedUnlisten).toBe(unlisten);
  });

  it("stopRun routes stop_run through the shared backend transport and returns its outcome", async () => {
    callBackendMock.mockResolvedValueOnce("stopped");
    const outcome = await stopRun("run-1");
    expect(callBackendMock).toHaveBeenCalledWith("stop_run", { runId: "run-1" });
    expect(outcome).toBe("stopped");
  });

  // Restated by #1724/FR-CHAT-4: `startRun` is the one seam every submitting surface passes
  // through, so it is where a turn's reference data is composed onto the prompt. What stays true is
  // that the user's own request leads it unchanged and the D21 operation targets ride beside it
  // untouched (`timeline/referenceData.test.ts` owns the envelope's own field rules).
  it("startRun invokes start_run with the project root, the reference-data-composed prompt and the operation targets, returning its run id", async () => {
    callBackendMock.mockResolvedValueOnce({ id: "run-42", queuedPosition: 2 });
    const result = await startRun("/project", "draft something", ["draft.md"], {
      openDocuments: { active: { path: "draft.md", dirty: false }, alsoOpen: [] },
    });
    const [command, args] = callBackendMock.mock.calls[0] as [
      string,
      { root: string; prompt: string; operationTargets: string[] },
    ];
    expect(command).toBe("start_run");
    expect(args.root).toBe("/project");
    expect(args.operationTargets).toEqual(["draft.md"]);
    expect(args.prompt.startsWith("draft something\n\n")).toBe(true);
    expect(args.prompt).toContain('"kind":"open_documents"');
    expect(result).toEqual({ id: "run-42", queuedPosition: 2 });
  });

  it("startRun rejects with whatever CommandError invoke() rejected with — never swallowed here", async () => {
    const error = { kind: "InvalidArguments", message: "prompt must not be empty" };
    callBackendMock.mockRejectedValueOnce(error);
    await expect(
      startRun("/project", "", [], { openDocuments: NO_OPEN_DOCUMENTS }),
    ).rejects.toEqual(error);
  });

  it("admits an addressed run with its comment targets and submit-time document context in one call", async () => {
    const accepted = {
      run: { id: "run-42", queuedPosition: 2 },
      threads: [],
      progress: { addressed: ["comment-1"], skipped: [], untouched: [], interrupted: null },
    };
    callBackendMock.mockResolvedValueOnce(accepted);

    const result = await startAddressRun(
      "/project", "draft.md", ["comment-1"], "alice", 42,
      "Address this comment", false, null,
      { openDocuments: { active: { path: "draft.md", dirty: false }, alsoOpen: [] } },
    );

    expect(result).toEqual(accepted);
    expect(callBackendMock).toHaveBeenCalledTimes(1);
    const [command, args] = callBackendMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("start_address_run");
    expect(args).toMatchObject({
      root: "/project", path: "draft.md", threadIds: ["comment-1"],
      author: "alice", timestamp: 42, batch: false, guidance: null,
    });
    expect(args.prompt).toBe("Address this comment");
    expect(args.referenceData).toContain('"kind":"open_documents"');
  });

  it("sends only the exact held IDs deliberately included in a batch", async () => {
    callBackendMock.mockResolvedValueOnce({ run: null, threads: [], progress: { addressed: [], skipped: [], untouched: [], interrupted: null } });
    await startAddressRun(
      "/project", "draft.md", ["held-a", "held-b", "open-c"], "alice", 42,
      "Address selected comments", true, null,
      { openDocuments: NO_OPEN_DOCUMENTS }, ["held-a"],
    );
    const [, args] = callBackendMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toMatchObject({
      threadIds: ["held-a", "held-b", "open-c"], includeHeldThreadIds: ["held-a"],
    });
  });
});

describe("timeline/agentActivity — outside a Tauri webview (D23 dev-mode)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    invokeMock.mockReset();
    listenMock.mockReset();
    callBackendMock.mockReset();
  });

  it("getRunState routes /run_state through the real headless-driver transport", async () => {
    callBackendMock.mockResolvedValueOnce(IDLE_STATE);

    await expect(getRunState()).resolves.toEqual(IDLE_STATE);

    expect(callBackendMock).toHaveBeenCalledWith("run_state", {});
  });

  it("polls /run_state, forwarding the active run and every queued position without calling listen()", async () => {
    callBackendMock.mockResolvedValueOnce({
      active: STATUS,
      queued: [
        { id: "run-2", position: 1 },
        { id: "run-3", position: 2 },
      ],
      finished: [],
      lastFinished: null,
    } satisfies RunQueueState);
    const onStatus = vi.fn();

    const unlisten = await listenToAgentActivity(onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(3));

    expect(listenMock).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
      STATUS,
      { id: "run-2", phase: { phase: "queued", position: 1 }, activity: [], elapsedSecs: 0 },
      { id: "run-3", phase: { phase: "queued", position: 2 }, activity: [], elapsedSecs: 0 },
    ]);
    unlisten();
  });

  it("observes each overwritten last_finished terminal before the newly active run", async () => {
    vi.useFakeTimers();
    const runA = { ...STATUS, id: "run-a" };
    const runB = { ...STATUS, id: "run-b" };
    const runC = { ...STATUS, id: "run-c" };
    callBackendMock
      .mockResolvedValueOnce({ active: runA, queued: [{ id: "run-b", position: 1 }], finished: [], lastFinished: null })
      .mockResolvedValueOnce({
        active: runB,
        queued: [{ id: "run-c", position: 1 }],
        finished: [{ ...runA, phase: { phase: "completed", reply: null } }],
        lastFinished: { ...runA, phase: { phase: "completed", reply: null } },
      })
      .mockResolvedValueOnce({
        active: runC,
        queued: [],
        finished: [
          { ...runA, phase: { phase: "completed", reply: null } },
          { ...runB, phase: { phase: "stopped", delivered: false } },
        ],
        lastFinished: { ...runB, phase: { phase: "stopped", delivered: false } },
      });
    const onStatus = vi.fn();

    const unlisten = await listenToAgentActivity(onStatus);
    await vi.advanceTimersByTimeAsync(100);

    expect(onStatus.mock.calls.map(([status]) => [status.id, status.phase.phase])).toEqual([
      ["run-a", "running"],
      ["run-b", "queued"],
      ["run-a", "completed"],
      ["run-b", "running"],
      ["run-c", "queued"],
      ["run-b", "stopped"],
      ["run-c", "running"],
    ]);
    unlisten();
  });

  it("forwards every terminal when two runs finish between polls before the newly active run", async () => {
    vi.useFakeTimers();
    const runA = { ...STATUS, id: "run-a" };
    const runB = { ...STATUS, id: "run-b" };
    const runC = { ...STATUS, id: "run-c" };
    const terminalA = { ...runA, phase: { phase: "completed", reply: null } };
    const terminalB = { ...runB, phase: { phase: "failed", message: "provider unavailable" } };
    callBackendMock
      .mockResolvedValueOnce({
        active: runA,
        queued: [
          { id: "run-b", position: 1 },
          { id: "run-c", position: 2 },
        ],
        lastFinished: null,
        finished: [],
      })
      .mockResolvedValueOnce({
        active: runC,
        queued: [],
        lastFinished: terminalB,
        finished: [terminalA, terminalB],
      });
    const onStatus = vi.fn();

    const unlisten = await listenToAgentActivity(onStatus);
    await vi.advanceTimersByTimeAsync(50);

    expect(
      onStatus.mock.calls
        .map(([status]) => status as RunStatus)
        .filter((status) => status.phase.phase === "completed" || status.phase.phase === "failed")
        .map((status) => status.id),
    ).toEqual(["run-a", "run-b"]);
    expect(onStatus).toHaveBeenLastCalledWith(runC);
    unlisten();
  });

  it("replays terminal history to a newly mounted subscriber after the queue is already idle", async () => {
    const terminalA = { ...STATUS, id: "run-a", phase: { phase: "completed", reply: null } } satisfies RunStatus;
    const terminalB = { ...STATUS, id: "run-b", phase: { phase: "stopped", delivered: false } } satisfies RunStatus;
    callBackendMock.mockResolvedValue({
      active: null,
      queued: [],
      finished: [terminalA, terminalB],
      lastFinished: terminalB,
    } satisfies RunQueueState);
    const firstSubscriber = vi.fn();
    const secondSubscriber = vi.fn();

    const unlistenFirst = await listenToAgentActivity(firstSubscriber);
    await vi.waitFor(() => expect(firstSubscriber).toHaveBeenCalledTimes(2));
    unlistenFirst();
    const unlistenSecond = await listenToAgentActivity(secondSubscriber);
    await vi.waitFor(() => expect(secondSubscriber).toHaveBeenCalledTimes(2));

    expect(firstSubscriber.mock.calls.map(([status]) => status.id)).toEqual(["run-a", "run-b"]);
    expect(secondSubscriber.mock.calls.map(([status]) => status.id)).toEqual(["run-a", "run-b"]);
    unlistenSecond();
  });

  it("stops polling after the final terminal phase and restarts only when a later UI start_run wakes it", async () => {
    vi.useFakeTimers();
    const terminal = { ...STATUS, phase: { phase: "failed", message: "provider unavailable" } } satisfies RunStatus;
    callBackendMock
      .mockResolvedValueOnce({ active: terminal, queued: [], finished: [terminal], lastFinished: terminal } satisfies RunQueueState)
      .mockResolvedValueOnce({ id: "run-later", queuedPosition: null })
      .mockResolvedValueOnce({ active: { ...STATUS, id: "run-later" }, queued: [], finished: [terminal], lastFinished: terminal });
    const onStatus = vi.fn();

    const unlisten = await listenToAgentActivity(onStatus);
    await vi.advanceTimersByTimeAsync(500);
    expect(callBackendMock.mock.calls.filter(([command]) => command === "run_state")).toHaveLength(1);

    await startRun("/project", "later", [], { openDocuments: NO_OPEN_DOCUMENTS });
    await vi.advanceTimersByTimeAsync(50);
    expect(callBackendMock.mock.calls.filter(([command]) => command === "run_state")).toHaveLength(2);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "run-later" }));
    unlisten();
  });

  it("unsubscribing cancels a scheduled poll", async () => {
    vi.useFakeTimers();
    callBackendMock.mockResolvedValue({ active: STATUS, queued: [], finished: [], lastFinished: null });

    const unlisten = await listenToAgentActivity(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    unlisten();
    await vi.advanceTimersByTimeAsync(500);

    expect(callBackendMock).toHaveBeenCalledTimes(1);
  });

  it("stopRun routes to the driver rather than silently degrading", async () => {
    callBackendMock.mockResolvedValueOnce("not_found");
    const outcome = await stopRun("run-1");
    expect(callBackendMock).toHaveBeenCalledWith("stop_run", { runId: "run-1" });
    expect(outcome).toBe("not_found");
  });

  it("startRun routes to the driver rather than returning a made-up empty run id", async () => {
    callBackendMock.mockResolvedValueOnce({ id: "run-real", queuedPosition: null });
    const result = await startRun("/project", "draft something", ["draft.md"], {
      openDocuments: NO_OPEN_DOCUMENTS,
    });
    expect(callBackendMock).toHaveBeenCalledWith("start_run", expect.objectContaining({
      root: "/project",
      operationTargets: ["draft.md"],
    }));
    expect(result).toEqual({ id: "run-real", queuedPosition: null });
  });
});

// J2's `[refs: N files read]` grounding chip (#1391) counts distinct files this run's activity
// feed reports having read.
describe("timeline/agentActivity — distinctFilesRead (#1391)", () => {
  it("counts absolute Read and project-relative get_document_state spellings by their shared identity (#1820)", () => {
    const activity: ActivityLine[] = [
      {
        verb: "Reading",
        detail: "C:\\project\\sermon.md",
        pathIdentity: "sermon.md",
      },
      { verb: "Reading", detail: "sermon.md", pathIdentity: "sermon.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("counts each distinct Reading path once", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "notes/outline.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(2);
  });

  it("counts a file reread several times as one file, not one per line", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "sermon.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("does not count non-Reading verbs — writing, editing, and drafting are not reads", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Writing", detail: "draft.md" },
      { verb: "Editing", detail: "draft.md" },
      { verb: "Drafting" },
      { verb: "Delivering", detail: "draft.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("ignores a Reading line with no detail yet (in-progress, no path named)", () => {
    const activity: ActivityLine[] = [{ verb: "Reading" }, { verb: "Reading", detail: "sermon.md" }];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("returns 0 for an empty or read-free activity list", () => {
    expect(distinctFilesRead([])).toBe(0);
    expect(distinctFilesRead([{ verb: "Drafting" }])).toBe(0);
  });

  // Round-2 review finding (PR #1819): the dedupe key must not be the raw display string, or a
  // spelling variant of one already-tracked document (agent::state's own `resolved_identity`/
  // `relative_to_root`, src-tauri/src/agent/state.rs:281-297) mints a second count. Scoped to the
  // spellings this frontend module can reach without new plumbing — leading `./`, redundant
  // separators, and case (Cowrite ships macOS + Windows only, both case-insensitive filesystems).
  it("counts a leading-./-decorated repeat as the same file as the bare spelling", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "./sermon.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("counts a case-variant repeat as the same file as the original spelling", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "Sermon.MD" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("counts a redundant-separator repeat as the same file as the normally-spelled path", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "notes/outline.md" },
      { verb: "Reading", detail: "notes//outline.md" },
      { verb: "Reading", detail: "notes\\outline.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(1);
  });

  it("still counts genuinely different files as distinct after normalization", () => {
    const activity: ActivityLine[] = [
      { verb: "Reading", detail: "sermon.md" },
      { verb: "Reading", detail: "notes/outline.md" },
    ];
    expect(distinctFilesRead(activity)).toBe(2);
  });
});

describe("timeline/agentActivity — completed-run summary (#1725)", () => {
  // Issue #1820 review finding 2: the persisted completed-run consumer must prefer the backend
  // identity too; the reply-chip-only cell above cannot catch this separate call path regressing.
  it("counts distinct persisted targets by path identity before display detail (#1820)", () => {
    expect(
      summarizeRunActivity([
        {
          verb: "Reading",
          detail: "C:\\project\\sermon.md",
          pathIdentity: "sermon.md",
        },
        { verb: "Reading", detail: "sermon.md", pathIdentity: "sermon.md" },
        { verb: "Writing", detail: "draft.md" },
        { verb: "Editing", detail: "draft.md" },
        { verb: "Delivering", detail: "notes/outline.md" },
      ]),
    ).toEqual({ filesRead: 1, changes: 2 });
  });

  it("preserves known zero instead of conflating it with unknown", () => {
    expect(summarizeRunActivity([{ verb: "Drafting" }])).toEqual({ filesRead: 0, changes: 0 });
  });

  it("reports a metric unknown when any matching persisted line lacks its path", () => {
    expect(
      summarizeRunActivity([
        { verb: "Reading" },
        { verb: "Writing", detail: "draft.md" },
        { verb: "Delivering" },
      ]),
    ).toEqual({ filesRead: null, changes: null });
  });
});
