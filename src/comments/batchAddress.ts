// ABOUTME: The batch-address trigger condition and J4's source/severity/review-pass filter set
// ABOUTME: (P2b-3a, FR-CMT-5/D8) — pure selection over threads; the transitions live in Rust.
import { isHeldByLiveRun, type CommentThread } from "./types";

/** The source value standing for "a human raised this", as opposed to a review skill. */
export const HUMAN_SOURCE = "human";

/**
 * J4's three filter dimensions (FR-CMT-5: "filterable by source, severity, review pass"). `null` on
 * a dimension means *unfiltered* — `NO_BATCH_FILTER` (all three null) is the default the trigger
 * opens with, because J4-Q1 ratified "Batch default = all open comments (filters available but not
 * pre-applied)".
 */
export interface BatchAddressFilter {
  /** The skill that raised the finding, or `HUMAN_SOURCE` for comments no skill raised. */
  source: string | null;
  /** Inclusive severity floor — J4's "severity ≥". */
  severityAtLeast: string | null;
  /** The workflow run (review pass) the finding came from. */
  reviewPass: string | null;
}

/** J4-Q1's default: every dimension unfiltered, so the target is all open threads. */
export const NO_BATCH_FILTER: BatchAddressFilter = {
  source: null,
  severityAtLeast: null,
  reviewPass: null,
};

/**
 * Orders the severity spellings the review path emits — the long form (`"high"`, seen in the
 * provider contract) and the single-letter form (`"H"`, seen in the MCP surface and J4's card
 * mock), case-insensitively. Severity is a free-form string on the wire with no ratified
 * vocabulary, so anything unrecognized (or absent) ranks `null` rather than being coerced into the
 * scale — a filtered batch must never sweep in a finding whose severity it couldn't actually read.
 */
export function severityRank(severity: string | null): number | null {
  if (severity === null) return null;
  switch (severity.trim().toLowerCase()) {
    case "low":
    case "l":
      return 0;
    case "medium":
    case "med":
    case "m":
      return 1;
    case "high":
    case "h":
      return 2;
    default:
      return null;
  }
}

/** The source a thread counts as for filtering: its review skill, or `HUMAN_SOURCE`. */
function sourceOf(thread: CommentThread): string {
  return thread.skill ?? HUMAN_SOURCE;
}

/**
 * A thread remains open while another run targets it. J4 shows those threads in the filtered
 * count, then excludes them by default with an explicit opt-in.
 */
function isOpen(thread: CommentThread): boolean {
  return thread.withdrawn_at == null && !thread.resolved;
}

/** Every open thread, in wire order. */
export function openThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter(isOpen);
}

/**
 * J4's trigger condition for `[Address all… ▾]`: more than one open comment, whether the trigger
 * is in the editor toolbar or a standalone Timeline. One open comment uses the single-address path.
 */
export function canBatchAddress(threads: CommentThread[]): boolean {
  return openThreads(threads).length > 1;
}

/**
 * J4's selected open set and its one default narrowing. Keep the held IDs beside the same
 * filtered set so the sheet's count and the exact opt-in transport cannot disagree.
 */
export function selectBatchSelection(
  threads: CommentThread[],
  filter: BatchAddressFilter,
  liveRunIds?: readonly string[],
  terminalRunIds?: readonly string[],
): { matching: CommentThread[]; available: CommentThread[]; held: CommentThread[] } {
  const floor = filter.severityAtLeast === null ? null : severityRank(filter.severityAtLeast);
  // "No floor applied" and "a floor I can't rank" are different questions with different safe
  // answers, and both would read as `floor === null` below. An unrankable *floor* selects nothing:
  // widening it to every open thread would be the exact inversion of the stance the thread side
  // takes above — a filtered batch must never sweep in findings it never actually compared.
  const matching = filter.severityAtLeast !== null && floor === null ? [] : openThreads(threads).filter((thread) => {
    if (filter.source !== null && sourceOf(thread) !== filter.source) return false;
    if (filter.reviewPass !== null && thread.workflow_run !== filter.reviewPass) return false;
    if (floor !== null) {
      const rank = severityRank(thread.severity);
      if (rank === null || rank < floor) return false;
    }
    return true;
  });
  const available: CommentThread[] = [];
  const held: CommentThread[] = [];
  for (const thread of matching) {
    (isHeldByLiveRun(thread, liveRunIds, terminalRunIds) ? held : available).push(thread);
  }
  return { matching, available, held };
}

/** The default batch target set. Live and terminal run IDs are required for delivered targets,
 * whose pending marker can be gone while the original run still holds them. */
export function selectBatchTargets(
  threads: CommentThread[], filter: BatchAddressFilter,
  liveRunIds: readonly string[], terminalRunIds: readonly string[],
): CommentThread[] {
  return selectBatchSelection(threads, filter, liveRunIds, terminalRunIds).available;
}

/**
 * The source values actually present among open threads — what the trigger's dropdown offers, so a
 * user is never shown a filter that would select nothing. Human first (it's the everyday case),
 * then skills alphabetically for a stable menu order.
 */
export function sourcesIn(threads: CommentThread[]): string[] {
  const present = new Set(openThreads(threads).map(sourceOf));
  const human = present.delete(HUMAN_SOURCE) ? [HUMAN_SOURCE] : [];
  return [...human, ...[...present].sort()];
}

/** The review passes present among open threads — the dropdown's "this review pass" options. */
export function reviewPassesIn(threads: CommentThread[]): string[] {
  const present = new Set(
    openThreads(threads)
      .map((thread) => thread.workflow_run)
      .filter((run): run is string => run !== null),
  );
  return [...present].sort();
}
