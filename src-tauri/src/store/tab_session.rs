// ABOUTME: Per-project tab-session persistence (TD §3.1: "tab-session persistence with per-tab
// ABOUTME: unsaved-content cap") — FR-ED-3's session-restore state, capped and machine-local.

//! FR-ED-3: "closing the project and reopening it restores the previously open tab set,
//! including content of dirty (unsaved) tabs, up to the per-tab cap." This module is the `store/`
//! half of that requirement — a pure `Session` shape (which tabs were open, which was active, and
//! each dirty tab's capped unsaved content) plus its atomic disk I/O, following the same
//! pure-shape-plus-load/save split `store::docs_map` already uses.
//!
//! # Machine-local, not committed (TD-12 precedent)
//!
//! Unlike the TD-4 sidecars (`comments/`, `changes/`, `docs.json`) — which are collaboration data,
//! repo-owned and committed by default — a tab session is per-machine UI state: which files *this*
//! window had open, and in-flight edits nobody has chosen to save yet. Committing or syncing that
//! would leak a contributor's scratch/unsaved text to every collaborator on every save and spam
//! review history with pure UI churn, which is not what TD-4's "committed by default" is for. It is
//! excluded from commit/sync via a committed `.emend/.gitignore` entry (`store::gitignore`), so
//! every clone/machine ignores its own local session file with no checkpointer-side special case.
//! TD-12 first recorded that mechanism for `store::lock`'s runtime files; its 2026-08-14 amendment
//! narrows the excluded list to **exactly this file**, because TD-20 moved the ownership registry
//! out of the project folder entirely — so this module is `ensure_pattern`'s one production caller.
//!
//! # The per-tab unsaved-content cap
//!
//! `TabSnapshot::new` enforces `UNSAVED_CONTENT_CAP_BYTES` per tab: content at or under the cap is
//! kept, over-cap content is dropped (`unsaved_content: None`) rather than failing the whole
//! session save, with `unsaved_content_omitted` recording why. An ordinary tab then restores from
//! disk; J2's file-less recovery document instead restores its standing loss state, including the
//! author's durable collapsed/full-notice choice (#1421).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::atomic;
use crate::store::gitignore;

/// Bumped whenever the on-wire shape changes in a way a reader could *misinterpret* (TD-4's "every
/// file carries `schema_version`" convention, followed here even though this sidecar isn't itself a
/// TD-4 committed one).
///
/// Deliberately still `1` after `TabSnapshot::recovered_from` was added (#932; the judgment is
/// recorded in full in `docs/formats/tab-session.md`): the addition is optional in both directions
/// and cannot be misread — its absence means "an ordinary project tab", which is exactly what every
/// writer of a version-1 file meant, since no such build could produce a recovery document. Bumping
/// would instead make `parse_or_fresh` reject every existing session on the first launch after the
/// upgrade, discarding precisely the unsaved buffers this field was added to preserve.
pub const SCHEMA_VERSION: u32 = 1;

/// Above this many UTF-8 bytes of *unsaved* content, a tab's dirty edit is not persisted across a
/// restart (see module docs) — generous enough that only a genuinely huge in-flight edit hits it,
/// never an ordinary chapter draft.
// @anchor:session-unsaved-content-cap-rust
pub const UNSAVED_CONTENT_CAP_BYTES: usize = 2 * 1024 * 1024;

const SESSION_FILE_NAME: &str = "tab-session.json";
const GITIGNORE_PATTERN: &str = "tab-session.json";

