// @vitest-environment jsdom
// ABOUTME: Covers `WelcomeScreen` (J8 Screen 1) — the folder-open action, the empty-state Recent
// ABOUTME: list, and the deferred-stub GitHub row (D12: shown, but inert — Clone-from-GitHub and
// ABOUTME: sign-in are out of scope for this unit).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ detectProviders: vi.fn().mockReturnValue(new Promise(() => {})) }));

const { WelcomeScreen } = await import("./WelcomeScreen");

describe("WelcomeScreen", () => {
  it("shows the Open a folder action — an empty Recent list — and the Writing partners panel", () => {
    render(<WelcomeScreen onOpenFolder={() => {}} />);

    expect(screen.getByRole("button", { name: "Open a folder…" })).toBeInTheDocument();
    expect(screen.getByText("(none yet)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Writing partners" })).toBeInTheDocument();
  });

  it("clicking Open a folder calls the provided handler", () => {
    const onOpenFolder = vi.fn();
    render(<WelcomeScreen onOpenFolder={onOpenFolder} />);

    fireEvent.click(screen.getByRole("button", { name: "Open a folder…" }));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("shows the GitHub row in its deferred stub state — present but inert (D12)", () => {
    render(<WelcomeScreen onOpenFolder={() => {}} />);

    expect(screen.getByText(/GitHub: not connected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect now" })).toBeDisabled();
  });
});
