# Authoring shell

Journey 1c. Mocks: `3a` / `3b` (timeline rail visible, document in redline state), `4a` / `4b` (timeline collapsed, comments column, document in comment state), `6a` / `6b` / `6c` (project rail anatomy and section states).

Read `tokens.md` and `platform-variants.md` first — platform-specific chrome rules are not repeated here.

## Layout

Three columns inside the window frame, top-level `display:flex`:

```
┌ title bar (38 / 44px) ───────────────────────────────────┐
├ project rail 236px┬ document column flex:1 ─┬ right rail ┤
│                   │ tab strip               │  372px     │
│                   │ toolbar (single row)    │  timeline  │
│                   │ canvas (flex:1)         │    OR      │
│                   │ status bar              │  400px     │
│                   │                         │  comments  │
└───────────────────┴─────────────────────────┴────────────┘
```

The document column is `flex:1; min-width:0`, bg `#FCFBF8`, 1px `#E3DFD6` right border.

## Project rail (236px, fixed)

Mocks: `6a` (Windows anatomy), `6b` (macOS), `6c` (section states). Behavior is `../ux-design.md` §2 "Project rail states" and J2, as amended for #1720; this file binds only its appearance.

Background `#F5F3ED` (Win) / `#F1EEE7` (mac), 1px `#E3DFD6` right border, `display:flex; flex-direction:column`.

The rail holds **two labelled sections in one tree** — `DOCUMENTS` and `SKILLS` — drawn as one continuous list of rows, not two panes: no divider rule, no nested scroll area, no second header bar. Nothing in the drawing may suggest two widgets, because the two headings label groups inside a single tree with a single roving tab stop.

- **Header** — the **name of the folder the user opened** (`product-comms` in the mocks), 12.5px/500 `#4A463E`, padding 13px 14px 9px, gap 8px (ruled by CJ 2026-08-20). It is a proper name, so it is **not** uppercased and carries no letter-spacing — the section-label treatment is deliberately not reused here — and it truncates with ellipsis rather than wrapping. Right-aligned `⟳` refresh, and on Windows a `‹‹` collapse affordance, both 12px `#A39E92`. The single `⟳` requests both sources.
- **Section labels** — the section-label token (`tokens.md`, 10.5px type row): 10.5px/500, `letter-spacing:.1em`, uppercase, `#8C8779`. This is **not** the header treatment above — the header is a proper name at 12.5px/500 `#4A463E` with no uppercasing and no tracking. `DOCUMENTS` padding `2px 9px 6px`; `SKILLS` padding `12px 9px 6px` — the extra 10px of leading is the only separation between the groups.
- **`WORKFLOWS` sub-label** — inside the Skills group, same label token, padding `12px 9px 6px`. It closes the skill disclosure list and opens the workflow leaves (ruled by CJ 2026-08-20, choosing option `6e` over an unlabelled outdent). It is a **label inside Skills, not a third section**: `SKILLS` still heads the group, and nothing else about the group's single-tree drawing changes. Two membership rules follow:
  - Discovery found skills but **no** workflows → the sub-label is **absent**. It never heads an empty list, and it is never accompanied by a "no workflows" line: an empty Skills group is a section-level state (`No skills found`), not two.
  - Discovery found workflows but **no** skills → `SKILLS` heads the group and `WORKFLOWS` sits directly beneath it (drawn in `6c`).
- **Tree** — one container, padding `0 8px 10px`, 13px, `#3A362F`.
  - **Order** — one alphabetical list per level with folders and documents **interleaved**, case-insensitively: `drafts`, `readme.md`, `research` (ruled by CJ 2026-08-20). Documents shows what is in the folder — no folders-first grouping, no type sort, no recency sort. The same rule applies inside an expanded skill's material.
  - **Folder rows** — 9px `▾`/`▸` chevron + name, padding 6px 8px, `#6B665C`; nested folders add `margin-left:16px` per level.
  - **Document rows** — nested at `margin-left:16px` per level, padding 6px 9px. A root-level document sits at `margin-left:8px` so its label aligns with folder names. Every FR-ED-9 type renders identically: `.txt` is an ordinary actionable row, in `#6B665C` like any other — **there is no muted, greyed, or "(not editable)" row treatment anywhere in this rail**, because a non-document has no row at all.
  - **Skill disclosure rows** — `display:flex; gap:7px`, padding 6px 8px. 9px chevron (`padding-top:4px` to sit on the first text line) + a two-line stack (`gap:2px`): authored name 13px `#3A362F`, then the authored description 11px/1.35 `#8C8779`. Expanded, the skill's own material renders as ordinary folder and document rows at `margin-left:16px`.
  - **Workflow leaf rows** — no chevron. Two-line stack, padding 6px 9px: discovered name 13px `#3A362F`, then the project-relative path in IBM Plex Mono 10.5px/1.35 `#8C8779`. The path line truncates with `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` — the visual label only; the accessible name stays whole.
