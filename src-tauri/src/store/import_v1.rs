// ABOUTME: D22 importer — reads v1 `.comments/`/`.track-changes/` sidecars and emits
// ABOUTME: synthetic TD-4 `CommentEvent`/`ChangeRecord`s, counted-invariant (test-plan §3).

//! The D22 migration importer (functional-spec D22; TD-4: "D22 migration = importer
//! emitting synthetic events").
//!
//! v1 stored comments as a flat, already-resolved array (`.comments/<encoded>.json`
//! — one JSON array of `Comment`, mutated in place) and track-changes as a single
//! attribution object (`.track-changes/<encoded>.json`). The rewrite's sidecar
//! contract (TD-4, `docs/formats/sidecar/`) is different in kind, not just shape:
//! comments are an **append-only causal event log** (`store::comments`) folded into
//! thread state, and track-changes is a **last-write-wins record map**
//! (`store::changes`) keyed by change id. This module bridges the two: it reads the
//! old flat state and synthesizes the events/records the new format would have
//! produced, one v1 record at a time.
//!
//! # Scope: emits and (via [`run_v1_upgrade`]) persists
//!
//! Per TD-4 the *pure* half of this module's job stops at emitting synthetic
//! values — writing them under `.cowrite/comments/<doc-id>/<author>.jsonl` /
//! `.cowrite/changes/<doc-id>.json` is the sidecar store service's job
//! (`docs/formats/sidecar/README.md`), and `<doc-id>` is a **UUID minted into
//! `.cowrite/docs.json`** (`docs-map.schema.json`), not a hash this module can
//! compute on its own. [`run_v1_upgrade`] is the P2a-10 wiring that wraps
//! `migrate_comments`/`migrate_changes` with a `store::service::SidecarStore` to
//! do exactly that: decode each legacy sidecar's encoded filename back to a
//! project-relative path, mint/reuse that document's UUID, persist the converted
//! events/records through the store's normal append path, and finally retire the
//! legacy directories ([`mark_legacy_sidecars_migrated`]) once every document has
//! been attempted. The disk-facing pieces that don't depend on doc identity
//! ([`read_v1_comments`]/[`read_v1_track_changes`], including the
//! truncated/corrupt-JSON ugly case) remain usable standalone for a caller that
//! wants finer-grained control than the one-shot project upgrade.
//!
//! # Counted invariants (test-plan §3)
//!
//! Every v1 record lands in exactly one bucket, so "in" always equals the sum of
//! "out" buckets — nothing is silently dropped:
//! - **Comments:** every v1 comment becomes exactly one event (`Create` for a root
//!   comment, `Reply` for one with a `parent_id`); every `resolved: true` comment
//!   additionally emits one synthetic `Resolve`. `threads_in == creates_out`,
//!   `replies_in == replies_out`, `resolutions_in == resolves_out`, always — anchor
//!   resolution failure does not drop the event (`Create.anchor` is optional in the
//!   new schema), it only demotes that comment's anchor to `None` and records the
//!   original quote in [`CommentMigration::orphans`] for the "orphan list manually
//!   verified once" acceptance criterion.
//! - **Track changes:** `ChangeRecord.anchor` is *not* optional (the new schema has
//!   no anchorless change), so a v1 change whose CriticMarkup marker can no longer
//!   be found in the live document cannot become a `ChangeRecord` at all — it is
//!   still *counted*, via [`ChangeMigration::orphans`], so `changes_in ==
//!   records_out + orphans_out`.
//!
//! # Anchor resolution (D17/TD-6 reuse, not reinvention)
//!
//! v1 comments carry a byte/UTF-16-ambiguous `start_offset`/`end_offset` plus the
//! exact quoted `text_snapshot` — no captured context. Resolution tries, in order:
//! 1. **Exact slice match** — `doc[start_offset..end_offset] == text_snapshot`. The
//!    common case (first-open migration, document unchanged since v1 wrote it).
//! 2. **[`textops::Anchor::fuzzy_reanchor`]** (D17/P1-5b), fed the v1 snapshot with
//!    empty captured context (v1 never stored any) — its token-exact stage 1 finds
//!    the identical text anywhere else in the document without needing correct
//!    offsets at all, which is exactly what recovers the CRLF-era ugly case (v1's
//!    line/col secondary anchors go unused here: byte offsets shift when
//!    `\r\n`-authored text is re-saved `\n`-normalized, but the quoted text itself
//!    is untouched, so the token-exact search still finds it).
//! 3. Otherwise: a **counted orphan** (D17's "never guess" rule, reused verbatim).
//!
//! Track-changes anchors have no stored snapshot at all in v1 (only
//! `start_offset` — "the actual change content lives in the markdown as
//! CriticMarkup; this stores attribution … only"), so resolution instead looks for
//! a live CriticMarkup marker whose span starts at that exact offset
//! ([`textops::parse`]); no marker there is an orphan.
//!
//! # Mixed-vintage v1 input
//!
//! v1's own comment schema grew optional fields over its lifetime (GitHub-review
//! linkage, secondary line/col anchors — see the legacy `comments/types.rs`
//! `test_backward_compat_*` tests). This module's v1 structs deliberately model
//! only the fields the new schema can represent; serde's default "ignore unknown
//! JSON keys" behavior means a directory holding sidecar files written by
//! different v1 vintages (some with those fields, some without) is transparently
//! tolerated without any explicit compatibility branching.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::store::changes::SCHEMA_VERSION as CHANGE_SCHEMA_VERSION;
use crate::store::changes::{ChangeRecord, ChangeType};
use crate::store::comments::{CommentEvent, EventKind, SCHEMA_VERSION as COMMENT_SCHEMA_VERSION};
use crate::store::service::SidecarStore;
use textops::{Anchor, Document, ReAnchor};

// --- v1 wire shapes (read-only; mirrors `legacy/v1`'s `comments`/`track_changes` modules) ---

/// One row of a v1 `.comments/<encoded-path>.json` array. v1 comments are already
/// *resolved* state (a flat list mutated in place), not an event log — this
/// module's job is to synthesize the events that would have produced this state.
#[derive(Debug, Clone, Deserialize)]
pub struct V1Comment {
    pub id: String,
    pub range: Option<V1TextRange>,
    pub author: String,
    pub content: String,
    pub created_at: String,
    #[serde(default)]
    pub resolved: bool,
    pub parent_id: Option<String>,
}

/// v1's anchor shape — offsets plus the quoted text, no captured context.
#[derive(Debug, Clone, Deserialize)]
pub struct V1TextRange {
    pub start_offset: usize,
    pub end_offset: usize,
    pub text_snapshot: String,
}

/// The whole `.track-changes/<encoded-path>.json` sidecar (v1's
/// `TrackChangesMetadata`). `tracking_enabled` has no analogue in the new schema
/// (tracking is a live document operation, not sidecar state) and is intentionally
/// dropped.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1TrackChangesMetadata {
    #[serde(default)]
    pub changes: Vec<V1ChangeEntry>,
}

