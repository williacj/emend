// @vitest-environment jsdom
// ABOUTME: Integration tests for J7 permission hydration/events in the timeline's run cards.
// ABOUTME: Pins revision ordering, project reset, live-run matching, and D15 ephemerality.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStatus } from "./agentActivity";
import type { PermissionState } from "./permission";

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

function handlerFor(eventName: string) {
  const call = [...listenMock.mock.calls].reverse().find(([name]) => name === eventName);
  return call?.[1] as ((event: { payload: unknown }) => void) | undefined;
}

function push(eventName: string, payload: unknown) {
  const handler = handlerFor(eventName);
  if (!handler) throw new Error(`No listener for ${eventName}`);
  act(() => handler({ payload }));
}

function running(id = "run-1"): RunStatus {
  return { id, phase: { phase: "running" }, activity: [], elapsedSecs: 5 };
}

function permission(
  revision: number,
  runId: string | null = "run-1",
  projectId: string | null = "project-a",
): PermissionState {
  return {
    projectId,
    runId,
    revision,
    requests: runId
      ? [{
          id: `request-${revision}`,
          action: "Bash",
          detail: `command-${revision}`,
          why: "verify it",
          requestedAtMs: Date.now(),
          allowExactCommand: true,
          allowScript: false,
        }]
      : [],
  };
}

function request(id: string, action = "Bash") {
  return {
    id,
    action,
    detail: `command-${id}`,
    why: "verify it",
    requestedAtMs: Date.now(),
    allowExactCommand: true,
    allowScript: false,
  };
}

