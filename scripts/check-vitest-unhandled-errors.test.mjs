// ABOUTME: node:test suite for check-vitest-unhandled-errors.mjs — proves the gate fails when
// ABOUTME: `dangerouslyIgnoreUnhandledErrors` appears anywhere in scope, and passes on a clean tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  IDENTIFIER,
  CLI_KEBAB_FLAG,
  findVitestConfigFiles,
  findWorkflowFiles,
  checkUnhandledErrors,
} from "./check-vitest-unhandled-errors.mjs";

// Builds a scratch repo root with the given files. `configs` is a map of repo-root filename ->
// content (e.g. "vitest.config.ts"); `scripts` is the package.json `scripts` object; `workflows` is
// a map of `.github/workflows/<name>.yml` filename -> content.
function scaffold({ configs = {}, scripts = { test: "vitest run" }, workflows = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emend-unhandled-"));
  for (const [name, content] of Object.entries(configs)) {
    writeFileSync(join(root, name), content);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "scratch", scripts }, null, 2));
  if (Object.keys(workflows).length > 0) {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    for (const [name, content] of Object.entries(workflows)) {
      writeFileSync(join(root, ".github/workflows", name), content);
    }
  }
  return root;
}

const CLEAN_VITEST_CONFIG = `import { defineConfig } from "vite";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
`;

function cleanScaffold(extra = {}) {
  return scaffold({
    configs: { "vitest.config.ts": CLEAN_VITEST_CONFIG, "vitest.perf.config.ts": CLEAN_VITEST_CONFIG },
    workflows: { "ci.yml": "on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n" },
    ...extra,
  });
}

