// ABOUTME: Local `npm run scope:tests` entry point — resolves the working diff against its merge
// ABOUTME: base and prints which suites the ratified classifier selects, plus their run commands.
//
// This deliberately does NOT reimplement the path->suite rule table. The rules already live in, and
// are already tested by, `./suite-classifier.mjs` (`classifyChangedPaths`); a second copy here is
// exactly the defect this script exists to remove (#1124, #2281, #2247 all trace to a hand-maintained
// prose copy of the same table drifting). This module's only job is the LOCAL seam the CI classifier
// does not have: reading a live git worktree (merge base, uncommitted, untracked) instead of an
// immutable PR event tree, and printing the result for a human at a prompt instead of writing
// `GITHUB_OUTPUT`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALL_SUITES,
  classifyChangedPaths,
  parseNameOnlyDiff,
  renderClassificationSummary,
} from './suite-classifier.mjs';
import { readPackageScripts } from './package-scripts.mjs';

const MAX_BUFFER = 4 * 1024 * 1024;
// No call site ever supplied `timeoutMs`, so every real git spawn was unbounded (#2467 review round 1,
// Minor) — a hung `git` (a stale lock, an interactive credential prompt) would hang this CLI forever.
const DEFAULT_TIMEOUT_MS = 10_000;

// No npm script builds and runs the Rust workspace suite (unlike T/F/E below), so there is no
// existing source of truth to read this command from. It mirrors the one place the literal command is
// otherwise recorded: the required gate's `cargo test` step in `.github/workflows/ci.yml`. If that
// step's invocation ever changes, this line has to change with it; `scripts/scope-tests.test.mjs`
// fails when the two disagree.
const RUST_TEST_COMMAND = 'cargo test --manifest-path src-tauri/Cargo.toml --workspace';

// T/F/E each already have a named script in package.json — the actual command text (what it runs,
// in what order) lives there, not here. This only names WHICH script answers for which suite letter;
// `buildSuiteCommands` reads the real script map rather than assuming its own copy of the command body.
const SUITE_SCRIPT_NAMES = Object.freeze({ T: 'test:scripts', F: 'test', E: 'test:e2e' });

// #2467 review round 1, Minor (Rule of Three; reviewer confirmed round 2 — this decline holds):
// Keep this Git wrapper Buffer-based for `parseNameOnlyDiff`'s NUL-safe framing. The CI classifier
// has its own Git invocation boundary and does not need the local working-tree view this tool reads.
export function defaultRunGit(args, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_BUFFER } = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer,
    shell: false,
    windowsHide: true,
  });
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
}

