// ABOUTME: Document identity map — the pure `.cowrite/docs.json` shape (TD §3.2b, `docs-map.schema.json`)
// ABOUTME: plus its atomic load/save. Path<->UUID lookups only; minting/rename/adopt policy lives in `service`.

//! The pure data half of TD §3.2b's doc-identity contract: "sidecars key on a per-doc UUID minted
//! at first sidecar write; a committed `.cowrite/docs.json` maps path<->UUID (rename/move = one
//! map update event — FR-ED-8; scratch-doc adoption = mint on save-in)."
//!
//! `DocsMap` itself carries no I/O or minting policy — it is the schema-shaped value plus the
//! lookups a caller needs (`doc_id_for_path`/`path_for`) and the one mutation (`set_path`) every
//! policy in `service::SidecarStore` (mint-or-get, rename, adopt, delete) is built from. Keeping
//! the map's own logic total and I/O-free makes it trivially unit-testable without a filesystem;
//! `load`/`save` below are the only functions that touch disk, and `save` is atomic (write-then-
//! rename) so a crash mid-write can never leave a torn `docs.json`. `SidecarStore` owns the
//! process-wide lock around every whole-map read-modify-write; TD §3.5's per-project process lock
//! excludes writers in another app process.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use uuid::Uuid;

use crate::store::atomic;

/// Bumped whenever the on-wire shape changes (TD-4: "every file carries `schema_version`"),
/// matching `store::comments`/`store::changes`'s own constants.
pub const SCHEMA_VERSION: u32 = 1;

/// The whole `.cowrite/docs.json` file (`docs-map.schema.json`): a per-doc UUID keyed to the
/// project-relative path that document currently lives at. Holds the *current* map only — a
/// rename overwrites the value in place, it does not append a history (TD §3.2b: "single-writer
/// by design").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocsMap {
    pub schema_version: u32,
    pub documents: BTreeMap<Uuid, String>,
}

impl Default for DocsMap {
    fn default() -> Self {
        DocsMap::new()
    }
}

impl DocsMap {
    pub fn new() -> DocsMap {
        DocsMap {
            schema_version: SCHEMA_VERSION,
            documents: BTreeMap::new(),
        }
    }

    /// The UUID currently mapped to `path`, if any. Linear scan — `documents` is keyed by UUID,
    /// not path, and a project's open-document count is small enough that this is not worth a
    /// second reverse index.
    pub fn doc_id_for_path(&self, path: &str) -> Option<Uuid> {
        self.documents
            .iter()
            .find(|(_, mapped)| mapped.as_str() == path)
            .map(|(id, _)| *id)
    }

    /// The path currently mapped to `id`, if any.
    pub fn path_for(&self, id: Uuid) -> Option<&str> {
        self.documents.get(&id).map(String::as_str)
    }

    /// Registers `id` at `path`, overwriting whatever path (if any) `id` was previously mapped
    /// to. The one mutation the schema supports — `service::SidecarStore` builds mint/rename/
    /// adopt/delete semantics on top of this plus its own preconditions.
    pub fn set_path(&mut self, id: Uuid, path: impl Into<String>) {
        self.documents.insert(id, path.into());
    }

    /// Removes `id` from the map (e.g. its document was deleted from the project), returning the
    /// path it was last mapped to, if it was tracked at all.
    pub fn remove(&mut self, id: Uuid) -> Option<String> {
        self.documents.remove(&id)
    }
}

/// Loads `.cowrite/docs.json` from `path`. A missing file is a fresh, empty map (a project that
/// has never minted a doc identity yet) rather than an error.
pub fn load(path: &Path) -> io::Result<DocsMap> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(DocsMap::new()),
        Err(e) => Err(e),
    }
}

/// Persists `map` to `path`, atomically (write-then-rename — a crash mid-write leaves the
/// previous, still-valid file in place, never a torn one). Creates parent directories as needed.
pub fn save(path: &Path, map: &DocsMap) -> io::Result<()> {
    atomic::write_json(path, map)
}

#[cfg(test)]
mod pure_tests {
    use super::*;

