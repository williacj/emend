// ABOUTME: Accessible 9c.8 recovery surface for an uncommitted final session write or proof.
// ABOUTME: Keeps risk copy, affected documents, Retry, Stay open, and explicit override together.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SessionWriteFailureDialogProps {
  affectedLabels: string[];
  detail: string;
  baseline: "prior" | "none" | "unknown";
  retrying: boolean;
  onQuitAnyway: () => void;
  onRetry: () => void;
  onStayOpen: () => void;
}

export function SessionWriteFailureDialog({
  affectedLabels,
  detail,
  baseline,
  retrying,
  onQuitAnyway,
  onRetry,
  onStayOpen,
}: SessionWriteFailureDialogProps) {
  const stayOpenRef = useRef<HTMLButtonElement>(null);
  const affectedListRef = useRef<HTMLUListElement>(null);
  const [affectedListOverflows, setAffectedListOverflows] = useState(false);
  const platform = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "mac"
    : "win";
  useEffect(() => stayOpenRef.current?.focus(), [retrying]);
  useLayoutEffect(() => {
    const list = affectedListRef.current;
    setAffectedListOverflows(list !== null && list.scrollHeight > list.clientHeight);
  }, [affectedLabels]);
  const baselineDetail = baseline === "prior"
    ? "Your previous saved session is still intact — if you quit anyway, that older session is what reopens, and it may bring back tabs you closed or earlier versions of what's open now."
    : baseline === "none"
      ? "There is no previous saved session to restore — if you quit anyway, this window reopens empty."
      : "Cowrite couldn't verify a usable previous session — if you quit anyway, what reopens may be incomplete.";

  return (
    <div
      className="session-write-failure"
      data-platform={platform}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-write-failure-title"
      aria-busy={retrying}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !retrying) {
          event.preventDefault();
          onStayOpen();
          return;
        }
        if (event.key !== "Tab") return;
        const focusables = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '.session-write-failure__affected ul[tabindex="0"], button:not(:disabled)',
          ),
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="session-write-failure__card">
        <h2 id="session-write-failure-title">Couldn't save your latest session changes</h2>
        <p>
          Cowrite couldn't save your latest session changes. {affectedLabels.length === 0
            ? "Your latest tab layout and session state may not return if you quit now."
            : affectedLabels.length === 1
              ? <>Changes to <strong>{affectedLabels[0]}</strong> may not return if you quit now.</>
              : <>Changes to <strong>{affectedLabels.length} untitled documents</strong> may not return if you quit now.</>}
        </p>
        {affectedLabels.length >= 2 && (
          <div className="session-write-failure__affected">
            <div>AFFECTED DOCUMENTS ({affectedLabels.length})</div>
            <ul ref={affectedListRef} tabIndex={affectedListOverflows ? 0 : undefined}>
              {affectedLabels.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </div>
        )}
        <p className="session-write-failure__reason">
          {detail || "Cowrite couldn't verify why the session write failed"}. No new session was committed. {baselineDetail}
        </p>
        <div className="session-write-failure__actions">
          <button type="button" className="session-write-failure__quit" disabled={retrying} onClick={onQuitAnyway}>Quit anyway</button>
          <button type="button" disabled={retrying} onClick={onRetry}>Try again</button>
          <button ref={stayOpenRef} type="button" className="session-write-failure__stay" disabled={retrying} onClick={onStayOpen}>Stay open</button>
        </div>
      </div>
    </div>
  );
}
