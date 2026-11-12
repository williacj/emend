---
name: proposal
description: Turn a fuzzy need into a proposal the owner can ratify — the problem and its evidence, the entries that follow, what is out of scope, and what stays unresolved. Load before drafting any delta to Emend's constitution, and before asking the owner for what you are missing.
---

ABOUTME: How a role gets from "I want X" to a proposal: what to establish before drafting an entry,
how to tell a requirement from a decision from a structure, and what the argument around the entries
has to carry.

# Writing a proposal

A delta to Emend's constitution is a proposal, whoever wrote it: changing a recorded decision
takes the owner's explicit agreement and a log entry in the owning document (`CLAUDE.md`, "Project
Context"). The entries are a proposal's payload; the proposal is the argument that earns them. It
travels as the pull request body, and the owner ratifies from it.

`.claude/skills/spec-style/` holds the form an entry is written in. This skill holds what has to be
true before you write one.

## The one test

**The owner must be able to ratify without reconstructing your reasoning.** The owner knows the need
they voiced. The owner does not know what you found, what you ruled out, or what you assumed.
Anything that moved you and is not written down is lost.

## Establish these before you draft

Draft no entry until you can answer all four. Where the answer is neither in the repository nor in
the card, ask the owner and wait for the reply. Dispatched, you cannot ask: escalate the card as
`ambiguous`, naming what is missing.

- **The problem, in observable terms.** What goes wrong today, to whom, and how often. "Emend has
  no X" names a missing feature, not a problem. You have it when you can say what the absence costs
  someone, without naming the thing you want to add.
- **The evidence.** What actually happened: a user report, a journey that fails, a document
  contradicting another, a card that escalated. You have it when you can cite where each piece
  lives. Where you cannot, the problem is a preference, and the proposal says so in those words.
- **What is already settled.** Read `docs/functional-spec.md`'s decision log and requirements,
  the journeys and state inventories in `docs/ux-design.md`, and `docs/tech-design.md`'s decision
  log. You have it when you can name the entries that come nearest the need and say what each
  leaves unanswered. A need the constitution already answers is a reading error rather than a
  delta. A need a ratified decision forecloses escalates as `recorded-decision` instead
  (`.claude/agents/pm.md`, "What you read, and what you never edit").
- **The boundary.** What this need does not include. You have it when you can name three things a
  reader would expect the proposal to cover and will not find in it. Knowing it now is what stops
  the proposal growing while you draft.

## Sort what you have into piles

Ask what each thing is a statement about: what Emend must do, how it behaves, how it is tested,
how work is done here, what was chosen among the ways to build it, or where the code lives. Each
answer has its document.

- **A requirement** — what Emend must do. It lands in `docs/functional-spec.md` as an FR-*, and a
  product choice it rests on lands in that document's decision log as a D#.
