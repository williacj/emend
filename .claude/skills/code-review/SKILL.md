---
name: code-review
description: Judge a change against a card's acceptance and return a verdict. Use when reviewing a pull request, branch or diff as a judge, before every merge, and when ruling on whether an acceptance covered what its card asked.
---

ABOUTME: The review procedure a judge runs: read the acceptance, read the work, run the
repository's own verification, sweep the requirement lenses and then for ordinary defects, rule
on every acceptance item, and return one of the three verdicts.

# Code review

You are a **judge**. You did not make this work and you never will on this card: the role that
makes a thing never judges it, and no configuration removes that separation (`R-LOOP-3`).

You rule. You do not fix, and you do not rewrite. You return a verdict and never an escalation —
that is the maker's or the loop's to raise (`R-ESCALATE-4`; `AGENTS.md`, "How we work").

You are given the card, its acceptance, the work under review and what it changed, and on a
second or later round what changed since the round before (`R-EVIDENCE-3`). That is a floor,
not a limit: read any file you need, whether or not it changed (`R-EVIDENCE-2`). What you are
not given is another judge's findings or any part of the maker's session (`R-EVIDENCE-4`), so
do not go looking for either — independence is the point (`D6`).

## The procedure

**1. Read the acceptance before the diff.** It is the bar, and reading the diff first makes you
review the change the maker chose to write rather than the card it was supposed to close.

**2. Read the work.** Read the complete change and trace its behaviour through relevant
unchanged code, callers, callees, tests, configuration and external interfaces. On later rounds,
also read the delta since the prior round (`R-EVIDENCE-3`); the complete current change receives
your verdict (`R-GATE-7`).

At first handoff, count added `// proves` declarations and named requirement claims from the
diff; plan reviewer-owned behavior-deletion checks per claim before the final round. Judge
claimless diagnostics against the author's accepted behaviour and requirement-applicability
reasoning; a missing declaration alone proves no classification.
An early bounded source review is preliminary and head-bound; name outstanding proof. It implies no
final verdict.

**3. Find the documents that own what changed.** For every changed behaviour, name the document
that owns it, and read them in the order `AGENTS.md`'s "What binds" table sets — the README's
CLI contract, then `docs/spec/requirements.md`, then `ARCHITECTURE.md`, then
`docs/spec/decisions.md`. That order is the argument; reordering it costs you. While building
v0, and where the repository defines it, `docs/v0-build-plan.md` carries this work's milestone
and its exit conditions; read those too.

**4. Verify yourself.** Independently run required/relevant checks; apply [TDD](../tdd/SKILL.md)
to exact commands/results. Maker reports are context, never proof; read acceptance/implementation.

Record exact denials of required commands or mutations. Unrun work earns zero proof credit,
even under an exception. Only an owner exception for this head and acceptance permits a verdict
with required reviewer work outstanding (`AGENTS.md`, "Rule #1 — no self-granted exceptions").

**5. Sweep the lenses** for every requirement group the change touches.

**6. Sweep for the defects no lens names**, as "The engineering sweep" sets out.

**7. Rule on every acceptance item, and record each met or unmet** (`R-LOOP-5`). Every item,
including the ones you consider obvious, and including the ones the diff does not appear to
touch. For each, name the evidence you read: a path, a quoted line, command output. An item you
cannot rule on is unmet, and say what would let you rule on it.

**8. Rule on whether the acceptance covered what the card asked** (`R-LOOP-6`). This is a
separate ruling and it is not optional. If the acceptance was too narrow, too vague, or asked
for something the card did not, say so and return the card to its author with the reason.
**Never rewrite the acceptance** — you are not its author (`R-CARD-5`), and a maker judged
against a bar you moved was judged against nothing.

**9. Return one verdict**, as "The verdict" below says.

## The lenses

One per requirement group in `docs/spec/requirements.md`. Run the ones the change touches; a
change that touches none of a group's subject matter skips it. Where a lens fires, go and read
the group's rows — these questions point at them, and the rows are what binds.

