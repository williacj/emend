// ABOUTME: Shared percentile helper for the test-plan §6 perf benchmarks (`structuralDecorations
// ABOUTME: ViewportPerf`, `timelineVirtualizationPerf`) — one statistic, not a copy per rig file.

/** The `p`th percentile of `samples` (nearest-rank method). */
export function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}
