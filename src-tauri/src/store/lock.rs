// ABOUTME: Per-project ownership registry file I/O (TD-20 rulings (2)/(3); TD §3.5 finding M7) —
// ABOUTME: an OS lock plus unlocked sidecars under per-user app-local data, never the project folder.

//! TD §3.5: "per-project lock file; opening an already-open project focuses the existing
//! instance's window. One MCP server, one sync worker, one JSONL appender per project — FR-AGENT-7
//! enforceable by construction." This module is the lock half of that sentence — `service::
//! SidecarStore`'s own doc comment already assumes it exists ("enforcing that lock is a different
//! unit's job").
//!
//! # Where the registry lives
//!
//! **Per-user, machine-local app data — never the project folder** (TD-20 ruling (3), which
//! relocated these files from `.emend/lock*` and amended TD-12's machine-local list down to
//! exactly `tab-session.json`). One directory per project,
//! `<app_local_data_dir>/instances/<project_key>/` ([`registry_dir`]), keyed by
//! `blake3(canonical root)` — the identical keying `store::transcript` already uses for
//! per-project machine-local state (P2a-17, D15), so two spellings of one directory (a symlink, a
//! relative respelling, a trailing separator) are one project and two genuinely distinct roots
//! never collide.
//!
//! The scope in which "one live instance" and "bring that window to the front" are meaningful is
//! exactly one user's desktop session on one machine. A lock *inside* the project folder is
//! visible to every user and machine sharing that folder (network share, OneDrive/Dropbox, a
//! second account), where a held lock either is unreliable or names an owner this process could
//! never raise a window for. Relocating also removes the write-into-the-user's-repo side effect
//! `acquire` used to perform on every open, leaving `.emend/` purely TD-4 portable data
//! (D1/FR-X-8 strengthened). Nothing migrated and nothing reads the old location: this module has
//! never had a production caller, so no shipped path ever wrote `.emend/lock*`.
//!
//! **Every operation is handed the directory it works in.** [`probe`], [`acquire`],
//! [`current_owner`], [`request_focus`] and [`FocusRequestWatcher`] take a registry directory and
//! write inside it and nowhere else, so the registry root is a plain injected parameter (TD-20
//! ruling (10)) rather than
//! an env var or a `cfg(test)` branch. [`registry_dir`] is the layout function that derives one
//! from an app-local-data dir — the same shape `store::transcript::transcript_file` and
//! `store::adoption::adoption_file` already have, and layout only: no ownership or routing policy
//! lives here, which is TD-20's "`store::lock` … gains no policy". `REGISTRY_DIR_NAME` names the
//! `instances/` §3.1 module's own namespace from here only until that module exists to own it.
//!
//! # Four pieces
//!
//! - **The lock itself** (`probe`/`acquire`) is an OS file lock (`fs4`, no libc) on the registry
//!   directory's `lock`, not a PID check. That is a deliberate simplification: a PID-liveness
//!   check has to reckon with PID reuse and cross-platform "is this process alive" APIs, and it is
//!   redundant here — the OS already tears the lock down the instant the owning file handle
//!   closes, crash included (`fs4`'s own `lock_cleanup` test asserts exactly this). So "detect a
//!   stale lock and reclaim it" needs no separate detection step at all: the very next `acquire`
//!   just succeeds, because the OS already released it. The lock file itself is content-free and
//!   never read or written after it is opened, because the two platforms disagree about what a
//!   held lock permits: Unix `flock` is advisory (I/O unaffected), but Windows `LockFileEx` is
//!   **mandatory and per-handle** — while held, no handle but the locking one, *not even
//!   another handle in this same process*, can read or write the file. Anything that must stay
//!   readable/writable therefore lives in separate, unlocked files:
//! - **The owner record** ([`LockOwner`], in the unlocked `owner.json`) names the holder's
//!   schema version, instance id, pid, executable identity, when it acquired, and **the canonical
//!   project root**.
//!   The root is what makes a `blake3`-keyed directory identifiable at all: without it a registry
//!   directory is an opaque hash that no support session or debugging pass could tie back to a
//!   project except by re-hashing every candidate root. Written by the acquirer (the lock makes it
//!   single-writer), removed on clean close, overwritten on reclaim after a crash. The **lock, not
//!   the record, is the ownership authority** — a reader that cannot read or parse it gets `None`,
//!   never an error.
//! - **The focus signal** (`request_focus`/`FocusRequestWatcher::watch`) is how a second
//!   instance asks the owning one to bring its window forward instead of opening its own copy
//!   of the project. It rides another unlocked file (`lock.focus-request`) that `notify` watches —
//!   the same native-OS-notification pattern `store::watch::SidecarWatcher` already uses, so no
//!   polling. This module never touches a window itself (§3.1 keeps window/app control in the
//!   Tauri app layer, `store/` is data-and-I/O only); it hands the owning side a `FocusRequest`
//!   stream and leaves calling `WebviewWindow::set_focus` to the app layer. It remains only for
//!   legacy callers while the routing tranche is assembled.
//! - **The answered rendezvous** stores versioned request and outcome JSON in `requests/` and
//!   `outcomes/`. Writes and native watchers live here; deadline, fulfillment, and sweep policy
//!   stays in `instances/`. Outcome publication is single-assignment (`create_new`), malformed
//!   records are never treated as valid, and a requester removes both records at its terminal
//!   disposition. This realizes TD-20 ruling (5); the old focus courtesy does not participate.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs4::{FileExt, TryLockError};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(test)]
use crate::store::atomic;

use crate::store::project_identity::{canonical_root, project_dir};

/// The app-local-data subdirectory every project's registry directory lives under (TD-20 ruling
/// (3)), named for the `instances/` §3.1 module that owns routing over it.
const REGISTRY_DIR_NAME: &str = "instances";

