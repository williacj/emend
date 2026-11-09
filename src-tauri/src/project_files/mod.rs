// ABOUTME: TD-18's backend authority for project-tree scans, native identity reconciliation, and
// ABOUTME: atomic history rekey and live-path rekey before immutable snapshot publication.

//! J2's rail is not a literal filesystem browser. This service enumerates the user-authored paths
//! TD-18 permits, publishes only completed immutable snapshots, and retains the last completed
//! generation whenever a later refresh cannot be trusted. It deliberately does not apply
//! `.gitignore`: a user-authored file remains project context even when Git does not track it.
//!
//! [`ProjectFiles`] serializes the scanner, reconciliation, rekey, and generation commit under one
//! mutex. The same [`refresh`](ProjectFiles::refresh) operation is therefore safe for first load,
//! explicit `[Refresh]`, retry, and the later native-event fanout without competing transitions.

mod automatic;
mod recreate;
#[cfg(windows)]
mod windows_recreate;

pub use automatic::{
    AutomaticRefresh, NativeEventSink, ProjectFilesObserver, ProjectFilesRefreshNotice,
    QuietWindowScheduler, RefreshScheduler,
};
pub use recreate::{
    RecreateAdapter, RecreateAdapterError, RecreateCapability, RecreateCapabilityStatus,
    RecreateOutcome, RecreatePublishStatus, RecreateTransaction, UnavailableRecreateAdapter,
};
#[cfg(windows)]
pub use windows_recreate::WindowsRecreateAdapter;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use uuid::Uuid;

use crate::store::service::{SidecarError, SidecarStore};

const HIDDEN_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".emend",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".cache",
    "__pycache__",
];

const HIDDEN_GIT_CONTROL_FILES: &[&str] = &[".gitignore", ".gitattributes", ".gitmodules"];

/// The filesystem shape of one visible row. Only Markdown files become actionable in the future
/// rail; links, unknown entries, and other files remain useful non-actionable project context.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
    Unknown,
}

/// Stable object identity supplied by a shipped native filesystem adapter. Its representation is
/// deliberately private: reconciliation may compare or retain it, but no caller may infer a move
/// from any of its parts. Tests inject arbitrary opaque pairs through [`opaque`](Self::opaque).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PlatformFileId {
    scope: u128,
    object: u128,
}

impl PlatformFileId {
    pub fn opaque(scope: u128, object: u128) -> Self {
        Self { scope, object }
    }
}

/// Rename classifications preserved from `notify` without requiring a paired shape that macOS
/// FSEvents and Windows ReadDirectoryChangesW do not provide (TD-18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRenameMode {
    Any,
    From,
    To,
    Both,
}

/// A normalized native event. #928 owns production fanout/coalescing; this pure evidence shape is
/// the boundary that fanout feeds without coupling reconciliation to a `notify` backend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedEventKind {
    Rename(NativeRenameMode),
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NormalizedEvent {
    pub kind: NormalizedEventKind,
    pub paths: Vec<String>,
    /// Optional backend correlation metadata is retained without being required: shipped macOS
    /// and Windows rename events provide no matching tracker (TD-18).
    pub tracker: Option<usize>,
}

/// Whether a normalized native event path can name a user-visible project row (TD-18 visibility).
///
/// A native event carries no entry kind — the path it names may already be gone — so a component is
/// admitted only when it is visible as *both* a directory and a file. A hidden tooling directory or
/// Git control file anywhere in the path therefore means the event cannot change what a snapshot
/// shows, and coalescing it into a refresh would only churn: `.emend/` alone receives a sidecar
/// write for every tracked change Emend itself lands.
///
/// The accepted cost of deciding without a kind: a *file* named exactly like a hidden directory
/// (`build`, `dist`, `target`, …) is a visible row the scanner lists, but an event naming it
/// schedules nothing, so its create/rename/delete waits for the next refresh from another cause or
/// from `[Refresh]`. Both alternatives are worse — admitting a component visible as *either* kind
/// re-admits every `.emend/` sidecar write, and a kind-aware rule re-admits `node_modules/`-scale
/// churn — so the miss is preferred to a feedback loop.
pub fn is_event_path_visible(relative: &str) -> bool {
    !relative.is_empty()
        && relative.split('/').all(|component| {
            is_user_visible(component, EntryKind::Directory)
                && is_user_visible(component, EntryKind::File)
        })
}

