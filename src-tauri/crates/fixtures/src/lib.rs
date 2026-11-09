// ABOUTME: Loader for the committed open-source fixture corpus (P0-4, TP-Q3).
// ABOUTME: Parses fixtures/corpus/manifest.json and exposes each fixture (path, source, license) to tests.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// A fixture category. Serialized lowercase in the manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// Long-form homiletic prose (mixed provenance: real PD-US sermons + authored CC0).
    Prose,
    /// CommonMark / GFM feature-coverage documents (authored CC0).
    Markdown,
    /// Technical documents with front matter, tables, and code (mixed provenance:
    /// authored CC0 + real permissively-licensed docs).
    Technical,
    /// Byte-level fidelity edge cases (BOM, CRLF, unicode, ...).
    Fidelity,
}

/// License record for a fixture. The boolean flags let the corpus mechanically
/// enforce TP-Q3's policy: no NonCommercial, no ShareAlike.
#[derive(Debug, Clone, Deserialize)]
pub struct License {
    /// SPDX-style identifier, e.g. `PD-US`, `CC0-1.0`, `CC-BY-4.0`.
    pub spdx: String,
    /// Human-readable license name.
    pub name: String,
    #[serde(default)]
    pub share_alike: bool,
    #[serde(default)]
    pub noncommercial: bool,
}

/// Provenance of a fixture (where the bytes came from).
#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    /// `project-gutenberg`, `authored`, ...
    pub kind: String,
    /// Gutenberg ebook number, when applicable.
    #[serde(default)]
    pub ebook: Option<u32>,
    /// Canonical URL, when applicable.
    #[serde(default)]
    pub url: Option<String>,
    /// Free-text note (e.g. "PG boilerplate removed; body verbatim").
    #[serde(default)]
    pub note: Option<String>,
}

/// One fixture entry from the manifest, with its path resolved to disk.
#[derive(Debug, Clone, Deserialize)]
pub struct Fixture {
    /// Stable identifier, unique across the corpus.
    pub id: String,
    pub category: Category,
    pub title: String,
    /// Path relative to the corpus root, as recorded in the manifest.
    pub path: String,
    pub source: Source,
    pub license: License,
}

impl Fixture {
    /// Absolute path to the fixture file on disk.
    pub fn abs_path(&self) -> PathBuf {
        corpus_dir().join(&self.path)
    }

    /// Read the fixture as UTF-8. Panics on I/O or decoding error — this is a
    /// test helper, and a missing/corrupt fixture is a hard failure, not a case
    /// to handle gracefully.
    pub fn read(&self) -> String {
        let p = self.abs_path();
        fs::read_to_string(&p).unwrap_or_else(|e| {
            panic!("failed to read fixture {} at {}: {e}", self.id, p.display())
        })
    }

    /// Read the fixture's raw bytes — use this for byte-exact fidelity checks
    /// (BOM, CRLF) where UTF-8 decoding via [`read`](Fixture::read) would still
    /// be exact but reading bytes states the intent.
    pub fn read_bytes(&self) -> Vec<u8> {
        let p = self.abs_path();
        fs::read(&p).unwrap_or_else(|e| {
            panic!("failed to read fixture {} at {}: {e}", self.id, p.display())
        })
    }
}

/// The license policy declared by the manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct LicensePolicy {
    #[serde(default)]
    pub allow_noncommercial: bool,
    #[serde(default)]
    pub allow_share_alike: bool,
    #[serde(default)]
    pub preferred: Vec<String>,
    #[serde(default)]
    pub accepted: Vec<String>,
}

/// The parsed manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub license_policy: Option<LicensePolicy>,
    pub fixtures: Vec<Fixture>,
}

/// Absolute path to the corpus root (`fixtures/corpus`).
///
/// Resolution order:
/// 1. `EMEND_FIXTURES_DIR` env var, if set (points directly at the corpus root).
/// 2. Otherwise, relative to this crate: `<crate>/../../../fixtures/corpus`.
pub fn corpus_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("EMEND_FIXTURES_DIR") {
        return PathBuf::from(dir);
    }
    // <repo>/src-tauri/crates/fixtures -> <repo>
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/corpus")
}