function checkedGit(runGit, args, options, label) {
  const res = runGit(args, options);
  if (res.error || res.status !== 0) {
    const detail = toBuffer(res.stderr).toString('utf8').trim() || res.error?.message || `git exited ${res.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return toBuffer(res.stdout);
}

function gitText(runGit, args, options, label) {
  return checkedGit(runGit, args, options, label).toString('utf8').trim();
}

function gitPaths(runGit, args, options, label) {
  return parseNameOnlyDiff(checkedGit(runGit, args, options, label));
}

// `git rev-parse --verify -q <ref>` exits nonzero with EMPTY stderr on a clean "ref doesn't exist" miss
// -- that is exactly what `-q` suppresses. Anything else (a timeout under `defaultRunGit`'s own 10s
// bound, a spawn error, git refusing for an unrelated reason) is a REAL failure, not ref absence, and
// must never be treated the same way -- silently reinterpreting it as "try the next candidate" could
// point suites at the wrong base with no visible error (#2467 review round 2, Minor).
function isCleanRefMiss(res) {
  return !res.error && res.status !== 0 && toBuffer(res.stderr).toString('utf8').trim() === '';
}

// A worktree may have no `origin` remote-tracking `main` (a from-scratch bare clone missing the
// remote-tracking ref, an offline checkout) — falling back to the local branch keeps the tool usable
// there instead of failing outright the way the CI classifier's stricter immutable-event contract may.
export function resolveDefaultBranchRef({ runGit = defaultRunGit, cwd = process.cwd(), candidates = ['origin/main', 'main'] } = {}) {
  for (const ref of candidates) {
    const res = runGit(['rev-parse', '--verify', '-q', ref], { cwd });
    if (!res.error && res.status === 0) return ref;
    if (!isCleanRefMiss(res)) {
      const detail = toBuffer(res.stderr).toString('utf8').trim() || res.error?.message || `git exited ${res.status}`;
      throw new Error(`checking whether ${ref} resolves failed (not a clean miss): ${detail}`);
    }
  }
  throw new Error(`could not resolve a default branch ref (tried: ${candidates.join(', ')})`);
}

// Requirement: classify the WORKING diff, not just what is committed. That is the union of three
// disjoint git views against the same merge base: (1) what HEAD already differs from the default
// branch by, (2) what the working tree currently differs from HEAD by (staged and unstaged alike —
// `git diff HEAD` alone reports both), and (3) untracked files git does not diff at all.
export function collectWorkingDiffPaths({ runGit = defaultRunGit, cwd = process.cwd(), candidates } = {}) {
  const baseRef = resolveDefaultBranchRef({ runGit, cwd, candidates });
  const mergeBase = gitText(runGit, ['merge-base', baseRef, 'HEAD'], { cwd }, 'merge-base resolution');
  const committed = gitPaths(
    runGit,
    ['diff', '--no-renames', '--name-only', '-z', mergeBase, 'HEAD', '--'],
    { cwd },
    'merge-base diff',
  );
  const uncommitted = gitPaths(
    runGit,
    ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
    { cwd },
    'working tree diff',
  );
  // `git diff --name-only` is always repo-root-relative AND repo-wide regardless of cwd, but
  // `git ls-files --others` defaults to BOTH cwd-relative path spelling AND cwd-subtree-scoped search.
  // `--full-name` only fixes the spelling half — without the explicit `':/'` pathspec below, an
  // untracked file outside the cwd subtree is not merely misspelled, it is not found at all and
  // silently vanishes from `paths` (verified empirically both ways; #2467 review round 2, Important 1 —
  // round 1's `--full-name`-only fix closed the spelling half but left this half open). `':/'` is git's
  // own pathspec syntax for "match from the top of the working tree", restoring the same repo-wide
  // scope the diff legs already have unconditionally.
  const untracked = gitPaths(
    runGit,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/'],
    { cwd },
    'untracked file listing',
  );
  const paths = Array.from(new Set([...committed, ...uncommitted, ...untracked]));
  return { paths, baseRef, mergeBase };
}

export function buildSuiteCommands(scripts = readPackageScripts()) {
  const commands = { R: RUST_TEST_COMMAND };
  for (const suite of ALL_SUITES.filter((s) => s !== 'R')) {
    const scriptName = SUITE_SCRIPT_NAMES[suite];
    if (!scriptName || !(scriptName in scripts)) {
      throw new Error(`package.json has no "${scriptName}" script for suite ${suite} — cannot print its command`);
    }
    commands[suite] = scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  }
  return commands;
}

export function scopeTests({ runGit = defaultRunGit, cwd = process.cwd(), scripts, candidates } = {}) {
  const { paths, baseRef, mergeBase } = collectWorkingDiffPaths({ runGit, cwd, candidates });
  const classification = classifyChangedPaths(paths, { baseSha: mergeBase, headSha: null });
  const commands = buildSuiteCommands(scripts ?? readPackageScripts());
  return { classification, commands, paths, baseRef };
}

// Renders a box whose border always matches its content width — computed, not hand-counted, so a
// banner border can never silently drift out of alignment with the text it wraps (#2467 review round 1
// Minor: a previous hand-typed banner had an 80-char border around 78-char content rows).
export function renderBanner(lines) {
  // `failClosedBannerLines` never returns an empty array today, but an unguarded `Math.max()` over zero
  // lines is `-Infinity`, and `'#'.repeat(-Infinity + 4)` throws an opaque `RangeError: Invalid count
  // value` — a genuine defect for whoever calls this next, not a real bug today (#2467 review round 2,
  // Minor). A clear, intentional error beats a cryptic one from three calls deep in `String.repeat`.
  if (!lines.length) throw new Error('renderBanner requires at least one line');
  const width = Math.max(...lines.map((line) => line.length));
  const border = '#'.repeat(width + 4);
  const body = lines.map((line) => `# ${line.padEnd(width)} #`);
  return [border, ...body, border].join('\n');
}

// `classification.failClosed` covers THREE distinct classifier conditions (classifyChangedPaths in
// suite-classifier.mjs): rule 9 (an unrecognized path), an empty changed-path result (nothing to
// classify — the common no-op case on a clean tree), and uncertain/malformed input. A single banner
// worded for rule 9 alone renders false text ("no path-table rule matched") on the empty-diff case,
// where nothing was ever offered to a rule in the first place — crying wolf on the MOST common no-op
// invocation erodes exactly the signal requirement 4 exists to buy (#2467 review round 1, Important 3).
//
// #2467 review round 2, Important 2: round 1's dispatch matched on `classification.reason` — free prose
// suite-classifier.mjs owns and does not guarantee, and its own test suite pins none of it. That
// reproduced this card's own central defect (depending on another module's un-pinned text) one level
// down, inside the very fix meant to close it (proven by the reviewer: rewording only the classifier's
// empty-case message left this file's tests 22/22 green while the real rendered banner silently reverted
// to the wrong text). Dispatch now uses only stable, structurally-typed facts: `paths.length` is a value
// THIS module computed itself (not parsed from another module's output), and `match.rule` is the
// classifier's own tested integer contract (`suite-classifier.test.mjs` asserts `.rule` values
// directly, e.g. `assert.equal(rootConfig.matches[0].rule, 1)`) — not prose, and not owed to us by
// promise alone the way `reason`'s wording is.
function failClosedBannerLines(classification, paths) {
  if (!paths.length) {
    return [
      'FAIL-CLOSED DEFAULT: the diff against the merge base is EMPTY.',
      'Running ALL FOUR suites because there is nothing to classify -- a SAFE',
      'DEFAULT, not a reasoned decision. See the reason below.',
    ];
  }
  if (classification.matches.some((match) => match.rule === 9)) {
    return [
      'FAIL-CLOSED DEFAULT: no path-table rule matched any changed path.',
      'Running ALL FOUR suites because nothing was recognized -- this is a',
      'SAFE DEFAULT, not a reasoned decision. See the reason below.',
    ];
  }
  return [
    'FAIL-CLOSED DEFAULT: the collected changed paths were UNCERTAIN.',
    'Running ALL FOUR suites because the input could not be trusted -- a',
    'SAFE DEFAULT, not a reasoned decision. See the reason below.',
  ];
}

// The rule-1/2/3 "run everything" decisions and the rule-9 fail-closed default both select all four
// suites, so the two must never look the same on screen — an operator scanning selections alone could
// mistake one for the other. `classification.failClosed` is the one field that distinguishes them; this
// banner is the loud, distinct-at-a-glance rendering of it, on top of (not instead of) the classifier's
// own reason text.
export function renderScopeReport({ classification, commands, paths, baseRef }) {
  const lines = [];
  lines.push(`Diff scope: ${paths.length} changed path(s) against \`${baseRef}\` (merge base, includes uncommitted + untracked).`);
  lines.push('');
  if (classification.failClosed) {
    lines.push(renderBanner(failClosedBannerLines(classification, paths)));
    lines.push('');
  }
  lines.push(renderClassificationSummary(classification).trimEnd());
  lines.push('');
  const selectedSuites = ALL_SUITES.filter((suite) => classification.suites[suite]);
  lines.push('## Run these');
  lines.push('');
  if (!selectedSuites.length) {
    lines.push('(no suite selected)');
  } else {
    for (const suite of selectedSuites) lines.push(`  ${suite}  ${commands[suite]}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function main({ cwd = process.cwd() } = {}) {
  const outcome = scopeTests({ cwd });
  process.stdout.write(`${renderScopeReport(outcome)}\n`);
  return outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
