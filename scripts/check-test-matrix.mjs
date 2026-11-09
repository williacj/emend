// ABOUTME: CI enforcement for docs/test-matrix.md (test-plan §9) — the FR-traceability gate.
// ABOUTME: Fails when a matrix row names a test that does not exist/would not run/did not execute in its own defining file, when a bare title is defined in several files, when a spec FR/property has no row, or when a blank line detaches a row from its table header.
// ABOUTME: Also fails a present-not-gating row that mixes executed and non-executed test ids (a relabelled mixed row), and a row naming a test-plan §6 bench-only assertion under any status but present-not-gating.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FILE_BOUND_KINDS, RESULT_KINDS, readExecutionArtifacts, toPosixPath } from "./test-execution-results.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// Placeholder tokens that mean "no test named yet" (a pending row).
const PLACEHOLDERS = new Set(["—", "-", "–", "", "n/a", "na", "tbd", "pending"]);

// Directory names that never contain first-party test sources.
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "dist-ssr", ".git", "spikes"]);

// #1239: a title built by template-literal interpolation (`` `built at ${when}` ``) has no
// literal source text to match against — the matrix id would have to be the interpolated
// runtime value, which this extractor can never see statically. Surfaced only when a JS-kind
// row's test truly isn't found, so a plain typo doesn't get a misleading nudge toward it.
const JS_DYNAMIC_TITLE_HINT =
  "note: a title built by template-literal interpolation (e.g. `${var}`) has no literal source text to match and cannot be resolved by static extraction";

// Where each test kind's sources live and how named tests are defined there.
// `roots` are repo-relative; missing roots are tolerated (tests not built yet).
// Each kind's `extract(text)` returns an index whose values are "active" (a
// runnable test) or "disabled" (present but ignored/skipped — would not run).
const KINDS = {
  // Rust unit/proptest: `fn <id>` (proptest! bodies use plain `fn` too). Ignore
  // status is read from the attribute block, not a char window — `#[ignore =
  // "long reason"]`, doc comments, or extra attributes between #[ignore] and fn
  // must not slip past.
  rust: {
    roots: ["src-tauri"],
    exts: [".rs"],
    extract: extractRust,
  },
  // Frontend component tests (vitest): a string title on it()/test()/describe(). Includes
  // `tests/perf` (test-plan §6 benchmarks) — same framework/authoring style as `src`/`tests/unit`,
  // just run via `npm run test:perf` instead of `npm test` (a tracked benchmark, not a PR gate).
  vitest: {
    roots: ["src", "tests/unit", "tests/perf"],
    exts: [".ts", ".tsx", ".js", ".jsx"],
    extract: (text) => extractJsTitles(text, ["it", "test", "describe"], ["skip", "todo"]),
    notFoundHint: JS_DYNAMIC_TITLE_HINT,
  },
  // End-to-end (Playwright): same string-title shape, different tree. `describe` is in the
  // keyword list for the same reason it is for `vitest`/`node` — the matrix names a
  // `test.describe(...)` journey block as freely as a leaf case, and `\bdescribe\s*\(` matches
  // inside `test.describe(` because the word boundary falls after the dot (#2235).
  e2e: {
    roots: ["tests/e2e", "e2e"],
    exts: [".ts", ".tsx", ".js", ".mjs"],
    extract: (text) => extractJsTitles(text, ["test", "it", "describe"], ["skip", "fixme", "todo"]),
    notFoundHint: JS_DYNAMIC_TITLE_HINT,
  },
  // node:test tooling tests (e.g. this script's own self-test): a string title.
  node: {
    roots: ["scripts", "tests/tooling"],
    exts: [".mjs", ".js"],
    extract: (text) => extractJsTitles(text, ["test", "it", "describe"], ["skip", "todo"]),
    notFoundHint: JS_DYNAMIC_TITLE_HINT,
  },
};

// A single JS/TS quoted string literal — `'…'`, `"…"`, or `` `…` `` — captured with its
// delimiter (group 1) and raw contents (group 2). `\\.` consumes a backslash-escaped
// character, including an escaped delimiter, before the "stop at the matching unescaped
// delimiter" lookahead (`(?!\1)`) gets a chance to end the match early — the bug this fixes
// (#1239) was exactly that early stop, e.g. at the `\'` in `'reconcile()\'s disposition…'`.
const QUOTED_TITLE = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/;

// A JS test declaration `it('id', …)` is active; `it.skip('id', …)` is disabled. Active wins
// if both forms of the same title appear anywhere in the corpus. Capture every full quoted
// literal — escapes and all — then unescape it into the same plain-text form the matrix uses,
// so escaped quotes and plain template literals resolve under their real names (#1239).
function extractJsTitles(text, defKeywords, skipKeywords) {
  const kw = defKeywords.join("|");
  const active = new RegExp(`\\b(?:${kw})\\s*\\(\\s*${QUOTED_TITLE.source}`, "g");
  const disabled = new RegExp(`\\b(?:${kw})\\.(?:${skipKeywords.join("|")})\\s*\\(\\s*${QUOTED_TITLE.source}`, "g");
  const index = new Map();
  collectJsTitles(text, disabled, "disabled", index);
  collectJsTitles(text, active, "active", index);
  return index;
}

function collectJsTitles(text, re, state, index) {
  let m;
  while ((m = re.exec(text))) {
    mergeTestState(index, unescapeJsString(m[2]), state);
    if (m.index === re.lastIndex) re.lastIndex++; // guard: a zero-width match must not loop forever
  }
}

// Undoes JS string-literal escaping well enough to compare an extracted title against the
// matrix's plain-text id: an escaped delimiter (`\'`, `\"`, `` \` ``) or backslash collapses
// to the bare character, `\n`/`\t`/`\r` become their control characters, and any other
// escaped character keeps its own meaning — same as JS itself dropping the backslash on an
// escape it doesn't otherwise recognise.
function unescapeJsString(raw) {
  return raw.replace(/\\(.)/gs, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch));
}

