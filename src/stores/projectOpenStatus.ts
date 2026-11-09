// ABOUTME: Pure J9 display fold for backend-owned project-routing notices and terminal outcomes.
// ABOUTME: Keeps exact status copy, request identity, failure-route honesty, and dismissal rules typed.
import type {
  ProjectRouteFailure,
  ProjectRouteOutcome,
  ProjectRoutingNotice,
} from "./project";

type NonAdoptedOutcome = Exclude<ProjectRouteOutcome, { status: "adopted_here" }>;

export function focusProjectOpenRecoveryTarget(
  recordedTarget: HTMLElement | null | undefined,
  fallbackTarget: HTMLElement | null | undefined,
): boolean {
  for (const target of [recordedTarget, fallbackTarget]) {
    if (!target?.isConnected) continue;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return true;
  }
  return false;
}

export type ProjectOpenStatus =
  | Readonly<{
      phase: "requesting";
      requestId: string;
      root: string;
      queued: number;
    }>
  | Readonly<{
      phase: "finished";
      requestId: string;
      outcome: NonAdoptedOutcome;
      retryPending: boolean;
    }>
  | Readonly<{
      phase: "close_blocked";
      root: string;
      runId: string;
    }>;

export const PROJECT_OPEN_FAILURE_DETAILS: Readonly<Record<ProjectRouteFailure, string>> = {
  project_unavailable: "That folder isn’t available to Emend.",
  open_failed: "Emend couldn’t finish setting up that project.",
  deadline_expired: "It took too long, so Emend stopped waiting.",
  registry_unavailable: "Emend couldn’t keep track of its open windows.",
  launch_failed: "The new window didn’t start.",
  owner_unavailable: "The window that has it isn’t responding.",
  activation_refused: "The system wouldn’t bring that window to the front.",
};

export function projectName(root: string): string {
  const withoutTrailingSeparators = root.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.split(/[\\/]/).pop() || root;
}

export interface ProjectOpenStatusMessageParts {
  prefix: string;
  name: string;
  suffix: string;
  queue?: string;
  detail?: string;
}

export function projectOpenStatusMessageParts(
  status: ProjectOpenStatus,
): ProjectOpenStatusMessageParts {
  const name = projectName(status.phase === "finished" ? status.outcome.root : status.root);
  if (status.phase === "requesting") {
    return {
      prefix: "Opening ",
      name,
      suffix: "…",
      queue: status.queued > 0 ? ` · ${status.queued} more queued` : undefined,
    };
  }
  if (status.phase === "close_blocked") {
    return { prefix: "Emend can’t close ", name, suffix: " while a run is in progress." };
  }
  switch (status.outcome.status) {
    case "already_open_here":
      return { prefix: "", name, suffix: " is already open in this window." };
    case "focused_other":
      return { prefix: "", name, suffix: " is open in another window — brought it to the front." };
    case "opened_new":
      return { prefix: "Opened ", name, suffix: " in a new window." };
    case "failed": {
      const prefix = status.outcome.failureRoute === "raise"
        ? "Emend couldn’t bring "
        : "Emend couldn’t open ";
      const suffix = status.outcome.failureRoute === "launch"
        ? " in a new window."
        : status.outcome.failureRoute === "raise" ? " to the front." : ".";
      return {
        prefix,
        name,
        suffix,
        detail: PROJECT_OPEN_FAILURE_DETAILS[status.outcome.reason],
      };
    }
  }
}

export function projectOpenStatusMessage(status: ProjectOpenStatus): string {
  const { prefix, name, suffix, queue, detail } = projectOpenStatusMessageParts(status);
  return `${prefix}${name}${suffix}${queue ?? ""}${detail ? ` ${detail}` : ""}`;
}

export function reduceProjectOpenStatus(
  current: ProjectOpenStatus | null,
  notice: ProjectRoutingNotice,
): ProjectOpenStatus | null {
  let next: ProjectOpenStatus | null;
  if (notice.status === "requesting") {
    next = {
      phase: "requesting",
      requestId: notice.request_id,
      root: notice.root,
      queued: notice.queued,
    };
  } else if (notice.outcome.status === "adopted_here") {
    next = null;
  } else {
    next = {
      phase: "finished",
      requestId: notice.request_id,
      outcome: notice.outcome,
      retryPending: false,
    };
  }
  if (current !== null && next !== null && projectOpenStatusMessage(current) === projectOpenStatusMessage(next)) {
    return current;
  }
  return next;
}

export function markProjectOpenRetryPending(status: ProjectOpenStatus): ProjectOpenStatus {
  if (status.phase !== "finished" || status.outcome.status !== "failed" || status.retryPending) {
    return status;
  }
  return { ...status, retryPending: true };
}
