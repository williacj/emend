// ABOUTME: A dedicated D23 driver spawns the deterministic permission provider through production argv.
// ABOUTME: Browser routing substitutes only the HTTP address; every handler and event stays real.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

export async function permissionDriver(page) {
  await buildPermissionProvider();
  const binary = (name) =>
    resolve("src-tauri/target/debug", name + (process.platform === "win32" ? ".exe" : ""));
  const child = spawn(binary("test-driver"), ["0"], {
    env: {
      ...process.env,
      COWRITE_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN: "1",
      COWRITE_CLAUDE_BIN: binary("permission-provider"),
      COWRITE_COPILOT_BIN: "cowrite-test-no-copilot-installed",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let timer;
  try {
    const url = await new Promise((resolveUrl, reject) => {
      timer = setTimeout(() => reject(new Error(`permission driver startup: ${stderr}`)), 10_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`permission driver exited ${code}: ${stderr}`)));
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const found = stderr.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) resolveUrl(found[0]);
      });
    });
    clearTimeout(timer);
    const post = async (command, args = {}) => {
      const response = await fetch(`${url}/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(8_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`${command}: ${JSON.stringify(body)}`);
      return body;
    };
    const configuredDriver = process.env.COWRITE_E2E_TEST_DRIVER_URL;
    if (!configuredDriver) throw new Error("COWRITE_E2E_TEST_DRIVER_URL is not configured");
    await page.route(`${configuredDriver}/**`, (route) =>
      route.continue({ url: `${url}${new URL(route.request().url()).pathname}` }),
    );
    return {
      post,
      async close() {
        try {
          await post("close_project");
        } finally {
          await stop(child);
        }
      },
    };
  } catch (error) {
    clearTimeout(timer);
    await stop(child);
    throw error;
  }
}

async function buildPermissionProvider() {
  const child = spawn(
    "cargo",
    [
      "build",
      "--quiet",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "-p",
      "fake-agent",
      "--bin",
      "permission-provider",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768);
  });
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`permission provider build failed (${signal ?? code}): ${stderr}`);
  }
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await closed; } finally { clearTimeout(timer); }
}
