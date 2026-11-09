// ABOUTME: Sidecar store service (P2a-10, FR-ED-8, TD §3.2b) — the I/O layer wrapping the pure
// ABOUTME: comment/track-changes folds: append, fold-from-disk, and docs.json identity/rename/delete/adopt.

//! Wraps the already-merged pure fold/schema logic (`store::comments`, `store::changes`,
//! `store::docs_map`) with disk I/O: appending events/records, folding a document's current
//! sidecar state from what's on disk, and the doc-identity lifecycle TD §3.2b describes —
//! mint-at-first-write, rename/move as one map update, delete-surfaces-disposition, and
//! scratch-doc adopt-on-save-in.
//!
//! # Layout
//!
//! Everything lives under `<project root>/.emend/` (TD-4: "all Cowrite data under one
//! `.emend/` dir"), keyed by the per-doc UUID rather than path or a path hash — a rename never
//! touches sidecar content, only the `docs.json` map entry (FR-ED-8):
//!
//! - `.emend/docs.json` — the whole path<->UUID map (`store::docs_map`).
//! - `.emend/comments/<doc-id>/<author>.jsonl` — one append-only event log per author.
//! - `.emend/changes/<doc-id>.json` — the single current attribution map for that doc.
//!
//! # Comments vs. changes: append means different things on disk
//!
//! Comments are a genuine append-only log (TD-4): `append_comment_event` opens the author's file
//! in append mode and writes one more line, never rewriting what's already there. Track-changes
//! is **single-writer, last-write-wins** (TD-4/D19) and its on-disk form is already the *current*
//! resolved map, not a log (`docs/formats/sidecar/README.md`) — so `append_change_record` folds
//! the new record on top of the persisted map and atomically rewrites the whole (small) file. Both
//! still go through the same `store::changes::Fold`/`store::comments::Fold` re-derivation, so the
//! incremental-sync invariant (`fold(prefix)` then `apply(rest)` == `fold(all)`, test-plan P5)
//! holds at this layer exactly as it does in the pure modules underneath.

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::PathBuf;
#[cfg(test)]
use std::sync::{Arc, Barrier, Condvar, TryLockError};
use std::sync::{Mutex, MutexGuard, PoisonError};

use uuid::Uuid;

use crate::store::atomic;
use crate::store::changes::{self, ChangeRecord};
use crate::store::comments::{self, CommentEvent};
use crate::store::docs_map;
use crate::store::watch::SidecarWatcher;

/// Every `docs.json` mutation is a read-modify-write of the whole map. `SidecarStore` instances
/// are deliberately cheap and are constructed independently by several backend participants, so
/// the serialization point must belong to the service rather than to one caller or instance.
/// TD §3.5's per-project process lock excludes another app process; this lock excludes concurrent
/// writers inside the one process. Map writes are rare and small, so one process-wide mutex keeps
/// the ownership rule simple without adding another on-disk runtime lock.
static DOCS_MAP_WRITE_LOCK: Mutex<()> = Mutex::new(());
/// One app process owns a project (TD §3.5). Comment commands construct independent store
/// handles, so correction validation and competing event appends share this process-wide lane.
static COMMENT_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_docs_map_writes() -> MutexGuard<'static, ()> {
    DOCS_MAP_WRITE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn lock_comment_writes() -> MutexGuard<'static, ()> {
    COMMENT_WRITE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Holds the comment write lane across a caller's fold, validation, and append. Ordinary
