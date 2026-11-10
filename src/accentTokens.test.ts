// ABOUTME: Pins the app's accent to the indigo family in docs/design/specs/tokens.md (refresh 31).
// ABOUTME: Checks the token values, that no old blue survives in src/, and that accent text uses the ink token.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesheet = readFileSync(join(root, "src", "styles.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`Missing CSS rule: ${selector}`);
  const open = stylesheet.indexOf("{", start);
  // A rule may sit on one line (`a { color: x; }`) or span several.
  return `\n${stylesheet.slice(open + 1, stylesheet.indexOf("}", open))}`;
}

function declaration(body: string, property: string): string | undefined {
  return body.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`))?.[1].trim();
}

describe("accent tokens (tokens.md, Accent family, refresh 31)", () => {
  it("sets the light and dark accent, ink and contrast tokens to the indigo family", () => {
    const light = ruleBody(":root");
    const dark = ruleBody(':root[data-theme="dark"]');
    expect({
      lightAccent: declaration(light, "--color-accent"),
      lightInk: declaration(light, "--color-accent-ink"),
      lightContrast: declaration(light, "--color-accent-contrast"),
      darkAccent: declaration(dark, "--color-accent"),
      darkInk: declaration(dark, "--color-accent-ink"),
      darkContrast: declaration(dark, "--color-accent-contrast"),
      darkHeldBg: declaration(dark, "--color-dictation-held-bg"),
    }).toEqual({
      lightAccent: "#4f46e5",
      lightInk: "#4f46e5",
      lightContrast: "#ffffff",
      darkAccent: "#a5b0ff",
      darkInk: "#b7c0ff",
      darkContrast: "#10131a",
      darkHeldBg: "#23284d",
    });
  });

  it("leaves none of the old blue in src/ or e2e/, as hex or as the rgb() a browser reports", () => {
    const hex = "2F5D8C|22456A|5B8DFF|E4EBF4|EAF0F6|B9CBDD|A9C0DC|26324A|CFDDEC";
    const decimal = ["47, ?93, ?140", "34, ?69, ?106", "91, ?141, ?255", "228, ?235, ?244", "234, ?240, ?246",
      "185, ?203, ?221", "169, ?192, ?220", "207, ?221, ?236", "38, ?50, ?74"].join("|");
    // This file names the old values in its own pattern, so it is the one path left out.
    const args = ["grep", "-n", "-i", "-E", `${hex}|${decimal}`, "--", "src", "e2e", ":!src/accentTokens.test.ts"];
    let hits = "";
    try {
      hits = execFileSync("git", args, { cwd: root, encoding: "utf8" });
    } catch (error) {
      // git grep exits 1 when nothing matches; any other status is a real failure.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(hits).toBe("");
  });

  it("sets accent-coloured text in the ink token, which is lighter than the fill in dark", () => {
    const textRules = [
      "button.comment-thread-card__anchor--withdrawn",
      ".agent-working-card__outbound-marker",
      ".comment-thread-card__badge",
      ".comment-thread-card__run-link button",
      ".comment-thread-card__replies summary",
      ".comment-thread-card__address",
      ':root[data-theme="dark"] .comment-thread-card__address',
      '.view-mode-toolbar__format-option:hover:not([aria-disabled="true"]):not(:disabled)',
    ];
    for (const selector of textRules) {
      expect({ selector, color: declaration(ruleBody(selector), "color") })
        .toEqual({ selector, color: "var(--color-accent-ink)" });
    }
    const dark = ruleBody(':root[data-theme="dark"]');
    expect(declaration(ruleBody(":root"), "--color-accent-ring-soft")).toBe("rgba(79, 70, 229, 0.72)");
    expect(declaration(dark, "--color-accent-ring-soft")).toBe("#a5b0ff");
    expect(declaration(dark, "--color-comment-gutter-selected-fg")).toBe("var(--color-accent-ink)");
    expect(declaration(dark, "--color-comment-gutter-resolved-fg")).toBe("var(--color-accent-ink)");
  });
});
