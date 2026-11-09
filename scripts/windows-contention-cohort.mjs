// ABOUTME: Validates the initial cohort and complete measured window for Windows contention benchmarks.
// ABOUTME: Uses Actions-readable run/job history to reject non-overlap or unrelated Windows work.

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function validateTargetSha(value) {
  if (!SHA_PATTERN.test(value ?? '')) {
    throw new Error('target_sha must be an immutable 40-character commit SHA');
  }
  return value;
}

export function validateCargoBuildJobs(value) {
  if (value !== 'uncapped' && !/^[1-9][0-9]*$/.test(value ?? '')) {
    throw new Error('cargo_build_jobs must be uncapped or a canonical positive integer');
  }
  return value;
}

function expectedJobs(parallelism) {
  if (parallelism === 'one') return 1;
  if (parallelism === 'two') return 2;
  throw new Error(`unknown benchmark parallelism: ${parallelism}`);
}

function expectedHostArtifacts(parallelism) {
  return parallelism === 'two'
    ? ['contention-host-base', 'contention-host-peer']
    : ['contention-host-base'];
}

function isBenchmarkJob(job) {
  return job.name?.startsWith('Full suite contention (');
}

function isWindowsJob(job) {
  return job.labels?.some((label) => {
    const name = typeof label === 'string' ? label : label?.name;
    return name?.toLowerCase() === 'windows';
  });
}

