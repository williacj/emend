// ABOUTME: Tests the self-hosted Windows workflow timing summary and historical aggregation.
// ABOUTME: Keeps observability non-gating while pinning queue/execution calculations to GitHub timestamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunReport,
  collectHistory,
  distribution,
  renderHistory,
  renderRunReport,
} from './windows-ci-timing.mjs';

test('buildRunReport separates queue wait from pickup-to-summary execution and completed steps', () => {
  const report = buildRunReport({
    run: { created_at: '2026-07-31T12:00:00Z', html_url: 'https://example.test/run/1' },
    job: {
      started_at: '2026-07-31T12:02:00Z',
      steps: [
        { name: 'Cargo test', started_at: '2026-07-31T12:03:00Z', completed_at: '2026-07-31T12:04:25Z', conclusion: 'success' },
        { name: 'Publish timing summary', started_at: '2026-07-31T12:06:55Z', completed_at: null, conclusion: null },
      ],
    },
    observedAt: '2026-07-31T12:07:00Z',
  });

  assert.equal(report.queueMs, 120_000);
  assert.equal(report.executionMs, 300_000);
  assert.deepEqual(report.steps, [{ name: 'Cargo test', durationMs: 85_000, conclusion: 'success' }]);
});

test('renderRunReport gives queue, execution, and step evidence a concise Actions summary', () => {
  const markdown = renderRunReport({
    url: 'https://example.test/run/1',
    observedAt: '2026-07-31T12:07:00Z',
    queueMs: 120_000,
    executionMs: 300_000,
    steps: [{ name: 'Cargo test', durationMs: 85_000, conclusion: 'success' }],
  });

  assert.match(markdown, /Windows runner timing/);
  assert.match(markdown, /Queue wait \| 2m 00s/);
  assert.match(markdown, /Pickup → summary \| 5m 00s/);
  assert.match(markdown, /Cargo test \| success \| 1m 25s/);
});

test('distribution reports a stable count, median, p90, min, max, and mean', () => {
  assert.deepEqual(distribution([9_000, 1_000, 5_000, 3_000, 7_000]), {
    count: 5,
    minMs: 1_000,
    medianMs: 5_000,
    p90Ms: 9_000,
    maxMs: 9_000,
    meanMs: 5_000,
  });
  assert.equal(distribution([]), null);
});

test('collectHistory reads successful completed jobs and keeps queue/execution/end-to-end distinct', () => {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[1] === 'list') {
      return JSON.stringify([
        { databaseId: 11, status: 'completed', conclusion: 'success', createdAt: '2026-07-31T12:00:00Z' },
        { databaseId: 12, status: 'completed', conclusion: 'failure', createdAt: '2026-07-31T13:00:00Z' },
      ]);
    }
    return JSON.stringify({ jobs: [{ startedAt: '2026-07-31T12:02:00Z', completedAt: '2026-07-31T12:07:00Z' }] });
  };

  const result = collectHistory({ limit: 20, runGh });

  assert.equal(calls.length, 2, 'failed/incomplete runs do not pay a job-detail request');
  assert.deepEqual(result.rows, [{ runId: 11, queueMs: 120_000, executionMs: 300_000, endToEndMs: 420_000 }]);
  assert.equal(result.queue.medianMs, 120_000);
  assert.equal(result.execution.medianMs, 300_000);
  assert.equal(result.endToEnd.medianMs, 420_000);
});

test('renderHistory names the sample and all three latency distributions', () => {
  const markdown = renderHistory({
    rows: [{ runId: 11 }],
    queue: distribution([120_000]),
    execution: distribution([300_000]),
    endToEnd: distribution([420_000]),
  });
  assert.match(markdown, /1 successful completed run/);
  assert.match(markdown, /Queue wait/);
  assert.match(markdown, /Pickup → complete/);
  assert.match(markdown, /End to end/);
});
