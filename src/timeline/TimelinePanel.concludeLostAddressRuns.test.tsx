// @vitest-environment jsdom
// ABOUTME: issues #1381/#1812 — a run that ends without delivering (stopped, or failed/crashed) must
// ABOUTME: clear `pending_run` on every thread it was addressing, or that thread reads "Working"
// ABOUTME: forever. Pins the `RunStatus` entry point specifically — `concludeLostAddressRuns`,
// ABOUTME: noticing a terminal phase and calling `conclude_address_run` for it. The shared worker
// ABOUTME: is also reached without a status at all (a cancelled queued run, #2228), covered in
// ABOUTME: `TimelinePanel.batchAddress.test.tsx`; the backend/store half lives in
// ABOUTME: `src-tauri/src/store/comments.rs` and `commands/comments.rs`'s own test suites.
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { thread } from "../comments/threadFixture";
import type { CommentThread } from "../comments/types";
import type { RunStatus } from "./agentActivity";
import { createCommentCard } from "./types";

const concludeAddressRunMock = vi.fn();
const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  concludeAddressRun: (...args: unknown[]) => concludeAddressRunMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const { TimelinePanel } = await import("./TimelinePanel");

function running(overrides: Partial<RunStatus> = {}): RunStatus {
  return { id: "run-1", phase: { phase: "running" }, activity: [], elapsedSecs: 0, ...overrides };
}

function push(status: RunStatus) {
  const calls = listenMock.mock.calls;
  const handler = calls[calls.length - 1][1] as (event: { payload: RunStatus }) => void;
  act(() => handler({ payload: status }));
}

