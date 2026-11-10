// ABOUTME: node:test suite for check-test-matrix.mjs — proves the enforcement gate fails on a bad matrix and passes on a good one.
// ABOUTME: Run with `npm run test:scripts` (the live gate is the Windows self-hosted workflow's tooling self-test step); no external test deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseMatrix, findOrphanRows, extractRequiredIds, findTest, checkMatrix, parseCliArgs, splitTestId, rustModuleSegments, rustExpectedCrateBinary, findRustCrateManifests, CODE_KINDS } from "./check-test-matrix.mjs";
import { FILE_BOUND_KINDS, RESULT_KINDS, decodeArtifact, parseCargoTestOutput, parseNodeResultsJsonl, parsePlaywrightJson, parseVitestJson, readExecutionArtifacts, stripAnsiEscapes } from "./test-execution-results.mjs";

// A minimal spec/test-plan pair: three required FRs (one of them a cut/descoped
// FR with NO priority tag — must still be required) and one required property.
const SPEC = `## 3. Functional Requirements
- FR-ED-1 (MUST): editor.
- FR-X-2 (MUST): secrets. (references FR-ED-1 should not be double-counted)
- FR-ED-6: Cut from v1: no priority tag, must still be required.
`;
const TEST_PLAN = `## 2. Properties
- **P1 No drift:** identity.
`;

function scaffold(matrixMd, { rust = "", vitest = "", perf = "", node = "", e2e = "", artifacts = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emend-matrix-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/functional-spec.md"), SPEC);
  writeFileSync(join(root, "docs/test-plan.md"), TEST_PLAN);
  writeFileSync(join(root, "docs/test-matrix.md"), matrixMd);
  if (rust) {
    mkdirSync(join(root, "src-tauri/src"), { recursive: true });
    writeFileSync(join(root, "src-tauri/src/lib.rs"), rust);
  }
  if (vitest) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/thing.test.ts"), vitest);
  }
  if (perf) {
    mkdirSync(join(root, "tests/perf"), { recursive: true });
    writeFileSync(join(root, "tests/perf/thing.perf.test.ts"), perf);
  }
  if (node) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/thing.test.mjs"), node);
  }
  if (e2e) {
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, "e2e/thing.spec.mjs"), e2e);
  }
  // `artifacts` is a { filename: contents } map written into <root>/results — the same
  // shape CI hands the checker through `--artifacts`. An empty object still creates the
  // directory, which is how "the runner produced nothing" is expressed.
  if (artifacts) {
    mkdirSync(join(root, "results"), { recursive: true });
    for (const [name, contents] of Object.entries(artifacts)) {
      writeFileSync(join(root, "results", name), contents);
    }
  }
  return root;
}

/**
 * A vitest JSON-reporter document naming one executed title per entry. Each entry may name its
 * own `file`, because vitest groups results BY file and a matrix id is credited only by the file
 * that defines it (#2250) — a fixture that could emit only one file could not express the
 * cross-file collision at all. The default is the absolute spelling vitest really emits.
 */
function vitestArtifact(entries) {
  const byFile = new Map();
  for (const { title, ancestors = [], status = "passed", file = "/repo/src/thing.test.ts" } of entries) {
    const bucket = byFile.get(file) ?? [];
    bucket.push({ ancestorTitles: ancestors, fullName: [...ancestors, title].join(" > "), title, status });
    byFile.set(file, bucket);
  }
  return JSON.stringify({
    numTotalTests: entries.length,
    testResults: [...byFile].map(([name, assertionResults]) => ({ name, status: "passed", assertionResults })),
  });
}

/**
 * A Playwright JSON-reporter document: one file suite, an optional describe suite, leaf specs.
 * `file` is the spelling the report uses for the source — Playwright makes it relative to its own
 * `rootDir`, which for this repo's `testDir: "./e2e"` is a bare `thing.spec.mjs`, SHORTER than the
 * repo-relative path the source walk produces. Overridable so both spellings get a cell.
 */
function playwrightArtifact(entries, { describeTitle = null, file = "e2e/thing.spec.mjs" } = {}) {
  const specs = entries.map(({ title, status = "passed" }) => ({
    title,
    file,
    ok: status === "passed",
    tests: [{ status: status === "passed" ? "expected" : "unexpected", results: [{ status }] }],
  }));
  const fileSuite = { title: file, file, specs: [], suites: [] };
  if (describeTitle) fileSuite.suites.push({ title: describeTitle, file, specs, suites: [] });
  else fileSuite.specs = specs;
  return JSON.stringify({ config: {}, suites: [fileSuite], errors: [], stats: {} });
}

/** libtest's stable human-readable output — what `cargo test` prints on the pinned stable toolchain. */
function cargoArtifact(entries) {
  return [
    "running " + entries.length + " tests",
    ...entries.map(({ path, outcome = "ok" }) => `test ${path} ... ${outcome}`),
    "test result: ok. " + entries.length + " passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
    "",
  ].join("\n");
}

/**
 * A libtest transcript WITH cargo's own `Running` headers merged in ahead of each target's own
 * result lines — the shape a real `cargo test --workspace 2>&1` capture has once the workflow
 * merges cargo's stderr into the artifact (#2308), not the stdout-only shape `cargoArtifact` above
 * models. Each target names its own binary; the hash suffix is fixed and arbitrary (cargo's own is
 * content-addressed and never checked, only stripped).
 */
function cargoArtifactWithTargets(targets) {
  // Each target's own result lines are exactly what `cargoArtifact` already builds; only the
  // `Running` header (and the blank line cargo prints after it) is new here.
  return targets
    .map(({ targetSource, binary, entries }) => `     Running ${targetSource} (src-tauri\\target\\debug\\deps\\${binary}-0123456789abcdef.exe)\n\n${cargoArtifact(entries)}`)
    .join("");
}

/** The JSONL our node:test reporter appends — one line per finished test or suite. */
function nodeArtifact(entries) {
  return entries.map(({ name, status = "pass", file = "scripts/thing.test.mjs" }) => JSON.stringify({ name, status, file })).join("\n") + "\n";
}

const HEADER = "| ID | Requirement / invariant | Test kind | Test IDs | Status | Notes |\n|--|--|--|--|--|--|\n";

// The shape of the real defect (docs/test-matrix.md:157, born in ff286b51): a COMPLETE
// table — every required FR/property row present — then a blank line, then further rows.
//
// The `NI-*` IDs are load-bearing, not cosmetic. An orphan whose ID is a required
// FR/property is caught anyway by the completeness half ("missing matrix row for …"), so a
// fixture built that way reports errors pre-fix for an unrelated reason and cannot express
// this defect at all. `NI-*` IDs have no completeness backstop — exactly like the four real
// orphans this fixture models — so the pre-fix checker is fully green here. The orphan rows
// also name tests that really exist, so no downstream "test not found" can stand in for the
// gate firing.
//
// 1-based line numbers: header 1, separator 2, rows 3-6, blank 7, orphaned rows 8 and 9.
const DETACHED_MATRIX =
  HEADER +
  "| FR-ED-1 | editor | rust | alive | present | |\n" +
  "| FR-X-2 | secrets | pending | — | pending | |\n" +
  "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
  "| P1 | no drift | pending | — | pending | |\n" +
  "\n" +
  "| NI-detached-one | first invariant below the blank line | rust | also_alive | present | |\n" +
  "| NI-detached-two | second invariant below it | rust | third_alive | present | |\n";

// Byte-identical to DETACHED_MATRIX minus the one blank line, so the blank line is the
// only variable between them.
const ATTACHED_MATRIX = DETACHED_MATRIX.replace("|\n\n| NI-detached-one", "|\n| NI-detached-one");

const THREE_LIVE_TESTS = "#[test]\nfn alive() {}\n#[test]\nfn also_alive() {}\n#[test]\nfn third_alive() {}\n";

test("parseMatrix reads columns by header, ignoring order and markdown", () => {
  const md = "| Status | ID | Test kind | Test IDs | Requirement / invariant |\n|--|--|--|--|--|\n| present | `FR-ED-1` | rust | `foo`, `bar` | editor |\n";
  const rows = parseMatrix(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "FR-ED-1");
  assert.equal(rows[0].kind, "rust");
  assert.deepEqual(rows[0].testIds, ["foo", "bar"]);
  assert.equal(rows[0].status, "present");
});

test("parseMatrix treats — and blanks as no named tests", () => {
  const rows = parseMatrix(HEADER + "| FR-X-2 | secrets | pending | — | pending | |\n");
  assert.deepEqual(rows[0].testIds, []);
});

test("parseMatrix returns a bare array of rows", () => {
  // Tripwire for downstream consumers that import
  // parseMatrix directly: a change to this return shape must fail loudly here rather than
  // break them silently.
  const parsed = parseMatrix(HEADER + "| FR-ED-1 | editor | rust | alive | present | |\n");
  assert.ok(Array.isArray(parsed), `expected an array, got ${typeof parsed}`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "FR-ED-1");
});

test("findOrphanRows reports a row detached from its table by a blank line, with its line number", () => {
  assert.equal(parseMatrix(DETACHED_MATRIX).length, 4);
  assert.deepEqual(
    findOrphanRows(DETACHED_MATRIX).map((o) => o.line),
    [8, 9],
  );
});

test("a detached row's orphan record carries its ID so the failure is diagnosable", () => {
  assert.deepEqual(
    findOrphanRows(DETACHED_MATRIX).map((o) => o.id),
    ["NI-detached-one", "NI-detached-two"],
  );
});

test("extractRequiredIds pulls FR definitions (incl. untagged/descoped) and properties, deduped", () => {
  const { frs, props } = extractRequiredIds({ specText: SPEC, testPlanText: TEST_PLAN });
  assert.deepEqual(frs.sort(), ["FR-ED-1", "FR-ED-6", "FR-X-2"]);
  assert.deepEqual(props, ["P1"]);
});

test("findTest distinguishes active, ignored, and missing rust tests", () => {
  const root = scaffold(HEADER, { rust: "#[test]\nfn alive() {}\n#[ignore]\n#[test]\nfn dead() {}\n" });
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "alive" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "dead" }), "disabled");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "ghost" }), "missing");
  rmSync(root, { recursive: true, force: true });
});

test("findTest indexes every compact Rust definition and preserves ignore state (#1933)", () => {
  const rust = [
    "#[test]",
    "fn first() {} #[test] fn second() {}",
    "",
    "#[ignore]",
    "#[test]",
    "fn skipped_first() {} #[test] fn skipped_second() {}",
  ].join("\n");
  const root = scaffold(HEADER, { rust });
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "first" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "second" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "skipped_first" }), "disabled");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "skipped_second" }), "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("findTest reads #[ignore] structurally — long reason + extra attrs don't slip past", () => {
  // A char-window scan would miss these: the `#[ignore = "…"]` reason is long,
  // and there are attributes/doc comments between the ignore and the fn.
  const rust = [
    '#[ignore = "this reason string is deliberately much longer than any fixed eighty-character scan window would ever tolerate, and then some"]',
    "#[test]",
    "fn long_reason() {}",
    "",
    "/// doc comment",
    "#[ignore]",
    "#[cfg(test)]",
    "#[test]",
    "fn attrs_between() {}",
  ].join("\n");
  const root = scaffold(HEADER, { rust });
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "long_reason" }), "disabled");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "attrs_between" }), "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("findTest treats #[cfg_attr(<cond>, ignore)] as disabled, but leaves other cfg_attr active", () => {
  const rust = [
    '#[cfg_attr(target_os = "windows", ignore)]',
    "#[test]",
    "fn win_ignored() {}",
    "",
    "#[cfg_attr(miri, ignore)]",
    "#[test]",
    "fn miri_ignored() {}",
    "",
    // Control: a cfg_attr that applies should_panic, not ignore — must stay active.
    '#[cfg_attr(feature = "x", should_panic)]',
    "#[test]",
    "fn conditionally_panics() {}",
  ].join("\n");
  const root = scaffold(HEADER, { rust });
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "win_ignored" }), "disabled");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "miri_ignored" }), "disabled");
  assert.equal(findTest({ repoRoot: root, kind: "rust", id: "conditionally_panics" }), "active");
  rmSync(root, { recursive: true, force: true });
});

