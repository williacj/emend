// @vitest-environment jsdom
// ABOUTME: Component-level proof that J4's batch entry point runs end to end (P2b-3a, FR-CMT-5/D8):
// ABOUTME: atomic Address admission, batch accounting, queued acknowledgement and cancellation
// ABOUTME: through the real timeline caller and its backend transport.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "../comments";
import { thread } from "../comments/threadFixture";
import { openDocumentsEnvelopeIn } from "./referenceDataTestUtils";
import { createAgentWorkingCard, createCommentCard } from "./types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
// TimelinePanel's P2a integration (#345) agent-activity subscription calls `listen()` on mount
// whenever `isTauri()` is true — stubbed inert here since this suite exercises the batch-address
// path, not activity streaming (see `TimelinePanel.agentActivity.test.tsx` for that).
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

const { TimelinePanel } = await import("./TimelinePanel");

/** The panel under test with a comment surface attached — `root` + `commentPath` are what make the
 * batch path live, mirroring `CommentCard`'s `card.root`/`card.path` for the single path. */
function panelWith(threads: CommentThread[]) {
  return (
    <TimelinePanel root="/project" commentPath="doc.md" commentThreads={threads} author="alice" commentNow={() => 42} />
  );
}

/** The prompt delivered with the atomic Address admission at the Tauri boundary. */
function startRunPrompt(): string {
  const args = invokeMock.mock.calls.find(([command]) => command === "start_address_run")?.[1];
  return args && `${args.prompt}${args.referenceData}`;
}

/** Opens the trigger's filter panel and fires the run button, with no filter applied (J4-Q1). */
function runBatch() {
  fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Address \d+ comments?$/ }));
}

/** Accepts the historical batch outcome fixture shape and projects the atomic response the new
 * command returns. Individual tests below still specify the same per-thread accounting. */
function backendReturning(outcome: any) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "load_transcript") return Promise.resolve([]);
    if (command === "start_address_run") return Promise.resolve(outcome && {
      run: { id: outcome.run_id, queuedPosition: null },
      threads: outcome.threads,
      progress: {
        addressed: outcome.addressed,
        skipped: outcome.skipped,
        untouched: outcome.untouched,
        interrupted: outcome.interrupted,
      },
    });
    return Promise.resolve(undefined);
  });
}

