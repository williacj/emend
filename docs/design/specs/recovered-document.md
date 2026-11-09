# Untitled recovery document (the editable displaced-document pane)

Draws J2's **untitled recovery document** — the tab Emend creates when a correlated move takes the path an open, dirty document occupied — and specifies the **over-cap state** where the displaced buffer exceeded the 2 MiB per-tab session cap and was not kept (PR #1833 / issue #1421).

Behavior sources: `../ux-design.md` J2 correlated-move clause (CJ 2026-08-11, wording ratified 2026-08-12) and the **#1379 untitled/scratch document lifecycle amendment, ratified by CJ 2026-08-21** — the pane is **editable**, autosave is off by construction, and `[Save As…]` is the ratified adoption route. Drawn against current `main` after **PR #1805** (`78ad0d196`).

Options: `9a` (Windows, over-cap, annotated, full window), `9b` (macOS peer, with the untitled title bar), `9c` (states, Save As outcomes, close guard; the dictation comparison `9c.9` is **superseded (17)** by `3c`/`3d`), `9d` (finalization, guard-hosted failure, duplicate labels), `9e` (live over-cap and the composed worst case), `9f` (run refusal, provenance pending).

> **Revised 2026-08-28 (7): this pane now carries a toolbar.** It previously had none, and the loss notice sat at the top of the pane for that reason. Both facts are superseded below.

> **Supersedes the read-only draw.** `8a`–`8c` specified a read-only pane with no Save, no Save As and a confirmed-close-only exit, against `RecoveredDocument`. That component is deleted and that lifecycle is gone; the options are withdrawn and not reissued. Withdrawal history lives in `CHANGELOG.md`.

## What this surface is — and is not

| It has | It does not have |
|---|---|
| A tab, named for the path it was displaced from, carrying an `UNTITLED` qualifier | A backing file, a project path, or a rail row (while it is active, **no rail row is marked active**) |
| An **editable** buffer (in the over-cap state, an empty one) | Autosave, a dirty state, a save path, or a status-bar saved-state slot on either platform |
| `[Save As…]` — the only route into the project, which **adopts** the buffer at a chosen path; comments can be created before adoption | `Share ▾`, `Ask agent`, or any other control that needs a path |
| **The ordinary editor toolbar**, in the pathless composition (`authoring-shell.md`) — mode switch, format group, redline group at ≥1 change, **comment group at ≥1 comment (20)**, mic, `Timeline ››` | A dirty state or a dirty dot — **giving it a real editor is exactly when someone would wire dirty tracking in; there is nowhere to put it** |
| Durable persistence with the session across quit and relaunch | Any state in which a save clears the over-cap notice — there is no path to save to while it is untitled |

It is **not saved anywhere until `[Save As…]` succeeds**, and no part of this surface may imply otherwise.

## Anatomy, top to bottom

1. **Tab.** `UNTITLED` qualifier — 10.5px/500, `.06em` — before an italic displaced path. Over-cap: qualifier `#8A6614` with a preceding 6px `#B5871F` dot. Buffer preserved: qualifier `#6B665C`, **no dot**. The dot means *earlier unsaved work was not preserved* — never *unsaved changes*, which this tab cannot have (it is never dirty).
2. **Toolbar.** The ordinary single-row editor toolbar in its **pathless composition** — `Rich text | Markdown` and the format group live, the redline group present only at ≥1 change, the comment group present at ≥1 comment and absent at 0, the mic present, `Share ▾` **absent rather than disabled**, and `Timeline ››` unchanged. `#FAF8F3`, 1px bottom `#E3DFD6` (macOS `box-shadow: 0 1px 0 #DCD7CC`), full column width. **One row; anything over budget goes to a `⋯` overflow.** Composition and the overflow order bind in `authoring-shell.md`.
3. **Loss notice** — amber, over-cap only. The app's existing non-modal amber document-notice vocabulary, in the **document-notice slot: immediately below the toolbar, above the standing-conditions strip** (`authoring-shell.md`) — the same slot the FR-ED-7 banner takes on a file-backed pane. **The toolbar does not move** when the notice mounts, is hidden, is re-expanded, or gains a failure line; only the document region reflows. The earlier placement at the top of the pane was justified solely by there being no toolbar, and that premise is gone. Fill `#FBF3E1`, 1px `#E0C98C` bottom (macOS `box-shadow: 0 1px 0`), padding 11px 16px, gap 10px, 6px `#B5871F` dot at `margin-top:5px`; consequence line 12.5px/1.45/500 `#8A6614`, reason 11.5px/1.5/400 `#8A6614`; `[Hide message]` as the standard chip (11.5px `#1F1D1A`, `#FCFBF8`, 1px `#D5D0C4`, radius 5px; macOS radius 7px, hairline `0 0 0 1px #DCD7CC`). At narrow widths the action **wraps below the text**; the message is never truncated.
4. **Save-As failure line** — non-modal, `role="status"`, only after a failed attempt, **inside the same slot, directly below the notice and above the strip**. It uses the bound **Reject / destructive family** from `tokens.md` and nothing else: tint `#F8EFED`, border 1px `#DCC4BF`, text `#A33A2E`, 11.5px/1.5. No unowned colors. Never a dialog.
5. **Standing-conditions strip** — always present, never dismissible: `Editable · Untitled · Not in this project · Saved nowhere yet`, 11.5px `#6B665C` on `#FAF8F3` (macOS `#F7F5EF`), 1px `#E3DFD6` bottom, separators 1px × 12px. Neutral, because these are standing conditions of every untitled document, not a warning. **Drop order when the column is too narrow:** `Editable` first, then `Not in this project`; `Saved nowhere yet` never drops.
6. **Buffer.** Editable, in the document serif at 15px/1.7 `#33302A`. Empty in the over-cap state, carrying the buffer's own placeholder in **`#6B665C`** — the instructional line is normal-size body text and must meet normal-text contrast; the `#A39E92`/`#B5B0A4` placeholder tints are for inert field hints, not for a sentence telling the author what to do: *Nothing was recovered into this document — you can start writing here.* A placeholder, not content — it disappears on the first keystroke and is never selectable text.
7. **Pane footer — present in every state.** `No autosave — there is no project path yet.` (11.5px `#8C8779`) at the left, `[Save As…]` chip at the right. This replaces the status-bar saved-state slot, which this pane has on neither platform. It appears in **all** of `9c.1`–`9c.6`; there is no state of this pane without it.

   **Responsive reduction is defined, not improvised.** Below the width at which the sentence and the chip fit on one line, the footer keeps both but drops the type step to 10.5px (as drawn in the `9c` tiles). Below the width at which even that fits, the sentence wraps to its own line **above** the chip — it is never truncated, ellipsised, or removed. If a future density genuinely cannot show it, the only permitted substitute is an icon-free `aria-label` carrying the same sentence on the footer element, so the accessible equivalent survives; the visible text is preferred in every case.

