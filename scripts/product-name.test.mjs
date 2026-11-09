// ABOUTME: Guards the product name in shipped code: no user-visible string in src/ or src-tauri/src/
// ABOUTME: may still say "Cowrite" after the rename to Emend (D36). Comments are #7's and are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_DIRS = ['src', 'src-tauri/src'];

// Protocol values that are not copy. Each is renamed by its own card and leaves this list there.
const NOT_COPY = [
  { file: 'src-tauri/src/agent/claude.rs', text: 'X-Cowrite-Run' }, // HTTP header name, #26
];

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;
const TRAILING_COMMENT = /\s\/\/.*$/;

export function oldNameLines(files, read) {
  const found = [];
  for (const file of files) {
    read(file).split('\n').forEach((line, index) => {
      if (COMMENT_LINE.test(line)) return;
      const code = line.replace(TRAILING_COMMENT, '');
      if (!code.includes('Cowrite')) return;
      if (NOT_COPY.some((entry) => entry.file === file && code.includes(entry.text))) return;
      found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('no string in shipped code names the product Cowrite', () => {
  const files = execFileSync('git', ['ls-files', ...SHIPPED_DIRS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.(ts|tsx|rs|css|html)$/.test(file));
  assert.ok(files.length > 100, `expected the shipped source tree, found ${files.length} files`);
  assert.deepEqual(oldNameLines(files, (file) => readFileSync(join(ROOT, file), 'utf8')), []);
});

test('the guard finds the old name in strings and JSX text but not in comments', () => {
  const sources = {
    'a.ts': 'const message = "Cowrite couldn’t open it";\n// Cowrite in a comment\n',
    'b.tsx': '<h1>Welcome to Cowrite</h1>\n{/* Cowrite */}\nconst x = 1; // Cowrite trailing\n',
    'src-tauri/src/agent/claude.rs': 'headers["X-Cowrite-Run"] = run;\n',
  };
  assert.deepEqual(oldNameLines(Object.keys(sources), (file) => sources[file]), [
    'a.ts:1: const message = "Cowrite couldn’t open it";',
    'b.tsx:1: <h1>Welcome to Cowrite</h1>',
  ]);
});
