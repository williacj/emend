// ABOUTME: App-scoped owner for Emend's single shell status slot, including TD-25's
// ABOUTME: unattributed-rejection priority, message identity, dismissal memory, and subscriptions.

export type AppStatusAudience = "author" | "reviewer";
export type UnsupportedRestoreRefusal = Readonly<{
  kind: "unsupported-restore-refusal";
  path: string;
  outcome: "closed" | "omitted";
}>;
export type AppStatusSnapshot = Readonly<{
  provenance: "user" | "unattributed";
  authorMessage: string;
  reviewerMessage: string;
  presentation?: UnsupportedRestoreRefusal;
}> | null;
export type OwnedUserAppStatus = Readonly<{
  provenance: "user";
  authorMessage: string;
  reviewerMessage: string;
}>;

const UNATTRIBUTED_FAILURE_COPY =
  "Something inside Emend didn’t finish. If something doesn’t look right, this may be why.";

let snapshot: AppStatusSnapshot = null;
let audience: AppStatusAudience = "author";
let dismissedMessage: string | null = null;
const listeners = new Set<() => void>();

function emit(next: AppStatusSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function displayedMessage(status: NonNullable<AppStatusSnapshot>): string {
  return audience === "reviewer" ? status.reviewerMessage : status.authorMessage;
}

function rejectionDetail(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  ) {
    return reason.message;
  }
  return "";
}

export function getAppStatus(): AppStatusSnapshot {
  return snapshot;
}

export function subscribeAppStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAppStatusAudience(nextAudience: AppStatusAudience) {
  audience = nextAudience;
}

export function publishUnhandledRejection(reason: unknown) {
  if (snapshot?.provenance === "user") return;

  const detail = rejectionDetail(reason);
  const authorMessage = `${UNATTRIBUTED_FAILURE_COPY}${detail ? ` ${detail}` : ""}`;
  const next = {
    provenance: "unattributed" as const,
    authorMessage,
    reviewerMessage: UNATTRIBUTED_FAILURE_COPY,
  };
  const message = displayedMessage(next);

  if (message === dismissedMessage) return;
  if (dismissedMessage !== null) dismissedMessage = null;
  if (snapshot?.provenance === "unattributed" && displayedMessage(snapshot) === message) return;
  emit(next);
}

export function setUserAppStatus(message: string | null, presentation?: UnsupportedRestoreRefusal) {
  if (message === null) {
    if (snapshot !== null) emit(null);
    return;
  }
  if (dismissedMessage !== null && dismissedMessage !== message) dismissedMessage = null;
  if (snapshot?.provenance === "user" && snapshot.authorMessage === message) return;
  emit({ provenance: "user", authorMessage: message, reviewerMessage: message, ...(presentation && { presentation }) });
}

/** Publishes a requested-action status with a unique identity its owner may compare-and-clear. */
export function setOwnedUserAppStatus(message: string): OwnedUserAppStatus {
  if (dismissedMessage !== null && dismissedMessage !== message) dismissedMessage = null;
  const owned = { provenance: "user" as const, authorMessage: message, reviewerMessage: message };
  emit(owned);
  return owned;
}

/** Clears only the exact publication the caller owns; a newer status always wins. */
export function clearOwnedUserAppStatus(owned: OwnedUserAppStatus) {
  if (snapshot === owned) emit(null);
}

// @anchor:begin-app-status-request
export function beginAppStatusRequest() {
  dismissedMessage = null;
  if (snapshot !== null) emit(null);
}

export function dismissAppStatus() {
  if (snapshot === null) return;
  if (snapshot.provenance === "unattributed") dismissedMessage = displayedMessage(snapshot);
  emit(null);
}
