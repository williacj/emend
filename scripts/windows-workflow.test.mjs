// ABOUTME: Tests for .github/workflows/windows-self-hosted.yml (issue #342) — pins the shape the
// ABOUTME: linked runbook promises: every-PR triggers, the self-hosted Windows target,
// ABOUTME: a bounded job timeout, the same suites CLAUDE.md requires, and the base-bound merge check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPackageScripts } from './package-scripts.mjs';
import {
  ALL_SUITES,
  classifyChangedPaths,
  renderClassificationSummary,
} from './windows-ci-classifier.mjs';
import { assertStepsRequireOutcome, namedStep } from './workflow-step-assertions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/windows-self-hosted.yml');
const RUNBOOK_PATH = join(REPO_ROOT, 'docs/ci-windows-runner.md');
const DEAD_FOCUSED_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/windows-e2e-focused-repeat.yml');
const INACTIVE_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');
const TOOLCHAIN_PATH = join(REPO_ROOT, 'rust-toolchain.toml');

function readWorkflow() {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

test('targets a self-hosted Windows runner — not a hosted windows-latest one', () => {
  const targets = readWorkflow()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('runs-on:'));

  assert.deepEqual(targets, [
    'runs-on: [self-hosted, Windows, cowrite-required]',
    'runs-on: [self-hosted, Windows, cowrite-required]',
    'runs-on: [self-hosted, Windows, cowrite-required]',
  ]);
});

test('the runner runbook makes qualification repeatable and admission reversible (#1935)', () => {
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

  assert.match(
    runbook,
    /three[^\n]*parallelism=one[^\n]*three[^\n]*parallelism=two[\s\S]*1\.5[×x]/i,
  );
  assert.match(
    runbook,
    /remove eligibility without deleting or unregistering a runner[\s\S]*actions\/runners\/\$runnerId\/labels\/cowrite-required/i,
  );
});

test('the runner runbook excludes non-discriminating pressure counters from admission (#1935)', () => {
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

  assert.match(
    runbook,
    /Admission is decided from those job-API[\s\S]*correctness guards[\s\S]*all-zero[\s\S]*non-discriminating[\s\S]*do not establish CPU\/disk saturation or headroom[\s\S]*excluded from the admission decision/i,
  );
});

test('the runner runbook rejects the obsolete all-registered-runners production route (#1935)', () => {
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

  assert.doesNotMatch(
    runbook,
    /Production `runs-on` stays `\[self-hosted, Windows\]` regardless[\s\S]*all\s+four runners/i,
  );
});

test('run steps use inbox Windows PowerShell with a process-scoped execution-policy bypass', () => {
  const yaml = readWorkflow();
  assert.match(
    yaml,
    /defaults:\s*\n\s+run:\s*\n\s+shell:\s*powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\. '\{0\}'"/
  );
});

test('triggers on every pull_request so every merge has the required check context', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /on:[\s\S]*pull_request:/);
  const trigger = yaml.slice(yaml.indexOf('  pull_request:'), yaml.indexOf('  workflow_dispatch:'));
  assert.doesNotMatch(trigger, /\n\s+paths:/);
});

test('also supports an on-demand run via workflow_dispatch', () => {
  assert.match(readWorkflow(), /workflow_dispatch:/);
});

test('manual dispatch runs the real project-files scan benchmark on the exact selected revision', () => {
  const yaml = readWorkflow();
  const checkout = yaml.match(/- uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(checkout, 'expected the operator workflow to check out a selected revision');
  assert.match(checkout[0], /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha \|\| github\.sha\s*\}\}/);

  const benchmark = namedStep(yaml, 'Project files scanner benchmark');
  assert.ok(benchmark, 'expected a manual project-files benchmark step');
  assert.match(benchmark[0], /github\.event_name == 'workflow_dispatch'/);
  assert.match(benchmark[0], /steps\.sccache\.outcome == 'success'/);
  assert.match(benchmark[0], /Write-Output "revision=\$\(git rev-parse HEAD\)"/);
  assert.match(
    benchmark[0],
    /Write-Output "runner=\$env:RUNNER_NAME os=\$env:RUNNER_OS arch=\$env:RUNNER_ARCH"/,
  );
  assert.match(
    benchmark[0],
    /\$processor = Get-CimInstance Win32_Processor \| Select-Object -First 1/,
  );
  assert.match(
    benchmark[0],
    /Write-Output "processor=\$\(\$processor\.Name\) logical_processors=\$\(\$processor\.NumberOfLogicalProcessors\)"/,
  );
  assert.match(
    benchmark[0],
    /\$workspaceDrive = \(Get-Item -LiteralPath \$env:GITHUB_WORKSPACE\)\.PSDrive/,
  );
  assert.match(
    benchmark[0],
    /\$workspaceVolume = Get-Volume -DriveLetter \$workspaceDrive\.Name/,
  );
  assert.match(
    benchmark[0],
    /Write-Output "workspace_drive=\$\(\$workspaceDrive\.Name\) filesystem=\$\(\$workspaceVolume\.FileSystem\) drive_type=\$\(\$workspaceVolume\.DriveType\)"/,
  );
  assert.match(
    benchmark[0],
    /cargo bench --manifest-path src-tauri\/Cargo\.toml --bench project_files_scan/,
  );
});

test('the Windows job retains the evidenced twenty-five-minute execution budget', () => {
  assert.match(readWorkflow(), /timeout-minutes:\s*25(?:\s|$)/);
});

test('runs one daily scheduled full-suite classifier backstop (#984/#985)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /schedule:\s*\n\s+- cron:\s*["']17 8 \* \* \*["']/);
});

test('grants the workflow APIs only read access while preserving checkout access (#976/#980)', () => {
  const yaml = readWorkflow();
  const permissions = yaml.match(/permissions:\s*\n([\s\S]*?)(?=\n\S|$)/);
  assert.ok(permissions, 'expected explicit workflow permissions');
  assert.match(permissions[0], /actions:\s*read/);
  assert.match(permissions[0], /contents:\s*read/);
  assert.match(permissions[0], /pull-requests:\s*read/);
  assert.doesNotMatch(permissions[0], /:\s*write/);
});

test('allows independent refs to use the two verified work roots concurrently (#982)', () => {
  const yaml = readWorkflow();
  // Kept independent of #1340: retiring that decision guard must not retire #982's concurrency pin.
  assert.doesNotMatch(yaml, /^\s*concurrency:/m);
  assert.doesNotMatch(yaml, /windows-self-hosted-runner-workspace/);
  assert.match(yaml, /#981 isolation canaries and six-run contention cohort/);
  assert.match(yaml, /Obsolete queued PR revisions still fail closed/);
});

test('records staying ungrouped as a decision, not a measurement hold (#1347)', () => {
  const yaml = readWorkflow();
  assert.doesNotMatch(yaml, /^\s*concurrency:/m);
  // #982 removed this workflow's group outright, so the decision is that it stays ungrouped — not that
  // some surviving group "stands". Each clause below is pinned because deleting any one of them turns
  // the record back into an unexplained absence, which is what #1340's parked state already was.
  assert.match(yaml, /#1347 \(CJ, 2026-08-10\): this workflow stays UNGROUPED/);
  assert.match(yaml, /no PR-keyed group is added on top of it/);
  assert.match(yaml, /workload-policy decision, not a safety hold/);
  assert.match(yaml, /Reopen only if Windows CI queue time is OBSERVED to block cards/);
  // Narrow by design: this rejects the superseded sentence verbatim, not hold language in general.
  // The positive clauses above are what a synonym cannot satisfy.
  assert.doesNotMatch(yaml, /unratified until/);
});

test('the job timeout is bounded — not left at the platform default', () => {
  const m = readWorkflow().match(/timeout-minutes:\s*([^\n]+)/);
  assert.ok(m, 'expected a timeout-minutes on the job');
  const minutes = [...m[1].matchAll(/\d+/g)].map((match) => Number(match[0]));
  assert.ok(minutes.length > 0, 'expected numeric timeout bounds');
  assert.ok(
    minutes.every((value) => value > 0 && value <= 120),
    `expected sane bounds, got ${minutes.join(', ')}`,
  );
});

test('normal Windows execution uses the evidenced twenty-five-minute budget', () => {
  assert.match(readWorkflow(), /timeout-minutes:\s*25(?:\s|$)/);
});

test('runs cargo and tooling suites', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /cargo test --manifest-path src-tauri\/Cargo\.toml --workspace/);
  assert.match(yaml, /npm run test:scripts/);
});

