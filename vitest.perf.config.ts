// ABOUTME: Vitest configuration for perf benchmarks (`npm run test:perf`, test-plan §6) — a
// ABOUTME: dedicated config so `tests/perf/**` never runs under `npm test`'s CI-gating suite.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/perf/**/*.perf.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
