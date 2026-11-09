// ABOUTME: Pure TD-28 recovery state machine for caught, reload, ready, failure, timeout, and close.
// ABOUTME: Attempt identities fence duplicate and late callbacks without retaining failed trees.
export type RecoveryState =
  | { status: "healthy"; attempt: number }
  | { status: "failed"; attempt: number }
  | { status: "reloading"; attempt: number; failedAttempt: number };

export type RecoveryAction =
  | { type: "caught"; attempt: number }
  | { type: "reload"; attempt: number }
  | { type: "ready"; attempt: number }
  | { type: "attempt-error"; attempt: number }
  | { type: "timeout"; attempt: number }
  | { type: "close-result"; attempt: number };

export function recoveryReducer(state: RecoveryState, action: RecoveryAction): RecoveryState {
  if (action.type === "caught") {
    if (state.status === "reloading" && state.attempt === action.attempt) {
      return { status: "failed", attempt: action.attempt };
    }
    if (state.status === "healthy" && state.attempt === action.attempt) {
      return { status: "failed", attempt: action.attempt };
    }
    return state;
  }
  if (action.type === "reload") {
    return state.status === "failed"
      ? { status: "reloading", attempt: action.attempt, failedAttempt: state.attempt }
      : state;
  }
  if (action.type === "ready") {
    return state.status === "reloading" && state.attempt === action.attempt
      ? { status: "healthy", attempt: action.attempt }
      : state;
  }
  if (action.type === "attempt-error" || action.type === "timeout") {
    return state.status === "reloading" && state.attempt === action.attempt
      ? { status: "failed", attempt: state.failedAttempt }
      : state;
  }
  return state;
}
