// ABOUTME: MEASUREMENT ONLY (#72, never merged): Chromium launch args for arm B of the port-randomization measurement.
// ABOUTME: Merges extra --disable-features names with Playwright's own list, since Chromium keeps only the last switch.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Playwright passes its own `--disable-features=<list>` and appends user args after it. Chromium's
// command line keeps the last occurrence of a switch, so a bare user `--disable-features=X` would
// silently re-enable everything Playwright disables. Read Playwright's list and pass the union.
function playwrightDisabledFeatures() {
  const corePkg = require.resolve("playwright-core/package.json");
  const bundle = readFileSync(path.join(path.dirname(corePkg), "lib", "coreBundle.js"), "utf8");
  const match = bundle.match(/disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/);
  if (!match) throw new Error("measure-72: could not find Playwright's disabledFeatures list");
  const body = match[1]
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const names = [...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  if (names.length < 5) throw new Error(`measure-72: Playwright list looks wrong: ${names}`);
  return names;
}

export function measureChromiumArgs() {
  const extra = (process.env.EMEND_E2E_CHROMIUM_DISABLE_FEATURES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.length === 0) return [];
  return [`--disable-features=${[...playwrightDisabledFeatures(), ...extra].join(",")}`];
}
