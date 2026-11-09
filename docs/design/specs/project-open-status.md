# Project-open progress and outcomes in the shared status region (#1752 / J9 / FR-X-11)

Mocks: `13a` (Windows welcome) / `13b` (macOS welcome) / `13c` (Windows authoring, close refused) / `13d` (macOS **workshop**, failure) / `13e` (all seven states + the surface matrix) / `13f` (actions and their states) / `13g` (one line, and the clipping order) / `13h` (`[Show the run]` destination, all three frames). Read `tokens.md` and `platform-variants.md` first.

**(16) Amended by refresh (16)** with clear-time focus recovery for the automatic clear (§8, *How the refusal clears*, item 6; §5), inside the existing §11 item 5 — no ninth disposition. **Revised by refresh (14)** after the independent review of refresh (13). Seven corrections are applied and are marked **(14)** where they change what (13) said; the eight dispositions and their current status are enumerated in §11.

**Behavior is not this file's.** It binds in `../functional-spec.md` **FR-X-10 / FR-X-11 / FR-X-12** and **D26**, and in `../ux-design.md` **J9 — "Open another project (routing across instances)"** with §2 *Project-open routing states* and §4 *Status region* — **ratified by CJ 2026-08-09 (DH-7), epic #759**. Routing, the four outcomes, the queue rule, the bounded deadline, the raise-is-not-focus-theft ruling and the no-stop-and-close rule are all settled there and are **not restated as design decisions here**.

This file settles **appearance**: whether the existing band is adopted, where it sits on the welcome surface, message and action hierarchy, action order, platform treatment, control states, announcement behavior, and the clipping order. The eight §11 behavior dispositions were ratified into the repo's `docs/ux-design.md` on 2026-09-14. CJ reversed the in-flight `✕` disposition on 2026-10-01; its repo prose amendment was pending at export and is applied by issue #2531 (`../amendments/2026-10-01-pending-prose.md` §A).

---

## 1. The band is adopted, not replaced — and it holds one line

**Adopted, verbatim, on all three surfaces.** The one-line non-modal status region §4 already establishes — full workspace width, between the app header and the body, dismissible on welcome / authoring / workshop — hosts every project-open state. No new region, no toast, no dialog, no panel, no welcome-only vocabulary, and no second band. §4's own words bind: *"the **same region, in the same place, under the same rules** therefore hosts document and project actions."*

What this refresh adds is the part §4 recorded as missing: *"Its appearance on the welcome surface is undrawn (`1a` carries no status region and predates this decision)."*

**(14) One line-height, in every state, including the failure.** Refresh (13) drew the failure state as two lines at ~56px and permitted a second line below ~560px of width. **Both are withdrawn.** §4 and **UXR-Q15** constrain this shared region to one line-height with **clipping, not wrapping**, and §2's *Unattributed internal failure* states the discipline in words this file now follows exactly: *"One line, and the band's height is never what gives way."* The failure carries its reason **inside the same line** (§3), and the clipping order in §9 is what absorbs the loss. **If two lines turn out to be genuinely necessary for the failure state, that is a proposed J9 / §4 delta for CJ** (§11.7) — not something this folder may grant itself, and not drawn as though it were settled.

| | Windows 11 | macOS |
|---|---|---|
| Fill | `#F7F5EF` | `#F7F5EF` |
| Edge | `border-bottom: 1px solid #E3DFD6` | `box-shadow: 0 1px 0 #DCD7CC` |
| Padding | 9px 14px | 9px 14px |
| Height | **46px**, in **all seven states** — a fixed `min-height` with `box-sizing:border-box`, so no state shrink-wraps to a different box or shifts the body under the user | same |
| Message | 12.5px/1.45 `#33302A` | same |
| Failure reason | 12.5px/1.45 `#6B665C`, **on the same line**, after a single space | same |

