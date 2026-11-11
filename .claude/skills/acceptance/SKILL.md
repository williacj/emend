---
name: acceptance
description: Write or revise a card's acceptance — the items that state what done means before any work on the card starts. Use when filing a card, when decomposing larger work into cards, when a spike card needs a bar, and when judging whether an acceptance item is testable.
---

ABOUTME: How an author writes a card's acceptance: work out what the card is really asking for,
then state it as standalone conditions a judge can rule on without asking the author.

# Writing an acceptance

Acceptance states what done means in the issue body, not a board field. Rigger reads it in this
form:

- Use `## Acceptance` or another ATX heading whose text is exactly `Acceptance`. Bullets only
  under `Acceptance criteria` or an underlined heading leave no counted items, so Rigger refuses
  the card.
- Write plain bullets, never task lists. Task-list items do not count; Rigger refuses a card with
  only those.
- Keep bullets outside fenced code blocks. Fenced bullets do not count; Rigger refuses a card with
  only those.

## The one test

**A judge must be able to rule on the item without asking you.** Every rule below is a way of
passing it. Its other half — one condition per item — is under "Write each item".

You will not be there when the card is judged. A judge that cannot rule on an item records it
unmet, and a verdict leaving any item unmet is not sound. An item only you can read is paid for in
rounds, by the maker, later.

## Start from the card, not from the bullets

Bullets written first tend to restate the title, which is one of the two shapes Rigger refuses
outright. Work these out before you write any:

- **The outcome.** What actor, stakeholder, or system outcome is this card meant to enable? That
  context belongs in the card's description. The acceptance holds the observable conditions that
  prove the outcome was reached; it never becomes a second brief.
- **The proof.** What observable change shows it was reached? That is what the items assert.
- **The constraints that already bind.** Where something outside the card fixes part of the
  answer, cite it: a D#, FR-*, J#, TD-# or P# id, a `docs/design/` mock id and spec, or a
  `CLAUDE.md` or `AGENTS.md` section. A constraint with no source behind it is you prescribing the
  implementation. Cite the owning document rather than restating it (`AGENTS.md`, "Documents own
  their facts").
- **The boundary and failure states that apply.** Empty input, invalid input, limits,
  permissions, a dependency failing, partial completion. Consider each; carry over only the ones
  this card can actually reach. A documentation card owes no error criterion, and one invented to
  fill out the list is filler a judge still has to rule on.

## Write each item

**One condition per item.** An `and` usually hides two.

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
to look precise — derive it from the card, or from a source you cite, such as `docs/test-plan.md`
§6's performance budgets.

**Say what done means, never how to do it.** The maker chooses the mechanism. An item that names
one bars a better route and is not a statement about done.

Every item is mandatory — one left unmet is not sound — so order them for reading rather than for
priority.

## Choose a format

An ordinary rule bullet by default: a named path exists and states a named thing; a named command
exits zero, or produces named output; a named input is refused, and the refusal names the reason;
a named document cites a named id.

Items may permit citing, not quoting, persistent evidence: a CI job, run attempt or comment by
URL; a file by path at a commit reachable from the judged head or `main`. Quote local output;
never cite CI artifacts or off-forge records. Citations name their record's commit, which must be
the item's; unopenable records are uncited. Items may demand quotes.

A **Given/When/Then** bullet where the ruling needs its context to make sense. One item still
carries one independently ruleable outcome, never a scenario with several `Then`s. Split a
compound result. Example acceptance:

```text
## Acceptance

- Given a document with YAML frontmatter is open, when the user saves it without editing the
  frontmatter, then the frontmatter bytes on disk are unchanged (FR-ED-1).
- Given a document with YAML frontmatter is open, when the user switches to the raw source view,
  then the source view shows the frontmatter exactly as it is on disk (FR-ED-1).
```

Both items trace to FR-ED-1, which makes round-trip fidelity, YAML frontmatter included, a P0
requirement.

Each bullet repeats its own context rather than borrowing it from the one above: standing alone
is worth the words it costs.

## A spike card

A spike card's acceptance states what a complete answer contains, never what the answer is.
Fixing the answer in advance is not a bar; it is the finding, and it leaves the spike unable to
report the one thing it was dispatched to find out.

Write the shape of the report: which options it weighed, what it measured, what it recommends
and on what evidence, and what would reverse the recommendation.

## Scope, and what a change costs

**Bound the card.** Put all requested work in acceptance. Found work outside it gets its own
card; follow-ups cover only outside work. An undone item leaves this card unfinished.

Ask for every case to be proved, never for a test per case: one table-driven or generated test
may prove a dimension. A mutation is evidence that an existing test discriminates; never ask
for a test per mutation. Ask for a probe a judge used to find a defect as a case in an existing
test of the invariant it broke, where one exists, and otherwise as one test of that invariant.

**Split work into cards.** Map every part of the larger work to a card's acceptance item, not
merely its title or description. `CLAUDE.md`'s "Issue Tracking" bounds a card: one pull request,
independently testable, four hours or less.

**Name dependencies.** In the dependent card, name the prerequisite card and its required result.
Its acceptance covers its own work.

**Cover every axis.** Satisfying one axis leaves others unchecked: commands can exit zero yet
write to the wrong path. Give each axis the card varies on its own item.

**Changing it after admission is expensive, and it stays yours.** Only its author changes an
acceptance after admission, never the maker it is judged against, and Rigger records who made
each change. A change to the acceptance, like a change to the work, sends every judge back and
spends one of the card's rounds; a card that exhausts its rounds escalates as ambiguous; and the
change stales every verdict already returned. Settle the bar with whoever will help you before
you file.

Before filing, remove items dependent on this card's verdict, marker, required check or
merge; `AGENTS.md`'s "Review and merge" still applies.

## Work outside the repository

For a card acting on a system outside the repository where undo is not obvious, require the maker
to state its intended action before acting, with inspectable evidence of what it said and when.

Require controlled proof for algorithmic behaviour and real-boundary proof for external contracts,
as `docs/test-plan.md` §7b's substitution discipline and the `tdd` skill's "Make the assertion
discriminate" set out. A fake agent or an injected clock cannot establish real OS behaviour or a
real deadline. Keep these obligations independently ruleable.

## What is checked, and what is not

Rigger's form check reads acceptance as the top of this skill states. It refuses only a card with
no items it counts, naming the reason, or one whose counted items only restate the card's title.

So the bar being right is yours. No check proves an acceptance adequate, and a sound verdict is
never a warranty that the card asked for the right things. A judge rules on whether the acceptance
covered what the card asked, and returns the card to you with the reason rather than rewriting it.

## Before you file

1. Did you start from the outcome, the proof, the constraints and the failure states that apply?
2. Does every constraint you name cite the source that fixes it?
3. Can a judge rule on each item without asking you?
4. Is each one condition?
5. Does each stand on its own?
6. Does each name the concrete thing that would prove it false?
7. Does each say what done means rather than how to reach it?
8. Where an item lists instances of a class, does it ask for the positive check instead?
9. Where the card turns on a threshold, is the value named and its source cited?
10. Does the set cover everything this card is asking for?
11. Does the set name every axis this card varies on, rather than exhausting one of them?
12. For a spike: does it describe a complete answer rather than the answer?
13. When splitting work, is each part mapped to an acceptance item?
14. Are each dependency's card and required result named?
15. Must a maker state an outside-system action before acting if undo is unclear?
16. Does each algorithmic claim have controlled proof and each external contract retain
    real-boundary proof?
