// ABOUTME: Publishes self-hosted Windows Actions timing and summarizes recent successful-run latency.
// ABOUTME: Separates queue delay from runner execution so CI throughput changes have comparable evidence.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function timestampMs(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`missing or invalid ${label} timestamp`);
  return parsed;
}

function elapsedMs(start, end, label) {
  const elapsed = timestampMs(end, `${label} end`) - timestampMs(start, `${label} start`);
  if (elapsed < 0) throw new Error(`${label} end precedes its start`);
  return elapsed;
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unavailable';
  const seconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${remainder}s`;
}

export function buildRunReport({ run, job, observedAt = new Date().toISOString() }) {
  const steps = (job.steps ?? [])
    .filter((step) => step.started_at && step.completed_at)
    .map((step) => ({
      name: step.name,
      durationMs: elapsedMs(step.started_at, step.completed_at, `step ${step.name}`),
      conclusion: step.conclusion ?? 'unknown',
    }));

  return {
    url: run.html_url,
    observedAt,
    queueMs: elapsedMs(run.created_at, job.started_at, 'queue'),
    executionMs: elapsedMs(job.started_at, job.completed_at ?? observedAt, 'execution'),
    steps,
  };
}

export function renderRunReport(report) {
  const lines = [
    '## Windows runner timing',
    '',
    '| Phase | Duration |',
    '| --- | ---: |',
    `| Queue wait | ${formatDuration(report.queueMs)} |`,
    `| Pickup → summary | ${formatDuration(report.executionMs)} |`,
    '',
    '| Step | Conclusion | Duration |',
    '| --- | --- | ---: |',
    ...report.steps.map(
      (step) => `| ${step.name.replaceAll('|', '\\|')} | ${step.conclusion} | ${formatDuration(step.durationMs)} |`,
    ),
    '',
    `Measured at ${report.observedAt}${report.url ? ` for [this run](${report.url})` : ''}.`,
    '',
  ];
  return lines.join('\n');
}

export function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2
    ? sorted[midpoint]
    : Math.round((sorted[midpoint - 1] + sorted[midpoint]) / 2);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs,
    p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1],
    maxMs: sorted.at(-1),
    meanMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function parseGhJson(runGh, args) {
  return JSON.parse(runGh(args));
}

export function collectHistory({ limit = 30, runGh = invokeGh } = {}) {
  const runs = parseGhJson(runGh, [
    'run',
    'list',
    '--workflow',
    'windows-self-hosted.yml',
    '--limit',
    String(limit),
    '--json',
    'databaseId,status,conclusion,createdAt',
  ]);
  const rows = [];

  for (const run of runs) {
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    const detail = parseGhJson(runGh, ['run', 'view', String(run.databaseId), '--json', 'jobs']);
    const job = detail.jobs?.[0];
    if (!job?.startedAt || !job.completedAt) continue;
    const queueMs = elapsedMs(run.createdAt, job.startedAt, `run ${run.databaseId} queue`);
    const executionMs = elapsedMs(job.startedAt, job.completedAt, `run ${run.databaseId} execution`);
    rows.push({
      runId: run.databaseId,
      queueMs,
      executionMs,
      endToEndMs: queueMs + executionMs,
    });
  }

  return {
    rows,
    queue: distribution(rows.map((row) => row.queueMs)),
    execution: distribution(rows.map((row) => row.executionMs)),
    endToEnd: distribution(rows.map((row) => row.endToEndMs)),
  };
}

function renderDistribution(name, stats) {
  if (!stats) return `| ${name} | 0 | — | — | — | — | — |`;
  return `| ${name} | ${stats.count} | ${formatDuration(stats.minMs)} | ${formatDuration(stats.medianMs)} | ${formatDuration(stats.p90Ms)} | ${formatDuration(stats.maxMs)} | ${formatDuration(stats.meanMs)} |`;
}

export function renderHistory(history) {
  const count = history.rows.length;
  return [
    `# Windows runner history: ${count} successful completed ${count === 1 ? 'run' : 'runs'}`,
    '',
    '| Measure | N | Min | Median | P90 | Max | Mean |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    renderDistribution('Queue wait', history.queue),
    renderDistribution('Pickup → complete', history.execution),
    renderDistribution('End to end', history.endToEnd),
    '',
  ].join('\n');
}

export function invokeGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh exited ${result.status}`);
  return result.stdout;
}

async function githubJson(path, env = process.env) {
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'cowrite-windows-ci-timing',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

export async function publishSummary({ env = process.env, requestJson = githubJson } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!repository || !runId || !env.GH_TOKEN) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID, and GH_TOKEN are required');
  }
  const [run, jobsResponse] = await Promise.all([
    requestJson(`/repos/${repository}/actions/runs/${runId}`, env),
    requestJson(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, env),
  ]);
  const job = jobsResponse.jobs?.find((candidate) => candidate.runner_name === env.RUNNER_NAME)
    ?? jobsResponse.jobs?.[0];
  if (!job) throw new Error('current run has no visible job');
  const markdown = renderRunReport(buildRunReport({ run, job }));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
  return markdown;
}

async function main() {
  const command = process.argv[2];
  if (command === 'publish') {
    try {
      await publishSummary();
    } catch (error) {
      const message = `## Windows runner timing\n\nTiming unavailable: ${error.message}\n`;
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
      else process.stdout.write(message);
      console.warn(message.trim());
    }
    return;
  }
  if (command === 'history') {
    const limit = Number(process.argv[3] ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('history limit must be an integer from 1 through 100');
    }
    process.stdout.write(renderHistory(collectHistory({ limit })));
    return;
  }
  throw new Error('usage: node scripts/windows-ci-timing.mjs <publish|history [1-100]>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
