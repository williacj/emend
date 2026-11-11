---
name: acceptance
description: Write or revise a card's acceptance — the items that state what done means before any work on the card starts. Use when filing a card, when decomposing larger work into cards, when a spike card needs a bar, and when judging whether an acceptance item is testable.
---

ABOUTME: How an author writes a card's acceptance: work out what the card is really asking for,
then state it as standalone conditions a judge can rule on without asking the author.

# Writing an acceptance

Acceptance states what done means in the issue body, not a board field (`D2` rule 2).
`R-CARD-12` owns its form:

- Use `## Acceptance` or another ATX heading whose text is exactly `Acceptance`. Bullets only
  under `Acceptance criteria` or an underlined heading leave no counted items, so the card is
  refused (`R-CARD-12`, `R-CARD-7`).
- Write plain bullets, never task lists (`D2` rule 2). Task-list items do not count; a card
  with only those is refused (`R-CARD-12`, `R-CARD-7`).
- Keep bullets outside fenced code blocks. Fenced bullets do not count; a card with only those
  is refused (`R-CARD-12`, `R-CARD-7`).

## The one test

**A judge must be able to rule on the item without asking you.** That is `R-CARD-2`'s test, and
every rule below is a way of passing it. Its other half — one condition per item — is under
"Write each item".

You will not be there when the card is judged. A judge that cannot rule on an item records it
unmet (`R-LOOP-5`), and a verdict leaving any item unmet is not sound (`R-VERDICT-4`). An item
only you can read is paid for in rounds, by the maker, later.

## Start from the card, not from the bullets

Bullets written first tend to restate the title, which is one of the two shapes admission
refuses outright (`R-CARD-8`). Work these out before you write any:

- **The outcome.** What actor, stakeholder, or system outcome is this card meant to enable? That
  context belongs in the card's description. The acceptance holds the observable conditions that
  prove the outcome was reached; it never becomes a second brief.
- **The proof.** What observable change shows it was reached? That is what the items assert.
- **The constraints that already bind.** Where something outside the card fixes part of the
  answer, cite it: a requirement id, a `D#`, an `AGENTS.md` section. A constraint with no source
  behind it is you prescribing the implementation. Write each citation as `AGENTS.md`,
  "Documents own their facts", requires.
- **The boundary and failure states that apply.** Empty input, invalid input, limits,
  permissions, a dependency failing, partial completion. Consider each; carry over only the ones
  this card can actually reach. A documentation card owes no error criterion, and one invented to
  fill out the list is filler a judge still has to rule on.

## Write each item

**One condition per item.** That is `R-CARD-2`'s first half; an `and` usually hides two.

**Each item stands on its own.** Each names enough subject and context to be ruled on by itself.
A judge reconstructing an item from the bullet above it is one misreading away from ruling on
the wrong thing.

**Name the thing, and the observable fact about it.** The ruling should be a reading, not an
opinion. Name the concrete thing that would prove the item false as well — the output, the file,
the exit code whose presence or value settles it. An item with no falsifier gives a judge nothing
to look for but your wording, and your wording will always agree with itself.

**Cut the words that hand the ruling back to you.** *Appropriate, clean, properly, robust,
comprehensive, reasonable, as needed, where necessary, good.* Each of these means "ask the
author". Name the condition the word stands for instead. If you cannot name it, you do not yet
know what you are asking for.

**A list of instances is evidence for a class, never the class itself.** Where an item names
members of a class, say that they are instances, and ask for the positive check instead: only
sanctioned members may appear. An item enumerating what must not appear is met exactly by the
absence of what it listed — the list under "Cut the words that hand the ruling back to you",
written into one, is satisfied by any synonym.

**Name the threshold, where there is one.** Where the card turns on quantity, duration, capacity,
compatibility or another threshold, name the value and how it is measured. Never invent a number
to look precise — derive it from the card, or from a source you cite.

**Say what done means, never how to do it.** The maker chooses the mechanism. An item that names
one bars a better route and is not a statement about done.

Every item is mandatory — one left unmet is not sound (`R-VERDICT-4`) — so order them for reading
rather than for priority.

## Choose a format

An ordinary rule bullet by default: a named path exists and states a named thing; a named command
exits zero, or produces named output; a named input is refused, and the refusal names the reason;
a named document cites a named id.

Items may permit citing, not quoting, persistent evidence: a CI job, run attempt or comment by
URL; a file by path at a commit reachable from the judged head or `main`. Quote local output;
never cite CI artifacts or off-forge records. Citations name their record's commit, which must be
the item's; unopenable records are uncited. Items may demand quotes.

