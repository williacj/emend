// ABOUTME: Verifies the capture harness's npm entry: a scenario and an output folder given as arguments
// ABOUTME: take the place of EMEND_ALIGNMENT_SCENARIO and EMEND_ALIGNMENT_OUTPUT, which still apply without them.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { alignmentEnvironment, scenarioSelected } from "./capture-design-alignment-state.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("a scenario argument selects the scenarios the same filter selects from the environment", () => {
  const fromArgument = alignmentEnvironment(["=toolbar"], {}).EMEND_ALIGNMENT_SCENARIO;
  const fromEnvironment = alignmentEnvironment([], { EMEND_ALIGNMENT_SCENARIO: "=toolbar" }).EMEND_ALIGNMENT_SCENARIO;
  assert.equal(fromArgument, "=toolbar");
  for (const name of ["win toolbar", "mac toolbar", "win compact toolbar", "mac composer voice error"]) {
    assert.equal(scenarioSelected(fromArgument, name), scenarioSelected(fromEnvironment, name), name);
  }
});

test("a scenario argument wins over EMEND_ALIGNMENT_SCENARIO", () => {
  assert.equal(alignmentEnvironment(["14b model row"], { EMEND_ALIGNMENT_SCENARIO: "j10" }).EMEND_ALIGNMENT_SCENARIO, "14b model row");
});

test("an output argument sets the capture folder in place of EMEND_ALIGNMENT_OUTPUT", () => {
  const settings = alignmentEnvironment(["dark voice", "docs/alignment-voice-dark"], { EMEND_ALIGNMENT_OUTPUT: "elsewhere" });
  assert.equal(settings.EMEND_ALIGNMENT_OUTPUT, "docs/alignment-voice-dark");
});

test("without arguments the environment's scenario and output are kept as they are", () => {
  const environment = { EMEND_ALIGNMENT_SCENARIO: "j10", EMEND_ALIGNMENT_OUTPUT: "docs/alignment-refresh20-j10" };
  assert.deepEqual(alignmentEnvironment([], environment), environment);
  assert.deepEqual(alignmentEnvironment([], {}), {});
});

test("an empty scenario argument leaves every scenario selected", () => {
  const settings = alignmentEnvironment([""], {});
  assert.equal(scenarioSelected(settings.EMEND_ALIGNMENT_SCENARIO, "win toolbar"), true);
});

test("the npm script runs the entry that applies the arguments before the harness loads", () => {
  const scripts = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts;
  assert.equal(scripts["capture:alignment"], "node scripts/capture-alignment.mjs");
  const entry = readFileSync(join(repository, "scripts/capture-alignment.mjs"), "utf8");
  const applied = entry.indexOf("alignmentEnvironment(process.argv.slice(2), process.env)");
  const loaded = entry.indexOf('import("./capture-design-alignment.mjs")');
  assert.ok(applied > -1, "the entry applies the command-line arguments");
  assert.ok(loaded > applied, "the harness loads only after the arguments are applied");
});

// Runs the real npm script. A scenario that matches nothing makes the harness write an empty
// measurements.json to its output folder and then refuse, naming the filter it received.
function runNpmCapture(commandLine, environment) {
  const folder = mkdtempSync(join(tmpdir(), "emend-alignment-arguments-"));
  const outputFolder = join(folder, "capture");
  const fill = (value) => value === "<output>" ? outputFolder : value;
  const base = { ...process.env };
  delete base.EMEND_ALIGNMENT_SCENARIO;
  delete base.EMEND_ALIGNMENT_OUTPUT;
  const result = spawnSync("npm", ["run", "capture:alignment", "--silent", "--", ...commandLine.map(fill)], {
    cwd: repository,
    encoding: "utf8",
    env: { ...base, ...Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, fill(value)])) },
  });
  const written = join(outputFolder, "measurements.json");
  const measurements = existsSync(written) ? JSON.parse(readFileSync(written, "utf8")) : null;
  rmSync(folder, { recursive: true, force: true });
  return { result, measurements };
}

test("npm run capture:alignment -- <scenario> <output> hands both arguments to the harness", () => {
  const { result, measurements } = runNpmCapture(["=no-such-scenario-argument", "<output>"], {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No capture scenario matched =no-such-scenario-argument/);
  assert.ok(measurements, "the capture was written to the output folder given as an argument");
  assert.deepEqual(measurements.captures, {});
});

test("without arguments the npm script reads EMEND_ALIGNMENT_SCENARIO and EMEND_ALIGNMENT_OUTPUT", () => {
  const { result, measurements } = runNpmCapture([], {
    EMEND_ALIGNMENT_SCENARIO: "=no-such-scenario-environment",
    EMEND_ALIGNMENT_OUTPUT: "<output>",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No capture scenario matched =no-such-scenario-environment/);
  assert.ok(measurements, "the capture was written to the output folder the environment names");
});
