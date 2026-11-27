ABOUTME: Brief for the owner's design project to draw D34's mention dispatch: the @ autocomplete, post lines and the shortcut.
ABOUTME: `docs/ux-design.md` J4 and §2 own the behaviour; this brief does not replace `docs/design/` appearance authority.

# Mention dispatch visual refresh brief (D34, williacj/emend#90)

**Behaviour source:** `docs/ux-design.md` J4 (*Single thread*, *The `@` autocomplete*, *One post, one run*) and §2 (*Which threads carry a composer*, *When a run captures a thread, and when it holds one*, *Posts, and whether they started a run*, the acknowledgment ladder). Under D34 a run starts when the user posts a comment or reply that names an agent with `@`, and `[Address with AI]` becomes a shortcut that inserts `@agent` and posts it. `docs/design/` draws the comment card, the reply affordance, the 340px popover composer and the editing state. It draws no autocomplete and no line on a post saying whether it started a run, and `specs/state.md` "Known gaps" lists neither. Refresh the generated design project. Do not hand-edit `docs/design/` in this repository.

## Frames to add

1. **The `@` autocomplete, in each composer that opens it.** Draw it in the new-comment popover composer (`14c`'s 340px composer), in a thread card's expanded reply field in the comments column (`4a`/`4b`), in Timeline, and in the editor's comment popover, on Windows and macOS. Show it open after `@` at the start of the body and after `@` mid-sentence. The list belongs to its composer, and focus stays in the textarea.
2. **The autocomplete's entries.** Show `@agent` first, with `No skill — the agent works from the thread as written`. Show a skill entry with its token, the word `Skill`, and its description and when-to-use. Show a workflow entry with its token, the word `Workflow`, and its description and when-to-use. Draw the highlighted entry, the keyboard focus treatment, and a long description that must truncate or wrap. The kind is a word, never an icon alone.
3. **The autocomplete's other states.** Draw the list narrowed by typed characters. Draw the non-selectable no-match line, `No listed skill or workflow matches “<typed>”. It's checked again when you post.` It speaks for the list only, so it must not read as a statement about the project or a promise that the post starts no run. Draw it for a token carrying `-` or `_`, such as `@_rev`, which stays open as a token. Draw the list closing at a bare `@` followed by a space or a full stop. Draw the stale list after a failed refresh, keeping its entries and adding `Couldn't update skills`, matching J2's rail. Draw the state with no completed read, with `@agent` and `Skills and workflows couldn't be listed.`
4. **A mention in a posted body.** Decide whether a resolving token in a posted body is styled differently from the text around it. If it is, the styling must not suggest that an unresolved token, an unchecked token, a reviewer's token or a token on an untitled document started a run.
5. **The lines beneath a post** (§2's table). Draw each on a root comment and on a reply, in the comments column, Timeline and the editor popover:
   - `Started one agent run · @code-review, @style-guide`, with one addressee and with several;
   - `Queued a new agent run · @code-review`, for a post whose run waits in the queue, and `Queued agent run cancelled — it never started.`;
   - `@styel started no run — no skill or workflow in this project has that name.`;
   - `@review started no run — more than one skill or workflow has that name.`;
   - `Couldn't check skills — @code-review started no run. Mention it in a new post to try again.`, alone, and together with `Started one agent run · @agent` on a post naming both;
   - `Posted after an agent run took this thread — that run doesn't have it.`, on a reply naming nobody;
   - the same posted-after line together with `Queued a new agent run · @agent`, on a reply naming an agent posted while a run holds the thread, both shown at once;
   - `@agent started no run — save this document to ask the agent.`, on an untitled document's comment card (J12's pathless pane, `9g`'s neighbourhood);
   - `@agent started no run — it was posted before this document was saved.`, on the same card after Save As;
   - `Editing doesn't start a run — reply to ask the agent.`;
   - `@agent started no run — it was posted in the review.`;
   - one post carrying both a started-run line and a no-match line.
   An ordinary note carries no line, so draw one beside them for contrast.
6. **`[Address with AI]` as a shortcut.** Draw the card before it is pressed and the card after it: the posted `@agent` reply with its started-run line, and the *Working* status (`5a.5`/`5b.5`). Draw the same sequence when the reply field already held a draft, which is posted as `@agent` followed by the draft. Draw the shortcut on an *Addressed — pending* card, which can now be addressed again.
7. **The reply composer during a run, and the mid-run reply sequence.** On a *Working* card and at ladder rungs 1 and 2, the reply field stays live while `[Address with AI]` is replaced by the rung. Draw the three moments of a reply naming an agent posted while run 1 holds the thread:
   - while run 2 is queued: the reply's `Queued a new agent run · @agent` and posted-after lines together, and the card's `⏳ also queued behind another agent run`;
   - once run 2 starts: the posted-after line gone, and the queued line now `Started one agent run · @agent`;
   - if run 2 is cancelled while queued: `Queued agent run cancelled — it never started.` with the posted-after line still shown.
   Draw a reply naming nobody posted mid-run: the posted-after line alone.
8. **A thread asked again.** Draw a thread carrying an undecided delivery while a second run works and after it delivers. Each delivery's changes are listed under that delivery's name and stay decidable, and `Mark as resolved` and `Dismiss` are inert while any change is undecided.

## Appearance questions for the refresh

- The autocomplete's position relative to the caret and the composer, its width inside the 340px popover and the 400px column, its maximum height, and how it scrolls. Apply `specs/tokens.md` and `specs/platform-variants.md`.
- The run lines' and no-run lines' type, colour and spacing, and how they sit against the reply block and the `5a.5` status slot without being read as a second status.
- How the queued line changes to the started-run line when the run starts, so the change reads as the same line updating rather than a new line arriving.
- Whether the `Couldn't check skills` line reads as a failure, as J2's `Couldn't update skills` does, and distinct from the no-match line, which states a fact about the project.
- How two lines on one post stack: for the mid-run reply that names an agent, for a post with a no-match token, and for a post naming `@agent` and an unchecked skill.
- How a long addressee list on the run line wraps or truncates, while keeping every addressee readable somewhere.
- Dark appearance, where the comment card's dark treatment already exists.

**Authority boundary:** this brief asks for the appearance of behaviour `docs/ux-design.md` records. It does not define which tokens resolve (FR-CMT-22), when a run starts (FR-CMT-23, TD-31), when a run captures a thread (§2, J13), what a run is given (§2), or whether `[Address with AI]` is offered on an untitled document, which is open (UXR-Q27.1). Where a drawing implies behaviour J4 and §2 do not record, it returns to the owner as a J# delta.
