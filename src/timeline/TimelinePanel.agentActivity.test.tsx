// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a integration (#345) acceptance criteria: TimelinePanel
// ABOUTME: `listen()`s for `agent://activity`, folds pushes into one agent-working card per run
// ABOUTME: (never a second card for the same run), wires [Stop] to `stop_run`, and never *force*-
// ABOUTME: scrolls a reader who has scrolled up — but tail-follows one still at the tail (P2b-1c).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStatus } from "./agentActivity";
import type { TimelineCard } from "./types";
import { thread } from "../comments/threadFixture";
import { sizeContainer } from "./virtualListTestUtils";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const { TimelinePanel } = await import("./TimelinePanel");

const ITEM_HEIGHT = 96;
const CONTAINER_HEIGHT = 600;

function manyChatCards(count: number): TimelineCard[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    kind: "chat-message" as const,
    author: i % 2 === 0 ? "user" : "agent",
    body: `message ${i}`,
    timestamp: "2026-07-15T00:00:00.000Z",
  }));
}

/** Fires `status` through whatever handler TimelinePanel's mount-time `listen()` call registered
 * — the same push shape `TauriActivityEmitter` sends, `{ payload }` per Tauri's event envelope. */
function pushStatus(status: RunStatus) {
  const calls = listenMock.mock.calls;
  const handler = calls[calls.length - 1][1] as (event: { payload: RunStatus }) => void;
  act(() => handler({ payload: status }));
}

function running(overrides: Partial<RunStatus> = {}): RunStatus {
  return { id: "run-1", phase: { phase: "running" }, activity: [], elapsedSecs: 0, ...overrides };
}