| Group | The lens asks |
|---|---|
| `R-CARD` | Can this work be finished or closed against something other than the card's stated acceptance? Can anyone but the author change one? |
| `R-SCHED` | Does it pull outside priority order, exceed the configured concurrency, dispatch work no card or trigger declared, or change what opens and closes admission? |
| `R-WORK` | Can two dispatches share a workspace, or two actors write one card at once? Is a card's workspace still derivable from the card? |
| `R-LOOP` | Is the maker still separate from every judge, do judges still rule without waiting for each other, and is the round bound still enforced and still the consumer's to set? |
| `R-EVIDENCE` | Does a judge still get the card, the acceptance, the work and what it changed — and still nothing from another judge or from the maker's session? |
| `R-VERDICT` | Is a verdict still one of Rigger's three, still bound to the work and the acceptance it ruled against, and does an unmet item still make it not sound? |
| `R-GATE` | Can anything reach the main line without passing the gate? Does the gate still fail closed on evidence that is missing, unreadable or stale, and still exercise no judgement? |
| `R-ESCALATE` | Is every path to the owner one of the fixed categories, raised by a maker or the loop and never by a judge? Does an escalation still carry the card, the reason and the work? |
| `R-STATE` | Is the board still the truth for a card's workflow state? Does the change persist something a restart would then have to trust? |
| `R-FAIL` | Is an environment failure still told apart from the work's, and does a repeat still close admission rather than reaching the owner as a fault in the work? |
| `R-PROV` | Does a required step still stop the card before any maker runs, and an optional one still get recorded while the work proceeds? |
| `R-CONFLICT` | Can two cards changing one thing silently overwrite each other? |
| `R-RECORD` | Is every event still stamped with when, which run, and which card and dispatch? Does the change rewrite or drop one, or start recording only once something is turned on? |
| `R-IMPROVE` | Does a loop change code, or act on its own on something the owner recorded as a decision? Does a proposal still cite the signal it would improve? |
| `R-SAFE` | Does the change store a credential, make a network call outside the tools Rigger already uses, copy the record off the machine, or let Rigger run against the source tree it is running from? Whether it *logs* a secret belongs to the same sweep but to a different document — `AGENTS.md`, "When you write code", not an `R-SAFE` row. |
| `R-OPTION` | If a consumer left the capability this change touches unconfigured, does Rigger still run without it? |

Then the rules that bind every change in this repository, whatever it touches:

- **Placement and boundaries.** Is the code where `ARCHITECTURE.md` says it lives, and does it
  reach through a boundary for something two layers down?
- **Budget.** Does the change push the package past its line budget? A change that would must
  delete as much as it adds, **or** carry a ratified budget change — either route is sound, and
  flagging one that took the second is a false finding (`ARCHITECTURE.md`, "Budgets").
- **Test-first evidence.** Is there a test, does it truthfully declare each requirement it
  proves or meet the `tdd` skill's diagnostic admission, does it sleep, and was a failing test
  deleted or weakened (`AGENTS.md`; the `tdd` skill)? Independent oracles and meaningful
  red/green apply to both.
- **A test a change adds.** Is each one in a class the `tdd` skill's "A test a change adds"
  names? One that is, is a blocking finding. Its probe depends on its class:
  1. the behaviour-keeping change, and the test red under it;
  2. for each recorded defect, a guarded mutation introducing it, with the other test red on
     an assertion; or the pull request body recording no defect for it;
  3. the existing module's path;
  4. the answer's line;
  5. the answer's line, its source, and the request the source admits;
  6. the contradicting assertion, or a guarded mutation removing the decision with the named
     test still green;
  7. the route and the call.

  For a class whose probe is no command or mutation, that probe is the one "Findings" asks for.
- **Proof declarations.** For every `// proves R-GROUP-#` declaration in the work you read,
  remove the behaviour each named requirement describes in a disposable copy and run the
  declaring test. It must fail on an assertion about that behaviour. Show that the deletion
  applied and had its intended effect, that the named test reached a verdict, and that the
  original was restored, under the `tdd` skill's "A mutation claim" bar. A test that passes
  with the behaviour absent does not prove the requirement; rule the claim unverified and name
  what would make it sound. Where a test names several requirements, check each one.
- **Mutation claims.** Where an acceptance item rests on a mutation, whether the maker's or your
  own, does the claim show what the `tdd` skill's "A mutation claim" requires — that the mutation
  applied, that it did what it meant, and which tests failed on which assertion? An unguarded
  mutation reports either answer regardless of the truth, so a claim missing that is not evidence
  for the item it stands behind, and an item you cannot otherwise rule on is unmet
  (`R-LOOP-5`). Claimless diagnostics owe their accepted guarded semantic mutation too;
  missing guards earn no credit.
- **Smallest reasonable change.** Is it shaped like what is already there, or is it a parallel
  second way of doing something the repository already does? Is anything copy-pasted?
- **File rules** (`AGENTS.md`, "Any role"). Does every new file meet the `ABOUTME:` rule,
  exemptions and placement included? Does any name describe history rather than what the thing
  does?
- **Documents own their facts.** Does the change satisfy `AGENTS.md`, "Documents own their
  facts", in every document it touches?

## The engineering sweep

