// ABOUTME: Closed TD-28 types shared by the render-recovery supervisor, boundary, and adapters.
// ABOUTME: They intentionally carry booleans/selectors only, never failed-tree data or raw errors.
export type RecoveryPhase = "initial" | "remount";
export type RecoveryContextSelector =
  | "unestablished"
  | "author-project"
  | "author-no-project"
  | "reviewer";

export interface CloseGuardFacts {
  dirty: boolean;
  untitled: boolean;
  reviewerDraft: boolean;
}

export interface FailureContext {
  selector: RecoveryContextSelector;
  runWasActive: boolean;
  // @anchor:render-recovery-close-guards
  closeGuards: CloseGuardFacts;
}

export interface RecoveryAttemptToken {
  readonly id: number;
  readonly phase: RecoveryPhase;
}

export const EMPTY_FAILURE_CONTEXT: FailureContext = Object.freeze({
  selector: "unestablished",
  runWasActive: false,
  closeGuards: Object.freeze({ dirty: false, untitled: false, reviewerDraft: false }),
});
