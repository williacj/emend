// ABOUTME: The external-change integrity banner (FR-ED-7, ux-design "Document integrity &
// ABOUTME: lifecycle moments", docs/design/specs/document-integrity.md mocks 11a/11b/11c) — a
// ABOUTME: non-modal bar across the editor top, never a dialog, for a file that changed on disk
// ABOUTME: while its tab was open. One component carries every FR-ED-7 presentation phase (#2074,
// ABOUTME: AC1): the ordinary/blocked "observed" choice, the busy "reloading" write, and the
// ABOUTME: "failed" recovery-write state CJ ruled on #1641 (2026-08-28) — never a second banner.
import type { Ref } from "react";
import { isMac } from "./keymap";

/**
 * Every shape this one banner renders (#2074 AC1). `reload-write-pending` (11c.4) carries **no**
 * banner at all — between the buffer swap and a successful recovery write the document is
 * genuinely unsaved, and the ordinary tab dot says so (`EditorShell` simply mounts nothing here for
 * that phase) — so it is not a member of this union.
 */
export type ExternalChangeBannerState =
  | {
      /** The ordinary choice (11c.1) or, once a blocked Save has rewritten it (11c.2), the same
       * choice with both lines replaced and focus already returned to `Keep mine`. */
      kind: "observed";
      blocked: boolean;
    }
  | {
      /** Reload's busy write (11c.3): `aria-busy`, the three actions dimmed but mounted, a quiet
       * `Reloading…`, and progress copy in place of the ordinary consequence line. */
      kind: "reloading";
    }
  | {
      /** The ratified failed-Reload disposition (11c.5, CJ 2026-08-28, #1641): `Keep mine` is
       * absent — after a Reload the buffer already holds the disk version, so the label is
       * ambiguous or a no-op — and `retrying` dims the same three actions while `Try again` is
       * itself in flight (bounded to one attempt at a time, AC7). */
      kind: "failed";
      reason: string;
      retrying: boolean;
    };

export interface ExternalChangeBannerProps {
  /** The document's project-relative path, named in the "observed, dirty" consequence line the way
   * every other surface in this folder names a path: italic. */
  path: string;
  state: ExternalChangeBannerState;
  /** Whether the tab has unsaved local edits — makes "Keep mine" the highlighted default (the safe
   * choice: never silently overwrite the user's in-progress edit) and picks the "observed" state's
   * consequence copy. Irrelevant once `state.kind` is `"reloading"`/`"failed"` — neither offers
   * `Keep mine` while busy or after Reload already replaced the buffer. */
  isDirty: boolean;
  onReload: () => void;
  onKeepMine: () => void;
  onCompare: () => void;
  onTryAgain: () => void;
  onSaveAs: () => void;
  /** Imperative focus target used only after a blocked manual/dirty-close Save explicitly asks to
   * return keyboard attention here. Banner appearance itself never moves focus. */
  keepMineRef?: Ref<HTMLButtonElement>;
  /** Defaults to the running platform; injectable so a test can render either chrome without
   * faking `navigator` (same shape as `TabBar.platform`). Drives the win/mac edge and radius
   * treatment (`document-integrity.md` "Buttons"). */
  platform?: "win" | "mac";
}

function heading(state: ExternalChangeBannerState): string {
  if (state.kind === "failed") return "The version from disk is here, but it isn’t saved";
  if (state.kind === "observed" && state.blocked) {
    return "Not saved — this file changed outside the editor";
  }
  return "This file changed outside the editor";
}

/** The italicized path in the "observed, dirty" consequence line is the one place this component's
 * copy is not a single string — every other phase's line two is plain text. */
function Consequence({ path, state, isDirty }: Pick<ExternalChangeBannerProps, "path" | "state" | "isDirty">) {
  if (state.kind === "failed") {
    return (
      <p className="integrity-banner__consequence">
        What you see now is the file as it was on disk. Emend couldn’t finish saving it back, so
        this document is still unsaved.
      </p>
    );
  }
  if (state.kind === "observed" && state.blocked) {
    return (
      <p className="integrity-banner__consequence">
        Emend didn’t write over it. Choose Reload, Keep mine, or Compare.
      </p>
    );
  }
  if (state.kind === "reloading") {
    return (
      <p className="integrity-banner__consequence">
        Bringing in the version from disk and saving it in place. Your earlier text is being
        replaced.
      </p>
    );
  }
  if (isDirty) {
    return (
      <p className="integrity-banner__consequence">
        Someone or something else wrote to <i>{path}</i>. Emend has paused writing to it until
        you choose. Your unsaved edits are still here.
      </p>
    );
  }
  return (
    <p className="integrity-banner__consequence">
      Nothing of yours is unsaved here, so no choice is safer than the others. Emend still won’t
      write to the file until you pick one.
    </p>
  );
}

export function ExternalChangeBanner({
  path,
  state,
  isDirty,
  onReload,
  onKeepMine,
  onCompare,
  onTryAgain,
  onSaveAs,
  keepMineRef,
  platform = isMac ? "mac" : "win",
}: ExternalChangeBannerProps) {
  const busy = state.kind === "reloading" || (state.kind === "failed" && state.retrying);
  const highlightKeepMine = state.kind === "observed" && isDirty;

  return (
    <div
      className="integrity-banner integrity-banner--external-change"
      role="status"
      aria-busy={busy || undefined}
      data-platform={platform}
    >
      <span className="integrity-banner__dot" aria-hidden="true" />
      <div className="integrity-banner__body">
        <p className="integrity-banner__message">{heading(state)}</p>
        <Consequence path={path} state={state} isDirty={isDirty} />
        {state.kind === "failed" && (
          <p className="integrity-banner__failure">
            <b>Couldn’t save the reloaded file.</b> {state.reason} Nothing was lost — the text on
            screen is the disk version.
          </p>
        )}
      </div>
      {state.kind === "reloading" && (
        <span className="integrity-banner__busy-label">Reloading…</span>
      )}
      <div className="integrity-banner__actions">
        {state.kind === "failed" ? (
          <>
            <button
              type="button"
              className="integrity-banner__action integrity-banner__action--default"
              disabled={busy}
              onClick={onTryAgain}
            >
              Try again
            </button>
            <button type="button" className="integrity-banner__action" disabled={busy} onClick={onSaveAs}>
              Save As…
            </button>
            <button type="button" className="integrity-banner__action" disabled={busy} onClick={onCompare}>
              Compare
            </button>
          </>
        ) : (
          <>
            <button type="button" className="integrity-banner__action" disabled={busy} onClick={onReload}>
              Reload
            </button>
            <button
              ref={keepMineRef}
              type="button"
              className={
                highlightKeepMine
                  ? "integrity-banner__action integrity-banner__action--default"
                  : "integrity-banner__action"
              }
              disabled={busy}
              onClick={onKeepMine}
            >
              Keep mine
            </button>
            <button type="button" className="integrity-banner__action" disabled={busy} onClick={onCompare}>
              Compare
            </button>
          </>
        )}
      </div>
    </div>
  );
}
