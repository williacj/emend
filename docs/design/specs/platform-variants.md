# Platform variants

The Windows and macOS mocks are the **same product** with native chrome. Ship one shell with platform-conditional chrome, not two implementations.

Options `3a`/`4a`/`5a` are Windows 11; `3b`/`4b`/`5b` are macOS. `5a`/`5b` are the comment-correction component-state galleries — card fragments on a column background rather than full windows, so the window, title-bar and tab rows below do not apply to them; every other row does.

| | Windows 11 | macOS |
|---|---|---|
| Window radius | 8px | 12px |
| Window shadow | `0 18px 44px rgba(31,29,26,.18), 0 0 0 1px rgba(31,29,26,.1)` | `0 22px 54px rgba(31,29,26,.22), 0 0 0 1px rgba(31,29,26,.1)` |
| Title bar | 38px, `#E8E4DB`, 1px bottom `#DCD7CC`. App icon: the Emend small-size mark (b) at 15px, radius 3px (`icons/emend-glyph.svg`; `#4F46E5` body, white strokes; the same drawing in light and dark) + `Emend — positioning-brief` at left, 12.5px `#4A463E`. Window controls right: 46px-wide cells, `—` `▢` `✕`, close cell `#D9D4C9` on hover | 44px, `#EDEAE2`. Traffic lights left (12px circles `#F0655A` `#F3BE4E` `#61C554`, gap 8px), then rail-toggle pair `‹‹` `››` (padding 4px 8px, radius 6px, `#E2DED4`; active one white + `0 1px 2px rgba(31,29,26,.12)`), centered document title 13px/500, then `Saved · 2:14 PM` and `Share ▾` right |
| Document tabs | Folder tabs: radius `6px 6px 0 0`, active `#FCFBF8` with 1px `#E3DFD6` and bottom border matching canvas (`margin-bottom:-1px`), strip `#F0EDE6`, padding 8px 12px 0, gap 2px, tabs padding 8px 14px | Pill tabs: radius 7px, active white + 1px `#E3DFD6` + `0 1px 2px rgba(31,29,26,.05)`, strip `#F7F5EF`, padding 8px 12px, gap 6px, tabs padding 6px 12px. No keyboard hint in the strip |
| Segmented controls | Bordered, hard-edged: 1px `#D5D0C4`, radius 6px, `overflow:hidden`, white fill, active segment solid `#1F1D1A` white 500 | Inset track `#E8E4DB` radius 8px with 2px padding; active segment white pill radius 6px + `0 1px 2px rgba(31,29,26,.12)` |
| Buttons and inputs | 1px `#D5D0C4` border, white fill, radius 6px | Borderless white fill, radius 7px, hairline via `box-shadow: 0 0 0 1px #DCD7CC`; cards 8–10px |
| Keyboard hints | None in the toolbar; `Ctrl+Enter to send` in the composer footer | Inline where a shortcut exists: `⌘⏎` (send) in the composer. No timeline-toggle hint: the toggle carries its label only. The document-tab strip carries none. |
| Save state | In the status bar (`Saved · 2:14 PM`) | In the title bar |
| Share button | In the toolbar right cluster | In the title bar |
| Active document row (either rail section) | `#E4E9EF` fill + `inset 2px 0 0 #4F46E5`, radius 5px | Solid `#4F46E5`, white text, radius 7px |
| Rail backgrounds | `#F5F3ED` | `#F1EEE7` |
| Project-rail header | Opened-folder name + `⟳` + `‹‹` collapse, all in the rail header | Opened-folder name + `⟳`; collapse lives in the title-bar `‹‹` `››` pair |
| Rail row radii | 5px (active fill, focus ring) | 7px (solid active row, focus ring) |
| Section `Try again` chip | White fill, 1px `#D5D0C4`, radius 5px | White fill, hairline `0 0 0 1px #DCD7CC`, radius 7px |
| Comments column bg | `#F0EDE6` | `#EDEAE2` |
| Integrity banner (`11a`/`11b`) | `border-bottom: 1px solid #E0C98C`; actions white `#FCFBF8` + 1px `#D5D0C4`, radius 5px | `box-shadow: 0 1px 0 #E0C98C`; actions `0 0 0 1px #DCD7CC`, radius 7px |
| Banner copy, order, focus | **Identical on both platforms** — same two lines, same `Reload` · `Keep mine` · `Compare` order, same highlighted-default rule, same focus behavior. No `⌘` hint on any banner action; none is keyboard-bound |
| Agent message card (`10a`/`10b`) | 1px `#E3DFD6`, radius 8px; attribution tile radius 5px | Borderless, `0 1px 2px rgba(31,29,26,.07)`, radius 10px; attribution tile radius 6px |
| Grounding indicator | **Identical on both platforms** — 11px `#8C8779`, right-aligned, own footer row above `1px #F0EDE6`. Not a chip; not platform-conditional; absent entirely at a zero count |

