# State and open questions

> **Current status (30).** `historyStatus` is `'saved-here'|'shared'|'newer-arrived'|null`, so `could-not-combine` is gone (ruling 4). Removed: `recovery.kind:'conflict'` and its `choice`, and the summary states `preparing`/`failed`/`reoffered`/`sentEarly` (ruling 6: `handoffSummary` is set at document creation or stays `null`). New: per-turn `divergedFrom: null|turnId` renders one `Continued on another computer` marker. Stored entries hold only messages, final replies, accepted handoffs and run links (ruling 5).

> **Status (29).** `historyStatus` is now `'saved-here'|'shared'|'newer-arrived'|'could-not-combine'|null` (brief’s four; unreadable is `null` plus the error card). New proposed: per-conversation `documentLink: 'live'|'missing'|'discarded'`, `relinkPicker: null|{docId, find}`, Workshop list group `notInProject` (collapsed by default); queued turns carry `capturedAt: {destination, also_open, selection}`; conversation `name: null` renders `New conversation` until the first reply. Decision 2 routes settled (no preview).

> **Status (28), revising (27).** `historyStatus` is now `'not-shared'|'shared'|'updated-elsewhere'|'conflict'|'unreadable'` (each pending Architect detection; fallback drops `shared`); recovery adds per-conversation `recovery: null|{kind:'too-long', route:null|'summary'|'turns'}|{kind:'conflict', choice:'both'|'local'|'remote'}`; `handoffPicker: {source, selected[], find}`; per-conversation `unseenOutcome: null|'finished'|'failed'` drives the tab/rail dot (F18). Open: F18–F21 and three Architect confirmations (`open-conflicts.md` (28)).

> **Status (27).** Turn 16 proposes per-document and Workshop agent conversations from PR #2692 (draft, not ratified). Proposed state, not yet binding: `selectedConversation: {kind:'document', docId} | {kind:'workshop', conversationId}`; per-conversation `facet`, `scroll`, `draft`, `pendingHandoff: 'pending'|'ready'|'edited'|'removed'|'failed'|null`; per-window `elsewhere[]` (running, permission, finished-unseen, failed); per-conversation `historyStatus: 'local'|'committed'|'pushed'|'pulled-newer'|'unreadable'|'conflict'`; per-project `migrationNoticeDismissed`. Open: the three PR decisions (`16h`) and findings F4–F17 (`16i`).

> **Status (26).** Turn 15 draws the Address all chooser in the main app's two hosts: the editor toolbar, and its `⋯` overflow at 900px. Opened from `⋯`, the chooser anchors 4px below it with right edges aligned, and focus moves to `Source`. Escape returns focus to `⋯`, an outside click leaves it with the clicked target, and after admission focus moves to the run card as Timeline expands (`15b`). The Timeline-header host is standalone-only (`15c`). CJ's final J4 rulings are applied, M11 included. **No conflict is open.** Carried from (24): the `14g` retryable-error cues are not shipped yet (`voice.md` §1a).

