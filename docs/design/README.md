# Emend design handoff

Design specs for `williacj/emend` (branch `main`). Intended location in the repo: `docs/design/`.

## How to use this folder

The `.dc.html` files in `mocks/` are **design references authored in HTML** — static prototypes of intended look and structure, not production code. Every value is an inline style so measurements can be read straight off the markup. There is no state and no event handling in them.

The task is to **recreate these designs in the Emend codebase's existing environment** (React + TypeScript; components under `src/editor/`, `src/timeline/`, `src/comments/`), reusing its established components and patterns. Do not port the HTML.

Read `specs/` for the implementable detail. Each spec file covers one surface and is written to be read on its own. Read `CHANGELOG.md` first if you have implemented from an earlier version of this folder — it tells you what changed so you can work the delta instead of re-reading everything.

Where the mocks and `docs/ux-design.md` disagree on **behavior**, `ux-design.md` wins. Where they disagree on **appearance**, the hi-fi mocks win. Where they disagree about the *same* thing, or a mock implies behavior `ux-design.md` does not record, **raise it with CJ** — neither document is amended by the reader (`CLAUDE.md`, "Reading `docs/design/`").

## Current status (32)

**Refresh (32) is current**, a specs-only follow-up to (31). The comment anchor in the document now tells Working, Addressed — pending and Selected apart by line pattern as well as colour. Working is neutral with a dotted line, Addressed — pending is amber with a 2px dashed line, and Selected swaps the fill to indigo while keeping the state's line. See `specs/comments.md` → *Anchor highlights in the text* and `CHANGELOG.md` (32).

## Status (31)