/// One pure visibility predicate for every scan (TD-18). Directory/tool names and Git control
/// files are ASCII conventions, so ASCII-insensitive comparison is the exact cross-platform rule;
/// other dot paths are not blanket-hidden.
pub fn is_user_visible(name: &str, kind: EntryKind) -> bool {
    if matches!(kind, EntryKind::Directory | EntryKind::Symlink)
        && HIDDEN_DIRECTORY_NAMES
            .iter()
            .any(|hidden| name.eq_ignore_ascii_case(hidden))
    {
        return false;
    }

    !(matches!(kind, EntryKind::File | EntryKind::Symlink)
        && HIDDEN_GIT_CONTROL_FILES
            .iter()
            .any(|hidden| name.eq_ignore_ascii_case(hidden)))
}

/// Whether a document path can appear in TD-18's user-visible project snapshot. Ancestors are
/// directories and the final component is the document file; delegating each component to
/// [`is_user_visible`] keeps that predicate the sole owner of the hidden/tooling rule.
pub fn is_project_path_enumerable(relative: &str) -> bool {
    if relative.is_empty() {
        return false;
    }

    let mut components = relative.split('/').peekable();
    while let Some(component) = components.next() {
        if component.is_empty()
            || component == "."
            || component == ".."
            || !is_user_visible(
                component,
                if components.peek().is_some() {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
            )
        {
            return false;
        }
    }
    true
}

/// Why a row is present but cannot currently be trusted or activated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectFileWarningKind {
    Unreadable,
}

/// Typed per-path degradation in an otherwise completed snapshot (FR-X-5/J2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectFileWarning {
    pub kind: ProjectFileWarningKind,
    pub message: String,
}

/// One hierarchical user-visible project row. `path` is project-relative and slash-separated on
/// both shipped platforms so the IPC contract has one spelling; it is display/navigation state,
/// never an unchecked path passed back to the filesystem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectFileEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    /// Backend-only evidence. Native identity is never a user-facing path or durable identifier.
    #[serde(skip_serializing)]
    pub platform_file_id: Option<PlatformFileId>,
    pub children: Vec<ProjectFileEntry>,
    pub warning: Option<ProjectFileWarning>,
}

/// One confidently correlated path transition. Descendant moves are listed independently so live
/// open-document state can follow only identities proven at the same directory suffix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectFileMove {
    pub old_path: String,
    pub new_path: String,
    pub kind: EntryKind,
    #[serde(skip_serializing)]
    pub platform_file_id: PlatformFileId,
}

/// A completed immutable generation. A generation advances only after the scanner has produced a
/// trustworthy result; errors never create a misleading empty or partial generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectFilesSnapshot {
    pub generation: u64,
    pub entries: Vec<ProjectFileEntry>,
    pub moves: Vec<ProjectFileMove>,
}

/// Refresh-level failures. An unreadable child is not one of these: it stays a warning row inside
/// a completed snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum ProjectFilesError {
    ProjectUnavailable(String),
    UpdateFailed(String),
}

