// ABOUTME: Document load/save/Recreate IPC — thin commands over textops and project-files authority.
// ABOUTME: Preserves source-as-model text and acquires TD-18 confinement before Recreate buffer access.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use textops::{Anchor, Document, Revision, Utf16Offsets};

use crate::store::atomic;
use crate::{
    agent::project::SharedOpenProject,
    project_files::{ProjectFiles, RecreateCapability, RecreateCapabilityStatus, RecreateOutcome},
};

use super::path_confine::{confine, identity_relative, ConfineError};

/// What `open_document` hands the frontend: the file's exact text plus its content-hash revision
/// (TD-6 `base_revision`) — the same shape the TD-1 §3.2 `get_document_state` MCP tool returns,
/// minus the agent-only fields (pending changes, comments, protection) this IPC layer doesn't own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocumentPayload {
    pub content: String,
    pub revision: String,
}

/// A document command failed. Serializable so it crosses the Tauri IPC boundary as a typed JS
/// error rather than a stringly-typed one; `InvalidPath` covers every `ConfineError` variant
/// (the frontend doesn't need to distinguish *why* a path was refused, only that it was).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    InvalidPath(String),
    InvalidDocument(String),
    Io(String),
    /// Another renderer already owns this project's tab-session write lane.
    WriterBusy(String),
    /// The caller no longer owns the tab-session write lane it named.
    WriterLost(String),
    /// The durable session changed after the caller's last acknowledged receipt.
    RevisionConflict(String),
    /// A lossless close was requested but at least one untitled buffer exceeded the durable cap.
    UntitledContentOmitted(String),
    /// A no-write close proof could not attest that the proposed payload is the durable session.
    SessionProofUnusable(String),
    /// A document's durable TD-4 history could not be carried to the path the user chose
    /// (`save_document_as`). Distinct from `Io` because nothing was written when it happens: the
    /// history moves first precisely so the buffer and its original file are still untouched.
    History(String),
}

impl From<ConfineError> for CommandError {
    fn from(e: ConfineError) -> Self {
        CommandError::InvalidPath(e.to_string())
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        CommandError::Io(e.to_string())
    }
}

