// @vitest-environment jsdom
// ABOUTME: Verifies the app-owned title row keeps real window controls behind the normal Tauri close event.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowCommands = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowCommands }));

import { WindowChrome } from "./WindowChrome";

describe("WindowChrome", () => {
  beforeEach(() => {
    for (const command of Object.values(windowCommands)) {
      command.mockReset().mockResolvedValue(undefined);
    }
  });

  it("routes Windows title controls to minimize, maximize, and the guarded close request", () => {
    render(<WindowChrome platform="win" title="Emend — notes.md" />);
    const header = screen.getByRole("banner");
    expect(header).toHaveAttribute("data-platform", "win");
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByText("Emend — notes.md")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize or restore window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(windowCommands.minimize).toHaveBeenCalledOnce();
    expect(windowCommands.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowCommands.close).toHaveBeenCalledOnce();
  });

  it("lets Tauri own double-click maximize and makes the full noninteractive title row draggable", () => {
    render(<WindowChrome platform="win" title="Emend — notes.md" status={<span>Connected</span>} />);
    const header = screen.getByRole("banner");
    expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(screen.getByText("Connected").closest(".app-header__status")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("Connected"));
    expect(windowCommands.toggleMaximize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Maximize or restore window" }));
    expect(windowCommands.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("reserves the macOS native traffic-light lane and renders no duplicate web controls", () => {
    render(<WindowChrome platform="mac" title="notes.md" />);
    expect(screen.getByRole("banner")).toHaveAttribute("data-platform", "mac");
    expect(screen.getByText("notes.md")).toBeVisible();
    expect(document.querySelector(".app-header__traffic-light-space")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close window" })).not.toBeInTheDocument();
  });
});