/// Bumped whenever `owner.json`'s shape changes. TD-20 ruling (6) makes that file a **cross-process**
/// record — one instance reads what another wrote to decide who to address — so the two sides can be
/// different builds, and a reader has to be able to tell which shape it is holding. Same TD-4
/// "every file carries `schema_version`" convention `store::transcript` and `store::tab_session`
/// already follow. Rendezvous readers reject an unrecognized version as corrupt rather than acting
/// on a record whose meaning this build does not know.
pub const OWNER_SCHEMA_VERSION: u32 = 1;
pub const LOCK_FILE_NAME: &str = "lock";
pub const OWNER_FILE_NAME: &str = "owner.json";
pub const FOCUS_REQUEST_FILE_NAME: &str = "lock.focus-request";
pub const REQUESTS_DIR_NAME: &str = "requests";
pub const OUTCOMES_DIR_NAME: &str = "outcomes";
pub const REQUEST_STAGING_DIR_NAME: &str = ".request-staging";
pub const REQUEST_STAGING_LOCK_FILE_NAME: &str = "publication.lock";
pub const RENDEZVOUS_SCHEMA_VERSION: u32 = 1;

/// Cross-process request record. Its absolute deadline is carried on disk so every prospective
/// owner judges expiry against the user's original ask rather than against its own queue turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RendezvousRequest {
    pub schema_version: u32,
    pub request_id: Uuid,
    pub requester_instance_id: String,
    pub asked_at_ms: i64,
    pub deadline_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendezvousSuccess {
    Focused,
    Opened,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RendezvousOutcome {
    pub schema_version: u32,
    pub request_id: Uuid,
    pub completed_at_ms: i64,
    pub deadline_at_ms: i64,
    pub outcome: RendezvousSuccess,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RendezvousRead<T> {
    Missing,
    Valid(T),
    Corrupt,
}

/// `<app_local_data_dir>/instances/<blake3(canonical root)>/` — the one directory every artifact
/// for `root`'s ownership lives in (TD-20 ruling (3)). Pure: resolving a path creates nothing.
pub fn registry_dir(app_local_data_dir: &Path, root: &Path) -> PathBuf {
    project_dir(app_local_data_dir, REGISTRY_DIR_NAME, root)
}

/// The parent directory whose children are opaque project keys. Directory reclamation must read
/// each child's `owner.json` to recover the canonical root; the hash is intentionally not inverted.
pub fn registries_root(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join(REGISTRY_DIR_NAME)
}

/// Who holds a project's ownership — written to the unlocked `owner.json` alongside (never inside)
/// the locked file, because a held Windows lock denies every other handle access to the lock file
/// itself (see module docs).
///
/// Diagnostic *and* addressing: TD-20 ruling (6) makes this the activation address a requester
/// raises the owner through, which is why it carries `pid` **and** `executable` — a recorded pid
/// alone can be reused by an unrelated process, so an addressee is trusted only when the live
/// process at that pid is this app. Nothing here decides ownership; the OS lock alone does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockOwner {
    pub schema_version: u32,
    pub pid: u32,
    pub instance_id: String,
    /// The holder's executable identity (`current_exe`), so a reused pid cannot be mistaken for
    /// this app (TD-20 ruling (6)). `None` when the platform refuses to report it — read as
    /// "cannot be verified", never as a match.
    pub executable: Option<PathBuf>,
    /// Unix seconds.
    pub acquired_at: i64,
    /// The canonical project root this registry directory belongs to — what makes a hashed
    /// directory identifiable without re-hashing every candidate root.
    pub project_root: PathBuf,
}

impl LockOwner {
    /// The current process holding `project_root`, identified by `instance_id` (a caller-chosen
    /// label — e.g. a window label or a minted UUID — since a PID alone is not stable/meaningful
    /// across platforms).
    ///
    /// **This constructor** records `project_root` in the same canonical spelling [`registry_dir`]
    /// keys by, so an owner record it builds cannot name a different project than the directory it
    /// is written into. That is a guarantee of `new`, not of the type: the fields are public, so a
    /// hand-built `LockOwner` can disagree with its directory and [`acquire`] would write it. Once
    /// TD-20 ruling (6) makes `owner.json` an activation address, such a record raises the wrong
    /// instance — so build owner records here.
    pub fn new(instance_id: impl Into<String>, project_root: &Path) -> LockOwner {
        LockOwner {
            schema_version: OWNER_SCHEMA_VERSION,
            pid: std::process::id(),
            instance_id: instance_id.into(),
            executable: std::env::current_exe().ok(),
            acquired_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            project_root: canonical_root(project_root),
        }
    }
}

/// The result of attempting to take ownership of a project.
pub enum LockOutcome {
    /// No other live instance held the project — this process now owns it and must not proceed to
    /// start the project's subsystems (sync worker, MCP server, sidecar appenders) until it has
    /// this.
    Acquired(ProjectLockGuard),
    /// Another live instance already holds the project. The caller must not start any subsystem
    /// for it. `acquire` signals that instance to bring its window forward, while `probe` only
    /// reports the ownership result; `owner`, if readable, names which instance.
    HeldByAnotherInstance { owner: Option<LockOwner> },
}

/// Holds a project's ownership for as long as it lives. Dropping it (including an unhandled panic
/// unwinding through it, or the whole process crashing) releases the OS lock immediately — there is
/// no separate release step to forget. Under TD-20 ruling (2) the guard is owned by
/// `agent::project::OpenProject` for the project session, so replace, close, and crash all release
/// ownership through the same drop that unbinds the MCP server and the D21 watchdog. A clean drop
/// also removes the unlocked runtime metadata files (`owner.json`, `lock.focus-request`); after a
/// crash they linger, but the next `acquire` overwrites them and nothing ever trusts them for
/// ownership.
pub struct ProjectLockGuard {
    // Kept alive only to hold the OS lock; never read/written again after `acquire` sets it up.
    _file: File,
    registry_dir: PathBuf,
}

impl ProjectLockGuard {
    /// The registry directory this guard holds ownership of — every artifact for this project,
    /// including the rendezvous files P2a-11d adds, lives here.
    pub fn registry_dir(&self) -> &Path {
        &self.registry_dir
    }
}

impl Drop for ProjectLockGuard {
    fn drop(&mut self) {
        // Best-effort housekeeping of the unlocked metadata files, done while the OS lock is
        // still held (`_file` closes — and releases it — only after this body). Failure is
        // acceptable: stale files are overwritten by the next `acquire`.
        let _ = fs::remove_file(owner_file_path(&self.registry_dir));
        let _ = fs::remove_file(focus_request_path(&self.registry_dir));
    }
}

fn lock_file_path(registry_dir: &Path) -> PathBuf {
    registry_dir.join(LOCK_FILE_NAME)
}

fn focus_request_path(registry_dir: &Path) -> PathBuf {
    registry_dir.join(FOCUS_REQUEST_FILE_NAME)
}

fn owner_file_path(registry_dir: &Path) -> PathBuf {
    registry_dir.join(OWNER_FILE_NAME)
}

pub fn requests_dir(registry_dir: &Path) -> PathBuf {
    registry_dir.join(REQUESTS_DIR_NAME)
}

pub fn outcomes_dir(registry_dir: &Path) -> PathBuf {
    registry_dir.join(OUTCOMES_DIR_NAME)
}

fn request_staging_dir(registry_dir: &Path) -> PathBuf {
    registry_dir.join(REQUEST_STAGING_DIR_NAME)
}

fn request_staging_lock_path(registry_dir: &Path) -> PathBuf {
    request_staging_dir(registry_dir).join(REQUEST_STAGING_LOCK_FILE_NAME)
}

fn request_path(registry_dir: &Path, request_id: Uuid) -> PathBuf {
    requests_dir(registry_dir).join(format!("{request_id}.json"))
}

fn outcome_path(registry_dir: &Path, request_id: Uuid) -> PathBuf {
    outcomes_dir(registry_dir).join(format!("{request_id}.json"))
}

pub fn ensure_rendezvous_dirs(registry_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(requests_dir(registry_dir))?;
    fs::create_dir_all(outcomes_dir(registry_dir))?;
    fs::create_dir_all(request_staging_dir(registry_dir))
}

pub fn write_rendezvous_request(
    registry_dir: &Path,
    request: &RendezvousRequest,
) -> io::Result<()> {
    prepare_rendezvous_request(registry_dir, request)?.arm()
}

/// A complete request that is durable but deliberately invisible to the owner watcher.
///
/// TD-20(6)'s macOS sequence needs an explicit happens-before edge: the requester must make the
/// exact bytes durable before it asks LaunchServices to activate the owner, yet the owner must not
/// see work it could perform before that entitlement exists. This object owns the existing staging
/// lane lock from preparation through [`Self::arm`] (or its cleanup on drop), so an acquirer sweep
/// cannot mistake a live publication for abandoned debris.
pub struct PreparedRendezvousRequest {
    staging_path: PathBuf,
    request_path: PathBuf,
    // Kept solely to retain the cross-process staging-lane lock. It must outlive the staged file.
    _staging_lock: File,
    armed: bool,
}

impl PreparedRendezvousRequest {
    /// Atomically makes this request observable by the owner. The file was synced before this
    /// rename, and the lock is still held until this method returns.
    pub fn arm(mut self) -> io::Result<()> {
        fs::rename(&self.staging_path, &self.request_path)?;
        self.armed = true;
        Ok(())
    }
}

impl Drop for PreparedRendezvousRequest {
    fn drop(&mut self) {
        if !self.armed {
            // A pre-arm failure must be invisible to an owner. The next acquirer can also sweep a
            // crash-left artifact after the OS releases `_staging_lock`; this is the ordinary
            // returned-error cleanup path.
            let _ = fs::remove_file(&self.staging_path);
        }
    }
}

/// Writes and syncs `request` under the persistent staging-lane lock without publishing it to
/// `requests/`. Call [`PreparedRendezvousRequest::arm`] only after the platform-specific step that
/// is permitted to run between durable intent and owner observation.
pub fn prepare_rendezvous_request(
    registry_dir: &Path,
    request: &RendezvousRequest,
) -> io::Result<PreparedRendezvousRequest> {
    ensure_rendezvous_dirs(registry_dir)?;
    let staging_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(request_staging_lock_path(registry_dir))?;
    match FileExt::try_lock(&staging_lock) {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "another rendezvous request is being prepared",
            ));
        }
        Err(TryLockError::Error(error)) => return Err(error),
    }

    let staging_path =
        request_staging_dir(registry_dir).join(format!("{}.json.tmp", request.request_id));
    let request_path = request_path(registry_dir, request.request_id);
    let json = serde_json::to_vec_pretty(request)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut staged = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging_path)?;
    if let Err(error) = staged.write_all(&json).and_then(|()| staged.sync_all()) {
        drop(staged);
        let _ = fs::remove_file(&staging_path);
        return Err(error);
    }
    drop(staged);

    Ok(PreparedRendezvousRequest {
        staging_path,
        request_path,
        _staging_lock: staging_lock,
        armed: false,
    })
}

