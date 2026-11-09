// ABOUTME: Reads each suite's own results artifact into the test names that EXECUTED and the files they ran in.
// ABOUTME: The evidence half of the test-plan §9 gate (#1814) — check-test-matrix.mjs owns the verdict.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An artifact file is named `<kind>[-<label>].<ext>`: the kind before the first `-` (or the
// extension) picks the parser, and the optional label keeps several runs of one kind — two
// OS matrix legs, two node:test suites — side by side in one directory. Naming the kind is
// deliberate: content-sniffing would let a mistyped or truncated file degrade silently into
// "this run produced no evidence for that kind", which is the exact failure mode (#1124)
// this whole check exists to make impossible.
//
// The `KIND_READERS` table below is the one definition of the convention, for producers as well
// as consumers: `.github/workflows/windows-self-hosted.yml` and `playwright.config.mjs` name
// files to match it, and check-test-matrix.test.mjs pins it against that file's own `KINDS` table
// so a kind can never be existence-checked without also being evidenceable.

/**
 * Executed records keyed by test name, each carrying the set of files it ran in. A name with an
 * EMPTY file set ran in a kind that cannot say where — that is why the caller consults
 * `FILE_BOUND_KINDS` rather than inferring "no files" as "no evidence".
 */
function recordExecuted(executed, name, file) {
  if (typeof name !== "string" || name === "") return;
  const files = executed.get(name) ?? new Set();
  if (typeof file === "string" && file !== "") files.add(toPosixPath(file));
  executed.set(name, files);
}

/**
 * Results documents spell paths however their producer found them — vitest emits an absolute
 * POSIX-slashed path, the node:test reporter an absolute Windows one, Playwright a path relative
 * to its own `rootDir`. Only the separator is normalised here; matching a report path against a
 * repo-relative source path is the checker's job, because only it knows the repo root.
 */
export function toPosixPath(path) {
  return String(path).split("\\").join("/");
}

/** `rust-windows.txt` -> "rust"; `vitest.json` -> "vitest"; `results.json` -> null. */
export function artifactKind(filename) {
  const stem = filename.replace(/\.[^.]*$/, "");
  const kind = stem.split("-")[0];
  return RESULT_KINDS.includes(kind) ? kind : null;
}

// The merge gate's runner has `CARGO_TERM_COLOR=always` set at the machine level (not in the
// workflow — a persistent host setting, confirmed by reading two of its own CI runs' step
// environments, #2308 review round 1), so cargo's own status-verb lines arrive wrapped in ANSI: a
// CSI SGR sequence around the verb itself (`ESC [ 1 m ESC [ 92 m Running ESC [ 0 m …`), and — on
// at least `Finished` — an OSC 8 hyperlink wrapping the whole rest of the line (`ESC ] 8 ; ; <url>
// ESC \ ... ESC ] 8 ; ; ESC \`), reproduced locally from this repo's own real cargo 1.97 output
// with that variable set, byte-identical in shape to the runner's own captured log lines. Neither
// survives a real gate run unstripped: `RUNNING_HEADER_RE` anchors `^\s*Running`, which an ESC byte
// at line-start defeats outright. `stripAnsiEscapes` runs over the WHOLE transcript once, before
// any line is inspected, so no line-matching regex below has to special-case where cargo chose to
// put a color or hyperlink escape — including one it does not use today but might tomorrow.
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsiEscapes(text) {
  return text.replace(ANSI_ESCAPE_RE, "");
}

// cargo's OWN progress line, e.g. `     Running unittests src\lib.rs (…\deps\emend_lib-19120b3956d52537.exe)`
// or `     Running tests\project_mcp_server.rs (…\deps\project_mcp_server-00d2a193c891da30.exe)`.
// Printed on cargo's STDERR, before it spawns the named binary and blocks until that binary
// exits — so in a merged transcript every `test … ok` line that follows one of these headers, up
// to the next one, is that header's own binary's output (verified against a real
// `cargo test --workspace 2>&1` capture on this repo, not assumed — #2308). Matched AFTER
// `stripAnsiEscapes` has already run, so this pattern itself never needs to tolerate color codes.
const RUNNING_HEADER_RE = /^\s*Running \S.*? \(([^()]+)\)\r?$/;

