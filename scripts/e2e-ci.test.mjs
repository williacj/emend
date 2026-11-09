// ABOUTME: Pins the live self-hosted Windows e2e acceptance gate selected by #1388/#1403.
// ABOUTME: Guards required-job execution, zero-retry failure visibility, billing safety, and quarantine tracking.
//
// #1388 selected the live Windows workflow; #1399 tracks test-plan §4's still-missing macOS lane.
// #1595 invalidated #1403's claimed clean sample and is repaired (PR #1602, merged 2026-08-16); that
// repair restarted the observation boundary, which closed within its one-day cutoff at 20/20
// qualifying PR-triggered runs, 20 overlaps (4 cross-run), and zero terminal or retry-masked
// failures (docs/proposals/windows-suite-classification.md §7.1). E now folds into this gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'windows-self-hosted.yml');
const PLAYWRIGHT_CONFIG_PATH = join(REPO_ROOT, 'playwright.config.mjs');
const SPEC_PATH = join(REPO_ROOT, 'e2e', 'acceptance.spec.mjs');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');
const require = createRequire(import.meta.url);
const PLAYWRIGHT_PACKAGE_PATH = require.resolve('playwright/package.json');
const { configLoader: { loadConfigFromFile } } = require(
  join(dirname(PLAYWRIGHT_PACKAGE_PATH), 'lib', 'common', 'index.js'),
);
/** How far above a `@quarantine` tag the explanatory comment block may start. */
const QUARANTINE_COMMENT_LINES = 12;

/**
 * Every `@quarantine` tag site in `spec` whose explanatory comment window (the
 * `commentWindow` lines immediately above the tag, inclusive) carries no `#<issue>` reference.
 * An empty result means every tag names its tracking issue — including, vacuously, when there
 * are no tags at all.
 *
 * Pure over the given spec text (rather than reading `SPEC_PATH` itself) so the scan can be
 * driven by fixtures in tests, not only by whatever the real file currently contains.
 */
function untrackedQuarantineTags(spec, { commentWindow = QUARANTINE_COMMENT_LINES } = {}) {
  const lines = spec.split('\n');
  const tagged = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('@quarantine'));

  return tagged.filter(({ index }) => {
    const context = lines.slice(Math.max(0, index - commentWindow), index + 1).join('\n');
    return !/#\d+/.test(context);
  });
}

/**
 * The required Windows job's own YAML block, sliced off at the next top-level job key.
 *
 * Asserts rather than returning undefined on purpose: most of the checks below are negative
 * (`doesNotMatch`), so a slice that silently stopped matching would let every one of them pass
 * vacuously — the guard would read green while guarding nothing.
 */
function e2eJob() {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const job = workflow.match(/\n  test-windows:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|$)/)?.[1];
  assert.ok(job, 'expected the required test-windows job in the live Windows workflow');
  return job;
}

test('the e2e gate uses the selected live self-hosted Windows venue (issue #1403)', () => {
  const job = e2eJob();

  assert.match(job, /runs-on:\s*\[self-hosted,\s*Windows,\s*cowrite-required\]/);
  assert.doesNotMatch(job, /(?:macos|ubuntu)-latest/);
  assert.match(job, /npm run test:e2e:ci/);
});

test('the e2e gate is failure-visible inside the one stable merge check (#1403)', () => {
  const job = e2eJob();
  const acceptance = job.match(/- name: Playwright acceptance suite\n([\s\S]*?)(?=\n\s+- name:|$)/)?.[0];
  assert.ok(acceptance, 'expected the Playwright acceptance step in the required job');

  assert.doesNotMatch(acceptance, /continue-on-error/);
  assert.doesNotMatch(acceptance, /\|\|\s*true/);
  assert.match(acceptance, /steps\.classifier\.outputs\.run_e2e\s*==\s*'true'/);
  assert.match(job, /name:\s*Suites \(Windows, self-hosted\)/);
  assert.doesNotMatch(job, /name:\s*E2E acceptance burn-in \(Windows, self-hosted\)/);
  assert.doesNotMatch(job, /\n    if:/);
});