#[cfg(test)]
pub(crate) fn write_rendezvous_request_with_stage_hook(
    registry_dir: &Path,
    request: &RendezvousRequest,
    after_stage: impl FnOnce(&Path),
) -> io::Result<()> {
    ensure_rendezvous_dirs(registry_dir)?;
    let json = serde_json::to_vec_pretty(request)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    atomic::write_from_staging_with_hook(
        &request_path(registry_dir, request.request_id),
        &request_staging_dir(registry_dir).join(format!("{}.json.tmp", request.request_id)),
        &request_staging_lock_path(registry_dir),
        &json,
        after_stage,
    )
}

fn read_json_record<T: for<'de> Deserialize<'de>>(path: &Path) -> RendezvousRead<T> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(record) => RendezvousRead::Valid(record),
            Err(_) => RendezvousRead::Corrupt,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => RendezvousRead::Missing,
        Err(_) => RendezvousRead::Corrupt,
    }
}

pub fn read_rendezvous_request(
    registry_dir: &Path,
    request_id: Uuid,
) -> RendezvousRead<RendezvousRequest> {
    match read_json_record::<RendezvousRequest>(&request_path(registry_dir, request_id)) {
        RendezvousRead::Valid(record)
            if record.schema_version == RENDEZVOUS_SCHEMA_VERSION
                && record.request_id == request_id
                && record.deadline_at_ms >= record.asked_at_ms =>
        {
            RendezvousRead::Valid(record)
        }
        RendezvousRead::Valid(_) | RendezvousRead::Corrupt => RendezvousRead::Corrupt,
        RendezvousRead::Missing => RendezvousRead::Missing,
    }
}