/// Absolute path to the manifest file.
pub fn manifest_path() -> PathBuf {
    corpus_dir().join("manifest.json")
}

/// Parse the manifest.
pub fn manifest() -> Manifest {
    let p = manifest_path();
    let raw = fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("failed to read manifest at {}: {e}", p.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("failed to parse manifest at {}: {e}", p.display()))
}

/// All fixtures declared in the manifest.
pub fn load() -> Vec<Fixture> {
    manifest().fixtures
}

/// Look up a single fixture by its stable id.
pub fn by_id(id: &str) -> Option<Fixture> {
    load().into_iter().find(|f| f.id == id)
}

/// All fixtures in a category.
pub fn by_category(category: Category) -> Vec<Fixture> {
    load()
        .into_iter()
        .filter(|f| f.category == category)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn manifest_parses_and_is_nonempty() {
        let m = manifest();
        assert_eq!(m.version, 1, "manifest version");
        assert!(!m.fixtures.is_empty(), "manifest declares fixtures");
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = HashSet::new();
        for f in load() {
            assert!(seen.insert(f.id.clone()), "duplicate fixture id: {}", f.id);
        }
    }

    #[test]
    fn every_declared_fixture_file_exists_and_is_readable() {
        for f in load() {
            let p = f.abs_path();
            assert!(
                p.is_file(),
                "fixture {} missing on disk: {}",
                f.id,
                p.display()
            );
            // Reading proves it is decodable / accessible; must not panic.
            let _ = f.read_bytes();
        }
    }

    #[test]
    fn no_orphan_files_on_disk() {
        // Every corpus file must be declared in the manifest (no undocumented
        // fixtures). Excludes the manifest itself, doc files, and the raw
        // Project Gutenberg staging area.
        let declared: HashSet<PathBuf> = load()
            .iter()
            .map(|f| corpus_dir().join(&f.path))
            .map(|p| p.canonicalize().unwrap_or(p))
            .collect();

        let mut orphans = Vec::new();
        walk(&corpus_dir(), &mut |p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "manifest.json" || name == "LICENSES.md" || name == "README.md" {
                return;
            }
            // Skip the raw Gutenberg staging area (uncommitted, gitignored).
            if p.components().any(|c| c.as_os_str() == "_raw") {
                return;
            }
            let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            if !declared.contains(&canon) {
                orphans.push(p.to_path_buf());
            }
        });
        assert!(
            orphans.is_empty(),
            "undocumented fixture files (add to manifest): {orphans:?}"
        );
    }

    #[test]
    fn license_policy_forbids_nc_and_sa() {
        // Mechanical enforcement of TP-Q3: no NonCommercial, no ShareAlike.
        for f in load() {
            assert!(
                !f.license.noncommercial,
                "fixture {} has a NonCommercial license ({}), forbidden by TP-Q3",
                f.id, f.license.spdx
            );
            assert!(
                !f.license.share_alike,
                "fixture {} has a ShareAlike license ({}), forbidden by TP-Q3",
                f.id, f.license.spdx
            );
        }
    }

    #[test]
    fn lookups_work() {
        let all = load();
        // by_id round-trips for a known-authored fixture.
        let first = &all[0];
        assert_eq!(by_id(&first.id).unwrap().id, first.id);
        assert!(by_id("does-not-exist").is_none());

        // by_category partitions and covers everything.
        let mut counted = 0;
        for cat in [
            Category::Prose,
            Category::Markdown,
            Category::Technical,
            Category::Fidelity,
        ] {
            counted += by_category(cat).len();
        }
        assert_eq!(counted, all.len(), "categories partition the corpus");
    }

    #[test]
    fn bom_fixture_is_byte_exact() {
        // Proves the byte-reading path preserves a UTF-8 BOM — the base case for
        // P1 round-trip fidelity.
        let f = by_id("fidelity-bom").expect("bom fixture declared");
        let bytes = f.read_bytes();
        assert_eq!(
            &bytes[..3],
            &[0xEF, 0xBB, 0xBF],
            "BOM preserved byte-for-byte"
        );
    }

    /// Recursively invoke `f` on every file under `dir`.
    fn walk(dir: &Path, f: &mut impl FnMut(&Path)) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, f);
            } else {
                f(&path);
            }
        }
    }
}