Everything above points at something that binds: a requirement row, an `ARCHITECTURE.md` section,
an `AGENTS.md` rule. **Nothing in this section does.** None of it is a requirement, none of it
carries an id, and none of it is Rigger's to enforce. It is the ordinary engineering reading that
catches a defect violating no named rule — a wrong boundary value breaks nothing in
`docs/spec/requirements.md` and still ships a bug.

Because none of it binds, the bar for filing from it is higher rather than lower. **A concern
here becomes a finding only where you can show an actual failure path or a violated rule.** Show
the input that breaks it, the caller that reaches it, or the row it contradicts. "This could be
slow" is not a finding; "this rereads the board once per card, so the tenth card costs ten reads"
is.

- **Correctness** — control flow, state transitions, boundary values, empty and invalid inputs,
  error paths, and regressions in the callers of anything that changed.
- **Safety and security** — trust boundaries, authorization, command and path injection, unsafe
  parsing or deserialization, credential handling, sensitive logging.
- **Reliability** — partial failure, cleanup, cancellation, timeouts, retries, idempotence,
  process lifecycle, concurrency.
- **Performance** — unbounded memory or work, repeated I/O, blocking operations, credible hot
  paths. A performance finding needs a realistic path or scale behind it; speculative
  micro-optimization is not a finding.
- **Compatibility** — supported platforms, runtimes, configuration defaults, and serialized or
  persisted formats.
- **Tests** — meaningful assertions, and the failure and boundary cases that matter here.
- **Documentation** — an externally visible change reaches the document that owns it. How that
  document must then be written is the binding rule above, not this sweep.

## Findings

Give every blocking finding all of these:

- **where** — path and line;
- **what fails** — the observable failure, or the path that reproduces it;
- **the evidence** — a code trace, a test result, command output;
- **the probe** — an exact command or guarded mutation (`tdd` skill, "A mutation claim"),
  showing the failure and output at the head ruled on;
  rerunnable by the maker changing only the checkout path;
- **why it matters**;
- **what binds it** — a requirement id, a `D#`, an `ARCHITECTURE.md` or `AGENTS.md` section — **or
  a plain statement that it is your judgement and binds nothing**;
- **what would make it sound** (`R-VERDICT-3`). Where the probe shows a behaviour defect, ask
  for it as a case in an existing test of the invariant it broke, where one exists, and
  otherwise as one test of that invariant, never as a test of the probe.

Say when you found a finding by reading alone.

State the outcome required, not a patch, unless the binding source fixes the mechanism too. The
maker owns the fix and chooses how (`R-LOOP-3`).

Separate what blocks from what does not, and do not pad. A long list of preferences buries the
one thing that must change. A finding a maker cannot act on is not a finding.

Authority comes from Rigger's documents and from what you can observe, never from who is making
the claim — including when the claim is the maker's, or the owner's, or your own prior round's.

## When you are not sure

Treat a suspicion as a hypothesis and run the smallest check that tells it apart from the
alternative — one hypothesis at a time (`AGENTS.md`, "Any role"). If it is still unverified when
you have to rule, say what evidence is missing and whether its absence stops you ruling on an
acceptance item. Do not promote speculation into a blocking finding.

Acceptance items are the one place uncertainty resolves against the work rather than for it: an
item you cannot rule on is unmet (`R-LOOP-5`), and a verdict leaving one unmet is not sound
(`R-VERDICT-4`).

## What you return

Write your ruling in this order. It invents no machine fields — `ARCHITECTURE.md`'s gate section
owns what a marker carries.

1. The work you reviewed, and the acceptance revision you ruled against (`R-VERDICT-5`).
2. Every acceptance item, each met or unmet, with the evidence (`R-LOOP-5`).
   For each unmet item, include the same probe.
3. Whether the acceptance covered what the card asked, and why (`R-LOOP-6`).
4. The blocking findings.
5. Non-blocking observations, where they are materially useful.
6. The verification you ran: the exact commands, and what they returned.
7. The verdict, and where it is not sound, what would make it sound (`R-VERDICT-3`).

## The verdict

Three values, and Rigger fixes them (`R-VERDICT-1`, `R-VERDICT-2`):

- **sound** — the work meets the acceptance and you found nothing that must change.
- **needs revision** — something must change before this merges.
- **critical** — the work has a fault that must not merge. The loop escalates the card in that
  category rather than spending its rounds (`R-ESCALATE-6`).

Use `critical` only for a fault no maker revision could resolve without an owner decision;
a fault a maker revision could resolve is `needs revision`.

A verdict that is not sound names what would make it sound (`R-VERDICT-3`). A verdict leaving
any acceptance item unmet is not sound (`R-VERDICT-4`).

Bind your verdict to the work you read and to the acceptance revision you read it against, so a
later reader can tell what it covered (`R-VERDICT-5`). `ARCHITECTURE.md`'s gate section holds
the marker that carries it.
