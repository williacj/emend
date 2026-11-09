// ABOUTME: App-lifetime TD-28 supervisor outside StrictMode, surviving every product-tree attempt.
// ABOUTME: Owns whole-window fallback, guarded close, run truth, diagnostics, and bounded remounts.
import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import App from "../App";
import { WindowChrome } from "../WindowChrome";
import { isMac } from "../editor/keymap";
import { destroyWindow, installNativeCloseRouter } from "../stores/appLifecycle";
import { getRunState, listenToAgentActivity, type RunQueueState } from "../timeline/agentActivity";
import type { AgentRunCardStatus } from "../timeline/types";
import { testHarness } from "../testHarness";
import { RenderRecoveryAttemptContext } from "./context";
import { reportRenderFailure, republishRuntimeError } from "./diagnostics";
import {
  decideFallbackClose,
  RenderFailureFallback,
  type FallbackRequestState,
} from "./RenderFailureFallback";
import { createRenderRecoveryRegistry, type RenderRecoveryRegistry } from "./registry";
import { recoveryReducer } from "./reducer";
import { EMPTY_FAILURE_CONTEXT, type FailureContext, type RecoveryAttemptToken } from "./types";

type RunProjection = "unknown" | "idle" | "active-or-awaiting";
type RecoveryTimer = ReturnType<typeof setTimeout>;

const scheduleDefaultTimeout = (callback: () => void, delayMs: number): RecoveryTimer => (
  setTimeout(callback, delayMs)
);
const cancelDefaultTimeout = (timer: RecoveryTimer): void => clearTimeout(timer);

export interface RenderAppArgs {
  token: RecoveryAttemptToken;
  phase: RecoveryAttemptToken["phase"];
  ready(): void;
  failed(): void;
}

interface AttemptModel {
  token: RecoveryAttemptToken;
  shown: boolean;
  caught: boolean;
  context: FailureContext | null;
  requestState: FallbackRequestState;
  closeRefusal: string | null;
}

interface BoundaryProps {
  children: ReactNode;
  onCaught(context: FailureContext, error: unknown): void;
  renderFallback(context: FailureContext): ReactNode;
}

interface BoundaryState {
  context: FailureContext | null;
}

function createAttemptBoundary(registry: RenderRecoveryRegistry, token: RecoveryAttemptToken) {
  return class AttemptBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { context: null };

    static getDerivedStateFromError(_error: unknown): BoundaryState {
      return { context: registry.capture(token) };
    }

    componentDidCatch(error: unknown, _info: ErrorInfo): void {
      this.props.onCaught(this.state.context ?? EMPTY_FAILURE_CONTEXT, error);
    }

    render(): ReactNode {
      return this.state.context
        ? this.props.renderFallback(this.state.context)
        : this.props.children;
    }
  };
}

function Attempt({
  model,
  registry,
  renderApp,
  onReady,
  onAttemptFailure,
  onCaught,
  onReload,
  platform,
  forceFailure,
}: {
  model: AttemptModel;
  registry: RenderRecoveryRegistry;
  renderApp(args: RenderAppArgs): ReactNode;
  onReady(token: RecoveryAttemptToken): void;
  onAttemptFailure(token: RecoveryAttemptToken): void;
  onCaught(token: RecoveryAttemptToken, context: FailureContext, error: unknown): void;
  onReload(token: RecoveryAttemptToken): void;
  platform: "win" | "mac";
  forceFailure: boolean;
}) {
  const Boundary = useMemo(
    () => createAttemptBoundary(registry, model.token),
    [registry, model.token],
  );
  const ready = useCallback(() => onReady(model.token), [model.token, onReady]);
  const failed = useCallback(
    () => onAttemptFailure(model.token),
    [model.token, onAttemptFailure],
  );
  const attempt = useMemo(() => ({
    token: model.token,
    registry,
    sessionGate: registry.gate(model.token),
    ready,
    failed,
  }), [failed, model.token, ready, registry]);
  useEffect(() => () => {
    void registry.release(model.token).catch(() => undefined);
  }, [model.token, registry]);

  return (
    <div
      className={model.caught
        ? "render-recovery-attempt render-recovery-attempt--fallback"
        : "render-recovery-attempt"}
      hidden={!model.shown}
      inert={!model.shown ? true : undefined}
    >
      <Boundary
        onCaught={(context, error) => onCaught(model.token, context, error)}
        renderFallback={(context) => (
          <>
            <WindowChrome platform={platform} title={platform === "win" ? "Cowrite" : ""} />
            <RenderFailureFallback
              context={context}
              requestState={model.requestState}
              closeRefusal={model.closeRefusal}
              platform={platform}
              instanceId={model.token.id}
              visible={model.shown}
              onReload={() => onReload(model.token)}
            />
          </>
        )}
      >
        <RenderRecoveryAttemptContext.Provider value={attempt}>
          <React.StrictMode>
            {forceFailure
              ? <RenderFailureAcceptanceProbe />
              : renderApp({ token: model.token, phase: model.token.phase, ready, failed })}
          </React.StrictMode>
        </RenderRecoveryAttemptContext.Provider>
      </Boundary>
    </div>
  );
}

