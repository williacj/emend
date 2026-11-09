// ABOUTME: Wires FR-ED-3's "quitting with dirty tabs open" guard to the real OS close request —
// ABOUTME: only inside an actual Tauri window; a no-op under the D23 dev-mode/Playwright surface.
import { beforeEach, describe, expect, it, vi } from "vitest";

const isTauriMock = vi.fn(() => true);
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
}));

const onCloseRequestedMock = vi.fn();
const destroyMock = vi.fn();
const getCurrentWindowMock = vi.fn(() => ({
  onCloseRequested: onCloseRequestedMock,
  destroy: destroyMock,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
}));

const { closeWindow, coordinateAppQuit, installNativeCloseRouter, installQuitGuard } = await import("./appLifecycle");
const { EMPTY_TABS, openTab, setTabDirty } = await import("./tabs");

describe("stores/appLifecycle — installQuitGuard", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    onCloseRequestedMock.mockReset();
    getCurrentWindowMock.mockClear();
  });

  it("outside a Tauri window never touches the window API and returns a no-op unlisten", async () => {
    isTauriMock.mockReturnValue(false);

    const unlisten = await installQuitGuard(() => EMPTY_TABS, vi.fn());

    expect(getCurrentWindowMock).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it("registers a close-requested handler on the current window", async () => {
    await installQuitGuard(() => EMPTY_TABS, vi.fn());

    expect(onCloseRequestedMock).toHaveBeenCalledTimes(1);
  });

  it("a close request with no dirty tabs is left alone (never prevented)", async () => {
    const onBlocked = vi.fn();
    let handler: (event: { preventDefault: () => void }) => void = () => {};
    onCloseRequestedMock.mockImplementation((h) => {
      handler = h;
    });
    await installQuitGuard(() => openTab(EMPTY_TABS, "a.md"), onBlocked);

    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("a close request with dirty tabs is prevented and the dirty paths are handed to onBlocked", async () => {
    const onBlocked = vi.fn();
    let handler: (event: { preventDefault: () => void }) => void = () => {};
    onCloseRequestedMock.mockImplementation((h) => {
      handler = h;
    });
    const dirtyState = setTabDirty(openTab(EMPTY_TABS, "a.md"), "a.md", true);
    await installQuitGuard(() => dirtyState, onBlocked);

    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith(["a.md"]);
  });

  it("runs onWillClose on every close attempt, whether or not the close ends up blocked", async () => {
    const onWillClose = vi.fn();
    let handler: (event: { preventDefault: () => void }) => void = () => {};
    onCloseRequestedMock.mockImplementation((h) => {
      handler = h;
    });
    const dirtyState = setTabDirty(openTab(EMPTY_TABS, "a.md"), "a.md", true);
    await installQuitGuard(() => dirtyState, vi.fn(), onWillClose);

    handler({ preventDefault: vi.fn() });
    expect(onWillClose).toHaveBeenCalledTimes(1);

    await installQuitGuard(() => EMPTY_TABS, vi.fn(), onWillClose);
    handler({ preventDefault: vi.fn() });
    expect(onWillClose).toHaveBeenCalledTimes(2);
  });

  it("reads tab state fresh on every close attempt rather than capturing it once", async () => {
    const onBlocked = vi.fn();
    let handler: (event: { preventDefault: () => void }) => void = () => {};
    onCloseRequestedMock.mockImplementation((h) => {
      handler = h;
    });
    let state = EMPTY_TABS;
    await installQuitGuard(() => state, onBlocked);

    handler({ preventDefault: vi.fn() });
    expect(onBlocked).not.toHaveBeenCalled();

    state = setTabDirty(openTab(EMPTY_TABS, "a.md"), "a.md", true);
    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith(["a.md"]);
  });
});

describe("stores/appLifecycle — closeWindow", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    destroyMock.mockReset();
    getCurrentWindowMock.mockClear();
  });

  it("outside a Tauri window is a no-op", async () => {
    isTauriMock.mockReturnValue(false);

    await closeWindow();

    expect(getCurrentWindowMock).not.toHaveBeenCalled();
  });

  it("inside a Tauri window destroys the current window (finishing a guard-resolved quit)", async () => {
    await closeWindow();

    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});

describe("stores/appLifecycle — coordinated app quit", () => {
  it("preflights every window before closing the first and stops at a refusal", async () => {
    const close = vi.fn();
    const result = await coordinateAppQuit([
      { preflight: vi.fn().mockResolvedValue({ eligible: true }), close },
      { preflight: vi.fn().mockResolvedValue({ eligible: false, reason: "run active" }), close },
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "refused", remaining: 2 });
  });

  it("closes sequentially and leaves later windows untouched after Stay open", async () => {
    const order: string[] = [];
    const result = await coordinateAppQuit([
      { preflight: async () => ({ eligible: true }), close: async () => { order.push("a"); return "closed"; } },
      { preflight: async () => ({ eligible: true }), close: async () => { order.push("b"); return "stayed-open"; } },
      { preflight: async () => ({ eligible: true }), close: async () => { order.push("c"); return "closed"; } },
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(result).toEqual({ outcome: "stayed-open", remaining: 2 });
  });
});

describe("stores/appLifecycle — app-lifetime close router", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    onCloseRequestedMock.mockReset();
    getCurrentWindowMock.mockClear();
  });

  it("synchronously prevents every native close before delegating", async () => {
    let handler: (event: { preventDefault: () => void }) => void = () => {};
    onCloseRequestedMock.mockImplementation((next) => { handler = next; });
    const onClose = vi.fn().mockResolvedValue(undefined);
    await installNativeCloseRouter(onClose);

    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not install a browser-only close participant", async () => {
    isTauriMock.mockReturnValue(false);
    await installNativeCloseRouter(vi.fn());
    expect(getCurrentWindowMock).not.toHaveBeenCalled();
  });
});
