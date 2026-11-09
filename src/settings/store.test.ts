// ABOUTME: Proves the process-global settings snapshot cannot be rolled back by hydration races.
// ABOUTME: Covers safe failure defaults, immediate patch publication, and event echo de-duplication.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "./ipc";

const getSettingsMock = vi.fn();
const patchSettingsMock = vi.fn();
const listenForBackendEventMock = vi.fn();

vi.mock("./ipc", async (importActual) => {
  const actual = await importActual<typeof import("./ipc")>();
  return {
    ...actual,
    getSettings: (...args: unknown[]) => getSettingsMock(...args),
    patchSettings: (...args: unknown[]) => patchSettingsMock(...args),
  };
});

vi.mock("../stores/driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) =>
    listenForBackendEventMock(...args),
}));

const {
  SETTINGS_CHANGED_EVENT,
  getSettingsStoreSnapshot,
  patchCurrentSettings,
  resetSettingsStoreForTests,
  startSettingsStore,
  subscribeSettings,
} = await import("./store");

const REVEALED: Settings = {
  ...DEFAULT_SETTINGS,
  reveal_markup_at_cursor: true,
};

describe("settings/store", () => {
  let emit: (settings: Settings) => void;
  const unlisten = vi.fn();

  beforeEach(() => {
    resetSettingsStoreForTests();
    getSettingsMock.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
    patchSettingsMock.mockReset();
    unlisten.mockReset();
    listenForBackendEventMock.mockReset().mockImplementation(
      (_name: string, handler: (settings: Settings) => void) => {
        emit = handler;
        return Promise.resolve(unlisten);
      },
    );
  });

  it("registers settings://changed before beginning initial hydration", async () => {
    const order: string[] = [];
    listenForBackendEventMock.mockImplementation(
      (_name: string, handler: (settings: Settings) => void) => {
        order.push("listen");
        emit = handler;
        return Promise.resolve(unlisten);
      },
    );
    getSettingsMock.mockImplementation(async () => {
      order.push("get");
      return DEFAULT_SETTINGS;
    });

    await startSettingsStore();

    expect(order).toEqual(["listen", "get"]);
    expect(listenForBackendEventMock).toHaveBeenCalledWith(
      SETTINGS_CHANGED_EVENT,
      expect.any(Function),
    );
  });

  it("keeps an event snapshot when an older in-flight get resolves afterward", async () => {
    let resolveGet!: (settings: Settings) => void;
    getSettingsMock.mockImplementation(
      () => new Promise<Settings>((resolve) => (resolveGet = resolve)),
    );

    const starting = startSettingsStore();
    await vi.waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    emit(REVEALED);
    resolveGet(DEFAULT_SETTINGS);
    await starting;

    expect(getSettingsStoreSnapshot()).toMatchObject({
      status: "ready",
      settings: REVEALED,
    });
  });

  it("leaves the safe reveal-off default available when hydration fails", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("settings unavailable"));

    await startSettingsStore();

    expect(getSettingsStoreSnapshot()).toMatchObject({
      status: "error",
      settings: { reveal_markup_at_cursor: false },
    });
    expect(getSettingsStoreSnapshot().error).toEqual(
      new Error("settings unavailable"),
    );
  });

  it("publishes a patch result immediately and de-duplicates its matching event echo", async () => {
    await startSettingsStore();
    patchSettingsMock.mockResolvedValueOnce(REVEALED);
    const subscriber = vi.fn();
    const unsubscribe = subscribeSettings(subscriber);

    await expect(
      patchCurrentSettings({ revealMarkupAtCursor: true }),
    ).resolves.toEqual(REVEALED);
    expect(getSettingsStoreSnapshot().settings).toEqual(REVEALED);
    expect(subscriber).toHaveBeenCalledTimes(1);

    emit(REVEALED);
    expect(subscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("publishes a microphone name change without a device ID change", async () => {
    await startSettingsStore();
    const subscriber = vi.fn();
    const unsubscribe = subscribeSettings(subscriber);
    const selected: Settings = {
      ...DEFAULT_SETTINGS,
      voice: { enabled: true, input_device_id: "mic-b", input_device_name: "USB microphone" },
    };
    const renamed: Settings = {
      ...selected,
      voice: { ...selected.voice, input_device_name: "Renamed USB microphone" },
    };

    emit(selected);
    expect(subscriber).toHaveBeenCalledTimes(1);
    emit(renamed);
    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(getSettingsStoreSnapshot().settings).toEqual(renamed);

    emit(renamed);
    expect(subscriber).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
