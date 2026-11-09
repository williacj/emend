// ABOUTME: Durable machine-local lifecycle for omission-aware UntitledDocument Save As adoption.
// ABOUTME: Persists prepared/file-committed/published phases and idempotent D15 projections.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use textops::Revision;

use super::service::{SidecarError, SidecarStore};
use super::{atomic, project_identity, transcript};

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptionPhase {
    Prepared,
    FileCommitted,
    SidecarsAdopted,
    Published,
    Tombstoned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionEvent {
    pub adoption_id: String,
    pub displaced_path: String,
    pub destination: String,
    /// Path-independent scratch identity. Empty only in schema-v1 records written before #1803.
    #[serde(default)]
    pub doc_id: String,
    #[serde(default)]
    pub recovery_content_omitted: bool,
    #[serde(default)]
    pub moved_comment_count: usize,
    pub expected_revision: String,
    pub destination_existed_before: bool,
    /// Internal WAL receipt set under the docs-map lock immediately before file landing begins.
    /// It distinguishes current post-write mappings from the short-lived legacy prepare-time
    /// reservations that must still be released conservatively.
    #[serde(default)]
    pub landing_started: bool,
    pub timestamp: String,
    pub phase: AdoptionPhase,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdoptionLog {
    schema_version: u32,
    events: Vec<AdoptionEvent>,
}

/// The app-local-data area this store's per-project directories live in.
const AREA: &str = "adoptions";

/// `<app_local_data_dir>/adoptions/<project_key(root)>/events.json`, keyed by the one
/// project-identity rule every app-local-data store shares (`store::project_identity`).
pub fn adoption_file(app_local_data_dir: &Path, root: &Path) -> PathBuf {
    project_identity::project_dir(app_local_data_dir, AREA, root).join("events.json")
}

fn load(path: &Path) -> io::Result<AdoptionLog> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AdoptionLog {
                schema_version: SCHEMA_VERSION,
                events: Vec::new(),
            });
        }
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn save(path: &Path, log: &AdoptionLog) -> io::Result<()> {
    atomic::write_json(path, log)
}

pub fn prepare(path: &Path, event: AdoptionEvent) -> io::Result<()> {
    let mut log = load(path)?;
    if log
        .events
        .iter()
        .any(|existing| existing.adoption_id == event.adoption_id)
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "adoption id already exists",
        ));
    }
    log.schema_version = SCHEMA_VERSION;
    log.events.push(event);
    save(path, &log)
}

pub fn event(path: &Path, adoption_id: &str) -> io::Result<AdoptionEvent> {
    load(path)?
        .events
        .into_iter()
        .find(|event| event.adoption_id == adoption_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "adoption event not found"))
}

pub fn mark_landing_started(path: &Path, adoption_id: &str, destination: &str) -> io::Result<()> {
    let mut log = load(path)?;
    let event = log
        .events
        .iter_mut()
        .find(|event| event.adoption_id == adoption_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "adoption event not found"))?;
    if event.phase != AdoptionPhase::Prepared {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "only a prepared adoption can begin landing",
        ));
    }
    event.destination = destination.to_string();
    event.landing_started = true;
    save(path, &log)
}

pub fn mark_file_committed(path: &Path, adoption_id: &str, revision: &str) -> io::Result<()> {
    let mut log = load(path)?;
    let event = log
        .events
        .iter_mut()
        .find(|event| event.adoption_id == adoption_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "adoption event not found"))?;
    if event.expected_revision != revision {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "landed revision does not match prepared content",
        ));
    }
    event.phase = AdoptionPhase::FileCommitted;
    save(path, &log)
}

pub fn tombstone(path: &Path, adoption_id: &str) -> io::Result<Option<(String, String)>> {
    let mut log = load(path)?;
    let event = log
        .events
        .iter_mut()
        .find(|event| event.adoption_id == adoption_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "adoption event not found"))?;
    let reservation = (event.phase == AdoptionPhase::Prepared && !event.doc_id.is_empty())
        .then(|| (event.doc_id.clone(), event.destination.clone()));
    event.phase = AdoptionPhase::Tombstoned;
    save(path, &log)?;
    Ok(reservation)
}