/// One open tab's restorable state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabSnapshot {
    /// The tab's identity: a project-relative path (§3.5 confinement) for an ordinary tab, or the
    /// opaque identity the frontend minted for an untitled recovery document (see
    /// `recovered_from`). Nothing here parses it — which of the two it is, is `recovered_from`.
    pub path: String,
    /// Path-independent sidecar identity for an untitled recovery document. Optional so every
    /// version-1 snapshot written before #1803 continues to restore; the frontend mints and
    /// checkpoints a missing identity before exposing the first sidecar-writing action.
    #[serde(default)]
    pub doc_id: Option<String>,
    /// The tab's unsaved content, captured at snapshot time. `None` means "restore from disk" —
    /// either the tab was clean (its content already matches the file), or
    /// `unsaved_content_omitted` records that its dirty content exceeded the cap. A recovery
    /// document is the one tab whose content is `Some` while it is *not* dirty: it has no disk to
    /// restore from, so this is the only durable copy of it (#932, CJ 2026-08-11).
    pub unsaved_content: Option<String>,
    /// For an untitled recovery document, its former project path: displaced by an external move
    /// (#932) or refused as an unsupported document on legacy restore (#2515). `None` for every
    /// ordinary tab.
    ///
    /// A session written before this field existed must still restore, rather than failing to
    /// parse and being degraded by `parse_or_fresh` into "no session to restore" — which would
    /// silently discard every tab and every unsaved buffer in that file. See `SCHEMA_VERSION` for
    /// why that is preferred to a version bump; the `io_tests` case named
    /// `a_session_written_before_recovered_from_existed_still_restores` is what pins it, and
    /// `#[serde(default)]` states that requirement at the boundary rather than resting it on the
    /// implicit default a missing `Option` already gets.
    #[serde(default)]
    pub recovered_from: Option<String>,
    /// Stable creation-order disambiguator for repeated displacement of the same path. Optional so
    /// version-1 sessions written before 9d.3 still restore and are normalized by the frontend.
    #[serde(default)]
    pub displaced_label_ordinal: Option<u32>,
    /// Whether `unsaved_content` was deliberately omitted because it exceeded the per-tab cap.
    /// This is explicit because `None` also means an ordinary clean tab; recovery-document UI must
    /// not infer a standing data-loss outcome from the absence of content alone (#1421).
    #[serde(default)]
    pub unsaved_content_omitted: bool,
    /// The author's persisted presentation choice for an over-cap recovery document. This can be
    /// true only while both `recovered_from` and `unsaved_content_omitted` are present; normalization
    /// clears impossible combinations from hand-edited or older session files.
    #[serde(default)]
    pub loss_notice_collapsed: bool,
}

impl TabSnapshot {
    /// Builds a snapshot for an ordinary project tab at `path`, applying the per-tab cap:
    /// `dirty_content` — the tab's current editor text, or `None` if the tab is clean — is kept
    /// only when it is `Some` and its byte length is within the cap; oversized dirty content
    /// degrades to `None` rather than failing the whole session save.
    pub fn new(path: impl Into<String>, dirty_content: Option<String>) -> TabSnapshot {
        let unsaved_content_omitted = dirty_content
            .as_ref()
            .is_some_and(|content| content.len() > UNSAVED_CONTENT_CAP_BYTES);
        let unsaved_content = dirty_content.filter(|c| c.len() <= UNSAVED_CONTENT_CAP_BYTES);
        TabSnapshot {
            path: path.into(),
            doc_id: None,
            unsaved_content,
            recovered_from: None,
            displaced_label_ordinal: None,
            unsaved_content_omitted,
            loss_notice_collapsed: false,
        }
    }

    /// Attaches an already-minted path-independent sidecar identity to an untitled snapshot.
    pub fn with_doc_id(self, doc_id: Option<String>) -> TabSnapshot {
        TabSnapshot { doc_id, ..self }
    }

    /// Marks this snapshot an untitled recovery document from `recovered_from` (`None` leaves it
    /// an ordinary project tab), so the restored tab is re-identified from the record rather than
    /// from the spelling of its `path` (CJ, 2026-08-12; D27 #2515).
    pub fn displaced_from(self, recovered_from: Option<String>) -> TabSnapshot {
        TabSnapshot {
            recovered_from,
            ..self
        }
    }

