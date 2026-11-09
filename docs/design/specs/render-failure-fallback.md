# The render-failure fallback (#2130 / J15 / UXR-Q23)

**Appearance only.** Copy, states, flow, focus contract and every prohibition below bind in `../ux-design.md` §2 *Render-failure fallback states* and **J15**, *Recover from a render failure* — **proposed at the DH-7 gate (#2130, PR #2301), not ratified**. This file settles what the surface looks like and nothing else. Where a value here implies behavior J15 does not record, **raise it with CJ**.

**Two behavioural questions the independent review of PR #2301 raised are now recorded in J15 and drawn here:** the **narrow Principle 3 / J7 exception** (live agent activity, permission controls and `[Stop]` unavailable until a successful reload/remount — accepted 2026-09-04), and **native close** (§5a / `12f` — accepted 2026-09-04).

Mocks: **`12a`** (Windows 11, author with a project, focus on mount) · **`12b`** (macOS, same state) · **`12c`** (Windows-led set: the remaining copy states and the two reload outcomes) · **`12d`** (macOS mirror set) · **`12f`** (native close — safe close, or a mode-safe refusal) · **`12e`** (mount transition, focus order, and what the surface refuses).

Traces FR-X-5, Principle 2 (the named exception), Principle 3 / J7 (the accepted narrow exception), Principle 4, Principle 7. Distinct from #2102's *Unattributed internal failure* status line by mechanism and by consequence; that line is drawn nowhere in this folder and this surface is not its spec.

---

## 1. The window

One terminal, whole-window state. **Only the outer platform window frame survives.** Nothing of the ordinary shell is mounted around it: no project rail, tab strip, toolbar, document-notice slot, standing-conditions strip, document-info row, status bar, review bar, comments column, timeline rail, reviewer doc-set bar or reviewer body. There is no pane-level card, no `Something went wrong` tile inside a surviving shell, and no fifth standing status region.

| Element | Windows 11 (`12a`) | macOS (`12b`) |
|---|---|---|
| Window radius | 8px | 12px |
| Window shadow | `0 18px 44px rgba(31,29,26,.18), 0 0 0 1px rgba(31,29,26,.1)` | `0 22px 54px rgba(31,29,26,.22), 0 0 0 1px rgba(31,29,26,.1)` |
| Title bar | 38px, `#E8E4DB`, 1px bottom `#DCD7CC`. App icon: the Emend small-size mark (b) at 15px, radius 3px (`icons/emend-glyph.svg`; `#4F46E5` body, white strokes; the same drawing in light and dark) + `Emend` at 12.5px `#4A463E`. Window controls right: 46px cells, `—` `▢` `✕` | 44px, `#EDEAE2`, 1px bottom `#DCD7CC`. Traffic lights left (12px, gap 8px, `#F0655A` `#F3BE4E` `#61C554`). **Centre empty** |
| Window body | `#EDEAE3` | `#EDEAE3` |

**The title bar loses everything the shell owned.** Windows drops the `— positioning-brief` document clause; macOS drops the centred document title, the `‹‹`/`››` rail-toggle pair, the `Saved · 2:14 PM` state and `Share ▾`. Those are app chrome drawn *into* the platform bar by the shell, and the shell is gone; a document or project name here would be a claim about a tree that no longer exists. The platform's own minimize / maximize / close and the traffic lights remain, and they are the **only** way out of this window other than `[Reload window]`.

**The body is `#EDEAE3`, the page background — not the `#FCFBF8` document canvas.** Every other full-window mock in this folder fills its body with paper. This one fills it with the surface the mocks show *behind* a window. That single substitution is what makes the state read terminal rather than like an empty document, and it is the mechanism that does the work here — **not** alarm colour. There is no red band, no amber band, no tint, no rule, no icon.

## 2. The content column

One centred column, top-weighted. **The column is the `main` root** — the one programmatically focusable element the mount transition targets (§4).

| | `12a` / `12b` (1400px window) | `12c` / `12d` (660px study models) |
|---|---|---|
| Column width | 520px | 470px |
| Top padding | 96px | 48px |
| Internal gap | 18px | 14px |
| Button block | \`align-items: flex-start\` — the control **hugs its label** | Same |
| Heading | Source Serif 4 600, **21px** / 1.3, `letter-spacing:-.01em`, `#1F1D1A` | 18px, otherwise identical |
| Body | IBM Plex Sans 400, **13.5px** / 1.65, `#4A463E` | 12.5px, otherwise identical |

Both heading and body carry `text-wrap: pretty`. The column is horizontally centred in the window and **top-aligned, not vertically centred** — J15 gives the fallback a fresh viewport beginning at its top, and a vertically centred column would move as the copy changes length across the four modes.

**The heading is the document-title role, borrowed deliberately.** Source Serif 4 600 is the largest and calmest type the system has, and the copy is careful not to assert loss — the heading says Emend cannot *show* the window, the body says it cannot *confirm* what was kept. A UI-sans heading would read as chrome, and there is no chrome; a warning glyph or a red heading would read as confirmed loss, which is the one thing this state must not imply.

## 3. Copy and the four rows

**The strings are `../ux-design.md` §2's, verbatim.** They are reproduced here only so the drawing can be checked against them. If they differ, §2 wins and the difference is a refresh bug — raise it.

**Sentence three of the author-project body is conditional** — see the note below the table, and `12c`.1 / `12d`.1 for the rendering without it. §2 gives the row as one string; the conditional is J15 Phase B’s.

| Row | Heading | Body | Drawn in |
|---|---|---|---|
| Author, project established — **a run was working or waiting** | `Emend can’t show this window right now.` | `Your saved documents are still in the project folder. Emend can’t confirm from this screen whether every unsaved edit was kept. If an agent run was working or waiting for permission, it may still be active; reloading does not stop it or decide the permission request. Reloading starts this window again from the last state Emend can restore.` | `12a`, `12b` |
| Author, project established — **no run was in flight** | same | the same string **with sentence three absent** | `12c`.1, `12d`.1 |
| Author, no project established | same | `No project is open in this window. Reloading starts Emend again.` | `12c`.2, `12d`.2 |
| Reviewer mode established | `Emend can’t show this review right now.` | `A comment or suggestion that was in progress may not have been sent. Reloading starts this window again from the last review state Emend can restore.` | `12c`.3 (Win frame), `12d`.3 (mac frame) |
| Context not established | `Emend can’t show this window right now.` | `Reloading starts Emend again.` | `12c`.4, `12d`.4 |

**The agent sentence is conditional, and its absence is a drawn state.** Sentence three of the author-project body renders only where a run was working or waiting for permission. `12c`.1 / `12d`.1 exist to fix the shorter rendering's appearance, because a three-sentence and a four-sentence body are the same row with different measures — nothing about the layout, column width or button position changes between them. No stale `working` or `waiting` row, elapsed clock, activity item or permission control appears in either.

**Reviewer copy leaks nothing.** No project path, managed checkout, branch, sync detail, autosave state or author recovery control is drawn in `12c`.3 / `12d`.3, and the heading names the *review*. Where the last mode cannot be established, the neutral row is drawn — the fallback never guesses author or reviewer context.

**`12c`.3 is drawn on the Windows frame and `12d`.3 on the macOS frame, deliberately.** Reviewer mode is a whole-window mode and its fallback composition is byte-identical to author mode's below the title bar; crossing the frames in the two sets demonstrates that, and keeps either set from being read as a platform-specific reviewer treatment.

## 4. Focus, and the one announcement

Drawn in `12a` / `12b` (focus on the root) and `12e` (the transition as a numbered sequence).

**Two new tokens.** Nothing else in this folder needed a visible focus treatment at window scale.

| | Windows 11 | macOS |
|---|---|---|
| Focus ring | `outline: 2px solid #1F1D1A` | `outline: 3px solid rgba(79,70,229,.72)` |
| Offset — on the `main` root | `outline-offset: 6px` | `outline-offset: 6px` |
| Offset — on the button | `outline-offset: 3px` | `outline-offset: 3px` |

**Offset differs by target, not by platform:** 6px on the root, 3px on the button, identically on Windows and macOS. Only the ring’s width and colour are platform-specific.

Windows takes the ink outline; macOS takes the softened accent halo. Both derive from existing `tokens.md` values (`#1F1D1A`, `#4F46E5`). These rings are for **this surface**; the correction galleries' `2px #4F46E5` at `outline-offset:1px` continues to govern in-shell controls.

The sequence, drawn in `12e`:

1. **The tree is gone.** The app header, shared status region, panes, rails, focus target and scroll positions cease to exist.
2. **The fallback replaces it** immediately, with **no animation** — nothing of the old shell fades, slides or lingers — and **no automatic retry**.
3. **Focus moves exactly once**, to the single `main` root: programmatically focusable, named by the heading, described by the body. **The root is not `role=alert` and carries no `aria-live`**, and there is no nested announcer. The focus move *is* the announcement.
4. **The next Tab stop is `[Reload window]`.** It is the only other focusable thing inside the window.
5. **Re-rendering this mounted instance moves focus again nowhere** and announces nothing again.
6. **Activation → pending** (§5). The control keeps focus and keeps its place.
7. **Success** returns through the ordinary welcome / author / reviewer entry path. **Rejection or bounded noncompletion** stays in this instance (§5). **A new render failure** mounts a fresh instance and repeats 2–5 exactly once.

The fallback owns a fresh viewport beginning at its top: it scrolls no surviving document or rail, because there is none, and claims no restored scroll position. This is J15's narrow, named exception to Principle 2 — leaving focus on a removed node is not preservation.

## 5. The one control, and its three states

Ink primary, the system's heaviest button. It is the only control in the window, so it ranks against nothing and needs no secondary; a quieter weight would leave a terminal surface with no visible route out.

| State | Windows 11 | macOS |
|---|---|---|
| `Reload window` (rest) | `#1F1D1A` fill, `#FCFBF8` label, 12.5px/500, padding 8px 16px, radius **6px** | Same, radius **7px**, `box-shadow: 0 1px 2px rgba(31,29,26,.18)` |
| `Reloading window…` (pending) | `#E8E4DB` fill, 1px `#D5D0C4`, `#6B665C` label, radius 6px | Same, radius 7px |
| `Reload window` (restored after a failed request) | Identical to rest, **with focus retained** | Same |

**The pending control is inert-but-present, not disabled-and-gone.** It takes the same muted-never-removed treatment the correction galleries use for an inert `✎` — muted fill, muted label, same geometry, same position — and it **stays focusable and keeps its focus ring**, so focus is never orphaned mid-request. A second activation joins the pending request rather than starting another.

**The button hugs its label — it is never a full-width bar.** The button-and-status block is \`align-items: flex-start\`, so the control is exactly its padding plus label (roughly 130px at \`Reload window\`, 154px at \`Reloading window…\`) and shares the column's left edge. A stretched ink bar the width of the measure is a different weight from a primary control, and button weight is one of the four things J15's brief asked this prototype to settle.

**No spinner, no progress bar, no percentage.** An indeterminate animation would be the only motion on a terminal surface, and it would claim progress this screen cannot observe. The word change carries the state.

**The failure status is adjacent text, not a band.** `12c`.6 / `12d`.6 place `Emend couldn’t reload this window. Try again.` below the restored button: IBM Plex Sans 400, 12.5px / 1.5, `#A33A2E`, **no fill, no border, no radius, no icon** — the reject token as text only. 10px gap from the button, same left edge, same measure.

That line is the fallback's **only** live region: a **polite, atomic `role=status`**, absent while a request is pending and inserted **once** for that request's failed outcome, so it announces without re-announcing the fallback. A later deliberate request clears it before pending begins. Nothing on the surface counts attempts or claims progress.

## 5a. Native close while the fallback is mounted

Drawn in **`12f`**. **Recorded in J15** (ruled 2026-09-04). J15 originally defined no close behaviour; this is the disposition it now records.

| Guard situation | Native close (Windows `✕`, macOS red light) does |
|---|---|
| **No guard applies** — nothing unsaved, no untitled buffer, no active or awaiting run, no unsent reviewer work | **Closes the window**, exactly as from the ordinary shell. Nothing is drawn; there is no fallback-specific confirmation |
| **Any guard would normally hold** — dirty or untitled author work, an active or awaiting run, unsent reviewer comment or suggestion | **Refuses.** The fallback stays mounted, the protected work stays protected, a mode-safe reason appears in the status slot, and `[Reload window]` remains the only action |

**Why refusal and not a confirm-and-discard.** The dirty-close guard, the untitled-close guard, the run-refusal dialog and the reviewer send confirmation all lived in the failed tree. A discard offer here would assert loss semantics the body has already declined to assert — it says Emend *can’t confirm whether every unsaved edit was kept* — so a `Close anyway` directly above that sentence would contradict it. Refusal is the only disposition consistent with the copy, and recovering the real guards is what the one button is for.

**It reuses the single status slot; it is not a second live region.** The refusal text occupies the same position below the button as the reload-failure line (§5), and the two are **mutually exclusive** — one slot, one polite atomic `role=status`, whichever reason is current. A refusal **does not move focus**: focus stays where the user left it, §4’s once-only rule is untouched, and the platform’s own close affordance keeps its ordinary highlight.

**Neutral ink, not the reject colour.** `#33302A` plain 12.5px / 1.5 at the same measure and left edge — no fill, border, radius or icon. Refusing to close is protective and expected; the `#A33A2E` reload-failure line is the surface’s one action not working. Same slot, same type, different claim.

**Mode-safe, and assembled from the guards actually holding.** No document, project, path, branch, checkout or run is named in either mode; where only one guard holds, only that clause renders. No `Close anyway`, `Discard`, `Stop` or `Send` appears — those are ordinary controls.

**The two refusal strings are adopted in §2.** Every string in turn 12 is §2 verbatim, these two included. What `12f` settles is the composition and the disposition:

- Author, guards holding — `Emend can’t close this window yet. There’s unsaved work, and an agent run may still be active. Reload the window to get the ordinary controls back.`
- Reviewer, guards holding — `Emend can’t close this review yet. A comment or suggestion may not have been sent. Reload the window to get the ordinary controls back.`

## 6. Deliberately absent

Every item below is absent by ruling, not undrawn. Do not add it, and do not derive it from another surface in this folder.

- **No `Dismiss`**, and no in-surface close or discard. Dismissal would recreate the blank window this state exists to prevent, and an in-surface discard would need loss semantics the failed tree took with it. Closing stays the platform frame's job — governed by §5a.
- **No `Try another way`**, alternate route, safe-mode entry or second action of any kind. One control.
- **No raw error detail** — no exception text, component name, stack, file path or developer vocabulary, in either mode. It belongs in structured logs.
- **No toast, no standing status band, no fifth region.** The #2102 status line is neither preserved inside this surface nor queued for after a reload.
- **No agent activity, no permission controls, no `[Stop]`, no run card, no elapsed clock.** While this fallback is mounted, Principle 3's live activity feed and J7's inline permission controls are unavailable — the **narrow exception, recorded in J15** (accepted 2026-09-04), scoped to the interval between the failed tree and a successful reload/remount. The conditional sentence is the only acknowledgement a run may exist, and `12f` is why that is survivable: a run in flight makes the window refuse to close rather than silently abandoning it.
- **No reassurance clause.** Never `Your work is safe`, `Nothing was lost`, or `All changes were saved`. The author copy names durable file text and then names the limit, and those are two different claims.
- **No alarm iconography** — no warning triangle, no broken-window glyph, no colour-coded severity.
- **No responsive rule of its own.** The surface has one control and no groups to collapse, so nothing collapses. The 660px study models in `12c` / `12d` are scale drawings that fit six states on one canvas — two per row inside a 1368px wrapping block, comparable to the hero artboards — **not a breakpoint**.

## 7. What is not settled here

- **Behavior is not.** J15 and §2 are **proposed, not ratified** — though the Principle 3 / J7 exception and the native-close disposition (§5a) are **recorded in J15**, not open questions. The render-boundary signal, structured logging without consuming the runtime signal, mode establishment outside the failed tree, and the remount success / rejection / bounded-noncompletion contract are the **Architect's**, and J15 states they do not inherit TD-25 by analogy.
- **The pending → success transition is undrawn.** `12c`.5 / `12d`.5 draw the pending state; what the window shows between a successful remount request and the ordinary entry path rendering is not drawn, deliberately — it is the ordinary entry path's own first frame.
- **No dark mode**, consistent with the rest of this folder.
