// ABOUTME: Ordered local transcription events and an injectable Whisper inference boundary.
// ABOUTME: Keeps provisional speech out of document state and rejects stale capture generations.

use std::sync::{mpsc, Arc, Mutex};

use super::capture::{CapturedAudio, MAX_CAPTURE_SECONDS};
use super::resample::WHISPER_SAMPLE_RATE;

#[cfg(feature = "voice-inference")]
mod whisper_backend;
#[cfg(feature = "voice-inference")]
pub use whisper_backend::WhisperTranscriber;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptionError {
    MissingModel,
    CorruptModel,
    Registry(String),
    InferenceFailed(String),
    InvalidAudio,
    Busy,
    NotRecording,
    Cancelled,
}

pub trait Transcriber: Send + Sync {
    fn transcribe(
        &self,
        model_id: &str,
        samples: &[f32],
        partial: Arc<dyn Fn(String) + Send + Sync>,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, TranscriptionError>;
}

impl<T: Transcriber + ?Sized> Transcriber for Box<T> {
    fn transcribe(
        &self,
        model_id: &str,
        samples: &[f32],
        partial: Arc<dyn Fn(String) + Send + Sync>,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, TranscriptionError> {
        (**self).transcribe(model_id, samples, partial, cancelled)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptionEventKind {
    Recording,
    Partial(String),
    Transcribing,
    Final(String),
    Failed(TranscriptionError),
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptionEvent {
    pub generation: u64,
    pub sequence: u64,
    pub kind: TranscriptionEventKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Recording,
    Transcribing,
}

struct Active {
    generation: u64,
    sequence: u64,
    request: u64,
    model_id: String,
    phase: Phase,
    last_partial: String,
    sender: mpsc::Sender<TranscriptionEvent>,
}

fn send(active: &mut Active, kind: TranscriptionEventKind) {
    active.sequence += 1;
    let _ = active.sender.send(TranscriptionEvent {
        generation: active.generation,
        sequence: active.sequence,
        kind,
    });
}

#[derive(Default)]
struct SessionState {
    next_generation: u64,
    active: Option<Active>,
}

/// Synchronous inference boundary. Call `update` or `finish` from a worker thread; callers read
/// the ordered event receiver without blocking the UI thread. Cancellation invalidates callbacks
/// from that worker before a later capture can publish its own transcript.
pub struct VoiceTranscription<T: Transcriber> {
    transcriber: T,
    state: Arc<Mutex<SessionState>>,
}

impl<T: Transcriber> VoiceTranscription<T> {
    pub fn new(transcriber: T) -> Self {
        Self {
            transcriber,
            state: Arc::new(Mutex::new(SessionState::default())),
        }
    }

    pub fn start(
        &self,
        model_id: &str,
    ) -> Result<(u64, mpsc::Receiver<TranscriptionEvent>), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.active.is_some() {
            return Err(TranscriptionError::Busy);
        }
        state.next_generation = state
            .next_generation
            .checked_add(1)
            .ok_or(TranscriptionError::Busy)?;
        let (sender, receiver) = mpsc::channel();
        let generation = state.next_generation;
        let mut active = Active {
            generation,
            sequence: 0,
            request: 0,
            model_id: model_id.to_owned(),
            phase: Phase::Recording,
            last_partial: String::new(),
            sender,
        };
        send(&mut active, TranscriptionEventKind::Recording);
        state.active = Some(active);
        Ok((generation, receiver))
    }

    pub fn update(&self, generation: u64, audio: &CapturedAudio) -> Result<(), TranscriptionError> {
        validate_audio(audio)?;
        let (model_id, request) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let active = state
                .active
                .as_mut()
                .ok_or(TranscriptionError::NotRecording)?;
            if active.generation != generation || active.phase != Phase::Recording {
                return Err(TranscriptionError::Cancelled);
            }
            active.request += 1;
            (active.model_id.clone(), active.request)
        };
        let state = Arc::clone(&self.state);
        let partial: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |text| {
            Self::emit_partial(&state, generation, request, text);
        });
        let state = Arc::clone(&self.state);
        let cancelled: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || !Self::is_current(&state, generation, request, Phase::Recording));
        let result = self.transcriber.transcribe(
            &model_id,
            &audio.samples,
            Arc::clone(&partial),
            Arc::clone(&cancelled),
        );
        match result {
            Ok(text) => {
                partial(text);
                if cancelled() {
                    Err(TranscriptionError::Cancelled)
                } else {
                    Ok(())
                }
            }
            Err(error) => self.fail_if_current(generation, request, Phase::Recording, error),
        }
    }