describe("timeline/TimelinePanel — agent activity streaming (P2a integration #345)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
  });

  it("#2539 persists a terminal batch only after its submit-time J13 disclosure is attached", async () => {
    let admit!: (response: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return new Promise((resolve) => { admit = resolve; });
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a"), thread("b")]}
      openDocuments={() => ({ active: { path: "doc.md", dirty: true, content: "edited" }, alsoOpen: [] })} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Address 2 comments" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_address_run", expect.anything()));

    pushStatus(running({ id: "batch-race", phase: { phase: "completed", reply: null } }));
    expect(invokeMock.mock.calls.filter(([command]) => command === "append_transcript_event")).toHaveLength(0);

    await act(async () => admit({
      run: { id: "batch-race", queuedPosition: null },
      progress: { addressed: ["a", "b"], skipped: [], untouched: [], interrupted: null },
      threads: [],
    }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
      root: "/project",
      event: expect.objectContaining({
        runId: "batch-race",
        outboundContext: "carried doc.md as edited",
      }),
    }));
  });

  it("#2539 persists an unrelated known run while batch admission is still pending", async () => {
    let admit!: (response: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return new Promise((resolve) => { admit = resolve; });
      return Promise.resolve(undefined);
    });
    const priorRun = {
      id: "other-run",
      kind: "agent-working" as const,
      runId: "other-run",
      phase: { phase: "running" as const },
      activity: [],
      elapsedSecs: 0,
      timestamp: "2026-09-14T00:00:00.000Z",
    };
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a"), thread("b")]}
      initialCards={[priorRun]} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Address 2 comments" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_address_run", expect.anything()));

    pushStatus(running({ id: "other-run", phase: { phase: "completed", reply: null } }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
      root: "/project",
      event: expect.objectContaining({ runId: "other-run", phase: { phase: "completed", reply: null } }),
    }));
    expect(admit).toBeTypeOf("function");
  });

  it("#2539 flushes a separately admitted run whose terminal push beat its own acknowledgement", async () => {
    let admitOther!: (response: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return new Promise(() => {});
      if (command === "start_run") return new Promise((resolve) => { admitOther = resolve; });
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a"), thread("b")]} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Address 2 comments" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_address_run", expect.anything()));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Another run" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_run", expect.anything()));

    pushStatus(running({ id: "other-late", phase: { phase: "completed", reply: null } }));
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "append_transcript_event" && args.event?.runId === "other-late"))
      .toHaveLength(0);
    await act(async () => admitOther({ id: "other-late", queuedPosition: null }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
      root: "/project",
      event: expect.objectContaining({ runId: "other-late", phase: { phase: "completed", reply: null } }),
    }));
  });

  it("subscribes to agent://activity on mount", () => {
    render(<TimelinePanel />);
    expect(listenMock).toHaveBeenCalledWith("agent://activity", expect.any(Function));
  });

  it("appends an agent-working card the first time a run's status is pushed", async () => {
    render(<TimelinePanel />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }], elapsedSecs: 3 }));

    expect(screen.getByText("Reading claude.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("holds a run reveal request until its card arrives, then focuses the card article without announcing", async () => {
    const onRunRevealConsumed = vi.fn();
    const { container } = render(
      <TimelinePanel
        initialCards={manyChatCards(30)}
        runRevealRequest={{ runId: "run-late", nonce: 1 }}
        onRunRevealConsumed={onRunRevealConsumed}
      />,
    );
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    const list = sizeContainer(container, 300);

    expect(onRunRevealConsumed).not.toHaveBeenCalled();
    pushStatus(running({ id: "run-late" }));

    const card = container.querySelector<HTMLElement>('[data-card-id="run-late"]');
    await waitFor(() => expect(card).toHaveFocus());
    expect(screen.getByRole("button", { name: "Stop" })).not.toHaveFocus();
    expect(onRunRevealConsumed).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(list.scrollTop).toBe(30 * ITEM_HEIGHT);
  });

  it("preserves a facet that contains the requested run and falls back to All only when it does not", async () => {
    const runCard = {
      id: "run-visible",
      kind: "agent-working" as const,
      runId: "run-visible",
      phase: { phase: "running" as const },
      activity: [],
      elapsedSecs: 0,
      timestamp: "2026-09-14T00:00:00.000Z",
    };
    const { rerender } = render(<TimelinePanel initialCards={[runCard]} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    rerender(<TimelinePanel initialCards={[runCard]} runRevealRequest={{ runId: "run-visible", nonce: 1 }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    rerender(<TimelinePanel initialCards={[runCard]} runRevealRequest={{ runId: "run-visible", nonce: 2 }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("re-reveals only for a fresh nonce and still targets the same card when it finishes in the race", async () => {
    const request = { runId: "run-race", nonce: 1 };
    const { container, rerender } = render(<TimelinePanel runRevealRequest={request} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    pushStatus(running({ id: "run-race" }));
    const card = container.querySelector<HTMLElement>('[data-card-id="run-race"]');
    await waitFor(() => expect(card).toHaveFocus());

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    rerender(<TimelinePanel runRevealRequest={{ ...request }} />);
    expect(outside).toHaveFocus();

    pushStatus(running({ id: "run-race", phase: { phase: "completed", reply: null } }));
    rerender(<TimelinePanel runRevealRequest={{ runId: "run-race", nonce: 2 }} />);
    await waitFor(() => expect(card).toHaveFocus());
    expect(card).toHaveClass("timeline-card--collapsed");
    outside.remove();
  });

  it("reports a watched blocking run exactly once when its card becomes terminal", async () => {
    const onWatchedRunTerminal = vi.fn();
    const { rerender } = render(
      <TimelinePanel watchedRunId="run-blocking" onWatchedRunTerminal={onWatchedRunTerminal} />,
    );
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ id: "run-blocking" }));
    expect(onWatchedRunTerminal).not.toHaveBeenCalled();

    pushStatus(running({
      id: "run-blocking",
      phase: { phase: "completed", reply: null },
    }));
    await waitFor(() => expect(onWatchedRunTerminal).toHaveBeenCalledWith("run-blocking"));

    rerender(
      <TimelinePanel watchedRunId="run-blocking" onWatchedRunTerminal={onWatchedRunTerminal} />,
    );
    expect(onWatchedRunTerminal).toHaveBeenCalledTimes(1);
  });

  it("updates the same card in place on a later push for the same run id — never minting a second one", async () => {
    const { container } = render(<TimelinePanel />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }] }));
    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }, { verb: "Drafting" }] }));

    expect(container.querySelectorAll('[data-card-kind="agent-working"]').length).toBe(1);
    expect(screen.getByText("Reading claude.md")).toBeTruthy();
    expect(screen.getByText("Drafting…")).toBeTruthy();
  });

  it("persists one exact terminal run snapshot through D15 but never a live intermediate snapshot (#1725)", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" now={() => "2026-08-31T01:02:03.000Z"} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(
      running({
        id: "run-durable",
        activity: [{ verb: "Reading", detail: "sermon.md" }],
        elapsedSecs: 3,
      }),
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "append_transcript_event")).toHaveLength(0);

    const terminal = running({
      id: "run-durable",
      phase: { phase: "completed", reply: null },
      activity: [
        { verb: "Reading", detail: "sermon.md" },
        { verb: "Editing", detail: "notes/outline.md" },
      ],
      elapsedSecs: 17,
    });
    pushStatus(terminal);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
        root: "/project",
        event: {
          schema_version: 1,
          id: "run-durable",
          kind: "agent-working",
          runId: "run-durable",
          phase: { phase: "completed", reply: null },
          activity: [
            { verb: "Reading", detail: "sermon.md" },
            { verb: "Editing", detail: "notes/outline.md" },
          ],
          elapsedSecs: 17,
          timestamp: "2026-08-31T01:02:03.000Z",
        },
      }),
    );

    pushStatus(terminal);
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([command]) => command === "append_transcript_event")).toHaveLength(1),
    );
  });

  it("dedupes a terminal append raced by initial D15 rehydrate and keeps the newer live run snapshot (#1725)", async () => {
    let resolveLoad: (events: unknown[]) => void = () => {};
    let appendedEvent: unknown;
    invokeMock.mockImplementation((command: string, args?: { event?: unknown }) => {
      if (command === "load_transcript") return new Promise((resolve) => (resolveLoad = resolve));
      if (command === "append_transcript_event") appendedEvent = args?.event;
      return Promise.resolve(undefined);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <TimelinePanel root="/project" now={() => "2026-08-31T01:02:03.000Z"} />,
    );
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(
      running({
        id: "run-rehydrate-race",
        phase: { phase: "completed", reply: null },
        activity: [{ verb: "Reading", detail: "sermon.md" }],
        elapsedSecs: 17,
      }),
    );
    await waitFor(() => expect(appendedEvent).toBeDefined());

    // A newer live push may land after the durable terminal snapshot was appended but before the
    // mount-time read returns. The exact appended event is therefore older than the in-memory card.
    pushStatus(
      running({
        id: "run-rehydrate-race",
        phase: { phase: "completed", reply: null },
        activity: [
          { verb: "Reading", detail: "sermon.md" },
          { verb: "Editing", detail: "notes/outline.md" },
        ],
        elapsedSecs: 19,
      }),
    );
    expect(screen.getByText(/Completed 0:19/)).toBeTruthy();

    act(() => resolveLoad([appendedEvent]));

    await waitFor(() =>
      expect(container.querySelectorAll('[data-card-kind="agent-working"]')).toHaveLength(1),
    );
    expect(screen.getByText(/Completed 0:19/)).toBeTruthy();
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    consoleError.mockRestore();
  });

  async function expectTerminalPersistence(phase: RunStatus["phase"]) {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" now={() => "2026-08-31T01:02:03.000Z"} />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ id: `run-${phase.phase}`, phase }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
        root: "/project",
        event: expect.objectContaining({
          kind: "agent-working",
          runId: `run-${phase.phase}`,
          phase,
        }),
      }),
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "append_transcript_event")).toHaveLength(1);
  }

  it("persists one stopped terminal run snapshot through D15", async () => {
    await expectTerminalPersistence({ phase: "stopped", delivered: false });
  });

  it("persists one failed terminal run snapshot through D15", async () => {
    await expectTerminalPersistence({ phase: "failed", message: "provider exited" });
  });

  it("wires a working card's Stop button to the stop_run command with its run id", async () => {
    invokeMock.mockResolvedValue("stopped");
    render(<TimelinePanel />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ id: "run-42" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(invokeMock).toHaveBeenCalledWith("stop_run", { runId: "run-42" });
  });

  it("renders each terminal state honestly once a run resolves (ux-design.md §2/J7)", async () => {
    render(<TimelinePanel />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    pushStatus(running({ id: "run-completed", phase: { phase: "completed", reply: null } }));
    expect(screen.getByText(/Completed/)).toBeTruthy();

    pushStatus(running({ id: "run-stopped-clean", phase: { phase: "stopped", delivered: false } }));
    expect(screen.getByText(/STOPPED — nothing applied/)).toBeTruthy();

    pushStatus(running({ id: "run-stopped-partial", phase: { phase: "stopped", delivered: true } }));
    expect(screen.getByText(/STOPPED — partial delivery/)).toBeTruthy();

    pushStatus(running({ id: "run-failed", phase: { phase: "failed", message: "claude exited" } }));
    expect(screen.getByText(/Agent stopped unexpectedly/)).toBeTruthy();
  });

  // Issue #1118 / J2 ("agent asks a clarifying question instead of drafting — normal chat, no
  // special UI") / Principle 5 (one stream, both directions): a completed run's `reply` is the
  // answer the user asked for. Before this, the only thing a chat question produced was an
  // activity card — `createChatMessageCard("agent", …)` had no production caller at all.
  describe("agent reply (#1118)", () => {
    it("renders one durable continuity-loss notice before a recovered turn's reply (#2064)", async () => {
      const { container } = render(<TimelinePanel root="/project" />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      const terminal = running({
        id: "run-recovered",
        phase: { phase: "recovered", reply: "Fresh answer." },
      });
      pushStatus(terminal);
      pushStatus(terminal);

      const chatCards = [...container.querySelectorAll('[data-card-kind="chat-message"]')];
      expect(chatCards).toHaveLength(2);
      expect(chatCards[0].textContent).toContain(
        "Couldn’t resume the previous agent session. A new session was started; your conversation history is still visible.",
      );
      expect(chatCards[1].textContent).toContain("Fresh answer.");
      await waitFor(() =>
        expect(invokeMock.mock.calls.filter(([command]) => command === "append_transcript_event")).toHaveLength(2),
      );
    });

    it("renders a completed run's reply as an agent chat card after that run's activity card", async () => {
      const { container } = render(<TimelinePanel />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      pushStatus(running({ id: "run-7", activity: [{ verb: "Reading", detail: "sermon.md" }] }));
      pushStatus(
        running({
          id: "run-7",
          activity: [{ verb: "Reading", detail: "sermon.md" }],
          phase: { phase: "completed", reply: "The sermon argues that grace precedes obedience." },
        }),
      );

      expect(screen.getByText("The sermon argues that grace precedes obedience.")).toBeTruthy();
      expect(screen.getByText("Agent")).toBeTruthy();
      // Stream order (D4/D6): the reply follows the activity card it belongs to, never precedes it.
      const kinds = [...container.querySelectorAll("[data-card-kind]")].map((el) =>
        el.getAttribute("data-card-kind"),
      );
      expect(kinds).toEqual(["agent-working", "chat-message"]);
    });

    // J2's grounding chip (#1391): the reply card carries `[refs: N files read]`, derived from the
    // same run's own activity feed — distinct paths, not activity lines.
    it("carries J2's refs chip on the reply, counting distinct read files off the run's own activity", async () => {
      const { container } = render(<TimelinePanel />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      pushStatus(
        running({
          id: "run-grounded",
          activity: [
            { verb: "Reading", detail: "sermon.md" },
            { verb: "Reading", detail: "sermon.md" },
            { verb: "Reading", detail: "notes/outline.md" },
            { verb: "Drafting" },
          ],
          phase: { phase: "completed", reply: "Strong angle." },
        }),
      );

      expect(screen.getByText("refs: 2 files read")).toBeTruthy();
      expect(container.querySelectorAll('[data-card-kind="chat-message"]').length).toBe(1);
    });

    // J2's edge state ("agent asks a clarifying question instead of drafting — normal chat, no
    // special UI"): an answerless-of-grounding reply renders no chip at all, not a "0 files read".
    it("carries no refs chip when the run's activity read nothing", async () => {
      render(<TimelinePanel />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      pushStatus(
        running({
          id: "run-ungrounded",
          activity: [{ verb: "Drafting" }],
          phase: { phase: "completed", reply: "Could you say more?" },
        }),
      );

      expect(screen.getByText("Could you say more?")).toBeTruthy();
      expect(screen.queryByText(/refs:/)).toBeNull();
    });

    it("never mints a second reply card when the same terminal status is pushed again", async () => {
      const { container } = render(<TimelinePanel />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      const terminal = running({ id: "run-7", phase: { phase: "completed", reply: "Answered." } });
      pushStatus(terminal);
      pushStatus(terminal);

      expect(container.querySelectorAll('[data-card-kind="chat-message"]').length).toBe(1);
    });

    it("mints no chat card for a run with no prose or one that never completed", async () => {
      const { container } = render(<TimelinePanel />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());

      pushStatus(running({ id: "run-silent", phase: { phase: "completed", reply: null } }));
      pushStatus(running({ id: "run-stopped", phase: { phase: "stopped", delivered: false } }));
      pushStatus(running({ id: "run-failed", phase: { phase: "failed", message: "claude exited" } }));
      pushStatus(running({ id: "run-live", activity: [{ verb: "Drafting" }] }));

      expect(container.querySelectorAll('[data-card-kind="chat-message"]').length).toBe(0);
    });
  });

  it("unsubscribes on unmount", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const { unmount } = render(<TimelinePanel />);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it("does not expose an in-process agent-activity producer through the D23 test harness (#1826)", () => {
    render(<TimelinePanel />);
    expect("notifyAgentActivity" in (window.__COWRITE_E2E__ ?? {})).toBe(false);
  });

  it("does not force-scroll a scrolled-up reader when an activity push arrives (Principle 2)", async () => {
    const { container } = render(<TimelinePanel initialCards={manyChatCards(200)} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    // Reader scrolls up to read history, away from the bottom of the stream.
    fireEvent.scroll(list, { target: { scrollTop: ITEM_HEIGHT * 10 } });
    expect(list.scrollTop).toBe(ITEM_HEIGHT * 10);

    // A brand-new working card arrives, then it updates in place — neither ever auto-scrolls.
    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }] }));
    expect(list.scrollTop).toBe(ITEM_HEIGHT * 10);
    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }, { verb: "Drafting" }] }));
    expect(list.scrollTop).toBe(ITEM_HEIGHT * 10);
  });

  it("tail-follows a reader still at the tail when a brand-new activity card arrives (P2b-1c / UXR-Q2)", async () => {
    const { container } = render(<TimelinePanel initialCards={manyChatCards(200)} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());

    // Reader stays at the tail — sizeContainer already leaves scrollTop at 0, so scroll there.
    const maxScrollTop = 200 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    fireEvent.scroll(list, { target: { scrollTop: maxScrollTop } });
    expect(list.scrollTop).toBe(maxScrollTop);

    // A brand-new working card appends — this is not the user's own submit, so it's `VirtualList`'s
    // generic tail-follow (not `handleSubmit`'s explicit scrollRequest) that carries the reader.
    pushStatus(running({ activity: [{ verb: "Reading", detail: "claude.md" }] }));

    const newMaxScrollTop = 201 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    expect(list.scrollTop).toBe(newMaxScrollTop);
  });
});
