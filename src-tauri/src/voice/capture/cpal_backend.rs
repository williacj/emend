// ABOUTME: Native CPAL input-device adapter for local microphone capture.
// ABOUTME: Maps OS audio failures to typed Emend errors and keeps samples in Rust memory.
use super::{CaptureBackend, CaptureError, CaptureSession, CapturedAudio, InputDevice, MonoBuffer};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

macro_rules! pcm_sample_type {
    ($format:expr, $typed:ident) => {{
        match $format {
            SampleFormat::I8 => Some($typed!(i8)),
            SampleFormat::I16 => Some($typed!(i16)),
            SampleFormat::I24 => Some($typed!(cpal::I24)),
            SampleFormat::I32 => Some($typed!(i32)),
            SampleFormat::I64 => Some($typed!(i64)),
            SampleFormat::U8 => Some($typed!(u8)),
            SampleFormat::U16 => Some($typed!(u16)),
            SampleFormat::U24 => Some($typed!(cpal::U24)),
            SampleFormat::U32 => Some($typed!(u32)),
            SampleFormat::U64 => Some($typed!(u64)),
            SampleFormat::F32 => Some($typed!(f32)),
            SampleFormat::F64 => Some($typed!(f64)),
            _ => None,
        }
    }};
}

pub struct CpalBackend;

pub struct CpalSession {
    stream: cpal::Stream,
    samples: Arc<Mutex<MonoBuffer>>,
    failure: Arc<Mutex<Option<CaptureError>>>,
}

impl CaptureBackend for CpalBackend {
    type Session = CpalSession;

    fn devices(&self) -> Result<Vec<InputDevice>, CaptureError> {
        let host = cpal::default_host();
        let default = host
            .default_input_device()
            .map(|device| device.id().map_err(|error| map_cpal_error(error, "")))
            .transpose()?;
        input_devices(&host)?
            .into_iter()
            .map(|device| {
                let id = device.id().map_err(|error| map_cpal_error(error, ""))?;
                let name = device
                    .description()
                    .map_err(|error| map_cpal_error(error, &id.to_string()))?
                    .name()
                    .to_owned();
                Ok(InputDevice {
                    is_default: default.as_ref() == Some(&id),
                    id: id.to_string(),
                    name,
                })
            })
            .collect()
    }

    fn default_device_id(&self) -> Result<Option<String>, CaptureError> {
        cpal::default_host()
            .default_input_device()
            .map(|device| {
                device
                    .id()
                    .map(|id| id.to_string())
                    .map_err(|error| map_cpal_error(error, ""))
            })
            .transpose()
    }

    fn open(&self, id: &str) -> Result<Self::Session, CaptureError> {
        let wanted = cpal::DeviceId::from_str(id).map_err(|_| CaptureError::DeviceUnavailable {
            device_id: id.to_owned(),
        })?;
        let host = cpal::default_host();
        let mut selected = None;
        for device in input_devices(&host)? {
            let device_id = device.id().map_err(|error| map_cpal_error(error, id))?;
            if device_id == wanted {
                selected = Some(device);
                break;
            }
        }
        let device = selected.ok_or_else(|| CaptureError::DeviceUnavailable {
            device_id: id.to_owned(),
        })?;
        let supported = device
            .default_input_config()
            .map_err(|error| map_cpal_error(error, id))?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        if sample_rate == 0 || channels == 0 {
            return Err(CaptureError::CaptureFailed(
                "microphone reported an invalid input format".into(),
            ));
        }
        let format = supported.sample_format();
        let config = supported.config();
        let samples = Arc::new(Mutex::new(MonoBuffer::new(sample_rate, channels)));
        let failure = Arc::new(Mutex::new(None));

        macro_rules! build_stream {
            ($sample_type:ty) => {{
                let target = Arc::clone(&samples);
                let error_slot = Arc::clone(&failure);
                let error_device_id = id.to_owned();
                device.build_input_stream::<$sample_type, _, _>(
                    config,
                    move |data: &[$sample_type], _| {
                        let mut buffer = target.lock().unwrap_or_else(|poison| poison.into_inner());
                        buffer.push_interleaved(data, |sample| f32::from_sample(sample));
                    },
                    move |error| {
                        if error.kind() != cpal::ErrorKind::DeviceChanged {
                            let mut slot = error_slot
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner());
                            slot.get_or_insert_with(|| map_cpal_error(error, &error_device_id));
                        }
                    },
                    None,
                )
            }};
        }
        let stream = pcm_sample_type!(format, build_stream)
            .ok_or_else(|| {
                CaptureError::CaptureFailed(format!(
                    "unsupported microphone sample format: {format:?}"
                ))
            })?
            .map_err(|error| map_cpal_error(error, id))?;
        stream.play().map_err(|error| map_cpal_error(error, id))?;
        if let Some(error) = failure
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
        {
            return Err(error);
        }
        Ok(CpalSession {
            stream,
            samples,
            failure,
        })
    }
}

