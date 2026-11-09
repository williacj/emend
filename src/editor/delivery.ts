// ABOUTME: Agent-delivery transaction policy (P2a-21, TD §3.3 finding M9) — the CM6 transaction
// ABOUTME: shape a delivered change-set must dispatch as: `addToHistory: false`, so a bare Ctrl/
// ABOUTME: Cmd+Z can never rip a delivery back out from under the user (Reject is the reversal).
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { seedTrackedChanges, type TrackedChangesSeed } from "./trackedChanges";

/** The `userEvent` tag every delivery transaction carries, so listeners can recognise one. */
export const DELIVERY_USER_EVENT = "agent.delivery";

/**
 * Builds the transaction spec for an agent delivery landing in an already-open document: the
 * document becomes `content` (the backend's rebased, TD-11-validated result — TD-2, no partial
 * patching client-side) and the tracked-change snapshot is reseeded from `seed` (the delivery's
 * parse of the new CriticMarkup), all tagged `Transaction.addToHistory.of(false)`.
 *
 * That annotation is the *whole* undo-policy contract (TD §3.3 finding M9): CM6's `history()` never
 * records this transaction, so it can never be the target of a bare undo — a delivered change-set
 * only ever leaves the document via an explicit Reject (`trackedChanges.ts`'s `decideChange`, itself
 * a normal, undoable transaction). Pure state-in/state-out — call `applyAgentDelivery` to dispatch
 * it against a live view.
 *
 * **Whole-document text, minimal change (UX Principle 2).** `content` is the backend's whole rebased
 * document (TD-7/P6 `textops::rebase` + `render_representable`), but it is dispatched as the *change
 * set that gets there* — the differing middle only, via `narrowToChangedSpan` — never as a blanket
 * `{from: 0, to: doc.length}` replace. The distinction is load-bearing rather than cosmetic: CM6
 * maps selections, cursors, and every other position through a transaction's changes, and a
 * full-document replace maps every downstream position onto the end of the replacement. A delivery
 * landing while the user is typing would therefore teleport the caret to the bottom of the file —
 * exactly the "no scroll, no focus steal" rule J1 Phase B is written against. Trimming to the
 * changed span leaves untouched text genuinely untouched, so a caret or selection outside the
 * delivered edits maps to the same characters it was on before.
 *
 * Nothing here scrolls or focuses: the spec deliberately carries no `scrollIntoView`, and a
 * `dispatch` never moves DOM focus on its own — the pending-change counter and the new timeline card
 * are the only things that move.
 */
export function deliveryTransaction(
  state: EditorState,
  content: string,
  seed: TrackedChangesSeed,
): TransactionSpec {
  return {
    changes: narrowToChangedSpan(state.doc.toString(), content),
    effects: seedTrackedChanges.of(seed),
    annotations: Transaction.addToHistory.of(false),
    userEvent: DELIVERY_USER_EVENT,
  };
}

/**
 * Whether `update` carries an agent delivery — the check a doc-change listener needs to tell "the
 * agent delivered a set the backend already wrote to disk" apart from "the user typed something".
 * Autosave uses it to stay disarmed: re-saving a delivery would write identical bytes back over the
 * backend's own atomic write (FR-AGENT-6) and could race the next delivery.
 */
export function isAgentDelivery(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => tr.isUserEvent(DELIVERY_USER_EVENT));
}

/**
 * The single replacement that turns `live` into `delivered`, trimmed to the span they actually
 * differ over: shared prefix and shared suffix are left alone so CM6 maps positions inside them
 * unchanged. Identical texts yield an empty change at the end of the shared prefix — i.e. at
 * `live.length`, which is the whole text.
 *
 * Boundaries are pulled back off any split surrogate pair, so an emoji straddling the trim point is
 * rewritten whole rather than cut into lone surrogates (JS strings are UTF-16; CM6 offsets are code
 * units). This is a positional optimisation only — the resulting document is `delivered` exactly,
 * whatever the trim decides, so TD-2 fidelity does not depend on the arithmetic being clever.
 */
function narrowToChangedSpan(
  live: string,
  delivered: string,
): { from: number; to: number; insert: string } {
  const max = Math.min(live.length, delivered.length);

  let prefix = 0;
  while (prefix < max && live[prefix] === delivered[prefix]) prefix++;
  // Never leave a high surrogate on the shared side with its low surrogate on the changed side.
  if (prefix > 0 && isHighSurrogate(live.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    live[live.length - 1 - suffix] === delivered[delivered.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(live.charCodeAt(live.length - suffix))) suffix--;

  return {
    from: prefix,
    to: live.length - suffix,
    insert: delivered.slice(prefix, delivered.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Dispatches `deliveryTransaction` against `view` — the entry point a session/event listener
 * (once that wiring lands) calls when the backend hands over a delivered change-set. */
export function applyAgentDelivery(view: EditorView, content: string, seed: TrackedChangesSeed): void {
  view.dispatch(deliveryTransaction(view.state, content, seed));
}
