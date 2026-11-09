// @vitest-environment node
// ABOUTME: Pins the 9-series recovery surfaces to the generated light-platform design tokens.
// ABOUTME: Keeps placeholder, Reject-family failures, and Win/mac 9c.8 chrome exact.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match?.[1].replace(/\s+/g, " ").trim() ?? "";
}

describe("9-series recovery design bindings", () => {
  it("separates composed loss facts with the lighter amber divider", () => {
    expect(declarations(":root")).toContain("--color-recovery-separator: #e9d8ac;");
    expect(declarations(".untitled-document__loss-separator")).toContain(
      "border-top: 1px solid var(--color-recovery-separator);",
    );
    expect(declarations(':root[data-theme="dark"]')).toContain(
      "--color-recovery-separator: var(--color-warning-fg);",
    );
  });

  it("sets pane Save As failure in the 11.5px Reject type rhythm", () => {
    const failure = declarations(".untitled-document__error");
    expect(failure).toContain("font-size: 11.5px;");
    expect(failure).toContain("line-height: 1.5;");
    expect(failure).toContain("background-color: var(--color-reject-bg);");
    expect(failure).toContain("color: var(--color-destructive-action);");
  });

  it("shortens the loss reason by 660px and wraps Hide message on narrower panes", () => {
    const short = stylesheet.slice(
      stylesheet.indexOf("@container (max-width: 660px)"),
      stylesheet.indexOf("@container (max-width: 420px)"),
    );
    expect(short).toContain(".untitled-document__loss-provenance,");
    expect(short).toContain(".untitled-document__loss-full {");
    expect(short).toContain("display: none;");
    expect(short).toContain(".untitled-document__loss-short {");
    expect(short).toContain("display: inline;");

    const narrow = stylesheet.slice(
      stylesheet.indexOf("@container (max-width: 420px)"),
      stylesheet.indexOf("@container (max-width: 330px)"),
    );
    expect(narrow).toContain(
      ".untitled-document__loss-notice:not(.untitled-document__loss-notice--collapsed) {",
    );
    expect(narrow).toContain("flex-wrap: wrap;");
    expect(narrow).toContain(".untitled-document__loss-copy {");
    expect(narrow).toContain("flex-basis: calc(100% - 16px);");
    expect(narrow).toContain(".untitled-document__loss-toggle {");
    expect(narrow).toContain("margin-left: 16px;");
  });

  it("uses normal body ink for the instructional placeholder and Reject tokens for failures", () => {
    expect(declarations(":root")).toContain("--color-untitled-placeholder: #6b665c;");
    expect(declarations(".untitled-document__error")).toContain(
      "background-color: var(--color-reject-bg);",
    );
    expect(declarations(".untitled-document__error")).toContain(
      "border-bottom: 1px solid var(--color-reject-border);",
    );
    expect(declarations(".untitled-adoption-pending")).toContain(
      "background: var(--color-reject-bg);",
    );
    expect(declarations(".untitled-adoption-pending")).toContain(
      "border-bottom: 1px solid var(--color-reject-border);",
    );
    expect(declarations(":root")).toContain("--color-session-status-win-bg: #f5f3ed;");
    expect(declarations(":root")).toContain("--color-session-status-mac-bg: #f1eee7;");
  });

  it("uses the exact Windows and macOS 9c.8 dialog chrome", () => {
    const card = declarations(".session-write-failure__card");
    expect(card).toContain("background: var(--color-session-dialog-bg);");
    expect(card).toContain("border: 1px solid var(--color-session-dialog-border);");
    expect(card).toContain("border-radius: 8px;");
    expect(card).toContain("box-shadow: 0 8px 26px rgba(31, 29, 26, 0.16);");

    const macCard = declarations(
      '.session-write-failure[data-platform="mac"] .session-write-failure__card',
    );
    expect(macCard).toContain("border: 0;");
    expect(macCard).toContain("border-radius: 10px;");
    expect(macCard).toContain(
      "box-shadow: 0 12px 32px rgba(31, 29, 26, 0.22), 0 0 0 1px rgba(31, 29, 26, 0.09);",
    );

    const quit = declarations(
      ".session-write-failure__actions .session-write-failure__quit",
    );
    expect(quit).toContain("background: var(--color-reject-bg);");
    expect(quit).toContain("border-color: var(--color-reject-border);");
    expect(quit).toContain("color: var(--color-destructive-action);");

    const stay = declarations(
      ".session-write-failure__actions .session-write-failure__stay",
    );
    expect(stay).toContain("background: var(--color-session-default-bg);");
    expect(stay).toContain("border-color: var(--color-action-border);");
  });
});
