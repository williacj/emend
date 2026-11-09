// ABOUTME: Thin IPC over the machine-local adoption lifecycle and idempotent D15 projection.
// ABOUTME: Confines paths, serializes one event writer, and exposes awaited durability boundaries.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;
use textops::Revision;

use crate::agent::project::SharedOpenProject;
use crate::store::service::{AdoptionLandingError, SidecarError, SidecarStore};
use crate::store::{adoption, project_identity, transcript};

use super::path_confine::{confine, identity_relative};

pub struct AdoptionCoordinator {
    app_local_data_dir: PathBuf,
    writer: Mutex<()>,
}

impl AdoptionCoordinator {
    pub fn new(app_local_data_dir: PathBuf) -> AdoptionCoordinator {
        AdoptionCoordinator {
            app_local_data_dir,
            writer: Mutex::new(()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    Invalid(String),
    Io(String),
}

/// Mints the path-independent TD-4 identity an editable untitled document checkpoints before its
/// first comment or change write (#1803). Minting creates no path mapping and no sidecar file.
pub fn mint_untitled_doc_id_on(root: String) -> Result<String, CommandError> {
    let canonical = project_identity::require_canonical_root(Path::new(&root))
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    Ok(SidecarStore::new(canonical).mint_doc_id().to_string())
}

#[tauri::command]
pub fn mint_untitled_doc_id(root: String) -> Result<String, CommandError> {
    mint_untitled_doc_id_on(root)
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        CommandError::Io(error.to_string())
    }
}

fn paths(coordinator: &AdoptionCoordinator, root: &str) -> (PathBuf, PathBuf) {
    (
        adoption::adoption_file(&coordinator.app_local_data_dir, Path::new(root)),
        transcript::transcript_file(&coordinator.app_local_data_dir, Path::new(root)),
    )
}

#[allow(clippy::too_many_arguments)] // The durable event fields deliberately mirror the IPC wire shape.
pub fn prepare_adoption_on(
    coordinator: &AdoptionCoordinator,
    root: String,
    adoption_id: String,
    displaced_path: String,
    destination: String,
    doc_id: String,
    recovery_content_omitted: bool,
    content: String,
    timestamp: String,
) -> Result<String, CommandError> {
    if adoption_id.trim().is_empty() || timestamp.trim().is_empty() {
        return Err(CommandError::Invalid(
            "adoption id and timestamp must be non-empty".into(),
        ));
    }
    confine(Path::new(&root), &displaced_path)
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    let destination_path = confine(Path::new(&root), &destination)
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    let destination = identity_relative(Path::new(&root), &destination_path)
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    let doc_id = uuid::Uuid::parse_str(&doc_id)
        .map_err(|error| CommandError::Invalid(format!("invalid untitled document id: {error}")))?;
    let _guard = coordinator
        .writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let store = SidecarStore::new(&root);
    store
        .ensure_adoption_destination_available(doc_id, &destination)
        .map_err(|error| match error {
            SidecarError::PathAlreadyClaimed { .. } => CommandError::Invalid(format!(
                "destination {destination:?} is already owned by another document"
            )),
            error => CommandError::Io(error.to_string()),
        })?;
    let event = adoption::AdoptionEvent {
        adoption_id,
        displaced_path,
        destination: destination.clone(),
        doc_id: doc_id.to_string(),
        recovery_content_omitted,
        moved_comment_count: 0,
        expected_revision: Revision::of(&content).as_str().into(),
        destination_existed_before: destination_path.exists(),
        landing_started: false,
        timestamp,
        phase: adoption::AdoptionPhase::Prepared,
    };
    let (event_path, _) = paths(coordinator, &root);
    adoption::prepare(&event_path, event)?;
    Ok(destination)
}

pub fn commit_adoption_on(
    coordinator: &AdoptionCoordinator,
    root: String,
    adoption_id: String,
    landed_revision: String,
) -> Result<(), CommandError> {
    let _guard = coordinator
        .writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (event_path, _) = paths(coordinator, &root);
    adoption::mark_file_committed(&event_path, &adoption_id, &landed_revision)?;
    Ok(())
}

/// Lands a prepared untitled Save As while the destination's docs-map ownership is held from the
/// final compare through the atomic file replacement. This is deliberately distinct from an
/// ordinary save: only a prepared adoption has a pathless UUID that must win bytes and identity as
/// one transition.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandAdoptionReceipt {
    pub revision: String,
    pub destination: String,
    pub pending: bool,
}

pub fn land_adoption_on(
    coordinator: &AdoptionCoordinator,
    session: &SharedOpenProject,
    root: String,
    adoption_id: String,
    content: String,
) -> Result<LandAdoptionReceipt, CommandError> {
    let _guard = coordinator
        .writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (event_path, _) = paths(coordinator, &root);
    let event = adoption::event(&event_path, &adoption_id)?;
    if event.phase != adoption::AdoptionPhase::Prepared {
        return Err(CommandError::Invalid(
            "only a prepared adoption can land a document".into(),
        ));
    }
    let doc_id = uuid::Uuid::parse_str(&event.doc_id)
        .map_err(|error| CommandError::Invalid(format!("invalid untitled document id: {error}")))?;
    if Revision::of(&content).as_str() != event.expected_revision {
        return Err(CommandError::Invalid(
            "adoption content changed after preparation".into(),
        ));
    }
    let root_path = Path::new(&root);
    let confined = confine(root_path, &event.destination)
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    let destination = identity_relative(root_path, &confined)
        .map_err(|error| CommandError::Invalid(error.to_string()))?;
    struct LandedDocument {
        revision: String,
        phase_pending: bool,
    }

    let landing = SidecarStore::new(root_path)
        .land_adoption_with(doc_id, &destination, |claimed_destination| {
            adoption::mark_landing_started(&event_path, &adoption_id, claimed_destination)
                .map_err(|error| super::document::CommandError::Io(error.to_string()))?;
            let revision = super::document::save_document_on(
                session,
                root.clone(),
                claimed_destination.to_string(),
                content,
                false,
            )?;
            // Keep phase durability inside the same identity-lock boundary as the file landing.
            // If map publication fails, a racing claimant cannot enter before reconciliation has
            // a FileCommitted receipt for the scratch UUID.
            let phase_pending =
                adoption::mark_file_committed(&event_path, &adoption_id, &revision).is_err();
            Ok(LandedDocument {
                revision,
                phase_pending,
            })
        })
        .map_err(|error| match error {
            AdoptionLandingError::Store(SidecarError::PathAlreadyClaimed { .. }) => {
                CommandError::Invalid(format!(
                    "destination {destination:?} is already owned by another document"
                ))
            }
            AdoptionLandingError::Store(error) => CommandError::Io(error.to_string()),
            AdoptionLandingError::Write(error) => command_error_from_document(error),
        })?;
    // Both failures occur after the bytes landed, so neither may enter the frontend's cancellable
    // no-write path. The receipt keeps that distinction explicit: FileCommitted can repair a map
    // failure, while a matching post-write map proves landing if phase persistence failed.
    Ok(LandAdoptionReceipt {
        revision: landing.value.revision,
        destination: landing.destination,
        pending: landing.mapping_pending || landing.value.phase_pending,
    })
}

fn command_error_from_document(error: super::document::CommandError) -> CommandError {
    use super::document::CommandError as DocumentError;
    match error {
        DocumentError::InvalidPath(message) | DocumentError::InvalidDocument(message) => {
            CommandError::Invalid(message)
        }
        DocumentError::Io(message)
        | DocumentError::WriterBusy(message)
        | DocumentError::WriterLost(message)
        | DocumentError::RevisionConflict(message)
        | DocumentError::UntitledContentOmitted(message)
        | DocumentError::SessionProofUnusable(message)
        | DocumentError::History(message) => CommandError::Io(message),
    }
}

pub fn cancel_adoption_on(
    coordinator: &AdoptionCoordinator,
    root: String,
    adoption_id: String,
) -> Result<(), CommandError> {
    let _guard = coordinator
        .writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (event_path, _) = paths(coordinator, &root);
    if let Some((doc_id, destination)) = adoption::tombstone(&event_path, &adoption_id)? {
        let doc_id = uuid::Uuid::parse_str(&doc_id).map_err(|error| {
            CommandError::Invalid(format!("invalid untitled document id: {error}"))
        })?;
        SidecarStore::new(&root)
            .release_adoption_reservation(doc_id, &destination)
            .map_err(|error| CommandError::Io(error.to_string()))?;
    }
    Ok(())
}

pub fn reconcile_adoptions_on(
    coordinator: &AdoptionCoordinator,
    root: String,
) -> Result<adoption::Reconciliation, CommandError> {
    let _guard = coordinator
        .writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (event_path, transcript_path) = paths(coordinator, &root);
    Ok(adoption::reconcile(
        &event_path,
        &transcript_path,
        Path::new(&root),
    )?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes the durable event fields as named arguments.
pub fn prepare_adoption(
    coordinator: State<'_, AdoptionCoordinator>,
    root: String,
    adoption_id: String,
    displaced_path: String,
    destination: String,
    doc_id: String,
    recovery_content_omitted: bool,
    content: String,
    timestamp: String,
) -> Result<String, CommandError> {
    prepare_adoption_on(
        &coordinator,
        root,
        adoption_id,
        displaced_path,
        destination,
        doc_id,
        recovery_content_omitted,
        content,
        timestamp,
    )
}

#[tauri::command]
pub fn commit_adoption(
    coordinator: State<'_, AdoptionCoordinator>,
    root: String,
    adoption_id: String,
    landed_revision: String,
) -> Result<(), CommandError> {
    commit_adoption_on(&coordinator, root, adoption_id, landed_revision)
}

#[tauri::command]
pub fn land_adoption(
    coordinator: State<'_, AdoptionCoordinator>,
    session: State<'_, SharedOpenProject>,
    root: String,
    adoption_id: String,
    content: String,
) -> Result<LandAdoptionReceipt, CommandError> {
    land_adoption_on(&coordinator, &session, root, adoption_id, content)
}

#[tauri::command]
pub fn cancel_adoption(
    coordinator: State<'_, AdoptionCoordinator>,
    root: String,
    adoption_id: String,
) -> Result<(), CommandError> {
    cancel_adoption_on(&coordinator, root, adoption_id)
}

#[tauri::command]
pub fn reconcile_adoptions(
    coordinator: State<'_, AdoptionCoordinator>,
    root: String,
) -> Result<adoption::Reconciliation, CommandError> {
    reconcile_adoptions_on(&coordinator, root)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn minting_an_untitled_identity_creates_no_path_mapping_or_sidecar_files() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();

        let id = mint_untitled_doc_id_on(root.to_string_lossy().into_owned()).unwrap();

        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert!(!root.join(".emend/docs.json").exists());
        assert!(!root.join(".emend/comments").exists());
        assert!(!root.join(".emend/changes").exists());
    }

    #[test]
    fn prepared_file_commit_reconciles_once_through_the_command_boundary() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let root_string = root.to_string_lossy().into_owned();
        let content = "new work after omission";
        let doc_id = SidecarStore::new(&root).mint_doc_id();
        crate::commands::comments::create_comment_by_id(
            root_string.clone(),
            doc_id.to_string(),
            content.into(),
            "you".into(),
            "keep this".into(),
            None,
            1,
        )
        .unwrap();

        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "new.md".into(),
            doc_id.to_string(),
            true,
            content.into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();
        let session: SharedOpenProject = std::sync::Arc::new(std::sync::Mutex::new(None));
        let landed_revision = land_adoption_on(
            &coordinator,
            &session,
            root_string.clone(),
            "a1".into(),
            content.into(),
        )
        .unwrap();
        commit_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            landed_revision.revision,
        )
        .unwrap();

        let first = reconcile_adoptions_on(&coordinator, root_string.clone()).unwrap();
        assert_eq!(first.published.len(), 1);
        assert_eq!(first.published[0].kind, "untitled-adoption");
        assert_eq!(
            first.published[0].fields.get("movedCommentCount"),
            Some(&serde_json::json!(1))
        );
        assert_eq!(
            SidecarStore::new(&root)
                .path_for(doc_id)
                .unwrap()
                .as_deref(),
            Some("new.md")
        );
        assert_eq!(
            first.published[0]
                .fields
                .get("adoptionId")
                .and_then(serde_json::Value::as_str),
            Some("a1"),
        );
        assert!(reconcile_adoptions_on(&coordinator, root_string)
            .unwrap()
            .published
            .is_empty());
    }

