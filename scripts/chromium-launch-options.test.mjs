// ABOUTME: Regression coverage for the e2e Chromium launch options that disable TCP port randomization on Windows (#72).
// ABOUTME: Reads the argv Playwright really builds, by launching Node as the "browser" so it exits at once and logs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { chromiumLaunchOptions } from "../e2e/support/chromiumLaunchOptions.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The argv Playwright passes to the browser for these launch options. The executable is Node, which
 * rejects Chromium's switches and exits, so the launch fails at once and its error carries
 * Playwright's own `<launching>` log line. No browser needs to be installed.
 */
async function playwrightLaunchArgv(launchOptions = {}) {
  let message;
  try {
    const browser = await chromium.launch({
      ...launchOptions,
      executablePath: process.execPath,
      timeout: 30_000,
    });
    await browser.close();
  } catch (error) {
    message = error.message;
  }
  const line = message?.split("\n").find((l) => l.startsWith("<launching> "));
  assert.ok(line, `no <launching> line in the launch error:\n${message}`);
  // Chromium's switches contain no spaces. The per-launch profile directory differs on each run and
  // may contain spaces (a spaced temporary directory), so it is cut out up to the next switch.
  return line
    .slice("<launching> ".length + process.execPath.length + 1)
    .replace(/--user-data-dir=.*?(?= --|$)/, "")
    .split(" ")
    .filter((arg) => arg !== "");
}

function disableFeaturesSwitches(argv) {
  return argv.filter((arg) => arg.startsWith("--disable-features="));
}

function namesOf(featureSwitch) {
  return featureSwitch.slice("--disable-features=".length).split(",");
}

/** The resolved Playwright config's chromium launch options, with `process.platform` forced. */
function configLaunchOptions(platform) {
  const env = { ...process.env };
  delete env.EMEND_E2E_VITE_PORT;
  delete env.EMEND_E2E_TEST_DRIVER_PORT;
  delete env.EMEND_E2E_TEST_DRIVER_URL;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
       const config = (await import("./playwright.config.mjs")).default;
       const project = config.projects.find((p) => p.name === "chromium");
       process.stdout.write(JSON.stringify(project.use.launchOptions ?? {}));`,
    ],
    { cwd: repoRoot, encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("on Windows the e2e Chromium gets one disable-features switch holding Playwright's list and TcpPortRandomizationWin (#72)", async () => {
  const [playwrightSwitch] = disableFeaturesSwitches(await playwrightLaunchArgv());
  assert.ok(playwrightSwitch, "Playwright passes its own --disable-features by default");

  const argv = await playwrightLaunchArgv(configLaunchOptions("win32"));
  const switches = disableFeaturesSwitches(argv);

  assert.equal(switches.length, 1, switches.join("\n"));
  assert.deepEqual(
    new Set(namesOf(switches[0])),
    new Set([...namesOf(playwrightSwitch), "TcpPortRandomizationWin"]),
  );
});

test("on macOS and Linux the e2e Chromium launches with Playwright's default switches unchanged (#72)", async () => {
  const defaults = await playwrightLaunchArgv();
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(await playwrightLaunchArgv(configLaunchOptions(platform)), defaults, platform);
  }
});

test("the argv read holds when the temporary directory has spaces in its path (#72)", async () => {
  const spaced = mkdtempSync(path.join(os.tmpdir(), "emend spaced tmp "));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const defaults = await playwrightLaunchArgv();
  try {
    Object.assign(process.env, { TMPDIR: spaced, TEMP: spaced, TMP: spaced });
    assert.deepEqual(await playwrightLaunchArgv(), defaults);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(spaced, { recursive: true, force: true });
  }
});

test("off Windows the launch options never read Playwright's source (#72)", () => {
  const unreadable = () => {
    throw new Error("read off Windows");
  };
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(chromiumLaunchOptions({ platform, readPlaywrightSource: unreadable }), {});
  }
});

const listSource = (entries) => `
    disabledFeatures = [
      ${entries}
    ].filter(Boolean);
    chromiumSwitches = (options) => [
      "--disable-features=" + disabledFeatures.join(","),
    ];`;

const unreadableSources = [
  [
    "a missing Playwright bundle",
    () => {
      throw Object.assign(new Error("ENOENT: no such file, open 'coreBundle.js'"), { code: "ENOENT" });
    },
    /coreBundle\.js/,
  ],
  ["a bundle without the disabledFeatures list", () => "var unrelated = [];", /disabledFeatures/],
  ["an empty disabledFeatures list", () => listSource("// nothing"), /empty/],
  [
    "a list entry that is not a plain string",
    () => listSource(`"Translate",\n      process.platform === "win32" ? "Other" : ""`),
    /not a plain string/,
  ],
  [
    "a bundle that builds its switch another way",
    () => listSource(`"Translate"`).replace('"--disable-features=" + disabledFeatures.join(",")', "x"),
    /switch/,
  ],
];

test("on Windows an unreadable or empty Playwright list fails loudly instead of being dropped (#72)", () => {
  for (const [label, readPlaywrightSource, cause] of unreadableSources) {
    assert.throws(
      () => chromiumLaunchOptions({ platform: "win32", readPlaywrightSource }),
      (error) => /#72/.test(error.message) && cause.test(error.message),
      label,
    );
  }
});
