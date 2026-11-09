// @vitest-environment jsdom
// ABOUTME: Proves TD-25's production entry point installs one module-scope listener outside
// ABOUTME: React rendering and observes an unhandled rejection without cancelling its loud channel.
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock("react-dom/client", () => ({ default: { createRoot: createRootMock } }));
vi.mock("./App", () => ({ default: () => null }));

describe("production unhandled-rejection registration (TD-25, #2102)", () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
    renderMock.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("registers once at module scope and never consumes the event", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");

    await import("./main");
    await import("./main");

    const registrations = addEventListener.mock.calls.filter(([type]) => type === "unhandledrejection");
    expect(registrations).toHaveLength(1);
    expect(addEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      createRootMock.mock.invocationCallOrder[0]!,
    );
    expect(addEventListener.mock.calls.some(([type]) => type === "error")).toBe(false);
    expect(createRootMock).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    const listener = registrations[0]?.[1] as EventListener;
    listener({ reason: new Error("native dialog failed"), preventDefault } as unknown as Event);

    expect(preventDefault).not.toHaveBeenCalled();
    const { getAppStatus } = await import("./stores/appStatus");
    expect(getAppStatus()?.authorMessage).toContain("native dialog failed");
    addEventListener.mockRestore();
  });
});
