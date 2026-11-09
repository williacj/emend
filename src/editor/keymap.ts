// ABOUTME: Single source of truth for the app's keybindings (P2b-9b, #362, FR-X-1; tech-design
// ABOUTME: §3.1 "native menus + Cmd/Ctrl layer ... = Tauri menu plugin + a single keymap module").
// ABOUTME: Every bound key — J1 triage, save, and the tab strip's roving-tabindex navigation — is
// ABOUTME: named and specified here once; CM6 extensions and the tab strip both read these
// ABOUTME: definitions rather than each restating a key combination of their own, so a binding
// ABOUTME: (and eventually a native menu item mirroring it) can never drift out of sync.

/**
 * True on macOS, where `Mod` resolves to Cmd rather than Ctrl (FR-X-1). CodeMirror's own `keymap`
 * facility already resolves a literal `"Mod-…"` spec against this same platform fact internally
 * when a binding is installed via `keymap.of(...)` — this export exists for the *display* half
 * (`displayShortcut`) and anything resolving a spec outside that facility (`resolveMod`), so both
 * sides read one platform fact rather than two independent `navigator.platform` checks that could
 * silently drift apart.
 */
export const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/**
 * A named app keybinding. `spec` is a CodeMirror-style key spec using the `Mod` placeholder
 * (resolved to Cmd on macOS, Ctrl on Windows/Linux); `label` is the human name a menu item or
 * tooltip shows beside the resolved shortcut.
 */
export interface KeymapEntry {
  readonly id: string;
  readonly spec: string;
  readonly label: string;
}

/**
 * The app's whole Cmd/Ctrl keybinding table (FR-X-1) — the one place a binding's key combination is
 * defined. `editor/trackedChanges.ts` (J1 triage) and `editor/EditorShell.tsx` (save) each build
 * their own CM6 `KeyBinding` from an entry's `spec` rather than restating the key combination, so a
 * menu item and its keyboard shortcut cannot drift (tech-design §3.1).
 */
export const KEYMAP = {
  acceptChange: { id: "acceptChange", spec: "Mod-Enter", label: "Accept change" },
  rejectChange: { id: "rejectChange", spec: "Mod-Backspace", label: "Reject change" },
  save: { id: "save", spec: "Mod-s", label: "Save" },
  bold: { id: "bold", spec: "Mod-b", label: "Bold" },
  italic: { id: "italic", spec: "Mod-i", label: "Italic" },
  documentEnd: { id: "documentEnd", spec: "Mod-End", label: "Document end" },
} as const satisfies Record<string, KeymapEntry>;

/**
 * `spec`'s `Mod` placeholder resolved to the literal modifier name this platform binds it to
 * (`Cmd`/`Ctrl`) — for a consumer that needs the resolved word itself. A plain CM6
 * `keymap.of([{ key: spec, ... }])` needs no call to this: CodeMirror's own keymap facility already
 * performs this same per-platform resolution internally.
 */
export function resolveMod(spec: string, mac: boolean = isMac): string {
  return spec.replace(/\bMod\b/, mac ? "Cmd" : "Ctrl");
}

/** Mac's conventional single-glyph symbols for the modifier names a `spec` can carry. */
const MAC_SYMBOL: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
};

/**
 * The human-displayable shortcut text for `spec` on the current (or given) platform — e.g.
 * `⌘Enter` on macOS, `Ctrl+Enter` elsewhere — so UI can show the real bound key instead of
 * hardcoding a glyph (acceptance criterion of #362). macOS renders the conventional symbol cluster
 * with no separator and single letters uppercased (`⌘S`); elsewhere, named keys join with `+` and
 * single letters uppercase the same way (`Ctrl+S`).
 */
export function displayShortcut(spec: string, mac: boolean = isMac): string {
  if (mac) {
    return spec
      .split("-")
      .map((part) => MAC_SYMBOL[part] ?? capitalizeKey(part))
      .join("");
  }
  return resolveMod(spec, false)
    .split("-")
    .map(capitalizeKey)
    .join("+");
}

function capitalizeKey(part: string): string {
  return part.length === 1 ? part.toUpperCase() : part;
}

/**
 * The tab strip's WAI-ARIA `tablist` roving-tabindex key contract (T2/FR-ED-3): the tab index a key
 * press moves selection to, given the currently-focused `index` among `count` tabs — or `undefined`
 * for a key the tab strip does not handle (falls through to the browser default). The one place
 * this mapping is specified; `editor/TabBar.tsx` only wires it to its own DOM/focus handling.
 */
export function tabListNavigation(key: string, index: number, count: number): number | undefined {
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return index === last ? 0 : index + 1;
    case "ArrowLeft":
    case "ArrowUp":
      return index === 0 ? last : index - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    case "Enter":
    case " ":
      return index;
    default:
      return undefined;
  }
}