8. **Shell status bar.** Window-level, below the pane footer. Slots on this pane are in `authoring-shell.md` — tracked-change count at ≥1 only, **open-comment count at ≥1 and absent at 0** (`9g.7`/`9g.8`), `Display: … ▾` present, **no saved-state slot on either platform**, and the unattributed-redline qualifier on the tracked-change count.

**With no notice mounted the toolbar and the strip are adjacent**, both `#FAF8F3`, separated by one hairline. That is intended: they read as a single chrome block rather than two bands (`9c`.1).

Nothing is ever placed **inside** the buffer: it is editable and copyable, and a notice about lost work must not become text the author can type over or paste into a document.

## Copy (final)

Consequence line:

> Your earlier unsaved work couldn’t be preserved.

Reason line (full, as drawn in `9a`/`9b`):

> This tab was opened to hold unsaved work from *`<displaced-path>`* after a moved document took that path. That work was larger than the 2 MiB Emend keeps per tab in its session, so it wasn’t kept, and Emend can’t restore it. What is here now is a new, empty untitled document: you can write in it, and `Save As…` adds what *you* write to the project. It doesn’t bring back what wasn’t kept.

Where the pane is too narrow for the provenance sentence, the reason line opens at *"That work was larger than…"*. The final sentence — *"It doesn’t bring back what wasn’t kept."* — is **load-bearing and never dropped, at any width, in any variant**: it is the only sentence that keeps `[Save As…]` from reading as a recovery route. It is present in the full reason line (`9a`/`9b`), in the narrow-width short line (`9c.2`), and while a Save-As failure line is showing (`9c.6`). A rendering that omits it is a defect, not a responsive concession; if something must go, the provenance sentence goes first.

**Live over-cap (`9e.1`)** — consequence and reason:

> This work is here, but Emend can't keep it in your session.
>
> It's larger than the 2 MiB Emend can hold per tab, so it won't be there after you quit. Nothing has been lost — the text is in front of you. `Save As…` puts it in the project, and that is the only way to keep it.

The one action is `Save As…`. **There is no `[Hide message]` on this state** — it is a live risk the author can still act on, not a fact about the past.

**Composed (`9e.2`)** — the live warning as above (second sentence becomes *"What you have written since is larger than…"*), then, below a rule:

> **Separately:** the earlier unsaved work this tab was opened to hold was not preserved, and Emend can't restore it. Saving now keeps what you wrote — it doesn't bring that back.

Collapsed line: `Earlier unsaved work not preserved`. Actions: `Hide message`, `Details`, `Save As…`. Strip: `Editable`, `Untitled`, `Not in this project`, `Saved nowhere yet`. Buffer placeholder: `Nothing was recovered into this document — you can start writing here.`

Adoption card (timeline, quiet — a **new** card kind; current `main` has none):

> Untitled saved as **`<chosen-path>`**. The unsaved work from *`<displaced-path>`* that exceeded the session limit was not part of it.

**Prohibited wording.** Anything implying the omitted work can be restored, retried, recovered, compared or found later; anything presenting editing or `Save As…` as recovery of it; "lost", "deleted" or "discarded" for the omission — Emend did not delete the author's work, it failed to keep a copy of it; "read-only" or any claim the pane cannot be edited; anything implying autosave is active or that the document is an ordinary file; any suggestion the displaced path still belongs to this document (it is the moved document's now); any claim the notice clears after a save (while untitled, there is no save).

## Two distinct over-cap states

The 2 MiB cap omits content **from serialization**, not from memory (`store/tab_session.rs`: `TabSnapshot::new` filters on write). Ratified by CJ 2026-08-28 (disposition 4), these are **two different states and must never be conflated**:

| State | When | What is true | Copy |
|---|---|---|---|
| **`live-over-cap-not-durable`** (`9e.1`) | This session, buffer over the cap | The bytes are **present and editable**. **Nothing has been lost.** They will not survive quit | Durability warning; action is `[Save As…]`; **not dismissible** |
| **`restored-omitted-empty`** (`9c.2`) | After relaunch, content was omitted | The bytes are **gone**. The document is genuinely empty | The ratified honesty notice; `[Hide message]`/`[Details]` |

**Never clear live bytes to enter `9c.2`.** A live over-cap buffer is not an omission; it becomes one only by surviving a relaunch that could not carry it.

**Live bytes require a decision before close.** A close or quit may **not** silently drop them: the tab reaches the guard as variant `live-over-cap`, with `[Save As…]` / `[Discard]` / `[Cancel]`.

**Composed, never merged (`9e.2`).** Where a restored-omission document is then grown past the cap, both facts show in one bar, **visually separated by a rule and the word "Separately"** — the new, still-actionable risk first, the earlier loss second, and a closing clause keeping saving from reading as recovery of it. They are different losses with different remedies and are never written as one sentence.

## States