A **Given/When/Then** bullet where the ruling needs its context to make sense. `R-CARD-2` still
holds, so one item carries one independently ruleable outcome, never a scenario with several
`Then`s. Split a compound result. Example acceptance (`R-CARD-12`):

```text
## Acceptance

- Given a Ready card has no acceptance, when `rigger plan` evaluates it, then the card is not
  pulled.
- Given a Ready card has no acceptance, when `rigger plan` evaluates it, then `plan` names the
  card and identifies missing acceptance as the reason.
```

Those are `R-CARD-7`'s two halves, one apiece; `plan` is the verb the README gives for showing
what a run refuses. Each bullet repeats its own context rather than borrowing it from the one
above: standing alone is worth the words it costs.

## A spike card

A spike card's acceptance states what a complete answer contains, never what the answer is
(`R-CARD-9`). Fixing the answer in advance is not a bar; it is the finding, and it leaves the
spike unable to report the one thing it was dispatched to find out.

Write the shape of the report: which options it weighed, what it measured, what it recommends
and on what evidence, and what would reverse the recommendation.

## Scope, and what a change costs

**Bound the card.** Put all requested work in acceptance. Found work outside it gets its own
card (`R-CARD-11`); follow-ups cover only outside work. An undone item leaves this card unfinished
(`R-CARD-10`).

Ask for every cell to be proved, never for a test per cell: one table-driven or generated test
may prove a dimension. A mutation is evidence that an existing test discriminates; never ask
for a test per mutation. Ask for a probe a judge used to find a defect as a case in an existing
test of the invariant it broke, where one exists, and otherwise as one test of that invariant.

**Split work into cards.** Map every part of the larger work to a card's acceptance item, not
merely its title or description.

**Name dependencies.** In the dependent card, name the prerequisite card and its required result.
Its acceptance covers its own work.

**Cover every axis.** Satisfying one axis leaves others unchecked: commands can exit zero yet
write to the wrong path. Give each axis the card varies on its own item (`R-CARD-2`).

**Changing it after admission is expensive, and it stays yours.** Only its author changes an
acceptance after admission, never the maker it is judged against (`R-CARD-5`), and every change
is recorded with who made it (`R-CARD-6`). A change to the acceptance, like a change to the work,
sends every judge back and spends one of the card's rounds (`R-LOOP-8`); a card that exhausts its
rounds escalates as ambiguous (`R-LOOP-9`); and the change stales every verdict already returned
(`R-GATE-7`). Settle the bar with whoever will help you before you file.

Before filing, remove items dependent on this card's verdict, marker, required check or
merge; `AGENTS.md`'s "Review and merge" still applies.

Classify cited prior attempts as offered proof, context, or unresolved/noncredit; later
results grant no retroactive credit.

For required retained originals, predeclare finite offered results before maker work: originals,
private-safe access, exact ref, behavior scope and retention event through final independent ruling or
longer card requirement.

**Name predictable test edits at filing.** An author may name bounded grant classes, each
stating what it covers and the existing `test/` lines it can reach, checkable in `git diff`.
Examples: assertion lines in a named test file may retarget the old result of this card's
changed behaviour; fixture lines in a named test file may mirror the real error from a named
layer. A class cannot admit deletion of a test or weaken what it proves; those go to the owner.
With classes, word the test-line item as: `git diff` against the base changes no existing line under
`test/` that the table does not list and no named class covers.

**Admit harness diagnostics before work.** For a test without `// proves`, record the
infrastructure behaviour, checked registered product requirements and why none applies, and
bounded guarded semantic discrimination under the `tdd` skill. A path or missing declaration
proves no classification. Never borrow an unrelated requirement or reclassify existing tests.

## Work outside the repository

For a card acting on a system outside the repository where undo is not obvious, require the maker
to state its intended action before acting, with inspectable evidence of what it said and when.

Require controlled proof for algorithmic behaviour and real-host proof for external contracts.
A real run cannot replace missing controlled proof; a fake or injected clock cannot establish
real OS behaviour or a real deadline. Keep these obligations independently ruleable.

## Systems outside Rigger's code

**Map the finite contract states.** At external boundaries, name states that change branch or
result, including reachable errors, absence and nonreturn. Mark in-scope cells and scope edges.
Each item retains a concrete falsifier.

For each in-scope cell, name controlled algorithm proof, real-boundary proof, or both, according
to its claim. Real OS behaviour, tool contracts and real deadlines retain real-host evidence;
injected-clock and fake results alone earn no such credit.

