// ABOUTME: Proves an evicted isolation-canary run reports its own absence from outside the run.
// ABOUTME: Covers the pending-eviction case that has no job, and the fail-closed unknown case.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { classifyCancelledRun, reportCancelledRun } from './canary-eviction-observer.mjs';

const workflowUrl = new URL('../.github/workflows/canary-eviction-observer.yml', import.meta.url);

// A run displaced from a concurrency group is cancelled while PENDING — before any job is created.
// All eight of the 2026-08-07 cancellations return `total_count: 0` from /actions/runs/<id>/jobs,
// which is why #1229's filed "option 3" (have the displaced run emit its own check-run) cannot work:
// no job means no step, no `if: cancelled()` hook, and no token-bearing context inside the run.
test('a run cancelled before any job existed is a displacement, and reports as one (#1229)', () => {
  const verdict = classifyCancelledRun({ conclusion: 'cancelled', jobTotalCount: 0 });
  assert.equal(verdict.publish, true);
  assert.equal(verdict.cause, 'displaced');
  assert.match(verdict.summary, /displaced by a newer canary/);
  assert.match(verdict.summary, /no isolation property was exercised/);
});

// A run cancelled while IN PROGRESS is a different animal and is easy to mistake for the above:
// 30647987352 does show steps. Its jobs already bind their own `cancelled` check-runs to the head,
// so the head is not silently bare and a second verdict would only double-report it.
test('a run cancelled after its jobs started is left alone, since its jobs already report (#1229)', () => {
  const verdict = classifyCancelledRun({ conclusion: 'cancelled', jobTotalCount: 2 });
  assert.equal(verdict.publish, false);
  assert.equal(verdict.cause, 'cancelled-in-progress');
});

// The observer exists BECAUSE absent reads as green. It must never resolve its own uncertainty in
// the direction that leaves a head bare.
test('an unreadable job count publishes anyway rather than leaving the head bare (#1229)', () => {
  const verdict = classifyCancelledRun({ conclusion: 'cancelled', jobTotalCount: null });
  assert.equal(verdict.publish, true);
  assert.equal(verdict.cause, 'undetermined');
  assert.match(verdict.summary, /could not be determined/);
});

test("a run that was not cancelled is not the observer's business", () => {
  for (const conclusion of ['success', 'failure', 'skipped', 'neutral', 'timed_out', null]) {
    const verdict = classifyCancelledRun({ conclusion, jobTotalCount: 0 });
    assert.equal(verdict.publish, false, `conclusion ${conclusion} must not publish`);
    assert.equal(verdict.cause, 'not-cancelled');
  }
});

test("reportCancelledRun publishes one neutral check-run bound to the displaced run's head", async () => {
  const posted = [];
  const result = await reportCancelledRun({
    env: { GITHUB_REPOSITORY: 'williacj/cowrite', GH_TOKEN: 'x' },
    run: { id: 31199424948, conclusion: 'cancelled', head_sha: 'f'.repeat(40) },
    requestJson: async () => ({ total_count: 0 }),
    postJson: async (path, body) => {
      posted.push({ path, body });
      return {};
    },
  });

  assert.equal(result.published, true);
  assert.equal(result.cause, 'displaced');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, '/repos/williacj/cowrite/check-runs');
  assert.equal(posted[0].body.head_sha, 'f'.repeat(40));
  assert.equal(posted[0].body.conclusion, 'neutral');
  assert.equal(posted[0].body.status, 'completed');
  // The same "not measured" family as the in-run verdicts, so a reader learns one convention.
  assert.equal(posted[0].body.name, 'Isolation canary (not measured: displaced)');
  assert.match(posted[0].body.output.summary, /31199424948/);
});

// The jobs read only names the CAUSE. The run being cancelled is already known from the event
// payload, so a failed read must not cost the verdict — the same rule the in-run poller follows.
test('reportCancelledRun still publishes when the jobs read throws', async () => {
  const posted = [];
  const warnings = [];
  const result = await reportCancelledRun({
    env: { GITHUB_REPOSITORY: 'williacj/cowrite', GH_TOKEN: 'x' },
    run: { id: 7, conclusion: 'cancelled', head_sha: 'a'.repeat(40) },
    requestJson: async () => {
      throw new Error('GitHub API 503 for /actions/runs/7/jobs');
    },
    postJson: async (path, body) => {
      posted.push({ path, body });
      return {};
    },
    warn: (message) => warnings.push(message),
  });
  assert.match(warnings[0], /503/);

  assert.equal(result.published, true);
  assert.equal(result.cause, 'undetermined');
  assert.equal(posted.length, 1);
});

