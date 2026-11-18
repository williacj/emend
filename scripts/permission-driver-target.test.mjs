// ABOUTME: Pins that the e2e permission driver runs binaries from the directory cargo built them in.
// ABOUTME: Covers CARGO_TARGET_DIR set outside src-tauri/target and unset.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { builtBinary } from "../e2e/support/permissionDriver.mjs";

test("CARGO_TARGET_DIR outside src-tauri/target resolves both binaries there", () => {
  const env = { CARGO_TARGET_DIR: "/elsewhere/target" };
  assert.equal(builtBinary("test-driver", env, "linux"), resolve("/elsewhere/target/debug/test-driver"));
  assert.equal(
    builtBinary("permission-provider", env, "linux"),
    resolve("/elsewhere/target/debug/permission-provider"),
  );
});

test("unset CARGO_TARGET_DIR resolves both binaries under src-tauri/target/debug", () => {
  assert.equal(builtBinary("test-driver", {}, "linux"), resolve("src-tauri/target/debug/test-driver"));
  assert.equal(
    builtBinary("permission-provider", {}, "win32"),
    resolve("src-tauri/target/debug/permission-provider.exe"),
  );
});
