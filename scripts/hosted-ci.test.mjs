// ABOUTME: Tests the hosted CI gate: shipped-platform Suites legs and their cross-OS execution evidence.
// ABOUTME: Pins independent macOS and Windows results, per-leg artifacts, and a check that cannot pass by skipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(HERE, '..', '.github', 'workflows', 'ci.yml');

test('hosted Cargo tests run independently on the two shipped platforms only (issue #1028)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const cargoJob = workflow.match(/\n  suites:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/)?.[1];

  assert.ok(cargoJob, 'expected the suites job');
  assert.match(cargoJob, /- name: Cargo test\n/);
  assert.match(cargoJob, /strategy:\s*\n\s+fail-fast:\s*false/);
  const legs = [...cargoJob.matchAll(/^\s+- os: (\S+)$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(legs, ['macos-latest', 'windows-latest']);
  assert.doesNotMatch(cargoJob, /ubuntu-latest/);
});

function job(workflow, name) {
  const block = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]+:\\n|$)`))?.[1];
  assert.ok(block, `expected the ${name} job`);
  return block;
}

test('each hosted Suites leg uploads every suite\'s execution evidence under its own OS label (williacj/emend#8)', () => {
  const suites = job(readFileSync(WORKFLOW_PATH, 'utf8'), 'suites');
  const legs = [...suites.matchAll(/^\s+label: (\S+)$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(legs, ['macos', 'windows']);

  // One artifact per kind, each carrying the leg's label: `matrix-evidence` merges both legs into
  // one directory, where two legs writing one filename would silently keep only one of them.
  assert.match(suites, /tee "\$EMEND_MATRIX_ARTIFACTS\/rust-\$\{\{ matrix\.label \}\}\.txt"/);
  assert.match(suites, /--outputFile\.json="\$EMEND_MATRIX_ARTIFACTS\/vitest-\$\{\{ matrix\.label \}\}\.json"/);
  assert.match(suites, /EMEND_TEST_RESULTS_FILE: \$\{\{ runner\.temp \}\}\/matrix-results\/node-scripts-\$\{\{ matrix\.label \}\}\.jsonl/);
  assert.match(suites, /EMEND_E2E_RESULTS_FILE: \$\{\{ runner\.temp \}\}\/matrix-results\/e2e-\$\{\{ matrix\.label \}\}\.json/);
  const written = [...suites.matchAll(/(?:matrix-results|EMEND_MATRIX_ARTIFACTS)\/([a-z][^"\n]*?\.(?:txt|jsonl|json))/g)]
    .map((match) => match[1]);
  assert.equal(written.length, 4);
  for (const file of written) assert.match(file, /\$\{\{ matrix\.label \}\}\.[a-z]+$/, file);

  const upload = suites.match(/- name: Upload test-matrix results\n([\s\S]*?)(?=\n\s+- name:|$)/)?.[1];
  assert.ok(upload, 'expected the results upload step');
  assert.match(upload, /name: matrix-results-\$\{\{ matrix\.label \}\}/);
  assert.match(upload, /if-no-files-found: error/);
  assert.doesNotMatch(upload, /^\s+if:/m);
});

test('the hosted execution check reads both legs together and fails when a leg did not pass (williacj/emend#8)', () => {
  const evidence = job(readFileSync(WORKFLOW_PATH, 'utf8'), 'matrix-evidence');

  assert.match(evidence, /needs: suites/);
  // A job skipped because a leg failed would read as passing, so this job always runs and fails.
  assert.match(evidence, /\n    if: \$\{\{ !cancelled\(\) \}\}/);
  const guard = evidence.match(/- name: Require both Suites legs to pass\n([\s\S]*?)(?=\n\s+- (?:name|uses):|$)/)?.[1];
  assert.ok(guard, 'expected the leg-result guard');
  assert.match(guard, /if: \$\{\{ needs\.suites\.result != 'success' \}\}/);
  assert.match(guard, /exit 1/);

  assert.match(evidence, /pattern: matrix-results-\*/);
  assert.match(evidence, /merge-multiple: true/);
  const check = evidence.match(/node scripts\/check-test-matrix\.mjs[^\n]*/)?.[0];
  assert.ok(check, 'expected the execution check');
  assert.match(check, /--artifacts "\$RUNNER_TEMP\/matrix-results"/);
  // Enforced: vitest and e2e. rust and node stay observed: widening the gate is CJ's call (#2234).
  assert.match(check, /--require-kinds vitest,e2e$/);
});
