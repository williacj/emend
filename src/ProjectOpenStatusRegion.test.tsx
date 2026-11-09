// @vitest-environment jsdom
// ABOUTME: Exercises the one-line J9 status region, contextual controls, and in-flight behavior.
// ABOUTME: Pins refresh-16 action order, retry focus retention, dismissal, and atomic announcements.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectOpenStatusRegion } from "./ProjectOpenStatusRegion";
import type { ProjectOpenStatus } from "./stores/projectOpenStatus";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return STYLESHEET.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

const failure: ProjectOpenStatus = {
  phase: "finished",
  requestId: "request-1",
  retryPending: false,
  outcome: {
    status: "failed",
    root: "/work/launch-plan",
    failureRoute: "launch",
    reason: "launch_failed",
  },
};

describe("ProjectOpenStatusRegion (J9, #1752)", () => {
  it("announces one atomic requesting line and keeps Dismiss available", () => {
    const onDismiss = vi.fn();
    render(<ProjectOpenStatusRegion onDismiss={onDismiss} status={{
      phase: "requesting",
      requestId: "request-1",
      root: "/work/sermon-notes",
      queued: 1,
    }} />);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Opening sermon-notes… · 1 more queued");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the queued count in the same announcement with muted secondary ink", () => {
    render(<ProjectOpenStatusRegion status={{
      phase: "requesting",
      requestId: "request-2",
      root: "/work/sermon-notes",
      queued: 3,
    }} />);

    const region = screen.getByRole("status");
    const queue = region.querySelector(".project-open-status__queue");
    expect(region).toHaveTextContent("Opening sermon-notes… · 3 more queued");
    expect(queue?.textContent).toBe(" · 3 more queued");
    expect(rule(".project-open-status__queue"))
      .toContain("color: var(--color-project-open-status-detail)");
  });

  it("renders the failure reason in the same line, then Try again, then Dismiss", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectOpenStatusRegion status={failure} onRetry={onRetry} onDismiss={onDismiss} />,
    );

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(
      "Cowrite couldn’t open launch-plan in a new window. The new window didn’t start.",
    );
    expect(within(region).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Try again", "Dismiss"]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps a retry-pending button focused and inert while Dismiss stays available", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectOpenStatusRegion
        status={{ ...failure, retryPending: true }}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />,
    );

    const region = screen.getByRole("status");
    const trying = screen.getByRole("button", { name: "Trying…" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(trying).toHaveAttribute("aria-disabled", "true");
    expect(trying).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    trying.focus();
    fireEvent.click(trying);
    expect(trying).toHaveFocus();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders Show the run before Dismiss and exposes the region ref for clear-time focus", () => {
    const regionRef = createRef<HTMLDivElement>();
    const onShowRun = vi.fn();
    render(
      <ProjectOpenStatusRegion
        ref={regionRef}
        status={{
          phase: "close_blocked",
          root: "/work/product-comms",
          runId: "run-7",
        }}
        onShowRun={onShowRun}
        onDismiss={vi.fn()}
      />,
    );

    expect(regionRef.current).toBe(screen.getByRole("status"));
    expect(within(regionRef.current!).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Show the run", "Dismiss"]);
    fireEvent.click(screen.getByRole("button", { name: "Show the run" }));
    expect(onShowRun).toHaveBeenCalledWith("run-7");
  });

  it("routes the band and run-card focus ring through light and dark semantic tokens", () => {
    const root = rule(":root");
    for (const declaration of [
      "--color-project-open-status-bg: #f7f5ef",
      "--color-project-open-status-border: #e3dfd6",
      "--color-project-open-status-mac-border: #dcd7cc",
      "--color-project-open-status-fg: #33302a",
      "--color-project-open-status-detail: #6b665c",
      "--color-project-open-status-action-border: #d5d0c4",
      "--color-project-open-status-action-bg: #fcfbf8",
      "--color-project-open-status-action-active-bg: #edeae2",
      "--color-project-open-status-action-pending-bg: #e8e4db",
      "--color-project-open-status-dismiss: #a39e92",
      "--color-project-open-status-focus: #2f5d8c",
      '--font-project-open-status: "IBM Plex Sans", system-ui, sans-serif',
    ]) {
      expect(root).toContain(declaration);
    }

    const dark = rule(':root[data-theme="dark"]');
    for (const declaration of [
      "--color-project-open-status-bg: var(--color-surface)",
      "--color-project-open-status-border: var(--color-border)",
      "--color-project-open-status-mac-border: var(--color-border)",
      "--color-project-open-status-fg: var(--color-fg)",
      "--color-project-open-status-detail: var(--color-muted)",
      "--color-project-open-status-action-border: var(--color-border)",
      "--color-project-open-status-action-bg: var(--color-bg)",
      "--color-project-open-status-action-active-bg: var(--color-border)",
      "--color-project-open-status-action-pending-bg: var(--color-surface)",
      "--color-project-open-status-dismiss: var(--color-muted)",
      "--color-project-open-status-focus: var(--color-accent)",
    ]) {
      expect(dark).toContain(declaration);
    }

    const bandRules = STYLESHEET.slice(
      STYLESHEET.indexOf(".shell-status--project-open {"),
      STYLESHEET.indexOf("/* The app-body row"),
    );
    expect(bandRules, "project-open selectors must contain no raw colors")
      .not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(bandRules, "project-open selectors must contain no raw body font")
      .not.toContain('"IBM Plex Sans"');
    expect(rule(".timeline-card--focus-target:focus"))
      .toContain("outline: 2px solid var(--color-project-open-status-focus)");
  });
});