test("findTest matches vitest string titles and flags .skip", () => {
  const root = scaffold(HEADER, { vitest: "it('renders ok', () => {});\ntest.skip('is slow', () => {});\n" });
  assert.equal(findTest({ repoRoot: root, kind: "vitest", id: "renders ok" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "vitest", id: "is slow" }), "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("findTest also scans tests/perf for vitest titles (test-plan §6 benchmark suite, P2b-10a)", () => {
  const root = scaffold(HEADER, { perf: "it('opens within budget', () => {});\n" });
  assert.equal(findTest({ repoRoot: root, kind: "vitest", id: "opens within budget" }), "active");
  rmSync(root, { recursive: true, force: true });
});

// #1239: the title extractor used to stop at a backslash-escaped quote, so a title with a
// legitimate apostrophe — written in source as `'reconcile()\'s disposition …'` — could
// never resolve under its real (unescaped) name. Reverting the matchJsTitle fix reproduces
// the original bug: `findTest` returns "missing" for a test that plainly exists.
test("findTest matches a single-quoted title containing an escaped apostrophe (#1239)", () => {
  const root = scaffold(HEADER, { node: "test('reconcile()\\'s disposition per reason', () => {});\n" });
  assert.equal(findTest({ repoRoot: root, kind: "node", id: "reconcile()'s disposition per reason" }), "active");
  rmSync(root, { recursive: true, force: true });
});

test("findTest matches a double-quoted title containing an escaped double-quote (#1239)", () => {
  const root = scaffold(HEADER, { node: 'test("says \\"hi\\" politely", () => {});\n' });
  assert.equal(findTest({ repoRoot: root, kind: "node", id: 'says "hi" politely' }), "active");
  rmSync(root, { recursive: true, force: true });
});

test("findTest matches a backtick template-literal title, including an escaped backtick (#1239)", () => {
  const root = scaffold(HEADER, { node: "test(`renders a \\`code\\` span`, () => {});\n" });
  assert.equal(findTest({ repoRoot: root, kind: "node", id: "renders a `code` span" }), "active");
  rmSync(root, { recursive: true, force: true });
});

test("findTest flags .skip on a title with an escaped quote as disabled, not missing (#1239)", () => {
  const root = scaffold(HEADER, { node: "test.skip('reconcile()\\'s disposition per reason', () => {});\n" });
  assert.equal(findTest({ repoRoot: root, kind: "node", id: "reconcile()'s disposition per reason" }), "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix's not-found error for a JS test kind notes that dynamic titles can't be statically resolved (#1239)", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | node | built at runtime | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  // A title assembled from a template-literal interpolation: the literal source text never
  // contains "built at runtime", so extraction cannot find it — a fact worth saying, not a
  // silent "not found" that reads like a typo.
  const root = scaffold(md, { node: "test(`built at ${when}`, () => {});\n" });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(
    errors.some((e) => e.includes("built at runtime") && e.includes("not found") && e.includes("template-literal interpolation")),
    errors.join("\n"),
  );
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix PASSES a complete matrix whose named tests exist", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | alive | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, { rust: "#[test]\nfn alive() {}\n" });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.join("\n")}`);
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix reads each test source file once while resolving multiple IDs (#1933)", () => {
  const md =
    HEADER +
    // `first title` is deliberately defined in BOTH source files, so the row has to name the one
    // it means (#2250): before the file binding, "active anywhere in the kind wins" let the live
    // definition in one file mask the `.skip`ped one in the other.
    "| FR-ED-1 | editor | node | scripts/thing.test.mjs::first title, second title | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, {
    node: "test('first title', () => {});\ntest('second title', () => {});\n",
  });
  writeFileSync(join(root, "scripts/disabled.test.mjs"), "test.skip('first title', () => {});\n");

  const reads = new Map();
  const { errors } = checkMatrix({
    repoRoot: root,
    readSourceFile(path, encoding) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return readFileSync(path, encoding);
    },
  });

  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(reads.size, 2, "both node:test source files should be indexed");
  assert.deepEqual([...reads.values()], [1, 1], "each source file should be read exactly once");
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix accepts one escaped-comma test title, not two missing fragments", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | node | keeps one title\\, comma included | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, { node: "test('keeps one title, comma included', () => {});\n" });
  const { errors, stats } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.join("\n")}`);
  assert.equal(stats.namedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix FAILS when a row names a nonexistent test (acceptance criterion)", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | not_written_yet | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, { rust: "#[test]\nfn something_else() {}\n" });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(errors.some((e) => e.includes("not_written_yet") && e.includes("not found")), errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix FAILS when a required FR has no row (completeness)", () => {
  const md = HEADER + "| FR-ED-1 | editor | pending | — | pending | |\n| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md);
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(errors.some((e) => e.includes("FR-X-2") && e.includes("missing matrix row")), errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix FAILS a named test that exists but is ignored (would not run)", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | ignored_one | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, { rust: "#[ignore]\n#[test]\nfn ignored_one() {}\n" });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(errors.some((e) => e.includes("ignored_one") && e.includes("would not run")), errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix FAILS a code kind that names no tests", () => {
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | — | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md);
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(errors.some((e) => e.includes("FR-ED-1") && e.includes("names no test")), errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix FAILS a row detached from its table by a blank line, naming the line", () => {
  // Pre-fix this fixture produced NO errors at all — the two rows and their named tests
  // were dropped silently and the gate reported green while verifying nothing.
  const root = scaffold(DETACHED_MATRIX, { rust: THREE_LIVE_TESTS });
  const { errors } = checkMatrix({ repoRoot: root });
  // `\b` matters: a bare `:8` would also match `:80`.
  assert.ok(errors.some((e) => /test-matrix\.md:8\b/.test(e)), errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("the detached-row failure names the row, not just the line", () => {
  const root = scaffold(DETACHED_MATRIX, { rust: THREE_LIVE_TESTS });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(
    errors.some((e) => e.includes("NI-detached-one") && /test-matrix\.md:\d+/.test(e)),
    errors.join("\n"),
  );
  rmSync(root, { recursive: true, force: true });
});

test("the identical matrix without the blank line still passes", () => {
  // Control: `stats.rows === 6` is what proves the two rows are recovered, not merely
  // un-errored.
  const root = scaffold(ATTACHED_MATRIX, { rust: THREE_LIVE_TESTS });
  const { errors, stats } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.rows, 6);
  rmSync(root, { recursive: true, force: true });
});

test("a second table with its own header after a heading is not a detached row", () => {
  // Control: the real file's shape — nine tables separated by headings and prose. Without
  // this cell a fix that errored on every table boundary would ship green here and explode
  // on the real matrix.
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | alive | present | |\n" +
    "\n## Another section\n\n" +
    HEADER +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, { rust: THREE_LIVE_TESTS });
  const { errors, stats } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.rows, 4);
  rmSync(root, { recursive: true, force: true });
});

test("a detached row is not counted in the row total the check reports", () => {
  // Control: a detached row must be reported, never silently re-attached to a stale header
  // and folded into the count CI prints.
  const root = scaffold(DETACHED_MATRIX, { rust: THREE_LIVE_TESTS });
  const { stats } = checkMatrix({ repoRoot: root });
  assert.equal(stats.rows, 4);
  rmSync(root, { recursive: true, force: true });
});

// --- Execution evidence (#1814, Route 1 of #1384) ----------------------------
//
// Everything above proves a named test is DEFINED. The block below proves the second,
// stronger half: that it also RAN. #1124 is the defect these cells exist to catch — 16
// `e2e/acceptance.spec.mjs` rows read `present` for a month while no CI job invoked that
// suite, and every existence-only cell above was green throughout.

// A complete matrix (all required FRs/properties covered) whose one code row is under test.
function executionMatrix(row) {
  return (
    HEADER +
    row +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n"
  );
}

// A run BLOCKS only on the kinds it declares it enforces, so every cell names the kind it is
// exercising rather than leaning on a default. `--require-kinds` is what the workflow passes.
function checkWithArtifacts(root, requireKinds) {
  return checkMatrix({ repoRoot: root, artifactsDir: join(root, "results"), requireKinds });
}

test("checkMatrix FAILS a row whose named test exists in source but ran in NO artifact (#1124's shape)", () => {
  // The exact #1124 configuration: the test is real and active, so every existence check
  // above is green — and the suite that would have run it produced no evidence of doing so.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | never actually ran | present | |\n"), {
    vitest: "it('never actually ran', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "some other test" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  assert.ok(
    errors.some((e) => e.includes("never actually ran") && e.includes("did not execute")),
    `expected a "did not execute" error naming "never actually ran"; errors were:\n${errors.join("\n")}`,
  );
  // Control: with no artifacts the same matrix is clean, which is precisely the weaker
  // guarantee #1384 corrected §9 down to. If this half ever fails, the fixture stopped
  // isolating execution from existence.
  assert.deepEqual(checkMatrix({ repoRoot: root }).errors, []);
  rmSync(root, { recursive: true, force: true });
});

test("the same unexecuted test is a WARNING, not a failure, for a kind the run only observes", () => {
  // A venue enforces what it can prove. A single-platform gate cannot execute another
  // platform's tests, so blocking on them would report "unproven" where the truth is
  // "unprovable here" — but staying silent would be the #1384 overclaim in reverse. The
  // finding is reported either way; only its severity moves.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | never actually ran | present | |\n"), {
    vitest: "it('never actually ran', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "some other test" }]) },
  });
  const { errors, warnings, stats } = checkWithArtifacts(root, []);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    warnings.some((w) => w.includes("never actually ran") && w.includes("did not execute")),
    `expected an observed-kind warning naming "never actually ran"; warnings were:\n${warnings.join("\n")}`,
  );
  assert.deepEqual(stats.enforcedKinds, []);
  assert.deepEqual(stats.observedKinds, ["vitest"]);
  rmSync(root, { recursive: true, force: true });
});

test("checkMatrix PASSES the same row once the artifact shows the test executed", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "really ran" }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  assert.deepEqual(stats.enforcedKinds, ["vitest"]);
  rmSync(root, { recursive: true, force: true });
});

test("a failing test still counts as executed — the matrix gate proves it ran, its own suite proves it passed", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | ran and failed | present | |\n"), {
    vitest: "it('ran and failed', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "ran and failed", status: "failed" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("a test the runner SKIPPED at runtime did not execute, even though it appears in the artifact", () => {
  // The near-match this gate must reject: present in the results document, but with a
  // status that means no assertion ever ran. Counting mere appearance would let a
  // `describe.skip` at the top of a file read as full coverage.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | skipped at runtime | present | |\n"), {
    vitest: "it('skipped at runtime', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "skipped at runtime", status: "pending" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  assert.ok(
    errors.some((e) => e.includes("skipped at runtime") && e.includes("did not execute")),
    `expected a "did not execute" error naming "skipped at runtime"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a near-match title is not execution evidence — the comparison is exact, not fuzzy", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | keeps the caret in view | present | |\n"), {
    vitest: "it('keeps the caret in view', () => {});\n",
    artifacts: {
      // Differs by case, by trailing space, and by a one-word suffix. None may satisfy the row.
      "vitest-ci.json": vitestArtifact([
        { title: "Keeps the caret in view" },
        { title: "keeps the caret in view " },
        { title: "keeps the caret in view always" },
      ]),
    },
  });
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  assert.ok(
    errors.some((e) => e.includes("keeps the caret in view") && e.includes("did not execute")),
    `expected a "did not execute" error naming "keeps the caret in view"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a present-status row naming a test quarantined out of the blocking gate FAILS (CJ, 2026-09-02)", () => {
  // #1403's quarantine mechanism is `playwright test --grep-invert @quarantine`, so a
  // quarantined case is simply ABSENT from the gating run's JSON — indistinguishable, to
  // this checker, from a suite that never ran. That is the point: both must fail `present`.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | quarantined journey | present | |\n"), {
    e2e: "test('quarantined journey', { tag: '@quarantine' }, async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "a journey that still gates" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["e2e"]);
  assert.ok(
    errors.some((e) => e.includes("quarantined journey") && e.includes("present-not-gating")),
    `expected a "present-not-gating" error naming "quarantined journey"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("present-not-gating is what lets that same quarantined row pass", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | quarantined journey | present-not-gating | |\n"), {
    e2e: "test('quarantined journey', { tag: '@quarantine' }, async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "a journey that still gates" }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["e2e"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.notGatingTests, 1);
  rmSync(root, { recursive: true, force: true });
});

