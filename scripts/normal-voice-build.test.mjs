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

test('the ordinary Emend app feature set links local Whisper', () => {
  const manifest = read('src-tauri/Cargo.toml');
  assert.match(manifest, /^default = \["voice-inference"\]$/m);
  assert.match(manifest, /^voice-inference = \["voice-capture", "dep:whisper-rs"\]$/m);
  // The headless e2e helper is not the shipped desktop binary.
  assert.match(read('src-tauri/crates/test-driver/Cargo.toml'), /^emend = \{ path = "\.\.\/\.\.", default-features = false \}$/m);
});

test('hosted Ubuntu lint installs CPAL ALSA headers before default-feature clippy', () => {
  const workflow = read('.github/workflows/ci.yml');
  const lint = workflow.slice(workflow.indexOf('\n  lint:\n'), workflow.indexOf('\n  suites:\n'));
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
    ['lint', 'suites', 'Rust clippy'],
    ['suites', 'build-app', 'Cargo test'],
    ['build-app', 'test-matrix', 'Build unsigned app with normal features'],
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
  // Hosted windows-latest ships Visual Studio 2026; CMake supports its generator from 4.2 (#53).
  assert.match(provisioner, /\$cmakeVersion = '4\.4\.5'/);
  assert.match(provisioner, /326c826486d46a23cf9d5a1c9ee3a567d427bdd02c4a34071937a2a675cff004/);
  assert.match(provisioner, /libclang\.runtime\.win-x64\/22\.1\.8/);
  assert.match(provisioner, /676b4aa346bc793af2fa05d80a9933825202ba65f71230417d5f0bb191dc3662/);
  assert.match(provisioner, /Get-FileHash[\s\S]*Expand-Archive[\s\S]*LIBCLANG_PATH/);
  assert.doesNotMatch(provisioner, /WHISPER_DONT_GENERATE_BINDINGS\s*=/);
});

test('macOS app builds target 10.15 for whisper.cpp std::filesystem (#53)', () => {
  // tauri build exports bundle.macOS.minimumSystemVersion as MACOSX_DEPLOYMENT_TARGET; below 10.15
  // libc++ marks std::filesystem unavailable and ggml fails to compile.
  const config = JSON.parse(read('src-tauri/tauri.macos.conf.json'));
  assert.equal(config.bundle?.macOS?.minimumSystemVersion, '10.15');
});
