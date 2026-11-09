// ABOUTME: Contract tests for J7's permission-state IPC and backend event bridge.
// ABOUTME: Pins the exact command arguments and shared driver-event subscription channel.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
const listenForBackendEventMock = vi.fn();

vi.mock("../backend", () => ({
  callBackend: (...args: unknown[]) => callBackendMock(...args),
}));
vi.mock("../stores/driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEventMock(...args),
}));

const { decidePermission, getPermissionState, listenToPermissionState, PERMISSION_EVENT } =
  await import("./permission");

describe("timeline/permission", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
    listenForBackendEventMock.mockReset();
  });

  it("hydrates permission_state with no project data in the request", async () => {
    const state = { projectId: null, runId: null, revision: 3, requests: [] };
    callBackendMock.mockResolvedValueOnce(state);

    await expect(getPermissionState()).resolves.toEqual(state);
    expect(callBackendMock).toHaveBeenCalledWith("permission_state", {});
  });

  it("subscribes through the shared backend event pump on the exact permission channel", async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenForBackendEventMock.mockResolvedValueOnce(unlisten);

    await expect(listenToPermissionState(handler)).resolves.toBe(unlisten);
    expect(PERMISSION_EVENT).toBe("cowrite://agent/permission");
    expect(listenForBackendEventMock).toHaveBeenCalledWith(PERMISSION_EVENT, handler);
  });

  it("sends a typed decision with camelCase run and request ids", async () => {
    callBackendMock.mockResolvedValueOnce(undefined);

    await decidePermission("run-7", "request-2", { kind: "deny", reason: "Use the checked report." });

    expect(callBackendMock).toHaveBeenCalledWith("decide_permission", {
      runId: "run-7",
      requestId: "request-2",
      decision: { kind: "deny", reason: "Use the checked report." },
    });
  });
});
