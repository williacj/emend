// @vitest-environment jsdom
// ABOUTME: Component-level proof of #696 (P2a integration, the 4th orphaned seam of #344): the
// ABOUTME: The composer's `start_run` integration, including FR-AGENT-7's immediate cancellable
// ABOUTME: queued acknowledgement, live-activity reconciliation, and honest rejected-call state —
// ABOUTME: and (#1777) the same honest state for a thread card's own [Address with AI].
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { thread } from "../comments/threadFixture";
import type { OpenDocumentsSnapshot } from "./referenceData";
import {
  lastStartRunPayload,
  openDocumentsEnvelopeIn,
  parseReferenceData,
  type StartRunPayload,
} from "./referenceDataTestUtils";
import { createCommentCard } from "./types";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
// TimelinePanel's P2a integration (#345) agent-activity subscription calls `listen()` on mount
// whenever `isTauri()` is true. This suite captures that production listener directly; D23's
// `/run_state` polling behavior lives in `agentActivity.test.ts` and the browser acceptance suite.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const { TimelinePanel } = await import("./TimelinePanel");

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function pushStatus(status: object) {
  const calls = listenMock.mock.calls;
  const handler = calls[calls.length - 1][1] as (event: { payload: object }) => void;
  act(() => handler({ payload: status }));
}

/** The payload the most recent real `start_run` invocation carried. This suite drives the *real*
 * `agentActivity.startRun` against a mocked Tauri boundary, so this is literally what reaches the
 * command — the only vantage point from which #1724's "the prompt names the open document" claim
 * is falsifiable (FR-CHAT-4). */
function startRunArgs(): StartRunPayload {
  return lastStartRunPayload(invokeMock.mock.calls);
}

