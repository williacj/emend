// ABOUTME: Vitest configuration for frontend component/unit tests (`npm test`).
// ABOUTME: Scoped to `src/`/`tests/unit` (docs/test-matrix.md's `vitest` kind) — the node:test
// ABOUTME: tooling suites under `scripts/` run via their own package script, not this one.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
