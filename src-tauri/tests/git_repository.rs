// ABOUTME: Real-repository tests for D12's optional Git capability and explicit initialization.
// ABOUTME: Checks Git state through the backend service without relying on a system Git binary.

use cowrite_lib::gitops::repository::{initialize, inspect, RepositoryError, RepositoryState};
use std::fs;

#[test]
fn a_plain_folder_has_no_git_capability_but_a_repository_and_its_subfolder_do() {
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(inspect(plain.path()).unwrap(), RepositoryState::Unversioned);
    assert!(!plain.path().join(".git").exists());

    let versioned = tempfile::tempdir().unwrap();
    let nested = versioned.path().join("chapters");
    fs::create_dir(&nested).unwrap();
    git2::Repository::init(versioned.path()).unwrap();

    let expected = RepositoryState::Versioned {
        workdir: fs::canonicalize(versioned.path()).unwrap(),
    };
    assert_eq!(inspect(versioned.path()).unwrap(), expected);
    assert_eq!(inspect(&nested).unwrap(), expected);
}

#[test]
fn initialization_preserves_documents_and_refuses_an_existing_parent_worktree() {
    let plain = tempfile::tempdir().unwrap();
    let document = plain.path().join("draft.md");
    fs::write(&document, "An existing draft.\n").unwrap();

    assert_eq!(
        initialize(plain.path()).unwrap(),
        fs::canonicalize(plain.path()).unwrap()
    );
    assert_eq!(
        fs::read_to_string(&document).unwrap(),
        "An existing draft.\n"
    );
    assert!(git2::Repository::open(plain.path())
        .unwrap()
        .workdir()
        .is_some());

    let nested = plain.path().join("chapters");
    fs::create_dir(&nested).unwrap();
    assert!(matches!(
        initialize(&nested),
        Err(RepositoryError::AlreadyVersioned { workdir })
            if workdir == fs::canonicalize(plain.path()).unwrap()
    ));
    assert!(!nested.join(".git").exists());
}

#[test]
fn a_bare_repository_is_not_treated_as_an_unversioned_author_project() {
    let bare = tempfile::tempdir().unwrap();
    git2::Repository::init_bare(bare.path()).unwrap();

    assert!(matches!(
        inspect(bare.path()),
        Err(RepositoryError::BareRepository)
    ));
    assert!(matches!(
        initialize(bare.path()),
        Err(RepositoryError::BareRepository)
    ));
    assert!(!bare.path().join(".git").exists());
}