// The split-row shape #2234 relies on. `present-not-gating` is ROW-level, so a row that mixes
// gating tests with one that never runs is honest under neither status. These two cells pin both
// halves of that: what splitting buys, and what the combined row costs under either label.
//
// One fixture for all five scaffolds below (`root`, `regressed`, and the three `combined(...)`
// calls), hoisted so "the SAME two tests" is structural rather than clerical — the second cell's
// whole claim is that it differs from the first only in row shape. `fold_stays_within_the_budget`
// is deliberately a bare `fn`: it models a test-plan §6 benchmark assertion, which is a plain
// function the bench binary's own `main` calls (`harness = false`), never a `#[test]`. That is
// exactly why no `cargo test` run on any platform executes it.
const SPLIT_ROW_SOURCES = "#[test]\nfn folds_in_causal_order() {}\nfn fold_stays_within_the_budget() {}\n";
const splitRowFixture = (executed) => ({
  rust: SPLIT_ROW_SOURCES,
  artifacts: { "rust-windows.txt": cargoArtifact(executed.map((name) => ({ path: `store::tests::${name}` }))) },
});
// `parseCargoTestOutput` derives `seen` only from per-test result lines — the header and summary
// libtest prints contribute nothing — so an empty result set is `seen === 0`, and
// `readExecutionArtifacts` rejects that as an unreadable artifact rather than reading it as a run
// that executed nothing. Naming an unrelated test that still runs is what keeps this fixture a
// readable artifact at all.
const RAN_ONLY_THE_GATING_TEST = ["folds_in_causal_order"];
const RAN_NEITHER = ["an_unrelated_test_that_still_runs"];

test("a requirement split across a gating row and a non-gating row passes as both (CJ, 2026-09-03)", () => {
  // The matrix already lets one requirement span rows — `NI-frontmatter-fold` / `-perf`, split by
  // #1814 for exactly this reason — so the split needs no new mechanism. This cell makes that a
  // pinned guarantee rather than an observation: it must keep holding for the two `[[bench]]`
  // rows CJ's 2026-09-03 ruling created.
  const split =
    "| FR-ED-1 | editor | rust | folds_in_causal_order | present | |\n" +
    "| FR-ED-1-bench | editor, its §6 benchmark | rust | fold_stays_within_the_budget | present-not-gating | |\n";

  const root = scaffold(executionMatrix(split), splitRowFixture(RAN_ONLY_THE_GATING_TEST));
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.notGatingTests, 1);
  rmSync(root, { recursive: true, force: true });

  // And the half that is the whole point of splitting rather than relabelling: the gating row
  // still has to execute. Without this the cell would pass on any pair of rows the constituent
  // cells already cover, and the guarantee the split is said to preserve would go unpinned.
  const regressed = scaffold(executionMatrix(split), splitRowFixture(RAN_NEITHER));
  const stillGating = checkWithArtifacts(regressed, ["rust"]).errors;
  assert.ok(
    stillGating.some((e) => e.includes("folds_in_causal_order") && e.includes("did not execute")),
    `expected the split gating row to still fail when its own test stops running; errors were:\n${stillGating.join("\n")}`,
  );
  assert.ok(
    !stillGating.some((e) => e.includes("fold_stays_within_the_budget")),
    "the non-gating row must stay silent in the same run, or the split has bought nothing",
  );
  rmSync(regressed, { recursive: true, force: true });
});

test("the same two tests in ONE row are honest under neither status — #2284 closes the mixed-relabel hole", () => {
  // `present` fails, correctly, on the test nothing ran. `present-not-gating` used to pass —
  // and silently dropped the execution guarantee from the gating test beside it, with nothing
  // in the run saying so. That silence was the exact hole #2284 exists to close: CJ's #2234
  // ruling forbids relabelling a mixed row to escape the gate, and until this fix the checker
  // accepted it anyway the instant AT LEAST ONE of the row's tests still executed.
  const combined = (status, executed) =>
    scaffold(
      executionMatrix(
        `| FR-ED-1 | editor | rust | folds_in_causal_order, fold_stays_within_the_budget | ${status} | |\n`,
      ),
      splitRowFixture(executed),
    );

  const asPresent = combined("present", RAN_ONLY_THE_GATING_TEST);
  const presentErrors = checkWithArtifacts(asPresent, ["rust"]).errors;
  assert.ok(
    presentErrors.some(
      (e) => e.includes("fold_stays_within_the_budget") && e.includes("did not execute"),
    ),
    "expected the combined `present` row to fail on the test that never ran",
  );
  // The mixed-row check test-plan §9 says never touches a `present` row is `notGatingRow`-gated
  // by construction (the `if (notGatingRow) { … } else { … }` split above); this pins that the
  // "names a mixed row" branch really is unreachable here, not merely that SOME error fires —
  // a bare `.some()` on the execution-gap error alone would pass even if the mixed-row error also
  // fired alongside it, which is not the guarantee the doc claims.
  assert.ok(
    !presentErrors.some((e) => e.includes("names a mixed row")),
    `the "present-not-gating"-only mixed-row check must never fire for a "present" row; errors were:\n${presentErrors.join("\n")}`,
  );
  rmSync(asPresent, { recursive: true, force: true });

  // The relabelled mixed row CJ's ruling forbids: one test genuinely executes, the other
  // genuinely does not, and the row claims `present-not-gating` for both. Before this fix that
  // combination (missedIds.length > 0 && ranAny) fell through both branches of the status check
  // and reported nothing at all — the silence PR #2285's reviewer pinned at this test's old
  // assertion (`assert.deepEqual(errors, [])`). It must now be rejected, naming both which test
  // ran and which did not, so the row-shape question routes back to a human (split it, per
  // CJ's ruling) rather than passing quietly.
  const relabelled = combined("present-not-gating", RAN_ONLY_THE_GATING_TEST);
  const { errors: mixedErrors, stats } = checkWithArtifacts(relabelled, ["rust"]);
  assert.ok(
    mixedErrors.some(
      (e) =>
        e.includes("FR-ED-1")
        && e.includes("present-not-gating")
        && e.includes("folds_in_causal_order")
        && e.includes("fold_stays_within_the_budget"),
    ),
    `expected the relabelled mixed row to be rejected; errors were:\n${mixedErrors.join("\n")}`,
  );
  assert.equal(stats.notGatingTests, 1, "the missed test still counts toward notGatingTests even while the row is rejected");
  rmSync(relabelled, { recursive: true, force: true });

  // The residual this fix does NOT close (test-plan §9 (d)): if EVERY test in the row stops
  // executing — including the genuinely-gating one — the row still reads as an honestly
  // non-gating row, because nothing in this run distinguishes "every test here is honestly
  // non-gating" from "the gating test broke too". The status is row-level; that gap is
  // documented, not silently widened by this card.
  const allMissed = combined("present-not-gating", RAN_NEITHER);
  const quiet = checkWithArtifacts(allMissed, ["rust"]).errors;
  assert.deepEqual(quiet, [], `expected the fully-non-executing row to stay green; errors were:\n${quiet.join("\n")}`);
  rmSync(allMissed, { recursive: true, force: true });
});

// The adjacent finding routed onto #2284 from PR #2285's review: the Test IDs legend says a
// test-plan §6 bench assertion "may be named only by a present-not-gating row that says so", but
// `extractRust` indexes every `fn` under `src-tauri` regardless of which target's tree it sits
// in, so a `present` row naming a bench-only fn passed existence-checking today. This is a
// STRUCTURAL check — it must fire with no `--artifacts` at all, the same as the "not found" and
// "ignored/skipped" existence errors beside it.
// `dir` and an explicit `path =` line are parameterized so the default-convention case and the
// explicit-`path` case (Cargo's other legal spelling of a bench target's source) share one
// Cargo.toml/bench-file shape instead of two copies of the same boilerplate that could drift.
function writeBenchCrate(
  root,
  {
    dir = "benches",
    pathLine = "",
    headerLine = "[[bench]]\n",
    nameLine = 'name = "comment_fold"\n',
    testLine = "test = false\n",
  } = {},
) {
  mkdirSync(join(root, `src-tauri/${dir}`), { recursive: true });
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "app"\nversion = "0.1.0"\n\n'
      + headerLine
      + nameLine
      + pathLine
      + "harness = false\n"
      + testLine,
  );
  // A real helper (`build_events`) sits beside the sanctioned assertion, exactly like the real
  // `src-tauri/benches/comment_fold.rs` — the check must key on the ROW's status, not merely on
  // "this id happens to live in a bench file".
  writeFileSync(
    join(root, `src-tauri/${dir}/comment_fold.rs`),
    "fn main() {}\n"
      + "fn comment_log_fold_stays_within_the_ten_k_event_budget(median_ms: f64) {}\n"
      + "fn build_events() -> Vec<u8> { Vec::new() }\n",
  );
}

/**
 * Writes a minimal `<root>/<crateDir>/Cargo.toml` — enough to drive `findRustCrateManifests`
 * (`[package]`/`[lib]`/`[[bin]]` `name`). One shared shape for the two #2308 cells that otherwise
 * hand-write near-identical manifests, the same reasoning `writeBenchCrate` above already applies
 * to a `[[bench]]` fixture.
 */
function writeCrateManifest(root, crateDir, { name, lib = null, bin = null } = {}) {
  mkdirSync(join(root, crateDir), { recursive: true });
  let toml = `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;
  if (lib) toml += `\n[lib]\n${lib.name ? `name = "${lib.name}"\n` : ""}${lib.path ? `path = "${lib.path}"\n` : ""}`;
  if (bin) toml += `\n[[bin]]\n${bin.name ? `name = "${bin.name}"\n` : ""}${bin.path ? `path = "${bin.path}"\n` : ""}`;
  writeFileSync(join(root, crateDir, "Cargo.toml"), toml);
}

test("a test-plan §6 bench-only assertion may be named only by a present-not-gating row (test-matrix.md Test IDs legend, #2284)", () => {
  const asPresent = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(asPresent);
  const presentErrors = checkMatrix({ repoRoot: asPresent }).errors;
  assert.ok(
    presentErrors.some(
      (e) =>
        e.includes("FR-ED-1")
        && e.includes("comment_log_fold_stays_within_the_ten_k_event_budget")
        && e.includes("present-not-gating"),
    ),
    `expected a "present" row naming a bench-only assertion to be rejected; errors were:\n${presentErrors.join("\n")}`,
  );
  rmSync(asPresent, { recursive: true, force: true });

  const asNotGating = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present-not-gating | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(asNotGating);
  const honestErrors = checkMatrix({ repoRoot: asNotGating }).errors;
  assert.deepEqual(honestErrors, [], `expected the honestly-labelled row to pass; errors were:\n${honestErrors.join("\n")}`);
  rmSync(asNotGating, { recursive: true, force: true });

  // Control: an ordinary #[test] defined OUTSIDE any bench target is unaffected — this check
  // must not require present-not-gating for every rust row, only for the sanctioned exception.
  const ordinary = scaffold(
    executionMatrix("| FR-ED-1 | editor | rust | some_other_test | present | |\n"),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(ordinary);
  const ordinaryErrors = checkMatrix({ repoRoot: ordinary }).errors;
  assert.deepEqual(ordinaryErrors, [], `expected an ordinary test row to be unaffected; errors were:\n${ordinaryErrors.join("\n")}`);
  rmSync(ordinary, { recursive: true, force: true });

  // Cargo also allows an explicit `path`, overriding the `benches/<name>.rs` default. Both real
  // bench crates in this repo use the default, so this is a distinct axis the real-matrix run
  // never exercises — pinned directly rather than left an untested residual.
  const explicitPath = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(explicitPath, { dir: "perf", pathLine: 'path = "perf/comment_fold.rs"\n' });
  const explicitPathErrors = checkMatrix({ repoRoot: explicitPath }).errors;
  assert.ok(
    explicitPathErrors.some(
      (e) => e.includes("comment_log_fold_stays_within_the_ten_k_event_budget") && e.includes("present-not-gating"),
    ),
    `expected an explicit \`path =\` bench target to be resolved too; errors were:\n${explicitPathErrors.join("\n")}`,
  );
  rmSync(explicitPath, { recursive: true, force: true });
});

