// ABOUTME: Reproduces the final Windows CI throughput soak from immutable GitHub Actions run ids.
// ABOUTME: Separates full/selective latency, validates overlap/isolation, and reports compiler-cache health.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { distribution, formatDuration } from './windows-ci-timing.mjs';

const STEP_NAMES = [
  'Rust fmt check',
  'Rust clippy',
  'Cargo test',
  'Install dependencies',
  'tooling self-test',
  'Validate docs/test-matrix.md',
  'vitest',
];

const FULL_STEP_CONCLUSIONS = Object.fromEntries(STEP_NAMES.map((name) => [name, 'success']));
const SELECTIVE_STEP_CONCLUSIONS = {
  'Rust fmt check': 'skipped',
  'Rust clippy': 'skipped',
  'Cargo test': 'skipped',
  'Install dependencies': 'success',
  'tooling self-test': 'success',
  'Validate docs/test-matrix.md': 'success',
  vitest: 'skipped',
};

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label} timestamp`);
  return parsed;
}

function duration(start, end, label) {
  const value = timestamp(end, `${label} end`) - timestamp(start, `${label} start`);
  if (value < 0) throw new Error(`${label} end precedes start`);
  return value;
}

function overlaps(left, right) {
  return timestamp(left.startedAt, 'left start') < timestamp(right.completedAt, 'right end')
    && timestamp(right.startedAt, 'right start') < timestamp(left.completedAt, 'left end');
}

export function parseCacheStats(log) {
  // GitHub rewrites the step label to "UNKNOWN STEP" on some historical log downloads,
  // so identify the unique aggregate counters by their complete line endings instead.
  const result = {};
  const patterns = {
    hits: /\bCache hits\s+(\d+)\s*$/,
    misses: /\bCache misses\s+(\d+)\s*$/,
    readErrors: /\bCache read errors\s+(\d+)\s*$/,
    writeErrors: /\bCache write errors\s+(\d+)\s*$/,
    errors: /\bCache errors\s+(\d+)\s*$/,
  };
  for (const line of log.split(/\r?\n/)) {
    for (const [name, pattern] of Object.entries(patterns)) {
      const match = line.match(pattern);
      if (match) result[name] = Number(match[1]);
    }
  }
  for (const name of Object.keys(patterns)) {
    if (!Number.isInteger(result[name])) throw new Error(`cache log is missing ${name}`);
  }
  return result;
}

function stepDuration(row, name) {
  const step = row.steps.find((candidate) => candidate.name === name && candidate.conclusion === 'success');
  return step ? duration(step.startedAt, step.completedAt, `step ${name}`) : null;
}

function stats(values) {
  return distribution(values.filter(Number.isFinite));
}

function conclusionsMatch(steps, expected) {
  const byName = new Map(steps.map((step) => [step.name, step.conclusion]));
  return Object.entries(expected).every(([name, conclusion]) => (
    steps.filter((step) => step.name === name).length === 1 && byName.get(name) === conclusion
  ));
}

function observeScope(row) {
  const matches = [
    ['full', FULL_STEP_CONCLUSIONS],
    ['selective', SELECTIVE_STEP_CONCLUSIONS],
  ].filter(([, expected]) => conclusionsMatch(row.steps, expected));
  if (matches.length !== 1) throw new Error(`run ${row.id} suite signals do not identify one valid scope`);
  return matches[0][0];
}

function validateStepConclusions(row, expected) {
  const byName = new Map(row.steps.map((step) => [step.name, step.conclusion]));
  for (const [name, conclusion] of Object.entries(expected)) {
    const count = row.steps.filter((step) => step.name === name).length;
    if (count !== 1 || byName.get(name) !== conclusion) {
      throw new Error(`run ${row.id} expected ${name}=${conclusion}, received ${byName.get(name) ?? 'missing'}`);
    }
  }
}

function validateRunIdentity(row, evidence, expectedEvent) {
  if (row.workflowPath !== evidence.workflowPath || row.event !== expectedEvent
    || row.status !== 'completed' || row.conclusion !== 'success') {
    throw new Error(`run ${row.id} workflow/event/status identity mismatch`);
  }
  if (!Number.isInteger(row.runnerId) || row.runnerId < 1 || !row.runnerName) {
    throw new Error(`run ${row.id} is missing its assigned runner identity`);
  }
}

function isWindowsJob(job) {
  return job.labels?.some((label) => (
    (typeof label === 'string' ? label : label?.name)?.toLowerCase() === 'windows'
  ));
}

function auditRound(round, rows, auditJobs) {
  const accepted = [...round.full, round.selective].map((id) => rows.find((row) => row.id === id));
  const windowStart = Math.min(...accepted.map((row) => timestamp(row.startedAt, `run ${row.id} start`)));
  const windowEnd = Math.max(...accepted.map((row) => timestamp(row.completedAt, `run ${row.id} end`)));
  const expected = new Set(accepted.map((row) => row.id));
  const overlapsWindow = auditJobs.filter((job) => {
    if (!isWindowsJob(job) || !Number.isInteger(job.runnerId) || job.runnerId < 1 || !job.startedAt) return false;
    const start = timestamp(job.startedAt, `audit job ${job.id} start`);
    const end = timestamp(job.completedAt, `audit job ${job.id} end`);
    return start < windowEnd && end > windowStart;
  });
  const unrelated = overlapsWindow.filter((job) => !expected.has(job.runId));
  if (unrelated.length) {
    throw new Error(`round ${round.round} has unrelated Windows overlap: ${unrelated.map((job) => `${job.runId}:${job.name}`).join(', ')}`);
  }
  for (const id of expected) {
    if (overlapsWindow.filter((job) => job.runId === id).length !== 1) {
      throw new Error(`round ${round.round} contamination audit is missing production run ${id}`);
    }
  }
}

export function analyzeCohort(evidence, rows, canaries, auditJobs) {
  const expectedIds = evidence.acceptedRounds.flatMap((round) => [...round.full, round.selective]);
  if (expectedIds.length < (evidence.minimumSuccessfulJobs ?? 0)) {
    throw new Error(`accepted cohort has ${expectedIds.length} jobs; minimum is ${evidence.minimumSuccessfulJobs}`);
  }
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error('accepted run ids must be unique');
  if (rows.length !== expectedIds.length) throw new Error(`expected ${expectedIds.length} rows, received ${rows.length}`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const canaryById = new Map(canaries.map((canary) => [canary.id, canary]));
  const expectedCanaryIds = evidence.acceptedRounds.map((round) => round.cancelledCanary);
  const canaryJobIds = canaries.flatMap((canary) => canary.jobs?.map((job) => job.id) ?? []);
  if (new Set(expectedCanaryIds).size !== expectedCanaryIds.length
    || canaries.length !== expectedCanaryIds.length
    || new Set(canaries.map((canary) => canary.id)).size !== canaries.length
    || new Set(canaryJobIds).size !== canaryJobIds.length) {
    throw new Error('cancelled canary ids must be complete and unique');
  }
  if (!Array.isArray(auditJobs)) throw new Error('complete Windows-job audit is required');

  for (const round of evidence.acceptedRounds) {
    const full = round.full.map((id) => byId.get(id));
    const selective = byId.get(round.selective);
    if (full.some((row) => !row) || !selective) throw new Error(`round ${round.round} is missing a run`);
    for (const row of full) validateRunIdentity(row, evidence, 'workflow_dispatch');
    validateRunIdentity(selective, evidence, 'pull_request');
    if (full.some((row) => observeScope(row) !== 'full' || row.headSha !== round.controlSha)) {
      throw new Error(`round ${round.round} full run scope/SHA mismatch`);
    }
    if (observeScope(selective) !== 'selective' || selective.headSha !== round.selectiveSha) {
      throw new Error(`round ${round.round} selective run scope/SHA mismatch`);
    }
    if (full[0].runnerId === full[1].runnerId) throw new Error(`round ${round.round} reused one runner`);
    if (!overlaps(full[0], full[1])) throw new Error(`round ${round.round} full jobs did not overlap`);
    if (!overlaps(full[1], selective)) throw new Error(`round ${round.round} selective job did not overlap full B`);
    const canary = canaryById.get(round.cancelledCanary);
    const canaryNames = canary?.jobs.map((job) => job.name).sort();
    if (!canary || canary.workflowPath !== evidence.canaryWorkflowPath || canary.event !== 'pull_request'
      || canary.status !== 'completed' || canary.conclusion !== 'cancelled'
      || canary.headSha !== round.selectiveSha
      || timestamp(canary.createdAt, `canary ${canary.id} creation`) < timestamp(full[1].startedAt, `run ${full[1].id} start`)
      || timestamp(canary.createdAt, `canary ${canary.id} creation`) >= timestamp(full[1].completedAt, `run ${full[1].id} end`)
      || timestamp(canary.updatedAt, `canary ${canary.id} update`) < timestamp(canary.createdAt, `canary ${canary.id} creation`)
      || timestamp(canary.updatedAt, `canary ${canary.id} update`) > timestamp(full[1].completedAt, `run ${full[1].id} end`)
      || canary.jobs.length !== 2
      || canaryNames.join('|') !== 'Isolation canary (base)|Isolation canary (head)'
      || canary.jobs.some((job) => job.status !== 'completed' || job.conclusion !== 'cancelled'
        || job.runnerId !== 0 || job.runnerName !== '' || !isWindowsJob(job))) {
      throw new Error(`round ${round.round} canary identity/isolation mismatch`);
    }
    auditRound(round, rows, auditJobs);
  }

  const full = rows.filter((row) => observeScope(row) === 'full');
  const selective = rows.filter((row) => observeScope(row) === 'selective');
  for (const row of full) {
    validateStepConclusions(row, FULL_STEP_CONCLUSIONS);
    if (row.cache.readErrors || row.cache.writeErrors || row.cache.errors) {
      throw new Error(`run ${row.id} reported a cache error`);
    }
    if (row.cache.hits + row.cache.misses === 0) throw new Error(`run ${row.id} reported no cache requests`);
  }
  for (const row of selective) validateStepConclusions(row, SELECTIVE_STEP_CONCLUSIONS);
  const summarize = (group) => ({
    count: group.length,
    queue: stats(group.map((row) => duration(row.createdAt, row.startedAt, `run ${row.id} queue`))),
    execution: stats(group.map((row) => duration(row.startedAt, row.completedAt, `run ${row.id} execution`))),
    endToEnd: stats(group.map((row) => duration(row.createdAt, row.completedAt, `run ${row.id} end to end`))),
    steps: Object.fromEntries(STEP_NAMES.map((name) => [name, stats(group.map((row) => stepDuration(row, name)))])),
  });
  const hitRates = full.map((row) => 100 * row.cache.hits / (row.cache.hits + row.cache.misses));
  return {
    rounds: evidence.acceptedRounds.length,
    all: summarize(rows),
    full: summarize(full),
    selective: summarize(selective),
    cache: {
      hitRate: stats(hitRates),
      readErrors: full.reduce((sum, row) => sum + row.cache.readErrors, 0),
      writeErrors: full.reduce((sum, row) => sum + row.cache.writeErrors, 0),
      errors: full.reduce((sum, row) => sum + row.cache.errors, 0),
    },
    audit: { acceptedWindowsJobs: rows.length, unrelatedWindowsJobs: 0 },
  };
}

function renderStats(value) {
  return value ? `${formatDuration(value.medianMs)} / ${formatDuration(value.p90Ms)}` : '—';
}

export function renderReport(report) {
  const lines = [
    '# Windows CI post-change soak',
    '',
    `${report.rounds} accepted rounds; ${report.full.count} full jobs and ${report.selective.count} selective jobs.`,
    '',
    '| Scope | N | Queue median / P90 | Execution median / P90 | End-to-end median / P90 |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| All | ${report.all.count} | ${renderStats(report.all.queue)} | ${renderStats(report.all.execution)} | ${renderStats(report.all.endToEnd)} |`,
    `| Full | ${report.full.count} | ${renderStats(report.full.queue)} | ${renderStats(report.full.execution)} | ${renderStats(report.full.endToEnd)} |`,
    `| Selective | ${report.selective.count} | ${renderStats(report.selective.queue)} | ${renderStats(report.selective.execution)} | ${renderStats(report.selective.endToEnd)} |`,
    '',
    '| Step | Full median / P90 | Selective median / P90 |',
    '| --- | ---: | ---: |',
    ...STEP_NAMES.map((name) => `| ${name} | ${renderStats(report.full.steps[name])} | ${renderStats(report.selective.steps[name])} |`),
    '',
    `Full-run cache hit-rate median/P90: ${report.cache.hitRate.medianMs.toFixed(2)}% / ${report.cache.hitRate.p90Ms.toFixed(2)}%.`,
    `Cache read/write/aggregate errors: ${report.cache.readErrors}/${report.cache.writeErrors}/${report.cache.errors}.`,
    `Contamination audit: ${report.audit.acceptedWindowsJobs} accepted Windows jobs; ${report.audit.unrelatedWindowsJobs} unrelated overlaps.`,
    '',
  ];
  return lines.join('\n');
}

