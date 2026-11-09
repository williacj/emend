# Prose alignment for `../ux-design.md` — J9 project-open status (#1752)

**Status (20):** All eight earlier J9 dispositions were ratified into the repo’s `docs/ux-design.md` on 2026-09-14. **§3 was then reversed:** the repo said `✕` was absent at export, and CJ reversed that on 2026-10-01. Issue #2531 carries the replacement recorded in `2026-10-01-pending-prose.md` §A. (19) wrongly reported §3 as applied. The rest of this file records the original proposals and their review history; it is not the current pending-change list. `docs/ux-design.md` is not amended by this project or by the reader of this folder (`CLAUDE.md`, "Reading `docs/design/`").

**(16) Amended by refresh (16)**: §6 gains clear-time focus recovery, inside the existing §11 item 5 — the eight-item inventory is unchanged. **Revised by refresh (14)** after independent review. Two items are new (§7, §8), three are rewritten (§1, §3, §6), and one former proposal is **withdrawn** (§9) because the review showed it contradicted ratified authority rather than filling a gap.

Appearance for all of it is drawn in `13a`–`13h` and specified in `specs/project-open-status.md`, whose §11 carries the same list as a single table. Nothing below changes a ratified routing rule; J9's four outcomes, the queue rule, the bounded deadline, raise-is-not-focus-theft and no-stop-and-close are untouched.

---

## 1. Two more leading sentences for the failure line — **selected by a route discriminator, not by the reason code**

**Where:** J9 Phase C; §2 *Project-open routing states*, the **Failed** row.

**Today:** one sentence — `Emend couldn’t open <name> in a new window.`

**The problem:** two of the seven reason codes fail on the **raise** route, where no new window was ever going to open, and four can fail **before a route is resolved at all**. Using the ratified sentence for either misstates what Emend attempted, which is the honesty FR-X-5 and Principle 7 are for.

**Proposed addition — two sentences, same register:**

- **raise** — `Emend couldn’t bring <name> to the front.`
- **undetermined** — `Emend couldn’t open <name>.`

The ratified launch sentence stays exactly as written.

**(14) The correction the review forced.** Refresh (13) mapped these three sentences **from the reason code**. That mapping is not truthful: `deadline_expired` can expire before route selection, during adoption, during raise **or** during launch, and `registry_unavailable` can arrive after route resolution during activation or adoption setup. A reason-derived sentence would therefore sometimes name an attempt Emend never made. The selection must come from the route itself — see §7.

## 2. The seven detail texts

**Where:** J9 Phase C (`<detail>`); §2 **Failed** row ("states the failure **and its reason**").

**Today:** the reason is required and no words are given for it.

**Proposed:** the seven strings in `specs/project-open-status.md` §7b, with the rules they follow — one short plain sentence; **true for every condition its reason code represents**; no lock / instance / registry / handle / timeout vocabulary; no OS-naming variance; no instruction (the button is the instruction); no raw error text.

**(14) Rewritten for truthfulness.** Refresh (13)'s strings overclaimed. `project_unavailable` covers **every** canonicalization failure, not only a folder that disappeared; `open_failed` covers provider-session loading, watcher startup and MCP-server startup as well as reading the folder; `registry_unavailable` can occur during activation or adoption setup and not only while determining which windows are open. The replacements are broad because their codes are broad.

**The alternative, put to CJ explicitly (§8):** require a **narrower backend reason taxonomy** so each condition can carry a specific sentence. That is a contract change and therefore the Architect's and CJ's.

**Why it belongs in `ux-design.md` rather than only here:** these are user-facing strings, and this folder is binding on appearance, not on copy that states behavior. The precedent is §2's own adoption of the `12f` refusal strings.

## 3. Dismiss is withdrawn while a request is in flight — **a conflict, and it stays one**

**Where:** §4 *Status region* — "On the established welcome/author/workshop surfaces it remains dismissible."

**Today:** dismissibility is stated **flatly**, with no carve-out for an in-flight request.

**The conflict:** FR-X-11 requires every project-open request to reach a **visible** outcome. If `Opening <name>…` can be dismissed, the launch, raise or adoption can arrive with nothing on screen having explained it — precisely the silent no-op the requirement forbids, and precisely the case J9 Phase B calls out as indistinguishable from a click that did nothing.

