// ABOUTME: Unit tests for the ordinary Cowrite Rust/Tauri build launcher.
// ABOUTME: Covers cache selection, shared worktree targets, and child-process propagation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildEnvironment,
  isEntrypoint,
  isSccacheAvailable,
  resolveSharedTargetDir,
  resolveTauriCli,
  runChild,
} from './rust-launcher.mjs';
import { readPackageScripts } from './package-scripts.mjs';

test('detects sccache when its version probe succeeds', () => {
  assert.equal(isSccacheAvailable(() => ({ status: 0 })), true);
});

test('falls back cleanly when sccache is unavailable', () => {
  assert.equal(isSccacheAvailable(() => ({ status: 1 })), false);
  assert.deepEqual(buildEnvironment({ env: {}, sccacheAvailable: false }), {});
});

test('EMEND_SCCACHE_DISABLE=1 disables automatic sccache selection', () => {
  assert.deepEqual(
    buildEnvironment({
      env: { EMEND_SCCACHE_DISABLE: '1' },
      sccacheAvailable: true,
    }),
    { EMEND_SCCACHE_DISABLE: '1' },
  );
});

test('an existing RUSTC_WRAPPER is preserved without probing or replacing it', () => {
  let probed = false;
  const env = { RUSTC_WRAPPER: '/custom/cache' };
  assert.deepEqual(
    buildEnvironment({
      env,
      detectSccache: () => {
        probed = true;
        return true;
      },
    }),
    env,
  );
  assert.equal(probed, false);
});

test('an explicitly empty RUSTC_WRAPPER is still preserved', () => {
  assert.deepEqual(
    buildEnvironment({ env: { RUSTC_WRAPPER: '' }, sccacheAvailable: true }),
    { RUSTC_WRAPPER: '' },
  );
});

// The two escape hatches can be set at once, so their precedence has to be a fact rather than an
// accident: a wrapper the developer exported themselves is never overridden or removed, which means
// EMEND_SCCACHE_DISABLE=1 suppresses only the automatic selection. README states this.
test('an exported RUSTC_WRAPPER outranks EMEND_SCCACHE_DISABLE', () => {
  assert.deepEqual(
    buildEnvironment({
      env: { RUSTC_WRAPPER: 'sccache', EMEND_SCCACHE_DISABLE: '1' },
      sccacheAvailable: true,
    }),
    { RUSTC_WRAPPER: 'sccache', EMEND_SCCACHE_DISABLE: '1' },
  );
});

test('sccache is enabled when available and no wrapper is already configured', () => {
  assert.deepEqual(
    buildEnvironment({ env: { KEEP: 'yes' }, sccacheAvailable: true }),
    { KEEP: 'yes', RUSTC_WRAPPER: 'sccache' },
  );
});

// sccache shares compiled objects across sibling worktrees from its own user-wide cache directory,
// with no path-normalization config. Deriving SCCACHE_BASEDIRS from the worktree list buys nothing:
// registry dependencies — the whole cost this targets — already hit across differing absolute
// checkout paths without it, while the workspace's own crates miss either way. Guarding it here so
// the wiring stays exactly what #177 verified.
test('sccache wiring is RUSTC_WRAPPER alone — no derived SCCACHE_BASEDIRS (#177 prior art)', () => {
  assert.deepEqual(
    buildEnvironment({
      env: {},
      sccacheAvailable: true,
      // Offered on a plate; must still be ignored. Goes red the moment the derivation returns.
      sccacheBaseDirs: ['/repo/main', '/repo/worktree'],
    }),
    { RUSTC_WRAPPER: 'sccache' },
  );
});

test('default builds retain Cargo target isolation', () => {
  assert.equal(
    Object.hasOwn(buildEnvironment({ env: {}, sccacheAvailable: true }), 'CARGO_TARGET_DIR'),
    false,
  );
});

test('shared target is derived from an absolute Git common directory', () => {
  assert.equal(
    resolveSharedTargetDir({
      cwd: '/repo/worktree',
      gitCommonDir: '/repo/main/.git',
    }),
    join('/repo/main', '.emend-cache', 'rust-target'),
  );
});

