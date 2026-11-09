// ABOUTME: The app Settings store (P2a-9) — a schema-versioned, migration-on-load settings blob
// ABOUTME: (`store/` owns it, TD §3.1). Autosave (P2a-7) is its first consumer; secrets never live here (FR-X-2).

//! A single app-global settings file (`settings.json` under the OS app-config dir), carrying an
//! explicit `schema_version` like every other `store/` file (TD-4). Unlike the TD-4 sidecars this
//! is **not** a published portability contract — it is app-internal config — so it has no
//! `docs/formats/` schema; its versioning exists purely so a future field addition is a
//! non-breaking migration rather than a data-losing shape change.
//!
//! **Migration lives on load.** [`load`] reads the raw JSON, runs [`migrate`], and always returns
//! a current-shaped [`Settings`]: missing fields are defaulted (pervasive `#[serde(default)]`, so a
//! partial or older blob upgrades field-by-field, preserving every value it *does* carry), the
//! `schema_version` is stamped to [`SCHEMA_VERSION`], and a file from a *newer* version is a
//! defined error rather than a silent downgrade that would drop its unknown fields.
//!
//! **Writes are serialized across TD-20 processes.** [`patch`] takes the companion settings lock,
//! reloads the latest durable snapshot, applies only the named fields, and atomically replaces the
//! file before releasing the lock. [`SettingsService`] retains the last-good complete snapshot and
//! uses a native filesystem watch to publish both local commits and external-process replacements.
//! Until it has a valid snapshot, reads report the durable load error instead of presenting safe UI
//! defaults as persisted state; this never prevents the rest of the app from starting.
//!
//! **Secrets never round-trip (FR-X-2).** [`Settings`] is a fixed struct with no credential field,
//! and migration does not use `deny_unknown_fields` — so any secret-shaped key someone drops into
//! the file is silently discarded on load and never written back. Tokens/keys live in the OS
//! keychain only; this store must never become a place they can hide.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};

use fs4::FileExt;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::store::atomic;

/// Bumped whenever the settings shape changes (TD-4: "every file carries `schema_version`").
/// Version 3 adds FR-ED-5's app-local voice preference; version 4 retains the selected device's
/// display name so an unplugged microphone can still be named after restart.
pub const SCHEMA_VERSION: u32 = 4;

/// The whole `settings.json` file. Every field carries a serde default so an older/partial blob
/// upgrades cleanly (see [`migrate`]); the struct is intentionally fixed and credential-free so no
/// secret can be represented or persisted here (FR-X-2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    /// Autosave on/off + interval (FR-ED-2). The store's first real consumer (P2a-7's editor
    /// autosave reads this instead of its hardcoded stub).
    #[serde(default)]
    pub autosave: AutosaveSettings,
    /// Reserved (J7 completion toggle) — persisted with a sensible default so its consumer lands
    /// without a breaking migration. Not wired in P2a-9.
    #[serde(default)]
    pub notifications: NotificationSettings,
    /// Reserved (FR-X-7): the default AI provider. FR-X-7 makes this a *per-project* default; the
    /// per-project keying lands with the provider consumer (P3-*), which extends this via the same
    /// migration path. Held here as an app-level placeholder so that addition is a field default,
    /// not a schema break. Not wired in P2a-9. (Never a credential — auth stays in the keychain.)
    #[serde(default)]
    pub provider_default: Option<String>,
    /// TD-26's app-global projection preference. This remains independent of display mode and is
    /// false on first run and migration, so markup stays hidden at the cursor by default.
    #[serde(default)]
    pub reveal_markup_at_cursor: bool,
    /// App-local dictation preference; a retained name is display-only, never a capture identity.
    #[serde(default)]
    pub voice: VoiceSettings,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub input_device_id: Option<String>,
    #[serde(default)]
    pub input_device_name: Option<String>,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            input_device_id: None,
            input_device_name: None,
        }
    }
}

/// Autosave configuration (FR-ED-2). Defaults match the editor's former hardcoded stub
/// (`DEFAULT_AUTOSAVE_INTERVAL_MS` = 1000ms, on) so wiring the store changes no default behavior.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutosaveSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_autosave_interval_ms")]
    pub interval_ms: u64,
}

