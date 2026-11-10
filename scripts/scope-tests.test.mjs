// ABOUTME: Pins the `npm run scope:tests` local wrapper — merge-base diff collection (including
// ABOUTME: uncommitted/untracked paths), command sourcing, and the loud fail-closed rendering (#2371).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSuiteCommands,
  collectWorkingDiffPaths,
  resolveDefaultBranchRef,
  scopeTests,
  renderScopeReport,
  renderBanner,
} from './scope-tests.mjs';
import { ALL_SUITES, classifyChangedPaths } from './suite-classifier.mjs';
import { readPackageScripts } from './package-scripts.mjs';

function gitResult(status = 0, stdout = '') {
  return {
    status,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    error: null,
  };
}

function selected(classification) {
  return ALL_SUITES.filter((suite) => classification.suites[suite]);
}

// --- buildSuiteCommands -------------------------------------------------------

test('buildSuiteCommands sources T/F/E from the injected package.json scripts map and hardcodes R', () => {
  const scripts = { 'test:scripts': 'y', test: 'z', 'test:e2e': 'w' };
  const commands = buildSuiteCommands(scripts);
  assert.equal(commands.R, 'cargo test --manifest-path src-tauri/Cargo.toml --workspace');
  assert.equal(commands.T, 'npm run test:scripts');
  assert.equal(commands.F, 'npm test');
  assert.equal(commands.E, 'npm run test:e2e');
});

// Killer mutation: if the suite->script-name mapping silently pointed at a renamed/removed script
// (the exact drift class #1124/#2281/#2247 trace to for the rule TABLE), this must fail loudly rather
// than print a command that does not exist.
test('buildSuiteCommands refuses to print a command for a suite whose script is missing from package.json', () => {
  const scripts = { test: 'z', 'test:e2e': 'w' }; // test:scripts missing
  assert.throws(() => buildSuiteCommands(scripts), /test:scripts/);
});

// R has no npm script to source its command from (unlike T/F/E), so it is a literal in
// scripts/scope-tests.mjs, hand-synced with the required gate's `cargo test` step in
// `.github/workflows/ci.yml`. This is the exact drift shape #1124/#2281/#2247 trace to for the rule table — pinning it
// here means a change to one side without the other reddens this test instead of silently diverging.
//
// #2467 review round 1, Important 2: a bare `workflow.includes(commands.R)` is substring CONTAINMENT,
// not identity — appending a flag after `--workspace` (e.g. `--no-fail-fast`) stays contained and this
// test would stay green while CI's actual invocation silently diverged from what this file prints.
// Anchoring on the whole step line the workflow runs, `run: <command> 2>&1 | tee …`, closes both the
// append case and the removal/reorder cases the plain-containment version missed.
test('the hardcoded R command matches, boundary-anchored, the exact cargo invocation in the required workflow', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const commands = buildSuiteCommands({ 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' });
  const anchored = `        run: ${commands.R} 2>&1 | tee `;
  assert.ok(
    workflow.split('\n').some((line) => line.startsWith(anchored)),
    `expected ci.yml to run the exact, unmodified invocation "${anchored.trim()}"`,
  );
});

test('buildSuiteCommands, sourced from the REAL package.json, agrees with the real script map', () => {
  const scripts = readPackageScripts();
  const commands = buildSuiteCommands(scripts);
  assert.equal(commands.T, 'npm run test:scripts');
  assert.equal(commands.F, 'npm test');
  assert.equal(commands.E, 'npm run test:e2e');
  assert.ok('test:scripts' in scripts && 'test' in scripts && 'test:e2e' in scripts);
});

// --- resolveDefaultBranchRef ---------------------------------------------------

test('resolveDefaultBranchRef prefers origin/main and stops there when it resolves', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(' '));
    return gitResult(0);
  };
  const ref = resolveDefaultBranchRef({ runGit });
  assert.equal(ref, 'origin/main');
  assert.deepEqual(calls, ['rev-parse --verify -q origin/main']);
});

test('resolveDefaultBranchRef falls back to local main when origin/main does not resolve', () => {
  const runGit = (args) => (args[3] === 'origin/main' ? gitResult(1) : gitResult(0));
  assert.equal(resolveDefaultBranchRef({ runGit }), 'main');
});