**Proposed:** the `✕` is **absent** (not disabled) while a request is in flight, including while a retry is pending, and returns with the outcome. Every settled state remains dismissible exactly as §4 says.

**(14) Kept as a proposal, deliberately.** The review asked that this not be presented as existing authority, and it is not: omitting the glyph **contradicts** a flat ratified rule rather than filling a gap, and `specs/project-open-status.md` §4 and §11.1 both say so in those words.

**Design consequence if CJ declines:** the band keeps `✕` on `Opening…`, and a dismissed request produces a window that raises or launches with no statement anywhere. `13a` and `13e` states 1, 2 and 2′ would be redrawn with the glyph present, and nothing else would change.

## 4. Which states each surface can host

**Where:** §2 *Project-open routing states*; §4's project-open paragraph.

**Today:** the seven states are written as one list for all surfaces.

**Proposed clarification (no behavior change):** record that a window holding no project cannot reach **Already open here**, **Opened in a new window** or **Close blocked by a run**, and that on the welcome surface **Adopted here** is the outcome that clears the band. This follows from D26 and is already true; writing it down stops a reader deriving three impossible welcome states from the list. Matrix in `specs/project-open-status.md` §2 and `13e`.

## 5. Reviewer mode is out of scope, explicitly

**Where:** §4 *Reviewer status region*; J6.

**Proposed clarification:** reviewer mode has no project-open entry point, so none of the seven states reaches it, and J6's persistence and non-dismissibility rules are unaffected by J9. One sentence; prevents a future reader reconciling two sets of dismissal rules that never meet.

## 6. `[Show the run]`'s destination

**Where:** J9 "Closing a project while a run is active"; §2 **Close blocked by a run** row.

**Today:** "which reveals the active run card in the timeline."

**Proposed:** the six answers in `specs/project-open-status.md` §8 — the status **stays while it is true**; the timeline expands if collapsed, **taking the rail back from the comments column** through the rail's one existing `Timeline ‹‹ / ››` control; the run card is revealed with the document pane's scroll and the caret untouched; **focus lands on the run card container, never on `[Stop]`**; nothing is announced; and activation is idempotent.

**(15) The reveal boundary, stated exactly.** The *fits* branch applies **only when `cardHeight + 12px <= timelineViewportHeight`** — the clearance is part of what must fit — and reveals the card **whole** with 12px above it. **Otherwise**, including a card that would fit alone but not with its clearance, the **tall-card branch** aligns the card's **top** with the same 12px clearance and promises no more. Refreshes (13) and (14) wrote "fits in the viewport", which left an impossible boundary between the two branches.

**(15) One terminal-clear rule, covering every ordering.** Refreshes (13) and (14) said in one place that only `Dismiss` clears the refusal and in another that run completion clears it; the single rule is: **`Dismiss` is the only manual clear** while the refusal is true; **completion of the blocking run clears it automatically, whether completion precedes or follows activation**; **activation never clears it by itself**; **a race between activation and completion still reveals the same now-completed card**; and **the refused close is never completed automatically** — the author initiates close again.

**(16) Clear-time focus recovery, stated so the automatic clear is complete.** Refreshes (13)–(15) settled *when* the refusal clears and said nothing about *where focus goes* when it clears on its own — and an automatic clear can remove the band from under `[Show the run]` or `✕`. Proposed: focus owned by a control inside the disappearing band is restored to the **stable authoring target recorded when the close attempt was refused**, with **`preventScroll`** so document, timeline and rail scroll positions do not move; if that target is disconnected or no longer focusable, the established **shell-level close-attempt target** takes it; if `[Show the run]` has already moved focus to the run-card container, or focus already sits on any other stable target outside the band, **focus is not moved**; `Dismiss` keeps its ordinary explicit-dismiss focus behavior; and **the refused close is still never completed automatically**. This sits inside the existing gap for `[Show the run]`'s status persistence (`specs/project-open-status.md` §11 item 5) and adds **no ninth item**.