fn projection(event: &AdoptionEvent) -> transcript::TranscriptEvent {
    let mut fields = serde_json::Map::new();
    fields.insert("adoptionId".into(), serde_json::json!(event.adoption_id));
    fields.insert(
        "displacedPath".into(),
        serde_json::json!(event.displaced_path),
    );
    fields.insert("destination".into(), serde_json::json!(event.destination));
    fields.insert(
        "recoveryContentOmitted".into(),
        serde_json::json!(event.recovery_content_omitted),
    );
    fields.insert(
        "movedCommentCount".into(),
        serde_json::json!(event.moved_comment_count),
    );
    transcript::TranscriptEvent {
        schema_version: transcript::SCHEMA_VERSION,
        id: format!("adoption-{}", event.adoption_id),
        kind: "untitled-adoption".into(),
        timestamp: event.timestamp.clone(),
        fields,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionCollision {
    pub destination: String,
    pub doc_id: String,
    pub existing_doc_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation {
    pub published: Vec<transcript::TranscriptEvent>,
    pub pending_destinations: Vec<String>,
    pub collisions: Vec<AdoptionCollision>,
}

/// Reconciles every nonterminal event and publishes each D15 projection exactly once by adoptionId.
pub fn reconcile(
    event_path: &Path,
    transcript_path: &Path,
    root: &Path,
) -> io::Result<Reconciliation> {
    let mut log = load(event_path)?;
    // The event log is the durable record; the D15 transcript is only its rebuildable projection.
    // If that projection cannot be read, preserve every projectable destination as pending rather
    // than letting a transcript failure hide durable work from the relaunch UI.
    let mut existing = transcript::read_all(transcript_path).ok();
    let mut result = Reconciliation::default();
    let mut changed = false;
    for event in &mut log.events {
        if event.phase == AdoptionPhase::Prepared {
            let destination = root.join(&event.destination);
            // Current writers publish this mapping only after the source bytes land while holding
            // the docs-map lock. It is therefore a durable post-write receipt, including for a
            // destination that existed before prepare. Without it, the prior conservative rules
            // remain: equal pre-existing bytes alone are ambiguous.
            let scratch_mapping_proves_landing = event.landing_started
                && uuid::Uuid::parse_str(&event.doc_id)
                    .ok()
                    .and_then(|id| {
                        SidecarStore::new(root)
                            .doc_id_for_path(&event.destination)
                            .ok()
                            .flatten()
                            .map(|mapped| mapped == id)
                    })
                    .unwrap_or(false);
            if scratch_mapping_proves_landing {
                event.phase = AdoptionPhase::FileCommitted;
                changed = true;
            } else {
                match fs::read_to_string(&destination) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        if let Ok(id) = uuid::Uuid::parse_str(&event.doc_id) {
                            SidecarStore::new(root)
                                .release_adoption_reservation(id, &event.destination)
                                .map_err(|error| io::Error::other(error.to_string()))?;
                        }
                        event.phase = AdoptionPhase::Tombstoned;
                        changed = true;
                    }
                    Ok(content)
                        if !event.destination_existed_before
                            && Revision::of(&content).as_str() == event.expected_revision =>
                    {
                        event.phase = AdoptionPhase::FileCommitted;
                        changed = true;
                    }
                    _ => {
                        // Old builds briefly published a scratch mapping during prepare. Ambiguous
                        // bytes must never inherit that identity; release only this event's mapping.
                        // If another owner has since claimed the path, the conditional release is a
                        // no-op and its incumbent history remains authoritative.
                        if let Ok(id) = uuid::Uuid::parse_str(&event.doc_id) {
                            SidecarStore::new(root)
                                .release_adoption_reservation(id, &event.destination)
                                .map_err(|error| io::Error::other(error.to_string()))?;
                        }
                        result.pending_destinations.push(event.destination.clone());
                    }
                }
            }
        }
        if event.phase == AdoptionPhase::FileCommitted {
            // Schema-v1 omission events predate pathless sidecar identity. They have nothing to
            // adopt and retain their established projection behavior.
            if event.doc_id.is_empty() {
                event.phase = AdoptionPhase::SidecarsAdopted;
                changed = true;
            } else {
                let Ok(id) = uuid::Uuid::parse_str(&event.doc_id) else {
                    result.pending_destinations.push(event.destination.clone());
                    continue;
                };
                let store = SidecarStore::new(root);
                match store.adopt_after_file_landed(id, &event.destination) {
                    Ok(()) => {}
                    Err(SidecarError::PathAlreadyClaimed { existing, .. }) => {
                        result.pending_destinations.push(event.destination.clone());
                        result.collisions.push(AdoptionCollision {
                            destination: event.destination.clone(),
                            doc_id: id.to_string(),
                            existing_doc_id: existing.to_string(),
                        });
                        continue;
                    }
                    Err(_) => {
                        result.pending_destinations.push(event.destination.clone());
                        continue;
                    }
                }
                let Ok(disposition) = store.sidecar_disposition(id) else {
                    result.pending_destinations.push(event.destination.clone());
                    continue;
                };
                event.moved_comment_count = disposition.thread_count;
                event.phase = AdoptionPhase::SidecarsAdopted;
                changed = true;
            }
        }
        if !matches!(
            event.phase,
            AdoptionPhase::SidecarsAdopted | AdoptionPhase::Published
        ) {
            continue;
        }
        let Some(existing) = existing.as_mut() else {
            result.pending_destinations.push(event.destination.clone());
            continue;
        };
        let already_published = existing.iter().any(|card| {
            card.fields
                .get("adoptionId")
                .and_then(serde_json::Value::as_str)
                == Some(event.adoption_id.as_str())
        });
        let card = projection(event);
        if !already_published {
            if transcript::append(transcript_path, &card).is_err() {
                result.pending_destinations.push(event.destination.clone());
                continue;
            }
            existing.push(card.clone());
            result.published.push(card);
        }
        if event.phase != AdoptionPhase::Published {
            event.phase = AdoptionPhase::Published;
            changed = true;
        }
    }
    if changed {
        save(event_path, &log)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn event(id: &str, phase: AdoptionPhase) -> AdoptionEvent {
        AdoptionEvent {
            adoption_id: id.into(),
            displaced_path: "old.md".into(),
            destination: "new.md".into(),
            doc_id: String::new(),
            recovery_content_omitted: true,
            moved_comment_count: 0,
            expected_revision: Revision::of("body").as_str().into(),
            destination_existed_before: false,
            landing_started: false,
            timestamp: "2026-08-27T00:00:00.000Z".into(),
            phase,
        }
    }

    #[test]
    fn committed_adoption_projects_once_and_repeated_reconciliation_dedupes() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        prepare(&events, event("a1", AdoptionPhase::FileCommitted)).unwrap();

        assert_eq!(
            reconcile(&events, &transcript, dir.path())
                .unwrap()
                .published
                .len(),
            1
        );
        assert!(reconcile(&events, &transcript, dir.path())
            .unwrap()
            .published
            .is_empty());
        assert_eq!(transcript::read_all(&transcript).unwrap().len(), 1);
    }

    #[test]
    fn a_projection_written_before_phase_promotion_is_not_appended_twice() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        let committed = event("a1", AdoptionPhase::FileCommitted);
        prepare(&events, committed.clone()).unwrap();
        transcript::append(&transcript, &projection(&committed)).unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();

        assert!(result.published.is_empty());
        assert_eq!(transcript::read_all(&transcript).unwrap().len(), 1);
        assert!(reconcile(&events, &transcript, dir.path())
            .unwrap()
            .published
            .is_empty());
    }

    #[test]
    fn a_published_event_rebuilds_a_projection_missing_from_a_rewritten_transcript_once() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        prepare(&events, event("a1", AdoptionPhase::Published)).unwrap();
        transcript::append(
            &transcript,
            &projection(&event("unrelated", AdoptionPhase::Published)),
        )
        .unwrap();

        let rebuilt = reconcile(&events, &transcript, dir.path()).unwrap();

        assert_eq!(rebuilt.published.len(), 1);
        assert_eq!(transcript::read_all(&transcript).unwrap().len(), 2);
        assert!(reconcile(&events, &transcript, dir.path())
            .unwrap()
            .published
            .is_empty());
        assert_eq!(transcript::read_all(&transcript).unwrap().len(), 2);
    }

    #[test]
    fn an_unreadable_transcript_keeps_durable_publications_pending() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        fs::create_dir(&transcript).unwrap();
        prepare(&events, event("a1", AdoptionPhase::Published)).unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();

        assert!(result.published.is_empty());
        assert_eq!(result.pending_destinations, vec!["new.md"]);
    }

    #[test]
    fn prepared_missing_destination_tombstones_but_exact_new_file_promotes() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        prepare(&events, event("missing", AdoptionPhase::Prepared)).unwrap();
        assert!(reconcile(&events, &transcript, dir.path())
            .unwrap()
            .published
            .is_empty());

        prepare(&events, event("landed", AdoptionPhase::Prepared)).unwrap();
        fs::write(dir.path().join("new.md"), "body").unwrap();
        assert_eq!(
            reconcile(&events, &transcript, dir.path())
                .unwrap()
                .published
                .len(),
            1
        );
    }

    #[test]
    fn crash_after_file_landing_adopts_uuid_sidecars_before_publishing() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        let store = SidecarStore::new(dir.path());
        let id = store.mint_doc_id();
        crate::commands::comments::create_comment_by_id(
            dir.path().to_string_lossy().into_owned(),
            id.to_string(),
            "body".into(),
            "you".into(),
            "survive the crash".into(),
            None,
            1,
        )
        .unwrap();
        let mut prepared = event("landed-with-sidecars", AdoptionPhase::Prepared);
        prepared.doc_id = id.to_string();
        prepare(&events, prepared).unwrap();
        fs::write(dir.path().join("new.md"), "body").unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();

        assert_eq!(result.published.len(), 1);
        assert_eq!(
            result.published[0].fields.get("movedCommentCount"),
            Some(&serde_json::json!(1))
        );
        assert_eq!(store.path_for(id).unwrap().as_deref(), Some("new.md"));
        assert!(reconcile(&events, &transcript, dir.path())
            .unwrap()
            .published
            .is_empty());
    }

    #[test]
    fn a_late_identity_collision_preserves_both_reachable_histories_and_stays_explicit() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        let store = SidecarStore::new(dir.path());
        let destination_owner = store.get_or_mint_for_path("new.md").unwrap();
        let scratch = store.mint_doc_id();
        crate::commands::comments::create_comment_by_id(
            dir.path().to_string_lossy().into_owned(),
            destination_owner.to_string(),
            "old body".into(),
            "you".into(),
            "old history".into(),
            None,
            1,
        )
        .unwrap();
        crate::commands::comments::create_comment_by_id(
            dir.path().to_string_lossy().into_owned(),
            scratch.to_string(),
            "body".into(),
            "you".into(),
            "scratch history".into(),
            None,
            2,
        )
        .unwrap();
        let mut committed = event("collision", AdoptionPhase::FileCommitted);
        committed.doc_id = scratch.to_string();
        prepare(&events, committed).unwrap();
        fs::write(dir.path().join("new.md"), "body").unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();

        assert_eq!(result.pending_destinations, vec!["new.md"]);
        assert!(result.published.is_empty());
        assert_eq!(
            result.collisions,
            vec![AdoptionCollision {
                destination: "new.md".into(),
                doc_id: scratch.to_string(),
                existing_doc_id: destination_owner.to_string(),
            }]
        );
        assert_eq!(store.path_for(scratch).unwrap(), None);
        assert_eq!(
            store.path_for(destination_owner).unwrap().as_deref(),
            Some("new.md")
        );
        let scratch_visible = store.fold_comments(scratch).unwrap();
        assert!(scratch_visible
            .threads
            .values()
            .any(|thread| thread.body == "scratch history"));
        assert!(!scratch_visible
            .threads
            .values()
            .any(|thread| thread.body == "old history"));
        let incumbent_visible = store.fold_comments(destination_owner).unwrap();
        let incumbent_comment = incumbent_visible.threads.values().next().unwrap();
        assert_eq!(incumbent_comment.body, "old history");
        assert_eq!(
            store.find_doc_id_by_comment(&incumbent_comment.id).unwrap(),
            Some(destination_owner),
        );
        let scratch_comment = scratch_visible.threads.values().next().unwrap();
        assert_eq!(
            store.find_doc_id_by_comment(&scratch_comment.id).unwrap(),
            Some(scratch),
        );
    }

    #[test]
    fn prepared_preexisting_destination_stays_pending_and_releases_a_legacy_reservation() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        fs::write(dir.path().join("new.md"), "preexisting body").unwrap();
        let store = SidecarStore::new(dir.path());
        let scratch = store.mint_doc_id();
        store.adopt(scratch, "new.md").unwrap();
        let mut prepared = event("a1", AdoptionPhase::Prepared);
        prepared.doc_id = scratch.to_string();
        prepared.destination_existed_before = true;
        prepare(&events, prepared).unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();
        assert_eq!(result.pending_destinations, vec!["new.md"]);
        assert!(result.published.is_empty());
        assert_eq!(store.doc_id_for_path("new.md").unwrap(), None);
        assert_eq!(store.path_for(scratch).unwrap(), None);
    }

    #[test]
    fn prepared_preexisting_equal_bytes_stay_ambiguous_without_a_landing_proof() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        fs::write(dir.path().join("new.md"), "body").unwrap();
        let mut prepared = event("a1", AdoptionPhase::Prepared);
        prepared.destination_existed_before = true;
        prepare(&events, prepared).unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();

        assert_eq!(result.pending_destinations, vec!["new.md"]);
        assert!(result.published.is_empty());
        assert_eq!(
            SidecarStore::new(dir.path())
                .doc_id_for_path("new.md")
                .unwrap(),
            None
        );
    }

    #[test]
    fn prepared_matching_scratch_mapping_proves_a_landed_preexisting_overwrite() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        let store = SidecarStore::new(dir.path());
        let scratch = store.mint_doc_id();
        let mut landed = event("landed", AdoptionPhase::Prepared);
        landed.doc_id = scratch.to_string();
        landed.destination_existed_before = true;
        landed.landing_started = true;
        prepare(&events, landed).unwrap();
        fs::write(dir.path().join("new.md"), "body").unwrap();
        store.adopt(scratch, "new.md").unwrap();
        assert_eq!(
            reconcile(&events, &transcript, dir.path())
                .unwrap()
                .published
                .len(),
            1
        );
    }

    #[test]
    fn an_explicit_file_failure_tombstones_even_when_the_destination_preexisted() {
        let dir = TempDir::new().unwrap();
        let events = dir.path().join("events.json");
        let transcript = dir.path().join("transcript.jsonl");
        let mut prepared = event("a1", AdoptionPhase::Prepared);
        prepared.destination_existed_before = true;
        prepare(&events, prepared).unwrap();
        tombstone(&events, "a1").unwrap();

        let result = reconcile(&events, &transcript, dir.path()).unwrap();
        assert!(result.pending_destinations.is_empty());
        assert!(result.published.is_empty());
    }
}
