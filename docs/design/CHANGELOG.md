# Handoff changelog

Newest first. Each entry lists what changed in the specs since the previous refresh, so an implementer can work the delta.

## 2026-11-10 (34) — Three corrections to the (33) comment-anchor spec

An independent review checked (33) against the shipped code (`src/editor/commentHighlights.ts`, `src/styles.css`). Specs only. No state's meaning changes; no J# delta.

1. **Suggestion's wavy underline is specified.** The app draws `text-decoration: underline wavy` in the line colour, offset 2px, beside the 1px solid border; (32) and (33) left it out. It is now in both tables, in both themes and when selected. It is what separates Suggestion from Open by pattern, so (33)'s "known gap" bullet is replaced by a note that the gap is closed (dark Open and Suggestion fills are 1.00:1, so this matters most there). (33) item 3 carries a correction note.
2. **Resolved and Dismissed get an anchor row and their own pattern.** No fill, 1px **dashed**: `#8C8779` light (3.46:1), `#6B7075` dark (3.30:1, new). The app drew Resolved 1px dotted, the pattern (32) gave Working. Selected: the indigo fill with the dashed line darkened to `#6B665C` / `#9AA0A6` (4.41:1 / 5.37:1). Dismissed shares the anchor, following §2's closed mechanics; its card appearance stays undrawn (UXR-Q12).
3. **Dark selected icon `+` is `#B7C0FF`** (accent ink, 8.09:1 on `#23284D`), not `#A5B0FF`. Only the border is `#A5B0FF`. `comments.md` corrected.
4. **`state.md`** records the comment anchors as a dark-mode carve-out, specified but not drawn, with the three colours this folder added for them.

Until (34) is in the repo, #41 keeps the app's current wavy underline, Resolved look and `#B7C0FF` glyph.

## 2026-11-10 (33) — Comment-anchor follow-ups to (32)

