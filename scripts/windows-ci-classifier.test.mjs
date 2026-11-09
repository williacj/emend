// ABOUTME: Pins the fail-closed changed-path classifier for the required Windows check.
// ABOUTME: Covers every ordered class plus metadata, pagination, rename, and summary failure edges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_SUITES,
  CLASSIFIER_VERSION,
  classifyChangedPaths,
  classifyPullRequest,
  main,
  nodeSetupRequired,
  renderClassificationSummary,
} from './windows-ci-classifier.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function selected(result) {
  return Object.entries(result.suites).filter(([, value]) => value).map(([key]) => key);
}

function expectSuites(paths, suites) {
  assert.deepEqual(selected(classifyChangedPaths(paths)), suites);
}

test('classifies every ordered path-table row', () => {
  assert.equal(CLASSIFIER_VERSION, 'windows-suites-v3');
  assert.deepEqual(ALL_SUITES, ['R', 'T', 'F', 'E']);
  const examples = [
    [['.github/workflows/windows-self-hosted.yml'], ALL_SUITES],
    [['src-tauri/crates/textops/Cargo.toml'], ALL_SUITES],
    [['src-tauri/src/commands/document.rs'], ALL_SUITES],
    [['src-tauri/crates/textops/src/lib.rs'], ['R']],
    [['scripts/check-test-matrix.mjs'], ['T']],
    [['src/editor/App.tsx'], ['F', 'E']],
    [['docs/implementation-plan.md'], ['T']],
    [['new-top-level/config.xyz'], ALL_SUITES],
  ];
  for (const [paths, suites] of examples) expectSuites(paths, suites);
});

test('covers every concrete run-all config and shared-interface pattern in rules 1 and 2', () => {
  for (const path of [
    '.github/actions/example/action.yml',
    'package.json',
    'package-lock.json',
    'rust-toolchain.toml',
    'src-tauri/Cargo.toml',
    'src-tauri/crates/textops/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.ts',
    'vitest.config.ts',
    'vitest.perf.config.ts',
    'playwright.config.ts',
    'playwright.config.mjs',
    '.gitattributes',
    '.gitignore',
    'CLAUDE.md',
    'src-tauri/src/commands/document.rs',
    'src-tauri/src/lib.rs',
    'src-tauri/capabilities/default.json',
    'src-tauri/gen/schemas/acl.json',
    'fixtures/project/document.md',
  ]) expectSuites([path], ALL_SUITES);
});

test('root Playwright config selects E through rule 1, while a nested near-match fails closed', () => {
  const rootConfig = classifyChangedPaths(['playwright.config.mjs']);
  assert.deepEqual(selected(rootConfig), ALL_SUITES);
  assert.equal(rootConfig.matches[0].rule, 1);
  assert.equal(rootConfig.failClosed, false);

  const nestedConfig = classifyChangedPaths(['config/playwright.config.mjs']);
  assert.deepEqual(selected(nestedConfig), ALL_SUITES);
  assert.equal(nestedConfig.matches[0].rule, 9);
  assert.equal(nestedConfig.failClosed, true);
});

test('frontend app-wiring and e2e paths select both component and acceptance coverage', () => {
  for (const path of [
    'src/editor/App.tsx',
    'tests/editor/App.test.tsx',
    'e2e/editor.spec.ts',
    'index.html',
    'public/icon.svg',
  ]) expectSuites([path], ['F', 'E']);
});

test('pins embedded contract trees to run all', () => {
  expectSuites(['docs/formats/provider-contract/tools.json'], ALL_SUITES);
  expectSuites(['docs/formats/sidecar/project.schema.json'], ALL_SUITES);
});

test('unions independent path classes without widening them', () => {
  expectSuites(['scripts/check-test-matrix.mjs', 'src/editor/App.tsx'], ['T', 'F', 'E']);
});

test('Cowrite agent guidance and the root README select tooling checks', () => {
  for (const path of ['.claude/skills/tdd/SKILL.md', '.agents/README.md', 'README.md']) {
    expectSuites([path], ['T']);
  }
});

test('a Rust plus frontend diff is the ratified cross-layer run-all negative control', () => {
  expectSuites(['src-tauri/crates/textops/src/lib.rs', 'src/editor/App.tsx'], ALL_SUITES);
});

