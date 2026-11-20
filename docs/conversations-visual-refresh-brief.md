ABOUTME: Brief for the owner's design project: reconcile turn 16's proposed conversation designs with D4/D15 as amended, FR-CONV-1..10 and J2.
ABOUTME: Lists what turn 16 already draws, what it must change, and what it does not draw; generated `docs/design/` files stay untouched until their next refresh.

# Document and Workshop conversations visual refresh brief

**Decision:** the owner, 2026-10-15, with D34/D35's superseded session-model ruling replaced 2026-11-12 (williacj/emend#22). D4 and D15 as amended, FR-CONV-1..10, J2 and §2 *Conversation states* in `docs/ux-design.md` hold the behavior. Each document keeps its own conversation, and a project keeps named Workshop conversations. A run stays in the conversation it started in. Visible history travels with the project, and provider session IDs stay on the machine.

## What already exists

Turn 16 of `docs/design/` already proposes this appearance, through refresh (30). Its owning spec is `docs/design/specs/agent-conversations.md`, its proposed J2/J13 prose is `docs/design/amendments/j2-j13-agent-conversations.md`, and its mocks are `16a`–`16l` in `mocks/Emend Authoring Shell.dc.html`. Turn 16 is **proposed, not implementable**: it was drawn against the draft conversation model that preceded williacj/emend#22, before these amendments existed. Ratified appearance remains `1b` and `6a`–`6c`, which draw one project-wide conversation and a rail with no Workshop entry.

This brief asks the design project to reconcile turn 16 with the amended constitution, not to draw it again. What it says turn 16 draws is read from that spec's text, so an item below that says the spec records no state asks the design project to check its mocks first and draw the state only where they lack it. Where turn 16 implies behavior that J2 does not record, that behavior is open in `docs/ux-design.md` §5, UXR-Q26, and the refresh keeps it marked as proposed until the owner rules.

## Across turn 16

- **Re-cite the requirements source.** Turn 16 cites that draft, `docs/agent-conversation-model.md` on PR #2692, and its CONV numbering. The refresh cites FR-CONV-1..10, D4, D15, D30, D34 and D35 as amended, J2, and §2 *Conversation states*.
- **Composer-less routes under D34.** `16e.15`'s run-card line, *Workshop summary not included — it waits for your next message*, was drawn for the composer-less routes "as today" when turn 16 was drawn (spec §5), against that draft. Under D34 the composer-less routes are a run started by posting a comment or reply that names an agent, the `[Address with AI]` shortcut included, and FR-CMT-5's `Address all…` batch (FR-CONV-6). Show the line on both.
- **Pending items stay pending.** Each item that UXR-Q26 lists stays proposed after the refresh.

## The five surfaces

