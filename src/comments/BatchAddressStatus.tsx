// ABOUTME: The last batch run's per-thread accounting (P2b-3a, FR-AGENT-6) — what completed, what
// ABOUTME: was skipped, what never ran, and why a run stopped early.
import type { BatchAddressOutcome } from "./types";

export interface BatchAddressStatusProps {
  /** One run's immutable admission accounting (FR-AGENT-6). */
  outcome: BatchAddressOutcome;
  /** Display order within this panel; the opaque backend run ID remains an internal key. */
  batchNumber: number;
  /** A later queued cancellation does not change admission or append-failure accounting. */
  conclusion?: "cancelled";
}

/**
 * Renders FR-AGENT-6's "the card says which": what completed, what was skipped, what never ran.
 *
 * Deliberately **not** part of `BatchAddressTrigger`. The trigger's lifetime is "more than one
 * comment is open"; this surface's lifetime is "a run happened". A clean batch marks every target
 * mid-run, so no comment is left open and the trigger lapses — housing the outcome inside it would
 * hide the accounting on exactly the path where it is most likely to be the user's only notice that
 * some comment was skipped and never looked at.
 */
export function BatchAddressStatus({ outcome, batchNumber, conclusion }: BatchAddressStatusProps) {
  const parts = [`${outcome.addressed.length} addressed`];
  if (outcome.skipped.length > 0) parts.push(`${outcome.skipped.length} skipped`);
  if (outcome.untouched.length > 0) parts.push(`${outcome.untouched.length} untouched`);
  return (
    <p className="batch-address-status" role="status">
      <span className="batch-address-status__run">Batch {batchNumber}</span> · {parts.join(" · ")}
      {outcome.interrupted !== null && (
        // Never swallowed: a batch that stopped early must say so, and say why, or the user is
        // left believing every comment was handled.
        <span className="batch-address-status__interrupted"> — stopped early: {outcome.interrupted}</span>
      )}
      {conclusion === "cancelled" && <span className="batch-address-status__conclusion"> · Cancelled</span>}
    </p>
  );
}
