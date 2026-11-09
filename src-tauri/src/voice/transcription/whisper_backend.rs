// ABOUTME: Feature-gated whisper.cpp adapter for verified local model bytes and 16-kHz PCM.
// ABOUTME: Relays safe native segment callbacks as provisional text and aborts stale inference.

use std::fs;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::{Transcriber, TranscriptionError};
use crate::voice::model_registry::{ModelRecord, ModelRegistry, ModelState, RegistryError};

pub struct WhisperTranscriber {
    registry: ModelRegistry,
}

impl WhisperTranscriber {
    pub fn new(registry: ModelRegistry) -> Self {
        Self { registry }
    }

    fn verified_model_bytes(&self, model_id: &str) -> Result<Vec<u8>, TranscriptionError> {
        let record = match self.registry.status(model_id).map_err(map_registry_error)? {
            ModelState::Absent | ModelState::Missing(_) => {
                return Err(TranscriptionError::MissingModel)
            }
            ModelState::Corrupt { .. } => return Err(TranscriptionError::CorruptModel),
            ModelState::Ready(record) => record,
        };
        // Status is a preflight, not a capability: reopen and verify the exact bytes passed to
        // whisper.cpp so a model replacement between status and inference cannot be trusted.
        read_and_verify(&record)
    }
}

fn map_registry_error(error: RegistryError) -> TranscriptionError {
    TranscriptionError::Registry(format!("{error:?}"))
}