### Correction galleries (`5a` / `5b`)

The states in these galleries inherit the table above; only these differ:

| | Windows 11 (`5a`) | macOS (`5b`) |
|---|---|---|
| Thread card | 1px `#E3DFD6`, radius 8px, `0 1px 2px rgba(31,29,26,.05)` | Borderless, radius 10px, `0 1px 3px rgba(31,29,26,.08)` |
| Emphasized card (confirming / editing) | 1px `#B4AE9E` + `0 2px 8px rgba(31,29,26,.08)` | `0 3px 12px rgba(31,29,26,.1), 0 0 0 1px #C6BFAE` |
| Confirmation buttons | Radius 6px; `Delete` `#A33A2E` fill, `Cancel` 1px `#D5D0C4` on white | Radius 7px; `Delete` `#A33A2E` fill, `Cancel` white with `0 0 0 1px #DCD7CC` |
| Button order | `Delete` → `Cancel` | `Delete` → `Cancel` — **the same order on both platforms**, deliberately. The destructive verb leads because it is what the card is asking about; this is one of the few places the mocks do not follow the platform's native dialog convention, and it is intentional |
| Overflow menu | 1px `#D5D0C4`, radius 8px, `0 8px 22px rgba(31,29,26,.16)`, white; inert footer block `#FAF8F3` | Borderless `#FDFCFA`, radius 9px, `0 12px 28px rgba(31,29,26,.2), 0 0 0 1px rgba(31,29,26,.08)`; inert footer block `#F7F5EF` |
| Status / reason line | 1px `#E3DFD6`, radius 6px | Radius 7px, hairline via `box-shadow: 0 0 0 1px #E3DFD6` |
| Withdrawn placeholder | `#F7F5EF` fill, 1px `#E3DFD6`, radius 8px | `#F5F3ED` fill, radius 10px, `0 0 0 1px #E3DFD6` |
| Hidden-threads chip | 1px `#D5D0C4`, bg `#F7F5EF` | Hairline ring, bg `#F5F3ED` |
| Dismiss key hint | `Esc cancels` at the right of the button row | `⎋` in the same slot |

Each gallery tile is a 400px column at the platform's comments-column background — `#F0EDE6` (Win) / `#EDEAE2` (mac) — which is the width the components ship at, not a frame.

The baseline full-window mocks are drawn at **1400px window width**; `14a` additionally carries binding **900px and 1000px** frames (`voice.md` §2). Content-area height is 860px in `3a`/`3b` and 1110px in `4a`/`4b` — the taller frame exists only to show the full comment stack. Height is not a spec.

### Session-write failure dialog (`9c.8`)

Raised when the awaited final session write fails on quit. Structure, copy, action order, destructive semantics, focus trap, `[Stay open]` autofocus and `Esc` behavior are **identical on both platforms**; only chrome differs.

| Element | Windows | macOS |
|---|---|---|
| Dialog card | `#FCFBF8`, 1px `#DCD7CC`, radius 8px, `0 8px 26px rgba(31,29,26,.16)` | `#FCFBF8`, borderless, radius 10px, `0 12px 32px rgba(31,29,26,.22), 0 0 0 1px rgba(31,29,26,.09)` |
| Neutral buttons (`Try again`) | 1px `#D5D0C4`, radius 5px, white fill | Radius 7px, hairline `0 0 0 1px #DCD7CC`, white fill |
| Default button (`Stay open`) | `#F0EDE6` fill, 1px `#D5D0C4`, radius 5px, 500 | `#F0EDE6` fill, hairline `0 0 0 1px #D5D0C4`, radius 7px, 500 |
| Destructive (`Quit anyway`) | `#F8EFED` fill, 1px `#DCC4BF`, `#A33A2E` 500, radius 5px | Same family, radius 7px |
| Focus ring on the default | 2px `#4F46E5`, `outline-offset:1px` | Same |
| Reason line | `#F8EFED` fill, 1px `#DCC4BF`, `#A33A2E`, radius 6px | Same, radius 7px |
| Affected-label list | Max height **96px**, 1px `#E3DFD6`, radius 5px, fill `#FAF8F3` | Max height **104px**, hairline `0 0 0 1px #E3DFD6`, radius 7px, fill `#FAF8F3` |
| Dialog max height | **420px** — title, body, reason and actions pinned; only the list scrolls | **440px** — same rule |
| List focus (overflowed only) | 2px `#4F46E5`, `outline-offset:1px`, `tabindex="0"` | Same |
| Narrow / long-locale actions | Stack full-width, same order, `Stay open` last and autofocused | Same rule |
| Action order | `Quit anyway` → `Try again` → `Stay open` | **The same order** — as with the correction cards, the destructive verb leads because it is what the dialog is asking about |

