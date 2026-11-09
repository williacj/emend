# Emend rebrand design brief: app icon, accent and design-project refresh

ABOUTME: Handoff for CJ's design project to draw the Emend app icon, adopt the indigo accent, and rebrand the design folder.
ABOUTME: Behavior is owned by `docs/ux-design.md`; this file does not replace `docs/design/` appearance authority.

**Ruling:** CJ, 2026-11-08. The app is renamed **Cowrite → Emend** ("to make corrections to a text": an agent proposes tracked changes and the author accepts or rejects them). It moves to the repository `williacj/emend`, which becomes public. Behavior does not change. CJ also ruled the same day that **the brand accent is the Emend site's indigo**, in the icon and in the app. Tracking: williacj/emend#10 under epic williacj/emend#21.

## Deliverable 1: the Emend app icon

1. **Two masters.** (a) **macOS:** 1024×1024 art with the current macOS app-icon rounded square and grid padding drawn in, because the repo's generator (`npx tauri icon`) does not apply that mask; it must read on light and dark Docks. (b) **Windows and small sizes:** an unpadded glyph as SVG plus 16px and 32px PNGs. The repo assembles `icon.ico`, the Windows tile sizes and the title-bar asset from (b), and `icon.icns`, `icon.png`, `32x32`, `128x128` and `128x128@2x` from (a). Together they replace the current set in `src-tauri/icons/`, including `Square30x30Logo` to `Square310x310Logo` and `StoreLogo`.
2. **One mark, two drawings:** (a) and (b) are the same mark; (b) is simplified where (a)'s detail does not survive 16px.
3. **Windows:** (b) reads at **16px** in the taskbar and at **15px in the title bar**. Every Windows shell frame draws it there (`specs/platform-variants.md`, the shell title-bar row: "App icon (15px, radius 3px, `#2F5D8C`)", currently a plain square placeholder).
4. **What the mark should say:** Emend's one distinctive act is the tracked change, a proposed insertion or deletion that the author rules on. Proofreading marks (caret, strike, stet) are fair territory. A generic AI sparkle or a quill would say nothing about this app. This is a direction, not a prescription.

## Deliverable 2: rebranded design-project refresh (27)

Regenerate `docs/design/` with the product name changed and nothing else:

1. **Files:** `mocks/Cowrite Authoring Shell.dc.html` → `mocks/Emend Authoring Shell.dc.html`; `mocks/Cowrite Wireframes.dc.html` → `mocks/Emend Wireframes.dc.html`. Update every reference to them.
2. **Drawn UI:** every window title and copy line that names the product reads Emend: `Emend — <doc>` (Windows title bar), `Emend` alone where no document clause is drawn (the render-failure fallback, `12a`–`12f`, in `platform-variants.md`), and copy such as `over Emend’s size limit`, `Emend can’t close this window yet…`, and `Emend couldn’t bring <name> to the front.` (typographic apostrophes, as drawn today). Swap the name one-for-one; make no other copy change.
3. **The 15px title-bar placeholder** becomes the Deliverable 1 small-size mark (b) in every Windows frame, light and dark.
4. **Folder prose:** `README.md` reads "Design specs for `williacj/emend`" and "recreate these designs in the Emend codebase". Specs and `amendments/` files that name the product use Emend. `CHANGELOG.md` keeps earlier entries as written (they are history) and adds a (27) entry for the rename.

## Deliverable 3: the indigo accent

CJ ruled (2026-11-08) that Emend's accent is the indigo from the Emend marketing page, replacing the app's blue. The icon uses it, and the app's accent token moves to it.

| Role | Today (`specs/tokens.md`) | Emend |
|---|---|---|
| Accent, light | `#2F5D8C` | `#4f46e5` |
| Link / hover-dark, light | `#22456A` | `#4338ca` |
| Accent and focus ring, dark | `#5B8DFF` | `#a5b0ff` |
| Accent ink, dark | (none) | `#b7c0ff` |

1. **Derive the rest of the accent family** in the same hue: today's tints `#E4EBF4` and `#EAF0F6`, borders `#B9CBDD` and `#A9C0DC`, the focus-ring `rgba(47,93,140,.45)`, and the dark held-selection tint `#26324A`. Record every new value in `specs/tokens.md`.
2. **Keep contrast:** text, links and focus rings in the new accent meet WCAG AA against the paper and dark surfaces they sit on. Where a site value fails on an app surface, adjust lightness within the hue and record why.
3. **Accent only:** comment amber, accept green, reject red, neutrals and the dark surfaces keep their current values. The site's own green and red are not adopted.
4. **Redraw** every frame that uses an accent value, Windows and macOS, light and dark, and the 15px title-bar mark (Deliverable 1 (b)).

**Authority boundary:** This brief requests a new icon, the name change, and the accent family only. Layout, every other token, states, and behavior are unchanged, and every gap in `docs/design/specs/state.md` "Known gaps" stays open. The app's copy changes in the same rename (williacj/emend#6), with `docs/ux-design.md` governing the wording. Until this refresh lands, the existing `docs/design/` keeps governing appearance, and its Cowrite naming is an expected, temporary mismatch.