describe("timeline/TimelinePanel — the batch-address header (P2b-3a, FR-CMT-5, J4 Batch)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    backendReturning(undefined);
  });

  it("shows [Address all… ▾] on the header when more than one comment is open", () => {
    render(panelWith([thread("a"), thread("b")]));
    expect(screen.getByRole("button", { name: /Address all/ })).toBeTruthy();
  });

  it("floats the standalone chooser outside the one-row Timeline header", () => {
    render(panelWith([thread("a"), thread("b")]));
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    const chooser = screen.getByRole("dialog", { name: "Address comments" });
    expect(chooser.parentElement).toBe(document.body);
    expect(chooser.classList.contains("batch-address__panel--floating")).toBe(true);
    expect(document.querySelector(".timeline-panel__header .batch-address__panel")).toBeNull();
  });

  it("shows no batch trigger with a single open comment", () => {
    render(panelWith([thread("a")]));
    expect(screen.queryByRole("button", { name: /Address all/ })).toBeNull();
  });

  it("shows no batch trigger at all on a panel with no comment threads", () => {
    render(<TimelinePanel />);
    expect(screen.queryByRole("button", { name: /Address all/ })).toBeNull();
  });

  // The panel owns the batch invocation the way `CommentCard` owns the single one: without this the
  // trigger is decorative — nothing mints the run id, nothing calls the command.
  it("admits the batch and its Address records with one command", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a", "b"],
      skipped: [],
      untouched: [],
      interrupted: null,
      threads: [],
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "start_address_run",
        expect.objectContaining({
          root: "/project",
          path: "doc.md",
          threadIds: ["a", "b"],
          author: "alice",
          timestamp: 42,
          batch: true,
          guidance: null,
        }),
      ),
    );
  });

  it("sends only the chooser's explicitly included live and queued IDs through atomic admission", async () => {
    backendReturning({ run_id: "run-batch", addressed: ["a", "live", "queued"], skipped: [], untouched: [], interrupted: null, threads: [] });
    render(<TimelinePanel root="/project" commentPath="doc.md" author="alice"
      commentThreads={[thread("a"), thread("live", { pending_run: "run-live" }), thread("queued", { pending_run: "run-queued" })]}
      initialCards={[
        createAgentWorkingCard({ id: "run-live", phase: { phase: "running" }, activity: [], elapsedSecs: 0 }),
        createAgentWorkingCard({ id: "run-queued", phase: { phase: "queued", position: 1 }, activity: [], elapsedSecs: 0 }),
      ]} />);
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    expect(screen.getByText(/3 open comments · 2 already in an agent run/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    fireEvent.click(screen.getByRole("button", { name: "Address 3 comments" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_address_run", expect.objectContaining({
      threadIds: ["a", "live", "queued"], includeHeldThreadIds: ["live", "queued"],
    })));
  });

  it("does not carry an include-them-too choice to another document's chooser", async () => {
    const heldA = [thread("a"), thread("held-a", { pending_run: "run-live" })];
    const heldB = [thread("b"), thread("held-b", { pending_run: "run-live" })];
    const liveCard = createAgentWorkingCard({ id: "run-live", phase: { phase: "running" }, activity: [], elapsedSecs: 0 });
    const { rerender } = render(<TimelinePanel root="/project" commentPath="a.md" author="alice"
      commentThreads={heldA} initialCards={[liveCard]} />);
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    expect((screen.getByRole("checkbox", { name: "include them too" }) as HTMLInputElement).checked).toBe(true);

    rerender(<TimelinePanel root="/project" commentPath="b.md" author="alice"
      commentThreads={heldB} initialCards={[liveCard]} />);
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    expect((screen.getByRole("checkbox", { name: "include them too" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Address 1 comment" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_address_run", expect.objectContaining({
      path: "b.md", threadIds: ["b"], includeHeldThreadIds: [],
    })));
  });

  it("requires a fresh opt-in before a second all-held batch admission", async () => {
    const held = [thread("live", { pending_run: "run-live" }), thread("queued", { pending_run: "run-queued" })];
    let admission = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") {
        admission += 1;
        return Promise.resolve({
          run: { id: `run-batch-${admission}`, queuedPosition: admission + 1 },
          progress: { addressed: ["live", "queued"], skipped: [], untouched: [], interrupted: null },
          threads: held,
        });
      }
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" commentPath="doc.md" author="alice"
      commentThreads={held}
      initialCards={[
        createAgentWorkingCard({ id: "run-live", phase: { phase: "running" }, activity: [], elapsedSecs: 0 }),
        createAgentWorkingCard({ id: "run-queued", phase: { phase: "queued", position: 1 }, activity: [], elapsedSecs: 0 }),
      ]} />);
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    fireEvent.click(screen.getByRole("button", { name: "Address 2 comments" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "start_address_run")).toHaveLength(1));

    expect(screen.queryByRole("dialog", { name: "Address comments" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    expect((screen.getByRole("checkbox", { name: "include them too" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Address 0 comments" }) as HTMLButtonElement).disabled).toBe(true);
    expect(invokeMock.mock.calls.filter(([command]) => command === "start_address_run")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    fireEvent.click(screen.getByRole("button", { name: "Address 2 comments" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "start_address_run")).toHaveLength(2));
  });

  it("returns one backend run id for the batch accounting and queued acknowledgement", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") {
        return Promise.resolve({
          run: { id: "run-from-start-run", queuedPosition: null },
          progress: { addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null },
          threads: [],
        });
      }
      return Promise.resolve(undefined);
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "start_address_run",
        expect.objectContaining({ root: "/project", path: "doc.md", threadIds: ["a", "b"] }),
      ),
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "start_run" || command === "address_all_with_ai")).toHaveLength(0);
  });

  // #1724/FR-CHAT-4: "a chat turn, a single Address with AI run, and a batch address run alike"
  // carry the open-document envelope. The batch path is the easiest of the four to leave behind,
  // because it composes its own prompt (`buildBatchAddressPrompt`) rather than the composer's.
  it("names the open documents in the prompt reaching Address admission, exactly as a chat turn does", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a", "b"],
      skipped: [],
      untouched: [],
      interrupted: null,
      threads: [],
    });

    render(
      <TimelinePanel
        root="/project"
        commentPath="doc.md"
        commentThreads={[thread("a"), thread("b")]}
        author="alice"
        commentNow={() => 42}
        openDocuments={() => ({
          active: { path: "doc.md", dirty: true, content: "live buffer" },
          alsoOpen: [{ path: null, label: "Untitled — recovered from gone.md", dirty: false }],
        })}
      />,
    );
    runBatch();

    await waitFor(() => expect(startRunPrompt()).toBeDefined());
    const prompt = startRunPrompt();
    // The batch instruction still leads the prompt; the envelope is reference data beneath it.
    expect(prompt.startsWith("Address the following 2 comment thread(s)")).toBe(true);
    expect(openDocumentsEnvelopeIn(prompt)).toEqual({
      emend_context_version: 1,
      kind: "open_documents",
      active: { path: "doc.md", unsaved: true, content: "live buffer" },
      also_open: [
        { path: null, label: "Untitled — recovered from gone.md", unsaved: true },
      ],
    });
  });

  it("surfaces the run's per-thread accounting on the header (FR-AGENT-6)", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a"],
      skipped: ["b"],
      untouched: [],
      interrupted: null,
      threads: [],
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 addressed"));
    expect(screen.getByRole("status").textContent).toContain("1 skipped");
  });

  it("reports an all-skipped admission without inventing a run or untouched targets", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return Promise.resolve({
        run: null,
        progress: { addressed: [], skipped: ["a", "b"], untouched: [], interrupted: null },
        threads: [thread("a", { resolved: true }), thread("b", { resolved: true })],
      });
      return Promise.resolve(undefined);
    });
    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 skipped"));
    expect(screen.getByRole("status").textContent).not.toContain("untouched");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  // FR-AGENT-6 honesty across the seam that can actually fail: a rejected IPC must not read as a
  // silent no-op, or the user believes every comment was handled when none were.
  it("reports a failed call as an interrupted run with every target untouched", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.reject(new Error("backend went away"));
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("stopped early"));
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("backend went away");
    expect(status).toContain("0 addressed");
    expect(status).toContain("2 untouched");

    // A failed admission still ends; reopening the chooser must offer a retry.
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    const run = screen.getByRole("button", { name: /^Address \d+ comments?$/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
  });

  it("retires a no-run header failure after a later batch is admitted", async () => {
    let admission = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") {
        admission += 1;
        if (admission === 1) return Promise.reject(new Error("connection lost"));
        return Promise.resolve({
          run: { id: "run-recovered", queuedPosition: null },
          progress: { addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null },
          threads: [],
        });
      }
      return Promise.resolve(undefined);
    });
    const { container } = render(panelWith([thread("a"), thread("b")]));
    runBatch();
    await waitFor(() => expect(container.querySelector('.timeline-panel__header .batch-address-status')?.textContent)
      .toContain("connection lost"));
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Address \d+ comments?$/ }));
    await waitFor(() => expect(container.querySelector('[data-card-id="run-recovered"] .batch-address-status')?.textContent)
      .toContain("Batch 2"));
    expect(container.querySelector('.timeline-panel__header .batch-address-status')).toBeNull();
  });

  it("reports partial admission with the real run id and exact untouched targets", async () => {
    backendReturning({
      run_id: "run-partial",
      addressed: ["a"], skipped: [], untouched: ["b"],
      interrupted: "sidecar write failed", threads: [thread("a", { pending_run: "run-partial" }), thread("b")],
    });
    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("stopped early"));
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("1 addressed");
    expect(status).toContain("1 untouched");
    expect(status).toContain("sidecar write failed");
  });

  it("keeps each batch's admission facts when a later queued batch is cancelled", async () => {
    let batchAction: ((threadIds: string[], includeHeldThreadIds?: string[]) => void) | null = null;
    let admission = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") {
        admission += 1;
        return Promise.resolve(admission === 1
          ? { run: { id: "run-a", queuedPosition: null }, progress: { addressed: ["a"], skipped: [], untouched: ["b"], interrupted: "sidecar write failed" }, threads: [] }
          : { run: { id: "run-b", queuedPosition: 1 }, progress: { addressed: ["b"], skipped: ["a"], untouched: [], interrupted: null }, threads: [] });
      }
      if (command === "stop_run") return Promise.resolve("cancelled");
      return Promise.resolve([]);
    });
    const { container } = render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a"), thread("b")]}
      author="alice" onRegisterBatchAddress={(action) => { batchAction = action; }} />);
    await act(async () => { batchAction?.(["a", "b"]); });
    await waitFor(() => expect(container.querySelector('[data-card-id="run-a"] .batch-address-status')?.textContent)
      .toContain("stopped early: sidecar write failed"));
    await act(async () => { batchAction?.(["a", "b"], ["b"]); });
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 100_000 } });
    await waitFor(() => expect(container.querySelector('[data-card-id="run-b"] .batch-address-status')?.textContent)
      .toMatch(/Batch 2.*1 addressed.*1 skipped/));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    await waitFor(() => expect(container.querySelector('[data-card-id="run-b"] .batch-address-status')?.textContent)
      .toMatch(/Batch 2.*1 addressed.*1 skipped.*Cancelled/));
    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    await waitFor(() => expect(container.querySelector('[data-card-id="run-a"] .batch-address-status')?.textContent)
      .toMatch(/Batch 1.*stopped early: sidecar write failed/));
  });

  it("keeps batch status with its document across tab switches", async () => {
    backendReturning({ run_id: "run-a", addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null, threads: [] });
    const comments = [thread("a"), thread("b")];
    const { rerender } = render(<TimelinePanel root="/project" commentPath="a.md" commentThreads={comments} author="alice" />);
    runBatch();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Batch 1"));
    rerender(<TimelinePanel root="/project" commentPath="b.md" commentThreads={[thread("c"), thread("d")]} author="alice" />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<TimelinePanel root="/project" commentPath="a.md" commentThreads={comments} author="alice" />);
    expect(screen.getByRole("status").textContent).toContain("Batch 1");
  });

  it("keeps batch status with its document when the old response arrives after a tab switch", async () => {
    let resolveAdmission: ((result: unknown) => void) | undefined;
    const onCommentThreadsChange = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return new Promise((resolve) => { resolveAdmission = resolve; });
      return Promise.resolve(undefined);
    });
    const { rerender } = render(<TimelinePanel root="/project" commentPath="a.md"
      commentThreads={[thread("a"), thread("b")]} author="alice" onCommentThreadsChange={onCommentThreadsChange} />);
    runBatch();
    await waitFor(() => expect(resolveAdmission).toBeDefined());
    rerender(<TimelinePanel root="/project" commentPath="b.md"
      commentThreads={[thread("c"), thread("d")]} author="alice" onCommentThreadsChange={onCommentThreadsChange} />);
    await act(async () => { resolveAdmission?.({
      run: { id: "run-a", queuedPosition: null },
      progress: { addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null },
      threads: [thread("a", { pending_run: "run-a" }), thread("b", { pending_run: "run-a" })],
    }); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Address all/ })).toBeTruthy();
    expect(onCommentThreadsChange).not.toHaveBeenCalled();
    rerender(<TimelinePanel root="/project" commentPath="a.md"
      commentThreads={[thread("a"), thread("b")]} author="alice" onCommentThreadsChange={onCommentThreadsChange} />);
    expect(screen.getByRole("status").textContent).toContain("Batch 1");
  });

  it("keeps three batch accounts out of the narrow header and with their run cards", async () => {
    let batchAction: ((threadIds: string[], includeHeldThreadIds?: string[]) => void) | null = null;
    let admissions = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") {
        admissions += 1;
        return Promise.resolve({
          run: { id: `run-${admissions}`, queuedPosition: admissions === 1 ? null : admissions - 1 },
          progress: { addressed: ["a"], skipped: ["b"], untouched: [], interrupted: null },
          threads: [],
        });
      }
      return Promise.resolve(undefined);
    });
    const { container } = render(<div style={{ width: 400 }}><TimelinePanel root="/project" commentPath="a.md"
      commentThreads={[thread("a"), thread("b")]} author="alice"
      onRegisterBatchAddress={(action) => { batchAction = action; }} /></div>);
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    for (let number = 1; number <= 3; number += 1) {
      await act(async () => { batchAction?.(["a", "b"], number > 1 ? ["a"] : []); });
      fireEvent.scroll(list, { target: { scrollTop: 100_000 } });
      await waitFor(() => expect(container.querySelector(`[data-card-id="run-${number}"] .batch-address-status`)?.textContent)
        .toContain(`Batch ${number}`));
      expect(container.querySelectorAll('.timeline-panel__header .batch-address-status')).toHaveLength(0);
    }
  });

  // The batch's own returned threads re-render the chooser, but targeted comments remain open
  // and visible with the now-held count until the run concludes.
  it("refreshes its threads from the run's returned state", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a", "b"],
      skipped: [],
      untouched: [],
      interrupted: null,
      threads: [thread("a", { pending_run: "run-1" }), thread("b", { pending_run: "run-1" })],
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 addressed"));
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    expect((screen.getByRole("button", { name: "Address 0 comments" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // The success path still needs its run-specific accounting after all open threads become held.
  it("keeps reporting its accounting after a clean batch leaves no comment open", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a", "b"],
      skipped: ["c"],
      untouched: [],
      interrupted: null,
      threads: [
        thread("a", { pending_run: "run-1" }),
        thread("b", { pending_run: "run-1" }),
        thread("c", { resolved: true }),
      ],
    });

    render(panelWith([thread("a"), thread("b"), thread("c")]));
    runBatch();

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 addressed"));
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("2 addressed");
    expect(status).toContain("1 skipped");
  });

  // The panel is not the only thing that moves these threads: a `CommentCard` in the stream below
  // resolves its own thread and the owner re-renders the panel with the new set. Seeding state once
  // would leave the header asserting J4's ">1 open comment" against a set it stopped tracking —
  // still counting a resolved comment as open, and still naming it as a batch target.
  it("tracks its threads when the owner supplies a new set", () => {
    const { rerender } = render(panelWith([thread("a"), thread("b")]));
    expect(screen.getByRole("button", { name: /Address all/ })).toBeTruthy();

    // One of the two is resolved elsewhere, so one open comment is left and J4's condition lapses.
    rerender(panelWith([thread("a", { resolved: true }), thread("b")]));

    expect(screen.queryByRole("button", { name: /Address all/ })).toBeNull();
  });

  // A second run launched over the first is not a state hazard — the backend re-derives eligibility
  // and skips the now-pending threads — but its accounting *overwrites* the first run's, so a user
  // who just addressed two comments is told "0 addressed · 2 skipped". That is the FR-AGENT-6
  // honesty surface reporting the opposite of what happened, so the button closes the window.
  it("does not fire a second batch while the first run is still in flight", async () => {
    let deliver: (outcome: unknown) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return new Promise((resolve) => (deliver = resolve));
      return Promise.resolve(undefined);
    });

    render(panelWith([thread("a"), thread("b")]));
    runBatch();

    // Reopening during the pending admission keeps its run control inert and named.
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    const run = screen.getByRole("button", { name: "Addressing…" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    // One admission call remains pending; a second click cannot submit another.
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([command]) => command === "start_address_run")).toHaveLength(1),
    );

    fireEvent.click(run);

    expect(invokeMock.mock.calls.filter(([command]) => command === "start_address_run")).toHaveLength(1);
    deliver({
      run: { id: "run-1", queuedPosition: null },
      progress: { addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null },
      threads: [],
    });
  });

  // …but the run's own refreshed threads must outlive a re-render that carries the *same* prop, or
  // the resync immediately reverts the transitions the batch just made.
  it("keeps the run's refreshed threads across a re-render with an unchanged prop", async () => {
    backendReturning({
      run_id: "run-1",
      addressed: ["a", "b"],
      skipped: [],
      untouched: [],
      interrupted: null,
      threads: [thread("a", { pending_run: "run-1" }), thread("b", { pending_run: "run-1" })],
    });

    const seed = [thread("a"), thread("b")];
    const { rerender } = render(panelWith(seed));
    runBatch();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 addressed"));
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    await waitFor(() => expect(screen.getByText(/2 open comments · 2 already in an agent run/)).toBeTruthy());

    rerender(panelWith(seed));

    expect(screen.getByText(/2 open comments · 2 already in an agent run/)).toBeTruthy();
  });

  // #537: J4 Batch's "one grouped-by-comment change-set card" — the deferred half of P2b-3's own
  // rendering (#398/#351): a real batch outcome now raises it, not just the header accounting.
  describe("raises J4 Batch's grouped-by-comment change-set card (#537)", () => {
    it("raises a change-set card naming every addressed comment once the run completes", async () => {
      backendReturning({
        run_id: "run-1",
        addressed: ["a", "b"],
        skipped: [],
        untouched: [],
        interrupted: null,
        threads: [thread("a", { pending_run: "run-1" }), thread("b", { pending_run: "run-1" })],
      });

      render(panelWith([thread("a"), thread("b")]));
      runBatch();

      await waitFor(() => expect(screen.getByText("ADDRESSED 2 COMMENTS · Agent")).toBeTruthy());
      const card = document.querySelector('[data-card-kind="change-set"]');
      expect(card?.getAttribute("data-card-id")).toBe("batch-address-run-1");
    });

    it("persists the raised card matching every other agent-originated card's transcript precedent (D15)", async () => {
      backendReturning({
        run_id: "run-7",
        addressed: ["a"],
        skipped: [],
        untouched: [],
        interrupted: null,
        threads: [thread("a", { pending_run: "run-7" })],
      });

      render(panelWith([thread("a"), thread("b")]));
      runBatch();

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith(
          "append_transcript_event",
          expect.objectContaining({
            root: "/project",
            event: expect.objectContaining({ kind: "change-set", id: "batch-address-run-7" }),
          }),
        ),
      );
    });

    it("skips a comment the run only skipped or left untouched — the card names what actually happened", async () => {
      backendReturning({
        run_id: "run-1",
        addressed: ["a"],
        skipped: ["b"],
        untouched: [],
        interrupted: null,
        threads: [thread("a", { pending_run: "run-1" }), thread("b")],
      });

      render(panelWith([thread("a"), thread("b")]));
      runBatch();

      await waitFor(() => expect(screen.getByText("ADDRESSED 1 COMMENT · Agent")).toBeTruthy());
    });

    it("raises no card at all when the run addressed nothing (a rejected call with every target untouched)", async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === "load_transcript") return Promise.resolve([]);
        return Promise.reject(new Error("backend went away"));
      });

      render(panelWith([thread("a"), thread("b")]));
      runBatch();

      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("stopped early"));
      expect(document.querySelector('[data-card-kind="change-set"]')).toBeNull();
    });
  });
});
// Issue #2228, ux-design.md §2's acknowledgment ladder + FR-AGENT-7. The production composition
// edge for rung 1: nothing an injected prop can prove, because the whole question is whether the
// app ever *reaches* the queued rung — the panel has to learn its own batch run queued, keep that
// fact, and hand it to the comment cards that run holds.
describe("timeline/TimelinePanel — a queued batch address reaches §2's rung 1 (issue #2228, FR-AGENT-7)", () => {
  const RUNG_1 =
    "Queued behind an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";
  const RUNG_2 =
    "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";

  /** The panel with a comment *card* in its stream as well as a comment surface — the batch header
   * runs off `commentThreads`, but the rung renders on the card, so both are needed to see the
   * whole path. */
  function panelWithCards(threads: CommentThread[], onCommentThreadsChange?: (updated: CommentThread[]) => void) {
    return (
      <TimelinePanel
        root="/project"
        commentPath="doc.md"
        commentThreads={threads}
        author="alice"
        commentNow={() => 42}
        onCommentThreadsChange={onCommentThreadsChange}
        initialCards={threads.map((t) => createCommentCard("/project", "doc.md", t, { id: `card-${t.id}` }))}
      />
    );
  }

  /** Atomic admission returns the queued position and every stamped thread together. */
  function backendQueueing(
    queuedPosition: number | null,
    threads: CommentThread[],
    extra?: (command: string, args: Record<string, unknown>) => unknown,
  ) {
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      const handled = extra?.(command, args);
      if (handled !== undefined) return handled;
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return Promise.resolve({
        run: { id: "run-q", queuedPosition },
        progress: { addressed: threads.map((t) => t.id), skipped: [], untouched: [], interrupted: null },
        threads,
      });
      return Promise.resolve(undefined);
    });
  }

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders rung 1 on every thread the queued run holds, and acknowledges the queued run itself", async () => {
    const targeted = [
      thread("a", { pending_run: "run-q", pending_run_started: false }),
      thread("b", { pending_run: "run-q", pending_run_started: false }),
    ];
    backendQueueing(1, targeted);
    render(panelWithCards([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByText(/2 addressed/)).toBeTruthy());
    expect(screen.getAllByText(RUNG_1)).toHaveLength(2);
    // Counted rather than `queryByText(...).toBeNull()`: on this surface a rung renders once per
    // targeted card, and `queryByText` throws its own multiple-match error rather than failing the
    // assertion — so the negative could not redden at the line that states it.
    expect(screen.queryAllByText(RUNG_2)).toHaveLength(0);
    // FR-AGENT-7's own half of the same fix: the queued request is visible and cancellable.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  // The near-match the rung must reject at the production edge: the identical batch, accepted
  // immediately rather than queued. `queuedPosition: null` is FR-AGENT-7's "started, not queued",
  // and claiming "queued behind" there would assert a run has not begun when it has.
  it("renders rung 2, not rung 1, when the same batch was not queued behind anything", async () => {
    const targeted = [
      thread("a", { pending_run: "run-q", pending_run_started: false }),
      thread("b", { pending_run: "run-q", pending_run_started: false }),
    ];
    backendQueueing(null, targeted);
    render(panelWithCards([thread("a"), thread("b")]));
    runBatch();

    await waitFor(() => expect(screen.getByText(/2 addressed/)).toBeTruthy());
    expect(screen.queryAllByText(RUNG_1)).toHaveLength(0);
    expect(screen.getAllByText(RUNG_2)).toHaveLength(2);
  });

  // Round-1 review finding, PR #2260. Acknowledging the queued batch is what makes [Cancel]
  // reachable for a batch address at all, and the exit is the half the acknowledgement does not
  // supply: Address admission stamped `pending_run` on every target, while a queued run is
  // cancelled by removing it from the backend deque — `StopOutcome::Cancelled`
  // with no `RunStatus`, so the run's own terminal-status path never fires. Without an exit the
  // cards assert their rung for the rest of the session and keep [Address with AI] withdrawn,
  // against ux-design.md §2's exit table ("Run stopped by the user from the run card → prior
  // state"). This presses the button and asserts what it *leaves*, which is the shape the whole
  // card exists to correct one surface over: rendering the control is not covering the path.
  it("cancelling the queued batch returns every thread it targeted to its prior state", async () => {
    const targeted = [
      thread("a", { pending_run: "run-q", pending_run_started: false }),
      thread("b", { pending_run: "run-q", pending_run_started: false }),
    ];
    // What `conclude_address_run` gives back once the run is concluded on each thread: the run is
    // gone, so both recompute to Open — §2's "prior state".
    const cleared = [thread("a"), thread("b")];
    const concludedThreadIds: string[] = [];
    backendQueueing(1, targeted, (command, args) => {
      if (command === "stop_run") return Promise.resolve("cancelled");
      if (command === "conclude_address_run") {
        concludedThreadIds.push(args.threadId as string);
        return Promise.resolve(cleared);
      }
      return undefined;
    });

    render(panelWithCards([thread("a"), thread("b")]));
    runBatch();
    await waitFor(() => expect(screen.getAllByText(RUNG_1)).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // The threads recompute — not merely that the button existed to press.
    await waitFor(() => expect(screen.queryAllByText(RUNG_1)).toHaveLength(0));
    expect(screen.queryAllByText(RUNG_2)).toHaveLength(0);
    // §2: when the request ends "the run-starting affordances return".
    expect(screen.getAllByRole("button", { name: "Address with AI" })).toHaveLength(2);
    // Every thread the run held, not just the first — a batch shares one run id across all of them.
    expect(concludedThreadIds).toEqual(["a", "b"]);
  });


});

