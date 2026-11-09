// ABOUTME: Covers `onboarding/ipc.ts` — the `detect_providers` bridge (through the shared
// ABOUTME: `callBackend` transport) and the Tauri-only folder picker's dev-mode fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({ callBackend: (...args: unknown[]) => callBackendMock(...args) }));

const isTauriMock = vi.fn(() => true);
const openMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => isTauriMock() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openMock(...args) }));

const { detectProviders, pickProjectFolder } = await import("./ipc");

describe("detectProviders", () => {
  it("calls detect_providers with no args and returns the entries", async () => {
    const entries = [
      { provider: "claude_code", state: "signed_in", account: "cj@example.com" },
      { provider: "copilot", state: "not_installed" },
    ];
    callBackendMock.mockResolvedValueOnce(entries);

    const result = await detectProviders();

    expect(callBackendMock).toHaveBeenCalledWith("detect_providers", {});
    expect(result).toEqual(entries);
  });
});

describe("pickProjectFolder", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    openMock.mockReset();
  });

  it("returns the selected directory path", async () => {
    openMock.mockResolvedValueOnce("/Users/cj/my-project");

    const result = await pickProjectFolder();

    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(result).toBe("/Users/cj/my-project");
  });

  it("returns null when the user cancels the dialog", async () => {
    openMock.mockResolvedValueOnce(null);

    expect(await pickProjectFolder()).toBeNull();
  });

  it("returns null outside a Tauri webview without touching the dialog plugin", async () => {
    isTauriMock.mockReturnValue(false);

    expect(await pickProjectFolder()).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });
});
