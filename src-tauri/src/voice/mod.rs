// ABOUTME: Rust-owned voice services for local dictation and model integrity.
// ABOUTME: Capture and model download keep audio and model bytes inside the backend.
pub mod capture;
pub mod catalog;
pub mod model_download;
pub mod model_registry;
#[cfg(feature = "voice-capture")]
pub mod resample;
pub mod settings;
#[cfg(feature = "voice-capture")]
pub mod transcription;
