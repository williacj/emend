// ABOUTME: Pins GitHub Actions' own JavaScript runtimes to Node 24-capable releases across CI.
// ABOUTME: Separately guards the Node 20 suite runtime, which issue #778 deliberately does not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/windows-self-hosted.yml',
];

function readWorkflows() {
  return WORKFLOW_PATHS.map((path) => ({
    path,
    yaml: readFileSync(join(REPO_ROOT, path), 'utf8'),
  }));
}

test('all workflows pin Node 24-based checkout and setup-node releases (issue #778)', () => {
  const expected = {
    'actions/checkout': {
      sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      tag: 'v7.0.1',
    },
    'actions/setup-node': {
      sha: '820762786026740c76f36085b0efc47a31fe5020',
      tag: 'v7.0.0',
    },
  };

  for (const { path, yaml } of readWorkflows()) {
    const pins = [...yaml.matchAll(/uses:\s*(actions\/(?:checkout|setup-node))@(\S+)(?:\s+#\s*(v[\d.]+))?/g)];
    assert.deepEqual(
      new Set(pins.map(([, action]) => action)),
      new Set(Object.keys(expected)),
      `expected ${path} to use both protected actions`
    );
    for (const [, action, ref, tag] of pins) {
      assert.deepEqual({ sha: ref, tag }, expected[action], `${path} has a stale ${action} pin`);
    }
  }
});

test('the action runtime upgrade leaves the suite runtime on Node 20 (issue #778)', () => {
  const versions = readWorkflows().flatMap(({ yaml }) =>
    [...yaml.matchAll(/node-version:\s*"(\d+)"/g)].map((match) => match[1])
  );
  assert.ok(versions.length > 0, 'expected at least one explicit suite runtime');
  assert.deepEqual(new Set(versions), new Set(['20']));
});
