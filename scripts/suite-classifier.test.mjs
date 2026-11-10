// ABOUTME: Pins the fail-closed changed-path classifier behind `npm run scope:tests`.
// ABOUTME: Covers every ordered class, git name-only diff parsing, and the rendered summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SUITES,
  CLASSIFIER_VERSION,
  classifyChangedPaths,
  parseNameOnlyDiff,
  renderClassificationSummary,
} from './suite-classifier.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function selected(result) {
  return Object.entries(result.suites).filter(([, value]) => value).map(([key]) => key);
}

function expectSuites(paths, suites) {
  assert.deepEqual(selected(classifyChangedPaths(paths)), suites);
}

test('classifies every ordered path-table row', () => {
  assert.equal(CLASSIFIER_VERSION, 'suites-v3');
  assert.deepEqual(ALL_SUITES, ['R', 'T', 'F', 'E']);
  const examples = [
    [['.github/workflows/ci.yml'], ALL_SUITES],
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

test('Emend agent guidance and the root README select tooling checks', () => {
  for (const path of ['.claude/skills/tdd/SKILL.md', '.agents/README.md', 'README.md']) {
    expectSuites([path], ['T']);
  }
});

test('a Rust plus frontend diff is the ratified cross-layer run-all negative control', () => {
  expectSuites(['src-tauri/crates/textops/src/lib.rs', 'src/editor/App.tsx'], ALL_SUITES);
});

test('classifier-owned files, empty results, and unknown paths fail closed to run all', () => {
  expectSuites(['scripts/suite-classifier.mjs'], ALL_SUITES);
  expectSuites([], ALL_SUITES);
  expectSuites(['brand-new-area/file.txt'], ALL_SUITES);
});

test('normalizes Windows separators but treats case-changed contract paths as unknown and run all', () => {
  expectSuites(['scripts\\check-test-matrix.mjs'], ['T']);
  expectSuites(['Scripts/check-test-matrix.mjs'], ALL_SUITES);
});

test('parses git name-only NUL framing, including deletions and both sides of a rename', () => {
  assert.deepEqual(parseNameOnlyDiff(Buffer.alloc(0)), []);
  assert.deepEqual(parseNameOnlyDiff(Buffer.from('docs/new.md\0scripts/old.mjs\0')), ['docs/new.md', 'scripts/old.mjs']);
});

test('malformed NUL framing, an empty path, invalid UTF-8 and non-buffer output all throw', () => {
  for (const output of [Buffer.from('src/a.ts'), Buffer.from('a\0\0'), Buffer.from([0xff, 0]), 'src/a.ts\0']) {
    assert.throws(() => parseNameOnlyDiff(output));
  }
});

test('classifies more than the compare-API 300-file cap', () => {
  const paths = Array.from({ length: 301 }, (_, index) => `docs/file-${index}.md`);
  paths.push('src/editor/App.tsx');
  assert.deepEqual(selected(classifyChangedPaths(paths)), ['T', 'F', 'E']);
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
