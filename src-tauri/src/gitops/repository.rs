// ABOUTME: Inspects project versioning without changing plain folders and initializes Git only on request.
// ABOUTME: Uses embedded libgit2 so local project features have no system-Git prerequisite.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Eq, PartialEq)]
pub enum RepositoryState {
    Unversioned,
    Versioned { workdir: PathBuf },
}

#[derive(Debug)]
pub enum RepositoryError {
    Io(io::Error),
    Git(git2::Error),
    BareRepository,
    AlreadyVersioned { workdir: PathBuf },
}

impl From<io::Error> for RepositoryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<git2::Error> for RepositoryError {
    fn from(error: git2::Error) -> Self {
        Self::Git(error)
    }
}

/// Reports whether the project is inside a Git working tree, including a parent repository.
/// This read-only check never creates versioning state for D12 plain folders.
pub fn inspect(project_root: &Path) -> Result<RepositoryState, RepositoryError> {
    let root = fs::canonicalize(project_root)?;
    if !root.is_dir() {
        return Err(RepositoryError::Io(io::Error::new(
            io::ErrorKind::NotADirectory,
            "project root is not a directory",
        )));
    }

    match git2::Repository::discover(&root) {
        Ok(repo) => match repo.workdir() {
            Some(workdir) => Ok(RepositoryState::Versioned {
                workdir: fs::canonicalize(workdir)?,
            }),
            None => Err(RepositoryError::BareRepository),
        },
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(RepositoryState::Unversioned),
        Err(error) => Err(error.into()),
    }
}

/// Explicitly enables local versioning for a project that is not already in a working tree.
pub fn initialize(project_root: &Path) -> Result<PathBuf, RepositoryError> {
    let root = fs::canonicalize(project_root)?;
    match inspect(&root)? {
        RepositoryState::Versioned { workdir } => {
            Err(RepositoryError::AlreadyVersioned { workdir })
        }
        RepositoryState::Unversioned => {
            git2::Repository::init(&root)?;
            Ok(root)
        }
    }
}