- **Active row** — platform treatment per `platform-variants.md`; trailing 6px dot (`#4F46E5`, or white on the macOS solid row). Exactly one row in the whole rail ever carries it, in either section.
- **Focus row** — 2px `#4F46E5` ring, `outline-offset:-1px`, radius matching the row (5px Win / 7px mac). Focus and active are separate treatments and are drawn together in `6a`: the ring is the roving tab stop, the fill is the open document.
- **Section status lines** — 11.5px/1.4 `#8C8779`, padding `6px 9px 8px`, rendered inside the owning section in place of (or beneath) its rows. Retained rows under an in-flight update or a failed update are drawn at `opacity:.55`; they are still the last trustworthy rows, never a new snapshot.
- **Section `Try again`** — 11.5px `#1F1D1A` chip, padding 4px 10px, white fill; 1px `#D5D0C4` radius 5px (Win) / hairline `0 0 0 1px #DCD7CC` radius 7px (mac). It sits under its own section's status line and never spans the rail.
- **Footer** — pinned with `margin-top:auto`, 1px top `#E3DFD6`, padding 11px 14px, 11.5px `#8C8779`: amber 6px dot `#B5871F` + `Watching folder · 1 file changed`.
- **Collapsed** — 44px strip, rail fill, one `››` restore control (12px `#6B665C`, 44×40 hit area). Nothing else is drawn.

**What the drawing must not add.** No file-type icons, no extension badges, no counts on section labels, no "show all files" toggle, no per-row overflow menu. Documents' membership is carried by presence alone.

## Tab strip

One tab per open document. Per-platform shape in `platform-variants.md`. Each tab: 6px status dot (`#4F46E5` when the file has unsaved work), filename 12.5px, close `✕` 11px (`#A39E92` active tab, `#BDB8AC` inactive). Inactive tabs are unfilled, text `#6B665C`.

A tab may be an **untitled recovery document** rather than a file: an `UNTITLED` qualifier (10.5px/500, `.06em`) before an italic displaced path name, and **never a dirty dot** — the tab is never dirty. Where the displaced buffer was preserved, the qualifier is `#6B665C` and there is **no** dot. Where it exceeded the 2 MiB per-tab session cap and was not kept, the qualifier is `#8A6614` and a 6px `#B5871F` dot precedes it; that dot means *earlier unsaved work was not preserved*, never *unsaved changes*. Its pane **carries the ordinary toolbar** (in the reduced pathless composition below) and has **no status-bar save slot on either platform** — there is no path and no autosave, so the pane carries its own footer instead: `No autosave — there is no project path yet` at the left and the `[Save As…]` chip at the right, which is the only route into the project. The amber dot and amber qualifier also mark the **live over-cap** state, where the buffer is present but the session cannot keep it (`9e.1`) — the same treatment, a different message. Where the same path has been displaced more than once, each such tab carries a stable `(n)` ordinal in 10.5px `#8C8779` after the path, identical in the tab strip, the accessible name and the affected-documents list. See `specs/recovered-document.md` (`9a`/`9b`/`9c`/`9d`).

## Toolbar

Single row, on **every** document pane including the untitled/scratch one. `display:flex; align-items:center; gap:10px; overflow:hidden` — **no `flex-wrap`**, padding 8–9px 14px, bg `#FAF8F3`, 1px bottom `#E3DFD6`, 12px text.

Groups are separated by `padding-left:10px; border-left:1px solid #E3DFD6`:

1. **Rich text / Markdown** — segmented control.
2. **Format group** — `B` (600) and `I` (italic) at 27×26; `H1` and `≔` at 31×26; gap 2px; radius 5px (Win) / 6px (mac). Placeholders for the real format icon set.
3. **Context group** — content depends on document state:
   - **Redline state** (`3a` / `3b`): `✓ Accept` (bg `#EDF4EF`, border `#A9C4B2`, text `#2E6B44`, 500) · `✕ Reject` (bg `#F8EFED`, border `#DCC4BF`, text `#A33A2E`, 500) · stepper `‹ 3 of 14 ›` (tabular nums; Win = bordered white group with 1px dividers, mac = inset `#E8E4DB` track with white active pill) · `Bulk ▾`. macOS shows a `⌘⏎` hint inside Accept, tinted `#6E9179`.
   - **Comment state** (`4a` / `4b`): `Address all… ▾` (**(26)** per `15a`: its own group after the format group; first to move into `⋯` at narrow widths, `15b`). The `Open (6) ▾` chip drawn in 4a/4b does not ship and is superseded.