test('reportCancelledRun posts nothing for a run whose jobs already reported', async () => {
  const posted = [];
  const result = await reportCancelledRun({
    env: { GITHUB_REPOSITORY: 'williacj/cowrite', GH_TOKEN: 'x' },
    run: { id: 30647987352, conclusion: 'cancelled', head_sha: 'b'.repeat(40) },
    requestJson: async () => ({ total_count: 2 }),
    postJson: async (path, body) => {
      posted.push({ path, body });
      return {};
    },
  });

  assert.equal(result.published, false);
  assert.equal(posted.length, 0);
});

// Publishing is best-effort exactly as it is inside the canary: a Checks refusal (a fork PR's
// read-only token, say) must not turn the observer itself into a red check.
test('a Checks API refusal is reported but does not throw', async () => {
  const warnings = [];
  const result = await reportCancelledRun({
    env: { GITHUB_REPOSITORY: 'williacj/cowrite', GH_TOKEN: 'x' },
    run: { id: 9, conclusion: 'cancelled', head_sha: 'c'.repeat(40) },
    requestJson: async () => ({ total_count: 0 }),
    postJson: async () => {
      throw new Error('GitHub API 403 for /check-runs');
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.published, false);
  assert.equal(result.cause, 'displaced');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /403/);
});

test("the observer runs off the canary's completion, on a hosted runner, and never on the pool (#1229)", () => {
  const yaml = readFileSync(workflowUrl, 'utf8');
  // workflow_run is the only trigger that can see a run the displaced run itself could not report.
  assert.match(yaml, /workflow_run:\n\s+workflows:\n\s+- Windows runner isolation canary\n\s+types:\n\s+- completed\n/);
  // ubuntu-latest, deliberately: an observer that contended for the two Windows runners would be
  // competing with the very cohort whose starvation it exists to report. Asserted over the
  // `runs-on:` lines alone rather than the whole file — a `doesNotMatch` against the raw text is
  // tripped by the comment that explains this very choice, which is #1234's second-order trap.
  const runsOn = [...yaml.matchAll(/^\s*runs-on: (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(runsOn, ['ubuntu-latest'], 'the observer must never queue for the Windows pool');
  // Only cancelled runs are the observer's business; everything else already reported itself.
  assert.match(yaml, /if: \$\{\{ github\.event\.workflow_run\.conclusion == 'cancelled' \}\}/);
  assert.match(yaml, /checks: write/);
  assert.match(yaml, /actions: read/);
});

// An explicit top-level `permissions:` block sets every scope it does NOT name to `none`, and this
// repository is private, so omitting `contents` leaves `actions/checkout` unable to read the repo.
// The observer would then die on its first step, publish nothing, and leave the displaced head
// bare — the exact "absent reads as green" outcome this card exists to close, and self-concealing
// besides, because a `workflow_run` run reports against the default branch rather than against the
// pull request whose head went unreported. Asserted as a SET so a future scope added without
// thought cannot widen the token silently either.
test('the observer requests every scope it needs and no more, contents included (#1229)', () => {
  const yaml = readFileSync(workflowUrl, 'utf8');
  const block = yaml.match(/^permissions:\n((?:[ \t]+.*\n|\n)*)/m);
  assert.ok(block, 'the observer must declare its permissions explicitly');
  const scopes = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .sort();
  assert.deepEqual(scopes, ['actions: read', 'checks: write', 'contents: read']);
});

// A hard string coupling across two files: the observer watches the canary BY NAME. When the two
// stop agreeing the observer simply stops firing — silently, in the same absent-reads-as-green
// direction the card is built to eliminate — so the coupling is asserted from both sides rather
// than pinned as a literal in one of them.
test('the observer watches the canary workflow by its real name, checked against the canary itself (#1229)', () => {
  const observer = readFileSync(workflowUrl, 'utf8');
  const canary = readFileSync(
    new URL('../.github/workflows/windows-runner-isolation-canary.yml', import.meta.url),
    'utf8',
  );
  const canaryName = canary.match(/^name: (.+)$/m)?.[1].trim();
  assert.ok(canaryName, 'the canary workflow must declare a name to be watched by');
  const watched = observer
    .match(/^\s+workflows:\n((?:\s+- .*\n)+)/m)?.[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => line.length > 0);
  assert.deepEqual(watched, [canaryName], 'the watched name must track the canary workflow itself');
});