**No colour, no icon, no dot, no spinner, in any of the seven states.** `../ux-design.md` §2 is explicit that severity is not encoded in this region. An amber dot means one specific thing in this system — *your work is at stake and Emend has stopped writing* — and nothing in project-open routing puts the author's text at risk; a Reject-family band would assert the same falsely. The trailing `…` on `Opening <name>…` is the whole of the progress indication.

**Placement per surface**

- **Authoring** — unchanged and adopted: between the app header and the body, above the project rail, tab strip and timeline, at **full workspace width**. It is **not** the document-notice slot (which is below the toolbar and belongs to one document); `authoring-shell.md`'s rule that nothing is ever inserted between the tab strip and the toolbar is untouched, because the band is above both. `13c`.
- **(14) Workshop** — the same region in the same place, above the **project-home strip** as well as the rail. `13d` is redrawn as an actual workshop surface per **J2 Phase A** and §4: **no document open**, the conversation centre-stage, the project-home strip (recent documents · active reviews) above it, the project rail present with **no active row**, and **no tab strip, no editor toolbar, no document status bar and no right rail**. Refresh (13) labelled that option *workshop* and drew an ordinary document workspace; that was a false claim about a surface the package says it covers. Composition follows `10c` and `6b`; this file restyles neither.
- **Welcome** — **immediately below the platform title bar, above the welcome column, full window width.** The welcome screen has no app header, so §4's "between the app header and body" resolves to the title bar as the upper edge. The band is a flex sibling: it **pushes** the centred column down by its own height and never overlays it, and it is never rendered inside the 520px column — a full-width line cannot be mistaken for a card in the welcome flow, and a card could. `13a`, `13b`.
- **Reviewer mode** — **not applicable.** Reviewer mode has no project-open entry point, so none of the seven states reaches it. J6's persistence and non-dismissibility rules are untouched by this refresh.

## 2. Which states each surface can host

A welcome window holds no project. Three of the seven states are therefore **unreachable** there — not undrawn, but impossible under D26.

| State (§2 name) | Welcome | Authoring / workshop |
|---|---|---|
| Requesting (+ `· N more queued`) | yes | yes |
| Adopted here | **the band clears** — the project on screen is the outcome | unreachable (the window already holds a project) |
| Already open here | unreachable | yes |
| Open in another window | yes | yes |
| Opened in a new window | unreachable | yes |
| Failed | yes | yes |
| Close blocked by a run | unreachable | yes |

**Adopted here is drawn as an absence, deliberately.** J9 Phase B: *"The status clears — the project on screen *is* the outcome."* A success line on a window that visibly just became that project is chatter FR-X-5 does not ask for.

**Every surface this table claims is drawn.** Welcome is `13a`/`13b`, authoring is `13c`, workshop is `13d`, and the eight state studies are `13e`. (14) That completeness is a correction: before this refresh, workshop was claimed and not represented.

## 3. Hierarchy

One line, three slots, in reading order:

1. **Message** — `flex:1; min-width:0`, a single `white-space:nowrap` run. The fixed sentence from §2, verbatim, with the project name as its one variable. **In the failure state the reason is the tail of this same run**, in `#6B665C` at the same 12.5px after one space.
2. **Contextual action** — at most **one**, `flex:none`, `white-space:nowrap`, hugging its label. `[Try again]` (Failed) or `[Show the run]` (Close blocked by a run). Never both, never a third, and **never a `Stop the run` shortcut** beside the refusal: J9 rules there is no stop-and-close in v1, so offering the stop here would add a behavior the journey refuses.
3. **Dismiss** — `✕`, `flex:none`, trailing edge. The one constant, so it holds one constant position, exactly like the tab close glyph.

**The project name renders 500-weight in body ink** — not italic, not quoted. That is the rail header's rule for the opened folder's name: it is a proper name. Italic stays reserved for **paths** everywhere in this folder.

**The queue suffix is a second run of the same line**, not a badge: `· 1 more queued` / `· 3 more queued` in `#6B665C` after a middot. Never a count chip, never a second line, never a list of what is queued — the region holds one message, and the queue is a fact about that message.