// #2467 review round 2, Minor (not reproduced by the reviewer — a code-visible risk, not a proven bug):
// a clean "ref absent" miss (`git rev-parse --verify -q <ref>`) exits nonzero with EMPTY stderr — that
// is what `-q` is for. A REAL failure (a timeout under the new 10s bound, a spawn error, git refusing
// for some other reason) is a different shape: non-empty stderr despite `-q`, or `res.error` set.
// Treating both shapes identically silently downgrades "origin/main check failed for some other reason"
// into "origin/main doesn't exist, try main" — which could point suites at the wrong base without any
// visible error. The killer mutation this guards: origin/main DOES exist, but checking it times out;
// the fix must surface that as an error, never as a silent fallback to local `main`.
test('resolveDefaultBranchRef throws (never silently falls back) when a candidate check fails for a real reason, not a clean miss', () => {
  const runGit = (args) => {
    if (args[3] === 'origin/main') {
      return {
        status: 128,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('fatal: not a git repository (or any of the parent directories): .git\n'),
        error: null,
      };
    }
    return gitResult(0); // 'main' would resolve cleanly -- must never be reached or reported
  };
  assert.throws(
    () => resolveDefaultBranchRef({ runGit }),
    /checking whether origin\/main resolves failed/,
  );
});

test('resolveDefaultBranchRef throws when no candidate resolves', () => {
  const runGit = () => gitResult(1);
  assert.throws(() => resolveDefaultBranchRef({ runGit }), /could not resolve a default branch ref/);
});

// --- collectWorkingDiffPaths (injected git) ------------------------------------

function diffFixture({ committed = [], uncommitted = [], untracked = [], mergeBase = 'a'.repeat(40) } = {}) {
  const calls = [];
  const nul = (paths) => Buffer.from(paths.length ? `${paths.join('\0')}\0` : '');
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return args[3] === 'origin/main' ? gitResult(0) : gitResult(1);
    if (args[0] === 'merge-base') return gitResult(0, `${mergeBase}\n`);
    if (args[0] === 'diff' && args.includes(mergeBase)) return gitResult(0, nul(committed));
    if (args[0] === 'diff') return gitResult(0, nul(uncommitted));
    if (args[0] === 'ls-files') return gitResult(0, nul(untracked));
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  return { runGit, calls };
}

test('collectWorkingDiffPaths unions committed, uncommitted, and untracked paths and dedupes overlaps', () => {
  const fixture = diffFixture({
    committed: ['src-tauri/lib.rs', 'scripts/shared.mjs'],
    uncommitted: ['scripts/shared.mjs', 'docs/note.md'],
    untracked: ['src/new.ts'],
  });
  const { paths, baseRef } = collectWorkingDiffPaths({ runGit: fixture.runGit });
  assert.equal(baseRef, 'origin/main');
  assert.deepEqual(
    [...paths].sort(),
    ['docs/note.md', 'scripts/shared.mjs', 'src-tauri/lib.rs', 'src/new.ts'].sort(),
  );
});

test('collectWorkingDiffPaths issues the exact no-renames NUL-delimited flags the classifier assumes', () => {
  const fixture = diffFixture({});
  collectWorkingDiffPaths({ runGit: fixture.runGit });
  const joined = fixture.calls.map((args) => args.join(' '));
  assert.ok(joined.some((c) => /^diff --no-renames --name-only -z [0-9a-f]{40} HEAD --$/.test(c)));
  assert.ok(joined.some((c) => c === 'diff --no-renames --name-only -z HEAD --'));
  assert.ok(joined.some((c) => c === 'ls-files --others --exclude-standard --full-name -z -- :/'));
});

test('an untracked-only path is still collected and classified', () => {
  const fixture = diffFixture({ untracked: ['src/editor/App.tsx'] });
  const { paths } = collectWorkingDiffPaths({ runGit: fixture.runGit });
  assert.deepEqual(paths, ['src/editor/App.tsx']);
  assert.deepEqual(selected(classifyChangedPaths(paths)), ['F', 'E']);
});

test('collectWorkingDiffPaths surfaces a failing git call instead of silently returning a wrong diff', () => {
  const runGit = (args) => {
    if (args[0] === 'rev-parse') return gitResult(1); // neither ref resolves
    return gitResult(0, Buffer.from('\0'));
  };
  assert.throws(() => collectWorkingDiffPaths({ runGit }), /could not resolve a default branch ref/);

  const mergeBaseFails = (args) => {
    if (args[0] === 'rev-parse') return args[3] === 'origin/main' ? gitResult(0) : gitResult(1);
    if (args[0] === 'merge-base') return gitResult(128, '');
    throw new Error('must not reach diff after a failed merge-base');
  };
  assert.throws(
    () => collectWorkingDiffPaths({ runGit: mergeBaseFails }),
    /merge-base resolution failed/,
  );
});