pub fn read_rendezvous_outcome(
    registry_dir: &Path,
    request_id: Uuid,
) -> RendezvousRead<RendezvousOutcome> {
    match read_json_record::<RendezvousOutcome>(&outcome_path(registry_dir, request_id)) {
        RendezvousRead::Valid(record)
            if record.schema_version == RENDEZVOUS_SCHEMA_VERSION
                && record.request_id == request_id =>
        {
            RendezvousRead::Valid(record)
        }
        RendezvousRead::Valid(_) | RendezvousRead::Corrupt => RendezvousRead::Corrupt,
        RendezvousRead::Missing => RendezvousRead::Missing,
    }
}

/// Publishes the one owner-reported answer. `create_new` is the cross-process single-assignment
/// primitive: a second answer cannot replace the first. Readers treat the brief create/write
/// interval as corrupt and keep waiting for another native event, never as a valid outcome.
pub fn write_rendezvous_outcome_once(
    registry_dir: &Path,
    outcome: &RendezvousOutcome,
) -> io::Result<bool> {
    ensure_rendezvous_dirs(registry_dir)?;
    let path = outcome_path(registry_dir, outcome.request_id);
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error),
    };
    let json = serde_json::to_vec_pretty(outcome)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if let Err(error) = file.write_all(&json).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(true)
}

pub fn remove_rendezvous_request(registry_dir: &Path, request_id: Uuid) {
    let _ = fs::remove_file(request_path(registry_dir, request_id));
}

pub fn remove_rendezvous_outcome(registry_dir: &Path, request_id: Uuid) {
    let _ = fs::remove_file(outcome_path(registry_dir, request_id));
}

pub fn rendezvous_request_files(registry_dir: &Path) -> io::Result<Vec<PathBuf>> {
    ensure_rendezvous_dirs(registry_dir)?;
    fs::read_dir(requests_dir(registry_dir))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect()
}

pub fn rendezvous_outcome_files(registry_dir: &Path) -> io::Result<Vec<PathBuf>> {
    ensure_rendezvous_dirs(registry_dir)?;
    fs::read_dir(outcomes_dir(registry_dir))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect()
}

pub fn rendezvous_request_staging_files(registry_dir: &Path) -> io::Result<Vec<PathBuf>> {
    ensure_rendezvous_dirs(registry_dir)?;
    fs::read_dir(request_staging_dir(registry_dir))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect()
}

/// Tries to claim the staging lane without waiting. Publishers acquire this persistent lock before
/// making a staging file visible, so `None` reliably means cleanup raced a live publisher. A crash
/// releases the OS lock while leaving the sentinel for the next acquisition to reuse.
pub fn try_lock_rendezvous_request_staging(registry_dir: &Path) -> io::Result<Option<File>> {
    ensure_rendezvous_dirs(registry_dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(request_staging_lock_path(registry_dir))?;
    match FileExt::try_lock(&file) {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

pub fn remove_rendezvous_artifact(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        // Both operations act on the link itself. Windows distinguishes file and directory links;
        // trying both avoids resolving the target merely to choose the deletion primitive.
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(path);
    } else if metadata.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// Native notification receiver for one rendezvous lane. Callers always scan the lane before and
/// after waiting, so coalesced events and a write racing watcher startup cannot lose a request.
pub struct RendezvousWatcher {
    _watcher: RecommendedWatcher,
    changes: Receiver<notify::Result<notify::Event>>,
}

impl RendezvousWatcher {
    fn watch_dir(path: &Path) -> io::Result<RendezvousWatcher> {
        fs::create_dir_all(path)?;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).map_err(io::Error::other)?;
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        Ok(RendezvousWatcher {
            _watcher: watcher,
            changes: rx,
        })
    }

    pub fn watch_requests(registry_dir: &Path) -> io::Result<RendezvousWatcher> {
        ensure_rendezvous_dirs(registry_dir)?;
        Self::watch_dir(&requests_dir(registry_dir))
    }

    pub fn watch_outcomes(registry_dir: &Path) -> io::Result<RendezvousWatcher> {
        ensure_rendezvous_dirs(registry_dir)?;
        Self::watch_dir(&outcomes_dir(registry_dir))
    }

    pub fn recv_timeout(&self, timeout: Duration) -> io::Result<bool> {
        match self.changes.recv_timeout(timeout) {
            Ok(Ok(event)) => Ok(!matches!(event.kind, EventKind::Access(_))),
            Ok(Err(error)) => Err(io::Error::other(error)),
            Err(RecvTimeoutError::Timeout) => Ok(false),
            Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "rendezvous notification stream disconnected",
            )),
        }
    }
}

