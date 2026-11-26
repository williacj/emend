// ABOUTME: Guards the provider-contract README against drift from the crate's `pub enum Schema` (TD-1):
// ABOUTME: every variant the enum declares must be named in docs/formats/provider-contract/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENUM_SOURCE = 'src-tauri/crates/provider-contract/src/lib.rs';
const README = 'docs/formats/provider-contract/README.md';

// The enum's variants are all unit variants, one per line. Any other line throws, so a shape this
// reader does not understand cannot silently drop a variant from the check.
function schemaVariants(rustSource) {
  const body = /^pub enum Schema \{\r?\n([\s\S]*?)^\}/m.exec(rustSource)?.[1];
  if (body === undefined) throw new Error(`no \`pub enum Schema\` in ${ENUM_SOURCE}`);
  const variants = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !/^#\[.*\]$/.test(line))
    .map((line) => {
      const variant = /^([A-Za-z_]\w*),?$/.exec(line)?.[1];
      if (!variant) throw new Error(`cannot read \`pub enum Schema\` line: ${line}`);
      return variant;
    });
  if (variants.length === 0) throw new Error('`pub enum Schema` declares no variants');
  return variants;
}

function parityFaults(rustSource, readme) {
  return schemaVariants(rustSource)
    .filter((variant) => !new RegExp(`\\b${variant}\\b`).test(readme))
    .map((variant) => `${README} does not name Schema variant ${variant}`);
}

const FIXTURE_ENUM = [
  'pub enum Schema {',
  '    /// A documented variant (`one.schema.json`).',
  '    ClaudeStreamEvent,',
  '    // A plain comment.',
  '    #[allow(dead_code)]',
  '    McpToolCall,',
  '',
  '    McpToolCallResult',
  '}',
  '',
  'impl Schema {}',
].join('\r\n');

test('the provider-contract README names every Schema variant the crate declares', () => {
  const read = (file) => readFileSync(join(ROOT, file), 'utf8');
  assert.deepEqual(parityFaults(read(ENUM_SOURCE), read(README)), []);
});

test('the README parity check reports a fault naming an omitted Schema variant', () => {
  // `McpToolCallResult` contains `McpToolCall`, which must not count as naming it.
  const readme = '`Schema` variants: `ClaudeStreamEvent`, `McpToolCallResult`.';
  assert.deepEqual(parityFaults(FIXTURE_ENUM, readme), [
    `${README} does not name Schema variant McpToolCall`,
  ]);
});

test('the README parity check reports no fault when every Schema variant is named', () => {
  const readme = '`Schema` variants: `ClaudeStreamEvent`, `McpToolCall`,\n`McpToolCallResult`.';
  assert.deepEqual(parityFaults(FIXTURE_ENUM, readme), []);
});

test('the README parity check refuses an enum it cannot read in full', () => {
  assert.throws(() => parityFaults('pub enum Other { A }', ''), /no `pub enum Schema`/);
  assert.throws(() => parityFaults('pub enum Schema {\n}\n', ''), /no variants/);
  assert.throws(() => parityFaults('pub enum Schema {\n    A, B,\n}\n', ''), /cannot read/);
});