/// One v1 `ChangeMetadataEntry` — attribution only; the change's *content* lives in
/// the document's CriticMarkup, so there is no length or quoted text to read here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1ChangeEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub change_type: V1ChangeType,
    pub start_offset: usize,
    pub author: String,
    pub timestamp: String,
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum V1ChangeType {
    Insertion,
    Deletion,
    Substitution,
}

impl From<V1ChangeType> for ChangeType {
    fn from(kind: V1ChangeType) -> ChangeType {
        match kind {
            V1ChangeType::Insertion => ChangeType::Insertion,
            V1ChangeType::Deletion => ChangeType::Deletion,
            V1ChangeType::Substitution => ChangeType::Substitution,
        }
    }
}

/// A v1 record whose anchor could not be resolved against the live document — kept
/// so nothing is silently dropped (D17's rule, reused): the original quote (where
/// one exists) is preserved for the one-time manual orphan review the acceptance
/// criteria call for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOrphan {
    pub id: String,
    pub quote: String,
}

// --- timestamp conversion ----------------------------------------------------

/// v1 wrote `created_at`/`timestamp` as `chrono::Utc::now().to_rfc3339()`; the new
/// schema wants milliseconds since the epoch. An unparsable timestamp (corrupt
/// data) falls back to `0` rather than dropping the record — the counted-invariant
/// guarantee (every input lands in exactly one output bucket) must hold even for
/// malformed timestamps, and `0` sorts first deterministically, same on every run.
fn parse_v1_timestamp(raw: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

// --- anchor resolution ---------------------------------------------------------

enum CommentAnchorResolution {
    Resolved(Anchor),
    Orphan { quote: String },
}

/// Resolve a v1 comment's anchor against the live document (§ module docs). `doc:
/// None` means the target document could not be read at all (moved, deleted, or
/// unreadable) — every anchored comment in that file is a counted orphan.
///
/// Takes an already-built [`Document`] (rather than raw text) so a caller
/// resolving many comments against the same file builds it once, not once per
/// comment.
fn resolve_comment_anchor(doc: Option<&Document>, range: &V1TextRange) -> CommentAnchorResolution {
    let Some(doc) = doc else {
        return CommentAnchorResolution::Orphan {
            quote: range.text_snapshot.clone(),
        };
    };
    let text = doc.text();

    if let Some(slice) = safe_slice(text, range.start_offset, range.end_offset) {
        if slice == range.text_snapshot {
            let length = range.end_offset - range.start_offset;
            return CommentAnchorResolution::Resolved(Anchor::new(doc, range.start_offset, length));
        }
    }

    // Exact offsets didn't land on the quoted text (drift, or a CRLF-era byte vs.
    // UTF-16 offset mismatch) — fall back to fuzzy re-anchor on the snapshot alone
    // (D17/P1-5b; v1 never captured context, so both sides are empty here, which
    // `fuzzy_reanchor` treats as an always-truncated, safely-excluded side).
    let phantom = Anchor {
        offset: range.start_offset,
        length: range.end_offset.saturating_sub(range.start_offset),
        text_snapshot: range.text_snapshot.clone(),
        context_before: String::new(),
        context_after: String::new(),
        base_revision: doc.revision(),
    };
    match phantom.fuzzy_reanchor(text, doc.revision()) {
        ReAnchor::Anchored(anchor) => CommentAnchorResolution::Resolved(anchor),
        ReAnchor::Orphan(orphan) => CommentAnchorResolution::Orphan {
            quote: orphan.text_snapshot,
        },
    }
}

/// Resolve a v1 track-change's anchor: find the live CriticMarkup marker whose
/// full span starts exactly at `start_offset` (§ module docs — v1 stored no
/// snapshot/length for changes, only the offset). `None` means no such marker
/// exists any more (accepted/rejected/hand-edited away, or offset drift) — a
/// counted orphan with a best-effort quote (up to 40 bytes of the live text at
/// that offset, if still in bounds; v1 has nothing better to offer here).
///
/// Takes the document's already-parsed markers (rather than re-parsing raw text)
/// so a caller resolving many changes against the same file parses it once, not
/// once per change.
fn resolve_change_anchor(
    doc: Option<&Document>,
    markers: &[textops::Markup],
    start_offset: usize,
) -> Option<Anchor> {
    let doc = doc?;
    let marker = markers.iter().find(|m| m.full.start == start_offset)?;
    Some(Anchor::new(
        doc,
        marker.full.start,
        marker.full.end - marker.full.start,
    ))
}

/// Best-effort quote for an orphaned track-change: up to 40 bytes of live text at
/// `start_offset`, char-boundary safe. Empty if the offset is out of bounds or the
/// document is unavailable — v1 stored no independent snapshot for changes, so
/// this is strictly weaker evidence than a comment orphan's preserved quote,
/// documented as a known v1-format limitation.
fn best_effort_change_quote(doc_text: Option<&str>, start_offset: usize) -> String {
    let Some(text) = doc_text else {
        return String::new();
    };
    if start_offset >= text.len() || !text.is_char_boundary(start_offset) {
        return String::new();
    }
    let end = ceil_within(text, (start_offset + 40).min(text.len()));
    text[start_offset..end].to_string()
}

fn ceil_within(text: &str, mut index: usize) -> usize {
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn safe_slice(text: &str, start: usize, end: usize) -> Option<&str> {
    if start > end
        || end > text.len()
        || !text.is_char_boundary(start)
        || !text.is_char_boundary(end)
    {
        return None;
    }
    Some(&text[start..end])
}

// --- comments migration --------------------------------------------------------

/// Counted-invariant tallies for one v1 `.comments/` file's migration (test-plan
/// §3: "old threads/replies/resolutions … in = events out"). `creates_out`/
/// `replies_out`/`resolves_out` equal `threads_in`/`replies_in`/`resolutions_in`
/// unconditionally, by construction — see the module docs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CommentMigrationCounts {
    pub threads_in: usize,
    pub replies_in: usize,
    pub resolutions_in: usize,
    pub creates_out: usize,
    pub replies_out: usize,
    pub resolves_out: usize,
    pub anchors_resolved: usize,
    pub anchors_orphaned: usize,
}

#[derive(Debug, Clone, Default)]
pub struct CommentMigration {
    pub events: Vec<CommentEvent>,
    pub counts: CommentMigrationCounts,
    pub orphans: Vec<ImportOrphan>,
}

/// Synthesize TD-4 `CommentEvent`s for one v1 `.comments/` file's worth of
/// comments (§ module docs for the counted-invariant contract). `doc_text` is the
/// live text of the document these comments were anchored to, if it could be
/// read.
pub fn migrate_comments(comments: &[V1Comment], doc_text: Option<&str>) -> CommentMigration {
    let mut events = Vec::new();
    let mut orphans = Vec::new();
    let mut counts = CommentMigrationCounts::default();
    // Built once per file, not once per comment — `resolve_comment_anchor` takes
    // the shared `Document` rather than raw text.
    let doc = doc_text.map(Document::new);

    for comment in comments {
        let timestamp = parse_v1_timestamp(&comment.created_at);

        match &comment.parent_id {
            None => {
                counts.threads_in += 1;
                let anchor = comment
                    .range
                    .as_ref()
                    .and_then(|range| match resolve_comment_anchor(doc.as_ref(), range) {
                        CommentAnchorResolution::Resolved(anchor) => {
                            counts.anchors_resolved += 1;
                            Some(anchor)
                        }
                        CommentAnchorResolution::Orphan { quote } => {
                            counts.anchors_orphaned += 1;
                            orphans.push(ImportOrphan {
                                id: comment.id.clone(),
                                quote,
                            });
                            None
                        }
                    });
                events.push(CommentEvent {
                    schema_version: COMMENT_SCHEMA_VERSION,
                    id: comment.id.clone(),
                    parent_id: None,
                    author: comment.author.clone(),
                    timestamp,
                    kind: EventKind::Create {
                        anchor,
                        body: comment.content.clone(),
                        severity: None,
                        skill: None,
                        workflow_run: None,
                    },
                });
                counts.creates_out += 1;
            }
            Some(parent_id) => {
                counts.replies_in += 1;
                events.push(CommentEvent {
                    schema_version: COMMENT_SCHEMA_VERSION,
                    id: comment.id.clone(),
                    parent_id: Some(parent_id.clone()),
                    author: comment.author.clone(),
                    timestamp,
                    kind: EventKind::Reply {
                        body: comment.content.clone(),
                        defense: false,
                        published: false,
                        run_id: None,
                    },
                });
                counts.replies_out += 1;
            }
        }

        if comment.resolved {
            counts.resolutions_in += 1;
            events.push(CommentEvent {
                schema_version: COMMENT_SCHEMA_VERSION,
                id: format!("{}::v1-resolved", comment.id),
                parent_id: Some(comment.id.clone()),
                author: comment.author.clone(),
                timestamp,
                kind: EventKind::Resolve,
            });
            counts.resolves_out += 1;
        }
    }

    CommentMigration {
        events,
        counts,
        orphans,
    }
}

// --- track-changes migration ----------------------------------------------------

/// Counted-invariant tallies for one v1 `.track-changes/` file's migration:
/// `changes_in == records_out + orphaned_out`, always (§ module docs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChangeMigrationCounts {
    pub changes_in: usize,
    pub records_out: usize,
    pub orphaned_out: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ChangeMigration {
    pub records: Vec<ChangeRecord>,
    pub counts: ChangeMigrationCounts,
    pub orphans: Vec<ImportOrphan>,
}

/// Synthesize TD-4 `ChangeRecord`s for one v1 `.track-changes/` file's worth of
/// pending changes (§ module docs). `doc_text` is the live text of the document
/// these changes' CriticMarkup markers live in, if it could be read.
pub fn migrate_changes(
    metadata: &V1TrackChangesMetadata,
    doc_text: Option<&str>,
) -> ChangeMigration {
    let mut records = Vec::new();
    let mut orphans = Vec::new();
    // Built/parsed once per file, not once per change entry.
    let doc = doc_text.map(Document::new);
    let markers: Vec<textops::Markup> = doc_text.map(textops::parse).unwrap_or_default();

    for entry in &metadata.changes {
        match resolve_change_anchor(doc.as_ref(), &markers, entry.start_offset) {
            Some(anchor) => {
                let timestamp = parse_v1_timestamp(&entry.timestamp);
                records.push(ChangeRecord {
                    schema_version: CHANGE_SCHEMA_VERSION,
                    id: entry.id.clone(),
                    kind: entry.change_type.into(),
                    author: entry.author.clone(),
                    anchor,
                    created_at: timestamp,
                    updated_at: timestamp,
                    group: entry.group_id.clone(),
                    change_set: None,
                    note: None,
                });
            }
            None => orphans.push(ImportOrphan {
                id: entry.id.clone(),
                quote: best_effort_change_quote(doc_text, entry.start_offset),
            }),
        }
    }

    let counts = ChangeMigrationCounts {
        changes_in: metadata.changes.len(),
        records_out: records.len(),
        orphaned_out: orphans.len(),
    };

    ChangeMigration {
        records,
        counts,
        orphans,
    }
}

// --- reading real v1 sidecar files ----------------------------------------------

/// A failure reading or parsing a v1 sidecar file — never a panic, per the
/// "truncated/corrupt JSON" ugly case (test-plan §3): a caller migrating many
/// files can catch this per file and continue with the rest.
#[derive(Debug)]
pub enum ImportError {
    Io {
        path: PathBuf,
        source: io::Error,
    },
    CorruptJson {
        path: PathBuf,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Io { path, source } => {
                write!(f, "failed to read v1 sidecar {}: {source}", path.display())
            }
            ImportError::CorruptJson { path, source } => {
                write!(f, "corrupt v1 sidecar JSON at {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for ImportError {}

/// Read and parse one v1 `.comments/<encoded-path>.json` file. Corrupt or
/// truncated JSON is a defined `Err`, never a panic.
pub fn read_v1_comments(path: &Path) -> Result<Vec<V1Comment>, ImportError> {
    let content = fs::read_to_string(path).map_err(|e| ImportError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    serde_json::from_str(&content).map_err(|e| ImportError::CorruptJson {
        path: path.to_path_buf(),
        source: e,
    })
}

/// Read and parse one v1 `.track-changes/<encoded-path>.json` file. Corrupt or
/// truncated JSON is a defined `Err`, never a panic.
pub fn read_v1_track_changes(path: &Path) -> Result<V1TrackChangesMetadata, ImportError> {
    let content = fs::read_to_string(path).map_err(|e| ImportError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    serde_json::from_str(&content).map_err(|e| ImportError::CorruptJson {
        path: path.to_path_buf(),
        source: e,
    })
}

/// The legacy sidecar directories D22 reads from, paired with the name each is
/// retired to once a caller has durably persisted its converted output.
const LEGACY_DIRS: [(&str, &str); 2] = [
    (".comments", ".comments.v1-migrated"),
    (".track-changes", ".track-changes.v1-migrated"),
];

/// Retires the v1 sidecar directories by renaming them aside, atomically and
/// idempotently — the "defined old-file disposition" half of the D22 upgrade
/// (test-plan §3). Old data is never deleted (renamed, not removed), so a botched
/// upgrade is always recoverable by hand.
///
/// Callers must invoke this **only after** durably persisting this module's
/// converted output — this function has no way to verify that itself, since it
/// doesn't know the new format's storage location (§ module docs: doc-hash/UUID
/// minting is P2a-10's job). Idempotent: if `<dir>.v1-migrated` already exists,
/// that directory is left untouched and `<dir>` is not renamed again — the second
/// (and every subsequent) call on an already-migrated project is a no-op, matching
/// D22's "at most a one-time upgrade" contract. A project with no legacy sidecars
/// at all (never used v1, or already fully migrated) is likewise a no-op.
pub fn mark_legacy_sidecars_migrated(repo_root: &Path) -> io::Result<()> {
    for (old, migrated) in LEGACY_DIRS {
        let old_path = repo_root.join(old);
        let migrated_path = repo_root.join(migrated);
        if old_path.exists() && !migrated_path.exists() {
            fs::rename(&old_path, &migrated_path)?;
        }
    }
    Ok(())
}

// --- persisting: the P2a-10 project-wide upgrade --------------------------------

/// Reverses a v1 sidecar filename's path encoding (`legacy/v1`'s `comments/storage.rs` and
/// `track_changes/storage.rs`, both: `file_path.replace('\\', "/").replace('/', "__")`) to
/// recover the project-relative path a `.comments/<encoded>.json`/`.track-changes/<encoded>.json`
/// sidecar belongs to. Lossy exactly where v1's own encoding was lossy (a real path segment
/// containing a literal `__`) — not a limitation this module introduces.
pub fn decode_v1_sidecar_stem(stem: &str) -> String {
    stem.replace("__", "/")
}

/// Tallies for one project-wide [`run_v1_upgrade`] (test-plan §3's counted-invariant discipline,
/// extended to the project level). `failed_files` names any legacy sidecar this run could not
/// read/parse/persist — logged for visibility, never silently dropped; migration continues past a
/// single bad file rather than aborting the whole project (D22's per-file resilience).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct V1UpgradeSummary {
    pub documents_migrated: usize,
    pub comment_events_written: usize,
    pub change_records_written: usize,
    pub comment_orphans: usize,
    pub change_orphans: usize,
    pub failed_files: Vec<PathBuf>,
}

/// The one-shot, project-wide D22 upgrade: migrates every v1 `.comments/`/`.track-changes/`
/// sidecar still present under `repo_root` into `store`, then retires the legacy directories
/// (idempotent — see [`mark_legacy_sidecars_migrated`]). A project with no legacy sidecars at all
/// is a no-op returning an empty summary.
///
/// For each distinct encoded stem found in either legacy directory: decodes it back to a
/// project-relative path, mints or reuses that document's UUID
/// (`SidecarStore::get_or_mint_for_path` — TD §3.2b), reads the live document text if present (for
/// anchor resolution, § module docs), converts and persists its comments (if any) and its tracked
/// changes (if any) through the store's normal append path, and counts the result. Legacy
/// directories are retired **after** every document has been attempted, regardless of individual
/// failures — retiring is non-destructive (rename aside, never delete, § `mark_legacy_sidecars_
/// migrated`), so a partially-failed run still leaves the raw v1 data recoverable by hand.
pub fn run_v1_upgrade(store: &SidecarStore, repo_root: &Path) -> io::Result<V1UpgradeSummary> {
    let mut summary = V1UpgradeSummary::default();

    for stem in legacy_sidecar_stems(repo_root)? {
        let path = decode_v1_sidecar_stem(&stem);
        let doc_text = fs::read_to_string(repo_root.join(&path)).ok();

        let Ok(doc_id) = store.get_or_mint_for_path(&path) else {
            summary.failed_files.push(PathBuf::from(&path));
            continue;
        };

        let comments_path = repo_root.join(".comments").join(format!("{stem}.json"));
        if comments_path.exists() {
            match read_v1_comments(&comments_path) {
                Ok(comments) => {
                    let migration = migrate_comments(&comments, doc_text.as_deref());
                    for event in &migration.events {
                        if store.append_comment_event(doc_id, event).is_err() {
                            summary.failed_files.push(comments_path.clone());
                            break;
                        }
                    }
                    summary.comment_events_written += migration.events.len();
                    summary.comment_orphans += migration.orphans.len();
                }
                Err(_) => summary.failed_files.push(comments_path),
            }
        }

        let changes_path = repo_root
            .join(".track-changes")
            .join(format!("{stem}.json"));
        if changes_path.exists() {
            match read_v1_track_changes(&changes_path) {
                Ok(metadata) => {
                    let migration = migrate_changes(&metadata, doc_text.as_deref());
                    for record in &migration.records {
                        if store.append_change_record(doc_id, record).is_err() {
                            summary.failed_files.push(changes_path.clone());
                            break;
                        }
                    }
                    summary.change_records_written += migration.records.len();
                    summary.change_orphans += migration.orphans.len();
                }
                Err(_) => summary.failed_files.push(changes_path),
            }
        }

        summary.documents_migrated += 1;
    }

    mark_legacy_sidecars_migrated(repo_root)?;
    Ok(summary)
}

/// Every distinct encoded sidecar stem present in either legacy directory, sorted for
/// deterministic run order (`BTreeSet`) — a document with sidecars in only one of the two
/// directories still appears exactly once.
fn legacy_sidecar_stems(repo_root: &Path) -> io::Result<Vec<String>> {
    let mut stems = BTreeSet::new();
    for (dir_name, _) in LEGACY_DIRS {
        let dir = repo_root.join(dir_name);
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    stems.insert(stem.to_string());
                }
            }
        }
    }
    Ok(stems.into_iter().collect())
}

#[cfg(test)]
mod comment_fixtures {
    use super::*;

    pub fn root(
        id: &str,
        author: &str,
        created_at: &str,
        resolved: bool,
        range: Option<V1TextRange>,
    ) -> V1Comment {
        V1Comment {
            id: id.to_string(),
            range,
            author: author.to_string(),
            content: format!("comment {id}"),
            created_at: created_at.to_string(),
            resolved,
            parent_id: None,
        }
    }

    pub fn reply(id: &str, parent_id: &str, author: &str, created_at: &str) -> V1Comment {
        V1Comment {
            id: id.to_string(),
            range: None,
            author: author.to_string(),
            content: format!("reply {id}"),
            created_at: created_at.to_string(),
            resolved: false,
            parent_id: Some(parent_id.to_string()),
        }
    }

    pub fn range(start: usize, end: usize, snapshot: &str) -> V1TextRange {
        V1TextRange {
            start_offset: start,
            end_offset: end,
            text_snapshot: snapshot.to_string(),
        }
    }
}

#[cfg(test)]
mod timestamp_tests {
    use super::*;

    #[test]
    fn a_valid_rfc3339_timestamp_converts_to_epoch_millis() {
        assert_eq!(parse_v1_timestamp("2025-02-12T10:00:00Z"), 1739354400000);
    }

    #[test]
    fn a_corrupt_timestamp_falls_back_to_epoch_zero_rather_than_dropping_the_record() {
        assert_eq!(parse_v1_timestamp("not-a-timestamp"), 0);
        assert_eq!(parse_v1_timestamp(""), 0);
    }
}

#[cfg(test)]
mod comment_anchor_resolution_tests {
    use super::*;

    #[test]
    fn an_exact_offset_and_snapshot_match_resolves() {
        let doc_text = "The quick brown fox jumps.";
        let range = comment_fixtures::range(4, 9, "quick");
        match resolve_comment_anchor(Some(&Document::new(doc_text)), &range) {
            CommentAnchorResolution::Resolved(anchor) => {
                assert_eq!(anchor.text_snapshot, "quick");
                assert_eq!(anchor.offset, 4);
            }
            CommentAnchorResolution::Orphan { .. } => panic!("exact match must resolve"),
        }
    }

    #[test]
    fn drifted_offsets_over_intact_text_recover_via_fuzzy_reanchor() {
        // Simulates the CRLF-era ugly case: v1's stored offsets no longer land on
        // the quoted text (line-ending normalization shifted everything), but the
        // quoted text itself is untouched and unique elsewhere in the document.
        let doc_text = "PREFIX_INSERTED_LATER The quick brown fox jumps.";
        let range = comment_fixtures::range(4, 9, "quick"); // stale offset, wrong slice at 4..9 here
        match resolve_comment_anchor(Some(&Document::new(doc_text)), &range) {
            CommentAnchorResolution::Resolved(anchor) => {
                assert_eq!(anchor.text_snapshot, "quick");
                assert_eq!(
                    &doc_text[anchor.offset..anchor.offset + anchor.length],
                    "quick"
                );
            }
            CommentAnchorResolution::Orphan { .. } => {
                panic!("intact text elsewhere must be recovered")
            }
        }
    }

    #[test]
    fn text_rewritten_away_is_a_counted_orphan_with_the_quote_preserved() {
        let doc_text = "Nothing here shares any words with the original at all.";
        let range = comment_fixtures::range(4, 9, "quick");
        match resolve_comment_anchor(Some(&Document::new(doc_text)), &range) {
            CommentAnchorResolution::Orphan { quote } => assert_eq!(quote, "quick"),
            CommentAnchorResolution::Resolved(_) => panic!("rewritten-away text must orphan"),
        }
    }

    #[test]
    fn a_missing_document_orphans_every_anchored_comment_with_its_quote() {
        let range = comment_fixtures::range(4, 9, "quick");
        match resolve_comment_anchor(None, &range) {
            CommentAnchorResolution::Orphan { quote } => assert_eq!(quote, "quick"),
            CommentAnchorResolution::Resolved(_) => panic!("no document to check against"),
        }
    }
}

#[cfg(test)]
mod change_anchor_resolution_tests {
    use super::*;

    #[test]
    fn a_marker_starting_exactly_at_the_stored_offset_resolves() {
        let doc_text = "before {++inserted++} after";
        let doc = Document::new(doc_text);
        let markers = textops::parse(doc_text);
        let anchor = resolve_change_anchor(Some(&doc), &markers, 7).expect("marker at offset 7");
        assert_eq!(
            &doc_text[anchor.offset..anchor.offset + anchor.length],
            "{++inserted++}"
        );
    }

    #[test]
    fn no_marker_at_the_stored_offset_is_none() {
        let doc_text = "no markup here at all";
        let doc = Document::new(doc_text);
        let markers = textops::parse(doc_text);
        assert!(resolve_change_anchor(Some(&doc), &markers, 3).is_none());
    }

    #[test]
    fn a_missing_document_never_resolves() {
        assert!(resolve_change_anchor(None, &[], 0).is_none());
    }

    #[test]
    fn best_effort_quote_takes_up_to_forty_bytes_at_the_offset() {
        let doc_text = "before {++inserted++} after";
        let quote = best_effort_change_quote(Some(doc_text), 7);
        assert_eq!(quote, "{++inserted++} after"); // whole remaining tail, under 40 bytes
    }

    #[test]
    fn best_effort_quote_is_empty_when_the_offset_is_out_of_bounds() {
        assert_eq!(best_effort_change_quote(Some("short"), 100), "");
        assert_eq!(best_effort_change_quote(None, 0), "");
    }
}

#[cfg(test)]
mod migrate_comments_tests {
    use super::*;

    #[test]
    fn a_root_comment_becomes_a_single_create_event() {
        let comments = vec![comment_fixtures::root(
            "c1",
            "user",
            "2025-01-01T00:00:00Z",
            false,
            None,
        )];
        let migration = migrate_comments(&comments, None);
        assert_eq!(migration.events.len(), 1);
        match &migration.events[0].kind {
            EventKind::Create { body, anchor, .. } => {
                assert_eq!(body, "comment c1");
                assert!(anchor.is_none());
            }
            other => panic!("expected Create, got {other:?}"),
        }
        assert_eq!(migration.counts.threads_in, 1);
        assert_eq!(migration.counts.creates_out, 1);
    }

    #[test]
    fn a_reply_becomes_a_single_reply_event_targeting_its_parent() {
        let comments = vec![
            comment_fixtures::root("c1", "user", "2025-01-01T00:00:00Z", false, None),
            comment_fixtures::reply("r1", "c1", "assistant", "2025-01-01T00:01:00Z"),
        ];
        let migration = migrate_comments(&comments, None);
        assert_eq!(migration.counts.threads_in, 1);
        assert_eq!(migration.counts.replies_in, 1);
        assert_eq!(migration.counts.creates_out, 1);
        assert_eq!(migration.counts.replies_out, 1);

        let fold = crate::store::comments::fold(migration.events.clone());
        let thread = fold.threads.get("c1").unwrap();
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].author, "assistant");
    }

    #[test]
    fn a_resolved_comment_additionally_emits_a_resolve_event() {
        let comments = vec![comment_fixtures::root(
            "c1",
            "user",
            "2025-01-01T00:00:00Z",
            true,
            None,
        )];
        let migration = migrate_comments(&comments, None);
        assert_eq!(migration.counts.resolutions_in, 1);
        assert_eq!(migration.counts.resolves_out, 1);
        assert_eq!(migration.events.len(), 2); // Create + Resolve

        let fold = crate::store::comments::fold(migration.events.clone());
        assert!(fold.threads["c1"].resolved);
    }

    #[test]
    fn the_full_causal_chain_folds_correctly_after_migration() {
        let comments = vec![
            comment_fixtures::root("c1", "user", "2025-01-01T00:00:00Z", false, None),
            comment_fixtures::reply("r1", "c1", "assistant", "2025-01-01T00:01:00Z"),
            comment_fixtures::root("c2", "user", "2025-01-01T00:02:00Z", true, None),
        ];
        let migration = migrate_comments(&comments, None);
        assert_eq!(migration.counts.threads_in, 2);
        assert_eq!(migration.counts.replies_in, 1);
        assert_eq!(migration.counts.resolutions_in, 1);

        let fold = crate::store::comments::fold(migration.events);
        assert_eq!(fold.threads.len(), 2);
        assert!(!fold.threads["c1"].resolved);
        assert_eq!(fold.threads["c1"].replies.len(), 1);
        assert!(fold.threads["c2"].resolved);
    }

    #[test]
    fn an_anchored_comment_with_intact_text_resolves_and_is_counted() {
        let doc_text = "The quick brown fox jumps.";
        let range = comment_fixtures::range(4, 9, "quick");
        let comments = vec![comment_fixtures::root(
            "c1",
            "user",
            "2025-01-01T00:00:00Z",
            false,
            Some(range),
        )];
        let migration = migrate_comments(&comments, Some(doc_text));
        assert_eq!(migration.counts.anchors_resolved, 1);
        assert_eq!(migration.counts.anchors_orphaned, 0);
        assert!(migration.orphans.is_empty());
        match &migration.events[0].kind {
            EventKind::Create { anchor, .. } => {
                assert_eq!(anchor.as_ref().unwrap().text_snapshot, "quick");
            }
            other => panic!("expected Create, got {other:?}"),
        }
    }

    #[test]
    fn an_anchored_comment_whose_text_is_gone_is_a_counted_orphan_but_the_event_still_emits() {
        let doc_text = "Completely different text sharing nothing with the quote.";
        let range = comment_fixtures::range(4, 9, "quick");
        let comments = vec![comment_fixtures::root(
            "c1",
            "user",
            "2025-01-01T00:00:00Z",
            false,
            Some(range),
        )];
        let migration = migrate_comments(&comments, Some(doc_text));
        assert_eq!(migration.counts.anchors_orphaned, 1);
        assert_eq!(migration.orphans.len(), 1);
        assert_eq!(migration.orphans[0].id, "c1");
        assert_eq!(migration.orphans[0].quote, "quick");
        // The event is still emitted (comment anchors are optional) — counted, never dropped.
        assert_eq!(migration.counts.creates_out, 1);
        match &migration.events[0].kind {
            EventKind::Create { anchor, .. } => assert!(anchor.is_none()),
            other => panic!("expected Create, got {other:?}"),
        }
    }

    #[test]
    fn migrating_the_same_input_twice_is_byte_identical_re_run() {
        let doc_text = "The quick brown fox jumps.";
        let range = comment_fixtures::range(4, 9, "quick");
        let comments = vec![
            comment_fixtures::root("c1", "user", "2025-01-01T00:00:00Z", true, Some(range)),
            comment_fixtures::reply("r1", "c1", "assistant", "2025-01-01T00:01:00Z"),
        ];
        let first = migrate_comments(&comments, Some(doc_text));
        let second = migrate_comments(&comments, Some(doc_text));
        let first_bytes: Vec<Vec<u8>> = first
            .events
            .iter()
            .map(|e| serde_json::to_vec(e).unwrap())
            .collect();
        let second_bytes: Vec<Vec<u8>> = second
            .events
            .iter()
            .map(|e| serde_json::to_vec(e).unwrap())
            .collect();
        assert_eq!(first_bytes, second_bytes);
        assert_eq!(first.counts, second.counts);
    }

    #[test]
    fn every_v1_comment_lands_in_exactly_one_bucket_counted_invariant() {
        let doc_text = "The quick brown fox jumps.";
        let comments = vec![
            comment_fixtures::root(
                "c1",
                "user",
                "2025-01-01T00:00:00Z",
                true,
                Some(comment_fixtures::range(4, 9, "quick")),
            ),
            comment_fixtures::root(
                "c2",
                "user",
                "2025-01-01T00:01:00Z",
                false,
                Some(comment_fixtures::range(0, 100, "out of bounds")),
            ),
            comment_fixtures::reply("r1", "c1", "assistant", "2025-01-01T00:02:00Z"),
        ];
        let migration = migrate_comments(&comments, Some(doc_text));
        assert_eq!(migration.counts.creates_out, migration.counts.threads_in);
        assert_eq!(migration.counts.replies_out, migration.counts.replies_in);
        assert_eq!(
            migration.counts.resolves_out,
            migration.counts.resolutions_in
        );
        assert_eq!(
            migration.counts.anchors_resolved + migration.counts.anchors_orphaned,
            2
        );
    }
}

#[cfg(test)]
mod migrate_changes_tests {
    use super::*;

    fn entry(id: &str, kind: V1ChangeType, start_offset: usize) -> V1ChangeEntry {
        V1ChangeEntry {
            id: id.to_string(),
            change_type: kind,
            start_offset,
            author: "user".to_string(),
            timestamp: "2025-01-01T00:00:00Z".to_string(),
            group_id: None,
        }
    }

    #[test]
    fn a_change_whose_marker_still_exists_becomes_a_change_record() {
        let doc_text = "before {++inserted++} after";
        let metadata = V1TrackChangesMetadata {
            changes: vec![entry("ch1", V1ChangeType::Insertion, 7)],
        };
        let migration = migrate_changes(&metadata, Some(doc_text));
        assert_eq!(migration.counts.changes_in, 1);
        assert_eq!(migration.counts.records_out, 1);
        assert_eq!(migration.counts.orphaned_out, 0);
        assert_eq!(migration.records[0].kind, ChangeType::Insertion);
        assert_eq!(migration.records[0].author, "user");
    }

    #[test]
    fn a_change_whose_marker_is_gone_is_a_counted_orphan_not_a_record() {
        let doc_text = "the marker was accepted and no longer exists here";
        let metadata = V1TrackChangesMetadata {
            changes: vec![entry("ch1", V1ChangeType::Deletion, 4)],
        };
        let migration = migrate_changes(&metadata, Some(doc_text));
        assert_eq!(migration.counts.changes_in, 1);
        assert_eq!(migration.counts.records_out, 0);
        assert_eq!(migration.counts.orphaned_out, 1);
        assert_eq!(migration.orphans[0].id, "ch1");
    }

    #[test]
    fn every_v1_change_lands_in_exactly_one_bucket_counted_invariant() {
        let doc_text = "before {++inserted++} after {--deleted--} tail";
        let deletion_offset = doc_text.find("{--deleted--}").unwrap();
        let metadata = V1TrackChangesMetadata {
            changes: vec![
                entry("ch1", V1ChangeType::Insertion, 7),
                entry("ch2", V1ChangeType::Deletion, deletion_offset),
                entry("ch3", V1ChangeType::Substitution, 999), // no marker there
            ],
        };
        let migration = migrate_changes(&metadata, Some(doc_text));
        assert_eq!(
            migration.counts.records_out + migration.counts.orphaned_out,
            migration.counts.changes_in
        );
        assert_eq!(migration.counts.records_out, 2);
        assert_eq!(migration.counts.orphaned_out, 1);
    }

    #[test]
    fn migrating_the_same_input_twice_is_byte_identical_re_run() {
        let doc_text = "before {++inserted++} after";
        let metadata = V1TrackChangesMetadata {
            changes: vec![entry("ch1", V1ChangeType::Insertion, 7)],
        };
        let first = migrate_changes(&metadata, Some(doc_text));
        let second = migrate_changes(&metadata, Some(doc_text));
        let first_bytes: Vec<Vec<u8>> = first
            .records
            .iter()
            .map(|r| serde_json::to_vec(r).unwrap())
            .collect();
        let second_bytes: Vec<Vec<u8>> = second
            .records
            .iter()
            .map(|r| serde_json::to_vec(r).unwrap())
            .collect();
        assert_eq!(first_bytes, second_bytes);
    }
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    #[test]
    fn a_realistic_v1_comments_file_deserializes() {
        // As actually written by v1 (`comments/storage.rs`'s `save_comments`),
        // including fields this module doesn't model (github/publish-status) —
        // the "mixed old+new" ugly case: unknown keys are silently ignored.
        let json = r#"[
            {
                "id": "c1",
                "file_path": "docs/README.md",
                "range": { "start_offset": 10, "end_offset": 25, "text_snapshot": "some selected text", "start_line": 3, "start_col": 5 },
                "author": "user",
                "content": "This paragraph needs work.",
                "created_at": "2025-02-12T10:00:00Z",
                "resolved": false,
                "parent_id": null,
                "source": "local",
                "publish_status": "draft"
            },
            {
                "id": "c2",
                "file_path": "docs/README.md",
                "range": null,
                "author": "assistant",
                "content": "General feedback.",
                "created_at": "2025-02-12T11:00:00Z",
                "resolved": true,
                "parent_id": null
            }
        ]"#;
        let comments: Vec<V1Comment> = serde_json::from_str(json).unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(
            comments[0].range.as_ref().unwrap().text_snapshot,
            "some selected text"
        );
        assert!(comments[1].resolved);
    }

    #[test]
    fn a_realistic_v1_track_changes_file_deserializes() {
        let json = r#"{
            "trackingEnabled": true,
            "changes": [
                { "id": "ch1", "type": "insertion", "startOffset": 42, "author": "CJ", "authorType": "human", "timestamp": "2026-04-04T00:00:00Z", "groupId": "g1", "resolved": false }
            ]
        }"#;
        let metadata: V1TrackChangesMetadata = serde_json::from_str(json).unwrap();
        assert_eq!(metadata.changes.len(), 1);
        assert_eq!(metadata.changes[0].id, "ch1");
        assert_eq!(metadata.changes[0].change_type, V1ChangeType::Insertion);
        assert_eq!(metadata.changes[0].group_id.as_deref(), Some("g1"));
    }

    #[test]
    fn a_v1_track_changes_file_missing_the_changes_key_defaults_to_empty() {
        let json = r#"{ "trackingEnabled": false }"#;
        let metadata: V1TrackChangesMetadata = serde_json::from_str(json).unwrap();
        assert!(metadata.changes.is_empty());
    }
}

