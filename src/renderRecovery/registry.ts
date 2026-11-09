// ABOUTME: App-scoped external store for immutable, attempt-owned render-recovery facts (TD-28).
// ABOUTME: Capture is side-effect-free; release is token-idempotent and forgets failed owners.
import { createSessionEffectGate, type SessionEffectGate } from "./sessionEffectGate";
import {
  EMPTY_FAILURE_CONTEXT,
  type FailureContext,
  type RecoveryAttemptToken,
  type RecoveryPhase,
} from "./types";

interface AttemptRecord {
  context: FailureContext;
  gate: SessionEffectGate;
  ordinaryClose: (() => void | Promise<void>) | null;
  released: Promise<void> | null;
}

function freezeContext(context: FailureContext): FailureContext {
  return Object.freeze({
    selector: context.selector,
    runWasActive: context.runWasActive,
    closeGuards: Object.freeze({ ...context.closeGuards }),
  });
}

export interface RenderRecoveryRegistry {
  createAttempt(phase: RecoveryPhase): RecoveryAttemptToken;
  publish(token: RecoveryAttemptToken, context: FailureContext): void;
  patch(token: RecoveryAttemptToken, patch: Partial<FailureContext>): void;
  capture(token: RecoveryAttemptToken): FailureContext;
  gate(token: RecoveryAttemptToken): SessionEffectGate;
  registerRelease(token: RecoveryAttemptToken, release: () => void | Promise<void>): void;
  registerOrdinaryClose(token: RecoveryAttemptToken, close: (() => void | Promise<void>) | null): void;
  ordinaryClose(token: RecoveryAttemptToken): (() => void | Promise<void>) | null;
  release(token: RecoveryAttemptToken): Promise<void>;
}

export function createRenderRecoveryRegistry(): RenderRecoveryRegistry {
  let nextId = 0;
  const records = new Map<number, AttemptRecord>();
  const releases = new Map<number, Array<() => void | Promise<void>>>();
  return {
    createAttempt(phase) {
      const token = Object.freeze({ id: ++nextId, phase });
      records.set(token.id, {
        context: EMPTY_FAILURE_CONTEXT,
        gate: createSessionEffectGate(phase === "initial" ? "ordinary" : "candidate"),
        ordinaryClose: null,
        released: null,
      });
      return token;
    },
    publish(token, context) {
      const record = records.get(token.id);
      if (record && !record.released) record.context = freezeContext(context);
    },
    patch(token, patch) {
      const record = records.get(token.id);
      if (!record || record.released) return;
      record.context = freezeContext({
        ...record.context,
        ...patch,
        closeGuards: patch.closeGuards ?? record.context.closeGuards,
      });
    },
    capture(token) {
      return records.get(token.id)?.context ?? EMPTY_FAILURE_CONTEXT;
    },
    gate(token) {
      const record = records.get(token.id);
      if (!record) throw new Error("render-recovery attempt is no longer registered");
      return record.gate;
    },
    registerRelease(token, release) {
      if (!records.has(token.id)) return;
      const owned = releases.get(token.id) ?? [];
      owned.push(release);
      releases.set(token.id, owned);
    },
    registerOrdinaryClose(token, close) {
      const record = records.get(token.id);
      if (record && !record.released) record.ordinaryClose = close;
    },
    ordinaryClose(token) {
      return records.get(token.id)?.ordinaryClose ?? null;
    },
    release(token) {
      const record = records.get(token.id);
      if (!record) return Promise.resolve();
      if (!record.released) {
        record.ordinaryClose = null;
        const callbacks = releases.get(token.id) ?? [];
        releases.delete(token.id);
        record.released = Promise.all([
          record.gate.release(),
          ...callbacks.map(async (callback) => callback()),
        ]).then(() => undefined).finally(() => records.delete(token.id));
      }
      return record.released;
    },
  };
}