**(14) No state renders two lines.** Outcome-then-reason survives as a **rank within the line**: fixed sentence in body ink first, reason in muted ink last, so the reason is what a tail ellipsis reaches first. That is the same rank `document-integrity.md` uses and the same placement §2 gives `<detail>`, expressed in one line-height instead of two.

## 4. Buttons and Dismiss

Both actions take the **ordinary** in-bar button, identical to `document-integrity.md`'s:

| | Windows 11 | macOS |
|---|---|---|
| Rest | `#FCFBF8`, 1px `#D5D0C4`, radius 5px, padding 5px 11px, 11.5px/500 `#33302A` | `#FCFBF8`, `0 0 0 1px #DCD7CC`, radius 7px, same padding/size |
| Hover | fill `#F7F5EF` | fill `#F7F5EF` |
| Pressed | fill `#EDEAE2`, no translate | same |
| Focus | `2px #4F46E5`, `outline-offset:1px` | same |
| Retry pending | `Trying…` — fill `#E8E4DB`, edge `#D5D0C4` / `#DCD7CC`, label `#6B665C`, inert, **still focusable and still ringed** | same |

**(14) Retry-pending keeps its focus ring, and it is now drawn.** Refresh (13) stated that the inert `Trying…` control "keeps focus and keeps its ring" and drew it without one. The **2px `#4F46E5` ring at `outline-offset:1px`** is drawn on both platforms in `13f.1`/`13f.2` and in the in-band examples `13f.3` (Windows) / `13f.4` (macOS). An inert control that silently lost its ring is a keyboard user's focus disappearing, which is the opposite of the reason the control stays present at all.

**No highlighted default anywhere in this band.** The solid-accent treatment marks the choice that protects the author's work (`Keep mine`), and no project-open outcome puts anything of theirs at risk. **Nothing is styled destructive.**

**Dismiss** — 24×24 box, `✕` 11px `#A39E92`, radius 5px. Hover: `#EDEAE2` fill, glyph `#33302A`. Focus: the same 2px `#4F46E5` ring at offset 1px. Accessible name `Dismiss`.

**Present or absent, never disabled** — `authoring-shell.md`'s standing rule. No greyed `[Try again]` on a success line; no greyed `✕` during a request.

**Two consequences of that rule, both drawn:**

- **(18) `✕` is present while a request is in flight** (`Opening…`, and while a retry is pending) — ruled by CJ 2026-10-01. Dismissing hides the band only; the request continues, and **the band returns with the outcome** when it arrives, so FR-X-11’s visible outcome still lands. Drawn in `13a`, `13e` states 1/2/2′ and `13f.3`/`13f.4`. **At export, the repo prose said absent** (`../ux-design.md` J9 Phase A, §2 Requesting, §4); issue #2531 carries the replacement recorded in `../amendments/2026-10-01-pending-prose.md` §A.
- **Retry-pending is the one inert-but-present control.** Removing the button the user just pressed would drop keyboard focus into nothing — the same reason `render-failure-fallback.md` §4 keeps `Reloading window…` in place. The band takes `aria-busy="true"` for the duration so the churn is not announced, and a second activation **joins** the pending retry rather than starting a second one.

## 5. Focus

- **Appearing takes no focus, in every state** — including the refusal and the failure. An author mid-sentence keeps their caret; a welcome user keeps their place in the Recent list. The band is `role="status"`, never a dialog: no trap, no overlay, no `aria-modal`.
- Its controls are reachable in **normal tab order**, between the chrome above and the first pane below: message (not focusable) → contextual action → `✕`.
- Focus ring is the app's in-shell convention — **2px `#4F46E5`, `outline-offset:1px`** on both platforms. The render-failure fallback's ink/halo rings at 6px and 3px belong to that surface and do not apply here.
- **Only two focus moves exist on this surface**: `[Show the run]`'s destination (§8), which the user asked for, and **clear-time focus recovery** when an automatic clear removes the band from under a control inside it (§8, *How the refusal clears*, item 6). Neither ever happens on appearance.