fn read_and_verify(record: &ModelRecord) -> Result<Vec<u8>, TranscriptionError> {
    let file = match fs::File::open(&record.path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(TranscriptionError::MissingModel)
        }
        Err(error) => return Err(TranscriptionError::Registry(error.to_string())),
    };
    let size = file
        .metadata()
        .map_err(|error| TranscriptionError::Registry(error.to_string()))?
        .len();
    if size != record.spec.byte_len {
        return Err(TranscriptionError::CorruptModel);
    }
    let limit = record
        .spec
        .byte_len
        .checked_add(1)
        .ok_or(TranscriptionError::CorruptModel)?;
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| TranscriptionError::Registry(error.to_string()))?;
    let expected_hash = blake3::Hash::from_hex(&record.spec.blake3)
        .map_err(|_| TranscriptionError::CorruptModel)?;
    if bytes.len() as u64 != record.spec.byte_len || blake3::hash(&bytes) != expected_hash {
        return Err(TranscriptionError::CorruptModel);
    }
    Ok(bytes)
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(
        &self,
        model_id: &str,
        samples: &[f32],
        partial: Arc<dyn Fn(String) + Send + Sync>,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, TranscriptionError> {
        if cancelled() {
            return Err(TranscriptionError::Cancelled);
        }
        let bytes = self.verified_model_bytes(model_id)?;
        if cancelled() {
            return Err(TranscriptionError::Cancelled);
        }
        let context = WhisperContext::new_from_buffer_with_params(
            &bytes,
            WhisperContextParameters::default(),
        )
        .map_err(|_| TranscriptionError::CorruptModel)?;
        let mut state = context
            .create_state()
            .map_err(|error| TranscriptionError::InferenceFailed(error.to_string()))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);

        let segments = Arc::new(Mutex::new(Vec::<String>::new()));
        let cancel_segments = Arc::clone(&cancelled);
        params.set_segment_callback_safe({
            let segments = Arc::clone(&segments);
            move |segment: whisper_rs::SegmentCallbackData| {
                if cancel_segments() {
                    return;
                }
                let Ok(index) = usize::try_from(segment.segment) else {
                    return;
                };
                let text = {
                    let mut parts = segments.lock().unwrap_or_else(|poison| poison.into_inner());
                    if index >= parts.len() {
                        parts.resize(index + 1, String::new());
                    }
                    parts[index] = segment.text;
                    parts.concat().trim().to_owned()
                };
                partial(text);
            }
        });
        let cancel_inference = Arc::clone(&cancelled);
        // whisper-rs 0.16 stores a boxed trait object but instantiates its abort trampoline
        // with F. Supply that trait-object type as F so the callback pointer has the same layout.
        params.set_abort_callback_safe(
            Box::new(move || cancel_inference()) as Box<dyn FnMut() -> bool>
        );
        let result = state.full(params, samples);
        if cancelled() {
            return Err(TranscriptionError::Cancelled);
        }
        result.map_err(|error| TranscriptionError::InferenceFailed(error.to_string()))?;
        let mut transcript = String::new();
        for segment in state.as_iter() {
            transcript.push_str(
                segment
                    .to_str()
                    .map_err(|error| TranscriptionError::InferenceFailed(error.to_string()))?,
            );
        }
        Ok(transcript.trim().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::catalog::{default_model_spec, DEFAULT_MODEL_ID};
    use crate::voice::model_registry::ModelSpec;

    fn pinned_wav_samples(bytes: &[u8]) -> Vec<f32> {
        assert!(bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"));
        let mut offset = 12;
        let mut format_found = false;
        let mut samples = None;
        while offset + 8 <= bytes.len() {
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let start = offset + 8;
            let end = start
                .checked_add(length)
                .expect("WAV chunk length overflow");
            assert!(end <= bytes.len(), "WAV chunk extends past the file");
            match &bytes[offset..offset + 4] {
                b"fmt " => {
                    assert!(length >= 16);
                    assert_eq!(
                        u16::from_le_bytes(bytes[start..start + 2].try_into().unwrap()),
                        1
                    );
                    assert_eq!(
                        u16::from_le_bytes(bytes[start + 2..start + 4].try_into().unwrap()),
                        1
                    );
                    assert_eq!(
                        u32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                        16_000
                    );
                    assert_eq!(
                        u16::from_le_bytes(bytes[start + 14..start + 16].try_into().unwrap()),
                        16
                    );
                    format_found = true;
                }
                b"data" => {
                    assert_eq!(length % 2, 0);
                    samples = Some(
                        bytes[start..end]
                            .chunks_exact(2)
                            .map(|sample| {
                                i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32_768.0
                            })
                            .collect(),
                    );
                }
                _ => {}
            }
            offset = end + length % 2;
        }
        assert!(format_found, "16 kHz mono PCM format chunk missing");
        samples.expect("WAV data chunk missing")
    }

    fn ordered_word_match_count(expected: &[&str], actual: &[&str]) -> usize {
        let mut previous = vec![0; actual.len() + 1];
        for word in expected {
            let mut current = vec![0; actual.len() + 1];
            for (index, spoken) in actual.iter().enumerate() {
                current[index + 1] = if word == spoken {
                    previous[index] + 1
                } else {
                    current[index].max(previous[index + 1])
                };
            }
            previous = current;
        }
        previous[actual.len()]
    }

    #[test]
    #[ignore = "requires pinned model and WAV paths; see #2626 fixture instructions"]
    fn pinned_wav_transcribes_recognizable_jfk_phrase() {
        let model = std::env::var_os("COWRITE_VOICE_FIXTURE_MODEL")
            .expect("set COWRITE_VOICE_FIXTURE_MODEL to the catalog-pinned model file");
        let wav = std::env::var_os("COWRITE_VOICE_FIXTURE_WAV")
            .expect("set COWRITE_VOICE_FIXTURE_WAV to the pinned JFK sample");
        let wav = fs::read(wav).unwrap();
        assert_eq!(wav.len(), 352_078, "fixture WAV bytes changed");
        assert_eq!(
            blake3::hash(&wav).to_hex().as_str(),
            "d4575570b38f24c717d9bb9f4fe369c38074da4067938e19a7b479b263897775",
            "fixture WAV bytes changed",
        );
        let samples = pinned_wav_samples(&wav);
        let data = tempfile::tempdir().unwrap();
        let registry = ModelRegistry::new(data.path());
        registry
            .admit(&default_model_spec(), model.as_ref())
            .unwrap();
        let transcript = WhisperTranscriber::new(registry)
            .transcribe(
                DEFAULT_MODEL_ID,
                &samples,
                Arc::new(|_| {}),
                Arc::new(|| false),
            )
            .unwrap();
        let words: Vec<String> = transcript
            .split(|character: char| !character.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        let spoken: Vec<&str> = words.iter().map(String::as_str).collect();
        let expected = [
            "and",
            "so",
            "my",
            "fellow",
            "americans",
            "ask",
            "not",
            "what",
            "your",
            "country",
            "can",
            "do",
            "for",
            "you",
            "ask",
            "what",
            "you",
            "can",
            "do",
            "for",
            "your",
            "country",
        ];
        let matching = ordered_word_match_count(&expected, &spoken);
        assert!(
            matching >= expected.len() - 4,
            "only {matching}/{} expected words matched in order: {transcript}",
            expected.len(),
        );
    }

    #[test]
    fn uppercase_trusted_digest_matches_identical_model_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.bin");
        let bytes = b"local model fixture";
        fs::write(&path, bytes).unwrap();
        let record = ModelRecord {
            spec: ModelSpec {
                id: "tiny.en".into(),
                byte_len: bytes.len() as u64,
                blake3: blake3::hash(bytes).to_hex().to_string().to_uppercase(),
            },
            path,
        };

        assert_eq!(read_and_verify(&record), Ok(bytes.to_vec()));
    }
}