/// Attempts to take ownership of the project `registry_dir` keys (TD §3.5, TD-20 ruling (3)). On
/// success the caller now exclusively owns the project and may start its subsystems; on
/// `HeldByAnotherInstance` the caller must not start anything for it. This ownership-only probe
/// never emits the legacy focus signal; routing decides whether and when to contact the owner.
///
/// Creates `registry_dir` if missing and writes **only** inside it: no path under the project root
/// is created, read, or modified by taking ownership.
pub fn probe(registry_dir: &Path, owner: &LockOwner) -> io::Result<LockOutcome> {
    fs::create_dir_all(registry_dir)?;
    let path = lock_file_path(registry_dir);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;

    match FileExt::try_lock(&file) {
        Ok(()) => {
            write_owner(registry_dir, owner)?;
            Ok(LockOutcome::Acquired(ProjectLockGuard {
                _file: file,
                registry_dir: registry_dir.to_path_buf(),
            }))
        }
        Err(TryLockError::WouldBlock) => {
            let existing_owner = current_owner(registry_dir);
            Ok(LockOutcome::HeldByAnotherInstance {
                owner: existing_owner,
            })
        }
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// Acquires ownership with the legacy best-effort focus courtesy retained for existing callers.
/// New TD-20 routing first calls [`probe`]; its answered rendezvous determines when to raise the
/// owner, so probing alone must not write `lock.focus-request`.
pub fn acquire(registry_dir: &Path, owner: &LockOwner) -> io::Result<LockOutcome> {
    let outcome = probe(registry_dir, owner)?;
    if matches!(&outcome, LockOutcome::HeldByAnotherInstance { .. }) {
        // Best-effort: "held by another instance" is a definitive answer we already have;
        // failing to write the courtesy focus signal must not turn it into an error. (No
        // logging facility exists backend-side yet — see tech-design §3.6 "Logging".)
        let _ = request_focus(registry_dir);
    }
    Ok(outcome)
}

fn write_owner(registry_dir: &Path, owner: &LockOwner) -> io::Result<()> {
    let json =
        serde_json::to_vec(owner).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    // The sidecar is unlocked, but only the holder of the OS lock ever writes it — the lock
    // makes it single-writer, so a plain whole-file write (not `store::atomic`'s
    // write-then-rename) is enough. A reader racing the write gets `None` (best-effort by
    // contract), never a torn decision.
    fs::write(owner_file_path(registry_dir), json)
}

/// Best-effort: who currently holds the project `registry_dir` keys, without attempting to acquire
/// it (e.g. for a caller that wants to show "already open in instance X" before the user even
/// tries to open it). `None` covers every reason there's no answer — nothing holds the lock, or the
/// record isn't readable/parseable right now — never an error. After a crash the record can name an
/// owner that no longer exists (cleanup never ran); that is why the OS lock, never this record, is
/// the ownership authority.
pub fn current_owner(registry_dir: &Path) -> Option<LockOwner> {
    parse_owner(&fs::read(owner_file_path(registry_dir)).ok()?)
}

fn parse_owner(content: &[u8]) -> Option<LockOwner> {
    serde_json::from_slice(content).ok()
}

/// Signals the instance holding this project to bring its window forward. Safe to call whether
/// or not anyone is currently watching (`FocusRequestWatcher::watch`) — an unwatched signal is simply
/// never observed, not an error. `acquire` already calls this on `HeldByAnotherInstance`; exposed
/// separately so a caller can re-request (e.g. the user clicks the same project again).
pub fn request_focus(registry_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(registry_dir)?;
    // Content just needs to change per request so each write is a distinct, observable event;
    // nothing reads it back, so precision beyond "unique-enough" doesn't matter.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    fs::write(
        focus_request_path(registry_dir),
        format!("{}.{:09}", now.as_secs(), now.subsec_nanos()),
    )
}

/// One observed focus request.
#[derive(Clone, Copy, Debug)]
pub struct FocusRequest {
    pub observed_at: SystemTime,
}

/// A live watch for focus requests against a project this process holds ownership of. Dropping
/// this stops the watch. Construct only from the instance that acquired the lock — a second
/// instance calls `request_focus`, not this.
pub struct FocusRequestWatcher {
    _watcher: RecommendedWatcher,
    requests: Receiver<FocusRequest>,
}

impl FocusRequestWatcher {
    /// Starts watching the project's registry directory (which must already exist — `acquire`
    /// creates it) for `request_focus` signals from other instances.
    pub fn watch(registry_dir: &Path) -> notify::Result<FocusRequestWatcher> {
        let (raw_tx, raw_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(raw_tx)?;
        watcher.watch(registry_dir, RecursiveMode::NonRecursive)?;

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for result in raw_rx {
                let Ok(event) = result else { continue };
                // Access is noise; Remove is `ProjectLockGuard`'s own cleanup deleting the
                // signal file — housekeeping, not somebody asking for focus.
                if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
                    continue;
                }
                let is_focus_request = event.paths.iter().any(|p| {
                    p.file_name().and_then(|n| n.to_str()) == Some(FOCUS_REQUEST_FILE_NAME)
                });
                if is_focus_request {
                    let request = FocusRequest {
                        observed_at: SystemTime::now(),
                    };
                    if tx.send(request).is_err() {
                        return; // no subscriber left — stop the background thread
                    }
                }
            }
        });

        Ok(FocusRequestWatcher {
            _watcher: watcher,
            requests: rx,
        })
    }

    /// Blocks until the next observed focus request, or `timeout` elapses.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<FocusRequest, RecvTimeoutError> {
        self.requests.recv_timeout(timeout)
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tempfile::TempDir;

    /// One project root plus its own isolated registry root — the fixture every test here needs,
    /// and the one place that knows how a registry directory is derived from the two. The
    /// `TempDir`s are held so the directories outlive the fixture's user.
    pub struct Fixture {
        _registry_root: TempDir,
        _project: TempDir,
        pub registry_root: PathBuf,
        pub root: PathBuf,
        /// This project's registry directory under `registry_root`.
        pub registry: PathBuf,
    }

    impl Fixture {
        pub fn new() -> Fixture {
            let registry_root = TempDir::new().unwrap();
            let project = TempDir::new().unwrap();
            Fixture {
                registry: registry_dir(registry_root.path(), project.path()),
                registry_root: registry_root.path().to_path_buf(),
                root: project.path().to_path_buf(),
                _registry_root: registry_root,
                _project: project,
            }
        }

        /// An owner record naming `instance_id` as the holder of this fixture's project.
        pub fn owner(&self, instance_id: &str) -> LockOwner {
            LockOwner::new(instance_id, &self.root)
        }
    }

    /// Takes ownership of `registry_dir` for `root`, or panics — for a test whose *subject* is what
    /// happens afterwards, where "somebody else already held it" is a broken fixture rather than an
    /// outcome to assert.
    pub fn take(registry_dir: &Path, root: &Path, instance_id: &str) -> ProjectLockGuard {
        match acquire(registry_dir, &LockOwner::new(instance_id, root)) {
            Ok(LockOutcome::Acquired(guard)) => guard,
            Ok(LockOutcome::HeldByAnotherInstance { .. }) => {
                panic!("fixture: {} is already held", root.display())
            }
            Err(error) => panic!("fixture: could not take ownership of {root:?}: {error}"),
        }
    }
}

