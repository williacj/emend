---
name: code-review
description: Judge a change against a card's acceptance and return a verdict. Use when reviewing a pull request, branch or diff as a judge, before every merge, and when ruling on whether an acceptance covered what its card asked.
---

ABOUTME: The review procedure a judge runs: read the acceptance, read the work, run the
repository's own verification, sweep the constitution lenses and then for ordinary defects, rule
on every acceptance item, and return one of the three verdicts.

# Code review

You are a **judge**. You did not make this work and you never will on this card: the role that
makes a thing never judges it, and no configuration removes that separation.

You rule. You do not fix, and you do not rewrite. You return a verdict and never an escalation —
that is the maker's or the loop's to raise.

You are given the card, its acceptance, the work under review and what it changed, and on a
second or later round what changed since the round before. That is a floor, not a limit: read any
file you need, whether or not it changed. What you are not given is another judge's findings or
any part of the maker's session, so do not go looking for either — independence is the point.

## The procedure

**1. Read the acceptance before the diff.** It is the bar, and reading the diff first makes you
review the change the maker chose to write rather than the card it was supposed to close.

**2. Read the work.** Read the complete change and trace its behaviour through relevant
unchanged code, callers, callees, tests, configuration and external interfaces. On later rounds,
also read the delta since the prior round; the complete current change receives your verdict.

An early bounded source review is preliminary and head-bound; name outstanding proof. It implies no
final verdict.

