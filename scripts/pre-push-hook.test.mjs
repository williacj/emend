// ABOUTME: Runs the real .githooks/pre-push in temporary Git repositories, feeding it push lines on stdin.
// ABOUTME: Proves it refuses a push to the remote's default branch, and every push when that branch is unknown.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", ".githooks", "pre-push");
const REMOTE_URL = "https://example.invalid/repo.git";
const LOCAL_SHA = "1".repeat(40);
const REMOTE_SHA = "2".repeat(40);

const shProbe = spawnSync("sh", ["-c", "exit 0"]);
const options = {
  skip: shProbe.error ? `sh cannot be spawned on this host (${shProbe.error.code})` : false,
};

function pushLine(remoteRef, localRef = "refs/heads/topic") {
  return `${localRef} ${LOCAL_SHA} ${remoteRef} ${REMOTE_SHA}\n`;
}

// Inherited GIT_* variables (GIT_DIR is set while a Git hook runs) would point these commands at
// another repository, so none reach the fixture; the user's and the system's config stay out too.
function isolatedEnv(globalConfig) {
  const inherited = Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name));
  return { ...Object.fromEntries(inherited), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
}

function createRepository(t, { originHead } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emend-pre-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "");
  const cwd = join(root, "repo");
  const env = isolatedEnv(globalConfig);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: args[0] === "init" ? root : cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.error ?? result.stderr}`);
  };
  git("init", "-q", cwd);
  git("remote", "add", "origin", REMOTE_URL);
  if (originHead) git("symbolic-ref", "refs/remotes/origin/HEAD", originHead);
  return (stdin) =>
    spawnSync("sh", [HOOK, "origin", REMOTE_URL], { cwd, env, input: stdin, encoding: "utf8" });
}

const withOriginMain = { originHead: "refs/remotes/origin/main" };

test("pre-push exits non-zero for a push to the default branch", options, (t) => {
  const runHook = createRepository(t, withOriginMain);
  const result = runHook(pushLine("refs/heads/main"));
  assert.equal(result.status, 1, result.stderr);
});

test("pre-push names the default branch when it refuses a push to it", options, (t) => {
  const runHook = createRepository(t, withOriginMain);
  const result = runHook(pushLine("refs/heads/main"));
  assert.match(result.stderr, /the default branch main\b/);
});

test("pre-push exits 0 for a push to another branch", options, (t) => {
  const runHook = createRepository(t, withOriginMain);
  const result = runHook(pushLine("refs/heads/feature"));
  assert.equal(result.status, 0, result.stderr);
});

const ANY_PUSH_LINES = [
  pushLine("refs/heads/main"),
  pushLine("refs/heads/feature"),
  pushLine("refs/tags/v1"),
];

test("pre-push exits non-zero for any push when the default branch is unknown", options, (t) => {
  const runHook = createRepository(t);
  for (const line of ANY_PUSH_LINES) {
    const result = runHook(line);
    assert.equal(result.status, 1, `${line}${result.stderr}`);
  }
});

test("pre-push says the default branch is unknown when it refuses for that reason", options, (t) => {
  const runHook = createRepository(t);
  for (const line of ANY_PUSH_LINES) {
    const result = runHook(line);
    assert.match(result.stderr, /the default branch for remote origin is unknown/, line);
  }
});
