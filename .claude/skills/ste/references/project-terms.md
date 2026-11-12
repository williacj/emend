ABOUTME: The project layer over the ste skill's word list: protected terms that keep one form and
one meaning, and the rulings that override a general substitution.

# Project terms and rulings — Rigger

This file is the project layer over `word-substitutions.md`. If the two disagree, this file
wins. A protected term keeps its listed form and its one meaning in every Rigger document; the
general substitution for that word does not apply to it.

## Protected technical terms

| Term | The one meaning |
|---|---|
| verify, verify-by-execution | prove a claim with a command's output, never by reasoning (the Triage discipline). For ordinary assurance in prose, use "make sure that". |
| validate, validation | the engine's startup examination of the config, which refuses an incoherent config |
| execution, Execution Kind | the routing fact on a card (product constant); also the "verify-by-execution" term above |
| terminal, terminalize | convert a fatal into an ordered authority sweep and a lifecycle close (DH-39); a terminal outcome leaves the pull set |
| retain | keep durable state across a process exit (sentinel, outbox, holder) |
| activate, activation epoch | the operator-controlled start of the serialized finalization lane (DH-46) |
| confirm | prove that a remote write landed before the engine advances local state (the outbox publisher) |
| required, required core, requiredCheck | contract vocabulary: a key or check the consumer must supply |
| proceed | a card's authorized continuation after a disposition (DH-30) |
| escalate | route a card to the escalation lane (`engineReview`). Do not use "bubble", "park", or "forward" for this action. |
| disposition | the owner's recorded answer over an exact head: ratified or rejected |
| attempt, attempt bound (noun) | one counted dispatch of an escalation-lane role, and its per-card limit (DH-29/DH-36). The verb stays "try". |
| lease, holder, occupant | three different coordination authorities; never synonyms for each other |
| marker | the judge's SHA-bound verdict file |
| sentinel | a durable cross-process request file (shutdown, breaker) |
| settle | active work runs to its ordinary completion |
| sweep | the engine's bounded release of the authorities it owns |
| drain | the pool becomes empty under ordinary completion |

## Modal ruling

- **may** is retained with exactly one meaning: *is authorized to*. Authority allocation is this
  project's subject; "can" does not carry it.
- **can** = capability. **must** = requirement. **will** = future. Never should, would, could,
  might.

## Classification ruling

- Rigger's spec and reference documents are descriptive text (25-word limit). In prose, write
  engine behavior with the engine or the named role as the subject: "The engine sends the final
  heartbeat."
- Exception, from blind-reader evidence (2026-08-09): a NUMBERED sequence of engine steps uses
  verb-initial lines ("1. Send the final heartbeat."), with the actor named once in the lead-in
  ("The engine performs these steps in order:"). Eight lines that each start "The engine" hide
  the verbs and defeat scanning; the verb-initial list was the best-comprehended passage in a
  blind three-version comparison.
- Imperatives that address the reader are for operator procedures only: start, stop, breaker
  clearing, lane activation.

## Not prose

DH-# tags, config keys, label literals, semantic stage keys, telemetry event kinds, and CLI
flags are code identifiers. Keep them exactly as written (see "What NOT to touch" in SKILL.md).
