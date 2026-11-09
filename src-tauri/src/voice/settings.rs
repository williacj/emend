// ABOUTME: Rust-owned voice Settings state for local model and microphone availability.
// ABOUTME: Keeps selected hardware and download status truthful across Settings commands.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

#[cfg(feature = "voice-capture")]
use std::sync::mpsc;

use serde::Serialize;

use super::capture::{CaptureBackend, CaptureError, CaptureService, InputDevice};
use super::catalog::{default_catalog_model, CatalogModel};
use super::model_download::{
    DownloadCancellation, DownloadControl, DownloadEvent, DownloadFailure, DownloadTransport,
    ModelDownloader,
};
use super::model_registry::{ModelOrigin, ModelRegistry, ModelState};
#[cfg(feature = "voice-inference")]
use super::transcription::WhisperTranscriber;
#[cfg(feature = "voice-capture")]
use super::transcription::{
    Transcriber, TranscriptionError, TranscriptionEvent, TranscriptionEventKind, VoiceTranscription,
};
use crate::store::settings::{Settings, SettingsService};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceError {
    CaptureActive,
    DeviceUnavailable,
    NoDevice,
    NoDefaultDevice,
    PermissionDenied,
    BackendUnavailable,
    SettingsUnavailable,
    ModelUnavailable,
    DownloadUnavailable,
    VoiceDisabled,
    DictationUnavailable,
    NotRecording,
    InvalidAudio,
}

fn device_error(error: CaptureError) -> VoiceError {
    match error {
        CaptureError::NoDevice => VoiceError::NoDevice,
        CaptureError::NoDefaultDevice => VoiceError::NoDefaultDevice,
        CaptureError::DeviceUnavailable { .. } => VoiceError::DeviceUnavailable,
        CaptureError::PermissionDenied => VoiceError::PermissionDenied,
        _ => VoiceError::BackendUnavailable,
    }
}

#[cfg(feature = "voice-capture")]
fn capture_issue(error: &CaptureError) -> VoiceDictationIssue {
    match error {
        CaptureError::NoDevice => VoiceDictationIssue::NoDevice,
        CaptureError::NoDefaultDevice => VoiceDictationIssue::NoDefaultDevice,
        CaptureError::DeviceUnavailable { .. } => VoiceDictationIssue::SelectedUnavailable,
        CaptureError::PermissionDenied => VoiceDictationIssue::PermissionDenied,
        _ => VoiceDictationIssue::BackendUnavailable,
    }
}

#[cfg(feature = "voice-capture")]
fn stop_issue(error: &CaptureError) -> VoiceDictationIssue {
    match error {
        CaptureError::CaptureFailed(_) => VoiceDictationIssue::InvalidAudio,
        _ => capture_issue(error),
    }
}

#[cfg(feature = "voice-capture")]
fn stop_error(error: CaptureError) -> VoiceError {
    match error {
        CaptureError::CaptureFailed(_) => VoiceError::InvalidAudio,
        _ => device_error(error),
    }
}

