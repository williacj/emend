// ABOUTME: Pins GitHub Actions' own JavaScript runtimes to Node 24-capable releases across CI.
// ABOUTME: Separately guards the Node 20 suite runtime, which issue #778 deliberately does not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const EXPECTED_PINS = {
  'actions/checkout': {
    sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
    tag: 'v7.0.1',
  },
  'actions/setup-node': {
    sha: '820762786026740c76f36085b0efc47a31fe5020',
    tag: 'v7.0.0',
  },
};

function readWorkflows(dir = WORKFLOW_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml'))
    .sort()
    .map((file) => ({ file, yaml: readFileSync(join(dir, file), 'utf8') }));
}

function protectedPins(yaml) {
  const pattern = /uses:\s*["']?(actions\/(?:checkout|setup-node))@([^\s"']+)["']?(?:\s+#\s*(v[\d.]+))?/g;
  return [...yaml.matchAll(pattern)].map(([, action, sha, tag]) => ({ action, sha, tag }));
}

function pinFaults(workflows) {
  return workflows.flatMap(({ file, yaml }) =>
    protectedPins(yaml)
      .filter(({ action, sha, tag }) => sha !== EXPECTED_PINS[action].sha || tag !== EXPECTED_PINS[action].tag)
      .map(({ action, sha, tag }) => `${file} has a stale ${action} pin: ${sha} # ${tag}`)
  );
}

test('all workflows pin Node 24-based checkout and setup-node releases (issue #778)', () => {
  const workflows = readWorkflows();
  // Guards against a vacuous pass: a reader or pattern that finds nothing reports no faults.
  assert.deepEqual(
    new Set(workflows.flatMap(({ yaml }) => protectedPins(yaml).map(({ action }) => action))),
    new Set(Object.keys(EXPECTED_PINS)),
    'expected the workflows to use both protected actions'
  );
  assert.deepEqual(pinFaults(workflows), []);
});

test('the action runtime upgrade leaves the suite runtime on Node 20 (issue #778)', () => {
  const versions = readWorkflows().flatMap(({ yaml }) =>
    [...yaml.matchAll(/node-version:\s*"(\d+)"/g)].map((match) => match[1])
  );
  assert.ok(versions.length > 0, 'expected at least one explicit suite runtime');
  assert.deepEqual(new Set(versions), new Set(['20']));
});

function readFixtureWorkflows(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'action-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, yaml] of Object.entries(files)) {
    writeFileSync(join(dir, name), yaml);
  }
  return readWorkflows(dir);
}

test('the pin check names the workflow file whose checkout pin differs from the expected SHA', (t) => {
  const staleSha = '0'.repeat(40);
  const workflows = readFixtureWorkflows(t, {
    'quoted.yml': `      - uses: "actions/checkout@${staleSha}" # v7.0.1\n`,
    'stale.yml': `      - uses: actions/checkout@${staleSha} # v7.0.1\n`,
  });

  assert.deepEqual(pinFaults(workflows), [
    `quoted.yml has a stale actions/checkout pin: ${staleSha} # v7.0.1`,
    `stale.yml has a stale actions/checkout pin: ${staleSha} # v7.0.1`,
  ]);
});

test('the pin check reports no fault for a workflow using neither protected action', (t) => {
  const workflows = readFixtureWorkflows(t, {
    'unrelated.yml': '      - uses: actions/cache@v4\n      - run: echo ok\n',
  });

  assert.deepEqual(workflows.map(({ file }) => file), ['unrelated.yml']);
  assert.deepEqual(pinFaults(workflows), []);
});