/// Pure TD-18 reconciliation over completed fixture entries and normalized event evidence. Stable
/// identity supplies association; an endpoint-naming rename event supplies only the fact that a
/// rename happened. Neither source is sufficient alone.
pub fn reconcile(
    previous: &[ProjectFileEntry],
    next: &[ProjectFileEntry],
    events: &[NormalizedEvent],
) -> Vec<ProjectFileMove> {
    let previous = flattened(previous);
    let next = flattened(next);
    let previous_by_path: HashMap<&str, &ProjectFileEntry> = previous
        .iter()
        .map(|entry| (entry.path.as_str(), *entry))
        .collect();
    let next_by_path: HashMap<&str, &ProjectFileEntry> = next
        .iter()
        .map(|entry| (entry.path.as_str(), *entry))
        .collect();
    let previous_identity_counts = identity_counts(&previous);
    let next_identity_counts = identity_counts(&next);
    let next_by_identity: HashMap<&PlatformFileId, &ProjectFileEntry> = next
        .iter()
        .filter_map(|entry| entry.platform_file_id.as_ref().map(|id| (id, *entry)))
        .collect();

    let mut moves = Vec::new();
    for old in &previous {
        if next_by_path.contains_key(old.path.as_str()) {
            continue;
        }
        let Some(id) = old.platform_file_id.as_ref() else {
            continue;
        };
        if previous_identity_counts.get(id) != Some(&1) || next_identity_counts.get(id) != Some(&1)
        {
            continue;
        }
        let Some(new) = next_by_identity.get(id).copied() else {
            continue;
        };
        if previous_by_path.contains_key(new.path.as_str()) || old.kind != new.kind {
            continue;
        }
        if rename_event_names(events, &old.path, &new.path) {
            moves.push(project_file_move(old, new, id));
        }
    }

    let directory_moves: Vec<ProjectFileMove> = moves
        .iter()
        .filter(|movement| movement.kind == EntryKind::Directory)
        .cloned()
        .collect();
    for directory in directory_moves {
        let old_prefix = format!("{}/", directory.old_path);
        let new_prefix = format!("{}/", directory.new_path);
        for old in previous
            .iter()
            .filter(|entry| entry.path.starts_with(&old_prefix))
        {
            let suffix = &old.path[old_prefix.len()..];
            let expected_new_path = format!("{new_prefix}{suffix}");
            let Some(new) = next_by_path.get(expected_new_path.as_str()).copied() else {
                continue;
            };
            let Some(id) = old.platform_file_id.as_ref() else {
                continue;
            };
            if new.platform_file_id.as_ref() != Some(id)
                || old.kind != new.kind
                || previous_identity_counts.get(id) != Some(&1)
                || next_identity_counts.get(id) != Some(&1)
                || previous_by_path.contains_key(new.path.as_str())
            {
                continue;
            }
            let movement = project_file_move(old, new, id);
            if !moves.iter().any(|existing| {
                existing.old_path == movement.old_path && existing.new_path == movement.new_path
            }) {
                moves.push(movement);
            }
        }
    }

    moves.sort_by(|left, right| {
        left.old_path
            .matches('/')
            .count()
            .cmp(&right.old_path.matches('/').count())
            .then_with(|| left.old_path.cmp(&right.old_path))
    });
    moves
}

fn flattened(entries: &[ProjectFileEntry]) -> Vec<&ProjectFileEntry> {
    fn visit<'a>(entry: &'a ProjectFileEntry, found: &mut Vec<&'a ProjectFileEntry>) {
        found.push(entry);
        for child in &entry.children {
            visit(child, found);
        }
    }

    let mut found = Vec::new();
    for entry in entries {
        visit(entry, &mut found);
    }
    found
}