#[cfg(test)]
mod acquire_release_tests {
    use super::test_support::Fixture;
    use super::*;

    #[test]
    fn opening_a_project_no_one_else_holds_acquires_the_lock() {
        let project = Fixture::new();

        let outcome = acquire(&project.registry, &project.owner("instance-a")).unwrap();

        assert!(matches!(outcome, LockOutcome::Acquired(_)));
    }

    #[test]
    fn acquiring_publishes_who_holds_the_project() {
        let project = Fixture::new();
        let owner = project.owner("instance-a");

        let outcome = acquire(&project.registry, &owner).unwrap();
        assert!(matches!(outcome, LockOutcome::Acquired(_)));

        assert_eq!(current_owner(&project.registry), Some(owner));
    }

    #[test]
    fn owner_metadata_lives_in_an_unlocked_sidecar_not_the_locked_file() {
        let project = Fixture::new();
        let owner = project.owner("instance-a");

        let _guard = acquire(&project.registry, &owner).unwrap();

        // Windows takes the OS lock as a mandatory, per-handle, whole-file lock: while it is
        // held, *no* handle but the locking one — not even one in the same process — can read
        // or write the lock file. The owner record therefore has to live in a separate,
        // unlocked file or it is unwritable at acquire time and unreadable by everyone else.
        let sidecar = fs::read(owner_file_path(&project.registry)).unwrap();
        assert_eq!(parse_owner(&sidecar), Some(owner));
    }

    #[test]
    fn dropping_the_guard_removes_the_runtime_metadata_files() {
        let project = Fixture::new();

        {
            let _guard = test_support::take(&project.registry, &project.root, "instance-a");
            request_focus(&project.registry).unwrap();
            assert!(owner_file_path(&project.registry).exists());
            assert!(focus_request_path(&project.registry).exists());
            // guard drops here — a clean close
        }

        assert!(!owner_file_path(&project.registry).exists());
        assert!(!focus_request_path(&project.registry).exists());
    }

    #[test]
    fn dropping_the_guard_releases_the_lock_for_a_later_acquire() {
        let project = Fixture::new();

        drop(test_support::take(
            &project.registry,
            &project.root,
            "instance-a",
        ));

        let second = acquire(&project.registry, &project.owner("instance-a")).unwrap();
        assert!(matches!(second, LockOutcome::Acquired(_)));
    }

    #[test]
    fn distinct_projects_lock_independently() {
        let a = Fixture::new();
        let b = Fixture::new();

        let outcome_a = acquire(&a.registry, &a.owner("instance-a")).unwrap();
        let outcome_b = acquire(&b.registry, &b.owner("instance-a")).unwrap();

        assert!(matches!(outcome_a, LockOutcome::Acquired(_)));
        assert!(matches!(outcome_b, LockOutcome::Acquired(_)));
    }
}

/// TD-20 ruling (3) — the registry is per-user app-local data keyed by canonical root, and a
/// registry directory says which project it belongs to (card #1746 criteria 2, 3 and 5).
#[cfg(test)]
mod registry_location_tests {
    use super::test_support::Fixture;
    use super::*;
    use crate::store::project_identity::project_key_for_layout_tests as project_key;
    use crate::test_support::tree;
    use tempfile::TempDir;