function RenderFailureAcceptanceProbe(): never {
  throw new Error("D23 render-failure acceptance probe");
}

export function RenderRecoverySupervisor({
  registry: providedRegistry,
  renderApp = () => <App />,
  diagnostic = reportRenderFailure,
  runtimeErrorReporter = republishRuntimeError,
  reloadTimeoutMs = 10_000,
  scheduleTimeout = scheduleDefaultTimeout,
  cancelTimeout = cancelDefaultTimeout,
  platform = isMac ? "mac" : "win",
  getRunProjection = getRunState,
  listenForRunActivity = listenToAgentActivity,
  installCloseRouter = installNativeCloseRouter,
  closeWindow = destroyWindow,
}: {
  registry?: RenderRecoveryRegistry;
  renderApp?: (args: RenderAppArgs) => ReactNode;
  diagnostic?: (phase: RecoveryAttemptToken["phase"]) => Promise<void>;
  runtimeErrorReporter?: (error: unknown) => void;
  reloadTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => RecoveryTimer;
  cancelTimeout?: (timer: RecoveryTimer) => void;
  platform?: "win" | "mac";
  getRunProjection?: () => Promise<RunQueueState>;
  listenForRunActivity?: (
    onStatus: (status: AgentRunCardStatus) => void,
  ) => Promise<() => void>;
  installCloseRouter?: (
    onCloseRequested: () => void | Promise<void>,
  ) => Promise<() => void>;
  closeWindow?: () => Promise<void>;
} = {}) {
  const registry = useMemo(
    () => providedRegistry ?? createRenderRecoveryRegistry(),
    [providedRegistry],
  );
  const [initialToken] = useState(() => registry.createAttempt("initial"));
  const [, dispatch] = useReducer(recoveryReducer, {
    status: "healthy" as const,
    attempt: initialToken.id,
  });
  const [attempts, setAttempts] = useState<AttemptModel[]>([{
    token: initialToken,
    shown: true,
    caught: false,
    context: null,
    requestState: "rest",
    closeRefusal: null,
  }]);
  const [forcedAttempt, setForcedAttempt] = useState<number | null>(null);
  const attemptsRef = useRef(attempts);
  const reloadOwners = useRef(new Set<number>());
  const promotions = useRef(new Set<number>());
  const candidateOwners = useRef(new Map<number, number>());
  const releases = useRef(new Map<number, Promise<void>>());
  const runProjection = useRef<RunProjection>("unknown");
  const timer = useRef<RecoveryTimer | null>(null);
  useEffect(() => { attemptsRef.current = attempts; }, [attempts]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    testHarness.triggerRenderFailure = () => {
      const shown = attemptsRef.current.find((entry) => entry.shown && !entry.caught);
      if (shown) setForcedAttempt(shown.token.id);
    };
    return () => {
      testHarness.triggerRenderFailure = null;
    };
  }, []);

  const clearAttemptTimer = useCallback(() => {
    if (timer.current !== null) cancelTimeout(timer.current);
    timer.current = null;
  }, [cancelTimeout]);

  const refreshRunProjection = useCallback(async () => {
    try {
      const state = await getRunProjection();
      runProjection.current = state.active?.phase.phase === "running" || state.queued.length > 0
        ? "active-or-awaiting"
        : "idle";
      for (const attempt of attemptsRef.current) {
        if (!attempt.caught) {
          registry.patch(attempt.token, { runWasActive: runProjection.current === "active-or-awaiting" });
        }
      }
    } catch {
      runProjection.current = runProjection.current === "active-or-awaiting"
        ? "active-or-awaiting"
        : "unknown";
    }
  }, [getRunProjection, registry]);

  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void refreshRunProjection();
    void listenForRunActivity(() => void refreshRunProjection())
      .then((release) => {
        if (stopped) release();
        else unlisten = release;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [listenForRunActivity, refreshRunProjection]);

  const handleCaught = useCallback((
    token: RecoveryAttemptToken,
    context: FailureContext,
    error: unknown,
  ) => {
    clearAttemptTimer();
    const release = registry.release(token);
    releases.current.set(token.id, release);
    void release.catch(() => undefined);
    try {
      void diagnostic(token.phase).catch(() => undefined);
    } catch {
      // A diagnostic sink can fail only outside the containment path; the fallback still wins.
    }
    try {
      runtimeErrorReporter(error);
    } catch {
      // Runtime re-publication is best effort and must never make the boundary itself fail.
    }
    dispatch({ type: "caught", attempt: token.id });
    const wasHiddenCandidate = candidateOwners.current.has(token.id);
    if (wasHiddenCandidate) candidateOwners.current.delete(token.id);
    setAttempts((current) => {
      return current
        .filter((entry) => !wasHiddenCandidate || entry.token.id === token.id)
        .map((entry) => entry.token.id === token.id
          ? { ...entry, shown: true, caught: true, context, requestState: "rest", closeRefusal: null }
          : entry);
    });
  }, [clearAttemptTimer, diagnostic, registry, runtimeErrorReporter]);

  const handleAttemptFailure = useCallback((candidate: RecoveryAttemptToken) => {
    clearAttemptTimer();
    void registry.release(candidate).catch(() => undefined);
    candidateOwners.current.delete(candidate.id);
    promotions.current.delete(candidate.id);
    dispatch({ type: "attempt-error", attempt: candidate.id });
    setAttempts((current) => current
      .filter((entry) => entry.token.id !== candidate.id)
      .map((entry) => {
        reloadOwners.current.delete(entry.token.id);
        return { ...entry, requestState: "failed" as const, closeRefusal: null };
      }));
  }, [clearAttemptTimer, registry]);

  const handleReload = useCallback((failedToken: RecoveryAttemptToken) => {
    if (reloadOwners.current.has(failedToken.id)
      || attemptsRef.current.some((entry) => !entry.shown)) return;
    const failed = attemptsRef.current.find((entry) => entry.token.id === failedToken.id && entry.caught);
    if (!failed) return;
    reloadOwners.current.add(failedToken.id);
    setAttempts((current) => current.map((entry) => entry.token.id === failedToken.id
      ? { ...entry, requestState: "pending" as const, closeRefusal: null }
      : entry));
    const release = releases.current.get(failedToken.id) ?? registry.release(failedToken);
    releases.current.set(failedToken.id, release);
    void release.then(() => {
      const stillFailed = attemptsRef.current.some((entry) => (
        entry.token.id === failedToken.id && entry.caught
      ));
      if (!stillFailed) return;
      const candidate = registry.createAttempt("remount");
      candidateOwners.current.set(candidate.id, failedToken.id);
      dispatch({ type: "reload", attempt: candidate.id });
      setAttempts((current) => [
        ...current,
        {
          token: candidate,
          shown: false,
          caught: false,
          context: null,
          requestState: "rest",
          closeRefusal: null,
        },
      ]);
      timer.current = scheduleTimeout(() => handleAttemptFailure(candidate), reloadTimeoutMs);
    }).catch(() => {
      reloadOwners.current.delete(failedToken.id);
      setAttempts((current) => current.map((entry) => entry.token.id === failedToken.id
        ? { ...entry, requestState: "failed" as const, closeRefusal: null }
        : entry));
    });
  }, [handleAttemptFailure, registry, reloadTimeoutMs, scheduleTimeout]);

  const handleReady = useCallback((token: RecoveryAttemptToken) => {
    const failedAttempt = candidateOwners.current.get(token.id);
    if (failedAttempt === undefined) return;
    if (promotions.current.has(token.id)) return;
    promotions.current.add(token.id);
    clearAttemptTimer();
    void registry.gate(token).promote().then(() => {
      candidateOwners.current.delete(token.id);
      reloadOwners.current.delete(failedAttempt);
      releases.current.delete(failedAttempt);
      dispatch({ type: "ready", attempt: token.id });
      setAttempts((entries) => entries
        .filter((entry) => entry.token.id === token.id)
        .map((entry) => ({ ...entry, shown: true })));
    }).catch(() => {
      promotions.current.delete(token.id);
      handleAttemptFailure(token);
    });
  }, [clearAttemptTimer, handleAttemptFailure, registry]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void installCloseRouter(async () => {
      const shown = attemptsRef.current.find((entry) => entry.shown);
      if (!shown) return;
      if (!shown.caught) {
        const context = registry.capture(shown.token);
        const delegate = registry.ordinaryClose(shown.token);
        if (context.selector === "author-project") {
          if (delegate) await delegate();
          return;
        }
        await closeWindow();
        return;
      }
      const context = shown.context ?? EMPTY_FAILURE_CONTEXT;
      const decision = decideFallbackClose(context, runProjection.current);
      if (decision.action === "destroy") {
        await closeWindow();
        return;
      }
      setAttempts((current) => current.map((entry) => entry.token.id === shown.token.id
        ? { ...entry, closeRefusal: decision.reason, requestState: entry.requestState === "pending" ? "pending" : "rest" }
        : entry));
      dispatch({ type: "close-result", attempt: shown.token.id });
    }).then((release) => {
      if (cancelled) release();
      else unlisten = release;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [closeWindow, installCloseRouter, registry]);

  useEffect(() => () => clearAttemptTimer(), [clearAttemptTimer]);

  return attempts.map((model) => (
    <Attempt
      key={model.token.id}
      model={model}
      registry={registry}
      renderApp={renderApp}
      onReady={handleReady}
      onAttemptFailure={handleAttemptFailure}
      onCaught={handleCaught}
      onReload={handleReload}
      platform={platform}
      forceFailure={forcedAttempt === model.token.id}
    />
  ));
}
