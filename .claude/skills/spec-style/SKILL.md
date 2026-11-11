---
name: spec-style
description: The register Rigger's binding documents are written in — five form rules for any diff touching README.md, ARCHITECTURE.md or docs/spec/. In docs/spec/, the lint reads the live decisions and requirements registers; retired registers keep their historical text. Load before drafting or reviewing one. Form only — it never licenses a change to what a ratified clause means. For allocating, amending and retiring ids, read the register's own preamble.
---

ABOUTME: The five form rules Rigger's binding documents are written under, and the test behind
each, for anyone drafting or reviewing a delta to them.

# The Rigger register

Five rules. They constrain **form only**. Content is never negotiable: every bound, exception and
gate survives an edit made under them. Where form and meaning pull apart, keep the meaning and
flag the sentence.

They describe how the binding documents are already written, so that a delta written under them
reads like what is already there. That is the whole of the job — a reader should not be able to
pick your row out of the ones around it.

## The five rules

### 1. One term per concept

Rigger's vocabulary is small, and keeping it small is what stops a reader wondering whether two
words name two mechanisms. A card is **escalated** — never bubbled, parked or forwarded. A role
is **dispatched**. A judge returns a **verdict**, never an approval or a sign-off. Name a new
concept once, then reuse the name.

The converse binds as hard: where two words already name two things, never collapse them. A
**judge** is the slot in the loop that returns a verdict; a **reviewer** is one of the roles that
can fill it (`ARCHITECTURE.md`, `judges: ['reviewer']`). Editing either into the other destroys a
distinction the configuration depends on.

### 2. Sentences of about 25 words, and never past 40

Split a compound. Use an em-dash aside sparingly, and never nested. A sentence carrying an
ordered sequence wants to be a list — that is rule 4.

The ceiling is not a preference about prose. A requirement is a thing a judge rules on and a
maker builds against, and a 40-word sentence hides its own conditions.

### 3. Active voice, actor named

The engine, the gate, the maker, the judge, the owner, the consumer, the role. Passive only where
the actor is genuinely unknown, or genuinely does not matter.

Where authority is the subject — who may merge, who may ratify, who may withdraw a row — an
ambiguous "it" is a defect rather than a style choice. `docs/spec/requirements.md` splits `made
true by` from `checked by` for this reason: two actors, two columns, nothing left to infer.

### 4. Structure that matches the meaning

A sequence of more than three steps, or a rule with three or more conditions, becomes a numbered
or bulleted list. State the discriminating test before the list it governs, so that a reader
knows what they are sorting by before they start sorting.

`docs/spec/requirements.md`'s `checked by` passage is one exemplar: it says the two columns differ
and why, then gives the five forms as a numbered list. `docs/spec/decisions.md`'s **Deferred, and
what returns it** tables are the other — one row per deferred thing, one column for the evidence
that returns it, and no prose carrying what the table holds better.

A register table cannot hold a list, so there a rule with three or more conditions takes a lead
row, then continuation rows each holding one condition. `docs/spec/requirements.md`'s `R-GATE-4`
to `R-GATE-8` are the exemplar. The split is by condition, never inside one definition: a
continuation row that defines one term may hold that term's several parts.

A structure that neither a list nor a table carries — a set of things and the relations between
them — becomes a diagram. `docs/spec/decisions.md`'s `D15` holds when a diagram is admitted, what
it owns in each venue, and the one form it takes. `ARCHITECTURE.md`'s layer map is the exemplar.

### 5. Own it, refer to it, or cut it

`AGENTS.md`'s "Documents own their facts" splits every sentence three ways.

1. **It states a fact the document owns.** A fact another document owns fails this branch.
2. **It refers to a fact another document owns.** A passage that names a source and restates what
   it says fails, however short the restatement.
3. **It is cut.** A sentence that owns nothing and refers to nothing is cut. Shortening it is no
   answer to this rule.

A term for a concept is one the binding documents already use for that concept, or one the
sentence introducing it defines. A term that is neither fails.

`AGENTS.md`, under "Write to be acted on", governs how the sentence that survives is written.

## What this skill is not

- **Not a rewrite licence.** Never improve a ratified clause's meaning while restyling it. Where
  a rule here and a clause's meaning conflict, keep the meaning and say so in the proposal.
- **Not the register's mechanics.** Allocating, amending, retiring and ratifying an id belong to
  each register's preamble, which is the authority; `AGENTS.md`'s "When you write a decision or a
  requirement" states what proposing one obliges you to do. Read the preamble of the file you are
  changing before you draft.
- **Not all of it lintable.** Where the repository defines it, `scripts/spec-style-lint.mjs`
  reads rules 1 and 2 off this file and applies them to `README.md`, `ARCHITECTURE.md`,
  `docs/spec/decisions.md`, and `docs/spec/requirements.md`. It reads every prose paragraph and
  every table cell, and skips fenced code and the retired registers, whose historical text is
  kept. A ruled-out term is a finding, and so is a sentence past the ceiling. Rules 3 and 4 ask
  whether an actor matters and whether a structure fits its meaning. Those are judgments, so
  they hold because an author applies them and a reviewer reads for them. Rule 5 asks who owns
  a fact, and holds the same way. The lint's `--hints` option gives advisory hints for rules 4
  and 5, which hold by judgment still.

## Before you hand it off

1. Does every concept use the binding documents' existing word, and does every existing
   distinction survive?
2. Is any sentence past 40 words? Are most nearer 25 than 35?
3. Does every sentence about authority name its actor?
4. Is anything ordered or conditional still buried in prose?
5. Does any passage restate what a source it names already says, or introduce a term nothing
   here defines?
6. Did you change what a ratified clause means? That is a proposal, not a restyle.