test('classifier-owned files, empty results, and unknown paths fail closed to run all', () => {
  expectSuites(['scripts/windows-ci-classifier.mjs'], ALL_SUITES);
  expectSuites([], ALL_SUITES);
  expectSuites(['brand-new-area/file.txt'], ALL_SUITES);
});

test('normalizes Windows separators but treats case-changed contract paths as unknown and run all', () => {
  expectSuites(['scripts\\check-test-matrix.mjs'], ['T']);
  expectSuites(['Scripts/check-test-matrix.mjs'], ALL_SUITES);
});

function prEnv(overrides = {}) {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    COWRITE_EVENT_BASE_SHA: SHA_A,
    COWRITE_EVENT_HEAD_SHA: SHA_B,
    ...overrides,
  };
}

function gitResult(status = 0, stdout = '') {
  return {
    status,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    error: null,
  };
}

function immutableGitFixture({
  paths = ['src/editor/App.tsx'],
  basePresent = true,
  fetchStatus = 0,
  ancestor = true,
  diffStatus = 0,
  diffError = null,
  diffOutput = null,
  checkoutHead = SHA_B,
} = {}) {
  const calls = [];
  let fetched = false;
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return gitResult(0, `${checkoutHead}\n`);
    if (args[0] === 'cat-file') {
      const isBase = args[2]?.startsWith(SHA_A);
      return gitResult(isBase && !basePresent && !fetched ? 1 : 0);
    }
    if (args[0] === 'fetch') {
      if (fetchStatus === 0) fetched = true;
      return gitResult(fetchStatus);
    }
    if (args[0] === 'merge-base') return gitResult(ancestor ? 0 : 1);
    if (args[0] === 'diff') {
      const output = diffOutput ?? Buffer.from(paths.length ? `${paths.join('\0')}\0` : '');
      return { ...gitResult(diffStatus, output), error: diffError };
    }
    throw new Error(`unexpected git command ${args.join(' ')}`);
  };
  return { runGit, calls };
}

test('classifies an exact immutable base-to-head tree diff', async () => {
  const fixture = immutableGitFixture();
  const result = await classifyPullRequest({ env: prEnv(), runGit: fixture.runGit });
  assert.deepEqual(selected(result), ['F', 'E']);
  assert.equal(result.baseSha, SHA_A);
  assert.equal(result.headSha, SHA_B);
  assert.ok(fixture.calls.some((args) => args.join(' ') === `diff --no-renames --name-only -z ${SHA_A} ${SHA_B} --`));
});

test('a shallow checkout fetches only the exact missing base SHA before diffing', async () => {
  const fixture = immutableGitFixture({ basePresent: false });
  const result = await classifyPullRequest({
    env: prEnv(),
    runGit: fixture.runGit,
  });
  assert.deepEqual(selected(result), ['F', 'E']);
  assert.ok(fixture.calls.some((args) => args.join(' ') === `fetch --no-tags --depth=1 origin ${SHA_A}`));
});

test('no-renames diff output includes both rename paths and classifies deletions by their removed path', async () => {
  const renamed = await classifyPullRequest({
    env: prEnv(),
    runGit: immutableGitFixture({ paths: ['docs/new.md', 'scripts/old.mjs'] }).runGit,
  });
  assert.deepEqual(selected(renamed), ['T']);

  const removed = await classifyPullRequest({
    env: prEnv(),
    runGit: immutableGitFixture({ paths: ['src/removed.ts'] }).runGit,
  });
  assert.deepEqual(selected(removed), ['F', 'E']);
});

test('workflow dispatch and schedule always run all without pull-request metadata', async () => {
  for (const eventName of ['workflow_dispatch', 'schedule']) {
    const result = await classifyPullRequest({
      env: { GITHUB_EVENT_NAME: eventName },
      runGit: () => { throw new Error('must not call git'); },
    });
    assert.deepEqual(selected(result), ALL_SUITES);
    assert.match(result.reason, new RegExp(eventName));
  }
});