// parseBenchTargets is a minimal TOML reader, not a general one — but a `#` comment and a
// single-quoted (literal) string are both ordinary, legal TOML that a real Cargo.toml can use
// on a `[[bench]]` table, and silently mis-parsing either fails OPEN: the bench-only file drops
// out of the set, so a `present` row naming its assertion passes existence-checking instead of
// being rejected. Each cell below pins one such spelling against the same real check this file's
// other bench-only cell uses, not a unit test of parseBenchTargets in isolation, so a regression
// here is caught exactly where CJ's rule is enforced.
test("a trailing comment on a [[bench]] table value does not hide the bench-only target", () => {
  const root = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(root, { testLine: "test = false  # not run in CI\n" });
  const errors = checkMatrix({ repoRoot: root }).errors;
  assert.ok(
    errors.some(
      (e) =>
        e.includes("FR-ED-1")
        && e.includes("comment_log_fold_stays_within_the_ten_k_event_budget")
        && e.includes("present-not-gating"),
    ),
    `expected a trailing comment on \`test = false\` to still register the bench-only target; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a single-quoted (TOML literal) bench target name does not hide the bench-only target", () => {
  const root = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(root, { nameLine: "name = 'comment_fold'\n" });
  const errors = checkMatrix({ repoRoot: root }).errors;
  assert.ok(
    errors.some(
      (e) =>
        e.includes("FR-ED-1")
        && e.includes("comment_log_fold_stays_within_the_ten_k_event_budget")
        && e.includes("present-not-gating"),
    ),
    `expected a single-quoted \`name\` to still register the bench-only target; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a trailing comment on the [[bench]] header line does not hide the whole block", () => {
  const root = scaffold(
    executionMatrix(
      "| FR-ED-1 | editor | rust | comment_log_fold_stays_within_the_ten_k_event_budget | present | |\n",
    ),
    { rust: "#[test]\nfn some_other_test() {}\n" },
  );
  writeBenchCrate(root, { headerLine: "[[bench]]  # perf harness\n" });
  const errors = checkMatrix({ repoRoot: root }).errors;
  assert.ok(
    errors.some(
      (e) =>
        e.includes("FR-ED-1")
        && e.includes("comment_log_fold_stays_within_the_ten_k_event_budget")
        && e.includes("present-not-gating"),
    ),
    `expected a trailing comment on the [[bench]] header to still register the block; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("present-not-gating is not a blanket exemption — the named test must still exist and be active", () => {
  // Without this cell the third state is a hole wider than the one it closes: any row could
  // dodge BOTH halves of the gate by relabelling itself.
  const missing = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | never written | present-not-gating | |\n"), {
    e2e: "test('something else', async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "something else" }]) },
  });
  assert.ok(
    checkWithArtifacts(missing, ["e2e"]).errors.some((e) => e.includes("never written") && e.includes("not found")),
  );
  rmSync(missing, { recursive: true, force: true });

  const skipped = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | disabled outright | present-not-gating | |\n"), {
    e2e: "test.skip('disabled outright', async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "something else" }]) },
  });
  assert.ok(
    checkWithArtifacts(skipped, ["e2e"]).errors.some((e) => e.includes("disabled outright") && e.includes("would not run")),
  );
  rmSync(skipped, { recursive: true, force: true });
});

