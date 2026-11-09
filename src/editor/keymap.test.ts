// @vitest-environment jsdom
// ABOUTME: Tests for the single keymap module (P2b-9b, #362, FR-X-1): per-platform binding
// ABOUTME: resolution/display, the tab-strip roving-tabindex table, and the no-duplicate-definition
// ABOUTME: contract that keeps this the app's one place a Cmd/Ctrl-style binding is defined.
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KEYMAP, displayShortcut, resolveMod, tabListNavigation } from "./keymap";

describe("editor/keymap — KEYMAP table", () => {
  it("names every currently-shipped J1 triage, save, and J14 format binding exactly once", () => {
    expect(KEYMAP.acceptChange.spec).toBe("Mod-Enter");
    expect(KEYMAP.rejectChange.spec).toBe("Mod-Backspace");
    expect(KEYMAP.save.spec).toBe("Mod-s");
    expect(KEYMAP.bold.spec).toBe("Mod-b");
    expect(KEYMAP.italic.spec).toBe("Mod-i");
    expect(KEYMAP.documentEnd.spec).toBe("Mod-End");
  });
});

describe("editor/keymap — resolveMod (per-platform Mod resolution)", () => {
  it("resolves Mod to Cmd on macOS", () => {
    expect(resolveMod("Mod-Enter", true)).toBe("Cmd-Enter");
  });

  it("resolves Mod to Ctrl on Windows/Linux", () => {
    expect(resolveMod("Mod-Enter", false)).toBe("Ctrl-Enter");
  });

  it("leaves non-Mod parts of the spec untouched", () => {
    expect(resolveMod("Mod-Backspace", true)).toBe("Cmd-Backspace");
    expect(resolveMod("Mod-s", false)).toBe("Ctrl-s");
  });
});

describe("editor/keymap — displayShortcut (UI-facing resolved binding)", () => {
  it("renders the mac symbol cluster with no separator", () => {
    expect(displayShortcut("Mod-Enter", true)).toBe("⌘Enter");
    expect(displayShortcut("Mod-Backspace", true)).toBe("⌘Backspace");
    expect(displayShortcut("Mod-s", true)).toBe("⌘S");
  });

  it("renders the Windows/Linux name joined with +", () => {
    expect(displayShortcut("Mod-Enter", false)).toBe("Ctrl+Enter");
    expect(displayShortcut("Mod-Backspace", false)).toBe("Ctrl+Backspace");
    expect(displayShortcut("Mod-s", false)).toBe("Ctrl+S");
  });
});

describe("editor/keymap — tabListNavigation (tab-strip roving-tabindex table, T2/FR-ED-3)", () => {
  it("ArrowRight/ArrowDown move to the next tab (wrapping past the last)", () => {
    expect(tabListNavigation("ArrowRight", 0, 3)).toBe(1);
    expect(tabListNavigation("ArrowDown", 2, 3)).toBe(0);
  });

  it("ArrowLeft/ArrowUp move to the previous tab (wrapping before the first)", () => {
    expect(tabListNavigation("ArrowLeft", 1, 3)).toBe(0);
    expect(tabListNavigation("ArrowUp", 0, 3)).toBe(2);
  });

  it("Home/End jump to the first/last tab", () => {
    expect(tabListNavigation("Home", 1, 3)).toBe(0);
    expect(tabListNavigation("End", 1, 3)).toBe(2);
  });

  it("Enter/Space activate the currently-focused index", () => {
    expect(tabListNavigation("Enter", 1, 3)).toBe(1);
    expect(tabListNavigation(" ", 2, 3)).toBe(2);
  });

  it("returns undefined for a key it does not handle", () => {
    expect(tabListNavigation("x", 1, 3)).toBeUndefined();
  });
});

describe("editor/keymap — single source of truth (no duplicate binding definitions)", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC_ROOT = resolve(HERE, "..");
  const SKIP_DIRS = new Set(["node_modules"]);

  // The exact `KeyBinding.key` shape (`{ key: "Mod-…", … }`) every CM6 keymap in this codebase
  // uses, widened to the full modifier alternation so a *platform-hardcoded* binding (e.g.
  // `key: "Ctrl-p"`) is caught too — that is the worse FR-X-1 violation `keymap.ts` exists to
  // prevent, not just a restated `Mod-`. A second literal definition matching this is exactly the
  // drift #362 exists to prevent (grep this repo for it and this test IS that grep, enforced in CI
  // rather than by hand). `keymap.ts` itself uses `spec:`, never `key:`, so it never matches this
  // pattern on its own merits — no self-exclusion is needed or granted.
  const bindingPattern = /key:\s*["'`](Mod|Cmd|Ctrl|Alt|Shift)[-+]/;

  function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectSourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
        files.push(full);
      }
    }
    return files;
  }

  it("matches a raw Mod-key CM6 binding (the original shape)", () => {
    expect(bindingPattern.test('keymap.of([{ key: "Mod-Enter", run: accept }])')).toBe(true);
  });

  it("matches a platform-hardcoded binding — the worse FR-X-1 violation not just Mod-", () => {
    expect(bindingPattern.test('keymap.of([{ key: "Ctrl-p", run: cmd }])')).toBe(true);
    expect(bindingPattern.test("key: 'Cmd-k'")).toBe(true);
    expect(bindingPattern.test("key: `Alt-x`")).toBe(true);
    expect(bindingPattern.test('key: "Shift-Tab"')).toBe(true);
  });

  it("does not match keymap.ts's own spec: shape", () => {
    expect(bindingPattern.test('spec: "Mod-Enter"')).toBe(false);
  });

  it("no file outside keymap.ts defines a raw or platform-hardcoded CM6 binding", () => {
    const keymapFile = resolve(HERE, "keymap.ts");
    const offenders = collectSourceFiles(SRC_ROOT)
      .filter((file) => resolve(file) !== keymapFile)
      .filter((file) => bindingPattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
