// ABOUTME: The accept/reject popover (P2a-5, J1 Phase C wireframe) — shows a pending change's
// ABOUTME: old→new text plus any agent note, with Accept/Reject buttons that route through the same
// ABOUTME: single decision path as toolbar clicks and Cmd/Ctrl+Enter / Cmd/Ctrl+Backspace triage.
import type { CSSProperties, KeyboardEvent } from "react";
import type { ChangeKind } from "./trackedChanges";

/** The resolved text a popover renders — both sides of the change (either may be empty) and the
 * optional agent note. Computed by the caller from the *current* document (so a user edit inside the
 * pending change shows through), not stored snapshot text. */
export interface RedlinePopoverChange {
  kind: ChangeKind;
  /** The removed / original side (a deletion's or substitution's `old`); empty for an insertion. */
  oldText: string;
  /** The added / replacement side (an insertion's or substitution's `new`); empty for a deletion. */
  newText: string;
  /** Optional agent note from the delivery metadata. */
  note?: string;
}

export interface RedlinePopoverProps {
  change: RedlinePopoverChange;
  /** Absolute positioning next to the redline (from `EditorView.coordsAtPos`); omitted in tests. */
  style?: CSSProperties;
  onAccept: () => void;
  onReject: () => void;
  onClose: () => void;
}

/** Human label for the change kind, for the popover heading and the assistive-tech name. */
const KIND_LABEL: Record<ChangeKind, string> = {
  insertion: "Insertion",
  deletion: "Deletion",
  substitution: "Substitution",
};

export function RedlinePopover({ change, style, onAccept, onReject, onClose }: RedlinePopoverProps) {
  // Escape dismisses without deciding — the popover is a transient overlay, not a mode (J1: "no
  // mode required"), so it must never trap the reviewer.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`${KIND_LABEL[change.kind]}: review change`}
      className="redline-popover"
      style={style}
      onKeyDown={handleKeyDown}
    >
      <div className="redline-popover__diff">
        {change.oldText && (
          <span className="redline-popover__old" aria-label="Removed text">
            {change.oldText}
          </span>
        )}
        {change.oldText && change.newText && <span aria-hidden="true"> → </span>}
        {change.newText && (
          <span className="redline-popover__new" aria-label="Added text">
            {change.newText}
          </span>
        )}
      </div>
      {change.note && <p className="redline-popover__note">{change.note}</p>}
      <div className="redline-popover__actions">
        <button type="button" className="redline-popover__accept" onClick={onAccept}>
          ✓ Accept
        </button>
        <button type="button" className="redline-popover__reject" onClick={onReject}>
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