**Refresh (31).** The app is renamed **Cowrite → Emend** (CJ, 2026-11-08; williacj/emend#10 under #21) and its accent moves to the Emend site's indigo. Nothing else changes: layout, every other token, states and behavior are as in (30), and every gap in `specs/state.md` "Known gaps" stays open.

- **Name.** The mocks are now `mocks/Emend Authoring Shell.dc.html` and `mocks/Emend Wireframes.dc.html`. Every drawn window title and copy line that named the product reads Emend, swapped one-for-one. The app's own copy changes in williacj/emend#6, under `../ux-design.md`.
- **Icon.** New `icons/`: the macOS master (a) and the Windows/small-size glyph (b), drawn on `mocks/Emend App Icon.dc.html`. Every Windows title bar, light and dark, now draws (b) at 15px in place of the plain square.
- **Accent.** `#4F46E5` / `#4338CA` light, `#A5B0FF` dark with `#B7C0FF` for dark accent text; the rest of the family is derived in the same hue and recorded with contrast figures in `specs/tokens.md` → *Accent family*. One value moved for contrast: the macOS softened focus ring is now `rgba(79,70,229,.72)`.

See `CHANGELOG.md` (31).

## Status (30)

Refresh (30), applying CJ’s rulings 4–6 (2026-10-15). The summary is present from the first frame or absent, so not-ready, failed and re-offered are removed. “Changed on two computers” and Compare versions are removed, and the new divergence marker (`16g.14–15`) takes their place. Status words are down to three. The access line and Rename/Delete are held. See `CHANGELOG.md` (30).

## Status (29)

Refresh (29) applying CJ’s visual brief of 2026-10-15 to turn 16: the brief’s four status words, Decision 2 option A removed, the Workshop composer footer marked as a new element, `New conversation` naming, queued turns with captured destination, and new `16l` (relink, missing/discarded documents, Rename/Delete — all J# deltas). See `CHANGELOG.md` (29).

## Status (28)

Refresh (28) revising (27) after review: plain-language history status and real recovery routes (`16g`), migrated-history handoff (`16j`), 900px + dark representatives in platform fonts (`16k`), the corrected J7 delta (activation, not scope), and the collapsed-Timeline finished cue (`16c.5`). Decision 1’s recommendation is now separate memory with an honest access line. Twenty-one findings. Still proposed, not implementable. See `CHANGELOG.md` (28).

## Status (27)

**Refresh (27).** New turn **16** reviews **PR #2692** (`docs/agent-conversation-model.md`, draft for #2690) and proposes the appearance of per-document and Workshop agent conversations. **Proposed, not implementable:** D4, D15, D30/FR-CHAT-4, TD-5 and J2 stay binding until CJ amends them. Spec: `specs/agent-conversations.md`. Proposed prose: `amendments/j2-j13-agent-conversations.md`.

- `16a`/`16b` Workshop while documents stay open (rail expanded, Windows; rail collapsed + app menu, macOS). `16c` switching document Timelines (Timeline expanded and collapsed). `16d` background runs and permissions. `16e` summary handoff: preview, edit, remove, not ready, failed, sent record. `16f` cross-document run links. `16g` migrated history and history-status notices.
- **Three decisions open** (`16h`), each with a recommendation: (1) agent access to stored conversations — make them unreadable to runs; (2) summary timing/routes — offer when the origin run finishes, composer-less routes don't receive it; (3) portable content/design — appearance proposals drawn, fields and merge rule left to the Architect.
- **Seventeen findings** (`16i`), including two contradictions with ratified J2 (entry path, Phase B) and three J7/J13 deltas.

## Current status (26)

**Refresh (26).** New turn **15** draws the **Address all chooser** (J4 batch) as the intended target, with CJ's final J4 rulings applied. Spec: `specs/comments.md` → *Address all chooser*.

- **Hosts.** In the main app the chooser opens only from the **editor toolbar** (`15a`, 1280px, pinned mic in the right cluster) or its **900px `⋯` overflow** (`15b`), where it anchors to `⋯`. The Timeline-header host is **standalone-only** (`15c`, component states).
- **Rulings.**
  - The `0 already in an agent run` clause and the checkbox are omitted when nothing is held.
  - The filter is kept on reopen for the same document and reset on a document switch.
  - Opening focuses `Source`. Escape returns focus to the invoker; an outside click leaves it with the clicked target.
  - After admission, the **run card takes focus whether Timeline began collapsed or expanded**.
- **Coverage.** Windows and macOS, light and dark, wide and 900px.
- **Dispositions.** M1–M12 are in `15d`. **No conflict is open.**
- **Shipped** in #2680 / #2681, with run-card focus in #2678. J4 records the rulings (#2676).
- **Evidence.** Browser captures in `docs/alignment-address-chooser/` (#2679). Native Windows title controls and native font metrics are not validated.
- **`14g`.** CJ approved the three retryable mic descriptions; the implementation gap remains (`voice.md` §1a).

## Status (24)

**Refresh (24).** #2661: dark J12 freeze (`14f.3`, `14f.4`) draws the selected `Rich text` segment in its ordinary dark `#A5B0FF` / `#10131A` beneath the single 55% pane layer; mic without a second fade, no ghost, saving-status row at full contrast. #2613: new `14g` — retryable error mic hover, pressed and keyboard-focus cues (`↻`) on the editor, Timeline and comment composer, Win/mac, light/dark, distinguished from Settings-route errors; spec in `voice.md` §1a. Remaining gap: these cues and the retry descriptions are not shipped.

## Current status (23)

**Refresh (23) — aligned to shipped behavior.** `14a` redrawn per CJ's 900px ruling (#2641): the mic and the 44×26 Timeline return stay inline, and the Rich text / Markdown switch follows the format group into `⋯` (closed, pending and keyboard-open frames, Win + mac). The (22) compact-spacing proposal is withdrawn. `14b` redrawn from shipped Voice Settings (#2646): 30×18 switch (55% while recording), heading row, device error 5px below the picker, disconnected-device labels, progress and held bars, disabled `Cancelling…`, external file and verbatim failure sentences. **No design conflict is open.** Validation gaps: physical microphone behavior and native Windows title controls. `voice.md` §9 records the capture evidence and the validation gaps.

## Current status (22)

**Refresh (22) — voice surfaces, Voice Settings and the collapsed-host fit.** New turn **14** and `specs/voice.md`, compared against `docs/alignment-voice/` (light browser captures):
- `14a` (#2602) — the 44×26 compact Timeline return at 900px (rail 236, comments 400) with the 16px Pause badge; the stable full chip at 1000px; placement `mic · return · ⋯`; hover/pressed/focus; Win/mac, light/dark.
- `14b` (#2611) — Voice Settings: enable, device and the four device errors, download/progress/Cancel/`Cancelling…`/Cancelled/Resume, failure and retry, managed and external models, locks, narrow dialogs, focus; Win/mac, light/dark.
- `14c` (#2613) — comment-composer mic at the left of the action row, provisional text below the textarea; idle/recording/transcribing/error.
- `14d` (#2613) — Timeline provisional text below the input, `Send` level with the input; editor multiline ghost at the original caret or held range; 330px pinned mic with the `#DCC4BF` stroke.
- `14e` (#2635) — four device/permission errors open Settings at Voice; others keep their retry.
- `14f` — J12 finalization: the whole inert pane, mic included, at **55% through one layer**. `3c`’s 45% rule corrected (`3c.10` both platforms); `9d.1` now draws the mic.

*(Superseded by (23): the 900px fit is ruled; the compact density is withdrawn.)* **Dark** is drawn for the 14-series only; it is captured for every voice surface except the 900px toolbar and the J12 frozen pane, which are drawn in dark but have source-stamped light captures only. No known differences from Emend remain (`voice.md` §9); `14a` frames use the shell’s 38px / 44px title bars.

## Current status (21)

**Refresh (21)**, regenerated from (20) on `main` `630f65a63`. Two CJ rulings: (1) `9h.2` — the omission-only tab stays selected, shown by basename with a 6px amber loss marker before the label and no editable buffer, matching Emend’s capture (Win + mac); (2) `5d.5`/`5c.2` — `→ Go to passage` is the current label for every comment anchor route (`4e`, `5d.5`, `5c.2`, wireframe), pending any later decision. The status below is otherwise unchanged from (20).

**Refresh (20).** No design conflict is open. At export, two repo prose alignments remained: (A) J9 `✕` present while a request is in flight and (B) untitled documents take comments. The issue #2531 import applies both in `docs/ux-design.md` alongside this generated folder; `amendments/2026-10-01-pending-prose.md` records the source clauses and replacement directions. Until that import merges, the repo text wins on behavior. (20) also draws an untitled document **with** comments (`9g.7`/`9g.8`): comment group at ≥1, status-bar `N open comments` at ≥1 and absent at 0.

**Refresh (19) — review corrections.** Corrected: untitled documents keep `Comment` in the selection popover and read `No comments in this document` when empty (`9g`, `4c.1`, `4d`, `9h`); `4g.4`/`4g.10` composer lines use J13’s over-size wording and the clean cases drop the standing line; a narrow-toolbar floor (253 / 255px) with the format group moving as a unit (`9g.5`/`9g.6`); the D27 tab shows the former project path; J10 closure statements are qualified for undecided linked changes. Everything below this section is **history** — the record of earlier refreshes, superseded wherever (19) says otherwise.

## History

**Refresh (18) — rulings applied.** CJ ruled the three J9 conflicts and all nine (17) proposals on 2026-10-01; **no conflict is open**. Redrawn: `5a.4`/`5b.4` (undecided linked changes make header Resolve, `Mark as resolved` and Delete inert together, with a card-level reason and `Go to changes`; a live run alone never disables Resolve), `5d.6` (reason only), `3d` (the mic is pinned in the row), and `13a`/`13e`/`13f` (`✕` present in flight). `CHANGELOG.md` (18).

**Refresh (17) — five ruled briefs drawn; not self-reviewed, ready for independent design review.** J10 child-first Delete (`5d`; `5a`–`5c` corrected in place), the collapsed-Timeline states (`4c`–`4g`), the pathless selection popover (`9g`), the editor-toolbar mic with measured fit (`3c`, `3d`; mic added to `3a`/`3b`/`4a`/`4b`/`9a`/`9b`), and D27 legacy unsupported-tab recovery (`9h`). The dictation conflict is disposed; **nine appearance proposals await CJ’s signoff**, listed at the end of `specs/open-conflicts.md`. `CHANGELOG.md` (17) carries the delta.

**Refresh (16) — carried forward.** A bounded consistency correction over refresh (15), not a redesign: **clear-time focus recovery** is defined for the automatic clear of the run-blocked-close status (restore to the recorded stable authoring target with `preventScroll`; shell-level close-attempt target as fallback; no move when `[Show the run]` already took focus or focus sits elsewhere; `Dismiss` unchanged; the refused close still never completed automatically), the contents-table row for `specs/open-conflicts.md` is corrected to **four open conflicts**, and §8's facet cross-reference now points to **§11 item 3**. It carries refresh (15) forward, which was itself a bounded consistency correction over refresh (14): stale summary text is aligned with the detailed specs, the `[Show the run]` reveal boundary is made exact (`cardHeight + 12px <= timelineViewportHeight`), and the close refusal gets **one** terminal-clear rule covering every ordering. Every corrected (14) decision is unchanged — the fixed 46px one-line region, the genuine workshop rendering, the comments-to-timeline rail transition, the retry-pending focus rings on both platforms, the broadened truthful detail texts, `failureRoute`, conditional facet preservation with the `all` fallback, `13h.3`, and the in-flight `Dismiss` conflict as a proposal. Turn 12 and everything before it are untouched. `CHANGELOG.md` carries the delta; `specs/project-open-status.md` §11 enumerates every item still awaiting CJ's ratification.

**This folder is repo-binding.** It is the fifth constitution document (ratified by CJ 2026-08-04), binding on appearance exactly as `docs/functional-spec.md` is binding on requirements. Nothing here is edited in the repo — including this README — because every refresh overwrites it; changes go to CJ and come back through the design project.

## Contents

| Path | What it is |
|---|---|
| `specs/tokens.md` | Colors, type, spacing, radii, shadows, icon policy. Read first. |
| `specs/platform-variants.md` | Windows 11 vs macOS chrome rules — applies to every surface. |
| `specs/authoring-shell.md` | The three-column shell: window frame, **project rail (Documents / Skills)**, tab strip, **toolbar (incl. the pathless composition and the one-row overflow rule)**, **the document-notice slot**, document canvas, status bar. |
| `specs/comments.md` | Comments column and gutter icons — thread card, replies, edit, menu, resolved, hidden-threads chip, the comment-correction states (`5a`/`5b`/`5c`), and **(26) the Address all chooser (`15a`–`15d`)**. |
| `specs/timeline-rail.md` | Timeline rail: facet bar, feed cards, **agent message card + grounding indicator**, change-set card, composer. |
| `specs/document-integrity.md` | **"This file changed outside the editor" (FR-ED-7)** — the non-modal integrity banner: placement, hierarchy, buttons, focus, announcement copy, Reload progress and failure, the post-Reload dirty window, and how it stays distinct from Missing-on-disk. |
| `specs/wireframes.md` | Lo-fi wireframes `1a`–`1n` covering journeys J1–J8, settings, and the FR-ED-7 changed-on-disk storyboard. |
| `specs/adoption-provenance.md` | The durable, idempotent, exactly-once adoption-provenance workflow: the event, its D15 projection, ordering, outcomes and copy. |
| `specs/open-conflicts.md` | **(26) No conflict is open.** The four Address all rulings (CJ 2026-10-04) are recorded; J4 carries them (#2676). **(20)** Two export-time prose alignments carried by issue #2531 (J9 in-flight `✕`, untitled comments). Everything else is the disposal record: dictation, the three J9 conflicts and the nine (17) proposals (CJ 2026-10-01), the seven review findings (CJ 2026-08-28), #1817 and the #1641 failed-Reload action set. |
| `specs/recovered-document.md` | J2's **editable** untitled recovery document, its **toolbar** and its over-cap state (`9a`–`9f`). |
| `amendments/j2-recovery-document-over-cap.md` | Record of the revised J2 over-cap amendment, **ratified by CJ 2026-08-27** and applied to `../ux-design.md` by PR #1833. Supersedes the 2026-08-26 wording. Reference copy. |
| `specs/render-failure-fallback.md` | **The render-failure fallback (#2130 / J15)** — one terminal whole-window state: outer platform frame only, the four copy rows, focus and the single announcement, the one `[Reload window]` control and its pending / failed treatments, **native close (§5a)**, and the ruled absences. |
| `specs/project-open-status.md` | **Project-open progress and outcomes (#1752 / J9 / FR-X-11)**: the shared status region on welcome, authoring and workshop; the band **adopted, not replaced**; welcome placement, hierarchy and action order; control states, announcements and clipping. **§11: all eight J9 dispositions ratified into the repo on 2026-09-14; item 1 reversed by CJ 2026-10-01, with its repo prose pending at export and applied by issue #2531.** |
| `amendments/j9-project-open-status-prose.md` | History of the #1752 prose alignment. §1 and §6’s facet rule are in the repo; **§3 is superseded** by `2026-10-01-pending-prose.md` §A. |
| `amendments/2026-10-01-pending-prose.md` | **(20) Exact J9 replacements and site-by-site untitled-comment edits** for the two repo alignments pending at export and applied by issue #2531. |
| `specs/agent-conversations.md` | **(30) Proposed** — Workshop entry and list, per-document Timeline header, Elsewhere row, summary handoff, cross-document links, history status and migration notices (`16a`–`16i`). Not implementable until PR #2692's amendments land. |
| `amendments/j2-j13-agent-conversations.md` | **(30) Proposed J2 / J13 (and consequential J7) prose** for CJ, not applied. |
| `specs/voice.md` | **(22) Voice surfaces**, and **(24) `14g`** retryable-error hover, pressed and focus cues (§1a) — the shared mic chip (light + dark), collapsed-host fit at 900/1000px, Voice Settings, comment-composer and Timeline provisional text, editor multiline ghost, error routes, the 55% freeze, shipped copy and the parity list against `docs/alignment-voice/`. |
| `specs/state.md` | State variables and open questions. |
| `mocks/` | The `.dc.html` design files + `support.js` runtime. Open any `.dc.html` in a browser. **(31)** `Emend App Icon.dc.html` shows the icon masters at size. |
| `icons/` | **(31)** The Emend app icon: `emend-macos-1024.svg`/`.png` (a, macOS master, grid and mask drawn in), `emend-glyph.svg` + `emend-glyph-32.png` (b, unpadded), `emend-glyph-16.svg`/`.png` (b, pixel-snapped). The repo builds `src-tauri/icons/` from these. |
| `../ux-design.md` | Behavioral spec — journeys, states, open UXR questions. Authoritative on behavior. The repo copy at `docs/ux-design.md` is the **only** authoritative one; this folder must not carry a duplicate. |
| `screen-map.md` | Which repo files each wireframe was built from. |
| `CHANGELOG.md` | Dated log of what changed in each handoff refresh. |

## Fidelity

- `mocks/Emend Authoring Shell.dc.html` (options `3a`–`3d`, `4a`–`4g`, `5a`–`5d`, `6a`, `6b`, `6c`, `9a`–`9h`, `10a`–`10c`, `11a`–`11c`, `12a`–`12f`, `13a`–`13h`, `14a`–`14g`, `15a`–`15d`, `16a`–`16k`) — **high fidelity** (turn 16 is a proposal; its run cards are illustrative). Colors, type, spacing, radii and shadows are final; recreate pixel-accurately.
- `mocks/Emend Wireframes.dc.html` (options `1a`–`1n`) — **low fidelity.** Layout, hierarchy and flow only; style from the hi-fi specs. `1n` frame 4 is the **only** drawing of the FR-ED-7 Compare destination, and stays a recorded gap at hi-fi.

Each mock option carries a visible id badge (`3a`, `4b`, …). Use those ids when discussing screens.

## Project-open progress and outcomes (#1752 / J9 / FR-X-11)

Options `13a` (Windows welcome), `13b` (macOS welcome), `13c` (Windows authoring, close refused), `13d` (macOS workshop, failure), `13e` (all seven states + the surface matrix), `13f` (actions and control states), `13g` (clipping) and `13h` (`[Show the run]`), with `specs/project-open-status.md`, draw J9's project-open experience. Behavior is **ratified** — J9 + §2 *Project-open routing states*, CJ 2026-08-09, epic #759 — and is not redefined here.

**The band is adopted, not replaced.** The existing one-line non-modal status region hosts every state on all three surfaces: same region, same place, same rules, per §4. **No toast, no dialog, no new panel, no welcome-only vocabulary, no second band.** What this refresh adds is the piece §4 recorded as missing — **the welcome placement**: immediately below the platform title bar, above the welcome column, full window width, pushing the centred column down rather than overlaying it and never rendered inside it.

**No colour, no icon, no dot, no spinner, in any of the seven states.** §2 forbids encoding severity in this region, and nothing in project-open routing risks the author's text — the trailing `…` is the whole of the progress indication, and the failure's muted **reason run** — the tail of the same single line — is a rank, not a colour.

**Hierarchy and order are settled:** message · **one** contextual action · `Dismiss`, left to right, on both platforms. The name is the sentence's only variable and its only elastic run — 500-weight body ink, not italic (italic stays for paths). `· N more queued` is a second run of the same line, never a badge. No highlighted default and nothing destructive-styled: the accent highlight in this system marks the choice that protects the author's work, and no outcome here endangers it.

**(14) The band holds ONE line, in every state — 46px, always.** §4 and **UXR-Q15** constrain this shared region to one line-height with **clipping, not wrapping**, and §2's *Unattributed internal failure* says so outright: *"the band's height is never what gives way."* Refresh (13)'s two-line failure and its sub-560px wrap are **withdrawn**. The failure's reason is the **tail of the same message run** in `#6B665C`, and the clipping order is fixed: **the reason gives way first** and may vanish entirely, **then the name** to a 160px floor, **then the fixed words last**; the actions never give way, and the full text of name and reason stays in the DOM for selection and assistive technology. Whether the failure may *ever* take a second line is recorded as a question for CJ rather than assumed.

**(14) All three claimed surfaces are actually drawn.** `13d` is redrawn as a real **workshop** surface per **J2 Phase A** — no document open, conversation centre-stage, project-home strip, project rail with no active row, and no tab strip, editor toolbar, document status bar or right rail. Refresh (13) labelled it workshop and drew a document workspace.

**Present or absent, never disabled.** **(18)** `✕` is **present while a request is in flight** (ruled by CJ 2026-10-01): dismissing hides the band and it returns with the outcome. **Retry-pending is the one inert-but-present control**: `Trying…` keeps its place, its focus and its ring.

**One polite atomic live region** per surface, announcing both lines together; identity governs repetition, the queue suffix included; `aria-busy` covers a pending retry; **the band never takes focus on appearance**, in any state.

**Three states are unreachable on the welcome surface** — `Already open here`, `Opened in a new window` and `Close blocked by a run` — because that window holds no project (D26); `Adopted here` clears the band, since the project on screen is the outcome. Reviewer mode has no project-open entry point, so none of the seven reaches it and J6's persistence rules are untouched.

**(14) The failure line's leading sentence comes from a route discriminator, not from the reason code.** A new required design-state input is proposed — `failureRoute: "undetermined" | "raise" | "launch"`, carried on TD-20's existing failed-outcome stream — because `deadline_expired` and `registry_unavailable` each arrive on more than one route, so a reason-derived sentence would sometimes name an attempt Emend never made. The renderer reads `failureRoute` alone; there is no per-reason default. The **Architect confirms this needs no new TD decision**; the wording it selects is CJ's.

**(14) The seven detail texts are rewritten to be true for every condition their code covers** — `project_unavailable` covers every canonicalization failure, `open_failed` covers provider-session loading and watcher and MCP startup as well as reading the folder, and `registry_unavailable` can arrive during activation or adoption setup. The alternative — **narrowing the backend reason taxonomy** so each condition can carry a specific sentence — is recorded explicitly as CJ's other route.

**(14) `[Show the run]`'s contract is completed, and its facet selection reconciled.** The timeline **takes the rail back from the comments column** (§4 *Right-rail occupancy*: collapsing the stream is what reveals the column, so the rail changes occupant rather than disappearing — refresh (13) drew it absent) through the rail's **one existing** `Timeline ‹‹ / ››` control; **no second collapse mechanism is proposed**; **(17)** UXR-Q13.1, the no-comments branch, is now ruled and drawn in `4c`. The run card is revealed **whole with 12px top clearance when it fits the timeline viewport, and top-aligned with the same clearance when it is taller** — §4's own ratified #1324 submit-scroll rule, reused. **Focus lands on the card container, never `[Stop]`.** The facet is **not touched when it already contains the card**, and changes only when the active facet would hide it — then to `all`, because §4 puts agent addressing runs under **Comments** and composer-started runs under **Chat**, so no narrow facet is right for every run kind. **No new facet is proposed.** Activation is idempotent, and the document scroll and caret are untouched.

**(15) One rule says when the refusal clears, in every ordering:** `Dismiss` is the **only manual clear** while the refusal is true; **completion of the blocking run clears it automatically**, whether completion comes before or after `[Show the run]` is activated; **activation never clears it by itself**; a race between the two still reveals the same now-completed card; and **the refused close is never completed automatically** — the author initiates close again. **(16) Clear-time focus recovery completes the automatic clear:** focus owned by a control inside the disappearing band is restored to the **stable authoring target recorded when the close was refused**, with **`preventScroll`** so nothing scrolls; a disconnected or unfocusable target falls back to the **shell-level close-attempt target**; focus is **not moved** if `[Show the run]` already placed it on the run-card container or if it already sits on any other stable target outside the band; `Dismiss` keeps its ordinary explicit-dismiss behavior; and recovery never completes the refused close. **(15) The reveal boundary is exact:** the *fits* branch applies **only when `cardHeight + 12px <= timelineViewportHeight`**, so a card that would fit alone but not with its clearance takes the tall-card branch.

**All eight J9 §11 items were ratified into `docs/ux-design.md` on 2026-09-14.** CJ reversed the in-flight `✕` ruling on 2026-10-01; that one repo prose change was pending at export and is applied by issue #2531; see `amendments/2026-10-01-pending-prose.md` §A. The seven detail strings, close-refusal behavior, one-line failure and retained reason taxonomy are already binding in the repo.

## Render-failure fallback (#2130 / J15 / UXR-Q23)

Options `12a` (Windows hero), `12b` (macOS hero), `12c`/`12d` (the six-state studies, wrapping two-up at 1368px), `12e` (mount transition and rationale) and `12f` (native close), with `specs/render-failure-fallback.md`, draw the one terminal whole-window state: only the outer platform frame survives, the body is `#EDEAE3` rather than the paper canvas, and `[Reload window]` is the sole control.

**Status.** §2 *Render-failure fallback states* and **J15** are **proposed at the DH-7 gate, not ratified** — this folder claims appearance authority only. Two questions raised by the independent review of PR #2301 are **recorded in J15**, not open: the **narrow Principle 3 / J7 exception** (live agent activity, permission controls and `[Stop]` unavailable until a successful reload) and **native close** (§5a / `12f`). Both `12f` refusal strings are **adopted in §2**, so every string in turn 12 is §2 verbatim.

## Project rail — Documents / Skills (#1720)

Options `6a` (Windows anatomy), `6b` (macOS) and `6c` (independent section states), plus the "Project rail" section of `specs/authoring-shell.md`, replace the superseded single `FILES` tree. They are drawn against ratified **D27 / FR-ED-9** and `../ux-design.md` §2 "Project rail states" + J2 as amended for #1720 (**ruled by CJ 2026-08-18, DH-7**). `1b`, `1c`, `2a`, `3a`, `3b`, `4a` and `4b` all carry the refreshed rail.

The one thing to carry into the code: **membership is presence.** A non-document has no row — there is no muted or disabled row treatment in this rail, and `.txt` is an ordinary actionable document row. Three appearance points were ruled by CJ on 2026-08-20 and are drawn as specified: the header carries the opened folder's name, Documents lists one alphabetical level with folders and documents interleaved, and a `WORKFLOWS` sub-label separates skill disclosures from workflow leaves. **The core rail appearance is settled** — anatomy, sections, row types, states, tokens and platform chrome are final and implementable as drawn. Two edge cases remain **known appearance gaps**, recorded in `specs/state.md` “Known gaps”: row overflow (no maximum line count or truncation for a long skill description) and long-tree scrolling (overflow behavior, and whether section labels stick). Neither blocks implementation of what is drawn; both are recorded as gaps, not as questions the mocks answer.

## The document-notice slot (2026-08-28)

**One slot, on every pane, for every document-level notice: immediately below the toolbar, above the standing-conditions strip.** The FR-ED-7 integrity banner, the untitled pane's amber loss notice, a Save As failure line and the adoption-provenance pending line all take it.

The phrase *"below the tab strip, above the buffer"* is **this folder's own wording**, from the previous refresh — **FR-ED-7 specifies no placement at all**. It describes **two** slots once a pane has a toolbar, and this resolves it to the lower one, for a reason that is about movement rather than hierarchy: a notice can mount, collapse, expand or gain a failure line, and above the toolbar each of those shifts the format controls under a caret mid-edit. **The toolbar never moves.**

The one thing to carry into the code: **nothing is ever inserted between the tab strip and the toolbar.** Binds in `specs/authoring-shell.md`; drawn in `9a`, `9c`.3 (the collapse/expand round trip) and `11a`/`11b`/`11c.1`.

## Untitled recovery document — over-cap state (PR #1833 / issue #1421)

Options `9a` (Windows), `9b` (macOS) and `9c` (states, Save As outcomes, close guard) with `specs/recovered-document.md` draw J2's **untitled recovery document** — the tab created when a correlated move takes the path an open, dirty document occupied — and specify the state where its buffer exceeded the **2 MiB per-tab session cap** and was not kept. Drawn against current `main` after **PR #1805** (`78ad0d196`).

**The pane has a toolbar (2026-08-28).** It previously had none, and it now carries the ordinary single-row editor toolbar in a **pathless composition**: mode switch and format group live, redline group at ≥1 change, **comment group at ≥1 comment (20)**, `Share ▾` **absent rather than disabled**. Consequences worth carrying into the code: the toolbar joins the **inert set** during finalization (`9d.1`) because every control on it mutates the buffer; and **adoption no longer adds a toolbar** — `Share ▾` arrives within the existing row, so `[Save As…]` must not be implemented as a remount (`9c.7`).

**The pane is editable.** Its lifecycle is J2's correlated-move clause plus the **#1379 untitled/scratch amendment, ratified by CJ 2026-08-21**: editable buffer, **autosave off by construction**, never dirty, no project path, and `[Save As…]` as the ratified route that adopts it into the project. It is implemented by `UntitledDocument`; `RecoveredDocument` is deleted. Close reaches the existing **three-action guard** — `[Save As…]` / `[Discard]` / `[Cancel]` — and this design introduces no competing modal.

The over-cap notice therefore carries four facts and nothing else: the earlier unsaved work **was not preserved**, it **exceeded the 2 MiB cap**, Emend **cannot restore it**, and this document **is not in the project yet**. Its last sentence — *"It doesn't bring back what wasn't kept"* — is load-bearing: editing and Save As must never read as recovery. The standing-conditions strip can no longer say `Read-only`; it reads `Editable · Untitled · Not in this project · Saved nowhere yet`, and it is never dismissible. **A successful Save As ends the state**: the adopted document is an ordinary project document, and the only trace of the omission is the quiet adoption timeline card, whose second sentence keeps adoption from reading as recovery.

**Quit stages its closes and commits them with one atomic session write.** #1805’s close seam (`src/stores/appLifecycle.ts`) flushes best-effort without awaiting it, so the no-guard-on-quit rule is conditional (`9c.8`): a run still active refuses the close first (FR-X-11) and nothing is composed; then the dirty project-document queue drains, but **no tab leaves memory while the attempt is pending** — a Save writes its file and keeps its tab mounted, a Discard is recorded, not applied. Emend composes the payload as if every staged close had happened, awaits the write, and closes only after an **authoritative per-tab losslessness proof**. **Every successful close routes through that proof** — a write success, a retry success, and the no-delta short-circuit all enter `awaiting-proof`, the last two via an **authoritative no-write proof**; only a confirmed-exact result commits removals and closes, and **no path closes while a live untitled buffer was omitted**: an omission clears the finalization lock and focuses the `live-over-cap` guard with the plan retained; an unusable proof is a typed failure that never closes.

On failure the plan is **retained, uncommitted** — every tab and buffer mounted — because `[Try again]` and `[Quit anyway]` both act on it. `[Stay open]`/`Esc`, a dirty-tab Cancel, or a failed project-document Save clear it without committing. **`[Quit anyway]` abandons the current session delta and closes**: it claims no durable commit, and its copy discloses that the previous saved session — including tabs or older buffers — may reopen. Reason copy is the actual normalized detail, then “No new session was committed.”, then one of three baseline clauses (valid / none / unverifiable). Two or more affected tabs are all listed — semantic `<ul>`, scrollable, never “and others.”

**Application-wide Quit is bounded coordination, not an atomic transaction.** A **non-mutating** active-run/eligibility preflight runs across all windows first; any refusal there stops the quit before any window makes a decision or a write. Windows are then processed **sequentially** through their existing per-window close state machines. A later Cancel, failure or refusal **stops the remaining windows but reverses nothing** — windows already closed stay closed, and completed project-document Saves stay saved. **No distributed rollback is claimed.** Coordinator ordering and ownership are the Architect’s.

**Two fields must persist durably** in the tab-session record — the over-cap outcome and whether the explanation is hidden — because neither is reconstructible from `recovered_from` + `unsaved_content` after a later serialization. The legacy pair is **migration-only**, and migration is bounded: only `recovered_from: Some(path)` + `unsaved_content: None` migrates. A record #1805 already normalized to `unsaved_content: Some("")` is indistinguishable from a genuinely empty buffer and is **not** migrated — a recorded limitation, disposed conservatively, because a missing warning is recoverable and a false one is not.

**All seven escalated conflicts are ratified.** CJ ratified the revised amendment 2026-08-27 and the seven dispositions from the `f24dc462ae77` review on **2026-08-28**; PR #1833 applies the authoritative wording to `../ux-design.md`. Behavior binds there; appearance binds here. **No unresolved conflict remains.** Two dependencies are owned elsewhere and must land with this work: the **persistence-receipt IPC** and the **one-logical-writer-per-session guarantee** — both the Architect's. `specs/open-conflicts.md` records what was escalated and how each was disposed; `8a`–`8c` (read-only) remain **withdrawn**.

**The over-cap lifecycle is two states, never one.** `live-over-cap-not-durable` (`9e.1`) — the bytes are present and editable, and only durability is at risk — and `restored-omitted-empty` (`9c.2`), after a relaunch that could not carry them. Live bytes are never cleared to reach the second, and require Save As / Discard / Cancel before close. Where both are true (`9e.2`) the facts are composed but visibly separate. Close has **five** guard variants; the empty ones use current-state wording ("empty now"), and an intentionally `preserved-empty` document gets no omission copy but is still guarded.

## Document integrity — "This file changed outside the editor" (issue #1641)

Options `11a` (Windows), `11b` (macOS) and `11c` (five states) with `specs/document-integrity.md` draw **FR-ED-7**'s changed-on-disk moment, and wireframe `1n` storyboards the whole flow. Behavior is already binding in `../functional-spec.md` FR-ED-7 and `../ux-design.md` "Document integrity & lifecycle moments" (**CJ architecture amendment #1599, 2026-08-16**) and is **not redefined here**: the write pause, Save performing no write, Reload's atomic restore and honest dirtiness, Keep mine as the sole authorization of the next local-content write, and Save As remaining separate.

**One vocabulary, amber.** A non-modal bar below the tab strip and above the buffer — never a dialog over the text — in the same `#FBF3E1` / `#E0C98C` / `#8A6614` treatment the 9-series over-cap notice uses, because it means the same class of thing: *your work is at stake and Emend has stopped writing*. Two lines only — the ratified sentence, then the consequence (writes paused; your unsaved edits are still here) — with `Reload` · `Keep mine` · `Compare` right-aligned in one row.

**`Keep mine` is the highlighted default only while unsaved edits exist**; with a clean buffer all three actions are equal weight, because nothing of the author's can be lost and the design must not push a choice. Nothing is styled destructive; Reject-family styling is reserved for failure.

**The banner never takes focus** — an author mid-sentence keeps their caret. The one exception is a **blocked Save**, which **rewrites both lines** and moves focus to `Keep mine`:

> **Not saved — this file changed outside the editor**
> Emend didn't write over it. Choose Reload, Keep mine, or Compare.

The lede lives in the heading rather than stacked beneath an identical one — the ratified sentence appears **once** per bar — and the announcement stays self-contained because the status region announces both lines together. Every user-facing string on this surface is plain language; no internal vocabulary appears in any of them.

**Reload's two honest states are drawn.** In progress: `aria-busy`, actions dimmed but not removed, a quiet `Reloading…`, and nothing announced on entry. After the swap but before the recovery write lands, the document is genuinely unsaved and says so with the **ordinary tab dot** plus `Reloaded from disk · not saved yet` — **no new badge**, because a state that is simply "dirty" must not dilute the dot. On failure the bar stays amber and gains a Reject-family line with the real reason, and the heading becomes the honest one: *"The version from disk is here, but it isn't saved."*

**Distinct from Missing-on-disk by copy and actions, never by colour.** Changed-on-disk has a disk version to reckon with; Missing-on-disk has none, and offers `Keep editing` / `Save As…` / `Close…` plus a persistent tab status. **Missing-on-disk itself is still undrawn** and must not be derived from these options.

**The failure action set is ruled.** `Try again` (primary) · `Save As…` · `Compare` (CJ, 2026-08-28). `Keep mine` is **omitted** — after a Reload the buffer already holds the disk version, so the label is ambiguous or a no-op — and `Save As…` is **included** as the safe escape for what is then the only unsaved copy.

**One recorded gap, and one implementation delta.** Compare is drawn at wireframe fidelity only (`1n` frame 4); its hi-fi typography, gutter, scroll sync and any diff marking are a **known gap**. And this is **not a restyle**: `ExternalChangeBanner.tsx` today renders one banner with three fixed actions and has **no reloading, write-pending or reload-failed presentation state**, so `11c.3`–`11c.5` need a bounded component follow-up — a phase input, the `aria-busy` treatment, the failure line, a per-phase action set, and the status-bar readouts.

## Comment correction (J10 / UXR-Q9)

Options `5a`/`5b`/`5c` and the "Correcting your own comment" section of `specs/comments.md` bind on appearance exactly as the rest of this folder does, against ratified requirements **D24** and **FR-CMT-8..13** (CJ 2026-08-05).

**UXR-Q9 — the appearance question — is resolved**, by CJ on 2026-08-09 (`145c655c`), through these very options. Implement the appearance from here.

Their behavior is **J10 — "Correct your own comment (revise or withdraw)"** (epic #1125, PR #1312), **ratified by CJ on 2026-08-09** (`145c655c`). Both halves are settled: `../ux-design.md` J10 is authoritative on behavior, this folder on appearance.

**J9 and UXR-Q8 belong to project-open routing (#759)**, not to these states — see `specs/project-open-status.md` and `13a`–`13h`.

## Refresh (17) — five ruled briefs

- **J10 child-first Delete** (`5d`, `specs/comments.md`). A live descendant keeps `Delete comment` present but inert with `Delete replies first.` — no link, no confirmation, no owner moderation. The cascade confirmation and “replies will remain” are gone; a placeholder with a live reply is now only the late-offline-reply convergence state.
- **Collapsed Timeline** (`4c`–`4g`). The 400px column keeps its width; refresh (17) used `Comments are available after Save As` for untitled documents, **superseded by refresh (20)**, which uses `No comments in this document` after a successful empty load for either document kind; collapse persists per window; the composer, provider switcher and mic live only in expanded Timeline; a comment-card run gets `Show the run` plus `Unsaved text sent with this run` only when text was sent; a run started elsewhere expands Timeline, keeps a facet that shows it or else selects `All`, and focuses its owning card. Permission attention stays a badge.
- **Pathless selection** (`9g`). **(19)/(20)** `Comment` · `Quote to chat` before Save As (only `Ask agent` waits); the ordinary set after. An untitled document with comments: `9g.7`/`9g.8`.
- **Editor mic** (`3c`, `3d`). Fixed 28×26 chip, state carried by fill, glyph and accessible name; measured overflow keeps one row.
- **D27 recovery** (`9h`). Former path in the italic label and title bar, a neutral explanatory notice, no active rail row — distinct from the clean refusal and the omission-only session.

## Refreshing this folder

These specs are regenerated from the design project, not hand-edited. Every refresh writes the same paths, so `git diff` shows exactly what moved. Do not edit `specs/` by hand — implementation notes belong in the code or in a separate file, or they will be overwritten.
