// ABOUTME: Tests fail-closed cohort and full-window validation for Windows contention benchmarks.
// ABOUTME: Excludes moving refs, reused runners, non-overlap, and unrelated Windows work.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  inspectCohort,
  inspectWindow,
  validateCargoBuildJobs,
  validateCohort,
  validateTargetSha,
  validateWindow,
} from './windows-contention-cohort.mjs';

const job = (id, name, runnerId, runnerName, overrides = {}) => ({
  id,
  name,
  status: 'in_progress',
  runner_id: runnerId,
  runner_name: runnerName,
  labels: ['self-hosted', 'Windows'],
  started_at: '2026-07-31T19:00:00Z',
  completed_at: null,
  _runId: 42,
  ...overrides,
});

const hostArtifacts = (...slots) => slots.map((slot, index) => ({
  id: index + 1,
  name: `contention-host-${slot}`,
  expired: false,
}));

test('validateTargetSha accepts only an immutable full commit SHA', () => {
  const sha = 'a'.repeat(40);
  assert.equal(validateTargetSha(sha), sha);
  for (const value of ['main', 'abc123', `${sha}x`, '']) {
    assert.throws(() => validateTargetSha(value), /40-character commit SHA/);
  }
});

test('validateCargoBuildJobs accepts uncapped or a canonical positive integer', () => {
  assert.equal(validateCargoBuildJobs('uncapped'), 'uncapped');
  assert.equal(validateCargoBuildJobs('8'), '8');
  for (const value of ['', '0', '-1', '08', '1.5', 'eight', undefined]) {
    assert.throws(
      () => validateCargoBuildJobs(value),
      /uncapped or a canonical positive integer/,
    );
  }
});

test('validateCohort accepts one current job as the only active Windows job', () => {
  const current = job(1, 'Full suite contention (base, one)', 22, 'cowrite-windows');
  assert.deepEqual(validateCohort({
    parallelism: 'one',
    currentRunnerName: 'cowrite-windows',
    currentJobs: [current],
    allJobs: [current],
    artifacts: hostArtifacts('base'),
  }), {
    runnerIds: [22],
    runnerNames: ['cowrite-windows'],
    startedAt: '2026-07-31T19:00:00.000Z',
  });
});

test('validateCohort requires distinct overlapping jobs and no unrelated active Windows job', () => {
  const first = job(1, 'Full suite contention (base, two)', 22, 'cowrite-windows');
  const second = job(2, 'Full suite contention (peer, two)', 24, 'cowrite-windows-2', {
    started_at: '2026-07-31T19:00:05Z',
  });
  const valid = {
    parallelism: 'two',
    currentRunnerName: 'cowrite-windows',
    currentJobs: [first, second],
    allJobs: [first, second],
    artifacts: hostArtifacts('base', 'peer'),
  };
  assert.deepEqual(validateCohort(valid), {
    runnerIds: [22, 24],
    runnerNames: ['cowrite-windows', 'cowrite-windows-2'],
    startedAt: '2026-07-31T19:00:05.000Z',
  });
  assert.throws(() => validateCohort({ ...valid, currentJobs: [first, { ...second, runner_id: 22 }] }), /distinct runner ids/);
  assert.throws(() => validateCohort({ ...valid, currentJobs: [{ ...first, status: 'completed' }, second] }), /2 overlapping benchmark jobs/);
  assert.throws(() => validateCohort({ ...valid, allJobs: [...valid.allJobs, job(3, 'production', 26, 'unrelated', { _runId: 99 })] }), /unrelated active Windows work/);
  assert.throws(
    () => validateCohort({ ...valid, artifacts: hostArtifacts('base') }),
    /expected hostname evidence artifacts contention-host-base, contention-host-peer/,
  );
});

test('cohort inspection uses Actions-readable run and job APIs, never runner administration', () => {
  const source = readFileSync(new URL('./windows-contention-cohort.mjs', import.meta.url), 'utf8');
  assert.match(source, /actions\/runs\?status=in_progress/);
  assert.match(source, /actions\/runs\/\$\{run\.id\}\/jobs/);
  assert.match(source, /actions\/runs\/\$\{currentRunId\}\/artifacts/);
  assert.doesNotMatch(source, /actions\/runners/);
});