The delayed `Saving your session…` row is **not** part of this dialog: it renders in the shell status bar's leading slot, taking that bar's platform fill (`#F5F3ED` Win / `#F1EEE7` mac).

### Finalization lock and guard-hosted Save As failure (`9d`)

| Element | Windows | macOS |
|---|---|---|
| Inert pane during finalization | 55% opacity, no pointer events; status row at full contrast | Same |
| Guard-hosted Save As failure line | `#F8EFED` fill, 1px `#DCC4BF`, `#A33A2E`, radius 6px, between body and actions | Same, radius 7px |
| Duplicate-label ordinal | 10.5px `#8C8779`, after the italic path | Same |

Behavior is identical on both platforms: refusal rather than queueing, focus restored to its pre-attempt position on `[Stay open]`, and the guard's failure line never falling back to the pane.

### The render-failure fallback (`12a`–`12f`)

The one surface where **only the outer platform frame** is drawn. Every ordinary row in the table above — tabs, segmented controls, save state, Share, rails, comments column — is inapplicable, because none of that chrome is mounted.

| Element | Windows 11 | macOS |
|---|---|---|
| Window radius / shadow | 8px; `0 18px 44px rgba(31,29,26,.18), 0 0 0 1px rgba(31,29,26,.1)` | 12px; `0 22px 54px rgba(31,29,26,.22), 0 0 0 1px rgba(31,29,26,.1)` |
| Title bar | 38px `#E8E4DB`; app icon + `Emend` only — **no document clause**; `—` `▢` `✕` at right | 44px `#EDEAE2`; traffic lights only — **no centred title, no `‹‹`/`››` pair, no save state, no `Share ▾`** |
| Window body | `#EDEAE3` — the page background, not the `#FCFBF8` canvas | Same |
| One button | Ink `#1F1D1A`, radius **6px**, no shadow | Ink `#1F1D1A`, radius **7px**, `0 1px 2px rgba(31,29,26,.18)` |
| Focus ring | `2px solid #1F1D1A` | `3px solid rgba(79,70,229,.72)` — **width and colour are the only platform delta;** offsets are 6px on the `main` root and 3px on the button on both |
| Native close (`12f`) | `✕` cell highlights `#C4402F` on the attempt; refusal leaves the fallback mounted | Red traffic light takes the platform focus halo on the attempt; same refusal |
| Composition, copy, hierarchy, measure, focus order | **Identical on both platforms** — the column, type, gaps, the four copy rows, the pending and failed treatments and the whole mount transition do not vary. The five rows above are the complete platform delta | |

See `render-failure-fallback.md`. Behavior is `../ux-design.md` J15 — **proposed, not ratified**.

### Live over-cap, run refusal and provenance-pending (`9e`, `9f`)

| Element | Windows | macOS |
|---|---|---|
| Live over-cap notice | Amber family, 1px `#E0C98C` bottom | Same, `box-shadow: 0 1px 0 #E0C98C` |
| Composed notice divider (`9e.2`) | 1px `#E9D8AC` above the "Separately" clause | Same |
| Run-refusal dialog | Ordinary alertdialog chrome (Win table above) | Ordinary alertdialog chrome (mac) |
| Provenance-pending line | Reject family, full-bleed under the status strip | Same |

Behavior, order, focus and `Esc` are identical on both platforms throughout the 9-series; only chrome differs.

### The project-open status band (`13a`–`13h`)

