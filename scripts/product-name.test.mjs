// ABOUTME: Guards the product name: nothing shipped (src/, src-tauri/ sources, crates and app config) carries
// ABOUTME: the old name (D36), and nothing in the repository names Cowrite outside a historical allowlist (#12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_DIRS = ['src', 'src-tauri/src', 'src-tauri/crates', 'src-tauri/capabilities'];
const SHIPPED_FILES = [
  'index.html',
  'src-tauri/Entitlements.plist',
  'src-tauri/Info.plist',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.macos.conf.json',
  'src-tauri/tauri.windows.conf.json',
];

// The display name, and the protocol values the agent, the webview and the sidecar see: the MCP
// server name and its tool prefix, event names, the run header, the app's author value and the
// reference-data envelope's version field. Header names are matched in any case, as servers read them.
const OLD_NAME = [
  /Cowrite|mcp__cowrite__|cowrite:\/\/|"cowrite"|`cowrite`|mcpServers\.cowrite|cowrite_context_version/,
  /x-cowrite-run/i,
];

export function oldNameLines(files, read) {
  const found = [];
  for (const file of files) {
    read(file).split('\n').forEach((line, index) => {
      if (!OLD_NAME.some((pattern) => pattern.test(line))) return;
      found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('nothing shipped names the product Cowrite', () => {
  const sources = execFileSync('git', ['ls-files', ...SHIPPED_DIRS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.(ts|tsx|rs|css|json|toml)$/.test(file));
  assert.ok(sources.length > 100, `expected the shipped source tree, found ${sources.length} files`);
  const files = [...sources, ...SHIPPED_FILES];
  assert.deepEqual(oldNameLines(files, (file) => readFileSync(join(ROOT, file), 'utf8')), []);
});

test('the guard finds the old name in copy, comments and protocol values', () => {
  const sources = {
    'a.ts': 'const message = "Cowrite couldn’t open it";\n// Cowrite in a comment\n',
    'b.plist': '<string>Cowrite uses your microphone</string>\n',
    'c.rs': [
      'headers["X-Cowrite-Run"] = run;',
      'const NAME: &str = "cowrite";',
      'let tool = "mcp__cowrite__propose_changes";',
      'const EVENT: &str = "cowrite://agent/delivery";',
      '{ cowrite_context_version: 1 }',
      'if lower.starts_with("x-cowrite-run:") {',
      'assert!(err.contains("mcpServers.cowrite"));',
      '/// Reads the `cowrite` entry',
      'let dir = ".cowrite";',
      'const NAME: &str = "emend";',
    ].join('\n'),
  };
  assert.deepEqual(oldNameLines(Object.keys(sources), (file) => sources[file]), [
    'a.ts:1: const message = "Cowrite couldn’t open it";',
    'a.ts:2: // Cowrite in a comment',
    'b.plist:1: <string>Cowrite uses your microphone</string>',
    'c.rs:1: headers["X-Cowrite-Run"] = run;',
    'c.rs:2: const NAME: &str = "cowrite";',
    'c.rs:3: let tool = "mcp__cowrite__propose_changes";',
    'c.rs:4: const EVENT: &str = "cowrite://agent/delivery";',
    'c.rs:5: { cowrite_context_version: 1 }',
    'c.rs:6: if lower.starts_with("x-cowrite-run:") {',
    'c.rs:7: assert!(err.contains("mcpServers.cowrite"));',
    'c.rs:8: /// Reads the `cowrite` entry',
  ]);
});

// Files that are dated records of the Cowrite era and keep the old name as written: the journal
// (its header says so), the generated design CHANGELOG, the spike findings, the rebrand brief,
// the pre-rename alignment baseline, and this guard's own patterns and fixtures.
const HISTORICAL_FILES = [
  'docs/journal.md',
  'docs/design/CHANGELOG.md',
  'docs/spikes/1137-e2e-production-wiring.md',
  'docs/spikes/spike1-provider-contract.md',
  'docs/spikes/spike2-git2.md',
  'docs/spikes/spike5-cm6-ghost.md',
  'docs/spikes/spike6-second-instance-activation.md',
  'docs/emend-rebrand-design-brief.md',
  'docs/alignment-baseline/README.md',
  'scripts/product-name.test.mjs',
];

// Lines in live documents that record the rename itself: its decision-log entries (D36, its D30
// amendment, TD-29), the design refresh that carried it, and the test-matrix rows for TD-29's
// clean break, which name pre-rename tests. Each is the line holding the marker, in that file only.
const RENAME_RECORDS = [
  { file: 'docs/functional-spec.md', marker: '| D36 |' },
  { file: 'docs/functional-spec.md', marker: 'D36 log entry' },
  { file: 'docs/tech-design.md', marker: '| TD-29 |' },
  { file: 'docs/design/README.md', marker: '**Refresh (31).**' },
  { file: 'docs/design/specs/tokens.md', marker: "replacing Cowrite's blue" },
  { file: 'docs/test-matrix.md', marker: '| NI-sidecar-clean-break |' },
  { file: 'docs/test-matrix.md', marker: '| NI-project-lock |' },
];

// The pre-rename sidecar folder `.cowrite/`, named only where TD-29's clean-break tests, the
// lock-relocation history (TD-12, TD-20) and the format docs say Emend leaves it untouched.
const OLD_SIDECAR = /(?<![\w.])\.cowrite\b|dot_cowrite/g;
const OLD_SIDECAR_FILES = [
  'docs/formats/sidecar/README.md',
  'docs/formats/tab-session.md',
  'docs/tech-design.md',
  'docs/test-matrix.md',
  'src-tauri/src/agent/project.rs',
  'src-tauri/src/store/gitignore.rs',
  'src-tauri/src/store/lock.rs',
  'src-tauri/src/store/service.rs',
];

// Takes `git grep -n` lines ("file:line:text") and returns those naming Cowrite outside the allowlist.
export function unallowedOldNameLines(grepLines) {
  return grepLines.filter((entry) => {
    const [file, , ...rest] = entry.split(':');
    const text = rest.join(':');
    if (HISTORICAL_FILES.includes(file)) return false;
    if (RENAME_RECORDS.some((record) => record.file === file && text.includes(record.marker))) return false;
    const checked = OLD_SIDECAR_FILES.includes(file) ? text.replace(OLD_SIDECAR, '') : text;
    return /cowrite/i.test(checked);
  });
}

test('nothing outside the historical allowlist names Cowrite', () => {
  let output = '';
  try {
    output = execFileSync('git', ['grep', '-I', '-n', '-i', 'cowrite'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1) throw error; // git grep exits 1 when nothing matches
  }
  const found = unallowedOldNameLines(output.split('\n').filter(Boolean));
  assert.deepEqual(found.map((entry) => entry.slice(0, 160)), []);
});

test('the repository guard allows only historical files, rename records and the old sidecar folder', () => {
  const lines = [
    'docs/journal.md:9:- Cowrite had 18 live worktrees',
    'docs/spikes/spike2-git2.md:40:install Cowrite only',
    'docs/functional-spec.md:73:| D36 | 2026-11-08 | Cowrite is its former name.',
    'docs/functional-spec.md:74:| D37 | 2026-11-09 | Cowrite opens faster.',
    'docs/test-matrix.md:287:| NI-sidecar-clean-break | holds only Cowrite\'s `.cowrite/`',
    'docs/tech-design.md:72:| TD-29 | clean break from Cowrite\'s',
    'docs/test-matrix.md:12:| NI-other | Cowrite saves the file',
    'src-tauri/src/store/service.rs:1277:fs::rename(a, dir.path().join(".cowrite")).unwrap();',
    'src-tauri/src/store/service.rs:1269:fn a_project_holding_only_dot_cowrite_opens() {',
    'src-tauri/src/store/service.rs:1280:// .cowrite/ is Cowrite\'s folder',
    'CLAUDE.md:9:Cowrite v2: cross-platform desktop app',
    'AGENTS.md:8:under `cowrite-worktrees/<issue-number>-<slug>`',
    'docs/journal.md.bak:1:Cowrite',
    'CLAUDE.md:3:| D36 | Cowrite',
    'src-tauri/tauri.conf.json:5:  "identifier": "com.cowrite.desktop",',
    'src/x.ts:1:const dir = ".cowrite/comments";',
    'docs/spikes/spike9-new.md:1:Cowrite',
  ];
  assert.deepEqual(unallowedOldNameLines(lines), [
    'docs/functional-spec.md:74:| D37 | 2026-11-09 | Cowrite opens faster.',
    'docs/test-matrix.md:12:| NI-other | Cowrite saves the file',
    'src-tauri/src/store/service.rs:1280:// .cowrite/ is Cowrite\'s folder',
    'CLAUDE.md:9:Cowrite v2: cross-platform desktop app',
    'AGENTS.md:8:under `cowrite-worktrees/<issue-number>-<slug>`',
    'docs/journal.md.bak:1:Cowrite',
    'CLAUDE.md:3:| D36 | Cowrite',
    'src-tauri/tauri.conf.json:5:  "identifier": "com.cowrite.desktop",',
    'src/x.ts:1:const dir = ".cowrite/comments";',
    'docs/spikes/spike9-new.md:1:Cowrite',
  ]);
});