fn identity_counts<'a>(entries: &'a [&'a ProjectFileEntry]) -> HashMap<&'a PlatformFileId, usize> {
    let mut counts = HashMap::new();
    for id in entries
        .iter()
        .filter_map(|entry| entry.platform_file_id.as_ref())
    {
        *counts.entry(id).or_insert(0) += 1;
    }
    counts
}

fn rename_event_names(events: &[NormalizedEvent], old_path: &str, new_path: &str) -> bool {
    events.iter().any(|event| {
        matches!(event.kind, NormalizedEventKind::Rename(_))
            && event
                .paths
                .iter()
                .any(|path| path == old_path || path == new_path)
    })
}

fn project_file_move(
    old: &ProjectFileEntry,
    new: &ProjectFileEntry,
    id: &PlatformFileId,
) -> ProjectFileMove {
    ProjectFileMove {
        old_path: old.path.clone(),
        new_path: new.path.clone(),
        kind: old.kind,
        platform_file_id: id.clone(),
    }
}

/// Injectable enumeration boundary from TD-18's test seam. Implementations must return a complete
/// hierarchy or a typed refresh error; [`ProjectFiles`] owns generation assignment and retention.
pub trait ProjectFilesScanner: Send + Sync {
    fn scan(&self, root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError>;
}

/// Production TD-18 filesystem enumerator. Public so the tracked performance benchmark can drive
/// the exact scanner used by [`ProjectFiles`], rather than a proxy walk that can silently drift.
#[derive(Default)]
pub struct FilesystemScanner;

impl ProjectFilesScanner for FilesystemScanner {
    fn scan(&self, root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
        let metadata = fs::symlink_metadata(root).map_err(|error| {
            ProjectFilesError::ProjectUnavailable(format!("{}: {error}", root.to_string_lossy()))
        })?;
        if !metadata.is_dir() {
            return Err(ProjectFilesError::ProjectUnavailable(format!(
                "{} is not a readable project directory",
                root.to_string_lossy()
            )));
        }

        scan_directory(root, "").map_err(|error| match error {
            DirectoryScanError::Unreadable(message) => {
                ProjectFilesError::ProjectUnavailable(message)
            }
            DirectoryScanError::Untrustworthy(message) => ProjectFilesError::UpdateFailed(message),
        })
    }
}

/// Durable path authority used at the candidate commit boundary. The production implementation is
/// the existing TD-4 [`SidecarStore`]; the trait exists only so a fail-then-retry can be pinned
/// without making the scanner or reconciler perform store I/O.
pub trait ProjectFilesStore: Send + Sync {
    fn doc_id_for_path(&self, path: &str) -> Result<Option<Uuid>, SidecarError>;
    fn rename_all(&self, moves: &[(Uuid, String)]) -> Result<(), SidecarError>;
}

impl ProjectFilesStore for SidecarStore {
    fn doc_id_for_path(&self, path: &str) -> Result<Option<Uuid>, SidecarError> {
        self.doc_id_for_path(path)
    }

    fn rename_all(&self, moves: &[(Uuid, String)]) -> Result<(), SidecarError> {
        self.rename_all(moves)
    }
}

/// Live `OpenProject` path state that must follow a proven move before its snapshot is published.
/// Rekeying is infallible bookkeeping; all fallible durable work happens first.
pub trait ProjectPathRekeyer: Send + Sync {
    fn rekey_path(&self, old_path: &str, new_path: &str);
}

struct NoopPathRekeyer;

impl ProjectPathRekeyer for NoopPathRekeyer {
    fn rekey_path(&self, _old_path: &str, _new_path: &str) {}
}

#[derive(Clone, Copy)]
enum TrackedDoc {
    Unresolved,
    Untracked,
    Tracked(Uuid),
}

#[derive(Clone)]
struct CandidateMove {
    movement: ProjectFileMove,
    tracked_doc: TrackedDoc,
}

#[derive(Clone)]
struct ReconciliationCandidate {
    base_generation: u64,
    snapshot: Arc<ProjectFilesSnapshot>,
    events: Vec<NormalizedEvent>,
    moves: Vec<CandidateMove>,
}

#[derive(Default)]
struct ProjectFilesState {
    generation: u64,
    latest: Option<Arc<ProjectFilesSnapshot>>,
    retained_candidate: Option<ReconciliationCandidate>,
    /// Native evidence received while a retained candidate still cannot commit.
    pending_events: Vec<NormalizedEvent>,
}

/// One open project's project-tree service. Clone/share snapshots, not mutable entries.
pub struct ProjectFiles {
    root: PathBuf,
    scanner: Arc<dyn ProjectFilesScanner>,
    store: Arc<dyn ProjectFilesStore>,
    path_rekeyer: Arc<dyn ProjectPathRekeyer>,
    recreate_adapter: Arc<dyn RecreateAdapter>,
    state: Mutex<ProjectFilesState>,
}

impl ProjectFiles {
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        Self::with_dependencies(
            &root,
            Arc::new(FilesystemScanner),
            Arc::new(SidecarStore::new(root.clone())),
            Arc::new(NoopPathRekeyer),
            default_recreate_adapter(),
        )
    }

    pub fn with_scanner(root: impl AsRef<Path>, scanner: Arc<dyn ProjectFilesScanner>) -> Self {
        let root = root.as_ref().to_path_buf();
        Self::with_dependencies(
            &root,
            scanner,
            Arc::new(SidecarStore::new(root.clone())),
            Arc::new(NoopPathRekeyer),
            default_recreate_adapter(),
        )
    }

    pub fn with_store_and_rekeyer(
        root: impl AsRef<Path>,
        store: Arc<dyn ProjectFilesStore>,
        path_rekeyer: Arc<dyn ProjectPathRekeyer>,
    ) -> Self {
        Self::with_dependencies(
            root,
            Arc::new(FilesystemScanner),
            store,
            path_rekeyer,
            default_recreate_adapter(),
        )
    }

    pub fn with_rekeyer(root: impl AsRef<Path>, path_rekeyer: Arc<dyn ProjectPathRekeyer>) -> Self {
        let root = root.as_ref().to_path_buf();
        Self::with_dependencies(
            &root,
            Arc::new(FilesystemScanner),
            Arc::new(SidecarStore::new(root.clone())),
            path_rekeyer,
            default_recreate_adapter(),
        )
    }

    pub fn with_scanner_and_recreate_adapter(
        root: impl AsRef<Path>,
        scanner: Arc<dyn ProjectFilesScanner>,
        recreate_adapter: Arc<dyn RecreateAdapter>,
    ) -> Self {
        let root = root.as_ref().to_path_buf();
        Self::with_dependencies(
            &root,
            scanner,
            Arc::new(SidecarStore::new(root.clone())),
            Arc::new(NoopPathRekeyer),
            recreate_adapter,
        )
    }

    fn with_dependencies(
        root: impl AsRef<Path>,
        scanner: Arc<dyn ProjectFilesScanner>,
        store: Arc<dyn ProjectFilesStore>,
        path_rekeyer: Arc<dyn ProjectPathRekeyer>,
        recreate_adapter: Arc<dyn RecreateAdapter>,
    ) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            scanner,
            store,
            path_rekeyer,
            recreate_adapter,
            state: Mutex::new(ProjectFilesState::default()),
        }
    }

    /// The single serialized first-load/refresh operation. The scanner runs while the state lock
    /// is held, so two callers cannot enumerate/commit out of order; failure leaves state untouched.
    pub fn refresh(&self) -> Result<Arc<ProjectFilesSnapshot>, ProjectFilesError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(candidate) = state.retained_candidate.take() {
            if self.revalidate(&candidate) {
                return self.commit_candidate(&mut state, candidate);
            }
        }
        self.refresh_fresh(&mut state)
    }

    /// Moves one document's durable TD-4 history and live path state from `from` to `to` — the
    /// user-driven counterpart of [`commit_candidate`](Self::commit_candidate)'s proven external
    /// move, used by J2's Missing-on-disk `[Save As…]` (#933). Both go through the same
    /// [`ProjectFilesStore`]/[`ProjectPathRekeyer`] pair, so a document keeps its comments, change
    /// records, and D21 protection however its path changed.
    ///
    /// A document with no sidecar identity yet has no history to carry and is not minted one here:
    /// Save As writes bytes, and a document earns an id when something is actually recorded against
    /// it (`SidecarStore::get_or_mint_for_path`). Live path state still follows in that case — the
    /// open tab moved either way.
    pub fn carry_document_history(&self, from: &str, to: &str) -> Result<(), String> {
        match self.store.doc_id_for_path(from) {
            Ok(Some(id)) => self
                .store
                .rename_all(&[(id, to.to_string())])
                .map_err(|error| error.to_string())?,
            Ok(None) => {}
            Err(error) => return Err(error.to_string()),
        }
        self.path_rekeyer.rekey_path(from, to);
        Ok(())
    }

    /// Reconciles one completed native-event batch, retaining it across a failed candidate retry.
    /// #928 feeds this from the sole `DocWatcher` subscription after coalescing; explicit retry
    /// uses [`refresh`](Self::refresh).
    pub fn refresh_with_events(
        &self,
        events: Vec<NormalizedEvent>,
    ) -> Result<Arc<ProjectFilesSnapshot>, ProjectFilesError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.pending_events.extend(events);
        if let Some(candidate) = state.retained_candidate.take() {
            if self.revalidate(&candidate) {
                self.commit_candidate(&mut state, candidate)?;
                return self.refresh_fresh(&mut state);
            }
        }
        self.refresh_fresh(&mut state)
    }

    fn refresh_fresh(
        &self,
        state: &mut ProjectFilesState,
    ) -> Result<Arc<ProjectFilesSnapshot>, ProjectFilesError> {
        let entries = self.scanner.scan(&self.root)?;
        let generation = state.generation.checked_add(1).ok_or_else(|| {
            ProjectFilesError::UpdateFailed("project-files generation exhausted".to_string())
        })?;
        let events = std::mem::take(&mut state.pending_events);
        let moves = state
            .latest
            .as_ref()
            .map(|previous| reconcile(&previous.entries, &entries, &events))
            .unwrap_or_default();
        let snapshot = Arc::new(ProjectFilesSnapshot {
            generation,
            entries,
            moves: moves.clone(),
        });
        if moves.is_empty() {
            return Ok(publish(state, snapshot));
        }
        let candidate = ReconciliationCandidate {
            base_generation: state.generation,
            snapshot,
            events,
            moves: moves
                .into_iter()
                .map(|movement| CandidateMove {
                    movement,
                    tracked_doc: TrackedDoc::Unresolved,
                })
                .collect(),
        };
        self.commit_candidate(state, candidate)
    }

    fn commit_candidate(
        &self,
        state: &mut ProjectFilesState,
        mut candidate: ReconciliationCandidate,
    ) -> Result<Arc<ProjectFilesSnapshot>, ProjectFilesError> {
        debug_assert_eq!(state.generation, candidate.base_generation);

        for movement in &mut candidate.moves {
            if matches!(movement.tracked_doc, TrackedDoc::Unresolved) {
                movement.tracked_doc = match self.store.doc_id_for_path(&movement.movement.old_path)
                {
                    Ok(Some(id)) => TrackedDoc::Tracked(id),
                    Ok(None) => TrackedDoc::Untracked,
                    Err(error) => {
                        return self.retain_failure(state, candidate, error.to_string());
                    }
                };
            }
        }
        let tracked_moves = candidate
            .moves
            .iter()
            .filter_map(|movement| match movement.tracked_doc {
                TrackedDoc::Tracked(id) => Some((id, movement.movement.new_path.clone())),
                TrackedDoc::Unresolved | TrackedDoc::Untracked => None,
            })
            .collect::<Vec<_>>();
        if let Err(error) = self.store.rename_all(&tracked_moves) {
            return self.retain_failure(state, candidate, error.to_string());
        }
        for movement in &candidate.moves {
            self.path_rekeyer
                .rekey_path(&movement.movement.old_path, &movement.movement.new_path);
        }
        Ok(publish(state, candidate.snapshot))
    }

    fn retain_failure(
        &self,
        state: &mut ProjectFilesState,
        candidate: ReconciliationCandidate,
        error: String,
    ) -> Result<Arc<ProjectFilesSnapshot>, ProjectFilesError> {
        state.retained_candidate = Some(candidate);
        Err(ProjectFilesError::UpdateFailed(format!(
            "could not commit project-file move: {error}"
        )))
    }

    fn revalidate(&self, candidate: &ReconciliationCandidate) -> bool {
        debug_assert!(!candidate.events.is_empty());
        candidate.moves.iter().all(|movement| {
            matches!(
                exact_spelling_exists(&self.root, &movement.movement.old_path),
                Ok(false)
            ) && platform_file_id_at(
                &self.root.join(&movement.movement.new_path),
                movement.movement.kind,
            ) == Some(movement.movement.platform_file_id.clone())
        })
    }

    /// The last fully completed snapshot, if first load has completed successfully.
    pub fn latest_snapshot(&self) -> Option<Arc<ProjectFilesSnapshot>> {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .latest
            .clone()
    }
}

