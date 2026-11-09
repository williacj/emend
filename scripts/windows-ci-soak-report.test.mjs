// ABOUTME: Pins the post-change Windows soak aggregator's cache parsing and overlap/isolation gates.
// ABOUTME: Keeps full/selective latency statistics reproducible without calling GitHub in unit tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCohort,
  parseCacheStats,
  renderReport,
  selectAuditRuns,
} from './windows-ci-soak-report.mjs';

const evidence = {
  workflowPath: '.github/workflows/windows-self-hosted.yml',
  canaryWorkflowPath: '.github/workflows/windows-runner-isolation-canary.yml',
  acceptedRounds: [{
    round: 1,
    controlSha: 'a'.repeat(40),
    full: [11, 12],
    selective: 13,
    selectiveSha: 'b'.repeat(40),
    cancelledCanary: 14,
  }],
};

function soakSteps(selected) {
  return [
    'Rust fmt check',
    'Rust clippy',
    'Cargo test',
    'Install dependencies',
    'tooling self-test',
    'Validate docs/test-matrix.md',
    'vitest',
  ].map((name, index) => ({
    name,
    conclusion: selected.includes(name) ? 'success' : 'skipped',
    startedAt: `2026-08-02T00:0${index}:00Z`,
    completedAt: `2026-08-02T00:0${index}:10Z`,
  }));
}

function full(id, runnerId, startedAt, completedAt) {
  return {
    id,
    round: 1,
    workflowPath: evidence.workflowPath,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    headSha: 'a'.repeat(40),
    createdAt: '2026-08-02T00:00:00Z',
    startedAt,
    completedAt,
    runnerId,
    runnerName: `runner-${runnerId}`,
    steps: soakSteps([
      'Rust fmt check',
      'Rust clippy',
      'Cargo test',
      'Install dependencies',
      'tooling self-test',
      'Validate docs/test-matrix.md',
      'vitest',
    ]),
    cache: { hits: 90, misses: 10, readErrors: 0, writeErrors: 0, errors: 0 },
  };
}

function selective() {
  return {
    id: 13,
    round: 1,
    workflowPath: evidence.workflowPath,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    headSha: 'b'.repeat(40),
    createdAt: '2026-08-02T00:02:30Z',
    startedAt: '2026-08-02T00:06:00Z',
    completedAt: '2026-08-02T00:06:30Z',
    runnerId: 1,
    runnerName: 'runner-1',
    steps: soakSteps(['Install dependencies', 'tooling self-test', 'Validate docs/test-matrix.md']),
    cache: null,
  };
}

function canary() {
  return {
    id: 14,
    workflowPath: evidence.canaryWorkflowPath,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'cancelled',
    headSha: 'b'.repeat(40),
    createdAt: '2026-08-02T00:03:00Z',
    updatedAt: '2026-08-02T00:03:10Z',
    jobs: ['Isolation canary (base)', 'Isolation canary (head)'].map((name, index) => ({
      id: 100 + index,
      name,
      status: 'completed',
      conclusion: 'cancelled',
      runnerId: 0,
      runnerName: '',
      labels: ['self-hosted', 'Windows'],
      startedAt: '2026-08-02T00:03:00Z',
      completedAt: '2026-08-02T00:03:10Z',
    })),
  };
}

function acceptedRows() {
  return [
    full(11, 1, '2026-08-02T00:01:00Z', '2026-08-02T00:06:10Z'),
    full(12, 2, '2026-08-02T00:02:00Z', '2026-08-02T00:07:00Z'),
    selective(),
  ];
}

