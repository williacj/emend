// ABOUTME: Resumable local model downloads with typed progress and integrity-checked admission.
// ABOUTME: The transport is injectable; only verified complete bytes enter the model registry.

use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use tokio::sync::Notify;

use fs4::FileExt;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::redirect::Policy;
use reqwest::Client;
use reqwest::{StatusCode, Url};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::model_registry::{Corruption, ModelRecord, ModelRegistry, ModelSpec, ModelState};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DownloadFailure {
    Transport(String),
    Storage(String),
    Registry(String),
    Protocol,
    Truncated { expected: u64, actual: u64 },
    Oversized { expected: u64, actual: u64 },
    Corrupt(Corruption),
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: u64 },
    Completed { record: ModelRecord },
    Cancelled { downloaded: u64, total: u64 },
    Failed { reason: DownloadFailure },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadControl {
    Continue,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseRange {
    Full,
    From { start: u64, total: u64 },
}

pub struct DownloadResponse {
    pub range: ResponseRange,
    pub stream: Box<dyn Read + Send>,
}

#[derive(Clone, Default)]
pub struct DownloadCancellation(Arc<DownloadCancellationInner>);

#[derive(Default)]
struct DownloadCancellationInner {
    state: Mutex<DownloadLifecycle>,
    changed: Condvar,
    async_changed: Notify,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum DownloadLifecycle {
    #[default]
    Active,
    Cancelled,
    Finished,
}

impl DownloadCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) -> bool {
        let Ok(mut state) = self.0.state.lock() else {
            return false;
        };
        if *state != DownloadLifecycle::Active {
            return false;
        }
        *state = DownloadLifecycle::Cancelled;
        self.0.changed.notify_all();
        self.0.async_changed.notify_waiters();
        true
    }

    pub fn is_cancelled(&self) -> bool {
        self.0
            .state
            .lock()
            .is_ok_and(|state| *state == DownloadLifecycle::Cancelled)
    }

    pub fn claim_completion(&self) -> bool {
        let Ok(mut state) = self.0.state.lock() else {
            return false;
        };
        if *state != DownloadLifecycle::Active {
            return false;
        }
        *state = DownloadLifecycle::Finished;
        true
    }

    pub fn wait_blocking(&self) {
        let Ok(mut state) = self.0.state.lock() else {
            return;
        };
        while *state == DownloadLifecycle::Active {
            let Ok(next) = self.0.changed.wait(state) else {
                return;
            };
            state = next;
        }
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.async_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub trait DownloadTransport {
    fn open(
        &self,
        url: &str,
        offset: u64,
        cancel: &DownloadCancellation,
    ) -> Result<DownloadResponse, DownloadFailure>;
}

/// Production HTTPS transport. Source URLs are supplied alongside trusted model metadata;
/// the expected digest remains the authority regardless of server response headers. Call from a
/// the downloader's blocking worker. Network waits run on Tokio so Cancel can interrupt them.
pub struct HttpTransport {
    client: Client,
    executor: HttpExecutor,
}

enum HttpExecutor {
    Shared(Handle),
    Owned(Runtime),
}

impl HttpExecutor {
    fn handle(&self) -> &Handle {
        match self {
            Self::Shared(handle) => handle,
            Self::Owned(runtime) => runtime.handle(),
        }
    }
}

enum HttpMessage {
    Header(ResponseRange),
    Chunk(Vec<u8>),
    Failure(DownloadFailure),
}

struct HttpReader {
    receiver: mpsc::Receiver<HttpMessage>,
    pending: Cursor<Vec<u8>>,
    cancel: DownloadCancellation,
    task: Option<JoinHandle<()>>,
    handle: Handle,
}

impl Read for HttpReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            if self.cancel.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "download cancelled",
                ));
            }
            let read = self.pending.read(out)?;
            if read > 0 {
                return Ok(read);
            }
            match self.receiver.blocking_recv() {
                Some(HttpMessage::Chunk(bytes)) => self.pending = Cursor::new(bytes),
                Some(HttpMessage::Failure(_)) => {
                    return Err(io::Error::other("response stream failed"))
                }
                Some(HttpMessage::Header(_)) => {
                    return Err(io::Error::other("unexpected HTTP header"))
                }
                None if self.cancel.is_cancelled() => {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "download cancelled",
                    ));
                }
                None => return Ok(0),
            }
        }
    }
}

impl Drop for HttpReader {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            // This reader is consumed only on the downloader's blocking worker. Join before
            // releasing its per-model lock so an old request cannot outlive its attempt.
            let _ = self.handle.block_on(task);
        }
    }
}