test('validateWindow rejects non-overlap and any Windows job that intersects the measured interval', () => {
  const first = job(1, 'Full suite contention (base, two)', 22, 'cowrite-windows', {
    status: 'completed',
    completed_at: '2026-07-31T19:10:00Z',
  });
  const second = job(2, 'Full suite contention (peer, two)', 24, 'cowrite-windows-2', {
    status: 'completed',
    started_at: '2026-07-31T19:00:05Z',
    completed_at: '2026-07-31T19:09:00Z',
  });
  const input = {
    parallelism: 'two',
    currentRunId: 42,
    startedAt: '2026-07-31T19:00:00Z',
    endedAt: '2026-07-31T19:10:00Z',
    allJobs: [first, second],
  };
  assert.deepEqual(validateWindow(input), { benchmarkJobs: 2, unrelatedWindowsJobs: 0 });
  assert.throws(
    () => validateWindow({ ...input, allJobs: [...input.allJobs, job(3, 'production', 26, 'unrelated', { _runId: 99, started_at: '2026-07-31T19:05:00Z', completed_at: '2026-07-31T19:06:00Z', status: 'completed' })] }),
    /unrelated Windows job overlapped/,
  );
  assert.throws(
    () => validateWindow({ ...input, allJobs: [first, { ...second, started_at: '2026-07-31T19:11:00Z' }] }),
    /did not overlap/,
  );
});

test('#1961: validateWindow ignores queued and skipped Windows jobs that never reached a runner', () => {
  const first = job(1, 'Full suite contention (base, two)', 27, 'cowrite-windows-3', {
    status: 'completed',
    started_at: '2026-08-24T21:29:15Z',
    completed_at: '2026-08-24T21:38:45Z',
    _runId: 32779742417,
  });
  const second = job(2, 'Full suite contention (peer, two)', 28, 'cowrite-windows-4', {
    status: 'completed',
    started_at: '2026-08-24T21:29:16Z',
    completed_at: '2026-08-24T21:38:41Z',
    _runId: 32779742417,
  });
  const skipped = job(3, 'E2E focused repeat (Windows, self-hosted)', null, null, {
    status: 'completed',
    conclusion: 'skipped',
    started_at: '2026-08-24T21:30:45Z',
    completed_at: '2026-08-24T21:30:44Z',
    _runId: 32779882873,
  });
  const queued = job(4, 'Suites (Windows, self-hosted)', null, null, {
    status: 'queued',
    conclusion: null,
    started_at: '2026-08-24T21:30:44Z',
    completed_at: null,
    _runId: 32779882873,
  });

  assert.deepEqual(validateWindow({
    parallelism: 'two',
    currentRunId: 32779742417,
    startedAt: '2026-08-24T21:29:16Z',
    endedAt: '2026-08-24T21:38:36Z',
    allJobs: [first, second, skipped, queued],
  }), { benchmarkJobs: 2, unrelatedWindowsJobs: 0 });
});

test('#1961: validateWindow rejects every overlapping Windows job that reached a runner', () => {
  const first = job(1, 'Full suite contention (base, two)', 27, 'cowrite-windows-3', {
    status: 'completed',
    completed_at: '2026-07-31T19:10:00Z',
  });
  const second = job(2, 'Full suite contention (peer, two)', 28, 'cowrite-windows-4', {
    status: 'completed',
    started_at: '2026-07-31T19:00:05Z',
    completed_at: '2026-07-31T19:09:00Z',
  });
  const input = {
    parallelism: 'two',
    currentRunId: 42,
    startedAt: '2026-07-31T19:00:00Z',
    endedAt: '2026-07-31T19:10:00Z',
    allJobs: [first, second],
  };

  for (const conclusion of ['success', 'failure', 'cancelled']) {
    const executed = job(3, `unrelated ${conclusion}`, 26, 'cowrite-windows-2', {
      status: 'completed',
      conclusion,
      started_at: '2026-07-31T19:05:00Z',
      completed_at: '2026-07-31T19:06:00Z',
      _runId: 99,
    });
    assert.throws(
      () => validateWindow({ ...input, allJobs: [...input.allJobs, executed] }),
      /unrelated Windows job overlapped/,
      `${conclusion} execution must invalidate the measured window`,
    );
  }
});