test('pins one Rust toolchain with rustfmt and clippy, then enforces both checks', () => {
  const yaml = readWorkflow();
  const inactiveYaml = readFileSync(INACTIVE_WORKFLOW_PATH, 'utf8');
  const toolchain = readFileSync(TOOLCHAIN_PATH, 'utf8');
  const pinnedChannel = toolchain.match(/channel\s*=\s*"([^"]+)"/)?.[1];

  assert.equal(pinnedChannel, '1.97.0');
  assert.match(toolchain, /components\s*=\s*\[[^\]]*"rustfmt"[^\]]*"clippy"[^\]]*\]/);
  assert.match(yaml, new RegExp(`toolchain:\\s*${pinnedChannel.replaceAll('.', '\\.')}`));
  assert.match(yaml, /components:\s*rustfmt,\s*clippy/);
  for (const workflow of [yaml, inactiveYaml]) {
    assert.match(workflow, /cargo fmt --manifest-path src-tauri\/Cargo\.toml --all -- --check/);
  }
  assert.match(
    yaml,
    /cargo clippy --manifest-path src-tauri\/Cargo\.toml --workspace --all-targets -- -D warnings/
  );
});

function cachePreflightStep(yaml) {
  return yaml.match(/- name: Verify Rust compiler cache\n([\s\S]*?)(?=\n\s+- name:|$)/);
}

