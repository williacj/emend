// @vitest-environment jsdom
// ABOUTME: Covers the zero-provider "quiet status chip" (J8, FR-X-7): renders nothing while
// ABOUTME: providers are still loading or once any provider is available, and renders exactly one
// ABOUTME: unobtrusive chip (no modal, no nag) when every provider reads not_installed.
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatusEntry } from "./types";

const detectProvidersMock = vi.fn();
vi.mock("./ipc", () => ({ detectProviders: (...args: unknown[]) => detectProvidersMock(...args) }));

const { EditorOnlyStatusChip } = await import("./EditorOnlyStatusChip");

describe("EditorOnlyStatusChip", () => {
  beforeEach(() => {
    detectProvidersMock.mockReset();
  });

  it("renders nothing before the first detection round resolves", () => {
    detectProvidersMock.mockReturnValueOnce(new Promise(() => {})); // never resolves
    render(<EditorOnlyStatusChip />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders the quiet chip when zero providers are installed", async () => {
    detectProvidersMock.mockResolvedValueOnce([
      { provider: "claude_code", state: "not_installed" },
      { provider: "copilot", state: "not_installed" },
    ]);

    render(<EditorOnlyStatusChip />);

    const chip = await screen.findByRole("status");
    expect(chip).toHaveTextContent("Editor-only");
  });

  it("renders nothing once at least one provider is available — no nagging", async () => {
    const result: ProviderStatusEntry[] = [
      { provider: "claude_code", state: "installed_signed_out" },
      { provider: "copilot", state: "not_installed" },
    ];
    const resolved = Promise.resolve(result);
    detectProvidersMock.mockReturnValueOnce(resolved);

    render(<EditorOnlyStatusChip />);
    await act(async () => {
      await resolved;
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
