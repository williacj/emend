// ABOUTME: Shared tooling helper — reads a package.json `scripts` map for scripts-side production
// ABOUTME: code and tests that need to resolve the repository's explicit npm commands.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

export function readPackageScripts(packageJsonPath = PACKAGE_JSON_PATH) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts;
}
