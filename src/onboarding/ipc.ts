// ABOUTME: Thin IPC bridge to the backend's `commands::providers` module (FR-X-7) — provider
// ABOUTME: detection only; no document/project logic here. Folder selection lives alongside it
// ABOUTME: (native OS picker via the dialog plugin — a Tauri-only capability with no D23 fallback,
// ABOUTME: since Playwright cannot drive a native dialog; e2e opens projects via the existing D23
// ABOUTME: test hook, same as every other e2e journey before this card, per acceptance.spec.mjs).
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { callBackend } from "../backend";
import type { ProviderStatusEntry } from "./types";

/**
 * Detects both providers (Claude Code, Copilot) — one call for the whole Writing partners panel
 * (J8). Backend-side and read-only (FR-X-9): never returns a credential, only presence/auth state.
 */
export async function detectProviders(): Promise<ProviderStatusEntry[]> {
  return callBackend<ProviderStatusEntry[]>("detect_providers", {});
}

/**
 * Opens the native OS folder picker and resolves the chosen path, or `null` if the user cancelled.
 * Tauri-only (D12: any folder is a project) — outside a webview (dev-mode e2e, D23) there is no
 * native dialog to drive, so this resolves `null`; e2e opens projects via `window.__COWRITE_E2E__`
 * directly instead, as the rest of the walking skeleton already does.
 */
// @anchor:test-plan-pick-project-folder
export async function pickProjectFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