| State | Condition | Appearance |
|---|---|---|
| **Buffer preserved** (`9c.1`) | Recovery buffer persisted and restored, non-empty | Strip only; neutral `UNTITLED`; no dot; no amber; editable |
| **Preserved empty** | Recovery buffer persisted and genuinely empty | Strip only; neutral; **no omission copy of any kind** |
| **Live over-cap** (`9e.1`) | Buffer exceeds the cap **this session** | Durability notice (not dismissible) + strip; amber `UNTITLED`; amber dot |
| **Restored omitted, empty** (`9c.2`) | `recoveryContentOmitted: true`, buffer empty | Loss notice + strip + placeholder; amber `UNTITLED`; amber dot |
| **Message hidden** (`9c.3`) | `[Hide message]` on a restored omission | Notice collapses to one amber line with `[Details]`; dot and qualifier remain |
| **Edits after the omission** (`9c.4`) | Restored omission, author has typed | Notice unchanged; buffer holds the new work; still no dirty dot |
| **Both** (`9e.2`) | Restored omission **and** now over the cap | Composed bar, two facts visibly separate |
| **Save As failed** (`9c.6` / `9d.2`) | Last attempt failed | Failure line in the surface that started it |
| **Adopted** (`9c.7`) | `[Save As…]` succeeded and provenance published | Ordinary project document |
| **Adopted, provenance pending** (`9f.2`) | File saved, publication not yet confirmed | Ordinary document **plus** an honest pending line |

**Unreachable, not drawn.** A *clean* displaced document's tab simply closes, so "recovery document with nothing unsaved" does not exist. An unreadable tab-session JSON restores an **empty session** — no tab survives on which a per-tab read-failure notice could render.

**The authoritative state is the explicit persisted outcome.** `9c.2` is bound to `recoveryContentOmitted: true`. The pair `recovered_from: Some(path)` + `unsaved_content: None` may be used only to **classify the initial occurrence and migrate legacy session records** written before the outcome field existed. It cannot be the durable definition: after a later serialization it cannot distinguish an omitted buffer from one that was never present, and an author who has since typed into the tab makes it non-null either way.

**Migration is bounded, and one legacy shape is deliberately not migrated.**

| Legacy record | Disposition |
|---|---|
| `recovered_from: Some(path)` + `unsaved_content: None` | **Unambiguous** — the buffer was omitted. Migrate to `recoveryContentOmitted: true`; the notice renders, and the message defaults to expanded. |
| `recovered_from: Some(path)` + `unsaved_content: Some("")` | **Ambiguous — not migrated.** #1805 normalizes absent content to an empty string, so this is indistinguishable from a recovery document whose buffer genuinely was empty. It receives **no** `recoveryContentOmitted` and **no** notice. |

This is a **recorded limitation, not an oversight.** A session normalized by #1805 before the outcome field existed cannot be classified after the fact, and no evidence available at migration time separates the two cases. Its disposition is the conservative one — **a missing warning is recoverable; a false one is not.** Telling an author their work was lost when none existed is the worse failure. Records written once the outcome field ships are unaffected, so the limitation is bounded to sessions predating it and does not propagate forward.

**Canonicalization, not eager rewrite.** Legacy records are canonicalized **in memory on read**; nothing is rewritten to disk until the session would be written for an independent reason. An eager rewrite-on-launch is rejected — it would burn the only pre-upgrade copy of a session before the author has done anything, and would make a launch the author then abandons destructive. **Consequence for the baseline:** `lastPersistedSession` must be the **canonical** representation of what is on disk, not the raw bytes read; otherwise every canonicalized legacy launch would register a spurious `wholeSessionDelta`. The honest name in code is *canonicalized last-persisted session*, and this spec means that by `lastPersistedSession` throughout.

**Malformed combinations.** Each is a defect in the record, disposed conservatively — never by inventing a loss:

| Malformed record | Disposition |
|---|---|
| Hidden flag set, no over-cap outcome | Drop the hidden flag; render nothing. There is no notice for it to have hidden |
| Over-cap outcome set, no recovery identity (no `recovered_from`) | Drop the outcome. Without a displaced path the notice cannot state what was lost, and its copy is unwritable |
| Adopted record (has a project path) still carrying recovery flags | Drop both flags. Adoption ends the state; a project document never shows the notice |
| Over-cap outcome set **and** non-empty persisted content | **Not malformed** — this is the legitimate *edited after the omission* case (`9c.4`). Keep both |

**Downgrade is unsupported and lossy — say so rather than promise otherwise.** The two new fields are additive and **ignorable**: an older Emend reading a newer session drops them and shows an untitled tab with no notice — degraded, never false. A newer Emend reading an older session applies the bounded migration above, and neither direction refuses to open a session. **But a session rewritten by an already-released older binary loses the new fields permanently.** Those binaries do not preserve keys they do not know, and no specification written now can change what they already do — so **downgrade-through-an-older-writer is recorded as unsupported and lossy**, not mitigated. The consequence is bounded and honest: the omission record disappears, and the tab returns as an ordinary untitled document with no notice. Any future round-trip guarantee would need a mechanism current binaries genuinely honor — a sidecar the old writer never touches, or a version gate that refuses the downgrade — and that is a separate decision, not a claim this folder may make.

**The cap is 2 MiB** (`2 * 1024 * 1024`) of inline content per tab in the tab-session JSON (`store::tab_session::UNSAVED_CONTENT_CAP_BYTES`). The copy states `2 MiB`, matching the implementation; it is never rounded or restated in MB.

## Transitions and persistence

