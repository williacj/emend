// ABOUTME: J2's Missing-on-disk integrity banner (FR-ED-2/7, #698/#933) — the non-modal recovery
// ABOUTME: bar for an open document whose project path is gone, with `[Recreate]` shown only while
// ABOUTME: the backend proves TD-18 transaction-long confinement for that exact path.
import { formatActionFailure } from "../backend";

/**
 * Why the last recovery attempt failed, when one has been tried (ux-design "Missing on disk"):
 * `confinement` is the capability that disappeared after `[Recreate]` was shown or invoked — a
 * refusal that happened *before* any read or write — and `error` is any other failure, which
 * likewise preserved the buffer and this state.
 */
export type MissingRecoveryFailure =
  | { kind: "confinement" }
  | { kind: "error"; detail: string };

export interface MissingOnDiskBannerProps {
  /**
   * Whether TD-18 currently reports path-specific transaction-long confinement for this document.
   * `[Recreate]` exists only while this is true — it is absent on macOS and on any unsupported
   * filesystem, which is the whole point of the gate (ux-design; TD-18 #929/#930).
   */
  recreatable: boolean;
  /** The recorded failure copy to show instead of the ordinary message, or `null`. */
  failure: MissingRecoveryFailure | null;
  onKeepEditing: () => void;
  onSaveAs: () => void;
  onClose: () => void;
  onRecreate: () => void;
}

/**
 * `"This file is missing from its project path. Your open copy is safe. [Keep editing] [Save As…]
 * [Close…]"` — ux-design's verbatim copy, plus `[Recreate]` when and only when confinement permits,
 * and the paused-autosave readout it also records (`Autosave paused — file missing`).
 *
 * There is deliberately no `[Reload]` or `[Compare]` here: no disk version exists to reload from or
 * compare against. Once one does again, this banner is gone and FR-ED-7's changed-contents banner
 * owns that choice.
 *
 * A failure state keeps the same non-modal bar and the same buffer, reduced to the two actions that
 * remain honest — `[Save As…]` and `[Keep editing]` — since neither `[Recreate]` (whose capability
 * just went away) nor a silent retry can be promised.
 *
 * `role="status"` — non-modal, never blocks input, exactly like the sibling integrity banners.
 */
export function MissingOnDiskBanner({
  recreatable,
  failure,
  onKeepEditing,
  onSaveAs,
  onClose,
  onRecreate,
}: MissingOnDiskBannerProps) {
  return (
    <div className="integrity-banner integrity-banner--missing" role="status">
      <p className="integrity-banner__message">{message(failure)}</p>
      <p className="integrity-banner__detail">Autosave paused — file missing</p>
      <div className="integrity-banner__actions">
        <button type="button" className="integrity-banner__action" onClick={onKeepEditing}>
          Keep editing
        </button>
        <button type="button" className="integrity-banner__action" onClick={onSaveAs}>
          Save As…
        </button>
        {failure === null && recreatable && (
          <button type="button" className="integrity-banner__action" onClick={onRecreate}>
            Recreate
          </button>
        )}
        {failure === null && (
          <button type="button" className="integrity-banner__action" onClick={onClose}>
            Close…
          </button>
        )}
      </div>
    </div>
  );
}

function message(failure: MissingRecoveryFailure | null): string {
  if (failure === null) {
    return "This file is missing from its project path. Your open copy is safe.";
  }
  if (failure.kind === "confinement") {
    return "Emend can’t safely recreate this file at its original path.";
  }
  // The recorded shared-status wording for a failure (FR-X-5), reused rather than invented so one
  // vocabulary covers every "we couldn't do it, here's why".
  return formatActionFailure(failure.detail);
}
