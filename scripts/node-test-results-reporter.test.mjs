// ABOUTME: node:test suite for node-test-results-reporter.mjs — the `node` kind's execution evidence.
// ABOUTME: Includes a live `node --test` run, so the JSONL is proved against the real runner's events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createResultsRecorder, resultLine, RESULTS_PATH_ENV } from './node-test-results-reporter.mjs';
import { parseNodeResultsJsonl } from './test-execution-results.mjs';

// A file:// URL, not an OS path: node's ESM loader rejects a bare `C:\…` reporter specifier
// ("absolute paths must be valid file:// URLs"), and the Windows `Suites` leg is where
// this gate runs on Windows. A backslash form fails *silently* — the run still exits 0 and the
// reporter simply never loads — which is why this is pinned here rather than left to CI.
const REPORTER = new URL('./node-test-results-reporter.mjs', import.meta.url).href;

/**
 * The environment a real CI shell would give `node --test`. `NODE_TEST_CONTEXT` is set inside
 * every node:test file process, and inheriting it makes the child switch to node's internal
 * v8-serializer reporter and ignore `--test-reporter` entirely — silently, exit code 0.
 */
function runnerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('resultLine records a passing test as executed', () => {
  const line = resultLine({ type: 'test:pass', data: { name: 'does the thing', file: '/repo/scripts/a.test.mjs' } });
  assert.deepEqual(JSON.parse(line), { name: 'does the thing', status: 'pass', file: '/repo/scripts/a.test.mjs' });
});

test('resultLine records a failing test as executed — it ran, which is what the matrix gate asks', () => {
  assert.equal(JSON.parse(resultLine({ type: 'test:fail', data: { name: 'broke', file: 'x' } })).status, 'fail');
});

test('resultLine marks a skipped or todo test as skip, not pass', () => {
  // node:test reports a skipped test as `test:pass` with `skip` set. Recording it as a pass
  // would make `describe.skip` read as full coverage — the exact conflation this gate exists
  // to end.
  assert.equal(JSON.parse(resultLine({ type: 'test:pass', data: { name: 'a', skip: true } })).status, 'skip');
  assert.equal(JSON.parse(resultLine({ type: 'test:pass', data: { name: 'b', todo: true } })).status, 'skip');
});

test('resultLine ignores events that are not a finished test', () => {
  assert.equal(resultLine({ type: 'test:start', data: { name: 'x' } }), null);
  assert.equal(resultLine({ type: 'test:diagnostic', data: { message: 'x' } }), null);
  assert.equal(resultLine({ type: 'test:pass', data: {} }), null);
  assert.equal(resultLine(undefined), null);
});

test('the reporter appends real node --test results, suites included, and skips what was skipped', () => {
  // The production edge: the live runner's own event stream, not a hand-built one. A parser
  // that agreed with a fixture but not with node:test would pass every cell above and report
  // an empty suite in CI.
  const dir = mkdtempSync(join(tmpdir(), 'emend-results-reporter-'));
  const spec = join(dir, 'sample.test.mjs');
  writeFileSync(
    spec,
    [
      "import { test, describe } from 'node:test';",
      "describe('an outer suite', () => {",
      "  test('a case that runs', () => {});",
      "  test.skip('a case that is skipped', () => {});",
      '});',
      '',
    ].join('\n'),
  );
  const results = join(dir, 'node-sample.jsonl');

  const run = spawnSync(process.execPath, [
    '--test',
    '--test-reporter', REPORTER,
    '--test-reporter-destination', 'stdout',
    spec,
  ], { encoding: 'utf8', env: runnerEnv({ [RESULTS_PATH_ENV]: results }) });

  assert.equal(run.status, 0, run.stderr);
  const jsonl = readFileSync(results, 'utf8');
  const { executed } = parseNodeResultsJsonl(jsonl);
  assert.ok(executed.has('a case that runs'), [...executed].join(', '));
  assert.ok(executed.has('an outer suite'), 'a describe block is a matrix-nameable id');
  // The artifact records the skip rather than dropping it — "reported but skipped" and "never
  // appeared at all" are different facts, and the reader is what decides between them.
  assert.match(jsonl, /"name":"a case that is skipped","status":"skip"/);
  assert.ok(!executed.has('a case that is skipped'), 'a skipped case never counts as executed');

  rmSync(dir, { recursive: true, force: true });
});