describe("timeline/TimelinePanel — composer submits actually start a run (#696)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_run") return Promise.resolve({ id: "run-1", queuedPosition: null });
      return Promise.resolve(undefined);
    });
  });

  // Restated from "an ordinary unquoted message reaches start_run byte-for-byte unchanged —
  // FR-CHAT-3" by #1724/FR-CHAT-4 (D30 amends FR-CHAT-3 in place): an ordinary message no longer
  // reaches `start_run` as the user's bare text, because every submitted run now names the open
  // documents. What survives is the half that still binds — the user's own request leads the prompt
  // unchanged, and no quoted-selection envelope rides an unquoted message.
  it("an ordinary unquoted message reaches start_run as the user's own text plus the open-document envelope — FR-CHAT-3 as amended by D30", async () => {
    render(
      <TimelinePanel
        root="/project"
        operationTargets={["draft.md"]}
        openDocuments={() => ({ active: { path: "draft.md", dirty: false }, alsoOpen: [] })}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("draft the opening section");

    await waitFor(() => expect(startRunArgs()).toBeDefined());
    const { root, prompt, operationTargets } = startRunArgs();
    expect(root).toBe("/project");
    expect(operationTargets).toEqual(["draft.md"]);
    expect(prompt.startsWith("draft the opening section\n\n")).toBe(true);
    expect(prompt).not.toContain('"kind":"quoted_selection"');
    expect(openDocumentsEnvelopeIn(prompt)).toEqual({
      cowrite_context_version: 1,
      kind: "open_documents",
      active: { path: "draft.md", unsaved: false },
      also_open: [],
    });
  });

  // The load-bearing seam assertion for #1724, driven from the real composer through the real
  // `startRun`: a `promptWithReferenceData` unit test alone passes against a caller that never
  // supplies the documents, which is exactly what shipped before this card.
  it("names the document the user is looking at in the prompt reaching start_run — the defect #1724 reported", async () => {
    render(
      <TimelinePanel
        root="/project"
        operationTargets={["drafts/a-commandment.md"]}
        openDocuments={() => ({
          active: { path: "drafts/a-commandment.md", dirty: true, content: "# A Commandment\n" },
          alsoOpen: [{ path: "notes/outline.md", dirty: false }],
        })}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("Summarize this message.");

    await waitFor(() => expect(startRunArgs()).toBeDefined());
    expect(openDocumentsEnvelopeIn(startRunArgs().prompt)).toEqual({
      cowrite_context_version: 1,
      kind: "open_documents",
      active: { path: "drafts/a-commandment.md", unsaved: true, content: "# A Commandment\n" },
      also_open: [{ path: "notes/outline.md", unsaved: false }],
    });
  });

  it("folds a later agent://activity push into a working card keyed on the id start_run returned — one continuous flow not two independent mechanisms", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("draft the opening section");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_run", expect.anything()));

    // The run this exact submit started (`run-1`, per this suite's `start_run` stub) is what a
    // later push must key its working card on — not a coincidentally-timed unrelated id.
    pushStatus({
      id: "run-1",
      phase: { phase: "running" },
      activity: [{ verb: "Reading", detail: "claude.md" }],
      elapsedSecs: 1,
    });

    expect(screen.getByText("Reading claude.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("does not regress a run to queued when its live running push beats the start_run response", async () => {
    let resolveStart!: (value: { id: string; queuedPosition: number }) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_run") {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("queued briefly");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_run", expect.anything()));
    pushStatus({
      id: "run-race",
      phase: { phase: "running" },
      activity: [{ verb: "Drafting" }],
      elapsedSecs: 1,
    });
    act(() => resolveStart({ id: "run-race", queuedPosition: 1 }));

    await waitFor(() => expect(screen.getByText("Drafting…")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByText(/queued behind an agent run/)).toBeNull();
  });

  it("does not call start_run without a project root — pre-document brainstorm FR-CHAT-1", () => {
    render(<TimelinePanel />);
    send("just thinking out loud");
    expect(invokeMock).not.toHaveBeenCalledWith("start_run", expect.anything());
  });

  it("a second submit while a run is active still calls start_run — FR-AGENT-7 queues it and the composer never silently drops it", async () => {
    let starts = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_run") {
        starts += 1;
        return Promise.resolve({
          id: `run-${starts}`,
          queuedPosition: starts === 1 ? null : 1,
        });
      }
      if (command === "stop_run") return Promise.resolve("cancelled");
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("first message");
    await waitFor(() =>
      expect(startRunArgs()).toMatchObject({
        root: "/project",
        prompt: expect.stringContaining("first message"),
        operationTargets: [],
      }),
    );

    send("second message, sent while the first is still running");
    await waitFor(() =>
      expect(startRunArgs()).toMatchObject({
        root: "/project",
        prompt: expect.stringContaining("second message, sent while the first is still running"),
        operationTargets: [],
      }),
    );

    const startRunCalls = invokeMock.mock.calls.filter(([command]) => command === "start_run");
    expect(startRunCalls.length).toBe(2);
    await waitFor(() => expect(screen.getByText("⏳ queued behind an agent run")).toBeTruthy());
    expect(screen.queryByText(/position/i)).toBeNull();
    expect(
      invokeMock.mock.calls.filter(
        ([command, args]) => command === "append_transcript_event" && args.event?.kind === "agent-working",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock).toHaveBeenCalledWith("stop_run", { runId: "run-2" });
    await waitFor(() => expect(screen.getByText("■ Cancelled before start")).toBeTruthy());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("append_transcript_event", {
        root: "/project",
        event: expect.objectContaining({
          kind: "agent-working",
          runId: "run-2",
          phase: { phase: "cancelled" },
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders a rejected start_run call honestly instead of silently swallowing it — FR-X-5 CommandError::InvalidArguments", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_run") {
        return Promise.reject({ kind: "InvalidArguments", message: "prompt must not be empty" });
      }
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    send("this somehow gets rejected server-side");

    await waitFor(() => expect(screen.getByText(/Agent stopped unexpectedly/)).toBeTruthy());
    expect(screen.getByText(/prompt must not be empty/)).toBeTruthy();
  });

  // FR-CHAT-4: "a turn that also carries a quoted selection carries both envelopes, the ambient
  // `open_documents` one first and the quote last as the more specific referent" — proven on the
  // prompt that actually reaches `start_run`, and with a quote whose document is deliberately not
  // among the open tabs, which the requirement says is legitimate and must not be reconciled away.
  it("carries both envelopes on a quoted turn, ambient first and the quote last, never reconciling the quote against the open set", async () => {
    const quote = {
      documentPath: "notes/elsewhere.md",
      text: "the quoted passage",
      anchor: {
        offset: 0,
        length: 18,
        text_snapshot: "the quoted passage",
        context_before: "",
        context_after: "",
        base_revision: "r0",
      },
    };
    render(
      <TimelinePanel
        root="/project"
        operationTargets={["draft.md"]}
        openDocuments={() => ({ active: { path: "draft.md", dirty: false }, alsoOpen: [] })}
        incomingQuote={quote}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));
    await waitFor(() => expect(screen.getByLabelText("Quoted selection")).toBeTruthy());

    send("tighten this");

    await waitFor(() => expect(startRunArgs()).toBeDefined());
    const { lines } = parseReferenceData(startRunArgs().prompt);
    const ambient = lines.findIndex((line) => line.includes('"kind":"open_documents"'));
    const quoted = lines.findIndex((line) => line.includes('"kind":"quoted_selection"'));
    expect(ambient).toBeGreaterThanOrEqual(0);
    expect(quoted).toBeGreaterThan(ambient);
    // Last in the block, after the statements that describe the ambient envelope.
    expect(quoted).toBe(lines.length - 1);
    expect(JSON.parse(lines[quoted])).toEqual({
      cowrite_context_version: 1,
      kind: "quoted_selection",
      document_path: "notes/elsewhere.md",
      quoted_text: "the quoted passage",
      anchor: quote.anchor,
    });
  });
});

/**
 * #1777 — the composer suite above proves the honest rejected-call state for a *message*; this one
 * proves it for the other surface that calls `start_run`, a mounted `CommentCard`'s own
 * `[Address with AI]`. #1721 wired that button to `start_run` and correctly refused to stamp the
 * thread pending when the call rejected, but then returned silently: the button read as dead with
 * no reason given (FR-X-5 "never silently no-ops", UX Principle 7).
 *
 * Driven through the panel's real production composition — the real `CommentCard`, the real
 * `agentActivity.startRun`, the real `comments/ipc.ts`, only the Tauri boundary mocked — because
 * the panel is where the `onAddressRunFailed` prop is actually supplied. A `CommentCard`-only test
 * can prove the callback fires but never that anything renders it, which is the half #1760 shipped.
 */
describe("timeline/TimelinePanel — a thread's [Address with AI] surfaces a rejected start_run (#1777)", () => {
  const THREAD = thread("c1", { body: "please clarify" });
  const CARD = createCommentCard("/project", "doc.md", THREAD, { id: "card-c1" });

  function renderPanelWithThreadCard(openDocuments?: () => OpenDocumentsSnapshot) {
    return render(
      <TimelinePanel
        root="/project"
        initialCards={[CARD]}
        commentThreads={[THREAD]}
        commentPath="doc.md"
        author="alice"
        commentNow={() => 300}
        openDocuments={openDocuments}
      />,
    );
  }

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders a Failed run card naming the reason and still stamps nothing on the thread", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      // The reachable rejection for this surface: the target failed `confine` because the project
      // root moved or unmounted under the app (`commands/commands/path_confine.rs`).
      if (command === "start_address_run") {
        return Promise.reject({ kind: "InvalidArguments", message: "target escapes the project root" });
      }
      return Promise.resolve(undefined);
    });
    renderPanelWithThreadCard();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    const card = document.querySelector('[data-card-id="c1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Address with AI" }));

    // The honest terminal state, through the identical `failedRunStatus`/`foldRunStatus` path the
    // composer already uses — not a second error presentation.
    await waitFor(() => expect(screen.getByText(/Agent stopped unexpectedly/)).toBeTruthy());
    expect(screen.getByText(/target escapes the project root/)).toBeTruthy();
    // #1721's half, still true: no run exists, so no pending/Address event may be recorded for it.
    expect(invokeMock).not.toHaveBeenCalledWith("address_with_ai", expect.anything());
    // And the request stays retryable rather than being replaced by an acknowledgment rung.
    expect(within(card).getByRole("button", { name: "Address with AI" })).toBeTruthy();
  });

  it("stamps the thread normally and raises no failure card when start_run succeeds", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return Promise.resolve({
        run: { id: "run-9", queuedPosition: null },
        threads: [{ ...THREAD, pending_run: "run-9", pending_run_started: true }],
        progress: { addressed: ["c1"], skipped: [], untouched: [], interrupted: null },
      });
      return Promise.resolve(undefined);
    });
    renderPanelWithThreadCard();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    const card = document.querySelector('[data-card-id="c1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Address with AI" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "start_address_run",
        expect.objectContaining({ threadIds: ["c1"], batch: false }),
      ),
    );
    expect(screen.queryByText(/Agent stopped unexpectedly/)).toBeNull();
  });

  // #1724/FR-CHAT-4: the panel feeds every mounted comment card the same open-document reader its
  // own composer submits with, so a thread's run names the same set a chat turn would. Proven on
  // the prompt reaching `start_run` through the real card and the real `startRun`.
  it("names the open documents in the prompt reaching start_run for a thread's own run", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_address_run") return Promise.resolve({
        run: { id: "run-9", queuedPosition: null },
        threads: [{ ...THREAD, pending_run: "run-9", pending_run_started: true }],
        progress: { addressed: ["c1"], skipped: [], untouched: [], interrupted: null },
      });
      return Promise.resolve(undefined);
    });
    renderPanelWithThreadCard(() => ({
      active: { path: "doc.md", dirty: false },
      alsoOpen: [{ path: "notes/outline.md", dirty: true }],
    }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));

    const card = document.querySelector('[data-card-id="c1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Address with AI" }));

    const addressCall = await waitFor(() => {
      const call = invokeMock.mock.calls.find(([command]) => command === "start_address_run");
      expect(call).toBeDefined();
      return call![1] as { referenceData: string };
    });
    expect(openDocumentsEnvelopeIn(addressCall.referenceData)).toEqual({
      cowrite_context_version: 1,
      kind: "open_documents",
      active: { path: "doc.md", unsaved: false },
      also_open: [{ path: "notes/outline.md", unsaved: true }],
    });
  });
});

