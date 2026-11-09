// ABOUTME: Converts bounded mono microphone capture to Whisper's 16-kHz audio input.
// ABOUTME: Uses a fresh rubato resampler per recording so filters cannot mix sessions.
use super::capture::{CaptureError, CapturedAudio, MAX_CAPTURE_SECONDS};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub const WHISPER_SAMPLE_RATE: u32 = 16_000;
const INPUT_CHUNK_FRAMES: usize = 1_024;

pub fn to_whisper_rate(mut audio: CapturedAudio) -> Result<CapturedAudio, CaptureError> {
    if audio.sample_rate == 0 {
        return Err(CaptureError::CaptureFailed(
            "microphone reported an invalid sample rate".into(),
        ));
    }
    let source_limit = audio.sample_rate as usize * MAX_CAPTURE_SECONDS;
    if audio.samples.len() > source_limit {
        audio.samples.drain(..audio.samples.len() - source_limit);
    }
    if audio.sample_rate == WHISPER_SAMPLE_RATE {
        return Ok(audio);
    }
    if audio.samples.is_empty() {
        return Ok(CapturedAudio {
            sample_rate: WHISPER_SAMPLE_RATE,
            samples: Vec::new(),
        });
    }

    let expected = ((audio.samples.len() as u64 * WHISPER_SAMPLE_RATE as u64)
        + audio.sample_rate as u64 / 2)
        / audio.sample_rate as u64;
    let expected = expected as usize;
    let ratio = WHISPER_SAMPLE_RATE as f64 / audio.sample_rate as f64;
    let parameters = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, parameters, INPUT_CHUNK_FRAMES, 1)
        .map_err(|error| CaptureError::CaptureFailed(error.to_string()))?;
    let delay = resampler.output_delay();
    let mut output = Vec::with_capacity(expected + delay + INPUT_CHUNK_FRAMES);
    for chunk in audio.samples.chunks(INPUT_CHUNK_FRAMES) {
        let input = [chunk];
        let converted = if chunk.len() == INPUT_CHUNK_FRAMES {
            resampler.process(&input, None)
        } else {
            resampler.process_partial(Some(&input), None)
        }
        .map_err(|error| CaptureError::CaptureFailed(error.to_string()))?;
        output.extend_from_slice(&converted[0]);
    }
    while output.len() < delay + expected {
        let converted = resampler
            .process_partial::<&[f32]>(None, None)
            .map_err(|error| CaptureError::CaptureFailed(error.to_string()))?;
        if converted[0].is_empty() {
            return Err(CaptureError::CaptureFailed(
                "resampler did not produce the expected audio duration".into(),
            ));
        }
        output.extend_from_slice(&converted[0]);
    }
    let samples = output[delay..delay + expected].to_vec();
    Ok(CapturedAudio {
        sample_rate: WHISPER_SAMPLE_RATE,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_device_rates_preserve_a_tenth_second_duration() {
        for source_rate in [8_000, 16_000, 44_100, 48_000, 96_000, 192_000] {
            let audio = CapturedAudio {
                sample_rate: source_rate,
                samples: vec![0.3; source_rate as usize / 10],
            };

            let converted = to_whisper_rate(audio).unwrap();

            assert_eq!(converted.sample_rate, WHISPER_SAMPLE_RATE);
            assert_eq!(converted.samples.len(), 1_600, "source rate {source_rate}");
            assert!(
                (converted.samples[800] - 0.3).abs() < 0.001,
                "source rate {source_rate}"
            );
        }
    }
}