// `pathOps` is pinned to a specific platform's `node:path` implementation, deliberately, rather than
// left at the ambient default: `/repo/main` isn't drive-qualified, so on an *actual* win32 host the
// ambient `resolve()` would fill in the current process's drive letter, silently producing a
// different (drive-prefixed) answer than this POSIX-shaped fixture expects (issue #691). Pinning
// makes the assertion true regardless of which OS is running the test.
test('shared target resolves a relative Git common directory against the worktree', () => {
  assert.equal(
    resolveSharedTargetDir({
      cwd: '/repo/main',
      gitCommonDir: '.git',
      pathOps: path.posix,
    }),
    path.posix.join('/repo/main', '.emend-cache', 'rust-target'),
  );
});

test('shared target resolves a relative Git common directory against the worktree — on Windows', () => {
  assert.equal(
    resolveSharedTargetDir({
      cwd: 'C:\\repo\\main',
      gitCommonDir: '.git',
      pathOps: path.win32,
    }),
    path.win32.join('C:\\repo\\main', '.emend-cache', 'rust-target'),
  );
});

// A worktree set anchored on a bare repo has no checkout to sit beside, so the cache must not be
// dropped into the bare directory's unrelated parent — where nothing gitignores it and it is not
// obviously ours.
test('shared target for a bare repository stays inside the Git directory', () => {
  assert.equal(
    resolveSharedTargetDir({
      cwd: '/repos/cowrite-feature',
      gitCommonDir: '/repos/cowrite.git',
    }),
    join('/repos/cowrite.git', '.emend-cache', 'rust-target'),
  );
});

test('shared mode sets CARGO_TARGET_DIR while retaining wrapper selection', () => {
  assert.deepEqual(
    buildEnvironment({
      env: {},
      shared: true,
      cwd: '/repo/worktree',
      gitCommonDir: '/repo/main/.git',
      sccacheAvailable: true,
    }),
    {
      RUSTC_WRAPPER: 'sccache',
      CARGO_TARGET_DIR: join('/repo/main', '.emend-cache', 'rust-target'),
    },
  );
});

test('child launch propagates args cwd environment and inherited stdio', async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let invocation;
  const status = runChild({
    command: 'cargo',
    args: ['build', '--package', 'cowrite'],
    cwd: '/repo/src-tauri',
    env: { SENTINEL: 'present' },
    spawnChild(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit('close', 23, null));
      return child;
    },
    signalSource: new EventEmitter(),
  });

  assert.equal(await status, 23);
  assert.deepEqual(invocation, {
    command: 'cargo',
    args: ['build', '--package', 'cowrite'],
    options: {
      cwd: '/repo/src-tauri',
      env: { SENTINEL: 'present' },
      stdio: 'inherit',
      windowsHide: false,
    },
  });
});