## 6. Announcement

**One polite atomic live region per surface** — `role="status"`, `aria-live="polite"`, `aria-atomic="true"` — announcing the whole band on every change. This matches `MissingOnDiskBanner`, the shell status region and `recovered-document.md`'s failure line.

- **Atomic, so a failure is heard as one thing**: outcome, then reason, in one pass. **(14) The reason is announced in full even when its display is clipped** — the text stays in the DOM and only its rendering is truncated, exactly as §2 requires for `<detail>`.
- **Message identity governs repetition** (§2's rule for this region): a message identical to the one already showing changes nothing on screen and is **not** re-announced. The queue suffix is part of the message for that comparison — `· 2 more queued` → `· 1 more queued` **is** a change and **is** announced.
- **Starting a new request clears the prior status** (§4), so a repeated failure is announced again.
- **`aria-busy="true"` while a retry is in flight** suppresses the churn; the outcome is what deserves the announcement.
- **Dismissal announces nothing**, and clearing on `Adopted here` announces nothing — the arriving project is the announcement.
- **No `role="alert"` and no assertive region** in any state. Nothing here interrupts.

## 7. Ratified failure line

### 7a. (14) The leading sentence comes from `failureRoute`, never from the reason code

**The problem refresh (13) left.** J9 records **one** leading sentence, which names the **launch** route. Two reason codes fail on the **raise** route, and four can fail before any route exists — so refresh (13) proposed two more sentences and then mapped them **from the reason code**. That mapping cannot be honest: `deadline_expired` can expire **before route selection, during adoption, during raise, or during launch**, and `registry_unavailable` can arrive **after** route resolution during activation or adoption setup. The earlier failed outcome carried only `root` and `reason`, so the renderer had no truthful basis for choosing between *launch*, *raise* and *undetermined*.

**Required design-state input (ratified 2026-09-14):**

```
failureRoute: "undetermined" | "raise" | "launch"
```

carried on TD-20's existing failed-outcome stream beside `root` and `reason`. **The Architect has confirmed that adding this discriminator is a narrow refinement of an existing contract and does not require a new TD decision.** The **wording** of the two added sentences is CJ's.

**How it selects the leading sentence — and it is the only input that does:**

| `failureRoute` | Leading sentence | Status |
|---|---|---|
| `launch` | `Emend couldn’t open <name> in a new window.` | **J9 verbatim, ratified** |
| `raise` | `Emend couldn’t bring <name> to the front.` | **ratified** |
| `undetermined` | `Emend couldn’t open <name>.` | **ratified** |

**Rules on that selection:**

- The renderer reads **`failureRoute` alone**. It never infers the route from `reason`, and there is **no per-reason default** — a reason code arriving without a `failureRoute` is a contract violation, not a case for guessing, and until the field exists the honest presentation is `undetermined` for every failure.
- `undetermined` is **not** a degraded state and carries no hedging words. It is the true sentence when Emend did not get far enough to attempt either route, and it reads as a complete statement.
- No sentence names a window Emend did not try to open or raise. That is the whole point of the discriminator.

### 7b. (14) The seven detail texts, rewritten to be truthful for every condition they cover

J9 Phase C requires the failure to state **why** (`<leading sentence> <detail>`). Refresh (13)'s strings overclaimed what their backend codes prove; the seven strings below replace them and were **ratified 2026-09-14** in `docs/ux-design.md`.

| Reason code | What the code actually covers | Ratified detail text | Routes it can arrive on |
|---|---|---|---|
| `project_unavailable` | **Every** canonicalization failure for the chosen root — missing, renamed, unreadable, not a usable path, on a volume that is gone | `That folder isn’t available to Emend.` | `undetermined` |
| `open_failed` | Reading the folder **and** provider-session loading, watcher startup and MCP-server startup | `Emend couldn’t finish setting up that project.` | `undetermined` |
| `deadline_expired` | The bounded FR-X-11 deadline, expiring **before route selection, during adoption, during raise, or during launch** | `It took too long, so Emend stopped waiting.` | any of the three |
| `registry_unavailable` | Instance bookkeeping unavailable — **at route resolution, and also during activation or adoption setup** | `Emend couldn’t keep track of its open windows.` | `undetermined`, `raise`, `launch` |
| `launch_failed` | The new window did not start | `The new window didn’t start.` | `launch` |
| `owner_unavailable` | The owning instance did not answer | `The window that has it isn’t responding.` | `raise` |
| `activation_refused` | The platform declined to raise the owning window | `The system wouldn’t bring that window to the front.` | `raise` |

**What changed and why (14).** `project_unavailable` no longer says *"that folder isn't on this computer any more"* — that is one of several conditions the code covers, and false for a folder that is present but unreadable. `open_failed` no longer says *"Emend couldn't read that folder"* — the code also covers three startup paths that have nothing to do with reading. `registry_unavailable` no longer says *"couldn't tell which windows are open"* — that describes only the route-resolution case and misstates an activation-time failure. `deadline_expired` no longer says *"it took too long to answer"*, which presumes a request-and-response that some of its cases never reached.

**The alternative, recorded rather than assumed.** Every string above is broad because the reason code beneath it is broad. CJ's other route is to **require a narrower backend reason taxonomy** — splitting `project_unavailable` and `open_failed` into per-condition codes so each can carry a specific sentence. That would be a **contract change** for the Architect and CJ; CJ retained the existing taxonomy on 2026-09-14 (§11.8). This folder's rule either way: **every displayed statement must be true for every condition its reason code represents.**

**Rules the seven texts follow, and which any substitute should:**

- **One short plain sentence**, fitting the one line beside the leading sentence at ordinary widths; when it does not fit, §9 clips it rather than wrapping the band.
- **True for the whole code**, never for its most vivid case.
- **No machinery in user-facing words** (Principle 4, J9 Phase C, FR-X-10): no lock, instance, registry, IPC, handle, mutex, timeout, PID or process. Never *"the project is in use"*, and never a force-unlock offer — leftover bookkeeping from an instance that is gone is never the user's problem.
- **No blame and no OS-naming variance.** `activation_refused` says *the system*, identically on both platforms; substituting "Windows"/"macOS" would make one string two and read as blame-shifting.
- **No instruction.** `[Try again]` is the instruction, and the band already carries it.
- **No raw error text**, ever. It belongs in structured logs — the same rule `render-failure-fallback.md` §6 states. (The `<detail>` verbatim-interpolation exception §2 grants the *Unattributed internal failure* line is bounded to that one state and does not reach here.)

## 8. Ratified `[Show the run]` behavior

J9 names the action and its purpose (*"reveals the active run card in the timeline"*). The details below were ratified into `docs/ux-design.md` on 2026-09-14 and are drawn in `13h.1`–`13h.3`:

1. **(15) The status stays while it is true, and clears when it stops being true.** Activation is not a dismissal. The full rule — who clears the refusal, in every ordering — is stated once at the end of this section; refreshes (13) and (14) split it between this item and the closing paragraph, and the two halves read as contradicting each other.
2. **(14) The timeline takes the rail back from the comments column.** §4's *Right-rail occupancy* (UXR-Q7.1, ratified 2026-08-05) gives the rail **two occupants that are never simultaneous**: expanded it holds the timeline; collapsed, the timeline reduces to a `Timeline ››` toolbar chip and the **comments column takes the rail**. Refresh (13) drew the collapsed state as an **absent** right rail, which contradicts that ruling. `13h.1` now draws the **comments column** occupying the 372px rail — which matters especially here, because the blocking run is *addressing comments*, so the threads it is working through are the very thing on screen. Activating `[Show the run]` **replaces the occupant**: the timeline expands to its persisted width through the rail's **one existing control**, the ratified `Timeline ‹‹ / ››` toggle. **No second collapse mechanism is proposed, implied or needed** — production has no general whole-timeline-collapse owner to borrow, and this action must not invent one. Nothing else changes: not the project rail, not the tab set, not the active document.
   **(17) UXR-Q13.1 is ruled** (CJ 2026-09-30): the no-comments column keeps 400px and reads `No comments in this document` — drawn in `4c`. `13h.1` still draws the has-comments case.
3. **(14) Facet selection, reconciled rather than assumed.** Refresh (13) proposed setting the facet to `all` unconditionally. Two ratified things push back: the permission-attention behavior selects **Chat**, and §4's own scroll-motion rule states that **a filter the user deliberately set survives their own Send** — and a status-region action has strictly *less* claim on that filter than the author's own submit. **Ratified rule:** if the active facet already contains the active run card, **the facet is not touched**; only when the active facet would hide the card does it change, and then to **`all`**.
   **Why `all` and not `chat`:** which narrow facet contains a run card depends on the run's **kind**. §4 defines the **Comments** facet as including *"agent addressing runs"*, so the very run in `13c`/`13h` lives under Comments, while a composer-started run lives under Chat. A close refusal can be raised by **any** run kind, so no narrow facet is correct for all of them, and `all` is the only one of `timelineFacet`'s five ratified values (`all`, `chat`, `comments`, `changes`, `findings`) guaranteed to contain the card. The permission-attention case can name Chat because it concerns one known card kind; this one cannot. **No new facet is proposed** — a facet named *Activity* does not exist in this product and must not be introduced by a status-region action.
   **Whether any facet change belongs to this action at all is behavior, and is CJ's** (§11 item 3).
4. **(14) Scroll — the complete edge contract.** Scroll is the timeline's own, never the document's.
   - **(15) The branch condition is exact, and the clearance is part of what must fit:** the *fits* branch applies **only when `cardHeight + 12px <= timelineViewportHeight`**.
   - **In that branch** the card is revealed **whole**, with **12px of clearance above it** — never centred.
   - **Otherwise** — including a card that would fit alone but not with its clearance — the **tall-card branch** applies: the card's **top** is aligned with the same 12px clearance, and **full visibility is not promised**, because it cannot be delivered. `13h.3` draws this. There is no third case and no boundary at which neither branch applies.
   - This is §4's own ratified scroll-motion rule for the author's submit (**#1324, CJ 2026-08-20** — the card *"whole when it fits within the viewport, or just its top … when the card is itself taller than the viewport"*), **reused** rather than a second motion contract invented beside it.
   - **The document pane's scroll position and the caret are untouched**, in every case.
5. **Focus lands on the run card container, never on `[Stop]`.** The card is a programmatically focusable container named by its own heading, and takes the app's ordinary ring (2px `#4F46E5`, `outline-offset:-1px`, the rail-row treatment). Landing focus on a stop control invites an accidental stop of the run the user asked only to *see*.
6. **Nothing is announced.** The focus move is the feedback — the same contract `render-failure-fallback.md` §3 uses for its one focus move.

**Idempotent.** A second activation re-reveals and re-focuses and changes nothing else — same branch condition, same 12px clearance, same facet decision, same focus target.

**How the refusal clears — one rule, covering every ordering.** This rule is the whole answer; nothing elsewhere in this file adds a second clearing condition.

1. **`Dismiss` is the only manual clear** while the refusal is still true.
2. **Completion of the blocking run clears the refusal automatically**, whether completion happens **before or after** `[Show the run]` is activated. Once the run is over the sentence is no longer true, and Emend does not leave a false sentence on screen.
3. **Activating `[Show the run]` never clears the refusal by itself.** Activation is navigation, not dismissal: while the run is still going the refusal is still true, so it stays.
4. **If activation and completion race**, the action still reveals the same run card — now completed — in the same place, with the same geometry and the same focus target.
5. **The refused close is never completed automatically.** When the run ends Emend does not resume the close; the author initiates it again (J9; Principle 2).
6. **(16) Clear-time focus recovery — where focus goes when the band disappears on its own.** An automatic clear can remove the band from under a focused control, and focus must never be dropped to the document body. When completion of the blocking run clears the refusal:
   - **If focus is owned by a control inside the disappearing band** — `[Show the run]` or `✕` — it is restored to the **stable authoring target recorded when the close attempt was refused**.
   - **Restored with `preventScroll`**, so the document, the timeline and the rail keep their scroll positions exactly; recovering focus must not move the view the author is reading.
   - **If that recorded target is disconnected or no longer focusable**, focus goes to the established **shell-level close-attempt target** — the same connected shell-chrome fallback `recovered-document.md` defines for a focus move out of a vanishing subtree.
   - **If `[Show the run]` already moved focus to the run-card container**, focus is **not moved again**. The user's own navigation outranks the recovery.
   - **If focus is already on any other stable target outside the band**, it is **not moved**. Recovery acts only on focus the clear would otherwise destroy.
   - **`Dismiss` is unaffected** and keeps its ordinary explicit-dismiss focus behavior; this rule governs the automatic clear only.
   - **None of this completes the refused close** (item 5). Focus recovery is housekeeping, not resumption.

**No attention flash.** No highlight animation, no temporary tint, no pulse on the revealed card. This folder has no attention-flash pattern, and a run card is already the loudest thing in the feed.

## 9. (14) One line, and the order in which things give way

**The band is one line-height at every width the app allows.** It never wraps, never scrolls, never gains a "more" disclosure and never becomes a card. `13g` draws the ladder.

**The clipping priorities, in the order things give way:**

1. **The failure reason gives way first**, and is the only run allowed to disappear completely. It is the **tail** of the message run, so the line's own tail ellipsis reaches it before anything else — which is exactly why §2 places `<detail>` last, and why this file puts the reason in the same position instead of on a second line.
2. **The project name clips next** — tail-ellipsised *inside* the sentence, down to a **160px floor**, because a project's distinguishing words are at its head.
3. **The fixed words of the leading sentence are last.** Below the width at which they alone fit, the line clips as one run from its tail.

So the reader loses the reason before they lose what Emend attempted, and loses part of the name before they lose the sentence that says what happened. **The full text of both the name and the reason stays present for selection and for assistive technology; only the display is clipped** (§6).

**The project name is the only elastic run in the six non-failure states.** Every one of those strings is a fixed sentence with one variable in it; the variable clips and the fixed words never do. That is what keeps `is already open in this window.` and `— brought it to the front.` readable at every width — those clauses carry the whole informational content, and a tail ellipsis across the sentence would eat exactly them.

**The actions never give way.** `[Try again]`, `[Show the run]` and `✕` are `flex:none` and `white-space:nowrap` and hug their labels; the message column is `min-width:0` and yields first. A band too narrow for its action clips further rather than dropping it — an outcome the user cannot act on is worse than one they cannot read in full.

**No tooltip or `title` carrying the full name.** This system has no hover-disclosure convention, and a line that will be replaced by the next outcome does not justify minting one.

**(14) This band claims no responsive carve-out.** Refresh (13) recorded a sub-560px two-line rule as the second carve-out from `state.md`'s "no responsive behavior below 1400px". That rule is withdrawn with the wrap: one line-height holds at every width, so there is nothing width-dependent left to carve out. The band adds no exception; the folder's responsive exceptions are the 9-series and the 14-series (`14a` 900/1000px toolbar, `14b` sub-560px Settings).

## 10. What this file does not settle

- **The bounded FR-X-11 deadline's duration.** Behavior, and unstated in J9; nothing here draws a countdown, and nothing may.
- **Whether `Recent` rows pre-mark projects as open elsewhere.** J9 rules they do not (UXR-Q8) — drawn accordingly in `13a`/`13b`, where every Recent row is plain.
- **The arriving instance.** FR-X-12 makes it ordinary; it has no states of its own and nothing in this turn describes it.
- **Clone-from-GitHub progress.** J9 routes a completed clone through the same four outcomes and surfaces no git machinery; the clone's own progress presentation is not drawn here and must not be derived from these options.
- **(17) UXR-Q13’s branches are ruled and drawn** in `4c`–`4g` (no-comments column, per-window collapse, composer in expanded Timeline, comment-card run link).
- **The lifted shell context in `13c` / `13d` / `13h` is context, not specification.** Frame, project rail (236px), project-home strip, tab strip, toolbar, canvas, status bar, comments column and timeline (372px, with its `TIMELINE` header row and the five facet pills `All · Chat · Comments · Changes · Findings`) are drawn to `authoring-shell.md`, `timeline-rail.md` and `comments.md` and are shown at reduced detail so the band reads at study width; where they disagree, **those specs win** — this file adds nothing to them. What binds from these options is the **band** and, in `13h`, the **destination**.
- **The in-flight agent run card's own appearance.** The `Agent · working` card in `13c` and `13h` is **illustrative context**, lifted the way the 12-series lifts platform chrome. In-flight run presentation is a recorded gap in `state.md` and binds in `../ux-design.md` J2 / #1391. What binds from `13h` is the **destination** — the reveal geometry, the focus target and the ring — not the card's dot, elapsed time, body or `[Stop]` treatment. The taller-than-viewport card in `13h.3` is padded with illustrative body text for that reason alone.

## 11. Disposition of the eight J9 items

**All eight items were ratified into `docs/ux-design.md` on 2026-09-14.** CJ reversed item 1 on 2026-10-01: `✕` is now present during a request or retry, but the repo said absent at export; issue #2531 carries the replacement recorded in `../amendments/2026-10-01-pending-prose.md` §A. Items 2–8 are already in the repo.

| # | Item | Kind | Where |
|---|---|---|---|
| 1 | **`✕` while a request is in flight** — **ruled: present; dismissing hides the band and it returns with the outcome.** | Conflict — **ruled** | §4; prose alignment §3 |
| 2 | **Two added leading sentences** (`raise`, `undetermined`) — **ruled: accepted, all three selected by `failureRoute`.** | Conflict — **ruled** | §7a; prose alignment §1 |
| 3 | **Facet change inside `[Show the run]`** — **ruled: switch to `all` only when the current facet would hide the run; otherwise untouched.** | Conflict — **ruled** | §8.3; prose alignment §6 |
| 4 | **`failureRoute` as a required design-state input**, and the rule that the renderer reads it alone. The Architect confirms it needs no new TD decision; the wording it selects is CJ's. | Gap — **ruled with item 2** | §7a |
| 5 | **`[Show the run]`'s status persistence, the terminal-clear rule, and **(16)** clear-time focus recovery** — that the refusal survives activation, that run completion clears it automatically in either ordering, that the earlier close is **never** completed automatically, and that an automatic clear restores focus to the recorded stable authoring target with `preventScroll` (falling back to the shell-level close-attempt target, and never moving focus the user already placed elsewhere). | Gap — **ratified 2026-09-14** | §8, *How the refusal clears* |
| 6 | **The seven failure detail texts.** | Gap — **ratified 2026-09-14** | §7b |
| 7 | **Whether the failure state may take a second line.** One line with clipping is ratified; the two-line alternative was rejected. | **Ruled 2026-09-14** | §1, §9 |
| 8 | **Whether to narrow the backend reason taxonomy** instead of broadening the copy — the existing taxonomy was retained. | **Ruled 2026-09-14** | §7b |

**Binding appearance:** the band's adoption and geometry, the 46px one-line height, the welcome and workshop placements, hierarchy and action order, the platform button treatment and all five control states including the retry-pending ring, the polite atomic live region, no-focus-on-appearance, the clipping order, and `[Show the run]`'s reveal geometry, focus target and ring.
