// @vitest-environment jsdom
// ABOUTME: Covers `ProviderChip` — the three FR-X-7 auth states render visibly and textually
// ABOUTME: distinct remediation, and the sign-in helper reveals the CLI's own command to run.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderChip } from "./ProviderChip";
import type { ProviderStatusEntry } from "./types";

describe("ProviderChip", () => {
  it("not_installed shows a distinct label and a Get-it install link", () => {
    const entry: ProviderStatusEntry = { provider: "claude_code", state: "not_installed" };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    expect(screen.getByText("Claude Code — not installed")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Get Claude Code" });
    expect(link).toHaveAttribute("href", expect.stringContaining("https://"));
  });

  it("installed_signed_out is visibly and textually distinct from not_installed", () => {
    const entry: ProviderStatusEntry = { provider: "copilot", state: "installed_signed_out" };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    expect(screen.getByText("Copilot CLI — installed, not signed in")).toBeInTheDocument();
    expect(screen.queryByText(/not installed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guide me through sign-in" })).toBeInTheDocument();
  });

  it("signed_in shows the account and a checkmark", () => {
    const entry: ProviderStatusEntry = {
      provider: "claude_code",
      state: "signed_in",
      account: "cj@example.com",
    };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    expect(screen.getByText("Claude Code — signed in as cj@example.com")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("signed_in with no reported account still reads as signed in", () => {
    const entry: ProviderStatusEntry = { provider: "copilot", state: "signed_in", account: null };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    expect(screen.getByText("Copilot CLI — signed in")).toBeInTheDocument();
  });

  it("Guide me through sign-in reveals the exact CLI command — never spawning anything itself", () => {
    const entry: ProviderStatusEntry = { provider: "claude_code", state: "installed_signed_out" };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    expect(screen.queryByText("claude auth login")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guide me through sign-in" }));

    expect(screen.getByText("claude auth login")).toBeInTheDocument();
  });

  it("Copy command writes the CLI's own login command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const entry: ProviderStatusEntry = { provider: "copilot", state: "installed_signed_out" };
    render(
      <ul>
        <ProviderChip entry={entry} />
      </ul>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Guide me through sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(writeText).toHaveBeenCalledWith("copilot login");
    await screen.findByRole("button", { name: "Copied" });
  });
});