    #[test]
    fn acquiring_ownership_writes_every_artifact_under_app_local_data_and_nothing_under_the_project_root(
    ) {
        let project = Fixture::new();
        // Committed TD-4 project data the user already has — taking ownership must leave the repo
        // byte-identical, including `.emend/.gitignore`, which `acquire` used to append to on
        // every single open (TD-12 amended, 2026-08-14).
        fs::create_dir_all(project.root.join(".emend")).unwrap();
        fs::write(project.root.join(".emend/.gitignore"), "custom-entry\n").unwrap();
        let before = tree(&project.root);

        let _guard = test_support::take(&project.registry, &project.root, "instance-a");
        request_focus(&project.registry).unwrap();

        assert_eq!(
            tree(&project.root),
            before,
            "taking ownership created a path under the user's project root"
        );
        assert_eq!(
            fs::read_to_string(project.root.join(".emend/.gitignore")).unwrap(),
            "custom-entry\n"
        );
        // Every artifact is inside the one keyed directory...
        assert_eq!(
            tree(&project.registry),
            vec![
                "lock".to_string(),
                "lock.focus-request".to_string(),
                "owner.json".to_string(),
            ]
        );
        // ...and the injected registry root holds nothing besides that directory's own path.
        let key = project_key(&project.root);
        assert_eq!(
            tree(&project.registry_root),
            vec![
                REGISTRY_DIR_NAME.to_string(),
                format!("{REGISTRY_DIR_NAME}/{key}"),
                format!("{REGISTRY_DIR_NAME}/{key}/lock"),
                format!("{REGISTRY_DIR_NAME}/{key}/lock.focus-request"),
                format!("{REGISTRY_DIR_NAME}/{key}/owner.json"),
            ]
        );
    }

    #[test]
    fn a_registry_directory_names_the_project_it_belongs_to_without_rehashing_candidate_roots() {
        let project = Fixture::new();
        let _guard = test_support::take(&project.registry, &project.root, "instance-a");

        // A reader holding only the opaque `blake3` directory — no candidate list, no project
        // path — recovers which project it is, and who to address, from the record alone.
        let recovered = current_owner(&project.registry).expect("owner.json is readable");

        assert_eq!(recovered.project_root, canonical_root(&project.root));
        assert!(recovered.project_root.is_absolute());
        assert_eq!(recovered.schema_version, OWNER_SCHEMA_VERSION);
        assert_eq!(recovered.instance_id, "instance-a");
        assert_eq!(recovered.pid, std::process::id());
        assert_eq!(recovered.executable, std::env::current_exe().ok());
        assert!(recovered.acquired_at > 0);
    }

    /// The **case** axis of project identity, gated to both shipped platforms rather than Windows
    /// alone: macOS ships APFS/HFS+ case-insensitive by default, so one directory is genuinely
    /// reachable under two casings there too. `agent::project`'s own
    /// `a_case_differing_path_to_the_same_directory_is_the_same_project` uses this same gate for
    /// this same reason; on a case-sensitive filesystem the two spellings are different
    /// directories and the assertion would be false, which is what the gate excludes.
    #[test]
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn a_case_differing_path_to_one_project_root_shares_its_registry_directory() {
        let project = Fixture::new();
        // Uppercasing the last component only: the temp dir's own name, which this process created
        // and can safely re-spell.
        let parent = project.root.parent().expect("a temp dir has a parent");
        let name = project
            .root
            .file_name()
            .expect("a temp dir has a name")
            .to_string_lossy()
            .to_uppercase();
        let respelled = parent.join(name);
        assert_ne!(
            respelled, project.root,
            "the re-spelling must differ as raw bytes"
        );

        assert_eq!(
            registry_dir(&project.registry_root, &respelled),
            project.registry,
            "a case-differing path to a project root must key to the same registry directory"
        );

        let _guard = test_support::take(&project.registry, &project.root, "instance-a");
        let second = acquire(
            &registry_dir(&project.registry_root, &respelled),
            &LockOwner::new("instance-b", &respelled),
        )
        .unwrap();

        assert!(matches!(second, LockOutcome::HeldByAnotherInstance { .. }));
    }

    /// A directory link naming `target` at `link`. Windows gets a **junction**, not `mklink /D`:
    /// a directory *symlink* needs Developer Mode or elevation, a junction needs neither, and
    /// `canonicalize` resolves both. (PR #2233 review: the earlier claim that this axis was
    /// untestable on Windows was wrong, and only the junction form was ever the obstacle.)
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) {
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd.exe is available on Windows");
        assert!(
            created.status.success(),
            "could not create a junction: {}{}",
            String::from_utf8_lossy(&created.stdout),
            String::from_utf8_lossy(&created.stderr)
        );
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("could not create a directory symlink");
    }

    /// The **link** axis of project identity: one directory reachable under its own path and under
    /// a link to it is one project, because `registry_dir` keys by the canonicalized root. Together
    /// with the case and respelling tests this closes criterion 5's identity axis on both shipped
    /// platforms.
    #[test]
    #[cfg(any(windows, unix))]
    fn a_linked_path_to_one_project_root_shares_its_registry_directory() {
        let project = Fixture::new();
        let elsewhere = TempDir::new().unwrap();
        let link = elsewhere.path().join("linked-project");
        link_dir(&project.root, &link);
        assert_ne!(link, project.root, "the link must differ as raw bytes");

        assert_eq!(
            registry_dir(&project.registry_root, &link),
            project.registry,
            "a link to a project root must key to the same registry directory as the root itself"
        );

        // ...so opening the project through the link finds it held rather than taking a second,
        // independent ownership of the very same directory.
        let _guard = test_support::take(&project.registry, &project.root, "instance-a");
        let second = acquire(
            &registry_dir(&project.registry_root, &link),
            &LockOwner::new("instance-b", &link),
        )
        .unwrap();

        assert!(matches!(second, LockOutcome::HeldByAnotherInstance { .. }));
    }

    #[test]
    fn two_spellings_of_one_project_root_share_one_registry_directory() {
        let project = Fixture::new();
        // A `.`-relative respelling and a trailing separator both name the same directory.
        let respelled = project.root.join(".");
        let with_separator = PathBuf::from(format!("{}/", project.root.display()));

        assert_eq!(
            registry_dir(&project.registry_root, &respelled),
            project.registry
        );
        assert_eq!(
            registry_dir(&project.registry_root, &with_separator),
            project.registry
        );

        // ...so a respelling finds the project held rather than taking a second, independent
        // ownership of the very same directory.
        let _guard = test_support::take(&project.registry, &project.root, "instance-a");
        let second = acquire(
            &registry_dir(&project.registry_root, &respelled),
            &LockOwner::new("instance-b", &respelled),
        )
        .unwrap();

        assert!(matches!(second, LockOutcome::HeldByAnotherInstance { .. }));
    }

    #[test]
    fn genuinely_distinct_project_roots_never_share_a_registry_directory() {
        // One registry root, two projects — the collision this rules out is between *keys*, so
        // both must be derived under the same root for the comparison to mean anything.
        let registry_root = TempDir::new().unwrap();
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        let a_dir = registry_dir(registry_root.path(), a.path());
        let b_dir = registry_dir(registry_root.path(), b.path());

        assert_ne!(a_dir, b_dir);

        // Holding one must not report the other held.
        let _held = test_support::take(&a_dir, a.path(), "instance-a");
        let other = acquire(&b_dir, &LockOwner::new("instance-b", b.path())).unwrap();

        assert!(matches!(other, LockOutcome::Acquired(_)));
    }
}