(32) is in the repo (williacj/emend#42). CJ answered both of its open questions yes on 2026-11-10. Specs only: `comments.md`, `tokens.md`, this file and the README.

1. **Selected + Reopened and Selected + Suggestion.** Same rule as (32): the indigo selected fill (`#E1E0F8` / `#23284D`), and each keeps its own line in its own colour, not the accent. Reopened: 3px double `#CF5B22` / `#F87171`, 3.14:1 / 5.12:1 on the fill. Suggestion: 1px solid `#1A7F37` / `#86EFAC`, 3.92:1 / 10.1:1. Body text 10.2:1 / 11.5:1. Rows added to both tables. The "is open" sentence is removed.
2. **The fourth carrier is binding.** `../ux-design.md` §2 now lists the anchor as the fourth non-animated way of telling Working from Addressed — pending (williacj/emend#40, merged in #43). It binds only where the thread has a live anchor, and selection must never hide which of the two it is. `comments.md` points to §2 in place of (32)'s "No J# delta … optional" bullet. **(32) item 6 is superseded** by this; it stays as written, as history.
3. **Dark Suggestion gets its own treatment.** The app drew it as `#26282C` with 1px solid `#9AA0A6` *(corrected in (34): and a wavy underline in the same grey, which this item left out)*, the same fill and colour as (32)'s dark Working. It is now `#14532D` with 1px solid `#86EFAC` (green-900/green-300, built like the dark warning pair). Body 7.37:1, line 6.49:1, fill 1.62:1 from dark Working. Light Suggestion is unchanged.
4. **Dark Reopened confirmed** as the app draws it: `#3A3D42` with 3px double `#F87171`, body 8.82:1, line 3.94:1.
5. **Dark selected gutter icon.** It shares the selected anchor's fill token, so (32)'s move to `#23284D` recolours it. Intended; one line added to the gutter-icon section. Light unchanged.
6. **`tokens.md` corrections** from the independent review: the Selected + Open line (1.92:1) is now listed, and the fill-separation figures are corrected to 1.06–1.17:1 in light and 1.04:1 in dark. The earlier 1.02 was the retired Working tint.
7. **Withdrawn:** `amendments/2026-11-10-anchor-carrier.md`, added to the design project before #40 landed §2 in the repo. It was never imported, and §2 now carries the ruling in its own words. Its README row is removed.
8. **Not changed:** the accent family and every state's meaning. No J# delta. The known gap stays recorded: unselected Open and Suggestion share a 1px solid pattern and differ by hue, outside §2's fourth carrier.

## 2026-11-10 (32) — Comment-anchor states: Working and Addressed — pending

Raised against the shipped app after (31) (williacj/emend#39): the Working anchor tint (`#E6E0FF`) sat 1.02:1 from the new Selected tint, the two shared their dark fill and accent line, and Addressed — pending drew exactly Working's anchor. Specs only; no mock draws these anchors.

1. **Rule.** The anchor's fill shows selection and its line shows thread state, by pattern and weight. Selection redraws the same pattern in the accent. `comments.md` → *Anchor highlights in the text*; `tokens.md` → *Comment-anchor states*.
2. **Working → neutral.** `#F0EDE6` with `1px dotted #6B665C` (dark `#26282C`, `1px dotted #9AA0A6`). It drops the violet, because a running agent is neither an accent action nor something the author owes.
3. **Addressed — pending → its own anchor.** Open's amber fill with `2px dashed #8A6614` (dark: `#78350F` with `2px dashed #FCD34D`, the app's warning pair, 6.29:1).
4. **Selected.** Light unchanged for Open (`#E1E0F8`, 1px solid `#A19CE9`). Selected Working and Selected Addressed — pending keep their pattern in `#4F46E5`. Dark Selected moves to `#23284D` with the pattern in `#A5B0FF`.
5. **Contrast.** Body text is 10.2:1 or better on every fill. Patterned lines are 4.76:1 or better against their fills.
6. **Not changed:** the accent family, Open, Reopened, Suggestion, and every state's meaning. No J# delta is raised. §2's three non-animated carriers are on the card, so this filled an appearance gap rather than resolving a conflict. Selected Reopened and Selected Suggestion are left open.
7. **Composition.** Selected applies alongside every state's style, not only to Open. Dark warning values confirmed from `src/styles.css` on 2026-11-10 and written into both specs in place of the earlier placeholders.

## 2026-11-08 (31) — Rename to Emend, app icon, indigo accent

CJ, 2026-11-08: the app is renamed **Cowrite → Emend** and moves to `williacj/emend`; the brand accent is the Emend site's indigo. Tracking: williacj/emend#10 under epic #21. Appearance only; behavior is unchanged. Entries below this one keep the Cowrite name and the old values as written, because they are history.

1. **Files renamed.** `mocks/Cowrite Authoring Shell.dc.html` → `mocks/Emend Authoring Shell.dc.html`; `mocks/Cowrite Wireframes.dc.html` → `mocks/Emend Wireframes.dc.html`. Every reference in the README, specs and amendments now uses the new names.
2. **Drawn name.** Every window title and copy line that names the product reads Emend, one-for-one: `Emend — <doc>` on Windows title bars, `Emend` alone in the render-failure fallback (`12a`–`12f`), and copy such as `over Emend’s size limit`, `Emend can’t close this window yet…` and `Emend couldn’t bring <name> to the front.` (typographic apostrophes kept). No other copy changed. README, specs and amendments name Emend; the README now reads "Design specs for `williacj/emend`".
3. **App icon (new `icons/`).** (a) `emend-macos-1024` is the 1024px macOS master with the grid drawn in (824px body, 100px padding), since `npx tauri icon` does not apply the mask. (b) `emend-glyph.svg` is the unpadded glyph for Windows and small sizes, with 32px and pixel-snapped 16px PNGs. The mark is two lines of text with an insertion caret, and (b) merges (a)'s two-word first line into one bar. Shown on the new page `mocks/Emend App Icon.dc.html`.
4. **15px title-bar mark.** The plain `#2F5D8C` / `#5B8DFF` square is replaced by (b) in all 55 Windows title bars, light and dark. The mark is the same in both themes. `platform-variants.md` and `render-failure-fallback.md` describe it.
5. **Accent family (`specs/tokens.md` → *Accent family*).** `#2F5D8C` → `#4F46E5`, `#22456A` → `#4338CA`, `#E4EBF4` → `#E1E0F8`, `#EAF0F6` → `#E8E7F9`, `#B9CBDD` → `#B3B0E6`, `#A9C0DC` → `#A19CE9`, `#CFDDEC` → `#CAC8F3`, `rgba(47,93,140,.18)` → `rgba(79,70,229,.18)`. Dark: `#5B8DFF` → `#A5B0FF` for fills, edges and rings, and **`#B7C0FF`** for text set in the accent (16 places in the mocks); `#26324A` → `#23284D`. Every frame that used one of these, on Windows and macOS, light and dark, now uses the new value, and spec prose follows.
6. **One contrast adjustment.** The macOS softened focus ring (`12a`–`12d`) moves from `rgba(47,93,140,.45)` to **`rgba(79,70,229,.72)`**. At `.45` it measured about 2:1, short of 3:1 for a focus indicator. That was also true of the old blue. All other accent text and rings meet AA; the figures are in `tokens.md`.
7. **Lo-fi wireframes.** Their stand-in blue moves to the same indigo (`#2A78D6` → `#4F46E5`, `#1B5AA6` → `#4338CA`, tints to match).
8. **Unchanged.** Comment amber, accept green, reject red, neutrals (including the `#E4E9EF` Windows active-file tint) and the dark surfaces keep their values. Layout, states and the `state.md` "Known gaps" are untouched.
9. **Expected mismatch.** Until the app's rename (williacj/emend#6) and token change land, the shipping code still says Cowrite and draws the old blue. This folder governs the target appearance.

## 2026-10-15 (30) — Agent conversations: CJ’s rulings 4–6

1. **Summary arrives with the document or not at all** (ruling 6). Removed `16e.7` (not ready), `16e.8` (failed), `16e.9` (re-offered) and `16e.12` (sent early), plus the `16e` NOT READY note. F12 is withdrawn. `16h` Decision 2 is fully ruled. In `agent-conversations.md` §5, and in §J2-3 and §J13-2, the not-ready, failed and sent-early copy is gone. `16j`’s on-request summary keeps its Preparing state.
2. **No two-computer conflict** (ruling 4). Removed `16g.9`, `16g.12`, `16g.13` and `16k.7`, the `16g.3` conflict row, and the §7 error. F19 now covers only the oversized history. `16h` Decision 3 withdraws “append-only is not conflict-free”. §J2-6 is rewritten.
3. **New `16g.14`, `16g.15`:** the divergence marker `Continued on another computer`, in a Timeline and in a Workshop conversation. It uses the seam divider and the existing reseed note; no new element.
4. **Three status words.** `Could not combine` is dropped, and detection is no longer tagged for the Architect (`16g.3` badges now read RULED).
5. **Held unchanged:** the access line (`16k`, Decision 1) and `16l` Rename/Delete, both still J# deltas.
6. `state.md`, `open-conflicts.md` and the README are updated.

## 2026-10-15 (29) — Agent conversations: CJ’s visual brief applied to turn 16

1. **Status words follow the brief** (`16g`, `16k`, `16c`): `Saved on this computer` · `Shared with the project` · `Newer turns arrived` · `Could not combine`. `Can’t read history` is no longer a slot word; an unreadable history shows only its error card. The Architect still confirms detection.
2. **Decision 2 routes settled** (CJ, 2026-10-15): `16e.14` (option A, preview first) is removed and `16e.15` is the route. When a summary is ready to offer is still open. `16h` is updated to match.
3. **Workshop composer footer** (`16a` notes): marked as a new element, not a reuse of J13’s band. Proposed §J13-5.
4. **Naming** (`16a.4`): `New conversation` until the first reply, then titled from the first message. The pending state is now drawn.
5. **Menu** (`16b.2–3`): View › Workshop is tagged as a J# delta. Keyboard routes are CJ’s.
6. **Queued turns** (`16c.4`): a second line gives the destination and context as captured at Send. Proposed §J13-6.
7. **New `16l`** (proposed, every frame a J# delta): relink notice and picker (CONV-7), the Discard line (F10), the *Not in the project* list group (F15), Rename/Delete and its confirmation (F14; no archive or export). Proposed §J2-4a.
8. Specs: `agent-conversations.md` §1, §2, §4, §5, §5a, §7, new §7a, §9; `state.md`; `open-conflicts.md` item 0. Windows Segoe metrics are still unmeasured.

## 2026-10-07 (28) — Agent conversations: review revisions to (27)

1. **`16g` plain-language history.** No user-facing commit, push, Git path or “Resolve it in Git” remains (Principle 4). Status words: `Not shared yet` · `Shared` · `Updated from another computer` · `Two versions to combine` · `Can’t read history`, each tagged for the Architect to confirm detection (`16g.3`), with a local-only fallback set. Popover rewritten (`16g.4`).
2. **Recovery routes (CONV-10, F19).** Too long for a new session → `Continue from a summary…` / `Choose turns to carry…` (`16g.7`, `16g.11`). Changed on two computers → `Compare versions…` → keep both in time order / either side, the other saved as its own conversation (`16g.9`, `16g.12`, `16g.13`). Send held, draft kept.
3. **New `16j`:** migrated-history handoff — exchange picker, Find with kept selections, disclosure before Prepare, review in the composer, exact `↑ OUT` record and its disclosure. F10 and F15 stay open and are tagged.
4. **New `16k`:** 900px and dark representatives for Workshop, the Elsewhere/permission cue, summary handoff and history errors, in platform font stacks. Rendered in a macOS browser: no clipping beyond the intended summary clamp. Segoe was not available, so Windows metrics are unverified.
5. **J7 conflict corrected.** J7 already makes the badge project-wide. The delta is activation crossing to another conversation (`16d.2` now focuses the request heading; `16d.3`, `16d` notes, F7, amendment J7).
6. **Collapsed-Timeline discovery (F18).** `16c.3` no longer says other activity is hidden; new `16c.5`/`16c.6` draw a 6px dot on the tab, rail row and collapsed strip. `16d.5` updated.
7. **Decisions (`16h`).** 1: separate memory + `A run can read this project’s other saved conversations.` until isolation is demonstrated. 2: after the creating run finishes; one-click actions leave it for the next composer turn. 3: merge design to the Architect; append-only is not conflict-free.
8. **Findings now 21** (F18–F21). Amendment adds §J2-6 (history status and recovery) and §J13-4 (preparing a summary).

## 2026-10-07 (27) — Agent conversations (PR #2692), proposed

1. **New turn 16, proposed.** Reviews `docs/agent-conversation-model.md` at `refs/pull/2692/head` as a requirements spec and draws the target model. Not implementable: D4, D15, D30/FR-CHAT-4, TD-5 and J2 remain binding until amended.
   - `16a` Workshop open with three tabs, none selected (Windows, rail expanded); list row states, Find, naming.
   - `16b` the same on macOS with the rail collapsed; app-menu candidates (Decision 3).
   - `16c` switching document Timelines; Timeline expanded and collapsed; queued-elsewhere message.
   - `16d` background runs and permissions: Elsewhere row, rail/list/tab markers, project-wide Pause badge, `Show` focus.
   - `16e` summary handoff: 13 states, plus Decision 2's two options side by side.
   - `16f` cross-document run links. `16g` migration notice, list states, history status, reseed and error notices.
   - `16h` the three open decisions with recommendations. `16i` seventeen findings.
2. **New files:** `specs/agent-conversations.md`, `amendments/j2-j13-agent-conversations.md`.
3. **Conflicts raised for CJ** (`open-conflicts.md` (27)): J2 entry path and Phase B contradict CONV-1/CONV-5; the Pause badge's scope (J7/UXR-Q13) changes under per-document conversations; J13 needs a Workshop clause and a linkable handoff line.
4. **Unchanged:** turns 3–15. Every run card in turn 16 is illustrative; the in-flight run card remains #1391's.

## 2026-10-04 (26) — Address all: toolbar hosts, CJ rulings, intended target

1. **Turn 15 redrawn on the real hosts.**
   - `15a`: the 1280px app with Timeline collapsed and the chooser opening from the editor toolbar, with the **pinned mic** in the right cluster. Windows light (8 frames), Windows dark (4), macOS light (3), macOS dark (3).
   - `15b`: the 900px app. The chooser opens from `⋯` and anchors to it. Windows light (5), Windows dark (3), macOS light and dark (2 each).
   - `15c`: the 372px Timeline-header frames are relabelled **standalone Timeline host, component states only**.
   - The (25) claim of a wide macOS dark frame is now true: `15a.16`–`15a.18`.
2. **CJ's rulings applied** in mocks and specs:
   - the `0 already in an agent run` clause and the checkbox are omitted when nothing is held;
   - the filter is kept through close and reopen on the same document and reset on a document switch;
   - both hosts focus `Source` on open, and close on Escape or an outside click. Escape returns focus to the invoker; an outside click leaves it with the clicked target (`15a.8`, `15b.5`);
   - in the main app Address all lives only in the editor toolbar or its 900px `⋯`; the Timeline-header version is standalone-only (`15c`).
3. **Focus after admission (CJ; UXR-Q16.4):** the admitted run's card takes focus whether Timeline began collapsed (it expands) or expanded (`15a.4`, `15b.4`). **M11 is closed.** J4 records it (#2676), and #2678 shipped it.
4. **Intended target settled** (`15d`, `comments.md`).
   - Resolved: M1, M5, M6, M7, M8, M9, and M12 (new: the chooser anchors to `⋯`).
   - Retained: M3.
   - Ruled: M2, M4, M10, M11. **No conflict is open.**
   - 4a/4b carry a superseded note. The `Open (6) ▾` toolbar chip does not ship.
5. **Housekeeping:** `state.md`'s stale *Current status (24)* is replaced by (26), including its 900px chooser summary, and `open-conflicts.md` by (26). `README.md` names (26) as current and lists `14g` and turn 15. The Address all references in `comments.md` and `timeline-rail.md` are now real links to `../../ux-design.md`.

6. **Regenerated against `main` @ `144ddb718`.** Every `15b` chooser now sits **4px below the visible `⋯` chip** with right edges aligned; it had measured 13–14px below. `15d`, `comments.md`, `README.md` and `open-conflicts.md` now record that #2680 / #2681 shipped the chooser and #2678 shipped run-card focus, and that J4 carries the rulings (#2676). The obsolete J4 prose request is removed. `voice.md` / `14g`: CJ approved the three retryable mic descriptions; the `14g` implementation gap remains.

**Evidence:** browser captures in `docs/alignment-address-chooser/` (#2679): 1280px and 900px, Windows and macOS platform styles, light and dark, four held-state frames, and `measurements.json`. **Not validated natively:** Windows title controls and font metrics.

## 2026-10-04 (25) — Address all chooser, as shipped (J4 batch)

1. **New turn 15** (`15a`–`15e`), drawn from `BatchAddressTrigger.tsx` / `styles.css` @ `efa23ecc`. It covers nine states: opened with no filter; the selected filter; available and already-in-a-run counts; `include them too` unchecked and checked; run focused; after submission; reopened with the filter kept and the checkbox reset; zero available; and a filter that matches nothing. Narrow layout is the Timeline rail with the inline panel. Wide layout is the editor toolbar with the floating panel. Shown on Windows and macOS, light and dark, with keyboard focus on each control. New section in `specs/comments.md`, and a pointer from `timeline-rail.md`.
2. **Nothing redesigned.** Ten mismatches with the implemented UI are listed in `15e` and `comments.md`. **For CJ (behaviour, J# deltas):** M2 the `0 already in an agent run` clause; M4 filter persistence across reopen; M10 no Escape on the inline panel and no focus into the dialog. **Appearance (this layer, awaiting direction):** M1 missing em dash; M3 filter order; M5 native controls; M6 no app focus ring; M7 the inline panel grows the Timeline header; M8 the Windows toolbar trigger has no border (an undefined custom property); M9 `4a`/`4b` chip drift.

**Gap:** no capture of the shipped chooser was available. Native control and focus-ring rendering is approximated from WebView2 / WKWebView defaults.

## 2026-10-04 (24) — dark freeze segment (#2661), retryable error mic cues (#2613)

1. **`14f.3` / `14f.4` (#2661).** Selected `Rich text` now uses the ordinary dark `#5B8DFF` fill and `#10131A` label (was `#E6E7EA` / `#1E1F22`), drawn before the single 55% pane layer. Mic keeps its idle treatment with no second fade; no dictation ghost; `Saving your session…` at full contrast. Note added to `14f` and `voice.md` §7.
2. **`14g` (#2613).** Retryable error mic chips — rest, hover, pressed, keyboard focus — at 2× and in context on the editor toolbar, Timeline input and comment composer; Windows and macOS, light and dark. 28×26 geometry and retry behaviour unchanged. Retryable errors add a `↻` cue on hover/press/focus; Settings-route errors do not. Exact colours, strokes and accessible names/descriptions in `voice.md` §1a; tokens, platform variants, state, screen map, README updated.

**Remaining gap:** Cowrite has no hover/pressed rule or `↻` cue for error chips and no description on retryable errors; no capture covers them. Retry descriptions approved by CJ (noted at (26)).

## 2026-10-03 (23) — aligned to shipped behavior: 900px toolbar and Voice Settings

Base: refresh (22). Existing features only; nothing new is designed.

1. **`14a` redrawn (#2602 / #2641).** CJ's 900px ruling: mic (28×26) and Timeline return (44×26) stay in the row; the **Rich text / Markdown switch follows the format group into `⋯`**, switch first. Frames: closed idle, closed pending, keyboard-open pending (Win + mac light), keyboard-open pending (Win + mac dark); the return state strip; 1000px with the switch inline. Menu: 4px below `⋯`, right-aligned, min 180, padding 6, row gap 5. **The (22) compact-spacing proposal is withdrawn**; ordinary spacing kept. Fit figures are IBM Plex Sans, the bundled toolbar font on both platform styles.
2. **`14b` redrawn (#2611 / #2646)** from shipped states: 30×18 On/Off switch, whole control at 55% while recording; Voice + `Refresh voice status` heading row; device error 5px below the picker with `⊘`; `Unavailable: <saved device name>` / `Unavailable selected microphone`; model progress and held bars; disabled `Cancelling…`; external file note, path and `Stop using this file`; `Stop using this model` for an unverifiable origin; accent-filled primary actions; failure sentences verbatim.
3. **Specs:** `voice.md` §2, §3, §8 (now shipped copy), §9 (matched items removed; validation gaps kept); `authoring-shell.md` (segmented-switch exception); `state.md` (`modelOrigin`, `selectedDeviceName`; no conflict open); `open-conflicts.md` (compact-spacing proposal replaced by the ruling); `screen-map.md`; README.

4. **Pre-import corrections (same refresh).** `14a` frames redrawn with the binding shell title bars — **38px Windows / 44px macOS** (was 32 / 28), matching `e2e/acceptance.spec.mjs`; frame heights grown to keep the body; `platform-variants.md` row corrected. Parity reconciled: Timeline `Send` level with the input, the ink-primary `Comment` and the dark mic chip are shipped and captured (`docs/alignment-voice/`, `alignment-voice-dark/`), as are the editor ghost (`alignment-editor-ghost/`) and composer errors (`alignment-voice-composer-errors/`); blanket "dark unevidenced" / "not yet captured" statements replaced by per-surface evidence in `voice.md`, `state.md`, `tokens.md` and the `14a`/`14c`/`14d` notes. Platform-font toolbar-fit estimates removed — the toolbar bundles IBM Plex Sans on both platform styles (`voice.md`, `state.md`, `authoring-shell.md`, `14a` table). `voice.md` heading → (23).

**Still different from Cowrite:** none known. **Evidence boundary:** the 900px toolbar and the J12 frozen pane are drawn in dark but have no source-stamped dark capture; both have light captures. **Validation gaps:** physical microphone behavior, live download and inference, native Windows title-control interaction.

## 2026-10-03 (22) — voice surfaces, Voice Settings, collapsed-host fit

Base: refresh (21). Comparison: `docs/alignment-voice/` (source-stamped light Win32/MacIntel browser captures). New turn **14** and `specs/voice.md`; everything else unchanged except the corrections listed.

1. **`14a` (#2602)** — compact Timeline return at 900px: stable 44×26, `››` + 16px nonnumeric Pause badge, right cluster `mic · return · ⋯` with `⋯` last. 1000px: full `Timeline ››` chip with its 16px badge space reserved, 100px idle and pending. Hover/pressed/focus; Win/mac, light/dark. **Compact density proposed** (padding 8, gaps 6/4, segment padding 5 at ≤300px) because the row is 41/42px over with the mic pinned — escalated in `open-conflicts.md`.
2. **`14b` (#2611)** — Voice Settings: switch, device select, four device errors, model states (download, progress, Cancel, `Cancelling…` held, Cancelled + Resume, failed + Retry, missing, corrupt, ready managed, ready external), recording lock, refused change, section failure; 720px and sub-560px dialogs; heading focus on open-at-Voice; Win/mac, light/dark.
3. **`14c` (#2613)** — comment-composer mic: left end of the action row at x = 12px, `Cancel`/`Comment` right-aligned to x = 328px, provisional slot below the textarea; idle, recording (short, wrapping), transcribing, two errors.
4. **`14d` (#2613)** — Timeline provisional below the input inside its column, `Send` level with the input; editor multiline ghost at the original caret and the held selected range; 330px pinned mic, `#DCC4BF` stroke retained.
5. **`14e` (#2635)** — error routes: no-device, no-default-device, selected-unavailable, permission-denied → Settings at Voice (heading focused; focus back to the mic on close); backend, model/download, transcription keep their retry. The `state.md` gap is closed.
6. **`14f` + corrections** — J12 finalization: the whole inert pane, toolbar and mic included, at **55% through one layer**, no extra mic fade (CJ 2026-10-02). `3c.10` (Win + mac) corrected from 45% groups + 45% mic + 60% buffer; `3c` notes and `authoring-shell.md` frozen row corrected; `9d.1` now draws the mic.
7. **Specs:** new `voice.md`; `authoring-shell.md`, `timeline-rail.md`, `comments.md`, `state.md` (voice state variables, gap closed, 14-series dark/responsive carve-out), `tokens.md` (14-series dark), `platform-variants.md`, `open-conflicts.md`, `screen-map.md`, README.

**Remaining differences from Cowrite** (`voice.md` §9): Timeline `Send` bottom-aligned to the partial; composer `Comment` not primary; no 900px compact density and no 900px-with-mic evidence; Settings uses a checkbox, muted device errors, no bar, removes Cancel while cancelling, prints the raw failure token, has no managed/external field; dark mic tokens keep light fills. Not evidenced: dark, multiline/held-range ghost, composer echoes, native title controls, physical voice.

## 2026-10-01 (21) — two CJ rulings, regenerated from refresh (20) on `main` (`630f65a63`)

Base: the reviewed refresh (20) package as merged on Cowrite `main` at `630f65a63`. Everything else from (20) is unchanged, including the applied J9 in-flight `✕`, untitled comments, the eight ratified J9 dispositions, and `9g.7`/`9g.8` with their comment group, open-comment count, gutter icons and anchored highlights. An earlier local (21) draft was built on a stale base and is discarded.

1. **`9h.2` omission-only legacy tab** — redrawn as Windows and macOS frames, aligned to `docs/alignment-after/win-9h-omission-refusal-1400.png`.
   - After refusal the tab **stays selected**. It shows the basename `survey-export.csv` with a **6px `#B5871F` amber loss marker before the label**; its accessible name carries *— earlier unsaved work was not preserved*.
   - There is **no editable recovered buffer**: no toolbar, strip, caret or `Save As…`, and the pane is empty.
   - Window title is `Cowrite — survey-export.csv`, and `notes.md` is the neighbouring tab.
   - The refusal band now names the former **project path** `research/survey-export.csv` in italic, as the capture does (it previously showed the basename).
   - **`9h.1` clean refusal still closes its tab.**
   - Updated: `recovered-document.md`, `open-conflicts.md` (D27 disposition) and the in-mock `9h` note.
2. **Withdrawn-placeholder anchor link** in `5d.5` and `5c.2` reads **`→ Go to passage`** (was `→ §2 ¶3`). The link still works, and the placeholder stays quiet and bodyless. `comments.md` notes that no surface currently computes or prints `§n ¶n`. The `4e.1`–`4e.8` live cards and the wireframe’s 1-series comment card now use the same label, so no `§n ¶n` text remains in any mock. `→ Go to passage` is the **current label for every anchor route, pending any later decision** (including a numbering rule).

**Review against captures:** `9h.2` (selected tab, dot before basename, empty pane, full path in the band) and the placeholder label in `5d.5`/`5c.2`.

## 2026-10-01 (20) — untitled comments and J9 dismiss reconciled

- **New `9g.7` (Win) / `9g.8` (mac):** an untitled document with two comments, Timeline collapsed. Comment group in the toolbar; the status bar reads `2 open comments` (present at ≥1, absent at 0); `Share ▾`, saved state and `Ask agent` still absent.
- **Specs reconciled:** `recovered-document.md` "does not have" row, `authoring-shell.md` pathless status bar, and `state.md` `toolbarComposition`, `projectOpenDismissible`, `projectOpenRetry` and `failureRoute`. README pathless descriptions and contents rows updated.
- **New `amendments/2026-10-01-pending-prose.md`:** exact J9 replacements in §A and site-by-site untitled-comment edits in §B for `docs/ux-design.md`.
- **Status corrected:** (19) said one prose alignment was pending and that J9 §3 was already in the repo. It is not, so **two** are pending. `j9-project-open-status-prose.md` §3 is marked superseded. The independent PM review also found and added the omitted §2 Selection popover row and broadened the two file-backed-only empty-comment sentences in the pending prose map. The independent designer review found and corrected an amber no-loss tab indicator and missing anchored-comment gutter icons in `9g.7`/`9g.8`; the former refresh-(17) untitled empty message is now explicitly marked superseded in the README history. A post-review consistency pass corrected the remaining pathless toolbar and count sentences in `recovered-document.md`, the Save As sentence in `authoring-shell.md`, the `screen-map.md` mapping, and the J9 status text across the current specs. The repo already ratified all eight earlier J9 dispositions on 2026-09-14; only the October 1 reversal still needs J9 prose alignment.

## 2026-10-01 (19) — review corrections

1. **Untitled comments kept.** Cowrite already anchors comments before Save As (`e2e/acceptance.spec.mjs`, ~1797); CJ keeps it. `9g` popover is now `Comment · Quote to chat` (only `Ask agent` absent); `4c.1`, `4d` and both `9h` frames read `No comments in this document`; pathless toolbar shows the comment group at ≥1 comment. **Pending prose alignment** for J12 / UXR-Q14.3 / Q14.4 recorded in `open-conflicts.md`.
2. **`4g.4` / `4g.10`**: the composer standing line uses J13's over-size wording (*goes by name only — over Cowrite's size limit; save it so the agent can read it*). `4g.5` / `4g.11` (clean) drop the standing line.
3. **Narrow toolbar** (`9g.5` Win, `9g.6` mac at 330px): after context controls, the **format group moves as one unit** into `⋯`; segmented control and mic stay. **Floor 253px Win / 255px mac.** `platform-variants.md`'s "the mic moves sooner" corrected.
4. **Status text**: README, `state.md` and `open-conflicts.md` open with one current-status summary; everything else is marked history. The J9 amendment notes the ruled items are in the repo.
5. **D27** tab label shows the former **project path** (`research/survey-export.csv`). **J10**: the statements that closure stays live with a child reply or a live run are qualified — undecided linked changes still block Resolve; the combined state is specified.

## 2026-10-01 (18) — CJ rulings applied; linked-changes closure refusal

**Rulings (CJ, 2026-10-01):** all three J9 conflicts and all nine (17) proposals. **No conflict remains open.** `../ux-design.md` is untouched; the J9 prose for the ruled items is ready to apply in the repo.

### Redrawn
- **`5a.4` / `5b.4` — undecided linked changes (D29, FR-CMT-21(a)).** Header `✓` muted `#C6BFAE`; menu `Mark as resolved` and `Delete comment` both inert `#A39E92`; the per-item reason is replaced by **one card-level line** with J10's copy (*2 linked changes still to decide. Accept them and this thread resolves; reject them and it reopens, and you can dismiss it then.*) and `Go to changes`. Fixes the stale "block Delete only" drawing. `5a.5` unchanged: a live run alone leaves `✓` and `Mark as resolved` live.
- **`5d.6`** — reason only, `Delete replies first.`.
- **`3d`** — regenerated with the mic pinned. Leave order `Timeline ››` → `Share ▾` → context controls right-most first. Compared with (16), pinning moves one extra control in three measured cases: `‹ 3 of 14 ›` in `9c.4`/`9c.7` on Windows, and `✕ Reject` at 572px on macOS. `3d.7` now shows the mic recording in the row with `⋯` holding only context controls.
- **`13a`, `13e` states 1/2/2′, `13f.3`/`13f.4`** — `✕` present while in flight and while a retry is pending. The 13a note is rewritten: dismissing hides the band, and it returns with the outcome.
- Annotations on `3c`, `4e`–`4g` and `9h` now read **ruled** instead of proposed.

### Specs
`comments.md` (linked-changes refusal, run rule, `5d.6`), `authoring-shell.md` (pinned mic, echo ruled), `timeline-rail.md`, `recovered-document.md`, `state.md`, `project-open-status.md` (§4 consequence, §11 items 1–4 ruled), `amendments/j9-project-open-status-prose.md` status, `open-conflicts.md` (dispositions), `README.md`.

## 2026-10-01 (17) — five ruled briefs: J10 child-first, collapsed Timeline, pathless selection, editor mic, D27 recovery

**Not self-reviewed — ready for independent design review.** `../ux-design.md` is untouched. Source briefs: `docs/j10-child-first-visual-refresh-brief.md`, `docs/uxr-q13-visual-refresh-brief.md`, `docs/uxr-q14-pathless-selection-visual-refresh-brief.md`, `docs/uxr-q14-editor-mic-visual-refresh-brief.md`, `docs/d27-legacy-unsupported-recovery-visual-refresh-brief.md` (all at `main`, read 2026-10-01).

### 1. J10 child-first Delete — `5a`–`5c` corrected, `5d` added
- `5a.2`/`5b.2`: “and replies will remain” removed; the muted live reply replaced by a withdrawn-reply provenance line; label now *published, or historically replied to by another actor*.
- `5a.1`/`5b.1`: relabelled clean-disappearance (never published, no historical reply by another actor). The private-root cascade confirmation is withdrawn.
- `5a.3`/`5b.3`/`5c.2`: relabelled the **late offline reply after an admitted withdrawal** convergence state. The ordinary parent-with-live-replies placeholder no longer exists.
- `5d`: inert `Delete comment` / `Delete reply` + `Delete replies first.` in the column (Win, mac), on a nested reply, in the 340px popover and on a resolved timeline card; the eligible published confirmation; the no-live-replies placeholder with anchor route; the commit-time refusal. No owner moderation anywhere. `5c.3` reuse rule now names three refusals. → `specs/comments.md`.

### 2. Collapsed Timeline — `4c`–`4g`
- `4c` (Win) / `4d` (mac): 400px column with `No comments in this document` / `Comments are available after Save As`; no-count header; tab-switch strip with `timelineCollapsed` unchanged.
- `4e`: comment-card `Show the run` link + conditional `Unsaved text sent with this run`, focus states, and the activated landing (run card container focused).
- `4f`: composer, provider switcher, composer mic and J13 standing line only in expanded Timeline.
- `4g`: `Address all…` and selection `Ask agent` starts; within-bound, over-bound, clean, queued and completed-collapsed owning cards; facet kept vs switched to `All`; Pause badge without expansion; full macOS transition.
- `authoring-shell.md` *Rail modes* gap closed; `timeline-rail.md` gains landing and direction rules; `project-open-status.md` no longer calls UXR-Q13.1 open.

### 3. Pathless selection — `9g`
`Quote to chat` alone before Save As (leading-item treatment, no disabled items); ordinary three-item popover after adoption, same selection. → `authoring-shell.md` *Selection popover*, `recovered-document.md`.

### 4. Editor mic — `3c`, `3d`; mic added to `3a`/`3b`/`4a`/`4b`/`9a`/`9b`
Fixed 28×26 chip first in the right cluster; nine states plus the J12 freeze and the Markdown projection on both platforms; ghost partial; status-bar echo. `3d` measures 8 cases × 2 platforms: the mic only changes the outcome where a row already overflowed, and then leaves after `Timeline ››`/`Share ▾`. `9c.9` (emoji comparison) marked superseded. Dictation conflict **disposed** in `open-conflicts.md`; state.md gaps rewritten.

### 5. D27 legacy unsupported-tab recovery — `9h`
Win + mac frames: italic former-path label, `Untitled — from <path>` title bar, neutral notice, no active rail row, collapsed rail’s Save As message. Comparison: clean refusal, omission-only refusal, retained text composed with a separate omission fact. → `recovered-document.md`.

### Flagged for CJ (appearance proposals, not conflicts)
Nine items, enumerated at the end of `specs/open-conflicts.md`: voice echo/error copy; relocated-mic treatment; overflow leave order and the composed context-group order; the commit-time J10 refusal sentence; focus after keyboard `Timeline ››`; focus target and user-card reading for auto-expanded runs; `↑ OUT`/`↓ IN` markers; Pause badge drawing; D27 copy and the status-band refusal for clean/omission-only tabs.

## 2026-09-14 (16) — #1752 / J9 consistency correction

**A bounded consistency correction over (15), not a redesign.** No option was redrawn, no token minted, no measurement or string changed, no decision reversed. Three corrections. **Not self-reviewed — ready for an independent design review.** `../ux-design.md` is untouched and all **eight** J9 dispositions remain proposed for CJ.

### 1. Clear-time focus recovery for the run-blocked-close status

(15) settled *when* the refusal clears and said nothing about *where focus goes* when run completion clears it automatically — which can remove the band from under `[Show the run]` or `✕` and drop focus to the document body. The rule, added as **item 6** of `project-open-status.md` §8 *How the refusal clears*:

- **Focus inside the disappearing band** is restored to the **stable authoring target recorded when the close attempt was refused**.
- **Restored with `preventScroll`**, so document, timeline and rail scroll positions do not move.
- **A disconnected or no-longer-focusable target** falls back to the established **shell-level close-attempt target** (`recovered-document.md`'s connected shell-chrome fallback).
- **If `[Show the run]` already moved focus to the run-card container**, focus is not moved again.
- **If focus already sits on any other stable target outside the band**, it is not moved.
- **`Dismiss` is unaffected** — ordinary explicit-dismiss focus behavior.
- **The refused close is still never completed automatically.**

Recorded consistently in `project-open-status.md` §8 and §5 (which no longer claims `[Show the run]` is the surface's only focus move), `state.md` (`projectOpenCloseRefusal`), the J9 prose amendment §6, `README.md`, `open-conflicts.md`, and the `13c` / `13h` mock annotations. It is J9 **behavior** and sits **inside** the existing gap at §11 item 5 — **no ninth disposition**, and the eight-item inventory is unchanged.

### 2. `README.md`'s contents row for `specs/open-conflicts.md`

It still said the file was about dictation and closed with "All resolved." Corrected to **four open conflicts** — dictation plus the three J9 project-open conflicts (the in-flight `✕` withdrawal, the two added leading sentences, any facet change inside `[Show the run]`) — with the stale claim removed. The file itself has said "four" since (15); only the table row was behind.

### 3. Facet cross-reference in `project-open-status.md` §8

The statement that any facet change inside `[Show the run]` is behavior for CJ pointed at **§11.5**, which is the status-persistence gap. It now points at **§11 item 3**, the facet conflict itself.

Everything else from (15) — and from (14) beneath it — is carried forward unchanged: the fixed 46px one-line band, the workshop rendering, the comments-to-timeline rail transition, the retry-pending focus rings, the broadened detail texts, `failureRoute`, conditional facet preservation with the `all` fallback, the exact `cardHeight + 12px <= timelineViewportHeight` boundary, and the one terminal-clear rule.

## 2026-09-14 (15) — #1752 / J9 consistency correction

**A bounded consistency correction over (14), not a redesign.** No option was redrawn, no token minted, no decision reversed. Three classes of change: stale summary text aligned with the detailed spec, one exact reveal boundary, and one terminal-clear rule. **Not self-reviewed — ready for another independent design review.** Historical entries below are unchanged.

### 1. Stale summary text aligned with `project-open-status.md`

Four live claims contradicted the spec they summarise, all introduced when (14) rewrote the detail and left the summaries behind:

- **`README.md`** — "the failure's muted **second line**" replaced: the reason is the **tail of the same single 46px line**, and there is no second line in any state.
- **`README.md` contents table** — "**two proposals for CJ**" replaced with the complete **eight-item inventory** (three conflicts, five gaps) and a pointer to `project-open-status.md` **§11**, which is the one place it is enumerated.
- **`README.md` contents table** — "**seven J# deltas**" replaced with what the amendment now actually contains: **ten sections** — the prose for all eight §11 items, two no-behavior-change clarifications (the surface matrix, the reviewer-mode exclusion), the **withdrawal** of (13)'s two-line/wrap proposal, and one note on §4's own wording.
- **`specs/state.md` preamble** — "**No unresolved conflict remains**" qualified: the `f24dc462ae77` disposal is complete, but the file later records **three open J9 conflicts**, and the preamble now says so and points at them.
- **`specs/open-conflicts.md` preamble** — "**One conflict is open: dictation**" replaced with **four**: dictation plus the three J9 conflicts. The two section-scoped "no unresolved conflict remains in this folder" claims under #1817 and #1641 are rescoped to the escalation each closes.

### 2. The `[Show the run]` reveal boundary is exact

(13) and (14) wrote "if the run card fits in the timeline's scroll viewport", which leaves an impossible boundary: a card that fits **alone** but not **with the required 12px clearance** matched neither branch. The condition is now stated as a comparison:

- **Fits branch — only when `cardHeight + 12px <= timelineViewportHeight`.** The card is revealed **whole**, 12px clearance above it, never centred.
- **Otherwise — the tall-card branch**, including a card that would fit alone but not with its clearance: the card's **top** is aligned with the same 12px clearance, and **full visibility is not promised**.
- **There is no third case.** `13h.3`'s caption now names the condition rather than saying "taller than the viewport".

§4's ratified submit-scroll precedent (**#1324, CJ 2026-08-20**) is still what this reuses; only the boundary is made unambiguous.

### 3. One terminal-clear rule for the close refusal

§8.1 said only `Dismiss` clears the refusal; the closing paragraph said run completion clears it. Both were true of different moments and read as a contradiction. They are replaced by **one rule covering every ordering**, stated once in `project-open-status.md` §8 (*How the refusal clears*) and mirrored verbatim in `state.md` (new `projectOpenCloseRefusal` row), `open-conflicts.md`, the J9 prose amendment §6, `README.md` and the `13c` / `13h` mock annotations:

1. **`Dismiss` is the only manual clear** while the refusal is true.
2. **Completion of the blocking run clears the refusal automatically**, whether completion happens **before or after** `[Show the run]` is activated.
3. **Activating `[Show the run]` never clears it by itself** — activation is navigation, not dismissal.
4. **If activation and completion race**, the action still reveals the same now-completed run card, same place, same geometry, same focus target.
5. **The refused close is never completed automatically** — the author initiates close again.

The rule is J9 **behavior** and therefore sits inside the existing gap for `[Show the run]`'s status persistence (§11.5, reworded to name it); it is **not** a new conflict and adds nothing to the eight-item inventory.

### 4. Everything corrected in (14) is unchanged

The fixed **46px one-line** status region and its clipping order; the genuine **workshop** rendering of `13d`; the **comments-column → timeline** right-rail transition with UXR-Q13.1 left open; the **retry-pending focus rings** on Windows and macOS; the **broadened truthful** failure details and the narrower-taxonomy alternative; **`failureRoute`** and its `undetermined`/`raise`/`launch` mapping; **conditional facet preservation with the `all` fallback**; the tall-card study **`13h.3`** (wording only); the **in-flight `Dismiss` conflict** as a proposal; and all **turn-12 / #2130** material.

### Files touched

Edited: `specs/project-open-status.md`, `specs/state.md`, `specs/open-conflicts.md`, `amendments/j9-project-open-status-prose.md`, `README.md`, `CHANGELOG.md`, `mocks/Cowrite Authoring Shell.dc.html` (+ the project-root source; **annotation text only — no drawn pixel changed**). Untouched: `specs/tokens.md`, `specs/platform-variants.md`, `screen-map.md`, and every other spec. No file added or removed. **Tile count 38** (30 + 8).

## 2026-09-13 (14) — #1752 / J9 revision after independent review of (13)

**Not a redesign, and not a new surface.** Every change is inside the turn-13 project-open work (`13a`–`13h`, `specs/project-open-status.md`). Turn 12 (#2130 / J15 / UXR-Q23) and everything before it are **byte-identical to (13)**. No token was minted. **This refresh is not self-reviewed — it is prepared for a new independent design review.**

### 1. The region holds ONE line, on every surface and in every state

Refresh (13)'s **two-line failure (~56px)** and its **sub-560px wrap** are **withdrawn**. `../ux-design.md` §4 and **UXR-Q15** constrain this shared region to one line-height with **clipping, not wrapping**, and §2's *Unattributed internal failure* states the discipline outright: *"One line, and the band's height is never what gives way."* The failure's reason is now the **tail of the same message run**, `#6B665C` at 12.5px after one space, so the band is **46px in all seven states** and the body beneath it never shifts when one state replaces another.

**The clipping priorities are stated explicitly** (`project-open-status.md` §9): **(1) the reason gives way first** and is the only run allowed to disappear completely — it is the tail, which is exactly why §2 places `<detail>` last; **(2) the project name clips next**, to a 160px floor; **(3) the fixed words of the leading sentence are last**. The actions never give way. The full text of name and reason stays in the DOM for selection and assistive technology. **The band now claims no responsive carve-out at all** — the 9-series is again the only one.

**If two lines are genuinely necessary, that is a proposed J9 / §4 delta for CJ** (§11.7), recorded rather than assumed: this folder may not grant itself an exception to a ratified constraint on a shared region.

### 2. `13h`'s right-rail transition is corrected — a hidden timeline does not empty the rail

§4's **Right-rail occupancy** (UXR-Q7.1, ratified 2026-08-05) gives the rail **two occupants that are never simultaneous**: collapsing the timeline is precisely **what reveals the comments column**. Refresh (13) drew the collapsed rail as **absent**. `13h.1` now draws the **comments column** in the 372px rail — which matters especially here, because the blocking run is *addressing comments*, so the threads it is working through are the very thing on screen. Activating `[Show the run]` **replaces the occupant** with the timeline, through the rail's **one existing control**, the ratified `Timeline ‹‹ / ››` toggle. **No second collapse mechanism is proposed or implied** — production has no general whole-timeline-collapse owner to borrow, and a status-region action must not invent one. **UXR-Q13's no-comments branch (Q13.1) is NOT settled**: `13h.1` draws the has-comments case and claims nothing about the other.

### 3. `13d` is now an actual workshop state

It was labelled *workshop* and drew an open document, tabs, an editor toolbar and an ordinary document workspace. Redrawn to **J2 Phase A** and §4: **no document open**, conversation centre-stage, the **project-home strip** (recent documents · active reviews) above it, the project rail present with **no active row**, and **no tab strip, no editor toolbar, no document status bar and no right rail**. Composition follows `10c` and `6b`; neither is restyled. Every surface the package claims — welcome, authoring, workshop — is now actually represented.

### 4. Retry-pending keeps the focus ring, and it is drawn

Refresh (13) said the inert-but-present `Trying…` control "keeps focus and keeps its ring" and drew no ring. The **2px `#2F5D8C` ring at `outline-offset:1px`** is now drawn in **both** platform examples — `13f.1`/`13f.2` for the chip, `13f.3` (Windows) / `13f.4` (macOS) for it inside the band. An inert control that silently lost its ring is a keyboard user's focus disappearing, which is the opposite of the reason it stays present.

### 5. Every failure detail is now true for every condition its code covers

Refresh (13)'s strings overclaimed. `project_unavailable` covers **every** canonicalization failure, not only a folder that disappeared; `open_failed` covers **provider-session loading, watcher startup and MCP-server startup** as well as reading the folder; `registry_unavailable` can occur **after route resolution and during activation or adoption setup**, not only while determining which windows are open. The seven texts are rewritten broad enough to be true throughout (`project-open-status.md` §7b), under one rule: **every displayed statement must be true for every condition its reason code represents.** The alternative — **requiring a narrower backend reason taxonomy** so each condition can carry a specific sentence — is recorded as CJ's explicit other route (§11.8). All of it remains **proposed**.

### 6. A route discriminator makes the leading sentence honest

`deadline_expired` can expire **before route selection, during adoption, during raise, or during launch**, and the failed outcome carries only `root` and `reason` — so the renderer had no truthful basis for choosing between the launch, raise and undetermined wording. A required design-state input is proposed:

```
failureRoute: "undetermined" | "raise" | "launch"
```

carried on **TD-20's existing failed-outcome stream**. `launch` → J9's ratified sentence; `raise` → `Cowrite couldn’t bring <name> to the front.`; `undetermined` → `Cowrite couldn’t open <name>.` The renderer reads **`failureRoute` alone** and never infers the route from `reason`; there is **no per-reason default**, and until the field exists the honest presentation is `undetermined` for every failure. **The Architect has confirmed this is a narrow refinement of an existing contract and does not require a new TD decision**; the **wording** it selects is a J9 delta for CJ. Recorded in `state.md`.

### 7. `[Show the run]`'s edge contract is complete, and its facet selection reconciled

- **Fits the timeline viewport** → revealed **whole**, 12px top clearance, never centred. **Taller than the viewport** → its **top** aligned with the same clearance, and **full visibility is not promised** (`13h.3` draws it). That is §4's own ratified submit-scroll rule (**#1324, CJ 2026-08-20**) reused, not a second motion contract.
- **Focus lands on the run card container, never `[Stop]`.**
- **Facet:** the facet is **not touched when it already contains the active run card**, and changes only when the active facet would hide it — then to `all`. §4 rules that **a filter the user deliberately set survives the author's own Send**, and a status-region action has less claim on it than that; the permission-attention behavior selects **Chat** because it concerns one known card kind, which this cannot, since §4 puts **agent addressing runs under Comments** and composer-started runs under **Chat** while a close refusal can be raised by any run kind. `all` is the only one of `timelineFacet`'s five ratified values guaranteed to contain the card. **No new facet is proposed.** **Whether any facet change belongs to this action at all stays behavior, proposed for CJ.**
- **Idempotence, the untouched document scroll and caret, and the rule that the refused close is never completed automatically** are unchanged and restated.

### 8. Dismissibility remains a question for CJ, not an authority

Omitting `✕` while a request is in flight **contradicts** §4's flat dismissibility rule rather than filling a gap. It stays drawn and stays **proposed**, in those words, in `project-open-status.md` §4 / §11.1, `state.md`, `open-conflicts.md` and the prose alignment.

### 9. What passed review and is unchanged

Welcome placement immediately below the platform title bar; the surface reachability matrix and the adopted-here absence; the reviewer-mode exclusion; one neutral non-modal region with no spinner, severity colour, toast, extra panel or duplicate Stop action; contextual-action-before-`Dismiss` ordering; the polite atomic live region; no focus movement merely because status appears; and all turn-12 / #2130 material.

### 10. Every proposal is enumerated in one place

`specs/project-open-status.md` **§11** is now the single table of what needs CJ: **three conflicts** (in-flight `✕`; the two added leading sentences; any facet change inside `[Show the run]`) and **five gaps** (`failureRoute`; `[Show the run]`'s status persistence; the seven detail texts; a second line for the failure; narrowing the reason taxonomy). `amendments/j9-project-open-status-prose.md` carries the prose for each, applies none, and **withdraws** (13)'s two-line/wrap proposal. `docs/ux-design.md` is **not** amended by this project.

### A note on `github.md`

`github.md` is **design-project-only metadata** — it records which repository and commit this design project was built against, for the design project's own sync workflow. **It is not part of the handoff and is not exported into `docs/design/`.** Earlier entries list it under "files touched" for that reason only; nothing in the repo should expect it.

### Files touched

Edited: `mocks/Cowrite Authoring Shell.dc.html` (+ the project-root source), `specs/project-open-status.md` (substantially rewritten), `specs/state.md`, `specs/platform-variants.md`, `specs/tokens.md`, `specs/open-conflicts.md`, `amendments/j9-project-open-status-prose.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`. No file added, none removed. **Tile count 38** (30 + 8) — no option id was added or removed; `13f` and `13h` each gained an internal study (`13f.4`, `13h.3`).

## 2026-09-08 (13) — project-open progress and outcomes in the shared status region (#1752 / J9 / FR-X-11)

**New surface, and the one artifact §4 recorded as missing.** `../ux-design.md` §4 says of this region: *"Its appearance on the welcome surface is undrawn (`1a` carries no status region and predates this decision), so that visual placement is a brief for CJ's design project rather than a repo edit to the generated pixel layer."* That brief is discharged here. Behavior is **ratified** — J9 + §2 *Project-open routing states*, CJ 2026-08-09, epic #759 — and is not redefined.

### 1. Eight new options

`13a` Windows welcome (request in flight, one queued) · `13b` macOS welcome (open in another window) · `13c` Windows authoring (close refused) · `13d` macOS workshop (failure with reason and retry) · `13e` all seven states drawn on the surface each can occur on, plus the surface matrix · `13f` actions and every control state on both platforms · `13g` long names and long details · `13h` `[Show the run]`, before and after. New spec: `specs/project-open-status.md`.

### 2. The band is ADOPTED, not replaced

The existing one-line non-modal status region hosts all seven states on welcome, authoring and workshop: **same region, same place, same rules.** No toast, no dialog, no new panel, no fifth region, no second band, and **no welcome-only vocabulary** — §4's own requirement. `#F7F5EF` fill, 9px 14px, and a **fixed 46px one-line height** (`min-height` + `box-sizing:border-box`) so that no state — with an action, with `✕` alone, or with neither — shrink-wraps to a different box and shifts the body under the user; ~56px in the two-line failure state, message 12.5px `#33302A`; Windows takes the border-bottom hairline, macOS the box-shadow hairline. **It is not the document-notice slot** — that slot is below the toolbar and belongs to one document; the rule that nothing is inserted between the tab strip and the toolbar is untouched, because the band is above both.

**Welcome placement, drawn for the first time:** immediately below the platform title bar, above the welcome column, **full window width**, as a flex sibling that pushes the column down rather than overlaying it — and never inside the 520px column, where a full-width line cannot be mistaken for a card and a card could.

### 3. What is settled

- **No colour, no icon, no dot, no spinner** in any state. §2 forbids encoding severity here; nothing in project-open routing risks the author's text. The trailing `…` is the whole progress indication.
- **Hierarchy:** message (`flex:1; min-width:0`) · **one** contextual action · `Dismiss`. Never two actions, and **never a `Stop the run` shortcut** beside the refusal — J9 rules there is no stop-and-close in v1.
- **Order:** `✕` is rightmost on both platforms and in every state, because it is the only constant.
- **The name is 500-weight body ink**, not italic and not quoted (the rail header's proper-name rule; italic stays for paths), and it is the sentence's only elastic run.
- **`· N more queued`** is a second run of the same line in `#6B665C` after a middot — never a badge, never a second line, never a list.
- **Failure is the one state allowed a second line** (outcome, then reason at 11.5px `#6B665C`); **three lines never**.
- **Buttons** are `document-integrity.md`'s ordinary in-bar control, with hover / pressed / focus drawn. **No highlighted default** — the accent highlight marks the choice that protects the author's work — and nothing is styled destructive.
- **Present or absent, never disabled**, with two consequences: `✕` is **absent while a request is in flight**, and **retry-pending is the one inert-but-present control** (`Trying…` keeps place, focus and ring; a second activation joins; the band takes `aria-busy`).
- **One polite atomic live region** per surface, announcing both lines together. Identity governs repetition, queue suffix included; dismissal and the `Adopted here` clear announce nothing; no `role="alert"` anywhere.
- **The band never takes focus on appearance**, in any state, including the refusal and the failure.
- **Clipping:** tail ellipsis on the **name only**, so the fixed clauses always survive; one permitted wrap below ~560px, two lines maximum; the actions never give way; no tooltip carrying the full name.

### 4. Two items PROPOSED for CJ's ratification — do not implement as binding

- **The seven failure detail texts** — `project_unavailable`, `open_failed`, `deadline_expired`, `registry_unavailable`, `launch_failed`, `owner_unavailable`, `activation_refused` — exact plain-language strings, each one sentence ≤ 52 characters, with **no lock / instance / registry / handle / timeout vocabulary**, no OS-naming variance, no instruction and no raw error text. Plus **two extra leading sentences** they force: J9's ratified sentence names the **launch** route, so a failed **raise** needs `Cowrite couldn’t bring <name> to the front.` and a pre-route failure needs `Cowrite couldn’t open <name>.`
- **`[Show the run]`'s exact behavior** — the status **stays** (the refusal is still true; only `✕` clears it); the timeline is revealed, expanding if collapsed, with its facet set to **`all`** unless already there — **no new facet is proposed**, since `timelineFacet`'s five ratified values stand and `all` is the only one guaranteed to contain an active run card — and nothing else changed; the run card scrolls fully into view with **12px clearance at the top of the timeline viewport**, never centred, and the document scroll and caret are untouched; **focus lands on the run card, not `[Stop]`**; nothing is announced. Activation is idempotent, and if the run ends first the band **clears** while the action still reveals the completed card — **Cowrite never completes the earlier close on its own**.

### 5. A finding, not a gap: three states are unreachable on welcome

A welcome window holds no project, so **Already open here**, **Opened in a new window** and **Close blocked by a run** cannot occur there under D26, and **Adopted here** clears the band because the project on screen is the outcome. Welcome hosts exactly three of the seven. Reviewer mode has **no project-open entry point**, so none of the seven reaches it and J6's persistence rules are untouched. Matrix in `13e` and `project-open-status.md` §2.

### 6. Prose alignment, kept separate

`amendments/j9-project-open-status-prose.md` records **seven J# deltas for CJ** and applies none: the two leading sentences, the seven detail texts, the in-flight dismissibility carve-out (§4 states flat dismissibility — **a conflict, not a gap**), the surface matrix, the reviewer-mode exclusion, `[Show the run]`'s behavioral half, and the discharge of §4's own "brief for CJ's design project" clause. `docs/ux-design.md` is **not** amended by this project. The three conflicts are also recorded in `specs/open-conflicts.md`, which is **no longer all-resolved**.

### 6b. The run card is illustrative, and says so

`13c` and `13h` show an `Agent · working` card because the refusal and its destination are unreadable without one, but **in-flight run presentation is a recorded gap** in this folder (`state.md`; it binds in `../ux-design.md` J2 / #1391). The card is labelled **illustrative context** inside both options — the same treatment the 12-series gives lifted platform chrome — and `project-open-status.md` §10 records the exclusion. What binds from `13h` is the **destination**: the card scrolled fully into view with 12px clearance, carrying the app's ordinary focus ring.

### 6c. The lifted shell is drawn to its own specs, and labelled

The frame around the band in `13c`/`13d`/`13h` follows `authoring-shell.md` and `timeline-rail.md` at reduced detail: **project rail 236px**, **right rail 372px**, the timeline's **`TIMELINE` header row** (label · `Address all… ▾` · `››`) and its **five** facet pills — `All · Chat · Comments · Changes · Findings`, padding 4px 10px, **radius 12px**, inactive white with 1px `#D5D0C4` (Win) / `#E3DFD6` (mac). The five pills matter here rather than elsewhere because §8's proposal argues from `timelineFacet`'s five ratified values, so the drawing of the destination has to show all five. And a **collapsed timeline is absent**, restored from the `Timeline ››` chip in the toolbar right cluster (`13h.1`) — not a 44px `‹‹` strip, which is the *project* rail's collapsed treatment. Those two specs stay authoritative for all of it; this refresh restyles nothing in them, and `project-open-status.md` §10 plus `state.md` record the exclusion.

### 7. Unchanged

Turn 12 (#2130 / J15 / UXR-Q23) is untouched — composition, tokens, measures, copy, focus and close behaviour are byte-identical to (12). No existing option was redrawn, no token was minted, and the band's sub-560px rule is recorded as the **second** carve-out from the no-responsive-behaviour-below-1400px rule (the 9-series is the first).

### Files touched

New: `specs/project-open-status.md`, `amendments/j9-project-open-status-prose.md`. Edited: `mocks/Cowrite Authoring Shell.dc.html` (+ the project-root source), `specs/state.md`, `specs/platform-variants.md`, `specs/tokens.md`, `specs/open-conflicts.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`, `github.md`.

**Tile count 38** (30 + 8).

## 2026-09-07 (12) — authority-label correction: the render-failure fallback is **J15 / UXR-Q23**, not J14

**Not a redesign, and not a status change.** Composition, artboards, states, tokens, measures, focus behaviour, close behaviour, copy and rendered appearance of `12a`–`12f` are **byte-identical to (11)**. Nothing was added, removed or renumbered. This refresh corrects one label.

### 1. Every live authority reference now reads J15

**J14 is the ratified formatting journey.** The render-failure fallback is governed by **J15**, with **UXR-Q23** as its open review question — **UXR-Q22 belongs to #2388** and never named this work. Every *live* reference that assigned this work to J14 has been relabelled — in `specs/render-failure-fallback.md` (heading, §2 binding note, §3 measure rationale, §4 focus/viewport exception, §5a native close, §6 prohibitions, §7 what-is-not-settled), `specs/state.md`, `specs/platform-variants.md`, `README.md`, `screen-map.md`, and the **visible mock annotations** in `mocks/Cowrite Authoring Shell.dc.html` (turn-12 section header and the `12a` / `12b` / `12e` / `12f` note bodies). The spec heading and the README section heading now name the pair: **(#2130 / J15 / UXR-Q23)**.

### 2. Platform-variants section heading covers `12f`

`specs/platform-variants.md`: *The render-failure fallback (`12a`–`12e`)* → **(`12a`–`12f`)**. The section's contents were already correct; only the range in the heading was stale.

### 3. Nothing else moved

- §2 *Render-failure fallback states* and the journey as a whole remain **proposed at the DH-7 gate, not ratified** — the repo's own status line, untouched.
- Both rulings remain **recorded** (now in J15): the narrow **Principle 3 / J7 exception** (live agent activity, permission controls and `[Stop]` unavailable until a successful reload) and **native close** (§5a / `12f`).
- The two `12f` refusal strings remain **adopted in §2**, verbatim.
- The author-project agent-activity sentence remains **conditional** everywhere.
- Preserved and re-verified unchanged: six-state studies wrapping two-up at **1368px**; the button **hugging its label** (`align-items: flex-start`); focus offsets **6px root / 3px button** on both platforms with only ring width and colour platform-specific; **one mutually exclusive status slot** (close refusal `#33302A`, reload failure `#A33A2E`).

### 4. History is left as history

Earlier entries in this file — (9), (10), (11) — keep their original **J14** wording. They record what those refreshes said at the time; rewriting them would falsify the record. Only live authority statements were corrected. `github.md` follows the same rule: its live sections and `## Screen map` read J15, its `## Sync history` is unedited.

### Files touched

`specs/render-failure-fallback.md` · `specs/state.md` · `specs/platform-variants.md` · `README.md` · `screen-map.md` · `CHANGELOG.md` · `mocks/Cowrite Authoring Shell.dc.html` (+ the project-root source of the same file) · `github.md`. No token, measure or artifact file changed otherwise.

**Tile count 30**, unchanged.

## 2026-09-06 (11) — status and provenance correction: both rulings recorded in J14, refusal strings adopted in §2

**Not a redesign.** Composition, artboards, states, tokens, measures, behaviour, copy and appearance of `12a`–`12f` are **byte-identical to (10)** except one label word in `12a` (item 4) and the status prose listed below. No state, artboard or artifact was added, removed or renumbered.

Read at **PR #2301 head `8d01b323fba0b2af60411bf126eedbd779ebe632`**, against the design review at `#issuecomment-5560107634`.

### 1. The Principle 3 / J7 exception is **recorded in J14**

Refresh (9) wrote it as *parked for CJ*; (10) as *accepted, awaiting recording*. It is now **recorded in J14** — not pending, proposed, contingent or out-of-tree. Live agent activity, permission controls and `[Stop]` remain **unavailable until a successful reload**. `render-failure-fallback.md` §6 and §7, `state.md`, and the `12e` note now say so.

### 2. Native-close behaviour is **recorded in J14**

§5a and `12f` are no longer described as a folder-side disposition awaiting a ruling. Unchanged in substance: with **no guard**, native close **closes the window and draws no additional surface**; where a guard **would normally hold**, close is **refused**, the fallback **stays mounted**, the **mode-safe reason occupies the single status slot**, `[Reload window]` **remains the sole action**, and **focus does not move**. `12f` still shows **author on Windows** and **reviewer on macOS**.

### 3. The two `12f` refusal strings are **adopted in §2**

Both strings are **preserved verbatim**:

- Author — `Cowrite can’t close this window yet. There’s unsaved work, and an agent run may still be active. Reload the window to get the ordinary controls back.`
- Reviewer — `Cowrite can’t close this review yet. A comment or suggestion may not have been sent. Reload the window to get the ordinary controls back.`

All "this folder's proposed wording", "need §2 adoption before they are authority" and "adopt or replace" language is removed from the mock note, the spec, `state.md` and `screen-map.md`. The `12f` note header changes from *COPY HERE IS PROPOSED, NOT §2's* to **COPY HERE IS §2's, ADOPTED**.

### 4. One label correction in `12a`

The *what is deliberately absent* note read "No `Dismiss`, close or discard" — which reads as a prohibition on closing at all, now that §5a governs the native close. It reads **"No `Dismiss`, in-surface close or discard"**. The same word is added to `state.md`'s echo of the list. §6's bullet already carried the correct wording and is unchanged.

### 5. Unchanged, and re-verified

- **The author-project agent-activity sentence stays conditional** everywhere it appears — the `12a`/`12b` artboard titles, the `12a` note, §3 of the spec (with `12c`.1 / `12d`.1 drawing the shorter body), and `state.md`'s `fallbackAgentActivity`.
- **Root focus offset 6px, button focus offset 3px, both platforms**; only ring width and colour are platform-specific (`2px #1F1D1A` Win / `3px rgba(47,93,140,.45)` mac).
- **The button hugs its label** — `align-items: flex-start`, never a full-width bar.
- **The six-state studies wrap two-up at 1368px.**
- **One status slot, mutually exclusive** — the reload-failure line (`#A33A2E`) or a close refusal (`#33302A`), never both; one polite atomic `role=status`.
- **J14 and §2 as a whole remain proposed at the DH-7 gate, not ratified.** That is the repo's own status line and is untouched; what changed here is only the status of the two questions *inside* it.

### Files touched

`mocks/Cowrite Authoring Shell.dc.html` (3 string replacements) · `specs/render-failure-fallback.md` (5) · `specs/state.md` (3) · `screen-map.md` (1) · `CHANGELOG.md` (this entry + one superseded-note) · `README.md` (status line) · `github.md`. No other spec changed; `tokens.md` and `platform-variants.md` already carried the corrected offsets from (10).

## 2026-09-04 (10) — review response: native close ruled, two label defects fixed, two rulings recorded

**The independent `design-review` of refresh (9) returned *Contradicts Established Design* — advisory, not a rejection.** This entry closes every finding. **No composition, token, measure or copy string from (9) changed** except the two label corrections in item 2 and the new close surface in item 1.

### 1. Native close is ruled and drawn — new option `12f`

The review found the gap: **J14 defines no close behaviour** for the case where an active run, dirty or untitled work, or unsent reviewer work would normally guard the close. **Ruled 2026-09-04, and accepted as recommended:**

- **No guard applies** → the native close **closes the window**, exactly as from the ordinary shell. Nothing is drawn; there is no fallback-specific confirmation.
- **Any guard would normally hold** → the close is **refused**. The fallback stays mounted, the protected work stays protected, a **mode-safe** reason appears, and `[Reload window]` remains the **sole** action — so the route back to the real guard controls is the same route as everything else on this surface.

`12f`.1 draws the author case on Windows (unsaved work and a possibly-active run, `✕` highlighted `#C4402F` on the attempt); `12f`.2 draws reviewer mode on macOS (possibly-unsent comment or suggestion, red light taking the platform halo), naming no project, path, branch or checkout in either.

**Three decisions the drawing had to make.** *(a)* **Refusal, not confirm-and-discard** — the dirty-close, untitled-close, run-refusal and reviewer-send guards all lived in the failed tree, and a `Close anyway` sitting directly above a paragraph that says Cowrite *can’t confirm whether every unsaved edit was kept* would contradict it outright. *(b)* **It reuses the one status slot** below the button and is **mutually exclusive** with the reload-failure line — one slot, one polite atomic live region, whichever reason is current — because a second announcer would break §4's contract; and a refusal **never moves focus**. *(c)* **Neutral `#33302A` ink, not the `#A33A2E` reject colour** — refusing to close is protective and expected, while a failed reload is the surface's one action not working. Same slot, same type, different claim.

**The two refusal strings are this folder's proposed wording, not §2's** — the only strings in turn 12 that are not §2 verbatim. They **need §2 adoption before they are authority**; what `12f` settles is the composition and the disposition. *(Superseded by (11): both strings are now adopted in §2.)*

### 2. Two label defects in the mocks, fixed

- **`12b` mislabelled the macOS root focus offset as 3px. It is 6px.** The note now states the rule correctly: **offset is a function of the target, not the platform** — 6px on the `main` root, 3px on the button, identically on both — and only the ring's **width and colour** are platform-specific (`2px #1F1D1A` Win / `3px rgba(47,93,140,.45)` mac). The drawn rings were always right; the caption was wrong.
- **`12e`'s token note now reads "3px on the button; 6px on the root."** The same correction is mirrored into `tokens.md` (Focus rings) and `platform-variants.md`, which had inherited the ambiguity.

### 3. The agent-activity sentence is marked conditional

Required by the review, and now unmissable in three places: the `12a` and `12b` artboard titles say *conditional* on their face; the `12a` note leads with **"Sentence three is conditional"**; and `render-failure-fallback.md` §3 carries the rule above the copy table, noting that §2 gives the row as one string while the conditional is J14 Phase B's. `12c`.1 / `12d`.1 remain the drawn rendering without it.

### 4. The Principle 3 / J7 exception is recorded as accepted

Refresh (9) wrote it as *parked for CJ*. It is **accepted (2026-09-04)**: live agent activity, permission controls and `[Stop]` are unavailable until a successful reload/remount. `render-failure-fallback.md` (header, §6, §7), `state.md` and this entry now say so, and the contingency language about an out-of-tree live-run surface is withdrawn — `12f` is what makes the exception survivable, since a run in flight now makes the window **refuse to close** rather than silently abandoning it.

### 5. Prose alignment for PR #2301 — required, and the (9) brief re-scoped

**Required by the review:**

1. **Record both accepted rulings in the proposal** — the narrow Principle 3 / J7 exception, and native close as ruled above (including that the refusal reuses the single status slot and never moves focus).
2. **Mark §2's author-project agent sentence conditional** — carried over from (9), now a blocker rather than a suggestion.
3. **Replace J14's stale *"undrawn / awaiting design refresh"* language** with references to **turn 12** (`12a`–`12f`) and **`docs/design/specs/render-failure-fallback.md`**. The state is drawn; the proposal should stop saying it is not.
4. **Adopt or replace the two `12f` refusal strings** in §2. Until then they are this folder's proposal, and `12f` says so on its face.

**Useful, not blocking** (the review's own characterisation, carried forward from (9) unchanged): naming the failed-request focus rule alongside the pending state in the brief's enumeration, and stating the reviewer heading's difference where the modes are enumerated.

### 6. What the review did not cover

**No rendered visual inspection was claimed** — no browser was available to the reviewer. The button-hug and 1368px wrapping fixes from the previous pass were verified **in source** only. Rendered inspection of turn 12 is still outstanding.

### Files in this refresh

**Regenerated:** `mocks/Cowrite Authoring Shell.dc.html` (new `12f`; label corrections in `12a`, `12b`, `12c`, `12e`), `specs/render-failure-fallback.md` (new **§5a Native close**; header, §3, §4, §6, §7), `specs/state.md` (new `closeGuards` and `statusSlot`; the open-items note re-scoped), `specs/tokens.md`, `specs/platform-variants.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`.

**Tile count 30.** Prepared for independent `design-review`; not self-reviewed.

## 2026-09-04 (9) — #2130 / J14: the render-failure fallback is drawn

**The undrawn state this folder's own `state.md` recorded as absent is now drawn.** J14's visual-design brief (`../ux-design.md`, #2130, PR #2301) commissioned it explicitly, noting that `docs/design/` had no fatal whole-window state and that **no existing mock may be stretched into authority for it** — so nothing here is derived from `3a`/`3b`, `4a`/`4b`, `11a`/`11b` or the 9-series beyond the outer platform frames, stripped of every app-drawn element.

**Behavior is not ratified.** §2 *Render-failure fallback states* and **J14** are **proposed at the DH-7 gate**. This refresh claims appearance authority only. The narrow **Principle 3 / J7 exception** — live agent activity, permission controls and `[Stop]` unavailable while the fallback is mounted — is CJ's to approve; it is drawn as ruled in the brief, and if he rejects it, the separate out-of-tree live-run/permission surface #2130 would then need is **deliberately not drawn** and must not be derived from `1d`.

### New mock options — turn 12

| Option | What it draws |
|---|---|
| `12a` | **Windows 11** — author with a project, a run may still be active, **focus on mount** (the ring is on the `main` root, not the button) |
| `12b` | **macOS** — the same state, mac frame and mac focus treatment |
| `12c` | The remaining five copy/outcome states: author-project **without** the conditional agent sentence · author with no project · reviewer (drawn on the Windows frame) · context not established · reload **pending** · reload **rejected / bounded-noncompleting** |
| `12d` | The macOS mirror set, with reviewer drawn on the Windows frame's counterpart — the two sets cross frames so neither reads as a platform-specific reviewer treatment |
| `12e` | The mount transition as seven numbered steps, the focus order, the two new tokens, and the composition rationale |

### The composition, in four decisions

1. **Terminal comes from subtraction, not from alarm.** Only the outer platform frame survives — Windows loses its `— positioning-brief` title clause; macOS loses the centred title, the `‹‹`/`››` pair, `Saved · 2:14 PM` and `Share ▾`, because those are app chrome drawn into the platform bar. The window body is **`#EDEAE3`, the page background** rather than the `#FCFBF8` canvas every other full-window mock uses — the surface the mocks show *behind* a window. That one substitution carries the whole "the shell is not mounted" reading, so calm costs nothing: no red or amber band, no tint, no rule, **no warning glyph**.
2. **Hierarchy is one sentence, one paragraph, one button.** Heading Source Serif 4 600/21px `#1F1D1A` — the document-title role, the calmest large type the system has; body IBM Plex Sans 13.5px/1.65 `#4A463E` at a 520px measure; the column top-weighted at 96px rather than vertically centred, because J14 gives the fallback a fresh viewport beginning at its top and the copy changes length across four modes.
3. **Button weight is full ink, on both platforms.** `#1F1D1A` / `#FCFBF8`, 12.5px/500, radius 6px Win / 7px mac. It is the only control in the window, so it ranks against nothing and needs no secondary — and a quieter weight would leave a terminal surface with no visible route out.
4. **Loading and failure are word changes, not new components.** `Reloading window…` takes the system's **inert-but-present** treatment (`#E8E4DB` / 1px `#D5D0C4` / `#6B665C`) — the same muted-never-removed rule the 5-series uses for an inert `✎` — keeps its geometry, position, focusability and ring, and carries **no spinner**: an indeterminate animation would be the only motion on a terminal surface and would claim progress this screen cannot observe. The failure line is `Cowrite couldn’t reload this window. Try again.` as **plain 12.5px `#A33A2E` text** below the restored button — the reject token as text only, no fill, border or icon.

### Focus and announcement

Drawn, because J14 makes it load-bearing: focus moves **exactly once** on mount to the single programmatically focusable `main` root, named by the heading and described by the body; the root is **not `role=alert` and carries no `aria-live`**; the next Tab stop is `[Reload window]`; re-rendering the same instance moves focus nowhere and announces nothing again; and the **only** live region on the surface is the rejected/noncompleting status — polite, atomic `role=status`, absent while pending, inserted once per failed request.

**Two new tokens, and nothing else new.** `tokens.md` gains a **Focus rings** section: the fallback root and button take `2px solid #1F1D1A` on Windows and `3px solid rgba(47,93,140,.45)` on macOS (offsets 6px on the root, 3px on the button), both derived from existing ink and accent values. In-shell controls keep the correction galleries' `2px #2F5D8C` at offset 1px. Every other value in turn 12 was already in `tokens.md`.

### Ruled absences, recorded as ruled rather than as gaps

No `Dismiss`, close or discard (the platform frame is the only other way out; an in-surface discard would need loss semantics the failed tree took with it) · no `Try another way` or second action · no raw exception detail, component name or path in either mode · no toast and no standing status band · no stale agent activity, permission controls, `[Stop]`, run card or elapsed clock · no reassurance clause — never *Your work is safe* · no alarm iconography · no responsive rule of its own (the 660px models in `12c`/`12d` are scale drawings, **not a breakpoint**).

### Files in this refresh

**New:** `specs/render-failure-fallback.md`.

**Regenerated:** `mocks/Cowrite Authoring Shell.dc.html` (turn 12 added at the top; every earlier turn byte-identical), `specs/tokens.md` (Focus rings), `specs/platform-variants.md` (the fallback's five-row platform delta), `specs/state.md` (four new per-window variables — `renderFallback`, `fallbackContext`, `fallbackAgentActivity`, `reloadRequest` — and the fatal-whole-window gap **retired**, replaced by the two things the fallback genuinely leaves open), `screen-map.md`, `README.md`, `CHANGELOG.md`.

**Tile count 28.**

### Prose alignment proposed for PR #2301 — for CJ, not applied here

Three small alignments, none of them design changes; `docs/design/` cannot amend `ux-design.md`, so they are recorded as a brief:

1. **§2's author-project row should say that its agent sentence is conditional.** J14 Phase B has the conditional as a separate bullet, but §2's table gives one string containing sentence three. As written, an implementer reading §2 alone renders the agent claim unconditionally. Suggest a clause on the row: *sentence three renders only where a run was working or waiting for permission*. Drawn both ways — `12a`/`12b` with, `12c`.1/`12d`.1 without.
2. **The brief's "Show … plus the focused one-button `Reloading window…` state" should name the failed-request focus rule alongside it.** §2 already says focus stays on the button after a rejection; the brief's enumeration does not, so a reader could take the pending state as the only focus-bearing outcome. Drawn as §2 states it.
3. **§2 and J14 Phase C describe the reviewer heading in prose only.** The reviewer row's heading differs from the other three (`…show this review…`), which is easy to lose; suggest stating that difference where the modes are enumerated. Drawn as §2's table gives it.

**No J# delta is claimed and no conflict is raised.** Nothing in turn 12 implies behavior J14 does not record. Prepared for independent `design-review`; not self-reviewed.

## 2026-08-28 (8) — correction pass: five package defects, no design change

**No design decision is revisited.** The toolbar composition, the document-notice slot, the dictation escalation and the status-bar contents all stand exactly as ruled in (7). This entry records five accuracy and consistency defects found in the delivered package by independent review, and how each is fixed.

1. **`9f.3` is restored, not withdrawn.** The published-card artboard was dropped from the regenerated mock while four files still cited it (`adoption-provenance.md` twice — including the ratified **Both succeed** row — `open-conflicts.md` disposition 1, `screen-map.md` and this file). It is redrawn: the timeline rail with the published scratch-adoption card in the plain at-rest shell, a neutral `#DCD7CC` tile rather than the agent's `#2F5D8C`, no action row, and a footer stating the exactly-once rule (**one card per `adoptionId`**). The pane carries **no pending line** in this state. All four citations are valid again and `specs/adoption-provenance.md` stays byte-identical. **Tile count 23.**
2. **`state.md`: the #1804 "Known gap" is retired.** It read *"rich-text / Markdown parity for an untitled buffer is out of scope: the pane is drawn as a plain buffer with no toolbar"* — false in every clause since refresh (7), and sitting in the one list implementers are told to read before building on these surfaces. Withdrawn explicitly, with what the refresh **does** leave open named in its place: dictation, the overflow breakpoint, and a new gap — **the zero-changes context group on the *file-backed* pane**, drawn only on the pathless pane in `9c`.1.
3. **`state.md`: the `contextGroup` row is repaired.** Unescaped pipes between `'none'` / `'redline'` / `'comments'` made five cells in a two-column table, so GitHub's renderer dropped everything after `'none'` — including the rule that **`'none'` is a rendered state, not an error and not a disabled group**, one of this package's headline decisions. Pipes escaped; every other row in the three state tables checked for the same shape (the rest already escape or use prose).
4. **This file: entry (7)'s header is rewritten.** It claimed a mocks-only pass with three specs left carrying superseded wording and "listed as outstanding below" — but all three were regenerated, the same entry enumerates their deltas, and no outstanding list exists. The header now describes the package that was actually delivered.
5. **The slot ruling's provenance is corrected in four places** — `specs/authoring-shell.md`, `specs/document-integrity.md`, `README.md` and entry (7) item 2. The phrase *"below the tab strip, above the buffer"* appears in none of `functional-spec.md`, `ux-design.md`, `tech-design.md` or `test-plan.md`; **FR-ED-7 specifies no placement at all.** The wording is this folder's own, from refresh (6). The ruling is unchanged — it resolves **this folder's** prior ambiguity, not a ratified requirement.

**Also, not a defect:** the dictation conflict is widened. `open-conflicts.md` cited three disagreeing sources; there is a fourth — **FR-ED-5 (MUST)**, requiring dictation into the editor surface with no placement stated. It settles nothing about placement, but it means the resolution cannot be *no mic anywhere **in the app*** — it says nothing about whether the editor's mic lives on the toolbar. Added to the table in `open-conflicts.md` and to the gap in `state.md`; **the escalation stands as written**.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html` (`9f.3` restored), `specs/state.md`, `specs/open-conflicts.md`, `specs/authoring-shell.md`, `specs/document-integrity.md`, `README.md`, `CHANGELOG.md`.

**Preserved byte-identically:** `specs/adoption-provenance.md`, `specs/recovered-document.md`, `specs/tokens.md`, `specs/comments.md`, `specs/platform-variants.md`, `specs/timeline-rail.md`, `specs/wireframes.md`, `screen-map.md`, `amendments/j2-recovery-document-over-cap.md`, `mocks/Cowrite Wireframes.dc.html`, `mocks/support.js`.

**No token, no copy and no layout decision changed.**

## 2026-08-28 (7) — the untitled/scratch pane gets a toolbar, and the document-notice slot is ruled for every pane

**Appearance only.** Mocks **and** specs changed this pass: `specs/authoring-shell.md`, `specs/recovered-document.md` and `specs/document-integrity.md` were regenerated with the ruled slot wording, and their deltas are enumerated under **Spec deltas in this entry, by file** below. Nothing from this pass is outstanding. *(Header corrected 2026-08-28 (8): it previously described this as a mocks-only pass with three specs left carrying superseded wording, which the entry's own contents contradict.)*

1. **The untitled/scratch pane now carries an editor toolbar** — the first time this surface has had one. One row between the tab strip and the document region, full column width, `#FAF8F3`, 1px bottom `#E3DFD6` (Win) / `box-shadow: 0 1px 0 #DCD7CC` (mac). Composition on a pathless buffer: `Rich text | Markdown` (both segments live) · format group `B I H1 ≔` (all live) · redline context group **present only at ≥1 change, absent at zero, never visible-but-disabled** · `Timeline ››`. **Absent, not disabled:** the comment group (path-keyed) and `Share ▾` (versioning at no project path). **One row, no exceptions** — anything over budget goes to a `⋯` overflow, never a second row (drawn in `9c`.4).
2. **The document-notice slot is ruled, and it binds on every pane.** The phrase *"below the tab strip, above the buffer"* is **this folder's own**, from refresh (6) — **FR-ED-7 specifies no placement at all** *(attribution corrected 2026-08-28 (8))*. It describes **two** slots on any toolbar-bearing pane. Ruling: **immediately below the toolbar, above the standing-conditions strip** — the amber over-cap notice, the FR-ED-7 integrity banner, a Save As failure line and the provenance-pending line all take it. **The toolbar never moves** when a notice mounts, collapses, expands or gains a failure line; only the document region reflows. The old justification for the notice sitting at pane top (*"because there is no toolbar to sit under"*) is removed — its premise is gone.
3. **`11a` / `11b` / `11c.1` redrawn with a toolbar.** They were previously drawn in a reduced frame with no toolbar and so never had to choose a slot. This is a fix to the **ordinary file-backed pane**, independent of the untitled work.
4. **`9a` / `9b` redrawn as full windows at 1400px**, so the shell status bar, the rail (no row active) and the timeline are visible. **Status bar on this pane:** left — mode readout, word count, tracked-change count **at ≥1 only**, and **no open-comment count at all** (absent, not `0`: a zero asserts a capability this pane does not have). Right — `Display: … ▾` **present** (computed from the buffer's own markup, so it needs no file), agent connection unchanged, **no saved-state slot on either platform**; the pane footer stands in for it.
5. **macOS title bar for an untitled tab** (`9b`): centred `UNTITLED` qualifier + italic displaced path + muted project name — the same three tokens as the tab, in the same order. **No proxy icon, no amber dot, and `Share ▾` and the saved state both absent** — an empty right side rather than a disabled control.
6. **Unattributed redlines are stated, not silenced** (`9c`.4). An untitled buffer's tracked changes are unrecorded — no author, no author-type, no agent note — but `✓ Accept` / `✕ Reject` is itself a provenance claim. Placement ruled: **the status bar's left cluster, qualifying the count** — `1 tracked change · no author recorded`. Rejected: the standing-conditions strip (unconditional, and it would drag a conditional fact into the binding drop order) and the toolbar (already the over-budget slot).
7. **A state no mock had drawn** — format group present, context group empty — is drawn in `9c`.1 and answers `3a`/`3b` as well.
8. **`9d.1`: the toolbar joins the inert set** at 55% opacity. Every control on it mutates the buffer, including the mode switch, which rewrites the projection the session payload is composed from.
9. **`9c.7`: the adoption delta shrinks.** Adoption no longer adds a toolbar; it swaps groups **within the existing row** (gains the comment group and `Share ▾`) and removes notice, strip, footer, dot and qualifier. The buffer is not re-created. Drawn so nobody implements a remount.
10. **Worst composed state judged** (`9e.2`: composed notice + failure line): six bands, three tinted. **Verdict — honest density, not a wall**, on the ordering: the three tinted bands read as one amber block plus one red line, top-down in cause order. The three constraints hold — the rule-and-*Separately* split is not merged, the final sentence never drops, and the strip is not folded into the toolbar row.
11. **Preserved unchanged:** the amber vocabulary (`#FBF3E1` / `#E0C98C` / `#8A6614`, 6px `#B5871F` dot); `Saved nowhere yet` never dropping and the strip drop order; the `UNTITLED` qualifier and dot semantics (**this pane is never dirty and shows no dirty dot — a real editor is exactly when someone would wire dirty tracking in**); no saved-state slot on either platform; the pane footer copy and its `[Save As…]` chip in every state; the notice's final sentence *"It doesn't bring back what wasn't kept."*; the buffer contents; `[Save As…]` as the only route into the project; and `9c.5`, `9c.8`, `9d.3`, `9e.3`, `9f.1`.

**Open, escalated to CJ — dictation.** Four sources disagree: `../functional-spec.md` **FR-ED-5 (MUST)** requires dictation into the editor surface without stating a placement; §2 puts the mic on all three surfaces *including the editor toolbar*; §4 enumerates the toolbar without it; the appearance spec enumerates four groups and no mic. The conflict is about the **ordinary file-backed pane** and predates this work — this pane is simply the first specified from scratch and therefore the first that had to ask. **Drawn without.** A comparison variant is drawn as `9c`.9, never as the default. This is a **J# delta for CJ**, not something an appearance spec settles.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/authoring-shell.md`, `specs/recovered-document.md`, `specs/document-integrity.md`, `specs/state.md`, `specs/open-conflicts.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`.

**Unrelated files preserved byte-identically:** `specs/tokens.md`, `specs/comments.md`, `specs/platform-variants.md`, `specs/timeline-rail.md`, `specs/adoption-provenance.md`, `specs/wireframes.md`, `amendments/j2-recovery-document-over-cap.md`, `mocks/Cowrite Wireframes.dc.html`, `mocks/support.js`.

**Spec deltas in this entry, by file.** `authoring-shell.md` — toolbar is one row on **every** pane, `flex-wrap` removed, `⋯` overflow with a ruled order (`Timeline ››` before `Share ▾`); the pathless composition table; context group present-or-absent, never disabled; adoption as a same-row group swap; a new **"The document-notice slot"** section; status-bar nowrap + the pathless slot table + the unattributed-redline statement. `recovered-document.md` — the toolbar added to the *It has* column and to the anatomy as item 2 (everything below renumbered), the notice re-slotted with its new justification, the shell status bar added as item 8, and the no-dirty-state consequence of having a real editor made explicit. `document-integrity.md` — the placement paragraph rewritten to name the slot and to record that `11a`/`11b`/`11c.1` were previously drawn without a toolbar. `state.md` — `toolbarComposition`, `toolbarOverflow[]`, `contextGroup`, an amended `editorMode`, and **four new Known gaps** (dictation; the overflow *threshold*, which is unruled where the ordering is ruled; the overflow menu's contents; the redline group's zero→one transition). `open-conflicts.md` — retitled, the "no unresolved conflict remains" line withdrawn, and a new **Open — dictation** section with the three-source table, the appearance recommendation, and two sub-questions that only bite if the mic is ruled in.

**Not exported:** `specs/tokens.md` gains no token — the toolbar reuses the existing chip, segment and divider treatments, and the notice reuses the amber family unchanged. **A toolbar adds no vocabulary.**

## 2026-08-28 (6) — "This file changed outside the editor": the FR-ED-7 integrity banner (issue #1641)

**Appearance only.** FR-ED-7 and `../ux-design.md` "Document integrity & lifecycle moments" (CJ architecture amendment #1599) are **not redefined** — the write pause, Save performing no write, Reload's atomic restore and honest dirtiness, Keep mine as the sole authorization of the next local-content write, and Save As remaining separate all bind there, unchanged. This folder previously drew **neither** integrity moment; the changed-on-disk one is now recorded rather than silently absent.

1. **New spec `specs/document-integrity.md`** and new hi-fi options **`11a` (Windows) / `11b` (macOS) / `11c` (five states)**, plus wireframe storyboard **`1n`** (five frames + the Missing-on-disk distinction).
2. **Presentation: a non-modal amber bar** below the tab strip, above the buffer, full column width — `#FBF3E1` fill, `#E0C98C` edge (Win `border-bottom`, mac `box-shadow: 0 1px 0`), `#8A6614` text, 6px `#B5871F` dot, padding 10px 14px. The same treatment as the 9-series over-cap notice, deliberately: it means the same class of thing. Never a dialog, never an overlay, never inside the buffer, and **never transient** — no toast anywhere in this design.
3. **Hierarchy: two lines, never three.** The ratified sentence verbatim at 12.5px/500, then the consequence at 11.5px — **writes are paused** and **the unsaved edits are still here** — then `Reload` · `Keep mine` · `Compare` right-aligned in one row, gap 6px, in the ratified order.
4. **Buttons.** Ordinary: `#FCFBF8` + 1px `#D5D0C4` radius 5px (Win) / `0 0 0 1px #DCD7CC` radius 7px (mac), padding 5px 11px, 11.5px. Highlighted default: solid `#2F5D8C`, white, 500 — the treatment `Review 1-by-1` and `[Save As…]` already carry. **`Keep mine` is highlighted only while unsaved edits exist**; on a clean buffer all three are equal weight (`11c.1`). **Nothing is styled destructive.**
5. **Focus.** The banner **never takes focus on appearance** — an author mid-sentence keeps their caret. Exactly one exception: a **blocked Save** moves focus to `Keep mine` (`11c.2`). Ring 2px `#2F5D8C` offset 1px; tab order follows reading order.
6. **Blocked-Save announcement copy** (`role="status"`, **rewrites both lines**, so the region re-announces): line one *"**Not saved — this file changed outside the editor**"*, line two *"Cowrite didn't write over it. Choose Reload, Keep mine, or Compare."* The lede lives in the heading rather than stacked under an identical one — **the ratified sentence appears once per bar, never twice** — and the announcement stays self-contained because the status region announces both lines together. **No internal vocabulary in any user-facing string** — no "flush", "imperative save", "divergent revision", "queued write", "publication".
7. **Reload in progress** (`11c.3`): `aria-busy="true"`, the three actions dimmed to 45% but **not removed** (no reflow under the author's eye), a quiet `Reloading…` left of the cluster, line two stating it in the author's terms, and **nothing announced on entry** — the outcome is what deserves the announcement.
8. **The post-Reload dirty window** (`11c.4`) is the **ordinary `#2F5D8C` tab dot** plus `Reloaded from disk · not saved yet` in the status bar. **No new badge and no second colour**: a state that is exactly "dirty" must not dilute the dot.
9. **Reload failure** (`11c.5`): the bar stays amber (the pause is still true) and gains an inset Reject-family line (`#F8EFED` / `#DCC4BF` / `#A33A2E`) carrying the real reason; the status line turns `#A33A2E`; the heading becomes the honest one — *"The version from disk is here, but it isn't saved"* — because after a Reload the earlier text really is gone. **Actions, ruled by CJ 2026-08-28: `Try again` (primary) · `Save As…` · `Compare`.** `Keep mine` is **omitted** — after a Reload the buffer already holds the disk version, so the label is ambiguous or a no-op; `Save As…` is **included** as the safe escape for what is now the only unsaved copy.
10. **Kept distinct from Missing-on-disk.** Both share the bar and the amber (`../ux-design.md`: "all use one vocabulary") and are told apart by **copy and action set, never by colour** — a disk version to reckon with (`Reload`/`Keep mine`/`Compare`) versus none (`Keep editing`/`Save As…`/`Close…` + a persistent tab status). `specs/document-integrity.md` carries the comparison table. **Missing-on-disk itself remains undrawn** and must not be derived from `11a`–`11c`.
11. **Inventory and gaps recorded in `specs/state.md`** — new per-document entries `externalChange` (with its four phases), `externalChangeSaveBlocked`, `compareOpen`, `missingOnDisk`; and four Known-gaps entries: changed-on-disk **is drawn**; the **Compare destination stays a gap** at hi-fi (wireframe only); the **failed-recovery-write action set is settled** — `Try again` (primary) / `Save As…` / `Compare`, `Keep mine` omitted (CJ, 2026-08-28) — **with implementation, not design, outstanding**; and **Missing-on-disk is undrawn**.
12. **The one escalation is disposed** (`specs/open-conflicts.md`): the failed-recovery-write action set was raised and **ruled the same day** — omit `Keep mine`, include `Save As…`, final order `Try again` / `Save As…` / `Compare`. Recorded closed; `specs/state.md`'s gap entry updated to match.

**Drawn against the shipping code**, read this pass: `src/editor/ExternalChangeBanner.tsx` (ratified copy, three actions, `--default` highlight keyed on `isDirty`, `role="status"`, `keepMineRef` used only after a blocked Save — all confirmed, all preserved), `ExternalChangeCompare.tsx`, and `src/styles.css`'s `.integrity-banner*` / `.external-change-compare*` rules. **The interim banner is neutral-surface** (`--color-surface` + `--color-border`, 6px 10px, message 13px) and its highlighted default uses `--color-accent` (`#2f6feb`); this pass replaces that appearance with the amber treatment and `#2F5D8C` above.

**This is not a CSS-only change.** `ExternalChangeBanner.tsx` renders **one** banner with three fixed actions and has **no reloading, write-pending or reload-failed presentation state at all**. Delivering `11c.3`–`11c.5` requires a **bounded implementation follow-up**: a phase input on the component, the `aria-busy` + dimmed-actions treatment, the Reject-family failure line with its real reason, a per-phase action set (including dropping `Keep mine` and adding `Save As…` on failure), the blocked-Save two-line rewrite, and the two status-bar readouts. Recorded in `specs/open-conflicts.md` so the delta is not underestimated.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `mocks/Cowrite Wireframes.dc.html`, `specs/document-integrity.md` (**new**), `specs/state.md`, `specs/platform-variants.md`, `specs/wireframes.md`, `specs/open-conflicts.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`.

**Unrelated files preserved byte-identically:** `specs/tokens.md`, `specs/comments.md`, `specs/authoring-shell.md`, `specs/timeline-rail.md`, `specs/recovered-document.md`, `specs/adoption-provenance.md`, `amendments/j2-recovery-document-over-cap.md`, `mocks/support.js`. Baseline for this refresh is the previous export (`main` @ `20bf30fa4c0a` plus the #1789 and #1817 refreshes below); the code above was read at `main` @ `6b2a452555a4`. **`docs/design/` was not re-diffed against that head** — confirm before committing.


## 2026-08-28 (5) — agent chat-message card and grounding indicator (issue #1817)

**Appearance only.** No new behavioral state, no new panel. Behavior binds in `../ux-design.md` J2 and issue #1391.

1. **New hi-fi options `10a` (Windows) / `10b` (macOS) / `10c` (workshop mode).** The agent reply is drawn in the timeline rail's Chat facet beneath a `You` card, in all three grounding cases — `refs: 4 files read`, `refs: 1 file read`, and a reply with **no indicator at all**. `10c` draws the same card at center-stage workshop measure.
2. **The reply reuses the user-message shell, not the change-set shell.** White, radius 8px (Win) / 10px (mac), padding 12px, gap 7px; Win 1px `#E3DFD6`, mac `0 1px 2px rgba(31,29,26,.07)`. Rationale recorded: emphasis in this feed means *something is waiting on you*, which a prose reply is not.
3. **Attribution is the shipped label plus a new tile** — the label is **`Agent`** 12.5px/500 `#3A362F`, which is what `ChatMessageCard`'s `AUTHOR_LABEL` renders today (`{user: "You", agent: "Agent"}`); no product or model name is asserted, because **the card data carries no model or provider field**. New appearance: a 20px **rounded-square** `#2F5D8C` tile (radius 5px Win / 6px mac) leading the row, against the user card's round avatar. Time right-aligned. No icon set, no emoji.
   **Ruled by CJ, 2026-08-28:** *the visible `Agent` label and the distinct agent tile satisfy #1817's source-attribution requirement; the card must not expose provider or model identity, and no new card field is authorized.* `specs/open-conflicts.md` records the escalation and its disposition as **closed**; `specs/state.md` and `specs/timeline-rail.md` carry the ruling. An earlier draft of this refresh invented `Claude` + `Sonnet 4.5` on the card; it was removed before export, and the ruling now forbids reintroducing it.
4. **The grounding indicator is muted text, not a chip** — 11px `#8C8779`, right-aligned on its own footer row above `1px #F0EDE6`. A chip would read as actionable and would compete with the `REVISION` badge and the action pills, which are. Identical on both platforms; **not** platform-conditional.
   **This ratifies what the interim implementation already chose.** `styles.css`'s `.chat-message-card__refs` is muted, right-aligned block text, adopted — per its own comment — because "`docs/design/` draws no chat card at all". Two literals now change deliberately: **11px `#8C8779`** in place of 12px `--color-muted`, and the footer hairline, which the interim rule has no equivalent for. The zero rule needs no code change: `showRefs = author === "agent" && (filesRead ?? 0) > 0` is already exactly this design.
5. **Zero renders nothing** — footer row and hairline both absent, card ends on its body. Never `refs: 0`, never "no files read", never an empty row. Singular `1 file read` / plural `N files read` fixed.
6. **Explicit non-scope, recorded in two places** (`timeline-rail.md`, `state.md` known gaps): which-files disclosure, the gesture that would reveal it, and in-flight run presentation are #1391's. **An *unknown* count is not the zero case** and must not borrow the absent-footer treatment.
7. `specs/state.md` gains `agentRefsCount` in the per-document table as an **appearance driver only**; `specs/platform-variants.md` gains an agent-card row and an indicator row stating the indicator is platform-identical.

8. **The quoted-excerpt element is left alone.** A chat card may carry a deep-linking quoted excerpt above its body (`chat-message-card__quote`, P2b-7). Its appearance stays unspecified by this folder; the footer rule sits below the body whether or not a quote is present. Recorded, not drawn.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/timeline-rail.md`, `specs/platform-variants.md`, `specs/state.md`, `specs/open-conflicts.md`, `screen-map.md`, `CHANGELOG.md`.

**Baseline: `main` @ `6d5503401`** — the code read for this pass (`src/timeline/ChatMessageCard.tsx`, `TimelineCard.tsx`, `AgentWorkingCard.tsx`, `src/styles.css`); `docs/design/` was file-by-file compared at `20bf30fa4c0a`, **before the #1789 refresh landed**; that refresh changed four files in the folder (`mocks/Cowrite Authoring Shell.dc.html`, `specs/authoring-shell.md`, `specs/platform-variants.md`, `CHANGELOG.md`), so the folder is **not** identical between the two commits and this export was not re-diffed against `6d5503401`. The byte-identical claim below is therefore against the `20bf30fa4c0a` comparison plus the #1789 delta — the importer should confirm it against current `main` before committing. Every file not in the list above is **byte-identical to that baseline**: `README.md`, `specs/recovered-document.md`, `specs/adoption-provenance.md`, `specs/comments.md`, `specs/tokens.md`, `specs/wireframes.md`, `amendments/j2-recovery-document-over-cap.md`, `mocks/Cowrite Wireframes.dc.html`, `mocks/support.js`. (`specs/authoring-shell.md` and the mock's `4b` toolbar carry the #1789 refresh recorded in the entry below.)


## 2026-08-28 (4) — timeline-toggle keyboard hint removed

**Presentation only.** No behavioral change; no new binding asserted.

1. **The macOS `⌘⌥T` timeline-toggle hint is removed everywhere.** `mocks/Cowrite Authoring Shell.dc.html` (`4b` right cluster) now renders the toggle with its label only. `specs/authoring-shell.md` right-cluster item no longer appends a chord on macOS. `specs/platform-variants.md` "Keyboard hints" lists only `⌘⏎` (send) and records that the timeline toggle carries no hint.
2. **No replacement chord.** `ux-design.md` records no timeline-toggle binding, and no separate UX decision authorizes one, so the hint is dropped rather than re-chorded. This closes the disposition question flagged with the #1368 `⌘T` removal (2026-08-20); the bundle now asserts no keyboard binding it cannot cite.
3. Nothing in the bundle claims a timeline shortcut. Historical wording survives only in this changelog.

**Baseline.** This export is rebased on `main` @ `20bf30fa4c0a`. `specs/state.md` and `specs/adoption-provenance.md` were **behind** that baseline in the previous export — the design source had not picked up the repo's corrected `prepared`-phase wording ("file success is not yet durably confirmed by the event") or the corrected `stagedDecisions` rule ("ordinary removals commit only after the authoritative persistence proof returns confirmed exact"). Both files are now **byte-identical to `main`** and carry no delta in this refresh. No other file in the bundle differs from the repository except the four named below.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/authoring-shell.md`, `specs/platform-variants.md`, `CHANGELOG.md`.


## 2026-08-28 (3) — proof routing, adoption reconciliation, bounded app-Quit (PR #1833 / issue #1421)

**Consistency cleanup only.** No new scope; the ratified treatment is unchanged.

1. **Every successful close routes through `awaiting-proof`.** `wholeSessionDelta = false` → skip write → **authoritative no-write proof** → `awaiting-proof`; retry write success → `awaiting-proof`; retry no-delta → no-write proof → `awaiting-proof`. **Only `awaiting-proof → confirmed exact` commits removals and closes**, and `closed` no longer lists retry success or no-delta as direct entrances. The `wholeSessionDelta` prose and the `[Try again]` control row are updated to match, and the **no-write proof/preflight capability** is added explicitly to the Architect-owned persistence-proof dependency.
2. **Prepared-event crash rows split**, matching `adoption-provenance.md` exactly: crash **before** the file write → tombstone, untitled document intact; file written but phase not promoted → **authoritative reconciliation**; verified file success → promote to `file-committed` and project **exactly once**; not verifiable → **remains non-projectable**, surfaces reconciliation pending, **never publish or tombstone on a guess**. Added the same-session case where the file succeeds but `prepared → file-committed` fails: the adoption **succeeded**, so Cowrite shows **provenance pending, not a Save As failure**, stays non-projectable, retries reconciliation automatically, and **never duplicates the card**.
3. **App-wide Quit is bounded, not atomic.** A **non-mutating** active-run/eligibility preflight runs across all windows first and any refusal stops before decisions or writes; windows are then processed **sequentially** through their existing per-window state machines; a later Cancel/failure/refusal stops the remaining windows but **reverses nothing** — closed windows stay closed, completed project Saves stay saved. The "one refusal ⇒ nothing written anywhere" claim and any implication of distributed rollback are removed from README, `recovered-document.md`, `state.md`, the transition table and architecture ownership.
4. **Stale `9d` mock authority removed** — "OPEN — NOT DRAWN, AWAITING CJ", "deliberately not drawn" and "not implementable until CJ rules" are gone; the annotation now records that all seven dispositions are ratified and drawn, and names the two Architect-owned dependencies. Historical wording remains only here and in `open-conflicts.md`.
5. **Transition table updated to 49 rows** (was 42), with its adoption rows agreeing exactly with `specs/adoption-provenance.md`.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `specs/adoption-provenance.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`.


## 2026-08-28 (2) — whole-bundle consistency sweep (PR #1833 / issue #1421)

**No redesign of the ratified treatment.** Twelve findings resolved across the bundle.

1. **Proof on every close path** — the authoritative per-tab losslessness preflight now runs on the initial write, on a successful `[Try again]`, **and** on the `wholeSessionDelta = false` short-circuit. **No path closes while a live untitled buffer was omitted.** Every `awaiting-proof` exit is defined: confirmed exact → close; **omission → clear the finalization lock, focus the `live-over-cap` guard, retain and recompose the plan**; unusable → typed `proof-unusable` failure, never close.
2. **Withdrawn authority removed** from every live file. `[Quit without saving session]` and every "commits the retained/staged decisions" claim are gone from README, `state.md`, `recovered-document.md`, the amendment and the mocks; the binding wording is `[Quit anyway]` — "abandons the current session delta; previous state may reopen." Historical wording remains only in CHANGELOG and `open-conflicts.md` history.
3. **D15 provenance corrected everywhere** — durable machine-local adoption event = the record; the D15 card = a reconstructible projection; **current `main` has no scratch-adoption card of any kind.** Every remaining claim that an existing card is itself the durable record is removed.
4. **`closeGuardVariant` enumerates five values** — `only-copy`, `live-over-cap`, `omitted-with-edits`, `restored-omitted-empty`, `preserved-empty`. The last two-variant summary is gone.
5. **Transition table added** — `specs/state.md`, "Transition coverage and test oracles (#1833)": **42 rows**, source / action / outcome / oracle, covering `9a`–`9f` including retry, no-delta, proof failure, app-wide Quit and adoption partial failure. (It had been lost to an authoring error in the previous pass.)
6. **Adoption provenance is crash-safe** — explicit phases `prepared` → `file-committed` → `published`, with `cancelled`/`tombstoned` terminal. **Only `file-committed` may project**; file or cleanup failure never publishes a false adoption. Crash/relaunch recovery is defined at every boundary, with idempotent dedupe by `adoptionId`. Mapped as an Architect dependency.
7. **Downgrade claim corrected** — the promise that released older binaries preserve unknown fields is removed as infeasible. **Downgrade-through-an-older-writer is recorded as unsupported and lossy**, with its bounded consequence stated; any future guarantee needs a mechanism old binaries genuinely honor and is a separate decision.
8. **Accessible names split** — live-only announces *current work is present but not kept in the session*; restored omission announces *earlier unsaved work was not preserved*; composed announces both. **`9e.1` never announces a loss.**
9. **App-wide Quit** — the coordinator **preflights every participating window before any window writes, removes a tab, or closes**; one refusal abandons the quit with nothing to undo. Ordering and ownership defined and mapped to architecture.
10. **Finalization focus** — focus moves to a defined shell-level close-attempt target **before** the pane goes inert; failure → `[Stay open]`, cancellation → recorded prior focus, success → the window closes. Focus is never left inside an inert subtree.
11. **State metadata** — `attemptGeneration` moved from the phase list to attempt-scoped variables; `baselineValidity` (`valid`/`none`/`unverifiable`) added; the comparison baseline is defined as **the latest canonical receipt**; a new **Architecture ownership** table covers the adoption-event lifecycle/dedupe, app-Quit coordination, the persistence receipt, single-writer, and migration semantics.
12. **Sweep clean** — none of the six withdrawn strings appears in any live spec, mock, README or amendment.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `specs/adoption-provenance.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-28 — all seven dispositions ratified and applied (PR #1833 / issue #1421)

**CJ ratified all seven escalated conflicts on 2026-08-28.** Applied here alongside every non-CJ correction from the consolidated review of `f24dc462ae77`. **No unresolved conflict remains.**

### New identifiers

`9e` — **live over-cap**: `9e.1` `live-over-cap-not-durable` · `9e.2` composed (earlier loss + new live risk) · `9e.3` its close guard.
`9f` — `9f.1` FR-X-11 run refusal ahead of close handling · `9f.2` adopted, provenance pending · `9f.3` the published card.
`9c.5` grows from two guard variants to **five**. New spec `specs/adoption-provenance.md`.

### Ratifications

1. **D15 provenance** — a durable machine-local **scratch-adoption event keyed by a stable adoption id**; the timeline card is its **visible D15 projection**, not the record; publication retries idempotently across relaunch. The event is persisted **before** the irreversible adoption boundary, so provenance cannot vanish between file success and card commit. File failure leaves the untitled document unchanged; file success + publication failure shows an honest "saved, provenance pending" line; pending state clears **only** on confirmed append.
2. **Override** — `[Quit without saving session]` → **`[Quit anyway]`**. It abandons the current session delta and closes, claims **no** durable commit, and discloses that the previous saved session — including tabs or older buffers — may reopen. Reason copy is now the **actual normalized detail** plus one of three baseline variants (valid / none / unverifiable).
3. **Empty guards** — current-state wording ("This untitled document is **empty now**…") replaces "nothing has been written here since", which type-then-delete falsified. A distinct **`preserved-empty`** variant is added with **no omission copy**, still guarded. All five variants keep `[Save As…]` / `[Discard]` / `[Cancel]`, Cancel autofocus and Esc.
4. **Over-cap lifecycle split** — `live-over-cap-not-durable` (bytes present and editable; only durability at risk) is separated from `restored-omitted-empty` (post-relaunch, genuinely gone). **Live bytes are never cleared to reach the empty state** and require Save As / Discard / Cancel before close. Composed presentation where both are true, visibly separate.
5. **Persistence proof** — an unguarded close now requires **authoritative confirmation that every remaining untitled buffer persisted without omission**; backend `Ok(())` is insufficient. Omission routes those tabs back to the guard as `live-over-cap`; unknown outcomes do not close. New `awaiting-proof` phase. **The Architect owns the IPC mechanism.**
6. **Session ownership** — **one logical writer per project tab session** is required and named as a dependency; frontend-local serialization is not claimed to provide it. **The Architect owns** whether D26 enforcement, backend serialization/CAS, or both supply it.
7. **Active run** — FR-X-11 refusal **precedes** D12/J2 close handling: no guard queue, no staged decisions, no session write; after stopping the run the author initiates close again.

### Also applied (non-CJ findings from the same review)

Single-flight close attempts with a stable **attempt generation** and nine **typed dirty-tab outcomes**; Save As ↔ close fencing; retry busy-state (one modal, disabled actions, generation-tagged callbacks); the missing **no-delta → closed** edge; identity-based tab matching with **untitled-subsequence** ordering and separate active attribution; adoption excluded from staged-discard copy; stable `(n)` duplicate-label disambiguator; guard-hosted Save As failure; the finalization `aria-busy`/`inert` lock; `#B5B0A4` → `#6B665C`; the 9-series carved into binding responsive authority with three-label dialog fit and stacking; scope limited to one cancellable window close with app-Quit as coordination and forced termination excluded; expanded migration (in-memory canonicalization, malformed combinations, downgrade with unknown keys preserved).

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/adoption-provenance.md` (new), `specs/state.md`, `specs/platform-variants.md`, `specs/authoring-shell.md`, `specs/open-conflicts.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-27 (6) — consolidated review of `f24dc462ae77`: appearance corrections; seven conflicts escalated (PR #1833 / issue #1421)

**Seven of the twelve findings conflict with ratified authority and are NOT encoded.** They are recorded in the new `specs/open-conflicts.md` with the code evidence behind each: durable D15 provenance (D15 says the transcript is scaffolding; `appendTranscriptEvent` is best-effort and swallowed; no scratch-adoption card exists), the destructive override, the type-then-delete guard body, the ratified "present and empty" premise (the cap omits at serialization — `tab_session.rs:91` — so the live buffer is not empty), the persistence receipt (`save_tab_session -> Result<(), CommandError>`; an FR-ED-3 delta), multi-window safety (D26/TD-20 own **processes**, not windows), and active-run close refusal. **The 9-series is no longer described as implementable.**

### Applied — appearance corrections that hold under either outcome

- **New option `9d`.** `9d.1` finalization lock (`aria-busy` + `inert`: edits, tab mutation, notice toggling and Save As **refused, not queued**; focus restored on `[Stay open]`). `9d.2` guard-hosted Save As failure rendered **inside** the alertdialog — never behind the focus trap — plus one single-flight latch shared with the pane (one panel, one write, one adoption, one provenance event). `9d.3` stable `(n)` disambiguator for a repeatedly displaced path, identical in tab strip, accessible name and affected-documents list.
- **Comparison corrected** — tabs matched by **stable opaque identity**; ordering compared **within the untitled subsequence**, so a project-tab-only change cannot mark an untouched untitled tab; active identity attributed separately; **adoption is not a staged discard** and never appears under vanishing-content copy.
- **Contrast** — the instructional buffer placeholder moves from `#B5B0A4` to `#6B665C`; placeholder tints are for inert hints, not instructions.
- **Responsive authority** — the 9-series is carved out of the folder's "nothing below 1400px" limit and is binding. The `9c.8` dialogs must show **three full action labels**: they stack full-width in the same order below that width and in long locales, never truncating; the list stays the only scrolling region.
- **Migration expanded** — canonicalize in memory rather than eager-rewrite (with the baseline named honestly as the *canonicalized* last-persisted session), dispositions for hidden-without-omitted, omitted-without-recovery-identity and adopted-with-recovery-flags, and additive/ignorable downgrade behavior with unknown keys preserved round-trip.
- **Recorded accurately** — the shared guard's Cancel autofocus, Esc and focus trap are **new #1833 work**, not existing behavior on `main`.
- **Also updated** — `specs/state.md` (`finalizationLock`, `saveAsLatch`, `displacedLabelOrdinal`, the missing **no-delta → closed** edge), `specs/platform-variants.md`, `authoring-shell.md` (status-bar leading slot; duplicate-label ordinal), `screen-map.md`, `README.md`.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/open-conflicts.md` (new), `specs/recovered-document.md`, `specs/state.md`, `specs/platform-variants.md`, `specs/authoring-shell.md`, `screen-map.md`, `README.md`, `CHANGELOG.md`.


## 2026-08-27 (5) — 9c.8 retained plan and single comparison basis (PR #1833 / issue #1421)

**Only the staged-close contract changes.**

1. **Write failure retains the plan.** The contradiction is resolved: `stagedDecisions` is **retained, uncommitted**, on failure — every tab and buffer mounted — because `[Try again]` and `[Quit without saving session]` both require it. `[Try again]` recomposes the proposed payload from the retained plan and retries; `[Quit without saving session]` commits the retained decisions and closes without updating the session; `[Stay open]`/`Esc` cancels and **clears** the plan, returning to `idle`. Only those three — Stay open/Escape, a dirty-tab Cancel, or a failed project-document Save — clear the plan without committing. `failed-decision`, `retrying`, `cancelled`, `overridden` and the amendment wording all updated.
2. **`wholeSessionDelta` added.** `proposedSessionPayload` materially differs from `lastPersistedSession`. **False ⇒ the snapshot already represents the proposed final session:** skip the redundant write, commit the staged removals, close — no status row, no failure, no risk warning. Cowrite never claims session state is at risk when the two representations are materially identical.
3. **One comparison basis.** `affectedUntitledTabs` is derived **exclusively** from `proposedSessionPayload` vs `lastPersistedSession`: a staged removal *is* absence from the proposed payload, a new tab *is* absence from the snapshot, and buffer, displaced path, omission flag, hidden state, identity and ordering use the same two-payload comparison. Top-level active-tab/order changes are **attributed to the untitled tabs whose active status or position differs**. Where only project-tab or other top-level state differs, `wholeSessionDelta` is true while the set is empty — **the only path to the zero-tab copy**.
4. **Propagated** — `9c.8` mock annotations and tile title, `specs/recovered-document.md`, `specs/state.md`, `amendments/j2-recovery-document-over-cap.md`, `screen-map.md`, `README.md`, this changelog. Visuals, dialog copy, list bounds and platform treatments are unchanged.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-27 (4) — 9c.8 atomic close contract (PR #1833 / issue #1421)

**Only the quit contract changes.** All previously resolved behavior is preserved.

1. **Dirty-tab resolution is atomic with the final write.** The queue still runs first, but tab removals are **staged** until persistence commits: a successful Save writes its project file and **keeps its tab mounted**; a Discard is **recorded, not applied**. Cowrite composes the payload *as if* every staged close occurred, awaits one atomic write, and commits the removals only on success. On failure the staging is cancelled — every tab open, saved tabs saved, discarded buffers still available. `[Stay open]` cancels the attempt and retains all tabs; `[Try again]` **recomposes against current state** and retries the same plan; `[Quit without saving session]` **explicitly commits** the staged decisions and closes without updating the session. A dirty-tab Cancel or failed project-document Save still aborts before the write. The state inventory and copy now distinguish **decision recorded** from **tab removal committed**.
2. **Risk is defined against the last successful session snapshot** — named as the comparison point *and* the recovery baseline. `affectedUntitledTabs` is every untitled tab whose serialized record **differs materially** on buffer content, tab identity/presence, displaced path, over-cap outcome, hidden/expanded state, or active-tab / session-only restoration state. Explicitly **not** limited to non-empty buffers or notice changes: an empty *preserved* buffer can be affected.
3. **Failure wording corrected to risk-based.** Title is now *Couldn't save your latest session changes*; bodies are the ratified one-tab, N-tab and **zero-tab** forms ("…may not return if you quit now"). The reason line states the baseline: *Your previous saved session is still intact.* No claim that tabs "would not come back."
4. **Label list bounded, never elided.** All affected labels in a semantic `<ul>`, vertically scrollable at 96px (Win) / 104px (mac) inside a 420px / 440px dialog; title, body, reason and actions pinned. Overflow gives the list `tabindex="0"` and a visible `#2F5D8C` ring as one stop before the actions — no stop when it fits. Never "and others."
5. **Propagated** — `9c.8` mocks (four panes: awaiting, one-tab Win, seven-tab mac with scrolling list, zero-tab Win), `specs/recovered-document.md`, `specs/platform-variants.md`, `specs/state.md`, `amendments/j2-recovery-document-over-cap.md`, `screen-map.md`, `README.md`, this changelog.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/platform-variants.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-27 (3) — 9c.8 quit integration corrected (PR #1833 / issue #1421)

**Recovery-document behavior is unchanged.** Nine corrections to the quit seam and its dependencies.

1. **Amendment summary** — "adoption leaves no durable record" replaced by "no document-attached provenance field survives adoption; the durable post-adoption record is the D15 scratch-adoption timeline card."
2. **Destructive override** — `[Quit without saving session]` discards the only persisted copies of untitled work, so it now carries the binding destructive treatment (`#F8EFED` / `#DCC4BF` / `#A33A2E`). Still never default, never autofocused. `[Stay open]` remains default and autofocused; `[Try again]` remains neutral.
3. **Compact pane footers** — `No autosave — there is no project path yet.` now appears with `[Save As…]` in **every** `9c.1`–`9c.6` pane. Responsive reduction is defined: type steps to 10.5px, then the sentence wraps above the chip; it is never truncated or removed, and the only permitted substitute preserves it as an accessible equivalent.
4. **Mixed-tab quit ordering** — specified: dirty project-document queue first; any cancel or failed save **aborts the quit** with no write attempted; only then the awaited final write, composed to reflect every save, discard, tab removal and remaining untitled buffer; only a successful write or the explicit override closes the window; **a successful write never bypasses a pending dirty-tab decision.**
5. **Multiple untitled documents** — singular keeps the named copy; two or more state the count **and list the accessible tab labels**. A tab counts as affected on buffer content **or** unpersisted notice/collapse state.
6. **State ownership** — `sessionFlushOnQuit` removed from per-document state and replaced by per-window `closeAttempt`: `idle → resolving-dirty-tabs → awaiting-write → failed-decision → retrying | cancelled | overridden → closed`, with `affectedUntitledTabs` driving the dialog copy.
7. **Shared chrome and platform** — the delayed `Saving your session…` row is specified in the **shell status bar's leading slot** (`#F5F3ED` Win / `#F1EEE7` mac), not a new surface. Windows and macOS variants of the failure dialog are drawn in `9c.8` and tabulated in `platform-variants.md`; action order, destructive semantics, focus trap, Stay-open autofocus and `Esc` are identical on both.
8. **Screen map** — the non-path "src-tauri native close" is gone. The close seam maps to `src/stores/appLifecycle.ts`, session scheduling/composition to `TabbedEditor.tsx`, and FR-ED-3's mapping now covers the awaited final write and its failure/override transition.
9. **Propagated** — mocks, `specs/recovered-document.md`, `specs/platform-variants.md`, `specs/state.md`, `amendments/j2-recovery-document-over-cap.md`, `screen-map.md`, `README.md`, this changelog.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/platform-variants.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-27 (2) — 9-series consistency pass (PR #1833 / issue #1421)

**The editable `UntitledDocument` design is unchanged.** Eight review findings resolved.

1. **`specs/authoring-shell.md`** — the live `RECOVERED`/read-only tab rule is gone. It now describes the `UNTITLED` qualifier, **no dot** on a preserved recovery tab, **amber dot + amber qualifier** on an over-cap one, the `[Save As…]` pane footer, and links `9a`–`9c`. No toolbar and no status-bar save slot are invented.
2. **`9c.2` and `9c.6`** — the load-bearing sentence *"It doesn't bring back what wasn't kept."* is present in the short reason line and while the failure line shows. It is now specified as never dropped at any width; the provenance sentence goes first instead.
3. **Save-As failure styling** — unowned `#FCF4F2` / `#E9CFC9` / `#8C3A2E` removed. The line uses the bound **Reject / destructive** family from `tokens.md`: `#F8EFED` fill, `#DCC4BF` border, `#A33A2E` text. Mock and spec changed together.
4. **Provenance contract corrected** — the adoption timeline card is a **D15 transcript record**, so the trace *is* durable. "No durable post-adoption provenance" is replaced by "no document-attached provenance field survives adoption; the durable trace is the existing scratch-adoption timeline card", and appending the ratified sentence is now an explicit **implementation requirement**.
5. **Quit persistence resolved (`9c.8`, new)** — #1805's native close flushes the session best-effort **without awaiting it**, so no-guard-on-quit was unsafe as written. Quit now **awaits the final write**: a quiet `Saving your session…` row after 400 ms, and on failure the window **stays open** with an `alertdialog` — `[Quit without saving session]` (never default) / `[Try again]` (**success resumes the interrupted quit**) / `[Stay open]` (default, autofocused, `Esc`).
6. **Migration bounded** — only `recovered_from: Some(path)` + `unsaved_content: None` migrates to `recoveryContentOmitted: true`. A record normalized by #1805 to `unsaved_content: Some("")` is indistinguishable from a genuinely empty buffer and is **not** migrated: no notice, no possibly false warning. Recorded as a limitation with a stated disposition.
7. **Close guard** — `empty-over-cap` is now an **explicit variant** (body, neutral `Discard`, accessible name), not merely `discardsOnlyCopy: false`; `only-copy` keeps the destructive body. Both keep the three actions in order, `Cancel` autofocus, and `Esc`.
8. **Propagated** — amendment record, state inventory, screen map, README, mock annotations and this changelog.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/authoring-shell.md`, `specs/recovered-document.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-27 — revised J2 over-cap amendment ratified (PR #1833 / issue #1421)

**No visual or behavioral change.** Status only; `9a`–`9c` are untouched.

- **CJ ratified the revised over-cap amendment on 2026-08-27**, and PR #1833 applies its authoritative wording to `docs/ux-design.md` (J2) and, where it touches requirements, `docs/functional-spec.md`. It **supersedes the wording ratified 2026-08-26**, which assumed the withdrawn read-only pane — the conflict raised in the 2026-08-26 (7) entry is settled in favour of the revision.
- **Ratified with the text, as drawn:** the empty-buffer close-guard body with `discardsOnlyCopy: false`, and the decision that **loss provenance leaves no durable record after adoption** (the quiet scratch-adoption timeline card is the only trace). A durable post-adoption record would be a separate delta.
- `amendments/j2-recovery-document-over-cap.md` is now an **amendment record**: "Proposed insertion" → "Ratified insertion (as applied by PR #1833)". `README.md`, `specs/recovered-document.md`, `specs/state.md` and the mock's closing annotation no longer say the behavior awaits CJ. `9a`–`9c` are implementable as drawn.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-26 (7) — retargeted to the editable untitled document; 8a–8c withdrawn (PR #1833 / issue #1421)

**Read against current `main` after PR #1805 (`78ad0d196`).** The read-only draw is withdrawn and replaced.

### Why

PR #1805 delivers the **#1379 untitled/scratch document lifecycle amendment, ratified by CJ 2026-08-21**: the displaced recovery document is **editable**, implemented by `UntitledDocument` (`RecoveredDocument` is deleted), with autosave off by construction, its buffer persisted in the tab session, `[Save As…]` as the ratified adoption route, and close offering `[Save As…]` / `[Discard]` / `[Cancel]`. `8a`–`8c` specified the opposite on four points — read-only, no Save or Save As, confirmed-close-only exit, `RecoveredDocument` implementation paths — and are **withdrawn and not reissued**.

**Conflict raised for CJ, not settled here:** the over-cap wording ratified 2026-08-26 assumed the read-only pane, five days after the lifecycle it assumed had been superseded (ratified 2026-08-21). The amendment file is now a **proposed revision**, not a ratified record.

### Added — options `9a`/`9b`/`9c`

- **`9a`** (Windows) / **`9b`** (macOS): the editable over-cap pane — `UNTITLED` tab qualifier with amber dot, amber loss notice, standing-conditions strip, empty editable buffer with its own placeholder, pane footer stating no-autosave beside `[Save As…]`.
- **`9c`**: `9c.1` buffer preserved · `9c.2` over-cap untouched · `9c.3` message hidden · `9c.4` edits made after the omission · `9c.5` the D12 three-action close guard with **two bodies** · `9c.6` Save As failed/cancelled · `9c.7` after successful Save As, with the adoption timeline card.

### Decisions recorded

1. **The strip no longer says `Read-only`** — it reads `Editable · Untitled · Not in this project · Saved nowhere yet`, never dismissible, with `Editable` dropping first at narrow widths and `Saved nowhere yet` never dropping.
2. **Four honesty facts kept**, and a fifth sentence added to defend them: *"It doesn't bring back what wasn't kept."* Editing and Save As must never read as recovery; no `[Retry]`/`[Recover…]`/`[Compare]` in any state.
3. **Editing does not clear the notice.** Neither does a tab switch or a relaunch; while untitled there is no save that could.
4. **`[Hide message]`/`[Details]` persist across relaunch as hidden**, never as a clean pane.
5. **Successful Save As ends the state.** No notice, qualifier, dot or strip on the adopted document; both persisted flags leave the session record with the untitled tab. **Loss provenance does not durably survive adoption** — the quiet scratch-adoption timeline card is the only trace, extended with a second sentence stating the omitted work was not part of what was saved. A durable post-adoption record is **raised for CJ**, not drawn.
6. **Close composes with the existing guard.** Same modal, same three actions, same default (`Cancel`). New: an over-cap tab with an **empty** buffer gets an honest body ("closing it discards nothing") and `discardsOnlyCopy: false`, so `Discard` is not styled destructive. Quit still raises no guard.
7. **`recoveryContentOmitted` and the hidden/expanded flag remain explicit durable fields**; the `recovered_from` + `unsaved_content` pair stays migration-only — and is now doubly insufficient, since an author who has typed into the tab makes it non-null either way.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-26 (6) — post-ratification tense and requirement citation (PR #1833 / issue #1421)

**No visual or behavioral change.**

- **`amendments/j2-recovery-document-over-cap.md`** — the two remaining pre-ratification present-tense statements are recast historically: "The clause does not currently say what the author is told" → "Before this amendment, the clause did not say…", and "it records a state the clause is currently silent on" → "…was previously silent on".
- **`screen-map.md`** — the `8a`/`8b`/`8c` row now cites ratified **FR-ED-3** for durable session persistence of the over-cap outcome and the collapsed/hidden message state, alongside **FR-ED-8** for the displaced-document lifecycle, and names the ratified over-cap amendment in the `ux-design.md` column.

### Files regenerated

`amendments/j2-recovery-document-over-cap.md`, `screen-map.md`, `CHANGELOG.md`.


## 2026-08-26 (5) — J2 over-cap amendment ratified (PR #1833 / issue #1421)

**No visual change.** The 8a–8c treatment and all behavior are untouched; this refresh changes status only.

- **CJ ratified the J2 recovery-document over-cap amendment on 2026-08-26**, and PR #1833 applies its authoritative wording to `docs/ux-design.md` (J2 correlated-move clause) and, where it touches requirements, `docs/functional-spec.md`. `8a`–`8c` are implementable as drawn; the earlier hold ("do not implement before the amendment is ratified") is lifted.
- **`amendments/j2-recovery-document-over-cap.md` is now an amendment record**, not a proposal: heading and status rewritten, "Proposed insertion" → "Ratified insertion (as applied by PR #1833)", and the confirmed-close wording delta recorded as ratified as drawn. The file is a reference copy — `../ux-design.md` is the authoritative one.
- **`specs/recovered-document.md`**: "Not settled here" replaced by "Where each half binds" — behavior binds in the ratified `../ux-design.md` clause, appearance binds here. Claims that J2 does not record the behavior, and that the amendment is not applied, are removed.
- **`specs/state.md`**: the recovered-document entry no longer reads "proposed, not ratified"; it states that `8a`–`8c` are drawn against the ratified J2 amendment.
- **`README.md`**: amendment table row and the recovered-document section record CJ's 2026-08-26 ratification for PR #1833 / issue #1421; the do-not-implement hold is removed.
- **Mock annotation** ("Why only three states") updated from "the J2 amendment is required before 8a ships" to the ratified statement. No pixels changed.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-26 (4) — state binding and stale-string sweep (PR #1833 / issue #1421)

**No visual change.** The 8a–8c treatment is untouched.

- **`8c.2` is now bound to `recoveryContentOmitted: true`**, the explicit persisted outcome, rather than to `recovered_from: Some(path)` + `unsaved_content: None`. The pair keeps one narrow role — classifying the initial occurrence and migrating legacy session records written before the outcome field existed — and is explicitly **not** the durable definition: after a later serialization it cannot distinguish an omitted buffer from one that was never present, so the persisted outcome is authoritative.
- **"The discriminator is sound as it stands" removed** from `specs/recovered-document.md`, and **"no behavioral change is required to ship 8a" removed** from the `8c` annotation; that annotation now states plainly that the J2 amendment is required before `8a` ships.
- **"supersedes withdrawn 7a–7c" removed** from the turn-8 header. Withdrawal history lives in the 2026-08-26 (2) entry of this file only; no live spec or mock mentions the superseded model.
- **`[Hide message]` annotation cross-reference corrected** from `8c`.2 to `8c`.3 — `8c.3` is the collapsed state.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `CHANGELOG.md`.


## 2026-08-26 (3) — independent-review corrections to the 8-series (PR #1833 / issue #1421)

**The 8a–8c treatment and the J2 `RecoveredDocument` lifecycle are unchanged.** Five review findings resolved; the only visual change is one token.

1. **Destructive token.** `8c.4`'s `Close and discard` was `#8C3A2E`, an off-palette red. Now the binding Reject/destructive token **`#A33A2E`** (`tokens.md`), matching the comment-deletion confirmation. Spec updated to name the token rather than the literal alone.
2. **Withdrawn-model references removed.** `specs/state.md` still pointed at `document-notices.md` and `7a`/`7b`/`7c`; those references are gone, along with the withdrawal notes in `README.md` and `specs/recovered-document.md` and the trailing "Withdrawn: 7a/7b/7c" in `screen-map.md`. The withdrawal remains recorded here in the 2026-08-26 (2) entry, which is its proper home; no live spec mentions the superseded model.
3. **`screen-map.md` source paths corrected.** `src/stores/tabSession.ts` does not exist. The frontend session store is **`src/stores/tabs.ts`**; the persistence and cap contract is **`src-tauri/src/store/tab_session.rs`**. Both are now listed.
4. **"No behavioral change is required" is withdrawn.** That claim was wrong: the discriminator being unambiguous *at creation* does not mean J2 authorizes the design. Current J2 defines **none** of the over-cap notice, the persistent amber / `RECOVERED` state, `[Hide message]`/`[Details]`, the specialized confirmed-close wording, or persistence across quit and relaunch. `README.md`, `specs/recovered-document.md` and the amendment now state that the amendment is **required** and that implementation waits on ratification.
5. **Durable persistence added to the amendment.** The tab-session record must carry (a) the over-cap outcome and (b) whether the explanation is hidden. Reconstructing either from `recovered_from` + `unsaved_content` is insufficient: once the session is serialized again from a tab holding no content, an omitted buffer is indistinguishable from one that was never present. And hiding must survive quit/relaunch **as hidden** — the collapsed amber line and `[Details]` return; a clean pane never does. This is two persisted fields, not a derivation, with consequences in `src-tauri/src/store/tab_session.rs` and `src/stores/tabs.ts`.

### Files regenerated

`mocks/Cowrite Authoring Shell.dc.html`, `specs/recovered-document.md`, `specs/state.md`, `screen-map.md`, `README.md`, `amendments/j2-recovery-document-over-cap.md`, `CHANGELOG.md`.


## 2026-08-26 (2) — RecoveredDocument over-cap state; the 2026-08-26 notice-bar treatment is withdrawn (PR #1833 / issue #1421)

**This entry replaces the 2026-08-26 entry, which is withdrawn in full.** That refresh modelled the wrong lifecycle: it drew an *ordinary file-backed editor tab* recovering a session after relaunch. #1421 is about J2's **untitled recovery document** — the read-only tab created when a correlated move takes the path an open, dirty document occupied. Options `7a`/`7b`/`7c` and `specs/document-notices.md` are **removed from the bundle and not reissued**. Nothing in turns 3–6 or the #1720 rail model was touched by either refresh.

### Added

- **`specs/recovered-document.md`** — the recovery pane's anatomy (tab qualifier, loss notice, permanent conditions strip, read-only content), its three reachable states, transitions and persistence, final copy with an explicit prohibited-wording list, and accessibility/keyboard semantics.
- **`amendments/j2-recovery-document-over-cap.md`** — proposed J2 amendment text for CJ/engineering, with insertion point, rationale, what it does and does not change, and the one wording delta to ratify. **Not applied to the repository's `docs/ux-design.md`.**
- **Mock options `8a`** (Windows, over-cap, annotated), **`8b`** (macOS peer), **`8c`** (`8c.1` buffer preserved · `8c.2` over-cap · `8c.3` message hidden · `8c.4` confirmed-close exit). Every tile carries the controls and persistent indicators its spec requires.

### Changed

- `specs/authoring-shell.md` — the notice-bar row is removed from the column diagram; the tab strip now notes the `RECOVERED` qualifier instead of a persistent-status dot.
- `specs/state.md` — `isRecoveredDocument`, `recoveryContentOmitted`, `lossNoticeCollapsed` replace the withdrawn `recoveryOutcome` / `noticeDismissed`; the gaps entry is retargeted and records that §3's own document moments are **not** drawn by this folder.
- `README.md`, `screen-map.md` — retargeted to `8a`–`8c` and the real repo files (`RecoveredDocument.tsx`, `tabSession.ts`).

### How each contradiction in the independent review was resolved

1. **Wrong lifecycle.** Ordinary file-backed session recovery withdrawn; the pane drawn is J2's untitled recovery document, with no backing file, save path, autosave, dirty state or "last saved version" anywhere in the draw or the copy.
2. **Wrong cap.** "5 MB" → **2 MiB** (`2 * 1024 * 1024`), stated in the copy in the same units as the implementation, never rounded.
3. **False affordances and false clearing.** The old bar promised the notice would clear on the next successful save and asserted autosave stayed active. There is no save here, so both are removed: nothing clears the state but the tab's confirmed close.
4. **Unreachable variants.** "Recovered, nothing was unsaved" (a clean displaced tab just closes) and "per-tab unreadable recovery copy" (an unreadable session restores an *empty* session — no surviving tab) are removed. Three states remain.
5. **The discriminator objection is withdrawn.** It was raised against the wrong lifecycle. Within *this* one, a recovery document is created only for a dirty displaced tab and the cap is the only thing that removes its content, so `recovered_from: Some(_)` + `unsaved_content: None` has exactly one meaning. **No behavioral change is required to ship `8a`.**
6. **The UXR identifier is withdrawn.** `UXR-Q12` was claimed in error — it belongs to J11 dismissal/reopen work. No new identifier is claimed; this work is cited as *PR #1833 / issue #1421 recovery-document over-cap state*.
7. **Dismissal implied resolution.** `[Dismiss]` → `[Hide message]`, which **collapses** the notice to a persistent `Unsaved work not preserved` line with `[Details]`, keeping the amber tab dot and qualifier. No state of the pane reads as an ordinary empty document.
8. **Invented macOS chrome.** The macOS status-bar save slot is gone. Neither platform has one for this pane; the permanent conditions strip carries the standing facts and both platforms read identically. macOS' close-button dirty dot and "Edited" proxy-icon conventions are explicitly not used, since they mean unsaved changes to a file.
9. **Placement.** The notice moved from "below the toolbar" (this pane has no toolbar) to the top of the pane, above the conditions strip, and is never inside selectable content or any save path.
10. **Path ownership.** The copy now says the path *was taken by a moved document*; nothing implies the original path still belongs to this tab.

### For CJ

- **The J2 amendment is proposed, not ratified.** Appearance binds from this folder; the behavior it depends on does not exist in `../ux-design.md` yet.
- **One wording delta:** the confirmed-close body currently warns about destroying the only copy of the buffer, which is false in the over-cap state. `8c.4` draws both bodies; the amendment's third paragraph proposes the honest split.

### Carried forward unchanged

Footer watch-count semantics, skill-description overflow, and long-tree scrolling / sticky section labels remain the three known rail gaps.

## 2026-08-20 (2) — handoff reconciliation (no visual change)

**No mock pixels and no rail model changed in this refresh.** Options `6a`/`6b`/`6c` and every rail drawn in `1b`/`1c`/`2a`/`3a`/`3b`/`4a`/`4b` are byte-identical to the entry below. This refresh only makes the folder's own statements agree with each other and records what the repo integration resolved.

### Corrections to this folder

- **README vs. `state.md` on open questions.** The README claimed no appearance question was left open for the rail while `state.md` still listed row overflow and rail scrolling. Both now say the same thing: the **core rail appearance is settled** — anatomy, sections, row types, states, tokens and platform chrome bind as drawn — while **two edge cases remain known appearance gaps**, recorded in `state.md` "Known gaps" and not in this changelog as open CJ questions. `state.md`'s pointer to a changelog list is removed with them.
- **Section-label typography.** `authoring-shell.md` described the section labels as "same treatment as the header label," which was wrong in both directions: the header is 12.5px/500 `#4A463E`, no uppercasing, no letter-spacing; the section labels are the **section-label token** (`tokens.md`, 10.5px row) — 10.5px/500, `.1em` tracking, uppercase, `#8C8779`. The spec now references the token and states the contrast explicitly.
- **`FILES` → `PROJECT` is superseded.** The visual-delta line in the entry below described the header label as becoming `PROJECT`. That was an intermediate choice. **The ruled final header is the opened folder's name** (12.5px/500 `#4A463E`, no uppercase, no tracking, ellipsis-truncated) — as specified in `authoring-shell.md` and drawn in every mock. The intermediate line is kept for history and marked superseded in place.

### Conflicts resolved by the repo integration

- **`ux-design.md`'s J2 ASCII sketch — resolved.** The Phase A wireframe no longer shows the superseded `FILES` / `skills/` / `workflows/` tree; the repo integration updates the sketch to the Documents / Skills rail, so prose and sketch now agree.
- **`docs/test-matrix.md` — resolved.** The file was read and reconciled at this head; the pending FR-ED-9 rows were verified against these mocks. The matrix check passes at **410 rows** and **5,027 / 5,027 named tests**. The previous entry's note that the file could not be opened no longer applies.

### Still open — known gaps, not questions these mocks answer

- **Footer watch-count semantics** — `Watching folder · 1 file changed` counts against a tree that deliberately hides non-documents. What the count includes and what the footer should say is behavior `ux-design.md` does not record: a **J# delta for CJ**.
- **Skill-description overflow** — a long authored description wraps to two lines in `6a`; no maximum line count and no truncation are decided (the workflow path line truncates; the description does not).
- **Long-tree scrolling / sticky section labels** — every mock rail fits its content. The overflow behavior of a long tree, and whether `DOCUMENTS` / `SKILLS` / `WORKFLOWS` stick while scrolling, are undecided.
- **No dark mode** in this folder (`state.md` "Known gaps"); the rail inherits that gap.

## 2026-08-20 — project rail: Documents / Skills split (#1720, PR #1722 @ `8d5fff1d`)

New: mock options **`6a`** (Windows rail anatomy), **`6b`** (macOS peer) and **`6c`** (independent section states), and a rewritten **"Project rail"** section in `specs/authoring-shell.md` replacing "Files rail". The superseded single `FILES` tree is gone from every mock that drew it — `1b`, `1c`, `2a`, `3a`, `3b`, `4a`, `4b`.

**Status.** Requirements are ratified: **D27** and **FR-ED-9** (2026-08-18), with **FR-SKILL-5** unchanged. Behavior is the **#1720 amendment to J2 / §2 "Project rail states"**, ruled by CJ 2026-08-18 at the DH-7 gate. `ux-design.md` states that implementation waits for this CJ-owned visual refresh; this is that refresh. Appearance binds here, behavior binds there.

### J2 requirement → where it is drawn and specified

| J2 / #1720 requirement | Mock | Spec |
|---|---|---|
| Two labelled groups replace the single FILES tree | `6a` `6b`, and the rail in `1b` `1c` `2a` `3a` `3b` `4a` `4b` | `authoring-shell.md` → "Project rail", intro + **Section labels** |
| Documents preserves folder hierarchy | `6a` (`drafts`, `readme.md`, `research` — alphabetically interleaved) | "Project rail" → **Tree / Order, Folder rows, Document rows** |
| Documents shows only FR-ED-9 types, case-insensitively | `6a` `6b` (`interview-notes.txt` as an ordinary row) | "Project rail" → **Document rows**; `platform-variants.md` → active-row row |
| Non-documents are never muted or disabled rows | `6a` annotation "DOCUMENTS MEMBERSHIP"; the old `readme.txt` `#A39E92` row is deleted from `3a`/`3b` and the `(not editable)` row from `1b` | "Project rail" → **Document rows** ("no muted, greyed or *(not editable)* row treatment anywhere"), **What the drawing must not add** |
| Dot-prefixed and grounding-owned paths hidden | `1b` annotation | "Project rail" intro; membership carried by presence |
| Skills as disclosure rows with authored name + description | `6a` `6b` (Grammar review collapsed, Sermon review expanded) | "Project rail" → **Skill disclosure rows** |
| Expanded skill shows its owned document material | `6a` (`SKILL.md`, `checklists/severity-guide.md`) | **Skill disclosure rows**, second sentence |
| Workflows as file-backed leaf rows, not folders | `6a` `6b` (`tighten-hook`, `weekly-brief`, under the `WORKFLOWS` sub-label) | **Workflow leaf rows**, **`WORKFLOWS` sub-label** |
| Workflow name + project-relative path | `6a` (10.5px mono path line, truncating) | **Workflow leaf rows** |
| Ownership precedence: workflow leaf → deepest skill → Documents | `6a` — `tighten-hook` is drawn at `claude_skills/sermon-review/workflows/tighten-hook.md` and appears **only** as the workflow leaf, absent from the expanded Sermon review disclosure | `6a` annotation "OWNERSHIP PRECEDENCE"; `state.md` → `activeDocumentPath` |
| One active marker across both groups; no path twice | `6a` `6b` | "Project rail" → **Active row**; `platform-variants.md` → "Active document row (either rail section)" |
| One roving tab stop; Up/Down cross the boundary; Home/End whole rail; Right/Left expand/collapse; Enter/Space activate or toggle | `6a` (focus ring on `launch-notes.md` beside the active `positioning-brief.md`) | "Project rail" → **Focus row**; `6a`/`6b` annotations "TWO SECTIONS, ONE TREE" and "FOCUS VS. ACTIVE" |
| Independent Documents/Skills Loading · Updating · Ready · Empty · Failure | `6c` — nine paired tiles, each naming both sections' states, plus rail-wide `Project files unavailable` and the collapsed strip | "Project rail" → **Section status lines**, **Section `Try again`**, **Collapsed**; `state.md` → `documentsState` / `skillsState` / `projectRootUnavailable` |
| One section usable while the other loads or fails | `6c` tiles 1–2 and 7–8 | `state.md` (independent state vars); `6c` tile captions |
| Tokens, spacing, platform chrome, collapse/restore, workshop vs. authoring composition preserved | rails in `1b` (workshop) and `3a`/`3b`/`4a`/`4b` (authoring) are the same tree; `6c` collapsed strip | `tokens.md` (section-label row updated), `platform-variants.md` (four rail rows added) |

### Visual delta, precisely

- ~~Rail header label `FILES` → `PROJECT`~~ — **superseded** (see the 2026-08-20 (2) entry above): the ruled final header is the **opened folder's name**, 12.5px/500 `#4A463E`, no uppercase, no tracking. The single `⟳` now requests both sources. Windows keeps `‹‹` in the header; macOS keeps its title-bar pair.
- Section labels `DOCUMENTS` / `SKILLS` use the existing 10.5px/500/`.1em`/`#8C8779` label token. The only separation between groups is 10px of extra leading — **no** divider, nested scroll area or second header, because they are one tree.
- Skill rows are two-line (name 13px + description 11px `#8C8779`); workflow rows are two-line (name 13px + path IBM Plex Mono 10.5px `#8C8779`, ellipsis-truncated).
- **Deleted:** the muted `readme.txt` row (`#A39E92`, `padding:6px 17px`) from `3a`/`3b`, and `1b`'s `readme.txt (not editable)` row. Both contradicted FR-ED-9 twice over — `.txt` **is** a document, and non-documents get no row.
- Added row treatments: focus ring (2px `#2F5D8C`, `outline-offset:-1px`), retained-rows-under-update `opacity:.55`, section status line, section-scoped `Try again` chip, 44px collapsed strip.
- No new colors, type sizes, radii or spacing steps: every value above is already in `tokens.md`.

### Ruled during this refresh

**The rail header is the opened folder's name (CJ, 2026-08-20).** Not a generic `PROJECT` label: the header names the folder the user opened. Because it is a proper name it drops the section-label treatment — 12.5px/500 `#4A463E`, no uppercasing, no letter-spacing, ellipsis-truncated. `tokens.md` no longer lists it among the section labels.

**Documents shows what is in the folder (CJ, 2026-08-20).** One alphabetical list per level with folders and documents interleaved — `drafts`, `readme.md`, `research` — not folders-first, not type-sorted. **Consequence worth knowing:** with no folders-first grouping, a level holding many documents and one folder gives that folder no reserved position, so hierarchy is carried entirely by the chevron and indent. That is the cost of matching the folder; it is accepted knowingly, and it is why the chevron column stays fixed-width at every level.

**`WORKFLOWS` sub-label (CJ, 2026-08-20).** The workflow leaves read as more of an expanded skill's contents, so the Skills group now carries a `WORKFLOWS` label between its skill disclosures and its workflow leaves. Two alternatives were drawn — an outdent with a hairline, and this label — and CJ chose the label. It is folded into `6a`, `6b`, `6c`, all four shell rails and the lo-fi rails; the alternative is deleted rather than shipped alongside. The label is **inside** Skills, not a third section, and the two membership rules it needs (absent when discovery finds no workflows; directly under `SKILLS` when discovery finds no skills) are specified in `authoring-shell.md` and drawn in the new `6c` "Skills ready — workflows only" tile.

### Conflicts raised, not encoded

- **The footer's watch count vs. Documents' membership.** The rail footer still reads `Watching folder · 1 file changed`. Under FR-ED-9 the rail deliberately hides non-documents, so a count that includes changes to non-document files would report activity the tree can never show — and one that excludes them is a different claim than the words make. Which it is, and what the footer should say, is behavior `ux-design.md` does not record: a **J# delta for CJ**, left as-is here rather than quietly redrawn.
- **RESOLVED (2026-08-20 (2)) — `ux-design.md`'s own J2 Phase A wireframe still shows the superseded rail** — the ASCII sketch lists `FILES`, `skills/`, `workflows/` and a loose `readme.txt`. Its prose is fully amended; only the sketch trails, the same way J10's status lines trailed at `145c655c`. Worth flipping on the next repo edit so the two records agree. **Since resolved:** the repo integration updates the sketch to the Documents / Skills rail.
- **RESOLVED (2026-08-20 (2)) — `docs/test-matrix.md` could not be read** at this head — the file is past the size limit this project can fetch, so the **two pending FR-ED-9 rows were not verified against these mocks**. Nothing in this refresh depends on them, but the matrix rows should be re-checked by someone who can open the file. **Since resolved:** the file was read and reconciled, the FR-ED-9 rows verified against these mocks, and the matrix check passes at 410 rows and 5,027 / 5,027 named tests.
- **Still no dark mode** in this folder (`state.md` "Known gaps"). The rail inherits that gap; "preserve light/dark treatment" therefore meant preserving the single light treatment.

## 2026-08-20 — macOS tab strip: ⌘T hint removed (#1368)

**macOS tab strip: the ⌘T hint in platform-variants.md implies a new-tab shortcut ux-design.md does not record (#1368).** CJ's disposition: the hint was a mock artifact, not intended behavior. Cowrite gains no generic new-tab action and no `Mod-t` binding, and no replacement affordance is introduced in its place.

Visual delta — macOS options `3b` and `4b` only:
- Removed the right-aligned `⌘T` label from the document-tab strip. The strip's trailing flex slot is gone with it; the tab list is the strip's only content.
- Everything else in the strip is byte-identical: pill geometry (radius 7px, tabs padding 6px 12px, gap 6px), strip fill `#F7F5EF` and padding 8px 12px, the active white + 1px `#E3DFD6` + `0 1px 2px rgba(31,29,26,.05)` treatment, tab contents, and the `✕` close controls.
- **Windows options `3a`/`4a` are untouched** — their folder-tab strip never carried the hint.

Spec delta:
- `specs/platform-variants.md` "Document tabs" (macOS) no longer claims a right-aligned `⌘T` hint; it now records that the strip carries no keyboard hint.
- `specs/platform-variants.md` "Keyboard hints" no longer lists `⌘T`. It enumerates only hints backed by a real binding.

**Out of scope at the time (resolved in the 2026-08-28 (4) refresh): the neighboring `⌘⌥T` timeline-toggle hint** (`specs/authoring-shell.md` right cluster) is unchanged here. It carries the same "does ux-design.md record this binding?" question and needs its own disposition rather than a silent change alongside this one — flagged for CJ, not resolved.

*Repo-side companion (not this folder's to write):* `docs/test-matrix.md` **NI-tabbar-presentation** still records the absent `⌘T` hint as an unresolved deliberate omission. With this refresh the visual design agrees with the shipped tab strip, so that discrepancy note should be closed on the same commit that drops this bundle in.

## 2026-08-09 — comment correction states (D24 / FR-CMT-8..13)

New: mock options **`5a`** (Windows), **`5b`** (macOS) and **`5c`** (cross-surface), plus a "Correcting your own comment" section in `specs/comments.md`. `4a`/`4b` are unchanged and remain the canonical normal-state column.

**Status — ratified, both halves.** The requirements were ratified first (**D24**, **FR-CMT-8..13**, CJ 2026-08-05 under Q21). On **2026-08-09 (`145c655c`) CJ ratified J10** — *"Correct your own comment (revise or withdraw)"*, epic #1125, PR #1312 — **and resolved UXR-Q9** through these options. `docs/ux-design.md` J10 is authoritative on the behavior; this folder is authoritative on the appearance. Build from both.

*Provenance note:* the J10 ratification was made by CJ in session at the DH-7 gate, following the precedent `dev-harness.md` records for in-session DH ratifications. `ux-design.md`'s own J10 status lines (header delta, journey table, §5 checklist) had not yet been rewritten at `145c655c` and catch up on a later repo edit; this folder records the decision, not the paperwork.

**These mocks answer UXR-Q9.** That entry records three surfaces the mocks assert but do not draw — the delete confirmation, the withdrawn placeholder, and the inert/refused rendering of a menu item. `5a.1`/`5a.2` draw the confirmation, `5a.3` the placeholder, `5a.4`/`5a.5` the two refusals, with macOS peers throughout. `specs/state.md` "Known gaps" now declares what remains open rather than leaving the omission undeclared, which was UXR-Q9's second complaint.

**Superseded — the earlier J9 attribution.** Drafts of this entry recorded these states first as "ratified with J9 in PR #1312", then as having no journey at all. Both are wrong and both are replaced by J10 / UXR-Q9 above. For the record: **J9 and UXR-Q8 belong to project-open routing across instances** (#759, ratified by CJ 2026-08-09 under DH-7, PR #1150), and PR #1312 was **rebased** onto J10 / UXR-Q9 to clear that collision — `f4d8edd` is that rebase commit, the head this refresh was generated against, not necessarily the PR's current head. No design pixels changed across either correction — the attribution moved, the mocks did not.

Also unrepresented: **D25 / FR-CMT-14..18** (thread dismissal, epic #1162, proposed 2026-08-09) is undrawn. Dismissal shares this thread card and will want the same treatment once ratified.

Covers the six required states, both platforms: private delete confirmation, published-or-replied delete confirmation, withdrawn placeholder (plus a nested reply variant), the undecided-linked-changes refusal, the active-AI-run refusal, and the post-save edited marker — with a control-state tile (hover/focus/pressed/inert) per platform and a cross-surface strip for the editor popover and the timeline card.

Decisions worth knowing:
- The confirmation is the **in-place editing state's sibling**: same emphasized card, same header slot (`Deleting` where editing shows `Editing`), same button order on both platforms. No dialog, no new component family, no new tokens.
- **Destructiveness is encoded three ways** — `#A33A2E` fill, the explicit verb `Delete`, and a visible "can't be undone" line — so it never rests on color. No trash glyph.
- The withdrawn placeholder uses a **solid** hairline on the resolved fill; the Windows dashed border stays reserved for resolved.
- The inert `Delete comment` menu item is **muted neutral, not red** — red would advertise an action that is unavailable.
- The two refusals sit at **different levels** deliberately: linked changes block one control, so the reason lives under that menu item; an AI run blocks two, so the reason lives on the card. Neither carries `[Stop]`.
- **During an AI run the overflow menu stays available.** `Copy link to comment` and `Mark as resolved` remain active inside it and `Delete comment` goes inert; only `✎` and `Delete` are withheld. Muting `⋯` itself would hide two legal actions to block one illegal one.
- Confirmation copy never names an individual reviewer — a live review can have several readers.
- **A withdrawn placeholder keeps its anchor jump** (`5c.2`). Withdrawal removes the gutter icon, the anchor highlight and the open-state weight; it does not remove the route back to the passage. A surviving reply whose subject the reader cannot reach was the defect to avoid.
- **The hidden-threads chip counts placeholders** (`5c.4`). `N resolved threads hidden` is a claim about every item it counts, so it holds only where the hidden set is entirely resolved; a placeholder in the set moves it to the neutral `N hidden threads`. Activating it reveals the whole set, a withdrawn-only set included.
- `specs/platform-variants.md` now carries `5a`/`5b` explicitly, including the deliberate `Delete` → `Cancel` order on **both** platforms. The private variant reads *"…hasn't been shared and no one else has replied, so it will disappear from the document"* — it states both conditions FR-CMT-9 makes the no-residue case depend on.

## 2026-08-04 (2) — sync after ratification

No spec content changed. This refresh picks up the repo-side amendments made when `docs/design/` was ratified as the fifth peer constitution document (PR #1141, CJ 2026-08-04):

- **README** now states the folder is repo-binding, adds the escalation rule (a conflict between constitution documents, or a mock implying behavior `ux-design.md` does not record, goes to CJ — the reader amends neither), and records that the folder must not carry a duplicate `ux-design.md`.
- **`docs/ux-design.md` removed from this folder.** The only authoritative copy is `docs/ux-design.md` in the repo; specs now reference it as `../ux-design.md`.
- **Three open conflicts** raised by the first handoff are recorded as `ux-design.md` **UXR-Q7**, open for CJ. Until they are decided, do not treat the specs as settled on these three points:
  1. **Comments column vs. one timeline.** Hi-fi `4a`/`4b` put a 400px comments column in the right rail, displacing the timeline. §4 makes that rail a single stream including comment threads, and Principle 5 is explicitly "not four competing panels." This amends a ratified principle and needs a J# delta.
  2. **Display-mode placement.** `specs/authoring-shell.md` moves `Display: all markup ▾` and save state into the status bar under the "toolbar stays one row" rule; the FR-ED-1 amendment of 2026-07-31 (#1020) places `Display:` adjacent to the segmented control in the toolbar.
  3. **Reply collapse at 2+ replies** (`specs/comments.md`) is thread behavior with no J# home — capture or drop.

## 2026-08-04 — initial handoff

First bundle. Everything is new; there is no delta to work.

Covers:
- Authoring shell (journey 1c) at hi-fi for Windows 11 and macOS, in two rail modes (timeline visible, timeline collapsed + comments column).
- Comment system: gutter icons, thread card, reply collapse, in-place edit, overflow menu, resolved treatment, hidden-threads chip.
- Timeline rail: facet bar, summary rows, user message card, change-set card, composer with quote bar.
- Lo-fi wireframes for journeys J1–J8 plus settings.

Decisions worth knowing (these settled during design and are not obvious from the mocks alone):
- Toolbar is **one row**. Display mode and save state were moved into the status bar to keep it that way.
- Gutter icons are **anchored to their paragraph**, not positioned at fixed offsets in a gutter strip. Options `4a`/`4b` show the correct approach; `3a`/`3b` show the earlier fragile one.
- Reply collapse appears only at **2+ replies**; a single reply always renders inline.
- Timeline and comments share the right rail; only one shows at a time.
