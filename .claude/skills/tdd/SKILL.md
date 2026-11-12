---
name: tdd
description: "Design discriminating tests while implementing an Emend feature or bugfix, or while writing or changing tests. Load before the first test body. Do not use for independent review, pre-handoff-only checking, prose-only cards, or throwaway spikes."
---

ABOUTME: Emend's test-design workflow for discriminating red-green-refactor cycles. It moves
oracle, seam, variation, and valid-RED decisions to the moment each test is designed.

# Discriminating TDD

Use this skill to design each test before implementation. `docs/test-plan.md` and Emend's
constitution remain authoritative. The implementer still owns suite scoping, traceability, PR evidence, and handoff.

Do not use this workflow for prose-only cards or gitignored `/spikes/` throwaway code. Do not create a
second TDD evidence document. Keep the test card in the task's ordinary working notes.

## Write the test card first

Record these fields before writing the test body:

- **Guarantee:** the observable behavior being added or repaired.
- **Seam:** the stable boundary through which the behavior is observed.
- **Killer mutation:** one plausible production defect that must make this assertion fail.
- **Oracle:** the source of the expected result, derived independently from the implementation.
- **Axes varied:** the inputs, states, identities, orderings, or failure modes exercised.
- **Axes fixed:** important dimensions this test does not cover.
- **Substitutions:** what is replaced and whether production participants remain at both ends.
- **Selector:** the narrow command that executes this cell.

If the card cannot name a plausible defect or independent oracle, redesign the test before proceeding.
A test that merely snapshots the current implementation, repeats its algorithm, or asserts a mock's
existence is not a useful RED.

## Work one vertical slice

1. Write one test for one observable guarantee.
2. Run the test card's narrow selector.
3. Confirm the intended cell executed and failed because the behavior is missing or broken.
4. Write the minimum production change.
5. Run the identical selector to GREEN.
6. Refactor while the selector stays green.
7. Create the next test card only after this slice is green.
8. Finish with the applicable layer suite, traceability update, and PR review.

Do not batch a horizontal inventory of imagined tests before any behavior works. A compile-time RED is
valid only when the missing API or type contract is the intended signal. Syntax, setup, dependency,
selector, and unrelated failures do not count.

## Make the assertion discriminate

- Assert behavior at the stable seam, not implementation choreography. Reject tests whose only value is
  detecting an intentional refactor.
- Derive expected values from the specification, a simple independent model, or a known fixture. Do not
  reproduce the production algorithm in the test.
- Understand a boundary's side effects before replacing it. When the guarantee depends on files, Git,
  process behavior, or another real boundary, retain a focused test on that real seam.
- In e2e, follow `docs/test-plan.md` §7b: substitute transport, never a production participant.
- Treat the killer mutation as a non-vacuity hypothesis. Later executed mutation evidence can show that
  an assertion can fail; it cannot prove that the test is sufficient or that all defects are covered.
- State meaningful fixed axes honestly. Add another test only when its varied axis protects a distinct
  risk, not to claim exhaustive edge-case coverage.

## Route Emend-specific risks

- For a `textops` invariant, extend the relevant P1-P6 property. Make generators reach the difficult
  input classes instead of merely increasing the case count.
- Use real temporary directories, real files, and local bare Git repositories when the guarantee
  depends on those boundaries.
- Use manual clocks, channels, barriers, or condition-based waits instead of wall-clock sleeps.
- Preserve a minimized permanent regression case when a property test discovers a bug.
- Add or adjust `docs/test-matrix.md` when behavior traces to an FR, property, or TD invariant.
- For Rust work, read [references/rust.md](references/rust.md) before designing the first Rust test.

Choose test levels and suites from risk and the touched layer. Do not invent numeric coverage targets,
new test dependencies, or unit-plus-integration-plus-e2e requirements that the card does not need.
