ABOUTME: Defines the design-project refresh needed for J10's child-first withdrawal rule.
ABOUTME: This is a handoff brief; generated `docs/design/` files remain untouched until their next refresh.

# J10 child-first Delete visual refresh brief

**Decision:** CJ, 2026-09-30 (America/Chicago); D24 / FR-CMT-8..11 and J10. A comment or reply with any unwithdrawn descendant reply cannot be deleted, even when the thread is resolved or dismissed. Each actor can delete only their own words in v1. Owner moderation belongs to a later permissions model.

Refresh `5a` (Windows), `5b` (macOS), `5c` (cross-surface), and their `specs/comments.md` / `specs/state.md` descriptions:

1. On an authored parent with an unwithdrawn child reply, keep `Delete comment` visible but inert in the existing overflow menu. State the reason next to the control: delete the replies first. Do not open confirmation. Apply the same state to a reply that has a child of its own. A reply by another actor can leave the parent unavailable indefinitely in v1; do not offer a way to delete that actor's reply.
2. Remove the private-root cascade confirmation and the published/replied confirmation's claim that replies remain. A parent can reach confirmation only after every descendant reply is withdrawn. The existing clean-disappearance confirmation applies to an unpublished parent with no historical reply by another actor; the already-seen confirmation applies to a published parent or one historically replied to by another actor. Keep the fixed text-survival and no-undo statement.
3. Remove the mock's ordinary parent-with-live-replies withdrawn placeholder. A published parent **without live replies** can still leave the established withdrawn placeholder, with its author/time and anchor route; historical reply provenance can also require it under FR-CMT-9. An offline reply by any author that arrives after an admitted withdrawal is the exceptional convergence state: show that live reply beneath the placeholder, even for a formerly private parent, and never discard its record. A withdrawn descendant is no longer a live blocker; preserve the existing `5a.3b` nested provenance line when its containing thread is shown. This refresh sets no new child-placeholder policy after a later parent withdrawal.
4. Show the child-present refusal and eligible confirmation consistently in the comments column, editor popover, and timeline card. Preserve the existing Windows/macOS tokens and card geometry unless the design refresh identifies a necessary layout adjustment.
5. Refresh the linked-change refusal in `5a.4`/`5b.4` as well: while a linked tracked change is undecided, both the header `Resolve` and overflow `Mark as resolved` are inert under ratified FR-CMT-21(a), alongside J10's inert `Delete comment`. Show the existing `Go to changes` route and a clear reason for the closure refusal. A live run by itself does not block manual Resolve (FR-CMT-21(b)).

The refresh should retire UXR-Q11's old cascade-hide questions and make the child-present refusal explicit. Behavior and eligibility are governed by `docs/ux-design.md` J10; appearance remains with the generated design project.