// FR-X-5: rejected atomic admission leaves no run and reports the backend reason in the batch
// status. Typed errors, plain Errors, and strings take the same `errorDetail` route.
describe("timeline/TimelinePanel — rejected Address admission", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  async function reasonAfterRejecting(rejection: unknown): Promise<string> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return Promise.reject(rejection);
      return Promise.resolve(undefined);
    });
    render(panelWith([thread("a"), thread("b")]));
    runBatch();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("stopped early"));
    return screen.getByRole("status").textContent ?? "";
  }

  it("renders a typed CommandError's own message with every target untouched", async () => {
    const status = await reasonAfterRejecting({ kind: "InvalidArguments", message: "target escapes the project root" });
    expect(status).toContain("0 addressed · 2 untouched");
    expect(status).toContain("— stopped early: target escapes the project root");
  });

  it("renders a thrown Error's message", async () => {
    expect(await reasonAfterRejecting(new Error("backend went away"))).toContain(
      "— stopped early: backend went away",
    );
  });

  it("renders a bare string rejection", async () => {
    expect(await reasonAfterRejecting("backend went away")).toContain("— stopped early: backend went away");
  });

  it("keeps the no-detail fallback for a rejection with no message", async () => {
    expect(await reasonAfterRejecting({})).toContain("— stopped early: [object Object]");
  });
});
