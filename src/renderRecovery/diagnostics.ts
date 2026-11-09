// ABOUTME: Thin frontend edge for TD-28's fixed render-failure diagnostic command.
// ABOUTME: No caller-selected error detail crosses IPC or enters the structured fallback record.
import { callBackend } from "../backend";
import type { RecoveryPhase } from "./types";

export async function reportRenderFailure(
  phase: RecoveryPhase,
  invokeDiagnostic: typeof callBackend = callBackend,
): Promise<void> {
  if (phase !== "initial" && phase !== "remount") {
    console.error(JSON.stringify({ kind: "react-render-failure" }));
    return;
  }
  try {
    await invokeDiagnostic<void>("report_render_failure", { input: { phase } });
  } catch {
    console.error(JSON.stringify({ kind: "react-render-failure", phase }));
  }
}

export function republishRuntimeError(error: unknown): void {
  const reportError = (globalThis as typeof globalThis & { reportError?: (reason: unknown) => void })
    .reportError;
  if (reportError) {
    reportError.call(globalThis, error);
    return;
  }
  window.dispatchEvent(new ErrorEvent("error", {
    error,
    message: error instanceof Error ? error.message : "React render failure",
  }));
}