> **Current status (23).** Turn 14 matches the shipped voice and collapsed-host behavior (`14a`, `14b` redrawn; `voice.md`). **No design conflict is open:** the 900px fit is ruled (CJ 2026-10-02, #2641) and the error-click gap is closed (#2635). Validation gaps: physical microphone behavior and native Windows title controls.

> **Current status (20).** No design conflict is open. At export, two repo prose alignments remained: (A) J9 in-flight `✕` (CJ reversal, 2026-10-01) and (B) untitled comments. The issue #2531 import applies both in `docs/ux-design.md` alongside this generated folder; `amendments/2026-10-01-pending-prose.md` records the change. Until that import merges, the repo text wins on behavior. Everything else in this file that says *proposed* or *open* is either a listed gap or history marked with its refresh number.

## State

**Per window — close attempt**

`closeAttempt` is **per-window state, not per-document**: it belongs to the window's close attempt, spans every tab in it, and outlives any individual tab. Its central rule is that **a decision recorded is not a tab removal committed** — the two are separated by the atomic session write.

| Phase | Meaning |
|---|---|
| `idle` | No close attempt in flight. A close request with an active run is **refused here** (FR-X-11) and never advances |
| `resolving-dirty-tabs` | The dirty project-document queue is running. Saves write their project files; **discards are recorded, not applied**; **no tab is removed**. A `Cancel` or a failed save returns to `idle` and aborts the quit with no write attempted |
| `awaiting-proof` | Authoritative per-tab losslessness outcomes are being checked — from the write, or from a **no-write proof** where none was needed. **Confirmed exact** is the only exit that commits removals and closes. **Omission** clears the finalization lock, retains and recomposes the plan, and focuses the `live-over-cap` guard. **Unusable** is a typed `proof-unusable` failure that never closes |
| `awaiting-write` | Every decision recorded and `wholeSessionDelta` is **true**; the composed payload is being written, **awaited**. After 400 ms the status-bar row appears. All tabs still mounted. Success → `awaiting-proof`, never straight to `closed`. If `wholeSessionDelta` is **false** this phase is skipped and Emend requests an **authoritative no-write proof**, entering `awaiting-proof` — the proof is never skipped with the write |
| `failed-decision` | The write failed. **`stagedDecisions` is retained, uncommitted** — every tab and buffer still mounted, discarded buffers still available — because `[Try again]` and `[Quit anyway]` both act on it. The `alertdialog` is up |
| `retrying` | `[Try again]` **recomposed `proposedSessionPayload` from the retained plan** and re-issued. Write success → **`awaiting-proof`**; recomposition finding no delta → **no-write proof** → **`awaiting-proof`**; write failure → `failed-decision`, plan still retained. **Never a direct entrance to `closed`** |
| `cancelled` | `[Stay open]` or `Esc` — attempt abandoned, **`stagedDecisions` cleared without committing**, recorded discards not applied, every tab retained; → `idle` |
| `overridden` | `[Quit anyway]` — **abandons the current session delta and closes**. No durable commit is claimed or performed; the previous saved session is what reopens, and previous state may reopen with it |
| `closed` | Window closes. Reached from exactly two places: **`awaiting-proof` → confirmed exact** (removals committed), or **`overridden`**. Neither a write success, a retry success, nor a no-delta short-circuit enters here directly — all three route through `awaiting-proof` |

| Per-attempt variable | Meaning |
|---|---|
| `attemptGeneration` | **Attempt-scoped variable**, not a phase. Stable for the life of one close attempt; every async callback carries it and is discarded on mismatch. Repeated native close requests **join** this attempt, never start a second |
| `baselineValidity` | `valid` \| `none` \| `unverifiable` — selects the failure dialog's baseline clause |
| `stagedDecisions` | Per decided tab: `saved` (project file written, tab still mounted) or `discard-recorded` (buffer intact, removal not applied). **Ordinary removals commit only after the authoritative persistence proof returns confirmed exact**, whether the attempt wrote a payload or took the no-delta path. The explicit `[Quit anyway]` override remains its separate ratified commit-without-persistence path. **Retained across a write failure.** **Cleared without committing** by exactly three things: `[Stay open]`/`Esc`, a dirty-tab `Cancel`, or a failed project-document Save |
| `proposedSessionPayload` | The session composed **as if** every staged close had occurred. Recomposed from the **retained** plan on `[Try again]` |
| `wholeSessionDelta` | `proposedSessionPayload` **materially differs from** `lastPersistedSession`. **False ⇒ skip the write, not the proof**: request an authoritative no-write proof and enter `awaiting-proof`. No risk warning is shown for a materially identical session, but an omitted live buffer still stops the close |
| `lastPersistedSession` | **The latest canonical receipt** — the canonical stored session as the backend last authoritatively confirmed it. Never the raw pre-cap request, never the bytes read from disk. **Updated only from a confirmed receipt.** It is the comparison baseline throughout, and the recovery baseline that survives a failed atomic write |
| `affectedUntitledTabs` | Derived **exclusively** from `proposedSessionPayload` vs `lastPersistedSession`. A staged removal is the tab's absence from the proposed payload; a new tab is its absence from the snapshot; buffer, displaced path, over-cap outcome, hidden/expanded state, identity and ordering all compare across the same two payloads. Top-level active-tab/order changes are **attributed to the untitled tabs whose active status or position differs**. **Not** limited to non-empty buffers — an empty *preserved* buffer counts if new, staged for removal, or moved. Empty **while** `wholeSessionDelta` is true (only project-tab or other top-level state differs) selects the **zero-tab copy** |

**Per window**

| Variable | Values |
|---|---|
| `platform` | `'win'` or `'mac'` |
| `railMode` | `'timeline'` or `'comments'` |
| `timelineCollapsed` | boolean — persistent per-window preference; survives tab switches; set false by a run started outside a comment card (UXR-Q16.4), never by a permission request |
| `voiceState` | (17) `idle` \| `downloading(progress)` \| `recording(partial)` \| `transcribing` \| `error(device\|permission\|model)` — per window, shown on whichever mic surface is active; `frozen` is derived from the J12 freeze, not stored |
| `commentsLoad` | (17) per document — file-backed **and untitled** (19) — `pending` \| `loaded(threads)` \| `failed`; only `loaded([])` may render `No comments in this document` |
| `commentRunLink` | (17) per comment card `{ runId, sentText: boolean }` — `sentText` true only when the envelope carried `content` |
| `projectRailCollapsed` | boolean (Windows `‹‹`, macOS title-bar toggles) — was `filesRailCollapsed` |
| `documentsState` | `'loading'`, `'updating'`, `'ready'`, `'empty'`, `'failed'` — drives the Documents section only |
| `skillsState` | `'loading'`, `'updating'`, `'ready'`, `'empty'`, `'failed'` — independent of `documentsState`; either section renders its own result while the other transitions |
| `projectRootUnavailable` | boolean — the only rail-wide failure; replaces both sections |
| `expandedFolders`, `expandedSkills` | expansion is per section but preserved together across collapse/restore |
| `railFocusPath` | the one roving tab stop, across both sections |
| `activeDocumentPath` | the sole active row; a canonical project-relative path owned by exactly one section |
| `activeFile`, `openTabs[]` | tab strip |
| `editorMode` | `'richtext'` or `'markdown'` — **live on every pane, including a pathless untitled buffer**: it is a projection over the buffer's own text |
| `toolbarComposition` | Derived, not stored: `'file-backed'` or `'pathless'`. Selects whether `Share ▾` renders **at all**. **(20)** The comment group renders on both compositions at ≥1 comment. Never a disabled variant |
| `toolbarOverflow[]` | Derived from measured width. Trailing right-cluster controls collapsed into `⋯`, `Timeline ››` before `Share ▾`. **The toolbar is never two rows** |
| `contextGroup` | `'none'` \| `'redline'` \| `'comments'`. `'none'` is a **rendered state** — format group present, context group absent — **not an error and not a disabled group** |
| `displayMode` | `'all-markup'`, `'final'`, `'original'` |
| `renderFallback` | `null` (ordinary shell) or a **fallback instance**. Non-null replaces the whole window body — every variable in this table and every per-document variable below is unrenderable while it holds, because the tree that read them is gone. A new render failure after a remount is a **new instance**, not a mutation of this one (`render-failure-fallback.md`) |
| `fallbackContext` | `'author-project'` \| `'author-no-project'` \| `'reviewer'` \| `'unestablished'` — selects the copy row. Established **without consulting the failed tree**; where it cannot be, `'unestablished'` wins rather than a guess |
| `fallbackAgentActivity` | boolean — whether the author-project body renders its conditional third sentence. Only ever a **conditional sentence**, never a status row, clock or control |
| `closeGuards` | The set of guards that would normally block a close — dirty buffer, untitled buffer, active or awaiting run, unsent reviewer comment or suggestion. **Empty ⇒ the native close closes the window.** Non-empty ⇒ the close is **refused**, the fallback stays mounted and the status slot carries a mode-safe reason assembled from the guards actually holding. A refusal never moves focus (`render-failure-fallback.md` §5a, ruled 2026-09-04) |
| `statusSlot` | The fallback’s **one** status position and its **one** polite atomic live region — either the reload-failure line or a close refusal, **never both**. `null` otherwise |
| `reloadRequest` | `'idle'` \| `'pending'` \| `'failed'` — `pending` renders the inert, still-focusable `Reloading window…`; `failed` restores the button, keeps focus on it and inserts the one polite atomic status. A duplicate activation while `pending` **joins**; a new deliberate request clears `failed` before `pending` begins |
| `projectOpenStatus` | The shared status region's project-open occupant, or `null`. One message at a time, on welcome, authoring and workshop alike: `{ state, name, queuedCount, reasonCode, failureRoute, retry }` with `state` in `requesting` \| `already-open-here` \| `open-elsewhere` \| `opened-new-window` \| `failed` \| `close-blocked-by-run`. **`adopted-here` is not a value** — that outcome clears the region (J9 Phase B). A window holding no project can never hold `already-open-here`, `opened-new-window` or `close-blocked-by-run`. Identity governs repetition, queue suffix included (`project-open-status.md`) |
| `failureRoute` | **(14) Required whenever `state` is `failed`**: `'undetermined'` \| `'raise'` \| `'launch'`. **Selects the leading sentence, alone** — the renderer never infers the route from `reasonCode`, because `deadline_expired` and `registry_unavailable` each arrive on more than one route. No per-reason default; absent ⇒ render `undetermined`. Carried on TD-20's existing failed-outcome stream; the **Architect confirms this needs no new TD decision**, and the wording it selects was **ruled by CJ 2026-10-01** (`project-open-status.md` §7a) |
| `queuedCount` | Requests waiting behind the active one, in request order. `0` renders no suffix; `1` renders `· 1 more queued`; `n` renders the plural. **Never a list and never a second line** — each request's own FR-X-11 deadline runs from the user's act, not from its queue turn (behavior, J9 Phase A) |
| `projectOpenCloseRefusal` | **(15)** The `close-blocked-by-run` occupant's lifetime, in one rule: `Dismiss` is the **only manual clear** while the refusal is true; **completion of the blocking run clears it automatically**, whether completion precedes or follows a `[Show the run]` activation; **activation never clears it**; if activation and completion race the action still reveals the same now-completed card; and **the refused close is never resumed automatically** — the author initiates close again. **(16) Clear-time focus recovery:** if the automatic clear removes the band from under a control inside it, focus is restored to the **stable authoring target recorded when the close was refused**, with **`preventScroll`** so no scroll position moves; if that target is disconnected or unfocusable, the **shell-level close-attempt target** takes it; if `[Show the run]` already moved focus to the run-card container, or focus already sits on any other stable target outside the band, **focus is not moved**; `Dismiss` keeps its ordinary explicit-dismiss behavior, and recovery never completes the refused close (`project-open-status.md` §8, *How the refusal clears*) |
| `projectOpenRetry` | `'idle'` \| `'pending'` — `pending` renders the inert-but-present `Trying…` and puts `aria-busy` on the band; **`✕` stays (20)**. A duplicate activation **joins**. The band's **only** inert-but-present control |
| `projectOpenDismissible` | **(20) Always true** while the band shows. Dismissing during `requesting` or a pending retry hides the band without cancelling; the band **returns with the terminal outcome** (CJ 2026-10-01; prose pending at export, applied by issue #2531; `amendments/2026-10-01-pending-prose.md` §A). Superseded: (14)’s false-while-in-flight |
| `saveState` | saved + timestamp, or dirty |
| `agentConnection` | e.g. `Claude Code · connected` |
| `watchedFolderStatus` | file-change count for the rail footer |

**Per document**

| Variable | Notes |
|---|---|
| `threads[]` | `{ id, author, createdAt, anchorRange, body, replies[], resolved }` |
| `expandedThreads` | which threads have their middle replies expanded; not persisted |
| `selectedThreadId` | drives the `#E1E0F8` selected anchor + gutter icon |
| `editingThreadId` | at most one at a time |
| `menuOpenThreadId` | at most one at a time |
| `confirmingDeleteId` | thread or reply awaiting delete confirmation; at most one at a time |
| `withdrawn` | per comment/reply — drives the placeholder; a private, unreplied withdrawal leaves no row at all |
| `editedAt` | per comment — renders the edited marker only when published or replied to |
| `externalChange` | Per document — the FR-ED-7 unresolved choice: `null`, or `{ capturedDiskContent, phase }` with `phase` in `observed` \| `reloading` \| `reload-write-pending` \| `reload-failed`. Drives the integrity banner (`document-integrity.md`). While non-null, **writes to this path are paused** — behavior, bound in FR-ED-7, not here |
| `externalChangeSaveBlocked` | A manual or dirty-close Save arrived while `externalChange` was unresolved. **Appearance driver only**: it swaps line two of the banner for the blocked-Save sentence and moves focus to `Keep mine` — the single case where the banner takes focus |
| `compareOpen` | The read-only two-pane Compare region is showing. Closing it returns to the banner **with the choice still open** — Compare resolves nothing. Its hi-fi appearance is a known gap, below |
| `missingOnDisk` | The distinct FR-ED-2/7 lifecycle (#698, #933): no disk version exists. Shares the banner vocabulary, never the action set — `Keep editing` / `Save As…` / `Close…`, plus a persistent `Missing on disk` tab status. **Never conflated with `externalChange`** |
| `agentRefsCount` | Per agent message — the count of files that reply read, supplied by the run (`../ux-design.md` J2, #1391). **Appearance driver only**: it selects singular / plural / **absent** in the message footer (`timeline-rail.md`). `0` renders no footer row; this design has no representation for an *unknown* count and must not borrow the zero treatment for one |
| `correctionBlock` | `null`, `'linked-changes'` (count + route) or `'ai-run'` — drives the two refusals |
| `showResolved` | collapsed behind the hidden-threads chip when false |
| `commentSort` | `'position'` or `'recency'` |
| `changes[]`, `currentChangeIndex` | redline stepper (`3 of 14`) |
| `timelineFacet` | `'all'`, `'chat'`, `'comments'`, `'changes'`, `'findings'` |
| `composerQuote` | quoted range shown in the composer quote bar |
| `recoveredFrom` | present ⇒ this tab is J2's untitled recovery document — **editable**, no backing file, no save path, no autosave, never dirty, at no project path. Dropped entirely when `[Save As…]` adopts it |
| `untitledBuffer` | the tab's live text; the session snapshot is its only durable copy (debounced write, flushed on blur / tab-set change / close request) |
| `finalizationLock` | While a payload is composed and the attempt unresolved: `aria-busy` on the pane, `inert` on tab strip, notice, buffer and `[Save As…]`. Edits, tab mutation, notice toggling and Save As are **refused, not queued**. Cleared on `[Stay open]`/`Esc`, restoring prior focus |
| `saveAsLatch` | One single-flight latch shared by pane and guard Save As — one panel, one file write, one adoption, one provenance event. A second request **joins** the first |
| `displacedLabelOrdinal` | Stable `(n)` disambiguator per colliding displaced path, assigned at creation, never renumbered. Identical string in tab strip, accessible name and affected-documents list |
| `closeGuardVariant` | **Five values**: `only-copy` \| `live-over-cap` \| `omitted-with-edits` \| `restored-omitted-empty` \| `preserved-empty`. Each owns its body copy, `Discard` styling and `Discard`'s accessible name. Selected by state, never a flag on one body |
| `untitledSaveState` | per untitled tab — `{ saving, error }`; `saving` disables `[Save As…]`, `error` renders the non-modal failure line |
| `liveOverCap` | The buffer exceeds the 2 MiB cap **this session** — bytes present and editable, not durable. Drives `9e.1`; distinct from `recoveryContentOmitted`, and never converted into it while the bytes are live |
| `adoptionId` | Stable id minted per adoption; keys the durable provenance event and its D15 projection |
| `provenancePending` | A durable pending scratch-adoption event whose publication is unconfirmed. Survives relaunch; cleared **only** on confirmed append |
| `recoveryContentOmitted` | the recovery buffer exceeded the 2 MiB per-tab session cap and was not kept; the explicit persisted outcome that drives the loss notice in `recovered-document.md`. Dropped at adoption |
| `lossNoticeCollapsed` | per recovery tab — the explanation is hidden and the persistent one-line statement is shown. Persisted; returns as hidden after relaunch. Never means resolved; editing and Save As do not clear it |

**Per window — voice (22)**

| Variable | Meaning |
|---|---|
| `voicePresentation` | Rust-owned phase projected for every mic: idle · downloading(pct) · cancelling · download_cancelled · recording(elapsed) · transcribing · error(reason) · unavailable(reason) · frozen. One value, three surfaces |
| `voiceSettingsError` | Derived: reason ∈ {no_device, no_default_device, selected_unavailable, permission_denied}. Drives the Settings route and `aria-description="Opens Voice Settings"` |
| `settingsInitialSection` | `general` · `voice`; `voice` focuses the Voice heading once on open |
| `settingsReturnFocus` | The initiating mic; falls back to the Settings trigger if it is no longer visible and available |
| `modelAction` | Settings’ one model action: download · cancel · cancelling (held, disabled) · resume · retry · remove · stop-using (external) |
| `modelOrigin` | `VoiceStatus.model_origin`: managed · external · null (unverifiable). Selects `Remove local model` / `Stop using this file` / `Stop using this model`; external adds the note and `external_model_path` |
| `selectedDeviceName` | `VoiceStatus.selected_device_name`; drives `Unavailable: <name>`, else `Unavailable selected microphone` |
| `dictationTarget` | Editor: original caret or selected range, fixed at accept; the held range tint renders while recording |
| `timelineReturnCompact` | Derived: editor toolbar ≤300px. Selects the 44×26 return control; the switch may overflow into `⋯` (row order: switch, then format) |
| `timelinePermissionPending` | Badge on the same physical button; never changes width, position or focus |

## Known gaps

- **(17)/(18) Dictation is ruled and drawn** (UXR-Q14.1): `3c` states, `3d` fit; the mic never moves into `⋯` (CJ 2026-10-01). **(22)** Error recovery is **ruled and drawn** — no-device, no-default-device, selected-device-unavailable and permission-denied open Settings at Voice with the Voice heading focused and focus returned to the initiating mic on close; backend, model/download and transcription errors keep their retry (`14e`, CJ 2026-10-02, #2635). The comment-composer mic (`14c`), Timeline provisional text and editor multiline ghost (`14d`), Voice Settings (`14b`) and the whole-pane 55% freeze (`14f`) are drawn. Remaining: reviewer-mode placement (not decided). **(23) Validation gaps:** physical microphone capture, live download and inference, and native Windows title-control interaction. (The toolbar bundles IBM Plex Sans on both platform styles, so toolbar fit is not a platform-font question.)
- **(17) The overflow rule is measured** (`3d`) from IBM Plex Sans; the toolbar bundles Plex on both platform styles, so those thresholds are the shipped values. A context group carrying **both** tracked changes and comments is undrawn; its redline-then-comment order is ruled. The composed visual still needs a drawing.
- **(18) The `⋯` menu is drawn once** (`3d.7`, context controls relocated while the pinned mic records); other relocated sets follow the same listing rule.
- **The redline group's zero→one transition is undrawn.** The group appears when the first tracked change exists, which changes toolbar width mid-edit and may itself trigger the overflow. Whether that is animated, and whether the overflow decision is sticky within a session, is unspecified.
- **Project rail (`6a`/`6b`/`6c`) draws the #1720 Documents/Skills split** against ratified **D27 / FR-ED-9** and `../ux-design.md` §2 "Project rail states" + J2 as amended (ruled by CJ 2026-08-18, DH-7). Appearance binds here; membership, ownership precedence and keyboard behavior bind there. The **core rail appearance is settled** and binds as drawn. Two edge cases remain open and are recorded as the next two gaps below — row overflow and long-tree scrolling. Do not settle those two from the mocks.
- **Skill and workflow row overflow** — a long authored description wraps to two lines in `6a`; no maximum line count is decided, and no truncation is drawn for the description (only for the workflow path line).
- **Rail scrolling** is not drawn. Every mock rail fits its content; the overflow behavior of a long tree, and whether section labels stick, are undecided.
- **Timeline-expand transition** from the `Timeline ››` chip is unspecified — only the two end states are drawn.
- **Agent message card (`10a`–`10c`) is drawn** — attribution, reply body and the grounding indicator (#1817). Appearance binds here; the count's provenance, any which-files disclosure, and in-flight run presentation bind in `../ux-design.md` J2 and #1391. **No unknown-count treatment is drawn**, deliberately, and by CJ's 2026-08-28 ruling the card carries **no provider or model identity** — the `Agent` label plus the tile are the whole of its attribution.
- **"File contents changed on disk" (FR-ED-7) is drawn** — `11a`–`11c` and `specs/document-integrity.md` settle presentation, hierarchy, button treatment, focus, blocked-Save announcement copy, Reload progress and failure feedback, and the post-Reload dirty indication; wireframe storyboard `1n`. Behavior binds in `../functional-spec.md` FR-ED-7 and `../ux-design.md` "Document integrity & lifecycle moments" (#1599). It is **distinct from Missing-on-disk** by copy and action set, never by colour. Previously absent from this folder entirely.
- **The Compare destination is drawn at wireframe fidelity only** (`1n` frame 4) and remains a **known appearance gap**: pane typography, gutter, scroll sync, and whether differing regions are marked at all are undrawn. The two-pane read-only structure and the `Close`-returns-to-the-banner rule are settled; nothing else about it is.
- **The action set after a failed Reload recovery write is settled** — `Try again` (primary) · `Save As…` · `Compare`, with `Keep mine` **omitted** because the buffer already holds the disk version (CJ, 2026-08-28; `open-conflicts.md`). Not a gap. What *is* outstanding is implementation, not design: the shipping banner has **no reloading, write-pending or reload-failed presentation state**, so `11c.3`–`11c.5` are a bounded component follow-up rather than a restyle.
- **Missing-on-disk itself is still not drawn.** Its copy and actions are quoted in `document-integrity.md` only to keep the two moments distinct; no mock specifies its appearance, and `11a`–`11c` must not be used as its spec.
- **Format toolbar glyphs** are placeholders, not a decided icon set.
- **Hover / focus / pressed states** are drawn for the correction controls only (`5a.7`, `5b.7`); elsewhere, derive them from the existing app's conventions.
- **Comment correction (`5a`/`5b`/`5c`) draws J10 / UXR-Q9** (`../ux-design.md`, epic #1125, PR #1312) against ratified D24 / FR-CMT-8..13. **UXR-Q9 is resolved by CJ 2026-08-09 (`145c655c`)** through these options: its three undrawn surfaces — confirmation, withdrawn placeholder, inert/refused rendering — are answered by `5a.1`/`5a.2`, `5a.3`, and `5a.4`/`5a.5` and their macOS peers. **J10 is ratified by CJ 2026-08-09 (`145c655c`)**: appearance binds here, behavior binds in `../ux-design.md`. Raise, do not assume.
- **Undo of a correction is out of scope by decision** (FR-CMT-8: no trash, no restore, no toast) — the absence is deliberate, not a gap.
- **Untitled recovery document (`9a`–`9f`) is drawn** — J2's **editable** displaced-document pane and its over-cap state (PR #1833 / issue #1421), against `main` @ `f24dc462ae77` (PR #1805 lineage `78ad0d196`). Its lifecycle binds in `../ux-design.md`: J2's correlated-move clause plus the **#1379 untitled/scratch amendment ratified by CJ 2026-08-21** (editable, no autosave, `[Save As…]` adoption, three-action close guard). The over-cap state's own behavior binds in the **revised over-cap amendment, ratified by CJ 2026-08-27** (superseding the 2026-08-26 wording, which assumed the withdrawn read-only pane); the record is in `amendments/j2-recovery-document-over-cap.md`. Appearance binds here. `8a`–`8c` (read-only) are withdrawn.
- **No document-attached post-adoption provenance** — the adopted document carries no provenance field. The durable record is a **machine-local adoption event** keyed by a stable `adoptionId`; the D15 timeline card is a **reconstructible projection** of it. **Current `main` has no scratch-adoption card of any kind** — the card is new work. See `adoption-provenance.md`.
- **Ambiguous legacy sessions are never classified** — a record normalized by #1805 to `unsaved_content: Some("")` is indistinguishable from a genuinely empty buffer and receives no notice. A recorded limitation with a stated disposition, bounded to sessions predating the outcome field.
- **#1804 is retired (2026-08-28 (8)), not moved.** The gap recorded here until this refresh — *"rich-text / Markdown parity for an untitled buffer is out of scope: the pane is drawn as a plain buffer with no toolbar, matching what ships"* — became **false in every clause** with refresh (7), which is the pass that gives this pane a toolbar with both mode segments live and `editorMode` as a projection over the buffer's own text, needing no path. It is withdrawn. What refresh (7) genuinely leaves open on this surface is **dictation**, **the toolbar overflow breakpoint** (both above) and the zero-changes context group (immediately below).
- **The zero-changes context group is undrawn on the *file-backed* pane.** `9c`.1 draws format-present / context-absent on the pathless pane and the rule is written to bind on every pane, but `3a`/`3b`/`4a`/`4b` all draw a file-backed pane that already has changes. The ordinary pane's zero state — and whether the group's arrival is what trips overflow there too — is not drawn.
- **§3's own remaining document moments** — missing-on-disk and CRLF-on-open — are **not drawn** on the ordinary file-backed pane; do not derive those surfaces from this folder. (Changed-on-disk **is** drawn — `11a`–`11c`, `document-integrity.md`.)
- **(17) Empty comments column is drawn** (`4c`/`4d`, UXR-Q13.1 / Q14.3). Still undrawn: the comments column while its load is **pending or failed** (must not claim zero), no-changes and no-timeline-activity empties. The recovery-document states in `recovered-document.md` are lifecycle states rather than empty states.
- **(22) Dark is drawn for the 14-series only** (`14a`–`14f`), from Emend’s own dark palette; it is not a dark mode for the rest of this folder. **(23) Evidence by surface:** dark is captured for the mic chip (`docs/alignment-voice-dark/`), editor ghost (`docs/alignment-editor-ghost/`), composer and Timeline errors (`docs/alignment-voice-composer-errors/`) and Voice Settings/model states; the 900px toolbar captures (`14a`) are **light only**, and the J12 frozen pane (`14f`) has light captures only. **(22) Responsive rules drawn:** the 900/1000px collapsed-host fit (`14a`) and the sub-560px Settings dialog (`14b`).
- **(26) Dark is also drawn for turn 15** (Address all chooser).
- **No dark mode** outside the 14-series and turn 15, and no responsive behavior below 1400px window width — **except two carve-outs**: the **14-series** 900/1000px toolbar rules (`14a`) and sub-560px Settings dialog (`14b`), binding per `voice.md` §2–§3; **(26)** the 900px Address all chooser (`15b`): first control into `⋯`, anchored to `⋯`, binding per `comments.md` *Address all chooser*; and the **9-series**, which is carved out and binding: the loss notice's wrap and its never-dropped final sentence, the standing-strip drop order, the pane-footer reduction, and the `9c.8` dialog's label-list bounds and action stacking rule are binding appearance, not illustrative (`recovered-document.md`).
- **The render-failure fallback (`12a`–`12e`) is drawn** — the fatal whole-window state this list recorded as **absent** until this refresh (#2130 / J15). `render-failure-fallback.md` settles the window, the terminal `#EDEAE3` body, the content column, all four copy rows plus the conditional agent sentence, the two focus-ring tokens, the mount transition and focus order, the one control's three states, and the polite atomic failure status. **Behavior is `../ux-design.md` §2 *Render-failure fallback states* + J15 — proposed at the DH-7 gate, not ratified.** Its long list of absences (no `Dismiss`, no in-surface close/discard, no raw detail, no toast, no stale agent activity, no permission controls, no reassurance clause) is **ruled, not undrawn** — see §6 of that spec.
- **What the fallback leaves open, deliberately:** the **pending → success transition** is undrawn (the ordinary entry path owns its own first frame), and the two behavioural questions open at refresh (9) are now **recorded in J15** (accepted 2026-09-04) and drawn: the **Principle 3 / J7 exception**, and **native close** (`12f`, §5a — safe close when no guard applies, otherwise refuse and keep the work). Both are **recorded in J15**, and the two refusal strings in `12f` are **adopted in §2** — neither is an open question.
- **(14) The band holds ONE line, in every state.** Refresh (13)'s two-line failure (~56px) and its sub-560px wrap are **withdrawn**: §4 and **UXR-Q15** constrain this shared region to one line-height with **clipping, not wrapping**, and §2's *Unattributed internal failure* states it outright. The failure's reason is the **tail of the same message run** in `#6B665C`, and `project-open-status.md` §9 fixes the order in which things give way — reason first (and it may vanish entirely), then the name to a 160px floor, then the fixed words last; actions never. CJ ratified the **one-line** failure on 2026-09-14; a second line is not part of this design.
- **Project-open progress and outcomes (`13a`–`13h`) are drawn** — the #1752 / J9 / FR-X-11 states in the shared status region, including **the welcome surface, which `../ux-design.md` §4 recorded as undrawn** ("`1a` carries no status region and predates this decision"). `project-open-status.md` settles that the existing one-line band and its placement are **adopted, not replaced**; the welcome placement (below the platform title bar, above the welcome column, full width, pushing not overlaying); hierarchy, action order (message · one contextual action · `Dismiss`), platform button treatment and every control state; the one polite atomic live region; and the clipping rules. Behavior binds in J9 + §2 *Project-open routing states*, **ratified by CJ 2026-08-09 (#759)**.
- **(18) J9: the three conflicts and the `failureRoute` gap are ruled by CJ (2026-10-01)** — `✕` present in flight with the band returning on outcome; the three leading sentences selected by `failureRoute`; facet changes to `all` only when it would hide the run. Items 5–8 of `project-open-status.md` §11 were already ratified into the repo on 2026-09-14; the October 1 in-flight `✕` reversal is the one J9 prose alignment carried by issue #2531.
- **Three project-open states are unreachable on the welcome surface** — `Already open here`, `Opened in a new window` and `Close blocked by a run`, because that window holds no project (D26). That is a consequence of the routing rule, **not an appearance gap**; the matrix is `project-open-status.md` §2 and `13e`. Reviewer mode has no project-open entry point, so none of the seven reaches it.
- **(14) The band claims NO responsive carve-out.** Refresh (13) recorded a sub-560px two-line rule as a second carve-out from the no-responsive-behavior rule below; it is withdrawn with the wrap. One line-height holds at every width the app allows, so nothing about the shell at any width is claimed here. **The carve-outs remain the 9-series and the 14-series** 900/1000px toolbar (`14a`) and sub-560px Settings (`14b`) rules.
- **(14) `13d` is an actual workshop surface, and the collapsed rail is not empty.** Two drawing errors in (13) are corrected: `13d` was labelled *workshop* and drew a document workspace — it is redrawn to **J2 Phase A** (no document open, conversation centre-stage, project-home strip, project rail with no active row, no tab strip / editor toolbar / document status bar / right rail, composition per `10c` and `6b`); and the collapsed right rail in `13h.1` was drawn **absent** — §4's *Right-rail occupancy* gives it to the **comments column**, so it is drawn that way, with `[Show the run]` **replacing the occupant** through the rail's one existing `Timeline ‹‹ / ››` control. **No second collapse mechanism is proposed**, and **UXR-Q13.1** was ruled by CJ on 2026-09-30 and the no-comments branch is drawn in `4c`; `13h.1` draws the has-comments case only.
- **The shell around the band in `13c`/`13d`/`13h` is lifted context at reduced detail**, drawn to `authoring-shell.md` (project rail 236px, right rail 372px, project-home strip), `comments.md` (the comments column occupying a collapsed-timeline rail) and `timeline-rail.md` (`TIMELINE` header row, five facet pills at radius 12px). Those specs remain authoritative for every one of those parts; refresh (13) adds nothing to them and must not be read as restyling them.
- **The in-flight agent run card is still undrawn**, and `13c`/`13h` do not change that: the `Agent · working` card there is **illustrative context**, labelled as such in both options, exactly as the 12-series labels lifted platform chrome. In-flight run presentation binds in `../ux-design.md` J2 / #1391. Only the **destination** binds from `13h` — **(14, boundary clarified 15)** the card revealed **whole with 12px top clearance only when `cardHeight + 12px <= timelineViewportHeight`, and top-aligned with the same clearance otherwise** — the clearance is part of what must fit, so a card that would fit alone but not with its clearance takes the tall-card branch (§4's ratified #1324 submit-scroll rule, reused), carrying the app's ordinary 2px `#4F46E5` ring at `outline-offset:-1px`, with focus on the card container and never on `[Stop]`. The illustrative body text in `13h.3` exists only to make the taller-than-viewport case drawable.
- **Clone-from-GitHub progress is undrawn.** J9 routes a completed clone through the same four outcomes; the clone's own progress presentation is not in `13a`–`13h` and must not be derived from them.
- **Gutter icon collision** behavior (two anchors on adjacent lines) is described but not drawn.


## Architecture ownership

Five mechanisms this design depends on are the Architect’s, named here so the handoff does not imply this folder settled them.

| Dependency | What this design requires |
|---|---|
| **Per-tab persistence receipt** | The write returns authoritative per-tab losslessness outcomes; `Result<(), CommandError>` is insufficient. **It must also expose a no-write proof / preflight** — the same attestation against the stored session with no write performed — because the no-delta and retry-no-delta paths need it to close. Shape, signature and transport are the Architect’s |
| **One logical writer per project tab session** | Via D26 enforcement, backend per-session-path serialization/CAS, or both |
| **Adoption-event lifecycle and dedupe** | Durable phased event store, crash-safe recovery at every boundary, idempotent dedupe by `adoptionId` (`adoption-provenance.md`) |
| **App-wide Quit coordination** | A coordinator that runs a **non-mutating** active-run/eligibility preflight across all windows first, then processes windows **sequentially** through their existing per-window state machines. **Bounded, not atomic:** a later refusal stops the remaining windows but never reverses closed windows or completed project Saves |
| **Migration semantics** | In-memory canonicalization, malformed-record disposition, and the version/downgrade contract |

## Transition coverage and test oracles (#1833)

Every transition across `9a`–`9f` has an assigned outcome and an oracle. Ratified dispositions marked **[CJ n]**. **49 rows.**

| Source / state | Action | Outcome | Oracle |
|---|---|---|---|
| 9a–9f | Restore, legacy `unsaved_content: None` | Migrate → `recoveryContentOmitted: true`, expanded | Notice renders; flag set in canonical session |
| 9a–9f | Restore, legacy `Some("")` | **Not** migrated; no notice | No notice; no flag written |
| 9a–9f | Restore, malformed record | Offending flags dropped | No notice; flags absent after canonicalization |
| 9a–9f | Serialize at exactly the cap | Content **kept** (at-or-under boundary) | Buffer restores intact after relaunch |
| 9a–9f | Serialize over the cap | Omitted from the session; tab enters **live-over-cap** [CJ 4] | Live bytes still editable; receipt reports omission |
| 9a–9f | Relaunch after omission | **restored-omitted-empty** | Buffer empty; omission notice; no live warning |
| 9a–9f | Hide → relaunch | Returns **as hidden**, Details intact | Collapsed line renders after restart |
| 9a–9f | Edit a restored omission | Notice unchanged; no dirty dot | Notice present; tab not dirty |
| 9a–9f | Edit back to empty | Guard variant **restored-omitted-empty** ("empty now") [CJ 3] | Body says "empty now"; Discard neutral |
| 9a–9f | Preserved buffer genuinely empty | Guard variant **preserved-empty**; no omission copy [CJ 3] | No omission text; guard still raised |
| 9a–9f | New edits exceed the cap | **9e.2** composed notice, two facts separate [CJ 4] | Both statements present, rule between them |
| 9a–9f | Pane Save As success / cancel / failure | Adopt / no-op / pane status line | Document unchanged on cancel and failure |
| 9a–9f | Guard Save As failure | Rendered **inside** the alertdialog | No pane-only failure while the modal is up |
| 9a–9f | Save As re-entrancy | Second request **joins** the first | One panel, one write, one adoption, one event |
| 9a–9f | Close guard, all five variants | Correct body + Discard styling | Variant by state; three actions, Cancel autofocus, Esc |
| 9a–9f | Mixed dirty Save / Discard / Cancel / failure | Cancel or failure **aborts** before the write | No write issued on abort |
| 9a–9f | Queued / in-flight session writes | One serialized lane; finalization drains first | No concurrent write observed |
| 9a–9f | Finalization focus | Focus moves to the shell close-attempt target **before** the pane goes inert | activeElement never inside an inert subtree |
| 9a–9f | Write succeeds | → **`awaiting-proof`**, never straight to `closed` | No close without a confirmed proof |
| 9a–9f | `wholeSessionDelta = false` | Skip write → **authoritative no-write proof** → `awaiting-proof` | Proof requested though no write occurred |
| 9a–9f | Retry write succeeds | → **`awaiting-proof`** | The state machine exposes no edge from a retry write success straight to `closed` |
| 9a–9f | Retry finds no delta | **No-write proof** → `awaiting-proof` | Proof requested; no write |
| 9a–9f | `awaiting-proof` → confirmed exact | **The only path that commits removals and closes** | Receipt lists no omission |
| 9a–9f | `awaiting-proof` → omission | Clear the finalization lock, retain and recompose the plan, focus the live-over-cap guard [CJ 5] | Lock released; guard focused; plan intact |
| 9a–9f | `awaiting-proof` → unusable | Typed **proof-unusable** failure; **never close** | Unverifiable-baseline copy; window stays open |
| 9a–9f | Final write failure | Plan **retained**; dialog up; nothing closed | stagedDecisions intact |
| 9a–9f | Retry repeated failure | Dialog stays; plan retained | Generation-tagged callbacks; single modal |
| 9a–9f | Retry in flight | One modal, actions disabled, aria-busy, further closes joined | No duplicate dialog or close |
| 9a–9f | Stay open / Esc | Attempt cancelled, plan **cleared**, prior focus restored | All tabs retained; pre-attempt focus |
| 9a–9f | **[Quit anyway]** [CJ 2] | Session delta abandoned; closes; **no durable-commit claim** | Copy discloses previous state may reopen |
| 9a–9f | Next launch after [Quit anyway] | Previous saved session reopens | Discarded tabs / older buffers may return, as disclosed |
| 9a–9f | Repeated native close, any phase | **Joins** the attempt | Exactly one queue, plan, write, dialog, close |
| 9a–9f | Active run on close [CJ 7] | FR-X-11 refusal; nothing composed | closeAttempt never leaves idle |
| 9a–9f | Duplicate displaced labels | Stable (n) ordinal | Identical string in strip, a11y name, dialog list |
| 9a–9f | Project-tab-only change | Untitled tabs **not** marked | affectedUntitledTabs empty; zero-tab copy |
| 9a–9f | Adoption `prepared`, crash **before** the file write | **Tombstone**; untitled document intact | No file; no card; buffer and flags unchanged |
| 9a–9f | Adoption `prepared`, file written but phase not promoted | **Authoritative reconciliation** — never a guess | Reconciliation runs on relaunch |
| 9a–9f |   …verified file success | Promote to `file-committed`, then project **exactly once** [CJ 1] | Exactly one card per adoptionId |
| 9a–9f |   …not verifiable | **Remains non-projectable**; surfaces reconciliation pending; **never publish or tombstone on a guess** | No card; no tombstone; retried later |
| 9a–9f | File saved but `prepared → file-committed` fails (same session) | The adoption **succeeded**: show **provenance pending**, not a Save As failure; non-projectable; auto-retry; **never duplicate the card** | Document is a project document; pending line; one card ever |
| 9a–9f | Adoption `file-committed`, crash before publication | Projection completes on relaunch, once | Exactly one card per adoptionId |
| 9a–9f | Adoption cleanup failure | **Never** publishes a false adoption | No card without file-committed |
| 9a–9f | Baseline valid / none / unverifiable | The three reason clauses | Correct clause per baselineValidity |
| 9a–9f | App-wide Quit — non-mutating preflight | Active-run/eligibility only, all windows; refusal stops before any decision or write | No window decided, wrote, removed or closed |
| 9a–9f | App-wide Quit — sequential processing | Each window runs its own close state machine | Per-window attempt generations |
| 9a–9f | App-wide Quit — later Cancel / failure / refusal | Stops the remaining windows; **closed windows stay closed, completed Saves stay saved** | No rollback attempted or claimed |
| 9a–9f | Downgrade through an older writer | **Unsupported / lossy**, recorded | New fields absent after an old-binary rewrite |
| 9a–9f | Forced termination / crash / kill | **Out of scope**; no guarantee | Not tested; not claimed |
| 9a–9f | Windows / macOS parity | Identical order, semantics, focus, Esc | Only chrome differs |
