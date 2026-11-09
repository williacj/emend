// ABOUTME: The "comment on this" affordance (#259, J4/FR-CMT-1) — a small floating button next to a
// ABOUTME: non-empty selection, alongside `QuoteAffordance`; purely presentational, positioned by the
// ABOUTME: caller (mirrors `QuoteAffordance`'s own `coordsAtPos`-computed `style`).
import type { CSSProperties } from "react";

export interface CommentTriggerProps {
  /** Absolute positioning next to the selection (from `EditorView.coordsAtPos`); omitted in tests
   * or before the view has laid out. */
  style?: CSSProperties;
  onComment: () => void;
}

/**
 * Renders nothing but a button — opening the comment popover in create mode, and everything
 * downstream of it, is the caller's job. Clicking never touches the CM6 view itself (no
 * `dispatch`, no `focus`), so it can never steal the caret or scroll the document (Principle 2).
 */
export function CommentTrigger({ style, onComment }: CommentTriggerProps) {
  return (
    <button type="button" className="comment-trigger" style={style} onClick={onComment}>
      Comment
    </button>
  );
}