/// Notification preferences (J7). Reserved; only the completion toggle is named so far.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NotificationSettings {
    #[serde(default = "default_true")]
    pub completion: bool,
}

/// Field-scoped input for a settings update. Unlike [`Settings`], this command shape is camelCase
/// and carries no `schemaVersion`: callers choose only the fields they intend to change, while the
/// backend reloads and stamps the durable complete snapshot under the settings-file lock (TD-26).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub autosave: Option<AutosavePatch>,
    pub notifications: Option<NotificationPatch>,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub provider_default: Option<Option<String>>,
    pub reveal_markup_at_cursor: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutosavePatch {
    pub enabled: bool,
    pub interval_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPatch {
    pub completion: bool,
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn current_schema_version() -> u32 {
    SCHEMA_VERSION
}
fn default_true() -> bool {
    true
}
fn default_autosave_interval_ms() -> u64 {
    1000
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema_version: SCHEMA_VERSION,
            autosave: AutosaveSettings::default(),
            notifications: NotificationSettings::default(),
            provider_default: None,
            reveal_markup_at_cursor: false,
            voice: VoiceSettings::default(),
        }
    }
}

impl Default for AutosaveSettings {
    fn default() -> Self {
        AutosaveSettings {
            enabled: true,
            interval_ms: default_autosave_interval_ms(),
        }
    }
}

impl Default for NotificationSettings {
    fn default() -> Self {
        NotificationSettings { completion: true }
    }
}

/// A settings blob could not be migrated to the current schema.
#[derive(Debug, PartialEq, Eq)]
pub enum MigrationError {
    /// The file's `schema_version` is newer than this build supports — refusing rather than
    /// silently downgrading (which would drop the newer version's fields, losing data). `found` is
    /// carried as the on-wire `u64` verbatim (no narrowing) so the error names the real version.
    NewerThanSupported { found: u64, supported: u32 },
    /// The blob's known fields are malformed (e.g. a non-integer interval) — a defined error, not a panic.
    Invalid(String),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::NewerThanSupported { found, supported } => write!(
                f,
                "settings schema_version {found} is newer than supported ({supported})"
            ),
            MigrationError::Invalid(msg) => write!(f, "invalid settings: {msg}"),
        }
    }
}

impl std::error::Error for MigrationError {}

/// Upgrades a raw settings value to the current [`Settings`] shape.
///
/// Reads `schema_version` from `raw` (a missing/absent version is treated as legacy `0`); a version
/// newer than [`SCHEMA_VERSION`] is a [`MigrationError::NewerThanSupported`]. Otherwise deserializes
/// leniently — pervasive `#[serde(default)]` fills every absent field (so older/partial blobs
/// upgrade field-by-field, preserving values they carry), and any unknown (incl. secret-shaped)
/// field is dropped — then stamps the current version. Idempotent: migrating an already-current
/// value yields an equal value.
pub fn migrate(raw: serde_json::Value) -> Result<Settings, MigrationError> {
    let found = raw
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if found > u64::from(SCHEMA_VERSION) {
        return Err(MigrationError::NewerThanSupported {
            found,
            supported: SCHEMA_VERSION,
        });
    }

    let mut settings: Settings =
        serde_json::from_value(raw).map_err(|e| MigrationError::Invalid(e.to_string()))?;
    settings.schema_version = SCHEMA_VERSION;
    Ok(settings)
}

/// The settings file path under an app-config directory (`<config_dir>/settings.json`). Pure —
/// the command layer resolves the real config dir from the Tauri app handle and passes it here.
pub fn settings_file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Loads and migrates the settings at `path`. A missing file is fresh [`Settings::default`] (a
/// first run) rather than an error; a present file is read, migrated to the current schema, and
/// returned current-shaped. A corrupt or newer-than-supported file is a defined error, never a panic.
pub fn load(path: &Path) -> io::Result<Settings> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let raw: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            migrate(raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e),
    }
}

/// Persists `settings` to `path` atomically (write-then-rename — a crash mid-write leaves the
/// previous file intact, never a torn one). Creates parent directories as needed. Callers that can
/// race must serialize around this raw primitive; [`patch`] owns that cross-process transaction.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    atomic::write_json(path, settings)
}