function auditJobs(rows = acceptedRows()) {
  return rows.map((row, index) => ({
    id: 200 + index,
    runId: row.id,
    name: `production-${row.id}`,
    labels: ['self-hosted', 'Windows'],
    runnerId: row.runnerId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

test('parseCacheStats reads the exact aggregate counters from the report step', () => {
  const log = [
    'job\tReport Rust compiler cache\tCache hits                          594',
    'job\tReport Rust compiler cache\tCache hits (Rust)                   594',
    'job\tReport Rust compiler cache\tCache misses                         87',
    'job\tReport Rust compiler cache\tCache read errors                     0',
    'job\tReport Rust compiler cache\tCache write errors                    0',
    'job\tReport Rust compiler cache\tCache errors                          0',
  ].join('\n');
  assert.deepEqual(parseCacheStats(log), {
    hits: 594,
    misses: 87,
    readErrors: 0,
    writeErrors: 0,
    errors: 0,
  });
});

// The sccache daemon is owned by the host, not by a job (#1178), so its raw counters accumulate
// across every run since it started. The workflow prints a per-run delta block after the raw
// stats; last-match-wins is what makes the delta the value read, and is therefore load-bearing.
test('parseCacheStats reads the per-run delta block, not the daemon lifetime totals it follows (#1178)', () => {
  const log = [
    'job\tReport Rust compiler cache\tCache hits                         5940',
    'job\tReport Rust compiler cache\tCache misses                        870',
    'job\tReport Rust compiler cache\tCache read errors                     3',
    'job\tReport Rust compiler cache\tCache write errors                    2',
    'job\tReport Rust compiler cache\tCache errors                          1',
    'job\tReport Rust compiler cache\tThis run (delta against the step-start baseline):',
    'job\tReport Rust compiler cache\tCache hits                          594',
    'job\tReport Rust compiler cache\tCache misses                         87',
    'job\tReport Rust compiler cache\tCache read errors                     0',
    'job\tReport Rust compiler cache\tCache write errors                    0',
    'job\tReport Rust compiler cache\tCache errors                          0',
  ].join('\n');
  assert.deepEqual(parseCacheStats(log), {
    hits: 594,
    misses: 87,
    readErrors: 0,
    writeErrors: 0,
    errors: 0,
  });
});

test('analyzeCohort separates latency and proves two-runner plus selective overlap', () => {
  const rows = acceptedRows();
  const report = analyzeCohort(evidence, rows, [canary()], auditJobs(rows));
  assert.equal(report.full.count, 2);
  assert.equal(report.selective.count, 1);
  assert.equal(report.cache.hitRate.medianMs, 90);
  assert.match(renderReport(report), /2 full jobs and 1 selective jobs/);
});

test('analyzeCohort rejects a canary that reached a runner', () => {
  const badCanary = canary();
  badCanary.jobs[1].runnerId = 22;
  const rows = acceptedRows();
  assert.throws(() => analyzeCohort(evidence, rows, [badCanary], auditJobs(rows)), /canary identity\/isolation mismatch/);
});

test('analyzeCohort rejects a selective run with a missing suite signal', () => {
  const rows = acceptedRows();
  rows[2].steps = rows[2].steps.filter((step) => step.name !== 'vitest');
  assert.throws(() => analyzeCohort(evidence, rows, [canary()], auditJobs(rows)), /suite signals do not identify one valid scope/);
});

test('analyzeCohort rejects a full run missing the Rust fmt signal', () => {
  const rows = acceptedRows();
  rows[0].steps = rows[0].steps.filter((step) => step.name !== 'Rust fmt check');
  assert.throws(() => analyzeCohort(evidence, rows, [canary()], auditJobs(rows)), /suite signals do not identify one valid scope/);
});

test('analyzeCohort rejects a production run from another workflow', () => {
  const rows = acceptedRows();
  rows[0].workflowPath = '.github/workflows/other.yml';
  assert.throws(() => analyzeCohort(evidence, rows, [canary()], auditJobs(rows)), /workflow\/event\/status identity mismatch/);
});

test('analyzeCohort rejects a substituted canary identity', () => {
  const rows = acceptedRows();
  const badCanary = canary();
  badCanary.headSha = 'c'.repeat(40);
  assert.throws(() => analyzeCohort(evidence, rows, [badCanary], auditJobs(rows)), /canary identity\/isolation mismatch/);
});

test('analyzeCohort rejects unrelated Windows overlap', () => {
  const rows = acceptedRows();
  const audit = auditJobs(rows);
  audit.push({
    id: 999,
    runId: 999,
    name: 'unrelated Windows suite',
    labels: ['self-hosted', 'Windows'],
    runnerId: 24,
    startedAt: '2026-08-02T00:04:00Z',
    completedAt: '2026-08-02T00:05:00Z',
  });
  assert.throws(() => analyzeCohort(evidence, rows, [canary()], audit), /unrelated Windows overlap/);
});

test('selectAuditRuns rejects partial workflow-run pagination', () => {
  assert.throws(() => selectAuditRuns([{
    total_count: 2,
    workflow_runs: [{
      id: 1,
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:10:00Z',
    }],
  }], Date.parse('2026-08-02T00:01:00Z'), Date.parse('2026-08-02T00:09:00Z')),
  /cannot prove complete workflow-run pagination/);
});