Steps are concurrent if they can interleave on one store, between processes or async tasks
within one process. A step is one read, write, rename or forge call. Concurrent actors including
a writer need an acceptance interleaving table: one row per ordering that can change outcomes
or reader access point, each with its required outcome. Include writers restarted against their
own leftovers after mid-write kills. Otherwise, one writer without concurrent readers, or
readers alone, needs none. An ordering whose outcome no item or structure fixes is a missing cell.

Justify exclusions and equivalences with evidence for independent review, not labels. Avoid
unrelated axes and unbounded external states. Bound absolutes by the map and scope edge.

Observe fixture readiness before timing behaviour that assumes it; time startup when it
belongs to the contract. The `tdd` skill gives procedures; "Have it attacked before dispatch"
governs independent review.

## What is checked, and what is not

The form check reads acceptance as `R-CARD-12` states. It refuses only a card with no items it
counts, by name and reason (`R-CARD-7`), or one whose counted items only restate the card's title
(`R-CARD-8`).

So the bar being right is yours. `D2`'s notes say what that buys and what it does not: no check
proves an acceptance adequate, and a green marker is never a warranty that the card asked for
the right things. A judge rules on whether the acceptance covered what the card asked, and
returns the card to you with the reason rather than rewriting it (`R-LOOP-6`).

## Have it attacked before dispatch

Before a card is dispatched, a second agent reviews its acceptance for missing cells and
unbounded absolutes. Choose that agent from the card's body:

- The architect reviews it if an acceptance item depends on a system outside Rigger's code, as
  "Systems outside Rigger's code" defines that class.
- The architect reviews it if "Lands in" names `ARCHITECTURE.md`, paths under two or more layer
  homes in `ARCHITECTURE.md`'s "The layers" table ("Lives in"), or a path under no layer's home.
  Paths under `test/`, `docs/journal/` and `docs/derived/` do not count toward this condition.
- Otherwise the second agent is the `reviewer`.

Use a `- **Lands in:**` bullet with backticked paths; indent continuation lines.
That agent checks that scope names every file an item or cited placement ruling requires.
It also checks that every cited proposal, ruling or grant is posted as a comment, issue
or pull request and linked from the card. Preflight checks readable scope, not coverage adequacy.

Pinned binding-document text, and nothing else, opens its fence with `markdown`; an example takes
another info string or none. That agent checks these defects:

1. An unclaimed, unexcepted new `R-` id.
2. Pinned text failing spec-style, or misfenced.
3. An unbounded negative guarantee ("Write each item"; "Systems outside Rigger's code").
4. A request no item covers.
5. Contradicting sibling cards.

`check:card` checks defect 1 and spec-style rules 1 and 2, not scope.

You revise the acceptance before any maker starts. This review is part of filing.

## Before you file

1. Did you start from the outcome, the proof, the constraints and the failure states that apply?
2. Did you write every citation as `AGENTS.md`, "Documents own their facts", requires?
3. Can a judge rule on each item without asking you (`R-CARD-2`)?
4. Is each one condition (`R-CARD-2`)?
5. Does each stand on its own?
6. Does each name the concrete thing that would prove it false?
7. Does each say what done means rather than how to reach it?
8. Where an item lists instances of a class, does it ask for the positive check instead?
9. Where the card turns on a threshold, is the value named and its source cited?
10. Does the set cover everything this card is asking for (`R-CARD-10`, `R-CARD-11`)?
11. Does the set name every axis this card varies on, rather than exhausting one of them?
12. For a spike: does it describe a complete answer rather than the answer (`R-CARD-9`)?
13. When splitting work, is each part mapped to an acceptance item?
14. Are each dependency's card and required result named?
15. Must a maker state an outside-system action before acting if undo is unclear?
16. Does each algorithmic claim have controlled proof and each external contract retain host proof?
17. Does each external boundary have a finite contract-state map naming each cell's proof and
    evidence for exclusions or equivalences?
18. Does every absolute stay within that map and its stated scope edge?
19. Did the second agent chosen under "Have it attacked before dispatch" review for missing cells
    and unbounded absolutes, and did you revise before dispatch?
20. Does the scope bullet cover every file an item or cited placement ruling requires?
21. Is every cited proposal, ruling and grant posted and linked from the card?
22. Did you name bounded grant classes for predictable existing test-line changes?
23. Where the repository defines them, before maker edits, did `npm run check:card` read the draft
    body, and `npm run preflight -- --body-file <body-file>` run in a clean checkout with
    origin/main and a merge base? Resolve or report failures before maker admission.
24. Before admitting claimless diagnostics, did you record behaviour, requirement applicability
    and bounded guarded discrimination?
