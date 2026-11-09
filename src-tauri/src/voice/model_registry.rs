// ABOUTME: Machine-local voice model registry with integrity-checked admission and readback.
// ABOUTME: Ready is reported only after validating the model bytes against trusted metadata.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use fs4::FileExt;
use serde::{Deserialize, Serialize};

use crate::store::atomic;

const SCHEMA_VERSION: u32 = 1;

/// Trusted catalog data supplied by the later download/inference card. A path alone is never
/// enough to admit a model: expected size and digest must be known before any bytes are read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSpec {
    pub id: String,
    pub byte_len: u64,
    pub blake3: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRecord {
    pub spec: ModelSpec,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Corruption {
    Length { expected: u64, actual: u64 },
    Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelState {
    Absent,
    Missing(ModelRecord),
    Corrupt {
        record: ModelRecord,
        reason: Corruption,
    },
    Ready(ModelRecord),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelOrigin {
    Managed,
    External,
}

#[derive(Debug)]
pub enum RegistryError {
    InvalidSpec,
    InvalidRegistry(String),
    CandidateMissing,
    CandidateCorrupt(Corruption),
    Io(io::Error),
}

impl From<io::Error> for RegistryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Serialize, Deserialize)]
struct RegistryDocument {
    schema_version: u32,
    models: BTreeMap<String, ModelRecord>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            models: BTreeMap::new(),
        }
    }
}

/// Machine-local model registry rooted under the OS app-local-data directory, never a project.
/// Calls revalidate bytes on every readback; callers of inference must still open/recheck the
/// model they use, because a file can change after any status query.
#[derive(Clone, Debug)]
pub struct ModelRegistry {
    data_dir: PathBuf,
}

impl ModelRegistry {
    pub fn new(app_local_data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: app_local_data_dir.as_ref().join("voice"),
        }
    }

    fn registry_path(&self) -> PathBuf {
        self.data_dir.join("models.json")
    }

    fn lock_path(&self) -> PathBuf {
        self.data_dir.join("models.lock")
    }

    fn load(&self) -> Result<RegistryDocument, RegistryError> {
        let bytes = match fs::read(self.registry_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(RegistryDocument::default())
            }
            Err(error) => return Err(error.into()),
        };
        let document: RegistryDocument = serde_json::from_slice(&bytes)
            .map_err(|error| RegistryError::InvalidRegistry(error.to_string()))?;
        if document.schema_version != SCHEMA_VERSION
            || document.models.iter().any(|(id, record)| {
                id != &record.spec.id
                    || validate_spec(&record.spec).is_err()
                    || !record.path.is_absolute()
            })
        {
            return Err(RegistryError::InvalidRegistry(
                "unsupported or invalid model registry".into(),
            ));
        }
        Ok(document)
    }

    /// Admit only a candidate matching a trusted identity. The companion lock serializes
    /// updates from multiple Cowrite windows; metadata publication is an atomic replacement.
    pub fn admit(&self, spec: &ModelSpec, candidate: &Path) -> Result<ModelRecord, RegistryError> {
        validate_spec(spec)?;
        fs::create_dir_all(&self.data_dir)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.lock_path())?;
        FileExt::lock(&lock)?;
        let mut document = self.load()?;
        let path = match fs::canonicalize(candidate) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(RegistryError::CandidateMissing)
            }
            Err(error) => return Err(error.into()),
        };
        let record = ModelRecord {
            spec: spec.clone(),
            path,
        };
        match inspect(&record)? {
            ModelState::Ready(_) => {}
            ModelState::Missing(_) => return Err(RegistryError::CandidateMissing),
            ModelState::Corrupt { reason, .. } => {
                return Err(RegistryError::CandidateCorrupt(reason))
            }
            ModelState::Absent => unreachable!("inspect always returns a recorded state"),
        }
        document.models.insert(spec.id.clone(), record.clone());
        atomic::write_json(&self.registry_path(), &document)?;
        Ok(record)
    }

    /// Read the durable record and recheck the file before reporting Ready. An invalid registry
    /// is an error, never an absent or ready model.
    pub fn status(&self, id: &str) -> Result<ModelState, RegistryError> {
        let document = self.load()?;
        match document.models.get(id) {
            Some(record) => inspect(record),
            None => Ok(ModelState::Absent),
        }
    }

    /// Classify the registered path by the same guarded target used by removal. A missing file
    /// retains its recorded location; an unreadable target is not guessed to be managed.
    pub fn origin(&self, record: &ModelRecord) -> Option<ModelOrigin> {
        let target = self.managed_target_path(&record.spec)?;
        if record.path != target {
            return Some(ModelOrigin::External);
        }
        match fs::canonicalize(self.managed_download_path(&record.spec)) {
            Ok(current) if current == target => Some(ModelOrigin::Managed),
            Ok(_) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Some(ModelOrigin::Managed),
            Err(_) => None,
        }
    }

    fn managed_download_path(&self, spec: &ModelSpec) -> PathBuf {
        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        self.data_dir
            .join("models")
            .join(format!("{key}-{}.bin", spec.blake3))
    }

    fn managed_target_path(&self, spec: &ModelSpec) -> Option<PathBuf> {
        let models = self.data_dir.join("models");
        // Inspect the directory entry itself. Following a link here could classify an outside
        // model directory as Cowrite-owned, and a regular file can look like a missing child on
        // Windows even though the managed directory is obstructed.
        let managed_dir = match fs::symlink_metadata(&models) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::canonicalize(&models).ok()?,
            Ok(_) => return None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::canonicalize(&self.data_dir).ok()?.join("models")
            }
            Err(_) => return None,
        };
        Some(managed_dir.join(self.managed_download_path(spec).file_name()?))
    }

    /// Forget a trusted catalog model. Delete bytes only when the registered path is the exact
    /// app-managed download path; externally admitted candidates are never removed by Settings.
    pub fn remove_managed(&self, spec: &ModelSpec) -> Result<(), RegistryError> {
        validate_spec(spec)?;
        fs::create_dir_all(&self.data_dir)?;
        // Match the downloader's lock order: model-download lock, then registry lock. Otherwise
        // a second Cowrite process could publish after Remove returned and silently re-adopt it.
        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        let downloads = self.data_dir.join("downloads");
        fs::create_dir_all(&downloads)?;
        let download_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(downloads.join(format!("{key}.lock")))?;
        FileExt::lock(&download_lock)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.lock_path())?;
        FileExt::lock(&lock)?;
        let mut document = self.load()?;
        let Some(record) = document.models.get(&spec.id) else {
            return Ok(());
        };
        if record.spec != *spec {
            return Err(RegistryError::InvalidSpec);
        }
        let expected = self.managed_download_path(spec);
        let managed_target = self.managed_target_path(spec);
        let actual = fs::canonicalize(&expected).ok();
        if let (Some(managed_target), Some(actual)) = (managed_target, actual) {
            if actual == record.path && actual == managed_target {
                fs::remove_file(&expected)?;
            }
        }
        document.models.remove(&spec.id);
        atomic::write_json(&self.registry_path(), &document)?;
        Ok(())
    }
}