- **Behaviour and flow** — a journey (J#), a state, or a principle. It lands in
  `docs/ux-design.md`. Behaviour a mock implies that `ux-design.md` does not record is for the owner
  and the Designer to capture (`CLAUDE.md`, "Reading `docs/design/`"). Dispatched, escalate it: as
  `recorded-decision` where it would change a recorded J#, otherwise as `ambiguous`.
- **A test rule** — a property (P#), a process rule for tests, or a release gate. It lands in
  `docs/test-plan.md`, and a requirement's named tests land in `docs/test-matrix.md`.
- **A process rule** — how work is done in this repository. It lands in `CLAUDE.md` or
  `AGENTS.md`, whichever owns the fact (`AGENTS.md`, "Documents own their facts").
- **A decision about structure** — a choice among the structures that satisfy the requirements,
  with what would reverse it. It lands in `docs/tech-design.md`'s decision log as a TD-#, on a card
  of its own, filed as `CLAUDE.md`'s "Cards and Rigger" says. A structural choice is the
  architect's, so a PM drafting one has left its lane.
- **A structure** — a process, a module home, a contract. It lands in `docs/tech-design.md`'s
  component designs, §3.1 included, and the architect proposes every delta there while the owner
  ratifies it. `.claude/agents/pm.md` forbids the PM to edit
  that file: name the module home the delta lands in, say why the requirement needs it, and leave
  the delta to the architect.

Something you cannot place is a finding, not a coin toss. Write it into the proposal as an open
question, name the two piles it sits between, and say what would settle it. Placing it by guess
passes the ambiguity on, which is failure mode 1 in `.claude/agents/pm.md`.

## Write each entry

The document you are changing is the authority on its ids and its columns. Read it there. What
the proposal owes beyond it:

- **Fill every column** the register's table has.
- **Name the test you expect to claim each new requirement.** `docs/test-plan.md` admits no FR
  without named tests (TP-Q2), and `docs/test-matrix.md` records them. Where no test exists yet,
  the proposal names the card that adds it and its matrix row.
- **Write it so a judge can rule on it.** `.claude/skills/acceptance/`, under "Write each item",
  holds the rule and the words it bars. An entry is read the same way an acceptance item is, by
  someone who cannot ask you, and it fails the same way.

**A proposal never lands as ratified.** Every entry in the constitution binds, so yours waits in the
pull request until the owner ratifies it. Write it as it will read once ratified, and let the pull
request body say it is a proposal.

## Run every check you specify

A check a proposal names — a grep, a test, the rule a gate would apply — is a claim about data
that already exists, in executable form. Verify it before you recommend it.

- **Run it against the files it would run on**, before it reaches the draft.
- **Write down what it returns today**: how many entries it passes, how many it fails, and which
  ones. A check whose present result the proposal leaves out is one the owner cannot ratify, because
  a clean run and an unrun check read the same on the page.
- **Where the run fails something the constitution permits, the check is wrong.** Correct it, or
  propose the entry that makes the constitution match it.

An observation about what the constitution currently says is the same claim, and takes the same
run. An unrun check reads as a finding, and the owner ratifies it as one.

## What the argument carries

Scale each to the delta. A one-entry proposal wants a paragraph per heading; a proposal that
reshapes a section wants more. Leave a heading out where it holds nothing, rather than padding it.

1. **The problem, and its evidence.** From above. This is the section that does the work.
2. **What must be true, and why it follows.** The entries, each tied to the part of the problem it
   answers. An entry nothing in the problem reaches is scope you added.
3. **What it rests on.** The decision being recorded, if any, and what would reverse it. Where an
   existing D# or TD-# already settles it, cite that instead.
4. **What it changes underneath.** The module home or contract the entries land in, named, and
   the journeys they change. A signal for the owner, never a reason to soften an entry.
5. **Out of scope.** The boundary you established, written down: three to five things a reader
   would expect and will not find, each with its reason. Deferred, better as its own card,
   foreclosed by a decision, or not yet evidenced.
6. **What it costs.** What gets harder, slower or impossible once the owner ratifies this. A
   proposal with no cost has not been examined.
7. **Open questions.** Each marked blocking or non-blocking, and each addressed to whoever resolves
   it.

## Draw the shape where the subject has one

Where the need has a shape — a state machine, a sequence crossing the app and the agent, a
boundary being redrawn — draw it. `.claude/skills/spec-style/` rule 3 asks for structure that
matches the meaning, and prose is not always the matching structure.

- **Mermaid in a fenced block**, not ASCII art. It renders for the owner, reads as plain text to a
  role on dispatch, and diffs a line at a time.
- **The diagram argues for the entries, and is never where an entry comes from.** Draw it, then
  read it back and write what it shows as entries. A fact surviving only in the picture never
  reached the constitution, and the constitution is what binds.
- **Label what it depicts** — current state, proposed state, or the difference between them.

This section governs the proposal and not the constitution. Whether a constitution document
carries a diagram of its own is a separate question, and this skill does not settle it.

## Mark every gap where it appears

Two kinds, both marked inline at the sentence they affect, never collected at the end where the
reader meets them too late.

- **An assumption** — plausible, unvalidated, and you drafted on it. Name what would falsify it.
- **An open question** — unknown, and it needs discovery or the owner. Name who resolves it.

An unmarked gap reads as a fact. The maker builds against what the entry says, not against what
you meant. An assumption you left unmarked therefore reaches them as an instruction, which is
failure mode 1 in `.claude/agents/pm.md`.

## Before you hand it off

1. Does the problem section say what goes wrong today, to whom, and how often?
2. Does a citation sit under each piece of evidence?
3. Does every entry trace to a part of the problem the draft states?
4. Is every requirement observable from outside, naming no mechanism?
5. Does every new requirement name the test you expect to claim it?
6. Does every proposed entry sit in the pull request, written as it will read once ratified?
7. Does every check or observation the draft specifies carry what it returns today?
8. Writing as the PM, does the draft name the structural delta rather than writing it?
9. Where the subject has a shape, is it drawn, and does every fact in the drawing also appear in an
   entry?
10. Is every gap marked inline, an assumption with what would falsify it or an open question with
    who resolves it?
11. Does out of scope name what a reader would expect and not find, each with its reason?
12. Does the draft say what ratifying it costs?
13. Does anything in the draft change what a ratified decision means?
