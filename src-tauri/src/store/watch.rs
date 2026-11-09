// ABOUTME: FS watcher for externally-landed sidecar changes (P2a-10) — native OS notification
// ABOUTME: APIs via `notify`, never polling; classifies raw events into typed per-doc SidecarChanges.

//! A sync worker (or another running instance, or a reviewer's checkout) can land sidecar writes
//! on disk that this process didn't make itself — a pulled `comments/<doc-id>/<author>.jsonl`
//! append, an updated `changes/<doc-id>.json`, a `docs.json` rewrite. Subscribers need to know
//! when that happens so they can re-fold and refresh state, without Cowrite polling the
//! filesystem on a timer (test-plan §3: "no polling storms").
//!
//! `notify::recommended_watcher` is backed by the OS's native notification API — FSEvents on
//! macOS, inotify on Linux, `ReadDirectoryChangesW` on Windows — so watching is push-based by
//! construction; this module's only job is turning notify's raw, path-only events into typed
//! [`SidecarChange`]s a caller can match on (which doc, which kind of sidecar).

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use uuid::Uuid;

/// Which sidecar a [`SidecarChange`] touched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidecarKind {
    /// `.cowrite/comments/<doc-id>/<author>.jsonl`
    Comments,
    /// `.cowrite/changes/<doc-id>.json`
    Changes,
    /// `.cowrite/docs.json`
    DocsMap,
    /// Anything else under `.cowrite/` this module doesn't specifically classify (e.g. the
    /// directories themselves, or a future sidecar kind) — still reported, never dropped.
    Other,
}

/// One externally-observed change to a sidecar file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidecarChange {
    /// The document this change belongs to — `None` only for `DocsMap` (the identity map itself
    /// isn't scoped to one doc) or an unclassifiable `Other` path.
    pub doc_id: Option<Uuid>,
    pub kind: SidecarKind,
    pub path: PathBuf,
}

/// A live watch on one project's `.cowrite/` directory. Dropping this stops the watch (the
/// underlying `notify` watcher is torn down with it).
pub struct SidecarWatcher {
    _watcher: RecommendedWatcher,
    changes: Receiver<SidecarChange>,
}

impl SidecarWatcher {
    /// Starts watching `cowrite_dir` (a project's `.cowrite/` directory, which must already
    /// exist) recursively for externally-landed changes.
    pub fn watch(cowrite_dir: &Path) -> notify::Result<SidecarWatcher> {
        let (raw_tx, raw_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(raw_tx)?;
        watcher.watch(cowrite_dir, RecursiveMode::Recursive)?;

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for result in raw_rx {
                let Ok(event) = result else { continue };
                // Access (open/read-only) events carry no information a sidecar consumer needs
                // and fire constantly on some platforms — everything else (create/modify/remove/
                // and the catch-all `Any`) is reported.
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in event.paths {
                    if let Some(change) = classify(&path) {
                        if tx.send(change).is_err() {
                            return; // no subscriber left — stop the background thread
                        }
                    }
                }
            }
        });

        Ok(SidecarWatcher {
            _watcher: watcher,
            changes: rx,
        })
    }

    /// Blocks until the next externally-observed change, or `timeout` elapses.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<SidecarChange, RecvTimeoutError> {
        self.changes.recv_timeout(timeout)
    }
}

/// Test-only helper: a real watch can legitimately deliver more than one event for one write —
/// on macOS, FSEvents can report a spurious event for the freshly-watched root directory itself
/// before/alongside the file event a test actually cares about (#615) — so asserting on whatever
/// `recv_timeout` hands back *first* is a test-shape bug, not a watcher bug. Drains events until
/// `predicate` matches one or `overall_timeout` elapses, rather than taking event #1 on faith.
#[cfg(test)]
pub(crate) fn recv_matching(
    watcher: &SidecarWatcher,
    overall_timeout: Duration,
    mut predicate: impl FnMut(&SidecarChange) -> bool,
) -> SidecarChange {
    let deadline = Instant::now() + overall_timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let change = watcher
            .recv_timeout(remaining)
            .expect("expected a matching notification before the deadline");
        if predicate(&change) {
            return change;
        }
    }
}

