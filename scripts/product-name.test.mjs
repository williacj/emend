// ABOUTME: Guards the product name in shipped code: nothing in src/, src-tauri/ sources and crates, or
// ABOUTME: the app's config, capability and host files may still carry the old name in copy or protocol values (D36).
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
