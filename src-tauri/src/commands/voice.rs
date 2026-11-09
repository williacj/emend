// ABOUTME: Typed Settings and dictation commands for one Rust-owned local voice session.
// ABOUTME: Emits voice phases without inserting any transcript into an editor or composer.

#[cfg(feature = "voice-capture")]
use std::future::Future;
use std::sync::Arc;
#[cfg(feature = "voice-capture")]
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::settings::SettingsService;
use crate::voice::model_download::HttpTransport;
use crate::voice::settings::{ProductionVoiceRuntime, VoiceError, VoiceStartReceipt, VoiceStatus};

pub const VOICE_DOWNLOAD_EVENT: &str = "voice://download";
pub const VOICE_DICTATION_EVENT: &str = "voice://dictation";

// An inference pass may take longer than this; awaiting each pass prevents overlapping snapshots.
// SPIKE-5's <16 ms figure measures only the editor ghost dispatch, not speech-to-ink latency.
#[cfg(feature = "voice-capture")]
const LIVE_UPDATE_INTERVAL: Duration = Duration::from_millis(750);

#[cfg(feature = "voice-capture")]
pub(crate) async fn live_update_worker<Update, UpdateFuture>(mut update: Update)
where
    Update: FnMut() -> UpdateFuture,
    UpdateFuture: Future<Output = bool>,
{
    loop {
        tokio::time::sleep(LIVE_UPDATE_INTERVAL).await;
        if !update().await {
            break;
        }
    }
}

#[tauri::command]
pub async fn get_voice_status(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
) -> Result<VoiceStatus, VoiceError> {
    let runtime = Arc::clone(&runtime);
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsService>();
        runtime.status(&settings)
    })
    .await
    .map_err(|_| VoiceError::DictationUnavailable)?
}

#[tauri::command]
pub fn set_voice_enabled(
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
    settings: State<'_, SettingsService>,
    enabled: bool,
) -> Result<VoiceStatus, VoiceError> {
    runtime.set_enabled(&settings, enabled)?;
    runtime.status(&settings)
}

#[tauri::command]
pub fn select_voice_input_device(
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
    settings: State<'_, SettingsService>,
    device_id: Option<String>,
) -> Result<VoiceStatus, VoiceError> {
    runtime.select_input_device(&settings, device_id.as_deref())?;
    runtime.status(&settings)
}

#[tauri::command]
pub async fn download_voice_model(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
) -> Result<(), VoiceError> {
    let runtime = Arc::clone(&runtime);
    tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new().map_err(|_| VoiceError::DownloadUnavailable)?;
        runtime.download_model_with_notice(transport, |notice| {
            let _ = app.emit(VOICE_DOWNLOAD_EVENT, notice);
        })
    })
    .await
    .map_err(|_| VoiceError::DownloadUnavailable)?
}

#[tauri::command]
pub fn cancel_voice_download(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
) -> Result<(), VoiceError> {
    runtime.cancel_model_download_with_event(|notice| {
        let _ = app.emit(VOICE_DOWNLOAD_EVENT, notice);
    })
}

#[tauri::command]
pub fn remove_voice_model(
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
    settings: State<'_, SettingsService>,
) -> Result<VoiceStatus, VoiceError> {
    runtime.remove_model()?;
    runtime.status(&settings)
}

#[tauri::command]
pub async fn start_voice_dictation(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
) -> Result<VoiceStartReceipt, VoiceError> {
    let runtime = Arc::clone(&runtime);
    #[cfg(feature = "voice-capture")]
    let live_runtime = Arc::clone(&runtime);
    #[cfg(feature = "voice-capture")]
    let live_app = app.clone();
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsService>();
        runtime.start_dictation(&settings, |event| {
            let _ = app.emit(VOICE_DICTATION_EVENT, event);
        })
    })
    .await
    .map_err(|_| VoiceError::DictationUnavailable)??;
    #[cfg(feature = "voice-capture")]
    {
        let generation = receipt.accepted_generation;
        // Each accepted session owns one sequential polling worker. The Rust generation check
        // ends it after Stop/Cancel/restart; inference runs off the UI thread and never overlaps
        // another update from this worker.
        tauri::async_runtime::spawn(live_update_worker(move || {
            let runtime = Arc::clone(&live_runtime);
            let app = live_app.clone();
            async move {
                let continued = tauri::async_runtime::spawn_blocking(move || {
                    runtime.update_dictation(generation, |event| {
                        let _ = app.emit(VOICE_DICTATION_EVENT, event);
                    })
                })
                .await;
                matches!(continued, Ok(Ok(true)))
            }
        }));
    }
    Ok(receipt)
}

#[tauri::command]
pub async fn stop_voice_dictation(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
) -> Result<VoiceStatus, VoiceError> {
    let runtime = Arc::clone(&runtime);
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsService>();
        runtime.stop_dictation(&settings, |event| {
            let _ = app.emit(VOICE_DICTATION_EVENT, event);
        })
    })
    .await
    .map_err(|_| VoiceError::DictationUnavailable)?
}

#[tauri::command]
pub fn cancel_voice_dictation(
    app: AppHandle,
    runtime: State<'_, Arc<ProductionVoiceRuntime>>,
    settings: State<'_, SettingsService>,
    expected_generation: u64,
) -> Result<VoiceStatus, VoiceError> {
    runtime.cancel_dictation(&settings, expected_generation, |event| {
        let _ = app.emit(VOICE_DICTATION_EVENT, event);
    })
}