fn validate_spec(spec: &ModelSpec) -> Result<blake3::Hash, RegistryError> {
    if spec.id.trim().is_empty() || spec.byte_len == 0 {
        return Err(RegistryError::InvalidSpec);
    }
    blake3::Hash::from_hex(&spec.blake3).map_err(|_| RegistryError::InvalidSpec)
}

fn inspect(record: &ModelRecord) -> Result<ModelState, RegistryError> {
    let mut file = match File::open(&record.path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ModelState::Missing(record.clone()))
        }
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(ModelState::Corrupt {
            record: record.clone(),
            reason: Corruption::Length {
                expected: record.spec.byte_len,
                actual: 0,
            },
        });
    }
    let actual = metadata.len();
    if actual != record.spec.byte_len {
        return Ok(ModelState::Corrupt {
            record: record.clone(),
            reason: Corruption::Length {
                expected: record.spec.byte_len,
                actual,
            },
        });
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize() != validate_spec(&record.spec)? {
        return Ok(ModelState::Corrupt {
            record: record.clone(),
            reason: Corruption::Digest,
        });
    }
    Ok(ModelState::Ready(record.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::model_download::{
        DownloadControl, DownloadFailure, DownloadResponse, DownloadTransport, ModelDownloader,
        ResponseRange,
    };
    use std::fs;
    use std::io::Cursor;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::Duration;
    use tempfile::TempDir;

    fn spec(id: &str, bytes: &[u8]) -> ModelSpec {
        ModelSpec {
            id: id.into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        }
    }

    #[test]
    fn missing_bytes_never_report_ready() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);
        let candidate = dir.path().join("model.bin");
        fs::write(&candidate, b"valid model").unwrap();
        let record = registry
            .admit(&spec("tiny-en", b"valid model"), &candidate)
            .unwrap();
        fs::remove_file(&candidate).unwrap();
        assert_eq!(
            ModelRegistry::new(dir.path()).status("tiny-en").unwrap(),
            ModelState::Missing(record)
        );
    }

    #[test]
    fn removing_a_managed_model_forgets_it_without_deleting_an_external_candidate() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let bytes = b"fixture model";
        let spec = spec("tiny-en", bytes);
        let external = dir.path().join("outside.bin");
        fs::write(&external, bytes).unwrap();
        registry.admit(&spec, &external).unwrap();
        registry.remove_managed(&spec).unwrap();
        assert_eq!(registry.status(&spec.id).unwrap(), ModelState::Absent);
        assert_eq!(fs::read(&external).unwrap(), bytes);

        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        let managed = dir
            .path()
            .join("voice/models")
            .join(format!("{key}-{}.bin", spec.blake3));
        fs::create_dir_all(managed.parent().unwrap()).unwrap();
        fs::write(&managed, bytes).unwrap();
        registry.admit(&spec, &managed).unwrap();
        registry.remove_managed(&spec).unwrap();
        assert_eq!(registry.status(&spec.id).unwrap(), ModelState::Absent);
        assert!(!managed.exists());
    }

    #[test]
    fn registered_origin_fails_closed_when_managed_path_changes() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let bytes = b"trusted bytes";
        let spec = spec("origin-path", bytes);
        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        let models = dir.path().join("voice/models");
        let managed = models.join(format!("{key}-{}.bin", spec.blake3));
        fs::create_dir_all(&models).unwrap();
        fs::write(&managed, bytes).unwrap();
        let record = registry.admit(&spec, &managed).unwrap();
        assert_eq!(registry.origin(&record), Some(ModelOrigin::Managed));

        fs::remove_file(&managed).unwrap();
        fs::remove_dir(&models).unwrap();
        let ModelState::Missing(record) = registry.status(&spec.id).unwrap() else {
            panic!("missing managed file must retain its registry record");
        };
        assert_eq!(registry.origin(&record), Some(ModelOrigin::Managed));

        fs::write(&models, b"not a directory").unwrap();
        assert_eq!(registry.origin(&record), None);
        fs::remove_file(&models).unwrap();

        #[cfg(unix)]
        {
            fs::create_dir_all(&models).unwrap();
            let outside = dir.path().join("outside.bin");
            fs::write(&outside, bytes).unwrap();
            std::os::unix::fs::symlink(&outside, &managed).unwrap();
            let ModelState::Ready(redirected) = registry.status(&spec.id).unwrap() else {
                panic!("matching outside bytes still inspect as ready");
            };
            assert_eq!(registry.origin(&redirected), None);
            registry.remove_managed(&spec).unwrap();
            assert_eq!(fs::read(&outside).unwrap(), bytes);
        }
    }

    #[test]
    fn managed_target_rejects_file_obstruction() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let spec = spec("origin-path", b"trusted bytes");
        fs::create_dir_all(dir.path().join("voice")).unwrap();
        assert!(registry.managed_target_path(&spec).is_some());

        fs::write(dir.path().join("voice/models"), b"not a directory").unwrap();
        assert_eq!(registry.managed_target_path(&spec), None);
    }

    #[cfg(unix)]
    #[test]
    fn redirected_models_directory_never_owns_external_bytes() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let bytes = b"trusted bytes";
        let spec = spec("origin-path", bytes);
        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        let outside_dir = dir.path().join("outside");
        fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join(format!("{key}-{}.bin", spec.blake3));
        fs::write(&outside, bytes).unwrap();
        fs::create_dir_all(dir.path().join("voice")).unwrap();
        std::os::unix::fs::symlink(&outside_dir, dir.path().join("voice/models")).unwrap();

        let record = registry.admit(&spec, &outside).unwrap();
        assert_eq!(registry.origin(&record), None);
        registry.remove_managed(&spec).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), bytes);
    }

    struct HeldTransport {
        bytes: Vec<u8>,
        opened: Sender<()>,
        release: Receiver<()>,
    }

    impl DownloadTransport for HeldTransport {
        fn open(
            &self,
            _url: &str,
            offset: u64,
            _cancel: &crate::voice::model_download::DownloadCancellation,
        ) -> Result<DownloadResponse, DownloadFailure> {
            self.opened.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(DownloadResponse {
                range: ResponseRange::From {
                    start: offset,
                    total: self.bytes.len() as u64,
                },
                stream: Box::new(Cursor::new(self.bytes[offset as usize..].to_vec())),
            })
        }
    }

    #[test]
    fn remove_waits_for_another_instances_download_publish_then_leaves_no_adopted_model() {
        let dir = TempDir::new().unwrap();
        let bytes = b"cross-window model";
        let expected = spec("tiny-en", bytes);
        let (opened_tx, opened_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let download_dir = dir.path().to_path_buf();
        let download_spec = expected.clone();
        let downloader = std::thread::spawn(move || {
            ModelDownloader::new(
                &download_dir,
                ModelRegistry::new(&download_dir),
                HeldTransport {
                    bytes: bytes.to_vec(),
                    opened: opened_tx,
                    release: release_rx,
                },
            )
            .download(&download_spec, "https://example.test/model.bin", |_| {
                DownloadControl::Continue
            })
            .unwrap();
        });
        opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let remove_dir = dir.path().to_path_buf();
        let remove_spec = expected.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let remover = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = ModelRegistry::new(&remove_dir).remove_managed(&remove_spec);
            done_tx.send(result).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let premature = done_rx.recv_timeout(Duration::from_millis(500));
        release_tx.send(()).unwrap();
        downloader.join().unwrap();
        remover.join().unwrap();
        assert!(
            matches!(premature, Err(mpsc::RecvTimeoutError::Timeout)),
            "Remove returned while another instance still held the model download lock"
        );
        assert_eq!(
            ModelRegistry::new(dir.path()).status(&expected.id).unwrap(),
            ModelState::Absent
        );
    }

    #[test]
    fn changed_bytes_never_report_ready() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let candidate = dir.path().join("model.bin");
        fs::write(&candidate, b"valid model").unwrap();
        let record = registry
            .admit(&spec("tiny-en", b"valid model"), &candidate)
            .unwrap();
        fs::write(&candidate, b"short").unwrap();
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Corrupt {
                record: record.clone(),
                reason: Corruption::Length {
                    expected: 11,
                    actual: 5
                },
            }
        );
        fs::write(&candidate, b"alter model").unwrap();
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Corrupt {
                record,
                reason: Corruption::Digest,
            }
        );
    }

    #[test]
    fn failed_admission_preserves_ready_and_valid_repair_recovers() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        let original = dir.path().join("original.bin");
        let candidate = dir.path().join("candidate.bin");
        fs::write(&original, b"original model").unwrap();
        let first = registry
            .admit(&spec("tiny-en", b"original model"), &original)
            .unwrap();
        fs::write(&candidate, b"bad candidate!").unwrap();
        assert!(matches!(
            registry.admit(&spec("tiny-en", b"trusted bytes"), &candidate),
            Err(RegistryError::CandidateCorrupt(Corruption::Length { .. }))
        ));
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(first.clone())
        );
        fs::write(&candidate, b"untrusteddata").unwrap();
        assert!(matches!(
            registry.admit(&spec("tiny-en", b"trusted bytes"), &candidate),
            Err(RegistryError::CandidateCorrupt(Corruption::Digest))
        ));
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(first.clone())
        );
        fs::remove_file(&original).unwrap();
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Missing(first.clone())
        );
        fs::write(&original, b"broken bytes").unwrap();
        assert!(matches!(
            registry.status("tiny-en").unwrap(),
            ModelState::Corrupt { .. }
        ));
        fs::write(&candidate, b"trusted bytes").unwrap();
        let recovered = registry
            .admit(&spec("tiny-en", b"trusted bytes"), &candidate)
            .unwrap();
        assert_eq!(
            ModelRegistry::new(dir.path()).status("tiny-en").unwrap(),
            ModelState::Ready(recovered)
        );
    }

    #[test]
    fn damaged_registry_fails_closed() {
        let dir = TempDir::new().unwrap();
        let registry = ModelRegistry::new(dir.path());
        fs::create_dir_all(dir.path().join("voice")).unwrap();
        let path = dir.path().join("voice/models.json");
        fs::write(&path, b"invalid json").unwrap();
        assert!(matches!(
            registry.status("tiny-en"),
            Err(RegistryError::InvalidRegistry(_))
        ));
        fs::write(&path, br#"{"schema_version":99,"models":{}}"#).unwrap();
        assert!(matches!(
            registry.status("tiny-en"),
            Err(RegistryError::InvalidRegistry(_))
        ));
    }

    #[test]
    fn admitted_model_is_ready_after_relaunch() {
        let dir = TempDir::new().unwrap();
        let candidate = dir.path().join("model.bin");
        let bytes = b"synthetic voice model fixture";
        fs::write(&candidate, bytes).unwrap();
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let first = ModelRegistry::new(dir.path());
        let admitted = first.admit(&spec, &candidate).unwrap();
        assert_eq!(admitted.path, fs::canonicalize(&candidate).unwrap());
        let after_relaunch = ModelRegistry::new(dir.path());
        assert_eq!(
            after_relaunch.status(&spec.id).unwrap(),
            ModelState::Ready(admitted)
        );
    }
}
