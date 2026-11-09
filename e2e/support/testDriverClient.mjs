// ABOUTME: Shared HTTP client for the D23 headless test driver (crates/test-driver) — one POST +
// ABOUTME: JSON round trip every driver-backed e2e helper (comments, document birth, ...) reuses
// ABOUTME: rather than each carrying its own copy (CLAUDE.md: never copy-paste — extract and import).
const TEST_DRIVER_URL = process.env.EMEND_E2E_TEST_DRIVER_URL;
if (!TEST_DRIVER_URL) {
  throw new Error("EMEND_E2E_TEST_DRIVER_URL must be set by playwright.config.mjs");
}

/**
 * POSTs `args` as JSON to the driver's `/<command>` route and returns the parsed JSON body. Throws
 * on any non-2xx response, carrying the body along so a failing call is diagnosable.
 *
 * `timeoutMs` aborts the request itself. The driver serves connections serially, so anything it is
 * slow to answer holds every later request behind it; a bounded caller then fails naming its own
 * command instead of consuming Playwright's whole test bound with no evidence (#1554).
 *
 * @param {string} command
 * @param {Record<string, unknown>} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function post(command, args, { timeoutMs } = {}) {
  try {
    const response = await fetch(`${TEST_DRIVER_URL}/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${command} failed: ${JSON.stringify(body)}`);
    return body;
  } catch (error) {
    if (timeoutMs !== undefined && error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${command} did not respond within ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

/**
 * Closes the driver's open project and resolves only after its backend resources are released.
 *
 * @param {{ timeoutMs?: number }} [options]
 */
export function closeProject(options) {
  return post("close_project", {}, options);
}
