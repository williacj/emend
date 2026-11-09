// ABOUTME: The frontend end of the J1 Phase B delivery pipe (#346) — subscribes to the backend's
// ABOUTME: landed-delivery event and maps one notice into the change-set card the timeline renders.
import type { ParsedChange } from "../editor/trackedChanges";
import { listenForBackendEvent } from "./driverEvents";
import {
  createChangeSetCard,
  type ChangeSetCard,
  type ChangeSetChange,
  type ChangeSetChangeKind,
} from "../timeline/types";

/**
 * The event a completed `propose_changes` is announced on. Namespaced so the agent's own event
 * surface stays distinguishable as it grows (activity, run phases — TD-5's streaming events).
 */
export const DELIVERY_EVENT = "cowrite://agent/delivery";

/**
 * One change in a delivered set — mirrors Rust `agent::delivery::DeliveredChange`
 * (`src-tauri/src/agent/delivery.rs`; cross-boundary types are defined in Rust with `Serialize`
 * and mirrored here per CLAUDE.md).
 */
export interface DeliveredChange {
  /** The TD-4 attribution id (`chg-…`) — the sidecar's identity for this change, and (since TD-16)
   * the identity the document's own parse reports it under, so the two join on it directly. */
  changeId: string;
  kind: ChangeSetChangeKind;
  note: string | null;
  /** The group this change decides all-or-none with (P4b), or `null` for a singleton. */
  group: string | null;
}

/** A completed delivery — mirrors Rust `agent::delivery::DeliveryNotice`. */
export interface DeliveryNotice {
  /** The delivered document, project-relative — matched against the open tabs. */
  doc: string;
  changeSetId: string;
  revision: string;
  /** The delivered document text, CriticMarkup and all: what the buffer reseeds from. */
  content: string;
  summary: string;
  changes: DeliveredChange[];
  /** Proposal edits that could not be rebased (TD-7) / were unrepresentable (TD-11). */
  stale: number;
  unrepresentable: number;
}

/**
 * Subscribes `handler` to every landed delivery, returning the unsubscribe function.
 *
 * Outside a Tauri webview, the shared D23 driver-event pump carries production notices from the
 * headless driver's cursor-backed `/events` log. Both transports use the same production handler.
 */
export async function listenForDeliveries(
  handler: (notice: DeliveryNotice) => void,
): Promise<() => void> {
  return listenForBackendEvent(DELIVERY_EVENT, handler);
}

export interface ChangeSetCardOptions {
  id?: string;
  timestamp?: string;
}

/**
 * Builds the timeline card for one delivery, joining what only the backend knows (which changes
 * belong to this change set, their attribution ids and agent notes) to what only the parse knows
 * (each marker's geometry).
 *
 * **The join is by change id, not by position in the list.** A delivered document generally carries
 * markers from *earlier* deliveries too, so `parsed` — the whole document's parse — is a superset of
 * this delivery's changes. Listing all of them would put changes the user never saw in this card
 * inside its `[Accept all]` sweep. Since TD-16 the parse reports a recorded marker under its own
 * `chg-` attribution id, so selecting this delivery's subset is a lookup on the identity both sides
 * already share — the two schemes that once had to be reconciled by offset are now one. A delivered
 * change the parse does not report (its document was not joined, its marker no longer stands) is
 * dropped rather than given invented geometry: fewer changes on the card is a visible, honest
 * failure; a fabricated span is one that triage would then act on.
 *
 * Every change lands in a single section named for the document: a `propose_changes` delivery
 * carries no sectioning of its own, and D5 puts per-section chunking in a later delivery concern —
 * so this maps whatever chunking the delivery has (none) rather than inventing one.
 */
export function changeSetCardFor(
  notice: DeliveryNotice,
  parsed: ParsedChange[],
  { id, timestamp }: ChangeSetCardOptions = {},
): ChangeSetCard {
  const byId = new Map(parsed.map((change) => [change.id, change]));
  const changes: ChangeSetChange[] = [];

  for (const delivered of notice.changes) {
    const change = byId.get(delivered.changeId);
    if (!change) continue;
    changes.push({
      // @anchor:change-set-card-for-id
      id: change.id,
      kind: change.kind,
      section: notice.doc,
      ...sidesOf(change, notice.content),
      ...(delivered.note ? { note: delivered.note } : {}),
    });
  }

  return createChangeSetCard(notice.changeSetId, notice.summary, changes, {
    id,
    timestamp,
    // The document these ids may be triaged against, and the parse generation they came from
    // (UXR-Q4): the same `revision` seeded into the live tracked-change field when this delivery
    // lands, so the card and that field correspond exactly when their generations match. Without
    // this the card's ids would be triaged against whatever document is on screen — a silent
    // wrong-document decide (invariants 2 + 4).
    doc: notice.doc,
    generation: notice.revision,
  });
}

/** The redline sides a card shows for a change, sliced out of the delivered text. */
function sidesOf(
  change: ParsedChange,
  content: string,
): { oldText?: string; newText?: string } {
  switch (change.kind) {
    case "insertion":
      return { newText: content.slice(change.text.from, change.text.to) };
    case "deletion":
      return { oldText: content.slice(change.text.from, change.text.to) };
    case "substitution":
      return {
        oldText: content.slice(change.old.from, change.old.to),
        newText: content.slice(change.new.from, change.new.to),
      };
  }
}