// A compiled artifact's file name never contains a `-` (Cargo requirement — a hyphenated
// crate/package name is legal in Cargo.toml but illegal in a linked binary's name, so cargo
// always substitutes `_`), and is suffixed with a 16-hex-digit build hash plus, on Windows,
// `.exe`. Stripping both leaves exactly the crate/binary identity the name encodes.
const HASHED_BINARY_RE = /^(.+)-[0-9a-f]{16}$/i;

// A libtest result line: `test <path> ... <outcome>`, or `test <path> - should panic ... <outcome>`
// for a `#[should_panic]` test. Hoisted beside `RUNNING_HEADER_RE`/`HASHED_BINARY_RE` rather than
// compiled fresh per line, now that parsing walks the transcript line by line for the `Running`
// header state (below) instead of a single whole-string `matchAll`.
const RESULT_LINE_RE = /^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored)\r?$/;

function crateBinaryFromPath(binaryPath) {
  // `String.prototype.split` always returns at least one element, so `.pop()` here is never
  // `undefined` — there is no empty-path fallback to guard.
  const base = String(binaryPath).split(/[\\/]/).pop();
  const stem = base.replace(/\.exe$/i, "");
  const hashed = HASHED_BINARY_RE.exec(stem);
  return hashed ? hashed[1] : stem;
}

/**
 * libtest's stable human-readable output — what `cargo test` prints on the pinned stable
 * toolchain. `--format json` is still `-Z unstable-options` (nightly only) at Rust 1.97, and
 * the repo does not use cargo-nextest, so this is the format actually available to CI.
 *
 * A result line is `test <path> ... <outcome>`, or `test <path> - should panic ... <outcome>`
 * for a `#[should_panic]` test — that infix is why the annotation is matched explicitly rather
 * than assumed away. libtest reports the full module path (`editor::tests::round_trips`); only
 * the last segment is recorded, because `extractRust` in check-test-matrix.mjs indexes bare `fn`
 * names, so a path-spelled matrix id fails the existence half and never reaches this set at all.
 * Doc-test lines (`test src/lib.rs - foo (line 3) ... ok`) carry a different infix and are not
 * matched, since no matrix row names one.
 *
 * The module path is NOT a file path in general — resolving an arbitrary `mod` tree would need a
 * Rust module-tree resolver this script does not have — so `rust` stays out of `FILE_BOUND_KINDS`
 * and a BARE rust id is still credited by name alone (sound: the existence half's ambiguity error
 * already refused any bare name several files define, so a bare match names one definition).
 *
 * The FULL path is kept here regardless (not just the leaf `pop()`ped name), because
 * check-test-matrix.mjs's `ranInDefiningFile` uses it to check a FILE-QUALIFIED id's module prefix
 * against its named file's own conventional module path (#2276, test-plan §9 item f-1) — the one
 * case libtest's transcript actually can prove, even without a general resolver.
 *
 * `crateOf` is the crate/binary identity (f-1)'s remaining residuals named as unavailable — it
 * IS available, on cargo's stderr, once the caller merges it into the captured transcript (#2308).
 * Keyed by the same full module-path string `executed` stores (not by the bare leaf name: two
 * DIFFERENT crates producing the identical module path is exactly the collision this exists to
 * catch, so collapsing to the leaf name here would erase the one thing being checked), each value
 * is the SET of crate binaries a "Running" header named while that exact path's line was printed
 * — a plain Map assembled directly here rather than through `recordExecuted`, whose string-only
 * guard exists for the OTHER kinds' file lists and would silently drop a non-string entry. An
 * artifact with no `Running` lines at all (a transcript captured before this card, or hand-built
 * without one) leaves `crateOf` empty — the caller's signal to fall back to the pre-#2308
 * name/prefix-only credit rather than refuse everything for evidence that was never captured. The
 * SAME thing happens, wrongly, if `Running` lines are present but unmatched because of an
 * unstripped color code — which is exactly why stripping runs first, unconditionally, rather than
 * only when a header line "looks" colored (#2308 review round 1, Critical 2: the merge gate's own
 * `CARGO_TERM_COLOR=always` made every `Running` line invisible to this parser, silently, with the
 * whole suite green).
 */
