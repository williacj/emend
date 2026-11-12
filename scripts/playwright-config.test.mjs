// ABOUTME: Regression coverage for per-run Playwright server ports and fail-closed server startup.
// ABOUTME: Evaluates the real config in isolated processes so independent e2e runs cannot share it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { allocateLoopbackPorts } from "./e2e-ports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = `
  const { createServer } = await import("node:net");
  const listen = (port) => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(server));
  });
  const close = (server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const config = (await import("./playwright.config.mjs")).default;
  const [vite, driver] = config.webServer;
  const reloaded = (await import("./playwright.config.mjs?worker-reload")).default;
  const [reloadedVite, reloadedDriver] = reloaded.webServer;
  let clientRequestURL;
  globalThis.fetch = async (url) => {
    clientRequestURL = url;
    return { ok: true, json: async () => ({}) };
  };
  const { post } = await import("./e2e/support/testDriverClient.mjs");
  await post("probe", {});
  const occupied = await Promise.all([
    listen(Number(new URL(vite.url).port)),
    listen(driver.port),
  ]);
  delete process.env.EMEND_E2E_VITE_PORT;
  delete process.env.EMEND_E2E_TEST_DRIVER_PORT;
  delete process.env.EMEND_E2E_TEST_DRIVER_URL;
  const independent = (await import("./playwright.config.mjs?independent-run")).default;
  const [independentVite, independentDriver] = independent.webServer;
  await Promise.all(occupied.map(close));
  process.stdout.write(JSON.stringify({
    baseURL: config.use.baseURL,
    clientRequestURL,
    driverCommand: driver.command,
    driverPort: driver.port,
    driverReuse: driver.reuseExistingServer,
    independentDriverPort: independentDriver.port,
    independentVitePort: Number(new URL(independentVite.url).port),
    reloadedDriverPort: reloadedDriver.port,
    reloadedViteURL: reloadedVite.url,
    viteCommand: vite.command,
    viteDriverURL: vite.env?.VITE_TEST_DRIVER_URL,
    vitePort: Number(new URL(vite.url).port),
    viteURL: vite.url,
    viteReuse: vite.reuseExistingServer,
  }));
`;

function inspectConfig() {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the allocator returns distinct OS-assigned ports for one e2e run (#1389)", async () => {
  const [vitePort, driverPort] = await allocateLoopbackPorts(2);

  assert.notEqual(vitePort, driverPort);
});

test("an independent config allocates around another run's occupied port pair (#1389)", () => {
  const config = inspectConfig();

  assert.notDeepEqual(
    [config.vitePort, config.driverPort],
    [config.independentVitePort, config.independentDriverPort],
  );
});

test("the allocated ports feed every consumer and both servers refuse foreign reuse (#1389)", () => {
  const config = inspectConfig();
  const viteURL = `http://127.0.0.1:${config.vitePort}`;
  const driverURL = `http://127.0.0.1:${config.driverPort}`;

  assert.equal(config.baseURL, viteURL);
  assert.equal(config.viteURL, viteURL);
  assert.equal(config.reloadedViteURL, viteURL);
  assert.equal(config.reloadedDriverPort, config.driverPort);
  assert.equal(config.viteDriverURL, driverURL);
  assert.equal(config.clientRequestURL, `${driverURL}/probe`);
  assert.match(config.viteCommand, /(?:^|\s)--strictPort(?:\s|$)/);
  assert.match(config.viteCommand, new RegExp(`(?:^|\\s)--port ${config.vitePort}(?:\\s|$)`));
  assert.match(config.driverCommand, new RegExp(`(?:^|\\s)${config.driverPort}(?:\\s|$)`));
  assert.equal(config.viteReuse, false);
  assert.equal(config.driverReuse, false);
});

/** The resolved config's #72 diagnostics wiring, evaluated with `diagnosticsDir` set or unset. */
function inspectDiagnostics(diagnosticsDir) {
  const env = { ...process.env };
  delete env.EMEND_E2E_VITE_PORT;
  delete env.EMEND_E2E_TEST_DRIVER_PORT;
  delete env.EMEND_E2E_TEST_DRIVER_URL;
  delete env.EMEND_E2E_DIAGNOSTICS_DIR;
  if (diagnosticsDir !== undefined) env.EMEND_E2E_DIAGNOSTICS_DIR = diagnosticsDir;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const config = (await import("./playwright.config.mjs")).default;
       const driver = config.webServer[1];
       process.stdout.write(JSON.stringify({
         driverPort: driver.port,
         driverTrace: driver.env.EMEND_TEST_DRIVER_TRACE ?? null,
         trace: config.use.trace ?? null,
       }));`,
    ],
    { cwd: repoRoot, encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a diagnostics directory gives the driver a per-run trace file and keeps failed tests' traces (#72)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emend-e2e-diagnostics-"));
  try {
    const diagnostics = path.join(dir, "not-yet-created");
    const config = inspectDiagnostics(diagnostics);

    assert.equal(
      config.driverTrace,
      path.join(diagnostics, `test-driver-trace-${config.driverPort}.jsonl`),
    );
    assert.ok(existsSync(diagnostics), "the driver can only create its file in an existing directory");
    assert.equal(config.trace?.mode, "retain-on-failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a diagnostics directory the driver keeps no trace and Playwright records none (#72)", () => {
  const config = inspectDiagnostics(undefined);

  assert.equal(config.driverTrace, null);
  assert.ok(config.trace === null || config.trace === "off", JSON.stringify(config.trace));
});