/// Classifies a raw changed path under `.cowrite/` into a typed [`SidecarChange`], per the
/// on-disk layout `store::service::SidecarStore` writes (`docs.json`, `comments/<uuid>/<author>
/// .jsonl`, `changes/<uuid>.json`).
fn classify(path: &Path) -> Option<SidecarChange> {
    let file_name = path.file_name()?.to_str()?;

    if file_name == "docs.json" {
        return Some(SidecarChange {
            doc_id: None,
            kind: SidecarKind::DocsMap,
            path: path.to_path_buf(),
        });
    }

    if let Some(parent) = path.parent() {
        if let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) {
            if let Ok(id) = Uuid::parse_str(parent_name) {
                return Some(SidecarChange {
                    doc_id: Some(id),
                    kind: SidecarKind::Comments,
                    path: path.to_path_buf(),
                });
            }
            if parent_name == "changes" {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(id) = Uuid::parse_str(stem) {
                        return Some(SidecarChange {
                            doc_id: Some(id),
                            kind: SidecarKind::Changes,
                            path: path.to_path_buf(),
                        });
                    }
                }
            }
        }
    }

    Some(SidecarChange {
        doc_id: None,
        kind: SidecarKind::Other,
        path: path.to_path_buf(),
    })
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    fn uuid() -> Uuid {
        Uuid::from_bytes([9; 16])
    }

    #[test]
    fn docs_json_classifies_as_docs_map_with_no_doc_id() {
        let change = classify(Path::new("/proj/.cowrite/docs.json")).unwrap();
        assert_eq!(change.kind, SidecarKind::DocsMap);
        assert_eq!(change.doc_id, None);
    }

    #[test]
    fn a_comment_author_file_classifies_with_its_doc_id() {
        let path = format!("/proj/.cowrite/comments/{}/alice.jsonl", uuid());
        let change = classify(Path::new(&path)).unwrap();
        assert_eq!(change.kind, SidecarKind::Comments);
        assert_eq!(change.doc_id, Some(uuid()));
    }

    #[test]
    fn a_changes_file_classifies_with_its_doc_id() {
        let path = format!("/proj/.cowrite/changes/{}.json", uuid());
        let change = classify(Path::new(&path)).unwrap();
        assert_eq!(change.kind, SidecarKind::Changes);
        assert_eq!(change.doc_id, Some(uuid()));
    }

    #[test]
    fn an_unrecognized_path_is_still_reported_as_other_never_dropped() {
        let change = classify(Path::new("/proj/.cowrite/some-future-file.txt")).unwrap();
        assert_eq!(change.kind, SidecarKind::Other);
        assert_eq!(change.doc_id, None);
    }

    #[test]
    fn a_second_authors_file_in_the_same_doc_directory_names_the_same_doc_id() {
        let bob = format!("/proj/.cowrite/comments/{}/bob.jsonl", uuid());
        let change = classify(Path::new(&bob)).unwrap();
        assert_eq!(change.kind, SidecarKind::Comments);
        assert_eq!(change.doc_id, Some(uuid()));
    }
}

#[cfg(test)]
mod live_watch_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_write_under_the_watched_directory_is_reported() {
        let dir = TempDir::new().unwrap();
        let watcher = SidecarWatcher::watch(dir.path()).unwrap();

        std::fs::write(
            dir.path().join("docs.json"),
            r#"{"schema_version":1,"documents":{}}"#,
        )
        .unwrap();

        // A leading self-event unrelated to this write (#615) may arrive first; drain to the
        // `DocsMap` one this test actually wants rather than asserting on event #1.
        let change = recv_matching(&watcher, Duration::from_secs(5), |c| {
            c.kind == SidecarKind::DocsMap
        });
        assert_eq!(change.kind, SidecarKind::DocsMap);
    }

    /// Regression test for #615: exercises the drain mechanism directly against a synthetic
    /// channel — deterministic, no dependence on real OS event timing/ordering — so it proves
    /// the mechanism rather than merely hoping a real watcher reproduces the flake on demand.
    /// The naive `recv_timeout(..).kind` this module used to assert on would have returned
    /// `Other` here (the exact #615 failure); `recv_matching` drains past it.
    #[test]
    fn recv_matching_drains_past_a_leading_event_that_does_not_match() {
        let (tx, rx) = mpsc::channel();
        tx.send(SidecarChange {
            doc_id: None,
            kind: SidecarKind::Other,
            path: PathBuf::from("/proj/.cowrite"),
        })
        .unwrap();
        tx.send(SidecarChange {
            doc_id: None,
            kind: SidecarKind::DocsMap,
            path: PathBuf::from("/proj/.cowrite/docs.json"),
        })
        .unwrap();
        let watcher = SidecarWatcher {
            _watcher: notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap(),
            changes: rx,
        };

        let change = recv_matching(&watcher, Duration::from_secs(5), |c| {
            c.kind == SidecarKind::DocsMap
        });
        assert_eq!(change.kind, SidecarKind::DocsMap);
    }

    #[test]
    fn no_event_within_the_timeout_is_a_defined_recv_timeout_error() {
        let dir = TempDir::new().unwrap();
        let watcher = SidecarWatcher::watch(dir.path()).unwrap();

        // No document exists to name, so any spurious self-event (the same #615 leading event
        // on the freshly-watched root) is drained and ignored on the way to the deadline —
        // the assertion is "no *further* event ever names anything", not "the very first
        // `recv_timeout` call times out".
        let deadline = Instant::now() + Duration::from_millis(200);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match watcher.recv_timeout(remaining) {
                Ok(_) => continue,
                Err(err) => {
                    assert_eq!(err, RecvTimeoutError::Timeout);
                    break;
                }
            }
        }
    }
}
