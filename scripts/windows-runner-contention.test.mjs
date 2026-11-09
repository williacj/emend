// ABOUTME: Contract tests for the operator-only one-versus-two Windows runner contention benchmark.
// ABOUTME: Pins full-suite parity, isolated parallel execution, bounded sampling, and cleanup.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertStepsRequireOutcome, namedStep } from './workflow-step-assertions.mjs';

const workflowUrl = new URL('../.github/workflows/windows-runner-contention-benchmark.yml', import.meta.url);
const samplerUrl = new URL('./windows-host-sampler.ps1', import.meta.url);

function read(url) {
  return readFileSync(url, 'utf8');
}

test('dispatches an explicit one-or-two runner matrix without production serialization (#981)', () => {
  const yaml = read(workflowUrl);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /host_label:[\s\S]*?default:\s*host-williacj-01[\s\S]*?options:\s*\n\s*- host-williacj-01\s*\n\s*- host-finn-pc10/);
  assert.match(yaml, /parallelism:/);
  assert.match(yaml, /options:\s*\n\s*- one\s*\n\s*- two/);
  assert.match(yaml, /fromJSON\(/);
  assert.ok(yaml.includes(`'["base","peer"]'`));
  assert.ok(yaml.includes(`'["base"]'`));
  assert.match(
    yaml,
    /runs-on:\s*\[self-hosted,\s*Windows,\s*["']?\$\{\{\s*inputs\.host_label\s*\}\}["']?\]/,
    'contention benchmark must select the requested physical host',
  );
  assert.doesNotMatch(yaml, /^concurrency:/m);
  assert.match(yaml, /timeout-minutes:\s*15/);
  assert.match(yaml, /EMEND_TARGET_SHA/);
  assert.match(yaml, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(yaml, /ref:\s*\$\{\{\s*inputs\.target_sha\s*\}\}/);
  assert.match(yaml, /windows-contention-cohort\.mjs/);
  assert.match(yaml, /windows-contention-cohort\.mjs finish/);
  assert.match(yaml, /Set-Content[^\n]+\$env:COMPUTERNAME/);
  assert.match(yaml, /name:\s*contention-host-\$\{\{\s*matrix\.slot\s*\}\}/);
  assert.match(yaml, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(yaml, /scripts\/windows-host-cohort\.mjs/);
  assert.match(yaml, /& node @arguments/);
  assert.match(yaml, /EMEND_BENCHMARK_ENDED_AT/);
  assert.match(
    yaml,
    /- name: Stop and report host sampler\n\s+if:.*always\(\).*\n\s+env:\n\s+GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\n\s+EMEND_PARALLELISM:\s*\$\{\{\s*inputs\.parallelism\s*\}\}/,
  );
});

test('validates and applies an explicit cargo build-job cap only when capped (#1083)', () => {
  const yaml = read(workflowUrl);
  assert.match(yaml, /cargo_build_jobs:/);
  assert.match(yaml, /default:\s*uncapped/);
  assert.match(yaml, /EMEND_CARGO_BUILD_JOBS:\s*\$\{\{\s*inputs\.cargo_build_jobs\s*\}\}/);
  assert.match(yaml, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(yaml, /CARGO_BUILD_JOBS=\$env:EMEND_CARGO_BUILD_JOBS/);
  assert.match(yaml, /if \(\$env:EMEND_CARGO_BUILD_JOBS -ne 'uncapped'\)/);
  assert.doesNotMatch(yaml, /CARGO_BUILD_JOBS='/);
  assert.equal(
    yaml.match(/Remove-Item Env:CARGO_BUILD_JOBS -ErrorAction SilentlyContinue/g)?.length,
    3,
  );
  assert.match(yaml, /cargo jobs=\$\{\{ inputs\.cargo_build_jobs \}\}/);
  assert.doesNotMatch(yaml, /^\s+CARGO_BUILD_JOBS:/m);
});

test('runs the complete production suite with cache-free Node setup (#981)', () => {
  const yaml = read(workflowUrl);
  for (const command of [
    'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check',
    'cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings',
    'cargo test --manifest-path src-tauri/Cargo.toml --workspace',
    'npm ci',
    'npm run test:scripts',
    'npm run matrix:check',
    'npm run check:vitest-unhandled-errors',
    'npm run test --if-present',
  ]) assert.ok(yaml.includes(command), `missing full-suite command: ${command}`);
  assert.match(yaml, /node-version:\s*["']?20["']?/);
  assert.match(yaml, /package-manager-cache:\s*false/);
});

test('records the host configuration needed to adjudicate qualification (#1935)', () => {
  const yaml = read(workflowUrl);
  const inventory = yaml.match(/- name: Report host qualification inventory\n([\s\S]*?)(?=\n\s+- name:|$)/);

  assert.ok(inventory, 'expected a host qualification inventory step');
  for (const evidence of [
    'Win32_Processor',
    'Win32_ComputerSystem',
    'Get-Volume',
    'Get-Partition',
    'Get-Disk',
    'Get-MpComputerStatus',
    'Get-MpPreference',
    'sccache --version',
    'Get-Process sccache',
    'node --version',
    'git --version',
    'Runner.Listener.exe',
    'RUNNER_WORKSPACE',
    'GITHUB_WORKSPACE',
  ]) {
    assert.ok(inventory[0].includes(evidence), `missing qualification evidence: ${evidence}`);
  }
});

test('records unavailable Defender preference state instead of aborting qualification (#1935)', () => {
  const yaml = read(workflowUrl);
  const inventory = yaml.match(/- name: Report host qualification inventory\n([\s\S]*?)(?=\n\s+- name:|$)/);

  assert.ok(inventory, 'expected a host qualification inventory step');
  assert.match(
    inventory[0],
    /\$workspaceExcluded = 'unknown'[\s\S]*\$exclusionCount = 'unknown'[\s\S]*try\s*\{[\s\S]*Get-MpPreference[\s\S]*\}\s*catch\s*\{[\s\S]*unavailable_error=/,
  );
});

test('resolves the runner listener above the repository workspace (#1935)', () => {
  const yaml = read(workflowUrl);
  const inventory = yaml.match(/- name: Report host qualification inventory\n([\s\S]*?)(?=\n\s+- name:|$)/);

  assert.ok(inventory, 'expected a host qualification inventory step');
  assert.match(
    inventory[0],
    /Split-Path -Parent \(Split-Path -Parent \$env:RUNNER_WORKSPACE\)[\s\S]*Join-Path \$runnerRoot 'bin\\Runner\.Listener\.exe'/,
  );
});

test('samples CPU and disk pressure and always stops only its own sampler (#981)', () => {
  const yaml = read(workflowUrl);
  const sampler = read(samplerUrl);
  assert.match(yaml, /windows-host-sampler\.ps1/);
  assert.match(yaml, /EMEND_SAMPLER_PID/);
  assert.match(yaml, /EMEND_SAMPLER_STARTED_TICKS/);
  assert.match(yaml, /EMEND_SAMPLER_STARTED_AT/);
  assert.match(yaml, /\.StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(yaml, /sampler process identity changed; refusing to stop reused PID/);
  assert.match(yaml, /Host sampler exited before cleanup/);
  assert.match(yaml, /forced stop invalidates evidence/);
  assert.match(yaml, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(yaml, /Stop-Process/);
  assert.match(yaml, /windows-host-sampler-report\.mjs/);
  assert.match(sampler, /Win32_PerfFormattedData_PerfOS_Processor/);
  assert.match(sampler, /Win32_PerfFormattedData_PerfDisk_PhysicalDisk/);
  assert.match(sampler, /Test-Path -LiteralPath \$StopPath/);
  assert.doesNotMatch(yaml, /Stop-Process\s+-Name/);
});

// #2293: the identical #2275/#2295 defect shape, in this second, separate workflow file.
// `!cancelled()` stays true after an earlier step fails, so without an explicit outcome check on the
// toolchain-pin steps, `Rust clippy`/`Cargo test` would run — and could report `success` — against
// whatever Rust happened to already be installed on the runner rather than the pinned 1.97.0, and
// `Install dependencies`/the npm-run steps would do the same against whatever Node happened to already
// be installed rather than the pinned Node 20. `Rust fmt check` needed no equivalent fix: it carries no
// explicit `if:` at all, so its default `success()` semantics already correctly no-run it when
// `Install Rust` fails — proven by the companion test below rather than assumed.
test('a failed toolchain pin blocks every step that invokes rustc/cargo, not just the job result (#2293)', () => {
  const yaml = read(workflowUrl);
  assert.match(yaml, /- name: Install Rust\n\s+id: rust\n\s+uses: dtolnay\/rust-toolchain@/);
  assertStepsRequireOutcome(
    yaml,
    ['Rust clippy', 'Cargo test'],
    "steps.rust.outcome == 'success'",
    'must not run after a failed toolchain pin',
  );
});

test('Rust fmt check has no explicit if: — it already correctly chains off default success() (#2293)', () => {
  const yaml = read(workflowUrl);
  const step = namedStep(yaml, 'Rust fmt check');
  assert.ok(step, 'expected a Rust fmt check step');
  assert.doesNotMatch(step[0], /\n\s*if:/, 'Rust fmt check must not gain an explicit if: that could weaken the implicit success() chain');
});

// The identical #2293 shape, one toolchain earlier: every step below `Setup Node.js` that actually
// invokes npm/node directly must require its outcome, not just `!cancelled()`.
test('a failed Node setup blocks every step that invokes npm/node directly, not just the job result (#2293)', () => {
  const yaml = read(workflowUrl);
  assert.match(yaml, /- name: Setup Node\.js\n\s+id: node\n\s+uses: actions\/setup-node@/);
  assertStepsRequireOutcome(
    yaml,
    [
      'Install dependencies',
      'tooling self-test',
      'Validate docs/test-matrix.md',
      'Validate vitest unhandled-errors invariant (test-plan §9b)',
      'vitest',
    ],
    "steps.node.outcome == 'success'",
    'must not run after a failed Node setup',
  );
});

// Named exception (#2293), not an oversight: this step must run under `always()`. Gating it on
// `steps.node.outcome == 'success'` the way the fixed steps above are gated would NOT protect against
// a dangling sampler: `Start host sampler` carries no `if:` of its own, so it inherits the same
// default `success()` chain as everything upstream of it — it only ever runs once `Setup Node.js` (and
// `Install Rust` before it) already succeeded, so its having started implies the Node pin succeeded.
// Gating on `steps.node.outcome` would therefore only suppress cleanup in exactly the case where the
// sampler never started, i.e. where there is nothing to clean up. `always()` exists for the opposite
// case: a failure in one of the steps between `Start host sampler` and here, where the sampler
// genuinely IS running and must still be stopped so its evidence is reported and the process does not
// leak on the physical host. Its own node invocations (`windows-host-sampler-report.mjs`,
// `windows-contention-cohort.mjs finish`) already fail loudly via their checked exit codes and the
// trailing `throw`s if node itself is unusable; they do not silently report success the way the fixed
// steps above could.
test('Stop and report host sampler stays gated on always() alone — cleanup must not depend on the toolchain pins (#2293)', () => {
  const yaml = read(workflowUrl);
  const step = namedStep(yaml, 'Stop and report host sampler');
  assert.ok(step, 'expected a Stop and report host sampler step');
  const ifLine = step[0].match(/^\s*if:\s*\$\{\{([^\n]*)\}\}\s*$/m);
  assert.ok(ifLine, 'expected a single-line if: condition for Stop and report host sampler');
  assert.equal(ifLine[1].trim(), 'always()');
});

// Regression guard for the class of near-miss #2295's review round 2 found: this file's own
// three no-explicit-`if:` steps between `Setup Node.js` and `Rust fmt check` (the qualification
// inventory and both cohort-validation steps) invoke sccache/node/git directly but need no outcome
// gate of their own — the default `success()` they already inherit is strictly stronger than a
// `!cancelled() && steps.X.outcome == 'success'` gate would be, since it also requires every OTHER
// preceding step (checkout, hostname evidence) to have succeeded. Pinned so a future edit that adds an
// `if: !cancelled()` to any of them is caught here rather than silently weakening this chain.
test('the qualification and cohort-validation steps carry no explicit if: — default success() already gates them (#2293)', () => {
  const yaml = read(workflowUrl);
  for (const name of [
    'Report host qualification inventory',
    'Validate isolated overlapping cohort',
    'Validate co-located host cohort',
  ]) {
    const step = namedStep(yaml, name);
    assert.ok(step, `expected a ${name} step`);
    assert.doesNotMatch(step[0], /\n\s*if:/, `${name} must not gain an explicit if: that could weaken the implicit success() chain`);
  }
});