- The notice **mounts with the pane**, before first paint of the buffer. Never animated in, never appears after the author has begun reading or typing.
- `[Hide message]` → *Message hidden*. `[Details]` → back, unchanged; the round trip records nothing and is repeatable.
- **Editing does not clear it.** The notice is a fact about what was lost, not about what the buffer holds. No timer, focus change or tab switch clears it either, and while the document is untitled there is no save that could.
- **Both facts persist durably** in the tab-session record: (a) that this tab's recovery content was omitted for exceeding the cap, and (b) whether the explanation is hidden. Neither is reconstructible from `recovered_from` + `unsaved_content` after a subsequent serialization. Hiding survives quit and relaunch **as hidden** — the collapsed amber line and `[Details]` return, never a clean pane. See `amendments/j2-recovery-document-over-cap.md`.
- **Save As, cancelled or failed:** nothing changes — buffer, untitled tab, amber state, persisted flags and any open close guard all stay intact. A failure renders in the pane's failure line; a cancelled panel shows nothing at all.
- **Save As, successful:** the untitled lifecycle ends. The tab becomes an ordinary project document at the chosen path (`adoptUntitledTab` drops `recoveredFrom` entirely), and with it the notice, the qualifier, the dot and the strip. Both persisted flags leave the session record along with the untitled tab.
- **A file that saved but whose phase promotion failed is still an adoption.** Where the Save As succeeds but persisting `prepared → file-committed` fails, the **file and the adoption succeeded**: the tab is an ordinary project document. Emend shows the **provenance-pending** line (`9f.2`), **not** a Save As failure — a Save As failure would be a lie about a file that exists. The event stays **non-projectable** until reconciliation promotes it, reconciliation retries automatically, and the card is **never duplicated**. See `adoption-provenance.md`.
- **No document-attached provenance field survives adoption.** The durable record is a **machine-local adoption event** keyed by a stable `adoptionId`, persisted before the irreversible boundary; the D15 timeline card is a **reconstructible projection** of that event, not the record. **Current `main` has no scratch-adoption card of any kind** — the card is new work, and the transcript append is best-effort today. Full workflow, phases and crash recovery: `adoption-provenance.md`. A *document-attached* provenance field would be a new persisted field on an ordinary project document and is a separate delta.
- **No restore affordance in any state**: no `[Retry]`, `[Recover…]` or `[Compare]`. The omitted buffer was never written anywhere.

## Close (composes with D12's three-action guard)

Closing an untitled recovery tab always reaches the **existing** `DirtyCloseGuard` — it is guarded on `recoveredFrom`, not on `dirty` (`tabsRequiringCloseGuard`), so even an untouched tab is guarded. Same modal, same three actions in the same order: `[Save As…]`, `[Discard]`, `[Cancel]`. **No new modal is introduced, and `RecoveredDocument`'s confirmed-close-only exit is not resurrected.**

| Variant | Selected when | Body | Discard |
|---|---|---|---|
| **`only-copy`** | Preserved buffer, non-empty | *"**`<label>`** holds unsaved work. Closing it without saving discards that work permanently."* | **Destructive** `#A33A2E` |
| **`live-over-cap`** (`9e.3`) | Buffer over the cap **this session** | *"This document holds unsaved work that Emend can't keep in your session — it's over the 2 MiB per-tab limit. Closing it without saving discards that work permanently."* | **Destructive** |
| **`omitted-with-edits`** | Restored omission, author has since typed | *"You've written in this document since it was opened, and that work isn't saved anywhere. Closing it without saving discards it permanently. The earlier unsaved work this tab was created to hold was already not preserved, and closing changes nothing about that."* | **Destructive** |
| **`restored-omitted-empty`** | `recoveryContentOmitted: true`, buffer empty **now** | *"This untitled document is empty now. Earlier unsaved work was not preserved. Closing it discards no current content."* | **Neutral** |
| **`preserved-empty`** | Recovery buffer preserved and genuinely empty | *"This untitled document is empty and isn't saved anywhere. Closing it discards no content."* | **Neutral** |

**Current-state wording, ratified 2026-08-28 (disposition 3).** `restored-omitted-empty` says *"empty **now**"* rather than *"nothing has been written here since"* — the old phrasing became false the moment an author typed and deleted. Type-then-delete lands here, correctly, because the body describes the buffer's present state rather than its history.

**`preserved-empty` is its own disposition.** An intentionally empty recovery buffer gets **no omission copy at all** — nothing was omitted — and it **does not bypass the guard**: it is still an untitled document holding a decision the author has not made.

These are **five explicit variants of the guard, selected by state** — not one body with `discardsOnlyCopy` flipped. Each variant owns its body copy, its `Discard` styling, and `Discard`'s accessible name; `discardsOnlyCopy` is a *consequence* of the variant, never its definition.

**New #1833 work, not existing behavior.** The shared guard's `Cancel` autofocus, `Esc` handling and focus trap are **not** present on current `main` at `f24dc462ae77`. They are specified here as new work for this issue and must be implemented, not assumed.

**All five keep, without exception:** the three actions `[Save As…]`, `[Discard]`, `[Cancel]` in that order; `[Cancel]` as the default with **autofocus**; and `Esc` cancelling. Nothing about the guard's structure, order, or dismissal differs between them.

- `[Cancel]` is the default and takes focus; it preserves the buffer and the guard's state.
- `[Save As…]` from the guard runs the ordinary adoption flow: on success the document is adopted **and stays open**, and the guard closes; on cancellation or failure the guard and buffer stay intact.
- `[Discard]` is the only action that destroys the buffer. No undo, no toast — consistent with FR-CMT-8's precedent elsewhere in this folder.
## Quit — staged closes, one atomic session write (`9c.8`)

Quit raises **no close guard** for an untitled tab (`dirtyTabsRequiringGuard` deliberately excludes it), and that is only honest if the buffer and both persisted flags actually reach disk. **As of #1805 they may not:** the close seam (`src/stores/appLifecycle.ts`) performs a best-effort asynchronous session flush and **does not await it**. This design does not claim quit is safe while the write is unawaited.

### An active run refuses the close before anything else (ratified, disposition 7)

**FR-X-11's run-blocked close refusal precedes D12/J2 close handling entirely.** On a close request with a run active, Emend shows the existing refusal surface — *"**`<run>`** is still running. Stop it first, then close — nothing has been closed or saved."* — and **no guard queue, no staged decisions and no session write begins**. Nothing is composed and nothing is entered.

After stopping the run the author **initiates close again**. The refused attempt is not resumed and leaves no state behind: `closeAttempt` never left `idle`.