fn apply_patch(settings: &mut Settings, patch: SettingsPatch) {
    if let Some(autosave) = patch.autosave {
        settings.autosave = AutosaveSettings {
            enabled: autosave.enabled,
            interval_ms: autosave.interval_ms,
        };
    }
    if let Some(notifications) = patch.notifications {
        settings.notifications = NotificationSettings {
            completion: notifications.completion,
        };
    }
    if let Some(provider_default) = patch.provider_default {
        settings.provider_default = provider_default;
    }
    if let Some(reveal) = patch.reveal_markup_at_cursor {
        settings.reveal_markup_at_cursor = reveal;
    }
    settings.schema_version = SCHEMA_VERSION;
}

fn settings_lock_file(path: &Path) -> PathBuf {
    path.with_file_name("settings.lock")
}

/// Reloads the latest durable settings, applies only the caller's fields, and atomically persists
/// the complete result while holding one cross-process advisory lock for that whole transaction.
pub fn patch(path: &Path, patch: SettingsPatch) -> io::Result<Settings> {
    patch_with_hook(path, patch, || {})
}

/// Backend-only voice mutation. The generic JSON Settings patch cannot change voice fields;
/// voice commands validate devices and active-capture state before calling this transaction.
pub fn patch_voice(
    path: &Path,
    enabled: Option<bool>,
    input_device: Option<Option<(String, String)>>,
) -> io::Result<Settings> {
    mutate_with_hook(
        path,
        || {},
        |settings| {
            if let Some(enabled) = enabled {
                settings.voice.enabled = enabled;
            }
            if let Some(input_device) = input_device {
                let (id, name) = match input_device {
                    Some((id, name)) => (Some(id), Some(name)),
                    None => (None, None),
                };
                settings.voice.input_device_id = id;
                settings.voice.input_device_name = name;
            }
            settings.schema_version = SCHEMA_VERSION;
        },
    )
}

fn patch_with_hook(
    path: &Path,
    patch: SettingsPatch,
    after_load: impl FnOnce(),
) -> io::Result<Settings> {
    mutate_with_hook(path, after_load, |settings| apply_patch(settings, patch))
}

fn mutate_with_hook(
    path: &Path,
    after_load: impl FnOnce(),
    update: impl FnOnce(&mut Settings),
) -> io::Result<Settings> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "settings path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(settings_lock_file(path))?;
    FileExt::lock(&lock_file)?;
    let result = (|| {
        let mut settings = load(path)?;
        after_load();
        update(&mut settings);
        save(path, &settings)?;
        Ok(settings)
    })();
    let _ = FileExt::unlock(&lock_file);
    result
}

/// Receives complete settings snapshots after a successful local commit or valid external file
/// replacement. Implementations must return quickly; the native watcher calls this on its worker.
pub trait SettingsObserver: Send + Sync {
    fn changed(&self, settings: &Settings);
}

struct SettingsServiceInner {
    path: PathBuf,
    /// `None` means this process has not observed a valid snapshot yet. It is deliberately not
    /// replaced with defaults after a failed initial read: commands must keep reporting that load
    /// error until the file becomes valid, while the editor remains free to use its frontend-safe
    /// pre-hydration values.
    snapshot: Mutex<Option<Settings>>,
    updates: Mutex<()>,
    observer: Arc<dyn SettingsObserver>,
}