/// FR-ED-9's two-gate document set. This applies at the document command boundary rather than
/// depending on which UI route supplied the path (rail, stale link, or restored tab).
pub(crate) fn is_supported_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["md", "markdown", "mdown", "mkd", "mkdn", "txt"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn unsupported_document_message(path: &Path) -> String {
    format!(
        "Emend supports only Markdown and plain-text documents (.md, .markdown, .mdown, .mkd, .mkdn, .txt): {}",
        path.display()
    )
}

fn require_supported_document(path: &Path) -> Result<(), CommandError> {
    if is_supported_document_path(path) {
        Ok(())
    } else {
        Err(CommandError::InvalidDocument(unsupported_document_message(
            path,
        )))
    }
}

/// Loads `path` (project-relative to `root`) and returns its exact text and revision.
///
/// Validate → call → return (§3.1): confine the path, read the bytes, wrap them in a
/// `textops::Document` (verbatim — TD-2, no reflow/reformat), hand back `.text()`/`.revision()`.
/// A file that isn't valid UTF-8 fails the read rather than silently mangling content.
#[tauri::command]
pub fn open_document(root: String, path: String) -> Result<DocumentPayload, CommandError> {
    let confined = confine(Path::new(&root), &path)?;
    require_supported_document(&confined)?;
    let text = fs::read_to_string(&confined)?;
    let doc = Document::new(text);
    Ok(DocumentPayload {
        content: doc.text().to_string(),
        revision: doc.revision().as_str().to_string(),
    })
}

fn write_document_to(
    confined: &Path,
    content: String,
    normalize_line_endings: bool,
) -> Result<String, CommandError> {
    let doc = Document::new(content);
    let to_write = if normalize_line_endings {
        textops::normalize_line_endings(doc.text()).into_owned()
    } else {
        doc.text().to_string()
    };
    atomic::write(confined, to_write.as_bytes())?;
    Ok(to_write)
}

/// Writes `content` to `path` (project-relative to `root`). The single production edge for every
/// save — autosave, manual save, and Save As all route here, so the on-disk guarantees hold
/// uniformly however the save was triggered (FR-ED-2):
///
/// - **Atomic** (TD §3.2b `store::atomic`): staged in a sibling temp file and `rename`d into
///   place, so a crash mid-write never leaves a truncated source-of-truth file. `store::atomic`
///   uses a fixed per-path temp name (single-writer contract); the editor honors it by serializing
///   this document's saves (`editor/autosave.ts` `createSaveRunner`), so two saves for one path
///   never race on that temp.
/// - **LF-normalized** when `normalize_line_endings` is set: the one deliberate exception to
///   byte-for-byte fidelity (TD-2 / P1). The frontend passes `false` for a file the user opted out
///   of via the CRLF banner's "Don't convert this file" (ux-design integrity moments); otherwise
///   `true`, and CRLF/lone-CR collapse to LF. Everything else is written verbatim (no serializer,
///   TD-2) — `Document::new` re-affirms the content is carried as opaque text.
///
/// When the save belongs to the open project, its watchdog is locked across the atomic write and
/// baseline refresh. That deliberate session→watchdog hold prevents a native notification or a
/// run's terminal reconciliation from mistaking Cowrite's own bytes for an outstanding agent write
/// (D21, FR-AGENT-5). Without a matching open project there is no relevant watchdog, so persistence
/// still succeeds and only the baseline refresh is skipped (FR-X-5).
///
/// Returns the revision (TD-6 content hash) of the bytes that actually landed — the same string a
/// fresh `open_document` of this file would report, and, on a normalizing save, the revision of the
/// *normalized* text rather than of the content the caller sent. A save is the one moment after a
/// load when the buffer is provably a named revision again, so handing it back is what lets the
/// editor re-declare it and re-seed the comment-anchor highlights an edit had closed off (#1121).
pub fn save_document_on(
    session: &SharedOpenProject,
    root: String,
    path: String,
    content: String,
    normalize_line_endings: bool,
) -> Result<String, CommandError> {
    let confined = confine(Path::new(&root), &path)?;
    require_supported_document(&confined)?;
    let mut session = super::project::lock(session);
    if let Some(project) = session.as_mut().filter(|project| project.is_root(&root)) {
        let identity = identity_relative(Path::new(&root), &confined)?;
        let mut watchdog = project.watchdog_mut();
        let written = write_document_to(&confined, content, normalize_line_endings)?;
        let revision = Revision::of(&written).as_str().to_string();
        watchdog.refresh_baseline_to(&identity, written);
        return Ok(revision);
    }

    drop(session);
    let written = write_document_to(&confined, content, normalize_line_endings)?;
    Ok(Revision::of(&written).as_str().to_string())
}

#[tauri::command]
pub fn save_document(
    session: State<'_, SharedOpenProject>,
    root: String,
    path: String,
    content: String,
    normalize_line_endings: bool,
) -> Result<String, CommandError> {
    save_document_on(&session, root, path, content, normalize_line_endings)
}

/// Extractor-free Save As used by both Tauri IPC and the D23 driver: writes the live buffer to the
/// in-project path the user chose and carries that document's history to it (J2 Missing on disk
/// `[Save As…]`, FR-ED-2/FR-ED-8, #933).
///
/// **History first, bytes second, and nothing half-done.** The durable rekey is the only fallible
/// step that can leave a record behind, so it runs while the original file and the buffer are still
/// untouched — a refused rekey (a destination another document already claims) therefore changes
/// nothing at all. If the write then fails, the history is carried back to `from_path`, so the
/// failure the user sees is again a failure that changed nothing (ux-design J2: "cancellation or
/// failure changes nothing").
///
/// Without an open project there is no project-files service and so no history to carry; the bytes
/// still land, mirroring [`save_document_on`]'s identical degrade (FR-X-5).
pub fn save_document_as_on(
    session: &SharedOpenProject,
    root: String,
    from_path: String,
    to_path: String,
    content: String,
    normalize_line_endings: bool,
) -> Result<String, CommandError> {
    // Both spellings resolved the way sidecar identity is actually minted — the filesystem's own
    // spelling, not the caller's (`path_confine::identity_relative`, PR #502 review) — so a
    // document whose tab reached here spelled otherwise (`./notes.md`, a symlinked ancestor, a
    // case-only difference on a case-insensitive volume) still finds the history it has. Keying on
    // what the caller wrote makes that lookup miss silently, moving the bytes and leaving the
    // comments and change records behind.
    let root_path = Path::new(&root);
    require_supported_document(&confine(root_path, &to_path)?)?;
    let confined_from = confine(root_path, &from_path)?;
    require_supported_document(&confined_from)?;
    let from = identity_relative(root_path, &confined_from)?;
    let to = identity_relative(root_path, &confine(root_path, &to_path)?)?;
    let files = project_files(session);
    if from != to {
        if let Some(files) = &files {
            files
                .carry_document_history(&from, &to)
                .map_err(CommandError::History)?;
        }
    }
    match save_document_on(session, root, to_path, content, normalize_line_endings) {
        Ok(revision) => Ok(revision),
        Err(error) => {
            if from != to {
                if let Some(files) = &files {
                    // Best effort by construction: this reverses a rename that just succeeded, and
                    // the original failure is what the user must be told about either way.
                    let _ = files.carry_document_history(&to, &from);
                }
            }
            Err(error)
        }
    }
}

/// Saves the open document to a different in-project path, carrying its history (FR-ED-2). Its I/O
/// — a sidecar history move plus the atomic write — stays off Tauri's main thread (FR-X-4); the
/// older `save_document` above is still synchronous, so this is the shape to move towards, not a
/// convention it already follows.
#[tauri::command]
pub async fn save_document_as(
    session: State<'_, SharedOpenProject>,
    root: String,
    from_path: String,
    to_path: String,
    content: String,
    normalize_line_endings: bool,
) -> Result<String, CommandError> {
    let session = Arc::clone(session.inner());
    tauri::async_runtime::spawn_blocking(move || {
        save_document_as_on(
            &session,
            root,
            from_path,
            to_path,
            content,
            normalize_line_endings,
        )
    })
    .await
    .unwrap_or_else(|_| Err(CommandError::Io("save-as task panicked".to_string())))
}

/// Extractor-free TD-18 capability query used by both Tauri IPC and the D23 driver. The result is
/// advisory and path-specific; [`recreate_missing_document_on`] re-acquires independently.
pub fn recreate_missing_document_capability_on(
    session: &SharedOpenProject,
    path: String,
) -> RecreateCapability {
    if !is_supported_document_path(Path::new(&path)) {
        return RecreateCapability {
            path,
            status: RecreateCapabilityStatus::ConfinementUnavailable,
        };
    }
    project_files(session)
        .map(|files| files.recreate_capability(&path))
        .unwrap_or(RecreateCapability {
            path,
            status: RecreateCapabilityStatus::ConfinementUnavailable,
        })
}

/// Extractor-free Recreate operation. The command contributes no filesystem policy: it takes the
/// project-relative path and current editor buffer, locates the open project's TD-18 service, and
/// returns that service's typed result unchanged (§3.1).
pub fn recreate_missing_document_on(
    session: &SharedOpenProject,
    path: String,
    content: String,
    normalize_line_endings: bool,
) -> RecreateOutcome {
    if !is_supported_document_path(Path::new(&path)) {
        return RecreateOutcome::Failed {
            message: unsupported_document_message(Path::new(&path)),
        };
    }
    let Some(files) = project_files(session) else {
        return RecreateOutcome::Failed {
            message: "no project is open".to_string(),
        };
    };
    files.recreate(&path, content, normalize_line_endings)
}

/// Reports whether Recreate can currently be acquired for one missing path. The query is run off
/// Tauri's main thread because a qualifying adapter may inspect metadata handles along the route.
#[tauri::command]
pub async fn recreate_missing_document_capability(
    session: State<'_, SharedOpenProject>,
    path: String,
) -> Result<RecreateCapability, String> {
    let session = Arc::clone(session.inner());
    let fallback_path = path.clone();
    let capability = tauri::async_runtime::spawn_blocking(move || {
        recreate_missing_document_capability_on(&session, path)
    })
    .await
    .unwrap_or(RecreateCapability {
        path: fallback_path,
        status: RecreateCapabilityStatus::ConfinementUnavailable,
    });
    Ok(capability)
}

/// Recreates a missing document from the current editor buffer through TD-18's path-specific,
/// no-replace adapter. All I/O stays off Tauri's main thread (FR-X-4).
#[tauri::command]
pub async fn recreate_missing_document(
    session: State<'_, SharedOpenProject>,
    path: String,
    content: String,
    normalize_line_endings: bool,
) -> Result<RecreateOutcome, String> {
    let session = Arc::clone(session.inner());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        recreate_missing_document_on(&session, path, content, normalize_line_endings)
    })
    .await
    .unwrap_or_else(|_| RecreateOutcome::Failed {
        message: "recreate task panicked".to_string(),
    });
    Ok(outcome)
}