    pub fn finish(&self, generation: u64, audio: &CapturedAudio) -> Result<(), TranscriptionError> {
        let (model_id, request) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let active = state
                .active
                .as_mut()
                .ok_or(TranscriptionError::NotRecording)?;
            if active.generation != generation || active.phase != Phase::Recording {
                return Err(TranscriptionError::Cancelled);
            }
            active.phase = Phase::Transcribing;
            active.request += 1;
            send(active, TranscriptionEventKind::Transcribing);
            (active.model_id.clone(), active.request)
        };
        if let Err(error) = validate_audio(audio) {
            return self.fail_if_current(generation, request, Phase::Transcribing, error);
        }
        let state = Arc::clone(&self.state);
        let cancelled: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || !Self::is_current(&state, generation, request, Phase::Transcribing));
        let result = self.transcriber.transcribe(
            &model_id,
            &audio.samples,
            Arc::new(|_| {}),
            Arc::clone(&cancelled),
        );
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(active) = state.active.as_mut() else {
            return Err(TranscriptionError::Cancelled);
        };
        if active.generation != generation || active.request != request {
            return Err(TranscriptionError::Cancelled);
        }
        let outcome = match result {
            Ok(text) => {
                send(active, TranscriptionEventKind::Final(text));
                Ok(())
            }
            Err(error) => {
                send(active, TranscriptionEventKind::Failed(error.clone()));
                Err(error)
            }
        };
        state.active = None;
        outcome
    }

    pub fn cancel(&self, generation: u64) -> Result<(), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(active) = state.active.as_ref() else {
            return Err(TranscriptionError::NotRecording);
        };
        if active.generation != generation {
            return Err(TranscriptionError::Cancelled);
        }
        let mut active = state.active.take().expect("checked above");
        send(&mut active, TranscriptionEventKind::Cancelled);
        Ok(())
    }

    fn emit_partial(state: &Mutex<SessionState>, generation: u64, request: u64, text: String) {
        let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(active) = state.active.as_mut() {
            if active.generation == generation
                && active.request == request
                && active.phase == Phase::Recording
                && active.last_partial != text
            {
                active.last_partial = text.clone();
                send(active, TranscriptionEventKind::Partial(text));
            }
        }
    }

    fn is_current(
        state: &Mutex<SessionState>,
        generation: u64,
        request: u64,
        phase: Phase,
    ) -> bool {
        let state = state.lock().unwrap_or_else(|poison| poison.into_inner());
        state.active.as_ref().is_some_and(|active| {
            active.generation == generation && active.request == request && active.phase == phase
        })
    }

    fn fail_if_current(
        &self,
        generation: u64,
        request: u64,
        phase: Phase,
        error: TranscriptionError,
    ) -> Result<(), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(active) = state.active.as_mut() else {
            return Err(TranscriptionError::Cancelled);
        };
        if active.generation != generation || active.request != request || active.phase != phase {
            return Err(TranscriptionError::Cancelled);
        }
        send(active, TranscriptionEventKind::Failed(error.clone()));
        state.active = None;
        Err(error)
    }
}