describe("timeline/TimelinePanel — permission requests (#2399)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    invokeMock.mockImplementation((command: string) => {
      if (command === "permission_state") return Promise.resolve(permission(0, null));
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("reports a pending request while hidden and navigates once when its collapsed host returns", async () => {
    const onPendingPermissionChange = vi.fn();
    const onPermissionNavigationActivate = vi.fn();
    const view = render(
      <TimelinePanel root="/project" collapsed onPendingPermissionChange={onPendingPermissionChange} onPermissionNavigationActivate={onPermissionNavigationActivate} />,
    );
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(1));
    await waitFor(() => expect(onPendingPermissionChange).toHaveBeenLastCalledWith(true));
    expect(document.querySelector(".timeline-panel")).toHaveAttribute("hidden");

    view.rerender(
      <TimelinePanel root="/project" permissionAttentionRequest={1} onPendingPermissionChange={onPendingPermissionChange} onPermissionNavigationActivate={onPermissionNavigationActivate} />,
    );
    expect(screen.getByRole("heading", { name: "Permission request: Bash" })).toHaveFocus();
    expect(onPermissionNavigationActivate).toHaveBeenCalledOnce();

    view.rerender(
      <TimelinePanel root="/project" collapsed permissionAttentionRequest={1} onPendingPermissionChange={onPendingPermissionChange} onPermissionNavigationActivate={onPermissionNavigationActivate} />,
    );
    view.rerender(
      <TimelinePanel root="/project" permissionAttentionRequest={1} onPendingPermissionChange={onPendingPermissionChange} onPermissionNavigationActivate={onPermissionNavigationActivate} />,
    );
    expect(onPermissionNavigationActivate).toHaveBeenCalledOnce();
  });

  it("applies explicit permission navigation focus once across later revisions of the same FIFO head", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    const first = request("first");
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 1, requests: [first],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show permission request in Timeline" }));
    expect(screen.getByRole("heading", { name: "Permission request: Bash" })).toHaveFocus();

    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 2, requests: [first],
    });

    expect(composer).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(composer).toHaveFocus();
  });

  it("retains focused FIFO ownership through a queued addition until the head clears", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    const first = request("first");
    const second = request("second", "Write");
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 1, requests: [first],
    });
    screen.getByRole("button", { name: "Allow once" }).focus();

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 2, requests: [first, second],
    });
    expect(screen.getAllByRole("button", { name: "Allow once" })[0]).toHaveFocus();
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 3, requests: [second],
    });

    expect(screen.getByRole("heading", { name: "Permission request: Write" })).toHaveFocus();
  });

  it("subscribes before hydration, keeps the newest revision, and never persists permission payloads", async () => {
    let resolveHydration!: (state: PermissionState) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "permission_state") return new Promise((resolve) => { resolveHydration = resolve; });
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();
    push("cowrite://agent/permission", permission(4));
    expect(screen.queryByText("command-4")).toBeNull();
    expect(composer).toHaveFocus();

    act(() => resolveHydration(permission(3)));
    await waitFor(() => expect(screen.getByText("command-4")).toBeTruthy());
    push("cowrite://agent/permission", permission(3));
    expect(screen.queryByText("command-3")).toBeNull();
    expect(screen.getByText("command-4")).toBeTruthy();
    expect(
      invokeMock.mock.calls.filter(([command, args]) =>
        command === "append_transcript_event" && JSON.stringify(args).includes("command-4")),
    ).toHaveLength(0);
  });

  it("routes the first decision and resets the revision floor when the project changes", async () => {
    const hydration = [permission(0, null, "project-a"), permission(0, null, "project-b")];
    invokeMock.mockImplementation((command: string) => {
      if (command === "permission_state") return Promise.resolve(hydration.shift());
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { rerender } = render(<TimelinePanel root="/project-a" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(9));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(invokeMock).toHaveBeenCalledWith("decide_permission", {
      runId: "run-1",
      requestId: "request-9",
      decision: { kind: "allow_once" },
    });
    rerender(<TimelinePanel root="/project-b" />);
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([command]) => command === "permission_state")).toHaveLength(2),
    );
    push("cowrite://agent/permission", permission(1, "run-1", "project-b"));
    await waitFor(() => expect(screen.getByText("command-1")).toBeTruthy());
  });

  it("buffers until hydration identifies the project and rejects delayed snapshots from the old project", async () => {
    let resolveProjectA!: (state: PermissionState) => void;
    let resolveProjectB!: (state: PermissionState) => void;
    let hydrationCall = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "permission_state") {
        hydrationCall += 1;
        return new Promise((resolve) => {
          if (hydrationCall === 1) resolveProjectA = resolve;
          else resolveProjectB = resolve;
        });
      }
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const { rerender } = render(<TimelinePanel root="/project-a" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(7, "run-1", "project-a"));
    push("cowrite://agent/permission", permission(5, "run-1", "project-a"));
    expect(screen.queryByText("command-7")).toBeNull();
    act(() => resolveProjectA(permission(6, "run-1", "project-a")));
    await waitFor(() => expect(screen.getByText("command-7")).toBeTruthy());

    rerender(<TimelinePanel root="/project-b" />);
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([command]) => command === "permission_state")).toHaveLength(2),
    );
    push("cowrite://agent/permission", permission(99, "run-1", "project-a"));
    push("cowrite://agent/permission", permission(2, "run-1", "project-b"));
    expect(screen.queryByText("command-2")).toBeNull();
    act(() => resolveProjectB(permission(1, "run-1", "project-b")));
    await waitFor(() => expect(screen.getByText("command-2")).toBeTruthy());

    push("cowrite://agent/permission", permission(100, "run-1", "project-a"));
    expect(screen.queryByText("command-100")).toBeNull();
    expect(screen.getByText("command-2")).toBeTruthy();
    push("cowrite://agent/permission", permission(3, "run-1", "project-b"));
    expect(screen.getByText("command-3")).toBeTruthy();
  });

  it("retries failed project identification when a buffered permission event arrives", async () => {
    let hydrationCall = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "permission_state") {
        hydrationCall += 1;
        return hydrationCall === 1
          ? Promise.reject(new Error("temporary hydration failure"))
          : Promise.resolve(permission(1, null, "project-a"));
      }
      if (command === "load_transcript") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<TimelinePanel root="/project-a" />);
    await waitFor(() => expect(hydrationCall).toBe(1));
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(2, "run-1", "project-a"));

    await waitFor(() => expect(screen.getByText("command-2")).toBeTruthy());
    expect(hydrationCall).toBe(2);
  });

  it("keeps a filtered permission arrival passive, then navigates to its exact run and heading on activation (#2429)", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running("run-1"));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();

    push("cowrite://agent/permission", {
      projectId: "project-a",
      runId: "run-1",
      revision: 4,
      requests: [request("request-head", "Bash")],
    });

    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(composer).toHaveFocus();
    expect(screen.queryByText("command-request-head")).toBeNull();
    expect(screen.queryByText(/new in Chat/i)).toBeNull();
    expect(screen.getByRole("status", { name: "Permission attention" })).toHaveTextContent(
      "Agent is waiting for permission.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show permission request in Timeline" }));

    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    const heading = await screen.findByRole("heading", { name: "Permission request: Bash" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("region", { name: "Permission request: Bash" })).toContainElement(heading);
    expect(heading.closest("article")).toHaveAttribute("data-card-id", "run-1");

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: null, revision: 5, requests: [],
    });
    expect(screen.queryByRole("button", { name: "Show permission request in Timeline" })).toBeNull();
    expect(screen.getByRole("heading", { name: /Agent working/ })).toHaveFocus();
  });

  it("moves focus from a clearing Timeline attention action to its persistent heading only when owned", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    const first = request("request-first", "Bash");
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 1, requests: [first],
    });
    const attention = screen.getByRole("button", { name: "Show permission request in Timeline" });
    attention.focus();

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: null, revision: 2, requests: [],
    });

    const heading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    expect(heading).toHaveFocus();
    expect(heading).toHaveClass("timeline-host__label--programmatic-focus");

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 3, requests: [request("request-next", "Write")],
    });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("button", { name: "Show permission request in Timeline" })).not.toHaveFocus();

    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: null, revision: 4, requests: [],
    });
    expect(composer).toHaveFocus();
  });

  it("announces each FIFO head once and remains silent for revisions, non-head additions, and activation (#2429)", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    const first = request("request-1", "Bash");
    const second = request("request-2", "Write");

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 1, requests: [first],
    });
    const firstAnnouncement = screen.getByRole("status", { name: "Permission attention" });
    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 2, requests: [first, second],
    });
    expect(screen.getByRole("status", { name: "Permission attention" })).toBe(firstAnnouncement);
    fireEvent.click(screen.getByRole("button", { name: "Show permission request in Timeline" }));
    expect(screen.getByRole("status", { name: "Permission attention" })).toBe(firstAnnouncement);

    push("cowrite://agent/permission", {
      projectId: "project-a", runId: "run-1", revision: 3, requests: [second],
    });
    expect(screen.getByRole("status", { name: "Permission attention" })).not.toBe(firstAnnouncement);
    expect(screen.getByRole("heading", { name: "Permission request: Write" })).toHaveFocus();
  });

  it("does not advertise an orphaned or terminal run as an actionable permission request", async () => {
    render(<TimelinePanel root="/project" />);
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("cowrite://agent/permission", permission(1));
    expect(screen.queryByRole("button", { name: "Show permission request in Timeline" })).toBeNull();

    push("agent://activity", {
      ...running(),
      phase: { phase: "completed", reply: null },
    });
    expect(screen.queryByRole("button", { name: "Show permission request in Timeline" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Permission attention" })).toBeNull();
  });

  it("restores the pre-activation focus target when the project changes after permission navigation", async () => {
    const onPermissionNavigationActivate = vi.fn();
    const { rerender } = render(
      <>
        <button>Persistent origin</button>
        <TimelinePanel
          key="project-a"
          root="/project-a"
          onPermissionNavigationActivate={onPermissionNavigationActivate}
        />
      </>,
    );
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(1));
    const origin = screen.getByRole("button", { name: "Persistent origin" });
    origin.focus();
    const attention = screen.getByRole("button", { name: "Show permission request in Timeline" });
    fireEvent.pointerDown(attention, { button: 0 });
    fireEvent.click(attention);
    expect(screen.getByRole("heading", { name: "Permission request: Bash" })).toHaveFocus();

    rerender(
      <>
        <button>Persistent origin</button>
        <TimelinePanel
          key="project-b"
          root="/project-b"
          permissionProjectFocusRestore={{ target: onPermissionNavigationActivate.mock.calls[0][0] }}
        />
      </>,
    );

    await waitFor(() => expect(origin).toHaveFocus());
  });

  it("focuses the new Timeline host when the permission navigation origin is gone on project replacement", async () => {
    const onPermissionNavigationActivate = vi.fn();
    const { rerender } = render(
      <TimelinePanel
        key="project-a"
        root="/project-a"
        onPermissionNavigationActivate={onPermissionNavigationActivate}
      />,
    );
    await waitFor(() => expect(handlerFor("cowrite://agent/permission")).toBeDefined());
    push("agent://activity", running());
    push("cowrite://agent/permission", permission(1));
    const attention = screen.getByRole("button", { name: "Show permission request in Timeline" });
    attention.focus();
    fireEvent.click(attention);
    expect(screen.getByRole("heading", { name: "Permission request: Bash" })).toHaveFocus();

    rerender(
      <TimelinePanel
        key="project-b"
        root="/project-b"
        permissionProjectFocusRestore={{ target: onPermissionNavigationActivate.mock.calls[0][0] }}
      />,
    );

    await waitFor(() => expect(screen.getByText("TIMELINE")).toHaveFocus());
  });
});
