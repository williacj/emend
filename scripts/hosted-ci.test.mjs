// ABOUTME: Tests the hosted CI Cargo matrix against Cowrite's shipped-platform policy.
// ABOUTME: Pins independent macOS and Windows results while rejecting Ubuntu as a Rust test lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(HERE, '..', '.github', 'workflows', 'ci.yml');

test('hosted Cargo tests run independently on the two shipped platforms only (issue #1028)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const cargoJob = workflow.match(/  test-cargo:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:|$)/)?.[1];

  assert.ok(cargoJob, 'expected the test-cargo job');
  assert.match(cargoJob, /strategy:\s*\n\s+fail-fast:\s*false/);
  assert.match(cargoJob, /os:\s*\[macos-latest,\s*windows-latest\]/);
  assert.doesNotMatch(cargoJob, /ubuntu-latest/);
});
