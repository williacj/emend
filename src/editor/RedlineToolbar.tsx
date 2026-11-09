// ABOUTME: The redline triage toolbar (P2a-5, J1 wireframe `[✓ Accept][✗ Reject] ◀ n/N ▶`) — accept
// ABOUTME: /reject the current change and step prev/next through the pending set, plus (P2b-2) an
// ABOUTME: optional trailing slot for the type-filtered bulk dropdown, all in the one cluster row
// ABOUTME: ux-design §4 specifies ("nav / accept-reject / type-filtered bulk / display mode").
import type { ReactNode } from "react";
import { ToolbarOverflowSlot, useToolbarOverflow } from "./ToolbarOverflowSlot";

export interface RedlineToolbarProps {
  /** Total pending changes (`N`). The toolbar is inert (disabled) at zero. */
  count: number;
  /** 1-based index of the current change (`n`), or 0 when none is focused yet. */
  position: number;
  onAccept: () => void;
  onReject: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Rendered after ▶, inside this same flex row (the type-filtered bulk dropdown, P2b-2) — so it
   * sits in the cluster ux-design §4 places it in rather than as a separate, unstyled row. */
  children?: ReactNode;
  /** Composes the controls as the context group inside the document's shared toolbar. */
  embedded?: boolean;
}

export function RedlineToolbar({
  count,
  position,
  onAccept,
  onReject,
  onPrev,
  onNext,
  children,
  embedded = false,
}: RedlineToolbarProps) {
  const none = count === 0;
  const overflow = useToolbarOverflow();
  const allHidden = embedded && [
    "review-accept", "review-reject", "review-stepper", "review-bulk",
  ].every((id) => overflow?.hidden.has(id));
  return (
    <div
      className={`redline-toolbar${embedded ? " redline-toolbar--embedded" : ""}`}
      role={embedded ? "group" : "toolbar"}
      aria-label="Review changes"
      data-toolbar-empty={allHidden || undefined}
    >
      <ToolbarOverflowSlot id="review-accept" enabled={embedded}>
        <button
          type="button"
          className="redline-toolbar__accept"
          onClick={onAccept}
          disabled={none}
        >
          ✓ Accept
          <span className="redline-toolbar__accept-shortcut" aria-hidden="true">⌘⏎</span>
        </button>
      </ToolbarOverflowSlot>
      <ToolbarOverflowSlot id="review-reject" enabled={embedded}>
        <button
          type="button"
          className="redline-toolbar__reject"
          onClick={onReject}
          disabled={none}
        >
          ✗ Reject
        </button>
      </ToolbarOverflowSlot>
      <ToolbarOverflowSlot id="review-stepper" enabled={embedded}>
        <div className="redline-toolbar__stepper" role="group" aria-label="Change navigation">
          <button
            type="button"
            className="redline-toolbar__prev"
            aria-label="Previous change"
            onClick={onPrev}
            disabled={none}
          >
            {embedded ? "‹" : "◀"}
          </button>
          <span className="redline-toolbar__count" aria-live="polite">
            {none ? "0 / 0" : embedded ? `${position} of ${count}` : `${position} / ${count}`}
          </span>
          <button
            type="button"
            className="redline-toolbar__next"
            aria-label="Next change"
            onClick={onNext}
            disabled={none}
          >
            {embedded ? "›" : "▶"}
          </button>
        </div>
      </ToolbarOverflowSlot>
      <ToolbarOverflowSlot id="review-bulk" enabled={embedded}>{children}</ToolbarOverflowSlot>
    </div>
  );
}
