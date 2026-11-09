# Proposed J2 / J13 prose — agent conversations (PR #2692, #2690)

**Status (30): proposed for CJ, not applied.** Rulings 4–6 (CJ, 2026-10-15) are folded in. `docs/ux-design.md` is not edited by this project. These replacements assume PR #2692's model is adopted and D4, D15, D30/FR-CHAT-4 and TD-5 are amended first. Appearance is turn 16 and `../specs/agent-conversations.md`. Bracketed items are open decisions or findings from `16i`; CJ settles them, not this text.

## J2

### §J2-1 Entry path — replaces "The repo-level conversation then slides from center stage to the right timeline, preserving its history (D4, Principle 5)."

> Opening a document shows **that document's own Timeline** in the right rail (CONV-1). Workshop conversations stay in Workshop and keep their history; nothing moves between them. Switching tabs switches the visible Timeline and the conversation a new turn goes to. Facet, scroll position and unsent composer text belong to each conversation [F4–F6]. Timeline collapse remains per window.

### §J2-2 Phase A — workshop mode (append)

> **Workshop is a fixed rail entry above Documents**, also reachable from the app menu [J# delta: View › Workshop drawn; placement and keyboard route are CJ’s]. It holds the project's named conversations: a list to create, find, reopen and resume them, and the selected conversation centre stage. Selecting Workshop **does not close document tabs**: they stay in the strip and none is selected, so no document is active for the next turn (CONV-4). The project-home strip appears only when no document is open. Before Send the composer names the destination conversation and that no document is active, on a footer line that is new to the Workshop composer [J13 delta]. A new conversation is called *New conversation* until its first reply, then is titled from the first message; the author may rename it in place. Pending permissions and finished or failed runs in other conversations are shown on the Workshop entry, the list row, and the Elsewhere row of the active Timeline; they are answered only on their own run card [F7, F8].

### §J2-3 Phase B — the birth moment (replaces the paragraph after the birth-card sketch)

> The birth card stays in the Workshop conversation that produced it, with the run's final reply and any pending permission (CONV-5). The new document opens as a tab and becomes active with **its own, new conversation**, whose Timeline begins with a link to the originating conversation and run. The agent may supply a visible summary in the same call that creates the document. If it does, the summary is preloaded into the document's next composer turn from the first frame, where the author can read, edit or remove it. Opening the document sends nothing (CONV-6). If it does not, nothing is preloaded and the link back to the Workshop conversation is the route. A sent handoff is never rewritten. Composer-less actions do not receive it and gain no preview step (CJ, 2026-10-15).

Strike: *"The conversation continues — same thread, now visibly associated with the doc (its future revisions, comments, findings all join this one timeline; Principle 5)."* Replace with: *"Future revisions, comments and findings on the document join the document's Timeline; a run that also changes another document appears once, in its origin, and the other document shows a link to it (CONV-3)."*

### §J2-4 Untitled documents (append to the lifecycle paragraph)

> An untitled document has its own conversation, which follows it through Save As adoption (CONV-7). [F10 — on `[Discard]`, proposed (`16l.3`): the dialog says the conversation stays in Workshop under *Not in the project*, where it is listed as discarded (`16l.4`).]

### §J2-4a Moved, missing and deleted (new) [`16l`]

> A document whose conversation cannot be matched — for example one moved while Emend was closed — opens with an empty Timeline and a notice offering to connect it to an earlier conversation; only conversations whose document is missing are offered, and connecting can be undone (CONV-7). Conversations of missing and discarded documents are listed together under *Not in the project* in Workshop [F15]. [F14 — proposed: a conversation can be renamed or deleted; deletion is confirmed, says other computers lose it once shared, and leaves documents’ changes in place; *Previous project conversation* cannot be deleted; no archive or export.]

### §J2-5 Migration (new)

> On first launch after the change, the earlier project-wide history becomes **Previous project conversation** in Workshop; its turns are not assigned to documents. The first document opened afterwards shows a one-time notice linking to it [F13: marker set on dismissal]. **Hand off a summary…** lets the author choose whole exchanges from it, review the prepared summary in the document’s composer — edit, remove, or change the exchanges — and send it with their next message; the turn records the exact text sent and which exchanges it came from. Choosing nothing sends nothing [`16j`]. A failed conversion is stated with a retry and never shows an empty conversation (CONV-10).

### §J2-6 History status and recovery (new)

> Each conversation shows, in plain words — *Saved on this computer*, *Shared with the project*, *Newer turns arrived* — whether other computers have its latest turns; it never names commits, pushes, branches or paths (Principle 4) [F20]. When a conversation cannot continue, Emend says why and offers a way on, and the author’s unsent message is kept: a history too long for a new session can continue from a reviewable summary or from chosen turns. Each computer keeps its own log, and Emend combines every computer’s turns in one time order without asking. Where two computers continued from the same turn, a quiet *Continued on another computer* marker sits at that point, and the next Send starts a fresh session from the combined history. Combining never fails, never holds Send and never splits a conversation [F19].

## J13

### §J13-1 Phase A — Workshop turns (append)

> In Workshop no document is active, so FR-CHAT-4 supplies no `content` and **no standing line is shown**. Open tabs travel in `also_open` by identity and dirty state only; that is not the author's text and takes no disclosure. The composer still names the destination conversation (CONV-2).

### §J13-2 Phase B — accepted handoffs (append)

> A turn that carried an accepted Workshop summary records it on the same card, in the same `↑ OUT` line family: *carried the Workshop summary from <conversation>*, marked *edited* when the author changed it. **Unlike the document line, this one discloses the exact text**, because CONV-6 retains what was sent — the no-deep-link rule above does not apply to it. Absent is still absent: a turn with no handoff has no handoff line.

### §J13-3 Composer-less routes (append to the routes bullet)

> A composer-less route does not carry a pending summary and shows no preview (CJ, 2026-10-15); its run card says *Workshop summary not included — it waits for your next message*.

### §J13-4 Preparing a summary (append) [F21]

> Preparing a summary sends the turns it is made from to the provider. The author is told before preparing starts; the receiving turn records the summary exactly as sent and which turns it was made from.

### §J13-5 Workshop composer footer (new) 

> The Workshop composer gains a footer line, which it did not have before: it names the destination conversation and says no document is active. It is not J13’s document footer band, and the unsaved-text standing line still does not appear in Workshop.

### §J13-6 Queued turns (append)

> A queued turn states the destination and context it captured at Send; these do not change if tabs or selection change before it runs (FR-AGENT-7).

## J7 (consequential)

> [F7] J7 already shows the badge while the project has any pending request; **that is unchanged.** What changes is activation. Where the request belongs to another document’s conversation or to Workshop, activation first makes that conversation active (its tab, or Workshop with the conversation selected), then proceeds exactly as J7 says — Chat, expand, focus the oldest request heading. The Elsewhere row’s `Show` on a permission item does the same. Workshop has no Timeline host; there the Elsewhere row is the in-app cue. Permission controls stay on the origin run card only.

> [F18] An unseen finished or failed run in another conversation marks that document’s tab and rail row (or the Workshop rail entry) with a small dot until it has been shown with its card in view; running runs mark nothing.