test('two node --test invocations both land in one results file', () => {
  // A reporter that owned the destination file would keep only the last invocation's
  // evidence while the combined run itself was green.
  const dir = mkdtempSync(join(tmpdir(), 'emend-results-append-'));
  const results = join(dir, 'node-split.jsonl');
  const specs = ['first', 'second'].map((name, index) => {
    const path = join(dir, `part${index}.test.mjs`);
    writeFileSync(path, `import { test } from 'node:test';\ntest('${name} invocation ran', () => {});\n`);
    return path;
  });

  for (const spec of specs) {
    const run = spawnSync(process.execPath, [
      '--test',
      '--test-reporter', REPORTER,
      '--test-reporter-destination', 'stdout',
      spec,
    ], { encoding: 'utf8', env: runnerEnv({ [RESULTS_PATH_ENV]: results }) });
    assert.equal(run.status, 0, run.stderr);
  }

  const { executed } = parseNodeResultsJsonl(readFileSync(results, 'utf8'));
  assert.ok(executed.has('first invocation ran'));
  assert.ok(executed.has('second invocation ran'));
  rmSync(dir, { recursive: true, force: true });
});

test('with no results path configured the reporter writes nothing at all', () => {
  // The ordinary local `npm run test:scripts` loop carries this reporter and must stay a
  // no-op — otherwise every dev run would litter, or worse, half-write an artifact CI reads.
  const dir = mkdtempSync(join(tmpdir(), 'emend-results-off-'));
  const spec = join(dir, 'sample.test.mjs');
  writeFileSync(spec, "import { test } from 'node:test';\ntest('runs quietly', () => {});\n");
  const env = runnerEnv();
  delete env[RESULTS_PATH_ENV];

  const run = spawnSync(process.execPath, [
    '--test',
    '--test-reporter', REPORTER,
    '--test-reporter-destination', 'stdout',
    spec,
  ], { encoding: 'utf8', env });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', 'the reporter yields nothing, so its destination stream stays empty');
  assert.equal(existsSync(join(dir, 'node-sample.jsonl')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('createResultsRecorder writes nothing when the environment names no results file', () => {
  // The ordinary local tooling run takes this branch when no results path is configured.
  const writes = [];
  const recorder = createResultsRecorder({ env: {}, append: (...args) => writes.push(args) });
  assert.equal(recorder.collecting, false);
  recorder.record({ type: 'test:pass', data: { name: 'anything', file: 'x' } });
  assert.equal(recorder.flush(), 0);
  assert.deepEqual(writes, []);
});

test('createResultsRecorder appends one JSONL batch and keeps skip distinct from pass', () => {
  const writes = [];
  const recorder = createResultsRecorder({
    env: { [RESULTS_PATH_ENV]: '/results/node-x.jsonl' },
    append: (path, text) => writes.push({ path, text }),
  });
  assert.equal(recorder.collecting, true);
  recorder.record({ type: 'test:pass', data: { name: 'ran', file: 'a' } });
  recorder.record({ type: 'test:pass', data: { name: 'skipped', file: 'a', skip: true } });
  recorder.record({ type: 'test:start', data: { name: 'ignored' } });
  assert.equal(recorder.flush(), 2);
  assert.equal(writes.length, 1, 'one append per flush, not one per event');
  assert.equal(writes[0].path, '/results/node-x.jsonl');
  const lines = writes[0].text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => [l.name, l.status]), [['ran', 'pass'], ['skipped', 'skip']]);
});

test('createResultsRecorder flushes nothing a second time, so a shared file gains no duplicates', () => {
  const writes = [];
  const recorder = createResultsRecorder({
    env: { [RESULTS_PATH_ENV]: '/results/node-x.jsonl' },
    append: (path, text) => writes.push({ path, text }),
  });
  recorder.record({ type: 'test:pass', data: { name: 'ran once', file: 'a' } });
  assert.equal(recorder.flush(), 1);
  assert.equal(recorder.flush(), 0);
  assert.equal(writes.length, 1);
});
