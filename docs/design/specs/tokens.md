# Design tokens

## Colors

### Neutrals (warm paper scale)

| Value | Used for |
|---|---|
| `#FCFBF8` | document canvas, cards |
| `#FAF8F3` | toolbar, mac inputs |
| `#F7F5EF` | mac tab strip, win resolved-thread fill |
| `#F5F3ED` | win rails, mac resolved-thread fill |
| `#F1EEE7` | mac rails |
| `#F0EDE6` | win tab strip, win comments column bg, win composer |
| `#EDEAE2` | mac title bar, mac comments column bg, reply-block border |
| `#EDEAE3` | page background behind the window |
| `#E8E4DB` | win title bar, mac inset segmented tracks, quote bar |
| `#E4E9EF` | win active-file tint |
| `#E3DFD6` | hairline borders (default) |
| `#DCD7CC` | chrome borders, mac hairline via box-shadow |
| `#D5D0C4` | win control borders, scrollbar |
| `#C6BFAE`, `#B4AE9E` | emphasized card borders |
| `#BDB8AC` | inactive tab close glyph |
| `#A39E92` | tertiary text, placeholders, timestamps |
| `#8C8779` | section labels, secondary text |
| `#6B665C` | secondary body, status bar |
| `#4A463E`, `#3A362F` | chrome text, tree text |
| `#33302A` | body text |
| `#1F1D1A` | ink, primary/dark buttons, active segment |

### Semantic

- **Accent (indigo)** — `#4F46E5`; link/hover-dark `#4338CA`; tints `#E1E0F8`, `#E8E7F9`; borders `#B3B0E6`, `#A19CE9`; text-selection highlight `#CAC8F3`. Full family and contrast below.
- **Comment (amber)** — `#B5871F`; text `#8A6614`; tint `#FBF3E1`; border `#E0C98C`.
- **Accept / resolved (green)** — `#2E6B44`, `#22522F`, `#6E9179`; tint `#EDF4EF`; border `#A9C4B2`.
- **Reject / destructive (red)** — `#A33A2E`; tint `#F8EFED`; border `#DCC4BF`.
- **Avatar fills** — `#D9CFC0`, `#C9D2D9`, `#DCD7CC`, `#E3DFD6`.
- **Traffic lights** — `#F0655A`, `#F3BE4E`, `#61C554`.

### Accent family (refresh (31), CJ ruling 2026-11-08)

Emend's accent is the indigo of the Emend marketing page, replacing Cowrite's blue. The four anchor values are the site's; every other value is derived in the same hue (243°, from `#4F46E5`) by keeping each old value's lightness and scaling its saturation by the same 1.5× that separates `#4F46E5` from the old `#2F5D8C`. Comment amber, accept green, reject red, the neutrals and the dark surfaces are unchanged.

| Role | Before (30) | Emend (31) | Contrast (WCAG 2.x) |
|---|---|---|---|
| Accent, light (fills, ticks, focus rings, accent text) | `#2F5D8C` | `#4F46E5` | 6.08:1 on `#FCFBF8`; white on it 6.29:1 |
| Link / hover-dark, light | `#22456A` | `#4338CA` | 7.64:1 on `#FCFBF8` |
| Tint (held range, pills, chips) | `#E4EBF4` | `#E1E0F8` | `#4F46E5` text on it 4.86:1 |
| Tint (notes, new-in-chat pill, handoff blocks) | `#EAF0F6` | `#E8E7F9` | `#4F46E5` 5.16:1, `#4338CA` 6.48:1 on it |
| Border | `#B9CBDD` | `#B3B0E6` | decorative edge on a tint |
| Border / held-range underline | `#A9C0DC` | `#A19CE9` | decorative edge on a tint |
| Text-selection highlight | `#CFDDEC` | `#CAC8F3` | `#33302A` body text on it 8.18:1 |
| Input focus halo (beside a 1px accent border) | `rgba(47,93,140,.18)` | `rgba(79,70,229,.18)` | the border carries the contrast |
| Softened focus ring (macOS `12a`–`12d`) | `rgba(47,93,140,.45)` | **`rgba(79,70,229,.72)`** | 3.08:1 on `#EDEAE3`, 3.35:1 on `#FCFBF8` |
| Accent and focus ring, dark | `#5B8DFF` | `#A5B0FF` | 8.05:1 on `#1E1F22`, 7.21:1 on `#26282C`; `#10131A` ink on it 9.07:1 |
| Accent ink, dark (text and links set in the accent) | (none; `#5B8DFF`) | `#B7C0FF` | 8.44:1 on `#26282C` |
| Held selection tint, dark | `#26324A` | `#23284D` | `#E6E7EA` text on it 11.5:1 |