fn default_recreate_adapter() -> Arc<dyn RecreateAdapter> {
    #[cfg(windows)]
    {
        Arc::new(WindowsRecreateAdapter)
    }
    #[cfg(not(windows))]
    {
        Arc::new(UnavailableRecreateAdapter)
    }
}

fn publish(
    state: &mut ProjectFilesState,
    snapshot: Arc<ProjectFilesSnapshot>,
) -> Arc<ProjectFilesSnapshot> {
    state.generation = snapshot.generation;
    state.latest = Some(Arc::clone(&snapshot));
    state.retained_candidate = None;
    snapshot
}

enum DirectoryScanError {
    /// `read_dir` could not begin for this exact directory. Below the root this becomes a typed
    /// warning on the known row; at the root it becomes `ProjectUnavailable`.
    Unreadable(String),
    /// Enumeration began but yielded an unassignable error, so publishing any partial tree would
    /// infer path facts TD-18 requires us to retain as stale instead.
    Untrustworthy(String),
}

fn scan_directory(
    directory: &Path,
    relative: &str,
) -> Result<Vec<ProjectFileEntry>, DirectoryScanError> {
    scan_directory_with_metadata(directory, relative, &|path| fs::symlink_metadata(path))
}

fn scan_directory_with_metadata<M>(
    directory: &Path,
    relative: &str,
    metadata_at: &M,
) -> Result<Vec<ProjectFileEntry>, DirectoryScanError>
where
    M: Fn(&Path) -> io::Result<fs::Metadata>,
{
    let read_dir = fs::read_dir(directory).map_err(|error| {
        DirectoryScanError::Unreadable(format!("{}: {error}", directory.to_string_lossy()))
    })?;
    let mut entries = Vec::new();

    for result in read_dir {
        let dir_entry = result.map_err(|error| {
            DirectoryScanError::Untrustworthy(format!(
                "could not complete enumeration of {}: {error}",
                directory.to_string_lossy()
            ))
        })?;
        let name = dir_entry.file_name().to_string_lossy().into_owned();
        let path = dir_entry.path();
        let relative_path = join_relative(relative, &name);

        let metadata = match metadata_at(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                entries.push(unreadable_entry(relative_path, name, error));
                continue;
            }
        };
        let kind = entry_kind(&metadata.file_type());

        if !is_user_visible(&name, kind) {
            continue;
        }

        let platform_file_id = platform_file_id_at(&path, kind);

        let (children, warning) = match kind {
            EntryKind::Directory => {
                match scan_directory_with_metadata(&path, &relative_path, metadata_at) {
                    Ok(children) => (children, None),
                    Err(DirectoryScanError::Unreadable(message)) => (
                        Vec::new(),
                        Some(ProjectFileWarning {
                            kind: ProjectFileWarningKind::Unreadable,
                            message,
                        }),
                    ),
                    Err(error @ DirectoryScanError::Untrustworthy(_)) => return Err(error),
                }
            }
            EntryKind::File => (
                Vec::new(),
                fs::File::open(&path).err().map(unreadable_warning),
            ),
            EntryKind::Symlink | EntryKind::Other | EntryKind::Unknown => (Vec::new(), None),
        };
        entries.push(ProjectFileEntry {
            path: relative_path,
            name,
            kind,
            platform_file_id,
            children,
            warning,
        });
    }

    entries.sort_by(entry_order);
    Ok(entries)
}

