# Document integrity — "This file changed outside the editor" (FR-ED-7)

Mocks: `11a` (Windows) / `11b` (macOS) / `11c` (states), wireframe storyboard `1n`. Read `tokens.md` and `platform-variants.md` first.

**Behavior is not this file's.** It binds in `../functional-spec.md` **FR-ED-7** and `../ux-design.md` "Document integrity & lifecycle moments" (CJ architecture amendment #1599, 2026-08-16): the write pause, what Save does, what Reload and Keep mine authorize, and Save As remaining separate. This file settles **appearance** — presentation, hierarchy, button treatment, focus, announcement copy, progress and failure feedback, and the post-Reload dirty indication. The shipping `src/editor/ExternalChangeBanner.tsx` already renders the ratified copy and the highlighted-default rule; what follows re-specifies its appearance.

## Placement and shell

A **non-modal bar across the top of the editor** — `../ux-design.md`'s words, and the whole vocabulary for this family: *never a dialog over your text*. It sits in the **document-notice slot: immediately below the toolbar, above the buffer** — never inside it, never as a dialog. The phrase *"below the tab strip, above the buffer"* is **this folder's own**, from refresh (6), not FR-ED-7's — **the requirement states no placement**. It describes **two** slots on any toolbar-bearing pane, and this resolves it to the lower one; the slot, and the reason (a notice that changes height must never move the format controls under the author's caret), bind in `authoring-shell.md`. **The same slot carries the untitled pane's amber loss notice** — one vocabulary, one slot, both panes. `11a` / `11b` / `11c.1` were previously drawn in a reduced frame with no toolbar and so never had to choose; they are redrawn with one.

| | Windows 11 | macOS |
|---|---|---|
| Fill | `#FBF3E1` | `#FBF3E1` |
| Edge | `border-bottom: 1px solid #E0C98C` | `box-shadow: 0 1px 0 #E0C98C` |
| Padding | 10px 14px | 10px 14px |
| Leading dot | 6px circle `#B5871F`, `margin-top:6px` | same |

**Why amber.** It is the same treatment the 9-series over-cap notice uses because it means the same class of thing: *your work is at stake and Emend has stopped writing*. Reusing it adds no vocabulary.

## Hierarchy — two lines, then the actions

1. **Message**, 12.5px/500/1.45 `#8A6614` — the ratified sentence verbatim: **"This file changed outside the editor"**.
2. **Consequence**, 11.5px/1.5 `#8A6614` — what the author needs next: **writes are paused**, and **the unsaved edits are still here**. The path is named in italic, as everywhere else in this folder.
3. **Action cluster**, right, `gap:6px`, vertically centered, in the ratified order: `Reload` · `Keep mine` · `Compare`.

Two lines, never three. Anything further belongs in Compare, not in the bar.

## Buttons

| | Windows 11 | macOS |
|---|---|---|
| Ordinary action | `#FCFBF8`, 1px `#D5D0C4`, radius 5px, padding 5px 11px, 11.5px | `#FCFBF8`, `0 0 0 1px #DCD7CC`, radius 7px, same padding/size |
| Highlighted default | solid `#4F46E5`, white, 500 | identical |