export function parseCargoTestOutput(text) {
  const executed = new Map();
  const crateOf = new Map();
  let seen = 0;
  let currentCrateBinary = null;
  for (const line of stripAnsiEscapes(String(text ?? "")).split(/\r?\n/)) {
    const header = RUNNING_HEADER_RE.exec(line);
    if (header) {
      currentCrateBinary = crateBinaryFromPath(header[1]);
      continue;
    }
    const result = RESULT_LINE_RE.exec(line);
    if (!result) continue;
    const [, path, outcome] = result;
    seen += 1;
    if (outcome === "ignored") continue;
    recordExecuted(executed, path.split("::").pop(), path);
    if (currentCrateBinary != null) {
      const binaries = crateOf.get(path) ?? new Set();
      binaries.add(currentCrateBinary);
      crateOf.set(path, binaries);
    }
  }
  return { executed, seen, crateOf };
}

/**
 * Vitest's JSON reporter (jest-compatible). `status` is `passed`/`failed`/`pending`/`todo`;
 * only the first two mean an assertion body actually ran. A `describe` block never appears
 * as its own result, so suite names are recovered from `ancestorTitles` — the matrix names
 * `describe(...)` titles as freely as `it(...)` ones.
 *
 * Every name — leaf and ancestor alike — is filed under the `testResults` entry's own `name`,
 * which vitest sets to the test file's absolute path. Filing the ancestors under that same file
 * is what makes crediting them honest: a `describe` body demonstrably ran in THIS file, whereas
 * before #2250 it was pooled by bare title and credited a same-titled row belonging to another
 * file entirely.
 */
export function parseVitestJson(text) {
  const doc = JSON.parse(text);
  const executed = new Map();
  let seen = 0;
  for (const file of doc?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      seen += 1;
      if (assertion?.status !== "passed" && assertion?.status !== "failed") continue;
      for (const name of [assertion?.title, ...(assertion?.ancestorTitles ?? [])]) {
        recordExecuted(executed, name, file?.name);
      }
    }
  }
  return { executed, seen };
}

/**
 * Playwright's JSON reporter. Leaf cases are `spec.title` under nested `suites`; a
 * `test.describe` block is a suite whose `title` differs from the file it came from (the
 * top-level suite's title IS its file path, which is not a matrix id). A result status of
 * `skipped`/`interrupted` means the body never ran; `passed`/`failed`/`timedOut` mean it did.
 *
 * A case excluded by the gate's own `--grep-invert @quarantine` (#1403) is simply absent from
 * this document — which is exactly how a quarantined test reads as "did not execute".
 */
export function parsePlaywrightJson(text) {
  const doc = JSON.parse(text);
  const executed = new Map();
  const ranStatuses = new Set(["passed", "failed", "timedOut"]);
  let seen = 0;

  // `JSONReportSuite.file` and `JSONReportSpec.file` are both required in Playwright's own
  // reporter types, but a nested suite inherits its parent's file when one is somehow absent,
  // so a missing field degrades to the enclosing file rather than to no binding at all.
  const visit = (suite, inheritedFile) => {
    const file = typeof suite?.file === "string" && suite.file !== "" ? suite.file : inheritedFile;
    if (typeof suite?.title === "string" && suite.title !== "" && suite.title !== suite.file) {
      seen += 1;
      recordExecuted(executed, suite.title, file); // a suite reached at all had its own body evaluated
    }
    for (const spec of suite?.specs ?? []) {
      if (typeof spec?.title !== "string" || spec.title === "") continue;
      seen += 1;
      if ((spec.tests ?? []).some((t) => (t?.results ?? []).some((r) => ranStatuses.has(r?.status)))) {
        recordExecuted(executed, spec.title, typeof spec.file === "string" && spec.file !== "" ? spec.file : file);
      }
    }
    for (const child of suite?.suites ?? []) visit(child, file);
  };
  for (const suite of doc?.suites ?? []) visit(suite, null);
  return { executed, seen };
}

