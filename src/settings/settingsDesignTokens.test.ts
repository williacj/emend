// @vitest-environment node
// ABOUTME: Pins Settings window and control chrome to the exact binding Win/mac platform variants.
// ABOUTME: Covers the dialog and the app-header entry so neither silently falls back to shared chrome.
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

describe("Settings binding platform chrome", () => {
  it("uses exact Windows control hairlines, radius, and full window shadow", () => {
    const root = declarations(":root");
    expect(root).toContain("--color-settings-control-bg: #ffffff;");
    expect(root).toContain("--color-settings-win-control-border: #d5d0c4;");
    expect(root).toContain(
      "--shadow-settings-window-win: 0 18px 44px rgba(31, 29, 26, 0.18), 0 0 0 1px rgba(31, 29, 26, 0.1);",
    );

    const window = declarations('.settings-dialog[data-platform="win"]');
    expect(window).toContain("border: 1px solid var(--color-settings-border);");
    expect(window).toContain("border-radius: 8px;");
    expect(window).toContain("box-shadow: var(--shadow-settings-window-win);");

    const controls = declarations(
      '.app-header__settings[data-platform="win"], .settings-dialog[data-platform="win"] button, .settings-dialog[data-platform="win"] select',
    );
    expect(controls).toContain("border: 1px solid var(--color-settings-win-control-border);");
    expect(controls).toContain("border-radius: 6px;");
    expect(controls).toContain("box-shadow: none;");

    expect(
      declarations('.settings-dialog[data-platform="win"] .settings-dialog__header'),
    ).toContain("border-bottom: 1px solid var(--color-settings-border);");
    expect(
      declarations('.settings-dialog[data-platform="win"] .settings-dialog__nav'),
    ).toContain("border-right: 1px solid var(--color-settings-border);");
    expect(
      declarations(
        '.settings-dialog[data-platform="win"] .settings-dialog__nav [aria-current="page"]',
      ),
    ).toContain("border-radius: 5px;");
  });

  it("uses exact macOS borderless controls, hairline ring, radius, and full window shadow", () => {
    const root = declarations(":root");
    expect(root).toContain("--color-settings-mac-control-hairline: #dcd7cc;");
    expect(root).toContain(
      "--shadow-settings-window-mac: 0 22px 54px rgba(31, 29, 26, 0.22), 0 0 0 1px rgba(31, 29, 26, 0.1);",
    );

    const window = declarations('.settings-dialog[data-platform="mac"]');
    expect(window).toContain("border: 0;");
    expect(window).toContain("border-radius: 12px;");
    expect(window).toContain("box-shadow: var(--shadow-settings-window-mac);");

    const controls = declarations(
      '.app-header__settings[data-platform="mac"], .settings-dialog[data-platform="mac"] button, .settings-dialog[data-platform="mac"] select',
    );
    expect(controls).toContain("border: 0;");
    expect(controls).toContain("border-radius: 7px;");
    expect(controls).toContain(
      "box-shadow: 0 0 0 1px var(--color-settings-mac-control-hairline);",
    );

    expect(
      declarations('.settings-dialog[data-platform="mac"] .settings-dialog__header'),
    ).toContain("box-shadow: 0 1px 0 var(--color-settings-border);");
    expect(
      declarations('.settings-dialog[data-platform="mac"] .settings-dialog__nav'),
    ).toContain("box-shadow: 1px 0 0 var(--color-settings-border);");
    expect(
      declarations(
        '.settings-dialog[data-platform="mac"] .settings-dialog__nav [aria-current="page"]',
      ),
    ).toContain("border-radius: 7px;");
  });
});