#[cfg(test)]
mod file_reading_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_v1_comments_parses_a_valid_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, r#"[{"id":"c1","range":null,"author":"user","content":"hi","created_at":"2025-01-01T00:00:00Z","resolved":false,"parent_id":null}]"#).unwrap();
        let comments = read_v1_comments(&path).unwrap();
        assert_eq!(comments.len(), 1);
    }

    #[test]
    fn read_v1_comments_reports_truncated_json_as_a_defined_error_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("truncated.json");
        fs::write(&path, r#"[{"id":"c1","range":null,"author":"user"#).unwrap();
        match read_v1_comments(&path) {
            Err(ImportError::CorruptJson { .. }) => {}
            other => panic!("expected CorruptJson, got {other:?}"),
        }
    }

    #[test]
    fn read_v1_comments_reports_a_missing_file_as_a_defined_io_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        match read_v1_comments(&path) {
            Err(ImportError::Io { .. }) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn read_v1_track_changes_parses_a_valid_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, r#"{"trackingEnabled":true,"changes":[]}"#).unwrap();
        let metadata = read_v1_track_changes(&path).unwrap();
        assert!(metadata.changes.is_empty());
    }

    #[test]
    fn read_v1_track_changes_reports_corrupt_json_as_a_defined_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("corrupt.json");
        fs::write(&path, "{not json at all").unwrap();
        match read_v1_track_changes(&path) {
            Err(ImportError::CorruptJson { .. }) => {}
            other => panic!("expected CorruptJson, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod disposition_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn legacy_sidecar_dirs_are_renamed_aside() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::create_dir(dir.path().join(".track-changes")).unwrap();
        fs::write(dir.path().join(".comments/doc.json"), "[]").unwrap();

        mark_legacy_sidecars_migrated(dir.path()).unwrap();

        assert!(!dir.path().join(".comments").exists());
        assert!(!dir.path().join(".track-changes").exists());
        assert!(dir.path().join(".comments.v1-migrated/doc.json").exists());
        assert!(dir.path().join(".track-changes.v1-migrated").exists());
    }

    #[test]
    fn a_project_with_no_legacy_sidecars_is_a_no_op() {
        let dir = TempDir::new().unwrap();
        mark_legacy_sidecars_migrated(dir.path()).unwrap();
        assert!(!dir.path().join(".comments.v1-migrated").exists());
    }

    #[test]
    fn re_running_after_a_completed_migration_is_idempotent() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(dir.path().join(".comments/doc.json"), "[]").unwrap();

        mark_legacy_sidecars_migrated(dir.path()).unwrap();
        assert!(dir.path().join(".comments.v1-migrated/doc.json").exists());

        // Second call: `.comments` is already gone, `.v1-migrated` already exists —
        // must not error and must leave the migrated directory exactly as it was.
        mark_legacy_sidecars_migrated(dir.path()).unwrap();
        assert!(dir.path().join(".comments.v1-migrated/doc.json").exists());
    }

    #[test]
    fn a_stray_new_comments_dir_alongside_an_already_migrated_one_is_left_alone() {
        // Mixed old+new: a fresh `.comments` reappeared after migration already
        // completed (e.g. a second, older backup restored over it). The already-
        // migrated data must not be clobbered by a second rename.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments.v1-migrated")).unwrap();
        fs::write(dir.path().join(".comments.v1-migrated/original.json"), "[]").unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(dir.path().join(".comments/stray.json"), "[]").unwrap();

        mark_legacy_sidecars_migrated(dir.path()).unwrap();

        assert!(dir
            .path()
            .join(".comments.v1-migrated/original.json")
            .exists());
        assert!(dir.path().join(".comments/stray.json").exists());
    }
}

