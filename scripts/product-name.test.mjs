// ABOUTME: Guards the product name in shipped code: nothing in src/, src-tauri/ sources and crates, or
// ABOUTME: the app's config, capability and host files may still say "Cowrite" after the rename (D36).
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

// Protocol values that are not copy. Each is renamed by its own card and leaves this list there.
const NOT_COPY = [
  { file: 'src-tauri/src/agent/claude.rs', text: 'X-Cowrite-Run' }, // HTTP header name, #26
  { file: 'src-tauri/crates/fake-agent/src/http_tool_server.rs', text: 'X-Cowrite-Run' }, // #26
];

export function oldNameLines(files, read) {
  const found = [];
  for (const file of files) {
    read(file).split('\n').forEach((line, index) => {
      if (!line.includes('Cowrite')) return;
      if (NOT_COPY.some((entry) => entry.file === file && line.includes(entry.text))) return;
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

test('the guard finds the old name on any line except an allowlisted protocol value', () => {
  const sources = {
    'a.ts': 'const message = "Cowrite couldn’t open it";\n// Cowrite in a comment\n',
    'b.plist': '<string>Cowrite uses your microphone</string>\n',
    'src-tauri/src/agent/claude.rs': 'headers["X-Cowrite-Run"] = run;\n',
  };
  assert.deepEqual(oldNameLines(Object.keys(sources), (file) => sources[file]), [
    'a.ts:1: const message = "Cowrite couldn’t open it";',
    'a.ts:2: // Cowrite in a comment',
    'b.plist:1: <string>Cowrite uses your microphone</string>',
  ]);
});