fn unreadable_warning(error: std::io::Error) -> ProjectFileWarning {
    ProjectFileWarning {
        kind: ProjectFileWarningKind::Unreadable,
        message: error.to_string(),
    }
}

/// Rust's Windows `FileType` defines `is_symlink` from the reparse tag's name-surrogate bit, so
/// junctions and mounted-folder redirects land here while Cloud Files/WOF entries retain their
/// ordinary file/directory kind. If Windows cannot read a reparse tag, `symlink_metadata` fails
/// and the caller above publishes an `Unknown` warning row without descending (TD-18/FR-X-5).
fn entry_kind(file_type: &fs::FileType) -> EntryKind {
    entry_kind_from_facts(
        file_type.is_symlink(),
        file_type.is_dir(),
        file_type.is_file(),
    )
}

fn entry_kind_from_facts(is_symlink: bool, is_directory: bool, is_file: bool) -> EntryKind {
    if is_symlink {
        EntryKind::Symlink
    } else if is_directory {
        EntryKind::Directory
    } else if is_file {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

fn unreadable_entry(path: String, name: String, error: std::io::Error) -> ProjectFileEntry {
    ProjectFileEntry {
        path,
        name,
        kind: EntryKind::Unknown,
        platform_file_id: None,
        children: Vec::new(),
        warning: Some(unreadable_warning(error)),
    }
}

fn exact_spelling_exists(root: &Path, relative: &str) -> io::Result<bool> {
    let mut directory = root.to_path_buf();
    let mut components = relative.split('/').peekable();
    while let Some(component) = components.next() {
        let mut matched = None;
        for result in fs::read_dir(&directory)? {
            let entry = result?;
            if entry.file_name() == OsStr::new(component) {
                matched = Some(entry.path());
                break;
            }
        }
        let Some(path) = matched else {
            return Ok(false);
        };
        if components.peek().is_none() {
            return Ok(true);
        }
        directory = path;
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn platform_file_id_at(path: &Path, kind: EntryKind) -> Option<PlatformFileId> {
    use std::os::unix::fs::MetadataExt;

    if matches!(
        kind,
        EntryKind::Symlink | EntryKind::Other | EntryKind::Unknown
    ) {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    Some(PlatformFileId::opaque(
        u128::from(metadata.dev()),
        u128::from(metadata.ino()),
    ))
}

#[cfg(windows)]
fn platform_file_id_at(path: &Path, kind: EntryKind) -> Option<PlatformFileId> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    if matches!(
        kind,
        EntryKind::Symlink | EntryKind::Other | EntryKind::Unknown
    ) {
        return None;
    }
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    let mut info: FILE_ID_INFO = unsafe { zeroed() };
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } != 0;
    succeeded.then(|| {
        PlatformFileId::opaque(
            u128::from(info.VolumeSerialNumber),
            u128::from_le_bytes(info.FileId.Identifier),
        )
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_file_id_at(_path: &Path, _kind: EntryKind) -> Option<PlatformFileId> {
    None
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn entry_order(left: &ProjectFileEntry, right: &ProjectFileEntry) -> Ordering {
    left.name
        .to_ascii_lowercase()
        .cmp(&right.name.to_ascii_lowercase())
        .then_with(|| left.name.cmp(&right.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_facts_map_to_the_file_entry_kind() {
        assert_eq!(entry_kind_from_facts(false, false, true), EntryKind::File);
    }

    #[test]
    fn symlink_and_directory_facts_map_to_distinct_entry_kinds() {
        assert_eq!(
            entry_kind_from_facts(true, false, false),
            EntryKind::Symlink
        );
        assert_eq!(
            entry_kind_from_facts(false, true, false),
            EntryKind::Directory
        );
    }

    #[test]
    fn an_unreadable_entry_is_unknown_non_descendable_and_warned() {
        let entry = unreadable_entry(
            "cloud".to_string(),
            "cloud".to_string(),
            std::io::Error::other("reparse tag unavailable"),
        );

        assert_eq!(entry.kind, EntryKind::Unknown);
        assert!(entry.children.is_empty());
        assert_eq!(
            entry.warning.unwrap().kind,
            ProjectFileWarningKind::Unreadable
        );
    }

    #[cfg(windows)]
    fn scan_indeterminate_real_windows_junction() -> Vec<ProjectFileEntry> {
        let fixture = tempfile::TempDir::new().unwrap();
        let project = fixture.path().join("project");
        let outside = fixture.path().join("outside");
        let junction = project.join("indeterminate junction");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("outside.md"), "must not escape\n").unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        scan_directory_with_metadata(&project, "", &|path| {
            if path == junction {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "reparse tag unavailable",
                ))
            } else {
                fs::symlink_metadata(path)
            }
        })
        .unwrap_or_else(|_| panic!("the disposable project must remain enumerable"))
    }

    #[cfg(windows)]
    fn indeterminate_junction(entries: &[ProjectFileEntry]) -> &ProjectFileEntry {
        entries
            .iter()
            .find(|entry| entry.path == "indeterminate junction")
            .unwrap()
    }

    #[cfg(windows)]
    fn contains_entry_path(entries: &[ProjectFileEntry], target: &str) -> bool {
        entries.iter().any(|entry| {
            entry.path == target || contains_entry_path(entry.children.as_slice(), target)
        })
    }

    #[cfg(windows)]
    #[test]
    fn an_indeterminate_tag_on_a_real_windows_reparse_point_is_listed_as_unknown() {
        let entries = scan_indeterminate_real_windows_junction();
        assert_eq!(indeterminate_junction(&entries).kind, EntryKind::Unknown);
    }

    #[cfg(windows)]
    #[test]
    fn an_indeterminate_tag_on_a_real_windows_reparse_point_has_no_children() {
        let entries = scan_indeterminate_real_windows_junction();
        assert!(indeterminate_junction(&entries).children.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn an_indeterminate_tag_on_a_real_windows_reparse_point_carries_a_typed_warning() {
        let entries = scan_indeterminate_real_windows_junction();
        assert_eq!(
            indeterminate_junction(&entries)
                .warning
                .as_ref()
                .map(|warning| warning.kind),
            Some(ProjectFileWarningKind::Unreadable)
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_indeterminate_tag_on_a_real_windows_reparse_point_does_not_expose_its_target() {
        let entries = scan_indeterminate_real_windows_junction();
        assert!(!contains_entry_path(
            &entries,
            "indeterminate junction/outside.md"
        ));
    }
}
