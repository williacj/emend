// ABOUTME: Summarizes CPU and disk samples captured during Windows runner contention benchmarks.
// ABOUTME: Emits comparable per-slot evidence while surfacing malformed or unavailable samples.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distribution } from './windows-ci-timing.mjs';

function finiteMetric(value) {
  return Number.isFinite(value) && value >= 0;
}

export function parseSamples(text) {
  const samples = [];
  const errors = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.error) {
        errors.push(String(row.error));
        continue;
      }
      if (!Number.isFinite(Date.parse(row.timestamp))
        || !finiteMetric(row.cpuPercent)
        || !finiteMetric(row.diskQueueLength)
        || !finiteMetric(row.diskPercent)) {
        errors.push(`invalid metric sample: ${line}`);
        continue;
      }
      samples.push({
        timestamp: row.timestamp,
        cpuPercent: row.cpuPercent,
        diskQueueLength: row.diskQueueLength,
        diskPercent: row.diskPercent,
      });
    } catch {
      errors.push(`malformed JSON sample: ${line}`);
    }
  }
  return { samples, errors };
}

export function validateSampleSet({ samples, errors, startedAt, endedAt }) {
  if (!samples.length) throw new Error('host sampler produced zero valid samples');
  if (errors.length) throw new Error(`host sampler reported ${errors.length} error(s): ${errors.join('; ')}`);
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('host sampler window is missing or malformed');
  }
  const timestamps = samples.map((sample) => Date.parse(sample.timestamp)).sort((a, b) => a - b);
  if (timestamps[0] - startMs > 10_000 || endMs - timestamps.at(-1) > 10_000) {
    throw new Error('host sampler coverage does not reach both ends of the measured window');
  }
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] - timestamps[index - 1] > 15_000) {
      throw new Error('host sampler contains a sample gap longer than 15 seconds');
    }
  }
  const expectedSamples = Math.max(2, Math.floor((endMs - startMs) / 5_000));
  const requiredSamples = Math.ceil(expectedSamples * 0.8);
  if (samples.length < requiredSamples) {
    throw new Error(`host sampler coverage is ${samples.length}/${expectedSamples}; at least 80% is required`);
  }
}

export function summarizeSamples(samples) {
  return {
    cpu: distribution(samples.map((sample) => sample.cpuPercent)),
    diskQueue: distribution(samples.map((sample) => sample.diskQueueLength)),
    diskBusy: distribution(samples.map((sample) => sample.diskPercent)),
  };
}

function metricRow(label, stats, suffix = '') {
  if (!stats) return `| ${label} | 0 | — | — | — |`;
  const render = (value) => `${value}${suffix}`;
  return `| ${label} | ${stats.count} | ${render(stats.medianMs)} | ${render(stats.p90Ms)} | ${render(stats.maxMs)} |`;
}

export function renderSampleSummary({
  slot,
  parallelism,
  cargoBuildJobs,
  runnerName,
  workspace,
  samples,
  errors,
}) {
  const summary = summarizeSamples(samples);
  return [
    `## Windows host contention: ${slot}`,
    '',
    '| Context | Value |',
    '| --- | --- |',
    `| Parallelism | ${parallelism} |`,
    `| Cargo build jobs | ${cargoBuildJobs} |`,
    `| Runner | ${runnerName || 'unknown'} |`,
    `| Workspace | \`${workspace || 'unknown'}\` |`,
    `| Sample errors | ${errors.length} |`,
    '',
    '| Metric | Samples | Median | P90 | Max |',
    '| --- | ---: | ---: | ---: | ---: |',
    metricRow('CPU busy', summary.cpu, '%'),
    metricRow('Disk queue length', summary.diskQueue),
    metricRow('Disk busy', summary.diskBusy, '%'),
    '',
    ...(errors.length ? ['### Sampler errors', '', ...errors.map((error) => `- ${error}`), ''] : []),
  ].join('\n');
}

export function publishSampleSummary(markdown, {
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  append = appendFileSync,
  write = (text) => process.stdout.write(text),
} = {}) {
  if (summaryPath) append(summaryPath, markdown);
  write(markdown);
}

function main() {
  const [samplePath, slot, parallelism, cargoBuildJobs] = process.argv.slice(2);
  if (!samplePath || !slot || !['one', 'two'].includes(parallelism)
    || (cargoBuildJobs !== 'uncapped' && !/^[1-9][0-9]*$/.test(cargoBuildJobs ?? ''))) {
    throw new Error('usage: node scripts/windows-host-sampler-report.mjs <samples.jsonl> <slot> <one|two> <uncapped|positive-integer>');
  }
  const parsed = parseSamples(readFileSync(samplePath, 'utf8'));
  const markdown = renderSampleSummary({
    ...parsed,
    slot,
    parallelism,
    cargoBuildJobs,
    runnerName: process.env.RUNNER_NAME,
    workspace: process.env.RUNNER_WORKSPACE,
  });
  publishSampleSummary(markdown);
  validateSampleSet({
    ...parsed,
    startedAt: process.env.COWRITE_SAMPLER_STARTED_AT,
    endedAt: process.env.COWRITE_SAMPLER_ENDED_AT,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
