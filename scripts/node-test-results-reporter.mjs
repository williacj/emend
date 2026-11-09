// ABOUTME: node:test reporter that appends every finished test/suite name as JSONL execution evidence.
// ABOUTME: Feeds the `node` kind of check-test-matrix.mjs's --artifacts execution gate (test-plan §9, #1814).

import { appendFileSync } from 'node:fs';

/**
 * Where to append. Unset means "not collecting", so an ordinary local tooling
 * run can carry this reporter without writing anything.
 */
export const RESULTS_PATH_ENV = 'EMEND_TEST_RESULTS_FILE';

/**
 * One JSONL line per finished test or suite: `pass`/`fail` mean the body ran, `skip` means it
 * did not. A skipped test is written out rather than dropped so the artifact records what the
 * run saw, and the reader decides — collapsing skip into pass is how a `describe.skip` would
 * read as coverage.
 *
 * Suites are emitted alongside leaf tests (node:test reports a `describe` block with its own
 * `test:pass`), because `docs/test-matrix.md` names `describe(...)` titles as freely as
 * `test(...)` ones. That, and treating `todo` as a skip, is deliberately a different predicate
 * from the timing reporter's — that one measures durations and so keeps only `nesting === 0`.
 */
export function resultLine(event) {
  if (event?.type !== 'test:pass' && event?.type !== 'test:fail') return null;
  const { data } = event;
  if (typeof data?.name !== 'string' || data.name === '') return null;
  const status = data.skip || data.todo ? 'skip' : event.type === 'test:pass' ? 'pass' : 'fail';
  return JSON.stringify({ name: data.name, status, file: data.file ?? null });
}

/**
 * The evidence sink, separated from the reporter so a reporter that is ALREADY attached can
 * record execution without a second one being attached beside it.
 *
 * That separation is load-bearing, not tidiness: node:test attaches its own `end` listeners to
 * the shared `TestsStream` per reporter, and a THIRD reporter of any kind — including node's own
 * built-in `dot` — crosses the default `MaxListeners` of 10 and prints
 * `MaxListenersExceededWarning: Possible EventEmitter memory leak detected`. The count is fixed
 * and bounded, so it is not a leak, but it is a false alarm in a required job's log and it cost
 * one #1814 investigation real time. A caller with two reporters can record evidence
 * through this recorder without adding a third.
 *
 * `record()` is a no-op when the environment names no results file; `flush()` appends rather
 * than truncates, so separate `node --test` invocations can share a results artifact.
 */
export function createResultsRecorder({ env = process.env, append = appendFileSync } = {}) {
  const path = env[RESULTS_PATH_ENV];
  const batch = [];
  return {
    collecting: Boolean(path),
    record(event) {
      if (!path) return;
      const line = resultLine(event);
      if (line) batch.push(line);
    },
    flush() {
      if (!path || batch.length === 0) return 0;
      append(path, `${batch.join('\n')}\n`);
      const written = batch.length;
      batch.length = 0;
      return written;
    },
  };
}

/**
 * The standalone reporter for `test:scripts:ci`. It yields nothing: its output is
 * the results file, so its destination stream
 * stays empty and never competes with the human-readable reporter beside it.
 */
export default async function* resultsReporter(source) {
  const recorder = createResultsRecorder();
  for await (const event of source) recorder.record(event);
  recorder.flush();
}
