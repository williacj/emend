// ABOUTME: Local transcript store (P2a-17, D15) — an append-only, per-project log of *rendered*
// ABOUTME: timeline cards, kept under the OS app-local-data dir (never `.emend/`, never synced).

// @anchor:transcript-store-module-doc
//! D15: "conversation history is local to the machine per-project... conversations are
//! scaffolding; the durable output is distilled into repo files." This module is the "durable
//! but local" half of that decision — it persists exactly what `timeline/` already renders (the
//! `TimelineCard` union, `src/timeline/types.ts`) so `TimelinePanel` can restore its prior
//! history on reopen, and nothing more: no provider session state (TD-5's session-resume is a
//! separate mechanism this store never touches), never repo-synced (TD §3.1 names `store/` as
//! the owner of "local transcript DB", distinct from the TD-4 sidecars that live in the
//! committed `.emend/`).
// @anchor-end:transcript-store-module-doc
//!
//! # Shape
//!
//! One JSON Lines file per project, `<project key>/transcript.jsonl` under the app's
//! local-data dir, the key being `store::project_identity`'s — the one rule every app-local-data
//! store shares, so this module no longer derives its own ([`transcript_file`]; the caller resolves the real dir from the Tauri app
//! handle — `commands::transcript` — this module stays disk-path-agnostic, matching
//! `store::settings`'s own pure-function-over-a-given-path shape). [`TranscriptEvent`] carries
//! the envelope every card shares (`id`/`kind`/`timestamp`, mirroring `TimelineCardBase` in
//! `src/timeline/types.ts`) plus whatever kind-specific fields the card renders
//! (`author`/`body` for `chat-message`, and whatever a future card kind adds) flattened onto the
//! same JSON object — this module never interprets them, so a new frontend `TimelineCard`
//! variant needs no change here (the same "extend without modifying" contract `timeline/types.ts`
//! already documents for its own union).
//!
//! # Ordering
//!
//! Append-only, one line per event, in arrival order — [`read_all`] returns exactly that file
//! order, which *is* chronological order because the frontend only ever appends a card the
//! instant it renders it (no backdating, no cross-author merge to arbitrate here, unlike
//! `store::comments`'s multi-author causal fold). Rehydrating is therefore a straight read, not
//! a sort.
//!
//! # Single-writer safety
//!
//! P2a-11's per-project lock (`store::lock`) already guarantees at most one *instance* has a
//! project open at a time, so at most one process ever appends here — TD §3.5's "one JSONL
//! appender per project" discipline, the same one `store::lock`'s own docs cite. This module
//! additionally holds an OS-level exclusive lock (`fs4`, the same crate `store::lock` uses) over
//! the transcript file for the duration of each [`append`] call, so concurrent in-process callers
//! (e.g. two async tasks racing a submit) never interleave partial writes either —
//! belt-and-suspenders on top of, not a replacement for, the P2a-11 guarantee.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use fs4::FileExt;
use serde::{Deserialize, Serialize};

use super::{atomic, project_identity};

/// Bumped whenever the on-wire envelope shape changes (TD-4's "every file carries
/// `schema_version`" convention, followed here even though this file is not itself a published
/// TD-4 sidecar contract — see module docs).
pub const SCHEMA_VERSION: u32 = 1;

/// One line of `transcript.jsonl`: the envelope every `TimelineCard` shares, plus its
/// kind-specific fields carried through opaque (never parsed/validated by this module).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptEvent {
    pub schema_version: u32,
    /// Mirrors `TimelineCardBase.id` — stable identity, never reused.
    pub id: String,
    /// Mirrors `TimelineCardBase.kind` — the discriminant frontend renderers switch on.
    pub kind: String,
    /// Mirrors `TimelineCardBase.timestamp` (ISO 8601).
    pub timestamp: String,
    /// Everything else the card carries (`author`/`body` for `chat-message`, …).
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// The app-local-data area this store's per-project directories live in.
const AREA: &str = "transcripts";

