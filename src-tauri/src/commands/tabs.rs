// ABOUTME: Tab-session IPC (P2a-6, TD §3.1) — confines FR-ED-3 state and owns its writer authority.
// ABOUTME: Serializes canonical-root writers behind app-local OS leases and revisioned receipts.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fs4::{FileExt, TryLockError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agent::project::SharedOpenProject;
use crate::store::project_identity;
use crate::store::tab_session::{Session, TabSnapshot, UNSAVED_CONTENT_CAP_BYTES};

use super::document::CommandError;
use super::path_confine::{confine, identity_relative};

/// Mirrors `store::tab_session::TabSnapshot`, JS-cased for the IPC boundary (CLAUDE.md:
/// cross-boundary types defined in Rust with `Serialize`, mirrored in TS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshotPayload {
    pub path: String,
    /// Path-independent sidecar identity for an untitled recovery document (#1803).
    #[serde(default)]
    pub doc_id: Option<String>,
    pub unsaved_content: Option<String>,
    /// The project path an untitled recovery document was displaced from, `None` for an ordinary
    /// tab (#932) — the flag the frontend re-identifies the restored tab from, carried across the
    /// boundary rather than re-derived from `path` on either side.
    pub recovered_from: Option<String>,
    /// Stable duplicate displaced-path label ordinal (9d.3); absent on ordinary and legacy tabs.
    #[serde(default)]
    pub displaced_label_ordinal: Option<u32>,
    /// Explicit result of applying the per-tab cap. Missing fields from older IPC callers default
    /// false; the store normalizes legacy on-disk recovery records when it loads them.
    #[serde(default)]
    pub unsaved_content_omitted: bool,
    /// Whether the standing over-cap explanation is collapsed to its persistent one-line form.
    #[serde(default)]
    pub loss_notice_collapsed: bool,
}

/// Mirrors `store::tab_session::Session` (minus `schema_version`, which is this layer's own
/// bookkeeping — the frontend neither sends nor needs it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    pub tabs: Vec<TabSnapshotPayload>,
    pub active_path: Option<String>,
}

/// In-process authority for FR-ED-3's one logical writer per project session, paired with the
/// cross-process OS lease below. The key is the filesystem-canonical project root so alternate
/// spellings cannot mint parallel lanes.
pub struct TabSessionCoordinator {
    writers: Mutex<HashMap<PathBuf, ActiveWriter>>,
    app_local_data_dir: PathBuf,
}

struct ActiveWriter {
    id: String,
    attachment_id: String,
    // Held for the logical writer's whole lifetime; Drop unlocks before closing this handle.
    _lease: File,
}

impl Drop for ActiveWriter {
    fn drop(&mut self) {
        // Closing one handle alone can leave the OS lease held by an inherited or duplicated
        // descriptor. Logical ownership ends here, even when that other descriptor stays open.
        let _ = FileExt::unlock(&self._lease);
    }
}

