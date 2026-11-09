// ABOUTME: Detects obsolete queued pull-request revisions before the Windows runner starts expensive suites.
// ABOUTME: Treats every missing, malformed, or unavailable GitHub answer as current so uncertainty runs tests.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function evaluateFreshness({ eventName, eventHead, currentHead }) {
  if (eventName !== 'pull_request') return { runExpensive: true, reason: 'non-pull-request' };
  if (!SHA_PATTERN.test(eventHead ?? '') || !SHA_PATTERN.test(currentHead ?? '')) {
    throw new Error('pull-request head response is missing or malformed');
  }
  return eventHead === currentHead
    ? { runExpensive: true, reason: 'current', eventHead, currentHead }
    : { runExpensive: false, reason: 'obsolete', eventHead, currentHead };
}

export function renderFreshnessSummary({ eventHead, currentHead }) {
  return [
    '## Obsolete Windows revision',
    '',
    'This queued revision is no longer the pull request head; expensive suites were skipped.',
    '',
    `- Event head: \`${eventHead}\``,
    `- Current head: \`${currentHead}\``,
    '',
  ].join('\n');
}

async function githubJson(path, env = process.env) {
  const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'cowrite-windows-ci-freshness',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

export async function checkFreshness({
  env = process.env,
  requestJson = githubJson,
  warn = (message) => console.warn(message),
} = {}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    return evaluateFreshness({ eventName: env.GITHUB_EVENT_NAME });
  }

  try {
    if (!/^\d+$/.test(env.COWRITE_PR_NUMBER ?? '')) throw new Error('pull-request number is missing or malformed');
    if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('repository is missing or malformed');
    if (!env.GH_TOKEN) throw new Error('GH_TOKEN is missing');
    const response = await requestJson(
      `/repos/${env.GITHUB_REPOSITORY}/pulls/${env.COWRITE_PR_NUMBER}`,
      env,
    );
    return evaluateFreshness({
      eventName: env.GITHUB_EVENT_NAME,
      eventHead: env.COWRITE_EVENT_HEAD_SHA,
      currentHead: response.head?.sha,
    });
  } catch (error) {
    warn(`revision freshness unavailable; running the full suite: ${error.message}`);
    return { runExpensive: true, reason: 'uncertain' };
  }
}

export async function main(env = process.env) {
  const result = await checkFreshness({ env });
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(env.GITHUB_OUTPUT, `run_expensive=${result.runExpensive}\nreason=${result.reason}\n`);
  if (!result.runExpensive && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, renderFreshnessSummary(result));
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
