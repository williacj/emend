// ABOUTME: Reports an isolation-canary run that was evicted from its concurrency group while pending.
// ABOUTME: Runs outside that run, because a run cancelled before any job exists cannot report itself.
import { fileURLToPath } from 'node:url';

const NOT_MEASURED_CHECK_NAME = 'Isolation canary (not measured: displaced)';

// A displaced run is cancelled while PENDING — the concurrency group evicts it before a job is ever
// created, so `GET /actions/runs/<id>/jobs` returns `total_count: 0`. That is what makes #1229's
// filed "option 3" unimplementable from inside the run: no job means no step, no `if: cancelled()`
// to hook, and no token-bearing context to call the API from. The verdict has to come from outside.
export function classifyCancelledRun({ conclusion, jobTotalCount }) {
  if (conclusion !== 'cancelled') {
    return { publish: false, cause: 'not-cancelled' };
  }
  if (jobTotalCount === 0) {
    return {
      publish: true,
      cause: 'displaced',
      summary:
        'NOT MEASURED: this canary run was displaced by a newer canary and cancelled before any job ' +
        'was created, so no isolation property was exercised on this revision. This is a ' +
        'concurrency-group outcome, not an isolation violation. The run produced no job and ' +
        'therefore could not report its own eviction from the inside.',
    };
  }
  // Cancelled while in progress is a different case, and an easy one to conflate: its jobs already
  // bind their own `cancelled` check-runs to this head, so the head is not bare and a second verdict
  // would only double-report it.
  if (typeof jobTotalCount === 'number' && jobTotalCount > 0) {
    return { publish: false, cause: 'cancelled-in-progress' };
  }
  // The run being cancelled is known from the event payload; only the CAUSE needed the API. This
  // observer exists because an absent verdict reads as green, so it must never resolve its own
  // uncertainty in the direction that leaves the head bare.
  return {
    publish: true,
    cause: 'undetermined',
    summary:
      'NOT MEASURED: this canary run was cancelled, and whether it was displaced while pending ' +
      'could not be determined because the run\'s job list could not be read. No isolation property ' +
      'is known to have been exercised on this revision.',
  };
}

async function githubJson(path, env = process.env, init = {}) {
  const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'cowrite-canary-eviction-observer',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

export async function reportCancelledRun({
  env = process.env,
  run,
  requestJson = githubJson,
  postJson = (path, body, e) => githubJson(path, e, { method: 'POST', body: JSON.stringify(body) }),
  warn = (message) => console.warn(message),
} = {}) {
  let jobTotalCount = null;
  if (run?.conclusion === 'cancelled') {
    try {
      const jobs = await requestJson(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/jobs`, env);
      jobTotalCount = typeof jobs?.total_count === 'number' ? jobs.total_count : null;
    } catch (error) {
      warn(`Could not read the displaced run's job list: ${error.message}`);
    }
  }

  const verdict = classifyCancelledRun({ conclusion: run?.conclusion, jobTotalCount });
  if (!verdict.publish) return { published: false, cause: verdict.cause };

  const body = {
    name: NOT_MEASURED_CHECK_NAME,
    head_sha: run.head_sha,
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'Isolation was not measured on this revision',
      summary: `${verdict.summary}\n\nDisplaced run: ${run.id}.`,
    },
  };

  try {
    await postJson(`/repos/${env.GITHUB_REPOSITORY}/check-runs`, body, env);
  } catch (error) {
    // Best-effort, exactly as inside the canary: a Checks refusal must not make the observer itself
    // the failing signal on someone's pull request.
    warn(`Could not publish the displaced-canary check-run: ${error.message}`);
    return { published: false, cause: verdict.cause };
  }
  return { published: true, cause: verdict.cause };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = JSON.parse(process.env.COWRITE_WORKFLOW_RUN ?? '{}');
  const result = await reportCancelledRun({ run });
  console.log(`displaced-canary observer: cause=${result.cause} published=${result.published}`);
}