    /// Carries 9d.3's stable duplicate-label ordinal across relaunch without deriving it from the
    /// opaque recovery identity or renumbering surviving siblings.
    pub fn with_displaced_label_ordinal(self, displaced_label_ordinal: Option<u32>) -> TabSnapshot {
        TabSnapshot {
            displaced_label_ordinal: displaced_label_ordinal.filter(|ordinal| *ordinal > 0),
            ..self
        }
    }

    /// Applies the frontend's already-durable recovery presentation state. The constructor may
    /// independently discover a newly over-cap buffer while enforcing the cap, so omission is
    /// combined rather than overwritten. A collapsed notice without both an omitted buffer and a
    /// recovery identity is invalid and is normalized away fail-soft.
    pub fn with_recovery_persistence(
        self,
        unsaved_content_omitted: bool,
        loss_notice_collapsed: bool,
    ) -> TabSnapshot {
        let unsaved_content_omitted = self.unsaved_content_omitted || unsaved_content_omitted;
        let loss_notice_collapsed =
            loss_notice_collapsed && unsaved_content_omitted && self.recovered_from.is_some();
        TabSnapshot {
            unsaved_content_omitted,
            loss_notice_collapsed,
            ..self
        }
    }

    fn normalize_after_load(mut self) -> TabSnapshot {
        if self.recovered_from.is_none() {
            self.doc_id = None;
        } else if self
            .doc_id
            .as_deref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            // A malformed persisted identity cannot own sidecars. Fail soft to the legacy shape so
            // the frontend mints and checkpoints a usable UUID instead of wedging this tab forever.
            self.doc_id = None;
        }
        self.displaced_label_ordinal = self
            .displaced_label_ordinal
            .filter(|ordinal| *ordinal > 0 && self.recovered_from.is_some());
        // Version-1 recovery records written before #1421 had no explicit outcome field. In the J2
        // lifecycle such a tab exists only for dirty displaced work, and the cap is the sole route
        // to `None`, so preserve that legacy meaning once at the storage boundary. New records no
        // longer require frontend inference.
        if self.recovered_from.is_some()
            && self.unsaved_content.is_none()
            && !self.unsaved_content_omitted
        {
            // A missing/false outcome on the legacy null-content shape is the one migration path.
            self.unsaved_content_omitted = true;
        }
        // The explicit writer outcome remains authoritative even for an ordinary project tab;
        // only the recovery-document UI is gated on `recovered_from`. Explicit omission may also
        // coexist with content after an editable recovery document receives new text.
        self.loss_notice_collapsed &= self.recovered_from.is_some() && self.unsaved_content_omitted;
        self
    }
}

/// The whole persisted session for one project: its open tab set, in order, plus which one (if
/// any) was active.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub schema_version: u32,
    pub tabs: Vec<TabSnapshot>,
    pub active_path: Option<String>,
}

impl Session {
    pub fn new(tabs: Vec<TabSnapshot>, active_path: Option<String>) -> Session {
        Session {
            schema_version: SCHEMA_VERSION,
            tabs,
            active_path,
        }
    }
}

impl Default for Session {
    fn default() -> Session {
        Session::new(Vec::new(), None)
    }
}

fn session_path(root: &Path) -> PathBuf {
    emend_dir(root).join(SESSION_FILE_NAME)
}

fn emend_dir(root: &Path) -> PathBuf {
    root.join(".emend")
}

/// Persists `session` for the project at `root`, atomically (write-then-rename — a crash mid-write
/// leaves the previous, still-valid session in place, never a torn one), and ensures the runtime
/// file is gitignored (TD-12 precedent, see module docs).
pub fn save(root: &Path, session: &Session) -> io::Result<()> {
    gitignore::ensure_pattern(
        &emend_dir(root),
        GITIGNORE_PATTERN,
        "# Machine-local tab-session state (TD §3.1, P2a-6) — never committed/synced.",
    )?;
    atomic::write_json(&session_path(root), session)
}

