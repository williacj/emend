// ABOUTME: Shared transport for backend IPC (§3.1) — dispatches through the real Tauri IPC bridge
// ABOUTME: when one is present, or (only outside a Tauri webview, D23) over HTTP to the headless
// ABOUTME: test driver, which calls the exact same backend command functions. Extracted from
// ABOUTME: `editor/ipc.ts` (P2a-1) so every module that needs the D23 fallback shares one transport
// ABOUTME: instead of re-implementing it (CLAUDE.md: never copy-paste — extract and import).
import { invoke, isTauri } from "@tauri-apps/api/core";

const DEFAULT_TEST_DRIVER_URL = "http://127.0.0.1:4711";

/**
 * Dispatches `command` with `args`: through the real Tauri IPC bridge when one is present, or —
 * only when it isn't (the Vite dev server running standalone under Playwright, D23) — over HTTP
 * to the headless test driver (`crates/test-driver`), which calls the exact same backend command
 * functions. The transport differs; the command never does, so this is a testability hook, not a
 * mock (CLAUDE.md: never mock in e2e). A driver error response (any non-2xx) rejects with the
 * response body — the same typed error shape the real `invoke()` rejection carries.
 */
// @anchor:test-plan-call-backend
export async function callBackend<T>(command: string, args: Record<string, unknown>): Promise<T> {
  // @anchor:test-plan-is-tauri-switch
  if (isTauri()) {
    return invoke<T>(command, args);
  }

  const base = import.meta.env.VITE_TEST_DRIVER_URL ?? DEFAULT_TEST_DRIVER_URL;
  const response = await fetch(`${base}/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok) {
    return Promise.reject(body);
  }
  return body as T;
}

/**
 * The human-readable half of whatever a rejected backend call threw — the typed `{ kind, message }`
 * shape both transports above produce, a thrown `Error`, or a bare string (FR-X-5: each failure
 * degrades visibly, never silently). The **one** reader of that shape in the app: three more had
 * grown up beside it, so #2230 folded all four into this, the one they can all express.
 *
 * `fallback` answers a rejection carrying no readable message. It is a parameter because that
 * wording is `ux-design.md` §4's Status region to choose *per surface* (an inline banner says
 * "Try again." via `formatActionFailure`; an agent run card says `String(error)`), so one reader
 * must not impose one answer. It defaults to `""`, which a caller can equally extend with `|| "…"`.
 *
 * A message the rejection really carried is never replaced by `fallback`, not even an empty one: a
 * backend that said nothing is a different fact from a rejection shape this reader cannot read.
 *
 * Lives here because it is the transport's own error shape being read.
 */
export function errorDetail(error: unknown, fallback = ""): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.trim();
  }
  return fallback;
}

/**
 * The shared "we couldn't do it, here's why" wording (FR-X-5) for a surface reporting a failed
 * requested action — `MissingOnDiskBanner`, `UntitledDocument`, and the app shell's project-open
 * boundary all use it. `detail` is `errorDetail(error)`'s output, which is `""`
 * for a rejection that carried no message; "Try again." is the ratified fallback for that case
 * (ux-design "Status region") rather than a dangling trailing space.
 */
export function formatActionFailure(detail: string): string {
  return `Cowrite couldn’t complete the requested action. ${detail || "Try again."}`;
}

/**
 * A failure whose `message` is already the whole sentence the author should read, because the
 * reporter knew both what failed and what it means for their work. A surface that prefixes a
 * subject of its own — "the requested action", "the document action" — would name the wrong one:
 * a window that refused to close is not a document action. Every other rejection keeps the wording
 * of the surface reporting it (#2327).
 */
export class UserFacingError extends Error {}

/** A legacy unsupported-tab refusal with a distinct shell-status presentation. */
export class UnsupportedRestoreRefusalError extends UserFacingError {
  constructor(message: string, readonly path: string, readonly outcome: "closed" | "omitted") {
    super(message);
  }
}

/**
 * The app shell's wording for a failure reported by the document region (`formatActionFailure`'s
 * sibling, FR-X-5). A `UserFacingError` already carries the whole sentence and passes through: the
 * shell would otherwise announce a refused window close as a document action, which names a
 * subject the author never acted on.
 */
export function formatDocumentActionFailure(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  const detail = errorDetail(error);
  return detail
    ? `Cowrite couldn’t complete the document action. ${detail}`
    : "Cowrite couldn’t complete the document action. Try again.";
}
