// ABOUTME: The "quote this in a message" affordance (P2b-7, UX Principle 6) — a small floating
// ABOUTME: button next to a non-empty selection; purely presentational, positioned by the caller
// ABOUTME: (mirrors `RedlinePopover`'s `coordsAtPos`-computed `style`, never computes its own layout).
import type { CSSProperties } from "react";

export interface QuoteAffordanceProps {
  /** Absolute positioning next to the selection (from `EditorView.coordsAtPos`); omitted in tests
   * or before the view has laid out. */
  style?: CSSProperties;
  onQuote: () => void;
}

/**
 * Renders nothing but a button — attaching the anchor capture, and everything downstream of it
 * (the timeline quote-bar), is the caller's job. Clicking never touches the CM6 view itself (no
 * `dispatch`, no `focus`), so it can never steal the caret or scroll the document (Principle 2).
 */
export function QuoteAffordance({ style, onQuote }: QuoteAffordanceProps) {
  return (
    <button
      type="button"
      className="quote-affordance"
      style={style}
      onClick={onQuote}
    >
      Quote to chat
    </button>
  );
}
