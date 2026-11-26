ABOUTME: Handoff for the owner's design project to draw the run activity line that says a run read the author's decisions.
ABOUTME: Behavior is owned by `docs/ux-design.md` §2 "Reading the author's decisions"; this file does not replace `docs/design/` appearance authority.

# Decision-read activity line visual refresh brief (FR-AGENT-8, D35, Q28(b))

**Behavior:** `docs/ux-design.md` §2, *Reading the author's decisions* (williacj/emend#93). A run that reads a tracked change's disposition or a thread's closure outcome shows one feed line per document. The line's verb is `Checking decisions`, and it names the document the way every other feed line names one. The line says that the run looked, never what it found. Draw it without hand-editing `docs/design/` in this repository.

**Why a brief is needed:** `docs/design/` draws no run card in hi-fi. `specs/timeline-rail.md`'s Feed section draws the user message, agent message and change-set cards, the collapsed summary row and the new-activity chip. The run card exists only as lo-fi `1d`, and #1391 holds a prior claim on it (`docs/ux-design.md` J13, historical brief item 2). The new line therefore has no drawn home yet.

## Frames to add

1. **A running run that has read decisions:** show the expanded run card's live activity feed with ordinary `Reading` lines and one `Checking decisions` line for a document. Use the same row treatment as every other activity line. The line carries no count, no outcome, no icon of its own that implies a result, and no link.
2. **Two documents:** the same run reads decisions on two documents. Show one `Checking decisions` line for each, never a combined or counted line.
3. **A completed run, collapsed and expanded:** the collapsed summary row is unchanged and does not mention decisions. A run whose only reads were decisions still reads `no files read`. Expanding the card restores the feed with the `Checking decisions` line in place.
4. **A failed or stopped run:** the `Checking decisions` line stays in the feed beside J7's failure copy.

## Appearance details to resolve in the generated design

- Carry Windows and macOS run-card conventions through each frame (`specs/platform-variants.md`, `specs/tokens.md`). Both platforms use the same words.
- Keep the line legible as an inbound read, like the `Reading` lines beside it. It must not borrow the `↑ OUT` outbound treatment that `4g` draws for J13.
- A long document name follows the existing activity-line rule: one bounded line, with the full name available (FR-X-3, #1117).

**Authority boundary:** `docs/ux-design.md` §2 governs the line's behavior and words. Existing `docs/design/` specs govern appearance until the owner's design-project refresh publishes the run card.