#[cfg(test)]
mod decode_stem_tests {
    use super::*;

    #[test]
    fn a_flat_filename_decodes_unchanged() {
        assert_eq!(decode_v1_sidecar_stem("readme.md"), "readme.md");
    }

    #[test]
    fn double_underscore_separators_decode_to_slashes() {
        assert_eq!(
            decode_v1_sidecar_stem("chapters__01-the-well.md"),
            "chapters/01-the-well.md"
        );
        assert_eq!(decode_v1_sidecar_stem("a__b__c.md"), "a/b/c.md");
    }
}

#[cfg(test)]
mod run_v1_upgrade_tests {
    use super::*;
    use tempfile::TempDir;

    fn v1_comment(id: &str, text: &str) -> String {
        format!(
            r#"[{{"id":"{id}","range":{{"start_offset":0,"end_offset":{len},"text_snapshot":"{text}"}},"author":"user","content":"note on {id}","created_at":"2025-01-01T00:00:00Z","resolved":false,"parent_id":null}}]"#,
            len = text.len()
        )
    }

    fn v1_track_changes(id: &str, start_offset: usize) -> String {
        format!(
            r#"{{"trackingEnabled":true,"changes":[{{"id":"{id}","type":"insertion","startOffset":{start_offset},"author":"user","authorType":"human","timestamp":"2025-01-01T00:00:00Z"}}]}}"#
        )
    }

