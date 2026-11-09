// ABOUTME: Thin IPC bridge to the backend's `commands::settings` — get the app Settings snapshot
// ABOUTME: or apply field-scoped patches. Outside Tauri (D23), the same calls
// ABOUTME: reach the headless test driver's loopback HTTP surface instead — same commands, no mocking.
import { callBackend } from "../backend";

/**
 * Mirrors Rust `store::settings::AutosaveSettings` (`src-tauri/src/store/settings.rs`) — cross-
 * boundary types are defined in Rust with `Serialize` and mirrored here per CLAUDE.md, so the
 * field names are the wire (snake_case) names verbatim.
 */
export interface AutosaveSettings {
  enabled: boolean;
  interval_ms: number;
}

/** Mirrors Rust `store::settings::NotificationSettings` — reserved (J7); not wired yet. */
export interface NotificationSettings {
  completion: boolean;
}

export interface VoiceSettings {
  enabled: boolean;
  input_device_id: string | null;
  input_device_name: string | null;
}

/** Mirrors Rust `store::settings::Settings` — the whole `settings.json` blob. */
export interface Settings {
  schema_version: number;
  autosave: AutosaveSettings;
  notifications: NotificationSettings;
  /** Reserved (FR-X-7); `null` when unset. Never a credential. */
  provider_default: string | null;
  /** Whether supported author views reveal markup syntax around the active cursor. */
  reveal_markup_at_cursor: boolean;
  voice: VoiceSettings;
}

/** Camel-case command payload mirrored from Rust `commands::settings::SettingsPatch`. */
export interface SettingsPatch {
  autosave?: {
    enabled: boolean;
    intervalMs: number;
  };
  notifications?: {
    completion: boolean;
  };
  providerDefault?: string | null;
  revealMarkupAtCursor?: boolean;
}

/**
 * The default settings, mirroring `Settings::default()` in Rust — what a fresh backend store (or a
 * caller's own catch fallback, e.g. `EditorShell`'s `getSettings().catch(() => DEFAULT_SETTINGS)`)
 * returns on a first run.
 */
export const DEFAULT_SETTINGS: Settings = {
  schema_version: 4,
  autosave: { enabled: true, interval_ms: 1000 },
  notifications: { completion: true },
  provider_default: null,
  reveal_markup_at_cursor: false,
  voice: { enabled: true, input_device_id: null, input_device_name: null },
};

/** The current settings, migrated to the live schema by the backend (a first run yields defaults). */
export async function getSettings(): Promise<Settings> {
  return callBackend<Settings>("get_settings", {});
}

/** Applies a field-scoped patch and returns the backend's complete committed snapshot. */
export async function patchSettings(patch: SettingsPatch): Promise<Settings> {
  return callBackend<Settings>("patch_settings", { patch });
}
