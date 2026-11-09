// ABOUTME: Checks and repairs the provider-neutral repo-skill symlink after Git materializes it as a file.
// ABOUTME: The repair preserves .claude/skills as the sole source and scopes core.symlinks to one worktree.
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINK_TEXT = "../.claude/skills";
const ALIAS_RELATIVE = ".agents/skills";
const SOURCE_RELATIVE = ".claude/skills";

function comparablePath(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function missing(error) {
  return error?.code === "ENOENT";
}

function readAliasState(alias, { lstat = lstatSync, readFile = readFileSync, readlink = readlinkSync } = {}) {
  let entry;
  try {
    entry = lstat(alias);
  } catch (error) {
    if (missing(error)) return { kind: "missing" };
    throw error;
  }

  if (entry.isSymbolicLink()) {
    return { kind: "symlink", target: readlink(alias).replaceAll("\\", "/") };
  }
  if (entry.isFile()) {
    const bytes = readFile(alias);
    return { kind: "file", bytes, text: bytes.toString("utf8") };
  }
  return { kind: entry.isDirectory() ? "directory" : "other" };
}

export function inspectSkillAlias(repoRoot, deps = {}) {
  const realpath = deps.realpath ?? realpathSync;
  const alias = join(repoRoot, ".agents", "skills");
  const source = join(repoRoot, ".claude", "skills");
  const state = readAliasState(alias, deps);

  if (state.kind === "file" && state.text === LINK_TEXT) {
    return {
      ok: false,
      kind: "materialized-link",
      detail: `${ALIAS_RELATIVE} is a plain ${state.bytes.length}-byte file containing ${LINK_TEXT}`,
    };
  }
  if (state.kind !== "symlink") {
    return {
      ok: false,
      kind: state.kind,
      detail: `${ALIAS_RELATIVE} must be a symbolic link to ${LINK_TEXT}; found ${state.kind}`,
    };
  }

  let aliasReal;
  let sourceReal;
  try {
    aliasReal = realpath(alias);
    sourceReal = realpath(source);
  } catch (error) {
    return {
      ok: false,
      kind: "broken-link",
      detail: `${ALIAS_RELATIVE} cannot resolve to ${SOURCE_RELATIVE}: ${error.message}`,
    };
  }
  if (comparablePath(aliasReal) !== comparablePath(sourceReal)) {
    return {
      ok: false,
      kind: "wrong-target",
      detail: `${ALIAS_RELATIVE} resolves to ${aliasReal}, not ${sourceReal}`,
    };
  }

  return {
    ok: true,
    kind: "symlink",
    detail: `${ALIAS_RELATIVE} -> ${state.target} -> ${SOURCE_RELATIVE}`,
  };
}

function defaultGit(repoRoot, args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function requireGit(repoRoot, args, runGit) {
  const result = runGit(repoRoot, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

function readGitSetting(repoRoot, scope, key, runGit) {
  const result = runGit(repoRoot, ["config", ...scope, "--get", key]);
  if (result.status === 0) return { present: true, value: result.stdout.trim() };
  if (result.status === 1) return { present: false };
  throw new Error(`could not read ${key}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

function restoreGitSetting(repoRoot, scope, key, previous, runGit) {
  const args = previous.present
    ? ["config", ...scope, key, previous.value]
    : ["config", ...scope, "--unset", key];
  const result = runGit(repoRoot, args);
  if (!previous.present && result.status === 5) return;
  if (result.status !== 0) {
    throw new Error(`could not restore ${key}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

export function repairSkillAlias(repoRoot, {
  runGit = defaultGit,
  symlink = symlinkSync,
  unlink = unlinkSync,
  writeFile = writeFileSync,
} = {}) {
  const before = inspectSkillAlias(repoRoot);
  if (before.ok) return { changed: false, inspection: before };
  if (before.kind !== "materialized-link") {
    const noun = before.kind === "file" ? "unexpected plain file" : before.kind;
    throw new Error(`refusing to replace ${noun} at ${ALIAS_RELATIVE}: ${before.detail}`);
  }

  requireGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], runGit);
  const previousExtension = readGitSetting(repoRoot, ["--local"], "extensions.worktreeConfig", runGit);
  let previousWorktree;
  const alias = join(repoRoot, ".agents", "skills");
  try {
    requireGit(repoRoot, ["config", "--local", "extensions.worktreeConfig", "true"], runGit);
    previousWorktree = readGitSetting(repoRoot, ["--worktree"], "core.symlinks", runGit);
    requireGit(repoRoot, ["config", "--worktree", "core.symlinks", "true"], runGit);
    unlink(alias);
    symlink(LINK_TEXT, alias, "dir");
    const after = inspectSkillAlias(repoRoot);
    if (!after.ok) throw new Error(`post-repair check failed: ${after.detail}`);
    const status = requireGit(repoRoot, ["status", "--porcelain", "--", ALIAS_RELATIVE], runGit);
    if (status !== "") throw new Error(`repair left ${ALIAS_RELATIVE} dirty: ${status}`);
    return { changed: true, inspection: after };
  } catch (error) {
    const rollbackErrors = [];
    try {
      const state = readAliasState(alias);
      if (state.kind === "symlink") unlink(alias);
      if (state.kind === "missing" || state.kind === "symlink") writeFile(alias, LINK_TEXT);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (previousWorktree) {
      try {
        restoreGitSetting(repoRoot, ["--worktree"], "core.symlinks", previousWorktree, runGit);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      restoreGitSetting(repoRoot, ["--local"], "extensions.worktreeConfig", previousExtension, runGit);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${error.message}; rollback also failed: ${rollbackErrors.map(({ message }) => message).join("; ")}`);
    }
    if (["EPERM", "EACCES"].includes(error?.code)) {
      throw new Error(
        `cannot create ${ALIAS_RELATIVE}: ${error.code}. Enable Windows Developer Mode or run from an elevated shell, then retry npm run repair:repo-skills.`,
      );
    }
    throw error;
  }
}

function repositoryRoot(cwd) {
  return requireGit(cwd, ["rev-parse", "--show-toplevel"], defaultGit);
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (argv.length !== 1 || !["--check", "--repair"].includes(argv[0])) {
    throw new Error("usage: node scripts/repo-skill-alias.mjs --check|--repair");
  }
  const repoRoot = repositoryRoot(cwd);
  if (argv[0] === "--repair") {
    const result = repairSkillAlias(repoRoot);
    process.stdout.write(`[repo-skill-alias] ${result.changed ? "repaired" : "already healthy"}: ${result.inspection.detail}\n`);
    return;
  }
  const inspection = inspectSkillAlias(repoRoot);
  if (!inspection.ok) {
    process.stderr.write(
      `[repo-skill-alias] BROKEN: ${inspection.detail}. Run \`npm run repair:repo-skills\` from this worktree.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[repo-skill-alias] OK: ${inspection.detail}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[repo-skill-alias] ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
