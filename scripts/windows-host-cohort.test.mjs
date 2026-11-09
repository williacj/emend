// ABOUTME: Tests hostname evidence used to prove Windows benchmark and canary jobs share one host.
// ABOUTME: Drives the real evidence-file boundary and rejects missing, malformed, or straddled cohorts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectHostCohort } from './windows-host-cohort.mjs';

function hostFiles(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'windows-host-cohort-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return contents.map((content, index) => {
    const path = join(dir, `host-${index}.txt`);
    writeFileSync(path, content);
    return path;
  });
}

test('inspectHostCohort accepts complete hostname evidence from one physical host', (t) => {
  const paths = hostFiles(t, ['WILLIACJ-01\r\n', 'williacj-01\n']);
  assert.deepEqual(inspectHostCohort(paths, 2), {
    hostname: 'WILLIACJ-01',
    evidenceFiles: ['host-0.txt', 'host-1.txt'],
  });
});

test('inspectHostCohort rejects a cohort whose hostname evidence straddles physical hosts', (t) => {
  const paths = hostFiles(t, ['WILLIACJ-01\n', 'FINN-PC10\n']);
  assert.throws(
    () => inspectHostCohort(paths, 2),
    /hostname evidence must identify one physical host; found FINN-PC10, WILLIACJ-01/,
    'straddled hostname evidence must be rejected',
  );
});

test('inspectHostCohort rejects missing or malformed hostname evidence', (t) => {
  const onePath = hostFiles(t, ['WILLIACJ-01\n']);
  assert.throws(
    () => inspectHostCohort(onePath, 2),
    /expected 2 hostname evidence files; found 1/,
  );
  for (const value of ['WILLIACJ-01\nFINN-PC10\n', ' WILLIACJ-01\n', '\n']) {
    const malformed = hostFiles(t, [value]);
    assert.throws(
      () => inspectHostCohort(malformed, 1),
      /must contain exactly one non-empty line/,
      'malformed hostname evidence must be rejected',
    );
  }
});