// --- scopeTests: proves paths flow into the REAL classifier, not a second copy -------------------

// #2467 review round 1, Important 4: the original list covered six of nine rules (1, 4-8) and the PR
// body over-claimed "every rule". Rules 2 and 3 are now included — rule 2 (a shared-interface path) and
// rule 3 (a cross-layer Rust+frontend pair, the same pair `suite-classifier.test.mjs` itself uses
// as its own cross-layer negative control) — bringing this to every rule the classifier can reach from a
// single `classifyChangedPaths` call: 1-4 and 6-8. Rule 9 is covered separately by the fail-closed banner tests
// above, since it needs `failClosed`, not just suite selection, to discriminate.
test('scopeTests classifies through the imported classifyChangedPaths — verified against a direct call, every live rule', () => {
  const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
  const examples = [
    ['package.json'], // rule 1: all four
    ['fixtures/project/document.md'], // rule 2: shared-interface path, all four
    ['src-tauri/crates/textops/src/lib.rs', 'src/editor/App.tsx'], // rule 3: cross-layer pair, all four
    ['src-tauri/crates/textops/src/lib.rs'], // rule 4: R
    ['scripts/some-tool.mjs'], // rule 6: T
    ['src/editor/App.tsx'], // rule 7: F, E
    ['docs/implementation-plan.md'], // rule 8: T
  ];
  for (const paths of examples) {
    const fixture = diffFixture({ committed: paths });
    const { classification } = scopeTests({ runGit: fixture.runGit, scripts: fakeScripts });
    const direct = classifyChangedPaths(paths);
    assert.deepEqual(classification.suites, direct.suites, `mismatch for ${paths.join(', ')}`);
  }
});

// Rule 3 (cross-layer) firing from paths split ACROSS git legs is wrapper-specific behaviour the test
// above cannot exercise (it only ever hands both paths to `classifyChangedPaths` together, pre-unioned).
// The union at `collectWorkingDiffPaths` is where this wrapper's own logic could plausibly drop or
// mis-scope a leg; this proves the union itself, not just the classifier downstream of it, produces the
// cross-layer trigger (#2467 review round 1, Important 4).
test('rule 3 (cross-layer) fires when the Rust and frontend paths arrive from DIFFERENT git legs', () => {
  const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
  const fixture = diffFixture({
    committed: ['src-tauri/crates/textops/src/lib.rs'],
    untracked: ['src/editor/App.tsx'],
  });
  const { paths, classification } = scopeTests({ runGit: fixture.runGit, scripts: fakeScripts });
  assert.deepEqual([...paths].sort(), ['src-tauri/crates/textops/src/lib.rs', 'src/editor/App.tsx']);
  assert.deepEqual(selected(classification), ALL_SUITES);
  assert.equal(classification.failClosed, false);
  assert.match(classification.reason, /rule 3/);
});

// --- renderScopeReport: the fail-closed case must never render like a genuine all-four match -----

test('a rule-9 fail-closed all-four match renders the loud banner; a rule-1 all-four match does not', () => {
  const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
  const failClosed = scopeTests({ runGit: diffFixture({ committed: ['unknown-area/thing.xyz'] }).runGit, scripts: fakeScripts });
  const genuine = scopeTests({ runGit: diffFixture({ committed: ['package.json'] }).runGit, scripts: fakeScripts });

  assert.deepEqual(selected(failClosed.classification), ALL_SUITES);
  assert.deepEqual(selected(genuine.classification), ALL_SUITES);
  assert.equal(failClosed.classification.failClosed, true);
  assert.equal(genuine.classification.failClosed, false);

  const failReport = renderScopeReport(failClosed);
  const genuineReport = renderScopeReport(genuine);
  assert.match(failReport, /FAIL-CLOSED DEFAULT: no path-table rule matched/);
  assert.doesNotMatch(genuineReport, /FAIL-CLOSED DEFAULT/);
  assert.notEqual(failReport, genuineReport);
});

