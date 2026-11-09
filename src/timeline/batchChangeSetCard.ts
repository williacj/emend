// ABOUTME: Builds the J4 batch grouped-by-comment `ChangeSetCard` (P2b-3b) from a real
// ABOUTME: `address_all_with_ai` outcome (P2b) — the wiring `TimelinePanel.handleAddressAll` needed.
import { ratifiedSeverityLetter } from "../comments/severity";
import type { BatchAddressOutcome, CommentThread } from "../comments/types";
import {
  createChangeSetCard,
  type ChangeSetCard,
  type ChangeSetCommentGroup,
  type ChangeSetSeverity,
} from "./types";

/**
 * Maps a thread's free-form `severity` string to the chip's ratified four-letter vocabulary.
 * Unlike `comments/severity.ts`'s `severityLetter` (which guesses a first letter for an
 * unrecognized string, correct for a single-thread card that always has *some* severity to show),
 * an unranked value here renders **no chip at all** — matching `ChangeSetCard`'s own "a group with
 * no severity renders its label and count with no chip" contract, which only the four ratified
 * letters may satisfy. `ratifiedSeverityLetter` matches the *input* against the ratified spellings
 * directly rather than round-tripping through `severityLetter`'s guessing fallback, which would
 * otherwise leak any free-form value starting with c/h/m/l ("cosmetic", "housekeeping") through as
 * a guessed match (review finding, #537).
 */
function commentSeverity(severity: string | null): ChangeSetSeverity | undefined {
  return severity === null ? undefined : ratifiedSeverityLetter(severity);
}

/** A short label for a group's `▸` header (ux-design.md's "Eph 4:22 quote" mock) — the anchored
 * passage a reviewer/finding quoted, or the comment's own body for a document-level thread
 * (`anchor: null`, FR-CMT-1) with no passage to quote. */
function commentLabel(thread: CommentThread): string {
  return thread.anchor?.text_snapshot || thread.body;
}

export interface BatchChangeSetCardOptions {
  id?: string;
  timestamp?: string;
}

/**
 * Builds the grouped-by-comment change-set card for one completed `[Address all…]` batch run
 * (FR-CMT-5/D8, ux-design.md J4 Batch) — one group per addressed comment, with its severity chip.
 *
 * **`changes`/`defenses`/`replyCount` are always empty today.** Nothing yet spawns the provider
 * run behind a batch address and ties its delivery back to a comment id
 * (`commands::comments::address_all_with_ai`'s own doc comment: "spawning/streaming the run itself
 * is P2a-15's job, out of scope here") — there is no event this function could read a delivered
 * change, reply, or defense from at the moment the batch call resolves. Building this card now,
 * with its per-comment metadata already in place, means every group is ready to receive real
 * changes/defenses/replies the moment that pipeline lands; inventing placeholder content this run
 * never actually produced would violate FR-AGENT-6's honesty and CLAUDE.md's "never fabricate a
 * tool field" rule instead.
 *
 * Returns `undefined` for a run that addressed nothing (every target was skipped, or the run was
 * interrupted before addressing any) — there is no comment to group, so no card to raise.
 */
export function batchChangeSetCardFor(
  outcome: BatchAddressOutcome,
  { id, timestamp }: BatchChangeSetCardOptions = {},
): ChangeSetCard | undefined {
  if (outcome.addressed.length === 0) return undefined;

  const byId = new Map(outcome.threads.map((thread) => [thread.id, thread]));
  const commentGroups: ChangeSetCommentGroup[] = outcome.addressed
    .map((threadId) => byId.get(threadId))
    // Defensive only: a real outcome's `threads` is the document's whole refreshed list, which
    // always includes every id `addressed` names. Never silently invents a group for an id it
    // can't find real thread data for.
    .filter((thread): thread is CommentThread => thread !== undefined)
    .map((thread) => ({
      commentId: thread.id,
      label: commentLabel(thread),
      severity: commentSeverity(thread.severity),
    }));

  const count = commentGroups.length;
  // `changeSetId` holds the batch's *run* id, not a `propose_changes` change_set_id: this run produced
  // no changes to attribute (see above), so there is no attribution record for it to point at, and the
  // run id is the only identity this card genuinely has. Inert today — nothing reads it with an empty
  // `changes` — but it is the field P2a-15 must fill with the real change-set id the moment a batch
  // address delivers changes, so that TD-4 attribution resolves (review Minor, #537).
  return createChangeSetCard(outcome.run_id, `Addressed ${count} ${count === 1 ? "comment" : "comments"}.`, [], {
    id: id ?? `batch-address-${outcome.run_id}`,
    timestamp,
    commentGroups,
    defenses: [],
    replyCount: 0,
  });
}
