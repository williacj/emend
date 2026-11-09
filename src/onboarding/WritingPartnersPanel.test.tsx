// @vitest-environment jsdom
// ABOUTME: Covers `WritingPartnersPanel` — renders a chip per detected provider, re-checks on
// ABOUTME: window focus (FR-X-7 "status re-checks live... without an app restart"), and shows the
// ABOUTME: zero-providers guidance only when every provider reads not_installed.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detectProvidersMock = vi.fn();
vi.mock("./ipc", () => ({ detectProviders: (...args: unknown[]) => detectProvidersMock(...args) }));

const { WritingPartnersPanel } = await import("./WritingPartnersPanel");

describe("WritingPartnersPanel", () => {
  beforeEach(() => {
    detectProvidersMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders one chip per detected provider", async () => {
    detectProvidersMock.mockResolvedValueOnce([
      { provider: "claude_code", state: "signed_in", account: "cj@example.com" },
      { provider: "copilot", state: "installed_signed_out" },
    ]);

    render(<WritingPartnersPanel />);

    await screen.findByText("Claude Code — signed in as cj@example.com");
    expect(screen.getByText("Copilot CLI — installed, not signed in")).toBeInTheDocument();
  });

  it("shows the zero-providers guidance only when every provider is not_installed", async () => {
    detectProvidersMock.mockResolvedValueOnce([
      { provider: "claude_code", state: "not_installed" },
      { provider: "copilot", state: "not_installed" },
    ]);

    render(<WritingPartnersPanel />);

    await screen.findByText(/editor works fully/);
  });

  it("does not show the zero-providers guidance when at least one provider is available", async () => {
    detectProvidersMock.mockResolvedValueOnce([
      { provider: "claude_code", state: "signed_in", account: null },
      { provider: "copilot", state: "not_installed" },
    ]);

    render(<WritingPartnersPanel />);

    await screen.findByText("Claude Code — signed in");
    expect(screen.queryByText(/editor works fully/)).not.toBeInTheDocument();
  });

  it("distinguishes a rejected provider transport from no providers installed", async () => {
    detectProvidersMock.mockRejectedValueOnce(new Error("transport down"));

    render(<WritingPartnersPanel />);

    await screen.findByText("Couldn’t check writing partners.");
    expect(
      screen.queryByText(/editor works fully/),
      "transport failure must not claim zero providers",
    ).not.toBeInTheDocument();
  });

  it("keeps the newest focus probe when an older probe completes last", async () => {
    let resolveFirst!: (value: unknown[]) => void;
    let resolveSecond!: (value: unknown[]) => void;
    detectProvidersMock
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

    render(<WritingPartnersPanel />);
    await waitFor(() => expect(detectProvidersMock).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(detectProvidersMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond([{ provider: "claude_code", state: "installed_signed_out" }]);
    });
    expect(screen.getByText("Claude Code — installed, not signed in")).toBeVisible();

    await act(async () => {
      resolveFirst([{ provider: "claude_code", state: "signed_in", account: "stale@example.com" }]);
    });
    expect(
      screen.getByText("Claude Code — installed, not signed in"),
      "late stale probe must not replace the newest result",
    ).toBeVisible();
  });

  it("re-checks on window focus without an app restart", async () => {
    detectProvidersMock.mockResolvedValue([{ provider: "claude_code", state: "not_installed" }]);

    render(<WritingPartnersPanel />);
    await waitFor(() => expect(detectProvidersMock).toHaveBeenCalledTimes(1));

    detectProvidersMock.mockResolvedValueOnce([
      { provider: "claude_code", state: "signed_in", account: "cj@example.com" },
    ]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await screen.findByText("Claude Code — signed in as cj@example.com");
    expect(detectProvidersMock).toHaveBeenCalledTimes(2);
  });
});