fn validate_audio(audio: &CapturedAudio) -> Result<(), TranscriptionError> {
    if audio.sample_rate != WHISPER_SAMPLE_RATE
        || audio.samples.is_empty()
        || audio.samples.len() > WHISPER_SAMPLE_RATE as usize * MAX_CAPTURE_SECONDS
        || audio.samples.iter().any(|sample| !sample.is_finite())
    {
        return Err(TranscriptionError::InvalidAudio);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "voice-inference")]
    use crate::voice::model_registry::{ModelRegistry, ModelSpec};
    #[cfg(feature = "voice-inference")]
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    struct FakeTranscriber;

    impl Transcriber for FakeTranscriber {
        fn transcribe(
            &self,
            _model_id: &str,
            samples: &[f32],
            partial: Arc<dyn Fn(String) + Send + Sync>,
            _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> Result<String, TranscriptionError> {
            let text = match samples.len() {
                16_000 => "Hello",
                32_000 => "Hello world",
                48_000 => "Hello world.",
                _ => panic!("unexpected audio length"),
            };
            partial(text.to_owned());
            Ok(text.to_owned())
        }
    }

    fn audio(seconds: usize) -> CapturedAudio {
        CapturedAudio {
            sample_rate: 16_000,
            samples: vec![0.0; seconds * 16_000],
        }
    }

    #[test]
    fn recording_partials_precede_a_distinct_transcribing_phase_and_final() {
        let voice = VoiceTranscription::new(FakeTranscriber);
        let (generation, receiver) = voice.start("tiny.en").unwrap();

        voice.update(generation, &audio(1)).unwrap();
        voice.update(generation, &audio(2)).unwrap();
        voice.finish(generation, &audio(3)).unwrap();

        let kinds: Vec<_> = receiver.try_iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            [
                TranscriptionEventKind::Recording,
                TranscriptionEventKind::Partial("Hello".into()),
                TranscriptionEventKind::Partial("Hello world".into()),
                TranscriptionEventKind::Transcribing,
                TranscriptionEventKind::Final("Hello world.".into()),
            ]
        );
    }

    struct BlockingTranscriber {
        calls: AtomicUsize,
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl Transcriber for BlockingTranscriber {
        fn transcribe(
            &self,
            _model_id: &str,
            samples: &[f32],
            partial: Arc<dyn Fn(String) + Send + Sync>,
            _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> Result<String, TranscriptionError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                partial("obsolete partial".into());
                Ok("obsolete final".into())
            } else if samples[0] == 0.2 {
                Ok("current final".into())
            } else {
                panic!("unexpected capture")
            }
        }
    }

    #[test]
    fn cancelled_terminal_decode_cannot_publish_into_a_later_capture() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let voice = Arc::new(VoiceTranscription::new(BlockingTranscriber {
            calls: AtomicUsize::new(0),
            started: started_tx,
            release: Mutex::new(release_rx),
        }));
        let (old_generation, old_events) = voice.start("tiny.en").unwrap();
        let worker_voice = Arc::clone(&voice);
        let worker = thread::spawn(move || worker_voice.finish(old_generation, &audio(1)));
        started_rx.recv().unwrap();

        voice.cancel(old_generation).unwrap();
        let (new_generation, new_events) = voice.start("tiny.en").unwrap();
        assert_ne!(old_generation, new_generation);
        let mut current_audio = audio(1);
        current_audio.samples[0] = 0.2;
        voice.finish(new_generation, &current_audio).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Err(TranscriptionError::Cancelled));

        assert_eq!(
            old_events
                .try_iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            [
                TranscriptionEventKind::Recording,
                TranscriptionEventKind::Transcribing,
                TranscriptionEventKind::Cancelled,
            ]
        );
        assert_eq!(
            new_events
                .try_iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            [
                TranscriptionEventKind::Recording,
                TranscriptionEventKind::Transcribing,
                TranscriptionEventKind::Final("current final".into()),
            ]
        );
    }

    struct FailingTranscriber;

    impl Transcriber for FailingTranscriber {
        fn transcribe(
            &self,
            _model_id: &str,
            _samples: &[f32],
            _partial: Arc<dyn Fn(String) + Send + Sync>,
            _cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> Result<String, TranscriptionError> {
            Err(TranscriptionError::InferenceFailed("decoder failed".into()))
        }
    }

    #[test]
    fn inference_failure_is_typed_terminal_and_recoverable() {
        let voice = VoiceTranscription::new(FailingTranscriber);
        let (generation, events) = voice.start("tiny.en").unwrap();
        let failure = TranscriptionError::InferenceFailed("decoder failed".into());

        assert_eq!(voice.finish(generation, &audio(1)), Err(failure.clone()));
        assert_eq!(
            events
                .try_iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            [
                TranscriptionEventKind::Recording,
                TranscriptionEventKind::Transcribing,
                TranscriptionEventKind::Failed(failure),
            ]
        );
        assert!(voice.start("tiny.en").is_ok());
    }

    #[test]
    fn empty_terminal_capture_fails_and_releases_its_generation() {
        let voice = VoiceTranscription::new(FakeTranscriber);
        let (old_generation, old_events) = voice.start("tiny.en").unwrap();

        assert_eq!(
            voice.finish(old_generation, &audio(0)),
            Err(TranscriptionError::InvalidAudio)
        );
        assert_eq!(
            old_events
                .try_iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            [
                TranscriptionEventKind::Recording,
                TranscriptionEventKind::Transcribing,
                TranscriptionEventKind::Failed(TranscriptionError::InvalidAudio),
            ]
        );
        let (new_generation, _) = voice.start("tiny.en").unwrap();
        assert_ne!(old_generation, new_generation);
        assert_eq!(
            voice.cancel(old_generation),
            Err(TranscriptionError::Cancelled)
        );
        voice.cancel(new_generation).unwrap();
    }

    #[cfg(feature = "voice-inference")]
    #[test]
    fn real_model_preflight_distinguishes_absence_from_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let registry = ModelRegistry::new(temp.path());
        let whisper = WhisperTranscriber::new(registry.clone());
        let ignore_partial: Arc<dyn Fn(String) + Send + Sync> = Arc::new(|_| {});
        let never_cancel: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);

        assert_eq!(
            whisper.transcribe(
                "tiny.en",
                &[0.0; 16_000],
                Arc::clone(&ignore_partial),
                Arc::clone(&never_cancel)
            ),
            Err(TranscriptionError::MissingModel)
        );

        let model_path = temp.path().join("model.bin");
        let mut bytes = b"fake model bytes".to_vec();
        fs::write(&model_path, &bytes).unwrap();
        registry
            .admit(
                &ModelSpec {
                    id: "tiny.en".into(),
                    byte_len: bytes.len() as u64,
                    blake3: blake3::hash(&bytes).to_hex().to_string(),
                },
                &model_path,
            )
            .unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&model_path, &bytes).unwrap();

        assert_eq!(
            whisper.transcribe("tiny.en", &[0.0; 16_000], ignore_partial, never_cancel),
            Err(TranscriptionError::CorruptModel)
        );
    }
}
