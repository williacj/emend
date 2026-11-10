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

test('every hosted suite step runs on both legs and after an earlier suite fails (williacj/emend#8)', () => {
  const suites = job(readFileSync(WORKFLOW_PATH, 'utf8'), 'suites');
  // bash runs with `-eo pipefail`, which is what makes `cargo test 2>&1 | tee` fail on a test failure.
  assert.match(suites, /\n    defaults:\n      run:\n        shell: bash\n/);
  assert.doesNotMatch(suites, /\n    if:/);

  const steps = suites.split(/\n(?=      - (?:name|uses):)/).slice(1);
  const names = steps.map((step) => step.match(/- name: (.*)/)?.[1] ?? step.match(/- uses: (\S+)/)[1]);
  const first = names.indexOf('tooling self-test');
  const last = names.indexOf('Playwright acceptance suite');
  assert.ok(first > 0 && last > first, 'expected the suite steps in order');
  // The gate step is the last setup step, so its success stands for every setup step before it.
  assert.equal(names[first - 1], 'Install dependencies');
  assert.match(steps[first - 1], /\n        id: deps\n/);
  assert.doesNotMatch(steps[first - 1], /^\s+if:/m);
  // Any other condition could skip a suite on one OS, which reading both legs together cannot see.
  for (const step of steps.slice(first, last + 1)) {
    const conditions = step.match(/^\s+if:.*$/gm)?.map((line) => line.trim());
    assert.deepEqual(conditions, ["if: ${{ !cancelled() && steps.deps.outcome == 'success' }}"], step.split('\n')[0]);
  }
  assert.deepEqual(names.slice(first, last + 1), [
    'tooling self-test',
    'Validate docs/test-matrix.md',
    'Validate vitest unhandled-errors invariant (test-plan §9b)',
    'vitest',
    'Cargo test',
    'Install Playwright Chromium',
    'Pre-build the headless test driver',
    'Playwright acceptance suite',
  ]);
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

  // Every kind from every leg, so a suite that stops producing results on one OS fails here even
  // though the other leg's results would still satisfy each row.
  const presence = evidence.match(/- name: Require every suite's results from both legs\n([\s\S]*?)(?=\n\s+- (?:name|uses):|$)/)?.[1];
  assert.ok(presence, 'expected the per-leg presence check');
  assert.match(presence, /for label in windows macos; do/);
  for (const file of ['node-scripts-$label.jsonl', 'vitest-$label.json', 'rust-$label.txt', 'e2e-$label.json']) {
    assert.ok(presence.includes(`"${file}"`), file);
  }
  assert.match(presence, /\[ ! -s "\$dir\/\$file" \]/);
  assert.match(presence, /exit "\$missing"/);
  assert.ok(evidence.indexOf('Require every suite') < evidence.indexOf('node scripts/check-test-matrix.mjs'));

  assert.match(evidence, /pattern: matrix-results-\*/);
  assert.match(evidence, /merge-multiple: true/);
  const check = evidence.match(/node scripts\/check-test-matrix\.mjs[^\n]*/)?.[0];
  assert.ok(check, 'expected the execution check');
  assert.match(check, /--artifacts "\$RUNNER_TEMP\/matrix-results"/);
  // Enforced: vitest and e2e. rust and node stay observed: widening the gate is CJ's call (#2234).
  assert.match(check, /--require-kinds vitest,e2e$/);
});

test('hosted Lint pins one Rust toolchain with rustfmt and clippy, then enforces both checks (#817)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const lint = job(workflow, 'lint');
  assert.match(lint, /toolchain: 1\.97\.0\n\s+components: rustfmt, clippy/);
  assert.match(lint, /run: cargo fmt --manifest-path src-tauri\/Cargo\.toml --all -- --check/);
  assert.match(lint, /run: cargo clippy --manifest-path src-tauri\/Cargo\.toml --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(lint, /continue-on-error/);
  // One toolchain across every hosted Rust job, so lint and the suites judge the same compiler.
  const pins = [...workflow.matchAll(/^\s+toolchain: (\S+)$/gm)].map((match) => match[1]);
  assert.ok(pins.length >= 3, `expected a pin in each Rust job, found ${pins.length}`);
  const channel = readFileSync(join(HERE, '..', 'rust-toolchain.toml'), 'utf8').match(/^channel = "([^"]+)"$/m)?.[1];
  assert.ok(channel, 'expected rust-toolchain.toml to pin a channel');
  assert.deepEqual([...new Set(pins)], [channel]);
});

test('hosted CI validates the FR-traceability matrix and the vitest unhandled-errors invariant (test-plan §9/§9b)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  for (const name of ['suites', 'test-matrix']) {
    const block = job(workflow, name);
    assert.match(block, /run: npm run matrix:check\n/, name);
    assert.match(block, /run: npm run check:vitest-unhandled-errors\n/, name);
  }
});

test('the Windows Suites leg runs default-feature workspace tests, CPAL capture and native Whisper included, into its Rust artifact (#2542/#2544)', () => {
  const suites = job(readFileSync(WORKFLOW_PATH, 'utf8'), 'suites');
  // The app's default feature is voice-inference, which enables voice-capture: a plain workspace
  // test compiles and runs both, so the step must not narrow the feature set.
  const manifest = readFileSync(join(HERE, '..', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(manifest, /^default = \["voice-inference"\]$/m);
  assert.match(manifest, /^voice-inference = \["voice-capture", "dep:whisper-rs"\]$/m);

  const cargo = suites.match(/- name: Cargo test\n([\s\S]*?)(?=\n\s+- name:|$)/)?.[1];
  assert.ok(cargo, 'expected the Cargo test step');
  assert.match(cargo, /run: cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1 \| tee "\$EMEND_MATRIX_ARTIFACTS\/rust-\$\{\{ matrix\.label \}\}\.txt"/);
  assert.doesNotMatch(cargo, /--features|--no-default-features/);

  // Windows provisions verified CMake and libclang before Cargo compiles Whisper.
  const provision = suites.indexOf('- name: Provision Windows Whisper tools');
  assert.ok(provision > 0 && provision < suites.indexOf('- name: Cargo test'));
  assert.match(suites, /if: matrix\.os == 'windows-latest'\n\s+shell: pwsh\n\s+run: \.\/scripts\/provision-whisper-windows\.ps1/);
});
