// @vitest-environment jsdom
// ABOUTME: Pins J15 turn-12 whole-window geometry, palette, typography, and platform focus rings.
// ABOUTME: Loads the shipped stylesheet so Windows and macOS variants are checked as rendered CSS.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RenderFailureFallback } from "./RenderFailureFallback";
import type { FailureContext } from "./types";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);
const CONTEXT: FailureContext = {
  selector: "author-no-project",
  runWasActive: false,
  closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
};

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return STYLESHEET.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function mount(platform: "win" | "mac") {
  const style = document.createElement("style");
  style.textContent = STYLESHEET;
  document.head.append(style);
  const result = render(
    <div className="render-recovery-attempt render-recovery-attempt--fallback">
      <RenderFailureFallback
        context={CONTEXT}
        requestState="rest"
        closeRefusal={null}
        platform={platform}
        instanceId={1}
        visible
        onReload={() => {}}
      />
    </div>,
  );
  return { ...result, style };
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
});

describe("render-failure turn-12 appearance", () => {
  it("routes the fallback appearance through its central semantic token contract", () => {
    const root = rule(":root");
    for (const declaration of [
      "--color-render-failure-canvas: #edeae3",
      "--color-render-failure-heading: #1f1d1a",
      "--color-render-failure-body: #4a463e",
      "--color-render-failure-button-bg: var(--color-render-failure-heading)",
      "--color-render-failure-button-fg: #fcfbf8",
      "--color-render-failure-button-disabled-border: #d5d0c4",
      "--color-render-failure-button-disabled-bg: #e8e4db",
      "--color-render-failure-button-disabled-fg: #6b665c",
      "--color-render-failure-status: #33302a",
      "--color-render-failure-error: #a33a2e",
      "--font-render-failure-heading: \"Source Serif 4\", Georgia, serif",
      "--font-render-failure-body: \"IBM Plex Sans\", system-ui, sans-serif",
      "--radius-render-failure-button-win: 6px",
      "--radius-render-failure-button-mac: 7px",
      "--shadow-render-failure-button-mac: 0 1px 2px rgba(31, 29, 26, 0.18)",
      "--outline-render-failure-focus-win: 2px solid var(--color-render-failure-heading)",
      "--outline-render-failure-focus-mac: 3px solid rgba(47, 93, 140, 0.45)",
      "--outline-offset-render-failure-root: 6px",
      "--outline-offset-render-failure-button: 3px",
    ]) {
      expect(root).toContain(declaration);
    }
    expect(rule(".render-recovery-attempt--fallback"))
      .toContain("background: var(--color-render-failure-canvas)");
    expect(rule(".render-failure h1"))
      .toContain("font-family: var(--font-render-failure-heading)");
    expect(rule(".render-failure__action button"))
      .toContain("border-radius: var(--radius-render-failure-button-win)");

    const fallbackRules = STYLESHEET.slice(
      STYLESHEET.indexOf("/* J15 / turn 12: the shell"),
      STYLESHEET.indexOf(":root[data-theme=\"dark\"]"),
    );
    expect(fallbackRules, "fallback selector rules must contain no raw colors")
      .not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(fallbackRules, "fallback selector rules must contain no raw heading font")
      .not.toContain("\"Source Serif 4\"");
    expect(fallbackRules, "fallback selector rules must contain no raw body font")
      .not.toContain("\"IBM Plex Sans\"");
  });

  it("uses the neutral terminal canvas and top-weighted 520px typographic column", () => {
    const { container } = mount("win");
    const attempt = container.firstElementChild as HTMLElement;
    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading");
    const body = screen.getByText("No project is open in this window. Reloading starts Emend again.");

    expect(rule(".render-recovery-attempt--fallback"))
      .toContain("background: var(--color-render-failure-canvas)");
    expect(getComputedStyle(attempt).minHeight).toBe("100vh");
    expect(rule(".render-failure")).toContain("width: min(520px, calc(100% - 48px))");
    expect(getComputedStyle(main).paddingTop).toBe("96px");
    expect(getComputedStyle(heading).fontSize).toBe("21px");
    expect(rule(".render-failure h1"))
      .toContain("font-family: var(--font-render-failure-heading)");
    expect(getComputedStyle(body).fontSize).toBe("13.5px");
    expect(rule(".render-failure > p"))
      .toContain("font-family: var(--font-render-failure-body)");
  });

  it("keeps target-specific offsets while changing only platform ring weight and color", () => {
    const win = mount("win");
    const winButton = screen.getByRole("button");
    expect(rule(".render-failure"))
      .toContain("outline-offset: var(--outline-offset-render-failure-root)");
    expect(rule('.render-failure[data-platform="win"]:focus'))
      .toContain("outline: var(--outline-render-failure-focus-win)");
    winButton.focus();
    expect(rule(".render-failure__action button"))
      .toContain("outline-offset: var(--outline-offset-render-failure-button)");
    expect(rule('.render-failure[data-platform="win"] .render-failure__action button:focus-visible'))
      .toContain("outline: var(--outline-render-failure-focus-win)");
    win.unmount();

    mount("mac");
    const macButton = screen.getByRole("button");
    expect(rule(".render-failure"))
      .toContain("outline-offset: var(--outline-offset-render-failure-root)");
    expect(rule('.render-failure[data-platform="mac"]:focus'))
      .toContain("outline: var(--outline-render-failure-focus-mac)");
    macButton.focus();
    expect(rule(".render-failure__action button"))
      .toContain("outline-offset: var(--outline-offset-render-failure-button)");
    expect(rule('.render-failure[data-platform="mac"] .render-failure__action button:focus-visible'))
      .toContain("outline: var(--outline-render-failure-focus-mac)");
  });
});
