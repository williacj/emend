// ABOUTME: Settings read/patch IPC (P2a-9, TD-26) — thin commands over the app-scoped settings
// ABOUTME: service; its store owns migration, locking, persistence, watching, and snapshot fan-out.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::store::settings::{Settings, SettingsObserver, SettingsPatch, SettingsService};

/// The app-global channel carrying every complete committed or externally replaced settings
/// snapshot. Its payload keeps [`Settings`]' established snake_case wire shape.
pub const SETTINGS_CHANGED_EVENT: &str = "settings://changed";

/// Bridges the store-owned observer onto Tauri without coupling persistence to the UI runtime.
pub struct TauriSettingsEmitter(pub AppHandle);

impl SettingsObserver for TauriSettingsEmitter {
    fn changed(&self, settings: &Settings) {
        let _ = Emitter::emit(&self.0, SETTINGS_CHANGED_EVENT, settings);
    }
}

/// A settings command failed. Serializable so it crosses the IPC boundary as a typed JS error.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    Io(String),
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        CommandError::Io(e.to_string())
    }
}

/// Returns the service's complete last-good settings snapshot, or the honest durable load error
/// when this process has not observed a valid snapshot yet.
#[tauri::command]
pub fn get_settings(service: State<'_, SettingsService>) -> Result<Settings, CommandError> {
    get_settings_on(&service)
}

pub fn get_settings_on(service: &SettingsService) -> Result<Settings, CommandError> {
    service.current().map_err(CommandError::from)
}

/// Applies only the fields named by `patch` and returns the complete committed snapshot.
#[tauri::command]
pub fn patch_settings(
    service: State<'_, SettingsService>,
    patch: SettingsPatch,
) -> Result<Settings, CommandError> {
    patch_settings_on(&service, patch)
}

pub fn patch_settings_on(
    service: &SettingsService,
    patch: SettingsPatch,
) -> Result<Settings, CommandError> {
    service.patch(patch).map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct NoopObserver;

    impl SettingsObserver for NoopObserver {
        fn changed(&self, _settings: &Settings) {}
    }

    #[test]
    fn get_settings_on_reports_an_initial_malformed_file_and_retry_recovers_after_repair() {
        let dir = tempfile::tempdir().unwrap();
        let path = crate::store::settings::settings_file(dir.path());
        std::fs::write(&path, "{invalid json").unwrap();
        let service = SettingsService::watch(&path, Arc::new(NoopObserver)).unwrap();

        let error = get_settings_on(&service).unwrap_err();
        assert!(matches!(error, CommandError::Io(message) if !message.is_empty()));

        let repaired = Settings {
            reveal_markup_at_cursor: true,
            ..Settings::default()
        };
        crate::store::settings::save(&path, &repaired).unwrap();

        assert_eq!(get_settings_on(&service).unwrap(), repaired);
    }
}
