// ABOUTME: The two guarded choices J2 records for a Missing-on-disk document (#933) — the manual
// ABOUTME: Save that cannot write, and the Close that would discard the only copy of the buffer.

/**
 * Which guarded choice this is:
 * - `save` — Cmd/Ctrl+S on a missing document. The write does not happen and cannot: the guard is
 *   what the user gets instead (`[Cancel] [Save As…]`, plus `[Recreate]` when confinement permits).
 * - `close` — the banner's `[Close…]` (and the tab's own close button). Closing is the one action
 *   here that destroys the buffer, so it is the one that asks (`[Cancel] [Save As…] [Close without
 *   saving]`).
 */
export type MissingGuardKind = "save" | "close";

export interface MissingDocumentGuardProps {
  kind: MissingGuardKind;
  /** The document being decided about — its project path, exactly as the tab carries it. */
  label: string;
  /** Whether TD-18 confinement currently permits `[Recreate]`; only the `save` guard offers it,
   * and only then (ux-design: "adding `[Recreate]` only when the same confinement capability is
   * available"). */
  recreatable?: boolean;
  onCancel: () => void;
  onSaveAs: () => void;
  /** The destructive exit, present only on the `close` guard. */
  onDiscard?: () => void;
  onRecreate?: () => void;
}

/**
 * A modal choice rather than a banner, deliberately: both are moments where the user asked for
 * something Cowrite will not silently do (write to a path that is gone; drop a buffer that has no
 * file). The ordinary Missing state stays non-modal — this is only the answer to an explicit act.
 *
 * Copy follows ux-design's — `"This file is missing from disk."` for the save guard, `"This file no
 * longer exists on disk. Close and discard Cowrite’s open copy?"` for the close one — with the
 * document's own name in place of "This file", the way every other guard here names its subject
 * (`DirtyCloseGuard`, FR-ED-8's delete prompt). A guard that can be raised for any of several open
 * documents has to say which one it is about.
 */
export function MissingDocumentGuard({
  kind,
  label,
  recreatable = false,
  onCancel,
  onSaveAs,
  onDiscard,
  onRecreate,
}: MissingDocumentGuardProps) {
  const closing = kind === "close";
  return (
    <div
      // Drawn as the dirty-close guard is: same kind of moment (an explicit act Cowrite will not
      // silently complete), so it reads the same way rather than inventing a second dialog style.
      className="dirty-close-guard"
      role="alertdialog"
      aria-modal="true"
      aria-label={closing ? `Close ${label}?` : `Save ${label}?`}
    >
      <p className="dirty-close-guard__message">
        {closing ? (
          <>
            <strong>{label}</strong> no longer exists on disk. Close and discard Emend’s open
            copy?
          </>
        ) : (
          <>
            <strong>{label}</strong> is missing from disk.
          </>
        )}
      </p>
      <div className="dirty-close-guard__actions">
        <button type="button" className="dirty-close-guard__cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="dirty-close-guard__save" onClick={onSaveAs}>
          Save As…
        </button>
        {!closing && recreatable && onRecreate && (
          <button type="button" className="dirty-close-guard__save" onClick={onRecreate}>
            Recreate
          </button>
        )}
        {closing && onDiscard && (
          <button type="button" className="dirty-close-guard__discard" onClick={onDiscard}>
            Close without saving
          </button>
        )}
      </div>
    </div>
  );
}
