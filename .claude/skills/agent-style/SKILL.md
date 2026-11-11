---
name: agent-style
description: The form a role prompt is written in — the sections it carries, the one test for whether a sentence belongs in it, and the facts it must never assert. Load before writing or reviewing any file under .claude/agents/.
---

ABOUTME: How a role prompt is written: the one test for whether a sentence belongs in it, the
seven sections it carries and the test behind each, and the facts it never asserts.

# Writing a role prompt

A role prompt says who one role is. `AGENTS.md` already binds every session in this repository,
so the prompt's whole job is to narrow: to say what is true of this role, and nothing else.

These files are templates. `rigger init` forks them into a consumer's repository, and Rigger reads
none of them from its own package at run time (`R-SAFE-6`). What a prompt asserts has to hold
wherever it lands, not only here.

## The one test

**If a sentence is true of every role, it belongs in `AGENTS.md` and not in a role prompt.**

Restating a repo-wide rule in a prompt does not emphasise it. It re-scopes it. The reader takes it
as this role's particular duty, and the rule looks narrower than it is. Leaving it out assigns
nothing, because the prompt's opening keeps the whole of `AGENTS.md` binding.

This is `AGENTS.md`'s "Documents own their facts" applied to prompts.

## The sections

Frontmatter, then seven sections in this order. A section with nothing true in it is left out
rather than padded.

| Section | What it holds | The test |
|---|---|---|
| Frontmatter | The `name` the configuration gives this role, and a `description` saying when to reach for it | A reader who sees only the description can tell what the role is for |
| When you fire | What has to be true for this role to be dispatched, in plain words | The reader can tell whether a given card is this role's |
| What you own | The artifact this role and only this role produces | No two prompts claim the same artifact |
| What you read, and what you never edit | The documents read before drafting, and the ones to stay consistent with and leave alone | Every document the role could open is on one side or the other |
| Who hands to you, and who picks up from you | The neighbouring roles, by name | For each thing the role must not do, the prompt names who does it instead |
| How you do it | The skills this role loads, by the path they live at, and when | Every path named exists |
| The ways you go wrong | The mistakes this role in particular makes | The section would be false or pointless in another prompt |
| What you never do | Prohibitions particular to this role, each with its source | No line survives being pasted into another prompt unchanged |

The last two are where a prompt earns its keep. A role a reader cannot get wrong in some specific
way is a role the prompt has not described.

## What a role prompt never asserts

- **A fact the configuration owns.** Which kind of card reaches this role, who judges it, how many
  rounds it gets, its model tier. The consumer declares all of those (`ARCHITECTURE.md`,
  "Extension points"), so a prompt stating them lies to every consumer who chose otherwise. It is
  also a second copy of a fact something else owns, which is what `D8` exists to prevent.
- **A rule `AGENTS.md` already carries.** The one test above.
- **Engine or board mechanics.** How a card moves, how a dispatch is recorded, what the gate
  admits. Those belong to Rigger's own layers rather than to a role.
- **A claim about the repository a reader cannot check.** A line count, a file that does not exist
  yet, a convention nothing records.

## The form

A role prompt is written in the form rules of `.claude/skills/spec-style/`, which holds each rule
and the test behind it. It takes all of them but the ownership split.

`AGENTS.md` reaches a prompt with that split directly, as "The one test" above says, so the skill
is not where a prompt takes it from.

Write in English rather than in the binding documents' vocabulary. A role reads its prompt on
dispatch, with nobody to ask. Where a term of art earns its place, the sentence around it says
what it means.

## Before you hand it off

1. Does every sentence say something true of this role rather than of every role?
2. Does each section pass its test in the table above?
3. Does the prompt assert a kind, a judge, a round count or a model tier?
4. Does every path and id in it resolve?
5. Would the "ways you go wrong" section be wrong in another role's prompt?
6. Could someone read the description alone and know when to reach for this role?
