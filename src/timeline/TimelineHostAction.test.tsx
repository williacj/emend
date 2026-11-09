// @vitest-environment jsdom
// ABOUTME: Contract tests for J7's expanded and collapsed Timeline permission-attention hosts.
// ABOUTME: Pins badge accessibility, clear-time focus, and the stable collapsed DOM.
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TimelineHostAction } from "./TimelineHostAction";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

describe("timeline/TimelineHostAction", () => {
  it("turns only the expanded label into one nonnumeric permission action", () => {
    const onActivate = vi.fn();
    const view = render(<TimelineHostAction mode="expanded" pending onActivate={onActivate} />);
    const action = screen.getByRole("button", { name: "Show permission request in Timeline" });
    expect(action).toHaveTextContent("TIMELINE");
    expect(action.querySelectorAll(".timeline-host__permission-badge")).toHaveLength(1);
    expect(action.querySelector(".timeline-host__permission-badge")).not.toHaveTextContent(/[0-9]/);
    expect(action.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(action);
    expect(onActivate).toHaveBeenCalledOnce();

    view.rerender(<TimelineHostAction mode="expanded" pending={false} onActivate={onActivate} />);
    expect(screen.queryByRole("button", { name: "Show permission request in Timeline" })).toBeNull();
    expect(screen.getByText("TIMELINE")).toHaveClass("timeline-host__label");
  });

  it("keeps one non-actionable level-2 Timeline heading mounted across pending state", () => {
    const onActivate = vi.fn();
    const view = render(<TimelineHostAction mode="expanded" pending={false} onActivate={onActivate} />);
    const heading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(<TimelineHostAction mode="expanded" pending onActivate={onActivate} />);
    expect(screen.getByRole("heading", { level: 2, name: "Timeline" })).toBe(heading);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("moves focus from a clearing expanded action to its owner-provided collapse toggle", () => {
    const collapseRef = createRef<HTMLButtonElement>();
    const view = render(
      <>
        <TimelineHostAction
          mode="expanded"
          pending
          onActivate={() => {}}
          clearedFocusTargetRef={collapseRef}
        />
        <button ref={collapseRef}>Collapse Timeline</button>
      </>,
    );
    screen.getByRole("button", { name: "Show permission request in Timeline" }).focus();
    view.rerender(
      <>
        <TimelineHostAction
          mode="expanded"
          pending={false}
          onActivate={() => {}}
          clearedFocusTargetRef={collapseRef}
        />
        <button ref={collapseRef}>Collapse Timeline</button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Collapse Timeline" })).toHaveFocus();
  });

  it("falls back from a clearing focused action to the persistent heading without activation", () => {
    const onActivate = vi.fn();
    const view = render(<TimelineHostAction mode="expanded" pending onActivate={onActivate} />);
    const persistentHeading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    const focusSpy = vi.spyOn(persistentHeading, "focus");
    screen.getByRole("button", { name: "Show permission request in Timeline" }).focus();

    view.rerender(<TimelineHostAction mode="expanded" pending={false} onActivate={onActivate} />);

    const heading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    expect(heading).toHaveFocus();
    expect(heading).toHaveClass("timeline-host__label--programmatic-focus");
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("uses the persistent heading when the owner-provided collapse toggle is not focusable", () => {
    const collapseRef = createRef<HTMLButtonElement>();
    const view = render(
      <>
        <TimelineHostAction
          mode="expanded"
          pending
          onActivate={() => {}}
          clearedFocusTargetRef={collapseRef}
        />
        <button ref={collapseRef} disabled>Collapse Timeline</button>
      </>,
    );
    screen.getByRole("button", { name: "Show permission request in Timeline" }).focus();

    view.rerender(
      <>
        <TimelineHostAction
          mode="expanded"
          pending={false}
          onActivate={() => {}}
          clearedFocusTargetRef={collapseRef}
        />
        <button ref={collapseRef} disabled>Collapse Timeline</button>
      </>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Timeline" })).toHaveFocus();
  });

  it("does not move heading focus to a newly remounted permission action", () => {
    const onActivate = vi.fn();
    const view = render(<TimelineHostAction mode="expanded" pending={false} onActivate={onActivate} />);
    const heading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    heading.focus();

    view.rerender(<TimelineHostAction mode="expanded" pending onActivate={onActivate} />);

    expect(screen.getByRole("heading", { level: 2, name: "Timeline" })).toBe(heading);
    expect(heading).toHaveFocus();
    expect(screen.getByRole("button", { name: "Show permission request in Timeline" })).not.toHaveFocus();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("does not restore focus after the attention action deliberately loses it without a destination", () => {
    const view = render(<TimelineHostAction mode="expanded" pending onActivate={() => {}} />);
    const action = screen.getByRole("button", { name: "Show permission request in Timeline" });
    action.focus();
    action.blur();

    view.rerender(<TimelineHostAction mode="expanded" pending={false} onActivate={() => {}} />);

    const heading = screen.getByRole("heading", { level: 2, name: "Timeline" });
    expect(heading).not.toHaveFocus();
    expect(heading).not.toHaveClass("timeline-host__label--programmatic-focus");
  });

  it("keeps the collapsed Timeline button mounted when its pending badge clears", () => {
    const view = render(<TimelineHostAction mode="collapsed" pending onActivate={() => {}} />);
    const action = screen.getByRole("button", { name: "Show permission request in Timeline" });
    view.rerender(<TimelineHostAction mode="collapsed" pending={false} onActivate={() => {}} />);
    expect(screen.getByRole("button", { name: "Show Timeline" })).toBe(action);
    expect(action).toHaveTextContent("Timeline");
    expect(action.querySelector(".timeline-host__permission-badge")).toBeNull();
  });

  it("pins the refreshed 16px light badge with dark derivation and focus treatment", () => {
    expect(STYLESHEET).toContain("--color-timeline-permission-badge-bg: #b5871f;");
    expect(STYLESHEET).toContain("--color-timeline-permission-badge-fg: #ffffff;");
    expect(STYLESHEET).toContain("--color-timeline-permission-badge-bg: var(--color-warning-fg);");
    expect(STYLESHEET).toContain("--color-timeline-permission-badge-fg: var(--color-bg);");
    expect(STYLESHEET).toMatch(
      /\.timeline-host__permission-badge\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*border-radius:\s*50%;/s,
    );
    expect(STYLESHEET).toMatch(
      /\.timeline-host__attention-action:focus-visible,[^{]*\{[^}]*outline:\s*2px solid var\(--color-accent\);[^}]*outline-offset:\s*1px;/s,
    );
    expect(STYLESHEET).toMatch(
      /\.timeline-host__label--programmatic-focus:focus\s*\{[^}]*outline:\s*2px solid var\(--color-accent\);[^}]*outline-offset:\s*1px;/s,
    );
  });
});
