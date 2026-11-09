// ABOUTME: Tests deterministic summaries for Windows contention CPU and disk JSONL samples.
// ABOUTME: Keeps malformed samples visible without letting them corrupt valid distributions.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSamples,
  publishSampleSummary,
  renderSampleSummary,
  summarizeSamples,
  validateSampleSet,
} from './windows-host-sampler-report.mjs';

test('publishSampleSummary preserves evidence in both the step summary and durable log', () => {
  const appended = [];
  const logged = [];
  publishSampleSummary('measured metrics', {
    summaryPath: 'summary.md',
    append: (path, text) => appended.push([path, text]),
    write: (text) => logged.push(text),
  });
  assert.deepEqual(appended, [['summary.md', 'measured metrics']]);
  assert.deepEqual(logged, ['measured metrics']);
});

test('parseSamples retains valid metrics and counts malformed or errored rows', () => {
  const input = [
    '\uFEFF{"timestamp":"2026-01-01T00:00:00Z","cpuPercent":20,"diskQueueLength":1,"diskPercent":10}',
    '{"timestamp":"2026-01-01T00:00:05Z","cpuPercent":80,"diskQueueLength":3,"diskPercent":90}',
    '{"timestamp":"2026-01-01T00:00:10Z","error":"counter unavailable"}',
    'not-json',
    '',
  ].join('\n');
  assert.deepEqual(parseSamples(input), {
    samples: [
      { timestamp: '2026-01-01T00:00:00Z', cpuPercent: 20, diskQueueLength: 1, diskPercent: 10 },
      { timestamp: '2026-01-01T00:00:05Z', cpuPercent: 80, diskQueueLength: 3, diskPercent: 90 },
    ],
    errors: ['counter unavailable', 'malformed JSON sample: not-json'],
  });
});

test('validateSampleSet rejects empty or partially errored evidence', () => {
  const window = { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:10Z' };
  assert.throws(() => validateSampleSet({ samples: [], errors: [], ...window }), /zero valid samples/);
  assert.throws(
    () => validateSampleSet({ samples: [{ timestamp: window.startedAt, cpuPercent: 1, diskQueueLength: 0, diskPercent: 1 }], errors: ['bad counter'], ...window }),
    /bad counter/,
  );
});

test('validateSampleSet requires 80 percent coverage and rejects a stalled sampler gap', () => {
  const sample = (second) => ({
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`,
    cpuPercent: 10,
    diskQueueLength: 0,
    diskPercent: 5,
  });
  const window = { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:30Z' };
  assert.throws(() => validateSampleSet({ samples: [sample(0)], errors: [], ...window }), /coverage/);
  assert.throws(() => validateSampleSet({ samples: [sample(0), sample(5), sample(25), sample(30)], errors: [], ...window }), /sample gap/);
  assert.doesNotThrow(() => validateSampleSet({ samples: [sample(0), sample(5), sample(10), sample(15), sample(20), sample(25)], errors: [], ...window }));
});

test('summarizeSamples reports comparable CPU and disk distributions', () => {
  const summary = summarizeSamples([
    { cpuPercent: 20, diskQueueLength: 1, diskPercent: 10 },
    { cpuPercent: 80, diskQueueLength: 3, diskPercent: 90 },
  ]);
  assert.equal(summary.cpu.medianMs, 50);
  assert.equal(summary.cpu.p90Ms, 80);
  assert.equal(summary.diskQueue.medianMs, 2);
  assert.equal(summary.diskBusy.medianMs, 50);
});

test('renderSampleSummary identifies the slot and exposes rejected samples', () => {
  const markdown = renderSampleSummary({
    slot: 'peer',
    parallelism: 'two',
    cargoBuildJobs: '8',
    runnerName: 'cowrite-windows-2',
    workspace: 'C:\\actions-runner-2\\_work\\cowrite',
    samples: [{ timestamp: '2026-01-01T00:00:00Z', cpuPercent: 40, diskQueueLength: 2, diskPercent: 60 }],
    errors: ['one rejected sample'],
  });
  assert.match(markdown, /Windows host contention: peer/);
  assert.match(markdown, /Parallelism \| two/);
  assert.match(markdown, /Cargo build jobs \| 8/);
  assert.match(markdown, /cowrite-windows-2/);
  assert.match(markdown, /CPU busy/);
  assert.match(markdown, /Sample errors \| 1/);
  assert.match(markdown, /one rejected sample/);
});
