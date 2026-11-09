// ABOUTME: Local transcript store IPC (P2a-17, D15) — thin commands over `store::transcript`,
// ABOUTME: resolving the OS app-local-data dir from the Tauri app handle; append/read/keying stay in the store.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::store::transcript::{self, TranscriptEvent};

/// A transcript command failed. Serializable so it crosses the IPC boundary as a typed JS error.
/// `Config` = the OS app-local-data dir couldn't be resolved; `Io` = an append/read failure.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    Config(String),
    Io(String),
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        CommandError::Io(e.to_string())
    }
}

/// `<app-local-data-dir>/transcripts/<project_key(root)>/transcript.jsonl` (D15: local to the
/// machine, never under `<root>/.emend/`). `app_local_data_dir` — not `app_config_dir`, which
/// `commands::settings` uses — because some platforms sync `app_data_dir` (e.g. iCloud Drive on
/// macOS); the local-data variant is the one Tauri guarantees stays on this machine only.
fn transcript_path<R: Runtime>(
    app: &AppHandle<R>,
    root: &str,
) -> Result<std::path::PathBuf, CommandError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(transcript::transcript_file(
        &dir,
        std::path::Path::new(root),
    ))
}

/// Persists one rendered timeline card (the frontend `timeline/types.ts` `TimelineCard` union,
/// shaped into `TranscriptEvent` by `timeline/ipc.ts`) to `root`'s local transcript store.
#[tauri::command]
pub fn append_transcript_event<R: Runtime>(
    app: AppHandle<R>,
    root: String,
    event: TranscriptEvent,
) -> Result<(), CommandError> {
    transcript::append(&transcript_path(&app, &root)?, &event)?;
    Ok(())
}

/// Loads `root`'s persisted transcript, in original append order — what `TimelinePanel` seeds
/// `initialCards` with on project reopen (P2a-16's rehydrate path).
#[tauri::command]
pub fn load_transcript<R: Runtime>(
    app: AppHandle<R>,
    root: String,
) -> Result<Vec<TranscriptEvent>, CommandError> {
    Ok(transcript::read_all(&transcript_path(&app, &root)?)?)
}