1. **Conversation naming.** Drawn: the Workshop title bar `Workshop · <conversation name>`, the list row name, the conversation header, the `New conversation` naming and in-place rename (`16a.4`), `MIGRATED` before **Previous project conversation** in the list, and the document's basename in the Timeline header (`16c`). Reconcile: the naming rule and rename are UXR-Q26.1, so they stay proposed. FR-CONV-5's origin link shows the Workshop conversation's name (`16e` origin link card), which needs no change.
2. **The Workshop list.** Drawn: the list column, find and its no-match state, rows by last activity, row states, and `New conversation` (`16a`, `16b`), plus the 900px width (`16k`). Reconcile: the spec records no empty list for a project with no Workshop conversation yet, and no long list. The *Not in the project* group (`16l.4`) and Rename/Delete (`16l.5`) are UXR-Q26.1 and UXR-Q26.2, so they stay proposed. The destination line before Send (`16a` composer footer) meets FR-CONV-2's "which conversation the run will belong to". Whether the Workshop composer gains that footer is UXR-Q26.8, so it stays marked as a J13 delta.
3. **Menu placement.** Drawn: the fixed Workshop rail entry above Documents with its active and status states (`16a`), and the collapsed rail with an app-menu item, *View › Workshop* (`16b`). Reconcile: the menu and its accelerator are UXR-Q26.7, so they stay open. FR-CONV-2 requires only that an app-menu action reaches the Workshop while the rail is collapsed. The spec records the app-menu route on macOS only (`16b`), so the Windows route needs drawing.
4. **Sent-context disclosure.** Drawn: the Workshop composer with no J13 standing line (`16a`), the preloaded summary in its ready, show-all, editing, edited and removed states, the `↑ OUT` record and *Show what was sent* (`16e`), the migrated-history picker and its record (`16j`), the fresh-session seam stating what was left out (`16g`), and the composer access line (`16k`, held at refresh (30), UXR-Q26.8). Reconcile, in three places:
   - `16j` gives the migrated summary preparing, failed and sent-early states "as §5's", and §5 removed those states (ruling 6). Ruling 6 covers only the summary that arrives when the document is born. A summary prepared on request from **Previous project conversation** can take time and can fail, so `16j` needs its own preparing and failed states. Whether preparing sends turns to a provider is UXR-Q26.4.
   - `16g`'s *Can't continue this conversation here* error is for a history too long to start a new session. Under FR-CONV-9 a long history is bounded and the seam discloses what was left out, and only an accepted handoff that cannot fit in the seed is an error. Redraw the error for that case. Its recovery route is UXR-Q26.5.
   - FR-CONV-4: the spec says the Workshop shows no J13 standing line, and records no Workshop state with dirty open tabs. Show that state, with no unsaved-text disclosure.
5. **The saved-here versus shared status.** Drawn: the three status words, *Saved on this computer*, *Shared with the project* and *Newer turns arrived*, in the Timeline header and Workshop conversation header, and the popover for each (`16g`). They use no Git word, as §2 *Conversation states* requires. Reconcile, in two places:
   - The popover's assurance *Reviewers never see it* (spec §7) is unconditional. FR-CONV-8 excludes conversation records from the automatic review mirror unless the author explicitly shares them, and D15 as amended lets shared history reach collaborators. The copy must say that history is left out of review by default and that the author can share it.
   - The popover's route for sharing history from this computer is UXR-Q26.9, and stays open until the owner rules.

## The surfaces J2 adds

- **Cross-conversation links.** Drawn: the origin change-set card's `ALSO` rows, the affected document's link card, the missing-origin line, and the tracked-change popover (`16f`), plus the Workshop origin link card (`16e`). They meet FR-CONV-3 and FR-CONV-5. No reconciliation is needed.
- **Attention from other conversations.** Drawn: the Elsewhere row, tab markers, rail-row dots, and the queued-turn copy (`16d`, `16c.5`, `16c.6`, `16k.4`). FR-CONV-3 requires only that they are discoverable. J7's activation change (F7) and the unseen-run markers (F18) are UXR-Q26.8.
- **The divergence marker.** Drawn: *Continued on another computer* on the seam divider (`16g.14`, `16g.15`). It meets FR-CONV-8. No reconciliation is needed.
- **Migration and relink.** Drawn: the migration notice, the converting, failed and done states in the list (`16g`), the selective handoff picker (`16j`), and the relink notice and picker (`16l.1`, `16l.2`). Reconcile: the notice's marker timing is UXR-Q26.3, and the relink offer and undo are UXR-Q26.2, so they stay proposed.

## Not recorded in turn 16's spec

- An empty Workshop list, and a long one (item 2).
- The Windows app-menu route to the Workshop (item 3).
- The error for an accepted handoff that cannot fit in a fresh session's seed, in place of `16g`'s too-long error (item 4).
- The preparing and failed states of a summary prepared from **Previous project conversation** (item 4).
- Where the conversation of a recovered or unsupported document is found. `16l.4` covers missing and discarded documents only (FR-CONV-7, UXR-Q26.2).
- The Workshop composer while open tabs are dirty (item 4).

Behavior and eligibility bind in `docs/functional-spec.md` FR-CONV-1..10 and in `docs/ux-design.md` J2 and §2. This brief asks the design project only for their appearance. Nothing under `docs/design/` is edited by hand.
