# Agent conversations — Workshop list, per-document Timelines, handoff

Mocks: turn 16 — `16a`–`16g` (surfaces), `16j` (migrated-history handoff), `16k` (900px and dark, platform fonts), `16l` (document identity: relink, missing and discarded documents, lifecycle — proposed), `16h` (open decisions), `16i` (review findings). Requirements source: `docs/agent-conversation-model.md` at `refs/pull/2692/head` (draft for #2690).

> **Status (30): applies CJ’s rulings 4–6 (2026-10-15) over (29). Proposed, not implementable.** PR #2692 is a draft. D4, D15, D30/FR-CHAT-4, TD-5 and J2 stay binding until CJ amends them. This file proposes appearance for the target model and records where the requirements leave behavior open. The proposed J2/J13 prose is in `../amendments/j2-j13-agent-conversations.md`. Nothing here amends `../../ux-design.md`.

Read `tokens.md`, `platform-variants.md`, `authoring-shell.md` and `timeline-rail.md` first. Turn 16 reuses their chrome unchanged; only the elements below are new.

## 1. Workshop entry (project rail)

- A fixed row **above `DOCUMENTS`**, label `Workshop`, ordinary 13px row type, padding 7px 9px. Not a section: no label token, no count, no divider.
- Active: the rail's existing active treatment (`#E4E9EF`, inset 2px `#4F46E5`, 500).
- Right edge: the strongest Workshop status, one only — Pause badge (16px `#B5871F` disc) › running `◔` (11px `#6B665C`). Never a number.
- **Collapsed rail is unchanged**: 44px strip, `››` only. Workshop is reached from the app menu (`16b`). The drawn placement, **View › Workshop** with no accelerator, is a **J# delta for CJ** (brief: keyboard routes and menu placement are not the drawing’s to decide).

## 2. Workshop surface (`16a`, `16b`)

- **With documents open:** the tab strip stays and **no tab is selected**. Workshop is not a tab. No editor toolbar, no document status bar, no right rail.
- **With no document open:** J2 Phase A unchanged — project-home strip, no tab strip.
- Title bar: `Workshop · <conversation name>`.
- **List column** 272px, `#F7F5EF` (Win) / `#F4F1EA` (mac), 1px `#E3DFD6` right border. Header: `WORKSHOP` label token + `New conversation` (secondary button). Find field 12.5px, placeholder `Find a conversation`. Rows by last activity.
- **Row:** name 13px (500 when selected), one muted line 11.5px `#8C8779`, time right. Selected = rail active treatment. Row status, right edge, one only:

| State | Marker | Second line |
|---|---|---|
| Needs permission | Pause badge 16px | `Needs permission to …`, `#8A6614` |
| Running | `◔` | `Running · …`, `#6B665C` |
| Queued | `Queued` 11px `#8C8779` | `Queued — waits for the current run` |
| Finished, unseen | 6px `#4F46E5` dot | `Finished · new reply` |
| Failed | — | `Run failed · open to see why`, `#A33A2E` |
| Migrated | `MIGRATED` qualifier before the name (10px/500 `.06em`) | `N turns · before <date>` |

- Find matches names and visible messages; matched term in 500 body ink. No match: `No conversations match "<q>". Find looks at names and visible messages.`
- **Naming (proposed, `16a.4`):** a new conversation is `New conversation` until its **first reply**, then titled from the first message (the row shows `New conversation` with `◔` while the first run works); renamed in place by activating the name (1px `#4F46E5` field with the 2px focus halo).
- **Conversation pane** `#F7F5EF`. Header: name 14px/500; history status right-aligned 11.5px `#8C8779` (§7). Cards as `10c`.
- **Composer footer — a new element (J13 delta).** The Workshop composer has no footer band today (`10c`); this one is new, not J13’s band reused. It leads with the destination: `Sends to <name> in Workshop — no document is active`, 11px `#4A463E`, then the model and send hint. No J13 standing line in Workshop (no document text is in play).

## 3. Timeline header (`16c`)

`TIMELINE` label · owning document basename 12px/500 `#33302A` (ellipsis, never wraps) · history status 11px `#8C8779` right-aligned · `››`. Untitled documents show the tab's disambiguated label.

Proposed per-conversation memory (findings F4–F6): facet, scroll position and unsent composer text are kept per conversation; the Address all filter keeps M4 (reset on document switch). Timeline collapse stays per window (UXR-Q13.2).

## 4. Background runs and permissions (`16d`)

- **Elsewhere row** — directly under the facet bar, `#F0EDE6`, 12px, padding 8px 14px; one row per item, max two, then `N more` / `Show all`. Order: needs permission › failed › finished › running. Present only while such an item exists in another conversation.
- Copy: `A run is working in <doc>` · `<name> in Workshop needs permission` · `Finished in <doc> · N changes` · `Run failed in <name>`. Action: `Show` (12px/500 link).
- `Show` switches to the origin (tab or Workshop); Timeline takes the rail if collapsed. A **permission** item then follows J7’s activation (focus on the request heading, `16d.2`). **Finished / failed** items follow J9’s `[Show the run]`: facet kept unless it hides the card, 12px clearance, focus on the card container. Nothing announced.
- **Nothing is answered remotely.** `Allow` / `Deny` / `[Stop]` exist only on the origin run card (CONV-3, J7).
- **Tab marker:** a pending permission adds a 12px Pause disc after the tab name. An unseen finished or failed run adds a **6px dot** (`#4F46E5`; failed `#A33A2E`; dark `#A5B0FF` / `#F87171`). Running never marks.
- **Timeline collapsed (F18, proposed):** the Elsewhere row is inside the Timeline, so other conversations surface outside it — the same 6px dot on the document’s rail row (Workshop: the rail entry), and on the collapsed rail strip’s `››` when any row carries one. Never on the Timeline chip, which stays J7’s (`16c.5`, `16c.6`, `16k.4`).
- **Pause badge on the Timeline host** is J7’s, already project-wide (shown while the project has any pending request). **Proposed J7 delta (F7) is its activation:** it first switches to the request’s conversation (tab or Workshop), then applies J7 unchanged — Chat selected, card expanded, focus on the oldest request heading. Workshop has no Timeline host; there the conversation pane carries the Elsewhere row (`16k.2`).
- A message sent while another conversation's run is active queues **in its own conversation** with `Queued — waits for the run in <doc>`, a second line `Goes to <doc> with the open tabs and selection as they were at Send` (11.5px `#8C8779`; FR-AGENT-7: destination and origin as captured at Send), and `Cancel`; the composer warns before Send: `A run is in progress in <doc>. A message sent now waits for it.`
- Finished-unseen clears once the origin has been shown with the card in view; failed persists until viewed the same way (F8).

## 5. Summary handoff (`16e`)

- **Origin link card** heads a Workshop-created document's Timeline: mono `↙ FROM WORKSHOP` marker (10px/500 `#4F46E5`), `Created by a run in <name>. That conversation stays in Workshop.`, links `Show the run` · `Open <name>`.
- **Summary block** sits in the composer above the input, in the quote bar's slot (quote bar nearest the input when both exist). 1px `#D5D0C4`, r7, `#FCFBF8`, padding 9px 11px. Label `WORKSHOP SUMMARY` 10px/500 `.08em`; `from <name>` link; `· edited` when edited; `Edit` · `Remove` right. Body 12.5px/1.55, clamped to 3 lines, `Show all` / `Show less`. Footnote 11px `#8C8779`: `Goes with your next message. Nothing has been sent.` Not Source Serif, no left rule — it is not an excerpt.
- **States:** ready · show all · editing (textarea, `Done` / `Cancel`, `Your edit replaces the prepared text for this message only.`) · edited · removed (dashed one-line placeholder, `Add it back` until Send). **No not-ready, failed or re-offered state** (ruling 6): the agent supplies the summary in the call that creates the document, so it is present from the first frame or absent. Without one, nothing is preloaded and the origin link card is the only route back.
- **Record:** the receiving turn's card carries J13's `↑ OUT` line — `carried the Workshop summary from <name>` (+ `· edited`) — and `Show what was sent` discloses the exact text and source. A queued turn reads `will carry …` and is never rewritten.
- **Composer-less routes — settled (CJ, 2026-10-15):** no preview step. They run as today; the run card reads `Workshop summary not included — it waits for your next message` (`16e.15`). Former option A (`16e.14`) is removed.

## 5a. Hand off a summary from migrated history (`16j`, proposed — F13, F21)

- **Picker:** dialog 560px, opened from the migration notice’s `Hand off a summary…`. Title `Hand off from Previous project conversation`; sub `To <doc>. Choose the exchanges the summary should cover.` Find field (`Find in earlier chat`), focus there on open. Rows are **whole exchanges** (your message + the reply), grouped by day, checkbox left, none preselected; selected rows tint `#E8E7F9`. Find filters without dropping hidden selections (`Showing 2 of 5 exchanges. 1 selected exchange is hidden by Find.`). Shift-click selects a range.
- **Footer:** `Preparing sends the selected exchanges to Claude to write the summary. Nothing reaches <doc>’s conversation until you send.` Count left (`No exchanges selected` / `N exchanges selected`), `Cancel`, `Prepare summary` (primary; unavailable at zero). Escape / Cancel returns focus to the invoking button; Prepare moves it to the composer input.
- **Review:** the §5 summary block with label `SUMMARY OF EARLIER CHAT`, `from Previous project conversation · N exchanges`, actions `Change exchanges…` · `Edit` · `Remove`. Preparing / failed / sent-early states are §5’s.
- **Record (exact):** `↑ OUT` line `carried a summary of N exchanges from Previous project conversation` (+ ` · edited`). Disclosure: `SENT WITH THIS TURN` + the text exactly as sent · `You edited it before sending.` when true · `MADE FROM N EXCHANGES IN PREVIOUS PROJECT CONVERSATION` + one line per exchange (date, time, first line of your message, linking to it in Workshop). The exchanges are referenced, not copied.
- F10 and F15 are now drawn as proposals in `16l` (§7a).

## 6. Cross-document run links (`16f`)

- Origin change-set card: `14 changes here · 4 in another document`, plus an `ALSO` row per affected document with `Open`.
- Affected document: one **link card** per run, `#FCFBF8`, 1px `#E3DFD6`, r7; mono `↗ LINKED RUN`; `N changes here from a run in <origin>.`; `Show the run` · `Review changes`. Files under **Changes** and **All**. No progress, permission or Stop.
- Missing origin: adds `That document is missing on disk. Its conversation is still available.`
- Tracked-change popover names the run: `From a run in <origin>` + `Show the run`.

## 7. History status and migration (`16g`)

- **Status slot**, Timeline header and Workshop conversation header, plain words only (Principle 4 — no commit, push, pull, branch or path), **three words**: `Saved on this computer` · `Shared with the project` · `Newer turns arrived` (body ink). 11px `#8C8779`. Combining cannot fail (ruling 4), so there is no fourth. An unreadable history shows **no status word**; its error card is the signal. **Final (brief, 2026-10-15):** the storage ruling answers detection, so the words no longer wait on the Architect.
- **Popover** (one per state, same pattern), e.g. `Saved on this computer` / `This conversation is saved with the project on this computer. Another computer gets these turns only when this project’s history is shared from here.` / `Emend doesn’t share it for you. Reviewers never see it.` How an author shares project history at all is F20, for CJ.
- **Reseed pending:** composer note `Newer turns arrived from another computer. Your next message starts a fresh session here from the updated history.`
- **Divergence marker (`16g.14`, `16g.15`, ruling 4):** where two computers continued a conversation from the same turn, Emend combines both computers’ turns in one time order and puts one quiet marker where they diverged. It uses the seam divider (`16g.6`): 18px `#D5D0C4` rule, `Continued on another computer` 11.5px `#6B665C`, flex rule. The same element appears in the Timeline and in a Workshop conversation. Nothing to choose, Send is never held, and the conversation never splits. The next Send uses the existing reseed note (`16g.5`).
- **After reseed:** one divider at the seam: `New session on this computer, started from N earlier turns and the accepted summary. M older turns were left out. Earlier tool actions were not repeated.`
- **Errors** (Reject-family card, `#DCC4BF` border, title `#A33A2E`; dark `#F87171`). Send is held in each; the draft stays.
  - **Too long for a new session:** `Can’t continue this conversation here` / `Its history is too long to start a new session on this computer. Nothing was sent; your message is still in the box.` / `Continue from a summary…` · `Choose turns to carry…` · `Details`. The summary route fills the composer’s summary slot (`CONTINUING FROM A SUMMARY`, `from this conversation · N earlier turns`, `Edit` · `Cancel`, footnote `Your next message starts a new session from this summary. The full history stays here.`); the seam then reads `…started from a summary of N earlier turns…` (`16g.11`). Choose turns reuses the `16j` picker aimed at this conversation.
  - **Unreadable:** `Can’t read this conversation’s saved history` / `Its saved history couldn’t be read on this computer. Nothing was deleted.` / `Try again` · `Details`.
  - **Provider reseed failed:** `Couldn’t start a new session` / `The history is intact. Your message wasn’t sent.` / `Try again`.
- **Migration notice** — once, at the head of the first-opened document’s Timeline feed, neutral card: `Earlier project chat is in Workshop` / `Your project-wide history is now Previous project conversation. It isn’t part of this document’s conversation, and nothing from it was sent.` / `Open in Workshop` · `Hand off a summary…` (§5a) · `✕`. Not the document-notice slot. Marker set on dismissal (proposed, F13).
- **Migration in the list:** converting · failed (`Couldn’t convert earlier history. The original files are untouched.` + `Try again` · `Details`) · done (`MIGRATED`). The migrated pane carries a standing note of what it is.

## 7a. Document identity (`16l`, proposed — CONV-7, F10, F14, F15; every item a J# delta)

- **Relink notice** (`16l.1`): heads the Timeline of a document whose conversation can’t be matched; neutral card. `No earlier conversation found for this document` / `If you moved or renamed it while Emend was closed, you can connect it to its earlier conversation. Nothing is sent.` / `Connect earlier conversation…` (primary) · `Start fresh`. The feed is otherwise empty, never falsely continued.
- **Relink picker** (`16l.2`): `Connect <doc> to an earlier conversation`; Find; rows are conversations whose document is missing only — basename, `Was in <folder> · last turn <date> · N turns`, `Connect`. Footnote: `Only conversations whose document can’t be found are listed. You can undo this from the Timeline’s first card.`
- **Discard (F10)** (`16l.3`): J12’s Discard dialog gains one line: `Its Timeline conversation (N turns) stays in Workshop under Not in the project.` Buttons unchanged.
- **Not in the project (F15)** (`16l.4`): a collapsible group at the foot of the Workshop list, `NOT IN THE PROJECT · N`, after a 1px `#E3DFD6` rule. Rows carry a neutral tag (`MISSING` / `DISCARDED`, the `MIGRATED` style); missing rows offer `Reconnect…` (opens the picker from the other side).
- **Lifecycle (F14)** (`16l.5`): row menu `Rename` · `Delete conversation…` (`#A33A2E`). Confirm: `Delete “<name>”?` / `Its history is removed from this project, and from other computers once it is shared. Documents its runs changed keep their changes.` / `Cancel` · `Delete` (filled `#A33A2E`). No archive or export. `Previous project conversation` has no Delete.
- **No locks.** Missing and discarded entries are never styled as private or walled; any run may read them (brief, CJ 2026-10-15).

## 8. 900px, dark and platform fonts (`16k`)

Representative frames: Workshop (Win light, mac dark), permission cue expanded and collapsed (Win light, Win dark), summary handoff (mac light, Win dark), history error (mac dark; the Windows light conflict frame `16k.7` was removed in (30)). At 900px the rail stays 236; Workshop’s list narrows to **240** so the conversation keeps 424; Timeline 372, or the comments column 400 when collapsed (UXR-Q23). Dark uses `tokens.md`’s dark set only. `16k` sets UI text in `'Segoe UI Variable Text', 'Segoe UI'` (Windows) and `-apple-system` / SF Pro (macOS); the rest of turn 16 uses IBM Plex Sans. **Checked in a macOS browser only:** the mac frames rendered in the system font; the Windows frames fell back to it, because Segoe is absent there. No text clips except the intended 3-line summary clamp. Segoe metrics are unmeasured.

**Composer access line (Decision 1, recommended):** `A run can read this project’s other saved conversations.` 11px `#6B665C` / `#9AA0A6`, last footer row. Drawn in `16k` only.

## 9. Not drawn

Archive and export (F14 draws Delete only); the in-flight run card itself (still #1391’s — every run card in turn 16 is illustrative context).
