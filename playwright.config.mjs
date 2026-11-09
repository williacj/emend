// ABOUTME: Playwright configuration for Emend's e2e walking skeleton (P2a-2, D23, test-plan §4).
// ABOUTME: Drives the real frontend served by Vite dev mode; document commands route through the
// ABOUTME: D23 headless test driver (crates/test-driver) rather than the Tauri IPC bridge, since a
// ABOUTME: plain Chromium page has no Tauri webview runtime — no application logic is mocked, only
// ABOUTME: the transport is substituted (see src/editor/ipc.ts).
import { defineConfig, devices } from "@playwright/test";
import { allocateLoopbackPorts } from "./scripts/e2e-ports.mjs";

const VITE_PORT_ENV = "EMEND_E2E_VITE_PORT";
const TEST_DRIVER_PORT_ENV = "EMEND_E2E_TEST_DRIVER_PORT";

function configuredPort(name) {
  const value = process.env[name];
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return port;
}

let VITE_PORT = configuredPort(VITE_PORT_ENV);
let TEST_DRIVER_PORT = configuredPort(TEST_DRIVER_PORT_ENV);
if ((VITE_PORT === null) !== (TEST_DRIVER_PORT === null)) {
  throw new Error(`${VITE_PORT_ENV} and ${TEST_DRIVER_PORT_ENV} must be set together`);
}
if (VITE_PORT === null && TEST_DRIVER_PORT === null) {
  [VITE_PORT, TEST_DRIVER_PORT] = await allocateLoopbackPorts(2);
  // Playwright re-evaluates this config in worker processes. These internal values keep every
  // evaluation on the pair allocated by the run's first config load; they are not fixed defaults.
  process.env[VITE_PORT_ENV] = String(VITE_PORT);
  process.env[TEST_DRIVER_PORT_ENV] = String(TEST_DRIVER_PORT);
}
if (VITE_PORT === TEST_DRIVER_PORT) {
  throw new Error("Vite and the test driver must use distinct e2e ports");
}
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;
const TEST_DRIVER_URL = `http://127.0.0.1:${TEST_DRIVER_PORT}`;
process.env.EMEND_E2E_TEST_DRIVER_URL = TEST_DRIVER_URL;

// #1814: when set, the run also writes a JSON results document for the test-matrix execution
// gate (test-plan §9). Playwright 1.61 has no env var for the JSON reporter's output path, and
// two reporters cannot share stdout, so the pair is composed here. Unset — every local run and
// every `npm run test:e2e` — leaves `reporter` undefined and the default reporter in place.
const E2E_RESULTS_FILE = process.env.EMEND_E2E_RESULTS_FILE;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  reporter: E2E_RESULTS_FILE ? [["list"], ["json", { outputFile: E2E_RESULTS_FILE }]] : undefined,
  // Every assertion in this suite is condition-based, never a fixed sleep (test-plan §7) — the
  // default 5s `expect()`/`.poll()` ceiling reproducibly falls short of that promise under ordinary
  // ambient machine load (not synthetic stress): re-opening a document mid-scenario missed its own
  // `.cm-content:visible` wait at the stock 5000ms with nothing else wrong, on a box at load average
  // ~9–11 — the same concurrent development load observed in #1317. Doubling it tolerates that
  // load without hiding a genuine stall, which would still fail, just 5s later (#1317).
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  webServer: [
    {
      // The real frontend, unmodified — dev mode is the D23 "dev-mode ... surface" hook, not a
      // separate test build.
      command: `npm run dev -- --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
      env: { VITE_TEST_DRIVER_URL: TEST_DRIVER_URL },
      url: VITE_URL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The headless test driver (tech-design §3.7) — a loopback HTTP surface over the exact
      // backend command functions the Tauri IPC layer calls (`crates/test-driver`).
      command: `cargo run --quiet --manifest-path src-tauri/Cargo.toml -p test-driver -- ${TEST_DRIVER_PORT}`,
      env: {
        ...process.env,
        // A dev machine running this suite may itself have `claude`/`copilot` on PATH (any
        // Emend dev box does) — redirect `agent::providers`' real PATH lookup to binary names
        // guaranteed absent everywhere, so `detect_providers` deterministically reports zero
        // providers without touching the real PATH or mocking the detection logic (P2a-22,
        // NI-provider-detect; CLAUDE.md: never mock in e2e).
        EMEND_CLAUDE_BIN: "cowrite-test-no-claude-installed",
        EMEND_COPILOT_BIN: "cowrite-test-no-copilot-installed",
      },
      port: TEST_DRIVER_PORT,
      reuseExistingServer: false,
      // First run compiles the crate; can be slow on a cold cache.
      timeout: 120_000,
    },
  ],
  use: {
    baseURL: VITE_URL,
  },
  projects: [
    {
      name: "chromium",
      // This run owns one D23 test-driver process, whose single OpenProject slot mirrors one desktop
      // app instance. The per-project cap remains authoritative when a caller raises the global
      // worker budget with `--workers`, so fixture roots cannot replace one another (#1581).
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