#[cfg(test)]
mod second_instance_tests {
    use super::test_support::Fixture;
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_second_instance_opening_the_same_project_does_not_acquire_the_lock() {
        let project = Fixture::new();
        let _first = test_support::take(&project.registry, &project.root, "instance-a");

        let outcome = acquire(&project.registry, &project.owner("instance-b")).unwrap();

        assert!(matches!(outcome, LockOutcome::HeldByAnotherInstance { .. }));
    }

    #[test]
    fn the_second_instance_learns_who_holds_the_project() {
        let project = Fixture::new();
        let first_owner = project.owner("instance-a");
        let _first = acquire(&project.registry, &first_owner).unwrap();

        let outcome = acquire(&project.registry, &project.owner("instance-b")).unwrap();

        let LockOutcome::HeldByAnotherInstance { owner } = outcome else {
            panic!("expected HeldByAnotherInstance");
        };
        assert_eq!(owner, Some(first_owner));
    }

    #[test]
    fn a_second_instance_opening_the_same_project_focuses_the_first_instances_window() {
        let project = Fixture::new();
        let _first = test_support::take(&project.registry, &project.root, "instance-a");

        // The owning instance is watching for focus requests, as it would be immediately after
        // acquiring the lock.
        let watcher = FocusRequestWatcher::watch(&project.registry).unwrap();

        // A second instance tries to open the same project — it must not start its own
        // subsystems (asserted above via HeldByAnotherInstance) and instead brings the first
        // instance's window to front.
        let outcome = acquire(&project.registry, &project.owner("instance-b")).unwrap();
        assert!(matches!(outcome, LockOutcome::HeldByAnotherInstance { .. }));

        watcher
            .recv_timeout(Duration::from_secs(5))
            .expect("expected the owning instance to observe a focus request");
    }

    #[test]
    fn request_focus_can_be_called_directly_without_going_through_acquire() {
        let project = Fixture::new();
        fs::create_dir_all(&project.registry).unwrap();
        let watcher = FocusRequestWatcher::watch(&project.registry).unwrap();

        request_focus(&project.registry).unwrap();

        watcher
            .recv_timeout(Duration::from_secs(5))
            .expect("expected the direct request_focus call to be observed");
    }

    #[test]
    fn a_failed_focus_signal_still_reports_the_project_as_held() {
        let project = Fixture::new();
        let first_owner = project.owner("instance-a");
        let _first = acquire(&project.registry, &first_owner).unwrap();

        // Sabotage the signal path: a directory where the signal file goes makes every
        // `request_focus` write fail.
        fs::create_dir_all(focus_request_path(&project.registry)).unwrap();

        // "Held by another instance" is a definitive answer the second instance already has;
        // a failed courtesy signal must not turn it into an error.
        let outcome = acquire(&project.registry, &project.owner("instance-b")).unwrap();
        let LockOutcome::HeldByAnotherInstance { owner } = outcome else {
            panic!("expected HeldByAnotherInstance despite the failed focus signal");
        };
        assert_eq!(owner, Some(first_owner));
    }

    #[test]
    fn a_clean_close_does_not_fire_a_focus_request() {
        let project = Fixture::new();
        let guard = test_support::take(&project.registry, &project.root, "instance-a");
        let watcher = FocusRequestWatcher::watch(&project.registry).unwrap();

        // The guard's cleanup removes `owner.json` among others — file *removals* are
        // housekeeping, not somebody asking for focus, and must not wake the watcher.
        drop(guard);

        assert!(matches!(
            watcher.recv_timeout(Duration::from_millis(500)),
            Err(RecvTimeoutError::Timeout)
        ));
    }
}

#[cfg(test)]
mod stale_lock_tests {
    use super::test_support::Fixture;
    use super::*;

    #[test]
    fn a_lock_left_behind_by_a_crashed_instance_is_reclaimed_not_permanently_blocking() {
        let project = Fixture::new();

        // Construct the exact disk state a crash leaves behind: the OS itself released the
        // advisory lock when the process died, but nothing ran the guard's cleanup — so the
        // lock file and the dead instance's stale owner record are still on disk.
        fs::create_dir_all(&project.registry).unwrap();
        fs::write(lock_file_path(&project.registry), b"").unwrap();
        fs::write(
            owner_file_path(&project.registry),
            serde_json::to_vec(&project.owner("instance-crashed")).unwrap(),
        )
        .unwrap();

        // A fresh open reclaims the project rather than reporting it held...
        let recovered_owner = project.owner("instance-recovered");
        let outcome = acquire(&project.registry, &recovered_owner).unwrap();
        assert!(matches!(outcome, LockOutcome::Acquired(_)));

        // ...and the stale record is overwritten, never trusted.
        assert_eq!(current_owner(&project.registry), Some(recovered_owner));
    }
}
