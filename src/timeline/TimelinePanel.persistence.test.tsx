// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a-17 acceptance criteria (issue #161, D15): given a
// ABOUTME: project `root`, TimelinePanel rehydrates its prior history on mount and persists every
// ABOUTME: newly submitted card to the local transcript store.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentWorkingCard, createProjectGroundingCard, type TimelineCard } from "./types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
// TimelinePanel's P2a integration (#345) agent-activity subscription calls `listen()` on mount
// whenever `isTauri()` is true — stubbed inert here since this suite exercises transcript
// persistence, not activity streaming (see `TimelinePanel.agentActivity.test.tsx` for that).
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

const { TimelinePanel } = await import("./TimelinePanel");

const PERSISTED_CARD: TimelineCard = {
  id: "card-persisted",
  kind: "chat-message",
  author: "agent",
  body: "welcome back",
  timestamp: "2026-07-15T00:00:00.000Z",
};

describe("timeline/TimelinePanel — local transcript persistence (P2a-17)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("rehydrates its prior history from the transcript store on mount when given a root", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") {
        return Promise.resolve([{ schema_version: 1, ...PERSISTED_CARD }]);
      }
      return Promise.resolve(undefined);
    });

    render(<TimelinePanel root="/project" />);

    await waitFor(() => expect(screen.getByText("welcome back")).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" });
  });

  it("prepends rehydrated history before any seed cards already passed in", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") {
        return Promise.resolve([{ schema_version: 1, ...PERSISTED_CARD }]);
      }
      return Promise.resolve(undefined);
    });
    const seed: TimelineCard = {
      id: "seed-1",
      kind: "chat-message",
      author: "user",
      body: "seeded message",
      timestamp: "2026-07-15T00:01:00.000Z",
    };

    const { container } = render(<TimelinePanel root="/project" initialCards={[seed]} />);

    await waitFor(() => expect(screen.getByText("welcome back")).toBeTruthy());
    expect(screen.getByText("seeded message")).toBeTruthy();
    expect([...container.querySelectorAll('[data-card-kind="chat-message"]')].map((card) => card.textContent)).toEqual([
      expect.stringContaining("welcome back"),
      expect.stringContaining("seeded message"),
    ]);
  });

  it("uses stable run identity when a rehydrated agent row was re-keyed and keeps the live snapshot", async () => {
    const historical = {
      schema_version: 1,
      ...createAgentWorkingCard(
        {
          id: "run-stable",
          phase: { phase: "completed" as const, reply: null },
          activity: [{ verb: "Reading", detail: "older.md" }],
          elapsedSecs: 17,
        },
        { id: "run-stable#2", timestamp: "2026-07-15T00:00:00.000Z" },
      ),
    };
    const live = createAgentWorkingCard(
      {
        id: "run-stable",
        phase: { phase: "completed", reply: null },
        activity: [{ verb: "Reading", detail: "newer.md" }],
        elapsedSecs: 19,
      },
      { timestamp: "2026-07-15T00:01:00.000Z" },
    );
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "load_transcript" ? [historical] : undefined),
    );

    const { container } = render(<TimelinePanel root="/project" initialCards={[live]} />);

    await waitFor(() =>
      expect(container.querySelectorAll('[data-card-kind="agent-working"]')).toHaveLength(1),
    );
    expect(screen.getByText(/Completed 0:19/)).toBeTruthy();
    expect(screen.queryByText(/Completed 0:17/)).toBeNull();
  });

  // ux-design §2 "Timeline facet empty states" (#1727, review round 2): an empty claim about a
  // project's history may only follow a *settled* answer, never the merely-not-yet-loaded state
  // rehydrate starts every mount with a root in.
  it("does not show the empty-facet message while the initial transcript load for this root is still in flight", async () => {
    let resolveLoad: (events: unknown[]) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return new Promise((resolve) => (resolveLoad = resolve));
      return Promise.resolve(undefined);
    });

    render(<TimelinePanel root="/project" />);

    // The rehydrate is still pending: the stream is empty, but that has not yet been established
    // as the settled truth, so no empty claim may appear.
    expect(screen.queryByText("No activity yet")).toBeNull();

    resolveLoad([]);
    // The rehydrate has now genuinely found nothing — the settled empty claim is correct here.
    await waitFor(() => expect(screen.getByText("No activity yet")).toBeTruthy());
  });

  it("does not flash a false empty-facet message over a project's actual history on first paint", async () => {
    let resolveLoad: (events: unknown[]) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return new Promise((resolve) => (resolveLoad = resolve));
      return Promise.resolve(undefined);
    });

    render(<TimelinePanel root="/project" />);
    expect(screen.queryByText("No activity yet")).toBeNull();

    resolveLoad([{ schema_version: 1, ...PERSISTED_CARD }]);
    await waitFor(() => expect(screen.getByText("welcome back")).toBeTruthy());
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("shows the ratified unavailable state instead of a false empty claim when transcript rehydrate fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.reject(new Error("disk unavailable"));
      return Promise.resolve(undefined);
    });

    render(<TimelinePanel root="/project" />);

    await screen.findByText("Activity unavailable");
    expect(screen.getByText("Earlier activity could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("retries transcript rehydration only and restores history after a successful retry", async () => {
    let loadAttempts = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command !== "load_transcript") return Promise.resolve(undefined);
      loadAttempts += 1;
      return loadAttempts === 1
        ? Promise.reject(new Error("disk unavailable"))
        : Promise.resolve([{ schema_version: 1, ...PERSISTED_CARD }]);
    });

    render(<TimelinePanel root="/project" />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await screen.findByText("welcome back");
    expect(screen.queryByText("Activity unavailable")).toBeNull();
    expect(screen.queryByText("Earlier activity could not be loaded.")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === "load_transcript")).toEqual([
      ["load_transcript", { root: "/project" }],
      ["load_transcript", { root: "/project" }],
    ]);
    expect(invokeMock.mock.calls.filter(([command]) => command === "permission_state")).toHaveLength(1);
  });

  it("rehydrates a pre-#1728 history whose events share one id as separate, distinctly keyed rows", async () => {
    // Every id the pre-#1728 module counter minted restarted with the process, so a store written
    // across three launches carries one id on three genuinely different cards (D15). The stream
    // keys its rows by card id, so rehydrating them raw is a duplicate React key — the reconciler
    // then cannot rebuild the list when the filtered set changes (#1727).
    const collided = [
      ["first launch", "2026-07-15T00:00:00.000Z"],
      ["second launch", "2026-07-16T00:00:00.000Z"],
      ["third launch", "2026-07-17T00:00:00.000Z"],
    ].map(([body, timestamp]) => ({ schema_version: 1, ...PERSISTED_CARD, id: "chat-message-1", body, timestamp }));
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "load_transcript" ? collided : undefined),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<TimelinePanel root="/project" />);

    await waitFor(() => expect(screen.getByText("third launch")).toBeTruthy());
    expect(screen.getByText("first launch")).toBeTruthy();
    expect(screen.getByText("second launch")).toBeTruthy();
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    consoleError.mockRestore();
  });

  it("does not call the backend at all without a root (purely in-memory like P2a-16)", () => {
    render(<TimelinePanel />);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("persists a newly submitted card to the transcript store when a root is given", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" createId={() => "new-card"} now={() => "2026-07-15T00:02:00.000Z"} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello from the user" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
        root: "/project",
        event: {
          schema_version: 1,
          id: "new-card",
          kind: "chat-message",
          author: "user",
          body: "hello from the user",
          timestamp: "2026-07-15T00:02:00.000Z",
        },
      }),
    );
  });

  it("keeps in-memory activity visible alongside the unavailable state after rehydrate fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.reject(new Error("disk unavailable"));
      return Promise.resolve(undefined);
    });
    const seed: TimelineCard = {
      id: "seed-1",
      kind: "chat-message",
      author: "user",
      body: "seeded message",
      timestamp: "2026-07-15T00:01:00.000Z",
    };

    render(<TimelinePanel root="/project" initialCards={[seed]} />);

    await screen.findByText("Activity unavailable");
    // The seed card the caller already had stays put beside the unavailable treatment — a failed
    // rehydrate never crashes, wipes the stream, or turns the unknown history into a true-empty claim.
    expect(screen.getByText("seeded message")).toBeTruthy();
    expect(screen.getByText("Earlier activity could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  // The grounding card is session-scoped state — "what grounding the agent has right now" — not
  // conversation history (#1718): App's own [project]-keyed effect raises a fresh one on every
  // open, so persisting it would accumulate one copy per open forever (CJ's own transcript held
  // eight). A deliberate narrowing of the D15 "agent-originated card is part of conversation
  // history" precedent this same effect's own comment documents.
  it("does not persist a project-grounding card delivered via incomingCards (#1718)", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const grounding = createProjectGroundingCard([], [], undefined, { id: "grounding-1" });

    render(<TimelinePanel root="/project" incomingCards={[grounding]} />);

    await screen.findByText("Found 0 skills, 0 workflows");
    // Give any queued persistence microtask a turn before asserting its absence.
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith("append_transcript_event", expect.anything());
  });

  // A rehydrated grounding card is also stale (its skill/workflow counts can change between
  // opens), so a store already holding one from a pre-fix launch must not add to what a fresh
  // discovery raises on this open — `timeline/ipc.ts`'s `loadTranscript` drops every persisted
  // `project-grounding` event on read, independent of the write-side exclusion above.
  it("shows exactly one project-grounding card when a stale persisted one rehydrates alongside a fresh one (#1718)", async () => {
    const persisted = {
      schema_version: 1,
      ...createProjectGroundingCard([{ name: "grammar", description: "Fixes grammar." }], [], undefined, {
        id: "project-grounding-1",
        timestamp: "2026-07-15T00:00:00.000Z",
      }),
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([persisted]);
      return Promise.resolve(undefined);
    });
    const fresh = createProjectGroundingCard([], [], undefined, { id: "grounding-fresh" });

    render(<TimelinePanel root="/project" incomingCards={[fresh]} />);

    // The fresh (zero-count) card, not the stale persisted one-skill card, is what's visible.
    await screen.findByText("Found 0 skills, 0 workflows");
    expect(screen.queryByText("Found 1 skill, 0 workflows")).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-card-kind="project-grounding"]')).toHaveLength(1);
  });

  it("a persist failure does not crash the panel or roll back the optimistic append", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "append_transcript_event") return Promise.reject(new Error("disk full"));
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" createId={() => "new-card"} now={() => "2026-07-15T00:02:00.000Z"} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello from the user" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", expect.anything()));
    // The card the user just sent stays visible in the in-memory stream even though persisting it
    // failed — a store write failure must never look to the user like their message vanished.
    expect(screen.getByText("hello from the user")).toBeTruthy();
  });
});
