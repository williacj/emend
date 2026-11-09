// ABOUTME: Tests package.json's race-free `pretest` wiring (issues #486/#1442) — `npm run typecheck` catching a
// ABOUTME: type error is not enough on its own: `npm test` must run it too, or a type
// ABOUTME: error can merge to main unnoticed exactly as it did in #486's escape (introduced by #362/#482,
// ABOUTME: found only by a reviewer manually running `tsc --noEmit` outside either mandated suite).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readPackageScripts } from "./package-scripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

test("npm test wires the TypeScript typecheck ahead of vitest via a pretest script that npm runs automatically before test — no extra CI wiring needed", () => {
  const scripts = readPackageScripts();
  assert.equal(
    scripts.pretest,
    "tsc --noEmit",
    'expected a "pretest" npm script running exactly "tsc --noEmit" so `npm test` typechecks before vitest runs a single test',
  );
});

// Proves the wiring above has teeth without putting a deliberate error under src/, where a concurrent
// production pretest could observe it (#1442). The fixture config includes src/ plus one invalid file
// outside src/; the ordinary command still sees only the production tree.
const CLEAN_PRETEST = "npm run pretest --silent";
const INVALID_PRETEST =
  "npm run pretest --silent -- --project scripts/fixtures/pretest-type-error/tsconfig.json";

function runPretest(command) {
  return new Promise((resolve, reject) => {
    // Single command string (no separate args array) with shell:true — avoids Node's DEP0190
    // (args-array + shell) deprecation warning; every token here is a static literal, nothing
    // interpolated, so there is nothing for a shell to misinterpret.
    const child = spawn(command, {
      cwd: REPO_ROOT,
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("an isolated real type error fails its pretest while a concurrent production pretest stays green", async () => {
  const [result, cleanResult] = await Promise.all([
    runPretest(INVALID_PRETEST),
    runPretest(CLEAN_PRETEST),
  ]);
  // A non-zero exit alone would also pass if `tsc` were simply unresolvable (e.g. no `node_modules/`)
  // — "the tool is missing" is not "the tool caught the error". Assert on tsc's actual diagnostic.
  assert.notEqual(
    result.status,
    0,
    `expected the fixture pretest to fail with a deliberate type error; stdout: ${result.stdout}`,
  );
  assert.match(
    result.stdout,
    /TS2322/,
    `expected tsc's own diagnostic code TS2322 in stdout — a bare non-zero exit could also mean tsc itself failed to run; stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.match(
    result.stdout,
    /pretest-type-error[\\/]src[\\/]probe\.ts/,
    `expected the fixture's own path in tsc's diagnostic output; stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(
    cleanResult.status,
    0,
    `expected the concurrent production pretest to pass; stdout: ${cleanResult.stdout}\nstderr: ${cleanResult.stderr}`,
  );
});