// #2467 review round 1, Important 3: `failClosed` covers three distinct classifier conditions (rule 9,
// an empty changed-path result, and uncertain/malformed input) — a banner worded only for rule 9 lies
// on the other two.
//
// #2467 review round 2, Important 2 (round 1's tests were the actual defect): these three used to
// synthesize the `classification` object by hand, so they could never notice that `renderScopeReport`'s
// dispatch depended on suite-classifier.mjs's own un-pinned prose — proven by the reviewer: a
// reworded classifier message left the hand-typed-fixture tests 22/22 green while the REAL render
// silently broke. All three now call the real, imported `classifyChangedPaths` directly — the actual
// seam, not a stand-in for it — so `renderScopeReport`'s own current dispatch (on `paths.length` and
// `match.rule`, not `reason` — see the comment above `failClosedBannerLines`) is what these exercise.
const EMPTY_CLASSIFICATION = classifyChangedPaths([]);
const RULE_9_PATH = 'brand-new-area/thing.xyz';
const RULE_9_CLASSIFICATION = classifyChangedPaths([RULE_9_PATH]);
const UNCERTAIN_PATH = 'bad/../path'; // a literal ".." segment: normalizePath's own documented rejection
const UNCERTAIN_CLASSIFICATION = classifyChangedPaths([UNCERTAIN_PATH]);

test('the three real fail-closed classifications this module dispatches on are shaped the way the dispatch assumes', () => {
  // Guards the assumption the dispatch logic relies on, independent of the render: if any of these three
  // shapes ever changed (e.g. the classifier started populating `matches` on the uncertain path, or
  // stopped tagging a rule-9 entry with `rule: 9`), this fails BEFORE the render tests below produce a
  // confusing wrong-text failure.
  assert.equal(EMPTY_CLASSIFICATION.failClosed, true);
  assert.equal(EMPTY_CLASSIFICATION.matches.length, 0);
  assert.equal(RULE_9_CLASSIFICATION.failClosed, true);
  assert.ok(RULE_9_CLASSIFICATION.matches.some((match) => match.rule === 9));
  assert.equal(UNCERTAIN_CLASSIFICATION.failClosed, true);
  assert.equal(UNCERTAIN_CLASSIFICATION.matches.length, 0);
});

