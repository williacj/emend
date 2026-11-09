// ABOUTME: Public render-recovery composition and testable TD-28 contracts.
// ABOUTME: Keeps the app root, recovery adapters, and pure helpers behind one module boundary.
export { useRenderRecoveryAttempt } from "./context";
export {
  RenderFailureFallback,
  assembleCloseRefusal,
  decideFallbackClose,
  fallbackCopy,
} from "./RenderFailureFallback";
export { RenderRecoverySupervisor, type RenderAppArgs } from "./RenderRecoverySupervisor";
export { createRenderRecoveryRegistry, type RenderRecoveryRegistry } from "./registry";
export { recoveryReducer, type RecoveryAction, type RecoveryState } from "./reducer";
export type {
  CloseGuardFacts,
  FailureContext,
  RecoveryAttemptToken,
  RecoveryContextSelector,
  RecoveryPhase,
} from "./types";
