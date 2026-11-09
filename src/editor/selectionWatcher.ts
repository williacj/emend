// ABOUTME: Editor selection observation (P2b-7, tech-design §3.1 "quote-selection→anchored-message
// ABOUTME: = selection watcher → timeline quote-bar") — a CM6 update-listener extension reporting the
// ABOUTME: live non-empty selection, purely read-only (Principle 2: never moves the caret or scrolls).
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * A non-empty editor selection at one instant, in CodeMirror's own UTF-16 code-unit coordinate
 * space (`state.selection.main`'s `from`/`to`) — the same space every other CM6-facing offset in
 * this codebase uses (`editor/ipc.ts`'s `parseChanges`). Converting to `textops`' byte-indexed
 * canonical space (TD-6) happens backend-side, in `capture_anchor` — this snapshot never hand-rolls
 * that arithmetic (CLAUDE.md: anchor construction stays in `textops`).
 */
export interface SelectionSnapshot {
  offset: number;
  length: number;
  /** The selected text, read straight off the live doc — shown by the quote affordance so a caller
   * never has to re-slice it. */
  text: string;
}

/** Reads `state`'s current selection: `null` for an empty selection (a bare caret, nothing to
 * quote), otherwise the snapshot of its main range. A multi-range selection is represented by its
 * `main` range only — CM6's own single "the" selection for single-range operations like this one. */
export function selectionSnapshot(state: EditorState): SelectionSnapshot | null {
  const { main } = state.selection;
  if (main.empty) return null;
  return {
    offset: main.from,
    length: main.to - main.from,
    text: state.sliceDoc(main.from, main.to),
  };
}

function sameSnapshot(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.offset === b.offset && a.length === b.length && a.text === b.text;
}

/**
 * Fires `onChange` whenever the live selection's snapshot changes — a non-empty selection appears,
 * moves, or collapses back to a bare caret (`null`) — deduped against the last-reported value so an
 * unrelated update (e.g. a doc edit outside the selection) doesn't re-fire an unchanged selection.
 * Read-only: this extension never dispatches a transaction of its own, so it can never itself steal
 * the caret or scroll the document (Principle 2) — it only observes what CM6 already reports.
 */
export function selectionWatcherExtension(
  onChange: (selection: SelectionSnapshot | null) => void,
): Extension {
  let last: SelectionSnapshot | null = null;
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    const next = selectionSnapshot(update.state);
    if (sameSnapshot(last, next)) return;
    last = next;
    onChange(next);
  });
}