**(14) Facet selection, revised.** Refresh (13) proposed setting the facet to `all` unconditionally. Two ratified things push back: §4's scroll-motion rule states that **a filter the user deliberately set survives their own Send** (and a status-region action has less claim on it than the author's own submit), and the permission-attention behavior selects **Chat**. The revised proposal is therefore: **do not touch the facet when it already contains the active run card**, and change it only when the active facet would hide the card — then to `all`, because which *narrow* facet contains a run card depends on the run's kind (§4 puts agent addressing runs under **Comments**, composer-started runs under **Chat**), and a close refusal can be raised by any kind. `all` is the only one of `timelineFacet`'s five ratified values guaranteed to contain the card. **No new facet is proposed.** Whether any facet change belongs to this action at all is behavior and needs CJ's word.

**(14) One thing the review corrected in the drawing rather than the prose.** Refresh (13) drew the collapsed right rail as **absent**. §4's *Right-rail occupancy* rules that collapsing the stream is what reveals the **comments column** — the rail changes occupant, it does not disappear. That was an appearance error, is fixed in `13h.1`, and needs nothing from CJ. **UXR-Q13.1** — what the rail shows with no comments — remains open and is not settled by that drawing.

**Which half is whose:** the reveal geometry, the focus target and the ring are appearance and bind in this folder. That the status **persists** through activation, that the earlier close is **never** completed later, and that a facet change is part of the action at all are **behavior** and need CJ's word. Note that the run card's **own** appearance is neither — it is an open gap in this folder (`state.md`), and `13c`/`13h` draw it as illustrative context only.

## 7. (14) New — a route discriminator on the failed outcome

**Where:** §2 *Project-open routing states*, the **Failed** row; TD-20's failed-outcome stream.

**Today:** the failed outcome carries `root` and `reason`. Nothing records **which route was in flight** when it failed.

**The problem:** without it the renderer cannot honestly choose between the launch, raise and undetermined wording (§1), because the reason code does not determine the route.

**Proposed required input:**

```
failureRoute: "undetermined" | "raise" | "launch"
```

The renderer selects the leading sentence from **`failureRoute` alone** and never infers it from `reason`; there is no per-reason default, and until the field exists the honest presentation is `undetermined` for every failure.

**Status:** **the Architect has confirmed that adding this discriminator to TD-20's existing failed-outcome stream is a narrow contract refinement and does not require a new TD decision.** What is CJ's is the **wording** the field selects (§1).

## 8. (14) New — the alternative to broad detail copy

**Where:** J9 Phase C; the backend reason taxonomy behind §2's **Failed** row.

**The choice, stated so it is CJ's and not this folder's:** either the seven detail strings stay **broad** (§2 above), because `project_unavailable` and `open_failed` each cover several materially different conditions — or the **taxonomy is narrowed**, splitting those codes per condition so each can carry a specific sentence. This folder's rule holds either way: **every displayed statement must be true for every condition its reason code represents.**

## 9. (14) Withdrawn — the sub-560px wrap and the two-line failure

Refresh (13) proposed that the failure state take a **second line** and that the message be permitted to wrap below ~560px. **Both are withdrawn.** §4 and **UXR-Q15** constrain this shared region to **one line-height with clipping, not wrapping**, and §2's *Unattributed internal failure* states it outright: *"One line, and the band's height is never what gives way."* Refresh (14) draws the failure's reason **inside the same line** as the tail of the message run, with the clipping order in `specs/project-open-status.md` §9 absorbing the loss, and drops the responsive carve-out (13) had claimed.

**Still CJ's, if one line proves insufficient:** whether the failure state may take a second line at all. Recorded as a gap in `specs/project-open-status.md` §11.7 rather than assumed — this folder may not grant itself an exception to a ratified constraint on a shared region.

## 10. One note on §4's own wording

§4 currently says the welcome placement "is a brief for CJ's design project rather than a repo edit to the generated pixel layer." That brief is now **discharged** by refreshes (13) and (14). If CJ ratifies, that clause can be replaced with a pointer to `docs/design/specs/project-open-status.md` §1 — the same pattern §4 already uses for the toolbar row budget and the outbound-turn-context line.
