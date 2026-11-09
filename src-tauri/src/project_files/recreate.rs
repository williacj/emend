// ABOUTME: TD-18's path-specific Recreate capability and transaction adapter contract.
// ABOUTME: Acquires confinement before buffer access and defaults every unproven platform to unavailable.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::commands::path_confine::canonical_relative;

use super::{ProjectFiles, ProjectFilesError, ProjectFilesSnapshot};

/// Whether this exact path currently has a platform/filesystem adapter that can prove
/// transaction-long confinement. This is advisory UI state only: [`ProjectFiles::recreate`]
/// always acquires again at invocation (TD-18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
// @anchor:recreate-confinement-unavailable
pub enum RecreateCapabilityStatus {
    Available,
    ConfinementUnavailable,
}

/// The path-specific capability shape reported to the frontend. Keeping the normalized path in
/// the response prevents a capability for one document from being accidentally reused for
/// another; invalid paths retain their requested spelling but are always unavailable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RecreateCapability {
    pub path: String,
    pub status: RecreateCapabilityStatus,
}

/// The no-replace publication result from a successfully acquired transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecreatePublishStatus {
    Created,
    Reappeared,
}

/// Acquisition errors happen before Emend asks for buffer content or permits any content/temp/
/// target I/O. Once acquired, confinement is transaction-long; publication can fail ordinarily,
/// but cannot report a late capability loss after bytes have been exposed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecreateAdapterError {
    ConfinementUnavailable,
}

/// A transaction-long confinement token. Implementations publish atomically with replacement
/// disabled. `Reappeared` is status-only: implementations must not open, read, or overwrite the
/// target; FR-ED-7's later explicit Compare owns that read.
pub trait RecreateTransaction: Send {
    fn publish(self: Box<Self>, content: &[u8]) -> Result<RecreatePublishStatus, String>;
}

/// Platform/filesystem boundary for TD-18 Recreate. Qualifying adapters must walk handle-relative
/// from the project root and reject every reparse point so confinement lasts for the transaction.
/// A capability query never hands out a token; invocation must call [`acquire`](Self::acquire) for
/// the same normalized project-relative path.
pub trait RecreateAdapter: Send + Sync {
    fn capability(&self, root: &Path, path: &Path) -> RecreateCapabilityStatus;

    fn acquire(
        &self,
        root: &Path,
        path: &Path,
    ) -> Result<Box<dyn RecreateTransaction>, RecreateAdapterError>;
}

/// Safe default for macOS, every unsupported platform, and any filesystem a platform adapter
/// cannot positively qualify. It performs no filesystem operation at all.
#[derive(Default)]
pub struct UnavailableRecreateAdapter;

impl RecreateAdapter for UnavailableRecreateAdapter {
    fn capability(&self, _root: &Path, _path: &Path) -> RecreateCapabilityStatus {
        RecreateCapabilityStatus::ConfinementUnavailable
    }

    fn acquire(
        &self,
        _root: &Path,
        _path: &Path,
    ) -> Result<Box<dyn RecreateTransaction>, RecreateAdapterError> {
        Err(RecreateAdapterError::ConfinementUnavailable)
    }
}

/// One typed command result. `Created` carries the ordinary refresh result without turning a
/// post-publication refresh failure into a false creation failure: the file already exists, while
/// the stale snapshot and refresh error remain explicit (FR-X-5).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RecreateOutcome {
    Created {
        snapshot: Option<ProjectFilesSnapshot>,
        refresh_error: Option<ProjectFilesError>,
    },
    Reappeared,
    ConfinementUnavailable,
    Failed {
        message: String,
    },
}

impl ProjectFiles {
    /// Reports advisory capability for one exact project-relative path. Invalid path syntax is a
    /// fail-closed unavailable result and never reaches a platform adapter.
    pub fn recreate_capability(&self, requested: &str) -> RecreateCapability {
        let Ok(path) = normalized_relative_path(requested) else {
            return RecreateCapability {
                path: requested.to_string(),
                status: RecreateCapabilityStatus::ConfinementUnavailable,
            };
        };
        RecreateCapability {
            path: canonical_relative(requested),
            status: self.recreate_adapter.capability(&self.root, &path),
        }
    }

    /// Recreates a missing file from the current editor buffer. The buffer is held by the caller,
    /// not read from disk; this method delegates to the injected-content seam that pins acquisition
    /// ordering in tests.
    pub fn recreate(
        &self,
        requested: &str,
        content: String,
        normalize_line_endings: bool,
    ) -> RecreateOutcome {
        self.recreate_with_content(requested, normalize_line_endings, || Ok(content))
    }

    /// Injected buffer-read seam for the TD-18 I/O audit. The closure is not called until a
    /// transaction-long confinement token has been acquired for this invocation.
    pub fn recreate_with_content<F>(
        &self,
        requested: &str,
        normalize_line_endings: bool,
        read_content: F,
    ) -> RecreateOutcome
    where
        F: FnOnce() -> Result<String, String>,
    {
        let path = match normalized_relative_path(requested) {
            Ok(path) => path,
            Err(message) => return RecreateOutcome::Failed { message },
        };
        let transaction = match self.recreate_adapter.acquire(&self.root, &path) {
            Ok(transaction) => transaction,
            Err(RecreateAdapterError::ConfinementUnavailable) => {
                return RecreateOutcome::ConfinementUnavailable;
            }
        };
        let content = match read_content() {
            Ok(content) => content,
            Err(message) => return RecreateOutcome::Failed { message },
        };
        let content = if normalize_line_endings {
            textops::normalize_line_endings(&content)
        } else {
            std::borrow::Cow::Borrowed(content.as_str())
        };

        match transaction.publish(content.as_bytes()) {
            Ok(RecreatePublishStatus::Reappeared) => RecreateOutcome::Reappeared,
            Ok(RecreatePublishStatus::Created) => match self.refresh() {
                Ok(snapshot) => RecreateOutcome::Created {
                    snapshot: Some(snapshot.as_ref().clone()),
                    refresh_error: None,
                },
                Err(error) => RecreateOutcome::Created {
                    snapshot: None,
                    refresh_error: Some(error),
                },
            },
            Err(message) => RecreateOutcome::Failed { message },
        }
    }
}

fn normalized_relative_path(requested: &str) -> Result<PathBuf, String> {
    if requested.is_empty() {
        return Err("recreate path must not be empty".to_string());
    }
    if requested.contains('\0') {
        return Err("recreate path must not contain a null byte".to_string());
    }

    let path = Path::new(requested);
    if path.is_absolute() {
        return Err("recreate path must be project-relative".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("recreate path must not contain `..` traversal".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("recreate path must be project-relative".to_string());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("recreate path must name a file".to_string());
    }
    Ok(normalized)
}
