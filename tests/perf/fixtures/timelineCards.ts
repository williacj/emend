// ABOUTME: Fixture generator for the timeline virtualization perf benchmark (test-plan §6, "5,000
// ABOUTME: cards scrolls jank-free") — a stream of plain chat-message cards, the cheapest realistic
// ABOUTME: card kind, so the benchmark measures VirtualList's own windowing cost, not a particular
// ABOUTME: card renderer's cost.
import { createChatMessageCard, type TimelineCard } from "../../../src/timeline/types";

/**
 * Builds `count` `ChatMessageCard`s alternating user/agent authorship, each with a distinct,
 * greppable body — the same shape `TimelinePanel.test.tsx`'s own 5,000-card fixture uses (mirrored
 * here rather than imported so this perf rig has no dependency on a non-perf test file). A fixed
 * timestamp and explicit ids keep every run of the benchmark byte-identical, matching
 * `buildLargeMarkdownDoc`'s own determinism.
 */
export function buildTimelineCards(count: number): TimelineCard[] {
  return Array.from({ length: count }, (_, i) =>
    createChatMessageCard(i % 2 === 0 ? "user" : "agent", `message ${i}`, {
      id: `card-${i}`,
      timestamp: "2026-07-15T00:00:00.000Z",
    }),
  );
}