### Dirty-tab resolution is atomic with the final write

The queue runs first, but **nothing leaves memory while the close attempt is pending**. A decision being *recorded* and a tab removal being *committed* are two different events, separated by the write.

1. Run the existing dirty project-document decision queue: save / discard / cancel, one tab at a time.
2. **A successful Save may write the project file** — that write is real and is not staged — **but its tab remains mounted** while the close attempt is pending.
3. **A Discard is recorded as a decision only.** The in-memory tab is not removed and its buffer is not destroyed.
4. Compose the **proposed** final session payload *as if* every staged close had already occurred — reflecting the saves, the recorded discards, the resulting tab set, and every remaining untitled buffer with its `recoveryContentOmitted` and hidden/expanded flags.
5. **Await the atomic session write.**
6. **On success** — subject to the persistence proof below, commit the staged removals, then close the window.
7. **On failure** — the plan is **retained, uncommitted**. `stagedDecisions` survives; every tab and buffer remains mounted; saved tabs remain saved (their project writes already happened and are not undone); **discarded buffers remain available, because their discard was never committed.** The plan is retained precisely because `[Try again]` and `[Quit anyway]` both act on it — cancelling it at failure would leave both controls with nothing to do.

   **Only three things clear the plan without committing it:** `[Stay open]` / `Esc`, a dirty-tab `Cancel`, or a failed project-document Save. Nothing else discards a staged decision.
8. **A dirty-tab `Cancel`, or a failed project-document Save, still aborts the quit before the final session write is attempted.** No write, no staging commit, window stays open.

### Closing without an untitled guard requires proof, not `Ok(())` (ratified, disposition 5)

**Emend may close without guarding an untitled buffer only on authoritative confirmation that every remaining untitled buffer persisted *without omission*.** A bare backend success is **not** that confirmation: the cap filters at serialization, so a write can succeed having silently dropped a buffer.

The write must return **authoritative per-tab persistence outcomes** — which tabs were stored, and which had content omitted. **The Architect owns the IPC mechanism** (receipt shape, command signature, transport); this folder binds only what the UI may conclude from it.

**Every successful close routes through `awaiting-proof`.** There is no direct entrance to `closed` from a write success, a retry success, or a no-delta short-circuit. Where no write is performed, Emend requests an **authoritative no-write proof** — the same per-tab losslessness attestation against the stored session, without a write — and enters `awaiting-proof` with it. Skipping the write never skips the proof: a buffer can be unpersistable while the session as a whole is unchanged, and that is exactly the case a no-delta close would otherwise close over. **No path closes while a live untitled buffer was omitted.**

| Path | Route |
|---|---|
| Write succeeded | → `awaiting-proof` |
| `wholeSessionDelta = false` | skip write → **authoritative no-write proof** → `awaiting-proof` |
| Retry write succeeded | → `awaiting-proof` |
| Retry finds no delta | skip write → **authoritative no-write proof** → `awaiting-proof` |

**Only `awaiting-proof → confirmed exact` may commit the staged removals and close.**

Every `awaiting-proof` exit is defined:

| Exit | Behavior |
|---|---|
| **Confirmed exact** — every remaining untitled buffer stored in full | Commit the staged removals; **close** |
| **Confirmed with omission** | **Do not close.** **Clear the finalization lock** (the surface becomes interactive again), **retain the plan and recompose it**, and **focus the `live-over-cap` guard** for the first affected tab — the rest follow in the ordinary queue. After the author's decisions the attempt re-composes, re-writes, and proves again |
| **Unusable proof** — malformed, absent, or unattributable outcomes | Typed **`proof-unusable`** failure. **Never close.** The finalization lock clears, the failure dialog opens with the **unverifiable-baseline** reason clause, and the plan is retained |
| **Write failed** | The failure dialog below; plan retained |

Until that confirmation exists the no-guard-on-quit rule does not apply. This is the dependency that makes quit honest.

There is no ordering in which the session is written while a dirty-tab decision is outstanding, and none in which a tab is destroyed by a close attempt that then fails.

### One comparison basis: proposed payload vs last persisted session

Emend tracks `lastPersistedSession` — **the last successfully persisted session representation**. It is the single comparison point, and — if a write fails — it **remains the recovery baseline**: a failed atomic write leaves it intact, so what is at stake is only the delta since it was written.

Everything below is derived from exactly two values, **`proposedSessionPayload` versus `lastPersistedSession`**. No other basis is used — not live tab state, not a per-tab dirty flag.

### `wholeSessionDelta` — is there anything to write at all?

> `wholeSessionDelta` = `proposedSessionPayload` **materially differs from** `lastPersistedSession`

- **If `wholeSessionDelta` is false**, the last persisted snapshot **already represents the proposed final session**, so Emend **skips the redundant write** — but not the proof. It requests an **authoritative no-write proof** and enters `awaiting-proof`; only a confirmed-exact result commits the staged removals and closes. No *write* failure can arise on this path, and no risk warning is shown for a session that is materially identical — but an omitted live buffer still stops the close.
- **Emend never claims session state is at risk when the proposed and persisted representations are materially identical.** A warning in that case would be false.
- The write, the `Saving your session…` row, and the failure dialog therefore all exist only on the `wholeSessionDelta = true` path.

### `affectedUntitledTabs`

The untitled tabs that account for the delta, computed from the same two payloads:

| Difference | How it is represented |
|---|---|
| **Staged removal** | The tab's **absence from `proposedSessionPayload`** |
| **New tab** | The tab's **absence from `lastPersistedSession`** |
| Buffer content, displaced path, over-cap outcome (`recoveryContentOmitted`), hidden/expanded state, identity, ordering | Field-level difference between the tab's record in the two payloads |
| Top-level **order** change | Compared as position **within the untitled-tab subsequence**, never as absolute index in the mixed project/untitled array. Attributed to the untitled tabs whose relative position differs |
| Top-level **active-tab** change | Attributed **separately**, and only to the tab that gained or lost active status |