    #[test]
    fn prepare_refuses_an_escaping_destination_before_writing_an_event() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let app_data = dir.path().join("app-data");
        let coordinator = AdoptionCoordinator::new(app_data.clone());

        let result = prepare_adoption_on(
            &coordinator,
            root.to_string_lossy().into_owned(),
            "a1".into(),
            "old.md".into(),
            "../outside.md".into(),
            uuid::Uuid::new_v4().to_string(),
            false,
            "body".into(),
            "2026-08-27T00:00:00.000Z".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert!(!app_data.exists());
    }

    #[test]
    fn prepare_refuses_a_destination_owned_by_another_document_before_writing_an_event() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let app_data = dir.path().join("app-data");
        let coordinator = AdoptionCoordinator::new(app_data.clone());
        let store = SidecarStore::new(&root);
        let existing = store.get_or_mint_for_path("taken.md").unwrap();
        let scratch = store.mint_doc_id();

        let result = prepare_adoption_on(
            &coordinator,
            root.to_string_lossy().into_owned(),
            "a1".into(),
            "old.md".into(),
            "taken.md".into(),
            scratch.to_string(),
            false,
            "scratch body".into(),
            "2026-08-27T00:00:00.000Z".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert_eq!(store.doc_id_for_path("taken.md").unwrap(), Some(existing));
        assert_eq!(store.path_for(scratch).unwrap(), None);
        assert!(!app_data.exists());
    }