**One adjustment, recorded.** The softened macOS ring at the old `.45` alpha measured about 2.0:1 against the paper and window surfaces, under the 3:1 that WCAG 1.4.11 asks of a focus indicator (the old blue failed the same way). It is raised to `.72` alpha, which is the same hue at a lower lightness (blended, about `#7F79EA` over paper), and now passes 3:1 on every surface it is drawn on. No other value needed adjusting.

**Dark ink vs. fill.** In dark frames, text and links set in the accent use `#B7C0FF`; fills, edges, ticks, switches, progress fills and focus rings use `#A5B0FF`. Dark accent fills keep `#10131A` labels. Spec prose elsewhere that says "dark `#A5B0FF`" for text means `#B7C0FF`.

**Kept, deliberately.** `#E4E9EF` (Windows active-file tint) is listed with the neutrals and keeps its value, as the brief keeps neutrals. `#10131A` (label on a dark accent fill) is ink, not accent. The lo-fi wireframes' stand-in blue (`#2A78D6`, `#1B5AA6`, `#DFE8F4`, `#A9C4E4`, `#EAF2FC`) moves to `#4F46E5`, `#4338CA`, `#DCDAF9`, `#9F9AF3` and `#E8E7FF` so the two files agree.

## Type

- **UI** — IBM Plex Sans, weights 400 / 500 / 600.
- **Document body** — Source Serif 4, weights 400 / 600.
- **Badges, ids, counters** — IBM Plex Mono, 400 / 500.

The mocks load these from Google Fonts; use whatever the app already bundles.

| Size | Role |
|---|---|
| 9px | disclosure chevrons |
| 10px | mono badges (`REVISION`), gutter counts (600) |
| 10.5px | section labels — 500, `letter-spacing:.1em`, uppercase (`DOCUMENTS`, `SKILLS`, `WORKFLOWS`, `TIMELINE`, `COMMENTS · 6 OPEN`) |
| 11px | timestamps, small pills |
| 11.5px | status bar, meta lines, facet pills |
| 12px | chips, menu affordances, collapse rows |
| 12.5px | author names, tabs, buttons, menu items |
| 13px | comment body, chat body, file tree |
| 15.5px / 1.75 | document body (Source Serif 4, `#33302A`) |
| 27px / 1.25 | document title (Source Serif 4, 600, `letter-spacing:-.01em`) |

Numeric counters (`3 of 14`) use `font-variant-numeric: tabular-nums`.

## Spacing

Steps in use: 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16px. Card padding 12–13px; rail padding 14px; document canvas padding 34px top/bottom, 72px left, 84–96px right.

## Radii

3, 4, 5, 6 (Windows controls), 7, 8 (Windows window + cards), 9, 10 (macOS cards), 12 (macOS window, pills), 50% (avatars).

Gutter comment icons use `border-radius: 4px 4px 4px 0` — the square bottom-left corner is the speech-bubble tail.

## Shadows

| Role | Windows | macOS |
|---|---|---|
| Card | `0 1px 2px rgba(31,29,26,.05)` | `0 1px 3px rgba(31,29,26,.08)` |
| Emphasized card | `0 2px 8px rgba(31,29,26,.07–.08)` + 1px border | `0 3px 12px rgba(31,29,26,.1), 0 0 0 1px …` |
| Popover | `0 6px 18px rgba(31,29,26,.14)` | `0 8px 22px rgba(31,29,26,.18), 0 0 0 1px rgba(31,29,26,.08)` |
| Menu | `0 8px 22px rgba(31,29,26,.16)` | `0 12px 28px rgba(31,29,26,.2), 0 0 0 1px rgba(31,29,26,.08)` |
| Window | `0 18px 44px rgba(31,29,26,.18)` | `0 22px 54px rgba(31,29,26,.22)` |

Windows draws hairlines as `border: 1px solid`; macOS draws them as `box-shadow: 0 0 0 1px` so they don't affect layout.

## Focus rings

| Surface | Windows 11 | macOS |
|---|---|---|
| In-shell controls (correction galleries, dialogs, rail rows, scrollable lists) | `2px #4F46E5`, `outline-offset:1px` | Same |
| The render-failure fallback's `main` root (`12a`/`12b`) | `2px solid #1F1D1A`, `outline-offset:6px` | `3px solid rgba(79,70,229,.72)`, `outline-offset:6px` |
| The render-failure fallback's one button (`12c`/`12d`) | `2px solid #1F1D1A`, `outline-offset:3px` | `3px solid rgba(79,70,229,.72)`, `outline-offset:3px` |