// #2230: `failedRunStatus` was one of four independent readers of a rejected call's message and now
// routes through `backend.errorDetail`. What a user sees is the claim — a helper-only test would
// pass while this header changed — so each rejection shape is driven through the real composer, the
// real `startRun`, the real `failedRunStatus`/`foldRunStatus` fold and the real `AgentWorkingCard`,
// and the WHOLE header string is asserted, not a substring. The axis varied is the rejection's
// SHAPE (typed CommandError, thrown Error, bare string, message-less object, `undefined`); the axis
// held fixed is the call site, which the sibling `#1777` describe above varies for the same builder.
describe("timeline/TimelinePanel — one reader of a rejected start_run's message (#2230, FR-X-5)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
  });

  async function headerAfterRejecting(rejection: unknown): Promise<string> {
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_transcript") return Promise.resolve([]);
      if (command === "start_run") return Promise.reject(rejection);
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_transcript", { root: "/project" }));
    send("a turn the backend rejects");
    const header = await screen.findByText(/Agent stopped unexpectedly/);
    return header.textContent ?? "";
  }

  it("renders the typed CommandError's own message", async () => {
    expect(
      await headerAfterRejecting({ kind: "InvalidArguments", message: "prompt must not be empty" }),
    ).toBe("■ Agent stopped unexpectedly — prompt must not be empty");
  });

  it("renders a thrown Error's message", async () => {
    expect(await headerAfterRejecting(new Error("the IPC bridge went away"))).toBe(
      "■ Agent stopped unexpectedly — the IPC bridge went away",
    );
  });

  it("renders a bare string rejection", async () => {
    expect(await headerAfterRejecting("the IPC bridge went away")).toBe(
      "■ Agent stopped unexpectedly — the IPC bridge went away",
    );
  });

  // The divergent case — the one the four implementations actually disagreed on. This surface's
  // answer for a rejection carrying no readable message is `String(error)`, which is what shipped
  // and what `ux-design.md` §4 would have to rule on to change (#2230 keeps it verbatim).
  it("keeps its shipped no-detail wording for a rejection carrying no message at all", async () => {
    expect(await headerAfterRejecting({})).toBe("■ Agent stopped unexpectedly — [object Object]");
  });

  it("keeps its shipped no-detail wording for an undefined rejection", async () => {
    expect(await headerAfterRejecting(undefined)).toBe(
      "■ Agent stopped unexpectedly — undefined",
    );
  });
});