test('the empty-diff fail-closed case renders EMPTY, not the rule-9 "no path-table rule matched" wording', () => {
  const commands = buildSuiteCommands({ 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' });
  const report = renderScopeReport({ classification: EMPTY_CLASSIFICATION, commands, paths: [], baseRef: 'main' });
  assert.match(report, /FAIL-CLOSED DEFAULT: the diff against the merge base is EMPTY/);
  assert.doesNotMatch(report, /no path-table rule matched/);
  assert.doesNotMatch(report, /UNCERTAIN/);
});

test('the uncertain-input fail-closed case renders UNCERTAIN, not the rule-9 or empty-diff wording', () => {
  const commands = buildSuiteCommands({ 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' });
  const report = renderScopeReport({
    classification: UNCERTAIN_CLASSIFICATION,
    commands,
    paths: [UNCERTAIN_PATH],
    baseRef: 'main',
  });
  assert.match(report, /FAIL-CLOSED DEFAULT: the collected changed paths were UNCERTAIN/);
  assert.doesNotMatch(report, /no path-table rule matched/);
  assert.doesNotMatch(report, /is EMPTY/);
});

test('every fail-closed banner line — border and content alike — renders at the same width', () => {
  const commands = buildSuiteCommands({ 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' });
  for (const [classification, paths] of [
    [RULE_9_CLASSIFICATION, [RULE_9_PATH]],
    [EMPTY_CLASSIFICATION, []],
    [UNCERTAIN_CLASSIFICATION, [UNCERTAIN_PATH]],
  ]) {
    const report = renderScopeReport({ classification, commands, paths, baseRef: 'main' });
    // Both border (`####...`) and content (`# text #`) banner rows start AND end with `#`; the report's
    // own `## Suite classification` / `## Run these` markdown headings start with `#` but never
    // end with one, so this filter cannot accidentally pull them in.
    const bannerLines = report.split('\n').filter((line) => line.startsWith('#') && line.endsWith('#'));
    assert.ok(bannerLines.length >= 3, `expected a banner block for reason "${classification.reason}"`);
    const widths = new Set(bannerLines.map((line) => line.length));
    assert.equal(widths.size, 1, `banner lines for "${classification.reason}" have inconsistent widths: ${[...widths]}`);
  }
});

// #2467 review round 2, Minor: unreachable through `failClosedBannerLines` today (it always returns
// three lines), but `Math.max()` over zero lines is `-Infinity`, and `'#'.repeat(-Infinity + 4)` throws
// an opaque `RangeError: Invalid count value` rather than saying what actually went wrong. A guard turns
// that into an intentional, readable error for whoever calls `renderBanner` next.
test('renderBanner refuses an empty line array with a clear error, not an opaque RangeError', () => {
  assert.throws(() => renderBanner([]), /renderBanner requires at least one line/);
});

test('renderScopeReport prints the runnable command only for suites the classification actually selected', () => {
  const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
  const outcome = scopeTests({ runGit: diffFixture({ committed: ['scripts/some-tool.mjs'] }).runGit, scripts: fakeScripts });
  assert.deepEqual(selected(outcome.classification), ['T']);
  const report = renderScopeReport(outcome);
  assert.match(report, /^\s*T\s+npm run test:scripts$/m);
  assert.doesNotMatch(report, /cargo test --manifest-path/);
  assert.doesNotMatch(report, /npm test$/m);
  assert.doesNotMatch(report, /npm run test:e2e/);
});

test('renderScopeReport reports "no suite selected" rather than an empty section when nothing is selected', () => {
  // classifyChangedPaths never actually selects zero suites (empty input fails closed to all four), so
  // this exercises renderScopeReport's own defensive branch directly rather than reaching it through
  // scopeTests.
  const commands = buildSuiteCommands({ 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' });
  const classification = { suites: { R: false, T: false, F: false, E: false }, failClosed: false, reason: 'synthetic', matches: [], version: 'x', baseSha: null, headSha: null };
  const report = renderScopeReport({ classification, commands, paths: [], baseRef: 'main' });
  assert.match(report, /\(no suite selected\)/);
});

// --- production edge: a real git repository, real spawnSync, no injected runGit ------------------

function sh(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

// #2467 review round 2, Minor: a fixture that creates a file and TRUSTS it is untracked, without ever
// checking git's own view, is blind to its own setup breaking (e.g. a stray `.gitignore` rule, an
// accidental earlier `git add .` swallowing it) — the test would then pass or fail for a reason having
// nothing to do with the behavior it names. This makes the precondition an assertion, not an assumption.
function assertUntracked(dir, relativePath) {
  const status = sh(['status', '--porcelain', '--', relativePath], dir);
  assert.equal(status, `?? ${relativePath}\n`, `expected ${relativePath} to be untracked (git status: ${JSON.stringify(status)})`);
}

function makeRealRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'emend-scope-tests-'));
  sh(['init', '-q', '-b', 'main'], dir);
  sh(['config', 'user.email', 'test@example.invalid'], dir);
  sh(['config', 'user.name', 'Scope Tests'], dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  sh(['add', '.'], dir);
  sh(['commit', '-q', '-m', 'seed'], dir);

  sh(['checkout', '-q', '-b', 'feature/x'], dir);
  mkdirSync(join(dir, 'src-tauri'), { recursive: true });
  writeFileSync(join(dir, 'src-tauri', 'lib.rs'), 'fn main() {}\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'x.mjs'), '// seed\n');
  sh(['add', '.'], dir);
  sh(['commit', '-q', '-m', 'add rust and tooling files'], dir);

  // uncommitted modification to an already-tracked file
  writeFileSync(join(dir, 'scripts', 'x.mjs'), '// modified\n');
  // untracked file
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), 'plan\n');

  return dir;
}

test('production edge: a real git worktree with no origin remote falls back to local main and collects real merge-base + uncommitted + untracked paths', () => {
  const dir = makeRealRepo();
  try {
    const { paths, baseRef } = collectWorkingDiffPaths({ cwd: dir });
    assert.equal(baseRef, 'main'); // no origin/main exists here — the real negative case
    assert.deepEqual(
      [...paths].sort(),
      ['docs/note.md', 'scripts/x.mjs', 'src-tauri/lib.rs'].sort(),
    );

    const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
    const outcome = scopeTests({ cwd: dir, scripts: fakeScripts });
    const direct = classifyChangedPaths(paths);
    assert.deepEqual(outcome.classification.suites, direct.suites);
    assert.deepEqual(selected(outcome.classification), ['R', 'T']);
    assert.equal(outcome.classification.failClosed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2467 review round 1, Important 1: `git ls-files --others` is CWD-relative and cwd-subtree-scoped by
// default, while both `git diff --name-only` legs are always repo-root-relative regardless of cwd
// (verified empirically: see PR discussion). Run from a subdirectory, the untracked leg silently
// returns paths relative to that subdirectory instead of the repo root, so an untracked Rust file
// reported as "src/main.rs" (missing its "src-tauri/" prefix) is misclassified as a FRONTEND path.
// This is real: the CLI guard at the bottom of scope-tests.mjs supports `node scripts/scope-tests.mjs`
// from any cwd, not just the package root `npm run` normalizes to.
test('an untracked file is still repo-root-relative when scope-tests runs from a subdirectory (#2467 review Important 1)', () => {
  // A deliberately minimal, single-commit repo (not `makeRealRepo()`, whose own seed files would also
  // land in the merge-base diff and blur this test's one variable: whether cwd changes the reported
  // path of ONE untracked file).
  const dir = mkdtempSync(join(tmpdir(), 'emend-scope-tests-cwd-'));
  try {
    sh(['init', '-q', '-b', 'main'], dir);
    sh(['config', 'user.email', 'test@example.invalid'], dir);
    sh(['config', 'user.name', 'Scope Tests'], dir);
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    sh(['add', '.'], dir);
    sh(['commit', '-q', '-m', 'seed'], dir);

    mkdirSync(join(dir, 'src-tauri', 'src'), { recursive: true });
    writeFileSync(join(dir, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n'); // untracked
    assertUntracked(dir, 'src-tauri/src/main.rs');

    const fromRoot = collectWorkingDiffPaths({ cwd: dir });
    const fromSubdir = collectWorkingDiffPaths({ cwd: join(dir, 'src-tauri') });
    assert.deepEqual(fromRoot.paths, ['src-tauri/src/main.rs']);
    assert.deepEqual(
      fromSubdir.paths,
      ['src-tauri/src/main.rs'],
      'running from a subdirectory must not change which repo-root-relative path is reported',
    );

    const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
    const fromSubdirOutcome = scopeTests({ cwd: join(dir, 'src-tauri'), scripts: fakeScripts });
    assert.deepEqual(
      selected(fromSubdirOutcome.classification),
      ['R'],
      'a Rust-only untracked change must still select R (not F/E) when run from src-tauri/',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2467 review round 2, Important 1 (round 1's fix was incomplete): `--full-name` only fixes the path
// SPELLING git reports; `git ls-files --others` still SCOPES its search to the cwd subtree by default,
// with or without `--full-name`. The test above placed its only untracked file INSIDE the cwd subtree
// it ran from (both under `src-tauri/`), so that scoping could never fire — a test that cannot fail for
// the bug it names is worse than no test. This one runs from `scripts/` while the untracked file sits
// under the DISJOINT top-level directory `src-tauri/`: proven empirically (see PR discussion) that
// `git ls-files --others --full-name` from `scripts/` returns NOTHING for a file under `src-tauri/`,
// while the same command from the repo root returns it — the file silently vanishes from `paths`, and
// with it the only signal that would have selected R.
test('an untracked file OUTSIDE the cwd subtree is not dropped (#2467 review round 2 Important 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emend-scope-tests-cwd-disjoint-'));
  try {
    sh(['init', '-q', '-b', 'main'], dir);
    sh(['config', 'user.email', 'test@example.invalid'], dir);
    sh(['config', 'user.name', 'Scope Tests'], dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'seed.mjs'), '// seed\n');
    sh(['add', '.'], dir);
    sh(['commit', '-q', '-m', 'seed'], dir);

    // Untracked file lives under src-tauri/, a top-level directory DISJOINT from the cwd (scripts/)
    // this test runs `collectWorkingDiffPaths` from.
    mkdirSync(join(dir, 'src-tauri', 'src'), { recursive: true });
    writeFileSync(join(dir, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n');
    assertUntracked(dir, 'src-tauri/src/main.rs');

    const fromScripts = collectWorkingDiffPaths({ cwd: join(dir, 'scripts') });
    assert.deepEqual(
      fromScripts.paths,
      ['src-tauri/src/main.rs'],
      'an untracked file outside the cwd subtree must still be reported, repo-root-relative',
    );

    const fakeScripts = { 'test:scripts': 'b', test: 'c', 'test:e2e': 'd' };
    const outcome = scopeTests({ cwd: join(dir, 'scripts'), scripts: fakeScripts });
    assert.deepEqual(
      selected(outcome.classification),
      ['R'],
      'the Rust-only untracked change must still select R when run from scripts/, a disjoint subtree',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production edge: once everything is committed, the committed-diff leg alone still reports the merge-base delta', () => {
  const dir = makeRealRepo();
  try {
    sh(['add', '.'], dir);
    sh(['commit', '-q', '-m', 'commit everything'], dir); // nothing uncommitted/untracked left
    const { paths } = collectWorkingDiffPaths({ cwd: dir });
    assert.deepEqual([...paths].sort(), ['docs/note.md', 'scripts/x.mjs', 'src-tauri/lib.rs'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
