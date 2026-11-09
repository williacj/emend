// ABOUTME: Shared step-block matching helpers for this repo's regex-based GitHub Actions workflow
// ABOUTME: tests — extracted from scripts/windows-workflow.test.mjs so a second workflow file (#2293)
// ABOUTME: reuses the same anchored-if: idiom instead of a second, driftable copy of it.
import assert from 'node:assert/strict';

// Escapes a literal string for embedding inside a `new RegExp(...)` pattern. Step names in these
// workflows can carry regex-meaningful characters (e.g. the parenthesized "(test-plan §9b)" suffix on
// "Validate vitest unhandled-errors invariant") that would otherwise silently change what the
// constructed pattern matches rather than fail loudly.
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function namedStep(yaml, name) {
  return yaml.match(new RegExp(`- name: ${escapeRegExp(name)}\\n([\\s\\S]*?)(?=\\n\\s+- name:|$)`));
}

// Shared by every prerequisite-gating test across the self-hosted workflow (#1178 sccache, #2275
// toolchain pin, #2295 Node setup) and the contention benchmark workflow (#2293): both prove the same
// shape — a named upstream step's `outcome` must appear, literally, in each listed downstream step's
// `if:` — over a different prerequisite and a different downstream step list.
//
// #2295 review finding 2: matching over the WHOLE captured step block is satisfied by a comment
// mentioning the literal, not just by the step's own real `if:` — `namedStep` sweeps up any comment
// block sitting between this step's body and the NEXT step's `- name:` line, which logically belongs
// to that next step, not this one. Anchoring to this step's own `if:` line closes that gap: a line
// that merely starts with `#` cannot match `^\s*if:`. Every `if:` in these workflows is a single line
// of the form `if: ${{ ... }}`.
export function assertStepsRequireOutcome(yaml, stepNames, outcomeExpression, failureReason) {
  const outcomePattern = new RegExp(escapeRegExp(outcomeExpression));
  for (const name of stepNames) {
    const step = namedStep(yaml, name);
    assert.ok(step, `expected a ${name} step`);
    const ifLine = step[0].match(/^\s*if:\s*\$\{\{([^\n]*)\}\}\s*$/m);
    assert.ok(ifLine, `expected a single-line "if: \${{ ... }}" condition for ${name}`);
    assert.match(
      ifLine[1],
      outcomePattern,
      `${name} ${failureReason}`,
    );
  }
}