// For each `fn <id>` definition, scan the contiguous block of attributes / doc
// comments / blank lines immediately above it: if any attribute is `#[ignore…]`
// (`#[ignore]` or `#[ignore = "…"]`), that test would not run. Active wins if
// any un-ignored definition of the name exists.
function extractRust(text) {
  const lines = text.split(/\r?\n/);
  const def = /\bfn\s+((?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*)\s*[(<]/gu;
  const index = new Map();
  for (let i = 0; i < lines.length; i++) {
    const matches = [...lines[i].matchAll(def)];
    if (matches.length === 0) continue;
    let ignored = false;
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (line === "") continue; // blank between attributes — keep scanning
      if (line.startsWith("//")) continue; // doc/line comment
      if (line.startsWith("#[") || line.startsWith("#![")) {
        // Bare `#[ignore]` / `#[ignore = "…"]`, or conditional
        // `#[cfg_attr(<cond>, …, ignore, …)]` where `ignore` is one of the
        // applied attributes (after the leading cfg predicate) — both disable
        // the test on the matching config. `ignore` must be a standalone arg,
        // so `#[cfg_attr(feature = "x", should_panic)]` stays active.
        if (/^#!?\[\s*ignore\b/.test(line) || /\bcfg_attr\s*\(.*,\s*ignore\b\s*[,)]/.test(line)) ignored = true;
        continue; // another attribute (#[test], #[cfg(...)], …)
      }
      break; // first real code line — attribute block has ended
    }
    for (const match of matches) {
      mergeTestState(index, match[1], ignored ? "disabled" : "active");
    }
  }
  return index;
}

function mergeTestState(index, id, state) {
  if (state === "active" || !index.has(id)) index.set(id, state);
}

// The kinds a row can name real tests in. Exported so the execution half's own kind list
// (`RESULT_KINDS`) can be pinned against it: a kind that is existence-checked here but has no
// results parser would be permanently unevidenceable, and the failure would surface as a
// confusing "names no known test kind" on the artifact rather than as a missing parser.
export const CODE_KINDS = Object.keys(KINDS);

// Kinds that do not point at a checked-in test (row is intentionally not
// existence-checked, only counted for completeness).
const NON_CODE_KINDS = new Set(["pending", "descoped", "manual", "release-gate"]);

// The third matrix state (test-plan §9, ratified by CJ 2026-09-02): the row's named tests
// exist and are active, but at least one of them runs only OUTSIDE the blocking gate — a
// `@quarantine`-tagged e2e case (#1403), or a tracked benchmark that is deliberately never a
// PR gate (test-plan §6). Flattening those into `present` is what let #1124 read as coverage
// for a month, so they get their own status rather than sharing one.
const NOT_GATING_STATUS = "present-not-gating";

// Deliberately unmissable: the whole failure mode this check exists to kill is a weaker
// guarantee quietly reading as the strong one, so the fallback announces itself in a shape
// no one skims past.
function existenceOnlyBanner(reason) {
  return [
  "!! ================================================================== !!",
  "!!  EXECUTION CHECK SKIPPED — this run proved DEFINITION, not RUNNING  !!",
  "!! ================================================================== !!",
  `  ${reason}, so every named test was checked only for being a real,`,
  "  active definition in the sources. Nothing here shows that any of them EXECUTED.",
  "  A green result is NOT evidence that the suites ran (#1384, #1814; #1124 is the incident).",
  "  CI passes --artifacts and gets the strong check; `npm run matrix:check` locally does not.",
  ].join("\n");
}

// --- Markdown table parsing -------------------------------------------------

// One pass over the markdown, producing both halves of what the file can contain: the
// parsed rows, and the row-shaped lines that arrived with no header above them.
// `parseMatrix` and `findOrphanRows` are thin views onto this so neither duplicates the
// tokenisation.
function scanMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = [];
  const orphans = [];
  let header = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    const norm = cells.map((c) => c.trim().toLowerCase());
    if (norm.includes("id") && norm.includes("status") && norm.includes("test kind")) {
      header = norm;
      continue;
    }
    if (!header) {
      // No column map to read an ID from, so take cell 0 — where the ID sits in every
      // table in this file.
      orphans.push({ line: i + 1, id: stripMd(cells[0] ?? "") });
      continue;
    }
    const get = (name) => {
      const i = header.indexOf(name);
      return i >= 0 && i < cells.length ? cells[i].trim() : "";
    };
    const id = stripMd(get("id"));
    if (!id) continue;
    rows.push({
      id,
      kind: stripMd(get("test kind")).toLowerCase(),
      testIds: parseTestIds(get("test ids")),
      status: stripMd(get("status")).toLowerCase(),
      requirement: get("requirement / invariant"),
    });
  }
  return { rows, orphans };
}

// Parse every GFM table that has an `ID`, `Test kind`, `Test IDs`, and `Status`
// column into row objects. Column order is read from the header, not assumed.
// Returns a bare array of rows — downstream tooling consumes this shape directly.
export function parseMatrix(markdown) {
  return scanMatrix(markdown).rows;
}

// The row-shaped lines that reached the parser with no header above them, each as
// `{ line, id }` with a 1-based line number. A blank line detaches the rows below it from
// their table: GFM stops rendering them as a table, and this parser cannot bind their
// cells to any column map — so they used to be dropped silently while the gate still
// reported green. `checkMatrix` turns each one into a hard error.
export function findOrphanRows(markdown) {
  return scanMatrix(markdown).orphans;
}

function splitRow(line) {
  // Split on unescaped pipes, dropping the leading/trailing empty cells.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|"));
}

