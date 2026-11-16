// ABOUTME: Chromium launch options for the e2e suite: on Windows, turns off Chromium's TCP port randomization (#72).
// ABOUTME: Merges that feature into Playwright's own --disable-features list, read at runtime, so it passes one switch.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// #72's measurement (PR #129, run 43794439146): on hosted Windows, Chromium's `TcpPortRandomizationWin`
// sets SO_RANDOMIZE_PORT before each connect, and Windows sometimes refuses such a connect with
// WSAENOBUFS. The page sees `net::ERR_NO_BUFFER_SPACE` and the app reports "Failed to fetch". Across
// 48 full e2e suites per arm, the default arm failed 7 runs for this cause and the feature-off arm none.
//
// Playwright already passes `--disable-features=<its list>`, and Chromium keeps only the last copy of
// a switch, so a second `--disable-features=TcpPortRandomizationWin` would silently re-enable every
// feature Playwright disables. Playwright exposes its list through no API, so it is read from its
// bundle here. Any doubt about that read fails the config load: launching with a switch that drops
// Playwright's list is worse than not launching.
const EXTRA_DISABLED_FEATURES = ["TcpPortRandomizationWin"];

const LIST_PATTERN = /\bdisabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/;
const SWITCH_SOURCE = '"--disable-features=" + disabledFeatures.join(",")';

function fail(cause) {
  throw new Error(`#72 e2e Chromium launch options: ${cause}`);
}

/** Reads the `playwright-core` that `@playwright/test` itself loads, following its dependency chain. */
function readInstalledPlaywrightSource() {
  const testPackage = createRequire(import.meta.url).resolve("@playwright/test/package.json");
  const playwrightPackage = createRequire(testPackage).resolve("playwright/package.json");
  const corePackage = createRequire(playwrightPackage).resolve("playwright-core/package.json");
  return readFileSync(path.join(path.dirname(corePackage), "lib", "coreBundle.js"), "utf8");
}

/** The feature names Playwright's `--disable-features` switch carries, parsed from its source. */
function playwrightDisabledFeatures(source) {
  const match = source.match(LIST_PATTERN);
  if (!match) fail("Playwright's source no longer holds a `disabledFeatures = [...].filter(Boolean)` list");
  if (!source.includes(SWITCH_SOURCE)) {
    fail(`Playwright no longer builds its switch as ${SWITCH_SOURCE}, so the list read may not be what it passes`);
  }
  const names = [];
  for (const line of match[1].split("\n")) {
    const entry = line.trim();
    if (entry === "" || entry.startsWith("//")) continue;
    const literal = entry.match(/^"([A-Za-z0-9_]+)",?$/);
    if (!literal) fail(`a disabledFeatures entry is not a plain string, so the list cannot be read whole: ${entry}`);
    names.push(literal[1]);
  }
  if (names.length === 0) fail("Playwright's disabledFeatures list is empty");
  return names;
}

/**
 * Playwright `launchOptions` for the e2e Chromium. On Windows, Playwright's own `--disable-features`
 * switch is dropped through `ignoreDefaultArgs` and one merged switch takes its place. Elsewhere there
 * are no options, and Playwright's source is never read.
 */
export function chromiumLaunchOptions({
  platform = process.platform,
  readPlaywrightSource = readInstalledPlaywrightSource,
} = {}) {
  if (platform !== "win32") return {};
  let source;
  try {
    source = readPlaywrightSource();
  } catch (error) {
    fail(`cannot read Playwright's coreBundle.js to find its --disable-features list: ${error.message}`);
  }
  const playwrightNames = playwrightDisabledFeatures(source);
  const merged = [...playwrightNames, ...EXTRA_DISABLED_FEATURES.filter((n) => !playwrightNames.includes(n))];
  return {
    ignoreDefaultArgs: [`--disable-features=${playwrightNames.join(",")}`],
    args: [`--disable-features=${merged.join(",")}`],
  };
}