/// `append_comment_event` callers enter the same lane for their individual event.
pub(crate) struct CommentTransaction<'a> {
    store: &'a SidecarStore,
    #[cfg(test)]
    _probe: CommentTransactionProbe,
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
thread_local! {
    static COMMENT_TRANSACTION_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
struct CommentTransactionProbe;

#[cfg(test)]
impl CommentTransactionProbe {
    fn new() -> Self {
        COMMENT_TRANSACTION_DEPTH.with(|depth| depth.set(depth.get() + 1));
        Self
    }
}

#[cfg(test)]
impl Drop for CommentTransactionProbe {
    fn drop(&mut self) {
        COMMENT_TRANSACTION_DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// A test-only check of write-lane ownership by this thread, not mere contention from another
/// test. Ordinary appends and longer transactions both install the thread-local probe.
#[cfg(test)]
pub(crate) fn comment_transaction_held() -> bool {
    COMMENT_TRANSACTION_DEPTH.with(|depth| depth.get() > 0)
        && matches!(COMMENT_WRITE_LOCK.try_lock(), Err(TryLockError::WouldBlock))
}

impl CommentTransaction<'_> {
    pub(crate) fn fold_comments(&self, id: Uuid) -> Result<comments::Fold, SidecarError> {
        self.store.fold_comments(id)
    }

    pub(crate) fn append_comment_event(
        &self,
        id: Uuid,
        event: &CommentEvent,
    ) -> Result<(), SidecarError> {
        self.store.append_comment_event_unlocked(id, event)
    }
}

#[cfg(test)]
struct DocsMapWriteProbe {
    callers_ready: Barrier,
    loaded_count: Mutex<usize>,
    loaded: Condvar,
}

#[cfg(test)]
impl DocsMapWriteProbe {
    fn new(writer_count: usize) -> Self {
        Self {
            callers_ready: Barrier::new(writer_count),
            loaded_count: Mutex::new(0),
            loaded: Condvar::new(),
        }
    }

    fn before_lock(&self) {
        self.callers_ready.wait();
    }

    fn after_load(&self) {
        let writer_holds_map_lock = match DOCS_MAP_WRITE_LOCK.try_lock() {
            Ok(guard) => {
                drop(guard);
                false
            }
            Err(TryLockError::WouldBlock | TryLockError::Poisoned(_)) => true,
        };
        let mut loaded_count = self
            .loaded_count
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *loaded_count += 1;
        self.loaded.notify_all();

        // On the unfixed implementation no map lock is held, so keep the first writer inside the
        // critical seam until both writers have loaded the same map. With the fix, the first writer
        // holds the lock and must continue so the second can enter after it saves.
        while !writer_holds_map_lock && *loaded_count < 2 {
            loaded_count = self
                .loaded
                .wait(loaded_count)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// A sidecar store operation failed. Wraps I/O with the small set of domain preconditions the
/// doc-identity lifecycle enforces (never a panic — every failure is a defined, reportable value,
/// matching `store::import_v1::ImportError`'s convention for this crate).
#[derive(Debug)]
pub enum SidecarError {
    Io(io::Error),
    /// `rename`/`purge_sidecar_data`/etc. named a doc id `docs.json` has no entry for.
    UnknownDoc(Uuid),
    /// `rename`/`adopt` named a path already claimed by a *different* doc id — assigning an
    /// already-occupied path would silently reassign someone else's document.
    PathAlreadyClaimed {
        path: String,
        existing: Uuid,
    },
}

impl From<io::Error> for SidecarError {
    fn from(e: io::Error) -> SidecarError {
        SidecarError::Io(e)
    }
}

impl fmt::Display for SidecarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SidecarError::Io(e) => write!(f, "sidecar store I/O error: {e}"),
            SidecarError::UnknownDoc(id) => write!(f, "no sidecar doc tracked with id {id}"),
            SidecarError::PathAlreadyClaimed { path, existing } => write!(
                f,
                "path {path:?} is already claimed by a different doc ({existing})"
            ),
        }
    }
}

impl std::error::Error for SidecarError {}

/// What sidecar data exists for a doc, for the caller to prompt the user about on delete
/// (FR-ED-8: "deleting a document prompts about its sidecar data" — this service surfaces the
/// data, the UI decision belongs to its consumer).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SidecarDisposition {
    pub thread_count: usize,
    pub change_count: usize,
}

/// Result of the indivisible adoption ownership check and file landing. A mapping write can fail
/// after the source-of-truth bytes have landed; callers must then keep the durable adoption event
/// pending so reconciliation can retry rather than reporting that nothing was written.
pub struct AdoptionLanding<T> {
    pub value: T,
    pub mapping_pending: bool,
    pub destination: String,
}

/// Failure before an adoption's bytes land. Store failures cover the ownership check; `Write`
/// preserves the document command's richer error surface without coupling the store to it.
pub enum AdoptionLandingError<E> {
    Store(SidecarError),
    Write(E),
}

impl SidecarDisposition {
    pub fn has_sidecar_data(&self) -> bool {
        self.thread_count > 0 || self.change_count > 0
    }
}

/// The sidecar store service for one project. Stateless beyond the project root — every method
/// reads/writes disk directly. The service owns process-wide serialization for `docs.json` map
/// mutations; TD §3.5's per-project lock excludes a second app process.
pub struct SidecarStore {
    root: PathBuf,
    #[cfg(test)]
    docs_map_write_probe: Option<Arc<DocsMapWriteProbe>>,
}

impl SidecarStore {
    pub fn new(root: impl Into<PathBuf>) -> SidecarStore {
        SidecarStore {
            root: root.into(),
            #[cfg(test)]
            docs_map_write_probe: None,
        }
    }

    #[cfg(test)]
    fn with_docs_map_write_probe(
        root: impl Into<PathBuf>,
        probe: Arc<DocsMapWriteProbe>,
    ) -> SidecarStore {
        SidecarStore {
            root: root.into(),
            docs_map_write_probe: Some(probe),
        }
    }

    fn emend_dir(&self) -> PathBuf {
        self.root.join(".emend")
    }

    fn docs_json_path(&self) -> PathBuf {
        self.emend_dir().join("docs.json")
    }

    fn comments_dir(&self, id: Uuid) -> PathBuf {
        self.emend_dir().join("comments").join(id.to_string())
    }

    /// The append-only log every event `author` writes for `id` lands in. Public so a caller can
    /// name the exact file a comment write targets: the D23 test driver's batch fault window
    /// (#538) makes *this* file genuinely unwritable between two of a batch's own appends, which
    /// is what lets an e2e script provoke FR-AGENT-6's partial batch against the real store
    /// instead of a mocked one.
    pub fn comment_author_file(&self, id: Uuid, author: &str) -> PathBuf {
        self.comments_dir(id).join(format!("{author}.jsonl"))
    }

    fn changes_file(&self, id: Uuid) -> PathBuf {
        self.emend_dir().join("changes").join(format!("{id}.json"))
    }

    fn load_docs_map_for_write(
        &self,
    ) -> Result<(MutexGuard<'static, ()>, docs_map::DocsMap), SidecarError> {
        #[cfg(test)]
        if let Some(probe) = &self.docs_map_write_probe {
            probe.before_lock();
        }
        let guard = lock_docs_map_writes();
        let map = docs_map::load(&self.docs_json_path())?;
        #[cfg(test)]
        if let Some(probe) = &self.docs_map_write_probe {
            probe.after_load();
        }
        Ok((guard, map))
    }

    // --- doc identity (TD §3.2b, FR-ED-8) -----------------------------------------------------

    /// Mints a fresh doc id, independent of any path — the entry point for a scratch/untitled
    /// document, which needs somewhere to key its accumulating comments/changes before it has a
    /// project path at all (TD §3.2b: "UUID minted at first sidecar write").
    pub fn mint_doc_id(&self) -> Uuid {
        Uuid::new_v4()
    }

    pub fn doc_id_for_path(&self, path: &str) -> Result<Option<Uuid>, SidecarError> {
        let map = docs_map::load(&self.docs_json_path())?;
        Ok(self.doc_id_in_map(&map, path))
    }

    pub fn path_for(&self, id: Uuid) -> Result<Option<String>, SidecarError> {
        Ok(docs_map::load(&self.docs_json_path())?
            .path_for(id)
            .map(str::to_string))
    }

    /// Every project-relative path currently tracked in `docs.json`, sorted. This is the document
    /// universe the TD-1 §3.2 `list_documents` tool reports over (D21 awareness): a document
    /// appears here once it has a sidecar identity (its first comment/change, or an explicit
    /// save-in), which is exactly the set with a per-doc UUID to key state against. Sorted so the
    /// tool's output is deterministic regardless of `docs.json` insertion order.
    pub fn tracked_paths(&self) -> Result<Vec<String>, SidecarError> {
        let map = docs_map::load(&self.docs_json_path())?;
        let mut paths: Vec<String> = map.documents.into_values().collect();
        paths.sort();
        Ok(paths)
    }

    /// The common entry point for a document that already has (or is getting) a project path:
    /// returns the existing id if `path` is already tracked, else mints one and registers it.
    /// This *is* "UUID minted at first sidecar write" for a document that was never a scratch doc.
    pub fn get_or_mint_for_path(&self, path: &str) -> Result<Uuid, SidecarError> {
        let (_map_write_guard, mut map) = self.load_docs_map_for_write()?;
        if let Some(id) = self.doc_id_in_map(&map, path) {
            return Ok(id);
        }
        let id = self.mint_doc_id();
        map.set_path(id, path);
        docs_map::save(&self.docs_json_path(), &map)?;
        Ok(id)
    }

    /// Rename/move an already-tracked document: one `docs.json` map update, sidecar content
    /// completely untouched (it's keyed by `id`, not path) — FR-ED-8. Errors if `id` isn't
    /// already tracked or `new_path` belongs to a different document (renaming isn't the way to
    /// mint an id; use `get_or_mint_for_path`/`adopt`).
    pub fn rename(&self, id: Uuid, new_path: &str) -> Result<(), SidecarError> {
        self.rename_all(&[(id, new_path.to_string())])
    }

    /// Renames every tracked document in one atomic `docs.json` update. Validation and mutation
    /// happen against one loaded map, so either the whole move set is persisted or none of it is.
    // @anchor:test-plan-sidecar-store-rename-all
    pub fn rename_all(&self, moves: &[(Uuid, String)]) -> Result<(), SidecarError> {
        if moves.is_empty() {
            return Ok(());
        }
        let (_map_write_guard, mut map) = self.load_docs_map_for_write()?;
        for (id, _) in moves {
            if !map.documents.contains_key(id) {
                return Err(SidecarError::UnknownDoc(*id));
            }
        }

        let moving_ids = moves
            .iter()
            .map(|(id, _)| *id)
            .collect::<std::collections::BTreeSet<_>>();
        let mut destinations = std::collections::BTreeMap::new();
        for (id, new_path) in moves {
            if let Some(existing) = destinations.insert(new_path, *id) {
                return Err(SidecarError::PathAlreadyClaimed {
                    path: new_path.clone(),
                    existing,
                });
            }
            if let Some(existing) = self.doc_id_in_map(&map, new_path) {
                if existing != *id && !moving_ids.contains(&existing) {
                    return Err(SidecarError::PathAlreadyClaimed {
                        path: new_path.clone(),
                        existing,
                    });
                }
            }
        }

        for (id, new_path) in moves {
            map.set_path(*id, new_path);
        }

        docs_map::save(&self.docs_json_path(), &map)?;
        Ok(())
    }

    /// Registers a scratch doc's already-minted `id` at `path` on its first save into the project
    /// (FR-ED-8's "scratch doc saved into the project adopts any comments/changes accumulated
    /// while untitled"). Adoption is free by construction: everything the scratch doc accumulated
    /// was already keyed by `id`, not a path, so registering the path is the whole operation — no
    /// sidecar content is copied or rewritten. Idempotent if called twice for the same
    /// `(id, path)` pair; errors if `path` is already claimed by a *different* doc.
    pub fn adopt(&self, id: Uuid, path: &str) -> Result<(), SidecarError> {
        self.publish_adoption_mapping(id, path)
    }

    /// Checks a Save As destination under the same map lock used by every identity mutation, but
    /// deliberately does not publish `path -> id`. Until the file write lands, the path's bytes do
    /// not belong to the scratch document and its UUID must remain pathless (D17/FR-ED-8).
    pub fn ensure_adoption_destination_available(
        &self,
        id: Uuid,
        path: &str,
    ) -> Result<(), SidecarError> {
        let (_map_write_guard, map) = self.load_docs_map_for_write()?;
        if let Some(existing) = self.doc_id_in_map(&map, path) {
            if existing != id {
                return Err(SidecarError::PathAlreadyClaimed {
                    path: path.to_string(),
                    existing,
                });
            }
        }
        Ok(())
    }

    /// Revalidates destination ownership, lands the file, and publishes its scratch identity while
    /// holding the one docs-map writer lock throughout. No path claimant can enter between the
    /// last ownership check and the atomic file replacement. A post-write map failure is reported
    /// as pending rather than as a failed write because the durable adoption log can reconcile it.
    pub fn land_adoption_with<T, E>(
        &self,
        id: Uuid,
        path: &str,
        write: impl FnOnce(&str) -> Result<T, E>,
    ) -> Result<AdoptionLanding<T>, AdoptionLandingError<E>> {
        let (_map_write_guard, mut map) = self
            .load_docs_map_for_write()
            .map_err(AdoptionLandingError::Store)?;
        // The leaf may have appeared after prepare. Resolve it only after taking the map lock so a
        // Windows case alias claimed in that interval compares using the filesystem's spelling.
        let destination = self
            .existing_identity_path(path)
            .unwrap_or_else(|| path.to_string());
        if let Some(existing) = self.doc_id_in_map(&map, &destination) {
            if existing != id {
                return Err(AdoptionLandingError::Store(
                    SidecarError::PathAlreadyClaimed {
                        path: destination,
                        existing,
                    },
                ));
            }
        }

        let value = write(&destination).map_err(AdoptionLandingError::Write)?;
        if self.doc_id_in_map(&map, &destination) == Some(id) {
            return Ok(AdoptionLanding {
                value,
                mapping_pending: false,
                destination,
            });
        }
        map.set_path(id, &destination);
        let mapping_pending = docs_map::save(&self.docs_json_path(), &map).is_err();
        Ok(AdoptionLanding {
            value,
            mapping_pending,
            destination,
        })
    }

    fn existing_identity_path(&self, path: &str) -> Option<String> {
        let root = self.root.canonicalize().ok()?;
        let resolved = self.root.join(path).canonicalize().ok()?;
        let relative = resolved.strip_prefix(root).ok()?;
        Some(relative.to_string_lossy().replace('\\', "/"))
    }

    fn doc_id_in_map(&self, map: &docs_map::DocsMap, path: &str) -> Option<Uuid> {
        map.documents
            .iter()
            .find(|(_, mapped)| self.paths_share_filesystem_identity(mapped, path))
            .map(|(id, _)| *id)
    }

    fn paths_share_filesystem_identity(&self, left: &str, right: &str) -> bool {
        if left == right {
            return true;
        }
        let left_resolved = self.root.join(left).canonicalize();
        let right_resolved = self.root.join(right).canonicalize();
        if matches!((left_resolved, right_resolved), (Ok(left), Ok(right)) if left == right) {
            return true;
        }
        #[cfg(windows)]
        {
            windows_paths_equal_ignore_case(left, right)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// Atomically publishes the identity of an already-landed Save As destination.
    fn publish_adoption_mapping(&self, id: Uuid, path: &str) -> Result<(), SidecarError> {
        let (_map_write_guard, mut map) = self.load_docs_map_for_write()?;
        if let Some(existing) = self.doc_id_in_map(&map, path) {
            if existing != id {
                return Err(SidecarError::PathAlreadyClaimed {
                    path: path.to_string(),
                    existing,
                });
            }
            return Ok(());
        }
        map.set_path(id, path);
        docs_map::save(&self.docs_json_path(), &map)?;
        Ok(())
    }

    /// Completes an adoption after the prepared file write has conclusively replaced `path`.
    /// An incumbent here raced the pre-write availability check (or belongs to a legacy event).
    /// Never detach it or silently choose between histories.
    pub fn adopt_after_file_landed(&self, id: Uuid, path: &str) -> Result<(), SidecarError> {
        self.adopt(id, path)
    }

    /// Removes only a still-owned legacy prepare-time reservation. New preparations never publish
    /// one; this migration cleanup returns their scratch UUID to pathless state, while a mapping
    /// replaced by another owner stays untouched.
    pub fn release_adoption_reservation(&self, id: Uuid, path: &str) -> Result<(), SidecarError> {
        let (_map_write_guard, mut map) = self.load_docs_map_for_write()?;
        if self.doc_id_in_map(&map, path) != Some(id) {
            return Ok(());
        }
        map.remove(id);
        docs_map::save(&self.docs_json_path(), &map)?;
        Ok(())
    }

    /// A document was deleted from the project: untracks `id` from `docs.json` (one map update,
    /// same as rename) and returns what sidecar data still exists on disk, for the caller to
    /// prompt the user about (FR-ED-8 leaves that UI decision to its consumer). Sidecar content
    /// itself is left in place until `purge_sidecar_data` is explicitly called — deleting the
    /// document is not, by itself, destructive to its comment/change history.
    pub fn delete_document(&self, id: Uuid) -> Result<SidecarDisposition, SidecarError> {
        let (_map_write_guard, mut map) = self.load_docs_map_for_write()?;
        map.remove(id);
        docs_map::save(&self.docs_json_path(), &map)?;
        self.sidecar_disposition(id)
    }

    /// What sidecar data exists for `id` right now, without changing anything.
    pub fn sidecar_disposition(&self, id: Uuid) -> Result<SidecarDisposition, SidecarError> {
        Ok(SidecarDisposition {
            thread_count: self.fold_comments(id)?.threads.len(),
            change_count: self.fold_changes(id)?.changes.len(),
        })
    }

    /// Permanently removes `id`'s sidecar content (comment logs + the changes file) — the
    /// caller's follow-up once a user has been prompted (via `sidecar_disposition`) and chosen to
    /// discard it. Does not touch `docs.json`; a no-op if there is nothing to remove.
    pub fn purge_sidecar_data(&self, id: Uuid) -> Result<(), SidecarError> {
        let comments_dir = self.comments_dir(id);
        if comments_dir.exists() {
            fs::remove_dir_all(&comments_dir)?;
        }
        let changes_file = self.changes_file(id);
        if changes_file.exists() {
            fs::remove_file(&changes_file)?;
        }
        Ok(())
    }

    // --- comments (append-only JSONL, TD-4) ----------------------------------------------------

    /// Appends one event to `event.author`'s log for `id`, creating the directory/file on first
    /// write. Never rewrites or reorders existing lines — genuinely append-only on disk, matching
    /// the sync conflict-freedom TD-4 relies on (different machines append to different files).
    pub fn append_comment_event(&self, id: Uuid, event: &CommentEvent) -> Result<(), SidecarError> {
        let _guard = lock_comment_writes();
        #[cfg(test)]
        let _probe = CommentTransactionProbe::new();
        #[cfg(test)]
        assert!(
            comment_transaction_held(),
            "ordinary comment append must hold the actual write mutex"
        );
        self.append_comment_event_unlocked(id, event)
    }

    /// A caller may hold this guard across its current-state check and event append. Keep the
    /// guard out of ordinary read-only folds; they are allowed to observe the last complete line.
    pub(crate) fn comment_transaction(&self) -> CommentTransaction<'_> {
        let guard = lock_comment_writes();
        CommentTransaction {
            store: self,
            #[cfg(test)]
            _probe: CommentTransactionProbe::new(),
            _guard: guard,
        }
    }

    fn append_comment_event_unlocked(
        &self,
        id: Uuid,
        event: &CommentEvent,
    ) -> Result<(), SidecarError> {
        let dir = self.comments_dir(id);
        fs::create_dir_all(&dir)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.comment_author_file(id, &event.author))?;
        let mut line = serde_json::to_string(event)
            .map_err(|e| SidecarError::Io(io::Error::new(io::ErrorKind::InvalidData, e)))?;
        line.push('\n');
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Finds which tracked document's comment log contains `comment_id` — as either a thread root
    /// or a reply within one — by folding each tracked doc's comments until a match is found.
    /// Used by the MCP `reply_to_comment` tool (P2b-5a, TD-1 §3.2), which addresses a comment by
    /// id alone with no `doc` argument of its own. Pathless UUID histories are included so a
    /// colliding or interrupted adoption cannot strand a still-present comment. A project-wide
    /// comment index is a future optimization if this ever proves hot; correctness first.
    pub fn find_doc_id_by_comment(&self, comment_id: &str) -> Result<Option<Uuid>, SidecarError> {
        let map = docs_map::load(&self.docs_json_path())?;
        let mut ids: BTreeSet<Uuid> = map.documents.into_keys().collect();
        let comments_root = self.emend_dir().join("comments");
        match fs::read_dir(&comments_root) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    if entry.file_type()?.is_dir() {
                        if let Ok(id) = Uuid::parse_str(&entry.file_name().to_string_lossy()) {
                            ids.insert(id);
                        }
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        for id in ids {
            let fold = self.fold_comments(id)?;
            let found = fold
                .threads
                .values()
                .any(|t| t.id == comment_id || t.replies.iter().any(|r| r.id == comment_id));
            if found {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// Folds `id`'s current thread state from every author's on-disk event log (test-plan P5).
    /// A document with no comment activity yet folds to an empty state, not an error. A line that
    /// fails to parse (a crash mid-`write_all` truncating the very last line — the one torn case
    /// append-only-without-fsync-barrier can produce) is skipped rather than failing the whole
    /// fold, mirroring `store::comments`'s own "unknown event types skipped, not fatal" policy for
    /// genuinely malformed input.
    pub fn fold_comments(&self, id: Uuid) -> Result<comments::Fold, SidecarError> {
        let dir = self.comments_dir(id);
        let mut events = Vec::new();
        if dir.exists() {
            let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
                .collect();
            // Deterministic read order — the fold's own (timestamp, id) ordering makes the
            // result independent of this anyway, but a stable iteration order keeps behavior
            // reproducible for debugging/logging.
            entries.sort();
            for path in entries {
                let content = fs::read_to_string(&path)?;
                for line in content.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(event) = serde_json::from_str::<CommentEvent>(line) {
                        events.push(event);
                    }
                }
            }
        }
        Ok(comments::fold(events))
    }

    // --- track changes (single JSON map, last-write-wins, TD-4/D19) ---------------------------

    /// Folds a new record into `id`'s current attribution map and atomically rewrites the whole
    /// (small) file. Track-changes is single-writer by design (TD-4/D19), so "append" here means
    /// "read current state, apply this record, persist the result" rather than growing a log.
    pub fn append_change_record(
        &self,
        id: Uuid,
        record: &ChangeRecord,
    ) -> Result<(), SidecarError> {
        self.append_change_records(id, std::slice::from_ref(record))
    }

    /// Folds a whole batch of records into `id`'s attribution map and rewrites the
    /// file **once** — the atomic-delivery shape `propose_changes` needs (FR-AGENT-6:
    /// "the applied subset is itself one complete, attributed change set"). Folding
    /// the batch in one shot then writing once means the on-disk map never shows a
    /// half-delivered change set, and (last-write-wins, TD-4/D19) is order-independent.
    pub fn append_change_records(
        &self,
        id: Uuid,
        records: &[ChangeRecord],
    ) -> Result<(), SidecarError> {
        if records.is_empty() {
            return Ok(());
        }
        let mut fold = self.fold_changes(id)?;
        fold.apply(records.iter().cloned());
        self.write_changes(id, &fold)
    }

    /// Folds `id`'s current attribution map from disk. A document with no tracked changes yet
    /// folds to an empty map, not an error.
    pub fn fold_changes(&self, id: Uuid) -> Result<changes::Fold, SidecarError> {
        let path = self.changes_file(id);
        let records: Vec<ChangeRecord> = match fs::read_to_string(&path) {
            Ok(content) => {
                let map: std::collections::BTreeMap<String, ChangeRecord> =
                    serde_json::from_str(&content).map_err(|e| {
                        SidecarError::Io(io::Error::new(io::ErrorKind::InvalidData, e))
                    })?;
                map.into_values().collect()
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(changes::fold(records))
    }

    fn write_changes(&self, id: Uuid, fold: &changes::Fold) -> Result<(), SidecarError> {
        atomic::write_json(&self.changes_file(id), &fold.changes)?;
        Ok(())
    }

    // --- FS watch (no polling — native OS notification APIs) ----------------------------------

    /// Starts watching this project's `.emend/` directory for externally-landed sidecar changes
    /// (a sync worker pulling a reviewer's edits, another process writing alongside this one) —
    /// `notify`'s recommended watcher uses native OS notification APIs (FSEvents/inotify/
    /// ReadDirectoryChangesW), never polling.
    pub fn watch(&self) -> notify::Result<SidecarWatcher> {
        SidecarWatcher::watch(&self.emend_dir())
    }
}

#[cfg(windows)]
fn windows_paths_equal_ignore_case(left: &str, right: &str) -> bool {
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};

    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    let Ok(left_len) = i32::try_from(left.len()) else {
        return false;
    };
    let Ok(right_len) = i32::try_from(right.len()) else {
        return false;
    };
    // SAFETY: both pointers remain valid for their explicit UTF-16 slice lengths throughout the
    // call. CompareStringOrdinal reads neither slice beyond that length and does not retain them.
    unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) == CSTR_EQUAL
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use tempfile::TempDir;

    fn store() -> (TempDir, SidecarStore) {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        (dir, store)
    }

    #[test]
    fn get_or_mint_for_path_mints_a_fresh_id_on_first_write() {
        let (_dir, store) = store();
        let id = store.get_or_mint_for_path("chapters/01.md").unwrap();
        assert_eq!(store.doc_id_for_path("chapters/01.md").unwrap(), Some(id));
        assert_eq!(
            store.path_for(id).unwrap(),
            Some("chapters/01.md".to_string())
        );
    }

    #[test]
    fn get_or_mint_for_path_returns_the_same_id_on_a_second_call() {
        let (_dir, store) = store();
        let first = store.get_or_mint_for_path("chapters/01.md").unwrap();
        let second = store.get_or_mint_for_path("chapters/01.md").unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn different_paths_mint_different_ids() {
        let (_dir, store) = store();
        let a = store.get_or_mint_for_path("a.md").unwrap();
        let b = store.get_or_mint_for_path("b.md").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn two_concurrent_map_writers_preserve_both_updates() {
        let (dir, store) = store();
        let first = store.get_or_mint_for_path("first.md").unwrap();
        let second = store.get_or_mint_for_path("second.md").unwrap();
        let probe = Arc::new(DocsMapWriteProbe::new(2));
        let mut writers = Vec::new();

        for (id, destination) in [(first, "first-moved.md"), (second, "second-moved.md")] {
            let root = dir.path().to_path_buf();
            let probe = Arc::clone(&probe);
            writers.push(thread::spawn(move || {
                let store = SidecarStore::with_docs_map_write_probe(root, probe);
                store.rename(id, destination)
            }));
        }

        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        assert_eq!(
            store.doc_id_for_path("first-moved.md").unwrap(),
            Some(first)
        );
        assert_eq!(
            store.doc_id_for_path("second-moved.md").unwrap(),
            Some(second)
        );
    }

    #[test]
    fn tracked_paths_lists_every_registered_path_sorted() {
        let (_dir, store) = store();
        store.get_or_mint_for_path("notes/b.md").unwrap();
        store.get_or_mint_for_path("a.md").unwrap();
        store.mint_doc_id(); // a scratch doc with no path never appears
        assert_eq!(
            store.tracked_paths().unwrap(),
            vec!["a.md".to_string(), "notes/b.md".to_string()]
        );
    }

    #[test]
    fn tracked_paths_is_empty_for_a_project_with_no_docs_json() {
        let (_dir, store) = store();
        assert!(store.tracked_paths().unwrap().is_empty());
    }

    #[test]
    fn rename_updates_the_map_in_one_call_without_touching_sidecar_content() {
        let (_dir, store) = store();
        let id = store.get_or_mint_for_path("old/name.md").unwrap();
        let event = comment_event(&id.to_string(), None, "alice", 0, "hello");
        store.append_comment_event(id, &event).unwrap();

        store.rename(id, "new/name.md").unwrap();

        assert_eq!(store.doc_id_for_path("old/name.md").unwrap(), None);
        assert_eq!(store.doc_id_for_path("new/name.md").unwrap(), Some(id));
        // Sidecar content survives the rename untouched, keyed by id.
        let fold = store.fold_comments(id).unwrap();
        assert_eq!(fold.threads.len(), 1);
    }

    #[test]
    fn rename_all_updates_every_path_in_one_map_save() {
        let (_dir, store) = store();
        let directory_id = store.get_or_mint_for_path("drafts").unwrap();
        let document_id = store.get_or_mint_for_path("drafts/kept.md").unwrap();

        store
            .rename_all(&[
                (directory_id, "archive".to_string()),
                (document_id, "archive/kept.md".to_string()),
            ])
            .unwrap();

        assert_eq!(
            store.path_for(directory_id).unwrap().as_deref(),
            Some("archive")
        );
        assert_eq!(
            store.path_for(document_id).unwrap().as_deref(),
            Some("archive/kept.md")
        );
    }

    #[test]
    fn rename_all_rejects_a_claimed_destination_without_changing_any_path() {
        let (dir, store) = store();
        let first = store.get_or_mint_for_path("first.md").unwrap();
        let second = store.get_or_mint_for_path("second.md").unwrap();
        let existing = store.get_or_mint_for_path("taken.md").unwrap();
        let docs_json = dir.path().join(".emend/docs.json");
        let before = fs::read(&docs_json).unwrap();

        let error = store
            .rename_all(&[
                (first, "moved.md".to_string()),
                (second, "taken.md".to_string()),
            ])
            .unwrap_err();

        assert!(matches!(
            error,
            SidecarError::PathAlreadyClaimed { path, existing: id }
                if path == "taken.md" && id == existing
        ));
        assert_eq!(fs::read(docs_json).unwrap(), before);
    }

    #[test]
    fn rename_all_rejects_two_moves_to_the_same_destination_within_the_batch() {
        // The intra-batch duplicate-destination guard (service.rs:208-213): with no destination
        // yet tracked in `docs.json` at all, only the batch's own two moves collide with each
        // other. This is the *only* thing standing between a batch and a `docs.json` mapping two
        // document IDs onto one path (#927's ratified invariant, FR-ED-8).
        let (dir, store) = store();
        let first = store.get_or_mint_for_path("first.md").unwrap();
        let second = store.get_or_mint_for_path("second.md").unwrap();
        let docs_json = dir.path().join(".emend/docs.json");
        let before = fs::read(&docs_json).unwrap();

        let error = store
            .rename_all(&[
                (first, "shared.md".to_string()),
                (second, "shared.md".to_string()),
            ])
            .unwrap_err();

        assert!(matches!(
            error,
            SidecarError::PathAlreadyClaimed { path, existing: id }
                if path == "shared.md" && id == first
        ));
        assert_eq!(fs::read(docs_json).unwrap(), before);
    }

    #[test]
    fn rename_all_commits_a_chain_where_a_mover_claims_another_movers_current_path() {
        // The `!moving_ids.contains(&existing)` relaxation (service.rs:215): `b.md`'s current
        // owner is itself moving away in the same batch, so `a -> b.md` must not be refused as
        // "claimed" the way it would be if `b` were not co-moving. Chained rather than a bare
        // swap to also exercise a mover whose destination is a *third* untouched path.
        let (_dir, store) = store();
        let a = store.get_or_mint_for_path("a.md").unwrap();
        let b = store.get_or_mint_for_path("b.md").unwrap();

        store
            .rename_all(&[(a, "b.md".to_string()), (b, "c.md".to_string())])
            .unwrap();

        assert_eq!(store.doc_id_for_path("a.md").unwrap(), None);
        assert_eq!(store.doc_id_for_path("b.md").unwrap(), Some(a));
        assert_eq!(store.doc_id_for_path("c.md").unwrap(), Some(b));
        // Collision-free: every tracked path is distinct, i.e. no two document IDs share one.
        let mut paths = store.tracked_paths().unwrap();
        let before_dedup = paths.len();
        paths.dedup();
        assert_eq!(
            paths.len(),
            before_dedup,
            "docs.json maps two ids to one path"
        );
        assert_eq!(paths, vec!["b.md".to_string(), "c.md".to_string()]);
    }

    #[test]
    fn renaming_an_unknown_doc_id_is_a_defined_error() {
        let (_dir, store) = store();
        let err = store.rename(Uuid::new_v4(), "wherever.md").unwrap_err();
        assert!(matches!(err, SidecarError::UnknownDoc(_)));
    }

    #[test]
    fn a_scratch_doc_mints_before_any_path_and_adopts_its_sidecar_data_on_save_in() {
        let (_dir, store) = store();
        let id = store.mint_doc_id();
        // Accumulate comment/change activity while untitled — keyed by id, no path yet.
        store
            .append_comment_event(
                id,
                &comment_event(&id.to_string(), None, "alice", 0, "note"),
            )
            .unwrap();
        store
            .append_change_record(id, &change_record("c1", 0))
            .unwrap();
        assert_eq!(store.path_for(id).unwrap(), None);

        store.adopt(id, "chapters/new-draft.md").unwrap();

        assert_eq!(
            store.doc_id_for_path("chapters/new-draft.md").unwrap(),
            Some(id)
        );
        // Everything accumulated while untitled is still there — adoption touched no content.
        assert_eq!(store.fold_comments(id).unwrap().threads.len(), 1);
        assert_eq!(store.fold_changes(id).unwrap().changes.len(), 1);
    }

    #[test]
    fn adopting_the_same_id_and_path_twice_is_idempotent() {
        let (_dir, store) = store();
        let id = store.mint_doc_id();
        store.adopt(id, "draft.md").unwrap();
        store.adopt(id, "draft.md").unwrap();
        assert_eq!(store.doc_id_for_path("draft.md").unwrap(), Some(id));
    }

    #[test]
    fn adopting_a_path_already_claimed_by_a_different_doc_is_a_defined_error() {
        let (_dir, store) = store();
        let existing = store.get_or_mint_for_path("taken.md").unwrap();
        let scratch = store.mint_doc_id();

        let err = store.adopt(scratch, "taken.md").unwrap_err();

        match err {
            SidecarError::PathAlreadyClaimed {
                path,
                existing: got,
            } => {
                assert_eq!(path, "taken.md");
                assert_eq!(got, existing);
            }
            other => panic!("expected PathAlreadyClaimed, got {other:?}"),
        }
    }

    #[test]
    fn landed_adoption_refuses_to_detach_a_racing_destination_owner() {
        let (_dir, store) = store();
        let existing = store.get_or_mint_for_path("taken.md").unwrap();
        let scratch = store.mint_doc_id();

        let error = store
            .adopt_after_file_landed(scratch, "taken.md")
            .unwrap_err();

        assert!(
            matches!(error, SidecarError::PathAlreadyClaimed { existing: owner, .. } if owner == existing)
        );
        assert_eq!(store.doc_id_for_path("taken.md").unwrap(), Some(existing));
        assert_eq!(
            store.path_for(existing).unwrap().as_deref(),
            Some("taken.md")
        );
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }

    #[test]
    fn adoption_holds_the_identity_lock_through_file_landing() {
        let (dir, store) = store();
        let scratch = store.mint_doc_id();
        let root = dir.path().to_path_buf();
        let (write_started_tx, write_started_rx) = std::sync::mpsc::channel();
        let (release_write_tx, release_write_rx) = std::sync::mpsc::channel();

        let landing = thread::spawn(move || {
            store
                .land_adoption_with(scratch, "new.md", |_| {
                    write_started_tx.send(()).unwrap();
                    release_write_rx.recv().unwrap();
                    Ok::<_, ()>(())
                })
                .unwrap_or_else(|_| panic!("adoption landing failed"));
        });
        write_started_rx.recv().unwrap();
        assert!(matches!(
            DOCS_MAP_WRITE_LOCK.try_lock(),
            Err(TryLockError::WouldBlock | TryLockError::Poisoned(_))
        ));

        release_write_tx.send(()).unwrap();
        landing.join().unwrap();
        assert_eq!(
            SidecarStore::new(root)
                .get_or_mint_for_path("new.md")
                .unwrap(),
            scratch
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_windows_unicode_case_alias_reuses_one_identity() {
        let (_dir, store) = store();
        let incumbent = store.get_or_mint_for_path("Notes/Ä.md").unwrap();

        let alias = store.get_or_mint_for_path("notes/ä.md").unwrap();

        assert_eq!(alias, incumbent);
        assert_eq!(store.tracked_paths().unwrap(), vec!["Notes/Ä.md"]);
    }

    #[test]
    fn delete_untracks_the_path_and_reports_no_sidecar_data_when_there_is_none() {
        let (_dir, store) = store();
        let id = store.get_or_mint_for_path("throwaway.md").unwrap();

        let disposition = store.delete_document(id).unwrap();

        assert!(!disposition.has_sidecar_data());
        assert_eq!(store.doc_id_for_path("throwaway.md").unwrap(), None);
    }

    #[test]
    fn delete_surfaces_disposition_data_without_deleting_the_sidecar_content_itself() {
        let (_dir, store) = store();
        let id = store.get_or_mint_for_path("has-comments.md").unwrap();
        store
            .append_comment_event(id, &comment_event(&id.to_string(), None, "alice", 0, "x"))
            .unwrap();

        let disposition = store.delete_document(id).unwrap();

        assert!(disposition.has_sidecar_data());
        assert_eq!(disposition.thread_count, 1);
        // Content is untouched — still readable by id even though the path is now untracked.
        assert_eq!(store.fold_comments(id).unwrap().threads.len(), 1);
    }

    #[test]
    fn purge_sidecar_data_removes_comment_and_change_content_but_not_docs_json() {
        let (_dir, store) = store();
        let id = store.get_or_mint_for_path("doomed.md").unwrap();
        store
            .append_comment_event(id, &comment_event(&id.to_string(), None, "alice", 0, "x"))
            .unwrap();
        store
            .append_change_record(id, &change_record("c1", 0))
            .unwrap();

        store.purge_sidecar_data(id).unwrap();

        assert_eq!(store.fold_comments(id).unwrap().threads.len(), 0);
        assert_eq!(store.fold_changes(id).unwrap().changes.len(), 0);
        // docs.json entry (if the caller hadn't already deleted it) is untouched by purge.
        assert_eq!(store.doc_id_for_path("doomed.md").unwrap(), Some(id));
    }

    #[test]
    fn purge_sidecar_data_on_a_doc_with_no_data_is_a_quiet_no_op() {
        let (_dir, store) = store();
        let id = store.mint_doc_id();
        store.purge_sidecar_data(id).unwrap();
    }

    fn comment_event(
        id: &str,
        parent: Option<&str>,
        author: &str,
        ts: i64,
        body: &str,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            author: author.to_string(),
            timestamp: ts,
            kind: comments::EventKind::Create {
                anchor: None,
                body: body.to_string(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        }
    }

    fn change_record(id: &str, updated_at: i64) -> ChangeRecord {
        let doc = textops::Document::new("hello world");
        ChangeRecord {
            schema_version: changes::SCHEMA_VERSION,
            id: id.to_string(),
            kind: changes::ChangeType::Insertion,
            author: "claude-code".to_string(),
            anchor: textops::Anchor::new(&doc, 0, 5),
            created_at: 0,
            updated_at,
            group: None,
            change_set: None,
            note: None,
        }
    }
}

#[cfg(test)]
mod comment_append_fold_tests {
    use super::*;
    use crate::test_support::tree_with_contents;
    use tempfile::TempDir;

    fn store() -> (TempDir, SidecarStore, Uuid) {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store.mint_doc_id();
        (dir, store, id)
    }

    fn create(id: &str, author: &str, ts: i64, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: None,
            author: author.to_string(),
            timestamp: ts,
            kind: comments::EventKind::Create {
                anchor: None,
                body: body.to_string(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        }
    }

    #[test]
    fn a_new_project_writes_its_sidecar_under_dot_emend_only() {
        let (dir, store, _) = store();
        let id = store.get_or_mint_for_path("a.md").unwrap();
        store
            .append_comment_event(id, &create("c1", "alice", 1, "hello"))
            .unwrap();

        assert!(dir.path().join(".emend/docs.json").is_file());
        assert!(store
            .comment_author_file(id, "alice")
            .starts_with(dir.path().join(".emend")));
        assert!(store.comment_author_file(id, "alice").is_file());
        assert!(!dir.path().join(".cowrite").exists());
    }

    #[test]
    fn a_project_holding_only_dot_cowrite_opens_with_no_sidecar_state_and_leaves_it_untouched() {
        // TD-29: a clean break with no migration. Real sidecar data is written by the store, then
        // moved to where Cowrite kept it; a fresh store must neither read, write nor delete it.
        let (dir, writer, _) = store();
        let old_id = writer.get_or_mint_for_path("a.md").unwrap();
        writer
            .append_comment_event(old_id, &create("c1", "alice", 1, "hello"))
            .unwrap();
        fs::rename(dir.path().join(".emend"), dir.path().join(".cowrite")).unwrap();
        let before = tree_with_contents(&dir.path().join(".cowrite"));
        assert!(!before.is_empty());

        let store = SidecarStore::new(dir.path());
        assert_eq!(store.doc_id_for_path("a.md").unwrap(), None);
        assert_eq!(store.tracked_paths().unwrap(), Vec::<String>::new());
        assert_eq!(store.find_doc_id_by_comment("c1").unwrap(), None);
        assert!(!store
            .sidecar_disposition(old_id)
            .unwrap()
            .has_sidecar_data());
        let new_id = store.get_or_mint_for_path("a.md").unwrap();
        assert_ne!(new_id, old_id);
        store
            .append_comment_event(new_id, &create("c2", "alice", 2, "fresh"))
            .unwrap();

        assert_eq!(tree_with_contents(&dir.path().join(".cowrite")), before);
        assert!(dir.path().join(".emend/docs.json").is_file());
    }

    fn reply(id: &str, parent: &str, author: &str, ts: i64, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: comments::EventKind::Reply {
                body: body.to_string(),
                defense: false,
                published: false,
                run_id: None,
            },
        }
    }

    #[test]
    fn folding_a_doc_with_no_comment_activity_is_an_empty_state_not_an_error() {
        let (_dir, store, id) = store();
        assert!(store.fold_comments(id).unwrap().threads.is_empty());
    }

    #[test]
    fn a_single_comment_append_is_immediately_visible_in_the_fold() {
        let (_dir, store, id) = store();
        store
            .append_comment_event(id, &create("c1", "alice", 0, "why here?"))
            .unwrap();
        let fold = store.fold_comments(id).unwrap();
        assert_eq!(fold.threads["c1"].body, "why here?");
    }

    #[test]
    fn appends_land_in_separate_per_author_files() {
        let (_dir, store, id) = store();
        store
            .append_comment_event(id, &create("c1", "alice", 0, "root"))
            .unwrap();
        store
            .append_comment_event(id, &reply("r1", "c1", "bob", 1, "reply"))
            .unwrap();

        let dir_entries: Vec<String> = std::fs::read_dir(store.comments_dir(id))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(dir_entries.contains(&"alice.jsonl".to_string()));
        assert!(dir_entries.contains(&"bob.jsonl".to_string()));
    }

    #[test]
    fn each_append_is_a_new_line_never_a_rewrite_of_earlier_lines() {
        let (_dir, store, id) = store();
        store
            .append_comment_event(id, &create("c1", "alice", 0, "first"))
            .unwrap();
        store
            .append_comment_event(id, &create("c2", "alice", 1, "second"))
            .unwrap();
        let content = std::fs::read_to_string(store.comment_author_file(id, "alice")).unwrap();
        assert_eq!(content.lines().count(), 2);
        assert!(content.lines().next().unwrap().contains("\"c1\""));
    }

    #[test]
    fn folding_a_prefix_of_appends_then_the_rest_matches_appending_and_folding_all_at_once() {
        // The incremental-sync invariant (P5), exercised at the store/append layer.
        let (dir_a, store_a, id) = store();
        store_a
            .append_comment_event(id, &create("c1", "alice", 0, "please clarify"))
            .unwrap();
        let prefix = store_a.fold_comments(id).unwrap();
        store_a
            .append_comment_event(id, &reply("r1", "c1", "bob", 1, "on it"))
            .unwrap();
        let incremental = store_a.fold_comments(id).unwrap();
        drop(dir_a);

        let dir_b = tempfile::TempDir::new().unwrap();
        let store_b = SidecarStore::new(dir_b.path());
        store_b
            .append_comment_event(id, &create("c1", "alice", 0, "please clarify"))
            .unwrap();
        store_b
            .append_comment_event(id, &reply("r1", "c1", "bob", 1, "on it"))
            .unwrap();
        let direct = store_b.fold_comments(id).unwrap();

        assert_ne!(
            prefix.threads["c1"].replies.len(),
            direct.threads["c1"].replies.len()
        );
        assert_eq!(incremental.threads, direct.threads);
    }

    #[test]
    fn a_corrupt_trailing_line_is_skipped_rather_than_failing_the_whole_fold() {
        let (_dir, store, id) = store();
        store
            .append_comment_event(id, &create("c1", "alice", 0, "intact"))
            .unwrap();
        // Simulate a crash mid-write: append a truncated, unparsable line after the good one.
        let mut file = OpenOptions::new()
            .append(true)
            .open(store.comment_author_file(id, "alice"))
            .unwrap();
        file.write_all(b"{\"schema_version\":1,\"id\":\"c2\",\"trunc")
            .unwrap();

        let fold = store.fold_comments(id).unwrap();

        assert_eq!(fold.threads.len(), 1);
        assert!(fold.threads.contains_key("c1"));
    }

    // --- find_doc_id_by_comment (P2b-5a: MCP reply_to_comment's doc-free lookup) --------------

    #[test]
    fn find_doc_id_by_comment_locates_the_tracked_doc_owning_a_thread_root() {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let a = store.get_or_mint_for_path("a.md").unwrap();
        let b = store.get_or_mint_for_path("b.md").unwrap();
        store
            .append_comment_event(a, &create("c1", "alice", 0, "on a.md"))
            .unwrap();
        store
            .append_comment_event(b, &create("c2", "alice", 0, "on b.md"))
            .unwrap();

        assert_eq!(store.find_doc_id_by_comment("c1").unwrap(), Some(a));
        assert_eq!(store.find_doc_id_by_comment("c2").unwrap(), Some(b));
    }

    #[test]
    fn find_doc_id_by_comment_locates_the_doc_owning_a_reply_not_just_a_thread_root() {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let a = store.get_or_mint_for_path("a.md").unwrap();
        store
            .append_comment_event(a, &create("c1", "alice", 0, "root"))
            .unwrap();
        store
            .append_comment_event(a, &reply("r1", "c1", "bob", 1, "a reply"))
            .unwrap();

        assert_eq!(store.find_doc_id_by_comment("r1").unwrap(), Some(a));
    }

    #[test]
    fn find_doc_id_by_comment_is_none_for_an_unknown_id() {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        store.get_or_mint_for_path("a.md").unwrap();
        assert_eq!(store.find_doc_id_by_comment("nonexistent").unwrap(), None);
    }

    #[test]
    fn appended_events_conform_to_the_published_comment_event_schema() {
        use crate::store::schema::{is_valid, Schema};
        let (_dir, store, id) = store();
        let event = create("c1", "alice", 0, "why here?");
        store.append_comment_event(id, &event).unwrap();

        let content = std::fs::read_to_string(store.comment_author_file(id, "alice")).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert!(is_valid(Schema::CommentEvent, &value));
    }
}

#[cfg(test)]
mod change_append_fold_tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, SidecarStore, Uuid) {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store.mint_doc_id();
        (dir, store, id)
    }

    fn record(
        id: &str,
        kind: changes::ChangeType,
        updated_at: i64,
        note: Option<&str>,
    ) -> ChangeRecord {
        let doc = textops::Document::new("The quick fox jumps.");
        ChangeRecord {
            schema_version: changes::SCHEMA_VERSION,
            id: id.to_string(),
            kind,
            author: "claude-code".to_string(),
            anchor: textops::Anchor::new(&doc, 4, 5),
            created_at: 0,
            updated_at,
            group: None,
            change_set: None,
            note: note.map(str::to_string),
        }
    }

    #[test]
    fn folding_a_doc_with_no_tracked_changes_is_an_empty_map_not_an_error() {
        let (_dir, store, id) = store();
        assert!(store.fold_changes(id).unwrap().changes.is_empty());
    }

    #[test]
    fn a_single_change_append_is_immediately_visible_in_the_fold() {
        let (_dir, store, id) = store();
        store
            .append_change_record(id, &record("c1", changes::ChangeType::Insertion, 0, None))
            .unwrap();
        let fold = store.fold_changes(id).unwrap();
        assert_eq!(fold.changes["c1"].kind, changes::ChangeType::Insertion);
    }

    #[test]
    fn appending_a_later_record_for_the_same_id_amends_it_last_write_wins() {
        let (_dir, store, id) = store();
        store
            .append_change_record(id, &record("c1", changes::ChangeType::Insertion, 0, None))
            .unwrap();
        store
            .append_change_record(
                id,
                &record("c1", changes::ChangeType::Insertion, 10, Some("amended")),
            )
            .unwrap();

        let fold = store.fold_changes(id).unwrap();
        assert_eq!(fold.changes.len(), 1);
        assert_eq!(fold.changes["c1"].note.as_deref(), Some("amended"));
    }

    #[test]
    fn a_batch_append_lands_every_record_in_one_write() {
        // The atomic-delivery shape: a whole change set folded and written once.
        let (_dir, store, id) = store();
        let batch = [
            record("c1", changes::ChangeType::Insertion, 0, None),
            record("c2", changes::ChangeType::Deletion, 0, None),
            record("c3", changes::ChangeType::Substitution, 0, None),
        ];
        store.append_change_records(id, &batch).unwrap();
        let fold = store.fold_changes(id).unwrap();
        assert_eq!(fold.changes.len(), 3);
        assert!(["c1", "c2", "c3"]
            .iter()
            .all(|k| fold.changes.contains_key(*k)));
    }

    #[test]
    fn an_empty_batch_append_is_a_quiet_no_op() {
        let (_dir, store, id) = store();
        store.append_change_records(id, &[]).unwrap();
        assert!(store.fold_changes(id).unwrap().changes.is_empty());
    }

    #[test]
    fn distinct_ids_all_survive_across_separate_appends() {
        let (_dir, store, id) = store();
        store
            .append_change_record(id, &record("c1", changes::ChangeType::Insertion, 0, None))
            .unwrap();
        store
            .append_change_record(id, &record("c2", changes::ChangeType::Deletion, 1, None))
            .unwrap();
        let fold = store.fold_changes(id).unwrap();
        assert_eq!(fold.changes.len(), 2);
    }

    #[test]
    fn the_on_disk_file_is_the_resolved_map_keyed_by_change_id() {
        let (_dir, store, id) = store();
        store
            .append_change_record(id, &record("c1", changes::ChangeType::Insertion, 0, None))
            .unwrap();
        let content = std::fs::read_to_string(store.changes_file(id)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(value.get("c1").is_some());
    }

    #[test]
    fn appended_records_conform_to_the_published_change_record_schema() {
        use crate::store::schema::{is_valid, Schema};
        let (_dir, store, id) = store();
        store
            .append_change_record(
                id,
                &record("c1", changes::ChangeType::Substitution, 0, None),
            )
            .unwrap();

        let content = std::fs::read_to_string(store.changes_file(id)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(is_valid(Schema::ChangeRecord, value.get("c1").unwrap()));
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;
    use crate::store::watch::{recv_matching, SidecarKind};
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn watching_the_store_reports_an_externally_landed_comment_append() {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store.mint_doc_id();
        // The watch target directory must exist before an OS watcher can be installed on it.
        std::fs::create_dir_all(dir.path().join(".emend")).unwrap();
        let watcher = store.watch().unwrap();

        store
            .append_comment_event(
                id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: "c1".to_string(),
                    parent_id: None,
                    author: "alice".to_string(),
                    timestamp: 0,
                    kind: comments::EventKind::Create {
                        anchor: None,
                        body: "landed externally".to_string(),
                        severity: None,
                        skill: None,
                        workflow_run: None,
                    },
                },
            )
            .unwrap();

        let change = recv_matching(&watcher, Duration::from_secs(5), |c| c.doc_id == Some(id));
        assert_eq!(change.kind, SidecarKind::Comments);
    }
}
