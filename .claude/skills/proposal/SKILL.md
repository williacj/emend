---
name: proposal
description: Turn a fuzzy need into a proposal the owner can ratify — the problem and its evidence, the rows that follow, what is out of scope, and what stays unresolved. Load before drafting any delta to docs/spec/, and before asking the owner for what you are missing.
---

ABOUTME: How a role gets from "I want X" to a proposal: what to establish before drafting a row,
how to tell a requirement from a decision from a structure, and what the argument around the rows
has to carry.

# Writing a proposal

`AGENTS.md`, "When you write a decision or a requirement", says which deltas are proposals. The
rows are a proposal's payload; the proposal is the argument that earns them. It travels as the
pull request body, and the owner ratifies from it.

`.claude/skills/spec-style/` holds the form a row is written in. This skill holds what has to be
true before you write one.

## The one test

**The owner must be able to ratify without reconstructing your reasoning.** They know the need
they voiced. They do not know what you found, what you ruled out, or what you assumed. Anything
that moved you and is not written down is lost.

## Establish these before you draft

Draft no row until you can answer all four. Where the answer is neither in the repository nor in
the card, ask the owner and wait for the reply.

- **The problem, in observable terms.** What goes wrong today, to whom, and how often. "Rigger has
  no X" names a missing feature, not a problem. You have it when you can say what the absence costs
  someone, without naming the thing you want to add.
- **The evidence.** What actually happened: a run that failed, a card that escalated, a document
  contradicting another, a command with no verb behind it. You have it when you can cite where each
  piece lives. Where you cannot, the problem is a preference, and the proposal says so in those
  words.