    #[test]
    fn a_project_with_no_legacy_sidecars_migrates_nothing() {
        let dir = TempDir::new().unwrap();
        let store = SidecarStore::new(dir.path());
        let summary = run_v1_upgrade(&store, dir.path()).unwrap();
        assert_eq!(summary, V1UpgradeSummary::default());
    }

    #[test]
    fn a_comment_only_document_is_migrated_and_persisted_through_the_store() {
        let dir = TempDir::new().unwrap();
        // Decoded path is "chapters/01.md" — the live document lives at the *decoded* path, not
        // the encoded sidecar filename.
        fs::create_dir(dir.path().join("chapters")).unwrap();
        fs::write(
            dir.path().join("chapters/01.md"),
            "The quick brown fox jumps.",
        )
        .unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(
            dir.path().join(".comments/chapters__01.md.json"),
            v1_comment("c1", "quick"),
        )
        .unwrap();

        let store = SidecarStore::new(dir.path());
        let summary = run_v1_upgrade(&store, dir.path()).unwrap();

        assert_eq!(summary.documents_migrated, 1);
        assert_eq!(summary.comment_events_written, 1);
        assert_eq!(summary.comment_orphans, 0);
        assert!(summary.failed_files.is_empty());

        let doc_id = store
            .doc_id_for_path("chapters/01.md")
            .unwrap()
            .expect("migrated doc registered under its decoded path");
        let fold = store.fold_comments(doc_id).unwrap();
        assert_eq!(fold.threads.len(), 1);
        let thread = fold.threads.get("c1").unwrap();
        match &thread.anchor {
            Some(anchor) => assert_eq!(anchor.text_snapshot, "quick"),
            None => panic!("expected the anchor to resolve against the live document"),
        }
    }