4. **Right cluster** (`margin-left:auto`, gap 8px) — **(17) the dictation mic first** (below), then the `Timeline ››` toggle when the timeline is collapsed (label only — no keyboard hint on either platform), then `Share ▾`: solid `#4F46E5`, white, 500, padding 6px 13px, radius 6px (Win) / 7px (mac). On macOS, Share lives in the title bar and only the Timeline toggle appears here.

### Dictation mic (`3c`, refresh (17); UXR-Q14.1, CJ 2026-09-30)

On every authoring pane — file-backed and pathless, Rich text and Markdown — in `3a`/`3b`/`4a`/`4b`/`9a`/`9b`. 28×26 chip, platform chip treatment (Win 1px `#D5D0C4` r6, white · mac 1px `#E3DFD6` r7, white); glyph is a 12×15 capsule-and-stand drawn in `#3A362F` (placeholder for the real icon set — the `9c.9` emoji is withdrawn). **Fixed width in every state**, so a voice state never reflows the row.

| State | Chip | Accessible name | Status-bar echo (ruled) |
|---|---|---|---|
| Idle | outline | `Dictate` | — |
| Downloading model | outline, glyph `#6B665C`, 2px progress hairline 18px wide at the chip foot (`#E3DFD6` track, `#4F46E5` fill) | `Dictate — downloading voice model, 42%` · `aria-busy` | `Downloading voice model · 42%` |
| Recording | solid `#1F1D1A`, filled `#FCFBF8` capsule | `Stop dictation — recording` · `aria-pressed=true` | `Recording · 0:07` (500, `#1F1D1A`) |
| Transcribing | `#EDEAE2` fill, three static 2px dots | `Dictation — transcribing` · `aria-busy` | `Transcribing…` |
| Error ×3 | `#F8EFED` / `#DCC4BF`, `#A33A2E` glyph with a 45° slash | `Dictate — no microphone found` / `— microphone permission denied` / `— voice model missing` | `No microphone found` / `Microphone access is off` / `Voice model is missing` in `#A33A2E` |
| Frozen (J12 finalization) | **(22) idle treatment, no opacity of its own** — the entire inert pane, toolbar and mic included, renders through one 55% layer (`9d.1`, `14f`; CJ 2026-10-02) | `Dictate — unavailable while saving` | — |

- **Live partial** renders at the caret as ghost text: `#8C8779`, `text-decoration: underline dotted #BDB8AC`, offset 3px. On commit it takes body ink. Under the freeze the partial is **removed**, never inked (`3c.10`).
- **Echo** sits at the end of the status bar’s left cluster. Echo and the three error strings are **ruled as drawn (18)**. **(22) Error routes:** the four device/permission errors open Settings at Voice; backend, model and transcription errors keep their retry (`14e`, `voice.md`).
- Focus: in-shell ring 2px `#4F46E5` at 2px offset. Order: format → context → mic → `Timeline ››` → `Share ▾` → `⋯`.

