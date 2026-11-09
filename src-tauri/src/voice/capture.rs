// ABOUTME: Typed local microphone selection, recording, and bounded audio capture.
// ABOUTME: Separates device access from capture policy so real devices stay outside unit tests.
#[cfg(any(test, feature = "voice-capture"))]
use std::collections::VecDeque;

#[cfg(feature = "voice-capture")]
pub mod cpal_backend;

/// The most recent thirty seconds of capture are retained for local transcription.
pub const MAX_CAPTURE_SECONDS: usize = 30;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, PartialEq)]
pub struct CapturedAudio {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

impl CapturedAudio {
    fn retain_latest(&mut self) {
        let limit = self.sample_rate as usize * MAX_CAPTURE_SECONDS;
        if self.samples.len() > limit {
            self.samples.drain(..self.samples.len() - limit);
        }
    }
}

#[cfg(any(test, feature = "voice-capture"))]
struct MonoBuffer {
    sample_rate: u32,
    channels: usize,
    samples: VecDeque<f32>,
}

#[cfg(any(test, feature = "voice-capture"))]
impl MonoBuffer {
    fn new(sample_rate: u32, channels: usize) -> Self {
        Self {
            sample_rate,
            channels,
            samples: VecDeque::new(),
        }
    }

    fn push_interleaved<T: Copy>(&mut self, data: &[T], to_f32: impl Fn(T) -> f32) {
        let limit = self.sample_rate as usize * MAX_CAPTURE_SECONDS;
        for frame in data.chunks_exact(self.channels) {
            let mono =
                frame.iter().map(|sample| to_f32(*sample)).sum::<f32>() / self.channels as f32;
            if self.samples.len() == limit {
                self.samples.pop_front();
            }
            self.samples.push_back(mono);
        }
    }

    fn take_audio(&mut self) -> CapturedAudio {
        CapturedAudio {
            sample_rate: self.sample_rate,
            samples: std::mem::take(&mut self.samples).into(),
        }
    }

    #[cfg(feature = "voice-capture")]
    fn snapshot_audio(&self) -> CapturedAudio {
        CapturedAudio {
            sample_rate: self.sample_rate,
            samples: self.samples.iter().copied().collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureError {
    NoDevice,
    NoDefaultDevice,
    DeviceUnavailable { device_id: String },
    PermissionDenied,
    AlreadyRecording,
    NotRecording,
    BackendUnavailable(String),
    CaptureFailed(String),
}

pub trait CaptureSession {
    fn snapshot(&self) -> Result<CapturedAudio, CaptureError>;
    fn stop(self) -> Result<CapturedAudio, CaptureError>;
}

pub trait CaptureBackend {
    type Session: CaptureSession;

    fn devices(&self) -> Result<Vec<InputDevice>, CaptureError>;
    fn default_device_id(&self) -> Result<Option<String>, CaptureError>;
    fn open(&self, id: &str) -> Result<Self::Session, CaptureError>;
}

pub struct CaptureService<B: CaptureBackend> {
    backend: B,
    session: Option<B::Session>,
}

impl<B: CaptureBackend> CaptureService<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            session: None,
        }
    }

    pub fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
        self.backend.devices()
    }

    pub fn is_recording(&self) -> bool {
        self.session.is_some()
    }

    /// Only an explicit default request (`None`) may select the system default.
    pub fn start(&mut self, selected_id: Option<&str>) -> Result<(), CaptureError> {
        if self.session.is_some() {
            return Err(CaptureError::AlreadyRecording);
        }
        let devices = self.backend.devices()?;
        let id = match selected_id {
            Some(id) => id.to_owned(),
            None => self.backend.default_device_id()?.ok_or({
                if devices.is_empty() {
                    CaptureError::NoDevice
                } else {
                    CaptureError::NoDefaultDevice
                }
            })?,
        };
        if !devices.iter().any(|device| device.id == id) {
            return Err(match selected_id {
                Some(_) => CaptureError::DeviceUnavailable { device_id: id },
                None => CaptureError::NoDevice,
            });
        }
        self.session = Some(self.backend.open(&id)?);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<CapturedAudio, CaptureError> {
        let mut audio = self
            .session
            .take()
            .ok_or(CaptureError::NotRecording)?
            .stop()?;
        if audio.sample_rate == 0 {
            return Err(CaptureError::CaptureFailed(
                "microphone reported an invalid sample rate".into(),
            ));
        }
        audio.retain_latest();
        Ok(audio)
    }

    pub fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
        let mut audio = self
            .session
            .as_ref()
            .ok_or(CaptureError::NotRecording)?
            .snapshot()?;
        if audio.sample_rate == 0 {
            return Err(CaptureError::CaptureFailed(
                "microphone reported an invalid sample rate".into(),
            ));
        }
        audio.retain_latest();
        Ok(audio)
    }