    #[test]
    fn a_document_with_both_comments_and_track_changes_shares_one_doc_id() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("notes.md"), "before {++inserted++} after").unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(
            dir.path().join(".comments/notes.md.json"),
            v1_comment("c1", "before"),
        )
        .unwrap();
        fs::create_dir(dir.path().join(".track-changes")).unwrap();
        fs::write(
            dir.path().join(".track-changes/notes.md.json"),
            v1_track_changes("ch1", 7),
        )
        .unwrap();

        let store = SidecarStore::new(dir.path());
        let summary = run_v1_upgrade(&store, dir.path()).unwrap();

        assert_eq!(summary.documents_migrated, 1);
        assert_eq!(summary.comment_events_written, 1);
        assert_eq!(summary.change_records_written, 1);

        let doc_id = store.doc_id_for_path("notes.md").unwrap().unwrap();
        assert_eq!(store.fold_comments(doc_id).unwrap().threads.len(), 1);
        assert_eq!(store.fold_changes(doc_id).unwrap().changes.len(), 1);
    }

    #[test]
    fn legacy_directories_are_retired_once_the_upgrade_completes() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(
            dir.path().join(".comments/untitled.json"),
            v1_comment("c1", "hi"),
        )
        .unwrap();

        let store = SidecarStore::new(dir.path());
        run_v1_upgrade(&store, dir.path()).unwrap();

        assert!(!dir.path().join(".comments").exists());
        assert!(dir
            .path()
            .join(".comments.v1-migrated/untitled.json")
            .exists());
    }

    #[test]
    fn running_the_upgrade_twice_does_not_duplicate_migrated_events() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(
            dir.path().join(".comments/untitled.json"),
            v1_comment("c1", "hi"),
        )
        .unwrap();

        let store = SidecarStore::new(dir.path());
        let first = run_v1_upgrade(&store, dir.path()).unwrap();
        // Legacy `.comments` is already retired — a second run finds nothing left to migrate.
        let second = run_v1_upgrade(&store, dir.path()).unwrap();

        assert_eq!(first.documents_migrated, 1);
        assert_eq!(second, V1UpgradeSummary::default());

        let doc_id = store.doc_id_for_path("untitled").unwrap().unwrap();
        assert_eq!(store.fold_comments(doc_id).unwrap().threads.len(), 1);
    }

    #[test]
    fn a_corrupt_sidecar_file_is_recorded_as_failed_but_does_not_stop_the_rest_of_the_project() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        fs::write(dir.path().join(".comments/broken.json"), "{not json at all").unwrap();
        fs::write(
            dir.path().join(".comments/good.json"),
            v1_comment("c1", "hi"),
        )
        .unwrap();

        let store = SidecarStore::new(dir.path());
        let summary = run_v1_upgrade(&store, dir.path()).unwrap();

        assert_eq!(summary.documents_migrated, 2); // both doc ids still get minted/registered
        assert_eq!(summary.comment_events_written, 1); // only the good file's event
        assert_eq!(summary.failed_files.len(), 1);
        assert!(summary.failed_files[0].ends_with("broken.json"));

        // The corrupt file's raw data survives, untouched, under the retired directory.
        assert!(dir
            .path()
            .join(".comments.v1-migrated/broken.json")
            .exists());
    }

    #[test]
    fn a_resolved_v1_comment_migrates_with_its_resolve_event() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".comments")).unwrap();
        let json = r#"[{"id":"c1","range":null,"author":"user","content":"done","created_at":"2025-01-01T00:00:00Z","resolved":true,"parent_id":null}]"#;
        fs::write(dir.path().join(".comments/resolved.json"), json).unwrap();

        let store = SidecarStore::new(dir.path());
        let summary = run_v1_upgrade(&store, dir.path()).unwrap();
        assert_eq!(summary.comment_events_written, 2); // Create + synthetic Resolve

        let doc_id = store.doc_id_for_path("resolved").unwrap().unwrap();
        let fold = store.fold_comments(doc_id).unwrap();
        assert!(fold.threads["c1"].resolved);
    }
}