/**
 * The JSONL appended by scripts/node-test-results-reporter.mjs — one `{name, status, file}`
 * per finished test or suite. JSONL lets several `node --test` invocations append to one
 * results directory without replacing earlier evidence.
 */
export function parseNodeResultsJsonl(text) {
  const executed = new Map();
  let seen = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (typeof entry?.name !== "string" || entry.name === "") continue;
    seen += 1;
    if (entry.status === "pass" || entry.status === "fail") recordExecuted(executed, entry.name, entry.file);
  }
  return { executed, seen };
}

/**
 * Decode an artifact by its byte-order mark rather than by assuming an encoding.
 *
 * The merge venue writes the cargo transcript through inbox Windows PowerShell 5.1, whose
 * `Tee-Object -FilePath` has no `-Encoding` parameter and emits UTF-16LE WITH A BOM (verified on
 * a real 5.1.26100.9278 host: the file begins `ff fe 72 00 75 00`). Read as UTF-8 that transcript
 * yields ZERO matches — not an error — so the kind stays in the evidence map and every rust row
 * reports "did not execute". CI run 33704545231 credited exactly 0 of 1208 rust ids for this.
 *
 * Sniffing the BOM, rather than pinning the producer to one encoding, is deliberate: the shell at
 * the venue is not ours to control, and the same silent-zero failure would return the moment a
 * step, runner image, or PowerShell version changed how it writes. No BOM means UTF-8, which is
 * what every other producer here emits.
 */
export function decodeArtifact(bytes) {
  if (typeof bytes === "string") return bytes;
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      // UTF-16BE: Node has no such decoder, so swap each pair into LE order first.
      const swapped = Buffer.from(bytes.subarray(2));
      swapped.swap16();
      return swapped.toString("utf16le");
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  const text = bytes.toString("utf8");
  // Fail closed instead of returning plausible rubbish. A BOM-less UTF-16 payload has no mark to
  // sniff, and read as UTF-8 it yields NUL-interleaved text that every parser here matches ZERO
  // of — the silent zero this module exists to prevent, reappearing one level down. NUL is not
  // legitimate in a libtest transcript, a JSON document, or JSONL, so its presence proves the
  // bytes are not what they were read as. Round 2 of this card's review recorded this hole by
  // execution; the journal then described it as closed. This is the code that makes that true.
  if (text.includes("\u0000")) {
    throw new Error(
      "decoded text contains NUL, so these bytes are neither UTF-8 nor BOM-marked " +
        "(a BOM-less UTF-16 producer is the usual cause) — emit the artifact as UTF-8, or with a BOM",
    );
  }
  return text;
}
/**
 * One record per kind: how to read its results document, and whether that document says WHICH
 * FILE each record ran in. `namesFiles` lives HERE, beside the parser that would have to produce
 * the file, rather than in a second list keyed by kind name — a fifth kind added to this table
 * cannot then be silently credited by bare name because someone forgot the other list, and a
 * silent loosening is the exact failure class #2250 exists to close.
 *
 * vitest names the file on every `testResults` entry, Playwright on every suite and spec, and
 * `scripts/node-test-results-reporter.mjs` writes `file` on every line. libtest prints a module
 * path and no file at all, so `rust` reads `false` and its rows stay name-matched — a residual
 * stated in test-plan §9 rather than papered over.
 */