test('metadata, checkout, fetch, ancestry, diff, output-overflow, and empty uncertainty all fail closed', async () => {
  const cases = [
    { env: prEnv({ COWRITE_EVENT_BASE_SHA: 'bad' }), runGit: immutableGitFixture().runGit },
    { env: prEnv(), runGit: immutableGitFixture({ checkoutHead: 'c'.repeat(40) }).runGit },
    { env: prEnv(), runGit: immutableGitFixture({ basePresent: false, fetchStatus: 1 }).runGit },
    { env: prEnv(), runGit: immutableGitFixture({ ancestor: false }).runGit },
    { env: prEnv(), runGit: immutableGitFixture({ diffStatus: 1 }).runGit },
    {
      env: prEnv(),
      runGit: immutableGitFixture({
        diffError: Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' }),
      }).runGit,
    },
    { env: prEnv(), runGit: immutableGitFixture({ paths: [] }).runGit },
  ];

  for (const input of cases) {
    const result = await classifyPullRequest(input);
    assert.deepEqual(selected(result), ALL_SUITES);
    assert.equal(result.failClosed, true);
  }
});

test('malformed NUL framing and invalid UTF-8 path bytes fail closed', async () => {
  for (const diffOutput of [Buffer.from('src/a.ts'), Buffer.from([0xff, 0])]) {
    const result = await classifyPullRequest({
      env: prEnv(),
      runGit: immutableGitFixture({ diffOutput }).runGit,
    });
    assert.deepEqual(selected(result), ALL_SUITES);
    assert.equal(result.failClosed, true);
  }
});

test('classifies more than the compare-API 300-file cap from the exact local trees', async () => {
  const paths = Array.from({ length: 301 }, (_, index) => `docs/file-${index}.md`);
  paths.push('src/editor/App.tsx');
  const result = await classifyPullRequest({
    env: prEnv(),
    runGit: immutableGitFixture({ paths }).runGit,
  });
  assert.deepEqual(selected(result), ['T', 'F', 'E']);
});

test('event movement cannot retarget the already-captured immutable diff SHAs', async () => {
  const env = prEnv();
  const fixture = immutableGitFixture();
  const runGit = (args, options) => {
    if (args[0] === 'diff') env.COWRITE_EVENT_HEAD_SHA = 'c'.repeat(40);
    return fixture.runGit(args, options);
  };
  const result = await classifyPullRequest({ env, runGit });
  assert.deepEqual(selected(result), ['F', 'E']);
  const diff = fixture.calls.find((args) => args[0] === 'diff');
  assert.deepEqual(diff.slice(-3), [SHA_A, SHA_B, '--']);
});

test('summary names classifier version, SHAs, and every selected or inapplicable suite with reasons', () => {
  const result = classifyChangedPaths(['src/editor/App.tsx'], { baseSha: SHA_A, headSha: SHA_B });
  const summary = renderClassificationSummary(result);
  assert.match(summary, new RegExp(CLASSIFIER_VERSION));
  assert.match(summary, new RegExp(SHA_A));
  assert.match(summary, new RegExp(SHA_B));
  for (const suite of ALL_SUITES) assert.match(summary, new RegExp(`\\| ${suite} \\|`));
  assert.match(summary, /selected/);
  assert.match(summary, /inapplicable/);
  assert.match(summary, /rule 7/i);
  assert.match(summary, /no changed path matched a rule selecting R/);
  assert.match(summary, /\| E \| E2E acceptance \| selected \|/);
});

test('an E-only classification requires Node setup while a Rust-only classification does not', () => {
  assert.equal(nodeSetupRequired({ R: false, T: false, F: false, E: true }), true);
  assert.equal(nodeSetupRequired({ R: true, T: false, F: false, E: false }), false);
});

test('main publishes stable boolean outputs and the full-suite dispatch summary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cowrite-windows-classifier-'));
  try {
    const outputPath = join(directory, 'output.txt');
    const summaryPath = join(directory, 'summary.md');
    await main({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    });
    const output = readFileSync(outputPath, 'utf8');
    for (const name of ['run_rust', 'run_tooling', 'run_frontend', 'run_e2e', 'run_node']) {
      assert.match(output, new RegExp(`^${name}=true$`, 'm'));
    }
    assert.doesNotMatch(output, /run_harness=/);
    assert.match(readFileSync(summaryPath, 'utf8'), /workflow_dispatch full-suite mode/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
