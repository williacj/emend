// ABOUTME: Confirms the settings IPC bridge stays thin (§3.1) — it shapes exactly the
// ABOUTME: `callBackend` calls `commands::settings` expects, nothing else (transport routing
// ABOUTME: itself, incl. the D23 headless test driver fallback, is `backend.test.ts`'s own coverage).
import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({ callBackend: (...args: unknown[]) => callBackendMock(...args) }));

const { getSettings, patchSettings, DEFAULT_SETTINGS } = await import("./ipc");

describe("settings/ipc", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  it("getSettings calls get_settings with no args and returns the backend value", async () => {
    const stored = {
      schema_version: 4,
      autosave: { enabled: false, interval_ms: 2500 },
      notifications: { completion: true },
      provider_default: null,
      reveal_markup_at_cursor: true,
      voice: { enabled: true, input_device_id: null, input_device_name: null },
    };
    callBackendMock.mockResolvedValueOnce(stored);

    const settings = await getSettings();

    expect(callBackendMock).toHaveBeenCalledWith("get_settings", {});
    expect(settings).toEqual(stored);
  });

  it("patchSettings sends a field-scoped camelCase patch and returns the full snapshot", async () => {
    const stored = { ...DEFAULT_SETTINGS, reveal_markup_at_cursor: true };
    callBackendMock.mockResolvedValueOnce(stored);

    const settings = await patchSettings({ revealMarkupAtCursor: true });

    expect(callBackendMock).toHaveBeenCalledWith("patch_settings", {
      patch: { revealMarkupAtCursor: true },
    });
    expect(settings).toEqual(stored);
  });

  it("defines the safe schema-v4 first-run default with reveal-at-cursor off", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      schema_version: 4,
      reveal_markup_at_cursor: false,
      voice: { input_device_id: null, input_device_name: null },
    });
  });

  it("getSettings propagates a callBackend rejection rather than swallowing it", async () => {
    // §7b Corollary B: this seam is routed, not exempted — a caller (e.g. `EditorShell`'s own
    // `.catch(() => DEFAULT_SETTINGS)`) decides the fallback; the bridge itself must not decide it
    // silently, which is what the old `if (!isTauri())` branch this replaces used to do.
    const failure = new Error("driver unreachable");
    callBackendMock.mockRejectedValueOnce(failure);

    await expect(getSettings()).rejects.toThrow(failure);
  });
});
