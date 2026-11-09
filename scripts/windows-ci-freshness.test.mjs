// ABOUTME: Tests the fail-closed pull-request freshness check used before expensive Windows suites.
// ABOUTME: Covers current, obsolete, dispatch, malformed, and API-failure decisions without network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFreshness, evaluateFreshness, renderFreshnessSummary } from './windows-ci-freshness.mjs';

test('evaluateFreshness runs current pull-request revisions', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(evaluateFreshness({ eventName: 'pull_request', eventHead: sha, currentHead: sha }), {
    runExpensive: true,
    reason: 'current',
    eventHead: sha,
    currentHead: sha,
  });
});

test('evaluateFreshness skips an obsolete queued pull-request revision', () => {
  const eventHead = 'a'.repeat(40);
  const currentHead = 'b'.repeat(40);
  assert.deepEqual(evaluateFreshness({ eventName: 'pull_request', eventHead, currentHead }), {
    runExpensive: false,
    reason: 'obsolete',
    eventHead,
    currentHead,
  });
});

test('obsolete summary names both validated head SHAs (#980 review)', () => {
  const eventHead = 'a'.repeat(40);
  const currentHead = 'b'.repeat(40);
  const summary = renderFreshnessSummary({ runExpensive: false, reason: 'obsolete', eventHead, currentHead });
  assert.ok(summary.includes(`Event head: \`${eventHead}\``));
  assert.ok(summary.includes(`Current head: \`${currentHead}\``));
});

test('evaluateFreshness runs workflow dispatches without requiring pull-request metadata', () => {
  assert.deepEqual(evaluateFreshness({ eventName: 'workflow_dispatch' }), {
    runExpensive: true,
    reason: 'non-pull-request',
  });
});

test('evaluateFreshness throws on missing or malformed pull-request heads', () => {
  assert.throws(() => evaluateFreshness({ eventName: 'pull_request', eventHead: '', currentHead: 'def' }));
  assert.throws(() => evaluateFreshness({ eventName: 'pull_request', eventHead: 'abc', currentHead: null }));
});

test('checkFreshness fails closed into the full suite when the API read fails', async () => {
  const warnings = [];
  const result = await checkFreshness({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      COWRITE_EVENT_HEAD_SHA: 'a'.repeat(40),
      COWRITE_PR_NUMBER: '42',
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'secret',
    },
    requestJson: async () => { throw new Error('offline'); },
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(result, { runExpensive: true, reason: 'uncertain' });
  assert.match(warnings[0], /offline/);
});