**Rule: the toolbar stays one row.** Display mode and save state were deliberately moved into the status bar to protect this. Anything that does not fit collapses into a **`⋯` overflow** — 28×26, same chip treatment, at the end of the right cluster — **never a second row**. **(18) Measured and ruled** (`3d`): leave order is `Timeline ››`, then `Share ▾`, then context-group controls right-most first. **The mic never moves into `⋯`** (CJ, 2026-10-01). **(23) The segmented switch moves only in the narrow 900px exception:** it follows the format group into `⋯` when the compact row needs the space, listed before the format group (CJ 2026-10-02, #2641; `14a`). **(19) Narrow limit:** after every context control, the **format group moves as one unit** and re-forms as one `B I H1 ≔` row inside `⋯` (`9g.5`/`9g.6`). **Floor: segmented control + mic + `⋯` = 253px Windows / 255px macOS** (Plex metrics); the shell must not give the document column less, collapsing the project rail and right rail first. Relocated controls are listed in the popover in **row order**; the popover uses B4b click/keyboard behavior and the platform menu treatment. A changes + comments context group is ordered redline-then-comment (ruled). Thresholds in `3d` are IBM Plex Sans figures; the toolbar bundles Plex on both platform styles, so they are the shipped values. Drawn in `9c`.4, `9c`.7 and `3d`.

### (23) Collapsed Timeline return at 900 / 1000px (`14a`, #2602 / #2641)

Right cluster **mic · Timeline return · `⋯`**, `⋯` last, ordinary spacing (padding 14, gaps 10/8). At a 900px window (rail 236, editor column 264, toolbar 263, comments 400) the row holds only the mic, the stable **44×26** return (`››` + the 16px Pause badge while pending) and `⋯`; **the Rich text / Markdown switch and the format group are in `⋯`**, switch first. At 1000px the switch is inline, the full `Timeline ››` chip shows with its badge space reserved, and the format group stays in `⋯`. Menu geometry, focus and font figures: `voice.md` §2. The (22) compact-spacing proposal is withdrawn.

**The context group is present or absent, never visible-but-disabled.** Zero tracked changes and zero comments mean the group is not rendered at all. The state *format group present, context group empty* is legitimate and reachable on **every** pane; it is drawn in `9c`.1 and applies unchanged to `3a`/`3b`.

### Composition on a pathless buffer (untitled / scratch)

The same row, reduced by what a document with no project path can honestly offer. Drawn in `9a`/`9b`; the full rules are in `recovered-document.md`.

| Group | On a pathless buffer | Why |
|---|---|---|
| `Rich text \| Markdown` | **Present**, both segments live | A pure projection over the buffer's own text |
| Format group `B I H1 ≔` | **Present**, all live | Buffer transforms; no path involved |
| Redline context group | **Present only at ≥1 change**, absent at zero | Zero is the normal case here |
| Comment context group | **(19) Present at ≥1 comment**, absent at 0 | Untitled documents take comments (shipped; CJ 2026-10-01) |
| Dictation (mic) | **Present**, before and after adoption | Needs no path (UXR-Q14.1); `3c`, `9g` |
| `Share ▾` | **Absent** | Versioning on a document at no project path. **Absence, not disablement** |
| `Timeline ››` | **Present**, unchanged | Window-level chrome |

**Adoption changes the toolbar's contents, not its existence.** A successful `[Save As…]` adds `Share ▾` **within the existing row**; the comment group remains present only at ≥1 comment, before and after adoption. Adoption also removes the pane's notice, strip and footer. The row itself, the mode switch and the format group are untouched, and the buffer is not re-created (`9c`.7). **Do not implement this as a remount.**

## The document-notice slot

**One slot, on every pane, for every document-level notice.** Immediately **below the toolbar and above the standing-conditions strip** (or, on a file-backed pane, above the document-info row) — the FR-ED-7 integrity banner, the untitled pane's amber loss notice, a Save As failure line and the adoption-provenance pending line all take it, in that order when they compose.

The phrase *"below the tab strip, above the buffer"* is **this folder's own**, written in refresh (6) — **FR-ED-7 states no placement at all**, and neither do `../ux-design.md`, `../tech-design.md` or `../test-plan.md`. What is resolved here is therefore this folder's prior ambiguity, not a ratified requirement: that phrase describes **two** slots once a pane has a toolbar, and this rules for the lower one. The reason is **movement, not hierarchy**: a notice can mount, unmount, collapse, expand or gain a failure line, and above the toolbar every one of those shifts the format controls vertically under a caret mid-edit. Below it, **the toolbar never moves** and only the document region reflows.

Binding consequence: **no notice, banner, failure line or status row may ever be inserted between the tab strip and the toolbar.**

## Document canvas

`flex:1; position:relative; overflow:hidden`, bg `#FCFBF8`.

Text column: `display:flex; flex-direction:column; gap:16px`, padding `34px 96px 34px 72px` in the redline mocks and `34px 84px 34px 72px` in the comment mocks (narrower right pad because gutter icons occupy the margin).

- Title: Source Serif 4, 600, 27px/1.25, `letter-spacing:-.01em`.
- Body paragraphs: Source Serif 4, 15.5px/1.75, `#33302A`.

### Tracked changes (inline markup)

- Deletion — `text-decoration:line-through; text-decoration-color:#A33A2E; color:#A33A2E`.
- Insertion — `background:#EDF4EF; border-bottom:2px solid #2E6B44; color:#22522F`.
- Paragraph-level change — `padding-left:14px; border-left:3px solid #B5871F` on the block.

### Selection popover

Appears on text selection. `display:inline-flex`, padding 4px, gap 2px, IBM Plex Sans 12.5px. Items, each padding 5px 10px, radius 5px (Win) / 6px (mac): `Comment` (active, bg `#F0EDE6`, 500) · `Quote to chat` · `Ask agent` (`#4F46E5`).

Windows: white fill, 1px `#D5D0C4`, radius 8px, `0 6px 18px rgba(31,29,26,.14)`.
macOS: `rgba(252,251,248,.92)`, radius 9px, `0 8px 22px rgba(31,29,26,.18), 0 0 0 1px rgba(31,29,26,.08)`.

**(19) On a pathless buffer** (`9g`, UXR-Q14.4 as corrected): `Comment` · `Quote to chat`. Only `Ask agent` is **absent** — no disabled item — until Save As. After a successful Save As an open popover re-renders in place with the full set; selection and editor are preserved and focus stays on its item.

Actions: `Comment` inserts a live draft card in the comments column and puts the selected (`+`) icon in the gutter; `Quote to chat` fills the composer quote bar; `Ask agent` starts an agent turn scoped to the selection.

### Scrollbar / minimap

5–6px rounded track at `right:3–4px`, `#D5D0C4` (Win) / `#CFC9BC` (mac).

## Status bar

**Leading slot, during a close attempt.** After 400 ms of an awaited final session write, the leading slot is replaced by `Saving your session…` — 11.5px `#6B665C` with a 6px `#B5871F` dot, `role="status"` — for the duration (`recovered-document.md`, `9c.8`/`9d.1`). Not a new surface and not an overlay; the bar keeps its platform fill.


Padding 8px 16px, 1px top `#E3DFD6`, bg `#F5F3ED` (Win) / `#F1EEE7` (mac), 11.5px `#6B665C`, gap 14px.

- Left, `·`-separated: `Markdown` · `1,208 words` · `14 tracked changes` · `2 open comments`. In comment mode: `Markdown` · `1,208 words` · `6 open comments` · `2 resolved`.
- Right cluster (`margin-left:auto`, gap 14px): `Display: all markup ▾` (menu: all markup / final / original) · `Saved · 2:14 PM` (Windows only) · `Claude Code · connected`.

**Items never wrap.** Every span is `white-space:nowrap`; the bar is one row at every width. Where the column is too narrow for the full set, the **right cluster** collapses trailing items into a `⋯` overflow, taking the agent connection first — the same discipline as the toolbar. The left cluster is never overflowed.

### On a pathless buffer

| Slot | Here |
|---|---|
| Left | mode readout · word count · **tracked-change count, present at ≥1 and absent at 0** · **(20) open-comment count present at ≥1 and absent at 0**, as the tracked-change count is (`9g.7`/`9g.8`) |
| Right — `Display: … ▾` | **Present**, all four modes — computed from the buffer's own markup, so it needs no file |
| Right — saved state | **Absent on both platforms**; the pane footer stands in for it |
| Right — agent connection | Present, unchanged |

**(20) The open-comment count follows the tracked-change rule.** Untitled documents take comments, so the count appears at ≥1 (`2 open comments`) in the same slot and treatment as a file-backed pane. It is absent at 0 rather than reading `0`; the comments column already says `No comments in this document` when it has loaded none. Superseded: (17)’s “absent, not zero — not possible here”.

**Unattributed tracked changes are stated here.** An untitled buffer's tracked changes are unrecorded — no author, no author-type, no agent note — but `✓ Accept` / `✕ Reject` is itself a provenance claim. The left cluster therefore qualifies the count: `1 tracked change · no author recorded`, the qualifier in `#8A6614`. It is on the count because the count is already there and already conditional; the standing-conditions strip is unconditional and would drag a conditional fact into its binding drop order, and the toolbar is the slot already at its width budget.

## Rail modes

The right rail holds **either** the timeline (372px) **or** the comments column (400px) — never both. `3a`/`3b` show the timeline; `4a`/`4b` show it collapsed to a `Timeline ››` toolbar chip with the comments column in its place. The `››` chevron reads as "bring it back from the right". Collapsed state is a persistent per-window preference.

**(17) Drawn:** the empty column (`4c`/`4d`, see `comments.md`), the per-window preference across tab switches (`4c.1`), the comment-card run link (`4e`), the return to the composer (`4f`), and the automatic expansion for a run started outside a comment card (`4g`). The transition swaps the occupant 400 → 372px in one step (the document column widens by 28px and the toolbar is re-measured); no animated width is specified. The composer, provider switcher, composer mic and J13 standing line exist **only** in expanded Timeline.

See `timeline-rail.md` and `comments.md`.