    fn uuid(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn a_fresh_map_is_empty_at_the_current_schema_version() {
        let map = DocsMap::new();
        assert_eq!(map.schema_version, SCHEMA_VERSION);
        assert!(map.documents.is_empty());
    }

    #[test]
    fn set_path_then_lookup_by_id_and_by_path_agree() {
        let mut map = DocsMap::new();
        map.set_path(uuid(1), "chapters/01.md");
        assert_eq!(map.path_for(uuid(1)), Some("chapters/01.md"));
        assert_eq!(map.doc_id_for_path("chapters/01.md"), Some(uuid(1)));
    }

    #[test]
    fn an_unmapped_path_or_id_is_none() {
        let map = DocsMap::new();
        assert_eq!(map.path_for(uuid(1)), None);
        assert_eq!(map.doc_id_for_path("nowhere.md"), None);
    }

    #[test]
    fn set_path_again_overwrites_rather_than_duplicates() {
        let mut map = DocsMap::new();
        map.set_path(uuid(1), "old/path.md");
        map.set_path(uuid(1), "new/path.md");
        assert_eq!(map.documents.len(), 1);
        assert_eq!(map.path_for(uuid(1)), Some("new/path.md"));
        assert_eq!(map.doc_id_for_path("old/path.md"), None);
    }

    #[test]
    fn remove_drops_the_entry_and_returns_its_last_path() {
        let mut map = DocsMap::new();
        map.set_path(uuid(1), "gone.md");
        assert_eq!(map.remove(uuid(1)), Some("gone.md".to_string()));
        assert_eq!(map.path_for(uuid(1)), None);
    }

    #[test]
    fn removing_an_untracked_id_is_a_quiet_none() {
        let mut map = DocsMap::new();
        assert_eq!(map.remove(uuid(9)), None);
    }

    #[test]
    fn docs_map_round_trips_through_json() {
        let mut map = DocsMap::new();
        map.set_path(uuid(1), "a.md");
        map.set_path(uuid(2), "b.md");
        let json = serde_json::to_string(&map).unwrap();
        let back: DocsMap = serde_json::from_str(&json).unwrap();
        assert_eq!(back, map);
    }
}

#[cfg(test)]
mod conformance_tests {
    // Binds this module's wire shape to the *published* contract (FR-X-8, P1-13): every
    // `DocsMap` this module can produce must validate against
    // `docs/formats/sidecar/docs-map.schema.json` — the schema `store::schema` previously only
    // checked against a hand-written example fixture (P2a-10 supplies the first real producer).
    use super::*;
    use crate::store::schema::{is_valid, Schema};

    #[test]
    fn a_fresh_map_conforms_to_the_published_schema() {
        assert!(is_valid(
            Schema::DocsMap,
            &serde_json::to_value(DocsMap::new()).unwrap()
        ));
    }

    #[test]
    fn a_populated_map_conforms_to_the_published_schema() {
        let mut map = DocsMap::new();
        map.set_path(Uuid::from_bytes([7; 16]), "chapters/01-the-well.md");
        assert!(is_valid(
            Schema::DocsMap,
            &serde_json::to_value(map).unwrap()
        ));
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn loading_a_missing_file_is_a_fresh_empty_map_not_an_error() {
        let dir = TempDir::new().unwrap();
        let map = load(&dir.path().join("docs.json")).unwrap();
        assert!(map.documents.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".cowrite/docs.json");
        let mut map = DocsMap::new();
        map.set_path(Uuid::from_bytes([3; 16]), "notes/outline.md");

        save(&path, &map).unwrap();
        let loaded = load(&path).unwrap();

        assert_eq!(loaded, map);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deeper/docs.json");
        save(&path, &DocsMap::new()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn save_leaves_no_stray_temp_file_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("docs.json");
        save(&path, &DocsMap::new()).unwrap();
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("docs.json")]);
    }

    #[test]
    fn a_corrupt_docs_json_is_a_defined_error_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("docs.json");
        fs::write(&path, "{not json").unwrap();
        assert!(load(&path).is_err());
    }
}