test("present-not-gating FAILS when every named test did execute in the gate — the row understates its own coverage", () => {
  // The inverse of CJ's ruling: the third state records a real gap, so it must not become a
  // quiet blanket opt-out that a row keeps long after its quarantine is lifted (#1382 is
  // exactly that history — its tests were un-quarantined by #1408 and the row's prose had to
  // be corrected by hand).
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | fully gating now | present-not-gating | |\n"), {
    e2e: "test('fully gating now', async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "fully gating now" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["e2e"]);
  assert.ok(
    errors.some((e) => e.includes("FR-ED-1") && e.includes("every named test executed")),
    `expected an "every named test executed" error on FR-ED-1; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("present-not-gating is flagged, not blessed, when the run has no execution evidence to judge it against", () => {
  // Existence-only mode cannot tell a genuine non-gating test from a typo, so it must not
  // silently accept the weaker status either.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | quarantined journey | present-not-gating | |\n"), {
    e2e: "test('quarantined journey', { tag: '@quarantine' }, async () => {});\n",
  });
  const { errors, warnings } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    warnings.some((w) => w.includes("present-not-gating") && w.includes("not verified")),
    warnings.join("\n"),
  );
  rmSync(root, { recursive: true, force: true });
});

test("every test kind resolves execution from its own suite's real artifact format", () => {
  // One cell per kind, because each reads a different vendor's document and a parser that
  // silently matched nothing would otherwise be indistinguishable from a green run only in
  // the kinds it does handle.
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | round_trips_frontmatter | present | |\n" +
    "| FR-X-2 | secrets | vitest | reads the keychain | present | |\n" +
    "| FR-ED-6 | cut | node | boards the deferral | present | |\n" +
    "| P1 | no drift | e2e | a journey that gates | present | |\n";
  const root = scaffold(md, {
    rust: "#[test]\nfn round_trips_frontmatter() {}\n",
    vitest: "it('reads the keychain', () => {});\n",
    node: "test('boards the deferral', () => {});\n",
    e2e: "test('a journey that gates', async () => {});\n",
    artifacts: {
      // libtest reports the module path; the matrix names the bare fn, as the source
      // extractor does — so both spellings have to resolve to the same executed test.
      "rust-windows.txt": cargoArtifact([{ path: "editor::tests::round_trips_frontmatter" }]),
      "vitest-ubuntu.json": vitestArtifact([{ title: "reads the keychain" }]),
      "node-scripts.jsonl": nodeArtifact([{ name: "boards the deferral" }]),
      "e2e-windows.json": playwrightArtifact([{ title: "a journey that gates" }]),
    },
  });
  const { errors, stats } = checkWithArtifacts(root, ["rust", "vitest", "node", "e2e"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 4);
  rmSync(root, { recursive: true, force: true });
});

test("each kind's parser rejects its own format's not-executed marker", () => {
  // The negative half of the cell above: one non-executing spelling per vendor document.
  const md =
    HEADER +
    "| FR-ED-1 | editor | rust | was_ignored | present | |\n" +
    "| FR-X-2 | secrets | vitest | was_pending | present | |\n" +
    "| FR-ED-6 | cut | node | was skipped | present | |\n" +
    "| P1 | no drift | e2e | was skipped in the run | present | |\n";
  const root = scaffold(md, {
    rust: "#[test]\nfn was_ignored() {}\n",
    vitest: "it('was_pending', () => {});\n",
    node: "test('was skipped', () => {});\n",
    e2e: "test('was skipped in the run', async () => {});\n",
    artifacts: {
      "rust-windows.txt": cargoArtifact([{ path: "tests::was_ignored", outcome: "ignored" }]),
      "vitest-ubuntu.json": vitestArtifact([{ title: "was_pending", status: "pending" }]),
      "node-scripts.jsonl": nodeArtifact([{ name: "was skipped", status: "skip" }]),
      "e2e-windows.json": playwrightArtifact([{ title: "was skipped in the run", status: "skipped" }]),
    },
  });
  const { errors } = checkWithArtifacts(root, ["rust", "vitest", "node", "e2e"]);
  for (const id of ["was_ignored", "was_pending", "was skipped", "was skipped in the run"]) {
    assert.ok(errors.some((e) => e.includes(id) && e.includes("did not execute")), `${id}: ${errors.join("\n")}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("a should_panic result line still reads as executed (its libtest line carries an infix)", () => {
  // libtest prints `test path::name - should panic ... ok`, so a parser anchored on
  // `<path> ... <outcome>` silently loses every should_panic test. Found against a real
  // `cargo test --workspace` transcript, not reasoned about.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | rejects_overlapping_groups | present | |\n"), {
    rust: "#[test]\n#[should_panic]\nfn rejects_overlapping_groups() {}\n",
    artifacts: {
      "rust-windows.txt": "running 1 test\ntest apply::tests::rejects_overlapping_groups - should panic ... ok\n",
    },
  });
  const { errors } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("a vitest suite title resolves from the artifact's ancestry, not only from leaf tests", () => {
  // The matrix names `describe(...)` blocks as freely as `it(...)` ones, and no runner
  // reports a suite as its own result row — vitest carries it in `ancestorTitles`. Missing
  // that would make every suite-named row a false "did not execute".
  const md =
    HEADER +
    "| FR-ED-1 | editor | vitest | editor/structuralDecorations | present | |\n" +
    "| FR-X-2 | secrets | pending | — | pending | |\n" +
    "| FR-ED-6 | cut | descoped | — | descoped | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, {
    vitest: "describe('editor/structuralDecorations', () => { it('folds', () => {}); });\n",
    artifacts: {
      "vitest-ubuntu.json": vitestArtifact([{ title: "folds", ancestors: ["editor/structuralDecorations"] }]),
    },
  });
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("a Playwright describe block resolves from its parent suite, and its file suite is not mistaken for one", () => {
  // Asserted against the parser rather than through checkMatrix because the e2e existence
  // extractor does not index `test.describe` titles at all today (filed separately) — that
  // unrelated gap would mask whether this parser recovers the ancestry.
  const { executed } = parsePlaywrightJson(playwrightArtifact([{ title: "accepts" }], { describeTitle: "J3 review journey" }));
  assert.ok(executed.has("J3 review journey"));
  assert.ok(executed.has("accepts"));
  // The top-level suite's title IS the spec's file path, which is never a matrix id.
  assert.ok(!executed.has("e2e/thing.spec.mjs"));
});

test("a required kind with no artifact at all is an error, not a silent pass (the artifact plumbing's own gate)", () => {
  // If the reporter flag is dropped from a CI step, the results file simply stops appearing.
  // Without this cell that regression reads as "nothing to check" and the gate goes green
  // while verifying nothing — #1124 in a new register.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | alive | present | |\n"), {
    rust: "#[test]\nfn alive() {}\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "unrelated" }]) },
  });
  const { errors } = checkWithArtifacts(root, ["rust", "vitest"]);
  assert.ok(
    errors.some((e) => e.includes("rust") && e.includes("no results artifact")),
    `expected a "no results artifact" error naming the required rust kind; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an unrequired kind with no artifact warns loudly and falls back to existence-only for that kind", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | alive | present | |\n"), {
    rust: "#[test]\nfn alive() {}\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "unrelated" }]) },
  });
  const { errors, warnings } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    warnings.some((w) => w.includes("rust") && w.includes("existence-only")),
    `expected an "existence-only" warning naming the rust kind; warnings were:\n${warnings.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an artifact filename that names no known kind is rejected rather than ignored", () => {
  // A dropped or mistyped prefix must not degrade to "this run had no evidence for that
  // kind" — that failure mode is silent by construction.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: { "results.json": vitestArtifact([{ title: "really ran" }]) },
  });
  const { errors } = checkWithArtifacts(root, []);
  assert.ok(
    errors.some((e) => e.includes("results.json") && e.includes("kind")),
    `expected an unknown-kind error naming "results.json"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a malformed artifact is an error, never an empty set of executed tests", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: { "vitest-ci.json": "{ this is not json" },
  });
  const { errors } = checkWithArtifacts(root, []);
  assert.ok(
    errors.some((e) => e.includes("vitest-ci.json") && e.includes("could not be parsed")),
    `expected a "could not be parsed" error naming "vitest-ci.json"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("with no artifacts directory the run warns unmissably that it proved existence only (CJ, 2026-09-02)", () => {
  // CJ's local-run ruling: `npm run matrix:check` stays cheap, but the weaker check must
  // never read as the strong one. The warning IS the deliverable here.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
  });
  const { errors, warnings, stats } = checkMatrix({ repoRoot: root });
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    warnings.some((w) => w.includes("EXECUTION CHECK SKIPPED")),
    `expected the EXECUTION CHECK SKIPPED banner; warnings were:\n${warnings.join("\n")}`,
  );
  assert.equal(stats.executionChecked, false);
  rmSync(root, { recursive: true, force: true });
});

test("passing --artifacts flips the run into execution-checked mode", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "really ran" }]) },
  });
  const { warnings, stats } = checkWithArtifacts(root, ["vitest"]);
  assert.equal(stats.executionChecked, true);
  assert.ok(!warnings.some((w) => w.includes("EXECUTION CHECK SKIPPED")), warnings.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("an artifacts directory that does not exist is an error, not a quiet fallback to existence-only", () => {
  // A mistyped --artifacts path in a workflow would otherwise turn the strong CI gate back
  // into the weak local one, invisibly and for as long as nobody re-read the log.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
  });
  const { errors } = checkMatrix({ repoRoot: root, artifactsDir: join(root, "nowhere") });
  assert.ok(
    errors.some((e) => e.includes("nowhere") && e.includes("artifacts")),
    `expected a missing-artifacts-directory error naming "nowhere"; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("parseCliArgs reads both flags, and refuses a kind list with nothing to read it from", () => {
  assert.deepEqual(parseCliArgs(["--artifacts", "out", "--require-kinds", "rust,e2e"]), {
    artifactsDir: "out",
    requireKinds: ["rust", "e2e"],
  });
  assert.deepEqual(parseCliArgs(["--artifacts=out"]).artifactsDir, "out");
  assert.deepEqual(parseCliArgs([]), { artifactsDir: null, requireKinds: [] });
  // A misspelled kind would otherwise enforce nothing while reading as if it enforced something.
  assert.throws(() => parseCliArgs(["--artifacts", "out", "--require-kinds", "rust,e2ee"]), /unknown kind/);
  assert.throws(() => parseCliArgs(["--require-kinds", "rust"]), /needs --artifacts/);
  assert.throws(() => parseCliArgs(["--artifacts"]), /needs a directory/);
  assert.throws(() => parseCliArgs(["--wat"]), /unknown argument/);
});

test("the execution half knows every kind the existence half checks", () => {
  // Two lists for one concept: `KINDS` decides what can be existence-checked, `RESULT_KINDS`
  // decides what can be evidenced. Let them drift and a matrix kind becomes permanently
  // unevidenceable — and the failure surfaces as "names no known test kind" pointing at the
  // artifact filename, away from the parser that was never written.
  assert.deepEqual([...CODE_KINDS].sort(), [...RESULT_KINDS].sort());
});

test("the cargo parser reads a real libtest transcript: module paths, ignored tests, and doc-tests", () => {
  // Format contract, pinned against the shape `cargo test --workspace` actually printed on the
  // pinned 1.97 toolchain — the part most likely to move under a toolchain bump, and the part a
  // matrix-row failure would misattribute to the matrix.
  const { executed } = parseCargoTestOutput(
    [
      "running 4 tests",
      "test anchor::tests::new_captures_the_exact_span ... ok",
      "test apply::tests::overlapping_groups_are_rejected - should panic ... ok",
      "test providers::tests::needs_a_real_shell ... ignored",
      "test rebase::tests::rejects_a_stale_base ... FAILED",
      "test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.03s",
      "   Doc-tests emend",
      "running 1 test",
      "test src/lib.rs - anchor (line 3) ... ok",
      "",
    ].join("\n"),
  );
  assert.ok(executed.has("new_captures_the_exact_span"), "a plain ok line");
  assert.ok(executed.has("overlapping_groups_are_rejected"), "the `- should panic` infix must not hide a test");
  assert.ok(executed.has("rejects_a_stale_base"), "a FAILED test still ran");
  assert.ok(!executed.has("needs_a_real_shell"), "an ignored test never ran");
  // The bare `fn` is the only spelling the matrix can name (extractRust indexes fn names), and a
  // doc-test line names a source file, which is never a matrix id.
  assert.ok(!executed.has("anchor::tests::new_captures_the_exact_span"));
  assert.ok(!executed.has("src/lib.rs"));
});

// The merge gate's own runner carries a persistent, machine-level `CARGO_TERM_COLOR=always` — not
// set by this workflow, confirmed independently by reading two of the runner's own CI runs' step
// environments (#2308 review round 1, Critical 2). Every escape sequence below is copied
// byte-for-byte from this repo's own real `cargo test --manifest-path src-tauri/Cargo.toml -p
// textops` output with that variable set (Rust 1.97, this host's toolchain) — not hand-approximated.
// The bug this reproduces: `RUNNING_HEADER_RE` anchors `^\s*Running`, which the leading ESC byte
// defeats outright, so on the real runner `crateOf` stayed empty for every record and the new
// crate-identity check degraded to an unconditional pass while the suite read green.
const REAL_COLORED_TRANSCRIPT = [
  "\x1b[1m\x1b[92m   Compiling\x1b[0m textops v0.1.0 (C:\\repo\\src-tauri\\crates\\textops)",
  // `Finished` carries an OSC 8 hyperlink around the rest of the line (`ESC ] 8 ; ; <url> ESC \\`,
  // closed by an empty `ESC ] 8 ; ; ESC \\`) — a different escape FAMILY than the CSI/SGR wrap on
  // `Running` below, included so stripping is proven general rather than tuned to one shape.
  "\x1b[1m\x1b[92m    Finished\x1b[0m \x1b]8;;https://doc.rust-lang.org/cargo/reference/profiles.html#default-profiles\x1b\\`test` profile [unoptimized + debuginfo]\x1b]8;;\x1b\\ target(s) in 13.20s",
  "\x1b[1m\x1b[92m     Running\x1b[0m unittests src\\lib.rs (src-tauri\\target\\debug\\deps\\textops-39345d178551b539.exe)",
  "",
  "running 1 test",
  "test tests::it_works ... ok",
  "",
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  "",
].join("\n");

test("stripAnsiEscapes removes a real CSI/SGR color wrap and a real OSC 8 hyperlink, leaving the plain text", () => {
  const stripped = stripAnsiEscapes(REAL_COLORED_TRANSCRIPT);
  assert.ok(!stripped.includes("\x1b"), "no escape byte survives");
  assert.ok(stripped.includes("     Running unittests src\\lib.rs (src-tauri\\target\\debug\\deps\\textops-39345d178551b539.exe)"));
  assert.ok(stripped.includes("    Finished `test` profile [unoptimized + debuginfo] target(s) in 13.20s"));
});

test("the cargo parser survives real CARGO_TERM_COLOR=always bytes: the Running header still matches and crateOf is still populated (#2308 review round 1, Critical 2)", () => {
  const { executed, seen, crateOf } = parseCargoTestOutput(REAL_COLORED_TRANSCRIPT);
  assert.equal(seen, 1);
  assert.ok(executed.has("it_works"));
  assert.deepEqual(
    [...crateOf.get("tests::it_works")],
    ["textops"],
    "an unstripped color code must not silently empty crateOf — that is exactly how the crate check went inert on the real runner",
  );
});

test("the vitest parser reads a real JSON-reporter document, ancestry and skip status included", () => {
  const { executed } = parseVitestJson(
    JSON.stringify({
      numTotalTests: 3,
      testResults: [
        {
          name: "/repo/src/appShellLayout.test.tsx",
          status: "passed",
          assertionResults: [
            { ancestorTitles: ["app-shell authoring layout"], fullName: "app-shell authoring layout fills its lane", title: "fills its lane", status: "passed", duration: 110 },
            { ancestorTitles: ["app-shell authoring layout"], fullName: "app-shell authoring layout is red", title: "is red", status: "failed", duration: 4 },
            { ancestorTitles: ["a suite reached only by skips"], fullName: "a suite reached only by skips never ran", title: "never ran", status: "pending", duration: 0 },
          ],
        },
      ],
    }),
  );
  assert.ok(executed.has("fills its lane"));
  assert.ok(executed.has("is red"), "a failed assertion still ran");
  assert.ok(executed.has("app-shell authoring layout"), "the describe title comes from ancestorTitles");
  assert.ok(!executed.has("never ran"), "`pending` is vitest's skip");
  assert.ok(!executed.has("a suite reached only by skips"), "a suite whose every case skipped did not run either");
});

// --- Artifact encoding at the merge venue (#1814 review round 1) ----------------------------
//
// The cells above feed the parsers UTF-8 text captured on a dev box. The merge venue does not
// write UTF-8: `.github/workflows/windows-self-hosted.yml` pipes `cargo test` through inbox
// Windows PowerShell 5.1's `Tee-Object -FilePath`, which has no `-Encoding` parameter and emits
// UTF-16LE with a BOM. Read as UTF-8 that transcript matches NOTHING — silently, zero names, no
// error — so the kind stayed in the evidence map and all 1208 rust ids reported "did not
// execute". CI run 33704545231 credited exactly 0 of them. Every cell here reads bytes shaped the
// way the workflow writes them, which is the only shape that can go red for that defect.

/** The exact byte sequence PS 5.1 `Tee-Object -FilePath` produces: UTF-16LE, BOM, CRLF. */
function powershell51Transcript(lines) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join("\r\n")}\r\n`, "utf16le")]);
}

test("decodeArtifact reads every byte-order mark a results producer can emit", () => {
  const text = "test tests::alive ... ok\n";
  assert.equal(decodeArtifact(Buffer.from(text, "utf8")), text, "no BOM is UTF-8");
  assert.equal(
    decodeArtifact(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])),
    text,
    "a UTF-8 BOM is stripped, not parsed as content",
  );
  assert.equal(
    decodeArtifact(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])),
    text,
    "UTF-16LE — what PS 5.1 Tee-Object writes",
  );
  const be = Buffer.from(text, "utf16le");
  be.swap16();
  assert.equal(
    decodeArtifact(Buffer.concat([Buffer.from([0xfe, 0xff]), be])),
    text,
    "UTF-16BE — no Node decoder, so the pairs are swapped first",
  );
  assert.equal(decodeArtifact(text), text, "an already-decoded string passes through");
});

test("a cargo transcript written the way the WORKFLOW writes it credits its tests as executed", () => {
  // The guard the first round did not have. Reverting the BOM decode makes this cell red and the
  // UTF-8 cell above stay green — which is exactly the asymmetry that let the defect ship.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | round_trips_frontmatter | present | |\n"), {
    rust: "#[test]\nfn round_trips_frontmatter() {}\n",
    artifacts: {
      "rust-windows.txt": powershell51Transcript([
        "running 1 test",
        "test editor::tests::round_trips_frontmatter ... ok",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      ]),
    },
  });
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1, "a UTF-16LE transcript must credit its test, not silently zero");
  rmSync(root, { recursive: true, force: true });
});

test("a UTF-16LE artifact of every JSON kind parses too, so the fix is not rust-only", () => {
  // A BOM breaks JSON.parse just as thoroughly as it breaks a line regex; decoding at the shared
  // artifact edge covers producers this workflow does not use yet.
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const md =
    HEADER +
    "| FR-ED-1 | editor | vitest | reads the keychain | present | |\n" +
    "| FR-X-2 | secrets | node | boards the deferral | present | |\n" +
    "| FR-ED-6 | cut | e2e | a journey that gates | present | |\n" +
    "| P1 | no drift | pending | — | pending | |\n";
  const root = scaffold(md, {
    vitest: "it('reads the keychain', () => {});\n",
    node: "test('boards the deferral', () => {});\n",
    e2e: "test('a journey that gates', async () => {});\n",
    artifacts: {
      "vitest-windows.json": utf16(vitestArtifact([{ title: "reads the keychain" }])),
      "node-scripts.jsonl": utf16(nodeArtifact([{ name: "boards the deferral" }])),
      "e2e-windows.json": utf16(playwrightArtifact([{ title: "a journey that gates" }])),
    },
  });
  const { errors, stats } = checkWithArtifacts(root, ["vitest", "node", "e2e"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 3);
  rmSync(root, { recursive: true, force: true });
});

test("the live Windows PowerShell that CI uses still writes what the decoder assumes", (t) => {
  // The byte-level cells above pin our MODEL of PS 5.1. This one pins the model to the real shell,
  // so a runner-image or PowerShell change that alters the encoding fails here rather than
  // silently zeroing the rust kind again. Windows-only by nature; the merge gate is a Windows job.
  if (process.platform !== "win32") {
    t.skip("inbox Windows PowerShell is Windows-only; the merge venue is a Windows job");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "emend-ps-encoding-"));
  const results = join(root, "rust-windows.txt");
  // The workflow's own shell form (defaults.run.shell), and its own Tee-Object -FilePath call.
  const script = `'running 1 test','test editor::tests::written_by_powershell ... ok' | Tee-Object -FilePath '${results}' | Out-Null`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const { byKind, errors } = readExecutionArtifacts({ dir: root });
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    byKind.get("rust")?.executed.has("written_by_powershell"),
    `the live shell wrote bytes the decoder could not read: ${[...readFileSync(results).subarray(0, 4)].map((b) => b.toString(16)).join(" ")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("findTest resolves a Playwright test.describe journey title, and flags a skipped one (#2235)", () => {
  // The e2e kind omitted `describe` while `vitest` and `node` carried it, so a row naming a
  // journey block failed existence with "not found in the e2e sources". `e2e/acceptance.spec.mjs`
  // is organised almost entirely into `test.describe` blocks, so this was a real authoring
  // restriction, not a curiosity. Folded in here on the coordinator's instruction; #2235 closes.
  const root = scaffold(HEADER, {
    e2e: [
      "test.describe('J3 review journey', () => { test('accepts a change', async () => {}); });",
      "test.describe.skip('J7 quarantined journey', () => { test('later', async () => {}); });",
      "",
    ].join("\n"),
  });
  assert.equal(findTest({ repoRoot: root, kind: "e2e", id: "J3 review journey" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "e2e", id: "accepts a change" }), "active");
  assert.equal(findTest({ repoRoot: root, kind: "e2e", id: "J7 quarantined journey" }), "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("a matrix row may now name an e2e describe block end to end, execution included (#2235)", () => {
  // The pairing that matters: the existence half resolves the journey title AND the execution
  // half credits it from the Playwright document's parent suite.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | J3 review journey | present | |\n"), {
    e2e: "test.describe('J3 review journey', () => { test('accepts a change', async () => {}); });\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "accepts a change" }], { describeTitle: "J3 review journey" }) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["e2e"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("--artifacts that yields no readable results still gets the banner, not a confident summary", () => {
  // The workflow reaches this state whenever neither `vitest` nor `e2e` was selected: --artifacts
  // is passed, --require-kinds is empty, and nothing was produced. Exiting 0 under an
  // "execution-checked" summary would make the weakest possible run read as the strong one — the
  // exact misreading CJ's 2026-09-02 ruling exists to prevent, at run scale rather than kind scale.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: {},
  });
  const { errors, warnings } = checkWithArtifacts(root, []);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(
    warnings.some((w) => w.includes("EXECUTION CHECK SKIPPED")),
    `expected the banner when no kind produced evidence; warnings were:\n${warnings.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a run with real evidence gets no banner, so the banner still means something", () => {
  // The control: without this, the cell above would pass on a checker that printed the banner
  // unconditionally, and the banner would stop carrying information.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | really ran | present | |\n"), {
    vitest: "it('really ran', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "really ran" }]) },
  });
  const { warnings } = checkWithArtifacts(root, ["vitest"]);
  assert.ok(!warnings.some((w) => w.includes("EXECUTION CHECK SKIPPED")), warnings.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

// --- Failing closed on an unreadable artifact (#1814 review round 3) -----------------------
//
// Round 1 fixed the encoding the venue actually uses; round 2 recorded, by execution, that a
// BOM-LESS UTF-16 payload still produced a silent zero — no throw, no error, `executed = 0` —
// and the journal then described that hole as closed. It was not. These cells are the code
// making the claim true, and the control that keeps the guard from becoming a blunt instrument.

test("a BOM-less UTF-16 transcript is an ERROR, never a run that executed nothing", () => {
  // No mark to sniff, so the bytes decode as NUL-interleaved UTF-8 that matches zero result
  // lines. Crediting that as "nothing ran" is the exact silent zero this card exists to end.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | round_trips_frontmatter | present | |\n"), {
    rust: "#[test]\nfn round_trips_frontmatter() {}\n",
    artifacts: {
      "rust-windows.txt": Buffer.from(
        "running 1 test\r\ntest editor::tests::round_trips_frontmatter ... ok\r\n",
        "utf16le",
      ),
    },
  });
  const { errors } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes("rust-windows.txt") && e.includes("NUL")),
    `expected an encoding error naming the artifact; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an unreadable artifact keeps its kind OUT of the evidence map, so an enforced kind fails", () => {
  // The severity that matters. If the kind stayed in the map with an empty set, every row would
  // report "did not execute" and a reader would hunt 1208 phantom regressions instead of one
  // broken producer — which is precisely what shipped in round 1.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | round_trips_frontmatter | present | |\n"), {
    rust: "#[test]\nfn round_trips_frontmatter() {}\n",
    artifacts: { "rust-windows.txt": Buffer.from("running 1 test\r\ntest a::b ... ok\r\n", "utf16le") },
  });
  const { errors } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes("no results artifact for the required \"rust\" kind")),
    `expected the required-kind failure, not per-row noise; errors were:\n${errors.join("\n")}`,
  );
  assert.ok(!errors.some((e) => e.includes("did not execute")), "no per-row execution noise from an unreadable file");
  rmSync(root, { recursive: true, force: true });
});