fn project_files(session: &SharedOpenProject) -> Option<Arc<ProjectFiles>> {
    super::project::lock(session)
        .as_ref()
        .map(|project| project.project_files())
}

/// Converts a `[utf16_start, utf16_end)` UTF-16 code-unit range (CodeMirror's coordinate space) to
/// the byte offsets `textops` indexes in (TD-6's canonical byte-indexed space) — the same UTF-16/
/// byte boundary `commands::changes::parse_changes` crosses the other direction (see that module's
/// docs: an astral character like `🎉` advances by a different amount in the two spaces). Walks
/// `content` once for both ends of the range rather than once per end. Either bound at or past the
/// string's end resolves to `content.len()` (a valid one-past-the-end byte offset) rather than
/// panicking on an off-by-one caller.
///
/// `pub(crate)` so `commands::comments::create_comment` can perform the identical conversion
/// (PR #495 review's Critical: the anchored-create path was skipping it entirely, feeding a raw
/// UTF-16 offset to a byte-indexed `Anchor::new`) rather than re-implementing it — the two
/// anchored-capture paths sharing one conversion so they can't drift apart again.
pub(crate) fn byte_range_from_utf16(
    content: &str,
    utf16_start: usize,
    utf16_end: usize,
) -> (usize, usize) {
    let mut utf16 = 0usize;
    let mut start = None;
    for (byte, ch) in content.char_indices() {
        if start.is_none() && utf16 >= utf16_start {
            start = Some(byte);
        }
        if utf16 >= utf16_end {
            return (start.unwrap_or(byte), byte);
        }
        utf16 += ch.len_utf16();
    }
    (start.unwrap_or(content.len()), content.len())
}

/// Captures a `textops::Anchor` (TD-4's shared anchor shape: offset/length/snapshot/context/
/// `base_revision`) at `[utf16_offset, utf16_offset + utf16_length)` of `content` — the quote-bar's
/// selection→anchored-message flow (UX Principle 6, tech-design §3.1's named-home checklist).
/// `content` is the live editor text (not re-read from disk, mirroring `parse_changes`): a
/// selection is measured against whatever the CM6 buffer currently holds, dirty or not, so this
/// command takes that text directly rather than a `root`/`path` that could name a stale disk copy.
/// Offsets arrive in CodeMirror's UTF-16 coordinate space and are converted to bytes before
/// indexing into `textops`' canonical space — the frontend never hand-rolls that arithmetic or the
/// anchor's snapshot/context capture itself (CLAUDE.md: anchor construction stays in `textops`).
#[tauri::command]
pub fn capture_anchor(
    content: String,
    utf16_offset: usize,
    utf16_length: usize,
) -> Result<Anchor, CommandError> {
    let doc = Document::new(content);
    let (start, end) = byte_range_from_utf16(doc.text(), utf16_offset, utf16_offset + utf16_length);
    Ok(Anchor::new(&doc, start, end - start))
}

/// A resolved anchor's position in CM6's UTF-16 coordinate space (P2b-7 follow-up, #492's
/// deep-link-back half: the timeline's quote-bar clicking back into the text it quoted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AnchorPosition {
    pub from: usize,
    pub to: usize,
}