async fn cancel_await<F: Future>(
    cancel: &DownloadCancellation,
    future: F,
) -> Result<F::Output, DownloadFailure> {
    tokio::select! {
        _ = cancel.cancelled() => Err(DownloadFailure::Cancelled),
        result = future => Ok(result),
    }
}

impl HttpTransport {
    pub fn new() -> Result<Self, DownloadFailure> {
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(300))
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() > 10 || attempt.url().scheme() != "https" {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| DownloadFailure::Transport("HTTP client initialization failed".into()))?;
        let executor = match Handle::try_current() {
            Ok(handle) => HttpExecutor::Shared(handle),
            Err(_) => HttpExecutor::Owned(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .map_err(|_| {
                        DownloadFailure::Transport("HTTP runtime initialization failed".into())
                    })?,
            ),
        };
        Ok(Self { client, executor })
    }
}

impl DownloadTransport for HttpTransport {
    fn open(
        &self,
        url: &str,
        offset: u64,
        cancel: &DownloadCancellation,
    ) -> Result<DownloadResponse, DownloadFailure> {
        let parsed = Url::parse(url).map_err(|_| DownloadFailure::Protocol)?;
        if parsed.scheme() != "https" {
            return Err(DownloadFailure::Protocol);
        }
        let mut request = self.client.get(parsed).header(ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let (sender, mut receiver) = mpsc::channel(2);
        let worker_cancel = cancel.clone();
        let handle = self.executor.handle().clone();
        let task = handle.spawn(async move {
            let mut response = match cancel_await(&worker_cancel, request.send()).await {
                Ok(Ok(response)) => response,
                Err(DownloadFailure::Cancelled) => return,
                Ok(Err(error)) => {
                    let message = if error.is_timeout() {
                        "request timed out"
                    } else if error.is_connect() {
                        "connection failed"
                    } else {
                        "request failed"
                    };
                    let _ = sender
                        .send(HttpMessage::Failure(DownloadFailure::Transport(
                            message.into(),
                        )))
                        .await;
                    return;
                }
                Err(_) => return,
            };
            let range = match response.status() {
                StatusCode::OK => Ok(ResponseRange::Full),
                StatusCode::PARTIAL_CONTENT => response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|header| header.to_str().ok())
                    .and_then(parse_content_range)
                    .ok_or(DownloadFailure::Protocol),
                status => Err(DownloadFailure::Transport(format!(
                    "HTTP {}",
                    status.as_u16()
                ))),
            };
            let range = match range {
                Ok(range) => range,
                Err(reason) => {
                    let _ = sender.send(HttpMessage::Failure(reason)).await;
                    return;
                }
            };
            if cancel_await(&worker_cancel, sender.send(HttpMessage::Header(range)))
                .await
                .is_err()
            {
                return;
            }
            loop {
                match cancel_await(&worker_cancel, response.chunk()).await {
                    Ok(Ok(Some(chunk))) => {
                        if cancel_await(
                            &worker_cancel,
                            sender.send(HttpMessage::Chunk(chunk.to_vec())),
                        )
                        .await
                        .is_err()
                        {
                            return;
                        }
                    }
                    Ok(Ok(None)) | Err(DownloadFailure::Cancelled) => return,
                    Ok(Err(_)) => {
                        let _ = sender
                            .send(HttpMessage::Failure(DownloadFailure::Transport(
                                "response stream failed".into(),
                            )))
                            .await;
                        return;
                    }
                    Err(_) => return,
                }
            }
        });
        let first = receiver.blocking_recv();
        if cancel.is_cancelled() {
            task.abort();
            let _ = handle.block_on(task);
            return Err(DownloadFailure::Cancelled);
        }
        let range = match first {
            Some(HttpMessage::Header(range)) => range,
            Some(HttpMessage::Failure(reason)) => {
                let _ = handle.block_on(task);
                return Err(reason);
            }
            _ => {
                let _ = handle.block_on(task);
                return Err(DownloadFailure::Transport(
                    "request stopped before headers".into(),
                ));
            }
        };
        Ok(DownloadResponse {
            range,
            stream: Box::new(HttpReader {
                receiver,
                pending: Cursor::new(Vec::new()),
                cancel: cancel.clone(),
                task: Some(task),
                handle,
            }),
        })
    }
}

fn parse_content_range(value: &str) -> Option<ResponseRange> {
    let remainder = value.strip_prefix("bytes ")?;
    let (bounds, total) = remainder.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    if start > end || end >= total {
        return None;
    }
    Some(ResponseRange::From { start, total })
}

pub struct ModelDownloader<T> {
    data_dir: PathBuf,
    registry: ModelRegistry,
    transport: T,
    sync_file: fn(&File) -> io::Result<()>,
}