impl TabSessionCoordinator {
    pub fn new(app_local_data_dir: PathBuf) -> TabSessionCoordinator {
        TabSessionCoordinator {
            writers: Mutex::new(HashMap::new()),
            app_local_data_dir,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionSnapshotPayload {
    pub canonical_root: String,
    pub attachment_id: String,
    pub revision: String,
    pub session: SessionPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionSavePolicy {
    Background,
    RequireUntitledLossless,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabPersistenceStatus {
    RestoredFromDisk,
    PersistedExact,
    OmittedOverCap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPersistenceOutcome {
    pub path: String,
    pub status: TabPersistenceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionReceipt {
    pub revision: String,
    pub session: SessionPayload,
    pub outcomes: Vec<TabPersistenceOutcome>,
}

impl From<Session> for SessionPayload {
    fn from(session: Session) -> SessionPayload {
        SessionPayload {
            tabs: session
                .tabs
                .into_iter()
                .map(|t| TabSnapshotPayload {
                    path: t.path,
                    doc_id: t.doc_id,
                    unsaved_content: t.unsaved_content,
                    recovered_from: t.recovered_from,
                    displaced_label_ordinal: t.displaced_label_ordinal,
                    unsaved_content_omitted: t.unsaved_content_omitted,
                    loss_notice_collapsed: t.loss_notice_collapsed,
                })
                .collect(),
            active_path: session.active_path,
        }
    }
}

fn validate_and_materialize(
    root: &str,
    session: SessionPayload,
) -> Result<(Session, Vec<TabPersistenceOutcome>), CommandError> {
    for tab in &session.tabs {
        confine(Path::new(root), &tab.path)?;
        // A recovery document's own identity is not a project path, but the path it was displaced
        // *from* is one, and it is shown to the author — so it is confined like any other.
        if let Some(recovered_from) = &tab.recovered_from {
            confine(Path::new(root), recovered_from)?;
            if let Some(doc_id) = &tab.doc_id {
                uuid::Uuid::parse_str(doc_id).map_err(|error| {
                    CommandError::InvalidDocument(format!("invalid untitled document id: {error}"))
                })?;
            }
        }
    }
    if let Some(active_path) = &session.active_path {
        confine(Path::new(root), active_path)?;
    }
    let outcomes = session
        .tabs
        .iter()
        .map(|tab| TabPersistenceOutcome {
            path: tab.path.clone(),
            status: match &tab.unsaved_content {
                _ if tab.unsaved_content_omitted => TabPersistenceStatus::OmittedOverCap,
                None => TabPersistenceStatus::RestoredFromDisk,
                Some(content) if content.len() <= UNSAVED_CONTENT_CAP_BYTES => {
                    TabPersistenceStatus::PersistedExact
                }
                Some(_) => TabPersistenceStatus::OmittedOverCap,
            },
        })
        .collect();
    let tabs = session
        .tabs
        .into_iter()
        .map(|t| {
            let doc_id = if t.recovered_from.is_some() {
                t.doc_id
            } else {
                None
            };
            TabSnapshot::new(t.path, t.unsaved_content)
                .with_doc_id(doc_id)
                .displaced_from(t.recovered_from)
                .with_displaced_label_ordinal(t.displaced_label_ordinal)
                .with_recovery_persistence(t.unsaved_content_omitted, t.loss_notice_collapsed)
        })
        .collect();
    Ok((Session::new(tabs, session.active_path), outcomes))
}

/// The app-local-data area the per-project writer leases live in.
const LEASE_DIR_NAME: &str = "tab-session-writers";

/// The lease file inside a project's own directory under that area. Deliberately the same spelling
/// `store::lock` gives the OS lock this is the sibling of, but its own constant rather than that
/// one: the two are separate on-disk contracts that happen to agree, and sharing a constant would
/// let a change to either silently move the other.
const LEASE_FILE_NAME: &str = "lock";

/// This layer's typed-error spelling of `project_identity::require_canonical_root` — the fallible
/// disposition of the one canonical-root rule, because a session may not be leased for a folder
/// that is not there. Error mapping only; the rule itself is not restated here.
fn canonical_project_root(root: &str) -> Result<PathBuf, CommandError> {
    project_identity::require_canonical_root(Path::new(root)).map_err(CommandError::from)
}

/// `<app_local_data_dir>/tab-session-writers/<project key>/lock` — the cross-process lease file
/// [`acquire_writer_lease`] opens, resolved through `store::project_identity::project_dir` like
/// every other per-project app-local-data store, so the transcript log, the adoption log, TD-20's
/// ownership registry and this lease all give one project one directory under one rule (#2245).
/// Pure: resolving a path creates nothing.
pub(crate) fn lease_path(app_local_data_dir: &Path, canonical_root: &Path) -> PathBuf {
    project_identity::project_dir(app_local_data_dir, LEASE_DIR_NAME, canonical_root)
        .join(LEASE_FILE_NAME)
}

fn acquire_writer_lease(
    app_local_data_dir: &Path,
    canonical_root: &Path,
) -> Result<File, CommandError> {
    // The directory is taken from the resolved path rather than composed a second time, so
    // `lease_path` stays the one spelling of where the lease lives — the same parent-of-a-file
    // shape `store::transcript::append` and `store::atomic::write` use, where `store::lock`
    // creates `registry_dir` directly because its own resolver returns the directory.
    let path = lease_path(app_local_data_dir, canonical_root);
    fs::create_dir_all(
        path.parent()
            .expect("a lease path always names a file inside its project directory"),
    )?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match FileExt::try_lock(&file) {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(CommandError::WriterBusy(
            "another process owns this tab session".into(),
        )),
        Err(TryLockError::Error(error)) => Err(CommandError::Io(error.to_string())),
    }
}

fn session_revision(session: &Session) -> Result<String, CommandError> {
    let bytes = serde_json::to_vec(session).map_err(|error| CommandError::Io(error.to_string()))?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

fn load_snapshot(
    canonical_root: &Path,
    attachment_id: &str,
) -> Result<TabSessionSnapshotPayload, CommandError> {
    let canonical_root = canonical_root.to_string_lossy().into_owned();
    let session = crate::store::tab_session::load(Path::new(&canonical_root))?;
    let session = sanitize_restored_session(&canonical_root, session);
    Ok(TabSessionSnapshotPayload {
        canonical_root,
        attachment_id: attachment_id.to_string(),
        revision: session_revision(&session)?,
        session: session.into(),
    })
}

/// Acquires the sole writer lane for `root` (in-process coordinator plus cross-process OS lease)
/// and returns the exact durable session, canonical root, accepted attachment generation, and CAS
/// revision. A stable writer may replace its attachment after reload, but only after the snapshot
/// load succeeds; another writer is refused before it can observe itself as an owner.
pub fn begin_tab_session_on(
    coordinator: &TabSessionCoordinator,
    root: String,
    writer_id: String,
    attachment_id: String,
) -> Result<TabSessionSnapshotPayload, CommandError> {
    if writer_id.is_empty() || attachment_id.is_empty() {
        return Err(CommandError::WriterLost(
            "writer id and attachment id must be non-empty".into(),
        ));
    }
    let canonical = canonical_project_root(&root)?;
    let mut writers = coordinator
        .writers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(owner) = writers.get(&canonical) {
        if owner.id != writer_id {
            return Err(CommandError::WriterBusy(
                "another renderer owns this tab session".into(),
            ));
        }
        let snapshot = load_snapshot(&canonical, &attachment_id)?;
        if owner.attachment_id != attachment_id {
            writers
                .get_mut(&canonical)
                .expect("the writer remains present while its coordinator lock is held")
                .attachment_id = attachment_id;
        }
        return Ok(snapshot);
    }
    let lease = acquire_writer_lease(&coordinator.app_local_data_dir, &canonical)?;
    let snapshot = load_snapshot(&canonical, &attachment_id)?;
    writers.insert(
        canonical,
        ActiveWriter {
            id: writer_id,
            attachment_id,
            _lease: lease,
        },
    );
    Ok(snapshot)
}

#[tauri::command]
pub fn begin_tab_session(
    coordinator: State<'_, TabSessionCoordinator>,
    root: String,
    writer_id: String,
    attachment_id: String,
) -> Result<TabSessionSnapshotPayload, CommandError> {
    begin_tab_session_on(&coordinator, root, writer_id, attachment_id)
}

/// Persists under an acquired writer attachment and a CAS revision. The coordinator lock
/// deliberately spans read/compare/write: all accepted writers also hold the per-root OS lease, so
/// the fixed-temp atomic writer has one serialized lane across processes; the revision detects a
/// write that bypassed or predated that lane.
pub fn save_tab_session_on(
    coordinator: &TabSessionCoordinator,
    root: String,
    writer_id: String,
    attachment_id: String,
    expected_revision: String,
    session: SessionPayload,
    policy: SessionSavePolicy,
) -> Result<TabSessionReceipt, CommandError> {
    let canonical = canonical_project_root(&root)?;
    let writers = coordinator
        .writers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if writers
        .get(&canonical)
        .map(|writer| (&writer.id, &writer.attachment_id))
        != Some((&writer_id, &attachment_id))
    {
        return Err(CommandError::WriterLost(
            "this renderer no longer owns the tab session".into(),
        ));
    }

    let canonical_root = canonical.to_string_lossy().into_owned();
    let current = load_snapshot(&canonical, &attachment_id)?;
    if current.revision != expected_revision {
        return Err(CommandError::RevisionConflict(format!(
            "expected {expected_revision}, found {}",
            current.revision
        )));
    }
    let omits_untitled = session.tabs.iter().any(|tab| {
        tab.recovered_from.is_some()
            && (tab.unsaved_content_omitted
                || tab
                    .unsaved_content
                    .as_ref()
                    .is_some_and(|content| content.len() > UNSAVED_CONTENT_CAP_BYTES))
    });
    let (materialized, outcomes) = validate_and_materialize(&canonical_root, session)?;
    if policy == SessionSavePolicy::RequireUntitledLossless && omits_untitled {
        return Err(CommandError::UntitledContentOmitted(
            "an untitled recovery buffer exceeds the durable session cap".into(),
        ));
    }
    crate::store::tab_session::save(&canonical, &materialized)?;
    let revision = session_revision(&materialized)?;
    Ok(TabSessionReceipt {
        revision,
        session: materialized.into(),
        outcomes,
    })
}

/// Attests that `session` is already the exact durable session without performing a write.
/// Ownership, attachment and revision checks are identical to `save_tab_session_on`; the
/// losslessness result is therefore authoritative rather than a renderer-side comparison.
pub fn prove_tab_session_on(
    coordinator: &TabSessionCoordinator,
    root: String,
    writer_id: String,
    attachment_id: String,
    expected_revision: String,
    session: SessionPayload,
) -> Result<TabSessionReceipt, CommandError> {
    let canonical = canonical_project_root(&root)?;
    let writers = coordinator
        .writers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if writers
        .get(&canonical)
        .map(|writer| (&writer.id, &writer.attachment_id))
        != Some((&writer_id, &attachment_id))
    {
        return Err(CommandError::WriterLost(
            "this renderer no longer owns the tab session".into(),
        ));
    }

    let canonical_root = canonical.to_string_lossy().into_owned();
    let current = load_snapshot(&canonical, &attachment_id)?;
    if current.revision != expected_revision {
        return Err(CommandError::RevisionConflict(format!(
            "expected {expected_revision}, found {}",
            current.revision
        )));
    }
    let (materialized, outcomes) = validate_and_materialize(&canonical_root, session)?;
    if outcomes
        .iter()
        .any(|outcome| outcome.status == TabPersistenceStatus::OmittedOverCap)
    {
        return Err(CommandError::UntitledContentOmitted(
            "an untitled recovery buffer is not durably exact".into(),
        ));
    }
    let proposed: SessionPayload = materialized.into();
    if proposed != current.session {
        return Err(CommandError::SessionProofUnusable(
            "the proposed session does not match the current durable session".into(),
        ));
    }
    Ok(TabSessionReceipt {
        revision: current.revision,
        session: current.session,
        outcomes,
    })
}

#[tauri::command]
pub fn prove_tab_session(
    coordinator: State<'_, TabSessionCoordinator>,
    root: String,
    writer_id: String,
    attachment_id: String,
    expected_revision: String,
    session: SessionPayload,
) -> Result<TabSessionReceipt, CommandError> {
    prove_tab_session_on(
        &coordinator,
        root,
        writer_id,
        attachment_id,
        expected_revision,
        session,
    )
}

#[tauri::command]
pub fn save_tab_session(
    coordinator: State<'_, TabSessionCoordinator>,
    root: String,
    writer_id: String,
    attachment_id: String,
    expected_revision: String,
    session: SessionPayload,
    policy: SessionSavePolicy,
) -> Result<TabSessionReceipt, CommandError> {
    save_tab_session_on(
        &coordinator,
        root,
        writer_id,
        attachment_id,
        expected_revision,
        session,
        policy,
    )
}

pub fn end_tab_session_on(
    coordinator: &TabSessionCoordinator,
    root: String,
    writer_id: String,
    attachment_id: String,
) -> Result<(), CommandError> {
    let canonical = canonical_project_root(&root)?;
    let mut writers = coordinator
        .writers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match writers.get(&canonical) {
        Some(owner) if owner.id != writer_id => {
            return Err(CommandError::WriterLost(
                "this renderer no longer owns the tab session".into(),
            ));
        }
        Some(owner) if owner.attachment_id != attachment_id => return Ok(()),
        Some(_) => {}
        None => {
            return Err(CommandError::WriterLost(
                "this renderer no longer owns the tab session".into(),
            ));
        }
    }
    writers.remove(&canonical);
    Ok(())
}

#[tauri::command]
pub fn end_tab_session(
    coordinator: State<'_, TabSessionCoordinator>,
    root: String,
    writer_id: String,
    attachment_id: String,
) -> Result<(), CommandError> {
    end_tab_session_on(&coordinator, root, writer_id, attachment_id)
}

/// Loads the persisted tab session for the project at `root`. A project with no saved session
/// (first open, or the runtime file was never written, or the file was corrupt/unrecognized —
/// `store::tab_session::load` already fails soft to empty on those) returns an empty session, not
/// an error — the frontend restores "no tabs" the same way it would a brand-new project.
///
/// Every surviving tab's path is re-confined against `root` (`sanitize_restored_session`): a
/// structurally valid session can still name a path that escapes `root` if the file itself
/// arrived from somewhere other than this project's own `save_tab_session` calls — e.g. synced in
/// via a non-git, non-gitignore-respecting channel from a different project or machine (CJ ruling,
/// #143). That tab is dropped rather than restoring the wrong content; the rest of an otherwise-
/// valid session still restores.
#[tauri::command]
pub fn load_tab_session(root: String) -> Result<SessionPayload, CommandError> {
    let session = crate::store::tab_session::load(Path::new(&root))?;
    Ok(sanitize_restored_session(&root, session).into())
}

/// Replaces the backend's live open-tab source for `root` with `paths` (D21/FR-AGENT-2). This is
/// deliberately separate from the persisted FR-ED-3 session snapshot above: restoring a disk
/// snapshot does not make a document protected until the frontend actually opens that tab.
pub fn set_open_tabs_on(
    session: &SharedOpenProject,
    root: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let root_path = Path::new(&root);
    let canonical: Result<Vec<String>, CommandError> = paths
        .iter()
        .map(|path| {
            let confined = confine(root_path, path)?;
            Ok(identity_relative(root_path, &confined)?)
        })
        .collect();
    let canonical = canonical?;

    let mut session = session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let project = session.as_mut().ok_or_else(|| {
        CommandError::InvalidPath("no project is open for this tab set".to_string())
    })?;
    if !project.is_root(&root) {
        return Err(CommandError::InvalidPath(
            "the tab set does not belong to the open project".to_string(),
        ));
    }
    project.watchdog_mut().set_open_tabs(&canonical);
    Ok(())
}

#[tauri::command]
pub fn set_open_tabs(
    app: AppHandle,
    session: State<SharedOpenProject>,
    root: String,
    paths: Vec<String>,
    active_path: Option<String>,
) -> Result<(), CommandError> {
    let save_as_enabled = crate::menu::save_document_as_available(&paths, active_path.as_deref());
    set_open_tabs_on(&session, root, paths)?;
    crate::menu::set_save_document_as_enabled(&app, save_as_enabled)
        .map_err(|error| CommandError::Io(error.to_string()))
}

/// Drops any tab whose `path` — or whose `recovered_from`, the displaced project path a recovery
/// document is named for — fails §3.5 confinement against `root`, and clears `active_path` if it
/// named one of the dropped tabs (or never named a tab at all). See `load_tab_session`'s docs.
fn sanitize_restored_session(root: &str, session: Session) -> Session {
    let root_path = Path::new(root);
    let tabs: Vec<TabSnapshot> = session
        .tabs
        .into_iter()
        .filter(|tab| {
            confine(root_path, &tab.path).is_ok()
                && tab
                    .recovered_from
                    .as_ref()
                    .is_none_or(|from| confine(root_path, from).is_ok())
        })
        .collect();
    let active_path = session
        .active_path
        .filter(|active| tabs.iter().any(|t| &t.path == active));
    Session::new(tabs, active_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::spawn_ignored_test;
    use std::io::{Read, Write};
    use tempfile::TempDir;

    const TEST_ATTACHMENT: &str = "test-attachment";

    fn root_of(dir: &TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    fn coordinator() -> TabSessionCoordinator {
        TabSessionCoordinator::new(std::env::temp_dir().join("cowrite-tab-session-tests"))
    }

    fn retain_lease_descriptor(lease: &std::fs::File) -> std::fs::File {
        lease.try_clone().unwrap()
    }

    fn save_tab_session(root: String, session: SessionPayload) -> Result<(), CommandError> {
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "test-writer".into(),
            TEST_ATTACHMENT.into(),
        )?;
        save_tab_session_on(
            &coordinator,
            root,
            "test-writer".into(),
            opened.attachment_id,
            opened.revision,
            session,
            SessionSavePolicy::Background,
        )?;
        Ok(())
    }

    fn one_tab(
        path: &str,
        content: Option<String>,
        recovered_from: Option<&str>,
    ) -> SessionPayload {
        SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: path.into(),
                doc_id: None,
                unsaved_content: content,
                recovered_from: recovered_from.map(str::to_string),
                displaced_label_ordinal: None,
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: Some(path.into()),
        }
    }

    /// The production edge for #2245: what `begin_tab_session_on` actually writes to a real
    /// app-local-data directory, not what `lease_path` returns in isolation. The area's whole tree
    /// is asserted as a positive allowlist, so the pre-#2245 flat `<key>.lock` spelling — or any
    /// other stray sibling — reddens here rather than only the one name this card moved.
    #[test]
    fn a_held_lease_lives_in_the_projects_own_directory_not_a_key_named_file() {
        let project = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let root = root_of(&project);
        let coordinator = TabSessionCoordinator::new(app_data.path().to_path_buf());

        begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();

        // Read off a *sibling* store's directory for the same root rather than re-derived here:
        // the claim is that the lease names this project exactly as the other stores do, and
        // naming the key rule in this file would also weaken `project_identity`'s caller-set scan
        // for the one module this card moved.
        let key = crate::store::lock::registry_dir(app_data.path(), Path::new(&root))
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let area = app_data.path().join(LEASE_DIR_NAME);

        assert_eq!(
            crate::test_support::tree(&area),
            vec![key.clone(), format!("{key}/{LEASE_FILE_NAME}")],
            "the lease area must hold exactly this project's own directory and the lease inside it"
        );
    }

    #[test]
    fn a_second_logical_writer_is_refused_until_the_owner_releases() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();

        begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer-a".into(),
            "attachment-a".into(),
        )
        .unwrap();
        let busy = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer-b".into(),
            "attachment-b".into(),
        );
        assert!(matches!(busy, Err(CommandError::WriterBusy(_))));

        // A duplicate retains the same OS open-file description, as an inherited descriptor
        // can during process creation. Logical release must not depend on its last close.
        let retained = retain_lease_descriptor(
            &coordinator.writers.lock().unwrap()[&std::fs::canonicalize(&root).unwrap()]._lease,
        );
        end_tab_session_on(
            &coordinator,
            root.clone(),
            "writer-a".into(),
            "attachment-a".into(),
        )
        .unwrap();
        begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer-b".into(),
            "attachment-b".into(),
        )
        .expect("logical release must unlock despite a retained descriptor");
        drop(retained);
        let contender = TabSessionCoordinator::new(coordinator.app_local_data_dir.clone());
        assert!(
            matches!(
                begin_tab_session_on(&contender, root, "writer-c".into(), "attachment-c".into()),
                Err(CommandError::WriterBusy(_))
            ),
            "closing the old descriptor must not release the successor's lease"
        );
    }

    #[test]
    fn dropping_the_coordinator_releases_a_writer_with_a_retained_descriptor() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let contender = TabSessionCoordinator::new(coordinator.app_local_data_dir.clone());
        begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer-a".into(),
            "attachment-a".into(),
        )
        .unwrap();
        let retained = retain_lease_descriptor(
            &coordinator.writers.lock().unwrap()[&std::fs::canonicalize(&root).unwrap()]._lease,
        );
        assert!(
            matches!(
                begin_tab_session_on(
                    &contender,
                    root.clone(),
                    "writer-b".into(),
                    "attachment-b".into()
                ),
                Err(CommandError::WriterBusy(_))
            ),
            "the OS lease must exclude a second coordinator while its owner lives"
        );
        drop(coordinator);
        begin_tab_session_on(&contender, root, "writer-b".into(), "attachment-b".into())
            .expect("coordinator teardown must unlock despite a retained descriptor");
        drop(retained);
    }

    #[test]
    fn one_renderer_releases_only_the_named_projects_writer() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let first_root = root_of(&first);
        let second_root = root_of(&second);
        let coordinator = coordinator();

        begin_tab_session_on(
            &coordinator,
            first_root.clone(),
            "renderer-a".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        begin_tab_session_on(
            &coordinator,
            second_root.clone(),
            "renderer-a".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        end_tab_session_on(
            &coordinator,
            first_root.clone(),
            "renderer-a".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();

        begin_tab_session_on(
            &coordinator,
            first_root,
            "renderer-b".into(),
            "attachment-b".into(),
        )
        .unwrap();
        let second_busy = begin_tab_session_on(
            &coordinator,
            second_root,
            "renderer-b".into(),
            "attachment-b".into(),
        );
        assert!(matches!(second_busy, Err(CommandError::WriterBusy(_))));
    }

    #[test]
    fn a_stale_attachment_cannot_release_a_reattached_writer() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let alias = dir.path().join(".").to_string_lossy().into_owned();
        let coordinator = coordinator();
        let old = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            "old-attachment".into(),
        )
        .unwrap();
        let current = begin_tab_session_on(
            &coordinator,
            alias.clone(),
            "writer".into(),
            "current-attachment".into(),
        )
        .unwrap();

        end_tab_session_on(&coordinator, root, "writer".into(), "old-attachment".into()).unwrap();
        save_tab_session_on(
            &coordinator,
            alias,
            "writer".into(),
            current.attachment_id,
            old.revision,
            one_tab("draft.md", Some("preserved".into()), None),
            SessionSavePolicy::Background,
        )
        .unwrap();
    }

    #[test]
    #[ignore = "subprocess helper invoked by the parent lease test"]
    fn tab_session_lease_holder_subprocess() {
        let Ok(root) = std::env::var("EMEND_TAB_SESSION_CHILD_ROOT") else {
            return;
        };
        let app_local_data_dir = std::env::var("EMEND_TAB_SESSION_CHILD_DATA")
            .expect("the parent supplies an isolated app-local data directory");
        let coordinator = TabSessionCoordinator::new(app_local_data_dir.into());
        begin_tab_session_on(
            &coordinator,
            root,
            "child-writer".into(),
            "child-attachment".into(),
        )
        .unwrap();
        println!("EMEND_TAB_SESSION_LEASE_READY");
        std::io::stdout().flush().unwrap();
        let mut release = [0_u8; 1];
        let _ = std::io::stdin().read_exact(&mut release);
    }

    #[test]
    fn the_writer_lease_excludes_a_real_child_process_and_releases_after_it_is_killed() {
        let project = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let root = root_of(&project);
        let mut child = spawn_ignored_test(
            "commands::tabs::tests::tab_session_lease_holder_subprocess",
            &[
                ("EMEND_TAB_SESSION_CHILD_ROOT", root.as_ref()),
                (
                    "EMEND_TAB_SESSION_CHILD_DATA",
                    app_data.path().as_os_str(),
                ),
            ],
            "EMEND_TAB_SESSION_LEASE_READY",
        );

        let second_process = TabSessionCoordinator::new(app_data.path().to_path_buf());
        let busy = begin_tab_session_on(
            &second_process,
            root.clone(),
            "parent-writer".into(),
            "parent-attachment".into(),
        );
        assert!(matches!(busy, Err(CommandError::WriterBusy(_))));
        assert!(!project.path().join(".emend/lock.tab-session").exists());

        child.0.kill().unwrap();
        child.0.wait().unwrap();
        begin_tab_session_on(
            &second_process,
            root,
            "parent-writer".into(),
            "parent-attachment".into(),
        )
        .unwrap();
    }

    #[test]
    fn a_save_returns_the_exact_committed_session_and_advances_its_revision() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        let requested = one_tab("draft.md", Some("live draft".into()), None);

        let receipt = save_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            opened.attachment_id.clone(),
            opened.revision.clone(),
            requested.clone(),
            SessionSavePolicy::Background,
        )
        .unwrap();

        assert_ne!(receipt.revision, opened.revision);
        assert_eq!(receipt.session, requested);
        assert_eq!(
            receipt.outcomes,
            vec![TabPersistenceOutcome {
                path: "draft.md".into(),
                status: TabPersistenceStatus::PersistedExact,
            }]
        );
        assert_eq!(load_tab_session(root).unwrap(), receipt.session);
    }

