// ABOUTME: Renders J9 project-open progress and outcomes in Cowrite's shared one-line status region.
// ABOUTME: Owns contextual action order, retry-pending semantics, and the status controls' DOM boundary.
import { forwardRef, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import {
  projectOpenStatusMessageParts,
  type ProjectOpenStatus,
} from "./stores/projectOpenStatus";

export interface ProjectOpenStatusRegionProps {
  platform?: "win" | "mac";
  status: ProjectOpenStatus;
  onRetry?: (root: string) => void;
  onShowRun?: (runId: string) => void;
  onDismiss?: () => void;
}

function StatusMessage({ status }: { status: ProjectOpenStatus }) {
  const { prefix, name, suffix, queue, detail } = projectOpenStatusMessageParts(status);
  const nameRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const measureName = () => {
      const element = nameRef.current;
      if (!element || cancelled) return;
      const message = element.parentElement;
      if (!message) return;
      message.style.setProperty("--project-open-name-floor", "0px");
      const naturalWidth = element.scrollWidth;
      message.style.setProperty("--project-open-name-floor", `${Math.min(160, naturalWidth)}px`);
    };
    measureName();
    void document.fonts?.ready.then(measureName);
    return () => { cancelled = true; };
  }, [name]);

  return (
    <p className="shell-status__message">
      <span className="project-open-status__fixed">{prefix}</span>
      <span ref={nameRef} className="project-open-status__name">{name}</span>
      <span className="project-open-status__fixed">{suffix}</span>
      {queue && <span className="project-open-status__queue">{queue}</span>}
      {detail && <span className="project-open-status__detail"> {detail}</span>}
    </p>
  );
}

export const ProjectOpenStatusRegion = forwardRef<HTMLDivElement, ProjectOpenStatusRegionProps>(
  function ProjectOpenStatusRegion({
    platform = "win",
    status,
    onRetry,
    onShowRun,
    onDismiss,
  }, ref) {
    const failed = status.phase === "finished" && status.outcome.status === "failed";
    const retryPending = failed && status.retryPending;
    return (
      <div
        ref={ref}
        className="shell-status shell-status--project-open"
        data-platform={platform}
        role="status"
        aria-atomic="true"
        aria-live="polite"
        aria-busy={retryPending || undefined}
      >
        <StatusMessage status={status} />
        <div className="shell-status__actions">
          {failed && (
            <button
              type="button"
              className="shell-status__action"
              aria-disabled={retryPending || undefined}
              aria-label={retryPending ? "Trying…" : "Try again"}
              onClick={() => {
                if (!retryPending) onRetry?.(status.outcome.root);
              }}
            >
              {retryPending ? "Trying…" : "Try again"}
            </button>
          )}
          {status.phase === "close_blocked" && (
            <button
              type="button"
              className="shell-status__action"
              aria-label="Show the run"
              onClick={() => onShowRun?.(status.runId)}
            >
              Show the run
            </button>
          )}
          <button
            type="button"
            className="shell-status__dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  },
);