/// `<app_local_data_dir>/transcripts/<project_key(root)>/transcript.jsonl` — never under
/// `<root>/.emend/`: D15's "local to the machine, not repo/git-tracked" is structural here,
/// not merely a gitignore entry. Since TD-20 (2026-08-14) `store::lock`'s ownership registry is
/// keyed the same way under the same app-local data dir — neither store is project data, and both
/// resolve their directory through the one rule in `store::project_identity`.
pub fn transcript_file(app_local_data_dir: &Path, root: &Path) -> PathBuf {
    project_identity::project_dir(app_local_data_dir, AREA, root).join("transcript.jsonl")
}

/// Machine-local conversation metadata stored beside this project's D15 transcript. The provider
/// session id is scaffolding for D4 continuity, not repo data and never global settings state.
#[derive(Debug, Serialize, Deserialize)]
struct ConversationMetadata {
    schema_version: u32,
    provider_session_id: Option<String>,
}

/// `<app_local_data_dir>/transcripts/<project_key(root)>/conversation.json`, sharing the exact
/// project identity and machine-local lifetime of the visible transcript beside it.
pub fn provider_session_file(app_local_data_dir: &Path, root: &Path) -> PathBuf {
    project_identity::project_dir(app_local_data_dir, AREA, root).join("conversation.json")
}

/// Reads the last positively established provider session. A missing file is a project with no
/// continuity yet; malformed metadata is an honest I/O error rather than fabricated freshness.
pub fn load_provider_session(path: &Path) -> io::Result<Option<String>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata: ConversationMetadata = serde_json::from_str(&content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if metadata.schema_version != SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported conversation metadata schema {}",
                metadata.schema_version
            ),
        ));
    }
    Ok(metadata.provider_session_id)
}

/// Atomically replaces or clears the durable provider identity. Clearing writes an explicit
/// `null` before a fresh fallback is started, so a crash cannot resurrect the stale resume id.
pub fn save_provider_session(path: &Path, provider_session_id: Option<&str>) -> io::Result<()> {
    atomic::write_json(
        path,
        &ConversationMetadata {
            schema_version: SCHEMA_VERSION,
            provider_session_id: provider_session_id.map(str::to_string),
        },
    )
}

/// Appends one rendered card event to `path`, creating its parent directory on first write.
/// Exclusive-locked for the duration of the write (see module docs) so concurrent callers never
/// interleave partial lines; never rewrites or reorders anything already on disk — genuinely
/// append-only, matching `store::service::SidecarStore::append_comment_event`'s own contract.
pub fn append(path: &Path, event: &TranscriptEvent) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // `read(true)` alongside append: Windows' `LockFileEx` (fs4's lock below) demands a handle
    // with GENERIC_READ or GENERIC_WRITE access, and append-only opens with neither (just
    // FILE_APPEND_DATA) — locking such a handle fails with "Access is denied". Read access
    // satisfies the requirement without weakening the append-only write semantics.
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)?;
    // `lock` (not `try_lock`) — a genuine second writer blocks and waits its turn rather than
    // erroring; unlike `store::lock`'s project-open lock this is not a "someone else already has
    // it" signal, just serializing writes that are all supposed to happen anyway. UFCS (not
    // method-call syntax), matching `store::lock`'s own usage: `std::fs::File` now has identically
    // named inherent methods, which would otherwise shadow `fs4`'s cross-platform (no-libc)
    // implementation silently.
    FileExt::lock(&file)?;
    let mut line =
        serde_json::to_string(event).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    line.push('\n');
    let result = file.write_all(line.as_bytes());
    // Best-effort: the file closing at the end of this function releases the lock regardless
    // (same OS-releases-on-handle-close guarantee `store::lock` relies on); an explicit unlock
    // just frees it a little sooner for a waiting caller.
    let _ = FileExt::unlock(&file);
    result
}

/// Reads every event persisted at `path`, in the order they were appended (rehydrate). A missing
/// file is an empty history (a project that has never had a transcript yet), not an error. A
/// trailing line that fails to parse — a crash mid-`write_all`, the one torn case an append-only
/// log without an fsync barrier can produce — is skipped rather than failing the whole read,
/// mirroring `store::service::SidecarStore::fold_comments`'s same crash-resilience policy.
pub fn read_all(path: &Path) -> io::Result<Vec<TranscriptEvent>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