test('inspectCohort uses actions-readable run/job APIs and waits boundedly for both jobs', async () => {
  let reads = 0;
  let waits = 0;
  const first = job(1, 'Full suite contention (base, two)', 22, 'cowrite-windows');
  const second = job(2, 'Full suite contention (peer, two)', 24, 'cowrite-windows-2');
  const result = await inspectCohort({
    env: {
      COWRITE_TARGET_SHA: 'a'.repeat(40),
      COWRITE_PARALLELISM: 'two',
      COWRITE_CARGO_BUILD_JOBS: '8',
      GITHUB_RUN_ID: '42',
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'secret',
      RUNNER_NAME: 'cowrite-windows',
    },
    collectJobs: async () => {
      reads += 1;
      return reads === 1
        ? { currentJobs: [first], allJobs: [first], artifacts: hostArtifacts('base') }
        : {
          currentJobs: [first, second],
          allJobs: [first, second],
          artifacts: hostArtifacts('base', 'peer'),
        };
    },
    wait: async () => { waits += 1; },
    attempts: 2,
  });
  assert.equal(result.targetSha, 'a'.repeat(40));
  assert.equal(result.cargoBuildJobs, '8');
  assert.equal(result.startedAt, '2026-07-31T19:00:00.000Z');
  assert.equal(waits, 1);
});

test('inspectWindow delegates the complete measured interval to durable job validation', async () => {
  const current = job(1, 'Full suite contention (base, one)', 22, 'cowrite-windows');
  const result = await inspectWindow({
    env: {
      COWRITE_PARALLELISM: 'one',
      COWRITE_BENCHMARK_STARTED_AT: '2026-07-31T19:00:00Z',
      COWRITE_BENCHMARK_ENDED_AT: '2026-07-31T19:10:00Z',
      GITHUB_RUN_ID: '42',
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'secret',
    },
    collectJobs: async () => [current],
  });
  assert.deepEqual(result, { benchmarkJobs: 1, unrelatedWindowsJobs: 0 });
});

test('inspectWindow paginates every run in its immutable timestamp range', async () => {
  const requested = [];
  const oldRun = (id) => ({
    id,
    status: 'completed',
    created_at: '2026-07-31T18:00:00Z',
    updated_at: '2026-07-31T18:01:00Z',
  });
  const firstPage = Array.from({ length: 100 }, (_, index) => oldRun(index + 1));
  firstPage[41] = {
    id: 42,
    status: 'completed',
    created_at: '2026-07-31T18:59:00Z',
    updated_at: '2026-07-31T19:10:00Z',
  };
  const current = job(1, 'Full suite contention (base, one)', 22, 'cowrite-windows');
  const result = await inspectWindow({
    env: {
      COWRITE_PARALLELISM: 'one',
      COWRITE_BENCHMARK_STARTED_AT: '2026-07-31T19:00:00Z',
      COWRITE_BENCHMARK_ENDED_AT: '2026-07-31T19:10:00Z',
      GITHUB_RUN_ID: '42',
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'secret',
    },
    requestJson: async (path) => {
      requested.push(path);
      if (path.includes('/actions/runs?') && path.includes('&page=1')) {
        return { total_count: 101, workflow_runs: firstPage };
      }
      if (path.includes('/actions/runs?') && path.includes('&page=2')) {
        return { total_count: 101, workflow_runs: [oldRun(101)] };
      }
      if (path.includes('/actions/runs/42/jobs')) {
        return { total_count: 1, jobs: [current] };
      }
      throw new Error(`unexpected request: ${path}`);
    },
  });
  assert.deepEqual(result, { benchmarkJobs: 1, unrelatedWindowsJobs: 0 });
  assert.equal(requested.some((path) => path.includes('&page=2')), true);
  assert.equal(requested[0].includes('2026-07-30T19%3A00%3A00.000Z..2026-07-31T19%3A10%3A00.000Z'), true);
});

test("inspectWindow fails closed at GitHub's 1,000-result search cap", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    status: 'completed',
    created_at: '2026-07-31T18:00:00Z',
    updated_at: '2026-07-31T18:01:00Z',
  }));
  await assert.rejects(
    () => inspectWindow({
      env: {
        COWRITE_PARALLELISM: 'one',
        COWRITE_BENCHMARK_STARTED_AT: '2026-07-31T19:00:00Z',
        COWRITE_BENCHMARK_ENDED_AT: '2026-07-31T19:10:00Z',
        GITHUB_RUN_ID: '42',
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'secret',
      },
      requestJson: async () => ({ total_count: 1_000, workflow_runs: firstPage }),
    }),
    /1,000-result GitHub search cap/,
  );
});