impl<T: DownloadTransport> ModelDownloader<T> {
    pub fn new(
        app_local_data_dir: impl AsRef<Path>,
        registry: ModelRegistry,
        transport: T,
    ) -> Self {
        Self {
            data_dir: app_local_data_dir.as_ref().join("voice"),
            registry,
            transport,
            sync_file: File::sync_all,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_sync(mut self, sync_file: fn(&File) -> io::Result<()>) -> Self {
        self.sync_file = sync_file;
        self
    }

    pub fn download(
        &self,
        spec: &ModelSpec,
        url: &str,
        on_event: impl FnMut(DownloadEvent) -> DownloadControl,
    ) -> Result<ModelRecord, DownloadFailure> {
        self.download_with_cancel(spec, url, &DownloadCancellation::new(), on_event)
    }

    pub fn download_with_cancel(
        &self,
        spec: &ModelSpec,
        url: &str,
        cancel: &DownloadCancellation,
        mut on_event: impl FnMut(DownloadEvent) -> DownloadControl,
    ) -> Result<ModelRecord, DownloadFailure> {
        let result = self.download_inner(spec, url, cancel, &mut on_event);
        match &result {
            Ok(record) => {
                on_event(DownloadEvent::Completed {
                    record: record.clone(),
                });
            }
            Err(DownloadFailure::Cancelled) => {}
            Err(reason) => {
                on_event(DownloadEvent::Failed {
                    reason: reason.clone(),
                });
            }
        }
        result
    }

    fn download_inner(
        &self,
        spec: &ModelSpec,
        url: &str,
        cancel: &DownloadCancellation,
        on_event: &mut impl FnMut(DownloadEvent) -> DownloadControl,
    ) -> Result<ModelRecord, DownloadFailure> {
        let expected =
            blake3::Hash::from_hex(&spec.blake3).map_err(|_| DownloadFailure::Protocol)?;
        if spec.id.trim().is_empty() || spec.byte_len == 0 {
            return Err(DownloadFailure::Protocol);
        }
        let key = blake3::hash(spec.id.as_bytes()).to_hex().to_string();
        let downloads = self.data_dir.join("downloads");
        let models = self.data_dir.join("models");
        fs::create_dir_all(&downloads).map_err(storage)?;
        fs::create_dir_all(&models).map_err(storage)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(downloads.join(format!("{key}.lock")))
            .map_err(storage)?;
        FileExt::lock(&lock).map_err(storage)?;

        if let ModelState::Ready(record) = self.registry.status(&spec.id).map_err(registry)? {
            if record.spec == *spec {
                if !cancel.claim_completion() {
                    on_event(DownloadEvent::Cancelled {
                        downloaded: 0,
                        total: spec.byte_len,
                    });
                    return Err(DownloadFailure::Cancelled);
                }
                return Ok(record);
            }
        }
        let final_path = models.join(format!("{key}-{}.bin", expected.to_hex()));
        if valid_file(&final_path, spec.byte_len, expected).map_err(storage)? {
            if !cancel.claim_completion() {
                on_event(DownloadEvent::Cancelled {
                    downloaded: 0,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
            return self.registry.admit(spec, &final_path).map_err(registry);
        }
        // A partial belongs to one trusted digest; a catalog update starts from zero.
        let partial = downloads.join(format!("{key}-{}.partial", expected.to_hex()));
        let mut offset = match fs::metadata(&partial) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(storage(error)),
        };
        if offset >= spec.byte_len {
            if offset == spec.byte_len
                && valid_file(&partial, spec.byte_len, expected).map_err(storage)?
            {
                if !cancel.claim_completion() {
                    on_event(DownloadEvent::Cancelled {
                        downloaded: offset,
                        total: spec.byte_len,
                    });
                    return Err(DownloadFailure::Cancelled);
                }
                return self.publish(spec, &partial, &final_path);
            }
            fs::remove_file(&partial).map_err(storage)?;
            offset = 0;
        }
        if on_event(DownloadEvent::Progress {
            downloaded: offset,
            total: spec.byte_len,
        }) == DownloadControl::Cancel
        {
            on_event(DownloadEvent::Cancelled {
                downloaded: offset,
                total: spec.byte_len,
            });
            return Err(DownloadFailure::Cancelled);
        }
        let mut response = match self.transport.open(url, offset, cancel) {
            Ok(response) => response,
            Err(DownloadFailure::Cancelled) => {
                on_event(DownloadEvent::Cancelled {
                    downloaded: offset,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
            Err(_) if cancel.is_cancelled() => {
                on_event(DownloadEvent::Cancelled {
                    downloaded: offset,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
            Err(reason) => return Err(reason),
        };
        match response.range {
            ResponseRange::Full => {
                if offset > 0 {
                    // The reset is durable before reporting zero or allowing cancellation.
                    let file = OpenOptions::new()
                        .write(true)
                        .open(&partial)
                        .map_err(storage)?;
                    file.set_len(0).map_err(storage)?;
                    (self.sync_file)(&file).map_err(storage)?;
                    offset = 0;
                    if on_event(DownloadEvent::Progress {
                        downloaded: 0,
                        total: spec.byte_len,
                    }) == DownloadControl::Cancel
                    {
                        on_event(DownloadEvent::Cancelled {
                            downloaded: 0,
                            total: spec.byte_len,
                        });
                        return Err(DownloadFailure::Cancelled);
                    }
                }
            }
            ResponseRange::From { start, total } if start == offset && total == spec.byte_len => {}
            _ => return Err(DownloadFailure::Protocol),
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(offset == 0)
            .append(offset > 0)
            .open(&partial)
            .map_err(storage)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancel.is_cancelled() {
                (self.sync_file)(&file).map_err(storage)?;
                on_event(DownloadEvent::Cancelled {
                    downloaded: offset,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
            let read = match response.stream.read(&mut buffer) {
                Ok(read) => read,
                Err(_) if cancel.is_cancelled() => {
                    (self.sync_file)(&file).map_err(storage)?;
                    on_event(DownloadEvent::Cancelled {
                        downloaded: offset,
                        total: spec.byte_len,
                    });
                    return Err(DownloadFailure::Cancelled);
                }
                Err(_) => return Err(DownloadFailure::Transport("response stream failed".into())),
            };
            if cancel.is_cancelled() {
                (self.sync_file)(&file).map_err(storage)?;
                on_event(DownloadEvent::Cancelled {
                    downloaded: offset,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
            if read == 0 {
                break;
            }
            let next = offset + read as u64;
            if next > spec.byte_len {
                return Err(DownloadFailure::Oversized {
                    expected: spec.byte_len,
                    actual: next,
                });
            }
            file.write_all(&buffer[..read]).map_err(storage)?;
            offset = next;
            if on_event(DownloadEvent::Progress {
                downloaded: offset,
                total: spec.byte_len,
            }) == DownloadControl::Cancel
            {
                (self.sync_file)(&file).map_err(storage)?;
                on_event(DownloadEvent::Cancelled {
                    downloaded: offset,
                    total: spec.byte_len,
                });
                return Err(DownloadFailure::Cancelled);
            }
        }
        (self.sync_file)(&file).map_err(storage)?;
        if offset < spec.byte_len {
            return Err(DownloadFailure::Truncated {
                expected: spec.byte_len,
                actual: offset,
            });
        }
        drop(file);
        if !valid_file(&partial, spec.byte_len, expected).map_err(storage)? {
            fs::remove_file(&partial).map_err(storage)?;
            return Err(DownloadFailure::Corrupt(Corruption::Digest));
        }
        if !cancel.claim_completion() {
            on_event(DownloadEvent::Cancelled {
                downloaded: offset,
                total: spec.byte_len,
            });
            return Err(DownloadFailure::Cancelled);
        }
        self.publish(spec, &partial, &final_path)
    }

    fn publish(
        &self,
        spec: &ModelSpec,
        partial: &Path,
        final_path: &Path,
    ) -> Result<ModelRecord, DownloadFailure> {
        fs::rename(partial, final_path).map_err(storage)?;
        self.registry.admit(spec, final_path).map_err(registry)
    }
}

fn valid_file(path: &Path, len: u64, digest: blake3::Hash) -> io::Result<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() != len {
        return Ok(false);
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
    Ok(hasher.finalize() == digest)
}

fn storage(error: io::Error) -> DownloadFailure {
    DownloadFailure::Storage(error.to_string())
}
fn registry(error: impl std::fmt::Debug) -> DownloadFailure {
    DownloadFailure::Registry(format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::model_registry::{ModelRegistry, ModelSpec, ModelState};
    use std::cell::RefCell;
    use std::io::{self, Cursor, Read};
    use tempfile::TempDir;

    #[test]
    fn cancellation_and_verified_completion_have_one_winner() {
        let cancelled = DownloadCancellation::new();
        assert!(cancelled.cancel());
        assert!(!cancelled.claim_completion());
        let completed = DownloadCancellation::new();
        assert!(completed.claim_completion());
        assert!(!completed.cancel());
        assert!(!completed.is_cancelled());
    }

    #[tokio::test]
    async fn held_connect_and_body_futures_retire_on_cancel_without_release() {
        for boundary in ["connect", "body"] {
            let cancel = DownloadCancellation::new();
            let worker_cancel = cancel.clone();
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let worker = tokio::spawn(async move {
                cancel_await(&worker_cancel, async move {
                    entered_tx.send(()).unwrap();
                    std::future::pending::<()>().await;
                })
                .await
            });
            entered_rx.await.unwrap();
            assert!(cancel.cancel(), "{boundary}");
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(5), worker)
                    .await
                    .unwrap()
                    .unwrap(),
                Err(DownloadFailure::Cancelled),
                "{boundary}",
            );
        }
    }

    #[test]
    fn bounded_http_reader_discards_buffered_bytes_after_cancel_and_joins_producer() {
        use std::sync::mpsc as std_mpsc;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let handle = runtime.handle().clone();
        let cancel = DownloadCancellation::new();
        let worker_cancel = cancel.clone();
        let (sender, receiver) = mpsc::channel(2);
        let (held_tx, held_rx) = std_mpsc::sync_channel(0);
        let task = handle.spawn(async move {
            sender
                .send(HttpMessage::Chunk(b"first".to_vec()))
                .await
                .unwrap();
            held_tx.send(()).unwrap();
            let _ = cancel_await(&worker_cancel, std::future::pending::<()>()).await;
        });
        let (result_tx, result_rx) = std_mpsc::channel();
        let (first_read_tx, first_read_rx) = std_mpsc::sync_channel(0);
        let reader_handle = handle.clone();
        let reader_cancel = cancel.clone();
        let reader = handle.spawn_blocking(move || {
            let mut reader = HttpReader {
                receiver,
                pending: Cursor::new(Vec::new()),
                cancel: reader_cancel,
                task: Some(task),
                handle: reader_handle,
            };
            let mut first = [0u8; 5];
            assert_eq!(reader.read(&mut first).unwrap(), 5);
            assert_eq!(&first, b"first");
            first_read_tx.send(()).unwrap();
            let mut next = [0u8; 5];
            result_tx
                .send(reader.read(&mut next).map_err(|error| error.kind()))
                .unwrap();
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        first_read_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(cancel.cancel());
        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err(io::ErrorKind::Interrupted)
        );
        handle.block_on(reader).unwrap();
    }

    #[test]
    fn cancel_interrupts_a_held_open_without_releasing_the_transport() {
        use std::sync::{mpsc, Arc, Mutex};

        struct HeldOpen {
            entered: mpsc::SyncSender<()>,
        }
        impl DownloadTransport for HeldOpen {
            fn open(
                &self,
                _url: &str,
                _offset: u64,
                cancel: &DownloadCancellation,
            ) -> Result<DownloadResponse, DownloadFailure> {
                self.entered.send(()).unwrap();
                cancel.wait_blocking();
                Err(DownloadFailure::Cancelled)
            }
        }
        let dir = TempDir::new().unwrap();
        let bytes = b"verified model bytes";
        let spec = ModelSpec {
            id: "held-open".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (result_tx, result_rx) = mpsc::channel();
        let cancel = DownloadCancellation::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let worker_events = Arc::clone(&events);
        let worker_cancel = cancel.clone();
        let downloader = ModelDownloader::new(
            dir.path(),
            registry.clone(),
            HeldOpen {
                entered: entered_tx,
            },
        );
        let worker = std::thread::spawn(move || {
            let result = downloader.download_with_cancel(
                &spec,
                "https://example.test/model",
                &worker_cancel,
                |event| {
                    worker_events.lock().unwrap().push(event);
                    DownloadControl::Continue
                },
            );
            result_tx.send(result).unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(cancel.cancel());
        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err(DownloadFailure::Cancelled)
        );
        worker.join().unwrap();
        assert_eq!(registry.status("held-open").unwrap(), ModelState::Absent);
        assert!(
            matches!(events.lock().unwrap().last(), Some(DownloadEvent::Cancelled { downloaded: 0, total }) if *total == bytes.len() as u64)
        );
    }

    #[test]
    fn cancel_interrupts_a_held_body_and_retry_resumes_its_partial() {
        use std::sync::mpsc;

        struct HeldBody {
            entered: mpsc::SyncSender<()>,
            bytes: Vec<u8>,
        }
        struct Reader {
            entered: mpsc::SyncSender<()>,
            cancel: DownloadCancellation,
            first: Vec<u8>,
            sent: bool,
        }
        impl Read for Reader {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if !self.sent {
                    self.sent = true;
                    out[..self.first.len()].copy_from_slice(&self.first);
                    return Ok(self.first.len());
                }
                self.entered.send(()).unwrap();
                self.cancel.wait_blocking();
                Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled body"))
            }
        }
        impl DownloadTransport for HeldBody {
            fn open(
                &self,
                _url: &str,
                offset: u64,
                cancel: &DownloadCancellation,
            ) -> Result<DownloadResponse, DownloadFailure> {
                assert_eq!(offset, 0);
                Ok(DownloadResponse {
                    range: ResponseRange::From {
                        start: 0,
                        total: self.bytes.len() as u64,
                    },
                    stream: Box::new(Reader {
                        entered: self.entered.clone(),
                        cancel: cancel.clone(),
                        first: self.bytes[..5].to_vec(),
                        sent: false,
                    }),
                })
            }
        }
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted model bytes";
        let spec = ModelSpec {
            id: "held-body".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (result_tx, result_rx) = mpsc::channel();
        let cancel = DownloadCancellation::new();
        let worker_cancel = cancel.clone();
        let worker_spec = spec.clone();
        let worker_dir = dir.path().to_path_buf();
        let worker_bytes = bytes.to_vec();
        let worker = std::thread::spawn(move || {
            let downloader = ModelDownloader::new(
                &worker_dir,
                ModelRegistry::new(&worker_dir),
                HeldBody {
                    entered: entered_tx,
                    bytes: worker_bytes,
                },
            );
            result_tx
                .send(downloader.download_with_cancel(
                    &worker_spec,
                    "https://example.test/model",
                    &worker_cancel,
                    |_| DownloadControl::Continue,
                ))
                .unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(cancel.cancel());
        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err(DownloadFailure::Cancelled)
        );
        worker.join().unwrap();
        assert_eq!(registry.status("held-body").unwrap(), ModelState::Absent);
        let retry = ModelDownloader::new(dir.path(), registry.clone(), FakeTransport::new(bytes));
        retry
            .download(&spec, "https://example.test/model", |_| {
                DownloadControl::Continue
            })
            .unwrap();
        assert_eq!(retry.transport.requested.borrow().as_slice(), &[5]);
        assert!(matches!(
            registry.status("held-body").unwrap(),
            ModelState::Ready(_)
        ));
    }

    struct FakeTransport {
        bytes: Vec<u8>,
        requested: RefCell<Vec<u64>>,
        fail_after: RefCell<Option<usize>>,
        ignore_range: RefCell<bool>,
        truncate_at: RefCell<Option<usize>>,
        chunk_size: RefCell<Option<usize>>,
    }

    impl FakeTransport {
        fn new(bytes: &[u8]) -> Self {
            Self {
                bytes: bytes.to_vec(),
                requested: RefCell::new(Vec::new()),
                fail_after: RefCell::new(None),
                ignore_range: RefCell::new(false),
                truncate_at: RefCell::new(None),
                chunk_size: RefCell::new(None),
            }
        }
    }

    struct InterruptedReader {
        source: Cursor<Vec<u8>>,
        remaining: usize,
    }
    struct ChunkReader {
        source: Cursor<Vec<u8>>,
        max_chunk: usize,
    }

    impl Read for ChunkReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let limit = out.len().min(self.max_chunk);
            self.source.read(&mut out[..limit])
        }
    }

    impl Read for InterruptedReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "interrupted",
                ));
            }
            let limit = out.len().min(self.remaining);
            let read = self.source.read(&mut out[..limit])?;
            self.remaining -= read;
            Ok(read)
        }
    }

    impl DownloadTransport for FakeTransport {
        fn open(
            &self,
            _url: &str,
            offset: u64,
            _cancel: &DownloadCancellation,
        ) -> Result<DownloadResponse, DownloadFailure> {
            self.requested.borrow_mut().push(offset);
            let actual_offset = if *self.ignore_range.borrow() {
                0
            } else {
                offset
            };
            let mut bytes = self.bytes[actual_offset as usize..].to_vec();
            if let Some(limit) = self.truncate_at.borrow_mut().take() {
                bytes.truncate(limit);
            }
            let stream: Box<dyn Read + Send> = match self.fail_after.borrow_mut().take() {
                Some(limit) => Box::new(InterruptedReader {
                    source: Cursor::new(bytes),
                    remaining: limit,
                }),
                None => match *self.chunk_size.borrow() {
                    Some(max_chunk) => Box::new(ChunkReader {
                        source: Cursor::new(bytes),
                        max_chunk,
                    }),
                    None => Box::new(Cursor::new(bytes)),
                },
            };
            let range = if *self.ignore_range.borrow() {
                ResponseRange::Full
            } else {
                ResponseRange::From {
                    start: offset,
                    total: self.bytes.len() as u64,
                }
            };
            Ok(DownloadResponse { range, stream })
        }
    }

    #[test]
    fn interrupted_download_resumes_and_only_complete_verified_bytes_become_ready() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let transport = FakeTransport::new(bytes);
        *transport.fail_after.borrow_mut() = Some(7);
        let downloader = ModelDownloader::new(dir.path(), registry.clone(), transport);
        let mut events = Vec::new();
        assert!(matches!(
            downloader.download(&spec, "fake://model", |event| {
                events.push(event);
                DownloadControl::Continue
            }),
            Err(DownloadFailure::Transport(_))
        ));
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);
        let record = downloader
            .download(&spec, "fake://model", |event| {
                events.push(event);
                DownloadControl::Continue
            })
            .unwrap();
        assert_eq!(downloader.transport.requested.borrow().as_slice(), &[0, 7]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
        assert!(events.iter().any(|event| matches!(event, DownloadEvent::Progress { downloaded: 7, total } if *total == bytes.len() as u64)));
        assert!(matches!(
            events.last(),
            Some(DownloadEvent::Completed { .. })
        ));
    }

    #[test]
    fn ignored_range_restarts_with_truthful_progress_before_appending() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let transport = FakeTransport::new(bytes);
        *transport.fail_after.borrow_mut() = Some(5);
        let downloader = ModelDownloader::new(dir.path(), registry.clone(), transport);
        let _ = downloader.download(&spec, "fake://model", |_| DownloadControl::Continue);
        *downloader.transport.ignore_range.borrow_mut() = true;
        let mut progress = Vec::new();
        let record = downloader
            .download(&spec, "fake://model", |event| {
                if let DownloadEvent::Progress { downloaded, .. } = event {
                    progress.push(downloaded);
                }
                DownloadControl::Continue
            })
            .unwrap();
        assert_eq!(downloader.transport.requested.borrow().as_slice(), &[0, 5]);
        assert_eq!(progress[0..2], [5, 0]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn cancelling_the_ignored_range_reset_keeps_zero_bytes_for_the_next_retry() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let transport = FakeTransport::new(bytes);
        *transport.fail_after.borrow_mut() = Some(5);
        let downloader = ModelDownloader::new(dir.path(), registry.clone(), transport);
        assert!(matches!(
            downloader.download(&spec, "fake://model", |_| DownloadControl::Continue),
            Err(DownloadFailure::Transport(_))
        ));

        *downloader.transport.ignore_range.borrow_mut() = true;
        let mut events = Vec::new();
        assert_eq!(
            downloader
                .download(&spec, "fake://model", |event| {
                    let cancel = matches!(event, DownloadEvent::Progress { downloaded: 0, .. });
                    events.push(event);
                    if cancel {
                        DownloadControl::Cancel
                    } else {
                        DownloadControl::Continue
                    }
                })
                .unwrap_err(),
            DownloadFailure::Cancelled
        );
        assert!(matches!(
            events.last(),
            Some(DownloadEvent::Cancelled { downloaded: 0, .. })
        ));
        let partials: Vec<_> = std::fs::read_dir(dir.path().join("voice/downloads"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "partial")
            })
            .collect();
        assert_eq!(partials.len(), 1);
        assert_eq!(std::fs::metadata(&partials[0]).unwrap().len(), 0);
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);

        *downloader.transport.ignore_range.borrow_mut() = false;
        let record = downloader
            .download(&spec, "fake://model", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(
            downloader.transport.requested.borrow().as_slice(),
            &[0, 5, 0]
        );
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn http_transport_rejects_non_https_model_source() {
        let transport = HttpTransport::new().unwrap();
        assert!(matches!(
            transport.open(
                "http://example.test/model.bin",
                0,
                &DownloadCancellation::new()
            ),
            Err(DownloadFailure::Protocol)
        ));
        assert!(matches!(
            transport.open("file:///tmp/model.bin", 0, &DownloadCancellation::new()),
            Err(DownloadFailure::Protocol)
        ));
    }

    #[test]
    fn a_new_trusted_digest_does_not_resume_an_older_models_partial_bytes() {
        let dir = TempDir::new().unwrap();
        let old = b"older-model-bytes";
        let newer = b"newer-model-bytes";
        let old_spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: old.len() as u64,
            blake3: blake3::hash(old).to_hex().to_string(),
        };
        let new_spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: newer.len() as u64,
            blake3: blake3::hash(newer).to_hex().to_string(),
        };
        let old_transport = FakeTransport::new(old);
        *old_transport.fail_after.borrow_mut() = Some(5);
        let first = ModelDownloader::new(dir.path(), ModelRegistry::new(dir.path()), old_transport);
        assert!(matches!(
            first.download(&old_spec, "fake://old", |_| DownloadControl::Continue),
            Err(DownloadFailure::Transport(_))
        ));
        let next = ModelDownloader::new(
            dir.path(),
            ModelRegistry::new(dir.path()),
            FakeTransport::new(newer),
        );
        let record = next
            .download(&new_spec, "fake://new", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(next.transport.requested.borrow().as_slice(), &[0]);
        assert_eq!(
            ModelRegistry::new(dir.path()).status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn corrupt_payload_reports_digest_failure_without_admission_then_valid_retry_recovers() {
        let dir = TempDir::new().unwrap();
        let trusted = b"trusted model bytes";
        let corrupt = b"altered model bytes";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: trusted.len() as u64,
            blake3: blake3::hash(trusted).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let bad = ModelDownloader::new(dir.path(), registry.clone(), FakeTransport::new(corrupt));
        let mut events = Vec::new();
        assert!(matches!(
            bad.download(&spec, "fake://bad", |event| {
                events.push(event);
                DownloadControl::Continue
            }),
            Err(DownloadFailure::Corrupt(Corruption::Digest))
        ));
        assert!(matches!(
            events.last(),
            Some(DownloadEvent::Failed {
                reason: DownloadFailure::Corrupt(Corruption::Digest)
            })
        ));
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);
        let good = ModelDownloader::new(dir.path(), registry.clone(), FakeTransport::new(trusted));
        let record = good
            .download(&spec, "fake://good", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(good.transport.requested.borrow().as_slice(), &[0]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn truncated_payload_reports_expected_and_actual_then_resumes_on_retry() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let transport = FakeTransport::new(bytes);
        *transport.truncate_at.borrow_mut() = Some(4);
        let downloader = ModelDownloader::new(dir.path(), registry.clone(), transport);
        let mut events = Vec::new();
        assert!(
            matches!(downloader.download(&spec, "fake://model", |event| { events.push(event); DownloadControl::Continue }), Err(DownloadFailure::Truncated { expected, actual: 4 }) if expected == bytes.len() as u64)
        );
        assert!(matches!(
            events.last(),
            Some(DownloadEvent::Failed {
                reason: DownloadFailure::Truncated { actual: 4, .. }
            })
        ));
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);
        let record = downloader
            .download(&spec, "fake://model", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(downloader.transport.requested.borrow().as_slice(), &[0, 4]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn cancellation_preserves_a_partial_for_resume_and_emits_no_failure() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let transport = FakeTransport::new(bytes);
        *transport.chunk_size.borrow_mut() = Some(5);
        let downloader = ModelDownloader::new(dir.path(), registry.clone(), transport);
        let mut events = Vec::new();
        assert_eq!(downloader.download(&spec, "fake://model", |event| {
            let cancel = matches!(event, DownloadEvent::Progress { downloaded, .. } if downloaded > 0);
            events.push(event);
            if cancel { DownloadControl::Cancel } else { DownloadControl::Continue }
        }).unwrap_err(), DownloadFailure::Cancelled);
        assert!(
            matches!(events.last(), Some(DownloadEvent::Cancelled { downloaded: 5, total }) if *total == bytes.len() as u64)
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, DownloadEvent::Failed { .. })));
        assert_eq!(registry.status("tiny-en").unwrap(), ModelState::Absent);
        let record = downloader
            .download(&spec, "fake://model", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(downloader.transport.requested.borrow().as_slice(), &[0, 5]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(record)
        );
    }

    #[test]
    fn damaged_admitted_model_is_replaced_by_verified_download() {
        let dir = TempDir::new().unwrap();
        let bytes = b"trusted local voice model";
        let spec = ModelSpec {
            id: "tiny-en".into(),
            byte_len: bytes.len() as u64,
            blake3: blake3::hash(bytes).to_hex().to_string(),
        };
        let registry = ModelRegistry::new(dir.path());
        let initial = ModelDownloader::new(dir.path(), registry.clone(), FakeTransport::new(bytes));
        let first = initial
            .download(&spec, "fake://model", |_| DownloadControl::Continue)
            .unwrap();
        std::fs::write(&first.path, b"damaged local bytes").unwrap();
        assert!(matches!(
            registry.status("tiny-en").unwrap(),
            ModelState::Corrupt { .. }
        ));
        let repair = ModelDownloader::new(dir.path(), registry.clone(), FakeTransport::new(bytes));
        let recovered = repair
            .download(&spec, "fake://model", |_| DownloadControl::Continue)
            .unwrap();
        assert_eq!(repair.transport.requested.borrow().as_slice(), &[0]);
        assert_eq!(
            registry.status("tiny-en").unwrap(),
            ModelState::Ready(recovered)
        );
    }

    #[test]
    fn content_range_parser_rejects_inconsistent_bounds() {
        assert_eq!(
            parse_content_range("bytes 5-9/10"),
            Some(ResponseRange::From {
                start: 5,
                total: 10
            })
        );
        assert_eq!(parse_content_range("bytes 5-10/10"), None);
        assert_eq!(parse_content_range("bytes 9-5/10"), None);
        assert_eq!(parse_content_range("bytes */10"), None);
    }
}