    #[cfg(feature = "voice-capture")]
    pub fn snapshot_for_transcription(&self) -> Result<CapturedAudio, CaptureError> {
        crate::voice::resample::to_whisper_rate(self.snapshot()?)
    }

    #[cfg(feature = "voice-capture")]
    pub fn stop_for_transcription(&mut self) -> Result<CapturedAudio, CaptureError> {
        crate::voice::resample::to_whisper_rate(self.stop()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeBackend {
        devices: Vec<InputDevice>,
        default: Option<String>,
        opened: RefCell<Vec<String>>,
        next_open_failure: RefCell<Option<CaptureError>>,
        audio: CapturedAudio,
    }

    struct FakeSession(CapturedAudio);

    impl CaptureSession for FakeSession {
        fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
            Ok(CapturedAudio {
                sample_rate: self.0.sample_rate,
                samples: self.0.samples.clone(),
            })
        }

        fn stop(self) -> Result<CapturedAudio, CaptureError> {
            Ok(self.0)
        }
    }

    impl CaptureBackend for FakeBackend {
        type Session = FakeSession;

        fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
            Ok(self.devices.clone())
        }

        fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
            Ok(self.default.clone())
        }

        fn open(&self, id: &str) -> Result<Self::Session, CaptureError> {
            self.opened.borrow_mut().push(id.to_owned());
            if let Some(error) = self.next_open_failure.borrow_mut().take() {
                return Err(error);
            }
            Ok(FakeSession(CapturedAudio {
                sample_rate: self.audio.sample_rate,
                samples: self.audio.samples.clone(),
            }))
        }
    }

    fn backend() -> FakeBackend {
        FakeBackend {
            devices: vec![
                InputDevice {
                    id: "built-in".into(),
                    name: "Built-in microphone".into(),
                    is_default: true,
                },
                InputDevice {
                    id: "usb".into(),
                    name: "USB microphone".into(),
                    is_default: false,
                },
            ],
            default: Some("built-in".into()),
            opened: RefCell::new(Vec::new()),
            next_open_failure: RefCell::new(None),
            audio: CapturedAudio {
                sample_rate: 2,
                samples: (0..62).map(|sample| sample as f32).collect(),
            },
        }
    }

    #[test]
    fn a_missing_selected_microphone_never_falls_back_to_the_default() {
        let mut capture = CaptureService::new(backend());

        assert_eq!(
            capture.start(Some("unplugged")),
            Err(CaptureError::DeviceUnavailable {
                device_id: "unplugged".into()
            })
        );
        assert!(capture.backend.opened.borrow().is_empty());
    }

    #[test]
    fn explicit_capture_returns_bounded_local_audio_and_enforces_one_session() {
        let mut capture = CaptureService::new(backend());
        assert_eq!(capture.devices().unwrap().len(), 2);

        assert_eq!(capture.start(Some("usb")), Ok(()));
        assert_eq!(capture.start(None), Err(CaptureError::AlreadyRecording));
        assert_eq!(capture.backend.opened.borrow().as_slice(), ["usb"]);

        let audio = capture.stop().unwrap();
        assert_eq!(audio.sample_rate, 2);
        assert_eq!(audio.samples.len(), 60);
        assert_eq!(audio.samples.first(), Some(&2.0));
        assert_eq!(audio.samples.last(), Some(&61.0));
        assert_eq!(capture.stop(), Err(CaptureError::NotRecording));
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn fake_capture_reaches_whisper_rate_without_losing_the_tail() {
        let mut source = backend();
        source.audio = CapturedAudio {
            sample_rate: 48_000,
            samples: vec![0.5; 48_000],
        };
        let mut capture = CaptureService::new(source);

        capture.start(None).unwrap();
        let audio = capture.stop_for_transcription().unwrap();

        assert_eq!(audio.sample_rate, 16_000);
        assert_eq!(audio.samples.len(), 16_000);
        assert!((audio.samples[100] - 0.5).abs() < 0.001);
        assert!((audio.samples[15_900] - 0.5).abs() < 0.001);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn live_snapshot_does_not_consume_the_final_capture() {
        let mut source = backend();
        source.audio = CapturedAudio {
            sample_rate: 48_000,
            samples: vec![0.25; 48_000],
        };
        let mut capture = CaptureService::new(source);
        capture.start(None).unwrap();

        let partial = capture.snapshot_for_transcription().unwrap();
        let final_audio = capture.stop_for_transcription().unwrap();

        assert_eq!(partial, final_audio);
        assert_eq!(partial.sample_rate, 16_000);
        assert_eq!(partial.samples.len(), 16_000);
        assert_eq!(
            capture.snapshot_for_transcription(),
            Err(CaptureError::NotRecording)
        );
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn stereo_44100_capture_mix_resamples_to_whisper_rate() {
        let mut buffer = MonoBuffer::new(44_100, 2);
        let stereo: Vec<f32> = (0..44_100).flat_map(|_| [0.75, -0.25]).collect();
        buffer.push_interleaved(&stereo, |sample| sample);

        let audio = crate::voice::resample::to_whisper_rate(buffer.take_audio()).unwrap();

        assert_eq!(audio.sample_rate, 16_000);
        assert_eq!(audio.samples.len(), 16_000);
        assert!((audio.samples[8_000] - 0.25).abs() < 0.001);
    }

    #[cfg(feature = "voice-capture")]
    #[test]
    fn a_new_recording_has_no_samples_from_its_predecessor() {
        let mut source = backend();
        source.audio = CapturedAudio {
            sample_rate: 48_000,
            samples: vec![0.7; 48_000],
        };
        let mut reused = CaptureService::new(source);
        reused.start(None).unwrap();
        let first = reused.stop_for_transcription().unwrap();
        assert!(first.samples[8_000] > 0.6);

        reused.backend.audio = CapturedAudio {
            sample_rate: 44_100,
            samples: vec![-0.4; 44_100],
        };
        reused.start(None).unwrap();
        let second = reused.stop_for_transcription().unwrap();

        let mut fresh_source = backend();
        fresh_source.audio = CapturedAudio {
            sample_rate: 44_100,
            samples: vec![-0.4; 44_100],
        };
        let mut fresh = CaptureService::new(fresh_source);
        fresh.start(None).unwrap();
        let fresh_second = fresh.stop_for_transcription().unwrap();

        assert_eq!(second, fresh_second);
        assert!(second.samples[8_000] < -0.3);
        assert_eq!(
            reused.stop_for_transcription(),
            Err(CaptureError::NotRecording)
        );
    }

    #[test]
    fn no_default_device_and_permission_denial_are_distinct_and_retryable() {
        let mut empty = backend();
        empty.devices.clear();
        empty.default = None;
        let mut capture = CaptureService::new(empty);
        assert_eq!(capture.start(None), Err(CaptureError::NoDevice));
        assert!(capture.backend.opened.borrow().is_empty());

        let denied = backend();
        *denied.next_open_failure.borrow_mut() = Some(CaptureError::PermissionDenied);
        let mut capture = CaptureService::new(denied);
        assert_eq!(capture.start(None), Err(CaptureError::PermissionDenied));
        assert_eq!(capture.stop(), Err(CaptureError::NotRecording));
        assert_eq!(capture.start(None), Ok(()));
        assert_eq!(
            capture.backend.opened.borrow().as_slice(),
            ["built-in", "built-in"]
        );
        assert!(capture.stop().is_ok());
    }

    #[test]
    fn available_microphones_without_a_system_default_require_explicit_selection() {
        let mut source = backend();
        source.default = None;
        let mut capture = CaptureService::new(source);

        assert_eq!(capture.start(None), Err(CaptureError::NoDefaultDevice));
        assert!(capture.backend.opened.borrow().is_empty());
        assert_eq!(capture.start(Some("usb")), Ok(()));
    }

    #[test]
    fn an_invalid_capture_rate_fails_instead_of_claiming_empty_audio() {
        let mut invalid = backend();
        invalid.audio.sample_rate = 0;
        let mut capture = CaptureService::new(invalid);
        capture.start(None).unwrap();

        assert!(matches!(
            capture.stop(),
            Err(CaptureError::CaptureFailed(_))
        ));
        assert_eq!(capture.stop(), Err(CaptureError::NotRecording));
    }

    #[test]
    fn mono_capture_keeps_only_the_latest_thirty_seconds() {
        let mut buffer = MonoBuffer::new(2, 2);
        let stereo: Vec<f32> = (0..62)
            .flat_map(|frame| [frame as f32, frame as f32 + 2.0])
            .collect();

        buffer.push_interleaved(&stereo, |sample| sample);
        let captured = buffer.take_audio();

        assert_eq!(captured.sample_rate, 2);
        assert_eq!(captured.samples.len(), 60);
        assert_eq!(captured.samples.first(), Some(&3.0));
        assert_eq!(captured.samples.last(), Some(&62.0));
    }
}