#[cfg(feature = "voice-capture")]
fn transcription_issue(error: &TranscriptionError) -> VoiceDictationIssue {
    match error {
        TranscriptionError::MissingModel => VoiceDictationIssue::ModelMissing,
        TranscriptionError::CorruptModel => VoiceDictationIssue::ModelCorrupt,
        TranscriptionError::InvalidAudio => VoiceDictationIssue::InvalidAudio,
        _ => VoiceDictationIssue::InferenceFailed,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceModelState {
    Absent,
    Missing,
    Corrupt,
    Ready,
}

pub use super::model_registry::ModelOrigin as VoiceModelOrigin;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceDeviceIssue {
    NoDevice,
    NoDefaultDevice,
    SelectedUnavailable,
    PermissionDenied,
    BackendUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VoiceStatus {
    pub enabled: bool,
    pub selected_device_id: Option<String>,
    /// Persisted display fallback for a disconnected selection; capture uses the ID only.
    pub selected_device_name: Option<String>,
    pub devices: Vec<InputDevice>,
    pub device_issue: Option<VoiceDeviceIssue>,
    pub model: VoiceModelState,
    pub model_origin: Option<VoiceModelOrigin>,
    pub external_model_path: Option<String>,
    pub download: VoiceDownloadPhase,
    pub download_revision: u64,
    pub capture_active: bool,
    pub inference_available: bool,
    pub dictation: VoiceDictationPhase,
    /// The accepted session identity while recording or transcribing.
    pub dictation_generation: Option<u64>,
}

/// The immutable Start acceptance and a separate, current owner snapshot. Another command may
/// cancel this session and start a successor before the status read completes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VoiceStartReceipt {
    pub accepted_generation: u64,
    #[serde(flatten)]
    pub status: VoiceStatus,
}

impl Deref for VoiceStartReceipt {
    type Target = VoiceStatus;

    fn deref(&self) -> &Self::Target {
        &self.status
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceDictationIssue {
    NoDevice,
    NoDefaultDevice,
    SelectedUnavailable,
    PermissionDenied,
    BackendUnavailable,
    ModelMissing,
    ModelCorrupt,
    InvalidAudio,
    InferenceFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceDictationPhase {
    Idle,
    Recording { elapsed_seconds: u64 },
    Transcribing,
    Error { reason: VoiceDictationIssue },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceDictationEvent {
    Recording {
        generation: u64,
    },
    Partial {
        generation: u64,
        text: String,
    },
    Transcribing {
        generation: u64,
    },
    Final {
        generation: u64,
        text: String,
    },
    Failed {
        generation: u64,
        reason: VoiceDictationIssue,
    },
    Cancelled {
        generation: u64,
    },
}

struct DictationOwner {
    phase: VoiceDictationPhase,
    started_at: Option<Instant>,
    #[cfg(feature = "voice-capture")]
    generation: Option<u64>,
    #[cfg(feature = "voice-capture")]
    receiver: Option<mpsc::Receiver<TranscriptionEvent>>,
}

impl Default for DictationOwner {
    fn default() -> Self {
        Self {
            phase: VoiceDictationPhase::Idle,
            started_at: None,
            #[cfg(feature = "voice-capture")]
            generation: None,
            #[cfg(feature = "voice-capture")]
            receiver: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceDownloadPhase {
    Idle,
    Progress { downloaded: u64, total: u64 },
    Cancelling,
    Completed,
    Cancelled { downloaded: u64, total: u64 },
    Failed { reason: VoiceDownloadIssue },
}

/// Revision is assigned when the Rust owner accepts a phase, before external event delivery.
/// A consumer may discard a late event with an older revision than its current snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VoiceDownloadNotice {
    pub revision: u64,
    pub phase: VoiceDownloadPhase,
}

struct DownloadState {
    revision: u64,
    phase: VoiceDownloadPhase,
}

impl DownloadState {
    fn advance(&mut self, phase: VoiceDownloadPhase) -> VoiceDownloadNotice {
        self.revision += 1;
        self.phase = phase.clone();
        VoiceDownloadNotice {
            revision: self.revision,
            phase,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceDownloadIssue {
    Transport,
    Storage,
    Registry,
    Protocol,
    Truncated,
    Oversized,
    Corrupt,
    Cancelled,
}

impl From<DownloadFailure> for VoiceDownloadIssue {
    fn from(value: DownloadFailure) -> Self {
        match value {
            DownloadFailure::Transport(_) => Self::Transport,
            DownloadFailure::Storage(_) => Self::Storage,
            DownloadFailure::Registry(_) => Self::Registry,
            DownloadFailure::Protocol => Self::Protocol,
            DownloadFailure::Truncated { .. } => Self::Truncated,
            DownloadFailure::Oversized { .. } => Self::Oversized,
            DownloadFailure::Corrupt(_) => Self::Corrupt,
            DownloadFailure::Cancelled => Self::Cancelled,
        }
    }
}

pub struct VoiceRuntime<B: CaptureBackend> {
    capture: Mutex<CaptureService<B>>,
    registry: ModelRegistry,
    app_local_data_dir: PathBuf,
    model: CatalogModel,
    download: Mutex<DownloadState>,
    active_download: AtomicBool,
    download_cancel_token: Mutex<Option<DownloadCancellation>>,
    dictation: Mutex<DictationOwner>,
    #[cfg(feature = "voice-capture")]
    transcription: Option<VoiceTranscription<Box<dyn Transcriber>>>,
}

impl<B: CaptureBackend> VoiceRuntime<B> {
    pub fn new(app_local_data_dir: impl AsRef<Path>, backend: B) -> Self {
        Self::with_model(app_local_data_dir, backend, default_catalog_model())
    }

    pub fn with_model(
        app_local_data_dir: impl AsRef<Path>,
        backend: B,
        model: CatalogModel,
    ) -> Self {
        #[cfg(feature = "voice-inference")]
        let transcriber: Option<Box<dyn Transcriber>> = Some(Box::new(WhisperTranscriber::new(
            ModelRegistry::new(app_local_data_dir.as_ref()),
        )));
        #[cfg(all(feature = "voice-capture", not(feature = "voice-inference")))]
        let transcriber: Option<Box<dyn Transcriber>> = None;
        #[cfg(feature = "voice-capture")]
        return Self::with_model_and_optional_transcriber(
            app_local_data_dir,
            backend,
            model,
            transcriber,
        );
        #[cfg(not(feature = "voice-capture"))]
        Self::with_model_and_optional_transcriber(app_local_data_dir, backend, model)
    }

    #[cfg(feature = "voice-capture")]
    pub fn with_model_and_transcriber(
        app_local_data_dir: impl AsRef<Path>,
        backend: B,
        model: CatalogModel,
        transcriber: Box<dyn Transcriber>,
    ) -> Self {
        Self::with_model_and_optional_transcriber(
            app_local_data_dir,
            backend,
            model,
            Some(transcriber),
        )
    }

    fn with_model_and_optional_transcriber(
        app_local_data_dir: impl AsRef<Path>,
        backend: B,
        model: CatalogModel,
        #[cfg(feature = "voice-capture")] transcriber: Option<Box<dyn Transcriber>>,
    ) -> Self {
        let dir = app_local_data_dir.as_ref().to_path_buf();
        Self {
            capture: Mutex::new(CaptureService::new(backend)),
            registry: ModelRegistry::new(&dir),
            app_local_data_dir: dir,
            model,
            download: Mutex::new(DownloadState {
                revision: 0,
                phase: VoiceDownloadPhase::Idle,
            }),
            active_download: AtomicBool::new(false),
            download_cancel_token: Mutex::new(None),
            dictation: Mutex::new(DictationOwner::default()),
            #[cfg(feature = "voice-capture")]
            transcription: transcriber.map(VoiceTranscription::new),
        }
    }

    pub fn status(&self, settings: &SettingsService) -> Result<VoiceStatus, VoiceError> {
        let settings = settings
            .current()
            .map_err(|_| VoiceError::SettingsUnavailable)?;
        let capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let (devices, device_issue) = match capture.devices() {
            Ok(devices) => {
                let issue = if devices.is_empty() {
                    Some(VoiceDeviceIssue::NoDevice)
                } else if let Some(selected) = &settings.voice.input_device_id {
                    (!devices.iter().any(|device| &device.id == selected))
                        .then_some(VoiceDeviceIssue::SelectedUnavailable)
                } else {
                    (!devices.iter().any(|device| device.is_default))
                        .then_some(VoiceDeviceIssue::NoDefaultDevice)
                };
                (devices, issue)
            }
            Err(CaptureError::PermissionDenied) => {
                (Vec::new(), Some(VoiceDeviceIssue::PermissionDenied))
            }
            Err(_) => (Vec::new(), Some(VoiceDeviceIssue::BackendUnavailable)),
        };
        let model_state = self
            .registry
            .status(&self.model.spec.id)
            .map_err(|_| VoiceError::ModelUnavailable)?;
        let (model, record) = match &model_state {
            ModelState::Absent => (VoiceModelState::Absent, None),
            ModelState::Missing(record) => (VoiceModelState::Missing, Some(record)),
            ModelState::Corrupt { record, .. } => (VoiceModelState::Corrupt, Some(record)),
            ModelState::Ready(record) => (VoiceModelState::Ready, Some(record)),
        };
        let model_origin = record.and_then(|record| self.registry.origin(record));
        let external_model_path = match (model_origin, record) {
            (Some(ModelOrigin::External), Some(record)) => record.path.to_str().map(str::to_owned),
            _ => None,
        };
        let owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        let dictation = match &owner.phase {
            VoiceDictationPhase::Recording { .. } => VoiceDictationPhase::Recording {
                elapsed_seconds: owner
                    .started_at
                    .map(|started| started.elapsed().as_secs())
                    .unwrap_or(0),
            },
            phase => phase.clone(),
        };
        let download = self
            .download
            .lock()
            .map_err(|_| VoiceError::DownloadUnavailable)?;
        Ok(VoiceStatus {
            enabled: settings.voice.enabled,
            selected_device_id: settings.voice.input_device_id,
            selected_device_name: settings.voice.input_device_name,
            devices,
            device_issue,
            model,
            model_origin,
            external_model_path,
            download: download.phase.clone(),
            download_revision: download.revision,
            capture_active: capture.is_recording(),
            inference_available: {
                #[cfg(feature = "voice-capture")]
                {
                    self.transcription.is_some()
                }
                #[cfg(not(feature = "voice-capture"))]
                {
                    false
                }
            },
            dictation,
            dictation_generation: {
                #[cfg(feature = "voice-capture")]
                {
                    owner.generation
                }
                #[cfg(not(feature = "voice-capture"))]
                {
                    None
                }
            },
        })
    }

    #[cfg(feature = "voice-capture")]
    pub fn start_dictation(
        &self,
        settings: &SettingsService,
        on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStartReceipt, VoiceError> {
        self.start_dictation_with_status_read(settings, on_event, || self.status(settings))
    }

    #[cfg(feature = "voice-capture")]
    fn start_dictation_with_status_read(
        &self,
        settings: &SettingsService,
        mut on_event: impl FnMut(VoiceDictationEvent),
        read_status: impl FnOnce() -> Result<VoiceStatus, VoiceError>,
    ) -> Result<VoiceStartReceipt, VoiceError> {
        let preferences = settings
            .current()
            .map_err(|_| VoiceError::SettingsUnavailable)?;
        if !preferences.voice.enabled {
            return Err(VoiceError::VoiceDisabled);
        }
        let transcription = self
            .transcription
            .as_ref()
            .ok_or(VoiceError::DictationUnavailable)?;
        match self
            .registry
            .status(&self.model.spec.id)
            .map_err(|_| VoiceError::ModelUnavailable)?
        {
            ModelState::Ready(_) => {}
            _ => return Err(VoiceError::ModelUnavailable),
        }
        let mut capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let mut owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if matches!(
            owner.phase,
            VoiceDictationPhase::Recording { .. } | VoiceDictationPhase::Transcribing
        ) {
            return Err(VoiceError::CaptureActive);
        }
        if let Err(error) = capture.start(preferences.voice.input_device_id.as_deref()) {
            owner.phase = VoiceDictationPhase::Error {
                reason: capture_issue(&error),
            };
            return Err(device_error(error));
        }
        let (generation, receiver) = match transcription.start(&self.model.spec.id) {
            Ok(started) => started,
            Err(_) => {
                let _ = capture.stop();
                return Err(VoiceError::DictationUnavailable);
            }
        };
        owner.phase = VoiceDictationPhase::Recording { elapsed_seconds: 0 };
        owner.started_at = Some(Instant::now());
        owner.generation = Some(generation);
        owner.receiver = Some(receiver);
        on_event(VoiceDictationEvent::Recording { generation });
        drop(owner);
        drop(capture);
        Ok(VoiceStartReceipt {
            accepted_generation: generation,
            status: read_status()?,
        })
    }

    #[cfg(not(feature = "voice-capture"))]
    pub fn start_dictation(
        &self,
        _settings: &SettingsService,
        _on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStartReceipt, VoiceError> {
        Err(VoiceError::DictationUnavailable)
    }

    /// Process one live capture snapshot for the accepted session. The caller schedules this on
    /// a worker; inference never holds the capture/owner locks needed by Stop and Cancel.
    #[cfg(feature = "voice-capture")]
    pub fn update_dictation(
        &self,
        generation: u64,
        mut on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<bool, VoiceError> {
        let transcription = self
            .transcription
            .as_ref()
            .ok_or(VoiceError::DictationUnavailable)?;
        let capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if owner.generation != Some(generation)
            || !matches!(owner.phase, VoiceDictationPhase::Recording { .. })
        {
            return Ok(false);
        }
        let audio = capture.snapshot_for_transcription();
        drop(owner);
        drop(capture);
        let audio = match audio {
            Ok(audio) => audio,
            Err(error) => {
                return self.fail_dictation_update(generation, stop_issue(&error), &mut on_event)
            }
        };
        if audio.samples.is_empty() {
            return Ok(true);
        }
        match transcription.update(generation, &audio) {
            Ok(()) => {}
            Err(TranscriptionError::Cancelled | TranscriptionError::NotRecording) => {
                return Ok(false)
            }
            Err(error) => {
                return self.fail_dictation_update(
                    generation,
                    transcription_issue(&error),
                    &mut on_event,
                )
            }
        }
        let owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if owner.generation != Some(generation)
            || !matches!(owner.phase, VoiceDictationPhase::Recording { .. })
        {
            return Ok(false);
        }
        if let Some(receiver) = &owner.receiver {
            for event in receiver.try_iter() {
                if let TranscriptionEventKind::Partial(text) = event.kind {
                    on_event(VoiceDictationEvent::Partial { generation, text });
                }
            }
        }
        Ok(true)
    }

    #[cfg(feature = "voice-capture")]
    fn fail_dictation_update(
        &self,
        generation: u64,
        reason: VoiceDictationIssue,
        on_event: &mut impl FnMut(VoiceDictationEvent),
    ) -> Result<bool, VoiceError> {
        let mut capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let mut owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if owner.generation != Some(generation)
            || !matches!(owner.phase, VoiceDictationPhase::Recording { .. })
        {
            return Ok(false);
        }
        let _ = capture.stop();
        if let Some(transcription) = &self.transcription {
            let _ = transcription.cancel(generation);
        }
        owner.phase = VoiceDictationPhase::Error {
            reason: reason.clone(),
        };
        owner.started_at = None;
        owner.generation = None;
        owner.receiver = None;
        on_event(VoiceDictationEvent::Failed { generation, reason });
        Ok(false)
    }

    #[cfg(feature = "voice-capture")]
    pub fn stop_dictation(
        &self,
        settings: &SettingsService,
        mut on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStatus, VoiceError> {
        let transcription = self
            .transcription
            .as_ref()
            .ok_or(VoiceError::DictationUnavailable)?;
        let mut capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let mut owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if !matches!(owner.phase, VoiceDictationPhase::Recording { .. }) {
            return Err(VoiceError::NotRecording);
        }
        let generation = owner.generation.ok_or(VoiceError::NotRecording)?;
        let receiver = owner.receiver.take().ok_or(VoiceError::NotRecording)?;
        let audio = match capture.stop_for_transcription() {
            Ok(audio) => audio,
            Err(error) => {
                let _ = transcription.cancel(generation);
                let reason = stop_issue(&error);
                owner.phase = VoiceDictationPhase::Error {
                    reason: reason.clone(),
                };
                owner.started_at = None;
                owner.generation = None;
                on_event(VoiceDictationEvent::Failed { generation, reason });
                drop(owner);
                drop(capture);
                return Err(stop_error(error));
            }
        };
        owner.phase = VoiceDictationPhase::Transcribing;
        owner.started_at = None;
        on_event(VoiceDictationEvent::Transcribing { generation });
        drop(owner);
        drop(capture);

        let result = transcription.finish(generation, &audio);
        let terminal = receiver.try_iter().find_map(|event| match event.kind {
            TranscriptionEventKind::Final(text) => {
                Some(VoiceDictationEvent::Final { generation, text })
            }
            TranscriptionEventKind::Failed(error) => Some(VoiceDictationEvent::Failed {
                generation,
                reason: transcription_issue(&error),
            }),
            _ => None,
        });
        let event = terminal.unwrap_or_else(|| match &result {
            Err(error) => VoiceDictationEvent::Failed {
                generation,
                reason: transcription_issue(error),
            },
            Ok(()) => VoiceDictationEvent::Failed {
                generation,
                reason: VoiceDictationIssue::InferenceFailed,
            },
        });
        let mut owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if owner.generation != Some(generation) {
            drop(owner);
            return self.status(settings);
        }
        owner.generation = None;
        owner.phase = match &event {
            VoiceDictationEvent::Final { .. } => VoiceDictationPhase::Idle,
            VoiceDictationEvent::Failed { reason, .. } => VoiceDictationPhase::Error {
                reason: reason.clone(),
            },
            _ => unreachable!("terminal event selected above"),
        };
        on_event(event);
        drop(owner);
        self.status(settings)
    }

    #[cfg(feature = "voice-capture")]
    pub fn cancel_dictation(
        &self,
        settings: &SettingsService,
        expected_generation: u64,
        mut on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStatus, VoiceError> {
        let mut capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let mut owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if owner.generation != Some(expected_generation) {
            drop(owner);
            drop(capture);
            return self.status(settings);
        }
        let transcription = self
            .transcription
            .as_ref()
            .ok_or(VoiceError::DictationUnavailable)?;
        let generation = owner.generation.take().expect("matched above");
        if matches!(owner.phase, VoiceDictationPhase::Recording { .. }) {
            let _ = capture.stop(); // Explicit cancellation discards these bytes.
        }
        // A Stop worker may have completed inference just before it reacquires this owner.
        // Its terminal remains fenced by our cleared generation, so cancellation still wins.
        match transcription.cancel(generation) {
            Ok(()) | Err(TranscriptionError::NotRecording) => {}
            Err(_) => return Err(VoiceError::DictationUnavailable),
        }
        owner.phase = VoiceDictationPhase::Idle;
        owner.started_at = None;
        owner.receiver = None;
        on_event(VoiceDictationEvent::Cancelled { generation });
        drop(owner);
        drop(capture);
        self.status(settings)
    }

    #[cfg(not(feature = "voice-capture"))]
    pub fn cancel_dictation(
        &self,
        settings: &SettingsService,
        _expected_generation: u64,
        _on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStatus, VoiceError> {
        self.status(settings)
    }

    #[cfg(not(feature = "voice-capture"))]
    pub fn stop_dictation(
        &self,
        _settings: &SettingsService,
        _on_event: impl FnMut(VoiceDictationEvent),
    ) -> Result<VoiceStatus, VoiceError> {
        Err(VoiceError::DictationUnavailable)
    }

    pub fn download_model<T: DownloadTransport>(
        &self,
        transport: T,
        mut on_phase: impl FnMut(VoiceDownloadPhase),
    ) -> Result<(), VoiceError> {
        self.download_model_with_notice(transport, |notice| on_phase(notice.phase))
    }

    pub fn download_model_with_notice<T: DownloadTransport>(
        &self,
        transport: T,
        on_notice: impl FnMut(VoiceDownloadNotice),
    ) -> Result<(), VoiceError> {
        self.download_model_with_notice_configured(transport, on_notice, |downloader| downloader)
    }

    fn download_model_with_notice_configured<T: DownloadTransport>(
        &self,
        transport: T,
        mut on_notice: impl FnMut(VoiceDownloadNotice),
        configure: impl FnOnce(ModelDownloader<T>) -> ModelDownloader<T>,
    ) -> Result<(), VoiceError> {
        let token = {
            let mut slot = self
                .download_cancel_token
                .lock()
                .map_err(|_| VoiceError::DownloadUnavailable)?;
            if self.active_download.swap(true, Ordering::SeqCst) {
                return Err(VoiceError::DownloadUnavailable);
            }
            let token = DownloadCancellation::new();
            *slot = Some(token.clone());
            token
        };
        struct Reset<'a> {
            active: &'a AtomicBool,
            slot: &'a Mutex<Option<DownloadCancellation>>,
        }
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                if let Ok(mut slot) = self.slot.lock() {
                    *slot = None;
                    self.active.store(false, Ordering::SeqCst);
                }
            }
        }
        let _reset = Reset {
            active: &self.active_download,
            slot: &self.download_cancel_token,
        };
        let downloader = configure(ModelDownloader::new(
            &self.app_local_data_dir,
            self.registry.clone(),
            transport,
        ));
        let mut last_downloaded = 0;
        let result =
            downloader.download_with_cancel(&self.model.spec, &self.model.url, &token, |event| {
                if let DownloadEvent::Progress { downloaded, .. } = &event {
                    last_downloaded = *downloaded;
                }
                let phase = match event {
                    DownloadEvent::Progress { downloaded, total } => {
                        VoiceDownloadPhase::Progress { downloaded, total }
                    }
                    DownloadEvent::Completed { .. } => VoiceDownloadPhase::Completed,
                    DownloadEvent::Cancelled { downloaded, total } => {
                        VoiceDownloadPhase::Cancelled { downloaded, total }
                    }
                    DownloadEvent::Failed { reason } => VoiceDownloadPhase::Failed {
                        reason: reason.into(),
                    },
                };
                let notice = if let Ok(mut current) = self.download.lock() {
                    let storage_failure = matches!(
                        phase,
                        VoiceDownloadPhase::Failed {
                            reason: VoiceDownloadIssue::Storage
                        }
                    );
                    if token.is_cancelled()
                        && !matches!(phase, VoiceDownloadPhase::Cancelled { .. })
                        && !storage_failure
                    {
                        return DownloadControl::Cancel;
                    }
                    current.advance(phase)
                } else {
                    return DownloadControl::Cancel;
                };
                on_notice(notice);
                if token.is_cancelled() {
                    DownloadControl::Cancel
                } else {
                    DownloadControl::Continue
                }
            });
        if token.is_cancelled() && !matches!(&result, Err(DownloadFailure::Storage(_))) {
            let mut current = self
                .download
                .lock()
                .map_err(|_| VoiceError::DownloadUnavailable)?;
            if matches!(current.phase, VoiceDownloadPhase::Cancelling) {
                // A late transport or protocol error cannot leave an accepted Cancel pending.
                // The count is the last confirmed write; a retry inspects the real partial length.
                let phase = VoiceDownloadPhase::Cancelled {
                    downloaded: last_downloaded,
                    total: self.model.spec.byte_len,
                };
                let notice = current.advance(phase);
                drop(current);
                on_notice(notice);
                return Ok(());
            }
        }
        match result {
            Ok(_) => Ok(()),
            Err(DownloadFailure::Cancelled) => Ok(()),
            Err(_) => Err(VoiceError::DownloadUnavailable),
        }
    }

    pub fn cancel_model_download(&self) -> Result<(), VoiceError> {
        self.cancel_model_download_with_event(|_| {})
    }

    pub fn cancel_model_download_with_event(
        &self,
        on_notice: impl FnOnce(VoiceDownloadNotice),
    ) -> Result<(), VoiceError> {
        let slot = self
            .download_cancel_token
            .lock()
            .map_err(|_| VoiceError::DownloadUnavailable)?;
        let token = slot.as_ref().ok_or(VoiceError::DownloadUnavailable)?;
        let mut current = self
            .download
            .lock()
            .map_err(|_| VoiceError::DownloadUnavailable)?;
        if matches!(
            current.phase,
            VoiceDownloadPhase::Completed
                | VoiceDownloadPhase::Cancelled { .. }
                | VoiceDownloadPhase::Failed { .. }
        ) {
            return Err(VoiceError::DownloadUnavailable);
        }
        if matches!(current.phase, VoiceDownloadPhase::Cancelling) {
            return Ok(());
        }
        if !token.cancel() {
            return Err(VoiceError::DownloadUnavailable);
        }
        let notice = current.advance(VoiceDownloadPhase::Cancelling);
        drop(current);
        drop(slot);
        on_notice(notice);
        Ok(())
    }

    pub fn remove_model(&self) -> Result<(), VoiceError> {
        if self.active_download.load(Ordering::SeqCst) {
            return Err(VoiceError::DownloadUnavailable);
        }
        let capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        if capture.is_recording() {
            return Err(VoiceError::CaptureActive);
        }
        let owner = self
            .dictation
            .lock()
            .map_err(|_| VoiceError::DictationUnavailable)?;
        if matches!(
            owner.phase,
            VoiceDictationPhase::Recording { .. } | VoiceDictationPhase::Transcribing
        ) {
            return Err(VoiceError::CaptureActive);
        }
        drop(owner);
        self.registry
            .remove_managed(&self.model.spec)
            .map_err(|_| VoiceError::ModelUnavailable)?;
        self.download
            .lock()
            .map_err(|_| VoiceError::DownloadUnavailable)?
            .advance(VoiceDownloadPhase::Idle);
        Ok(())
    }

    pub fn select_input_device(
        &self,
        settings: &SettingsService,
        id: Option<&str>,
    ) -> Result<Settings, VoiceError> {
        let capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        let current = settings
            .current()
            .map_err(|_| VoiceError::SettingsUnavailable)?;
        if capture.is_recording() && current.voice.input_device_id.as_deref() != id {
            return Err(VoiceError::CaptureActive);
        }
        let devices = capture.devices().map_err(device_error)?;
        let selected = match id {
            Some(id) => Some(
                devices
                    .iter()
                    .find(|device| device.id == id)
                    .ok_or(VoiceError::DeviceUnavailable)?,
            ),
            None if devices.is_empty() => return Err(VoiceError::NoDevice),
            None if !devices.iter().any(|device| device.is_default) => {
                return Err(VoiceError::NoDefaultDevice)
            }
            None => None,
        };
        settings
            .patch_voice(
                None,
                Some(selected.map(|device| (device.id.clone(), device.name.clone()))),
            )
            .map_err(|_| VoiceError::SettingsUnavailable)
    }

    pub fn set_enabled(
        &self,
        settings: &SettingsService,
        enabled: bool,
    ) -> Result<Settings, VoiceError> {
        let capture = self
            .capture
            .lock()
            .map_err(|_| VoiceError::BackendUnavailable)?;
        if capture.is_recording() && !enabled {
            return Err(VoiceError::CaptureActive);
        }
        settings
            .patch_voice(Some(enabled), None)
            .map_err(|_| VoiceError::SettingsUnavailable)
    }
}

#[cfg(feature = "voice-capture")]
pub type ProductionVoiceRuntime = VoiceRuntime<super::capture::cpal_backend::CpalBackend>;

#[cfg(not(feature = "voice-capture"))]
pub type ProductionVoiceRuntime = VoiceRuntime<UnavailableBackend>;

#[cfg(not(feature = "voice-capture"))]
pub struct UnavailableBackend;

#[cfg(not(feature = "voice-capture"))]
pub struct UnavailableSession;

#[cfg(not(feature = "voice-capture"))]
impl super::capture::CaptureSession for UnavailableSession {
    fn snapshot(&self) -> Result<super::capture::CapturedAudio, CaptureError> {
        Err(CaptureError::BackendUnavailable(
            "voice capture is not built".into(),
        ))
    }

    fn stop(self) -> Result<super::capture::CapturedAudio, CaptureError> {
        Err(CaptureError::BackendUnavailable(
            "voice capture is not built".into(),
        ))
    }
}

#[cfg(not(feature = "voice-capture"))]
impl CaptureBackend for UnavailableBackend {
    type Session = UnavailableSession;
    fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
        Err(CaptureError::BackendUnavailable(
            "voice capture is not built".into(),
        ))
    }
    fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
        Ok(None)
    }
    fn open(&self, _id: &str) -> Result<Self::Session, CaptureError> {
        Err(CaptureError::BackendUnavailable(
            "voice capture is not built".into(),
        ))
    }
}

pub fn production_runtime(app_local_data_dir: impl AsRef<Path>) -> ProductionVoiceRuntime {
    #[cfg(feature = "voice-capture")]
    let backend = super::capture::cpal_backend::CpalBackend;
    #[cfg(not(feature = "voice-capture"))]
    let backend = UnavailableBackend;
    VoiceRuntime::new(app_local_data_dir, backend)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::settings::{Settings, SettingsObserver, SettingsService};
    use crate::voice::capture::{CaptureSession, CapturedAudio};
    use crate::voice::model_download::{
        DownloadFailure, DownloadResponse, DownloadTransport, ResponseRange,
    };
    use crate::voice::model_registry::ModelSpec;
    use std::fs::File;
    use std::io::{self, Cursor};
    use std::sync::Arc;

    #[cfg(feature = "voice-capture")]
    struct FixtureTranscriber;
    #[cfg(feature = "voice-capture")]
    impl crate::voice::transcription::Transcriber for FixtureTranscriber {
        fn transcribe(
            &self,
            model_id: &str,
            samples: &[f32],
            _partial: Arc<dyn Fn(String) + Send + Sync>,
            _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> Result<String, crate::voice::transcription::TranscriptionError> {
            assert_eq!(model_id, "dictation-fixture");
            assert!(!samples.is_empty());
            Ok("dictated words".into())
        }
    }

    struct NoopObserver;
    impl SettingsObserver for NoopObserver {
        fn changed(&self, _settings: &Settings) {}
    }

    struct FakeBackend;
    struct FakeSession;
    impl CaptureSession for FakeSession {
        fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
            Ok(CapturedAudio {
                sample_rate: 16_000,
                samples: vec![0.1; 160],
            })
        }

        fn stop(self) -> Result<CapturedAudio, CaptureError> {
            Ok(CapturedAudio {
                sample_rate: 16_000,
                samples: vec![0.1; 160],
            })
        }
    }
    impl CaptureBackend for FakeBackend {
        type Session = FakeSession;
        fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
            Ok(vec![
                InputDevice {
                    id: "mic-a".into(),
                    name: "Desk microphone".into(),
                    is_default: true,
                },
                InputDevice {
                    id: "mic-b".into(),
                    name: "USB microphone".into(),
                    is_default: false,
                },
            ])
        }
        fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
            Ok(Some("mic-a".into()))
        }
        fn open(&self, id: &str) -> Result<Self::Session, CaptureError> {
            assert!(
                matches!(id, "mic-a" | "mic-b"),
                "capture must use the device ID"
            );
            Ok(FakeSession)
        }
    }

    #[test]
    fn production_inference_availability_tracks_linked_feature() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let runtime = production_runtime(dir.path());
        assert_eq!(
            runtime.status(&settings).unwrap().inference_available,
            cfg!(feature = "voice-inference")
        );
    }

    #[cfg(not(feature = "voice-capture"))]
    #[test]
    fn conditional_cancel_without_capture_reports_idle_status() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let runtime = production_runtime(dir.path());
        let mut events = Vec::new();
        let status = runtime
            .cancel_dictation(&settings, 41, |event| events.push(event))
            .unwrap();
        assert_eq!(status.dictation_generation, None);
        assert_eq!(status.dictation, VoiceDictationPhase::Idle);
        assert!(events.is_empty());
    }

    #[test]
    fn changing_input_while_recording_is_refused_without_changing_persisted_selection() {
        let dir = tempfile::tempdir().unwrap();
        let path = crate::store::settings::settings_file(dir.path());
        let settings = SettingsService::degraded(&path, Arc::new(NoopObserver));
        settings
            .patch_voice(None, Some(Some(("mic-a".into(), "Desk microphone".into()))))
            .unwrap();
        let runtime = VoiceRuntime::new(dir.path(), FakeBackend);
        runtime
            .capture
            .lock()
            .unwrap()
            .start(Some("mic-a"))
            .unwrap();

        assert_eq!(
            runtime.select_input_device(&settings, Some("mic-b")),
            Err(VoiceError::CaptureActive)
        );
        assert_eq!(
            settings.current().unwrap().voice.input_device_id.as_deref(),
            Some("mic-a")
        );
        assert!(runtime.status(&settings).unwrap().capture_active);
        assert_eq!(
            runtime.set_enabled(&settings, false),
            Err(VoiceError::CaptureActive)
        );
        assert!(settings.current().unwrap().voice.enabled);
    }

    #[test]
    fn disappeared_selected_device_remains_selected_and_is_reported_until_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        settings
            .patch_voice(
                None,
                Some(Some(("unplugged-mic".into(), "Old microphone".into()))),
            )
            .unwrap();
        let runtime = VoiceRuntime::new(dir.path(), FakeBackend);

        let status = runtime.status(&settings).unwrap();
        assert_eq!(status.selected_device_id.as_deref(), Some("unplugged-mic"));
        assert_eq!(
            status.device_issue,
            Some(VoiceDeviceIssue::SelectedUnavailable)
        );
        assert_eq!(
            runtime.select_input_device(&settings, Some("unplugged-mic")),
            Err(VoiceError::DeviceUnavailable)
        );
        assert_eq!(
            settings.current().unwrap().voice.input_device_id.as_deref(),
            Some("unplugged-mic")
        );
        runtime
            .select_input_device(&settings, Some("mic-b"))
            .unwrap();
        assert_eq!(runtime.status(&settings).unwrap().device_issue, None);
    }

    #[test]
    fn selected_microphone_name_survives_restart_and_disconnection() {
        struct DisconnectedBackend;
        impl CaptureBackend for DisconnectedBackend {
            type Session = FakeSession;
            fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
                Ok(vec![InputDevice {
                    id: "mic-a".into(),
                    name: "Desk microphone".into(),
                    is_default: true,
                }])
            }
            fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
                Ok(Some("mic-a".into()))
            }
            fn open(&self, _id: &str) -> Result<Self::Session, CaptureError> {
                Ok(FakeSession)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = crate::store::settings::settings_file(dir.path());
        let settings = SettingsService::degraded(&path, Arc::new(NoopObserver));
        let connected = VoiceRuntime::new(dir.path(), FakeBackend);
        connected
            .select_input_device(&settings, Some("mic-b"))
            .unwrap();
        assert_eq!(
            settings
                .current()
                .unwrap()
                .voice
                .input_device_name
                .as_deref(),
            Some("USB microphone")
        );

        let reopened = SettingsService::degraded(&path, Arc::new(NoopObserver));
        let disconnected = VoiceRuntime::new(dir.path(), DisconnectedBackend);
        let status = disconnected.status(&reopened).unwrap();
        assert_eq!(status.selected_device_id.as_deref(), Some("mic-b"));
        assert_eq!(
            status.selected_device_name.as_deref(),
            Some("USB microphone")
        );
        assert_eq!(
            status.device_issue,
            Some(VoiceDeviceIssue::SelectedUnavailable)
        );
        assert!(!status.devices.iter().any(|device| device.id == "mic-b"));
        assert_eq!(
            serde_json::to_value(&status).unwrap()["selected_device_name"],
            "USB microphone"
        );

        disconnected.select_input_device(&reopened, None).unwrap();
        let cleared = disconnected.status(&reopened).unwrap();
        assert_eq!(cleared.selected_device_id, None);
        assert_eq!(cleared.selected_device_name, None);
        assert_eq!(cleared.device_issue, None);
    }

    #[test]
    fn explicit_reselection_refreshes_name_and_failed_choice_preserves_pair() {
        struct RenamedBackend;
        impl CaptureBackend for RenamedBackend {
            type Session = FakeSession;
            fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
                Ok(vec![
                    InputDevice {
                        id: "mic-a".into(),
                        name: "Desk microphone".into(),
                        is_default: true,
                    },
                    InputDevice {
                        id: "mic-b".into(),
                        name: "Renamed USB microphone".into(),
                        is_default: false,
                    },
                ])
            }
            fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
                Ok(Some("mic-a".into()))
            }
            fn open(&self, _id: &str) -> Result<Self::Session, CaptureError> {
                Ok(FakeSession)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = crate::store::settings::settings_file(dir.path());
        let settings = SettingsService::degraded(&path, Arc::new(NoopObserver));
        VoiceRuntime::new(dir.path(), FakeBackend)
            .select_input_device(&settings, Some("mic-b"))
            .unwrap();
        let renamed = VoiceRuntime::new(dir.path(), RenamedBackend);
        renamed
            .select_input_device(&settings, Some("mic-b"))
            .unwrap();
        let after_rename = renamed.status(&settings).unwrap();
        assert_eq!(after_rename.selected_device_id.as_deref(), Some("mic-b"));
        assert_eq!(
            after_rename.selected_device_name.as_deref(),
            Some("Renamed USB microphone")
        );

        assert_eq!(
            renamed.select_input_device(&settings, Some("missing")),
            Err(VoiceError::DeviceUnavailable)
        );
        assert_eq!(
            crate::store::settings::load(&path).unwrap().voice,
            settings.current().unwrap().voice
        );
        let after_refusal = renamed.status(&settings).unwrap();
        assert_eq!(
            after_refusal.selected_device_id,
            after_rename.selected_device_id
        );
        assert_eq!(
            after_refusal.selected_device_name,
            after_rename.selected_device_name
        );
    }

    struct FixtureTransport(Vec<u8>);

    fn fixture_digest(bytes: &[u8]) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(bytes);
        hasher.finalize().to_hex().to_string()
    }
    impl DownloadTransport for FixtureTransport {
        fn open(
            &self,
            _url: &str,
            offset: u64,
            _cancel: &crate::voice::model_download::DownloadCancellation,
        ) -> Result<DownloadResponse, DownloadFailure> {
            Ok(DownloadResponse {
                range: ResponseRange::From {
                    start: offset,
                    total: self.0.len() as u64,
                },
                stream: Box::new(Cursor::new(self.0[offset as usize..].to_vec())),
            })
        }
    }

    #[test]
    fn downloaded_model_progress_and_ready_status_follow_verified_backend_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"test model fixture";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/fixture.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model);
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Absent
        );
        let mut events = Vec::new();
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |event| events.push(event))
            .unwrap();
        assert!(events.iter().any(|event| matches!(event, VoiceDownloadPhase::Progress { downloaded, total } if *downloaded == *total && *total == bytes.len() as u64)));
        assert_eq!(events.last(), Some(&VoiceDownloadPhase::Completed));
        let status = runtime.status(&settings).unwrap();
        assert_eq!(status.model, VoiceModelState::Ready);
        assert_eq!(status.download, VoiceDownloadPhase::Completed);
    }

    #[test]
    fn voice_status_reports_registered_model_origin() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"trusted model bytes";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "origin-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/model.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model.clone());
        let absent = runtime.status(&settings).unwrap();
        assert_eq!(absent.model, VoiceModelState::Absent);
        assert_eq!(absent.model_origin, None);
        assert_eq!(absent.external_model_path, None);

        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let managed = runtime.status(&settings).unwrap();
        assert_eq!(managed.model, VoiceModelState::Ready);
        assert_eq!(managed.model_origin, Some(VoiceModelOrigin::Managed));
        assert_eq!(managed.external_model_path, None);
        let ModelState::Ready(record) = runtime.registry.status(&model.spec.id).unwrap() else {
            panic!("download must be registered");
        };
        std::fs::remove_file(&record.path).unwrap();
        let missing_managed = runtime.status(&settings).unwrap();
        assert_eq!(missing_managed.model, VoiceModelState::Missing);
        assert_eq!(
            missing_managed.model_origin,
            Some(VoiceModelOrigin::Managed)
        );
        std::fs::write(&record.path, b"untrusted model byte").unwrap();
        let corrupt_managed = runtime.status(&settings).unwrap();
        assert_eq!(corrupt_managed.model, VoiceModelState::Corrupt);
        assert_eq!(
            corrupt_managed.model_origin,
            Some(VoiceModelOrigin::Managed)
        );
        runtime.remove_model().unwrap();

        let external = dir.path().join("external-model.bin");
        std::fs::write(&external, bytes).unwrap();
        let external = std::fs::canonicalize(external).unwrap();
        runtime.registry.admit(&model.spec, &external).unwrap();
        let ready_external = runtime.status(&settings).unwrap();
        assert_eq!(ready_external.model, VoiceModelState::Ready);
        assert_eq!(
            ready_external.model_origin,
            Some(VoiceModelOrigin::External)
        );
        assert_eq!(
            ready_external.external_model_path.as_deref(),
            external.to_str()
        );
        std::fs::remove_file(&external).unwrap();
        let missing_external = runtime.status(&settings).unwrap();
        assert_eq!(missing_external.model, VoiceModelState::Missing);
        assert_eq!(
            missing_external.model_origin,
            Some(VoiceModelOrigin::External)
        );
        std::fs::write(&external, b"untrusted model byte").unwrap();
        let corrupt_external = runtime.status(&settings).unwrap();
        assert_eq!(corrupt_external.model, VoiceModelState::Corrupt);
        assert_eq!(
            corrupt_external.model_origin,
            Some(VoiceModelOrigin::External)
        );
        runtime.remove_model().unwrap();
        assert!(external.exists(), "external bytes must survive forgetting");
        assert_eq!(runtime.status(&settings).unwrap().model_origin, None);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn held_start_response_keeps_its_accepted_generation_after_cancel_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        ));
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(FixtureTranscriber),
        ));
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();

        let (old_event_tx, old_event_rx) = mpsc::channel();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first_runtime = Arc::clone(&runtime);
        let status_runtime = Arc::clone(&runtime);
        let first_settings = Arc::clone(&settings);
        let status_settings = Arc::clone(&settings);
        let first = std::thread::spawn(move || {
            first_runtime.start_dictation_with_status_read(
                &first_settings,
                |event| old_event_tx.send(event).unwrap(),
                || {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    status_runtime.status(&status_settings)
                },
            )
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let first_generation = match old_event_rx.recv().unwrap() {
            VoiceDictationEvent::Recording { generation } => generation,
            other => panic!("unexpected first event: {other:?}"),
        };
        runtime
            .cancel_dictation(&settings, first_generation, |_| {})
            .unwrap();
        let second = runtime.start_dictation(&settings, |_| {}).unwrap();
        let second_generation = second.accepted_generation;
        assert_ne!(first_generation, second_generation);

        release_tx.send(()).unwrap();
        let first = first.join().unwrap().unwrap();
        assert_eq!(first.accepted_generation, first_generation);
        assert_eq!(first.status.dictation_generation, Some(second_generation));
        let response = serde_json::to_value(&first).unwrap();
        assert_eq!(response["accepted_generation"], first_generation);
        assert_eq!(response["dictation_generation"], second_generation);
        assert!(!runtime
            .update_dictation(first.accepted_generation, |_| {})
            .unwrap());
        assert_eq!(
            runtime.status(&settings).unwrap().dictation_generation,
            Some(second_generation)
        );
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn dictation_starts_only_from_ready_model_and_emits_ordered_terminal_phases() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(FixtureTranscriber),
        );
        assert_eq!(
            runtime.start_dictation(&settings, |_| {}),
            Err(VoiceError::ModelUnavailable)
        );
        assert!(!runtime.status(&settings).unwrap().capture_active);
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        runtime.set_enabled(&settings, false).unwrap();
        assert_eq!(
            runtime.start_dictation(&settings, |_| {}),
            Err(VoiceError::VoiceDisabled)
        );
        runtime.set_enabled(&settings, true).unwrap();
        runtime
            .select_input_device(&settings, Some("mic-b"))
            .unwrap();

        let mut started = Vec::new();
        let status = runtime
            .start_dictation(&settings, |event| started.push(event))
            .unwrap();
        assert!(status.inference_available);
        assert_eq!(status.selected_device_id.as_deref(), Some("mic-b"));
        assert!(status.capture_active);
        assert!(matches!(
            status.dictation,
            VoiceDictationPhase::Recording { .. }
        ));
        let generation = status.dictation_generation.expect("accepted generation");
        assert_eq!(started, [VoiceDictationEvent::Recording { generation }]);

        let mut stopped = Vec::new();
        let status = runtime
            .stop_dictation(&settings, |event| stopped.push(event))
            .unwrap();
        assert_eq!(
            stopped,
            [
                VoiceDictationEvent::Transcribing { generation },
                VoiceDictationEvent::Final {
                    generation,
                    text: "dictated words".into()
                },
            ]
        );
        assert_eq!(status.dictation, VoiceDictationPhase::Idle);
        assert!(!status.capture_active);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn live_dictation_update_emits_correlated_partial_before_stop() {
        struct LiveTranscriber;
        impl crate::voice::transcription::Transcriber for LiveTranscriber {
            fn transcribe(
                &self,
                _model_id: &str,
                samples: &[f32],
                partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, crate::voice::transcription::TranscriptionError> {
                assert!(!samples.is_empty());
                partial("live words".into());
                Ok("live words".into())
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(LiveTranscriber),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let mut events = Vec::new();
        assert!(runtime
            .update_dictation(generation, |event| events.push(event))
            .unwrap());
        assert_eq!(
            events,
            [VoiceDictationEvent::Partial {
                generation,
                text: "live words".into(),
            }]
        );
        assert!(matches!(
            runtime.status(&settings).unwrap().dictation,
            VoiceDictationPhase::Recording { .. }
        ));
        runtime.stop_dictation(&settings, |_| {}).unwrap();
    }

    #[cfg(feature = "voice-capture")]
    #[tokio::test(start_paused = true)]
    async fn live_update_worker_waits_for_tick_and_retires_old_generation() {
        struct LiveTranscriber;
        impl crate::voice::transcription::Transcriber for LiveTranscriber {
            fn transcribe(
                &self,
                _model_id: &str,
                _samples: &[f32],
                partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, TranscriptionError> {
                partial("live words".into());
                Ok("live words".into())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(LiveTranscriber),
        ));
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let worker_runtime = Arc::clone(&runtime);
        let worker_events = Arc::clone(&events);
        let worker = tokio::spawn(crate::commands::voice::live_update_worker(move || {
            let runtime = Arc::clone(&worker_runtime);
            let events = Arc::clone(&worker_events);
            async move {
                runtime
                    .update_dictation(generation, |event| {
                        events.lock().unwrap().push(event);
                    })
                    .unwrap()
            }
        }));
        tokio::task::yield_now().await; // arm the first timer without waiting on wall time
        tokio::time::advance(std::time::Duration::from_millis(749)).await;
        assert!(events.lock().unwrap().is_empty());
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            *events.lock().unwrap(),
            [VoiceDictationEvent::Partial {
                generation,
                text: "live words".into(),
            }]
        );
        runtime
            .cancel_dictation(&settings, generation, |_| {})
            .unwrap();
        let successor = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        assert_ne!(successor, generation);
        tokio::time::advance(std::time::Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        assert!(
            worker.is_finished(),
            "old generation worker must exit on its next tick"
        );
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(
            runtime.status(&settings).unwrap().dictation_generation,
            Some(successor)
        );
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn held_live_update_cannot_publish_after_cancel_and_restart() {
        struct HeldPartial {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl crate::voice::transcription::Transcriber for HeldPartial {
            fn transcribe(
                &self,
                _model_id: &str,
                _samples: &[f32],
                partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, TranscriptionError> {
                partial("old provisional".into());
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Ok("old provisional".into())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let runtime = Arc::new(VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(HeldPartial {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        ));
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let (old_event_tx, old_event_rx) = mpsc::channel();
        let update_runtime = Arc::clone(&runtime);
        let update = std::thread::spawn(move || {
            update_runtime.update_dictation(generation, |event| old_event_tx.send(event).unwrap())
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        runtime
            .cancel_dictation(&settings, generation, |_| {})
            .unwrap();
        let successor = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        assert_ne!(successor, generation);
        release_tx.send(()).unwrap();
        assert!(!update.join().unwrap().unwrap());
        assert!(old_event_rx.try_iter().next().is_none());
        let status = runtime.status(&settings).unwrap();
        assert_eq!(status.dictation_generation, Some(successor));
        assert!(matches!(
            status.dictation,
            VoiceDictationPhase::Recording { .. }
        ));
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn live_inference_failure_retires_capture_and_emits_correlated_failure() {
        struct FailsOnce(AtomicBool);
        impl crate::voice::transcription::Transcriber for FailsOnce {
            fn transcribe(
                &self,
                _model_id: &str,
                _samples: &[f32],
                _partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, crate::voice::transcription::TranscriptionError> {
                if self.0.swap(false, Ordering::SeqCst) {
                    Err(TranscriptionError::InferenceFailed(
                        "fixture failure".into(),
                    ))
                } else {
                    Ok("recovered".into())
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(FailsOnce(AtomicBool::new(true))),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let mut events = Vec::new();
        assert!(!runtime
            .update_dictation(generation, |event| events.push(event))
            .unwrap());
        assert_eq!(
            events,
            [VoiceDictationEvent::Failed {
                generation,
                reason: VoiceDictationIssue::InferenceFailed,
            }]
        );
        let failed = runtime.status(&settings).unwrap();
        assert!(!failed.capture_active);
        assert_eq!(failed.dictation_generation, None);
        assert_eq!(
            failed.dictation,
            VoiceDictationPhase::Error {
                reason: VoiceDictationIssue::InferenceFailed,
            }
        );
        let restarted = runtime.start_dictation(&settings, |_| {}).unwrap();
        assert!(restarted.dictation_generation.unwrap() > generation);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn live_model_loss_reports_missing_and_corrupt_without_stuck_capture() {
        struct ModelLoss(TranscriptionError);
        impl crate::voice::transcription::Transcriber for ModelLoss {
            fn transcribe(
                &self,
                _model_id: &str,
                _samples: &[f32],
                _partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, TranscriptionError> {
                Err(self.0.clone())
            }
        }
        for (error, reason) in [
            (
                TranscriptionError::MissingModel,
                VoiceDictationIssue::ModelMissing,
            ),
            (
                TranscriptionError::CorruptModel,
                VoiceDictationIssue::ModelCorrupt,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let settings = SettingsService::degraded(
                &crate::store::settings::settings_file(dir.path()),
                Arc::new(NoopObserver),
            );
            let bytes = b"dictation test model";
            let model = CatalogModel {
                spec: ModelSpec {
                    id: "dictation-fixture".into(),
                    byte_len: bytes.len() as u64,
                    blake3: fixture_digest(bytes),
                },
                url: "https://example.test/dictation.bin".into(),
            };
            let runtime = VoiceRuntime::with_model_and_transcriber(
                dir.path(),
                FakeBackend,
                model,
                Box::new(ModelLoss(error)),
            );
            runtime
                .download_model(FixtureTransport(bytes.to_vec()), |_| {})
                .unwrap();
            let generation = runtime
                .start_dictation(&settings, |_| {})
                .unwrap()
                .dictation_generation
                .unwrap();
            let mut events = Vec::new();
            assert!(!runtime
                .update_dictation(generation, |event| events.push(event))
                .unwrap());
            assert_eq!(
                events,
                [VoiceDictationEvent::Failed {
                    generation,
                    reason: reason.clone(),
                }]
            );
            let status = runtime.status(&settings).unwrap();
            assert_eq!(status.dictation, VoiceDictationPhase::Error { reason });
            assert_eq!(status.dictation_generation, None);
            assert!(!status.capture_active);
        }
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn failed_live_snapshot_retires_capture_with_invalid_audio() {
        struct BadSnapshot;
        impl CaptureSession for BadSnapshot {
            fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
                Err(CaptureError::CaptureFailed("invalid live samples".into()))
            }
            fn stop(self) -> Result<CapturedAudio, CaptureError> {
                Ok(CapturedAudio {
                    sample_rate: 16_000,
                    samples: vec![0.1; 160],
                })
            }
        }
        struct BadSnapshotBackend;
        impl CaptureBackend for BadSnapshotBackend {
            type Session = BadSnapshot;
            fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
                Ok(vec![InputDevice {
                    id: "mic-a".into(),
                    name: "Desk".into(),
                    is_default: true,
                }])
            }
            fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
                Ok(Some("mic-a".into()))
            }
            fn open(&self, _id: &str) -> Result<Self::Session, CaptureError> {
                Ok(BadSnapshot)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            BadSnapshotBackend,
            model,
            Box::new(FixtureTranscriber),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let mut events = Vec::new();
        assert!(!runtime
            .update_dictation(generation, |event| events.push(event))
            .unwrap());
        assert_eq!(
            events,
            [VoiceDictationEvent::Failed {
                generation,
                reason: VoiceDictationIssue::InvalidAudio,
            }]
        );
        let status = runtime.status(&settings).unwrap();
        assert!(!status.capture_active);
        assert_eq!(status.dictation_generation, None);
        assert_eq!(
            status.dictation,
            VoiceDictationPhase::Error {
                reason: VoiceDictationIssue::InvalidAudio,
            }
        );
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn capture_processing_failure_is_not_reported_as_missing_microphone() {
        struct FailingSession;
        impl CaptureSession for FailingSession {
            fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
                Err(CaptureError::CaptureFailed(
                    "invalid capture samples".into(),
                ))
            }

            fn stop(self) -> Result<CapturedAudio, CaptureError> {
                Err(CaptureError::CaptureFailed(
                    "invalid capture samples".into(),
                ))
            }
        }
        struct FailingBackend;
        impl CaptureBackend for FailingBackend {
            type Session = FailingSession;
            fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
                Ok(vec![InputDevice {
                    id: "mic-a".into(),
                    name: "Desk".into(),
                    is_default: true,
                }])
            }
            fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
                Ok(Some("mic-a".into()))
            }
            fn open(&self, _id: &str) -> Result<Self::Session, CaptureError> {
                Ok(FailingSession)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FailingBackend,
            model,
            Box::new(FixtureTranscriber),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let mut events = Vec::new();
        assert_eq!(
            runtime.stop_dictation(&settings, |event| events.push(event)),
            Err(VoiceError::InvalidAudio)
        );
        assert_eq!(
            events,
            [VoiceDictationEvent::Failed {
                generation,
                reason: VoiceDictationIssue::InvalidAudio
            }]
        );
        assert_eq!(
            runtime.status(&settings).unwrap().dictation,
            VoiceDictationPhase::Error {
                reason: VoiceDictationIssue::InvalidAudio
            }
        );
        assert!(!runtime.status(&settings).unwrap().capture_active);
        assert!(matches!(
            runtime
                .start_dictation(&settings, |_| {})
                .unwrap()
                .dictation,
            VoiceDictationPhase::Recording { .. }
        ));
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn conditional_cancel_preserves_successor_and_reports_current_status() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(FixtureTranscriber),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();

        let first = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .accepted_generation;
        let mut retired = Vec::new();
        let idle = runtime
            .cancel_dictation(&settings, first, |event| retired.push(event))
            .unwrap();
        assert_eq!(
            retired,
            [VoiceDictationEvent::Cancelled { generation: first }]
        );
        assert_eq!(idle.dictation_generation, None);

        let mut no_active_events = Vec::new();
        let still_idle = runtime
            .cancel_dictation(&settings, first, |event| no_active_events.push(event))
            .unwrap();
        assert_eq!(still_idle.dictation_generation, None);
        assert!(no_active_events.is_empty());

        let second = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .accepted_generation;
        assert_ne!(first, second);
        let mut stale_events = Vec::new();
        let recording = runtime
            .cancel_dictation(&settings, first, |event| stale_events.push(event))
            .unwrap();
        assert!(stale_events.is_empty());
        assert_eq!(recording.dictation_generation, Some(second));
        assert!(recording.capture_active);
        assert!(matches!(
            recording.dictation,
            VoiceDictationPhase::Recording { .. }
        ));

        let mut current_events = Vec::new();
        let ended = runtime
            .cancel_dictation(&settings, second, |event| current_events.push(event))
            .unwrap();
        assert_eq!(
            current_events,
            [VoiceDictationEvent::Cancelled { generation: second }]
        );
        assert_eq!(ended.dictation_generation, None);
        assert!(!ended.capture_active);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn cancelling_dictation_retires_its_generation_before_a_later_start() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let runtime = VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(FixtureTranscriber),
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();
        let mut cancelled = Vec::new();
        let status = runtime
            .cancel_dictation(&settings, generation, |event| cancelled.push(event))
            .unwrap();
        assert_eq!(cancelled, [VoiceDictationEvent::Cancelled { generation }]);
        assert_eq!(status.dictation, VoiceDictationPhase::Idle);
        assert!(!status.capture_active);
        assert_eq!(
            runtime.stop_dictation(&settings, |_| {}),
            Err(VoiceError::NotRecording)
        );
        assert!(matches!(
            runtime
                .start_dictation(&settings, |_| {})
                .unwrap()
                .dictation,
            VoiceDictationPhase::Recording { .. }
        ));
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn cancelled_stop_cannot_publish_over_a_new_recording() {
        use std::sync::mpsc;

        struct HeldTranscriber {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl crate::voice::transcription::Transcriber for HeldTranscriber {
            fn transcribe(
                &self,
                _model_id: &str,
                _samples: &[f32],
                _partial: Arc<dyn Fn(String) + Send + Sync>,
                _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
            ) -> Result<String, crate::voice::transcription::TranscriptionError> {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Ok("late old words".into())
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        ));
        let bytes = b"dictation test model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "dictation-fixture".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/dictation.bin".into(),
        };
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let runtime = Arc::new(VoiceRuntime::with_model_and_transcriber(
            dir.path(),
            FakeBackend,
            model,
            Box::new(HeldTranscriber {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        ));
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        let generation = runtime
            .start_dictation(&settings, |_| {})
            .unwrap()
            .dictation_generation
            .unwrap();

        let (old_event_tx, old_event_rx) = mpsc::channel();
        let stop_runtime = Arc::clone(&runtime);
        let stop_settings = Arc::clone(&settings);
        let stop = std::thread::spawn(move || {
            stop_runtime.stop_dictation(&stop_settings, |event| old_event_tx.send(event).unwrap())
        });
        assert_eq!(
            old_event_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            VoiceDictationEvent::Transcribing { generation }
        );
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(runtime.remove_model(), Err(VoiceError::CaptureActive));
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Ready
        );
        let mut cancellation = Vec::new();
        runtime
            .cancel_dictation(&settings, generation, |event| cancellation.push(event))
            .unwrap();
        assert_eq!(
            cancellation,
            [VoiceDictationEvent::Cancelled { generation }]
        );
        assert!(matches!(
            runtime
                .start_dictation(&settings, |_| {})
                .unwrap()
                .dictation,
            VoiceDictationPhase::Recording { .. }
        ));
        release_tx.send(()).unwrap();
        assert!(matches!(
            stop.join().unwrap().unwrap().dictation,
            VoiceDictationPhase::Recording { .. }
        ));
        assert!(
            old_event_rx.try_iter().next().is_none(),
            "old Stop must emit no terminal event"
        );
        assert!(runtime.status(&settings).unwrap().capture_active);
    }

    #[test]
    fn active_capture_refuses_model_removal_and_preserves_verified_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"in-use model fixture";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "in-use".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/in-use.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model);
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        runtime
            .capture
            .lock()
            .unwrap()
            .start(Some("mic-a"))
            .unwrap();

        assert_eq!(runtime.remove_model(), Err(VoiceError::CaptureActive));
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Ready
        );
        let ModelState::Ready(record) = runtime.registry.status("in-use").unwrap() else {
            panic!("a refused removal must retain the admitted model");
        };
        assert_eq!(std::fs::read(record.path).unwrap(), bytes);
    }

    struct BrokenTransport;
    impl DownloadTransport for BrokenTransport {
        fn open(
            &self,
            _url: &str,
            _offset: u64,
            _cancel: &crate::voice::model_download::DownloadCancellation,
        ) -> Result<DownloadResponse, DownloadFailure> {
            Err(DownloadFailure::Transport("offline".into()))
        }
    }

    #[test]
    fn model_download_failure_remains_visible_and_retry_recovers_to_ready() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"retry fixture";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "retry".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/retry.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model);
        assert_eq!(
            runtime.download_model(BrokenTransport, |_| {}),
            Err(VoiceError::DownloadUnavailable)
        );
        assert_eq!(
            runtime.status(&settings).unwrap().download,
            VoiceDownloadPhase::Failed {
                reason: VoiceDownloadIssue::Transport
            }
        );
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Absent
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Ready
        );
        runtime.remove_model().unwrap();
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Absent
        );
    }

    #[test]
    fn cancelling_a_settings_download_reports_partial_and_allows_resume() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"cancellable model fixture";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "cancel".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/cancel.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model);
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |phase| {
                if matches!(phase, VoiceDownloadPhase::Progress { downloaded, .. } if downloaded > 0) {
                    runtime.cancel_model_download().unwrap();
                }
            })
            .unwrap();
        assert!(matches!(
            runtime.status(&settings).unwrap().download,
            VoiceDownloadPhase::Cancelled { downloaded, total }
                if downloaded > 0 && total == bytes.len() as u64
        ));
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Absent
        );
        runtime
            .download_model(FixtureTransport(bytes.to_vec()), |_| {})
            .unwrap();
        assert_eq!(
            runtime.status(&settings).unwrap().model,
            VoiceModelState::Ready
        );
    }

    #[test]
    fn accepted_cancel_reports_cancelling_while_transport_open_is_held() {
        use std::sync::mpsc;

        struct HeldOpen {
            entered: mpsc::SyncSender<()>,
            release: mpsc::Receiver<()>,
            bytes: Vec<u8>,
        }
        impl DownloadTransport for HeldOpen {
            fn open(
                &self,
                _url: &str,
                offset: u64,
                _cancel: &crate::voice::model_download::DownloadCancellation,
            ) -> Result<DownloadResponse, DownloadFailure> {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
                Ok(DownloadResponse {
                    range: ResponseRange::From {
                        // A malformed late header must not strand an accepted Cancel.
                        start: offset + 1,
                        total: self.bytes.len() as u64,
                    },
                    stream: Box::new(Cursor::new(self.bytes[offset as usize..].to_vec())),
                })
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"held model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "held-cancel".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/held.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model(dir.path(), FakeBackend, model));
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::channel();
        let worker_runtime = Arc::clone(&runtime);
        let bytes = bytes.to_vec();
        let worker = std::thread::spawn(move || {
            worker_runtime.download_model(
                HeldOpen {
                    entered: entered_tx,
                    release: release_rx,
                    bytes,
                },
                |_| {},
            )
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        runtime.cancel_model_download().unwrap();
        assert_eq!(
            runtime.status(&settings).unwrap().download,
            VoiceDownloadPhase::Cancelling
        );
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert!(matches!(
            runtime.status(&settings).unwrap().download,
            VoiceDownloadPhase::Cancelled { .. }
        ));
    }

    #[test]
    fn delayed_progress_notice_cannot_outvote_accepted_cancel() {
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"revision model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "revision-cancel".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/revision.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model(dir.path(), FakeBackend, model));
        let notices = Arc::new(Mutex::new(Vec::<VoiceDownloadNotice>::new()));
        let (held_tx, held_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::channel();
        let worker_runtime = Arc::clone(&runtime);
        let worker_notices = Arc::clone(&notices);
        let worker = std::thread::spawn(move || {
            worker_runtime.download_model_with_notice(FixtureTransport(bytes.to_vec()), |notice| {
                if matches!(notice.phase, VoiceDownloadPhase::Progress { downloaded, .. } if downloaded > 0) {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
                worker_notices.lock().unwrap().push(notice);
            })
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        runtime
            .cancel_model_download_with_event(|notice| notices.lock().unwrap().push(notice))
            .unwrap();
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();

        let notices = notices.lock().unwrap();
        let progress = notices
            .iter()
            .find(|notice| matches!(notice.phase, VoiceDownloadPhase::Progress { downloaded, .. } if downloaded > 0))
            .unwrap();
        let cancelling = notices
            .iter()
            .find(|notice| matches!(notice.phase, VoiceDownloadPhase::Cancelling))
            .unwrap();
        let cancelled = notices
            .iter()
            .find(|notice| matches!(notice.phase, VoiceDownloadPhase::Cancelled { .. }))
            .unwrap();
        assert!(progress.revision < cancelling.revision);
        assert!(cancelling.revision < cancelled.revision);
        assert!(
            notices
                .iter()
                .position(|notice| notice.revision == cancelling.revision)
                < notices
                    .iter()
                    .position(|notice| notice.revision == progress.revision)
        );
        let status = runtime.status(&settings).unwrap();
        assert_eq!(status.download_revision, cancelled.revision);
        assert_eq!(status.download, cancelled.phase);
    }

    #[test]
    fn accepted_cancel_notice_can_reenter_status_and_cancel() {
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        ));
        let bytes = b"reentrant cancel";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "reentrant-notice".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/reentrant.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model(dir.path(), FakeBackend, model));
        let (notice_tx, notice_rx) = mpsc::channel();
        let worker_runtime = Arc::clone(&runtime);
        let callback_runtime = Arc::clone(&runtime);
        let worker_settings = Arc::clone(&settings);
        let worker = std::thread::spawn(move || {
            worker_runtime.download_model(FixtureTransport(bytes.to_vec()), |phase| {
                if matches!(phase, VoiceDownloadPhase::Progress { downloaded, .. } if downloaded > 0) {
                    callback_runtime
                        .cancel_model_download_with_event(|notice| {
                            let status = callback_runtime.status(&worker_settings).unwrap();
                            let second_cancel = callback_runtime.cancel_model_download();
                            notice_tx.send((notice, status, second_cancel)).unwrap();
                        })
                        .unwrap();
                }
            })
        });
        let (notice, status, second_cancel) = notice_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("accepted Cancel callback must not retain owner locks");
        assert_eq!(notice.phase, VoiceDownloadPhase::Cancelling);
        assert_eq!(status.download, VoiceDownloadPhase::Cancelling);
        assert_eq!(status.download_revision, notice.revision);
        assert_eq!(second_cancel, Ok(()));
        worker.join().unwrap().unwrap();
        assert!(matches!(
            runtime.status(&settings).unwrap().download,
            VoiceDownloadPhase::Cancelled { .. }
        ));
    }

    #[test]
    fn terminal_notice_may_arrive_before_held_cancelling_notice_but_has_newer_revision() {
        use std::sync::mpsc;

        struct HeldOpen(mpsc::SyncSender<()>);
        impl DownloadTransport for HeldOpen {
            fn open(
                &self,
                _url: &str,
                _offset: u64,
                cancel: &crate::voice::model_download::DownloadCancellation,
            ) -> Result<DownloadResponse, DownloadFailure> {
                self.0.send(()).unwrap();
                cancel.wait_blocking();
                Err(DownloadFailure::Cancelled)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"held delivery";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "held-delivery".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/delivery.bin".into(),
        };
        let runtime = Arc::new(VoiceRuntime::with_model(dir.path(), FakeBackend, model));
        let (opened_tx, opened_rx) = mpsc::sync_channel(0);
        let (terminal_tx, terminal_rx) = mpsc::channel();
        let worker_runtime = Arc::clone(&runtime);
        let worker = std::thread::spawn(move || {
            worker_runtime.download_model_with_notice(HeldOpen(opened_tx), |notice| {
                if matches!(notice.phase, VoiceDownloadPhase::Cancelled { .. }) {
                    terminal_tx.send(notice).unwrap();
                }
            })
        });
        opened_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (cancelling_started_tx, cancelling_started_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::channel();
        let (cancelling_tx, cancelling_rx) = mpsc::channel();
        let cancel_runtime = Arc::clone(&runtime);
        let canceller = std::thread::spawn(move || {
            cancel_runtime
                .cancel_model_download_with_event(|notice| {
                    cancelling_started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    cancelling_tx.send(notice).unwrap();
                })
                .unwrap();
        });
        cancelling_started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let terminal = terminal_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("terminal delivery must not wait for a held Cancel callback");
        release_tx.send(()).unwrap();
        let cancelling = cancelling_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        canceller.join().unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(cancelling.phase, VoiceDownloadPhase::Cancelling);
        assert!(matches!(
            terminal.phase,
            VoiceDownloadPhase::Cancelled { .. }
        ));
        assert!(cancelling.revision < terminal.revision);
        let status = runtime.status(&settings).unwrap();
        assert_eq!(status.download_revision, terminal.revision);
        assert_eq!(status.download, terminal.phase);
    }

    #[test]
    fn cancelled_download_with_failed_partial_sync_reports_storage_not_resumable_cancelled() {
        fn fail_sync(_: &File) -> io::Result<()> {
            Err(io::Error::other("injected partial sync failure"))
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsService::degraded(
            &crate::store::settings::settings_file(dir.path()),
            Arc::new(NoopObserver),
        );
        let bytes = b"unsynced model";
        let model = CatalogModel {
            spec: ModelSpec {
                id: "unsynced-cancel".into(),
                byte_len: bytes.len() as u64,
                blake3: fixture_digest(bytes),
            },
            url: "https://example.test/unsynced.bin".into(),
        };
        let runtime = VoiceRuntime::with_model(dir.path(), FakeBackend, model);
        let mut notices = Vec::new();
        let result = runtime.download_model_with_notice_configured(
            FixtureTransport(bytes.to_vec()),
            |notice| {
                if matches!(notice.phase, VoiceDownloadPhase::Progress { downloaded, .. } if downloaded > 0) {
                    runtime.cancel_model_download().unwrap();
                }
                notices.push(notice);
            },
            |downloader| downloader.with_sync(fail_sync),
        );
        assert_eq!(result, Err(VoiceError::DownloadUnavailable));
        let status = runtime.status(&settings).unwrap();
        assert_eq!(
            status.download,
            VoiceDownloadPhase::Failed {
                reason: VoiceDownloadIssue::Storage
            }
        );
        assert_eq!(status.model, VoiceModelState::Absent);
        assert!(matches!(
            notices.last(),
            Some(VoiceDownloadNotice {
                phase: VoiceDownloadPhase::Failed {
                    reason: VoiceDownloadIssue::Storage
                },
                ..
            })
        ));
        assert!(!notices
            .iter()
            .any(|notice| matches!(notice.phase, VoiceDownloadPhase::Cancelled { .. })));
    }
}
