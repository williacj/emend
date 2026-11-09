// ABOUTME: Turn-12 whole-window fallback for a caught React render failure (J15 / FR-X-5).
// ABOUTME: Owns one focus announcement, one reload control, and one mutually-exclusive status slot.
import { useLayoutEffect, useRef } from "react";
import type { FailureContext } from "./types";

export type FallbackRequestState = "rest" | "pending" | "failed";

export function fallbackCopy(context: FailureContext): { heading: string; body: string } {
  if (context.selector === "reviewer") {
    return {
      heading: "Emend can’t show this review right now.",
      body: "A comment or suggestion that was in progress may not have been sent. Reloading starts this window again from the last review state Emend can restore.",
    };
  }
  if (context.selector === "author-project") {
    const activity = context.runWasActive
      ? " If an agent run was working or waiting for permission, it may still be active; reloading does not stop it or decide the permission request."
      : "";
    return {
      heading: "Emend can’t show this window right now.",
      body: `Your saved documents are still in the project folder. Emend can’t confirm from this screen whether every unsaved edit was kept.${activity} Reloading starts this window again from the last state Emend can restore.`,
    };
  }
  if (context.selector === "author-no-project") {
    return {
      heading: "Emend can’t show this window right now.",
      body: "No project is open in this window. Reloading starts Emend again.",
    };
  }
  return {
    heading: "Emend can’t show this window right now.",
    body: "Reloading starts Emend again.",
  };
}

function ordinaryList(clauses: string[]): string {
  const first = `${clauses[0][0].toUpperCase()}${clauses[0].slice(1)}`;
  if (clauses.length === 1) return first;
  if (clauses.length === 2) return `${first}, and ${clauses[1]}`;
  return `${[first, ...clauses.slice(1, -1)].join(", ")}, and ${clauses[clauses.length - 1]}`;
}

export function assembleCloseRefusal(
  mode: "author",
  guards: { dirty: boolean; untitled: boolean; run: boolean },
): string;
export function assembleCloseRefusal(mode: "reviewer", guards: { draft: boolean }): string;
export function assembleCloseRefusal(
  mode: "author" | "reviewer",
  guards: { dirty?: boolean; untitled?: boolean; run?: boolean; draft?: boolean },
): string {
  if (mode === "reviewer") {
    return "Emend can’t close this review yet. A comment or suggestion may not have been sent. Reload the window to get the ordinary controls back.";
  }
  const clauses = [
    guards.dirty ? "There’s unsaved work" : null,
    guards.untitled ? "an untitled document is open" : null,
    guards.run ? "an agent run may still be active" : null,
  ].filter((clause): clause is string => clause !== null);
  return `Emend can’t close this window yet. ${ordinaryList(clauses)}. Reload the window to get the ordinary controls back.`;
}

export type FallbackCloseDecision =
  | { action: "destroy" }
  | { action: "refuse"; reason: string };

export function decideFallbackClose(
  context: FailureContext,
  runProjection: "unknown" | "idle" | "active-or-awaiting",
): FallbackCloseDecision {
  if (context.selector === "reviewer") {
    return context.closeGuards.reviewerDraft
      ? { action: "refuse", reason: assembleCloseRefusal("reviewer", { draft: true }) }
      : { action: "destroy" };
  }
  const run = runProjection === "active-or-awaiting"
    || (runProjection === "unknown" && context.selector === "author-project");
  if (!context.closeGuards.dirty && !context.closeGuards.untitled && !run) {
    return { action: "destroy" };
  }
  return {
    action: "refuse",
    reason: assembleCloseRefusal("author", {
      dirty: context.closeGuards.dirty,
      untitled: context.closeGuards.untitled,
      run,
    }),
  };
}

export function RenderFailureFallback({
  context,
  requestState,
  closeRefusal,
  platform,
  instanceId,
  visible,
  onReload,
}: {
  context: FailureContext;
  requestState: FallbackRequestState;
  closeRefusal: string | null;
  platform: "win" | "mac";
  instanceId: number;
  visible: boolean;
  onReload(): void;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const copy = fallbackCopy(context);
  useLayoutEffect(() => {
    if (!visible || focused.current) return;
    focused.current = true;
    mainRef.current?.focus();
  }, [visible]);
  const status = closeRefusal ?? (requestState === "failed"
    ? "Emend couldn’t reload this window. Try again."
    : null);

  return (
    <main
      id={`render-failure-${instanceId}`}
      ref={mainRef}
      className="render-failure"
      data-platform={platform}
      tabIndex={-1}
      aria-labelledby={`render-failure-heading-${instanceId}`}
      aria-describedby={`render-failure-body-${instanceId}`}
    >
      <h1 id={`render-failure-heading-${instanceId}`}>{copy.heading}</h1>
      <p id={`render-failure-body-${instanceId}`}>{copy.body}</p>
      <div className="render-failure__action">
        <button
          type="button"
          aria-disabled={requestState === "pending"}
          onClick={() => requestState !== "pending" && onReload()}
        >
          {requestState === "pending" ? "Reloading window…" : "Reload window"}
        </button>
        {status && (
          <p
            className={closeRefusal ? "render-failure__status" : "render-failure__status render-failure__status--error"}
            role="status"
            aria-atomic="true"
          >
            {status}
          </p>
        )}
      </div>
    </main>
  );
}