test('requires the persistent runner sccache and reports compiler-cache evidence (#978)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /env:\s*\n\s+RUSTC_WRAPPER:\s*sccache/);
  const start = cachePreflightStep(yaml);
  assert.ok(start, 'expected a cache preflight step');
  assert.match(start[0], /steps\.freshness\.outputs\.run_expensive != 'false'/);
  assert.match(start[0], /sccache --version/);
  const report = yaml.match(/- name: Report Rust compiler cache\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(report, 'expected a cache-statistics step');
  // always() so a failed suite still reports; the Rust-or-E clause is pinned separately below.
  assert.match(report[0], /if:\s*\$\{\{\s*always\(\)\s*&&\s*steps\.freshness\.outputs\.run_expensive != 'false'/);
  assert.match(report[0], /continue-on-error:\s*true/);
  assert.match(report[0], /sccache --show-stats/);
});

// The daemon is per-user, so both runner services share one server. Zeroing it wipes the counters
// a concurrent job is accumulating on the same daemon.
test('never zeroes the shared sccache daemon a concurrent job is using (#1178)', () => {
  // Comments are allowed to name the flag; what must not exist is a step that runs it.
  const executable = readWorkflow()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(executable, /--zero-stats/);
});

// A job must never own the daemon: it is reaped when that job completes, killing the concurrent
// job's compile mid-flight. The preflight is the job's first sccache touch, so an absent server
// proves the host Task Scheduler task that owns it is down.
test('fails visibly when no externally owned sccache server is running (#1178)', () => {
  const start = cachePreflightStep(readWorkflow());
  assert.ok(start, 'expected a cache preflight step');
  assert.match(start[0], /Get-Process sccache/);
  assert.match(start[0], /throw /);
  // The acceptance test is "same pid across two overlapping jobs" — it has to be readable from the log.
  assert.match(start[0], /\$server\.Id/);
  assert.match(start[0], /sccache-baseline\.txt/);
});

// The daemon now outlives every job, so its raw counters are cumulative rather than per-run.
test('reports per-run cache deltas, not the shared daemon lifetime totals (#1178)', () => {
  const report = readWorkflow().match(/- name: Report Rust compiler cache\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(report, 'expected a cache-statistics step');
  assert.match(report[0], /sccache-baseline\.txt/);
  // windows-ci-soak-report.mjs takes the LAST match per counter, so the delta block must be printed
  // after the raw stats. The header text is shared with its parseCacheStats delta test fixture.
  const rawAt = report[0].indexOf('sccache --show-stats');
  const deltaAt = report[0].indexOf('This run (delta against the step-start baseline):');
  assert.ok(rawAt !== -1, 'expected the raw stats to still be printed');
  assert.ok(deltaAt > rawAt, 'the per-run delta block must be printed after the raw stats');
});

function namedJob(yaml, name) {
  return yaml.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`));
}

// escapeRegExp/namedStep/assertStepsRequireOutcome moved to ./workflow-step-assertions.mjs (#2293) so
// this file's proven anchored-if: idiom (#2295 review finding 2) is reused, not re-derived, by the
// contention-benchmark workflow's own test file.

// Reproduces the reviewer's exact near-miss (#2295 review finding 2) against a synthetic fixture,
// not the real committed workflow: a step whose `if:` does NOT carry the target literal, immediately
// followed by a comment block that DOES carry it, immediately followed by the next `- name:`. Under the
// old whole-block match this passed silently (the comment satisfied the assertion instead of the real
// gate); it must fail loudly instead. This test fails under the pre-fix (unanchored) implementation and
// passes once the match is anchored to the step's own `if:` line — that is the proof the fix actually
// closes the gap rather than merely moving it.
const NEAR_MISS_FIXTURE_YAML = `      - name: Rust clippy
        if: \${{ !cancelled() && steps.freshness.outputs.run_expensive != 'false' }}
        run: cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings

      # Near-miss regression fixture only (#2295 review finding 2): this comment names
      # steps.rust.outcome == 'success' but the real gate above does not carry it — this text
      # logically belongs to the NEXT step and must not satisfy an assertion about THIS one.
      - name: Cargo test
        if: \${{ !cancelled() }}
        run: cargo test --manifest-path src-tauri/Cargo.toml --workspace
`;

test('assertStepsRequireOutcome rejects a literal that only appears in a trailing comment, not the step\'s own if: line (#2295 review finding 2)', () => {
  assert.throws(
    () => assertStepsRequireOutcome(
      NEAR_MISS_FIXTURE_YAML,
      ['Rust clippy'],
      "steps.rust.outcome == 'success'",
      'must not run after a failed toolchain pin',
    ),
    /must not run after a failed toolchain pin/,
  );
});

test('the focused repeat is a mode of the registered Windows workflow, never a dead standalone dispatch (#1595)', () => {
  const yaml = readWorkflow();
  const dispatch = yaml.slice(
    yaml.indexOf('  workflow_dispatch:'),
    yaml.indexOf('  # Ratified in #984'),
  );

  assert.equal(existsSync(DEAD_FOCUSED_WORKFLOW_PATH), false);
  assert.match(dispatch, /windows_mode:\s*[\s\S]*?type:\s*choice/);
  assert.match(dispatch, /default:\s*suites/);
  assert.match(dispatch, /options:\s*\n\s+- suites\s*\n\s+- focused-e2e-repeat/);
  for (const input of ['target_sha', 'iterations', 'test_grep']) {
    assert.match(dispatch, new RegExp(`\\n\\s+${input}:`), `expected dispatch input ${input}`);
  }
});

test('focused dispatch cannot replace or duplicate the normal required job (#1595/#1403)', () => {
  const yaml = readWorkflow();
  const normalMode = /if:\s*\$\{\{\s*github\.event_name != 'workflow_dispatch' \|\| \(inputs\.windows_mode != 'focused-e2e-repeat' && inputs\.windows_mode != 'unsigned-nsis'\)\s*\}\}/;
  const required = namedJob(yaml, 'test-windows');
  const focused = namedJob(yaml, 'e2e-focused-repeat');

  assert.ok(required, 'expected the stable required job');
  assert.ok(focused, 'expected the operator-only focused-repeat job');
  assert.match(required[0], normalMode);
  assert.match(focused[0], /if:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.windows_mode == 'focused-e2e-repeat'\s*\}\}/);
  assert.match(required[0], /name:\s*Suites \(Windows, self-hosted\)/);
  assert.doesNotMatch(focused[0], /name:\s*Suites \(Windows, self-hosted\)/);
});

test('registered focused dispatch validates an immutable target and runs every iteration with zero retries (#1595)', () => {
  const focused = namedJob(readWorkflow(), 'e2e-focused-repeat');
  assert.ok(focused, 'expected the operator-only focused-repeat job');

  assert.match(focused[0], /name:\s*E2E focused repeat \(Windows, self-hosted\)/);
  assert.match(focused[0], /EMEND_TARGET_SHA:\s*\$\{\{\s*inputs\.target_sha\s*\}\}/);
  assert.match(focused[0], /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(focused[0], /\^\(\[1-9\]\|1\[0-9\]\|2\[0-5\]\)\$/);
  assert.match(focused[0], /ref:\s*\$\{\{\s*inputs\.target_sha\s*\}\}/);
  assert.match(focused[0], /for \(\$i = 1; \$i -le \$iterations; \$i\+\+\)/);
  assert.match(focused[0], /npx playwright test --retries=0 --reporter=list --grep/);
  assert.match(focused[0], /if \(\$status -ne 0\) \{ \$failed \+= \$i \}/);
  assert.match(focused[0], /if \(\$failed\.Count -gt 0\)/);
  assert.match(focused[0], /name:\s*playwright-report-focused-repeat/);
  assert.doesNotMatch(focused[0], /EMEND_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN/);
});

// Detecting the outage is not preventing it. `!cancelled()` stays true after a failed step, so
// without this gate the job throws and then compiles anyway under RUSTC_WRAPPER=sccache — starting
// exactly the job-owned daemon the preflight forbids, which the runner reaps at job end and which
// kills whatever peer job is compiling. Observed live in job 92443930095: the preflight failed at
// 21:01:04, clippy and cargo test then succeeded, and the report step read 873 compile requests off
// a daemon the host task had not yet started.
test('a failed cache preflight blocks every Rust step, not just the job result (#1178)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /- name: Verify Rust compiler cache\n\s+id: sccache\n/);
  assertStepsRequireOutcome(
    yaml,
    ['Rust fmt check', 'Rust clippy', 'Cargo test'],
    "steps.sccache.outcome == 'success'",
    'must not run after a failed cache preflight',
  );
});

// Detecting a failed toolchain pin is not preventing it from being used anyway. `!cancelled()` stays
// true after `Install Rust` fails, so without this gate every step below that actually invokes the
// pinned rustc/cargo ran anyway, against whatever toolchain happened to already be on the runner
// instead of the pinned 1.97.0 — and reported `success` doing it. Observed live in run 33817279014:
// `Install Rust` failed on a transient DNS error resolving static.rust-lang.org, and Rust fmt check,
// Rust clippy, and Cargo test then all reported success. `steps.sccache.outcome` alone cannot catch
// this: the cache-verification step never invokes rustc/cargo, so it reports `success` regardless of
// whether the toolchain pin itself succeeded (#2275).
test('a failed toolchain pin blocks every step that invokes rustc/cargo, not just the job result (#2275)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /- name: Install Rust\n\s+id: rust\n/);
  assertStepsRequireOutcome(
    yaml,
    [
      'Rust fmt check',
      'Rust clippy',
      'Cargo test',
      'Project files scanner benchmark',
      'Pre-build the headless test driver',
    ],
    "steps.rust.outcome == 'success'",
    'must not run after a failed toolchain pin',
  );
});

// The identical #2275 shape, one toolchain earlier: `Classify applicable suites` invokes the pinned
// Node 20 directly (`node scripts/windows-ci-classifier.mjs`) under `!cancelled()`, so without this
// gate a failed `Setup Node.js` would let it run anyway, against whatever node happened to already be
// on the runner, and report `success` doing it. This test proves only the classifier's OWN direct
// gate; it does not, on its own, prove anything about steps further downstream (see the next test).
test('a failed Node setup blocks the classifier itself, not just the job result (#2295)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /- name: Setup Node\.js\n\s+id: node\n/);
  assertStepsRequireOutcome(
    yaml,
    ['Classify applicable suites'],
    "steps.node.outcome == 'success'",
    'must not run after a failed Node setup',
  );
});

// Each Node-invoking suite step proves setup succeeded directly. The execution-evidence
// validation uses `success()` and the timing summary is diagnostic only.
test('Node-invoking suite steps require the Node toolchain pin directly (#2295)', () => {
  const yaml = readWorkflow();
  assertStepsRequireOutcome(
    yaml,
    [
      'Install dependencies',
      'tooling self-test',
      'Validate docs/test-matrix.md',
      'Validate vitest unhandled-errors invariant (test-plan §9b)',
      'vitest',
      'Install Playwright Chromium',
      'Playwright acceptance suite',
    ],
    "steps.node.outcome == 'success'",
    'must not run after a failed Node setup',
  );
});

// A docs-only PR compiles nothing, so a daemon outage must not red-gate it (job 92458818324 skipped
// every Rust step but still ran the cache step). The E suite also compiles the headless driver, which
// needs the toolchain installed in the first place.
//
// This must be OR, not AND: an E-only PR (classifier rule 7 — src/**, tests/**, e2e/**, index.html,
// public/** with no src-tauri/**, so run_rust stays 'false') still needs the toolchain and the cache
// step to run, or `steps.sccache.outcome` is never set to 'success', which skips the driver build and
// then the `Playwright acceptance suite` step — every step reports success/skipped, and the required
// check goes green having executed zero acceptance tests. Asserting only that both output names
// appear (rather than the exact `(A == 'true' || B == 'true')` expression) cannot tell that OR from
// AND: verified by mutating this same `||` to `&&` at this file's head and confirming `npm run
// test:scripts` still passed before this assertion existed.
test('Install Rust and the cache steps run when Rust OR E compiles, not only when both do (#1178/#1403)', () => {
  const yaml = readWorkflow();
  for (const name of ['Install Rust', 'Verify Rust compiler cache', 'Report Rust compiler cache']) {
    const step = namedStep(yaml, name);
    assert.ok(step, `expected a ${name} step`);
    assert.match(
      step[0],
      /\(steps\.classifier\.outputs\.run_rust == 'true' \|\| steps\.classifier\.outputs\.run_e2e == 'true'\)/,
      `${name} must gate on run_rust OR run_e2e, not AND — an E-only PR must still run this step`
    );
  }
});

// Lower-consequence than the OR/AND gap above (dropping these fails the job red, not green) but the
// same unpinned-structure class: the acceptance step must not run past a failed prerequisite.
test('the acceptance step requires every one of its three prerequisites to have succeeded (#1178/#1403)', () => {
  const yaml = readWorkflow();
  const step = namedStep(yaml, 'Playwright acceptance suite');
  assert.ok(step, 'expected a Playwright acceptance suite step');
  for (const prerequisite of ['sccache', 'playwright', 'e2e-driver']) {
    assert.match(
      step[0],
      new RegExp(`steps\\.${prerequisite}\\.outcome == 'success'`),
      `the acceptance step must require steps.${prerequisite}.outcome == 'success'`
    );
  }
});

test('dispatch diagnostics exercise the sccache failure-report branches without stopping, restarting, or zeroing the host daemon (#1185)', () => {
  const yaml = readWorkflow();
  const dispatch = yaml.slice(yaml.indexOf('  workflow_dispatch:'), yaml.indexOf('  # Ratified in #984'));
  assert.match(
    dispatch,
    /sccache_diagnostic:\s*\n[\s\S]*?default:\s*none\s*\n\s+type:\s*choice\s*\n\s+options:\s*\n\s+- none\s*\n\s+- preflight-failure\s*\n\s+- report-no-server\s*\n\s+- report-replaced\s*\n\s+- boot-trigger/,
  );

  const preflight = namedStep(yaml, 'Verify Rust compiler cache');
  assert.ok(preflight, 'expected a cache preflight step');
  const forcedFailureAt = preflight[0].indexOf("-eq 'preflight-failure'");
  const firstSccacheTouchAt = preflight[0].indexOf('sccache --version');
  assert.ok(forcedFailureAt !== -1, 'expected the diagnostic preflight failure');
  assert.ok(
    firstSccacheTouchAt > forcedFailureAt,
    'the forced failure must execute before the first sccache touch',
  );
  assert.match(
    preflight[0],
    /-eq 'boot-trigger'[\s\S]*?Get-CimInstance Win32_OperatingSystem[\s\S]*?Get-ScheduledTask -TaskName 'sccache-server'[\s\S]*?Get-WinEvent -FilterHashtable/,
  );
  assert.match(preflight[0], /LogName = 'Microsoft-Windows-TaskScheduler\/Operational'/);
  assert.match(preflight[0], /Id = 118/);
  assert.match(
    preflight[0],
    /Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler\/Operational'[\s\S]*?-not \$taskHistory\.IsEnabled/,
  );
  assert.match(preflight[0], /\[xml\]\$_\.ToXml\(\)[\s\S]*?\.Name -eq 'TaskName'/);
  assert.match(preflight[0], /boot_triggered=\$\(\$bootEvent\.TimeCreated\.ToString\('o'\)\)/);
  assert.doesNotMatch(preflight[0], /Get-ScheduledTaskInfo|LastRunTime/);
  assert.match(preflight[0], /@\(\$task\.Triggers\)\.Count -ne 1 -or \$bootTriggers\.Count -ne 1/);
  assert.match(preflight[0], /\$bootToTriggerSeconds -lt 0 -or \$bootToTriggerSeconds -gt 300/);
  assert.match(preflight[0], /\$triggerToServerSeconds -gt 10/);

  const report = namedStep(yaml, 'Report Rust compiler cache');
  assert.ok(report, 'expected a cache-statistics step');
  assert.match(report[0], /-eq 'report-no-server'[\s\S]*?\$server = \$null/);
  assert.match(report[0], /-eq 'report-replaced'[\s\S]*?\$before\[\$name\] = \$after\[\$name\] \+ 1/);
  assert.doesNotMatch(preflight[0] + report[0], /sccache --(?:start-server|stop-server|zero-stats)/);
});

test('sccache diagnostics are dispatch-only and always reject themselves as merge evidence (#1185)', () => {
  const yaml = readWorkflow();
  assert.match(
    yaml,
    /EMEND_SCCACHE_DIAGNOSTIC:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.sccache_diagnostic \|\| 'none'\s*\}\}/,
  );

  const reject = namedStep(yaml, 'Reject sccache diagnostic as merge evidence');
  assert.ok(reject, 'expected a terminal diagnostic rejection step');
  assert.match(reject[0], /if:\s*\$\{\{\s*always\(\) && env\.EMEND_SCCACHE_DIAGNOSTIC != 'none'\s*\}\}/);
  assert.match(reject[0], /throw\s+"Sccache diagnostic runs cannot satisfy the Windows PR check/);

  for (const name of [
    'Install dependencies',
    'tooling self-test',
    'Validate docs/test-matrix.md',
    'vitest',
  ]) {
    const step = namedStep(yaml, name);
    assert.ok(step, `expected a ${name} step`);
    assert.doesNotMatch(
      step[0],
      /EMEND_SCCACHE_DIAGNOSTIC/,
      `${name} must preserve the ratified full workflow_dispatch suite`,
    );
  }
});

test('keeps Node 20 but does not restore a remote npm cache on the persistent runner (#977)', () => {
  const yaml = readWorkflow();
  const step = yaml.match(/- name: Setup Node\.js\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(step, 'expected a Setup Node.js step');
  assert.match(step[0], /actions\/setup-node@/);
  assert.match(step[0], /node-version:\s*["']20["']/);
  assert.doesNotMatch(step[0], /(?:^|\n)\s*cache:/);
  assert.match(step[0], /package-manager-cache:\s*false/);
  assert.match(yaml, /- name: Install dependencies[\s\S]*?run:\s*npm ci/);
});

test('checks out the exact event head with complete ancestry for immutable classifier input (#985 live control)', () => {
  const yaml = readWorkflow();
  const checkout = yaml.match(/- uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(checkout, 'expected the checkout step');
  assert.match(checkout[0], /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha \|\| github\.sha\s*\}\}/);
  assert.match(checkout[0], /fetch-depth:\s*0/);
});

test('validates the FR-traceability matrix in the live workflow', () => {
  assert.match(
    readWorkflow(),
    /- name: Validate docs\/test-matrix\.md\s*\n(?:\s+if:[^\n]+\n)?\s+run: npm run matrix:check/
  );
});

test('runs the vitest unhandled-errors invariant gate on this workflow and on ci.yml (test-plan §9b, #2103)', () => {
  const gateStep = /- name: Validate vitest unhandled-errors invariant.*\n(?:\s+if:[^\n]+\n)?\s+run: npm run check:vitest-unhandled-errors/;
  assert.match(readWorkflow(), gateStep);
  assert.match(readFileSync(INACTIVE_WORKFLOW_PATH, 'utf8'), gateStep);
});


test('publishes one stable Windows check name', () => {
  const yaml = readWorkflow();
  assert.match(
    yaml,
    /name:\s*Suites \(Windows, self-hosted\)/,
  );
});

test('publishes a non-gating timing summary even when an earlier suite fails (#976)', () => {
  const yaml = readWorkflow();
  const step = yaml.match(/- name: Publish timing summary\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(step, 'expected a terminal Publish timing summary step');
  assert.match(step[0], /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(step[0], /continue-on-error:\s*true/);
  assert.match(step[0], /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(step[0], /node scripts\/windows-ci-timing\.mjs publish/);
});

test('checks live PR-head freshness and gates every expensive Windows step fail-closed (#980)', () => {
  const yaml = readWorkflow();
  const freshness = yaml.match(/- name: Check revision freshness\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(freshness, 'expected a revision-freshness step');
  assert.match(freshness[0], /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(freshness[0], /EMEND_PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
  assert.match(freshness[0], /EMEND_EVENT_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(freshness[0], /node scripts\/windows-ci-freshness\.mjs/);

  for (const name of [
    'Install Rust',
    'Rust fmt check',
    'Rust clippy',
    'Cargo test',
    'Install dependencies',
    'tooling self-test',
    'Validate docs/test-matrix.md',
    'vitest',
    'Install Playwright Chromium',
    'Pre-build the headless test driver',
    'Playwright acceptance suite',
  ]) {
    const step = yaml.match(new RegExp(`- name: ${name.replaceAll('.', '\\.')}\\n([\\s\\S]*?)(?=\\n\\s+- name:|$)`));
    assert.ok(step, `expected a ${name} step`);
    assert.match(step[0], /steps\.freshness\.outputs\.run_expensive\s*!=\s*'false'/, `${name} must skip only known-stale revisions`);
  }
});

test('classifies suites inside the stable job and gates each suite unit independently (#985)', () => {
  const yaml = readWorkflow();
  const classifier = yaml.match(/- name: Classify applicable suites\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(classifier, 'expected a classifier step inside the one required job');
  assert.match(classifier[0], /id:\s*classifier/);
  assert.match(classifier[0], /steps\.freshness\.outputs\.run_expensive\s*!=\s*'false'/);
  assert.match(classifier[0], /EMEND_EVENT_BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha \|\| github\.sha\s*\}\}/);
  assert.match(classifier[0], /EMEND_EVENT_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha \|\| github\.sha\s*\}\}/);
  assert.match(classifier[0], /node scripts\/windows-ci-classifier\.mjs/);
  assert.doesNotMatch(classifier[0], /continue-on-error:\s*true/);

  const expected = new Map([
    ['Install Rust', 'run_rust'],
    ['Rust fmt check', 'run_rust'],
    ['Rust clippy', 'run_rust'],
    ['Cargo test', 'run_rust'],
    ['Install dependencies', 'run_node'],
    ['tooling self-test', 'run_tooling'],
    ['Validate docs/test-matrix.md', 'run_tooling'],
    ['vitest', 'run_frontend'],
    ['Install Playwright Chromium', 'run_e2e'],
    ['Pre-build the headless test driver', 'run_e2e'],
    ['Playwright acceptance suite', 'run_e2e'],
  ]);
  for (const [name, output] of expected) {
    const step = yaml.match(new RegExp(`- name: ${name.replaceAll('.', '\\.')}\\n([\\s\\S]*?)(?=\\n\\s+- name:|$)`));
    assert.ok(step, `expected a ${name} step`);
    assert.match(step[0], new RegExp(`steps\\.classifier\\.outputs\\.${output}\\s*==\\s*'true'`));
  }
});

test('the workflow-owned full-suite classifier exposes four required-job suite flags (#1402/#1403)', () => {
  const classification = classifyChangedPaths(['.github/workflows/windows-self-hosted.yml']);
  assert.deepEqual(ALL_SUITES, ['R', 'T', 'F', 'E']);
  assert.deepEqual(classification.suites, { R: true, T: true, F: true, E: true });
  assert.match(
    renderClassificationSummary(classification),
    /\| E \| E2E acceptance \| selected \|/
  );

  const requiredJob = namedJob(readWorkflow(), 'test-windows');
  assert.ok(requiredJob, 'expected the stable required job');
  assert.match(requiredJob[0], /steps\.classifier\.outputs\.run_e2e/);
});

test('folds E into the one stable required Windows job after burn-in (#1403)', () => {
  const yaml = readWorkflow();
  const requiredJob = namedJob(yaml, 'test-windows');
  assert.ok(requiredJob, 'expected the stable required job');
  assert.match(requiredJob[0], /name:\s*Suites \(Windows, self-hosted\)/);
  assert.equal((yaml.match(/^    name:\s*Suites \(Windows, self-hosted\)$/gm) ?? []).length, 1);
  assert.equal(namedJob(yaml, 'e2e-windows-burn-in'), null);
  assert.doesNotMatch(yaml, /E2E acceptance burn-in \(Windows, self-hosted\)/);

  for (const name of [
    'Install Playwright Chromium',
    'Pre-build the headless test driver',
    'Playwright acceptance suite',
  ]) {
    const step = namedStep(requiredJob[0], name);
    assert.ok(step, `expected a ${name} required-job step`);
    assert.match(step[0], /steps\.classifier\.outputs\.run_e2e\s*==\s*'true'/);
  }

  const installRust = namedStep(requiredJob[0], 'Install Rust');
  assert.match(installRust[0], /steps\.classifier\.outputs\.run_e2e\s*==\s*'true'/);
  const sccache = namedStep(requiredJob[0], 'Verify Rust compiler cache');
  assert.match(sccache[0], /steps\.classifier\.outputs\.run_e2e\s*==\s*'true'/);
  const installDependencies = namedStep(requiredJob[0], 'Install dependencies');
  assert.match(installDependencies[0], /steps\.classifier\.outputs\.run_node\s*==\s*'true'/);
  const installBrowser = namedStep(requiredJob[0], 'Install Playwright Chromium');
  assert.match(installBrowser[0], /npx playwright install chromium/);
  const prebuild = namedStep(requiredJob[0], 'Pre-build the headless test driver');
  assert.match(prebuild[0], /cargo build --manifest-path src-tauri\/Cargo\.toml -p test-driver/);
  assert.match(prebuild[0], /steps\.sccache\.outcome == 'success'/);
  const acceptance = namedStep(requiredJob[0], 'Playwright acceptance suite');
  // Block scalar since #1814; the pinned property is the command and its zero retries, not the
  // YAML shape that carries them.
  assert.match(acceptance[0], /^\s*npm run test:e2e:ci -- --retries=0\s*$/m);
  const report = namedStep(requiredJob[0], 'Upload Playwright report');
  assert.ok(report, 'expected the failure-artifact step inside the required job');
  assert.match(report[0], /if:\s*\$\{\{\s*failure\(\)[^}]*steps\.classifier\.outputs\.run_e2e\s*==\s*'true'/);
  assert.match(report[0], /playwright-report-windows/);
  assert.doesNotMatch(requiredJob[0], /EMEND_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN/);
});

test('an obsolete revision cannot publish successful merge evidence (#980 review)', () => {
  const yaml = readWorkflow();
  const timingOffset = yaml.indexOf('- name: Publish timing summary');
  const rejectOffset = yaml.indexOf('- name: Reject obsolete revision as merge evidence');
  assert.ok(timingOffset >= 0, 'expected timing publication');
  assert.ok(rejectOffset > timingOffset, 'obsolete rejection must run after timing publication');

  const reject = yaml.match(/- name: Reject obsolete revision as merge evidence\n([\s\S]*?)(?=\n\s+- name:|$)/);
  assert.ok(reject, 'expected a terminal obsolete-revision rejection step');
  assert.match(reject[0], /if:\s*\$\{\{\s*always\(\)[^}]*steps\.freshness\.outputs\.run_expensive\s*==\s*'false'[^}]*\}\}/);
  assert.match(reject[0], /throw\s+"Obsolete revision cannot satisfy the Windows PR check/);
});

// --- the tooling suite must actually be runnable on Windows -----------------------------
// `node --test scripts/*.test.mjs` depends on the invoking shell expanding the `*` before node ever sees it. npm's
// script-shell on Windows is cmd.exe, which — unlike the POSIX shells this repo's suites have run
// under until now — never expands a bare glob for a generic argv; whether the literal string then
// "works" anyway is purely down to the Node version's own internal glob support, a fragile thing to
// depend on silently. The fix moves discovery off shell globbing entirely: `cd <dir> && node --test`
// uses node:test's own default recursive discovery from a set cwd, no glob syntax at all. The static
// check below fails outright on the reverted/old glob-string form; the live check after it
// actually execute the real npm script text through a real cmd.exe and prove test files are
// discovered and run.

test('test:scripts does not depend on shell-expanded glob syntax — cmd.exe (the npm Windows script-shell) never expands a bare wildcard', () => {
  const scripts = readPackageScripts();
  for (const name of ['test:scripts']) {
    const script = scripts[name];
    assert.ok(script, `expected an npm script named "${name}"`);
    assert.ok(
      !script.includes('*'),
      `"${name}" ("${script}") relies on a shell-expanded glob (*) — cmd.exe never expands it on ` +
        'Windows, and depending on node itself expanding a literal glob string is Node-version-fragile; ' +
        'use directory-scoped discovery ("cd <dir> && node --test") instead'
    );
  }
});

// Guards the live check below against re-triggering itself: `npm run test:scripts` discovers
// this very file, so a live check that shells out to `npm run test:scripts` would spawn a Windows
// `node:test` run that re-executes this same test, which would shell out again, forever. Set in the
// child's environment before the live check spawns anything; a nested run skips it.
const NESTED_ENV = 'EMEND_WORKFLOW_LIVE_CHECK_NESTED';
const DISCOVERY_SENTINEL = 'cowrite-windows-cmd-discovery-sentinel';
// Node 20's TAP reporter describes every name-filtered test. The suite crossed spawnSync's
// implicit ~1 MiB stdout cap at 3,735 tests (#1573), killing a healthy child with ENOBUFS. Keep a
// generous explicit bound like the other repository-owned captured subprocesses: bounded against a
// runaway child, but far enough above ordinary suite growth that adding tests cannot break discovery.
const CMD_DISCOVERY_MAX_BUFFER = 64 * 1024 * 1024;

// Runs an npm script's literal command text through a real cmd.exe — precisely how a bare Windows
// self-hosted runner would run it via `npm run <name>` (no ambient SHELL var to fall back to a POSIX
// shell, unlike this repo's own git-bash dev environment, which would silently mask the bug this test
// exists to catch — confirmed live while building this fix: the same broken glob form passes here
// under git-bash and fails only once actually routed through cmd.exe).
function runScriptOnCmd(scriptText, { spawn = spawnSync } = {}) {
  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID mark THIS process as already inside a node:test run;
  // node:test's own recursion guard sees them on the child and silently skips running any files
  // ("run() is being called recursively... skipping") — a false PASS, not a real one, discovered live
  // while building this fix. Any nested `node --test` invocation needs these stripped, independent of
  // whether the target files actually overlap.
  const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...env } = process.env;
  return spawn('cmd.exe', ['/d', '/c', scriptText], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...env, [NESTED_ENV]: '1' },
    maxBuffer: CMD_DISCOVERY_MAX_BUFFER,
  });
}

export function discoveryProbeCommand(scriptText) {
  // cmd.exe consumes an unescaped leading caret, while quoting the value passes the quotes through
  // to Node's option parser. Doubling the caret is cmd.exe's native escape and gives Node the exact
  // anchored regular expression without making the quote characters part of the pattern.
  return `${scriptText} --test-name-pattern=^^${DISCOVERY_SENTINEL}$`;
}

test('the lightweight command retains default discovery and selects exactly the sentinel (#979)', () => {
  assert.equal(
    discoveryProbeCommand('cd scripts && node --test'),
    'cd scripts && node --test --test-name-pattern=^^cowrite-windows-cmd-discovery-sentinel$',
  );
});

// Reads the test count out of a `node:test` run's captured stdout, accepting BOTH default reporters
// (issue #729). Which one a piped child emits is a function of the Node version, not of anything this
// repo controls: `node:test` picks its default by whether stdout is a TTY, and the two disagree —
//   spec: `ℹ tests 1709`      tap: `# tests 1709`
// Node 24 (this dev box) emits the spec form even when piped; Node 20 (what `actions/setup-node` pins
// in `windows-self-hosted.yml`) emits TAP. Matching only the spec form is why the live check below
// passed locally and failed on the self-hosted runner for every run of its first day — the child ran
// fine, exited 0, and produced complete TAP output that this parser could not read. GitHub already
// warns Node 20 is deprecated on Actions runners, so the format will flip again when that pin moves;
// accepting both is what makes this robust to the version rather than to today's version.
//
// Returns the count, or `null` when no summary line is present at all (a genuinely broken invocation).
// The `\r?` is load-bearing, not defensive: this parses output captured from a real `cmd.exe`, whose
// lines end CRLF, and `$` under `/m` matches before `\n` only — so without it every Windows summary
// line fails to match, which is the exact bug this function exists to fix.
export function parseRanTestCount(stdout) {
  const m = (stdout || '').match(/^(?:ℹ|#) tests (\d+)\r?$/m);
  return m ? Number(m[1]) : null;
}

export function hasPassingDiscoverySentinel(stdout) {
  const escaped = DISCOVERY_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const successes = (stdout || '').match(
    new RegExp(`^(?:✔ ${escaped}(?: \\(|\\r?$)|ok \\d+ - ${escaped}\\r?$)`, 'gm'),
  );
  return successes?.length === 1;
}

test('hasPassingDiscoverySentinel reads both reporter shapes and CRLF', () => {
  assert.equal(hasPassingDiscoverySentinel('ok 38 - cowrite-windows-cmd-discovery-sentinel\r\n'), true);
  assert.equal(hasPassingDiscoverySentinel('✔ cowrite-windows-cmd-discovery-sentinel (0.2ms)\n'), true);
  assert.equal(hasPassingDiscoverySentinel('# Subtest: cowrite-windows-cmd-discovery-sentinel\n'), false);
  assert.equal(hasPassingDiscoverySentinel(
    'ok 38 - cowrite-windows-cmd-discovery-sentinel\n' +
    'ok 39 - cowrite-windows-cmd-discovery-sentinel\n',
  ), false);
});

test('the discovery probe rejects a zero-pass run even when node discovered many skipped tests', () => {
  assert.throws(
    () => assertDiscoveryProbe({ status: 0, stdout: '# tests 2200\n# pass 0\n', stderr: '' }, 'test:scripts'),
    /exactly one passing discovery sentinel/,
  );
});

test('#1573: the real cmd discovery capture survives output beyond spawnSync\'s implicit 1 MiB buffer', () => {
  let observed;
  const result = runScriptOnCmd('ignored by the cross-platform spawn seam', {
    spawn(command, args, options) {
      observed = { command, args, options };
      return spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
        options,
      );
    },
  });

  assert.equal(observed.command, 'cmd.exe');
  assert.deepEqual(observed.args, ['/d', '/c', 'ignored by the cross-platform spawn seam']);
  assert.equal(result.status, 0, result.error?.message);
  assert.equal(Buffer.byteLength(result.stdout), 2 * 1024 * 1024);
  assert.equal(observed.options.maxBuffer, 64 * 1024 * 1024);
});

test('#1573: a discovery capture failure names ENOBUFS, its signal, and captured output size', () => {
  const error = Object.assign(new Error('spawnSync cmd.exe ENOBUFS'), { code: 'ENOBUFS' });
  assert.throws(
    () => assertDiscoveryProbe({
      status: null,
      signal: 'SIGTERM',
      error,
      stdout: 'x'.repeat(1_114_112),
      stderr: '',
    }, 'test:scripts'),
    (failure) => {
      assert.match(failure.message, /spawn error: ENOBUFS \(spawnSync cmd\.exe ENOBUFS\)/);
      assert.match(failure.message, /signal: SIGTERM/);
      assert.match(failure.message, /stdout: 1114112 byte\(s\)/);
      assert.match(failure.message, /stderr: ""/);
      return true;
    },
  );
});

test('#1578: a discovery spawn error wins over a zero exit status', () => {
  const error = Object.assign(new Error('spawnSync cmd.exe ENOBUFS'), { code: 'ENOBUFS' });
  assert.throws(
    () => assertDiscoveryProbe({
      status: 0,
      signal: null,
      error,
      stdout: 'partial',
      stderr: '',
    }, 'test:scripts'),
    (failure) => {
      assert.match(failure.message, /spawn error: ENOBUFS \(spawnSync cmd\.exe ENOBUFS\)/);
      assert.match(failure.message, /signal: none/);
      assert.match(failure.message, /stdout: 7 byte\(s\)/);
      assert.match(failure.message, /stderr: ""/);
      return true;
    },
  );
});

// A silent zero-file discovery still exits 0. Require both a summary and the sentinel's reporter-level
// success line: name filtering still reports each discovered file as a passing wrapper, so the global
// pass count alone cannot prove that the selected test body ran.
function assertDiscoveryProbe(result, name) {
  const spawnError = result.error
    ? `${result.error.code ?? result.error.name ?? 'unknown'} (${result.error.message})`
    : 'none';
  const failure =
    `cmd.exe could not run the real "${name}" invocation; ` +
    `spawn error: ${spawnError}; signal: ${result.signal ?? 'none'}; ` +
    `stdout: ${Buffer.byteLength(result.stdout ?? '')} byte(s); ` +
    `stderr: ${JSON.stringify(result.stderr ?? '')}`;
  assert.equal(result.error, undefined, failure);
  assert.equal(
    result.status,
    0,
    failure,
  );
  const ran = parseRanTestCount(result.stdout);
  assert.ok(
    ran !== null,
    `expected a node:test summary line from "${name}"; stdout: ${JSON.stringify(result.stdout)}`
  );
  assert.equal(
    hasPassingDiscoverySentinel(result.stdout),
    true,
    `expected exactly one passing discovery sentinel from "${name}"; discovered ${ran} tests; stdout: ${JSON.stringify(result.stdout)}`,
  );
}

// Unit coverage for the parser above, so the reporter-format question is settled by a cheap assertion
// on a captured sample rather than only by a live `cmd.exe` spawn — which can only ever produce
// whichever format the LOCAL Node emits, and so structurally could not catch #729 on the dev box.
test('parseRanTestCount reads the TAP reporter summary (what Node 20 emits to a pipe — issue #729)', () => {
  const tap = 'TAP version 13\nok 1 - something\n1..1709\n# tests 1709\n# pass 1709\n# fail 0\n';
  assert.equal(parseRanTestCount(tap), 1709);
});

test('parseRanTestCount reads the spec reporter summary (what Node 24 emits to a pipe — issue #729)', () => {
  const spec = '✔ something (1.2ms)\nℹ tests 1709\nℹ suites 0\nℹ pass 1709\nℹ fail 0\n';
  assert.equal(parseRanTestCount(spec), 1709);
});

test('parseRanTestCount reports null when no summary line is present — a silent zero-discovery must not read as a pass', () => {
  assert.equal(parseRanTestCount('TAP version 13\n'), null);
  assert.equal(parseRanTestCount(''), null);
  assert.equal(parseRanTestCount(undefined), null);
});

test('parseRanTestCount anchors to a whole line so a subtest merely NAMED like a summary cannot spoof it', () => {
  // `# Subtest: …` lines carry arbitrary test titles; an unanchored match would happily read one.
  assert.equal(parseRanTestCount('# Subtest: # tests 9999 is a silly name\n# tests 42\n'), 42);
});

test('parseRanTestCount handles CRLF — the output really is captured from cmd.exe (issue #729)', () => {
  // The whole point of these checks is a real Windows shell, so CRLF is the normal case, not an edge
  // one: `$` under `/m` matches before `\n` only, so an unguarded anchor would reject every genuine
  // Windows summary line while passing this suite's own LF-shaped fixtures.
  assert.equal(parseRanTestCount('TAP version 13\r\n# tests 1709\r\n# pass 1709\r\n'), 1709);
  assert.equal(parseRanTestCount('ℹ tests 1709\r\nℹ pass 1709\r\n'), 1709);
});


test('npm run test:scripts genuinely discovers and runs its test files under a real Windows cmd.exe (issue #388 CRITICAL)', (t) => {
  if (process.platform !== 'win32') { t.skip('cmd.exe is Windows-only'); return; }
  if (process.env[NESTED_ENV]) { t.skip('nested invocation — this file is itself part of test:scripts'); return; }
  const result = runScriptOnCmd(discoveryProbeCommand(readPackageScripts()['test:scripts']));
  assertDiscoveryProbe(result, 'test:scripts');
});

// --- test-matrix execution evidence (#1814) ---------------------------------
//
// The checker can only prove a test ran if this workflow really hands it that suite's results
// document. Every cell below pins one link in that chain: drop any one and the gate keeps
// reporting green over kinds it can no longer see — which is #1124's failure, re-made.

test('every suite writes its execution evidence into one per-run results directory (#1814)', () => {
  const yaml = readWorkflow();
  // The path is composed in a STEP and published through $GITHUB_ENV. `runner` is not an
  // available context in `jobs.<id>.env`, and putting it there makes GitHub reject the whole
  // workflow file — run 33694188051 failed in 0s with "workflow file issue" for exactly that.
  assert.doesNotMatch(yaml, /runner\.temp/, 'the runner context is unavailable in jobs.<id>.env');
  assert.match(yaml, /\$dir = "\$env:RUNNER_TEMP\\matrix-results-\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT"/);
  assert.match(yaml, /"EMEND_MATRIX_ARTIFACTS=\$dir" \| Out-File -FilePath \$env:GITHUB_ENV -Append/);
  // Keyed by run id AND attempt, and cleared: RUNNER_TEMP survives between jobs on the persistent
  // service, and a re-run reading the previous attempt's artifacts would credit tests this
  // attempt never executed.
  assert.match(yaml, /- name: Prepare test-matrix results directory[\s\S]*?Remove-Item -LiteralPath \$dir -Recurse -Force/);

  // One artifact per kind, named so check-test-matrix.mjs can pick the parser from the filename.
  assert.match(yaml, /Tee-Object -FilePath "\$env:EMEND_MATRIX_ARTIFACTS\\rust-windows\.txt"/);
  assert.match(yaml, /--outputFile\.json="\$env:EMEND_MATRIX_ARTIFACTS\\vitest-windows\.json"/);
  assert.match(yaml, /\$env:EMEND_TEST_RESULTS_FILE = "\$env:EMEND_MATRIX_ARTIFACTS\\node-scripts\.jsonl"/);
  assert.match(yaml, /\$env:EMEND_E2E_RESULTS_FILE = "\$env:EMEND_MATRIX_ARTIFACTS\\e2e-windows\.json"/);
});

test('every step that composes an artifact path refuses to run with the directory unset (#1814)', () => {
  // An unset variable would make `"$env:EMEND_MATRIX_ARTIFACTS\rust-windows.txt"` resolve to the
  // drive root — a silent write outside the results directory, and evidence the gate would then
  // fail to find. Seven writers, seven guards; the count is asserted so a new writer added without
  // one is visible here rather than at 2am on the runner.
  const guards = readWorkflow().match(/if \(-not \$env:EMEND_MATRIX_ARTIFACTS\) \{ throw /g) ?? [];
  assert.equal(guards.length, 5, 'cargo, tooling, vitest, playwright, and the validation step');
});

test('cargo test still fails the step once its output is piped to the results file (#1814)', () => {
  // The pipeline, not cargo (or cmd), is now the step's last command, so PowerShell would
  // otherwise exit 0 on a red suite — a green required check over failing Rust tests.
  assert.match(
    readWorkflow(),
    /cmd \/c 'cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1'[\s\S]*?Tee-Object[\s\S]*?if \(\$LASTEXITCODE -ne 0\) \{ throw "cargo test failed/,
  );
});

test('feature-gated voice capture runs in the Windows Rust execution artifact (#2542)', () => {
  const cargo = namedStep(readWorkflow(), 'Cargo test');
  assert.ok(cargo, 'expected the ordinary Windows Rust suite step');
  assert.match(cargo[0], /steps\.classifier\.outputs\.run_rust == 'true'/);
  assert.match(cargo[0], /steps\.rust\.outcome == 'success'/);
  assert.match(cargo[0], /steps\.sccache\.outcome == 'success'/);
  assert.match(
    cargo[0],
    /cmd \/c 'cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1'/,
  );
  assert.match(cargo[0], /Tee-Object -FilePath "\$env:EMEND_MATRIX_ARTIFACTS\\rust-windows\.txt"/);
  assert.match(cargo[0], /if \(\$LASTEXITCODE -ne 0\) \{ throw "cargo test failed/);
});

test('native Whisper inference tests run in the Windows Rust artifact (#2544)', () => {
  const cargo = namedStep(readWorkflow(), 'Cargo test');
  assert.ok(cargo);
  assert.match(cargo[0], /cmd \/c 'cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1'/);
  assert.match(cargo[0], /Tee-Object -FilePath "\$env:EMEND_MATRIX_ARTIFACTS\\rust-windows\.txt"/);
  assert.match(cargo[0], /if \(\$LASTEXITCODE -ne 0\) \{ throw "cargo test failed/);
});

test('Windows Whisper build provisions verified target libclang before Cargo (#2544)', () => {
  const setup = namedStep(readWorkflow(), 'Provision libclang for Whisper');
  const cargo = namedStep(readWorkflow(), 'Cargo test');
  const lockfile = readFileSync(join(REPO_ROOT, 'src-tauri/Cargo.lock'), 'utf8');
  assert.match(lockfile, /\[\[package\]\]\nname = "whisper-rs-sys"\nversion = "0\.15\.0"\n/);
  assert.ok(setup, 'Windows bindgen needs a target-native libclang DLL');
  assert.ok(cargo);
  assert.match(setup[0], /id: libclang/);
  assert.match(setup[0], /libclang\.runtime\.win-x64\/22\.1\.8/);
  assert.match(setup[0], /676b4aa346bc793af2fa05d80a9933825202ba65f71230417d5f0bb191dc3662/);
  assert.match(setup[0], /Get-FileHash[\s\S]*?if \(\$actual -ne \$expected\) \{ throw[\s\S]*?Expand-Archive/);
  assert.match(setup[0], /\$bin = Join-Path \$root 'runtimes\\win-x64\\native'[\s\S]*?\$dll = Join-Path \$bin 'libclang\.dll'/);
  assert.match(setup[0], /LIBCLANG_PATH[\s\S]*?GITHUB_ENV/);
  assert.match(cargo[0], /steps\.libclang\.outcome == 'success'/);
  assert.match(cargo[0], /Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(cargo[0], /\$env:WHISPER_DONT_GENERATE_BINDINGS\s*=/);
  assert.ok(readWorkflow().indexOf('- name: Provision libclang for Whisper') < readWorkflow().indexOf('- name: Cargo test'));
});

test('Windows Whisper build provisions hash-verified CMake before Cargo test (#2544)', () => {
  const setup = namedStep(readWorkflow(), 'Provision CMake for Whisper');
  const cargo = namedStep(readWorkflow(), 'Cargo test');
  assert.ok(setup, 'the native Whisper test build needs an explicit CMake binary');
  assert.ok(cargo);
  assert.match(setup[0], /id: cmake/);
  assert.match(setup[0], /steps\.classifier\.outputs\.run_rust == 'true'/);
  assert.match(setup[0], /\$version = '3\.31\.12'[\s\S]*?\$archiveName = "cmake-\$version-windows-x86_64\.zip"/);
  assert.match(setup[0], /0c4baa40f28b3f8225eb3fdf6946c987b4fe901403b4eaf2fbbd9378100aaa0c/);
  assert.match(setup[0], /Get-FileHash[\s\S]*?if \(\$actual -ne \$expected\) \{ throw[\s\S]*?Expand-Archive/);
  assert.match(setup[0], /GITHUB_PATH/);
  assert.match(cargo[0], /steps\.cmake\.outcome == 'success'/);
  assert.ok(readWorkflow().indexOf('- name: Provision CMake for Whisper') < readWorkflow().indexOf('- name: Cargo test'));
});

test('cargo test merges stderr into the piped stream via a CHILD PROCESS, not a bare PowerShell redirect (#2308 review round 1, Critical 1)', () => {
  // A bare `cargo test ... 2>&1` on a command PowerShell invokes directly wraps cargo's own
  // routine stderr lines in a terminating `NativeCommandError` under this runner's
  // `$ErrorActionPreference = 'Stop'` — reproduced locally, and the mechanism that killed the
  // `Cargo test` step on three real CI runs before this fix. Merging inside `cmd /c '... 2>&1'`
  // avoids that (PowerShell sees one native invocation, `cmd.exe`, whose own stdout is ordinary
  // success-stream text) and gives cargo's target/binary identity (printed on stderr) a real
  // OS-handle merge into the same artifact `Tee-Object` writes, in emission order.
  assert.match(readWorkflow(), /cmd \/c 'cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1'/);
  // The exact broken shape must never come back: `2>&1` piped straight into Tee-Object with no
  // closing quote in between (the fixed line always has `2>&1'` — quote, then space, then pipe).
  assert.ok(
    !readWorkflow().includes("--workspace --features voice-inference 2>&1 |"),
    "a direct (unwrapped) `cargo test ... 2>&1 |` must not reappear — it kills the step under this runner's $ErrorActionPreference",
  );
});


test('the execution check blocks on the kinds this venue can prove, and only when they ran (#1814)', () => {
  const yaml = readWorkflow();
  const step = yaml.match(/- name: Validate test-matrix execution evidence[\s\S]*?(?=\n      - name: )/);
  assert.ok(step, 'the execution-evidence step must exist');
  const body = step[0];

  // `success()`, not `!cancelled()`: a suite that already failed leaves a partial artifact.
  assert.match(body, /if: \$\{\{ success\(\) && steps\.freshness\.outputs\.run_expensive != 'false' \}\}/);
  // One invocation built as an argument array — the artifacts path is written once, so it cannot
  // be changed in one branch and forgotten in the other.
  assert.match(body, /\$argv = @\('scripts\/check-test-matrix\.mjs', '--artifacts', \$env:EMEND_MATRIX_ARTIFACTS\)/);
  assert.match(body, /if \(\$kinds\.Count -gt 0\) \{ \$argv \+= @\('--require-kinds', \(\$kinds -join ','\)\) \}/);
  assert.match(body, /\n\s+node \$argv\n/);
  assert.match(body, /if \(\$LASTEXITCODE -ne 0\) \{ throw "test-matrix execution check failed/);

  // Enforced: exactly `vitest` and `e2e`, each only when its own suite was selected. Requiring a
  // kind whose suite this revision skipped would fail a PR that never claimed to run it.
  assert.match(body, /if \(\$env:EMEND_RUN_FRONTEND -eq 'true'\) \{ \$kinds \+= 'vitest' \}/);
  assert.match(body, /if \(\$env:EMEND_RUN_E2E -eq 'true'\) \{ \$kinds \+= 'e2e' \}/);

  // NOT enforced: `rust` and `node`. Both credit tests this Windows venue cannot execute at all
  // (`#[cfg(unix)]` / `#[cfg(target_os = "macos")]` cases, and node tests gated on a specific
  // macOS host), so requiring them here would fail a green revision over tests that are
  // unprovable rather than unproven. The checker still WARNS on every one of them. Widening the
  // gate is CJ's call on the cross-platform question; this cell is what stops it widening by
  // accident, in either direction.
  assert.doesNotMatch(body, /\$kinds \+= 'rust'/);
  assert.doesNotMatch(body, /\$kinds \+= 'node'/);
});

test('the daily scheduled backstop selects every suite, so the execution gate is proved daily (#1814/#984)', () => {
  // On `schedule` there is no pull_request, so base and head are the same commit and the diff is
  // empty — which the classifier fails closed into running everything. That is what makes the
  // strong execution check a guaranteed daily event rather than only a lucky per-PR one.
  const scheduled = classifyChangedPaths([]);
  assert.deepEqual(scheduled.suites, Object.fromEntries(ALL_SUITES.map((suite) => [suite, true])));
});