const KIND_READERS = {
  rust: { parse: parseCargoTestOutput, namesFiles: false },
  vitest: { parse: parseVitestJson, namesFiles: true },
  e2e: { parse: parsePlaywrightJson, namesFiles: true },
  node: { parse: parseNodeResultsJsonl, namesFiles: true },
};

export const RESULT_KINDS = Object.keys(KIND_READERS);

/** The kinds whose results can be bound to a defining file (#2250) — derived, never re-listed. */
export const FILE_BOUND_KINDS = new Set(RESULT_KINDS.filter((kind) => KIND_READERS[kind].namesFiles));

/**
 * Read every artifact in `dir` into `{ byKind, errors }`. `byKind` maps a kind to
 * `{ executed, files, crateOf }`, where `executed` is a `Map<testName, Set<sourceFile>>`, `files`
 * names the artifacts it was read from, and `crateOf` (populated only for `rust`, #2308) is a
 * `Map<modulePath, Set<crateBinary>>` recovered from cargo's own `Running` headers; a kind absent
 * from the map had no artifact at all, which the caller decides how to treat. A parse failure is
 * an error rather than an empty result set: an unreadable artifact proves nothing, and silently
 * reading it as "nothing executed" would turn one broken reporter into a whole suite's worth of
 * confusing row failures.
 */
export function readExecutionArtifacts({ dir, readFile = readFileSync }) {
  const errors = [];
  const byKind = new Map();

  let entries;
  try {
    // withFileTypes matches walk()'s idiom in check-test-matrix.mjs and makes the missing
    // directory a single throw rather than a per-entry probe.
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    errors.push(`--artifacts ${dir}: no such results directory — CI must produce one before the execution check can run`);
    return { byKind, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const kind = artifactKind(name);
    if (!kind) {
      errors.push(
        `--artifacts: "${name}" names no known test kind — an artifact filename must start with one of ${RESULT_KINDS.join(", ")} (e.g. vitest-ubuntu.json)`,
      );
      continue;
    }
    let parsed;
    let bytes;
    try {
      bytes = readFile(join(dir, name));
      parsed = KIND_READERS[kind].parse(decodeArtifact(bytes));
    } catch (error) {
      errors.push(`--artifacts: "${name}" could not be parsed as ${kind} results — ${error.message}`);
      continue;
    }
    const bucket = byKind.get(kind) ?? { executed: new Map(), files: [], crateOf: new Map() };
    // A parser that recognised NO records in a non-empty file has not observed an empty run; it
    // has failed to read the file. Distinguishing the two is the whole point: an all-ignored
    // cargo transcript or an all-skipped vitest run legitimately executes nothing, and both still
    // RECOGNISE their records. Only a format or encoding mismatch recognises none.
    if (parsed.seen === 0) {
      errors.push(
        `--artifacts: "${name}" yielded no recognisable ${kind} test records` +
          `${bytes.length === 0 ? " (the file is empty)" : ` (${bytes.length} bytes read)`}` +
          " — treat this as an unreadable artifact, not as a run that executed nothing",
      );
      continue;
    }
    for (const [id, sources] of parsed.executed) {
      const merged = bucket.executed.get(id) ?? new Set();
      for (const source of sources) merged.add(source);
      bucket.executed.set(id, merged);
    }
    // Only `rust`'s parser returns this (#2308); every other kind's `parsed.crateOf` is undefined
    // and the loop below is simply skipped, leaving the bucket's `crateOf` empty exactly as it is
    // for every kind that has no crate concept.
    for (const [path, binaries] of parsed.crateOf ?? []) {
      const merged = bucket.crateOf.get(path) ?? new Set();
      for (const binary of binaries) merged.add(binary);
      bucket.crateOf.set(path, merged);
    }
    bucket.files.push(name);
    byKind.set(kind, bucket);
  }

  return { byKind, errors };
}
