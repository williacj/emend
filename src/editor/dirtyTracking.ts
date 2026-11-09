// ABOUTME: The dirty/clean detection an editor tab needs (FR-ED-3) — a CM6 update-listener
// ABOUTME: extension comparing the live doc against a caller-supplied last-saved baseline.
import { StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { serializeDocumentState } from "./document";

/**
 * Dispatch this effect (with no doc changes of its own) to make `dirtyTrackingExtension`
 * re-evaluate against a baseline that just moved — e.g. right after a successful save updates
 * what `getBaseline()` returns — even though that dispatch touches no text itself. Without this,
 * the extension's own doc-changed-only listener would never learn the save happened, and its
 * internal last-reported-dirty memory would drift out of sync with reality.
 */
export const recheckDirty = StateEffect.define<void>();

/**
 * Fires `onDirtyChange` whenever the doc's dirty/clean status *changes* (not on every keystroke,
 * and not repeatedly while it stays the same) — "dirty" means the live doc no longer serializes
 * to exactly `getBaseline()`'s current value. `getBaseline` is read fresh on every relevant
 * transaction rather than captured once, so a caller can move the baseline after a successful save
 * (pairing the update with a `recheckDirty` dispatch) without reconfiguring this extension. A
 * transaction that only moves the selection/scroll (no `docChanged`, no `recheckDirty`) never
 * fires — cursor and scroll changes aren't dirtiness.
 */
export function dirtyTrackingExtension(
  getBaseline: () => string,
  onDirtyChange: (dirty: boolean) => void,
): Extension {
  let lastDirty = false;
  return EditorView.updateListener.of((update) => {
    const forcedRecheck = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(recheckDirty)),
    );
    if (!update.docChanged && !forcedRecheck) return;
    const dirty = serializeDocumentState(update.state) !== getBaseline();
    if (dirty !== lastDirty) {
      lastDirty = dirty;
      onDirtyChange(dirty);
    }
  });
}
