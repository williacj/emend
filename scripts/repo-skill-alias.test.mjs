// ABOUTME: Regression tests for checking and repairing the repo-owned skill alias on Windows checkouts.
// ABOUTME: Real Git fixtures prove the repaired symlink stays clean and worktree-local.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectSkillAlias, repairSkillAlias } from "./repo-skill-alias.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "repo-skill-alias.mjs");
const LINK_TEXT = "../.claude/skills";

function git(cwd, args, env = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function mustGit(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function runCli(cwd, ...args) {
  return spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function createMaterializedAlias(root) {
  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(join(root, ".claude", "skills", "repo-only-probe"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "repo-only-probe", "SKILL.md"), "---\nname: repo-only-probe\ndescription: probe\n---\n");
  writeFileSync(join(root, ".agents", "skills"), LINK_TEXT);
}

function createGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "emend-repo-skill-alias-"));
  createMaterializedAlias(root);
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@example.com"]);
  mustGit(root, ["config", "user.name", "Test"]);
  mustGit(root, ["config", "core.symlinks", "false"]);
  mustGit(root, ["add", ".claude"]);
  const blob = mustGit(root, ["hash-object", "-w", ".agents/skills"]);
  mustGit(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},.agents/skills`]);
  mustGit(root, ["commit", "-qm", "fixture"]);
  return root;
}

test("#2442: the check identifies Git's 17-byte materialized skill link as broken", () => {
  const root = mkdtempSync(join(tmpdir(), "emend-repo-skill-check-"));
  try {
    createMaterializedAlias(root);
    assert.deepEqual(inspectSkillAlias(root), {
      ok: false,
      kind: "materialized-link",
      detail: ".agents/skills is a plain 17-byte file containing ../.claude/skills",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2442: the CLI check fails loudly on the materialized-link state", () => {
  const root = createGitFixture();
  try {
    const result = runCli(root, "--check");
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /plain 17-byte file.*npm run repair:repo-skills/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2442: repair makes a clean real symlink and scopes core.symlinks to that worktree", (t) => {
  const root = createGitFixture();
  const card = join(dirname(root), `${fileURLToPath(import.meta.url).length}-${Date.now()}-card`);
  try {
    mustGit(root, ["worktree", "add", "-q", "-b", "feature/card", card]);
    const repaired = runCli(card, "--repair");
    if (repaired.status !== 0 && /EPERM|EACCES/.test(repaired.stderr)) {
      t.skip("real directory symlinks require Developer Mode or elevation on this Windows host");
      return;
    }
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(lstatSync(join(card, ".agents", "skills")).isSymbolicLink(), true);
    assert.equal(realpathSync(join(card, ".agents", "skills")), realpathSync(join(card, ".claude", "skills")));
    assert.equal(mustGit(card, ["config", "--worktree", "--get", "core.symlinks"]), "true");
    assert.equal(mustGit(root, ["config", "--get", "core.symlinks"]), "false");
    assert.equal(mustGit(card, ["status", "--porcelain"]), "");
    assert.equal(runCli(card, "--check").status, 0);
  } finally {
    git(root, ["worktree", "remove", "--force", card]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2442: repair refuses an unexpected plain file without overwriting it", () => {
  const root = createGitFixture();
  const alias = join(root, ".agents", "skills");
  try {
    writeFileSync(alias, "local data that is not the tracked link target");
    assert.throws(
      () => repairSkillAlias(root),
      /refusing to replace unexpected plain file/,
    );
    assert.equal(readFileSync(alias, "utf8"), "local data that is not the tracked link target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2442: a denied symlink creation restores the tracked placeholder and Git setting", () => {
  const root = createGitFixture();
  const alias = join(root, ".agents", "skills");
  const globalConfig = join(root, "inherited-global.gitconfig");
  const env = { GIT_CONFIG_GLOBAL: globalConfig };
  const scopedGit = (cwd, args) => git(cwd, args, env);
  try {
    mustGit(root, ["config", "--file", globalConfig, "extensions.worktreeConfig", "false"]);
    assert.equal(scopedGit(root, ["config", "--local", "--get", "extensions.worktreeConfig"]).status, 1);
    assert.equal(scopedGit(root, ["config", "--get", "extensions.worktreeConfig"]).stdout.trim(), "false");
    assert.throws(
      () => repairSkillAlias(root, {
        runGit: scopedGit,
        symlink: () => {
          throw Object.assign(new Error("privilege not held"), { code: "EPERM" });
        },
      }),
      /Developer Mode or run from an elevated shell/,
    );
    assert.deepEqual({
      alias: readFileSync(alias, "utf8"),
      coreSymlinks: scopedGit(root, ["config", "--get", "core.symlinks"]).stdout.trim(),
      extensionEffective: scopedGit(root, ["config", "--get", "extensions.worktreeConfig"]).stdout.trim(),
      extensionLocalStatus: scopedGit(root, ["config", "--local", "--get", "extensions.worktreeConfig"]).status,
    }, {
      alias: LINK_TEXT,
      coreSymlinks: "false",
      extensionEffective: "false",
      extensionLocalStatus: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2442: a pre-symlink config failure restores the shared worktree extension", () => {
  const root = createGitFixture();
  const alias = join(root, ".agents", "skills");
  try {
    mustGit(root, ["config", "extensions.worktreeConfig", "false"]);
    assert.throws(
      () => repairSkillAlias(root, {
        runGit: (cwd, args) => {
          if (args.join(" ") === "config --worktree core.symlinks true") {
            return { status: 2, stdout: "", stderr: "injected config failure" };
          }
          return git(cwd, args);
        },
      }),
      /injected config failure/,
    );
    assert.deepEqual({
      alias: readFileSync(alias, "utf8"),
      coreSymlinks: mustGit(root, ["config", "--get", "core.symlinks"]),
      extension: mustGit(root, ["config", "--get", "extensions.worktreeConfig"]),
    }, {
      alias: LINK_TEXT,
      coreSymlinks: "false",
      extension: "false",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