    #[test]
    fn prepare_uses_the_filesystem_identity_without_publishing_the_scratch_uuid() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("notes")).unwrap();
        let app_data = dir.path().join("app-data");
        let coordinator = AdoptionCoordinator::new(app_data);
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();

        let destination = prepare_adoption_on(
            &coordinator,
            root.to_string_lossy().into_owned(),
            "a1".into(),
            "old.md".into(),
            "./notes/new.md".into(),
            scratch.to_string(),
            false,
            "scratch body".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();

        assert_eq!(destination, "notes/new.md");
        assert_eq!(store.doc_id_for_path("notes/new.md").unwrap(), None);
        assert_eq!(store.doc_id_for_path("./notes/new.md").unwrap(), None);
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }

    #[test]
    fn cancelling_a_prepared_write_keeps_its_scratch_uuid_pathless() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();
        let root_string = root.to_string_lossy().into_owned();
        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "new.md".into(),
            scratch.to_string(),
            false,
            "scratch body".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();
        assert_eq!(store.doc_id_for_path("new.md").unwrap(), None);

        cancel_adoption_on(&coordinator, root_string, "a1".into()).unwrap();

        assert_eq!(store.path_for(scratch).unwrap(), None);
        assert_eq!(store.doc_id_for_path("new.md").unwrap(), None);
    }

    #[test]
    fn prepared_crash_over_a_preexisting_file_keeps_scratch_history_pathless() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("new.md"), "INCUMBENT BODY").unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let root_string = root.to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();
        crate::commands::comments::create_comment_by_id(
            root_string.clone(),
            scratch.to_string(),
            "SCRATCH BODY".into(),
            "you".into(),
            "scratch history".into(),
            None,
            1,
        )
        .unwrap();

        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "new.md".into(),
            scratch.to_string(),
            false,
            "SCRATCH BODY".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();

        // Simulate process loss after production preparation but before the file write.
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "INCUMBENT BODY"
        );
        assert_eq!(store.doc_id_for_path("new.md").unwrap(), None);
        let result = reconcile_adoptions_on(&coordinator, root_string.clone()).unwrap();
        assert_eq!(result.pending_destinations, vec!["new.md"]);
        assert_eq!(store.path_for(scratch).unwrap(), None);

        let incumbent_threads = crate::commands::comments::load_comment_threads_on(
            &root_string,
            "new.md",
            &Default::default(),
            &crate::commands::comments::ReconciledDocs::default(),
            || 2,
        )
        .unwrap();
        assert!(incumbent_threads.is_empty());
        let scratch_threads = crate::commands::comments::load_comment_threads_by_id(
            root_string,
            scratch.to_string(),
            "SCRATCH BODY".into(),
        )
        .unwrap();
        assert_eq!(scratch_threads.len(), 1);
        assert_eq!(scratch_threads[0].body, "scratch history");
    }

    #[test]
    fn a_post_prepare_claimant_is_refused_before_scratch_bytes_can_replace_its_file() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let session: SharedOpenProject = std::sync::Arc::new(std::sync::Mutex::new(None));
        let root_string = root.to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();
        crate::commands::comments::create_comment_by_id(
            root_string.clone(),
            scratch.to_string(),
            "SCRATCH BODY".into(),
            "you".into(),
            "scratch history".into(),
            None,
            1,
        )
        .unwrap();
        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "new.md".into(),
            scratch.to_string(),
            false,
            "SCRATCH BODY".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();

        // A different document lands and creates history after prepare but before adoption lands.
        fs::write(root.join("new.md"), "INCUMBENT BODY").unwrap();
        crate::commands::comments::create_comment(
            root_string.clone(),
            "new.md".into(),
            "you".into(),
            "incumbent history".into(),
            None,
            2,
        )
        .unwrap();
        let incumbent = store.doc_id_for_path("new.md").unwrap().unwrap();

        let result = land_adoption_on(
            &coordinator,
            &session,
            root_string.clone(),
            "a1".into(),
            "SCRATCH BODY".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "INCUMBENT BODY"
        );
        assert_eq!(store.doc_id_for_path("new.md").unwrap(), Some(incumbent));
        assert_eq!(store.path_for(scratch).unwrap(), None);
        let incumbent_threads = crate::commands::comments::load_comment_threads_on(
            &root_string,
            "new.md",
            &Default::default(),
            &crate::commands::comments::ReconciledDocs::default(),
            || 3,
        )
        .unwrap();
        assert_eq!(incumbent_threads[0].body, "incumbent history");
        let scratch_threads = crate::commands::comments::load_comment_threads_by_id(
            root_string,
            scratch.to_string(),
            "SCRATCH BODY".into(),
        )
        .unwrap();
        assert_eq!(scratch_threads[0].body, "scratch history");
    }

    #[cfg(windows)]
    #[test]
    fn prepare_refuses_a_windows_case_alias_of_an_owned_destination() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("Notes")).unwrap();
        fs::write(root.join("Notes/Owned.md"), "existing").unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let store = SidecarStore::new(&root);
        let existing = store.get_or_mint_for_path("Notes/Owned.md").unwrap();
        let scratch = store.mint_doc_id();

        let result = prepare_adoption_on(
            &coordinator,
            root.to_string_lossy().into_owned(),
            "a1".into(),
            "old.md".into(),
            "notes/owned.md".into(),
            scratch.to_string(),
            false,
            "scratch body".into(),
            "2026-08-27T00:00:00.000Z".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert_eq!(
            store.doc_id_for_path("Notes/Owned.md").unwrap(),
            Some(existing)
        );
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn landing_refuses_a_windows_case_alias_claimed_after_prepare_without_overwriting() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(root.join("Notes")).unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let session: SharedOpenProject = std::sync::Arc::new(std::sync::Mutex::new(None));
        let root_string = root.to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();
        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "notes/claimed.md".into(),
            scratch.to_string(),
            false,
            "SCRATCH BODY".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();
        fs::write(root.join("Notes/Claimed.md"), "INCUMBENT BODY").unwrap();
        crate::commands::comments::create_comment(
            root_string.clone(),
            "notes/claimed.md".into(),
            "you".into(),
            "incumbent history".into(),
            None,
            2,
        )
        .unwrap();
        let incumbent = store.doc_id_for_path("Notes/Claimed.md").unwrap().unwrap();

        let result = land_adoption_on(
            &coordinator,
            &session,
            root_string,
            "a1".into(),
            "SCRATCH BODY".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert_eq!(
            fs::read_to_string(root.join("notes/claimed.md")).unwrap(),
            "INCUMBENT BODY"
        );
        assert_eq!(
            store.doc_id_for_path("Notes/Claimed.md").unwrap(),
            Some(incumbent)
        );
        assert_eq!(store.tracked_paths().unwrap(), vec!["Notes/Claimed.md"]);
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn landing_refuses_a_missing_windows_unicode_case_alias_claimed_after_prepare() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let coordinator = AdoptionCoordinator::new(dir.path().join("app-data"));
        let session: SharedOpenProject = std::sync::Arc::new(std::sync::Mutex::new(None));
        let root_string = root.to_string_lossy().into_owned();
        let store = SidecarStore::new(&root);
        let scratch = store.mint_doc_id();
        prepare_adoption_on(
            &coordinator,
            root_string.clone(),
            "a1".into(),
            "old.md".into(),
            "notes/ä.md".into(),
            scratch.to_string(),
            false,
            "SCRATCH BODY".into(),
            "2026-08-27T00:00:00.000Z".into(),
        )
        .unwrap();
        let incumbent = store.get_or_mint_for_path("Notes/Ä.md").unwrap();

        let result = land_adoption_on(
            &coordinator,
            &session,
            root_string,
            "a1".into(),
            "SCRATCH BODY".into(),
        );

        assert!(matches!(result, Err(CommandError::Invalid(_))));
        assert!(!root.join("notes/ä.md").exists());
        assert_eq!(
            store.doc_id_for_path("notes/ä.md").unwrap(),
            Some(incumbent)
        );
        assert_eq!(store.tracked_paths().unwrap(), vec!["Notes/Ä.md"]);
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }
}