#[cfg(test)]
fn chat_event(id: &str, timestamp: &str, author: &str, body: &str) -> TranscriptEvent {
    let mut fields = serde_json::Map::new();
    fields.insert("author".to_string(), serde_json::json!(author));
    fields.insert("body".to_string(), serde_json::json!(body));
    TranscriptEvent {
        schema_version: SCHEMA_VERSION,
        id: id.to_string(),
        kind: "chat-message".to_string(),
        timestamp: timestamp.to_string(),
        fields,
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[test]
    fn a_chat_message_event_round_trips_through_json_fields_and_all() {
        let event = chat_event("card-1", "2026-07-16T00:00:00.000Z", "user", "hello there");
        let json = serde_json::to_string(&event).unwrap();
        let back: TranscriptEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, event);
    }

    #[test]
    fn kind_specific_fields_are_flattened_onto_the_same_json_object() {
        // This module never interprets kind-specific fields — but they must land as top-level
        // keys alongside the envelope, matching the frontend `TimelineCard` shape verbatim,
        // rather than nested under a "fields" wrapper key.
        let event = chat_event("card-1", "2026-07-16T00:00:00.000Z", "agent", "hi back");
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value.get("author").and_then(|v| v.as_str()), Some("agent"));
        assert_eq!(value.get("body").and_then(|v| v.as_str()), Some("hi back"));
        assert!(value.get("fields").is_none());
    }

    #[test]
    fn an_event_with_a_future_kinds_unknown_fields_still_round_trips() {
        // A future `TimelineCard` variant this module has never heard of must still persist —
        // "extend without modifying" (timeline/types.ts) applies here too.
        let mut fields = serde_json::Map::new();
        fields.insert("severity".to_string(), serde_json::json!("high"));
        fields.insert("change_count".to_string(), serde_json::json!(3));
        let event = TranscriptEvent {
            schema_version: SCHEMA_VERSION,
            id: "card-9".to_string(),
            kind: "change-set".to_string(),
            timestamp: "2026-07-16T00:00:00.000Z".to_string(),
            fields,
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: TranscriptEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, event);
    }
}

#[cfg(test)]
mod project_key_tests {
    use super::*;
    use crate::store::project_identity::project_key_for_layout_tests as project_key;
    use tempfile::TempDir;

    #[test]
    fn transcript_file_is_laid_out_under_transcripts_slash_the_project_key() {
        let app_data = Path::new("/app-local-data");
        let dir = TempDir::new().unwrap();
        let key = project_key(dir.path());

        assert_eq!(
            transcript_file(app_data, dir.path()),
            app_data
                .join("transcripts")
                .join(key)
                .join("transcript.jsonl")
        );
    }
}

