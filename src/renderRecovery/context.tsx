// ABOUTME: Attempt-token context through which committed product owners publish minimal TD-28 facts.
// ABOUTME: Direct App tests outside the supervisor receive a no-op null context unchanged.
import { createContext, useContext } from "react";
import type { SessionEffectGate } from "./sessionEffectGate";
import type { FailureContext, RecoveryAttemptToken } from "./types";
import type { RenderRecoveryRegistry } from "./registry";

export interface RenderRecoveryAttempt {
  token: RecoveryAttemptToken;
  registry: RenderRecoveryRegistry;
  sessionGate: SessionEffectGate;
  ready(): void;
  failed(): void;
}

export const RenderRecoveryAttemptContext = createContext<RenderRecoveryAttempt | null>(null);

export function useRenderRecoveryAttempt(): RenderRecoveryAttempt | null {
  return useContext(RenderRecoveryAttemptContext);
}

export function publishRecoveryContext(
  attempt: RenderRecoveryAttempt | null,
  context: FailureContext,
): void {
  if (attempt) attempt.registry.publish(attempt.token, context);
}
