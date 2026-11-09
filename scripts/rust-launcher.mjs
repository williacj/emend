// ABOUTME: Cross-platform launcher for ordinary Emend Cargo and Tauri builds.
// ABOUTME: Adds optional sccache and sequential-worktree target sharing without changing engine builds.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// The ambient default: whichever of node:path's win32/posix implementations matches the host this
// process is actually running on. Callers needing a *specific* platform's semantics regardless of
// host — a test pinning Windows path resolution while running on a POSIX CI runner, say — pass
// `path.win32`/`path.posix` (from node:path's default export) in explicitly.
const HOST_PATH_OPS = { basename, dirname, isAbsolute, join, resolve };
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// Probed as a bare name on every platform, deliberately. On Windows that misses an `sccache`
// installed as a `.cmd`/`.bat` shim, and detecting one would be the wrong favour here: the name below is
// handed to Cargo as `RUSTC_WRAPPER` and Cargo resolves it with the same restriction, so a shim we
// could see but Cargo could not spawn would turn a working plain-Cargo build into a broken one.
// Missing it degrades to the documented fallback instead, which is the safe direction.
export function isSccacheAvailable(runProbe = (command, args, options) => spawnSync(command, args, options)) {
  const result = runProbe('sccache', ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
}

export function resolveSharedTargetDir({ cwd, gitCommonDir, pathOps = HOST_PATH_OPS }) {
  const commonDir = pathOps.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : pathOps.resolve(cwd, gitCommonDir);
  // `<root>/.git` means the cache belongs beside the checkout. Anything else is a Git directory that
  // is not a checkout's `.git` — a bare repo anchoring a worktree set, or `--separate-git-dir` —
  // where the parent is unrelated ground, so the cache goes inside the Git directory itself.
  const anchor = pathOps.basename(commonDir) === '.git' ? pathOps.dirname(commonDir) : commonDir;
  return pathOps.join(anchor, '.emend-cache', 'rust-target');
}

// The CLI's entry file is that package's business: read it from the declared `bin` so a rename on
// their side surfaces here as a resolution error rather than as a spawn failure deeper in the build.
export function resolveTauriCli(requireFrom = createRequire(import.meta.url), pathOps = HOST_PATH_OPS) {
  const manifestPath = requireFrom.resolve('@tauri-apps/cli/package.json');
  const { bin } = requireFrom(manifestPath);
  const entry = typeof bin === 'string' ? bin : bin?.tauri;
  if (!entry) throw new Error('@tauri-apps/cli declares no `tauri` bin entry');
  return pathOps.resolve(pathOps.dirname(manifestPath), entry);
}

function readGitCommonDir(cwd) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`could not resolve Git's common worktree directory: ${result.stderr?.trim() || 'git rev-parse failed'}`);
  }
  return result.stdout.trim();
}

// `RUSTC_WRAPPER=sccache` is the whole cache wiring, deliberately — sccache's cache directory is
// user-wide rather than repo-scoped, so sibling worktrees share compiled objects with no further
// configuration. Path-normalizing config such as
// SCCACHE_BASEDIRS is not derived here: registry dependencies — the multi-minute cost this targets —
// already hit across differing absolute checkout paths without it, the workspace's own crates miss
// either way, and sccache reads that setting only when its server cold-starts, so whichever process
// wins that race would silently decide it for every later build.
export function buildEnvironment({
  env,
  shared = false,
  cwd = REPO_ROOT,
  gitCommonDir,
  sccacheAvailable,
  detectSccache = isSccacheAvailable,
}) {
  const childEnv = { ...env };
  // An exported RUSTC_WRAPPER outranks EMEND_SCCACHE_DISABLE: the disable flag suppresses the
  // automatic selection below, and never removes a wrapper the developer configured themselves.
  if (!Object.hasOwn(childEnv, 'RUSTC_WRAPPER') && childEnv.EMEND_SCCACHE_DISABLE !== '1') {
    const available = sccacheAvailable ?? detectSccache();
    if (available) childEnv.RUSTC_WRAPPER = 'sccache';
  }
  if (shared) {
    childEnv.CARGO_TARGET_DIR = resolveSharedTargetDir({
      cwd,
      gitCommonDir: gitCommonDir ?? readGitCommonDir(cwd),
    });
  }
  return childEnv;
}

export function runChild({
  command,
  args,
  cwd,
  env,
  spawnChild = spawn,
  signalSource = process,
  platform = process.platform,
}) {
  return new Promise((resolveStatus) => {
    const child = spawnChild(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: false,
    });
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
    };
    // A POSIX signal sent to this pid alone (`kill <pid>`) reaches only the launcher, so forward it
    // explicitly — and keep forwarding: a repeated Ctrl+C is how a developer escalates, and a
    // one-shot handler would let the second one kill the launcher and leave Cargo unsupervised.
    // Windows console control events already reach every attached process; installing a handler
    // there and calling child.kill() would turn Ctrl+C into a forceful TerminateProcess call that
    // can orphan Cargo.
    if (platform !== 'win32') {
      for (const signal of FORWARDED_SIGNALS) {
        const handler = () => child.kill(signal);
        handlers.set(signal, handler);
        signalSource.on(signal, handler);
      }
    }
    child.once('error', (error) => {
      cleanup();
      console.error(`failed to launch ${command}: ${error.message}`);
      resolveStatus(1);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolveStatus(code ?? SIGNAL_EXIT_CODES[signal] ?? 1);
    });
  });
}

function usageError() {
  return new Error('usage: rust-launcher.mjs [--shared] cargo <args...> | tauri <args...>');
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const shared = args[0] === '--shared';
  if (shared) args.shift();
  const tool = args.shift();
  if (tool !== 'cargo' && tool !== 'tauri') throw usageError();

  const env = buildEnvironment({ env: process.env, shared, cwd: REPO_ROOT });
  const invocation = tool === 'cargo'
    ? { command: 'cargo', args, cwd: join(REPO_ROOT, 'src-tauri') }
    : { command: process.execPath, args: [resolveTauriCli(), ...args], cwd: REPO_ROOT };
  return runChild({ ...invocation, env });
}

// `node -e`, `--eval` and the REPL all leave process.argv[1] undefined, so importing this module
// from one of them must be a no-op rather than a TypeError out of pathToFileURL.
export function isEntrypoint(moduleUrl, argv1 = process.argv[1]) {
  return typeof argv1 === 'string' && moduleUrl === pathToFileURL(argv1).href;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