function timeMs(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is missing or malformed`);
  return parsed;
}

function runnerEvidence(jobs, expected) {
  const runnerIds = jobs.map((job) => job.runner_id);
  const runnerNames = jobs.map((job) => job.runner_name);
  if (runnerIds.some((id) => !Number.isInteger(id) || id < 1)
    || new Set(runnerIds).size !== expected) {
    throw new Error(`benchmark jobs must use ${expected} distinct runner ids`);
  }
  if (runnerNames.some((name) => !name) || new Set(runnerNames).size !== expected) {
    throw new Error(`benchmark jobs must use ${expected} distinct runner names`);
  }
  return {
    runnerIds: [...runnerIds].sort((a, b) => a - b),
    runnerNames: [...runnerNames].sort(),
  };
}

function hostArtifactEvidence(artifacts, parallelism) {
  const expected = expectedHostArtifacts(parallelism);
  if (!Array.isArray(artifacts)) {
    throw new Error('current run hostname evidence artifacts are missing');
  }
  const available = new Set(
    artifacts
      .filter((artifact) => !artifact.expired)
      .map((artifact) => artifact.name),
  );
  if (expected.some((name) => !available.has(name))) {
    throw new Error(`expected hostname evidence artifacts ${expected.join(', ')}`);
  }
}

export function validateCohort({
  parallelism,
  currentRunnerName,
  currentJobs,
  allJobs,
  artifacts,
}) {
  const expected = expectedJobs(parallelism);
  const activeJobs = currentJobs.filter((job) => isBenchmarkJob(job) && job.status === 'in_progress');
  if (activeJobs.length !== expected) {
    throw new Error(`expected ${expected} overlapping benchmark jobs; found ${activeJobs.length}`);
  }
  const runners = runnerEvidence(activeJobs, expected);
  if (!runners.runnerNames.includes(currentRunnerName)) {
    throw new Error(`current runner ${currentRunnerName} is absent from the benchmark cohort`);
  }
  const activeWindows = allJobs.filter((job) => job.status === 'in_progress' && isWindowsJob(job));
  const benchmarkIds = new Set(activeJobs.map((job) => job.id));
  const unrelated = activeWindows.filter((job) => !benchmarkIds.has(job.id));
  if (activeWindows.length !== expected || unrelated.length) {
    throw new Error(
      `unrelated active Windows work invalidates the cohort: benchmark=${activeJobs.length} active=${activeWindows.length}`,
    );
  }
  hostArtifactEvidence(artifacts, parallelism);
  const startedAt = new Date(Math.max(...activeJobs.map(
    (job) => timeMs(job.started_at, `benchmark job ${job.id} start`),
  ))).toISOString();
  return { ...runners, startedAt };
}

export function validateWindow({ parallelism, currentRunId, startedAt, endedAt, allJobs }) {
  const expected = expectedJobs(parallelism);
  const startMs = timeMs(startedAt, 'benchmark window start');
  const endMs = timeMs(endedAt, 'benchmark window end');
  if (endMs <= startMs) throw new Error('benchmark window end must follow its start');
  const benchmarkJobs = allJobs.filter(
    (job) => String(job._runId) === String(currentRunId) && isBenchmarkJob(job),
  );
  if (benchmarkJobs.length !== expected) {
    throw new Error(`expected ${expected} durable benchmark jobs; found ${benchmarkJobs.length}`);
  }
  runnerEvidence(benchmarkJobs, expected);
  const intervals = benchmarkJobs.map((job) => ({
    start: timeMs(job.started_at, `benchmark job ${job.id} start`),
    end: job.completed_at ? timeMs(job.completed_at, `benchmark job ${job.id} end`) : endMs,
  }));
  if (Math.max(...intervals.map((interval) => interval.start))
    >= Math.min(...intervals.map((interval) => interval.end))) {
    throw new Error('benchmark jobs did not overlap during the measured window');
  }
  const benchmarkIds = new Set(benchmarkJobs.map((job) => `${job._runId}:${job.id}`));
  const unrelated = allJobs.filter((job) => {
    if (!isWindowsJob(job) || !Number.isInteger(job.runner_id) || job.runner_id < 1
      || !job.started_at || benchmarkIds.has(`${job._runId}:${job.id}`)) return false;
    const jobStart = timeMs(job.started_at, `job ${job.id} start`);
    const jobEnd = job.completed_at ? timeMs(job.completed_at, `job ${job.id} end`) : endMs;
    return jobStart < endMs && jobEnd > startMs;
  });
  if (unrelated.length) {
    const names = unrelated.map((job) => `${job._runId}:${job.name}`).join(', ');
    throw new Error(`unrelated Windows job overlapped the measured window: ${names}`);
  }
  return { benchmarkJobs: benchmarkJobs.length, unrelatedWindowsJobs: 0 };
}

async function githubJson(path, env = process.env) {
  const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'cowrite-windows-contention-cohort',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

function completePage(response, key, label) {
  const rows = response[key];
  if (!Array.isArray(rows) || !Number.isInteger(response.total_count)) {
    throw new Error(`${label} response is missing rows or total_count`);
  }
  if (response.total_count > rows.length) {
    throw new Error(`${label} exceeds the 100-row proof bound; refusing partial evidence`);
  }
  return rows;
}

async function jobsForRuns(runs, repository, requestJson, env) {
  const pages = await Promise.all(runs.map(async (run) => {
    const response = await requestJson(
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      env,
    );
    return completePage(response, 'jobs', `run ${run.id} jobs`).map((job) => ({ ...job, _runId: run.id }));
  }));
  return pages.flat();
}

async function collectActiveJobs({ repository, currentRunId, requestJson, env }) {
  const [response, artifactResponse] = await Promise.all([
    requestJson(
      `/repos/${repository}/actions/runs?status=in_progress&per_page=100`,
      env,
    ),
    requestJson(
      `/repos/${repository}/actions/runs/${currentRunId}/artifacts?per_page=100`,
      env,
    ),
  ]);
  const runs = completePage(response, 'workflow_runs', 'in-progress runs');
  const allJobs = await jobsForRuns(runs, repository, requestJson, env);
  return {
    currentJobs: allJobs.filter((job) => String(job._runId) === String(currentRunId)),
    allJobs,
    artifacts: completePage(artifactResponse, 'artifacts', 'current run artifacts'),
  };
}

async function collectWindowJobs({ repository, startedAt, endedAt, requestJson, env }) {
  const startMs = timeMs(startedAt, 'benchmark window start');
  const endMs = timeMs(endedAt, 'benchmark window end');
  const since = new Date(startMs - 86_400_000).toISOString();
  const until = new Date(endMs).toISOString();
  const createdRange = encodeURIComponent(`${since}..${until}`);
  const runs = [];
  let totalCount = null;
  const searchResultCap = 1_000;
  for (let page = 1; page <= 10; page += 1) {
    const response = await requestJson(
      `/repos/${repository}/actions/runs?created=${createdRange}&per_page=100&page=${page}`,
      env,
    );
    const pageRows = response.workflow_runs;
    if (!Array.isArray(pageRows) || !Number.isInteger(response.total_count)) {
      throw new Error('window candidate runs response is missing rows or total_count');
    }
    // GitHub caps workflow-run searches that use `created` at 1,000 results. At the cap there is no
    // way to distinguish exactly 1,000 matches from a truncated larger result, so fail closed before
    // treating any page set as complete evidence.
    if (response.total_count >= searchResultCap) {
      throw new Error('window candidate runs reached the 1,000-result GitHub search cap; refusing partial evidence');
    }
    if (totalCount === null) totalCount = response.total_count;
    else if (response.total_count !== totalCount) {
      throw new Error('window candidate run count changed during pagination; refusing unstable evidence');
    }
    runs.push(...pageRows);
    if (runs.length >= totalCount) {
      if (runs.length !== totalCount || new Set(runs.map((run) => run.id)).size !== runs.length) {
        throw new Error('window candidate run pagination returned duplicate or excess rows');
      }
      break;
    }
    if (pageRows.length === 0) {
      throw new Error('window candidate run pagination ended before total_count');
    }
    if (page === 10) {
      throw new Error('window candidate run pagination exceeded its proof bound');
    }
  }
  const relevantRuns = runs.filter((run) => {
    const created = timeMs(run.created_at, `run ${run.id} creation`);
    const updated = timeMs(run.updated_at, `run ${run.id} update`);
    return created < endMs && (run.status !== 'completed' || updated > startMs);
  });
  return jobsForRuns(relevantRuns, repository, requestJson, env);
}

function validateEnv(env) {
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) throw new Error('GITHUB_RUN_ID is missing or malformed');
  if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('GITHUB_REPOSITORY is missing or malformed');
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required');
}

export async function inspectCohort({
  env = process.env,
  requestJson = githubJson,
  collectJobs = collectActiveJobs,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  attempts = 24,
} = {}) {
  const targetSha = validateTargetSha(env.COWRITE_TARGET_SHA);
  const cargoBuildJobs = validateCargoBuildJobs(env.COWRITE_CARGO_BUILD_JOBS);
  validateEnv(env);
  if (!env.RUNNER_NAME) throw new Error('RUNNER_NAME is required');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const jobs = await collectJobs({
      repository: env.GITHUB_REPOSITORY,
      currentRunId: env.GITHUB_RUN_ID,
      requestJson,
      env,
    });
    try {
      return {
        ...validateCohort({
          parallelism: env.COWRITE_PARALLELISM,
          currentRunnerName: env.RUNNER_NAME,
          ...jobs,
        }),
        targetSha,
        cargoBuildJobs,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await wait(5_000);
    }
  }
  throw lastError ?? new Error('benchmark cohort validation exhausted without evidence');
}

export async function inspectWindow({
  env = process.env,
  requestJson = githubJson,
  collectJobs = collectWindowJobs,
} = {}) {
  validateEnv(env);
  const allJobs = await collectJobs({
    repository: env.GITHUB_REPOSITORY,
    startedAt: env.COWRITE_BENCHMARK_STARTED_AT,
    endedAt: env.COWRITE_BENCHMARK_ENDED_AT,
    requestJson,
    env,
  });
  return validateWindow({
    parallelism: env.COWRITE_PARALLELISM,
    currentRunId: env.GITHUB_RUN_ID,
    startedAt: env.COWRITE_BENCHMARK_STARTED_AT,
    endedAt: env.COWRITE_BENCHMARK_ENDED_AT,
    allJobs,
  });
}

async function main() {
  const command = process.argv[2];
  if (command === 'start') {
    const cohort = await inspectCohort();
    if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
    appendFileSync(process.env.GITHUB_ENV, `COWRITE_BENCHMARK_STARTED_AT=${cohort.startedAt}\n`);
    const markdown = [
      '## Windows contention cohort',
      '',
      `- Target SHA: \`${cohort.targetSha}\``,
      `- Cargo build jobs: ${cohort.cargoBuildJobs}`,
      `- Runner ids: ${cohort.runnerIds.join(', ')}`,
      `- Runner names: ${cohort.runnerNames.join(', ')}`,
      `- Window start: ${cohort.startedAt}`,
      '',
    ].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    else process.stdout.write(markdown);
    return;
  }
  if (command === 'finish') {
    const result = await inspectWindow();
    const markdown = `## Windows contention window\n\nValidated ${result.benchmarkJobs} benchmark job(s) with no unrelated Windows overlap.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    else process.stdout.write(markdown);
    return;
  }
  throw new Error('usage: node scripts/windows-contention-cohort.mjs <start|finish>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
