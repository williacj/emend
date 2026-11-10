// ABOUTME: Frontend IPC for J7 permission requests and decisions on a live agent run.
// ABOUTME: Uses the shared native/D23 event bridge; request state stays session-only in the UI.
import { callBackend } from "../backend";
import { listenForBackendEvent } from "../stores/driverEvents";

/** Mirrors Rust `agent::permission::PermissionRequest`'s camelCase wire shape. */
export interface PermissionRequest {
  id: string;
  action: string;
  detail: string;
  why: string;
  requestedAtMs: number;
  allowExactCommand: boolean;
  allowScript: boolean;
}

/** One project-scoped snapshot. Revisions increase whenever its request queue changes. */
export interface PermissionState {
  projectId: string | null;
  runId: string | null;
  revision: number;
  requests: PermissionRequest[];
}

/** Mirrors Rust `agent::permission::PermissionDecision`'s tagged snake_case variants. */
export type PermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_exact_command" }
  | { kind: "allow_script" }
  | { kind: "deny"; reason: string };

/** Mirrors Rust `commands::agent::PERMISSION_EVENT`. */
export const PERMISSION_EVENT = "emend://agent/permission";

export function getPermissionState(): Promise<PermissionState> {
  return callBackend<PermissionState>("permission_state", {});
}

export function listenToPermissionState(
  handler: (state: PermissionState) => void,
): Promise<() => void> {
  return listenForBackendEvent(PERMISSION_EVENT, handler);
}

export function decidePermission(
  runId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  return callBackend<void>("decide_permission", { runId, requestId, decision });
}