**`Keep mine` is the highlighted default only while unsaved local edits exist** (FR-ED-7's safe choice). With a clean buffer all three actions carry equal weight — `11c.1` — because then nothing of the author's can be lost and the design must not push a choice. The solid-accent treatment is the one `Review 1-by-1` and `[Save As…]` already use.

**Nothing is styled destructive.** `Reload` does replace the buffer, but the author asked for it and `Compare` exists to be read first. Reject-family styling in this bar is reserved for **failure**, below.

## Focus

- **Appearing takes no focus.** An author mid-sentence keeps their caret. This is binding: the banner is `role="status"`, not a dialog, and has no focus trap, no overlay, no `aria-modal`.
- **A blocked Save is the one exception**: focus moves to `Keep mine` (`11c.2`), because Save was an explicit request that produced no write and the author needs the choice under their hands.
- Focus ring: 2px `#4F46E5`, offset 1px — the app's convention.
- Tab order is buffer → `Reload` → `Keep mine` → `Compare`, matching reading order.

## Announcement copy

The bar is `role="status"`, announced politely once on appearance. **A blocked Save rewrites both lines**, which re-announces the whole region:

> **Not saved — this file changed outside the editor**
> Emend didn't write over it. Choose Reload, Keep mine, or Compare.

The lede belongs in the **heading**, not stacked beneath an identical one: the ratified sentence must appear **once**, never twice in the same bar. Line one states the outcome and the cause; line two states what Emend did about it and the way out. **The announcement stays self-contained because the status region announces both lines together** — a screen-reader author hears outcome, reason and choices in one pass, and never hears the same clause twice. **Plain language only.** No internal vocabulary in any user-facing string on this surface — never "flush", "imperative save", "divergent revision", "queued write", "publication".

## Reload in progress

- `aria-busy="true"` on the bar.
- The three actions dim to **45% opacity** and stop responding; they are not removed — the row must not reflow while the author is looking at it.
- A quiet **`Reloading…`** (11.5px `#8A6614`) sits left of the action cluster.
- Line two becomes: *"Bringing in the version from disk and saving it in place. Your earlier text is being replaced."*
- **Nothing is announced on entry.** `aria-busy` suppresses the churn; the outcome is what deserves an announcement.

## The pending recovery write — post-Reload dirty indication

Between the buffer swap and a successful recovery write the document is **genuinely unsaved**, and FR-ED-7 requires it to say so. It says so with the **ordinary `#4F46E5` tab dot**, plus the status bar reading `Reloaded from disk · not saved yet` (`11c.4`).

**No new badge and no second colour.** Inventing a marker for a state that is exactly "dirty" would dilute the ordinary dot. The status-bar line is the only thing that distinguishes this dirtiness from any other, and it disappears when the write succeeds — replaced by the ordinary `Saved · h:mm PM`.

## Reload failure

The bar **stays amber** — the pause is still true — and gains an inset line in the **Reject family**: `#F8EFED` fill, 1px `#DCC4BF`, radius 5px, 11.5px `#A33A2E`, carrying the **real reason**. The status-bar line turns `#A33A2E`.

The heading changes, because after a Reload the earlier text really is gone and the old heading would be a lie:

> **The version from disk is here, but it isn't saved**
> What you see now is the file as it was on disk. Emend couldn't finish saving it back, so this document is still unsaved.
> **Couldn't save the reloaded file.** *&lt;reason&gt;* Nothing was lost — the text on screen is the disk version.

**Action set (ruled by CJ, 2026-08-28): `Try again` (highlighted primary) · `Save As…` · `Compare`.**

- **`Try again`** — a failed write is retryable, and it is the only action that resolves the state.
- **`Keep mine` is omitted.** After a Reload the buffer already holds the disk version, so the label is ambiguous at best and a no-op at worst. It must not appear in this state.
- **`Save As…`** — the safe escape for a buffer that is now the only unsaved copy of anything, consistent with its role in every other integrity moment.
- **`Compare`** — both sides still exist, so reading them is still available.

Recorded closed in `open-conflicts.md`.

## Distinct from Missing-on-disk

Both moments share the bar and the amber — `../ux-design.md` requires one vocabulary — and are told apart by **copy and action set, never by colour alone**:

| | Changed on disk (FR-ED-7) | Missing on disk (FR-ED-2/7, #698) |
|---|---|---|
| Premise | A disk version exists and differs | No disk version exists |
| Actions | `Reload` · `Keep mine` · `Compare` | `Keep editing` · `Save As…` · `Close…` (+ conditional `Recreate`) |
| Second line | Writes paused; your edits are still here | `Autosave paused — file missing` |
| Persistence | Resolved by choosing; no tab status | `[Keep editing]` leaves a persistent `Missing on disk` tab status |

Neither can be mistaken for the other by what it offers. **Save As… remains a safe path out of either.**

## Compare

`1n` frame 4 draws the destination at **wireframe fidelity only**: a read-only two-pane region — `Your version` | `On disk` — with a header naming the path and a `Close` that returns to the bar with the choice still open. **Compare decides nothing.** No three-way merge editor (`../ux-design.md`'s explicit call).

**Its hi-fi appearance is a recorded gap** (`state.md`, "Known gaps"): pane typography, gutter, scroll sync, and whether differing regions are marked at all are undrawn. The shipping `ExternalChangeCompare.tsx` renders plain `<pre>` panes; nothing here overrides it yet.
