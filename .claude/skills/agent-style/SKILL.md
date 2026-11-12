---
name: agent-style
description: The form a role prompt is written in — the sections it carries, the one test for whether a sentence belongs in it, and the facts it must never assert. Load before writing or reviewing any file under .claude/agents/.
---

ABOUTME: How a role prompt is written: the one test for whether a sentence belongs in it, the
seven sections it carries and the test behind each, and the facts it never asserts.

# Writing a role prompt

A role prompt says who one role is. `CLAUDE.md` and `AGENTS.md` already bind every session in this
repository, so the prompt's whole job is to narrow: to say what is true of this role, and nothing
else.

These files began as Rigger's templates, which `rigger init` forked into this repository. Rigger
reads them from here, never from its own package, so what a prompt asserts has to hold in Emend.

## The one test

**If a sentence is true of every role, it belongs in `CLAUDE.md` or `AGENTS.md` and not in a role
prompt.**

Restating a repo-wide rule in a prompt does not emphasise it. It re-scopes it. The reader takes it
as this role's particular duty, and the rule looks narrower than it is. Leaving it out assigns
nothing, because the prompt's opening keeps the whole of `CLAUDE.md` and `AGENTS.md` binding.

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

The role's key under `roles` in `rigger.config.mjs`, such as `pmReviewer`, is the name Rigger
dispatches it by and writes as `role` in a verdict marker. The frontmatter `name` may be its
hyphenated form, such as `pm-reviewer`, because Claude Code names agents that way.

The last two are where a prompt earns its keep. A role a reader cannot get wrong in some specific
way is a role the prompt has not described.

## What a role prompt never asserts

- **A fact the configuration owns.** Which kind of card reaches this role, who judges it, how many
  rounds it gets, its model tier. `rigger.config.mjs` declares all of those, so a prompt stating
  them is a second copy that goes stale the day the config changes.
- **A rule `CLAUDE.md` or `AGENTS.md` already carries.** The one test above.
- **Engine or board mechanics.** How a card moves, how a dispatch is recorded, what the gate
  admits. Those are Rigger's, and its guide owns them.
- **A tool only one provider has.** `rigger.config.mjs` may run a role on Claude Code or on Codex,
  so its prompt has to read the same on both. Name a skill by its directory under `.claude/skills/`:
  Claude Code finds it there, Codex finds it through the `.agents/skills` link
  (`.agents/README.md`), and either can read its `SKILL.md` at that path. Name no tool, subagent,
  slash command or settings file that only one provider has.
- **A claim about the repository a reader cannot check.** A line count, a file that does not exist
  yet, a convention nothing records.

## The form

A role prompt is written in the form rules of `.claude/skills/spec-style/`, which holds each rule
and the test behind it.

Write in English rather than in the constitution's vocabulary. A role reads its prompt on
dispatch, with nobody to ask. Where a term of art earns its place, the sentence around it says
what it means.

## Before you hand it off

1. Does every sentence say something true of this role rather than of every role?
2. Does each section pass its test in the table above?
3. Does the prompt assert a kind, a judge, a round count or a model tier?
4. Does every path and id in it resolve?
5. Would the "ways you go wrong" section be wrong in another role's prompt?
6. Could someone read the description alone and know when to reach for this role?
7. Would it read the same to a session on Claude Code and one on Codex?