test('the required e2e gate makes retry masking impossible (#1403/#1595)', () => {
  const job = e2eJob();
  const acceptance = job.match(/- name: Playwright acceptance suite\n([\s\S]*?)(?=\n\s+- name:|$)/)?.[0];
  assert.ok(acceptance, 'expected the Playwright acceptance step in the required job');

  // The shared config deliberately retries generic CI runs. The Windows PR check must override that
  // policy at its own command edge so a first-attempt acceptance failure makes this check red.
  const config = readFileSync(PLAYWRIGHT_CONFIG_PATH, 'utf8');
  assert.match(config, /retries:\s*process\.env\.CI\s*\?\s*[1-9]\d*\s*:\s*0/);
  // #1814 turned this step into a block scalar (it guards the results directory first), so the
  // anchor is the command LINE rather than the `run:` prefix. The pinned property is unchanged:
  // the required gate invokes exactly this command, with retries forced to zero.
  assert.match(acceptance, /^\s*npm run test:e2e:ci -- --retries=0\s*$/m);
});

test('the one-project D23 backend is never shared by concurrent Playwright workers (#1581)', async () => {
  const portEnvironment = [
    'EMEND_E2E_VITE_PORT',
    'EMEND_E2E_TEST_DRIVER_PORT',
    'EMEND_E2E_TEST_DRIVER_URL',
  ];
  const originalEnvironment = new Map(portEnvironment.map((name) => [name, process.env[name]]));
  process.env.EMEND_E2E_VITE_PORT = '45101';
  process.env.EMEND_E2E_TEST_DRIVER_PORT = '45102';

  let config;
  try {
    config = await loadConfigFromFile(PLAYWRIGHT_CONFIG_PATH, {
      argv: ['--workers=6'],
      workers: 6,
    });
  } finally {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  // The override must reach the global worker budget while the one-backend Chromium project keeps
  // its stricter cap. This is Playwright's resolved configuration, not source-text inspection.
  assert.equal(config.config.workers, 6, 'the test must apply the standard global CLI override');
  assert.equal(
    config.projects[0].workers,
    1,
    'the Chromium project must remain capped at one worker under the global CLI override',
  );
});

test('the e2e gate never arms the real-claude spawn escape hatch (issue #1149 stays fail-closed)', () => {
  const job = e2eJob();

  // #1149 fixed the driver binary spawning the real, billable `claude` CLI by refusing unless
  // EMEND_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN=1. Putting the e2e suite on CI is exactly the
  // change that would turn a regression here into recurring spend on every PR.
  assert.doesNotMatch(job, /EMEND_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN/);
});

test('the CI subset excludes exactly the quarantine tag (issue #1124 item 2)', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));

  // The blocking gate runs a *named subset*, so the exclusion has to live in one greppable place
  // rather than being spelled out in the workflow's shell line.
  assert.equal(pkg.scripts['test:e2e:ci'], 'playwright test --grep-invert @quarantine');
  // `test:e2e` stays the full suite — quarantined tests must still be runnable locally, or
  // "track the rest" degrades into "delete the rest".
  assert.equal(pkg.scripts['test:e2e'], 'playwright test');
});

// A silent quarantine is how a suite rots back into #1124's original state: each tag site must
// carry a `#<issue>` reference in the comment block immediately above it. The three cells below
// drive `untrackedQuarantineTags` directly over synthetic spec text, so the missing-issue
// rejection branch has committed coverage even while the real spec (checked separately, below)
// currently carries zero tags.

test('untrackedQuarantineTags rejects a @quarantine tag whose comment names no issue', () => {
  const spec = [
    '// no tracking issue named anywhere near this',
    'test.describe("x", { tag: "@quarantine" }, () => {});',
  ].join('\n');

  const offenders = untrackedQuarantineTags(spec);

  assert.equal(offenders.length, 1);
  assert.match(offenders[0].line, /@quarantine/);
});

test('untrackedQuarantineTags accepts a @quarantine tag whose comment names its issue', () => {
  const spec = [
    '// tracked by #1382',
    'test.describe("x", { tag: "@quarantine" }, () => {});',
  ].join('\n');

  assert.deepEqual(untrackedQuarantineTags(spec), []);
});

test('untrackedQuarantineTags passes vacuously with zero @quarantine tags', () => {
  const spec = 'test.describe("x", () => {});';

  assert.deepEqual(untrackedQuarantineTags(spec), []);
});

test('every quarantined e2e test names the issue tracking it (issue #1124 item 2)', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');
  const offenders = untrackedQuarantineTags(spec);

  assert.deepEqual(
    offenders.map(({ line, index }) => `line ${index + 1}: ${line.trim()}`),
    [],
    'every @quarantine tag in the real spec must name a tracking issue in the comment block above it',
  );
});
