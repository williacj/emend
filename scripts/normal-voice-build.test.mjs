// ABOUTME: Production build contract for local Whisper on both shipped desktop platforms.
// ABOUTME: Keeps a plain app build, its native toolchain, and its executable evidence together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedStep } from './workflow-step-assertions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the ordinary Cowrite app feature set links local Whisper', () => {
  const manifest = read('src-tauri/Cargo.toml');
  assert.match(manifest, /^default = \["voice-inference"\]$/m);
  assert.match(manifest, /^voice-inference = \["voice-capture", "dep:whisper-rs"\]$/m);
  // The headless e2e helper is not the shipped desktop binary.
  assert.match(read('src-tauri/crates/test-driver/Cargo.toml'), /^emend = \{ path = "\.\.\/\.\.", default-features = false \}$/m);
});

test('self-hosted Windows provisions target-native Whisper tools before default-feature clippy and tests', () => {
  const workflow = read('.github/workflows/windows-self-hosted.yml');
  assert.equal((workflow.match(/GGML_CCACHE: "OFF"/g) ?? []).length, 3);
  const cmake = workflow.indexOf('- name: Provision CMake for Whisper');
  const clang = workflow.indexOf('- name: Provision libclang for Whisper');
  const clippy = workflow.indexOf('- name: Rust clippy');
  const cargo = namedStep(workflow, 'Cargo test');
  assert.ok(cmake > 0 && clang > cmake && clippy > clang);
  assert.ok(cargo);
  assert.match(namedStep(workflow, 'Rust clippy')[0], /steps\.cmake\.outcome == 'success'[\s\S]*steps\.libclang\.outcome == 'success'/);
  assert.match(cargo[0], /steps\.cmake\.outcome == 'success'[\s\S]*steps\.libclang\.outcome == 'success'/);
  assert.match(cargo[0], /cargo test --manifest-path src-tauri\/Cargo\.toml --workspace 2>&1/);
  assert.doesNotMatch(cargo[0], /--features voice-inference/);
});

test('hosted Ubuntu lint installs CPAL ALSA headers before default-feature clippy', () => {
  const workflow = read('.github/workflows/ci.yml');
  const lint = workflow.slice(workflow.indexOf('\n  lint:\n'), workflow.indexOf('\n  test-cargo:\n'));
  const linuxDeps = namedStep(lint, 'Install Linux deps');
  assert.ok(linuxDeps);
  assert.match(linuxDeps[0], /^\s*if: matrix\.os == 'ubuntu-latest'$/m);
  const install = linuxDeps[0].match(/sudo apt-get install -y(?:[^\n]*\\\r?\n)*[^\n]*/)?.[0];
  assert.ok(install, 'Linux dependency step must run apt-get install');
  assert.match(install, /\blibasound2-dev\b/);
  assert.ok(lint.indexOf('- name: Rust clippy') > lint.indexOf('- name: Install Linux deps'));
});

test('hosted Windows and macOS gates build and inspect a normal unsigned app executable', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /build-app:[\s\S]*?matrix:[\s\S]*?os: \[macos-latest, windows-latest\]/);
  assert.match(workflow, /npm run tauri -- build --no-bundle --ci --no-sign/);
  assert.match(workflow, /npm run tauri -- build --ci --no-sign --bundles nsis/);
  assert.match(workflow, /npm run tauri -- build --ci --no-sign --bundles app/);
  assert.doesNotMatch(workflow, /tauri -- build[^\n]*--features/);
  assert.match(workflow, /target\/release\/emend\.exe/);
  assert.match(workflow, /target\/release\/emend(?:[^.\w]|$)/);
  assert.match(workflow, /target\/release\/bundle\/nsis[\s\S]*\*-setup\.exe/);
  assert.match(workflow, /target\/release\/bundle\/macos\/Emend\.app/);
  assert.match(workflow, /PlistBuddy -c 'Print :NSMicrophoneUsageDescription'/);
  assert.match(workflow, /scripts\/provision-whisper-windows\.ps1/);
  assert.match(workflow, /LIBCLANG_PATH/);
});

test('macOS bundle gate requires the executable named by its own Info.plist', () => {
  const inspect = namedStep(read('.github/workflows/ci.yml'), 'Inspect macOS app executable');
  assert.ok(inspect);
  assert.match(inspect[0], /PlistBuddy -c 'Print :CFBundleExecutable' "\$app\/Contents\/Info\.plist"/);
  assert.match(inspect[0], /bundle_exe="\$app\/Contents\/MacOS\/\$bundle_name"/);
  assert.match(inspect[0], /test -s "\$bundle_exe"/);
  assert.match(inspect[0], /file "\$bundle_exe" \| grep -q 'Mach-O'/);
  assert.doesNotMatch(inspect[0], /find "\$app\/Contents\/MacOS"[^\n]*-print/);
});