test("an artifact whose records are unrecognisable is an error, whatever the encoding", () => {
  // The general form: the guard is "recognised no records", not "looked like UTF-16". A producer
  // that changes format, or writes a log where results were expected, fails the same way.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | alive | present | |\n"), {
    rust: "#[test]\nfn alive() {}\n",
    artifacts: { "rust-windows.txt": "warning: unused variable\nerror: could not compile `emend`\n" },
  });
  const { errors } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes("no recognisable rust test records") && e.includes("bytes read")),
    `expected an unrecognisable-records error; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an empty artifact says so, rather than reading as a suite that ran nothing", () => {
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | alive | present | |\n"), {
    rust: "#[test]\nfn alive() {}\n",
    artifacts: { "rust-windows.txt": "" },
  });
  const { errors } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes("no recognisable rust test records") && e.includes("the file is empty")),
    `expected the empty-file wording; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an all-ignored transcript executes nothing and is NOT an error — the guard's own control", () => {
  // Without this cell the guard above could be a blanket "zero executed is a defect", which would
  // fail every legitimately all-skipped run. Recognised-but-not-executed and not-recognised-at-all
  // are different facts, and collapsing them is what made the original zero unreadable.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | was_ignored | present-not-gating | |\n"), {
    rust: "#[test]\nfn was_ignored() {}\n",
    artifacts: {
      "rust-windows.txt": cargoArtifact([{ path: "tests::was_ignored", outcome: "ignored" }]),
    },
  });
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 0, "an ignored test genuinely executed nothing");
  assert.equal(stats.notGatingTests, 1, "and the row says so structurally");
  rmSync(root, { recursive: true, force: true });
});

test("decodeArtifact refuses NUL-bearing bytes rather than returning them", () => {
  assert.throws(
    () => decodeArtifact(Buffer.from("test a::b ... ok\n", "utf16le")),
    /contains NUL/,
    "a BOM-less UTF-16 payload must throw, not decode to rubbish",
  );
  // And the recognised encodings still pass through untouched.
  assert.equal(decodeArtifact(Buffer.from("test a::b ... ok\n", "utf8")), "test a::b ... ok\n");
});

// --- A row's OWN test, not merely a test of its name (#2250) --------------------------------
//
// Everything above proves a named test is defined and that SOMETHING of that name ran. #2250 is
// the gap between those two and what a row actually claims: ids were matched as bare titles
// pooled across a whole kind, so a same-titled test in an unrelated file credited the row. The
// first cell below is the reproduction executed during PR #2240's review, which passed with zero
// errors before this binding existed.

const BUDGET_TITLE = "keystroke latency stays within budget";

/** The #2250 collision: the row's test lives in `tests/perf`, an unrelated `src/` file shares its title. */
function collidingScaffold(row) {
  return scaffold(executionMatrix(row), {
    // What the row means: a §6 benchmark, run by `npm run test:perf`, never by the gating suite.
    perf: `it('${BUDGET_TITLE}', () => {});\n`,
    // What actually ran: an unrelated component suite whose describe block shares the title.
    vitest: `describe('${BUDGET_TITLE}', () => { it('an unrelated case', () => {}); });\n`,
    artifacts: {
      "vitest-ci.json": vitestArtifact([{ title: "an unrelated case", ancestors: [BUDGET_TITLE] }]),
    },
  });
}

test("a row whose intended test never ran FAILS, even though an unrelated file ran one of the same name", () => {
  // THE demonstration. Qualified to the benchmark it means, the row is judged against THAT file:
  // the `src/` describe block that did run is not evidence for it. Before #2250 this exact
  // fixture reported `errors: 0` and `executedTests: 1 of 1`.
  const root = collidingScaffold(`| FR-ED-1 | editor | vitest | tests/perf/thing.perf.test.ts::${BUDGET_TITLE} | present | |\n`);
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  assert.ok(
    errors.some((e) => e.includes(BUDGET_TITLE) && e.includes("did not execute")),
    `expected a "did not execute" error for the benchmark; errors were:\n${errors.join("\n")}`,
  );
  assert.ok(
    errors.some((e) => e.includes("src/thing.test.ts")),
    `the error must name where the same-titled test DID run, or the collision stays invisible; errors were:\n${errors.join("\n")}`,
  );
  assert.equal(stats.executedTests, 0, "nothing about this row was proven, so nothing may be counted");
  rmSync(root, { recursive: true, force: true });
});

test("the same row is refused BEFORE it is qualified — a bare title two files define names no one test", () => {
  // The other half of the migration: an unqualified id that resolves to several files cannot be
  // bound at all, so it is a hard error naming the candidates rather than a silent coin flip.
  const root = collidingScaffold(`| FR-ED-1 | editor | vitest | ${BUDGET_TITLE} | present | |\n`);
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  const ambiguity = errors.find((e) => e.includes("is defined in 2 files"));
  assert.ok(ambiguity, `expected an ambiguity error; errors were:\n${errors.join("\n")}`);
  assert.ok(ambiguity.includes("src/thing.test.ts") && ambiguity.includes("tests/perf/thing.perf.test.ts"), ambiguity);
  assert.ok(ambiguity.includes(`qualify it as "<file>::`), ambiguity);
  assert.equal(stats.executedTests, 0, "an id that names no one test cannot be credited by any of them");
  // Existence-only runs it too: the ambiguity is a property of the matrix and the sources, not of
  // whatever artifacts happened to be supplied, so the cheap local loop reports it as well.
  assert.ok(checkMatrix({ repoRoot: root }).errors.some((e) => e.includes("is defined in 2 files")));
  rmSync(root, { recursive: true, force: true });
});

test("a legitimate describe-titled row still passes — an ancestor title is credited for its own file", () => {
  // The control the fix must not break: `describe` titles are legitimate matrix ids in vitest,
  // node and e2e alike, and an ancestor's body demonstrably ran IN THE FILE it was reported under.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | app-shell authoring layout | present | |\n"), {
    vitest: "describe('app-shell authoring layout', () => { it('fills its lane', () => {}); });\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "fills its lane", ancestors: ["app-shell authoring layout"] }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("an unqualified id defined in exactly ONE file needs no qualifier — the bare form stays legal", () => {
  // The migration's scope claim, pinned: qualification is required only where a title collides.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | only defined once | present | |\n"), {
    vitest: "it('only defined once', () => {});\n",
    perf: "it('a benchmark with its own name', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "only defined once" }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("a same-titled test that ran in a DIFFERENT file is named as such, not reported as nothing having run", () => {
  // The diagnostic is the difference between "wire this into the gate" and "something else is
  // answering to its name" — a reader who cannot tell them apart re-opens #2250 every time.
  const root = collidingScaffold(`| FR-ED-1 | editor | vitest | tests/perf/thing.perf.test.ts::${BUDGET_TITLE} | present | |\n`);
  const { errors } = checkWithArtifacts(root, ["vitest"]);
  const finding = errors.find((e) => e.includes("did not execute"));
  assert.ok(finding.includes("is defined in tests/perf/thing.perf.test.ts"), finding);
  assert.ok(finding.includes("which is not the file this row names"), finding);
  rmSync(root, { recursive: true, force: true });
});

test("state resolves per FILE — the same title skipped in one file and live in another reports the row's own file", () => {
  // Before the binding, "active anywhere wins" meant a row pointing at a `.skip`ped test read as
  // present because an unrelated file happened to define a live one.
  const shared = "shared between two files";
  const options = {
    vitest: `it.skip('${shared}', () => {});\n`,
    perf: `it('${shared}', () => {});\n`,
  };
  const dead = scaffold(executionMatrix(`| FR-ED-1 | editor | vitest | src/thing.test.ts::${shared} | present | |\n`), options);
  assert.ok(
    checkMatrix({ repoRoot: dead }).errors.some((e) => e.includes(shared) && e.includes("ignored/skipped")),
    "the row names the file where the test is skipped, so it must report that",
  );
  rmSync(dead, { recursive: true, force: true });

  const live = scaffold(executionMatrix(`| FR-ED-1 | editor | vitest | tests/perf/thing.perf.test.ts::${shared} | present | |\n`), options);
  assert.deepEqual(checkMatrix({ repoRoot: live }).errors, []);
  rmSync(live, { recursive: true, force: true });
});

