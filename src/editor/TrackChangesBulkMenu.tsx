// ABOUTME: The toolbar's type-filtered bulk-ops dropdown (P2b-2, J1-Q1; ux-design §4 track-changes
// ABOUTME: cluster: "nav / accept-reject / type-filtered bulk / display mode") — "Accept/Reject all
// ABOUTME: insertions/deletions", scoped to the whole document.
import { useRef, useState } from "react";
import type { ChangeDesc } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useDismissOnOutsideOrEscape } from "../useDismissOnOutsideOrEscape";
import { decideByType, trackedChanges, type ChangeTypeFilter, type Decision } from "./trackedChanges";

export interface TrackChangesBulkMenuProps {
  /** The mounted editor view; renders nothing until it loads. */
  view: EditorView | null;
  /** Bumped by the editor on every view update, so this re-reads the live tracked-change set (the
   * same signal `RedlineReview`/`ViewModeToolbar` read for the same reason). */
  version: number;
  /** Receives the decision transaction's mapping when a bulk action removes the final change. */
  onFinalDecision?: (changes: ChangeDesc) => void;
}

const OPTIONS: readonly { filter: ChangeTypeFilter; decision: Decision; label: string }[] = [
  { filter: "insertion", decision: "accept", label: "Accept all insertions" },
  { filter: "insertion", decision: "reject", label: "Reject all insertions" },
  { filter: "deletion", decision: "accept", label: "Accept all deletions" },
  { filter: "deletion", decision: "reject", label: "Reject all deletions" },
];

/**
 * "Accept all insertions"/"Accept all deletions" (and reject equivalents), scoped to the whole
 * document (J1-Q1) — the toolbar-dropdown half of the type-filtered bulk ops; the change-set card's
 * own overflow menu (`timeline/ChangeSetCard.tsx`) is the change-set-scoped equivalent. Each pick is
 * one `decideByType` call: a single-parse-snapshot batch decision honoring group atomicity (P4b)
 * and the TD-11 single-snapshot corollary, never a per-change loop — so a bulk op is one decision
 * with no observable partially-applied intermediate state (FR-AGENT-6-style honesty at this
 * interface). An option with no matching pending change disables rather than firing a no-op.
 */
export function TrackChangesBulkMenu({ view, version, onFinalDecision }: TrackChangesBulkMenuProps) {
  // `version` isn't read directly — it's a render trigger only (see the prop's own doc comment);
  // this line just satisfies the unused-parameter check.
  void version;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDetailsElement>(null);

  // Native `<details>` closes on neither Escape nor an outside click, so an absolutely-positioned
  // options panel would otherwise overlay the document until the summary is clicked again — the
  // shared fix (`ChangeSetCard`'s overflow menu has the same need).
  useDismissOnOutsideOrEscape(open, rootRef, setOpen);

  if (!view) return null;
  const changes = trackedChanges(view.state);

  return (
    <details
      className="track-changes-bulk-menu"
      ref={rootRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="Type-filtered bulk operations">Bulk ▾</summary>
      <div className="track-changes-bulk-menu__options">
        {OPTIONS.map(({ filter, decision, label }) => (
          <button
            key={label}
            type="button"
            disabled={!changes.some((c) => c.kind === filter)}
            onClick={() => {
              decideByType(view, filter, decision, (mapping) => {
                if (trackedChanges(view.state).length === 0) onFinalDecision?.(mapping);
              });
              setOpen(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </details>
  );
}
