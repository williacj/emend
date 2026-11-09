// @vitest-environment jsdom
// ABOUTME: Exercises the fallback's Windows close cell through the supervisor's guarded native-close route.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FailureContext } from "./types";

const native = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/window")>(),
  getCurrentWindow: () => ({ close: native.close }),
}));

import { RenderRecoverySupervisor } from "./RenderRecoverySupervisor";
import { createRenderRecoveryRegistry } from "./registry";

const DIRTY_CONTEXT: FailureContext = {
  selector: "author-project",
  runWasActive: false,
  closeGuards: { dirty: true, untitled: false, reviewerDraft: false },
};

function ThrowNow(): never {
  throw new Error("fallback chrome probe");
}

afterEach(() => {
  vi.restoreAllMocks();
  native.close.mockReset();
});

describe("fallback window chrome", () => {
  it("sends its Windows close cell through the supervisor guard and keeps the fallback mounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createRenderRecoveryRegistry();
    const destroy = vi.fn().mockResolvedValue(undefined);
    let nativeClose: (() => void | Promise<void>) | undefined;
    native.close.mockImplementation(async () => { await nativeClose?.(); });

    render(
      <RenderRecoverySupervisor
        registry={registry}
        platform="win"
        diagnostic={() => Promise.resolve()}
        runtimeErrorReporter={() => {}}
        getRunProjection={() => Promise.resolve({ active: null, queued: [], finished: [], lastFinished: null })}
        listenForRunActivity={() => Promise.resolve(() => {})}
        installCloseRouter={async (handler) => {
          nativeClose = handler;
          return () => {};
        }}
        closeWindow={destroy}
        renderApp={({ token }) => {
          registry.publish(token, DIRTY_CONTEXT);
          return <ThrowNow />;
        }}
      />,
    );

    const fallback = await screen.findByRole("main", { name: "Cowrite can’t show this window right now." });
    const close = await screen.findByRole("button", { name: "Close window" });
    fireEvent.click(close);
    await waitFor(() => expect(native.close).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("There’s unsaved work"));
    expect(destroy).not.toHaveBeenCalled();
    expect(fallback).toHaveFocus();
  });
});