// `platform` is pinned to a non-Windows value, deliberately: this is the forwarding behavior that is
// disabled outright on win32 (see the "Windows relies on native console-event propagation" test
// below), so leaving it at the ambient default would silently test nothing — or fail outright — on an
// actual Windows test runner (issue #691).
test('child launch forwards termination signals and maps signal-only exits', async () => {
  const child = new EventEmitter();
  const forwarded = [];
  child.kill = (signal) => {
    forwarded.push(signal);
    return true;
  };
  const signalSource = new EventEmitter();
  const status = runChild({
    command: 'cargo',
    args: [],
    cwd: '/repo',
    env: {},
    platform: 'linux',
    spawnChild() {
      queueMicrotask(() => signalSource.emit('SIGTERM'));
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return child;
    },
    signalSource,
  });

  assert.equal(await status, 143);
  assert.deepEqual(forwarded, ['SIGTERM']);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

// Ctrl+C twice is how a developer escalates when the first one does not take. A one-shot handler
// makes the second signal kill the launcher and leave Cargo running unsupervised.
test('a repeated termination signal is forwarded every time', async () => {
  const child = new EventEmitter();
  const forwarded = [];
  child.kill = (signal) => {
    forwarded.push(signal);
    return true;
  };
  const signalSource = new EventEmitter();
  const status = runChild({
    command: 'cargo',
    args: [],
    cwd: '/repo',
    env: {},
    platform: 'linux',
    spawnChild() {
      queueMicrotask(() => signalSource.emit('SIGINT'));
      queueMicrotask(() => signalSource.emit('SIGINT'));
      queueMicrotask(() => child.emit('close', null, 'SIGINT'));
      return child;
    },
    signalSource,
  });

  assert.equal(await status, 130);
  assert.deepEqual(forwarded, ['SIGINT', 'SIGINT']);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
});

test('Windows relies on native console-event propagation instead of force-killing the child', async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const signalSource = new EventEmitter();
  const status = runChild({
    command: 'cargo',
    args: [],
    cwd: 'C:\\repo',
    env: {},
    platform: 'win32',
    spawnChild() {
      queueMicrotask(() => signalSource.emit('SIGINT'));
      queueMicrotask(() => child.emit('close', 130, null));
      return child;
    },
    signalSource,
  });

  assert.equal(await status, 130);
  assert.equal(killed, false);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
});

// The Tauri CLI's entry file is that package's business, not ours. Reading it from the declared
// `bin` keeps a CLI-side rename a resolution error here rather than a spawn failure later.
//
// `pathOps` is pinned to `path.posix`, deliberately: `resolveTauriCli` always calls `resolve()`
// unconditionally, and `/repo/...` isn't drive-qualified, so on an actual win32 host the ambient
// `resolve()` would fill in the current process's drive letter, silently producing a different
// (drive-prefixed) answer than this POSIX-shaped fixture expects (issue #691).
test('the Tauri CLI is resolved from the package bin entry', () => {
  const manifest = '/repo/node_modules/@tauri-apps/cli/package.json';
  const fakeRequire = (manifestPath) => {
    assert.equal(manifestPath, manifest);
    return { bin: { tauri: './tauri.js' } };
  };
  fakeRequire.resolve = (specifier) => {
    assert.equal(specifier, '@tauri-apps/cli/package.json');
    return manifest;
  };
  assert.equal(
    resolveTauriCli(fakeRequire, path.posix),
    path.posix.join('/repo/node_modules/@tauri-apps/cli', 'tauri.js'),
  );
});

test('a single-string bin declaration resolves the same way', () => {
  const manifest = '/repo/node_modules/@tauri-apps/cli/package.json';
  const fakeRequire = () => ({ bin: './tauri.js' });
  fakeRequire.resolve = () => manifest;
  assert.equal(
    resolveTauriCli(fakeRequire, path.posix),
    path.posix.join('/repo/node_modules/@tauri-apps/cli', 'tauri.js'),
  );
});

test('the Tauri CLI is resolved from the package bin entry — on Windows', () => {
  const manifest = 'C:\\repo\\node_modules\\@tauri-apps\\cli\\package.json';
  const fakeRequire = (manifestPath) => {
    assert.equal(manifestPath, manifest);
    return { bin: { tauri: './tauri.js' } };
  };
  fakeRequire.resolve = (specifier) => {
    assert.equal(specifier, '@tauri-apps/cli/package.json');
    return manifest;
  };
  assert.equal(
    resolveTauriCli(fakeRequire, path.win32),
    path.win32.join('C:\\repo\\node_modules\\@tauri-apps\\cli', 'tauri.js'),
  );
});

test('a Tauri CLI declaring no bin entry fails loudly rather than spawning nothing', () => {
  const fakeRequire = () => ({});
  fakeRequire.resolve = () => '/repo/node_modules/@tauri-apps/cli/package.json';
  assert.throws(() => resolveTauriCli(fakeRequire), /no .*bin entry/);
});

test('the installed Tauri CLI really resolves to a file on disk', () => {
  assert.equal(existsSync(resolveTauriCli()), true);
});

// Importing the module must never run the CLI, and must never throw either — `node -e`, `--eval`
// and the REPL all leave process.argv[1] undefined.
test('module import with no argv entry is not treated as the entrypoint', () => {
  assert.equal(isEntrypoint('file:///repo/scripts/rust-launcher.mjs', undefined), false);
});

test('direct invocation is recognized as the entrypoint', () => {
  const script = join('/repo', 'scripts', 'rust-launcher.mjs');
  assert.equal(isEntrypoint(pathToFileURL(script).href, script), true);
  assert.equal(isEntrypoint(pathToFileURL(script).href, join('/repo', 'other.mjs')), false);
});

test('npm scripts route ordinary and explicit shared builds through the launcher', () => {
  const scripts = readPackageScripts();
  assert.equal(scripts.tauri, 'node scripts/rust-launcher.mjs tauri');
  assert.equal(scripts['build:rust'], 'node scripts/rust-launcher.mjs cargo build --package emend');
  assert.equal(scripts['tauri:shared'], 'node scripts/rust-launcher.mjs --shared tauri');
  assert.equal(scripts['build:rust:shared'], 'node scripts/rust-launcher.mjs --shared cargo build --package emend');
});
