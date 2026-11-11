---
name: spec-style
description: The form rules for a delta to Emend's constitution — docs/functional-spec.md, docs/ux-design.md, docs/tech-design.md and docs/test-plan.md. Load before drafting or reviewing one. Form only — it never licenses a change to what a ratified clause means.
---

ABOUTME: The form rules a delta to Emend's constitution is written under, and the test behind
each, for anyone drafting or reviewing one.

# The constitution's register

These rules constrain **form only**. Content is never negotiable: every bound, exception and
gate survives an edit made under them. Where form and meaning pull apart, keep the meaning and
flag the sentence.

They exist so that a delta reads like what is already there. A reader should not be able to pick
your entry out of the ones around it, so read the section you are changing before you draft.

`docs/design/` is not written under these rules: it is generated from CJ's design project and
never hand-edited (`CLAUDE.md`, "Reading `docs/design/`").

## The rules

### 1. One term per concept

Keeping the vocabulary small is what stops a reader wondering whether two words name two
mechanisms. Use the word the constitution already uses for a concept. Name a new concept once,
then reuse the name.

The converse binds as hard: where two words already name two things, never collapse them. A
**judge** is the slot in Rigger's loop that returns a verdict; a **reviewer** is one of the roles
that can fill it (`rigger.config.mjs`, `judges`). In the product, a **comment** and a **tracked
change** are different things. Editing one into the other destroys a distinction something depends
on.

### 2. Active voice, actor named

The user, the agent, the app, the backend, the maker, the judge, CJ. Passive only where the actor
is genuinely unknown, or genuinely does not matter.

Where authority is the subject — who may accept a change, who may ratify, who may withdraw an
entry — an ambiguous "it" is a defect rather than a style choice.

### 3. Structure that matches the meaning

A sequence of more than three steps, or a rule with three or more conditions, becomes a numbered
or bulleted list. State the discriminating test before the list it governs, so that a reader
knows what they are sorting by before they start sorting.

Where the constitution keeps a register as a table — `docs/functional-spec.md`'s decision log,
`docs/tech-design.md`'s architecture decision log, `docs/test-matrix.md`'s rows — a new entry is
a row in that table, in its columns, never prose beside it.

A structure that neither a list nor a table carries — a set of things and the relations between
them, or a state machine — becomes a diagram.

Beyond these rules, which document owns a fact, and so where a delta states it, is
`AGENTS.md`'s "Documents own their facts".

## What this skill is not

- **Not a rewrite licence.** Never improve a ratified clause's meaning while restyling it. Where
  a rule here and a clause's meaning conflict, keep the meaning and say so in the proposal.
- **Not the register's mechanics.** Changing a recorded decision takes CJ's explicit agreement and
  a log entry in the owning document (`CLAUDE.md`, "Project Context"). Read the section and the
  decision log of the file you are changing before you draft.
- **Not linted.** These rules hold because an author applies them and a reviewer reads for them.

## Before you hand it off

1. Does every concept use the constitution's existing word, and does every existing distinction
   survive?
2. Does every sentence about authority name its actor?
3. Is anything ordered or conditional still buried in prose?
4. Does the delta state each fact in the document that owns it?
5. Did you change what a ratified clause means? That is a proposal, not a restyle.