**3. Find the documents that own what changed.** For every changed behaviour, name the
constitution document that owns it, from the list in `CLAUDE.md`'s "Project Context":
`docs/functional-spec.md` (D#, FR-*), `docs/ux-design.md` (J#), `docs/tech-design.md` (TD-#,
§3.1), `docs/test-plan.md` (P#), and `docs/design/` for appearance, by mock id. Read what each
says about the change. Where two of them disagree, that is a finding for CJ, never yours to
resolve (`CLAUDE.md`, "Project Context"). Where the card belongs to a phase,
`docs/implementation-plan.md` carries its milestone; read that too.

**4. Verify yourself.** Independently run the suites `CLAUDE.md`'s "Starting Work & Testing"
names for every layer the change touches, and any other check the acceptance relies on. Judge
the tests the change adds against the [tdd skill's](../tdd/SKILL.md) "Make the assertion
discriminate"; the skill's workflow is the maker's, not yours. Maker reports are context, never
proof; read the acceptance and the implementation.

Record exactly which required command you could not run, and why. A check you did not run proves
nothing, even under an exception. Only CJ's exception for this head and acceptance permits a verdict
with required reviewer work outstanding (`CLAUDE.md`, "Rule #1").

**5. Sweep the lenses** for every constitution document the change touches.

**6. Sweep for the defects no lens names**, as "The engineering sweep" sets out.

**7. Rule on every acceptance item, and record each met or unmet.** Every item, including the
ones you consider obvious, and including the ones the diff does not appear to touch. For each,
name the evidence you read: a path, a quoted line, command output. An item you cannot rule on is
unmet, and say what would let you rule on it.

**8. Rule on whether the acceptance covered what the card asked.** This is a separate ruling and
it is not optional. If the acceptance was too narrow, too vague, or asked for something the card
did not, say so and return the card to its author with the reason. **Never rewrite the
acceptance** — you are not its author, and a maker judged against a bar you moved was judged
against nothing.

**9. Return one verdict**, as "The verdict" below says.

## The lenses

One per constitution document. Run the ones the change touches; a change that touches none of a
document's subject matter skips it. Where a lens fires, go and read the document's entries —
these questions point at them, and the entries are what bind. `CLAUDE.md`'s "Code Review" makes
any Critical invariant or constitution violation block merge.

| Document | The lens asks |
|---|---|
| `CLAUDE.md`, non-negotiable invariants | Does the change put a serializer between view and file, make anything on disk unportable or undocumented, deliver an agent change to a protected document other than as an atomic tracked change through the MCP contract, store a secret outside the OS keychain or send traffic from outside the Rust backend, or show git to the user? |
| `docs/functional-spec.md` | Does the behaviour still meet every D# and FR-* it touches, and does it add behaviour no requirement records? |
| `docs/ux-design.md` | Does each state and flow the change reaches match its journey (J#) and state inventory? Does it build behaviour a mock implies but `ux-design.md` does not record? |
| `docs/tech-design.md` | Is the code where §3.1 says it lives, and does it keep every TD-# contract it touches? |
| `docs/test-plan.md` | Are the properties P1–P6 and the substitution discipline (§7b) still held, and does every FR the change touches still have named tests in `docs/test-matrix.md`? |
| `docs/design/` | Does the appearance match the mock and spec it cites, `specs/tokens.md` and `specs/platform-variants.md` included? Does it answer a question `specs/state.md` lists under "Known gaps"? Does it edit anything under `docs/design/`, which is never hand-edited (`CLAUDE.md`, "Reading `docs/design/`")? |

Then the rules that bind every change in this repository, whatever it touches:

- **Placement and boundaries.** Is the code where `docs/tech-design.md` §3.1 says it lives, and
  does it reach through a boundary for something two layers down?
- **Test-first evidence.** Is there a test, does it discriminate as the `tdd` skill's "Make the
  assertion discriminate" asks, does it sleep, and was a failing test deleted or weakened
  (`CLAUDE.md`, "Starting Work & Testing")? Independent oracles and meaningful
  red/green apply.
- **Traceability.** Does every FR, property or TD invariant the change's behaviour traces to have
  its `docs/test-matrix.md` row, and does `npm run matrix:check` pass?
- **Smallest reasonable change.** Is it shaped like what is already there, or is it a parallel
  second way of doing something the repository already does? Is anything copy-pasted?
- **File rules** (`CLAUDE.md`, "Code Quality"). Does every new file meet the `ABOUTME:` rule,
  the `docs/design/` exemption included? Does any name describe history rather than what the
  thing does?
- **Documents own their facts.** Does every document the change touches state each fact once,
  in its owning document, and link to it elsewhere (`AGENTS.md`, "Documents own their facts")?

## The engineering sweep

Everything above points at something that binds: a constitution entry, a `CLAUDE.md` or
`AGENTS.md` rule. **Nothing in this section does.** None of it carries an id. It is the ordinary
engineering reading that catches a defect violating no named rule — a wrong boundary value
breaks no requirement and still ships a bug.

Because none of it binds, the bar for filing from it is higher rather than lower. **A concern
here becomes a finding only where you can show an actual failure path or a violated rule.** Show
the input that breaks it, the caller that reaches it, or the entry it contradicts. "This could be
slow" is not a finding; "this rereads the sidecar once per comment, so the tenth comment costs ten
reads" is.

- **Correctness** — control flow, state transitions, boundary values, empty and invalid inputs,
  error paths, and regressions in the callers of anything that changed.
- **Safety and security** — trust boundaries, authorization, command and path injection, unsafe
  parsing or deserialization, credential handling, sensitive logging.
- **Reliability** — partial failure, cleanup, cancellation, timeouts, retries, idempotence,
  process lifecycle, concurrency.
- **Performance** — unbounded memory or work, repeated I/O, blocking operations, credible hot
  paths. A performance finding needs a realistic path or scale behind it; speculative
  micro-optimization is not a finding.
- **Compatibility** — supported platforms (macOS and Windows), runtimes, configuration defaults,
  and serialized or persisted formats.
- **Tests** — meaningful assertions, and the failure and boundary cases that matter here.
- **Documentation** — an externally visible change reaches the document that owns it.

## Findings

Give every blocking finding all of these:

- **where** — path and line;
- **what fails** — the observable failure, or the path that reproduces it;
- **the evidence** — a code trace, a test result, command output;
- **the probe** — an exact command, or a temporary code change and the output showing it applied,
  that reproduces the failure at the head ruled on; rerunnable by the maker changing only the
  checkout path;
- **why it matters**;
- **what binds it** — a D#, FR-*, J#, TD-# or P# id, a `docs/design/` mock or spec, or a
  `CLAUDE.md` or `AGENTS.md` section — **or a plain statement that it is your judgement and binds
  nothing**;
- **what would make it sound**. Where the probe shows a behaviour defect, ask for it as a case in
  an existing test of the invariant it broke, where one exists, and otherwise as one test of that
  invariant, never as a test of the probe.

Say when you found a finding by reading alone.

State the outcome required, not a patch, unless the binding source fixes the mechanism too. The
maker owns the fix and chooses how.

Separate what blocks from what does not, and do not pad. A long list of preferences buries the
one thing that must change. A finding a maker cannot act on is not a finding.

Authority comes from Emend's constitution and from what you can observe, never from who is making
the claim — including when the claim is the maker's, or CJ's, or your own prior round's.

## When you are not sure

Treat a suspicion as a hypothesis and run the smallest check that tells it apart from the
alternative — one hypothesis at a time (`CLAUDE.md`, "Debugging"). If it is still unverified when
you have to rule, say what evidence is missing and whether its absence stops you ruling on an
acceptance item. Do not promote speculation into a blocking finding.

Acceptance items are the one place uncertainty resolves against the work rather than for it: an
item you cannot rule on is unmet, and a verdict leaving one unmet is not sound.

## What you return

Write your ruling in this order. It invents no machine fields — Rigger's instruction for your
verdict marker owns what a marker carries.

1. The work you reviewed, and the acceptance revision you ruled against.
2. Every acceptance item, each met or unmet, with the evidence.
   For each unmet item, include the same probe.
3. Whether the acceptance covered what the card asked, and why.
4. The blocking findings.
5. Non-blocking observations, where they are materially useful.
6. The verification you ran: the exact commands, and what they returned.
7. The verdict, and where it is not sound, what would make it sound.

## The verdict

Three values, and Rigger fixes them:

- **sound** — the work meets the acceptance and you found nothing that must change.
- **needs revision** — something must change before this merges.
- **critical** — the work has a fault that must not merge. The loop escalates the card in that
  category rather than spending its rounds.

Use `critical` only for a fault no maker revision could resolve without CJ's decision;
a fault a maker revision could resolve is `needs revision`.

A verdict that is not sound names what would make it sound. A verdict leaving any acceptance item
unmet is not sound.

Bind your verdict to the work you read and to the acceptance revision you read it against, so a
later reader can tell what it covered. Rigger's instruction for your verdict marker holds the
marker that carries it.
