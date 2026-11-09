// @vitest-environment jsdom
// ABOUTME: Assembled UI proof that D23 submits and queued cancellation keep their production
// ABOUTME: TimelinePanel -> agentActivity -> callBackend callers outside a Tauri webview (#1825).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const { TimelinePanel } = await import("./TimelinePanel");

interface BackendRequest {
  command: string;
  args: Record<string, unknown>;
}

const requests: BackendRequest[] = [];
let starts = 0;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("timeline/TimelinePanel — D23 run request transport (#1825)", () => {
  beforeEach(() => {
    requests.length = 0;
    starts = 0;
    invokeMock.mockReset();
    listenMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const request = {
          command: url.pathname.slice(1),
          args: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        };
        requests.push(request);

        switch (request.command) {
          case "load_transcript":
            return jsonResponse([]);
          case "run_state":
            return jsonResponse({ active: null, queued: [], finished: [], lastFinished: null });
          case "start_run":
            starts += 1;
            return jsonResponse({ id: `run-${starts}`, queuedPosition: starts === 1 ? null : 1 });
          case "stop_run":
            return jsonResponse("cancelled");
          case "append_transcript_event":
            return jsonResponse(null);
          default:
            throw new Error(`unexpected backend request: ${request.command}`);
        }
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("UI submits and queued Cancel reach the D23 start_run and stop_run routes through production callers", async () => {
    render(<TimelinePanel root="C:/project" />);
    await waitFor(() =>
      expect(requests).toContainEqual({ command: "load_transcript", args: { root: "C:/project" } }),
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "first request" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        command: "start_run",
        args: expect.objectContaining({ root: "C:/project", operationTargets: [] }),
      }),
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "queued request" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(requests).toContainEqual({ command: "stop_run", args: { runId: "run-2" } }),
    );
    expect(await screen.findByText("■ Cancelled before start")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });
});
