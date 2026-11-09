// @vitest-environment jsdom
// ABOUTME: Covers General Settings load, field-scoped persistence, and reveal-at-cursor control.
// ABOUTME: Also proves failure honesty/retry and keyboard/focus closure.
import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "./ipc";

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
vi.mock("./VoiceSettingsSection", () => ({ VoiceSettingsSection: () => null }));

const { SettingsDialog } = await import("./SettingsDialog");
const { getSettingsStoreSnapshot, resetSettingsStoreForTests } = await import("./store");

const STORED: Settings = {
  schema_version: 4,
  autosave: { enabled: true, interval_ms: 1000 },
  notifications: { completion: false },
  provider_default: "claude",
  reveal_markup_at_cursor: false,
  voice: { enabled: true, input_device_id: null, input_device_name: null },
};

const themeProps = { themeMode: "system" as const, onThemeModeChange: vi.fn() };

describe("settings/SettingsDialog", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
    getSettingsMock.mockReset().mockResolvedValue(STORED);
    patchSettingsMock.mockReset();
    listenForBackendEventMock
      .mockReset()
      .mockResolvedValue(vi.fn());
  });

  it("loads the current autosave values and focuses the Close action", async () => {
    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Autosave" })).toBeChecked(),
    );
    expect(
      screen.getByRole("combobox", { name: "Autosave interval" }),
    ).toHaveValue("1000");
    expect(
      screen.getByRole("checkbox", { name: "Reveal markup at cursor" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Close Settings" }),
    ).toHaveFocus();
  });

  async function expectPlatformChrome(platform: "win" | "mac") {
    render(
      <SettingsDialog {...themeProps} platform={platform} onClose={vi.fn()} />,
    );

    await screen.findByRole("checkbox", { name: "Autosave" });
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute(
      "data-platform",
      platform,
    );
  }

  it("stamps win platform chrome on the dialog", async () => {
    await expectPlatformChrome("win");
  });

  it("stamps mac platform chrome on the dialog", async () => {
    await expectPlatformChrome("mac");
  });

  it("persists a non-default interval with a field-scoped patch, then reports it live", async () => {
    const view = render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);
    const interval = await screen.findByRole("combobox", {
      name: "Autosave interval",
    });

    const expected: Settings = {
      ...STORED,
      autosave: { enabled: true, interval_ms: 2000 },
    };
    patchSettingsMock.mockResolvedValueOnce(expected);

    fireEvent.change(interval, { target: { value: "2000" } });

    await waitFor(() =>
      expect(patchSettingsMock).toHaveBeenCalledWith({
        autosave: { enabled: true, intervalMs: 2000 },
      }),
    );
    await waitFor(() => expect(getSettingsStoreSnapshot().settings).toEqual(expected));
    expect(screen.getByRole("status")).toHaveTextContent("Settings saved");

    view.unmount();
    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);
    expect(
      await screen.findByRole("combobox", { name: "Autosave interval" }),
    ).toHaveValue("2000");
  });

  it("keeps an existing custom interval selectable instead of replacing it with a default", async () => {
    getSettingsMock.mockResolvedValueOnce({
      ...STORED,
      autosave: { enabled: true, interval_ms: 2500 },
    });

    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);

    const interval = await screen.findByRole("combobox", {
      name: "Autosave interval",
    });
    expect(interval).toHaveValue("2500");
    expect(
      screen.getByRole("option", { name: "2500 milliseconds" }),
    ).toBeInTheDocument();
  });

  it("keeps a failed draft visibly uncommitted and retries that exact value", async () => {
    patchSettingsMock.mockRejectedValueOnce(
      new Error("settings file is read-only"),
    );
    patchSettingsMock.mockResolvedValueOnce({
      ...STORED,
      autosave: { enabled: false, interval_ms: 1000 },
    });
    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);
    const autosave = await screen.findByRole("checkbox", { name: "Autosave" });

    fireEvent.click(autosave);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings weren’t saved. settings file is read-only",
    );
    expect(autosave).not.toBeChecked();
    expect(getSettingsStoreSnapshot().settings).toEqual(STORED);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(patchSettingsMock).toHaveBeenCalledTimes(2));
    expect(patchSettingsMock).toHaveBeenLastCalledWith({
      autosave: { enabled: false, intervalMs: 1000 },
    });
    await waitFor(() =>
      expect(getSettingsStoreSnapshot().settings.autosave.enabled).toBe(false),
    );
  });

  it("reports a load failure with a retry rather than inventing defaults", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("settings unavailable"));
    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Emend couldn’t load Settings. settings unavailable",
    );
    expect(
      screen.queryByRole("checkbox", { name: "Autosave" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("checkbox", { name: "Autosave" }),
    ).toBeChecked();
  });

  it("persists reveal-at-cursor independently and restores it on reopen", async () => {
    const expected = { ...STORED, reveal_markup_at_cursor: true };
    patchSettingsMock.mockResolvedValueOnce(expected);
    const view = render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);
    const reveal = await screen.findByRole("checkbox", {
      name: "Reveal markup at cursor",
    });

    fireEvent.click(reveal);

    await waitFor(() =>
      expect(patchSettingsMock).toHaveBeenCalledWith({
        revealMarkupAtCursor: true,
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Settings saved",
    );

    view.unmount();
    render(<SettingsDialog {...themeProps} onClose={vi.fn()} />);
    expect(
      await screen.findByRole("checkbox", {
        name: "Reveal markup at cursor",
      }),
    ).toBeChecked();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <button ref={triggerRef}>Settings</button>
        <SettingsDialog
          {...themeProps}
          returnFocusTo={triggerRef}
          onClose={onClose}
        />
      </>,
    );
    await screen.findByRole("checkbox", { name: "Autosave" });

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), {
      key: "Escape",
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(triggerRef.current).toHaveFocus();
  });
});
