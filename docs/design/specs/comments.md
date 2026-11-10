# Comments

Mocks: `4a` (Windows) / `4b` (macOS) for the normal column; `5a` / `5b` / `5c` for the comment-correction states. Read `tokens.md` and `platform-variants.md` first.

Two halves: **gutter icons** in the document margin, and the **comments column** in the right rail. They are reciprocally linked — clicking either selects both.

## Gutter icons

24×20px, `border-radius: 4px 4px 4px 0` (square bottom-left = speech-bubble tail), 1.5px border.

| State | Border | Fill | Glyph |
|---|---|---|---|
| Open comment | `#B5871F` | `#FBF3E1` | none, or reply count in 600 10px `#8A6614` |
| Selected / add-here | `#4F46E5` | `#E1E0F8` | `+` in 400 14px `#4F46E5` (box is 24×22) |
| Resolved | `#6E9179` | `#EDF4EF` | `✓` in 400 11px `#2E6B44` |

**(33) Dark selected icon.** The selected / add-here icon shares its fill token with the selected anchor, so (32)'s dark Selected move from `#26282C` to `#23284D` recolours the icon too. That is intended: the icon and its anchor read as one selection. Its border and `+` keep the dark accent `#A5B0FF` (6.92:1 on `#23284D`). Light is unchanged.

**Anchoring — use the paragraph-anchored approach.** In `4a`/`4b` each icon is `position:absolute; top:1–3px; right:-56px` (`-58px` for the wider selected icon) on its own paragraph, so it tracks the anchor as the document reflows. Options `3a`/`3b` show an earlier approach — icons at fixed `top` values in a 44px absolutely-positioned gutter strip — which is fragile; do not implement that. Add vertical collision nudging when two anchors fall close together.

**Anchor highlights in the text** (revised (32) and (33); values and contrast in `tokens.md` → *Comment-anchor states*):

The **fill says whether the thread is selected**; the **line says the thread's state**, by pattern and weight as well as colour. Selecting a thread swaps the fill to the indigo tint and keeps the state's line pattern, so a selected thread still shows its state. No anchor animates.

| State | Light | Dark | Line pattern (the non-colour carrier) |
|---|---|---|---|
| Open | `background:#FBF3E1; box-shadow:0 1px 0 #E0C98C` (unchanged) | `background:#78350F; box-shadow:0 1px 0 #FCD34D` (the warning pair, unchanged) | 1px solid |
| Working | `background:#F0EDE6; border-bottom:1px dotted #6B665C` | `background:#26282C; border-bottom:1px dotted #9AA0A6` | 1px **dotted**, neutral |
| Addressed — pending | `background:#FBF3E1; border-bottom:2px dashed #8A6614` | `background:#78350F; border-bottom:2px dashed #FCD34D` (6.29:1) | 2px **dashed**, amber |
| Reopened (unchanged) | `background:#FFE0D6; border-bottom:3px double #CF5B22` | `background:#3A3D42; border-bottom:3px double #F87171` (confirmed (33)) | 3px **double** |
| Suggestion | `background:#D8F0DD; border-bottom:1px solid #1A7F37` (unchanged) | **(33)** `background:#14532D; border-bottom:1px solid #86EFAC` | 1px solid, green |
| Selected + Open | `background:#E1E0F8; box-shadow:0 1px 0 #A19CE9` (unchanged) | `background:#23284D; box-shadow:0 1px 0 #A5B0FF` | 1px solid |
| Selected + Working | `background:#E1E0F8; border-bottom:1px dotted #4F46E5` | `background:#23284D; border-bottom:1px dotted #A5B0FF` | 1px dotted |
| Selected + Addressed — pending | `background:#E1E0F8; border-bottom:2px dashed #4F46E5` | `background:#23284D; border-bottom:2px dashed #A5B0FF` | 2px dashed |
| Selected + Reopened **(33)** | `background:#E1E0F8; border-bottom:3px double #CF5B22` | `background:#23284D; border-bottom:3px double #F87171` | 3px double, own colour |
| Selected + Suggestion **(33)** | `background:#E1E0F8; border-bottom:1px solid #1A7F37` | `background:#23284D; border-bottom:1px solid #86EFAC` | 1px solid, own colour |

