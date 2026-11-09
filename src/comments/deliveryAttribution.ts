// ABOUTME: Groups a thread's `linked_changes` by delivery and formats each delivery's relative age.
// ABOUTME: CommentThreadCard uses these helpers where ux-design.md §2 requires attribution (#1380).
import type { LinkedChange } from "./types";

export interface LinkedChangeDeliveryGroup {
  deliveryId: string;
  deliveredAt: number;
  changes: LinkedChange[];
}

/**
 * Groups `linkedChanges` by the delivery (`delivery_id`) that produced them (#1380, ux-design.md
 * §2). A re-delegated thread can carry undecided changes from more than one delivery (FR-CMT-7
 * preserves per-change outcomes across reopenings) — this lets a caller render each under its own
 * name wherever §2 requires attribution. Groups come out in first-appearance order, matching
 * `linked_changes`' own oldest-first accumulation (`store::comments::Thread` docs) — never
 * re-sorted by count or recency.
 */
export function groupLinkedChangesByDelivery(linkedChanges: LinkedChange[]): LinkedChangeDeliveryGroup[] {
  const groups: LinkedChangeDeliveryGroup[] = [];
  const byDeliveryId = new Map<string, LinkedChangeDeliveryGroup>();
  for (const change of linkedChanges) {
    let group = byDeliveryId.get(change.delivery_id);
    if (!group) {
      group = {
        deliveryId: change.delivery_id,
        deliveredAt: change.delivered_at,
        changes: [],
      };
      byDeliveryId.set(change.delivery_id, group);
      groups.push(group);
    }
    group.changes.push(change);
  }
  return groups;
}

/**
 * `12m ago`-style relative time for a delivery's `delivered_at` (ms since epoch) — the J1
 * vocabulary ux-design.md §2 names (`↳ 2 changes from Agent · 12m ago · …`). `now` is the caller's
 * own clock reading (CLAUDE.md: injectable clocks, no reliance on real time in tests); this
 * function never reads `Date.now()` itself. A `deliveredAt` in the future (clock skew) floors to
 * "just now" rather than a negative duration.
 */
export function formatDeliveryRelativeTime(deliveredAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - deliveredAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