function invokeGh(args) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (!result.error && result.status === 0) return result.stdout;
    if (attempt === 5) throw result.error ?? new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`);
  }
}

function fetchRow(repository, id, round) {
  const run = JSON.parse(invokeGh(['api', `repos/${repository}/actions/runs/${id}`]));
  const jobs = JSON.parse(invokeGh(['api', `repos/${repository}/actions/runs/${id}/jobs?per_page=100`]));
  if (jobs.jobs?.length !== 1) throw new Error(`run ${id} must contain exactly one production job`);
  const job = jobs.jobs[0];
  const row = {
    id,
    round,
    workflowPath: run.path,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    createdAt: run.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    runnerId: job.runner_id,
    runnerName: job.runner_name,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  };
  row.cache = observeScope(row) === 'full'
    ? parseCacheStats(invokeGh(['run', 'view', String(id), '--log']))
    : null;
  return row;
}

function fetchCanary(repository, id) {
  const run = JSON.parse(invokeGh(['api', `repos/${repository}/actions/runs/${id}`]));
  const jobs = JSON.parse(invokeGh(['api', `repos/${repository}/actions/runs/${id}/jobs?per_page=100`]));
  return {
    id,
    workflowPath: run.path,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    jobs: (jobs.jobs ?? []).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      runnerId: job.runner_id,
      runnerName: job.runner_name,
      labels: job.labels,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    })),
  };
}

export function selectAuditRuns(pages, start, end) {
  if (!Array.isArray(pages) || pages.length === 0
    || pages.some((page) => !Array.isArray(page.workflow_runs) || !Number.isInteger(page.total_count))) {
    throw new Error('contamination audit received a malformed workflow-run page');
  }
  const totals = new Set(pages.map((page) => page.total_count));
  const total = pages[0].total_count;
  const runs = pages.flatMap((page) => page.workflow_runs);
  if (totals.size !== 1 || total >= 1_000 || runs.length !== total
    || new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new Error('contamination audit cannot prove complete workflow-run pagination');
  }
  return runs.filter((run) => (
    timestamp(run.created_at, `run ${run.id} creation`) < end
    && timestamp(run.updated_at, `run ${run.id} update`) > start
  ));
}

function fetchAuditJobs(repository, rows) {
  const start = Math.min(...rows.map((row) => timestamp(row.startedAt, `run ${row.id} start`)));
  const end = Math.max(...rows.map((row) => timestamp(row.completedAt, `run ${row.id} end`)));
  const since = new Date(start - 86_400_000).toISOString();
  const until = new Date(end).toISOString();
  const created = encodeURIComponent(`${since}..${until}`);
  const pages = JSON.parse(invokeGh([
    'api', '--paginate', '--slurp',
    `repos/${repository}/actions/runs?created=${created}&per_page=100`,
  ]));
  const relevant = selectAuditRuns(pages, start, end);
  return relevant.flatMap((run) => {
    const response = JSON.parse(invokeGh([
      'api', `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
    ]));
    if (!Array.isArray(response.jobs) || !Number.isInteger(response.total_count)
      || response.total_count !== response.jobs.length) {
      throw new Error(`contamination audit cannot prove complete jobs for run ${run.id}`);
    }
    return response.jobs.map((job) => ({
      id: job.id,
      runId: run.id,
      name: job.name,
      labels: job.labels,
      runnerId: job.runner_id,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }));
  });
}

function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) throw new Error('usage: node scripts/windows-ci-soak-report.mjs EVIDENCE.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const rows = evidence.acceptedRounds.flatMap((round) => [
    ...round.full.map((id) => fetchRow(evidence.repository, id, round.round)),
    fetchRow(evidence.repository, round.selective, round.round),
  ]);
  const canaries = evidence.acceptedRounds.map((round) => fetchCanary(evidence.repository, round.cancelledCanary));
  const auditJobs = fetchAuditJobs(evidence.repository, rows);
  process.stdout.write(renderReport(analyzeCohort(evidence, rows, canaries, auditJobs)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