**Offset is a function of the target, not the platform:** **6px on the root, 3px on the button**, identically on both. Only width and colour differ.

The fallback's rings are platform-differentiated because it is the only surface in this folder where the ring is the composition's own load-bearing element rather than a control detail; `rgba(79,70,229,.72)` is the accent softened, and no new hue is introduced. Elsewhere, hover / focus / pressed states are drawn for the correction controls and, **(23)**, for the `14a` Timeline return control: hover `#F0EDE6`, pressed `#E8E4DB` (mac adds a 1px inner shade), keyboard focus 2px `#4F46E5` at 2px offset; dark hover and pressed `#3A3D42`, ring `#A5B0FF` (`voice.md` §2). Derive the rest from the app's conventions (`state.md`).

## Icons

**App icon (31).** The Emend mark is two lines of text with a proofreader's insertion caret at the end of the second: a proposed insertion waiting on the author. It is drawn twice. (a) `icons/emend-macos-1024.svg`/`.png` is the 1024px macOS master with the macOS grid drawn in (824px body, 100px padding, 185px corner radius, drop shadow, a faint top edge so it holds on a dark Dock); its first line is two words. (b) `icons/emend-glyph.svg` is the unpadded glyph for Windows and small sizes (`icons/emend-glyph-32.png`), with the first line merged into one bar. `icons/emend-glyph-16.svg`/`.png` is (b) snapped to whole pixels for 16px. Body `#4F46E5` (the macOS master grades `#6158F0` to `#4338CA`), strokes white. The 15px Windows title-bar icon is (b) and does not change with the theme.


Every glyph in the mocks is a Unicode stand-in: `⋯ ✎ ✓ ✕ ▸ ▾ ‹ › ›› ‹‹ ⟳ ◉ ≔ ⏎`. **Replace all of them with the codebase's real icon set** at equivalent optical size. Avatars are flat color circles standing in for real avatar images or initials.

**The project-open status band mints no new token** (refreshes 13–14). **(14)** The failure reason is now `#6B665C` at **12.5px/1.45 on the same line** as the message — it is the tail of one run, not a second line, so the band's `min-height:46px` is its height in **all seven states** and no `~56px` two-line box exists anywhere. Its fill `#F7F5EF`, edges `#E3DFD6` / `#DCD7CC`, message ink `#33302A`, detail `#6B665C`, name weight 500, action fills and the `2px #4F46E5` / offset-1px focus ring are all already in this file. **No severity colour is introduced**, deliberately: `../ux-design.md` §2 forbids encoding severity in that region. See `project-open-status.md`.

## Dark — 14-series only (refresh (22))

From Emend’s `:root[data-theme="dark"]` palette (`src/styles.css`). Applies to `14a`–`14f` only. **(23) Evidenced** by dark browser captures for the mic chip (`docs/alignment-voice-dark/`), editor ghost and held range (`docs/alignment-editor-ghost/`), composer and Timeline errors (`docs/alignment-voice-composer-errors/`) and Voice Settings/model rows; the 900px toolbar (`14a`) and the J12 frozen pane (`14f`) dark frames are drawn but not captured.

| Role | Value |
|---|---|
| Pane / chip / dialog | `#1E1F22` |
| Toolbar, nav, surface, error fill | `#26282C` |
| Line, edge, hover, pressed | `#3A3D42` |
| Ink / body | `#E6E7EA` |
| Muted, chevrons, ghost | `#9AA0A6` |
| Accent, focus ring | `#A5B0FF` |
| Accent ink (text and links in the accent) | `#B7C0FF` |
| Pause badge / bars | `#FCD34D` / `#1E1F22` |
| Error ink and stroke | `#F87171` |
| Recording chip / capsule | `#E6E7EA` / `#1E1F22` |
| Held selection tint / underline | `#23284D` / `#A5B0FF` |

**(24) Mic error interaction** (`14g`): light hover `#F3E4E0`/`#CFA9A1`, pressed `#ECD7D2`/`#C29890`/glyph `#8E2F25`; dark hover `#33292B`, pressed `#3D2C2E`/`#FCA5A5`; retry cue `↻` in glyph colour. **Dark freeze** (`14f.3`/`14f.4`): ordinary selected segment `#A5B0FF`/`#10131A` beneath the 55% pane layer.

**Light voice tokens retained:** mic error `#F8EFED` / **`#DCC4BF`** / `#A33A2E` on both platforms (mac as a hairline); ghost `#8C8779` + dotted `#BDB8AC`; held range `#E1E0F8` + `#A19CE9`; Pause badge `#B5871F`.
