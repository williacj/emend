// ABOUTME: Wires FR-ED-3's "quitting with dirty tabs open" guard to the real OS close request —
// ABOUTME: only inside an actual Tauri window; a no-op under the D23 dev-mode/Playwright surface.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirtyTabsRequiringGuard, type TabsState } from "./tabs";

/** Returned by `installQuitGuard`; call it to stop listening (e.g. on unmount). */
export type Unlisten = () => void;

/** Installs TD-28's one app-lifetime native-close interception outside the recoverable tree. */
export async function installNativeCloseRouter(
  onCloseRequested: () => void | Promise<void>,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    void onCloseRequested();
  });
}

export type QuitPreflight = { eligible: true } | { eligible: false; reason: string };
export type WindowCloseOutcome = "closed" | "stayed-open" | "refused";
export interface QuitParticipant {
  preflight(): Promise<QuitPreflight>;
  close(): Promise<WindowCloseOutcome>;
}

/** Runs the ratified app-wide boundary: all non-mutating preflights, then bounded serial closes. */
export async function coordinateAppQuit(
  participants: readonly QuitParticipant[],
): Promise<{ outcome: WindowCloseOutcome; remaining: number }> {
  for (const participant of participants) {
    const preflight = await participant.preflight();
    if (!preflight.eligible) return { outcome: "refused", remaining: participants.length };
  }
  for (let index = 0; index < participants.length; index += 1) {
    const outcome = await participants[index].close();
    if (outcome !== "closed") {
      return { outcome, remaining: participants.length - index };
    }
  }
  return { outcome: "closed", remaining: 0 };
}

/**
 * FR-ED-3: "quitting with any dirty tab open prompts a save/discard/cancel guard; cancel aborts
 * the close." `getTabs` is called fresh on *every* close attempt (never captured once), so it
 * always sees the current tab set. When any tab is dirty, the OS close is cancelled
 * (`event.preventDefault()`) and `onBlocked` receives the dirty paths — the caller resolves them
 * through the same save/discard/cancel guard a single dirty tab-close uses, then re-requests the
 * close once every tab is clean. A clean tab set lets the close proceed untouched.
 *
 * `onCoordinatedClose` is the #1421 path: it prevents the native close synchronously and hands the
 * whole attempt to a receipt/proof-gated coordinator. `onWillClose` remains only for legacy callers
 * that do not provide that coordinator; it must never be presented as losslessness authority.
 *
 * Outside a real Tauri window (`isTauri()` false — the dev-server-driven Playwright surface, D23)
 * there is no OS close event to intercept, so this is a no-op: the same Tauri/test-driver split
 * `editor/ipc.ts` already uses, applied to window lifecycle instead of document I/O.
 */
// @anchor:test-plan-install-quit-guard
export async function installQuitGuard(
  getTabs: () => TabsState,
  onBlocked: (dirtyPaths: string[]) => void,
  onWillClose?: () => void,
  onCoordinatedClose?: () => void,
): Promise<Unlisten> {
  if (!isTauri()) {
    return () => {};
  }
  const unlisten = await getCurrentWindow().onCloseRequested((event) => {
    if (onCoordinatedClose) {
      event.preventDefault();
      onCoordinatedClose();
      return;
    }
    onWillClose?.();
    const dirty = dirtyTabsRequiringGuard(getTabs());
    if (dirty.length > 0) {
      event.preventDefault();
      onBlocked(dirty);
    }
  });
  return unlisten;
}

/**
 * Finishes a quit `installQuitGuard` cancelled: call this once every dirty tab the guard queue
 * surfaced has been resolved (saved or discarded) — the resulting close request finds no dirty
 * tabs left and proceeds. A no-op outside a real Tauri window, same D23 split as everything else
 * here.
 */
// @anchor:test-plan-close-window
export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().destroy();
}

/** The supervisor's explicit safe-close edge; named separately from ordinary close coordination. */
export const destroyWindow = closeWindow;
