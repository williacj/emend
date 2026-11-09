// @vitest-environment jsdom
// ABOUTME: Pins TD-28/J15 whole-window render containment, copy, focus, and guarded recovery.
// ABOUTME: Exercises the real React error boundary plus pure close/reload transition contracts.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppStatus, setOwnedUserAppStatus, setUserAppStatus } from "../stores/appStatus";
import {
  RenderRecoverySupervisor,
  assembleCloseRefusal,
  createRenderRecoveryRegistry,
  decideFallbackClose,
  recoveryReducer,
  type FailureContext,
} from ".";

const CONTEXTS: FailureContext[] = [
  {
    selector: "author-project",
    runWasActive: true,
    closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
  },
  {
    selector: "author-project",
    runWasActive: false,
    closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
  },
  {
    selector: "author-no-project",
    runWasActive: false,
    closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
  },
  {
    selector: "reviewer",
    runWasActive: false,
    closeGuards: { dirty: false, untitled: false, reviewerDraft: true },
  },
  {
    selector: "unestablished",
    runWasActive: false,
    closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
  },
];

function ThrowNow(): never {
  throw new Error("ghp_abc123 AcquisitionPlan /private/draft.md");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setUserAppStatus(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("render recovery contracts (TD-28 / J15)", () => {
  it("reducer fences duplicate reloads and stale callbacks", () => {
    const failed = recoveryReducer({ status: "healthy", attempt: 1 }, { type: "caught", attempt: 1 });
    const pending = recoveryReducer(failed, { type: "reload", attempt: 2 });
    expect(recoveryReducer(pending, { type: "reload", attempt: 3 })).toEqual(pending);
    expect(recoveryReducer(pending, { type: "ready", attempt: 99 })).toEqual(pending);
    expect(recoveryReducer(pending, { type: "timeout", attempt: 2 })).toEqual({
      status: "failed",
      attempt: 1,
    });
  });

  it("captures immutable committed facts without writing or releasing during capture", () => {
    const registry = createRenderRecoveryRegistry();
    const token = registry.createAttempt("initial");
    const release = vi.fn();
    registry.publish(token, CONTEXTS[0]);
    registry.registerRelease(token, release);

    const captured = registry.capture(token);
    expect(captured).toEqual(CONTEXTS[0]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    registry.publish(token, CONTEXTS[2]);
    expect(captured).toEqual(CONTEXTS[0]);
  });

  it("replaces a real throwing tree with neutral copy, no raw detail, and one focus move", async () => {
    const diagnostic = vi.fn().mockResolvedValue(undefined);
    const runtimeError = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <RenderRecoverySupervisor
        diagnostic={diagnostic}
        runtimeErrorReporter={runtimeError}
        renderApp={() => <ThrowNow />}
      />,
    );

    const fallback = await screen.findByRole("main", {
      name: "Emend can’t show this window right now.",
    });
    expect(fallback).toHaveTextContent("Reloading starts Emend again.");
    expect(fallback, "fallback must not render caller-selected ghp_abc123")
      .not.toHaveTextContent("ghp_abc123");
    expect(fallback).not.toHaveTextContent("AcquisitionPlan");
    expect(fallback).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith("initial");
    expect(runtimeError).toHaveBeenCalledWith(expect.any(Error));
    focus.mockRestore();
  });

  it("renders exact mode-safe copy for $selector", async () => {
    for (const context of CONTEXTS) {
      const registry = createRenderRecoveryRegistry();
      const mounted = render(
        <RenderRecoverySupervisor
          registry={registry}
          diagnostic={() => Promise.resolve()}
          runtimeErrorReporter={() => {}}
          renderApp={({ token }) => {
            registry.publish(token, context);
            return <ThrowNow />;
          }}
        />,
      );
      const main = await screen.findByRole("main");
      if (context.selector === "reviewer") {
        expect(main).toHaveAccessibleName("Emend can’t show this review right now.");
        expect(main).toHaveTextContent("A comment or suggestion that was in progress may not have been sent.");
      } else if (context.selector === "author-project") {
        expect(main).toHaveTextContent("Your saved documents are still in the project folder.");
        expect(main).toHaveTextContent(
          context.runWasActive ? "it may still be active" : "Emend can’t confirm from this screen",
        );
        if (!context.runWasActive) expect(main).not.toHaveTextContent("it may still be active");
      } else if (context.selector === "author-no-project") {
        expect(main).toHaveTextContent("No project is open in this window.");
      } else {
        expect(main).toHaveTextContent("Reloading starts Emend again.");
        expect(main).not.toHaveTextContent("project");
      }
      mounted.unmount();
    }
  });

  it("joins duplicate reload activation and keeps fallback visible until candidate readiness", async () => {
    let renderCount = 0;
    const installCloseRouter = vi.fn(async () => () => {});
    function Candidate({ ready }: { ready(): void }) {
      return <button onClick={ready}>ordinary shell restored</button>;
    }
    render(
      <RenderRecoverySupervisor
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        installCloseRouter={installCloseRouter}
        renderApp={({ phase, ready }) => {
          renderCount += 1;
          return phase === "initial" ? <ThrowNow /> : <Candidate ready={ready} />;
        }}
      />,
    );
    const reload = await screen.findByRole("button", { name: "Reload window" });
    fireEvent.click(reload);
    fireEvent.click(reload);
    expect(screen.getByRole("button", { name: "Reloading window…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(await screen.findByText("ordinary shell restored"));
    await waitFor(() => expect(screen.getByText("ordinary shell restored")).toBeVisible());
    expect(renderCount).toBeGreaterThan(1);
    expect(installCloseRouter).toHaveBeenCalledTimes(1);
  });

  it("finishes failed-attempt release before mounting the candidate", async () => {
    let finishRelease: (() => void) | undefined;
    const released = new Promise<void>((resolve) => { finishRelease = resolve; });
    const registry = createRenderRecoveryRegistry();
    let candidateRenders = 0;
    function CommitThenThrow({ token }: { token: { id: number; phase: "initial" | "remount" } }) {
      const [broken, setBroken] = useState(false);
      useEffect(() => {
        registry.registerRelease(token, () => released);
        setBroken(true);
      }, [token]);
      if (broken) return <ThrowNow />;
      return <p>ordinary shell</p>;
    }
    render(
      <RenderRecoverySupervisor
        registry={registry}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        renderApp={({ token, phase, ready }) => {
          if (phase === "initial") return <CommitThenThrow token={token} />;
          candidateRenders += 1;
          return <button onClick={ready}>candidate ready</button>;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reload window" }));
    expect(screen.getByRole("button", { name: "Reloading window…" })).toBeInTheDocument();
    expect(candidateRenders).toBe(0);

    finishRelease?.();
    await waitFor(() => expect(candidateRenders).toBeGreaterThan(0));
  });

  it("creates a fresh fallback and runtime report when the candidate also throws", async () => {
    const diagnostic = vi.fn().mockResolvedValue(undefined);
    const runtimeError = vi.fn();
    const nativeFocus = HTMLElement.prototype.focus;
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      // Chromium refuses focus while an ancestor is hidden. Mirror that browser behavior so this
      // assertion distinguishes an attempted hidden focus from a successful post-reveal move.
      if (!this.closest("[hidden]")) nativeFocus.call(this, options);
    });
    render(
      <RenderRecoverySupervisor
        diagnostic={diagnostic}
        runtimeErrorReporter={runtimeError}
        renderApp={() => <ThrowNow />}
      />,
    );
    const initialFallback = await screen.findByRole("main");
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
    await waitFor(() => expect(diagnostic).toHaveBeenCalledWith("remount"));
    expect(runtimeError).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
    const replacementFallback = screen.getByRole("main");
    expect(
      document.activeElement,
      "replacement fallback must receive focus only after reveal",
    ).toBe(replacementFallback);
    expect(replacementFallback.id).not.toBe(initialFallback.id);
    expect(document.getElementById(initialFallback.id)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload window" })).toBeInTheDocument();
  });

  it("keeps the fallback live when either diagnostic sink fails", async () => {
    render(
      <RenderRecoverySupervisor
        diagnostic={() => { throw new Error("diagnostic unavailable"); }}
        runtimeErrorReporter={() => { throw new Error("runtime reporter unavailable"); }}
        renderApp={() => <ThrowNow />}
      />,
    );

    expect(await screen.findByRole("button", { name: "Reload window" })).toBeInTheDocument();
  });

  it("preserves TD-25 user status identity across containment and remount", async () => {
    const owned = setOwnedUserAppStatus("The requested document action failed.");
    render(
      <RenderRecoverySupervisor
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        renderApp={({ phase, ready }) => phase === "initial"
          ? <ThrowNow />
          : <button onClick={ready}>finish candidate</button>}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reload window" }));
    fireEvent.click(await screen.findByText("finish candidate"));
    await waitFor(() => expect(screen.queryByRole("main")).not.toBeInTheDocument());
    expect(getAppStatus()).toBe(owned);
  });

  it("restores the same fallback after bounded noncompletion and ignores late ready", async () => {
    let lateReady: (() => void) | undefined;
    let expire: (() => void) | undefined;
    const scheduleTimeout = vi.fn((callback: () => void) => {
      expire = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    render(
      <RenderRecoverySupervisor
        reloadTimeoutMs={20}
        scheduleTimeout={scheduleTimeout}
        cancelTimeout={() => {}}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        renderApp={({ phase, ready }) => {
          if (phase === "initial") return <ThrowNow />;
          lateReady = ready;
          return <p>hidden candidate</p>;
        }}
      />,
    );
    const reload = await screen.findByRole("button", { name: "Reload window" });
    fireEvent.click(reload);
    await waitFor(() => expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 20));
    await act(async () => expire?.());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Emend couldn’t reload this window. Try again.",
    );
    act(() => lateReady?.());
    expect(screen.queryByText("hidden candidate")).not.toBeInTheDocument();
  });

  it("returns the existing fallback to failed immediately when candidate setup rejects", async () => {
    render(
      <RenderRecoverySupervisor
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        renderApp={({ phase, failed }) => phase === "initial"
          ? <ThrowNow />
          : <button onClick={failed}>reject candidate setup</button>}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reload window" }));
    fireEvent.click(await screen.findByRole("button", { name: "reject candidate setup", hidden: true }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Emend couldn’t reload this window. Try again.",
    );
    expect(screen.queryByRole("button", { name: "reject candidate setup", hidden: true }))
      .not.toBeInTheDocument();
  });

  it("assembles every author guard subset and one reviewer refusal", () => {
    expect(assembleCloseRefusal("author", { dirty: true, untitled: false, run: false })).toBe(
      "Emend can’t close this window yet. There’s unsaved work. Reload the window to get the ordinary controls back.",
    );
    expect(assembleCloseRefusal("author", { dirty: true, untitled: true, run: true })).toBe(
      "Emend can’t close this window yet. There’s unsaved work, an untitled document is open, and an agent run may still be active. Reload the window to get the ordinary controls back.",
    );
    expect(assembleCloseRefusal("reviewer", { draft: true })).toBe(
      "Emend can’t close this review yet. A comment or suggestion may not have been sent. Reload the window to get the ordinary controls back.",
    );
  });

  it("fails closed from unknown run truth, then permits only a proven-idle guard-free close", () => {
    const context = CONTEXTS[1];
    expect(decideFallbackClose(context, "unknown")).toEqual({
      action: "refuse",
      reason: "Emend can’t close this window yet. An agent run may still be active. Reload the window to get the ordinary controls back.",
    });
    expect(decideFallbackClose(context, "idle")).toEqual({ action: "destroy" });
    expect(decideFallbackClose(context, "active-or-awaiting").action).toBe("refuse");
  });

  it("routes native close through the frozen fallback guards without moving focus", async () => {
    let nativeClose: (() => void | Promise<void>) | undefined;
    let resolveRun: ((state: {
      active: null;
      queued: never[];
      finished: never[];
      lastFinished: null;
    }) => void) | undefined;
    const runState = new Promise<{
      active: null;
      queued: never[];
      finished: never[];
      lastFinished: null;
    }>((resolve) => { resolveRun = resolve; });
    const destroy = vi.fn().mockResolvedValue(undefined);
    const registry = createRenderRecoveryRegistry();
    render(
      <RenderRecoverySupervisor
        registry={registry}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        getRunProjection={() => runState}
        listenForRunActivity={() => Promise.resolve(() => {})}
        installCloseRouter={async (handler) => {
          nativeClose = handler;
          return () => {};
        }}
        closeWindow={destroy}
        renderApp={({ token }) => {
          registry.publish(token, CONTEXTS[1]);
          return <ThrowNow />;
        }}
      />,
    );
    const fallback = await screen.findByRole("main");
    expect(fallback).toHaveFocus();
    await act(async () => nativeClose?.());
    expect(destroy).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("An agent run may still be active");
    expect(fallback).toHaveFocus();

    resolveRun?.({ active: null, queued: [], finished: [], lastFinished: null });
    await act(async () => { await runState; });
    await act(async () => nativeClose?.());
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveFocus();
  });

  it("keeps reload pending and focus in place when native close is refused mid-request", async () => {
    let nativeClose: (() => void | Promise<void>) | undefined;
    const destroy = vi.fn().mockResolvedValue(undefined);
    const registry = createRenderRecoveryRegistry();
    render(
      <RenderRecoverySupervisor
        registry={registry}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        installCloseRouter={async (handler) => {
          nativeClose = handler;
          return () => {};
        }}
        closeWindow={destroy}
        renderApp={({ token, phase }) => {
          if (phase === "initial") {
            registry.publish(token, {
              selector: "author-project",
              runWasActive: false,
              closeGuards: { dirty: true, untitled: false, reviewerDraft: false },
            });
            return <ThrowNow />;
          }
          return <p>Candidate waiting for ready</p>;
        }}
      />,
    );
    const reload = await screen.findByRole("button", { name: "Reload window" });
    reload.focus();
    fireEvent.click(reload);
    const pending = await screen.findByRole("button", { name: "Reloading window…" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    await act(async () => nativeClose?.());
    expect(destroy).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("unsaved work");
    expect(screen.getByRole("button", { name: "Reloading window…" })).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveFocus();
  });

  it("shows reload failure after a close refusal when failed-owner release rejects", async () => {
    let nativeClose: (() => void | Promise<void>) | undefined;
    let rejectRelease: ((reason: Error) => void) | undefined;
    const release = new Promise<void>((_, reject) => { rejectRelease = reject; });
    const registry = createRenderRecoveryRegistry();
    function CommitThenThrow({ token }: { token: { id: number; phase: "initial" | "remount" } }) {
      const [broken, setBroken] = useState(false);
      useEffect(() => {
        registry.registerRelease(token, () => release);
        setBroken(true);
      }, [token]);
      if (broken) return <ThrowNow />;
      return <p>ordinary shell</p>;
    }
    render(
      <RenderRecoverySupervisor
        registry={registry}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        installCloseRouter={async (handler) => {
          nativeClose = handler;
          return () => {};
        }}
        renderApp={({ token }) => {
          registry.publish(token, {
            selector: "author-project",
            runWasActive: false,
            closeGuards: { dirty: true, untitled: false, reviewerDraft: false },
          });
          return <CommitThenThrow token={token} />;
        }}
      />,
    );
    const reload = await screen.findByRole("button", { name: "Reload window" });
    reload.focus();
    fireEvent.click(reload);
    await screen.findByRole("button", { name: "Reloading window…" });
    await act(async () => nativeClose?.());
    expect(screen.getByRole("status")).toHaveTextContent("unsaved work");
    await act(async () => rejectRelease?.(new Error("release failed")));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "Emend couldn’t reload this window. Try again.",
    ));
    expect(screen.getByRole("button", { name: "Reload window" })).toHaveFocus();
  });

  it("retains a positive active run guard when a later monitor refresh fails", async () => {
    let nativeClose: (() => void | Promise<void>) | undefined;
    let refreshRun: (() => void) | undefined;
    const getRunProjection = vi.fn()
      .mockResolvedValueOnce({ active: null, queued: [{}], finished: [], lastFinished: null })
      .mockRejectedValueOnce(new Error("monitor unavailable"));
    const destroy = vi.fn().mockResolvedValue(undefined);
    const registry = createRenderRecoveryRegistry();
    render(
      <RenderRecoverySupervisor
        registry={registry}
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        getRunProjection={getRunProjection}
        listenForRunActivity={async (refresh) => {
          refreshRun = () => refresh({} as never);
          return () => {};
        }}
        installCloseRouter={async (handler) => {
          nativeClose = handler;
          return () => {};
        }}
        closeWindow={destroy}
        renderApp={({ token }) => {
          registry.publish(token, CONTEXTS[1]);
          return <ThrowNow />;
        }}
      />,
    );

    await screen.findByRole("main");
    await waitFor(() => expect(getRunProjection).toHaveBeenCalledTimes(1));
    await act(async () => refreshRun?.());
    await waitFor(() => expect(getRunProjection).toHaveBeenCalledTimes(2));
    await act(async () => nativeClose?.());
    expect(destroy).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("An agent run may still be active");
  });

  it("covers all seven nonempty author guard subsets and reviewer draft independently", () => {
    const expected = [
      "There’s unsaved work",
      "An untitled document is open",
      "There’s unsaved work, and an untitled document is open",
      "An agent run may still be active",
      "There’s unsaved work, and an agent run may still be active",
      "An untitled document is open, and an agent run may still be active",
      "There’s unsaved work, an untitled document is open, and an agent run may still be active",
    ];
    for (let mask = 1; mask < 8; mask += 1) {
      const context: FailureContext = {
        selector: "author-project",
        runWasActive: false,
        closeGuards: {
          dirty: Boolean(mask & 1),
          untitled: Boolean(mask & 2),
          reviewerDraft: false,
        },
      };
      const projection = mask & 4 ? "active-or-awaiting" : "idle";
      expect(decideFallbackClose(context, projection)).toEqual({
        action: "refuse",
        reason: `Emend can’t close this window yet. ${expected[mask - 1]}. Reload the window to get the ordinary controls back.`,
      });
    }
    expect(decideFallbackClose(CONTEXTS[3], "idle").action).toBe("refuse");
    expect(decideFallbackClose({
      ...CONTEXTS[3],
      closeGuards: { dirty: false, untitled: false, reviewerDraft: false },
    }, "idle")).toEqual({ action: "destroy" });
  });
});