test("a config that sets dangerouslyIgnoreUnhandledErrors: true is detected and fails", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": `export default { test: { dangerouslyIgnoreUnhandledErrors: true } };\n`,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /vitest\.config\.ts:1:/);
    assert.match(errors[0], new RegExp(IDENTIFIER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a config that sets dangerouslyIgnoreUnhandledErrors to any other value still fails", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": `export default { test: { dangerouslyIgnoreUnhandledErrors: process.env.CI ? false : true } };\n`,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean tree passes with zero errors", () => {
  const root = cleanScaffold();
  try {
    const { errors, stats } = checkUnhandledErrors({ repoRoot: root });
    assert.deepEqual(errors, []);
    assert.equal(stats.vitestConfigsScanned, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly-added third config file is found by the glob, not a hard-coded pair", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": CLEAN_VITEST_CONFIG,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
      "vitest.integration.config.ts": `export default { test: { dangerouslyIgnoreUnhandledErrors: true } };\n`,
    },
  });
  try {
    const { errors, stats } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(stats.vitestConfigsScanned, 3);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /vitest\.integration\.config\.ts:1:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a third clean config file added alongside the pair does not trip the check", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": CLEAN_VITEST_CONFIG,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
      "vitest.integration.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors, stats } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(stats.vitestConfigsScanned, 3);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commented-out occurrence still fails (fail-closed on ambiguity, by design)", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": `export default {\n  test: {\n    // dangerouslyIgnoreUnhandledErrors: true,\n    include: ["src/**/*.test.ts"],\n  },\n};\n`,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /vitest\.config\.ts:3:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a string-literal occurrence still fails (fail-closed on ambiguity, by design)", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": `export default { note: "never set dangerouslyIgnoreUnhandledErrors here" };\n`,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an npm script that passes the CLI flag is detected", () => {
  const root = cleanScaffold({
    scripts: { test: "vitest run --dangerouslyIgnoreUnhandledErrors" },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /package\.json/);
    assert.match(errors[0], /script "test"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow run step that passes the CLI flag is detected", () => {
  const root = cleanScaffold({
    workflows: {
      "ci.yml": "on: push\njobs:\n  test:\n    steps:\n      - run: npx vitest run --dangerouslyIgnoreUnhandledErrors\n",
    },
  });
  try {
    const { errors, stats } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(stats.workflowsScanned, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ci\.yml:5:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #2121 review, Important 1: cac (vitest's CLI arg parser) camelizes a dashed flag name BEFORE its
// unknown-option check, so `--dangerously-ignore-unhandled-errors` is a live, accepted second spelling
// of the same option on the two CLI surfaces — not a silently-dropped unknown flag. Verified by
// execution against the installed vitest 4.1 CLI (see the script's header comment); these tests pin
// the CLI-kebab-flag pattern the reviewer's plant proved was missing.

test("an npm script that passes the kebab-case CLI flag is detected", () => {
  const root = cleanScaffold({
    scripts: { test: "vitest run --dangerously-ignore-unhandled-errors" },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /package\.json/);
    assert.match(errors[0], /script "test"/);
    assert.match(errors[0], new RegExp(CLI_KEBAB_FLAG.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow run step that passes the kebab-case CLI flag is detected", () => {
  const root = cleanScaffold({
    workflows: {
      "ci.yml": "on: push\njobs:\n  test:\n    steps:\n      - run: npx vitest run --dangerously-ignore-unhandled-errors\n",
    },
  });
  try {
    const { errors, stats } = checkUnhandledErrors({ repoRoot: root });
    assert.equal(stats.workflowsScanned, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ci\.yml:5:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vitest config that would need the kebab-case flag spelling is out of scope (config keys are always camelCase)", () => {
  // The kebab-case pattern is CLI-surface-only by design — a JS/TS object key can never be spelled
  // in kebab-case, so this is not a coverage gap, just a confirmation the second pattern isn't
  // applied where it can never legitimately fire.
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": `export default { test: { note: "${CLI_KEBAB_FLAG}" } };\n`,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
    },
  });
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an occurrence in a file outside scope (e.g. src/) is not scanned at all", () => {
  const root = cleanScaffold();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/thing.ts"), `// discussing dangerouslyIgnoreUnhandledErrors in prose is fine here\n`);
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVitestConfigFiles ignores a similarly-named non-vitest file", () => {
  const root = cleanScaffold({
    configs: {
      "vitest.config.ts": CLEAN_VITEST_CONFIG,
      "vitest.perf.config.ts": CLEAN_VITEST_CONFIG,
      "notvitest.config.ts": `export default { test: { dangerouslyIgnoreUnhandledErrors: true } };\n`,
    },
  });
  try {
    const files = findVitestConfigFiles(root);
    assert.equal(files.length, 2);
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.deepEqual(errors, []); // out of scope by design — see the script's header comment
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findWorkflowFiles only looks at .github/workflows", () => {
  const root = cleanScaffold();
  try {
    const files = findWorkflowFiles(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /ci\.yml$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty repo root (no vitest configs at all) is a hard error, not a silent pass", () => {
  const root = mkdtempSync(join(tmpdir(), "emend-unhandled-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.ok(errors.some((e) => /no vitest config files found/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #2121 review Minor: the vacuity guard originally covered only the vitest-config-files surface —
// an unparseable package.json or a missing .github/workflows silently scanned as "zero" and still
// printed the pass line. These pin the two guards added to close that gap.

test("an unparseable package.json is a hard error, not a silent pass", () => {
  const root = cleanScaffold();
  try {
    writeFileSync(join(root, "package.json"), "{ not valid json");
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.ok(errors.some((e) => /package\.json.*could not be read\/parsed as JSON/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero workflow files under .github/workflows is a hard error, not a silent pass", () => {
  const root = mkdtempSync(join(tmpdir(), "emend-unhandled-noworkflows-"));
  writeFileSync(join(root, "vitest.config.ts"), CLEAN_VITEST_CONFIG);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  try {
    const { errors } = checkUnhandledErrors({ repoRoot: root });
    assert.ok(errors.some((e) => /no workflow files found under \.github\/workflows/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
