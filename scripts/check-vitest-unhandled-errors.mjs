// ABOUTME: CI enforcement for docs/test-plan.md §9b (ratified 2026-08-28, #1701/#2100) — the single
// ABOUTME: boolean invariant that `dangerouslyIgnoreUnhandledErrors` is never set in any vitest config.
//
// Why this exists: vitest's run-level "Unhandled Errors" are a required signal (test-plan §9b) — a
// suite that ends with one is a red run even when every test passes. #1690 is the incident that
// proves the signal's worth: a fixture defect failed the required Suites (Windows, self-hosted) gate
// at 1315/1315 passed, and the escaping rejection was the only thing that made it findable. Silencing
// that signal under pressure to get a flaky-looking run green is a plausible, easy-to-miss-by-eye
// failure mode, so — following the precedent set by scripts/check-test-matrix.mjs for
// docs/test-matrix.md traceability — this is a script, not a convention.
//
// Detection: a bare, case-sensitive substring search for the literal identifier
// `dangerouslyIgnoreUnhandledErrors`. This alone is NOT sufficient on the two CLI surfaces (npm
// scripts, workflow files): cac (vitest's CLI arg parser) camelizes a dashed flag name BEFORE its
// unknown-option check, so `--dangerously-ignore-unhandled-errors` is accepted as the same option —
// it is the declared spelling, not a silently-dropped unknown one — while
// `--dangerously-ignore-unhandled-error` (near-miss singular) and `--totally-bogus-flag` both throw
// `Unknown option`. Confirmed by execution against vitest 4.1's CAC option table
// (`node_modules/vitest/dist/chunks/cac.*.js`), whose documented config meaning is in
// `node_modules/vitest/dist/config.d.ts`. So the CLI-surface check also searches for the literal
// kebab-case flag spelling `--dangerously-ignore-unhandled-errors` — see `CLI_KEBAB_FLAG` below.
// The config-key surface does NOT get this second pattern: a vitest config object key can only ever
// be camelCase JS/TS syntax, so `dangerouslyIgnoreUnhandledErrors` alone is exhaustive there.
// Neither pattern tries to distinguish live code from a comment or string literal containing the
// same text — fail-closed on ambiguity, same call as leaving a `.skip`/`.ignore` test undetected
// would be wrong to make silently. The cost is a possible false positive if a file legitimately needs
// to *talk about* either spelling in prose; the fix for that file is to describe the invariant without
// spelling either identifier out verbatim (as this very script's comments do above).
//
// Scope, and why each surface is/isn't covered:
//   - vitest config files: `vite*.config.{ts,mts,cts,js,mjs,cjs}` / `vitest*.config.{...}` at the
//     REPO ROOT ONLY (not recursive). This rests on Vitest/Vite convention: config lives at the
//     project root (there is no `workspaces` field and no nested project root in this repo, so
//     root-only is a strict superset of the surface test-plan §9b actually ratified). Stated
//     limitation: a `--config configs/vitest.ci.config.ts` refactor would move a live config to a
//     non-root path and silently drop it out of this check's scope — root-only tracks today's layout,
//     not a guarantee against a future one. A third config file added tomorrow at the root under a
//     name that doesn't start with `vite`/`vitest` would likewise be missed; also a real, stated
//     limitation, not an oversight. (This is deliberately NOT a recursive walk with exclusions for
//     untracked worktree checkouts under `.codex-worktrees/`/`.codex-artifacts/` — that would also
//     have worked, per the `SKIP_DIRS`/dot-prefix precedent in `scripts/check-test-matrix.mjs`, but
//     the root-only vite/vitest convention above is the actual reason this check stops at the root.)
//   - `package.json`: only the `scripts` object values are checked (the commands that actually run),
//     not the whole file — this is the most direct place a CLI-flag override
//     (`vitest run --dangerouslyIgnoreUnhandledErrors`) would live, since every CI/local invocation
//     goes through an npm script.
//   - `.github/workflows/*.yml`/`*.yaml` (top-level only, matching this repo's flat workflow layout):
//     the whole file is scanned. A workflow's `run:` step is exactly the other place an inline CLI
//     flag or env-var-driven override could set this outside any config file, per the card's own
//     framing — confirmed as a real vector (the CLI flag above), not a hypothetical one. Scanning the
//     whole file (not just `run:` blocks) trades a small amount of precision (a `name:`/comment
//     mentioning the identifier would also fail) for not needing a YAML parser dependency; the
//     workflow files this repo owns are expected to never contain that literal string outside a
//     violation, exactly like the vitest config case above.
//
// The two CLI surfaces (`package.json` scripts, `.github/workflows/**`) are additionally scanned for
// the kebab-case CLI flag spelling `--dangerously-ignore-unhandled-errors` — see the Detection
// section above for why that second pattern is necessary and why the config-key surface doesn't need
// it.
//
// What this does NOT cover: an env-var-based override. No such mechanism was found for this option in
// the installed vitest (4.1.10) — only the config key and the CLI flag, both covered above.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export const IDENTIFIER = "dangerouslyIgnoreUnhandledErrors";