- **What is already settled.** Read the preamble of `docs/spec/requirements.md`, then the rows,
  then `docs/spec/requirements-retired.md`, then `docs/spec/decisions.md`. You have it when you can
  name the rows that come nearest the need and say what each leaves unanswered. A need the register
  already answers is a reading error rather than a delta. A need a ratified decision forecloses
  escalates as `recorded-decision` instead (`.claude/agents/pm.md`, "What you read, and what you
  never edit").
- **The boundary.** What this need does not include. You have it when you can name three things a
  reader would expect the proposal to cover and will not find in it. Knowing it now is what stops
  the proposal growing while you draft.

## Sort what you have into three piles

Ask what each thing is a statement about: what Rigger must do, what was chosen among the ways to
do it, or where the code lives. Three answers, three documents.

- **A requirement** — what must be true of Rigger, in the sense the preamble of
  `docs/spec/requirements.md` gives the word. It lands in that file.
- **A decision** — a choice among the structures that satisfy the requirements, with what would
  reverse it. It lands in `docs/spec/decisions.md`. A structural choice is the architect's
  (`D18` rule 2), so a PM drafting one has left its lane.
- **A structure** — a layer, a module, an extension point. It lands in `ARCHITECTURE.md`, and the
  architect proposes every delta there while the owner ratifies it (`D18` rule 1).
  `.claude/agents/pm.md` forbids the PM to edit that file: name the layer the delta lands in, say
  why the requirement needs it, and leave the delta to the architect.

Something you cannot place is a finding, not a coin toss. Write it into the proposal as an open
question, name the two piles it sits between, and say what would settle it. Placing it by guess is
failure mode 2 in `.claude/agents/pm.md`.

## Write each row

The preamble of `docs/spec/requirements.md` is the authority on ids and on what the two columns
mean. Read it there. What the proposal owes beyond it:

- **Fill both columns.**
- **Name the test you expect to claim the row.** A judge enforces the test obligation for each new
  requirement (`D17` rules 1 and 7). Where no test exists yet, `checked
  by` is `nothing yet`, and the proposal names the card that closes it.
- **Write it so a judge can rule on it.** `.claude/skills/acceptance/`, under "Write each item",
  holds the rule and the words it bars. A row is read the same way an acceptance item is, by
  someone who cannot ask you, and it fails the same way.
- **State its limit.** Each row you propose states the edge past which it does not hold, or rests
  on a table of the dimensions it depends on, each combination marked in or out of scope.
  `.claude/skills/acceptance/`, under "Systems outside Rigger's code", holds that table's form.
  A ratified row's table lives in `docs/spec/requirements.md`, under its group, directly after
  that group's row table. Head it with the row's id, for example
  `### R-TABLEEXAMPLE-1 — Example states`. The row cites its own id and that heading.

**A proposal never lands in either register.** Every row in `docs/spec/requirements.md` and every
entry in `docs/spec/decisions.md` binds, so yours waits in the pull request until the owner
ratifies it (each register's preamble). Write it as it will read once ratified, and let the pull
request body say it is a proposal.

## Run every check you specify

A check a proposal names — a lint, a grep, the rule a gate would apply — is a claim about data
that already exists. `AGENTS.md`, "How we work", has you read the current code before
recommending a change to it, and a specified check is that same claim in executable form.

- **Run it against the files it would run on**, before it reaches the draft.
- **Write down what it returns today**: how many entries it passes, how many it fails, and which
  ones. A check whose present result the proposal leaves out is one the owner cannot ratify,
  because a clean run and an unrun check read the same on the page.
- **Where the run fails something a register's preamble permits, the check is wrong.** Correct it,
  or propose the row that makes the register match it.

An observation about what the binding documents currently say is the same claim, and takes the
same run. An unrun check reads as a finding, and the owner ratifies it as one.

## What the argument carries

Scale each to the delta. A one-row proposal wants a paragraph per heading; a proposal that reshapes
a group wants more. Leave a heading out where it holds nothing, rather than padding it.

1. **The problem, and its evidence.** From above. This is the section that does the work.
2. **What must be true, and why it follows.** The rows, each tied to the part of the problem it
   answers. A row nothing in the problem reaches is scope you added.
3. **What it rests on.** The decision being recorded, if any, and what would reverse it. Where an
   existing `D#` already settles it, cite that instead.
4. **What it changes underneath.** The layer or extension point the rows land in, named, and the
   `README.md` verb the rows imply where the CLI contract carries none. A signal for the owner,
   never a reason to soften a row.
5. **Out of scope.** The boundary you established, written down: three to five things a reader
   would expect and will not find, each with its reason. Deferred, better as its own card,
   foreclosed by a decision, or not yet evidenced.
6. **What it costs.** What gets harder, slower or impossible once the owner ratifies this. A
   proposal with no cost has not been examined.
7. **Open questions.** Each marked blocking or non-blocking, and each addressed to whoever resolves
   it.

## Draw the shape where the subject has one

Where the need has a shape — a card moving between states, a sequence crossing roles, a boundary
being redrawn — draw it. `.claude/skills/spec-style/` rule 4 asks for structure that matches the
meaning, and prose is not always the matching structure.

- **Mermaid in a fenced block**, not ASCII art. It renders for the owner, reads as plain text to a
  role on dispatch, and diffs a line at a time.
- **The diagram argues for the rows, and is never where a row comes from.** Draw it, then read it
  back and write what it shows as rows. A fact surviving only in the picture never reached the
  register, and the register is what binds.
- **Label what it depicts** — current state, proposed state, or the difference between them.

This section governs the proposal and not the register. Whether the registers under `docs/spec/`
carry diagrams of their own is a separate question, and this skill does not settle it.

## Mark every gap where it appears

Two kinds, both marked inline at the sentence they affect, never collected at the end where the
reader meets them too late.

- **An assumption** — plausible, unvalidated, and you drafted on it. Name what would falsify it.
- **An open question** — unknown, and it needs discovery or the owner. Name who resolves it.

An unmarked gap reads as a fact. The maker builds against what the row says, not against what you
meant. An assumption you left unmarked therefore reaches them as an instruction, which is failure
mode 1 in `.claude/agents/pm.md`.

## Before you hand it off

1. Does the problem section say what goes wrong today, to whom, and how often?
2. Does a citation sit under each piece of evidence?
3. Does every row trace to a part of the problem the draft states?
4. Is every row observable from outside, naming no mechanism?
5. Does every row carry `made true by`, `checked by`, and the test you expect to claim it?
6. Do every proposed row and every proposed decision sit in the pull request, each written as it
   will read once ratified?
7. Does every check or observation the draft specifies carry what it returns today?
8. Does the draft name the structural delta rather than writing it?
9. Where the subject has a shape, is it drawn, and does every fact in the drawing also appear in a
   row?
10. Is every gap marked inline, an assumption with what would falsify it or an open question with
    who resolves it?
11. Does out of scope name what a reader would expect and not find, each with its reason?
12. Does the draft say what ratifying it costs?
13. Does anything in the draft change what a ratified decision means?
14. Does every row state its limit, or rest on a table of the dimensions it depends on? If it has
    a table, does that table live under its group directly after the row table in
    `docs/spec/requirements.md`?