/// One app-process settings owner. It keeps the last valid complete snapshot in memory, serializes
/// local updates, and watches the shared file so another TD-20 process propagates changes live.
pub struct SettingsService {
    inner: Arc<SettingsServiceInner>,
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SettingsServiceInner {
    fn publish_if_changed(&self, next: Settings) {
        let should_publish = {
            let mut snapshot = lock(&self.snapshot);
            if snapshot.as_ref() == Some(&next) {
                false
            } else {
                *snapshot = Some(next.clone());
                true
            }
        };
        if should_publish {
            self.observer.changed(&next);
        }
    }

    fn refresh_from_disk(&self) -> io::Result<()> {
        let _update = lock(&self.updates);
        let next = load(&self.path)?;
        self.publish_if_changed(next);
        Ok(())
    }

    fn current(&self) -> io::Result<Settings> {
        let _update = lock(&self.updates);
        if let Some(settings) = lock(&self.snapshot).clone() {
            return Ok(settings);
        }

        let next = load(&self.path)?;
        self.publish_if_changed(next.clone());
        Ok(next)
    }
}

impl SettingsService {
    /// Builds a local-only service when the native watcher itself cannot start. It still hydrates
    /// a readable durable snapshot instead of inventing defaults; an initial load failure remains
    /// visible to commands until a later read or successful patch recovers it. Document editing is
    /// never held behind this optional settings subscription.
    pub fn degraded(path: &Path, observer: Arc<dyn SettingsObserver>) -> Self {
        let initial = match load(path) {
            Ok(settings) => Some(settings),
            Err(error) => {
                eprintln!("Cowrite could not load settings: {error}");
                None
            }
        };
        Self {
            inner: Arc::new(SettingsServiceInner {
                path: path.to_path_buf(),
                snapshot: Mutex::new(initial),
                updates: Mutex::new(()),
                observer,
            }),
            _watcher: Mutex::new(None),
        }
    }

    /// Starts the native directory watch before the initial read, closing the startup race between
    /// subscribing and hydrating. A later invalid replacement is ignored and the last-good
    /// snapshot remains available; the next valid replacement can still advance it.
    pub fn watch(path: &Path, observer: Arc<dyn SettingsObserver>) -> io::Result<Self> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "settings path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        let (raw_tx, raw_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(raw_tx).map_err(io::Error::other)?;
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;

        let initial = match load(path) {
            Ok(settings) => Some(settings),
            Err(error) => {
                // Editing remains available because the frontend owns its safe pre-hydration
                // value. Keep the invalid/newer file and the load failure honest; a later valid
                // replacement can establish this service's first last-good snapshot.
                eprintln!("Cowrite could not load settings: {error}");
                None
            }
        };
        let inner = Arc::new(SettingsServiceInner {
            path: path.to_path_buf(),
            snapshot: Mutex::new(initial),
            updates: Mutex::new(()),
            observer,
        });
        let worker = Arc::clone(&inner);
        std::thread::spawn(move || {
            for result in raw_rx {
                let Ok(event) = result else { continue };
                // Atomic replacement is reported as the final file on Windows but may be reported
                // only as a change to this watched directory on macOS. Reload for every non-access
                // change in the non-recursive directory; snapshot equality removes temp/lock noise.
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                if let Err(error) = worker.refresh_from_disk() {
                    eprintln!("Cowrite could not reload settings after a file change: {error}");
                }
            }
        });

        Ok(Self {
            inner,
            _watcher: Mutex::new(Some(watcher)),
        })
    }

    /// Returns the complete last-good snapshot. Before this process has observed one, retry the
    /// durable read so Settings UI Retry can recover even when the native watcher is unavailable;
    /// a still-malformed or unreadable file remains an honest error.
    pub fn current(&self) -> io::Result<Settings> {
        self.inner.current()
    }

    pub fn patch(&self, update: SettingsPatch) -> io::Result<Settings> {
        let _update = lock(&self.inner.updates);
        let committed = patch(&self.inner.path, update)?;
        self.inner.publish_if_changed(committed.clone());
        Ok(committed)
    }

    pub fn patch_voice(
        &self,
        enabled: Option<bool>,
        input_device: Option<Option<(String, String)>>,
    ) -> io::Result<Settings> {
        let _update = lock(&self.inner.updates);
        let committed = patch_voice(&self.inner.path, enabled, input_device)?;
        self.inner.publish_if_changed(committed.clone());
        Ok(committed)
    }