#[cfg(test)]
mod append_read_tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;
    use tempfile::TempDir;

    fn transcript_path(dir: &TempDir) -> PathBuf {
        dir.path().join("transcript.jsonl")
    }

    #[test]
    fn reading_a_missing_file_is_an_empty_history_not_an_error() {
        let dir = TempDir::new().unwrap();
        assert!(read_all(&transcript_path(&dir)).unwrap().is_empty());
    }

    #[test]
    fn append_then_read_back_preserves_order() {
        let dir = TempDir::new().unwrap();
        let path = transcript_path(&dir);
        let events = [
            chat_event("c1", "2026-07-16T00:00:00.000Z", "user", "first"),
            chat_event("c2", "2026-07-16T00:00:01.000Z", "agent", "second"),
            chat_event("c3", "2026-07-16T00:00:02.000Z", "user", "third"),
        ];
        for event in &events {
            append(&path, event).unwrap();
        }

        let rehydrated = read_all(&path).unwrap();

        assert_eq!(rehydrated, events);
    }

    #[test]
    fn append_creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deeper/transcript.jsonl");
        append(&path, &chat_event("c1", "ts", "user", "hi")).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn each_append_is_a_new_line_never_a_rewrite_of_earlier_lines() {
        let dir = TempDir::new().unwrap();
        let path = transcript_path(&dir);
        append(&path, &chat_event("c1", "ts0", "user", "first")).unwrap();
        append(&path, &chat_event("c2", "ts1", "user", "second")).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 2);
        assert!(content.lines().next().unwrap().contains("\"c1\""));
    }

    #[test]
    fn a_process_restart_does_not_lose_already_appended_events() {
        // Neither `append` nor `read_all` holds any state beyond the bytes already on disk at
        // `path` — this *is* what a crash/restart does to a caller: only the file survives, and
        // the next call (post-restart) starts from that alone, no in-memory carry-over to lose.
        let dir = TempDir::new().unwrap();
        let path = transcript_path(&dir);
        append(&path, &chat_event("c1", "ts0", "user", "before restart")).unwrap();

        append(&path, &chat_event("c2", "ts1", "user", "after restart")).unwrap();

        let rehydrated = read_all(&path).unwrap();
        assert_eq!(rehydrated.len(), 2);
        assert_eq!(rehydrated[0].id, "c1");
        assert_eq!(rehydrated[1].id, "c2");
    }

    #[test]
    fn a_corrupt_trailing_line_is_skipped_rather_than_failing_the_whole_read() {
        let dir = TempDir::new().unwrap();
        let path = transcript_path(&dir);
        append(&path, &chat_event("c1", "ts0", "user", "intact")).unwrap();
        // Simulate a crash mid-write: a truncated, unparsable line after the good one.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"schema_version\":1,\"id\":\"c2\",\"trunc")
            .unwrap();

        let rehydrated = read_all(&path).unwrap();

        assert_eq!(rehydrated.len(), 1);
        assert_eq!(rehydrated[0].id, "c1");
    }

    #[test]
    fn concurrent_appends_from_multiple_threads_never_corrupt_or_interleave_lines() {
        // P2a-11's per-project lock already guarantees at most one *instance* ever opens a
        // project (TD §3.5 "one JSONL appender per project"); this proves the store's own
        // exclusive-lock-per-write additionally holds under concurrent *in-process* callers, so
        // the single-writer discipline survives even a caller that doesn't serialize its own
        // append calls.
        let dir = TempDir::new().unwrap();
        let path = transcript_path(&dir);
        let threads = 8;
        let events_per_thread = 25;

        std::thread::scope(|scope| {
            for t in 0..threads {
                let path = path.clone();
                scope.spawn(move || {
                    for i in 0..events_per_thread {
                        let id = format!("t{t}-e{i}");
                        append(&path, &chat_event(&id, "ts", "user", "concurrent")).unwrap();
                    }
                });
            }
        });

        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), threads * events_per_thread);
        // Every line parses on its own — a torn/interleaved write would produce at least one
        // line that isn't valid JSON on its own.
        for line in &lines {
            let parsed: Result<TranscriptEvent, _> = serde_json::from_str(line);
            assert!(parsed.is_ok(), "line failed to parse cleanly: {line:?}");
        }
        let rehydrated = read_all(&path).unwrap();
        assert_eq!(rehydrated.len(), threads * events_per_thread);
    }
}

#[cfg(test)]
mod provider_session_metadata_tests {
    use super::*;
    use tempfile::TempDir;

    const SESSION_ID: &str = "e6639704-0d4d-497d-8898-ef5a938ef849";

    #[test]
    fn provider_session_metadata_lives_beside_the_projects_transcript() {
        let app_data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();

        let metadata = provider_session_file(app_data.path(), project.path());
        let transcript = transcript_file(app_data.path(), project.path());

        assert_eq!(metadata.parent(), transcript.parent());
        assert_eq!(metadata.file_name().unwrap(), "conversation.json");
    }

    #[test]
    fn provider_session_identity_survives_a_fresh_store_instance_and_can_be_cleared() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("conversation.json");

        save_provider_session(&path, Some(SESSION_ID)).unwrap();
        assert_eq!(
            load_provider_session(&path).unwrap().as_deref(),
            Some(SESSION_ID)
        );

        save_provider_session(&path, None).unwrap();
        assert_eq!(load_provider_session(&path).unwrap(), None);
    }

    #[test]
    fn project_keys_isolate_provider_session_identity() {
        let app_data = TempDir::new().unwrap();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let first_path = provider_session_file(app_data.path(), first.path());
        let second_path = provider_session_file(app_data.path(), second.path());

        save_provider_session(&first_path, Some(SESSION_ID)).unwrap();

        assert_eq!(
            load_provider_session(&first_path).unwrap().as_deref(),
            Some(SESSION_ID)
        );
        assert_eq!(load_provider_session(&second_path).unwrap(), None);
    }
}