**Tabs are matched by stable opaque identity** across the two payloads — never by label, path, or array index.

**A project-tab-only change must not mark an untouched untitled tab.** Closing or opening a project tab shifts every absolute index after it; because ordering compares the untitled subsequence, an untitled tab whose neighbours in that subsequence are unchanged is **not** affected. This is the most likely false positive, and the rule exists to prevent it.

**Adoption is not a staged discard.** An adopted tab leaves the untitled set because it became a project document — its content was *saved*. It must never appear in `affectedUntitledTabs`, and never under copy implying its content may vanish. Absence-from-proposed means "staged removal" only for a tab whose staged decision was `discard-recorded`.

- The set is **not** limited to non-empty buffers, and not to notice-state changes. **An empty preserved buffer is affected** when it is new, staged for removal, or has moved in the order.
- **If only project-tab or other top-level state differs**, `wholeSessionDelta` is **true** while `affectedUntitledTabs` is **empty** — and that combination is what selects the **zero-tab copy**. The zero-tab copy is reachable in no other way.

### Finalization locks the surface (`9d.1`)

From the moment `proposedSessionPayload` is composed until the attempt resolves, the document surface **must not remain freely mutable against an already-composed payload**. The pane carries `aria-busy="true"`; the tab strip, the notice and its toggle, the buffer, and `[Save As…]` are `inert`. Editing, tab mutation, notice toggling and Save As are **refused, not queued** — none can race the terminal write. Visually 55% opacity with no pointer events, the status row left at full contrast because it is the one live element.

**Focus moves out before the subtree goes inert.** Focus is never left inside an inert region. Before the pane is made inert, focus is moved to a defined **shell-level close-attempt target** — a non-inert, programmatically focusable element in the shell that owns the attempt and labels it (it is what the `Saving your session…` status row describes). The author's prior focus position is recorded at that moment.

| Resolution | Focus |
|---|---|
| **Failure** | Moves to `[Stay open]` in the dialog, which traps focus |
| **Cancellation** (`[Stay open]` / `Esc`) | Interaction restored, then focus **returns to the recorded prior position** |
| **Omission or unusable proof** | Lock cleared, then focus moves to the `live-over-cap` guard |
| **Success** | The window closes; no focus target is needed |

### One close attempt, one generation

The **first** cancellable close request **synchronously prevents native close** and owns a stable **attempt generation**. Repeated native close or Quit requests, in any phase, **join or focus that attempt** — never a second queue, plan, write, dialog or close. Every asynchronous callback carries its generation and is discarded if it does not match.

Before final serialization every dirty tab reaches a **typed outcome**:

| Outcome | Effect on the attempt |
|---|---|
| `blocked-active-run` | Refused before the attempt starts (FR-X-11, above) |
| `missing-on-disk` | Resolved through the existing missing-on-disk surface; unresolved ⇒ **abort** |
| `save-refused-external-divergence` | The existing divergence refusal; **abort** — never overwrite |
| `saved` | Project file written; **tab stays mounted** |
| `saved-as-rekeyed` | Adopted at a new path; identity rekeyed in `proposedSessionPayload` |
| `discard-recorded` | Recorded; buffer intact, removal staged |
| `cancelled` | **Abort**; no write |
| `blocked` | **Abort** |
| `failed` | **Abort**; reported in its own surface |

**Save As and close fence each other.** A close request raised while a Save As is in flight **waits for it to settle** and takes its outcome (`saved-as-rekeyed` or `failed`) into the queue; a Save As raised during finalization is **refused, not queued**. One latch, one panel, one write, one adoption, one provenance event.

### While awaiting

After **400 ms**, a quiet non-modal row appears in the **shell status bar's leading slot** — `Saving your session…`, 11.5px `#6B665C` with a 6px `#B5871F` dot, `role="status"` — replacing the slot's usual content. Not a new surface, not an overlay, no spinner. Windows fill `#F5F3ED`, macOS `#F1EEE7` (`platform-variants.md`). Under 400 ms nothing is shown. Every decided tab is still mounted behind it. On success the window closes with nothing further displayed.

### On failure — the window stays open, and the copy is risk-based

The write is atomic: a failure may well leave the previous valid session intact. The dialog therefore **never claims a tab "would not come back."** It states the risk of quitting now.

Title: **Couldn't save your latest session changes**

| Affected untitled tabs | Body |
|---|---|
| One | *Emend couldn't save your latest session changes. Changes to **`<label>`** may not return if you quit now.* |
| Two or more | *Emend couldn't save your latest session changes. Changes to **`<N>` untitled documents** may not return if you quit now.* |
| **Zero** | *Emend couldn't save your latest session changes. Your latest tab layout and session state may not return if you quit now.* |

The zero case arises **only** when `wholeSessionDelta` is true because non-untitled or top-level session state differs while `affectedUntitledTabs` is empty; the layout and session state are then genuinely at risk. It is never shown when the two representations are materially identical — in that case there is no write and no dialog.

**The override is honest about what reopens (ratified, disposition 2).** The label is `[Quit anyway]`. The withdrawn label implied the closes were durably committed, which they are not: **it abandons the current session delta and closes**, and previous state may reopen.

Beneath the body, the reason in the Reject family (`#F8EFED` fill, 1px `#DCC4BF`, `#A33A2E` text): the **actual normalized error detail**, then a baseline disclosure. Four variants:

| Baseline | Reason line |
|---|---|
| **Universal** | *`<actual detail>`. No new session was committed.* |
| Valid prior snapshot | …*Your previous saved session is still intact — if you quit anyway, that older session is what reopens, and it may bring back tabs you closed or earlier versions of what's open now.* |
| No previous snapshot | …*There is no previous saved session to restore — if you quit anyway, this window reopens empty.* |
| Unknown or unusable | …*Emend couldn't verify a usable previous session — if you quit anyway, what reopens may be incomplete.* |

The detail is the **normalized error**, never a fixed string; `Permission denied writing session.json` is an example of one, not the copy.