test("a title both skipped and live in the SAME file is still active — the per-file merge is unchanged", () => {
  // #2250 narrowed "active wins" from kind-wide to per-file. Within one file it still holds, and
  // it must: a suite that keeps a `.skip`ped variant beside the live case is ordinary, and reading
  // that row as disabled would be a new false failure rather than a closed hole.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | both spellings here | present | |\n"), {
    vitest: "it.skip('both spellings here', () => {});\nit('both spellings here', () => {});\n",
  });
  assert.deepEqual(checkMatrix({ repoRoot: root }).errors, []);
  rmSync(root, { recursive: true, force: true });
});

test("a qualifier naming a file that does not define the test is an error, never a fallback to the bare title", () => {
  // A stale qualifier — the file was renamed, the test moved — must fail loudly. Falling back to
  // the bare title on a miss would restore exactly the pooling this closes.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | src/nowhere.test.ts::only defined once | present | |\n"), {
    vitest: "it('only defined once', () => {});\n",
  });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(
    errors.some((e) => e.includes('is not defined in "src/nowhere.test.ts"') && e.includes("src/thing.test.ts")),
    `expected a wrong-file error naming both the claim and the truth; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("file matching is by whole path SEGMENTS — a longer basename is not the file the row names", () => {
  // `sameFile` compares from the right, so `src/thing.test.ts` must not be satisfied by a result
  // from `src/otherthing.test.ts`; a plain substring comparison would credit it.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | only defined once | present | |\n"), {
    vitest: "it('only defined once', () => {});\n",
    artifacts: { "vitest-ci.json": vitestArtifact([{ title: "only defined once", file: "/repo/src/otherthing.test.ts" }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["vitest"]);
  // Each assertion carries its own message: a shared one cannot say WHICH of them failed, and a
  // mutation that reddens the cell at the other one would then read as proof of this one (#1762).
  assert.ok(
    errors.some((e) => e.includes("did not execute")),
    `a result from another file must not credit this row; errors were:\n${errors.join("\n")}`,
  );
  assert.equal(stats.executedTests, 0, "a result from another file must not be counted as executed");
  rmSync(root, { recursive: true, force: true });
});

test("Playwright's rootDir-relative file spelling still credits the repo-relative source it names", () => {
  // The production edge for the ENFORCED e2e kind: `testDir: "./e2e"` makes Playwright's `file` a
  // bare `thing.spec.mjs` while the source walk calls it `e2e/thing.spec.mjs`. Matching only
  // "report path ends with source path" would fail every e2e row in the merge gate.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | e2e | a journey that gates | present | |\n"), {
    e2e: "test('a journey that gates', async () => {});\n",
    artifacts: { "e2e-windows.json": playwrightArtifact([{ title: "a journey that gates" }], { file: "thing.spec.mjs" }) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["e2e"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("rust stays name-matched because libtest prints a module path and no file", () => {
  // The stated residual (test-plan §9): `rust` is deliberately absent from FILE_BOUND_KINDS, so a
  // rust row is credited by name alone. Pinned so the exemption is a decision, not an accident.
  assert.ok(!FILE_BOUND_KINDS.has("rust"), "rust cannot be file-bound until libtest names files");
  assert.deepEqual([...FILE_BOUND_KINDS].sort(), ["e2e", "node", "vitest"]);
  // Every kind must have ANSWERED the file-bound question, not merely be absent from the set:
  // `Set.has` on a forgotten kind returns false, which would silently restore #2250's bare-title
  // pooling for it. `FILE_BOUND_KINDS` is derived from the same per-kind table the parsers live
  // in, so this pins that derivation rather than a second hand-maintained list.
  assert.ok(
    [...FILE_BOUND_KINDS].every((kind) => RESULT_KINDS.includes(kind)),
    "a file-bound kind that no parser reads could never be evidenced",
  );
  assert.equal(FILE_BOUND_KINDS.size + 1, RESULT_KINDS.length, "rust is the ONLY exemption; a new one needs its own reasoning");
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | round_trips_frontmatter | present | |\n"), {
    rust: "#[test]\nfn round_trips_frontmatter() {}\n",
    artifacts: { "rust-windows.txt": cargoArtifact([{ path: "editor::tests::round_trips_frontmatter" }]) },
  });
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("splitTestId reads a file qualifier only when the left side really is a source path", () => {
  assert.deepEqual(splitTestId("a plain title"), { file: null, name: "a plain title" });
  assert.deepEqual(splitTestId("src/thing.test.ts::a plain title"), { file: "src/thing.test.ts", name: "a plain title" });
  assert.deepEqual(splitTestId("src-tauri/src/store/settings.rs::save_then_load_round_trips"), {
    file: "src-tauri/src/store/settings.rs",
    name: "save_then_load_round_trips",
  });
  // A title that merely CONTAINS `::` is still a title — Rust-ish paths appear in prose titles.
  assert.deepEqual(splitTestId("rejects agent::mcp::open without a token"), {
    file: null,
    name: "rejects agent::mcp::open without a token",
  });
  // An absolute Windows path can never masquerade as a qualifier: its own `:` disqualifies it.
  assert.deepEqual(splitTestId("C:/repo/src/thing.test.ts::a title"), {
    file: null,
    name: "C:/repo/src/thing.test.ts::a title",
  });
});

test("every results parser files each executed name under the file it ran in", () => {
  const vitest = parseVitestJson(vitestArtifact([{ title: "fills its lane", ancestors: ["app-shell authoring layout"] }]));
  assert.deepEqual([...vitest.executed.get("fills its lane")], ["/repo/src/thing.test.ts"]);
  assert.deepEqual(
    [...vitest.executed.get("app-shell authoring layout")],
    ["/repo/src/thing.test.ts"],
    "an ancestor is filed under the file that ran it, which is what makes crediting it honest",
  );

  const playwright = parsePlaywrightJson(playwrightArtifact([{ title: "accepts" }], { describeTitle: "J3 review journey" }));
  assert.deepEqual([...playwright.executed.get("accepts")], ["e2e/thing.spec.mjs"]);
  assert.deepEqual([...playwright.executed.get("J3 review journey")], ["e2e/thing.spec.mjs"]);

  const node = parseNodeResultsJsonl(nodeArtifact([{ name: "boards the deferral", file: "C:\\repo\\scripts\\thing.test.mjs" }]));
  assert.deepEqual(
    [...node.executed.get("boards the deferral")],
    ["C:/repo/scripts/thing.test.mjs"],
    "the node:test reporter emits native Windows separators; only the separator is normalised here",
  );

  const cargo = parseCargoTestOutput(cargoArtifact([{ path: "editor::tests::round_trips" }]));
  // libtest names no FILE, but the full module path is kept (#2276) so a qualified rust id's
  // execution credit can be checked against the module path its defining file would produce.
  assert.deepEqual([...cargo.executed.get("round_trips")], ["editor::tests::round_trips"]);
  // No `Running` header in this artifact -> no crate identity recovered (#2308's pre-condition).
  assert.equal(cargo.crateOf.size, 0, "a transcript with no Running header carries no crate identity");

  const cargoWithCrate = parseCargoTestOutput(
    cargoArtifactWithTargets([
      { targetSource: "unittests src\\lib.rs", binary: "emend_lib", entries: [{ path: "editor::tests::round_trips" }] },
    ]),
  );
  assert.deepEqual(
    [...cargoWithCrate.crateOf.get("editor::tests::round_trips")],
    ["emend_lib"],
    "cargo's own Running header names the crate binary a path's test ran in (#2308)",
  );
});

// --- What the disclosures in test-plan §9 item (f) actually mean, executed (#2250) ---------------
//
// A residual list is prose until something runs it. Each cell below pins one clause of (f-1)/(f-2)/
// (f-3) — ratified by CJ 2026-09-03 — so a later change that silently narrows or widens a stated gap
// fails here rather than leaving ratified text describing code that moved.

test("a rust qualifier now refuses a same-named execution from the WRONG file — (f-1) closed for a resolvable module path (#2276)", () => {
  // Review round 1 found the residual understated: `resolveTestId` never reports `ambiguous` once a
  // qualifier is present, so qualifying is exactly what silences the uniqueness check — and the
  // qualified ids are by construction the colliding names. libtest names no FILE, but it does print
  // the full module path, and for a file under the conventional `src-tauri/{src,crates/*/src}`
  // layout that path is derivable from the file's OWN repo path without parsing a single `mod`
  // declaration — Rust's file-per-module convention already IS the resolver. `settings.rs` derives
  // module segments `["settings"]`; a same-named test recorded under `docs_map::tests::…` does not
  // start with that prefix, so it must not credit this row even though the bare NAME matches.
  const shared = "save_then_load_round_trips";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/src/settings.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      // Only the OTHER file's copy ran (module prefix "docs_map", not "settings").
      "rust-windows.txt": cargoArtifact([{ path: `docs_map::tests::${shared}` }]),
    },
  });
  writeFileSync(join(root, "src-tauri/src/settings.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes(shared) && e.includes("did not execute")),
    `a same-named execution from docs_map must not credit settings.rs's row; errors were:\n${errors.join("\n")}`,
  );
  assert.equal(stats.executedTests, 0, "the wrong file's execution must not be counted for this row");
  rmSync(root, { recursive: true, force: true });
});

test("...and still credits it when the NAMED file's own copy ran, module prefix included (#2276)", () => {
  const shared = "save_then_load_round_trips";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/src/settings.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      // The real libtest shape: the file's own module (`settings`) wraps a `tests` submodule.
      "rust-windows.txt": cargoArtifact([{ path: `settings::tests::${shared}` }]),
    },
  });
  writeFileSync(join(root, "src-tauri/src/settings.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1, "the named file's own execution must still credit the row");
  rmSync(root, { recursive: true, force: true });
});

test("(f-1)'s crate-root residual with NO crate evidence in the run: still name-matched, honestly (pre-#2308 shape)", () => {
  // The module path alone cannot place a test at crate/binary scope when the run's artifact carries
  // no crate identity at all — a candidate file that IS the crate/integration-test root (`src/lib.rs`,
  // `src/main.rs`, or a bare `tests/<file>.rs`) resolves to an EMPTY module-segment prefix, and an
  // empty prefix is trivially a prefix of anything. Where the evidence has no `Running` headers to
  // recover crate identity from (an artifact captured before #2308, or hand-built without one, which
  // is exactly what the bare `cargoArtifact` fixture below models), the check still declines to
  // fabricate an answer and falls back to the old by-name credit.
  const shared = "debug_formatting_never_prints_the_bearer_token";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/tests/project_mcp_server.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      // A same-named test ran, but in an unrelated module, and this artifact carries no crate
      // identity at all (no `Running` header) — the pre-#2308 residual shape.
      "rust-windows.txt": cargoArtifact([{ path: `http_tool_server::tests::${shared}` }]),
    },
  });
  mkdirSync(join(root, "src-tauri/tests"), { recursive: true });
  writeFileSync(join(root, "src-tauri/tests/project_mcp_server.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], "with no crate evidence at all, a crate-root/integration-root qualifier stays name-matched only");
  assert.equal(stats.executedTests, 1);
  rmSync(root, { recursive: true, force: true });
});

test("closing (f-1)'s crate-root residual: cargo's Running header (#2308) refuses a same-named execution from the WRONG crate", () => {
  // The exact scenario test-plan §9 (f-1) named as its first residual, and #2308's own acceptance
  // witness: `debug_formatting_never_prints_the_bearer_token` runs only in a DIFFERENT crate
  // (`fake_agent`'s `http_tool_server.rs`) than the row's own file (`project_mcp_server.rs`, an
  // integration-test root whose own crate IS the file itself). Once the artifact carries a `Running`
  // header (recovered from cargo's stderr, merged into the transcript), the empty-prefix fallback no
  // longer credits blindly — it checks the recorded execution's own crate against the one the
  // defining file would produce, and refuses this row.
  const shared = "debug_formatting_never_prints_the_bearer_token";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/tests/project_mcp_server.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      "rust-windows.txt": cargoArtifactWithTargets([
        { targetSource: "unittests src\\lib.rs", binary: "fake_agent", entries: [{ path: `http_tool_server::tests::${shared}` }] },
      ]),
    },
  });
  mkdirSync(join(root, "src-tauri/tests"), { recursive: true });
  writeFileSync(join(root, "src-tauri/tests/project_mcp_server.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes(shared) && e.includes("did not execute")),
    `a different crate's same-named execution must not credit this row; errors were:\n${errors.join("\n")}`,
  );
  assert.equal(stats.executedTests, 0, "the wrong crate's execution must not be counted for this row");
  rmSync(root, { recursive: true, force: true });
});

test("...and still credits the crate-root row when the NAMED file's own crate is the one that ran (#2308)", () => {
  const shared = "debug_formatting_never_prints_the_bearer_token";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/tests/project_mcp_server.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      // The real libtest shape for an integration-test root: no module prefix at all, and cargo's
      // header names the binary after the file itself.
      "rust-windows.txt": cargoArtifactWithTargets([
        { targetSource: "tests\\project_mcp_server.rs", binary: "project_mcp_server", entries: [{ path: shared }] },
      ]),
    },
  });
  mkdirSync(join(root, "src-tauri/tests"), { recursive: true });
  writeFileSync(join(root, "src-tauri/tests/project_mcp_server.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.equal(stats.executedTests, 1, "the row's own crate running the test must still credit it");
  rmSync(root, { recursive: true, force: true });
});

test("closing (f-1)'s second residual: two crates deriving the identical module segments do not credit each other (#2308)", () => {
  // Test-plan §9 (f-1)'s second residual: two DIFFERENT crates whose files happen to derive the
  // SAME module-segment list (unreached in the live corpus today, per the census in the test-plan
  // entry, but not enforced against anything that would keep it that way) would be indistinguishable
  // by prefix alone. Built directly here: a root-crate file and a `fake-agent`-crate file both named
  // `foo.rs`, both deriving segments `["foo"]`. Only `fake-agent`'s copy ran.
  const shared = "shared_leaf_name";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/src/foo.rs::${shared} | present | |\n`), {
    rust: `#[test]\nfn ${shared}() {}\n`,
    artifacts: {
      "rust-windows.txt": cargoArtifactWithTargets([
        { targetSource: "unittests src\\lib.rs", binary: "fake_agent", entries: [{ path: `foo::tests::${shared}` }] },
      ]),
    },
  });
  writeFileSync(join(root, "src-tauri/src/foo.rs"), `#[test]\nfn ${shared}() {}\n`);
  // The root crate's own manifest — needed so `foo.rs`'s expected crate binary ("emend", the
  // package-name default with no `[lib]` override) resolves at all, distinct from `fake_agent`.
  writeCrateManifest(root, "src-tauri", { name: "emend" });
  mkdirSync(join(root, "src-tauri/crates/fake-agent/src"), { recursive: true });
  writeCrateManifest(root, "src-tauri/crates/fake-agent", { name: "fake-agent", lib: { name: "fake_agent", path: "src/lib.rs" } });
  writeFileSync(join(root, "src-tauri/crates/fake-agent/src/foo.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.ok(
    errors.some((e) => e.includes(shared) && e.includes("did not execute")),
    `a sibling crate's identical-segment execution must not credit the root crate's row; errors were:\n${errors.join("\n")}`,
  );
  assert.equal(stats.executedTests, 0);
  rmSync(root, { recursive: true, force: true });
});

test("rustModuleSegments resolves all six of its own outcomes, not just the src/-file and integration-root shapes", () => {
  // Only two of the six shapes below were reachable through a `checkMatrix` fixture before this
  // cell (a plain `src-tauri/src/<x>.rs` file, and a bare `src-tauri/tests/<x>.rs` root) — the
  // rest was executed only ad hoc during review, never pinned. Exported so the pure function can
  // be driven directly rather than needing a scaffolded fixture per shape.
  assert.deepEqual(rustModuleSegments("src-tauri/src/store/settings.rs"), { segments: ["store", "settings"], resolvable: true });
  assert.deepEqual(
    rustModuleSegments("src-tauri/crates/provider-contract/src/fold.rs"),
    { segments: ["fold"], resolvable: true },
    "a sibling crate's src/ tree derives a module path the same way the main crate's does",
  );
  assert.deepEqual(
    rustModuleSegments("src-tauri/crates/provider-contract/tests/integration.rs"),
    { segments: [], resolvable: true },
    "a sibling crate's own integration-test root is an empty prefix too — same residual, different crate",
  );
  assert.deepEqual(
    rustModuleSegments("src-tauri/src/main.rs"),
    { segments: [], resolvable: true },
    "main.rs is a crate root exactly like lib.rs — both are the module libtest numbers from",
  );
  assert.deepEqual(
    rustModuleSegments("src-tauri/src/store/mod.rs"),
    { segments: ["store"], resolvable: true },
    "the /mod fold: a directory's mod.rs derives its CONTAINING directory's segments, not an extra `mod` segment — this is the ancestor prefix the next test's residual rests on",
  );
  assert.deepEqual(
    rustModuleSegments("src-tauri/benches/round_trip.rs"),
    { segments: [], resolvable: false },
    "a layout outside the walked convention falls back to by-name credit, not a fabricated prefix",
  );
});

test("rustExpectedCrateBinary derives the crate a Running header would name, for each rustModuleSegments shape (#2308)", () => {
  const manifests = [
    { crateDir: "src-tauri", libBinary: "emend_lib", binBinary: "emend" },
    { crateDir: "src-tauri/crates/provider-contract", libBinary: "provider_contract", binBinary: "provider_contract" },
  ];
  assert.equal(
    rustExpectedCrateBinary("src-tauri/src/store/settings.rs", manifests),
    "emend_lib",
    "an ordinary src/ file compiles into its crate's lib target",
  );
  assert.equal(
    rustExpectedCrateBinary("src-tauri/src/main.rs", manifests),
    "emend",
    "main.rs is the crate's bin target, not its lib",
  );
  assert.equal(
    rustExpectedCrateBinary("src-tauri/crates/provider-contract/src/fold.rs", manifests),
    "provider_contract",
    "a sibling crate's src/ tree resolves against its OWN manifest",
  );
  assert.equal(
    rustExpectedCrateBinary("src-tauri/tests/project_mcp_server.rs", manifests),
    "project_mcp_server",
    "an integration-test root IS its own crate, named after the file — no manifest lookup needed",
  );
  assert.equal(
    rustExpectedCrateBinary("src-tauri/crates/provider-contract/tests/integration.rs", manifests),
    "integration",
    "same for a sibling crate's own integration-test root",
  );
  assert.equal(
    rustExpectedCrateBinary("src-tauri/benches/round_trip.rs", manifests),
    null,
    "a layout outside the walked convention resolves to nothing — the same residual rustModuleSegments already names",
  );
});

test("findRustCrateManifests reads a real Cargo.toml's [package]/[lib]/[[bin]] names, hyphens underscored (#2308)", () => {
  // Verified against this repo's real manifests (not assumed): the root crate's `[lib] name =
  // "emend_lib"` override, and `fake-agent`'s package-default lib/bin names, both show up on
  // cargo's own `Running` header exactly this way (a real `cargo test --workspace 2>&1` capture).
  const root = mkdtempSync(join(tmpdir(), "emend-matrix-crate-"));
  writeCrateManifest(root, "src-tauri", { name: "emend", lib: { name: "emend_lib" } });
  writeCrateManifest(root, "src-tauri/crates/fake-agent", {
    name: "fake-agent",
    lib: { name: "fake_agent", path: "src/lib.rs" },
    bin: { name: "fake-agent", path: "src/main.rs" },
  });
  const manifests = findRustCrateManifests({ repoRoot: root, readSourceFile: readFileSync });
  assert.deepEqual(
    manifests.find((m) => m.crateDir === "src-tauri"),
    { crateDir: "src-tauri", libBinary: "emend_lib", binBinary: "emend" },
    "the root crate has no [[bin]] table, so its bin binary falls back to the package name default",
  );
  assert.deepEqual(
    manifests.find((m) => m.crateDir === "src-tauri/crates/fake-agent"),
    { crateDir: "src-tauri/crates/fake-agent", libBinary: "fake_agent", binBinary: "fake_agent" },
    "an explicit [[bin]] name (\"fake-agent\") is still underscored to the FILE name cargo actually produces",
  );
  rmSync(root, { recursive: true, force: true });
});

test("a rust qualifier naming a module ANCESTOR (mod.rs) is credited by ANY descendant's execution — (f-1)'s third, unclosed residual", () => {
  // `ranInRustModulePrefix` accepts a PREFIX match, and a module-ancestor file's own derived
  // prefix is, by construction, also a prefix of every file `mod`-declared beneath it — so a row
  // naming `store/mod.rs` is satisfied by an execution recorded in `store/settings.rs`, a
  // completely DIFFERENT file, even though the row's own file never ran at all in this
  // transcript. Named, not closed: it needs a mod-tree resolver this card does not build
  // (test-plan §9 (f-1), third residual). Unreached by any of the 18 qualified rust ids live
  // today — none of them names a `mod.rs` — so this pins the mechanism, not a live false pass.
  const shared = "shared_test";
  const root = scaffold(executionMatrix(`| FR-ED-1 | editor | rust | src-tauri/src/store/mod.rs::${shared} | present | |\n`), {
    artifacts: {
      "rust-windows.txt": cargoArtifact([{ path: `store::settings::tests::${shared}` }]),
    },
  });
  mkdirSync(join(root, "src-tauri/src/store"), { recursive: true });
  writeFileSync(join(root, "src-tauri/src/store/mod.rs"), `#[test]\nfn ${shared}() {}\n`);
  const { errors, stats } = checkWithArtifacts(root, ["rust"]);
  assert.deepEqual(errors, [], "documented residual: an ancestor's row is credited by any descendant's execution");
  assert.equal(stats.executedTests, 1, "the row is credited even though its OWN file never ran in this transcript");
  rmSync(root, { recursive: true, force: true });
});

test("that same rust qualifier is still fatal when its file does not define the test — the half that DOES bind", () => {
  // The other side of (f-1): "binds definition, not execution" is only honest if definition really
  // binds. A stale rust qualifier must fail exactly as loudly as a vitest one.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | rust | src-tauri/src/nowhere.rs::round_trips | present | |\n"), {
    rust: "#[test]\nfn round_trips() {}\n",
  });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(
    errors.some((e) => e.includes('is not defined in "src-tauri/src/nowhere.rs"')),
    `a rust qualifier must still bind the definition; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("prose ending in a source extension parses as a qualifier and fails LOUDLY, never silently", () => {
  // `QUALIFIED_ID` is a shape test, not a proof that the left side is a path, so a title such as
  // `reads config.ts::default export` is read as a qualifier. The comment used to imply otherwise.
  // The failure direction is what makes that acceptable — it is refused, not quietly mismatched.
  assert.deepEqual(
    splitTestId("reads config.ts::default export"),
    { file: "reads config.ts", name: "default export" },
    "prose ending in a source extension must parse as a qualifier — the shape test cannot tell it apart",
  );
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | reads config.ts::default export | present | |\n"), {
    vitest: "it('reads config.ts::default export', () => {});\n",
  });
  const { errors } = checkMatrix({ repoRoot: root });
  assert.ok(
    errors.some((e) => e.includes("default export") && (e.includes("not found") || e.includes("is not defined in"))),
    `a mis-parsed qualifier must be reported, not silently resolved; errors were:\n${errors.join("\n")}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("findTest takes a bare title, so a qualified cell entry reads as missing — split it first", () => {
  // The exported probe indexes by name. Handing it a `Test IDs` entry verbatim is a caller error,
  // and the contract now says so rather than leaving the reader to discover it as a false negative.
  const root = scaffold(executionMatrix("| FR-ED-1 | editor | vitest | only defined once | present | |\n"), {
    vitest: "it('only defined once', () => {});\n",
  });
  const opts = { repoRoot: root, kind: "vitest" };
  assert.equal(findTest({ ...opts, id: "only defined once" }), "active");
  assert.equal(findTest({ ...opts, id: "src/thing.test.ts::only defined once" }), "missing");
  assert.equal(findTest({ ...opts, id: splitTestId("src/thing.test.ts::only defined once").name }), "active");
  rmSync(root, { recursive: true, force: true });
});
