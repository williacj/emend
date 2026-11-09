// ABOUTME: Builds the prompt an "Address with AI" run carries (FR-CMT-2/FR-CMT-5) — what the
// ABOUTME: comment asked for, the exact passage it's anchored to, and any re-delegation guidance.
// ABOUTME: Shared by the single-thread and batch address paths, matching `runId.ts`'s identical
// ABOUTME: one-shared-helper shape, so both name the run's actual work the same way.
import type { CommentThread } from "./types";

/** One thread's comment as the run sees it: the quoted passage it's anchored to (a document-level
 * thread has none) followed by the comment body itself. */
// @anchor:address-prompt-thread-summary
function threadSummary(thread: CommentThread): string {
  const quote = thread.anchor ? `Quoted passage: "${thread.anchor.text_snapshot}"\n` : "";
  return `${quote}Comment: ${thread.body}`;
}

/**
 * The `start_run` prompt for a single "Address with AI" run (FR-CMT-2, ux-design.md J4): propose a
 * tracked change addressing the comment, or reply explaining why none is needed (FR-CMT-4's
 * defense path) — the two outcomes [`addressWithAI`]'s own doc names. `guidance` is the
 * [Try again — add guidance…] re-delegation note (`null` for a first address); when given, it is
 * appended so the run sees both the rejection that reopened the thread and the user's own note.
 * Callers pass `[path]` as `start_run`'s `operationTargets` (D21) — see `timeline/CommentCard.tsx`
 * and `editor/CommentPopover.tsx`.
 */
export function buildAddressPrompt(thread: CommentThread, guidance: string | null = null): string {
  const lines = [
    "Address this comment thread: propose a tracked change, or reply explaining why none is needed.",
    threadSummary(thread),
  ];
  if (guidance) lines.push(`Guidance for this attempt: ${guidance}`);
  return lines.join("\n\n");
}

/**
 * The `start_run` prompt for one `[Address all…]` batch run (FR-CMT-5/D8, ux-design.md J4 Batch) —
 * every targeted thread listed in order, under the same instruction the single path gives. See
 * `TimelinePanel.handleAddressAll`, which passes the same targets to `address_all_with_ai` under
 * this run's own id.
 */
export function buildBatchAddressPrompt(threads: CommentThread[]): string {
  const lines = [
    `Address the following ${threads.length} comment thread(s): for each, propose a tracked change, ` +
      "or reply explaining why none is needed.",
    ...threads.map((thread, index) => `${index + 1}. ${threadSummary(thread)}`),
  ];
  return lines.join("\n\n");
}