fn input_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>, CaptureError> {
    let mut input = Vec::new();
    for device in host.devices().map_err(|error| map_cpal_error(error, ""))? {
        let id = device
            .id()
            .map_err(|error| map_cpal_error(error, ""))?
            .to_string();
        match device.supported_input_configs() {
            Ok(mut configs) => {
                if configs.next().is_some() {
                    input.push(device);
                }
            }
            Err(error) => skip_output_only(error, &id)?,
        }
    }
    Ok(input)
}

fn skip_output_only(error: cpal::Error, id: &str) -> Result<(), CaptureError> {
    if error.kind() == cpal::ErrorKind::UnsupportedOperation {
        Ok(())
    } else {
        Err(map_cpal_error(error, id))
    }
}

impl CaptureSession for CpalSession {
    fn snapshot(&self) -> Result<CapturedAudio, CaptureError> {
        if let Some(error) = self
            .failure
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
        {
            return Err(error);
        }
        let buffer = self
            .samples
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        Ok(buffer.snapshot_audio())
    }

    fn stop(self) -> Result<CapturedAudio, CaptureError> {
        let CpalSession {
            stream,
            samples,
            failure,
        } = self;
        drop(stream);
        if let Some(error) = failure
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            return Err(error);
        }
        let mut buffer = samples.lock().unwrap_or_else(|poison| poison.into_inner());
        Ok(buffer.take_audio())
    }
}

fn map_cpal_error(error: cpal::Error, device_id: &str) -> CaptureError {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => CaptureError::PermissionDenied,
        cpal::ErrorKind::DeviceNotAvailable => CaptureError::DeviceUnavailable {
            device_id: device_id.to_owned(),
        },
        cpal::ErrorKind::HostUnavailable => CaptureError::BackendUnavailable(error.to_string()),
        _ => CaptureError::CaptureFailed(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_denial_stays_distinct_from_disconnected_hardware() {
        let denied = cpal::Error::new(cpal::ErrorKind::PermissionDenied);
        let missing = cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable);

        assert_eq!(
            map_cpal_error(denied, "built-in"),
            CaptureError::PermissionDenied
        );
        assert_eq!(
            map_cpal_error(missing, "built-in"),
            CaptureError::DeviceUnavailable {
                device_id: "built-in".into()
            }
        );
    }

    #[test]
    fn enumeration_skips_output_only_devices_but_preserves_permission_denial() {
        let output_only = cpal::Error::new(cpal::ErrorKind::UnsupportedOperation);
        let denied = cpal::Error::new(cpal::ErrorKind::PermissionDenied);

        assert_eq!(skip_output_only(output_only, "speaker"), Ok(()));
        assert_eq!(
            skip_output_only(denied, "microphone"),
            Err(CaptureError::PermissionDenied)
        );
    }

    #[test]
    fn every_pcm_sample_format_dispatches_to_its_own_typed_stream() {
        macro_rules! selected_type {
            ($sample:ty) => {
                <$sample as cpal::SizedSample>::FORMAT
            };
        }
        let pcm_formats = [
            SampleFormat::I8,
            SampleFormat::I16,
            SampleFormat::I24,
            SampleFormat::I32,
            SampleFormat::I64,
            SampleFormat::U8,
            SampleFormat::U16,
            SampleFormat::U24,
            SampleFormat::U32,
            SampleFormat::U64,
            SampleFormat::F32,
            SampleFormat::F64,
        ];
        for format in pcm_formats {
            assert_eq!(pcm_sample_type!(format, selected_type), Some(format));
        }
        assert_eq!(pcm_sample_type!(SampleFormat::DsdU8, selected_type), None);
    }
}