    #[test]
    fn a_stale_revision_cannot_overwrite_a_newer_durable_session() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        let external = Session::new(vec![TabSnapshot::new("newer.md", None)], None);
        crate::store::tab_session::save(dir.path(), &external).unwrap();

        let result = save_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            opened.attachment_id,
            opened.revision,
            one_tab("stale.md", Some("stale".into()), None),
            SessionSavePolicy::Background,
        );

        assert!(matches!(result, Err(CommandError::RevisionConflict(_))));
        assert_eq!(load_tab_session(root).unwrap().tabs[0].path, "newer.md");
    }

    #[test]
    fn lossless_policy_refuses_an_over_cap_untitled_buffer_without_writing() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        let oversized = "x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1);

        let result = save_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            opened.attachment_id.clone(),
            opened.revision.clone(),
            one_tab("untitled:1:draft.md", Some(oversized), Some("draft.md")),
            SessionSavePolicy::RequireUntitledLossless,
        );

        assert!(matches!(
            result,
            Err(CommandError::UntitledContentOmitted(_))
        ));
        let after =
            begin_tab_session_on(&coordinator, root, "writer".into(), TEST_ATTACHMENT.into())
                .unwrap();
        assert_eq!(after.revision, opened.revision);
        assert!(after.session.tabs.is_empty());
    }

    #[test]
    fn background_policy_reports_an_over_cap_omission_honestly() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();

        let receipt = save_tab_session_on(
            &coordinator,
            root,
            "writer".into(),
            opened.attachment_id,
            opened.revision,
            one_tab(
                "untitled:1:draft.md",
                Some("x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1)),
                Some("draft.md"),
            ),
            SessionSavePolicy::Background,
        )
        .unwrap();

        assert_eq!(receipt.session.tabs[0].unsaved_content, None);
        assert_eq!(
            receipt.outcomes[0].status,
            TabPersistenceStatus::OmittedOverCap
        );
    }

    #[test]
    fn no_write_proof_returns_the_current_receipt_without_changing_revision() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        let requested = one_tab("draft.md", Some("live draft".into()), None);
        let saved = save_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            opened.attachment_id.clone(),
            opened.revision,
            requested.clone(),
            SessionSavePolicy::RequireUntitledLossless,
        )
        .unwrap();

        let proof = prove_tab_session_on(
            &coordinator,
            root,
            "writer".into(),
            opened.attachment_id,
            saved.revision.clone(),
            requested,
        )
        .unwrap();

        assert_eq!(proof, saved);
    }

    #[test]
    fn no_write_proof_refuses_a_mismatch_and_a_carried_omission() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        let coordinator = coordinator();
        let opened = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();

        let mismatch = prove_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            opened.attachment_id.clone(),
            opened.revision.clone(),
            one_tab("draft.md", None, None),
        );
        assert!(matches!(
            mismatch,
            Err(CommandError::SessionProofUnusable(_))
        ));

        let omitted = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "untitled:1:draft.md".into(),
                doc_id: None,
                unsaved_content: None,
                recovered_from: Some("draft.md".into()),
                displaced_label_ordinal: Some(1),
                unsaved_content_omitted: true,
                loss_notice_collapsed: false,
            }],
            active_path: Some("untitled:1:draft.md".into()),
        };
        crate::store::tab_session::save(
            dir.path(),
            &Session::new(
                vec![TabSnapshot::new("untitled:1:draft.md", None)
                    .displaced_from(Some("draft.md".into()))
                    .with_recovery_persistence(true, false)],
                Some("untitled:1:draft.md".into()),
            ),
        )
        .unwrap();
        let refreshed = begin_tab_session_on(
            &coordinator,
            root.clone(),
            "writer".into(),
            TEST_ATTACHMENT.into(),
        )
        .unwrap();
        let refusal = prove_tab_session_on(
            &coordinator,
            root,
            "writer".into(),
            refreshed.attachment_id,
            refreshed.revision,
            omitted,
        );
        assert!(matches!(
            refusal,
            Err(CommandError::UntitledContentOmitted(_))
        ));
    }

    #[test]
    fn loading_a_session_for_a_project_that_never_saved_one_is_empty_not_an_error() {
        let dir = TempDir::new().unwrap();

        let payload = load_tab_session(root_of(&dir)).unwrap();

        assert!(payload.tabs.is_empty());
        assert_eq!(payload.active_path, None);
    }

    /// The frontend keeps a document displaced by an external move (#932, CJ 2026-08-11) as an
    /// untitled recovery document whose identity is deliberately not a project path, and the only
    /// durable copy of that unsaved work is this session snapshot. That durability claim rests on
    /// this boundary: §3.5 confinement runs over every tab path on save *and* again on restore, so
    /// an identity it rejected would be silently dropped and the work lost at the next relaunch.
    #[test]
    fn an_untitled_recovery_identity_round_trips_and_survives_restore_confinement() {
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "untitled:1:notes/b.md".into(),
                doc_id: None,
                unsaved_content: Some("displaced unsaved work".into()),
                recovered_from: Some("notes/b.md".into()),
                displaced_label_ordinal: Some(1),
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: Some("untitled:1:notes/b.md".into()),
        };

        save_tab_session(root_of(&dir), session.clone()).unwrap();
        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded, session);
    }

    #[test]
    fn save_then_load_round_trips_the_whole_session_through_the_ipc_shape() {
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![
                TabSnapshotPayload {
                    path: "a.md".into(),
                    doc_id: None,
                    unsaved_content: None,
                    recovered_from: None,
                    displaced_label_ordinal: None,
                    unsaved_content_omitted: false,
                    loss_notice_collapsed: false,
                },
                TabSnapshotPayload {
                    path: "b.md".into(),
                    doc_id: None,
                    unsaved_content: Some("unsaved b".into()),
                    recovered_from: None,
                    displaced_label_ordinal: None,
                    unsaved_content_omitted: false,
                    loss_notice_collapsed: false,
                },
            ],
            active_path: Some("b.md".into()),
        };

        save_tab_session(root_of(&dir), session.clone()).unwrap();
        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded, session);
    }

    #[test]
    fn saving_a_session_rejects_a_recovered_from_path_escaping_root() {
        // A recovery document's identity is deliberately not a project path, but the path it is
        // *named for* is one and is shown to the author — so it is confined like any other, and a
        // session file arriving from elsewhere cannot make the app display a foreign path (#932).
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "untitled:1:escape.md".into(),
                doc_id: None,
                unsaved_content: Some("displaced unsaved work".into()),
                recovered_from: Some("../escape.md".into()),
                displaced_label_ordinal: Some(1),
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: None,
        };

        let err = save_tab_session(root_of(&dir), session);

        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    #[test]
    fn loading_a_session_drops_a_tab_whose_recovered_from_escapes_root() {
        let dir = TempDir::new().unwrap();
        let foreign = Session::new(
            vec![
                TabSnapshot::new("fine.md", None),
                TabSnapshot::new("untitled:1:escape.md", Some("displaced".into()))
                    .displaced_from(Some("../escape.md".into())),
            ],
            None,
        );
        crate::store::tab_session::save(dir.path(), &foreign).unwrap();

        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded.tabs.len(), 1);
        assert_eq!(loaded.tabs[0].path, "fine.md");
    }

    #[test]
    fn saving_a_session_rejects_a_tab_path_escaping_root() {
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "../escape.md".into(),
                doc_id: None,
                unsaved_content: None,
                recovered_from: None,
                displaced_label_ordinal: None,
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: None,
        };

        let err = save_tab_session(root_of(&dir), session);

        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    #[test]
    fn saving_a_session_rejects_an_active_path_escaping_root() {
        // `active_path` is never used as a filesystem path (it's only matched against restored
        // tab paths on the frontend), but confinement is validated whole-session, not just the
        // fields that happen to be exploitable today — defense in depth at the IPC boundary.
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "fine.md".into(),
                doc_id: None,
                unsaved_content: None,
                recovered_from: None,
                displaced_label_ordinal: None,
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: Some("../escape.md".into()),
        };

        let err = save_tab_session(root_of(&dir), session);

        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    #[test]
    fn saving_a_session_with_an_escaping_path_writes_nothing_at_all() {
        // Whole-session validation, not per-tab: a bad path among good ones refuses the save
        // entirely rather than silently dropping just the offending tab.
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![
                TabSnapshotPayload {
                    path: "fine.md".into(),
                    doc_id: None,
                    unsaved_content: None,
                    recovered_from: None,
                    displaced_label_ordinal: None,
                    unsaved_content_omitted: false,
                    loss_notice_collapsed: false,
                },
                TabSnapshotPayload {
                    path: "../escape.md".into(),
                    doc_id: None,
                    unsaved_content: None,
                    recovered_from: None,
                    displaced_label_ordinal: None,
                    unsaved_content_omitted: false,
                    loss_notice_collapsed: false,
                },
            ],
            active_path: None,
        };

        assert!(save_tab_session(root_of(&dir), session).is_err());

        let loaded = load_tab_session(root_of(&dir)).unwrap();
        assert!(loaded.tabs.is_empty());
    }

    #[test]
    fn loading_a_session_drops_a_tab_whose_path_escapes_root() {
        // `store::tab_session::save` (unlike the `save_tab_session` command) does not confine —
        // this simulates a tab-session.json that arrived some way other than this project's own
        // `save_tab_session` calls (e.g. a non-git, non-gitignore-respecting sync tool delivering a
        // different project's or machine's file), a structurally valid session naming an escaping
        // path (CJ ruling, #143).
        let dir = TempDir::new().unwrap();
        let foreign = Session::new(
            vec![
                TabSnapshot::new("fine.md", None),
                TabSnapshot::new("../escape.md", None),
            ],
            None,
        );
        crate::store::tab_session::save(dir.path(), &foreign).unwrap();

        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded.tabs.len(), 1);
        assert_eq!(loaded.tabs[0].path, "fine.md");
    }

    #[test]
    fn loading_a_session_clears_active_path_when_it_names_a_dropped_tab() {
        let dir = TempDir::new().unwrap();
        let foreign = Session::new(
            vec![TabSnapshot::new("../escape.md", None)],
            Some("../escape.md".to_string()),
        );
        crate::store::tab_session::save(dir.path(), &foreign).unwrap();

        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert!(loaded.tabs.is_empty());
        assert_eq!(loaded.active_path, None);
    }

    #[test]
    fn loading_a_session_keeps_the_active_path_when_it_still_names_a_surviving_tab() {
        let dir = TempDir::new().unwrap();
        let foreign = Session::new(
            vec![
                TabSnapshot::new("fine.md", None),
                TabSnapshot::new("../escape.md", None),
            ],
            Some("fine.md".to_string()),
        );
        crate::store::tab_session::save(dir.path(), &foreign).unwrap();

        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded.active_path, Some("fine.md".to_string()));
    }

    #[test]
    fn saving_a_session_enforces_the_per_tab_unsaved_content_cap() {
        use crate::store::tab_session::UNSAVED_CONTENT_CAP_BYTES;
        let dir = TempDir::new().unwrap();
        let oversized = "x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1);
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "big.md".into(),
                doc_id: None,
                unsaved_content: Some(oversized),
                recovered_from: None,
                displaced_label_ordinal: None,
                unsaved_content_omitted: false,
                loss_notice_collapsed: false,
            }],
            active_path: None,
        };

        save_tab_session(root_of(&dir), session).unwrap();
        let loaded = load_tab_session(root_of(&dir)).unwrap();

        assert_eq!(loaded.tabs[0].unsaved_content, None);
        assert!(loaded.tabs[0].unsaved_content_omitted);
    }

    #[test]
    fn over_cap_recovery_state_and_collapsed_notice_round_trip_through_ipc() {
        let dir = TempDir::new().unwrap();
        let session = SessionPayload {
            tabs: vec![TabSnapshotPayload {
                path: "untitled:1:b.md".into(),
                doc_id: None,
                unsaved_content: None,
                recovered_from: Some("b.md".into()),
                displaced_label_ordinal: Some(1),
                unsaved_content_omitted: true,
                loss_notice_collapsed: true,
            }],
            active_path: Some("untitled:1:b.md".into()),
        };

        save_tab_session(root_of(&dir), session.clone()).unwrap();

        assert_eq!(load_tab_session(root_of(&dir)).unwrap(), session);
    }
}