### Save As failure stays in the surface that started it (`9d.2`)

- **Pane-initiated** Save As failure keeps the pane-level non-modal `role="status"` line (anatomy § 3).
- **Guard-initiated** Save As failure renders **inside the `alertdialog`**, in the Reject family, between the body and the actions: *Couldn't save to `<path>` — `<reason>`. Nothing was written, and this document is unchanged.* It must **never** fall back to the pane line, which sits behind the focus trap — a modal cannot leave its only failure explanation somewhere the author cannot reach.
- **Focus** stays in the dialog and returns to `[Cancel]`; the dialog stays open and the buffer is untouched.
- **One single-flight latch across both entry points.** Pane Save As and guard Save As share it: **one save panel, one file write, one adoption, one provenance event**. A guard Save As raised while a pane Save As is in flight **joins** the existing operation rather than opening a second panel; the outcome renders in whichever surface is frontmost, and the guard variant wins when both are up.

### The affected-label list

Shown whenever two or more tabs are affected, headed `AFFECTED DOCUMENTS (<N>)`.

- **Every** affected accessible label is rendered. **Never "and others,"** never a truncated set, never a bare count without names.
- Semantic markup: a real `<ul>` of `<li>`, so length and position are announced.
- The list is **vertically scrollable** with a maximum height of **96px** (Windows) / **104px** (macOS); the dialog's own maximum height is **420px** (Win) / **440px** (mac).
- **Title, body, reason line and actions stay pinned and visible** at any list length — only the list scrolls.
- **Only when it overflows** does the list take `tabindex="0"`, with a visible 2px `#4F46E5` focus ring, making it keyboard-scrollable (arrows, PgUp/PgDn) as a single stop **before** the actions. When the list fits, it is not in the tab order at all — no unnecessary stop between the body and the buttons.

| Control | Treatment | Behavior |
|---|---|---|
| `[Quit anyway]` | **Destructive** — `#F8EFED` fill, 1px `#DCC4BF`, `#A33A2E` 500. **Never the default, never autofocused.** | **Abandons the current session delta and closes.** It makes **no claim to durably commit** anything — it cannot: the session is not saved, so the previous saved session is what reopens, and it may bring back tabs the author discarded or older versions of open buffers. |
| `[Try again]` | **Neutral** chip; busy while in flight. | **Recomposes `proposedSessionPayload` from the retained plan**, then retries. A successful write enters `awaiting-proof`; a recomposition finding no delta requests the **no-write proof** and also enters `awaiting-proof`. Neither closes directly — only a confirmed-exact proof does. On write failure the dialog stays, plan still retained, reason line updated. |
| `[Stay open]` | **Default**, takes focus. | **Cancels the attempt, clears the staged decisions, and retains all tabs** — recorded discards never applied, every buffer intact; returns to `idle`. `Esc` does the same. |

- **Three full action labels must always be visible.** Below the width at which they fit on one row, the actions **stack full-width in the same order**, destructive first, `[Stay open]` last and still autofocused. Labels are **never truncated or abbreviated, in any locale** — a longer localization stacks earlier rather than eliding. The label list stays the only scrolling region; title, body, reason and actions stay pinned.
- Action order is `[Quit anyway]` → `[Try again]` → `[Stay open]` on **both** platforms — the destructive verb leads, matching the correction-card precedent in `platform-variants.md`.
**While `[Try again]` is in flight:** exactly **one** modal and **one** retained plan; the dialog carries `aria-busy="true"`; **all three actions are disabled** against repeat activation; further native close requests are **ignored or joined**, never queued; and every callback is **tagged with the attempt generation**, so a stale completion cannot close a window whose attempt was cancelled. On failure controls are restored and focus returns to `[Stay open]`. On success the removals are committed **once** and the interrupted close completes.

- Focus lands on `[Stay open]` on open and returns to it after a failed `[Try again]`; focus is **trapped** in the dialog on both platforms.
- Announced as an `alertdialog`; the reason line and the label list live inside it, not in a separate live region.
- **Scope and app-wide Quit.** `9c.8` governs **one cancellable project-window close request**. Application-wide **Quit** is bounded coordination across windows — **not an atomic transaction, and no distributed rollback is claimed**:

  1. **Non-mutating preflight across all participating windows** — active-run and eligibility only. Nothing is decided, staged, written, removed, or closed. **Any refusal here stops the quit before any window makes a decision or a write.**
  2. **Then process windows sequentially**, each through its **existing per-window close state machine** (queue → compose → write → proof → commit → close), under its own attempt generation.
  3. **A later Cancel, failure, or refusal stops the remaining windows.** It does **not** reverse what already happened: **windows already successfully closed remain closed**, and **project-document Saves already completed remain saved**. The author is told which windows remain open.

  The coordinator owns ordering and the participating-window list; **a window never initiates an app quit's write.** The coordinator is an **architecture dependency owned by the Architect** (`state.md`, Architecture ownership). **Explicitly out of scope:** forced termination, crash, process kill, and non-vetoable OS shutdown.

- **Session ownership (ratified, disposition 6).** These guarantees require **one logical writer per project tab session**. Frontend-local serialization alone does not provide it and is not claimed to. **The Architect owns** whether D26 enforcement, backend per-session-path serialization/CAS, or both supply it; this design depends on the invariant, not on a particular mechanism.
- Applies to **any** quit that would risk an untitled buffer, not only the over-cap one. It composes with the D12 close guard rather than replacing it: the close guard protects a tab, this protects the session write.

## Accessibility and semantics

- **Duplicate displaced labels.** Repeated displacement of the same path produces identical labels. Each such tab carries a **stable ordinal disambiguator** — `(1)`, `(2)` — assigned at creation, in creation order, and **never renumbered** when a sibling closes. Rendered in 10.5px `#8C8779` after the italic path (`9d.3`). **The identical string is used in the tab strip, the accessible name, and the affected-documents list**, so a label in the dialog names exactly one tab. It appears only where a collision exists.
- **Tab accessible names are split by state, and `9e.1` never announces a loss.** Base: `Untitled — recovered from product-brief.md, editable`. Then:

| State | Appended |
|---|---|
| **Live over-cap only** (`9e.1`) | `— current work is present but not kept in the session`. **No loss is announced**: nothing has been lost |
| **Restored omission** (`9c.2`–`9c.4`) | `— earlier unsaved work was not preserved` |
| **Composed** (`9e.2`) | `— current work is present but not kept in the session; earlier unsaved work was not preserved` — both facts, in the order the notice states them |

The amber dot and the qualifier's colour are never the sole carriers of any of this.
- **Notice** is a `region` labelled `Recovery notice, untitled document from product-brief.md`, announced **once** on mount as a polite live region. It does not take focus and does not move the caret. Re-expanding from `[Details]` does not re-announce.
- **Keyboard.** The notice sits in tab order between the tab strip and the buffer; the strip is not focusable. `[Hide message]`/`[Details]` are one real button with `aria-expanded`, so focus stays on it across the collapse/expand rather than being dropped into the buffer. `Esc` with focus inside the expanded notice collapses it. `[Save As…]` follows the buffer in tab order. Nothing here is click-only.
- **Buffer** keeps its shipped accessible name (`Untitled document text`); the strip is in the pane's accessible description, so a screen reader reaching the buffer has already been told the document is untitled and saved nowhere yet.
- **What hiding changes, semantically:** the control's accessible name becomes `Earlier unsaved work not preserved — show details`; the tab's accessible name is unchanged; nothing is announced as resolved, because nothing was.
- **Failure line** is `role="status"` — non-modal, announced politely, matching `MissingOnDiskBanner` and the shell status region.
- **Close guard** is the existing `alertdialog`; focus lands on `Cancel`, `Esc` cancels, and `Discard`'s accessible name is `Discard this untitled document`.
- Colour is never the sole carrier in any state, and `#8A6614` on `#FBF3E1` clears 4.5:1.

## Where each half binds

Appearance binds here. Behavior binds in `../ux-design.md` — J2's correlated-move clause and the ratified #1379 lifecycle amendment. The over-cap state's own behavior is recorded by the **revised over-cap amendment, ratified by CJ on 2026-08-27** and applied to `../ux-design.md` by PR #1833 — it supersedes the wording ratified 2026-08-26, which assumed the withdrawn read-only pane. The record is in `amendments/j2-recovery-document-over-cap.md`; `../ux-design.md` is the authoritative copy. **All seven escalated conflicts were ratified by CJ on 2026-08-28** and are applied here (`open-conflicts.md` records what was escalated and how each was disposed). **No unresolved conflict remains.** Two implementation dependencies are owned elsewhere and must land with this work: the **persistence-receipt IPC** (disposition 5) and the **single-logical-writer guarantee** (disposition 6), both the Architect's.

## Refresh (17)

### The mic (`9a`/`9b`, `3c.10`)
Present on the pathless pane before and after adoption (UXR-Q14.1). Under finalization it is frozen with the rest of the toolbar and an uncommitted partial is discarded — see `authoring-shell.md` *Dictation mic*.

### Pathless selection popover (`9g`) — corrected (19)
`Comment` · `Quote to chat`; only `Ask agent` is absent (untitled documents take comments — shipped; CJ 2026-10-01). After a successful Save As the ordinary three-item popover, on the same selection, with no editor re-creation (UXR-Q14.4, J12 Phase F).

### Second entry route — legacy unsupported tab with retained text (`9h`, D27 / #2515)
- **Label:** `UNTITLED` + the former **project path** in italic (`research/survey-export.csv`, ellipsized from the left if the tab is narrow) — (19); title bar `Untitled — from research/survey-export.csv`. No dirty dot; no amber dot unless a separate omission fact exists. No active rail row.
- **Explanation:** a **neutral** notice in the document-notice slot (`#F0EDE6` Win / `#EDEAE2` mac, 12.5px/500 `#33302A` lead + 11.5px/1.5 `#4A463E` body, `Hide message`), above the standing-conditions strip. **Copy (ruled (18)):** *`<path>` can’t open as a Emend document.* / *Emend won’t open or write that file. The unsaved text this tab held is here, in an untitled document you can edit. `Save As…` saves it to a supported document path in this project — not to the original file.*
- Everything else is `9c.1`/`9c.7`: editable buffer, strip, no-autosave footer, guarded close, same-surface adoption; comments work as on any untitled document; an empty collapsed column reads `No comments in this document` (19).
- **Composed with an omission fact** (`9h.3`): amber tab dot and the amber notice beneath the D27 notice, worded so it never claims the omitted bytes returned.
- **Not this route:** a clean unsupported tab (`9h.1`) and an omission-only one (`9h.2`) create **no** recovery document. They refuse in the shared status band (`project-open-status.md` geometry: one line, 46px, clipping not wrapping; no action, `✕`), which names the former project path in italic.
  - **Clean (`9h.1`):** the tab closes.
  - **(21) Omission-only (`9h.2`, Windows and macOS), ruled by CJ 2026-10-01:** the tab **stays selected** after refusal. It is labelled by its **basename** (`survey-export.csv`), no `UNTITLED` qualifier, with the **amber loss marker** — a **6px `#B5871F` dot before the label** — matching Emend’s capture `docs/alignment-after/win-9h-omission-refusal-1400.png`. The accessible name carries *— earlier unsaved work was not preserved*. It has **no editable recovered buffer**: no toolbar, standing strip, caret, footer or `Save As…`, and the pane is empty `#FCFBF8`. Window title `Emend — survey-export.csv`. No active rail row. Supersedes (17)–(20) “the tab closes” for this case.

  Remaining lines for both cases: Proposed lines: *`<name>` can’t open as a Emend document. Its tab was closed.* / *`<name>` can’t open as a Emend document.* + muted reason run *Its unsaved work was over the session limit and wasn’t kept.*, which gives way first. Placement and both sentences are **ruled as drawn (18)**.