function isSeparator(cells) {
  return cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

function stripMd(s) {
  return s.replace(/[`*]/g, "").trim();
}

function parseTestIds(cell) {
  return stripMd(cell)
    .split(/(?<!\\),/)
    .map((t) => t.replace(/\\,/g, ",").trim())
    .filter((t) => t && !PLACEHOLDERS.has(t.toLowerCase()));
}

// --- Required-ID extraction (the completeness half) -------------------------

// Every FR defined in the functional spec as a list item (`- FR-AREA-n …`) and
// every property defined in the test plan (`- **Pn …`) must have a matrix row.
// The FR match keys on the ID alone — NOT on a following `(MUST/SHOULD/COULD)`
// tag — so a cut/descoped FR like `- FR-ED-6: Cut from v1: …` is still required.
export function extractRequiredIds({ specText, testPlanText }) {
  const frs = [...specText.matchAll(/^\s*-\s+(FR-[A-Z]+-\d+[a-z]?)\b/gm)].map((m) => m[1]);
  const props = [...testPlanText.matchAll(/^\s*-\s+\*\*(P\d[a-z]?)\b/gm)].map((m) => m[1]);
  return { frs: unique(frs), props: unique(props) };
}

function unique(arr) {
  return [...new Set(arr)];
}

// --- Test existence ---------------------------------------------------------

function walk(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing root — tolerated
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(repoRoot, kind) {
  const spec = KINDS[kind];
  const files = [];
  for (const root of spec.roots) {
    walk(join(repoRoot, root), spec.exts, files); // walk() tolerates a missing root
  }
  return [...new Set(files)];
}

// A kind's index is `Map<testName, Map<repoRelativeFile, state>>` — the DEFINING FILE is kept,
// not collapsed away, because a bare title pooled across a whole kind is exactly what let a row
// be credited by a same-titled test in an unrelated file (#2250). State is merged per file
// (active wins over disabled within one file), so a title that is live in one file and `.skip`ped
// in another reports the truth for whichever file the row actually names.
function indexKind({ repoRoot, kind, readSourceFile }) {
  const spec = KINDS[kind];
  const index = new Map();
  for (const file of sourceFiles(repoRoot, kind)) {
    const rel = toPosixPath(relative(repoRoot, file));
    for (const [id, state] of spec.extract(readSourceFile(file, "utf8"))) {
      const byFile = index.get(id) ?? new Map();
      mergeTestState(byFile, rel, state);
      index.set(id, byFile);
    }
  }
  return index;
}

// Result: "active" (a live test), "disabled" (present but #[ignore]/.skip only),
// or "missing". Kind-wide, ignoring which file defines it — `checkMatrix` does the
// file-bound resolution; this stays the cheap "does this name exist anywhere" probe.
//
// `id` is a bare TITLE, never a `Test IDs` cell entry: a file-qualified entry handed here
// reports "missing", because the qualifier is part of no test's name. Split it with
// `splitTestId` first, or call `resolveTestId`, which takes cell entries and binds the file.
export function findTest({ repoRoot, kind, id, readSourceFile = readFileSync }) {
  const spec = KINDS[kind];
  if (!spec) return "missing";
  const byFile = indexKind({ repoRoot, kind, readSourceFile }).get(id);
  if (!byFile) return "missing";
  return [...byFile.values()].includes("active") ? "active" : "disabled";
}

// A `Test IDs` cell entry is either a bare title (`keystroke latency stays within budget`) or a
// FILE-QUALIFIED one (`tests/perf/budget.perf.test.ts::keystroke latency stays within budget`).
// Qualification is what a row uses to say which of two same-titled tests it means; the bare form
// stays legal and is the overwhelming majority, so this is an extension of the format, not a
// migration of every row.
//
// The left side is treated as a path only when it ends in one of the kinds' own source
// extensions and contains no `:` of its own — so `agent::mcp::open` and a Windows absolute path
// (`C:/…`) can never be mistaken for a qualifier.
//
// It is a SHAPE test, not a proof that the left side is a path: prose ending in an extension —
// `reads config.ts::default export` — does parse as a qualifier. That fails loudly and immediately
// (`wrong-file`, or not-found), never silently, because the named file must actually define the
// title; the failure direction is the safe one, and the cells below pin both spellings.
const SOURCE_EXTS = [...new Set(Object.values(KINDS).flatMap((k) => k.exts))];
const QUALIFIED_ID = new RegExp(`^([^\\s:][^:]*(?:${SOURCE_EXTS.map((e) => e.replace(".", "\\.")).join("|")}))::(.+)$`);

/** `{ file, name }` — `file` is null for the bare form. */
export function splitTestId(entry) {
  const match = QUALIFIED_ID.exec(entry);
  return match ? { file: toPosixPath(match[1]), name: match[2] } : { file: null, name: entry };
}

/**
 * Resolve one `Test IDs` entry against a kind's index into `{ name, file, state, files }`.
 *
 * `state` is one of the source states ("active"/"disabled"/"missing") or one of two binding
 * failures that only exist because the row must name ONE test:
 *   - "ambiguous"  — a bare title that several files define; nothing can say which one is meant.
 *   - "wrong-file" — a qualified title whose named file does not define it.
 * `file` is the single defining file the row resolved to, or null when it did not resolve to one.
 * `files` is the candidate list. The FULL list is gathered and sorted only on the two failure paths
 * that print it; a resolved id reports its own single file, because every one of the ~6,700 ids
 * resolved per CI run would otherwise pay for a spread and a sort that nothing reads.
 */
export function resolveTestId(index, entry) {
  const { file, name } = splitTestId(entry);
  const byFile = index.get(name);
  if (!byFile) return { name, file, state: "missing", files: [] };
  const candidates = () => [...byFile.keys()].sort();
  if (file) {
    const state = byFile.get(file);
    return state === undefined
      ? { name, file, state: "wrong-file", files: candidates() }
      : { name, file, state, files: [file] };
  }
  if (byFile.size > 1) return { name, file: null, state: "ambiguous", files: candidates() };
  const [only] = byFile.keys();
  return { name, file: only, state: byFile.get(only), files: [only] };
}

/**
 * Does a results document's file path denote the same file as this repo-relative source path?
 *
 * Compared as whole path SEGMENTS from the right, in either direction, because the two spellings
 * are produced by different tools and neither is canonical: vitest emits an absolute path and the
 * node:test reporter a Windows one (both longer than the repo-relative path), while Playwright
 * emits a path relative to its own `rootDir` — `acceptance.spec.mjs` for what the walk calls
 * `e2e/acceptance.spec.mjs` (shorter). Segment alignment is what stops `thing.test.ts` matching
 * `something.test.ts` — a partial basename is never a match.
 *
 * The weakness is therefore the SUFFIX RULE itself, not merely a shared basename: whichever path is
 * shorter is satisfied by every longer path it is a whole-segment suffix of. A bare `thing.spec.mjs`
 * matches both `e2e/thing.spec.mjs` and `e2e/support/thing.spec.mjs`; equally `scripts/x.test.mjs`
 * would be satisfied by a report path ending `…/other/scripts/x.test.mjs`. The ambiguity error
 * upstream does not close this — it fires when one TEST NAME has several defining files, not when
 * two FILES nest — so it is a real residual, named as one in test-plan §9 item (f-2) (ratified by
 * CJ 2026-09-03) rather than waved off here. Reachability is a DIFFERENT property in each direction,
 * so neither criterion alone covers all four kinds: where the report path is LONGER (vitest, node)
 * a collision needs one source path to be a whole-segment suffix of another — 0 such pairs across
 * all four walks — and where it is SHORTER (e2e, a bare basename) suffix-nesting is not the shape
 * that bites; two files sharing a basename at any depth is, and e2e has none (8 files). Unreachable
 * today, but by a property of the file tree that nothing enforces.
 */
function sameFile(resultPath, sourcePath) {
  const a = toPosixPath(resultPath).split("/").filter(Boolean);
  const b = toPosixPath(sourcePath).split("/").filter(Boolean);
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  for (let i = 1; i <= n; i++) {
    if (a[a.length - i] !== b[b.length - i]) return false;
  }
  return true;
}

/**
 * The module-path segments a rust source file's OWN repo-relative path would produce, under the
 * plain Rust convention this repo follows (verified against a real `cargo test --workspace`
 * transcript, not assumed — #2276): `mod x;` names a sibling `x.rs` (or `x/mod.rs`), so a file's
 * module path is exactly its path under a crate's `src/`, minus the `.rs` extension, with a
 * trailing `/mod` segment folded away (`mod.rs` names its own containing directory, not an extra
 * segment). A crate's OWN root file (`src/lib.rs`, `src/main.rs`) or an integration-test file
 * directly under `<crate>/tests/` contributes NO segment — it IS the module root libtest's
 * transcript starts numbering from — which is exactly why `resolvable && segments.length === 0`
 * is a distinct, deliberately unresolved case below rather than an empty match.
 *
 * A path outside this shape (a bench, `build.rs`, a nested `tests/<dir>/…` helper) reports
 * `resolvable: false` — this is a real, present shape (5 files today: two `benches/`, `build.rs`,
 * a `crates/*\/benches` file, `tests/common/mod.rs`) and NOT a residual to close, because falling
 * back to the old by-name credit for it never turns a currently-proven row unproven; it just leaves
 * that row exactly as unproven as every rust row was before this file (#2276).
 */
export function rustModuleSegments(sourcePath) {
  const posix = toPosixPath(sourcePath);
  let rest = null;
  let match;
  if ((match = /^src-tauri\/src\/(.+)\.rs$/.exec(posix))) rest = match[1];
  else if ((match = /^src-tauri\/crates\/[^/]+\/src\/(.+)\.rs$/.exec(posix))) rest = match[1];
  else if (/^src-tauri\/tests\/[^/]+\.rs$/.test(posix)) return { segments: [], resolvable: true };
  else if (/^src-tauri\/crates\/[^/]+\/tests\/[^/]+\.rs$/.test(posix)) return { segments: [], resolvable: true };
  else return { segments: [], resolvable: false };
  if (rest === "lib" || rest === "main") return { segments: [], resolvable: true };
  if (rest.endsWith("/mod")) rest = rest.slice(0, -"/mod".length);
  return { segments: rest.split("/"), resolvable: true };
}

/**
 * Does ANY of `name`'s recorded rust executions carry `fileSegments` as a PREFIX of its own module
 * path (leaf name dropped)? A prefix, not an exact match — deliberately, for two different reasons
 * this function conflates on purpose, and disclosure must not: (1) the recorded path also carries
 * whatever inline `mod tests { … }`-style wrapper the file itself chose (`tests`, `io_tests`,
 * `fold_properties`, …) between the file's own module and the leaf test name, and this check has no
 * way to know that wrapper's spelling — nor does it need to, since only the FILE-defining prefix
 * has to match; and (2) `fileSegments` derived from a module-ANCESTOR file (a `mod.rs`) is, by
 * definition, also a prefix of every descendant file's own segments — so a row naming an ancestor is
 * credited by an execution recorded in ANY file `mod`-declared beneath it, not only the named file.
 * This function has no way to tell a submodule file's own tests apart from an inline `mod x { … }`
 * block written directly inside the ancestor, which is exactly what reason (1) needs it to tolerate
 * — so reason (2) is accepted as the same cost, not screened out. It binds ancestor-or-self, not the
 * file alone: unreached by any of the 18 qualified rust ids live today (none names a `mod.rs`), but
 * the corpus has 43 real ancestor→descendant prefix pairs (`store/mod.rs` over 15 files,
 * `agent/mod.rs` over 12, `commands/mod.rs` over 12, `project_files/mod.rs` over 3, `skills/mod.rs`
 * over 1) — see test-plan §9 (f-1)'s third residual.
 *
 * Verified sound against the 18 qualified rust ids live in docs/test-matrix.md today (#2276): the
 * distinguishing prefix differs between every colliding pair (`store::settings` vs `store::docs_map`
 * vs `store::tab_session`, `store::changes` vs `store::comments`, `store::service` vs
 * `store::transcript`, `store::schema` vs a different crate's `tests::…`, `http_tool_server` vs a
 * bare integration-root name) — a check by prefix rather than name is what tells them apart. It DOES
 * now also vary on crate/binary identity: `crateMatches` (the caller's closure, built from cargo's
 * own `Running` headers — #2308) is checked alongside the segment-prefix match, on the same
 * `recordedPath`, so two DIFFERENT crates whose files happen to share an identical relative path are
 * told apart by their own recorded crate rather than credited on segment prefix alone. Checked
 * directly and unreachable LIVE today (no two crates' files currently collide this way) — `node -e`
 * walking every rust source file's derived segments across all crates finds zero duplicate non-root
 * segment lists among **108** files (**36** further files derive the empty/root list and share it —
 * see `rustModuleSegments`) — but "unreachable" here means "not present in the corpus today," not
 * "refused if it arose": the fixture `closing (f-1)'s second residual: two crates deriving the
 * identical module segments do not credit each other (#2308)` in
 * `scripts/check-test-matrix.test.mjs` builds the collision directly and proves it is refused.
 */
function ranInRustModulePrefix(ranIn, fileSegments, crateMatches) {
  for (const recordedPath of ranIn) {
    const parts = recordedPath.split("::");
    if (parts.length <= fileSegments.length) continue; // no room left for even the leaf name
    if (fileSegments.every((segment, i) => parts[i] === segment) && crateMatches(recordedPath)) return true;
  }
  return false;
}

/**
 * A minimal top-level TOML reader for the `[package]`/`[lib]`/`[[bin]]` tables' `name` key — the
 * same non-general-parser scope as `parseBenchTargets` (below), sharing its `parseTomlStringValue`
 * for the one value shape both need. No crate here declares more than one `[[bin]]` table, so only
 * the first is read.
 */
function parseCrateManifestNames(text) {
  let packageName = null;
  let libName = null;
  let binName = null;
  let section = null; // "package" | "lib" | "bin" | null
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (line === "[package]") {
      section = "package";
      continue;
    }
    if (line === "[lib]") {
      section = "lib";
      continue;
    }
    if (line === "[[bin]]") {
      section = binName == null ? "bin" : null;
      continue;
    }
    if (/^\[/.test(line)) {
      section = null;
      continue;
    }
    if (!section) continue;
    const m = /^name\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const name = parseTomlStringValue(m[1].trim());
    if (name == null) continue;
    if (section === "package") packageName = name;
    else if (section === "lib") libName = name;
    else if (section === "bin") binName = name;
  }
  return { packageName, libName, binName };
}

/**
 * Every crate manifest under the rust roots, reduced to the two facts `rustExpectedCrateBinary`
 * needs: its own repo-relative directory, and the binary FILE name cargo would produce for its lib
 * target and its bin target. Cargo always emits a target's compiled file name with every `-`
 * replaced by `_` regardless of whether the table gives an explicit override or the package-name
 * default applies (a hyphenated name is legal in Cargo.toml but never in a linked artifact's file
 * name) — verified against a real `cargo test --workspace 2>&1` transcript on this repo, not
 * assumed (#2308): the root crate's `[lib] name = "cowrite_lib"` override and every other crate's
 * un-overridden default both show up on cargo's own `Running` header exactly this way.
 */
export function findRustCrateManifests({ repoRoot, readSourceFile }) {
  const manifests = [];
  for (const { tomlPath, text } of readCargoManifests({ repoRoot, readSourceFile })) {
    const { packageName, libName, binName } = parseCrateManifestNames(text);
    if (!packageName) continue;
    const crateDir = toPosixPath(relative(repoRoot, dirname(tomlPath)));
    manifests.push({
      crateDir,
      libBinary: (libName ?? packageName).replace(/-/g, "_"),
      binBinary: (binName ?? packageName).replace(/-/g, "_"),
    });
  }
  return manifests;
}

/**
 * The crate binary name a "Running" header would show if `sourcePath`'s own tests ran — the fact
 * libtest's transcript omits and cargo's stderr carries instead (test-plan §9 (f-1), #2308). An
 * integration-test file (`<crate>/tests/<name>.rs`) IS its own crate, named after itself, exactly
 * like `rustModuleSegments` already treats it as its own (empty) module root; `src/main.rs` is its
 * crate's bin target; every other `src/**` file compiles into its crate's lib target. Anything
 * else (a bench, `build.rs`, a nested `tests/<dir>/helper.rs`) is unresolved — the same five files
 * `rustModuleSegments` already reports `resolvable: false` for — and returns `null`, the same
 * "nothing to check against" signal `rustModuleSegments`'s callers already handle.
 */
export function rustExpectedCrateBinary(sourcePath, crateManifests) {
  const posix = toPosixPath(sourcePath);
  let match;
  if ((match = /^src-tauri\/tests\/([^/]+)\.rs$/.exec(posix))) return match[1].replace(/-/g, "_");
  if ((match = /^src-tauri\/crates\/[^/]+\/tests\/([^/]+)\.rs$/.exec(posix))) return match[1].replace(/-/g, "_");
  for (const manifest of crateManifests) {
    if (posix === `${manifest.crateDir}/src/main.rs`) return manifest.binBinary;
    if (posix.startsWith(`${manifest.crateDir}/src/`)) return manifest.libBinary;
  }
  return null;
}

/**
 * Did this kind's results record `name` running in the file that DEFINES it (#2250)?
 *
 * Without the file check the gate proved "a test with this title ran somewhere in this kind",
 * which a same-titled test in an unrelated file satisfies. A kind outside `FILE_BOUND_KINDS`
 * reports no file at all — `rust`, whose libtest transcript prints a module path — so a BARE rust
 * id is credited by name; that stays sound because the existence half's ambiguity error already
 * refused any bare name several files define (#2274).
 *
 * A QUALIFIED rust id is different: qualifying is exactly what silences that ambiguity check
 * (test-plan §9 item f-1, #2276), so the id's own file must be checked against the module path the
 * evidence actually carries — via `rustModuleSegments`/`ranInRustModulePrefix` above — rather than
 * credited by name alone.
 *
 * Two of (f-1)'s three residuals were that a candidate's CRATE/BINARY identity could not be
 * checked at all — libtest's own transcript never names it — leaving a crate/integration-test-root
 * qualifier (an empty module prefix, indistinguishable from another crate's) and a same-segment
 * collision across crates both open. `getRustCrateManifests()`/`rustExpectedCrateBinary` recover
 * that identity from cargo's stderr instead (#2308), and `crateMatches` below checks it PER
 * RECORD: a `recordedPath` with no `crateOf` entry — an artifact captured before this card, one
 * hand-built without a `Running` header, or (in principle) a result line parsed before the first
 * header this run ever printed — carries no crate evidence to refuse it by, so it falls back
 * unchanged to the pre-#2308 name/prefix-only credit rather than reading crate data recorded for
 * some OTHER path in this same run as if it applied here too. The third residual — a `mod.rs`
 * ancestor credited by any descendant's own execution — is untouched: crate identity says WHICH
 * BINARY a path ran in, never which FILE within that binary defined it, so it cannot tell a
 * submodule's own test apart from its ancestor's; that still needs a mod-tree resolver this card
 * does not build.
 *
 * The crate-root/integration-test-root/unwalked case needs no branch of its own: `rustModuleSegments`
 * only ever returns a NON-empty `segments` for the genuine prefix case (a resolvable, non-root
 * `src/**` file) — every other outcome is `[]`, resolvable or not — and an empty prefix trivially
 * satisfies `ranInRustModulePrefix`'s own "room for a leaf name" and "every segment matches" checks,
 * leaving exactly `crateMatches` to decide. So `ranInRustModulePrefix` alone covers every rust shape.
 */
function ranInDefiningFile(kindEvidence, kind, name, definingFile, wasQualified, getRustCrateManifests) {
  const ranIn = kindEvidence.executed.get(name);
  if (!ranIn) return false;
  if (kind === "rust" && wasQualified) {
    const { segments } = rustModuleSegments(definingFile);
    const crateOf = kindEvidence.crateOf ?? new Map();
    const expectedCrate = rustExpectedCrateBinary(definingFile, getRustCrateManifests());
    const crateMatches = (recordedPath) => {
      if (expectedCrate == null) return true; // an unresolvable defining file — the named residual
      const binaries = crateOf.get(recordedPath);
      return binaries ? binaries.has(expectedCrate) : true; // no crate evidence for THIS record
    };
    return ranInRustModulePrefix(ranIn, segments, crateMatches);
  }
  if (!FILE_BOUND_KINDS.has(kind)) return true;
  for (const path of ranIn) {
    if (sameFile(path, definingFile)) return true;
  }
  return false;
}

// --- Bench-only assertions (test-plan §6; test-matrix.md Test IDs legend) ---------------------
//
// The legend's one sanctioned exception: a plain `fn` a `harness = false` bench binary's own
// `main` calls, from a `[[bench]]` target its crate's Cargo.toml explicitly declares
// `test = false` — no `cargo test` run on any platform ever reaches it, so it "may be named
// only by a present-not-gating row that says so." `extractRust` indexes every `fn` under
// `src-tauri` regardless of which target's tree it sits in, so existence-checking alone cannot
// tell such an assertion apart from an ordinary `#[test]`. The one extra fact the legend's rule
// needs is which FILES are bench-only-target sources, read directly from the Cargo.toml that
// makes a target bench-only in the first place rather than guessed from directory conventions;
// a row is checked against that file set through `resolved.file`, the same defining-file
// resolution every other id-level branch below already uses.

// TOML comments start with `#` outside a string; strip one before parsing so a trailing comment
// on a value, or on the `[[bench]]` header itself, cannot silently take the whole line — or the
// whole block, for the header — out of the parse (a `#` inside a quoted string is not a
// comment). This walks the line once, character by character, tracking which quote (if any) is
// currently open; it is not a general TOML tokenizer, just enough to find the first unquoted `#`.
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && (quote !== '"' || line[i - 1] !== "\\")) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

// A bare TOML value that is a double-quoted (basic, with `\`-escapes) or single-quoted (literal,
// unescaped) string — the one value shape `parseBenchTargets` and `parseCrateManifestNames` both
// need to read out of a `name`/`path` assignment. Returns `null` for anything else (a bare
// `true`/`false`, a bare number, an array, an inline table, …), which each caller handles itself.
function parseTomlStringValue(value) {
  const basic = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  if (basic) return basic[1].replace(/\\(.)/g, "$1");
  const literal = /^'([^']*)'$/.exec(value);
  return literal ? literal[1] : null;
}

// A minimal `[[bench]]` table reader: enough of TOML to read `name`/`path`/`test` out of this
// repo's own Cargo.toml files, not a general parser. Values are a bare `true`/`false`, a
// double-quoted (basic) string, or a single-quoted (literal, unescaped) string; anything else —
// arrays, inline tables, multi-line strings — is simply not captured, which is fine because no
// `[[bench]]` table here uses one.
function parseBenchTargets(text) {
  const targets = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (line === "[[bench]]") {
      current = {};
      targets.push(current);
      continue;
    }
    if (current && /^\[/.test(line)) {
      current = null; // left the [[bench]] block for another table
      continue;
    }
    if (!current) continue;
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (value === "true" || value === "false") current[m[1]] = value === "true";
    else {
      const stringValue = parseTomlStringValue(value);
      if (stringValue != null) current[m[1]] = stringValue;
    }
  }
  return targets;
}

// Every `Cargo.toml` under the rust roots, as its own text — the one walk+read `findBenchOnlyRustFiles`
// and `findRustCrateManifests` both need before their own per-purpose parse. An unreadable manifest
// is skipped rather than thrown: it names nothing either caller needs, and a caller is never
// authority to WIDEN what it found from a manifest it could not actually read.
function* readCargoManifests({ repoRoot, readSourceFile }) {
  for (const tomlPath of walk(join(repoRoot, "src-tauri"), ["Cargo.toml"], [])) {
    let text;
    try {
      text = readSourceFile(tomlPath, "utf8");
    } catch {
      continue;
    }
    yield { tomlPath, text };
  }
}

// Every repo-relative POSIX file path that is a `[[bench]]` target's source, for a target whose
// Cargo.toml explicitly declares `test = false` — read from every `Cargo.toml` under the rust
// roots. A target's source file defaults to Cargo's own convention (`<crate>/benches/<name>.rs`)
// unless the table gives an explicit `path`. A target this cannot read/resolve names nothing —
// it is never authority to WIDEN the set, only to record what it could actually find.
//
// Deliberately a set of FILES, not ids: `indexKind` (below, called once per kind at line ~622)
// already walks this exact tree for the `rust` kind and already knows, per id, which file
// defines it — that is `resolveTestId`'s `resolved.file`. Reading and re-`extractRust`ing every
// bench-only source a second time here would duplicate that work for information the run has
// already computed, so this stops at the cheap Cargo.toml-only fact and leaves the row-level
// check to compare against `resolved.file` instead of re-deriving fn names by hand.
function findBenchOnlyRustFiles({ repoRoot, readSourceFile }) {
  const files = new Set();
  for (const { tomlPath, text } of readCargoManifests({ repoRoot, readSourceFile })) {
    const crateDir = dirname(tomlPath);
    for (const target of parseBenchTargets(text)) {
      if (target.test !== false || typeof target.name !== "string" || !target.name) continue;
      const benchPath = join(crateDir, target.path ?? join("benches", `${target.name}.rs`));
      files.add(toPosixPath(relative(repoRoot, benchPath)));
    }
  }
  return files;
}

// --- Top-level check --------------------------------------------------------

export function checkMatrix({
  repoRoot = REPO_ROOT,
  matrixPath = join(repoRoot, "docs/test-matrix.md"),
  specPath = join(repoRoot, "docs/functional-spec.md"),
  testPlanPath = join(repoRoot, "docs/test-plan.md"),
  readSourceFile = readFileSync,
  // Opt-in execution evidence (#1814). Absent -> existence-only, loudly announced (CJ,
  // 2026-09-02: the local dev loop stays cheap, CI always passes --artifacts).
  artifactsDir = null,
  // Kinds CI asserts really ran in this invocation. A required kind with no artifact is an
  // error — that is how a dropped reporter flag fails loudly instead of quietly reducing the
  // gate's reach. A kind neither required nor evidenced falls back to existence-only.
  requireKinds = [],
} = {}) {
  const errors = [];
  const warnings = [];
  const { rows, orphans } = scanMatrix(readFileSync(matrixPath, "utf8"));
  if (rows.length === 0) errors.push("test-matrix.md: no traceability rows parsed — is the table intact?");

  // Structure: a row with no header above it is unverifiable, so it is a hard error rather
  // than a silent drop. The `rows.length === 0` guard above only catches total collapse.
  for (const o of orphans) {
    errors.push(
      `test-matrix.md:${o.line}: table row "${o.id}" has no header above it — a blank line detached it from its table; remove the blank line or add a header row`,
    );
  }

  const seen = new Set(rows.map((r) => r.id));
  const { frs, props } = extractRequiredIds({
    specText: readFileSync(specPath, "utf8"),
    testPlanText: readFileSync(testPlanPath, "utf8"),
  });

  // Completeness: every spec FR + property has a row.
  for (const id of [...frs, ...props]) {
    if (!seen.has(id)) errors.push(`missing matrix row for ${id} (defined in the constitution, no traceability row)`);
  }

  // Execution evidence: what each suite's own results artifact says actually ran. Read once,
  // before the row loop, so a broken artifact is reported as itself rather than as a hundred
  // confusing per-row failures.
  const executionChecked = artifactsDir != null;
  // `--require-kinds` names the kinds this run ENFORCES: their artifact must exist, and every one
  // of their named tests must have executed. A kind with an artifact but outside the list is
  // reported, not blocked — every unproven test is listed as a warning. That split is what lets a
  // venue enforce exactly what it can prove: a single-platform gate cannot execute another
  // platform's `#[cfg(unix)]` tests, and failing them there would say "unproven" when the truth is
  // "unprovable here". The distinction is stated in every run's summary line, never implied.
  const enforcedKinds = new Set(requireKinds);
  let evidence = new Map();
  if (executionChecked) {
    const read = readExecutionArtifacts({ dir: artifactsDir, readFile: readSourceFile });
    evidence = read.byKind;
    errors.push(...read.errors);
    for (const kind of RESULT_KINDS) {
      if (evidence.has(kind)) continue;
      if (enforcedKinds.has(kind)) {
        errors.push(
          `--artifacts ${artifactsDir}: no results artifact for the required "${kind}" kind — the suite that produces it did not run, or its reporter flag was dropped`,
        );
      } else {
        warnings.push(
          `no results artifact for the "${kind}" kind — its rows fall back to existence-only, so nothing here shows those tests ran`,
        );
      }
    }
  } else {
    warnings.push(existenceOnlyBanner("No --artifacts <dir> was given"));
  }
  // The other way a run can prove nothing: --artifacts was given and not one readable artifact
  // came back. The workflow reaches that state whenever no kind is enforced and no suite ran, and
  // such a run is exactly as weak as an existence-only one, so it gets the same banner.
  if (executionChecked && evidence.size === 0) {
    warnings.push(existenceOnlyBanner(`--artifacts ${artifactsDir} yielded no readable results for any kind`));
  }

  // Validity: every row that names a test names a real, runnable one. Build each
  // kind's complete index once so resolving another matrix ID is a Map lookup,
  // never another filesystem walk or source-file read.
  const indexedKinds = new Map();
  let checked = 0;
  let present = 0;
  let executed = 0;
  let notGating = 0;
  // Lazy + memoized: only rust rows ever consult this, and every one of them shares the same
  // repo-wide answer, so it is computed at most once per run rather than once per row/id.
  let benchOnlyRustFiles = null;
  const getBenchOnlyRustFiles = () => (benchOnlyRustFiles ??= findBenchOnlyRustFiles({ repoRoot, readSourceFile }));
  // Same lazy + memoized shape, for the crate-manifest facts a qualified rust id's crate-identity
  // check (#2308) needs.
  let rustCrateManifests = null;
  const getRustCrateManifests = () => (rustCrateManifests ??= findRustCrateManifests({ repoRoot, readSourceFile }));
  for (const row of rows) {
    if (row.testIds.length === 0) {
      // Pending/descoped rows must not silently claim a code kind with no tests.
      if (!NON_CODE_KINDS.has(row.kind)) {
        errors.push(`${row.id}: test kind "${row.kind}" names no test — use a pending/manual/descoped kind or add Test IDs`);
      }
      continue;
    }
    if (!KINDS[row.kind]) {
      errors.push(`${row.id}: names tests but has unknown test kind "${row.kind}" (expected: ${Object.keys(KINDS).join(", ")})`);
      continue;
    }
    if (!indexedKinds.has(row.kind)) {
      indexedKinds.set(row.kind, indexKind({ repoRoot, kind: row.kind, readSourceFile }));
    }
    // Execution is only judged where this run actually holds that kind's results. A row of a
    // kind with no artifact keeps exactly today's existence-only guarantee (and its warning).
    const kindEvidence = evidence.get(row.kind) ?? null;
    const notGatingRow = row.status === NOT_GATING_STATUS;
    const missedIds = [];
    const executedIds = [];

    for (const id of row.testIds) {
      checked++;
      const resolved = resolveTestId(indexedKinds.get(row.kind), id);
      const { name, state } = resolved;
      if (state === "active") present++;
      else if (state === "disabled")
        errors.push(`${row.id}: test "${name}" (${row.kind}) exists but is ignored/skipped — it would not run`);
      else if (state === "ambiguous")
        errors.push(
          `${row.id}: test "${name}" (${row.kind}) is defined in ${resolved.files.length} files (${resolved.files.join(", ")}) — a bare title cannot say which one this row means, so no results document can prove the right one ran; qualify it as "<file>::${name}"`,
        );
      else if (state === "wrong-file")
        errors.push(
          `${row.id}: test "${name}" (${row.kind}) is not defined in "${resolved.file}" — it is defined in ${resolved.files.join(", ")}`,
        );
      else {
        const hint = KINDS[row.kind].notFoundHint;
        errors.push(`${row.id}: test "${name}" (${row.kind}) not found in the ${row.kind} sources${hint ? ` — ${hint}` : ""}`);
      }
      // The Test IDs legend's one sanctioned exception (test-plan §6): a plain fn a bench
      // binary's own `main` calls, from a `[[bench]]` target its Cargo.toml declares
      // `test = false`. extractRust indexes every `fn` under `src-tauri` regardless of which
      // target owns its file, so the existence check above cannot itself tell such an
      // assertion apart from an ordinary `#[test]` — this is the extra structural fact the
      // legend requires and nothing previously checked (#2284). Checked against `resolved.file`
      // (the same defining-file resolution every other branch in this loop already uses), not
      // against the bare name — a fn that merely shares a name with one is not this row's test.
      if (row.kind === "rust" && state === "active" && !notGatingRow
          && resolved.file && getBenchOnlyRustFiles().has(resolved.file)) {
        errors.push(
          `${row.id}: test "${name}" (rust) is a test-plan §6 benchmark assertion (defined in ${resolved.file}, a [[bench]] target its Cargo.toml declares \`test = false\`) — the Test IDs legend permits naming it only from a "${NOT_GATING_STATUS}" row; this row's status is "${row.status}"`,
        );
      }
      // `present-not-gating` exempts a row from having to RUN, never from having to exist:
      // the existence checks above still applied, so the status cannot launder a typo.
      if (state !== "active" || !kindEvidence) continue;
      const wasQualified = splitTestId(id).file != null;
      if (ranInDefiningFile(kindEvidence, row.kind, name, resolved.file, wasQualified, getRustCrateManifests)) {
        executed++;
        executedIds.push(name);
      } else {
        missedIds.push({ name, file: resolved.file });
      }
    }

    if (!kindEvidence) {
      if (notGatingRow) {
        warnings.push(
          `${row.id}: status "${NOT_GATING_STATUS}" is not verified in this run — no ${row.kind} results artifact was available to show which of its tests run outside the gate`,
        );
      }
      continue;
    }
    // A kind outside --require-kinds is observed, not enforced: its findings go to `warnings`
    // in the same words, so the run still names every unproven test rather than staying quiet
    // about the half it does not block on.
    const report = enforcedKinds.has(row.kind) ? errors : warnings;
    if (notGatingRow) {
      notGating += missedIds.length;
      // Both branches below require at least one id to have executed; a row where NOTHING
      // executed is exactly the residual test-plan §9 (d) documents and is deliberately left
      // silent here (nothing in this run can tell "honestly non-gating" from "the gating test
      // broke too" when the status is row-level).
      if (executedIds.length > 0) {
        if (missedIds.length === 0) {
          // The status records a real gap. Left in place after the gap closes it becomes a
          // silent standing opt-out — which is how #1382's row kept claiming a quarantine in
          // prose for months after #1408 lifted it.
          report.push(
            `${row.id}: status "${NOT_GATING_STATUS}" but every named test executed in this run — use "present"`,
          );
        } else {
          // The relabelled mixed row CJ's #2234 ruling forbids (#2284): `present-not-gating` is
          // row-level, so a row naming both a genuinely-gating test and a genuinely-non-gating
          // one is honest under neither status. Before this check missedIds.length !== 0 skipped
          // the "use present" branch above and there was no other branch to catch it — this
          // exact shape reported nothing at all. The remedy is the same one CJ ruled for P5/P6:
          // split the executing test(s) into their own "present" row.
          report.push(
            `${row.id}: status "${NOT_GATING_STATUS}" names a mixed row — ${executedIds.join(", ")} executed in this run, but ${missedIds.map((m) => m.name).join(", ")} did not; a "${NOT_GATING_STATUS}" row may name no test that executes (CJ's #2234 ruling forbids relabelling a mixed row to escape the gate) — split the executing test(s) into their own "present" row (test-matrix.md Status legend's split rule) instead of relabelling this one`,
          );
        }
      }
    } else {
      for (const missed of missedIds) {
        // Naming the files a same-titled test DID run in is the difference between "nothing ran
        // this" and "something else answered to its name" — the second is the #2250 shape, and a
        // reader who cannot tell them apart re-litigates it every time.
        const ranIn = [...(kindEvidence.executed.get(missed.name) ?? [])];
        const elsewhere = ranIn.length
          ? ` — a test of that name executed in ${ranIn.join(", ")}, which is not the file this row names`
          : "";
        report.push(
          `${row.id}: test "${missed.name}" (${row.kind}) is defined in ${missed.file} but did not execute there in the ${row.kind} results (${kindEvidence.files.join(", ")})${elsewhere} — wire it into the gating suite, or record the gap with status "${NOT_GATING_STATUS}"`,
        );
      }
    }
  }

  return {
    errors,
    warnings,
    stats: {
      rows: rows.length,
      requiredFrs: frs.length,
      requiredProps: props.length,
      namedTests: checked,
      presentTests: present,
      executionChecked,
      executedTests: executed,
      notGatingTests: notGating,
      enforcedKinds: [...enforcedKinds].sort(),
      observedKinds: [...evidence.keys()].filter((kind) => !enforcedKinds.has(kind)).sort(),
    },
  };
}

// --- CLI --------------------------------------------------------------------

// `--artifacts <dir>` and `--require-kinds <a,b>`. Both are opt-in: `npm run matrix:check`
// with no flags is the cheap local existence-only loop, and CI passes them (CJ, 2026-09-02).
export function parseCliArgs(argv) {
  const options = { artifactsDir: null, requireKinds: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    const value = inline ?? argv[++i];
    if (flag === "--artifacts") {
      if (!value) throw new Error("--artifacts needs a directory");
      options.artifactsDir = value;
    } else if (flag === "--require-kinds") {
      if (!value) throw new Error("--require-kinds needs a comma-separated kind list");
      options.requireKinds = value.split(",").map((k) => k.trim()).filter(Boolean);
      const unknown = options.requireKinds.filter((k) => !RESULT_KINDS.includes(k));
      if (unknown.length) throw new Error(`--require-kinds: unknown kind(s) ${unknown.join(", ")} (expected: ${RESULT_KINDS.join(", ")})`);
    } else {
      throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (options.requireKinds.length && !options.artifactsDir) {
    throw new Error("--require-kinds needs --artifacts: there is nothing to require a kind from");
  }
  return options;
}

function splitFlag(arg) {
  const at = String(arg).indexOf("=");
  return at === -1 ? [String(arg), null] : [String(arg).slice(0, at), String(arg).slice(at + 1)];
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const { errors, warnings, stats } = checkMatrix(options);
  const s = stats;
  // Say which kinds this run BLOCKS on and which it merely observed, every time. A gate whose
  // reach has to be inferred from what it did not complain about is the gate #1384 found.
  const executionLine = s.executionChecked
    ? `${s.executedTests} executed · enforced: ${s.enforcedKinds.join(", ") || "none"} · observed only: ${s.observedKinds.join(", ") || "none"}${s.notGatingTests ? ` · ${s.notGatingTests} not gating` : ""}`
    : "execution NOT checked";
  console.log(
    `test-matrix: ${s.rows} rows · ${s.requiredFrs} FRs + ${s.requiredProps} properties required · ${s.presentTests}/${s.namedTests} named tests present · ${executionLine}`,
  );
  if (warnings.length) console.warn(`\n${warnings.length} warning${warnings.length === 1 ? "" : "s"}:`);
  for (const w of warnings) console.warn(`\n${w}`);
  if (errors.length) {
    console.error(`\n✗ test-matrix check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("✓ test-matrix check passed");
}

// `process.argv[1]` is an OS path (backslashes on Windows); convert it to a
// file URL so the "run directly?" check holds on every platform, not just POSIX.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