/// Loads the persisted session for `root`. A project that has never had a session saved (or whose
/// tab-session file is missing for any other reason) restores to an empty session, not an error —
/// the same "missing = fresh" convention `docs_map::load` uses. A file that exists but isn't a
/// session this exact schema version wrote (see `parse_or_fresh`) fails soft the same way, per the
/// module docs' "fail-soft restore" (CJ ruling, #143): reading this file has exactly two
/// acceptable outcomes, the session it names or "no session to restore," never a crash.
pub fn load(root: &Path) -> io::Result<Session> {
    match fs::read_to_string(session_path(root)) {
        Ok(content) => Ok(parse_or_fresh(&content)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Session::default()),
        Err(e) => Err(e),
    }
}

/// Parses a session file's raw content, degrading to a fresh empty session for anything that
/// isn't a session this exact schema version wrote: truncated/invalid JSON, a sync-conflict
/// artifact left by a non-git sync tool, or a `schema_version` this build doesn't recognize
/// (older or newer — never guess at fields under an assumption that may not hold). A genuine I/O
/// problem reading the file (permissions, etc.) is a different kind of failure and still
/// propagates as an `Err` from `load` above; this function only ever sees content that was
/// readable, so it never itself needs to error.
fn parse_or_fresh(content: &str) -> Session {
    serde_json::from_str::<Session>(content)
        .ok()
        .filter(|session| session.schema_version == SCHEMA_VERSION)
        .map(|mut session| {
            session.tabs = session
                .tabs
                .into_iter()
                .map(TabSnapshot::normalize_after_load)
                .collect();
            session
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn a_clean_tab_has_no_unsaved_content() {
        let snap = TabSnapshot::new("a.md", None);
        assert_eq!(snap.unsaved_content, None);
    }

    #[test]
    fn a_dirty_tab_within_the_cap_keeps_its_content() {
        let snap = TabSnapshot::new("a.md", Some("in-flight edit".to_string()));
        assert_eq!(snap.unsaved_content.as_deref(), Some("in-flight edit"));
    }

    #[test]
    fn dirty_content_at_exactly_the_cap_is_kept() {
        let content = "x".repeat(UNSAVED_CONTENT_CAP_BYTES);
        let snap = TabSnapshot::new("a.md", Some(content.clone()));
        assert_eq!(snap.unsaved_content, Some(content));
    }

    #[test]
    fn a_snapshot_is_an_ordinary_project_tab_unless_it_is_told_otherwise() {
        assert_eq!(TabSnapshot::new("a.md", None).recovered_from, None);
        assert_eq!(
            TabSnapshot::new("untitled:1:b.md", Some("displaced work".into()))
                .displaced_from(Some("b.md".into()))
                .recovered_from
                .as_deref(),
            Some("b.md")
        );
    }

    #[test]
    fn an_untitled_doc_id_round_trips_but_is_dropped_from_an_ordinary_tab() {
        let id = "4c7be32a-45f8-476f-a175-8fd48cab51d3".to_string();
        let untitled = TabSnapshot::new("untitled:1:b.md", Some("draft".into()))
            .displaced_from(Some("b.md".into()))
            .with_doc_id(Some(id.clone()))
            .normalize_after_load();
        assert_eq!(untitled.doc_id, Some(id));

        let ordinary = TabSnapshot::new("b.md", None)
            .with_doc_id(Some("stale".into()))
            .normalize_after_load();
        assert_eq!(ordinary.doc_id, None);

        let malformed = TabSnapshot::new("untitled:2:c.md", Some("draft".into()))
            .displaced_from(Some("c.md".into()))
            .with_doc_id(Some("not-a-uuid".into()))
            .normalize_after_load();
        assert_eq!(malformed.doc_id, None);
    }

    #[test]
    fn dirty_content_over_the_cap_is_dropped_not_the_whole_snapshot() {
        let content = "x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1);
        let snap = TabSnapshot::new("a.md", Some(content));
        assert_eq!(snap.path, "a.md");
        assert_eq!(snap.unsaved_content, None);
    }

    #[test]
    fn an_over_cap_recovery_documents_content_is_dropped_but_its_origin_is_not() {
        // The exact signal `restoreFromSession`'s frontend consumer reads to tell "the cap dropped
        // this buffer" apart from "an ordinary recovery document" (#1421): `recovered_from: Some`
        // paired with `unsaved_content: None` can only come from the cap, since a recovery
        // document's content is always `Some` at the moment `displaced_from` marks it — nothing else
        // produces that pairing. Pinned here so a future change to either method can't quietly break
        // the contract the frontend relies on.
        let content = "x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1);
        let snap =
            TabSnapshot::new("untitled:1:b.md", Some(content)).displaced_from(Some("b.md".into()));
        assert_eq!(snap.unsaved_content, None);
        assert_eq!(snap.recovered_from.as_deref(), Some("b.md"));
        assert!(snap.unsaved_content_omitted);
        assert!(!snap.loss_notice_collapsed);
    }

    #[test]
    fn a_recovery_notice_collapse_is_durable_only_for_an_omitted_recovery_buffer() {
        let omitted = TabSnapshot::new(
            "untitled:1:b.md",
            Some("x".repeat(UNSAVED_CONTENT_CAP_BYTES + 1)),
        )
        .displaced_from(Some("b.md".into()))
        .with_recovery_persistence(true, true);
        assert!(omitted.unsaved_content_omitted);
        assert!(omitted.loss_notice_collapsed);

        let preserved = TabSnapshot::new("untitled:1:b.md", Some("kept".into()))
            .displaced_from(Some("b.md".into()))
            .with_recovery_persistence(false, true);
        assert!(!preserved.unsaved_content_omitted);
        assert!(!preserved.loss_notice_collapsed);
    }

    #[test]
    fn explicit_omission_survives_new_content_typed_after_the_loss() {
        let snapshot = TabSnapshot::new("untitled:1:b.md", Some("new work after omission".into()))
            .displaced_from(Some("b.md".into()))
            .with_recovery_persistence(true, true)
            .normalize_after_load();

        assert_eq!(
            snapshot.unsaved_content.as_deref(),
            Some("new work after omission")
        );
        assert!(snapshot.unsaved_content_omitted);
        assert!(snapshot.loss_notice_collapsed);
    }

    #[test]
    fn displaced_label_ordinal_round_trips_without_rederivation() {
        let snapshot = TabSnapshot::new("untitled:2:b.md", Some("kept".into()))
            .displaced_from(Some("b.md".into()))
            .with_displaced_label_ordinal(Some(2));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let restored: TabSnapshot = serde_json::from_str(&encoded).unwrap();

        assert_eq!(restored.displaced_label_ordinal, Some(2));
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn loading_a_missing_session_is_a_fresh_empty_session_not_an_error() {
        let dir = TempDir::new().unwrap();
        let session = load(dir.path()).unwrap();
        assert!(session.tabs.is_empty());
        assert_eq!(session.active_path, None);
    }

    #[test]
    fn save_then_load_round_trips_the_whole_session() {
        let dir = TempDir::new().unwrap();
        let session = Session::new(
            vec![
                TabSnapshot::new("a.md", None),
                TabSnapshot::new("b.md", Some("unsaved b".to_string())),
            ],
            Some("b.md".to_string()),
        );

        save(dir.path(), &session).unwrap();
        let loaded = load(dir.path()).unwrap();

        assert_eq!(loaded, session);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        save(dir.path(), &Session::default()).unwrap();
        assert!(session_path(dir.path()).exists());
    }

    #[test]
    fn a_corrupt_session_file_degrades_to_a_fresh_session_not_an_error() {
        // A tab-session file is disposable, machine-local UI state (see module docs' "fail-soft
        // restore" — CJ ruling, #143): reading a corrupt one has exactly two acceptable outcomes,
        // the session it names or "no session to restore," never a crash and never someone else's
        // content passed off as this project's.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(session_path(dir.path()), "{not json").unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session, Session::default());
    }

    #[test]
    fn a_truncated_json_file_degrades_to_a_fresh_session() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        // A whole, valid session, cut off mid-write (e.g. a crash or a non-git sync tool tearing
        // the file) — not merely malformed at the start, genuinely half-written.
        let whole = serde_json::to_string(&Session::new(
            vec![TabSnapshot::new("a.md", None)],
            Some("a.md".to_string()),
        ))
        .unwrap();
        let truncated = &whole[..whole.len() / 2];
        fs::write(session_path(dir.path()), truncated).unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session, Session::default());
    }

    #[test]
    fn sync_conflict_artifact_content_degrades_to_a_fresh_session() {
        // What a non-git, non-gitignore-respecting sync tool (Dropbox-style folder sync) can leave
        // behind when two machines wrote the same path concurrently: conflict markers, not JSON.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            "<<<<<<< machine-a\n{\"schema_version\":1,\"tabs\":[],\"active_path\":null}\n=======\n{\"schema_version\":1,\"tabs\":[],\"active_path\":null}\n>>>>>>> machine-b\n",
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session, Session::default());
    }

    #[test]
    fn a_recovery_documents_origin_survives_the_round_trip() {
        let dir = TempDir::new().unwrap();
        let session = Session::new(
            vec![
                TabSnapshot::new("untitled:1:b.md", Some("displaced work".into()))
                    .displaced_from(Some("b.md".into())),
            ],
            Some("untitled:1:b.md".to_string()),
        );

        save(dir.path(), &session).unwrap();

        let loaded = load(dir.path()).unwrap();

        // Stated absolutely, not merely as equality with the input: both sides are built by the
        // same code, so `loaded == session` alone would still hold if the origin were dropped on
        // the way in and never written at all.
        assert_eq!(loaded.tabs[0].recovered_from.as_deref(), Some("b.md"));
        assert_eq!(loaded, session);
    }

    #[test]
    fn a_session_written_before_recovered_from_existed_still_restores() {
        // The `SCHEMA_VERSION` judgment (#932, recorded in `docs/formats/tab-session.md`), pinned
        // by execution: a version-1 file predating the field is read with `recovered_from: None`
        // rather than rejected. Bumping the version instead would have discarded this whole
        // session — including the very unsaved buffers the field was added to preserve — on the
        // first launch after the upgrade.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            r#"{"schema_version":1,"tabs":[{"path":"a.md","unsaved_content":"in-flight edit"}],"active_path":"a.md"}"#,
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(
            session.tabs,
            vec![TabSnapshot::new("a.md", Some("in-flight edit".into()))]
        );
        assert_eq!(session.tabs[0].recovered_from, None);
        assert_eq!(session.active_path, Some("a.md".to_string()));
    }

    #[test]
    fn a_legacy_over_cap_recovery_record_is_normalized_to_the_explicit_outcome() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            r#"{"schema_version":1,"tabs":[{"path":"untitled:1:b.md","unsaved_content":null,"recovered_from":"b.md"}],"active_path":"untitled:1:b.md"}"#,
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert!(session.tabs[0].unsaved_content_omitted);
        assert!(!session.tabs[0].loss_notice_collapsed);
    }

    #[test]
    fn content_typed_after_an_explicit_omission_keeps_the_outcome_and_collapse() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            r#"{"schema_version":1,"tabs":[{"path":"untitled:1:b.md","unsaved_content":"kept","recovered_from":"b.md","unsaved_content_omitted":true,"loss_notice_collapsed":true}],"active_path":"untitled:1:b.md"}"#,
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session.tabs[0].unsaved_content.as_deref(), Some("kept"));
        assert!(session.tabs[0].unsaved_content_omitted);
        assert!(session.tabs[0].loss_notice_collapsed);
    }

    #[test]
    fn a_field_this_build_does_not_know_is_ignored_rather_than_failing_the_restore() {
        // The other half of the #932 `schema_version` judgment, and the half a build of *this*
        // vintage cannot otherwise demonstrate: the downgrade direction. The claim recorded in
        // `docs/formats/tab-session.md` — that an older build reads a newer file rather than
        // discarding the session — holds only while this shape tolerates unknown fields, i.e.
        // while nothing here carries `deny_unknown_fields`. Pinned by execution so that adding it
        // later is a test failure rather than a silent loss of everyone's session on a downgrade.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            r#"{"schema_version":1,"tabs":[{"path":"a.md","unsaved_content":null,"a_field_from_the_future":true}],"active_path":"a.md","also_from_the_future":42}"#,
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session.tabs, vec![TabSnapshot::new("a.md", None)]);
        assert_eq!(session.active_path, Some("a.md".to_string()));
    }

    #[test]
    fn an_unrecognized_schema_version_degrades_to_a_fresh_session() {
        // A build older or newer than the one that wrote the file — never guess at fields under a
        // schema-version assumption that may not hold.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(
            session_path(dir.path()),
            r#"{"schema_version":999,"tabs":[{"path":"a.md","unsaved_content":null}],"active_path":null}"#,
        )
        .unwrap();

        let session = load(dir.path()).unwrap();

        assert_eq!(session, Session::default());
    }

    #[test]
    fn saving_a_session_ensures_the_runtime_file_is_gitignored() {
        let dir = TempDir::new().unwrap();

        save(dir.path(), &Session::default()).unwrap();

        let gitignore = fs::read_to_string(emend_dir(dir.path()).join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l == GITIGNORE_PATTERN));
    }

    #[test]
    fn saving_a_session_preserves_an_existing_gitignores_other_entries() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(emend_dir(dir.path())).unwrap();
        fs::write(emend_dir(dir.path()).join(".gitignore"), "custom-entry\n").unwrap();

        save(dir.path(), &Session::default()).unwrap();

        let gitignore = fs::read_to_string(emend_dir(dir.path()).join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l == "custom-entry"));
        assert!(gitignore.lines().any(|l| l == GITIGNORE_PATTERN));
    }

    #[test]
    fn the_gitignore_pattern_is_ensured_even_when_the_session_write_itself_fails() {
        // `ensure_pattern` runs *before* the session file is
        // written, so no version/timing window can let a checkpoint commit capture a live
        // unsaved-content snapshot (CJ ruling, #143, condition 3). Forcing the write to fail here
        // — the target path is already a directory, so `atomic::write_json`'s rename can't land —
        // and still finding the pattern proves the ordering, not just the happy-path outcome.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(session_path(dir.path())).unwrap();

        let result = save(dir.path(), &Session::default());

        assert!(result.is_err());
        let gitignore = fs::read_to_string(emend_dir(dir.path()).join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l == GITIGNORE_PATTERN));
    }

    #[test]
    fn a_later_save_overwrites_the_previous_session_completely() {
        let dir = TempDir::new().unwrap();
        save(
            dir.path(),
            &Session::new(vec![TabSnapshot::new("old.md", None)], None),
        )
        .unwrap();

        save(
            dir.path(),
            &Session::new(
                vec![TabSnapshot::new("new.md", None)],
                Some("new.md".into()),
            ),
        )
        .unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.tabs, vec![TabSnapshot::new("new.md", None)]);
        assert_eq!(loaded.active_path, Some("new.md".to_string()));
    }
}

#[cfg(test)]
mod schema_version_tests {
    use super::*;

    #[test]
    fn a_fresh_session_carries_the_current_schema_version() {
        assert_eq!(Session::default().schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn session_new_stamps_the_current_schema_version() {
        assert_eq!(
            Session::new(Vec::new(), None).schema_version,
            SCHEMA_VERSION
        );
    }
}