- **Selected composes with every state; it is not an Open-only style.** A selected thread takes the selected fill and its state's line together, so selection must be applied alongside the state's style, never instead of it. Working and Addressed — pending redraw their pattern in the accent when selected. **(33)** Reopened and Suggestion keep their line in **their own colour** when selected (CJ, 2026-11-10), because those lines are already unlike the others, and Suggestion's 1px solid line in the accent would match Selected + Open in everything but shade.
- **Working is neutral, not violet.** It means the agent is running and the author owes nothing, so it takes no accent (accent means a selection or an action) and no amber (amber means a comment waiting on the author). The previous `#E6E0FF` / `1px dashed #6F52D9` treatment is withdrawn; it measured 1.02:1 against the Selected tint.
- **Addressed — pending stays in the comment amber**, because like Open it waits on the author. It differs from Open by a 2px dashed line in the darker amber ink, against Open's 1px solid light amber line. It no longer shares Working's anchor.
- **(33) Dark Suggestion is green.** The app drew it on the surface `#26282C` with a 1px solid `#9AA0A6` line: the same fill and colour as dark Working, separated only by solid against dotted. It now takes the green-900/green-300 pair, `#14532D` with `#86EFAC`, which keeps its light-theme meaning (green, as in insertion and accept) and follows the same construction as the dark warning pair (`#78350F`/`#FCD34D`). Against dark Working it now differs in fill (1.62:1), hue, line colour and pattern.
- **The anchor follows the state the card displays**, in §2's presentation order. A thread with a run in flight shows Working even if an earlier delivery left changes undecided; those changes are marked in the text by their own redline marks.
- **Reduced motion.** Nothing here moves. If the implementation adds motion to Working (moving dots, for example), the static dotted line must remain the carrier and the motion must stop under `prefers-reduced-motion`.
- **Forced colours.** Draw the patterned lines with `border-bottom`, not `box-shadow`: Windows High Contrast drops box shadows but keeps borders, so Working and Addressed — pending stay distinct there. Open and Selected + Open still use the shadow line (unchanged), which forced colours hide.
- **Binding: `../ux-design.md` §2, the fourth carrier** (williacj/emend#40, merged in #43). §2 lists the anchor in the text as the fourth non-animated way of telling Working from Addressed — pending. It binds only where the thread has a live anchor (document-level and Orphaned threads have none), and selecting a thread must never hide which of the two it is. This table discharges it; §2 governs if they ever disagree.
- **Known gap, not changed:** unselected Open and Suggestion share a 1px solid pattern and differ by hue and fill, in both themes. Suggestion's card carries a diff preview and `Apply`, so the thread is never ambiguous, but the anchor alone is colour-dependent for that pair. It is outside §2's fourth carrier, which covers only Working and Addressed — pending.

The `+` icon is also the **live add affordance**: highlighting text shows it in the gutter next to the selection before the comment is committed.

## Comments column (400px)

Background `#F0EDE6` (Win) / `#EDEAE2` (mac).

**Header** — padding 12px 14px, 1px bottom `#E3DFD6`: `COMMENTS · 6 OPEN` (10.5px, 500, `letter-spacing:.1em`, `#8C8779`) + right-aligned sort chip `Position ▾` (12px, padding 4px 9px, white; sorts by anchor position in the document, alternative is recency).

**Body** — `flex:1; display:flex; flex-direction:column; gap:11px`, padding 14px.

## Thread card (open)

Padding 13px, gap 9px, white. Windows: 1px `#E3DFD6`, radius 8px, `0 1px 2px rgba(31,29,26,.05)`. macOS: radius 10px, `0 1px 3px rgba(31,29,26,.08)`.

Rows in order:

1. **Header** (gap 9px) — 26px avatar circle · author 12.5px/500 · relative time 11px `#A39E92` · right-aligned action cluster (`margin-left:auto`, gap 10px, 13px, `#6B665C`): `⋯` menu · `✎` edit · `✓` resolve. Drawn always-visible in the mocks; they may reveal on hover/focus but must stay keyboard-reachable.
2. **Body** — 13px/1.6, `#33302A`.
3. **Collapse row** — **only when the thread has 2+ replies**: `▸ 2 more replies`, 12px `#4F46E5`, 500. The newest reply always stays visible below it; the middle replies are what collapse. A thread with one reply renders it inline with no collapse row. Expansion is per-thread and not persisted.
4. **Reply block** — `padding-left:11px; border-left:2px solid #EDEAE2`, gap 6px. 20px avatar · name 12px/500 · time 11px `#A39E92` right · small `⋯ ✎` cluster 12px `#8C8779`. Body 13px/1.6.
5. **Reply affordance** — collapsed one-line field: padding 9px 11px, radius 7px (Win) / 8px (mac), bg `#FCFBF8` (Win) / `#FAF8F3` (mac), hairline border, placeholder `Reply…` 12.5px `#A39E92`. Expands to a textarea on focus.

## Overflow menu

Opened from `⋯`, which takes a `#EDEAE2` background while the menu is open. Width 216px, right-aligned to the card (`align-self:flex-end`), radius 8px (Win) / 9px (mac), padding `5px 0`, items 12.5px `#3A362F` padding 8px 13px:

- `Copy link to comment`
- `Mark as resolved`
- separator, 1px `#EDEAE2`
- `Delete comment` in `#A33A2E` — requires confirmation (see "Correcting your own comment")

The delete item is present only on the reader's own comment. On another actor's comment it is **absent, never disabled** (FR-CMT-8).

Windows: white, 1px `#D5D0C4`, `0 8px 22px rgba(31,29,26,.16)`. macOS: `#FDFCFA`, `0 12px 28px rgba(31,29,26,.2), 0 0 0 1px rgba(31,29,26,.08)`.

## Editing state (in place)

Replaces the body of the card being edited; the card does not move.

- Card emphasis — Win: 1px `#B4AE9E` + `0 2px 8px rgba(31,29,26,.08)`. mac: `0 3px 12px rgba(31,29,26,.1), 0 0 0 1px #C6BFAE`.
- Header — the timestamp is replaced by the word `Editing`, 11px `#8C8779`. Action cluster hides.
- Textarea — min-height 44px, padding 9px 11px, 13px/1.6 `#33302A`. Focus ring: Win `border:1px solid #4F46E5`; mac `box-shadow: 0 0 0 2px rgba(79,70,229,.72)`.
- Buttons — `Save` (`#1F1D1A`, white, 500) · `Cancel` (white / hairline), 12.5px, padding 6px 13px, radius 6px (Win) / 7px (mac). macOS shows a right-aligned `⌘⏎` hint.
- Keys — `⌘⏎` / `Ctrl+Enter` saves, `Esc` cancels and restores the previous body.

## Resolved thread

Shown when resolved threads are expanded. Windows: 1px **dashed** `#D5D0C4`, bg `#F7F5EF`. macOS: bg `#F5F3ED` + `0 0 0 1px #E3DFD6`, radius 10px. Padding 12px 13px, gap 7px.

24px avatar; author and body both muted to `#8C8779` (body 12.5px/1.6); `✓ Resolved` pill (padding 2px 8px, radius 10px, bg `#EDF4EF`, border `#A9C4B2`, text `#2E6B44`, 11px); a single `⋯` action. No reply field. The reply collapse row still shows (`▸ 1 more reply`).

## Hidden-threads chip

Centered pill: 11.5px `#6B665C`, padding 5px 12px, radius 12px, bg `#F7F5EF` (Win) / `#F5F3ED` (mac), hairline. Activating it reveals the **entire** hidden set inline.

**The wording depends on what is hidden** (`5c.4`). Withdrawn placeholders are hidden alongside resolved threads and are counted with them:

| Hidden set | Chip |
|---|---|
| Every hidden item is resolved | `N resolved threads hidden` |
| The set contains a withdrawn placeholder (with or without resolved threads) | `N hidden threads` |

`N resolved threads hidden` is a claim about every item it counts, so it survives only in the first row; a placeholder in the set makes it false. The neutral form covers the mixed and the withdrawn-only case alike — a withdrawn-only set still gets a chip and still reveals on activation, never a silently empty column. Geometry, color and placement are identical in both forms.

## Interactions

- **Click a gutter icon** → scroll its thread into view in the column and select it (anchor fill switches to the `#E1E0F8` selected tint and its line keeps the thread state's pattern; see *Anchor highlights in the text*). Click a card → same in reverse.
- **Resolve (`✓`)** → thread animates to the resolved treatment; if resolved threads are hidden it collapses into the hidden-threads chip, and the header count decrements.
- **Edit (`✎`)** → in-place editing state above.
- **`⋯`** → overflow menu above.
- **Sort chip** → position (anchor order) or recency.
- **Toolbar `Open (6) ▾`** → filter which threads the column shows; `Address all… ▾` hands the open threads to an agent (see [`docs/ux-design.md`](../../ux-design.md) J4). **(26)** In the main app `Address all… ▾` lives in the **editor toolbar** (and its `⋯` overflow at 900px), not here or in the Timeline header. No `Open (N) ▾` toolbar control ships, so the 4a/4b chip is superseded context. See *Address all chooser* below.

---

# Correcting your own comment

Mocks: `5a` (Windows) / `5b` (macOS) galleries, `5c` cross-surface, `5d` child-first Delete (refresh (17)). Requirements: D24, FR-CMT-8..13.

**Status — ratified; appearance and J10 behavior are binding.** The requirements are ratified: **D24** and **FR-CMT-8..13** (CJ 2026-08-05, Q21). This section is the appearance authority for them, binding as the rest of this folder is.

**UXR-Q9 is resolved** — by CJ on 2026-08-09 (`145c655c`), through these options. It asked for three surfaces the mocks asserted but did not draw: the delete confirmation, the withdrawn placeholder, and the inert/refused rendering. `5a`/`5b`/`5c` draw all three, and this section is their appearance authority.

Behavior lives in **J10 — "Correct your own comment (revise or withdraw)"** (`../ux-design.md`, epic #1125, PR #1312), **ratified by CJ on 2026-08-09 in session at the DH-7 gate** (`145c655c`). J10 governs behavior, this section governs appearance, as with every other surface in this folder.

**J9 and UXR-Q8 are not these states.** They belong to project-open routing across instances (#759, ratified by CJ 2026-08-09, PR #1150). Earlier drafts of this folder cited J9 for correction; that attribution was wrong and is superseded here.

Everything here is the existing thread card with its **body replaced**. No new component family, no new tokens, no dialog. Author/provenance header stays; ordinary actions hide while a correction is in progress. The same components render in the comments column, the editor comment popover, and the timeline thread card.

## Delete eligibility — child-first (`5d`, refresh (17))

J10 Phase B (CJ, 2026-09-30): an authored comment or reply with **any unwithdrawn descendant reply** cannot be deleted — resolved and dismissed threads included. Each author deletes only their own words in v1; **no owner-moderation control is drawn anywhere**, so another actor’s reply can keep a parent unavailable indefinitely. Confirmation is reachable only once every descendant reply is withdrawn. A withdrawn descendant is no longer a blocker.

## Delete confirmation (`5a.1`, `5a.2`, `5d.4`)

Card takes the **emphasized** treatment already used by the in-place editing state — Win: 1px `#B4AE9E` + `0 2px 8px rgba(31,29,26,.08)`; mac: `0 3px 12px rgba(31,29,26,.1), 0 0 0 1px #C6BFAE`. The card does not move.

- **Header** — avatar · author · time stay. The right-hand action cluster is replaced by the word `Deleting`, 11px `#8C8779` (the same slot the editing state uses for `Editing`). On a published comment an `In review` pill sits after the time: 11px `#4F46E5`, padding 2px 7px, radius 10px, bg `#E1E0F8`, border/ring `#B3B0E6`.
- **Body** — gap 7px:
  1. Heading `Delete this comment?` — 12.5px/600 `#1F1D1A`.
  2. Provenance line — 12.5px/1.6 `#4A463E`. Two variants, chosen by publication and reply state:
     - never published, no historical reply by another actor (clean disappearance): *This comment hasn't been shared and no one else has replied, so it will disappear from the document.*
     - published, or historically replied to by another actor (already-seen): *Others may already have seen this comment. The thread will keep a note that you deleted it.* — **(17)** the clause “and replies will remain” is removed: no live reply can exist at this point.
     - **(17) The private-root cascade confirmation is withdrawn.** There is no variant that takes your own replies with it.
  3. History line — 12.5px/1.6 `#6B665C`, identical in both variants: *Emend keeps the original text in this document's history. Deleting removes it from view, not from the record. This can't be undone.*
     This line is required by FR-CMT-11; it must not be shortened into an implication of erasure.
     Never name an individual reviewer — a live review can have several readers.
- **Actions** — `Delete` filled `#A33A2E`, white, 500, then `Cancel` (Win: white + 1px `#D5D0C4`; mac: white + `0 0 0 1px #DCD7CC`). Padding 6px 13px, radius 6px (Win) / 7px (mac). Order matches the editing state's `Save`/`Cancel` on **both** platforms — internal consistency with its nearest sibling beats per-OS button order here. Right-aligned hint: `Esc cancels` (Win) / `⎋` (mac), 11px `#A39E92`.
- **Destructiveness is encoded three ways** — filled destructive fill, the explicit verb `Delete`, and the visible "can't be undone" statement. No trash glyph: a second symbol would blur the difference between leaving the view and leaving the record.
- **(17) No live reply renders beneath a confirmation.** Where a withdrawn reply existed, its 5a.3b provenance line (`**Marcus L.** deleted a reply`) sits beneath the actions (`5d.4`).
- `Esc` and `Cancel` restore the untouched card with no residue.

## Withdrawn placeholder (`5a.3`)

Shown when a **published** parent **without live replies** is withdrawn, or when historical reply provenance requires it (FR-CMT-9) — `5d.5`. A never-published parent with no historical reply leaves no residue at all.

**(17) Exceptional convergence only** (`5a.3` / `5b.3` / `5c.2`, relabelled): an offline reply by any author that arrives **after** an admitted withdrawal renders live beneath the placeholder — even for a formerly private parent — and its record is never discarded. This is no longer the ordinary outcome of withdrawing a replied-to parent, which cannot happen. This refresh sets no new placeholder policy for a later parent withdrawal over such a reply.

Flat, quiet, no elevation. Win: padding 11px 13px, radius 8px, bg `#F7F5EF`, **1px solid** `#E3DFD6`. mac: radius 10px, bg `#F5F3ED`, `0 0 0 1px #E3DFD6`. The Windows **dashed** border is not used — it already means resolved.

- One header row: 20px avatar `#E3DFD6` · `**You** deleted a comment` 12.5px `#8C8779` (author name 500) · deletion time right, 11px `#A39E92`.
- A late-arriving reply (convergence state only) renders below in the ordinary reply block, at full body contrast — it is live content.
- **(21)** `→ Go to passage` anchor route, 12px `#4F46E5`, beneath the header on every surface (`5d.5`, `5c.2`, Windows and macOS). The placeholder stays quiet and bodyless, and its label is **fixed text, not a computed location**. No section/paragraph numbering rule exists, so no surface currently computes or prints a `§n ¶n` location. **`→ Go to passage` is the current label for every comment anchor route** — live cards (`4e`), the withdrawn placeholder (`5d.5`, `5c.2`) and the lo-fi wireframe — pending any later decision, including a section/paragraph numbering rule. Superseded: (17)’s `→ §2 ¶3` on the placeholder.
- **Absent:** original body, all actions, the reply composer, the gutter icon, the anchor highlight, and any open-thread weight.
- Placeholder threads group with resolved threads but keep their anchor-order position, and count into the hidden-threads chip under its rule above.
- **The anchor route survives** (`5c.2`). What withdrawal removes is the gutter icon, the anchor *highlight*, and the open-state weight — not the navigation. Activating the placeholder still scrolls its document anchor into view, on every surface that draws one. A surviving reply that answers a passage the reader cannot reach is the defect this avoids; the reply stays live, so its subject stays reachable.

**Nested variant** (`5a.3b`) — a reply, not the root, withdrawn inside a live thread: one line inside the reply block, 16px avatar · `**You** deleted a reply` 12px `#8C8779` · time right. No card of its own.

## Refusals

All three are local, always visible, and keyboard reachable. No dialog, no global banner, no tooltip.

**(17) Live descendant — Delete only** (`5d.1`–`5d.3`, `5d.7`, `5d.8`). Same menu geometry and inert footer block as the linked-changes refusal: `Delete comment` (or `Delete reply` on a reply) inert in `#A39E92`, with `Delete replies first.` beneath it at 11.5px/1.5 `#6B665C`. **No link and no `Go to …` control** — the author cannot act on another actor’s reply. Activating it opens no confirmation and moves no focus. Identical in the column, the 340px editor popover and the timeline thread card. Edit stays live; closure controls stay live **unless a linked change is undecided**.

**(19) Combined — live descendant + undecided linked changes.** Both rules apply: header `✓` and `Mark as resolved` inert with the card-level linked-changes reason and `Go to changes` (`5a.4`), and `Delete comment` inert with its own `Delete replies first.` beneath it in the menu.

**(17) Commit-time recheck** (`5d.6`). If a reply arrives while confirmation is open, `Delete` refuses visibly: the confirmation is replaced by an inline block (padding 9px 11px, radius 7px, bg `#FAF8F3`, 1px `#E3DFD6`) — `Delete replies first.` 12.5px/500 `#33302A`; **reason only** — no second sentence (ruled (18)); header slot reads `Not deleted`; the new reply renders live; focus returns to `⋯`.

**Undecided linked changes — closure and Delete together** (`5a.4` / `5b.4`, redrawn (18); D29, FR-CMT-21(a)). The overflow menu opens as normal. `Mark as resolved` and `Delete comment` both render **inert in `#A39E92`, not red**; the header `✓` (Resolve) mutes to `#C6BFAE` with an accessible name stating why. Because one cause now blocks three controls, the reason moves to **card level** (as the run refusal does): a line below the body — padding 8px 10px, radius 6px (Win) / 7px (mac), bg `#FAF8F3`, 1px `#EDEAE2` ring — reading *2 linked changes still to decide. Accept them and this thread resolves; reject them and it reopens, and you can dismiss it then.* at 11.5px/1.5 `#6B665C` (J10 copy), then `Go to changes` 12px/500 `#4F46E5`, focusable. `Dismiss`, where a menu carries it, is inert by the same rule. `Edit` stays available. Menu width 232px.

**Active "Address with AI" run — Edit and Delete** (`5a.5`). `⋯` **stays available** and opens as normal — the menu is how a reader reaches the actions that are still legal. Inside it `Copy link to comment` and `Mark as resolved` are active, and `Delete comment` renders inert in `#A39E92` on the tinted footer block. `✎` in the card header mutes to `#C6BFAE`; **`✓` stays active — a live run alone never disables Resolve** (FR-CMT-21(b)); an undecided linked change still does (`5a.4`), run or no run. The inert menu item carries no reason of its own — one cause blocks both controls, so it is stated once at card level. A card-level status line sits below the body — padding 8px 10px, radius 6px (Win) / 7px (mac), bg `#FAF8F3`, hairline, `◔` in `#B5871F`, text 11.5px/1.5 `#6B665C`: *Addressing with AI — you can edit or delete this comment once the run finishes.* Card level rather than menu level because two different controls are blocked by one cause. **No `[Stop]` here** — stopping the run stays on its timeline card; do not duplicate agent controls.

## Edited marker (`5a.6`)

Appears only where the comment was published to a review or another actor has replied (FR-CMT-13); never on a private, unseen comment (`5a.6b`).

In the header, after the creation time: `·` then `edited 2m ago`, 11px `#A39E92` — the same weight and color as the timestamp beside it, so it never competes with author or publication provenance. Informational only: no link, no version history, no hover target.

## Control states (`5a.7`, `5b.7`)

| Control | Rest | Hover | Focus | Pressed |
|---|---|---|---|---|
| Delete | `#A33A2E` | `#8E3226` | rest + `0 0 0 2px #fff, 0 0 0 4px #4F46E5` (Win) / `0 0 0 3px rgba(79,70,229,.72)` (mac) | `#7A2A20` |
| Cancel | white + hairline | `#F7F5EF` + `#C6BFAE` | rest + same accent ring | `#EDEAE2` + `#B4AE9E` |
| Menu item | transparent | `#F0EDE6` (Win) / `#EDEAE2` (mac) | `inset 0 0 0 2px` accent | — |
| Inert menu item | `#A39E92` text on the tinted footer; not hoverable, not focusable | | | |

The refusal reason is static text, but the `Go to changes` control inside it takes the ordinary accent focus ring and sits in tab order.

## Cross-surface (`5c`)

- **Editor comment popover** — same component at 340px wide with the popover shadow; nothing else changes. The anchor keeps its selected highlight while confirming and drops to no highlight the moment the delete lands.
- **Timeline thread card** — keeps the card's own kind/time header row above the component; everything below it is the column treatment unchanged.
- **Reviewer mode** — same components, same authorship rule: actions are absent on another actor's comment, never disabled.

---

# Collapsed-Timeline column states (`4c`–`4e`, refresh (17))

Behavior: `../ux-design.md` §4 *Collapsed-rail supplement*, J12, J13; UXR-Q13.1–3, Q14.3 (CJ 2026-09-30).

- **Width never changes.** The column stays **400px** on every open document, including the empty ones. Collapse never widens the editor.
- **Header with no threads:** `COMMENTS` alone — no `· 0 OPEN`, no badge, and no `Position ▾`.
- **Empty message:** body text, 13px/1.6 `#6B665C`, centred, max-width 280px, 44px top padding. Not a button, not focusable, no icon. One string on every open document:
  - file-backed, **after a successful comments load with no threads**: `No comments in this document` (`4c`)
  - **(19)** untitled: the **same** message — untitled documents take comments (shipped; CJ 2026-10-01). (17)’s `Comments are available after Save As` is withdrawn.
  - pending or failed load: **no zero claim**; treatment is a recorded gap (`state.md`).
- **Tab switch** (`4c.1`): contents follow the active tab; `timelineCollapsed` is untouched; focus stays on the tab.

## Run link on a comment card (`4e`)

After `[Address with AI]` while collapsed, the card keeps its `◔ Addressing with AI…` line (`5a.5`) and gains a **footer row**: `padding-top:7px; border-top:1px solid #EDEAE2; display:flex; flex-wrap:wrap; gap:3px 10px`.

- `Show the run` — 12px/500 `#4F46E5`, a link. Focus: 2px `#4F46E5` ring hugging the label (2px pad, radius 4px). Distinct from the anchor route (`→ Go to passage`, regular weight, under the body).
- `Unsaved text sent with this run` — 11.5px/1.45 `#6B665C` plain text beside the link; wraps beneath it, never truncated. **Only** when the envelope carried `content` (dirty path-bearing within bound, or active untitled within bound). Clean and over-bound runs show the link alone.
- Activation: the `Timeline ››` transition (400 → 372px), the run card revealed with 12px clearance, **focus on the run card container** (2px `#4F46E5` outline, 2px offset), never `[Stop]`.

---

# Comment-composer mic (`14c`, refresh (22), #2613)

The 340px popover composer carries the shared 28×26 mic. **Placement:** the left end of the action row, flush with the textarea’s left edge (x = 12px); `Cancel` · `Comment` right-aligned, gap 8px, `Comment` flush with the right inner edge (x = 328px). **Provisional text** sits in a slot directly below the textarea (8px), full inner width, ghost treatment, wrapping; an error echo takes the same slot in `#A33A2E`. `Comment` is the ink primary and disabled while the draft is empty. States, dark values and the full geometry table: `voice.md` §4.

---

# Address all chooser (`15a`–`15d`, refresh (26), J4 batch)

**This section is the intended target.** Behaviour is [`docs/ux-design.md`](../../ux-design.md) §3 J4 *Batch*, the J4-Q1 amendment in §5, UXR-Q18, and UXR-Q16.4 for landing, plus CJ's rulings of 2026-10-04 recorded below. **Shipped** in #2680 / #2681 (`main` @ `144ddb718`): `src/comments/BatchAddressTrigger.tsx`, `batchAddress.ts`, `src/editor/ViewModeToolbar.tsx`, `ToolbarOverflowSlot.tsx`, `src/styles.css` (`.batch-address*`), plus #2678 for run-card focus. J4 records the rulings (#2676).

**Evidence.** Browser captures in `docs/alignment-address-chooser/` (#2679): 1280px and 900px, Windows and macOS platform styles, light and dark, plus four held-state frames. `measurements.json` records the source revision, fonts, CSS colours and geometry, including the chooser opening 4px below the visible `⋯` with its right edge aligned. **Not validated:** native Windows title controls and native font metrics.

## Hosts
- **The main app has exactly two hosts:** the editor toolbar, or its `⋯` overflow at 900px. The Timeline-header host is **standalone-only** and is not drawn in any main-app frame.
- **Main app: editor toolbar.** The trigger sits in its own group after the format group, with a left hairline and gap 6. The right cluster keeps the **pinned mic** first, then `Timeline ››` when Timeline is collapsed (`15a`). Present only while more than one comment is open.
- **900px: toolbar overflow.** `Address all…` is the first control to leave the row (`COLLAPSE_ORDER`). In `⋯` it is listed in row order, after the switch and the format group, as a full-width chip. Activating it closes `⋯` and opens the chooser **anchored to `⋯`**: 4px below, right edges aligned, and `⋯` keeps its open fill while the chooser is up (`15b`).
- **Standalone Timeline host** (`TimelinePanel` outside the main app): the trigger sits in the Timeline header. It shows component states only (`15c`), not a main-app layout. The panel **floats** here too, so the header stays one row.

## Copy
- Trigger: `Address all… ▾`.
- Filters, in order: `Source` · `Severity at least` · `Review pass`. Each select's first option is `All`, and no filter is pre-applied.
- Scope line, restated against the current filter, in a polite live region:
  - with held threads: `Address all · N open comments · M already in an agent run —`, then the checkbox `include them too`, described by the line;
  - **with none held (CJ): `Address all · N open comments`**, with no clause and no checkbox.
- Run: `Address K comments` (singular at 1), where K = N − M, or N when opted in. Disabled at K = 0. Reads `Addressing…` while an admission is pending.

## Behaviour drawn (CJ, 2026-10-04 — appearance of ruled behaviour only)
- **Open:** focus moves to `Source`, the first filter, from either host (`15a.1`, `15b.2`, `15c.1`).
- **Dismiss:** Escape or an outside click closes the chooser from either host. **Escape** returns focus to the invoker: the trigger, or `⋯` at 900px (`15a.8`, `15b.5`). **An outside click** leaves focus with the clicked target.
- **Filter scope:** the chosen filter is kept through close and reopen on the same document (`15a.5`) and resets to All when the active document changes (`15a.6`). `include them too` resets on submit and whenever the held set changes.
- **After admission (CJ; UXR-Q16.4):** focus moves to the admitted run's card, **whether Timeline began collapsed or expanded**. That is the owning submitted-turn card; `Address all…` creates no user chat card, so it is the run card, drawn with a 2px accent outline at a 2px offset as in `4g`. From a collapsed Timeline the run expands it (400 → 372px), and the facet becomes `All` only if the current one excludes the run (`15a.4`, `15b.4`). From an expanded Timeline nothing expands; the same facet rule applies, and focus still lands on the run card. A clean document gets no J13 line. If the document is dirty, the run card carries the line drawn in `4g.3`.

## Appearance
| Part | Light | Dark | Notes |
|---|---|---|---|
| Trigger | 4px 9px, 12px/1.5 IBM Plex Sans, `#FFFFFF` / `#4A463E` | `#1E1F22` / `#E6E7EA` | Win `1px #D5D0C4` r6 (dark `#3A3D42`) · mac `0 0 0 1px #DCD7CC` r7 · open `#F0EDE6` / `#3A3D42` |
| Panel | `#FAF8F3`, `1px #E3DFD6`, shadow `0 8px 22px rgba(31,29,26,.16)` | `#26282C`, `#3A3D42`, `rgba(0,0,0,.35)` | r7 Win / r8 mac · padding 10 · gap 8 · min-width 220 · **max-width 320** · 4px below the invoker, right edges aligned |
| Filter row | label 12px `#6B665C`, space-between, gap 12 | `#9AA0A6` | — |
| Select | 4px 22px 4px 9px, 12px, `#FFFFFF` / `#3A362F`, drawn `#A39E92` chevron, min-width 132 | `#1E1F22` / `#E6E7EA` | border as the trigger |
| Scope line | 12px/1.5 `#6B665C`, wraps, gap 4px 6px | `#9AA0A6` | — |
| Checkbox | 14px r3, `#FFFFFF` / `1px #D5D0C4`; checked `#4F46E5` with a white tick | `#1E1F22` / `#3A3D42`; checked `#A5B0FF` with a `#10131A` tick | label `#3A362F` / `#E6E7EA`, gap 6 |
| Run | accent primary `#4F46E5` / `#FFFFFF`, 500 12px, 5px 11px, r6 (mac r7), hugs its label on the right | `#A5B0FF` / `#10131A` | disabled at `opacity:.55` |
| Focus | `2px #4F46E5`, offset 1px | `#A5B0FF` | trigger, `⋯`, every chooser control |

## Dispositions of the refresh-(25) differences (`15d`)
- **Resolved and shipped (#2680 / #2681):**
  - M1 em dash;
  - M5 app-styled controls;
  - M6 app focus ring;
  - M7 both hosts float;
  - M8 Windows toolbar trigger border (the undefined `--timeline-facet-border`);
  - M9 turn 15 supersedes the 4a/4b chip and drops their `Open (6) ▾`;
  - M12 anchor 4px below the visible `⋯` at 900px, right edges aligned.
- **Retained as the target:** M3, the shipped filter order and labels.
- **Ruled by CJ:** M2 (omit the clause at 0 held), M4 (filter scope), M10 (focus on open; Escape returns focus to the invoker, an outside click leaves it with the clicked target), and **M11 (run-card focus after admission from either Timeline state)**. M11 shipped in #2678.
- **Nothing is open.**
