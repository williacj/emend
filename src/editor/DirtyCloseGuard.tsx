// ABOUTME: FR-ED-3's dirty-close guard UI — presented when closing a dirty tab (or quitting with
// ABOUTME: any dirty tab open); Save or Save As / Discard / Cancel, according to the tab's route.
import { useEffect, useRef } from "react";

export interface DirtyCloseGuardProps {
  /** What to call the tab awaiting a decision — `tabLabel`, never a raw recovery identity. */
  label: string;
  /** Omitted only when this guard has no non-destructive save route (for example Missing on disk). */
  onSave?: () => void;
  /** The save action's exact user-facing route; ordinary dirty tabs keep the default `Save`. */
  saveLabel?: string;
  /** Shared Save As single-flight state; every exit is disabled across the irreversible attempt. */
  saving?: boolean;
  /** Guard-hosted failure explanation, since the pane status is hidden behind this modal. */
  saveError?: string | null;
  /** J2's explicit untitled-document guard state. Ordinary project-document guards omit it. */
  recoveryVariant?:
    | "only-copy"
    | "live-over-cap"
    | "omitted-with-edits"
    | "restored-omitted-empty"
    | "preserved-empty";
  /** A context-specific accessible name while the visible action remains the standard Discard. */
  discardLabel?: string;
  onDiscard: () => void;
  onCancel: () => void;
}

export function DirtyCloseGuard({
  label,
  onSave,
  saveLabel = "Save",
  saving = false,
  saveError,
  recoveryVariant,
  discardLabel,
  onDiscard,
  onCancel,
}: DirtyCloseGuardProps) {
  const savable = onSave !== undefined;
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!saving) cancelRef.current?.focus();
  }, [saving]);
  const neutralRecovery =
    recoveryVariant === "restored-omitted-empty" || recoveryVariant === "preserved-empty";
  const destructiveRecovery = recoveryVariant !== undefined && !neutralRecovery;
  const title = neutralRecovery
    ? `Close ${label}?`
    : savable
      ? `Unsaved work in ${label}`
      : `Discard ${label}?`;
  return (
    <div
      className="dirty-close-guard"
      role="alertdialog"
      aria-modal="true"
      aria-busy={saving}
      aria-labelledby="dirty-close-guard-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "Tab") {
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div className="dirty-close-guard__card">
        <h2 id="dirty-close-guard-title" className="dirty-close-guard__title">
          {title}
        </h2>
        <p className="dirty-close-guard__message">
          {recoveryVariant === "restored-omitted-empty" ? (
            <>
              This untitled document is empty now. Earlier unsaved work was not preserved. Closing
              it discards no current content.
            </>
          ) : recoveryVariant === "preserved-empty" ? (
            <>This untitled document is empty and isn't saved anywhere. Closing it discards no content.</>
          ) : recoveryVariant === "live-over-cap" ? (
            <>
              This document holds unsaved work that Cowrite can't keep in your session — it's over
              the 2 MiB per-tab limit. Closing it without saving discards that work permanently.
            </>
          ) : recoveryVariant === "omitted-with-edits" ? (
            <>
              You've written in this document since it was opened, and that work isn't saved
              anywhere. Closing it without saving discards it permanently. The earlier unsaved work
              this tab was created to hold was already not preserved, and closing changes nothing
              about that.
            </>
          ) : recoveryVariant === "only-copy" ? (
            <>
              <strong>{label}</strong> holds unsaved work. Closing it without saving discards that
              work permanently.
            </>
          ) : savable ? (
            <>
              <strong>{label}</strong> has unsaved changes.
            </>
          ) : (
            <>
              <strong>{label}</strong> holds unsaved work with no file to save it to. Closing it
              discards that work permanently.
            </>
          )}
        </p>
        {saveError && (
          <p className="dirty-close-guard__save-error" role="status">
            {saveError}
          </p>
        )}
        <div className="dirty-close-guard__actions">
          {savable && (
            <button type="button" className="dirty-close-guard__save" onClick={onSave} disabled={saving}>
              {saveLabel}
            </button>
          )}
          <button
            type="button"
            className={`dirty-close-guard__discard${
              destructiveRecovery ? " dirty-close-guard__discard--destructive" : ""
            }`}
            aria-label={discardLabel}
            onClick={onDiscard}
            disabled={saving}
          >
            Discard
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="dirty-close-guard__cancel"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
