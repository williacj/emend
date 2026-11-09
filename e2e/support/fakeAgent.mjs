// ABOUTME: Spawns the compiled `fake-agent` binary (P0-6/P0-7, src-tauri/crates/fake-agent)
// ABOUTME: against a named scenario and collects its stream-JSON stdout — the e2e side of the
// ABOUTME: walking skeleton's "spawn a fake-agent scenario, verify handshake" acceptance step.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = path.resolve(HERE, "../../src-tauri");

/**
 * Runs `cargo run -p fake-agent -- --scenario <name> --pace all --validate` to completion and
 * resolves with its stdout parsed as one JSON stream event per line, in emission order.
 * Condition-based (resolves on the child's `close` event) — no fixed wait, no sleep.
 *
 * @param {string} scenarioName file under `crates/fake-agent/scenarios/`
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export function runFakeAgentScenario(scenarioName) {
  const scenarioPath = path.join(SRC_TAURI, "crates/fake-agent/scenarios", scenarioName);

  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        path.join(SRC_TAURI, "Cargo.toml"),
        "-p",
        "fake-agent",
        "--",
        "--scenario",
        scenarioPath,
        "--pace",
        "all",
        "--validate",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`fake-agent exited ${code}: ${stderr}`));
        return;
      }
      const events = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      resolve(events);
    });
  });
}