    #[cfg(test)]
    fn refresh_from_disk(&self) -> io::Result<()> {
        self.inner.refresh_from_disk()
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_fresh_settings_is_current_version_with_autosave_on_at_the_default_interval() {
        let s = Settings::default();
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert_eq!(
            s.autosave,
            AutosaveSettings {
                enabled: true,
                interval_ms: 1000
            }
        );
        assert!(s.notifications.completion);
        assert_eq!(s.provider_default, None);
        assert!(!s.reveal_markup_at_cursor);
    }

    #[test]
    fn migrating_a_current_schema_blob_is_a_no_op() {
        // Idempotent load: an already-current file survives migration byte-for-byte in meaning.
        let current = serde_json::to_value(Settings::default()).unwrap();
        let migrated = migrate(current.clone()).unwrap();
        assert_eq!(migrated, Settings::default());
        // Round-tripping the migrated value again is still a no-op.
        let again = migrate(serde_json::to_value(&migrated).unwrap()).unwrap();
        assert_eq!(again, migrated);
    }

    #[test]
    fn migrating_an_older_partial_blob_fills_defaults_and_bumps_the_version() {
        // A version-0 blob that set autosave off but predates the interval/notifications fields.
        let old = json!({ "schema_version": 0, "autosave": { "enabled": false } });
        let migrated = migrate(old).unwrap();
        assert_eq!(migrated.schema_version, SCHEMA_VERSION); // bumped
        assert!(!migrated.autosave.enabled); // still-valid field preserved
        assert_eq!(migrated.autosave.interval_ms, 1000); // absent field defaulted
        assert!(migrated.notifications.completion); // absent field defaulted
        assert!(!migrated.reveal_markup_at_cursor); // v2 preference defaults off
    }

    #[test]
    fn migrating_a_v1_blob_preserves_every_old_field_and_defaults_reveal_off() {
        let old = json!({
            "schema_version": 1,
            "autosave": { "enabled": false, "interval_ms": 4500 },
            "notifications": { "completion": false },
            "provider_default": "claude"
        });

        let migrated = migrate(old).unwrap();

        assert_eq!(migrated.schema_version, 4);
        assert!(!migrated.autosave.enabled);
        assert_eq!(migrated.autosave.interval_ms, 4500);
        assert!(!migrated.notifications.completion);
        assert_eq!(migrated.provider_default.as_deref(), Some("claude"));
        assert!(!migrated.reveal_markup_at_cursor);
    }

    #[test]
    fn migrating_an_unversioned_blob_treats_it_as_legacy_and_upgrades() {
        let unversioned = json!({ "autosave": { "enabled": false, "interval_ms": 2500 } });
        let migrated = migrate(unversioned).unwrap();
        assert_eq!(migrated.schema_version, SCHEMA_VERSION);
        assert_eq!(
            migrated.autosave,
            AutosaveSettings {
                enabled: false,
                interval_ms: 2500
            }
        );
    }

    #[test]
    fn a_blob_from_a_newer_schema_version_is_a_defined_error_not_a_silent_downgrade() {
        let newer = json!({ "schema_version": 999, "autosave": { "enabled": true } });
        assert_eq!(
            migrate(newer),
            Err(MigrationError::NewerThanSupported {
                found: 999,
                supported: SCHEMA_VERSION
            })
        );
    }

    #[test]
    fn a_malformed_field_is_a_defined_error_not_a_panic() {
        let bad = json!({ "schema_version": 1, "autosave": { "interval_ms": "not-a-number" } });
        assert!(matches!(migrate(bad), Err(MigrationError::Invalid(_))));
    }

    #[test]
    fn a_secret_shaped_field_is_dropped_never_round_tripped() {
        // FR-X-2 guard: a credential dropped into the file must not survive load→save.
        let with_secret = json!({
            "schema_version": 1,
            "autosave": { "enabled": true, "interval_ms": 1000 },
            "api_token": "sk-shh-super-secret",
            "github_password": "hunter2",
        });
        let migrated = migrate(with_secret).unwrap();
        let round_tripped = serde_json::to_string(&migrated).unwrap();
        assert!(!round_tripped.contains("api_token"));
        assert!(!round_tripped.contains("github_password"));
        assert!(!round_tripped.contains("super-secret"));
        assert!(!round_tripped.contains("hunter2"));
    }

    #[test]
    fn the_serialized_settings_keys_are_a_fixed_credential_free_set() {
        // Structural FR-X-2 guard: the persisted shape is exactly these keys — no field exists that
        // could hold a token/key, so one can never be introduced by accident without failing here.
        let value = serde_json::to_value(Settings::default()).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "autosave",
                "notifications",
                "provider_default",
                "reveal_markup_at_cursor",
                "schema_version",
                "voice"
            ]
        );
    }

    #[test]
    fn settings_patch_accepts_only_the_camel_case_command_shape() {
        let patch: SettingsPatch = serde_json::from_value(json!({
            "autosave": { "enabled": false, "intervalMs": 2500 },
            "notifications": { "completion": false },
            "providerDefault": null,
            "revealMarkupAtCursor": true
        }))
        .unwrap();

        assert_eq!(patch.autosave.unwrap().interval_ms, 2500);
        assert!(!patch.notifications.unwrap().completion);
        assert_eq!(patch.provider_default, Some(None));
        assert_eq!(patch.reveal_markup_at_cursor, Some(true));
        assert!(serde_json::from_value::<SettingsPatch>(json!({
            "reveal_markup_at_cursor": true
        }))
        .is_err());
    }

    #[test]
    fn toggling_autosave_off_is_reflected_after_a_round_trip() {
        // "Toggling in Settings changes autosave's behavior" at the persistence layer.
        let mut s = Settings::default();
        s.autosave.enabled = false;
        s.autosave.interval_ms = 5000;
        let reloaded = migrate(serde_json::to_value(&s).unwrap()).unwrap();
        assert!(!reloaded.autosave.enabled);
        assert_eq!(reloaded.autosave.interval_ms, 5000);
    }

    #[test]
    fn v2_voice_defaults_and_selected_device_survive_a_persisted_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_file(dir.path());
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema_version": 2,
                "autosave": { "enabled": false, "interval_ms": 5000 },
                "reveal_markup_at_cursor": true
            }))
            .unwrap(),
        )
        .unwrap();
        let migrated = load(&path).unwrap();
        assert_eq!(migrated.schema_version, 4);
        assert!(migrated.voice.enabled);
        assert_eq!(migrated.voice.input_device_id, None);
        assert_eq!(migrated.voice.input_device_name, None);
        assert!(!migrated.autosave.enabled);

        let changed = patch_voice(
            &path,
            Some(false),
            Some(Some(("mic-2".into(), "USB microphone".into()))),
        )
        .unwrap();
        assert!(!changed.voice.enabled);
        assert_eq!(changed.voice.input_device_id.as_deref(), Some("mic-2"));
        assert_eq!(
            changed.voice.input_device_name.as_deref(),
            Some("USB microphone")
        );
        assert_eq!(load(&path).unwrap(), changed);
        assert_eq!(changed.autosave.interval_ms, 5000);
        assert!(changed.reveal_markup_at_cursor);
    }

    #[test]
    fn v3_selected_device_defaults_name_and_current_choice_round_trips_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_file(dir.path());
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema_version": 3,
                "voice": { "enabled": true, "input_device_id": "mic-old" }
            }))
            .unwrap(),
        )
        .unwrap();

        let migrated = load(&path).unwrap();
        assert_eq!(migrated.schema_version, 4);
        assert_eq!(migrated.voice.input_device_id.as_deref(), Some("mic-old"));
        assert_eq!(migrated.voice.input_device_name, None);

        let selected = patch_voice(
            &path,
            None,
            Some(Some(("mic-b".into(), "USB microphone".into()))),
        )
        .unwrap();
        assert_eq!(selected.voice.input_device_id.as_deref(), Some("mic-b"));
        assert_eq!(
            selected.voice.input_device_name.as_deref(),
            Some("USB microphone")
        );
        assert_eq!(load(&path).unwrap(), selected);

        let system_default = patch_voice(&path, None, Some(None)).unwrap();
        assert_eq!(system_default.voice.input_device_id, None);
        assert_eq!(system_default.voice.input_device_name, None);
        assert_eq!(load(&path).unwrap(), system_default);
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;
    use serde_json::json;
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::time::Duration;
    use tempfile::TempDir;

    #[derive(Default)]
    struct RecordingObserver {
        published: Mutex<Vec<Settings>>,
        changed: Condvar,
    }

    impl SettingsObserver for RecordingObserver {
        fn changed(&self, settings: &Settings) {
            self.published.lock().unwrap().push(settings.clone());
            self.changed.notify_all();
        }
    }

    impl RecordingObserver {
        fn wait_for(&self, count: usize) -> Vec<Settings> {
            let values = self.published.lock().unwrap();
            let (values, timeout) = self
                .changed
                .wait_timeout_while(values, Duration::from_secs(2), |values| {
                    values.len() < count
                })
                .unwrap();
            assert!(!timeout.timed_out(), "settings publication did not arrive");
            values.clone()
        }
    }

    #[test]
    fn loading_a_missing_settings_file_is_fresh_defaults_not_an_error() {
        let dir = TempDir::new().unwrap();
        let s = load(&dir.path().join("settings.json")).unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        let mut s = Settings::default();
        s.autosave.interval_ms = 3000;
        s.provider_default = Some("claude".to_string());

        save(&path, &s).unwrap();
        assert_eq!(load(&path).unwrap(), s);
    }

    #[test]
    fn loading_an_older_on_disk_file_upgrades_it_preserving_valid_fields() {
        // The named migration test at the IO layer: a legacy file on disk loads as current-shaped.
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        fs::write(
            &path,
            json!({ "schema_version": 0, "autosave": { "enabled": false } }).to_string(),
        )
        .unwrap();

        let loaded = load(&path).unwrap();

        assert_eq!(loaded.schema_version, SCHEMA_VERSION);
        assert!(!loaded.autosave.enabled);
        assert_eq!(loaded.autosave.interval_ms, 1000);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/config/settings.json");
        save(&path, &Settings::default()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn save_leaves_no_stray_temp_file_behind() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        save(&path, &Settings::default()).unwrap();
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("settings.json")]);
    }

    #[test]
    fn a_corrupt_settings_file_is_a_defined_error_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        fs::write(&path, "{not json").unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn settings_file_is_named_settings_json_under_the_config_dir() {
        assert_eq!(
            settings_file(Path::new("/cfg/cowrite")),
            PathBuf::from("/cfg/cowrite/settings.json")
        );
    }

    #[test]
    fn concurrent_unrelated_patches_reload_under_one_lock_and_preserve_both_fields() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        let first_path = path.clone();
        let second_path = path.clone();
        let (first_loaded_tx, first_loaded_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (second_loaded_tx, second_loaded_rx) = mpsc::channel();

        let first = std::thread::spawn(move || {
            patch_with_hook(
                &first_path,
                SettingsPatch {
                    autosave: Some(AutosavePatch {
                        enabled: false,
                        interval_ms: 5000,
                    }),
                    ..SettingsPatch::default()
                },
                || {
                    first_loaded_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            )
            .unwrap()
        });
        first_loaded_rx.recv().unwrap();
        let second = std::thread::spawn(move || {
            patch_with_hook(
                &second_path,
                SettingsPatch {
                    reveal_markup_at_cursor: Some(true),
                    ..SettingsPatch::default()
                },
                || second_loaded_tx.send(()).unwrap(),
            )
            .unwrap()
        });
        assert!(matches!(
            second_loaded_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_tx.send(()).unwrap();

        first.join().unwrap();
        second.join().unwrap();
        let stored = load(&path).unwrap();
        assert!(!stored.autosave.enabled);
        assert_eq!(stored.autosave.interval_ms, 5000);
        assert!(stored.reveal_markup_at_cursor);
    }

    #[test]
    fn service_publishes_one_complete_snapshot_for_a_local_patch_and_deduplicates_its_echo() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        let observer = Arc::new(RecordingObserver::default());
        let service = SettingsService::watch(&path, observer.clone()).unwrap();

        let committed = service
            .patch(SettingsPatch {
                reveal_markup_at_cursor: Some(true),
                ..SettingsPatch::default()
            })
            .unwrap();
        service.refresh_from_disk().unwrap();

        let published = observer.wait_for(1);
        assert_eq!(published, vec![committed.clone()]);
        assert_eq!(service.current().unwrap(), committed);
    }

    #[test]
    fn service_watches_a_valid_external_replacement_and_retains_last_good_on_invalid_input() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        let observer = Arc::new(RecordingObserver::default());
        let service = SettingsService::watch(&path, observer.clone()).unwrap();
        let external = Settings {
            reveal_markup_at_cursor: true,
            ..Settings::default()
        };

        save(&path, &external).unwrap();

        assert_eq!(observer.wait_for(1), vec![external.clone()]);
        assert_eq!(service.current().unwrap(), external);
        fs::write(&path, "{invalid json").unwrap();
        assert!(service.refresh_from_disk().is_err());
        assert_eq!(service.current().unwrap(), external);
    }

    #[test]
    fn a_patch_in_one_service_is_published_by_another_service_watching_the_shared_file() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        let writer_observer = Arc::new(RecordingObserver::default());
        let reader_observer = Arc::new(RecordingObserver::default());
        let writer = SettingsService::watch(&path, writer_observer.clone()).unwrap();
        let reader = SettingsService::watch(&path, reader_observer.clone()).unwrap();

        let committed = writer
            .patch(SettingsPatch {
                reveal_markup_at_cursor: Some(true),
                ..SettingsPatch::default()
            })
            .unwrap();

        assert_eq!(writer_observer.wait_for(1), vec![committed.clone()]);
        assert_eq!(reader_observer.wait_for(1), vec![committed.clone()]);
        assert_eq!(reader.current().unwrap(), committed);
    }

    #[test]
    fn service_keeps_an_initial_load_failure_honest_until_a_valid_replacement() {
        let dir = TempDir::new().unwrap();
        let path = settings_file(dir.path());
        fs::write(&path, "{invalid json").unwrap();
        let observer = Arc::new(RecordingObserver::default());

        let service = SettingsService::watch(&path, observer.clone()).unwrap();

        assert_eq!(
            service.current().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let replacement = Settings {
            autosave: AutosaveSettings {
                enabled: false,
                interval_ms: 4200,
            },
            ..Settings::default()
        };
        save(&path, &replacement).unwrap();

        assert_eq!(observer.wait_for(1), vec![replacement.clone()]);
        assert_eq!(service.current().unwrap(), replacement);
    }

    #[test]
    fn degraded_service_hydrates_a_readable_saved_snapshot_without_a_native_watch() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_file(dir.path());
        let saved = Settings {
            autosave: AutosaveSettings {
                enabled: false,
                interval_ms: 3600,
            },
            reveal_markup_at_cursor: true,
            ..Settings::default()
        };
        save(&path, &saved).unwrap();
        let observer = Arc::new(RecordingObserver::default());
        let service = SettingsService::degraded(&path, observer.clone());

        assert_eq!(service.current().unwrap(), saved);
        let committed = service
            .patch(SettingsPatch {
                notifications: Some(NotificationPatch { completion: false }),
                ..SettingsPatch::default()
            })
            .unwrap();

        assert!(committed.reveal_markup_at_cursor);
        assert!(!committed.autosave.enabled);
        assert_eq!(committed.autosave.interval_ms, 3600);
        assert!(!committed.notifications.completion);
        assert_eq!(service.current().unwrap(), committed);
        assert_eq!(observer.wait_for(1), vec![committed]);
    }

    #[test]
    fn a_successful_patch_recovers_a_degraded_service_from_its_initial_load_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_file(dir.path());
        fs::write(&path, "{invalid json").unwrap();
        let observer = Arc::new(RecordingObserver::default());
        let service = SettingsService::degraded(&path, observer.clone());

        assert_eq!(
            service.current().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let repaired = Settings {
            provider_default: Some("claude".to_string()),
            ..Settings::default()
        };
        save(&path, &repaired).unwrap();
        let committed = service
            .patch(SettingsPatch {
                reveal_markup_at_cursor: Some(true),
                ..SettingsPatch::default()
            })
            .unwrap();

        assert_eq!(committed.provider_default.as_deref(), Some("claude"));
        assert!(committed.reveal_markup_at_cursor);
        assert_eq!(service.current().unwrap(), committed);
        assert_eq!(observer.wait_for(1), vec![committed]);
    }

    #[test]
    fn degraded_service_keeps_an_unreadable_initial_path_honest_until_retry_can_load_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_file(dir.path());
        fs::create_dir(&path).unwrap();
        let service = SettingsService::degraded(&path, Arc::new(RecordingObserver::default()));

        assert!(service.current().is_err());

        fs::remove_dir(&path).unwrap();
        let repaired = Settings {
            reveal_markup_at_cursor: true,
            ..Settings::default()
        };
        save(&path, &repaired).unwrap();

        assert_eq!(service.current().unwrap(), repaired);
    }
}