| | Windows 11 | macOS |
|---|---|---|
| Fill | `#F7F5EF` | `#F7F5EF` |
| Lower edge | `border-bottom: 1px solid #E3DFD6` | `box-shadow: 0 1px 0 #DCD7CC` |
| Padding / height | 9px 14px · **46px in all seven states** (fixed `min-height`, `box-sizing:border-box`) — **(14)** one line-height everywhere, no two-line box | same |
| In-bar action | `#FCFBF8`, 1px `#D5D0C4`, radius **5px** | `#FCFBF8`, `0 0 0 1px #DCD7CC`, radius **7px** |
| Focus ring | `2px #4F46E5`, `outline-offset:1px` | same |
| Retry-pending | `Trying…` — `#E8E4DB` fill, `#D5D0C4` border, `#6B665C` label, **inert and still ringed** | same, with the `0 0 0 1px #DCD7CC` hairline |

The hairline substitution is the one this file already governs for the toolbar and the integrity bar; the action radii are `document-integrity.md`'s. **(14) The retry-pending focus ring is drawn on both platforms** — `13f.1`/`13f.2` for the chip and `13f.3`/`13f.4` for it in the band. Refresh (13) specified it and drew neither. **Nothing else in the band is platform-specific** — fill, padding, type, order, states, announcement and clipping are identical, and the upper edge is whichever platform title bar the surface has. Full rules in `project-open-status.md`.

### Refresh (17) surfaces (`3c`, `3d`, `4c`–`4g`, `5d`, `9g`, `9h`)

| Element | Windows 11 | macOS |
|---|---|---|
| Mic chip | 1px `#D5D0C4`, r6 | 1px `#E3DFD6`, r7 |
| Right cluster | mic · `Timeline ››` · `Share ▾` | mic · `Timeline` (Share lives in the title bar) |
| Fit (`3d`, `9g.5`) | `Share ▾` makes Windows rows wider, so other controls move sooner; **the mic never moves**; floor 253px | the same rule; fewer controls move; floor 255px |
| Comments column fill | `#F0EDE6` | `#EDEAE2` |
| D27 notice fill | `#F0EDE6` | `#EDEAE2` |
| D27 title bar | `Emend — Untitled — from <path>` | centred `Untitled — from <path>` |
| Selection popover | white, 1px `#D5D0C4`, r8 | `rgba(252,251,248,.92)`, r9, ring shadow |
| `Delete replies first.` band | `#FAF8F3` | `#F7F5EF` |

Words, order and behavior are identical on both platforms; only the tokens above differ.

## Voice surfaces and the collapsed-host fit (`14a`–`14f`, refresh (22))

| Element | Windows 11 | macOS |
|---|---|---|
| Mic, return, `⋯` chips | 1px `#D5D0C4` r6 | 1px `#E3DFD6` hairline (box-shadow) r7 |
| Mic error hover / pressed (`14g`) | 1px border takes the state stroke; pressed adds inset shade | hairline takes the state stroke; pressed appends inset shade |
| Mic error stroke | 1px `#DCC4BF` border | 1px `#DCC4BF` hairline — replaces the idle hairline, never stacked under it |
| Compact return | 44×26, same edge | 44×26, same edge; pressed adds a 1px inner shade |
| Settings shell | 1px `#E3DFD6` r8, `0 18px 44px` | r12, `0 22px 54px` + hairline |
| Settings controls | 1px `#D5D0C4` r6 | 1px `#DCD7CC` hairline r7 |
| Comment popover | 1px `#D5D0C4` r8 | r10 shadow + hairline |
| Composer textarea | 1px `#D5D0C4` r7, `#FCFBF8` | hairline `#DCD7CC` r8, `#FAF8F3` |
| Timeline input / Send | 1px `#D5D0C4` r8 / r8 | hairline r9 / r9 |
| Title bar (900/1000 frames) | **38px**, `#E8E4DB`, 1px `#DCD7CC`; app icon + `Emend — <doc>` 12.5px; 46px `—` `▢` `✕` cells — the §1 shell bar | **44px**, `#EDEAE2`, 1px `#DCD7CC`; traffic lights, `‹‹` `››` pair, centred title 13/500, `Saved · <time>` and `Share ▾` — the §1 shell bar |

Heights match Emend's browser gate (`e2e/acceptance.spec.mjs`: 38px Windows, 44px macOS). Native Windows title-control interaction is drawn, not evidenced.