test('every hosted Rust job gets the proven Windows toolchain and target bindings', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /^  GGML_CCACHE: "OFF"$/m);
  assert.equal((workflow.match(/- name: Provision Windows Whisper tools/g) ?? []).length, 3);
  for (const [job, nextJob, cargoStep] of [
    ['lint', 'test-cargo', 'Rust clippy'],
    ['test-cargo', 'build-app', 'Cargo test'],
    ['build-app', 'test-npm', 'Build unsigned app with normal features'],
  ]) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    const end = workflow.indexOf(`\n  ${nextJob}:\n`, start + 1);
    assert.ok(start > 0 && end > start, `expected bounded ${job} job`);
    const block = workflow.slice(start, end);
    const provision = block.indexOf('- name: Provision Windows Whisper tools');
    const compile = block.indexOf(`- name: ${cargoStep}`);
    assert.ok(provision > 0 && compile > provision, `${job} must provision target libclang before Cargo`);
  }
  const provisioner = read('scripts/provision-whisper-windows.ps1');
  assert.match(provisioner, /3\.31\.12/);
  assert.match(provisioner, /0c4baa40f28b3f8225eb3fdf6946c987b4fe901403b4eaf2fbbd9378100aaa0c/);
  assert.match(provisioner, /libclang\.runtime\.win-x64\/22\.1\.8/);
  assert.match(provisioner, /676b4aa346bc793af2fa05d80a9933825202ba65f71230417d5f0bb191dc3662/);
  assert.match(provisioner, /Get-FileHash[\s\S]*Expand-Archive[\s\S]*LIBCLANG_PATH/);
  assert.doesNotMatch(provisioner, /WHISPER_DONT_GENERATE_BINDINGS\s*=/);
});

test('the operator Windows full-suite probe prepares Whisper before sampled default-feature builds', () => {
  const workflow = read('.github/workflows/windows-runner-contention-benchmark.yml');
  assert.match(workflow, /^      GGML_CCACHE: "OFF"$/m);
  const provision = workflow.indexOf('- name: Provision Windows Whisper tools');
  const sample = workflow.indexOf('- name: Start host sampler');
  const clippy = namedStep(workflow, 'Rust clippy');
  const cargo = namedStep(workflow, 'Cargo test');
  assert.ok(provision > 0 && sample > provision);
  assert.match(workflow, /run: \.\/scripts\/provision-whisper-windows\.ps1/);
  assert.match(clippy[0], /steps\.whisper\.outcome == 'success'/);
  assert.match(cargo[0], /steps\.whisper\.outcome == 'success'/);
});

test('on-demand self-hosted Windows NSIS build targets one immutable PR head without changing the required check', () => {
  const workflow = read('.github/workflows/windows-self-hosted.yml');
  const required = workflow.slice(workflow.indexOf('\n  test-windows:\n'), workflow.indexOf('\n  unsigned-nsis:\n'));
  const start = workflow.indexOf('\n  unsigned-nsis:\n');
  const end = workflow.indexOf('\n  e2e-focused-repeat:\n', start);
  assert.ok(start > 0 && end > start, 'expected a separate operator NSIS job');
  const bundle = workflow.slice(start, end);
  assert.match(workflow, /options:\s*\n\s+- suites\s*\n\s+- focused-e2e-repeat\s*\n\s+- unsigned-nsis/);
  assert.match(required, /inputs\.windows_mode != 'unsigned-nsis'/);
  assert.match(bundle, /if:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.windows_mode == 'unsigned-nsis' \}\}/);
  assert.match(bundle, /name: Unsigned NSIS \(Windows, self-hosted\)/);
  assert.match(bundle, /runs-on: \[self-hosted, Windows, cowrite-required\]/);
  assert.match(bundle, /EMEND_TARGET_SHA: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(bundle, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(bundle, /ref: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(bundle, /git rev-parse HEAD/);
  assert.match(bundle, /scripts\/provision-whisper-windows\.ps1/);
  assert.match(bundle, /npm ci/);
  assert.match(bundle, /npm run tauri -- build --ci --no-sign --bundles nsis/);
  assert.doesNotMatch(bundle, /tauri -- build[^\n]*--features/);
  assert.match(bundle, /target\/release\/emend\.exe/);
  assert.match(bundle, /bundle\/nsis[\s\S]*\*-setup\.exe/);
  assert.match(bundle, /actions\/upload-artifact@/);
});