describe("timeline/TimelinePanel — clearing a lost address run (issue #1381)", () => {
  beforeEach(() => {
    concludeAddressRunMock.mockReset();
    concludeAddressRunMock.mockResolvedValue([]);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
  });

  it("a stopped run calls conclude_address_run for the thread it was addressing, with the stopped outcome", async () => {
    const working = thread("a", { pending_run: "run-1" });
    const card = createCommentCard("/project", "doc.md", working, { id: "card-a" });
    render(
      <TimelinePanel
        initialCards={[card]}
        commentThreads={[working]}
        commentPath="doc.md"
        root="/project"
        commentNow={() => 5}
      />,
    );

    push(running({ id: "run-1", phase: { phase: "stopped", delivered: false } }));

    expect(concludeAddressRunMock).toHaveBeenCalledWith(
      "/project",
      "doc.md",
      "a",
      "you",
      expect.any(Number),
      "run-1",
      "stopped",
    );
  });

  it("a failed run carries the failed outcome instead", async () => {
    const working = thread("a", { pending_run: "run-1" });
    const card = createCommentCard("/project", "doc.md", working, { id: "card-a" });
    render(<TimelinePanel initialCards={[card]} commentThreads={[working]} commentPath="doc.md" root="/project" />);

    push(running({ id: "run-1", phase: { phase: "failed", message: "claude exited" } }));

    expect(concludeAddressRunMock).toHaveBeenCalledWith(
      "/project",
      "doc.md",
      "a",
      "you",
      expect.any(Number),
      "run-1",
      "failed",
    );
  });

  it("concludes either pending run even when the scalar cannot identify one", async () => {
    const working = thread("a", {
      pending_run: null,
      pending_runs: [
        { run_id: "run-1", address_event_id: "address-1", started: true, guidance: null, corrected: false },
        { run_id: "run-2", address_event_id: "address-2", started: false, guidance: null, corrected: false },
      ],
    });
    render(<TimelinePanel commentThreads={[working]} commentPath="doc.md" root="/project" />);

    push(running({ id: "run-2", phase: { phase: "failed", message: "provider failed" } }));

    await waitFor(() => expect(concludeAddressRunMock).toHaveBeenCalledWith(
      "/project", "doc.md", "a", "you", expect.any(Number), "run-2", "failed",
    ));
  });

  it("a clean completion never calls conclude_address_run — that path belongs to the delivery/defense events already covering it", async () => {
    const working = thread("a", { pending_run: "run-1" });
    const card = createCommentCard("/project", "doc.md", working, { id: "card-a" });
    render(<TimelinePanel initialCards={[card]} commentThreads={[working]} commentPath="doc.md" root="/project" />);

    push(running({ id: "run-1", phase: { phase: "completed", reply: null } }));

    expect(concludeAddressRunMock).not.toHaveBeenCalled();
  });

  it("a stopped/failed run naming no thread's pending run id is a no-op — nothing to conclude", async () => {
    const open = thread("a"); // pending_run: null
    const background = thread("b", { pending_run: "run-other" });
    const cards = [
      createCommentCard("/project", "doc.md", open, { id: "card-a" }),
      createCommentCard("/project", "background.md", background, { id: "card-b" }),
    ];
    render(<TimelinePanel initialCards={cards} commentThreads={[open]} commentPath="doc.md" root="/project" />);

    push(running({ id: "run-unrelated", phase: { phase: "stopped", delivered: false } }));

    expect(concludeAddressRunMock).not.toHaveBeenCalled();
  });

  // A batch run addresses several threads under one shared run id (FR-CMT-5/D8) — every thread it
  // was addressing must be concluded, not just the first.
  it("concludes when an immediate terminal status arrives before the pending thread update", async () => {
    const open = thread("a");
    const working = { ...open, pending_run: "run-1" };
    const card = createCommentCard("/project", "doc.md", open, { id: "card-a" });
    const { rerender } = render(
      <TimelinePanel initialCards={[card]} commentThreads={[open]} commentPath="doc.md" root="/project" />,
    );

    push(running({ id: "run-1", phase: { phase: "failed", message: "provider unavailable" } }));
    expect(concludeAddressRunMock).not.toHaveBeenCalled();

    rerender(
      <TimelinePanel initialCards={[card]} commentThreads={[working]} commentPath="doc.md" root="/project" />,
    );
    await waitFor(() =>
      expect(concludeAddressRunMock).toHaveBeenCalledWith(
        "/project",
        "doc.md",
        "a",
        "you",
        expect.any(Number),
        "run-1",
        "failed",
      ),
    );
  });

  it("a batch run's shared id concludes every thread it was addressing, not only one", async () => {
    const a = thread("a", { pending_run: "batch-1" });
    const b = thread("b", { pending_run: "batch-1" });
    const cards = [a, b].map((t) => createCommentCard("/project", "doc.md", t, { id: `card-${t.id}` }));
    render(
      <TimelinePanel initialCards={cards} commentThreads={[a, b]} commentPath="doc.md" root="/project" />,
    );

    push(running({ id: "batch-1", phase: { phase: "stopped", delivered: false } }));

    // Sequenced (not concurrent — see `concludeLostAddressRuns`'s own doc), so the second call only
    // lands after the first call's promise resolves.
    await waitFor(() => expect(concludeAddressRunMock).toHaveBeenCalledTimes(2));
    const targeted = concludeAddressRunMock.mock.calls.map((call) => call[2]);
    expect(targeted.sort()).toEqual(["a", "b"]);
  });

  it("reports the fully-cleared thread list up through onCommentThreadsChange once every conclusion lands", async () => {
    const working = thread("a", { pending_run: "run-1" });
    const cleared: CommentThread[] = [{ ...working, pending_run: null, concluded_run: { run_id: "run-1", outcome: "stopped" } }];
    concludeAddressRunMock.mockResolvedValueOnce(cleared);
    const card = createCommentCard("/project", "doc.md", working, { id: "card-a" });
    const onCommentThreadsChange = vi.fn();

    render(
      <TimelinePanel
        initialCards={[card]}
        commentThreads={[working]}
        commentPath="doc.md"
        root="/project"
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );

    push(running({ id: "run-1", phase: { phase: "stopped", delivered: false } }));
    await screen.findByText("Address run stopped — nothing proposed for this comment.");

    expect(onCommentThreadsChange).toHaveBeenCalledWith(cleared);
  });

  it("a run that concludes after its document becomes inactive clears that document without replacing the active threads (#1812)", async () => {
    const backgroundWorking = thread("background", { pending_run: "run-1" });
    const backgroundCleared: CommentThread[] = [
      {
        ...backgroundWorking,
        pending_run: null,
        concluded_run: { run_id: "run-1", outcome: "stopped" },
      },
    ];
    concludeAddressRunMock.mockResolvedValueOnce(backgroundCleared);
    const backgroundCard = createCommentCard("/project", "background.md", backgroundWorking, {
      id: "card-background",
    });
    const active = thread("active");
    const onCommentThreadsChange = vi.fn();

    render(
      <TimelinePanel
        initialCards={[backgroundCard]}
        commentThreads={[active]}
        commentPath="active.md"
        root="/project"
        commentNow={() => 5}
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );

    push(running({ id: "run-1", phase: { phase: "stopped", delivered: false } }));

    await waitFor(() =>
      expect(concludeAddressRunMock).toHaveBeenCalledWith(
        "/project",
        "background.md",
        "background",
        "you",
        6,
        "run-1",
        "stopped",
      ),
    );
    await screen.findByText("Address run stopped — nothing proposed for this comment.");
    expect(onCommentThreadsChange).not.toHaveBeenCalled();
  });
});
