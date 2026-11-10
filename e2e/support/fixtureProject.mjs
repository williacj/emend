// ABOUTME: Creates a throwaway project folder with one markdown file for the e2e walking
// ABOUTME: skeleton (test-plan §4) — a real directory on real disk, never a mocked filesystem.
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeProject } from "./testDriverClient.mjs";

// Playwright bounds most tests at 30 seconds (`playwright.config.mjs`); a few (#1317) carry a
// wider per-test/describe budget for measured, unrelated reasons. Each teardown step here is
// bounded well inside even the tightest 30s case, so a stalled teardown reports *which* await
// stalled instead of spending the whole bound and reporting only "Test timeout of 30000ms
// exceeded" (#1554). The sum leaves the failing test room to report, and no healthy step comes
// close: a whole teardown is milliseconds.
const CLEANUP_BUDGETS_MS = Object.freeze({
  closeProject: 8_000,
  pageClose: 5_000,
  removeDirectory: 5_000,
});
/** A step that completes this slowly is the same evidence one turn before it becomes a failure. */
const SLOW_STEP_MS = 1_000;
/** How many surviving directory entries a stalled removal names before summarizing the rest. */
const REPORTED_ENTRIES = 5;

/**
 * Awaits `work`, rejecting with `describeStall()` if it has not settled within `budgetMs`. The
 * timer never keeps a run alive: it is cleared as soon as either outcome arrives.
 */
async function bounded(work, budgetMs, describeStall) {
  const settled = Promise.resolve(work);
  // A rejection arriving after the budget already lost the race is still handled here, so a stalled
  // step cannot also surface as an unhandled rejection in an unrelated later test.
  settled.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      settled,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(describeStall())), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The entries still in `root`, naming what a stalled removal was unable to delete. */
function describeEntries(root) {
  try {
    const entries = readdirSync(root);
    if (entries.length === 0) return "(none)";
    const shown = entries.slice(0, REPORTED_ENTRIES).join(", ");
    return entries.length > REPORTED_ENTRIES ? `${shown} (${entries.length} total)` : shown;
  } catch (error) {
    return `unreadable (${error?.code ?? error?.message})`;
  }
}

/**
 * Removes the fixture tree, retrying the one race that is expected here and bounded by `budgetMs`.
 *
 * `ENOTEMPTY` means a writer that had already started put an entry back between a removal pass's
 * own readdir and its rmdir (#1383) — retried across event-loop turns so the writer can finish. Any
 * other error is this teardown's own failure and reaches the caller unchanged. Both the retry loop
 * and a single `rm` call that never settles are bounded, so neither can spin unobserved (#1554).
 */
async function removeDirectory(root, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  let lastCode = "none";
  const stalled = () =>
    `directory removal did not settle within ${budgetMs}ms after ${attempts} ` +
    `attempt${attempts === 1 ? "" : "s"}; ` +
    `last error ${lastCode}; remaining entries: ${describeEntries(root)}`;
  for (;;) {
    attempts += 1;
    try {
      // Each pass is bounded by what is left of the budget: `rm` retries this race internally too,
      // so a pass can spin inside one call and never come back to the loop's own deadline check.
      await bounded(
        rm(root, { recursive: true, force: true }),
        Math.max(deadline - Date.now(), 0),
        stalled,
      );
      return;
    } catch (error) {
      // The stall report carries no `code`, so it leaves by this same door, unretried.
      if (error?.code !== "ENOTEMPTY") throw error;
      lastCode = error.code;
      if (Date.now() >= deadline) throw new Error(stalled());
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/** Closes the page unless it is already closed, bounded so an unresponsive browser is reported. */
async function closePage(page, budgetMs) {
  if (page.isClosed()) return;
  await bounded(page.close(), budgetMs, () => `page.close did not settle within ${budgetMs}ms`);
}

/**
 * Runs one teardown step, recording what it cost. A failure names the step, its elapsed time, the
 * fixture root, and every step that had already completed — the evidence that says which of the
 * three awaits stalled (#1554).
 */
async function cleanupStep(completed, root, name, run) {
  const startedAt = Date.now();
  try {
    await run();
  } catch (error) {
    const context = completed.length === 0 ? "" : `; completed ${completed.join(", ")}`;
    throw new Error(
      `fixture cleanup failed at ${name} after ${Date.now() - startedAt}ms ` +
        `[root ${root}${context}]: ${error.message}`,
      { cause: error },
    );
  }
  const elapsed = Date.now() - startedAt;
  completed.push(`${name} in ${elapsed}ms`);
  if (elapsed >= SLOW_STEP_MS) {
    console.warn(`fixture cleanup: ${name} took ${elapsed}ms [root ${root}]`);
  }
}

/**
 * @param {string | NodeJS.ArrayBufferView} initialContent
 * @returns {{
 *   root: string,
 *   path: string,
 *   readSaved: (relPath?: string) => string,
 *   addFile: (relPath: string, content: string | NodeJS.ArrayBufferView) => string,
 *   removeFile: (relPath?: string) => void,
 *   overwrite: (content: string, relPath?: string) => void,
 *   cleanup: (
 *     page: { close: () => Promise<void>, isClosed: () => boolean },
 *     options?: { budgets?: Partial<typeof CLEANUP_BUDGETS_MS> },
 *   ) => Promise<void>,
 * }}
 */
export function createFixtureProject(initialContent) {
  const root = mkdtempSync(path.join(tmpdir(), "emend-e2e-"));
  const relPath = "notes.md";
  writeFileSync(path.join(root, relPath), initialContent);

  return {
    root,
    path: relPath,
    readSaved: (target = relPath) => readFileSync(path.join(root, target), "utf8"),
    // Adds a second (third, ...) file to the same project — P2a-6's multi-tab/session-restore
    // journeys need more than one document open at once.
    addFile: (target, content) => {
      writeFileSync(path.join(root, target), content);
      return target;
    },
    // Removes a fixture file after the project-files snapshot has observed it, so J2 can exercise
    // the real activation-raced-with-disappearance edge through D23 rather than mocking IPC.
    removeFile: (target = relPath) => unlinkSync(path.join(root, target)),
    // Overwrites an existing file's content directly on disk (default: the seeded doc) — a real
    // filesystem mutation standing in for "the user kept typing since the agent last read this"
    // (TD-7's own rust unit-test precedent, a mid-test `fs::write`), not a mock: nothing about the
    // app's own read/write path is touched, only the state it reads next.
    overwrite: (content, target = relPath) => writeFileSync(path.join(root, target), content),
    // Closes the backend project while the page is still live, then the page so no new frontend
    // write can start, then removes the tree — each step bounded and named, so a teardown that
    // stalls says which await stalled instead of exhausting Playwright's test timeout (#1554).
    cleanup: async (page, { budgets } = {}) => {
      const limits = { ...CLEANUP_BUDGETS_MS, ...budgets };
      const completed = [];
      const steps = [
        ["close_project", () => closeProject({ timeoutMs: limits.closeProject })],
        ["page.close", () => closePage(page, limits.pageClose)],
        ["directory removal", () => removeDirectory(root, limits.removeDirectory)],
      ];
      for (const [name, run] of steps) await cleanupStep(completed, root, name, run);
    },
  };
}