/// Resolves `anchor` (as `capture_anchor` minted it) against `content` — the *live* editor text,
/// in the same CM6 position space `capture_anchor` itself indexes (never disk text, #447) — to a
/// UTF-16 `{from, to}` CodeMirror can select and scroll to.
///
/// `None` whenever the anchor's recorded byte range no longer holds exactly `text_snapshot` in
/// `content` (out of bounds, off a char boundary, or simply different text): the document has
/// moved on since the quote was captured, and this command does not guess where the text went.
/// This is deliberately only the **exact** half of TD-6's "exact mapping via stored revision when
/// available, else D17 snapshot+context re-anchor" — snapshot+context fuzzy re-anchor for a
/// genuinely drifted quote is not implemented here (mirrors `timeline/`'s other still-unwired
/// `onFocusChange` deep-links, e.g. `ChangeSetCard`/`CommentThreadCard` — each is its own
/// follow-up, not a promise every deep-link resolves through a moved document today).
///
/// The UTF-16 conversion goes through `textops::Utf16Offsets` — `capture_anchor`'s own utf16→byte
/// conversion run in reverse — never hand-rolled here (CLAUDE.md: anchor arithmetic stays in
/// `textops`).
#[tauri::command]
pub fn resolve_anchor(content: String, anchor: Anchor) -> Option<AnchorPosition> {
    let end = anchor.offset.checked_add(anchor.length)?;
    let slice = content.get(anchor.offset..end)?;
    if slice != anchor.text_snapshot {
        return None;
    }
    let offsets = Utf16Offsets::new(&content, vec![anchor.offset, end]);
    Some(AnchorPosition {
        from: offsets.at(anchor.offset),
        to: offsets.at(end),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const WITH_FRONTMATTER: &str = "---\ntitle: Test\ntags: [a, b]\n---\n\n# Body\n\nSome text.\n";

    fn root_of(dir: &TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    fn closed_session() -> SharedOpenProject {
        crate::commands::project::new_session()
    }

    #[test]
    fn open_document_returns_the_files_exact_text_and_its_revision() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), WITH_FRONTMATTER).unwrap();

        let payload = open_document(root_of(&dir), "doc.md".into()).unwrap();

        assert_eq!(payload.content, WITH_FRONTMATTER);
        assert_eq!(
            payload.revision,
            Document::new(WITH_FRONTMATTER).revision().as_str()
        );
    }

    #[test]
    fn open_document_leaves_frontmatter_untouched_as_an_opaque_block() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), WITH_FRONTMATTER).unwrap();

        let payload = open_document(root_of(&dir), "doc.md".into()).unwrap();

        assert!(payload
            .content
            .starts_with("---\ntitle: Test\ntags: [a, b]\n---\n"));
    }

    #[test]
    fn open_document_rejects_a_path_escaping_root() {
        let dir = TempDir::new().unwrap();
        let err = open_document(root_of(&dir), "../escape.md".into());
        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    #[test]
    fn open_document_on_invalid_utf8_fails_rather_than_corrupting() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();

        let err = open_document(root_of(&dir), "bad.md".into());

        assert!(matches!(err, Err(CommandError::Io(_))));
    }

    #[test]
    fn document_commands_admit_only_the_six_supported_extensions() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        for extension in ["md", "markdown", "mdown", "mkd", "mkdn", "txt", "MD", "Txt"] {
            let path = format!("draft.{extension}");
            fs::write(dir.path().join(&path), "before").unwrap();
            assert_eq!(
                open_document(root.clone(), path.clone()).unwrap().content,
                "before"
            );
            save_document_on(
                &closed_session(),
                root.clone(),
                path.clone(),
                "after".into(),
                true,
            )
            .unwrap();
            assert_eq!(fs::read_to_string(dir.path().join(path)).unwrap(), "after");
        }
        for extension in ["html", "rs", "rst", "json"] {
            let path = format!("draft.{extension}");
            fs::write(dir.path().join(&path), "untouched").unwrap();
            assert!(matches!(
                open_document(root.clone(), path.clone()),
                Err(CommandError::InvalidDocument(_))
            ));
            assert!(matches!(
                save_document_on(
                    &closed_session(),
                    root.clone(),
                    path.clone(),
                    "wrong".into(),
                    true
                ),
                Err(CommandError::InvalidDocument(_))
            ));
            assert_eq!(
                fs::read_to_string(dir.path().join(path)).unwrap(),
                "untouched"
            );
        }
    }

    #[test]
    fn save_as_refuses_unsupported_source_or_destination_before_moving_history_or_writing() {
        let dir = TempDir::new().unwrap();
        let root = root_of(&dir);
        fs::write(dir.path().join("source.md"), "source").unwrap();
        let result = save_document_as_on(
            &closed_session(),
            root,
            "source.md".into(),
            "target.html".into(),
            "replacement".into(),
            true,
        );
        assert!(matches!(result, Err(CommandError::InvalidDocument(_))));
        assert_eq!(
            fs::read_to_string(dir.path().join("source.md")).unwrap(),
            "source"
        );
        assert!(!dir.path().join("target.html").exists());

        fs::write(dir.path().join("source.html"), "unsupported source").unwrap();
        let result = save_document_as_on(
            &closed_session(),
            root_of(&dir),
            "source.html".into(),
            "target.md".into(),
            "replacement".into(),
            true,
        );
        assert!(matches!(result, Err(CommandError::InvalidDocument(_))));
        assert_eq!(
            fs::read_to_string(dir.path().join("source.html")).unwrap(),
            "unsupported source"
        );
        assert!(!dir.path().join("target.md").exists());
    }

    #[test]
    fn recreate_refuses_an_unsupported_document_type_before_any_publication() {
        let dir = TempDir::new().unwrap();
        let path = "draft.html".to_string();
        let outcome = recreate_missing_document_on(
            &closed_session(),
            path.clone(),
            "should not land".into(),
            true,
        );
        assert!(matches!(
            outcome,
            RecreateOutcome::Failed { message } if message.contains("Markdown and plain-text")
        ));
        assert!(!dir.path().join(path).exists());
    }

    #[test]
    fn save_document_writes_the_given_content_verbatim() {
        let dir = TempDir::new().unwrap();

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            WITH_FRONTMATTER.into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("doc.md")).unwrap(),
            WITH_FRONTMATTER
        );
    }

    #[test]
    fn save_document_overwrites_existing_content_completely() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "old, much longer content than what replaces it").unwrap();

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            "new".into(),
            true,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn save_document_normalizes_crlf_to_lf_when_normalization_is_enabled() {
        let dir = TempDir::new().unwrap();
        let crlf = "---\r\ntitle: Test\r\n---\r\n\r\n# Body\r\nSome text.\r\n";

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            crlf.into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("doc.md")).unwrap(),
            "---\ntitle: Test\n---\n\n# Body\nSome text.\n"
        );
    }

    #[test]
    fn save_document_preserves_crlf_verbatim_when_normalization_is_disabled() {
        // The CRLF banner's "Don't convert this file" opt-out (FR-ED-2): the frontend passes
        // `false` and the file's exact bytes, line endings included, survive.
        let dir = TempDir::new().unwrap();
        let crlf = "line one\r\nline two\r\n";

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            crlf.into(),
            false,
        )
        .unwrap();

        assert_eq!(
            fs::read(dir.path().join("doc.md")).unwrap(),
            crlf.as_bytes()
        );
    }

    #[test]
    fn save_document_returns_the_revision_of_the_bytes_it_wrote() {
        // The frontend declares this revision as the buffer's own (#1121), so it must be exactly
        // the string a fresh `open_document` of the same file reports — anything else and the
        // comment-highlight seed would be checked against a revision nothing else ever produces.
        let dir = TempDir::new().unwrap();

        let revision = save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            WITH_FRONTMATTER.into(),
            true,
        )
        .unwrap();

        assert_eq!(
            revision,
            open_document(root_of(&dir), "doc.md".into())
                .unwrap()
                .revision
        );
    }

    #[test]
    fn save_document_returns_the_normalized_revision_not_the_buffers_crlf_one() {
        // A normalizing save writes different bytes than it was handed (FR-ED-2), so the revision
        // must name what landed on disk — naming the CRLF text the caller sent would hand the
        // frontend a revision no file ever had.
        let dir = TempDir::new().unwrap();
        let crlf = "line one\r\nline two\r\n";

        let revision = save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            crlf.into(),
            true,
        )
        .unwrap();

        assert_eq!(
            revision,
            Document::new("line one\nline two\n").revision().as_str()
        );
        assert_ne!(revision, Document::new(crlf).revision().as_str());
    }

    #[test]
    fn save_document_leaves_no_stray_tmp_file_behind() {
        // Every save is atomic (write-temp + rename via `store::atomic`); a successful save leaves
        // only the target, never the staging `.tmp`.
        let dir = TempDir::new().unwrap();

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            WITH_FRONTMATTER.into(),
            true,
        )
        .unwrap();

        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("doc.md")]);
    }

    #[test]
    fn save_document_rejects_a_path_escaping_root() {
        let dir = TempDir::new().unwrap();

        let err = save_document_on(
            &closed_session(),
            root_of(&dir),
            "../escape.md".into(),
            "x".into(),
            true,
        );

        assert!(matches!(err, Err(CommandError::InvalidPath(_))));
    }

    #[test]
    fn an_app_save_during_an_announced_agent_write_advances_the_watchdog_baseline() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::agent::watchdog::WriteOutcome;
        use crate::commands::project::new_session;

        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), "human original\n").unwrap();
        let root = root_of(&dir);
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());
        {
            let mut session = session.lock().unwrap();
            let project = session.as_mut().unwrap();
            let mut watchdog = project.watchdog_mut();
            watchdog.open_tab("doc.md");
            watchdog.begin_run("run-1", &["doc.md".to_string()]);
            watchdog.observe(
                "run-1",
                &serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "tool_use", "name": "Write", "input": { "file_path": "doc.md" } }
                    ] }
                }),
            );
        }

        save_document_on(
            &session,
            root,
            "doc.md".into(),
            "human original plus what the user just typed\r\n".into(),
            true,
        )
        .unwrap();

        let outcome = session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .watchdog_mut()
            .on_write("doc.md")
            .unwrap();
        assert_eq!(outcome, WriteOutcome::Unchanged);

        let agent_text = "agent replacement\n";
        fs::write(dir.path().join("doc.md"), agent_text).unwrap();
        let outcome = session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .watchdog_mut()
            .on_write("doc.md")
            .unwrap();
        assert!(matches!(outcome, WriteOutcome::Converted { .. }));
        let delivered = fs::read_to_string(dir.path().join("doc.md")).unwrap();
        assert_eq!(
            textops::project(&delivered, textops::DisplayMode::Original),
            "human original plus what the user just typed\n"
        );
        assert_eq!(
            textops::project(&delivered, textops::DisplayMode::None),
            agent_text
        );
    }

    #[test]
    fn a_save_for_a_different_root_cannot_refresh_the_open_projects_watchdog() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::agent::watchdog::WriteOutcome;
        use crate::commands::project::new_session;

        let open = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        fs::write(open.path().join("doc.md"), "open baseline\n").unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(open.path(), ProjectObservers::default()).unwrap());
        {
            let mut session = session.lock().unwrap();
            let mut watchdog = session.as_mut().unwrap().watchdog_mut();
            watchdog.open_tab("doc.md");
            // Keep native notifications from advancing the baseline before the direct assertion.
            watchdog.begin_run("run-1", &[]);
        }

        save_document_on(
            &session,
            root_of(&other),
            "doc.md".into(),
            "wrong project\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(other.path().join("doc.md")).unwrap(),
            "wrong project\n"
        );
        fs::write(open.path().join("doc.md"), "wrong project\n").unwrap();
        assert_eq!(
            session
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .watchdog_mut()
                .on_write("doc.md")
                .unwrap(),
            WriteOutcome::ExternalChange
        );
    }

    #[test]
    fn a_save_without_an_open_project_still_persists_the_users_bytes() {
        let dir = TempDir::new().unwrap();

        save_document_on(
            &closed_session(),
            root_of(&dir),
            "doc.md".into(),
            "workshop draft\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("doc.md")).unwrap(),
            "workshop draft\n"
        );
    }

    #[test]
    fn a_save_belonging_to_the_open_project_returns_the_written_revision_too() {
        // The watchdog branch is a second write path (the baseline refresh happens under the
        // session lock), so the revision the frontend re-seeds comment highlights against must
        // come back from it as well — not only from the no-project branch above (#1121).
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;

        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), "before\n").unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());

        let revision = save_document_on(
            &session,
            root_of(&dir),
            "doc.md".into(),
            "after the user typed\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            revision,
            open_document(root_of(&dir), "doc.md".into())
                .unwrap()
                .revision
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recreate_missing_document_command_delegates_the_live_buffer_and_fails_closed() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::project_files::{RecreateCapabilityStatus, RecreateOutcome};

        let dir = TempDir::new().unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());
        let buffer = "unsaved current buffer".to_string();

        let capability =
            recreate_missing_document_capability_on(&session, "missing.md".to_string());
        let outcome =
            recreate_missing_document_on(&session, "missing.md".to_string(), buffer.clone(), true);

        assert_eq!(capability.path, "missing.md");
        assert_eq!(
            capability.status,
            RecreateCapabilityStatus::ConfinementUnavailable
        );
        assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
        assert_eq!(buffer, "unsaved current buffer");
        assert!(!dir.path().join("missing.md").exists());
    }

    #[test]
    fn save_as_writes_the_buffer_and_carries_the_documents_history_with_it() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::store::service::SidecarStore;

        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("missing.md"), "on disk\n").unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store.get_or_mint_for_path("missing.md").unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());

        let revision = save_document_as_on(
            &session,
            root_of(&dir),
            "missing.md".into(),
            "recovered.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("recovered.md")).unwrap(),
            "the unsaved buffer\n"
        );
        assert_eq!(
            revision,
            open_document(root_of(&dir), "recovered.md".into())
                .unwrap()
                .revision
        );
        assert_eq!(store.path_for(id).unwrap().as_deref(), Some("recovered.md"));
        assert_eq!(store.doc_id_for_path("missing.md").unwrap(), None);
    }

    #[test]
    fn a_failed_save_as_write_leaves_the_history_on_the_original_path() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::store::service::SidecarStore;

        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("missing.md"), "on disk\n").unwrap();
        // A directory at the chosen path: the write fails after the history has already moved, so
        // this is the case that must leave nothing half-done (J2 "failure changes nothing").
        fs::create_dir(dir.path().join("blocked.md")).unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store.get_or_mint_for_path("missing.md").unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());

        let error = save_document_as_on(
            &session,
            root_of(&dir),
            "missing.md".into(),
            "blocked.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap_err();

        assert!(matches!(error, CommandError::Io(_)), "{error:?}");
        assert_eq!(store.path_for(id).unwrap().as_deref(), Some("missing.md"));
        assert!(dir.path().join("blocked.md").is_dir());
    }

    #[test]
    fn save_as_onto_a_path_another_document_already_claims_writes_nothing() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::store::service::SidecarStore;

        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("taken.md"), "someone else's document\n").unwrap();
        let store = SidecarStore::new(dir.path());
        let mine = store.get_or_mint_for_path("missing.md").unwrap();
        store.get_or_mint_for_path("taken.md").unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());

        let error = save_document_as_on(
            &session,
            root_of(&dir),
            "missing.md".into(),
            "taken.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap_err();

        assert!(matches!(error, CommandError::History(_)), "{error:?}");
        assert_eq!(store.path_for(mine).unwrap().as_deref(), Some("missing.md"));
        assert_eq!(
            fs::read_to_string(dir.path().join("taken.md")).unwrap(),
            "someone else's document\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_as_carries_history_from_a_missing_leaf_through_filesystem_aliases() {
        // Sidecar identity is minted under `identity_relative` — what the filesystem *holds* —
        // while an open tab can legitimately carry another spelling of the same file: a symlinked
        // ancestor here, a case-only difference on a case-insensitive volume in the field. Save As
        // runs after the source disappeared and before the destination leaf exists, so resolving
        // the complete leaf on either side cannot recover that spelling; the deepest existing
        // ancestor must. Looking history up under what the *caller wrote* would miss silently
        // (`Ok(None)`), moving the bytes and leaving comments and change records on the old path.
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::store::service::SidecarStore;

        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("real/source")).unwrap();
        fs::create_dir_all(dir.path().join("real/recovered")).unwrap();
        fs::write(dir.path().join("real/source/outline.md"), "on disk\n").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real/source"),
            dir.path().join("source-link"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real/recovered"),
            dir.path().join("recovered-link"),
        )
        .unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store
            .get_or_mint_for_path("real/source/outline.md")
            .unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());
        // This is Save As's actual Missing-on-disk state: only the buffer and durable history
        // remain. Resolving the whole leaf cannot work now, so both sides must recover the
        // filesystem spelling from their deepest existing ancestor.
        fs::remove_file(dir.path().join("real/source/outline.md")).unwrap();

        save_document_as_on(
            &session,
            root_of(&dir),
            "source-link/outline.md".into(),
            "recovered-link/outline.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            store.path_for(id).unwrap().as_deref(),
            Some("real/recovered/outline.md")
        );
        assert_eq!(
            store.doc_id_for_path("real/source/outline.md").unwrap(),
            None
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("real/recovered/outline.md")).unwrap(),
            "the unsaved buffer\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_aliased_missing_leaf_save_as_restores_the_filesystem_identity() {
        use crate::agent::project::{OpenProject, ProjectObservers};
        use crate::commands::project::new_session;
        use crate::store::service::SidecarStore;

        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("real/source")).unwrap();
        fs::create_dir_all(dir.path().join("real/recovered/blocked.md")).unwrap();
        fs::write(dir.path().join("real/source/outline.md"), "on disk\n").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real/source"),
            dir.path().join("source-link"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real/recovered"),
            dir.path().join("recovered-link"),
        )
        .unwrap();
        let store = SidecarStore::new(dir.path());
        let id = store
            .get_or_mint_for_path("real/source/outline.md")
            .unwrap();
        let session = new_session();
        *session.lock().unwrap() =
            Some(OpenProject::open(dir.path(), ProjectObservers::default()).unwrap());
        fs::remove_file(dir.path().join("real/source/outline.md")).unwrap();

        let error = save_document_as_on(
            &session,
            root_of(&dir),
            "source-link/outline.md".into(),
            "recovered-link/blocked.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap_err();

        assert!(matches!(error, CommandError::Io(_)), "{error:?}");
        assert_eq!(
            store.path_for(id).unwrap().as_deref(),
            Some("real/source/outline.md")
        );
        assert!(dir.path().join("real/recovered/blocked.md").is_dir());
    }

    #[test]
    fn save_as_without_an_open_project_still_persists_the_users_bytes() {
        let dir = TempDir::new().unwrap();

        save_document_as_on(
            &closed_session(),
            root_of(&dir),
            "missing.md".into(),
            "recovered.md".into(),
            "the unsaved buffer\n".into(),
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("recovered.md")).unwrap(),
            "the unsaved buffer\n"
        );
    }

    #[test]
    fn recreate_without_an_open_project_is_a_typed_failure() {
        use crate::commands::project::new_session;
        use crate::project_files::{RecreateCapabilityStatus, RecreateOutcome};

        let session = new_session();

        let capability =
            recreate_missing_document_capability_on(&session, "missing.md".to_string());
        let outcome = recreate_missing_document_on(
            &session,
            "missing.md".to_string(),
            "buffer".to_string(),
            false,
        );

        assert_eq!(capability.path, "missing.md");
        assert_eq!(
            capability.status,
            RecreateCapabilityStatus::ConfinementUnavailable
        );
        assert_eq!(
            outcome,
            RecreateOutcome::Failed {
                message: "no project is open".to_string()
            }
        );
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            serde_json::json!({ "status": "failed", "message": "no project is open" })
        );
    }

    #[test]
    fn load_then_save_with_no_edits_is_byte_identical() {
        // P1 (save∘load ≡ identity), first assertion at the command layer. The fixture is LF, so
        // normalization is a no-op and fidelity holds byte-for-byte.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("doc.md"), WITH_FRONTMATTER).unwrap();
        let root = root_of(&dir);

        let payload = open_document(root.clone(), "doc.md".into()).unwrap();
        save_document_on(
            &closed_session(),
            root,
            "doc.md".into(),
            payload.content,
            true,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("doc.md")).unwrap(),
            WITH_FRONTMATTER
        );
    }

    #[test]
    fn capture_anchor_slices_an_ascii_selection_and_captures_context() {
        let content = "before HELLO after";

        let anchor = capture_anchor(content.into(), 7, 5).unwrap();

        assert_eq!(anchor.offset, 7);
        assert_eq!(anchor.length, 5);
        assert_eq!(anchor.text_snapshot, "HELLO");
        assert_eq!(anchor.context_before, "before ");
        assert_eq!(anchor.context_after, " after");
        assert_eq!(anchor.base_revision, Document::new(content).revision());
    }

    #[test]
    fn capture_anchor_converts_utf16_offsets_across_an_astral_character() {
        // "🎉" is 4 bytes but 2 UTF-16 code units — a selection starting after it (CodeMirror's
        // UTF-16 coordinate space) must land on the byte offset just past it, not two bytes in.
        let content = "🎉hello world";

        let anchor = capture_anchor(content.into(), 2, 5).unwrap();

        assert_eq!(anchor.text_snapshot, "hello");
        assert_eq!(anchor.offset, 4);
    }

    #[test]
    fn capture_anchor_on_a_zero_length_selection_captures_a_point_anchor() {
        let content = "hello";

        let anchor = capture_anchor(content.into(), 2, 0).unwrap();

        assert_eq!(anchor.offset, 2);
        assert_eq!(anchor.length, 0);
        assert_eq!(anchor.text_snapshot, "");
    }

    #[test]
    fn capture_anchor_indexes_crlf_content_in_its_own_utf16_space() {
        // Regression for PR #446's Critical (#358): capture_anchor must index `content`'s own
        // UTF-16 units, whatever they are — including a literal CRLF, which is 2 units per line
        // break, not 1. This pins the byte/UTF-16 conversion correct against a CRLF-containing
        // string, given an offset already counted in *that same string's* UTF-16 space — the
        // contract EditorShell.handleQuote now upholds by passing `state.doc.toString()` (always
        // LF-joined) rather than a CRLF-serialized string paired with CM6's own line-break-as-one
        // position offsets.
        let content = "line one\r\nline two\r\nHELLO there";
        // ASCII-only prefix, so the byte offset of "HELLO" equals its UTF-16 offset in `content`.
        let utf16_offset = content.find("HELLO").unwrap();

        let anchor = capture_anchor(content.into(), utf16_offset, 5).unwrap();

        assert_eq!(anchor.text_snapshot, "HELLO");
        assert_eq!(anchor.offset, utf16_offset);
        assert_eq!(anchor.length, 5);
    }

    #[test]
    fn capture_anchor_never_reads_from_disk() {
        // The live editor buffer can be dirty (unsaved edits) — capture_anchor takes that text
        // directly rather than a root/path that could name a stale disk copy (mirrors
        // `parse_changes`'s own content-not-path shape).
        let content = "unsaved buffer text";

        let anchor = capture_anchor(content.into(), 0, 7).unwrap();

        assert_eq!(anchor.text_snapshot, "unsaved");
    }

    fn anchor_for(content: &str, byte_offset: usize, byte_length: usize) -> Anchor {
        Anchor::new(&Document::new(content), byte_offset, byte_length)
    }

    #[test]
    fn resolve_anchor_finds_the_still_matching_text_and_converts_to_utf16() {
        let content = "before HELLO after";
        let anchor = anchor_for(content, 7, 5);

        let position = resolve_anchor(content.into(), anchor).unwrap();

        assert_eq!(position.from, 7);
        assert_eq!(position.to, 12);
    }

    #[test]
    fn resolve_anchor_converts_byte_offsets_to_utf16_across_an_astral_character() {
        // "🎉" is 4 bytes but 2 UTF-16 code units — a byte-indexed anchor after it must resolve to
        // the UTF-16 position CodeMirror actually uses, not the raw byte count.
        let content = "🎉hello world";
        let anchor = anchor_for(content, 4, 5); // "hello", byte-indexed

        let position = resolve_anchor(content.into(), anchor).unwrap();

        assert_eq!(position.from, 2); // "🎉" is 2 UTF-16 units
        assert_eq!(position.to, 7);
    }

    #[test]
    fn resolve_anchor_is_none_when_the_live_text_no_longer_matches_the_snapshot() {
        // The document moved on since the quote was captured — an honest "can't place this"
        // rather than silently selecting whatever now sits at that byte range (D17/P2).
        let anchor = anchor_for("before HELLO after", 7, 5);

        let position = resolve_anchor("before WORLDS after".into(), anchor);

        assert!(position.is_none());
    }

    #[test]
    fn resolve_anchor_is_none_when_the_recorded_range_is_out_of_bounds() {
        let anchor = anchor_for("before HELLO after", 7, 5);

        let position = resolve_anchor("short".into(), anchor);

        assert!(position.is_none());
    }

    #[test]
    fn resolve_anchor_is_none_for_a_length_that_overflows_usize() {
        let mut anchor = anchor_for("hello", 0, 5);
        anchor.length = usize::MAX;

        let position = resolve_anchor("hello".into(), anchor);

        assert!(position.is_none());
    }

    #[test]
    fn resolve_anchor_round_trips_what_capture_anchor_just_minted() {
        // The realistic shape: capture, then immediately resolve against the same live buffer
        // (the same-session common case) — must recover the exact CM6 UTF-16 range it started
        // from, byte-space round trip included. An astral character ahead of the target text makes
        // the byte offset (24) and the UTF-16 offset (22) genuinely diverge, so a byte/UTF-16 mixup
        // in either direction of the round trip would fail this — a CRLF-laden but otherwise-ASCII
        // buffer would not have (review, #492 PR #554: CRLF's own line endings are plain ASCII, one
        // byte = one UTF-16 unit each, at this layer — CRLF is collapsed only in CM6, frontend-side,
        // #447 — so the CRLF framing this test used to carry didn't actually exercise anything).
        let content = "🎉line one\r\nline two\r\nHELLO there";
        let utf16_offset = 22; // "🎉" (2 UTF-16 units) + "line one\r\nline two\r\n" (20 ASCII units)
        let anchor = capture_anchor(content.into(), utf16_offset, 5).unwrap();

        let position = resolve_anchor(content.into(), anchor).unwrap();

        assert_eq!(position.from, utf16_offset);
        assert_eq!(position.to, utf16_offset + 5);
    }
}