// The CLI-flag spelling of IDENTIFIER, as cac (vitest's CLI arg parser) accepts it: it camelizes a
// dashed flag name BEFORE its unknown-option check, so this kebab-case flag is a second, independent
// live spelling of the same option on the two CLI surfaces below — see the Detection section in the
// header comment. NOT scanned for in vitest config files: a config object key can only be written in
// camelCase JS/TS syntax, so IDENTIFIER alone is exhaustive there.
export const CLI_KEBAB_FLAG = "--dangerously-ignore-unhandled-errors";

// Repo-root filenames that are a vitest/vite config surface. Glob-shaped (matches a name pattern),
// not a hard-coded list of today's two files — see the header comment for why it stops at the root.
const VITEST_CONFIG_NAME = /^vite(st)?[\w.-]*\.config\.(ts|mts|cts|js|mjs|cjs)$/i;

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing dir — tolerated, same posture as check-test-matrix.mjs's walk()
  }
}

// Every occurrence of `needle` in `text`, as 1-based line numbers (for readable error output).
function findOccurrences(text, needle) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes(needle)) hits.push(i + 1);
  });
  return hits;
}

export function findVitestConfigFiles(repoRoot) {
  return listDir(repoRoot)
    .filter((e) => e.isFile() && VITEST_CONFIG_NAME.test(e.name))
    .map((e) => join(repoRoot, e.name))
    .sort();
}

export function findWorkflowFiles(repoRoot) {
  const dir = join(repoRoot, ".github/workflows");
  return listDir(dir)
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

// Extract every `scripts` value from package.json as a single searchable blob, tagged with the
// script name it came from (for error messages). Parses JSON rather than substring-scanning the
// whole file, so a mention of the identifier elsewhere in package.json (there is no legitimate reason
// for one, but this keeps the check scoped to what it claims) is out of scope. `parsed: false` lets
// the caller fail closed on an unreadable/unparseable package.json instead of silently treating it as
// zero scripts — the same vacuity posture as the vitest-config-files guard below (#2121 review Minor).
function packageScripts(repoRoot, readFile) {
  const pkgPath = join(repoRoot, "package.json");
  try {
    const pkg = JSON.parse(readFile(pkgPath, "utf8"));
    return { pkgPath, scripts: pkg.scripts ?? {}, parsed: true };
  } catch {
    return { pkgPath, scripts: {}, parsed: false };
  }
}

export function checkUnhandledErrors({ repoRoot = REPO_ROOT, readSourceFile = readFileSync } = {}) {
  const errors = [];

  const configFiles = findVitestConfigFiles(repoRoot);
  if (configFiles.length === 0) {
    errors.push("no vitest config files found at the repo root — is the glob broken, or the check looking in the wrong place?");
  }
  for (const file of configFiles) {
    const hits = findOccurrences(readSourceFile(file, "utf8"), IDENTIFIER);
    for (const line of hits) {
      errors.push(`${file}:${line}: sets/references "${IDENTIFIER}" — never set in a vitest config (test-plan §9b)`);
    }
  }

  const { pkgPath, scripts, parsed } = packageScripts(repoRoot, readSourceFile);
  if (!parsed) {
    errors.push(`${pkgPath}: could not be read/parsed as JSON — is the check looking in the wrong place?`);
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    if (command.includes(IDENTIFIER)) {
      errors.push(`${pkgPath}: script "${name}" references "${IDENTIFIER}" — never set in an npm script (test-plan §9b)`);
    }
    if (command.includes(CLI_KEBAB_FLAG)) {
      errors.push(`${pkgPath}: script "${name}" references "${CLI_KEBAB_FLAG}" — never set in an npm script (test-plan §9b)`);
    }
  }

  const workflowFiles = findWorkflowFiles(repoRoot);
  if (workflowFiles.length === 0) {
    errors.push("no workflow files found under .github/workflows — is the check looking in the wrong place?");
  }
  for (const file of workflowFiles) {
    const text = readSourceFile(file, "utf8");
    for (const line of findOccurrences(text, IDENTIFIER)) {
      errors.push(`${file}:${line}: references "${IDENTIFIER}" — never set via an inline CLI flag/override (test-plan §9b)`);
    }
    for (const line of findOccurrences(text, CLI_KEBAB_FLAG)) {
      errors.push(`${file}:${line}: references "${CLI_KEBAB_FLAG}" — never set via an inline CLI flag/override (test-plan §9b)`);
    }
  }

  return {
    errors,
    stats: {
      vitestConfigsScanned: configFiles.length,
      npmScriptsScanned: Object.keys(scripts).length,
      workflowsScanned: workflowFiles.length,
    },
  };
}

function main() {
  const { errors, stats } = checkUnhandledErrors();
  console.log(
    `vitest-unhandled-errors: ${stats.vitestConfigsScanned} vitest config(s) · ${stats.npmScriptsScanned} npm script(s) · ${stats.workflowsScanned} workflow file(s) scanned`,
  );
  if (errors.length) {
    console.error(`\n✗ vitest-unhandled-errors check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("✓ vitest-unhandled-errors check passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
