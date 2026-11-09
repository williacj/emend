// ABOUTME: Real-Windows proofs for TD-18's transaction-confined Recreate adapter.
// ABOUTME: Exercises sharing, reparse, no-overwrite, concurrency, and path-torture boundaries.

#![cfg(windows)]

use std::fs::{self, File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use emend_lib::project_files::{
    ProjectFiles, RecreateAdapter, RecreateCapabilityStatus, RecreateOutcome,
    WindowsRecreateAdapter,
};
use tempfile::TempDir;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_TEMPORARY;

const DELETE_ACCESS: u32 = 0x0001_0000;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

fn assert_available(root: &Path, relative: &Path) {
    assert_eq!(
        WindowsRecreateAdapter.capability(root, relative),
        RecreateCapabilityStatus::Available,
        "the self-hosted Windows proof must run on a qualifying filesystem"
    );
}

fn is_created(outcome: &RecreateOutcome) -> bool {
    matches!(outcome, RecreateOutcome::Created { .. })
}

fn recreate_temps(root: &Path) -> Vec<PathBuf> {
    fn visit(directory: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let file_type = entry.file_type().unwrap();
            if file_type.is_dir() && !file_type.is_symlink() {
                visit(&entry.path(), found);
            } else if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".emend-recreate-")
            {
                found.push(entry.path());
            }
        }
    }

    let mut found = Vec::new();
    visit(root, &mut found);
    found
}

fn open_with_delete(path: &Path) -> File {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    options.open(path).unwrap()
}

fn create_junction(link: &Path, target: &Path) {
    let output = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "mklink /J failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn near_260_relative(root: &Path) -> PathBuf {
    let mut relative = PathBuf::from("long-path");
    let file_name = "near-limit.md";
    loop {
        let target_len = root
            .join(&relative)
            .join(file_name)
            .as_os_str()
            .encode_wide()
            .count();
        if target_len >= 248 {
            assert!(
                target_len <= 260,
                "constructed path length was {target_len}"
            );
            relative.push(file_name);
            return relative;
        }
        let component_len = (249 - target_len).clamp(1, 32);
        relative.push("x".repeat(component_len));
    }
}

#[test]
fn windows_recreate_uses_shared_lf_normalization_across_path_torture_cases() {
    let root = TempDir::new().unwrap();
    let near_limit = near_260_relative(root.path());
    let cases = [
        PathBuf::from("folder with spaces/missing note.md"),
        PathBuf::from("unicøde 雪/草稿.md"),
        PathBuf::from("Case Folder/DRAFT.MD"),
        near_limit,
    ];

    for relative in &cases {
        fs::create_dir_all(root.path().join(relative).parent().unwrap()).unwrap();
        assert_available(root.path(), relative);
        let files = ProjectFiles::new(root.path());

        let outcome = files.recreate(
            &relative.to_string_lossy(),
            "line one\r\nline two\r".to_string(),
            true,
        );

        assert!(is_created(&outcome), "{relative:?}: {outcome:?}");
        assert_eq!(
            fs::read_to_string(root.path().join(relative)).unwrap(),
            "line one\nline two\n"
        );
        assert_eq!(
            fs::metadata(root.path().join(relative))
                .unwrap()
                .file_attributes()
                & FILE_ATTRIBUTE_TEMPORARY,
            0,
            "{relative:?}: published documents must not retain the temporary attribute"
        );
    }
    assert!(recreate_temps(root.path()).is_empty());
}

#[test]
fn windows_recreate_resolves_case_only_parent_spelling_without_losing_requested_leaf_spelling() {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join("Mixed Case Parent")).unwrap();
    let requested = Path::new("mixed case parent/Draft.MD");
    assert_available(root.path(), requested);

    let outcome = ProjectFiles::new(root.path()).recreate(
        &requested.to_string_lossy(),
        "buffer".to_string(),
        false,
    );

    assert!(is_created(&outcome), "{outcome:?}");
    assert_eq!(
        fs::read_to_string(root.path().join("Mixed Case Parent/Draft.MD")).unwrap(),
        "buffer"
    );
}

#[test]
fn windows_recreate_rejects_root_and_ancestor_reparse_points_before_buffer_access() {
    let container = TempDir::new().unwrap();
    let project = container.path().join("project");
    let outside = container.path().join("outside");
    let root_junction = container.path().join("root junction");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&outside).unwrap();
    create_junction(&root_junction, &project);
    create_junction(&project.join("linked ancestor"), &outside);

    for (root, requested) in [
        (root_junction.as_path(), "missing.md"),
        (project.as_path(), "linked ancestor/missing.md"),
    ] {
        let content_read = Arc::new(Mutex::new(false));
        let observed = Arc::clone(&content_read);
        let files = ProjectFiles::new(root);

        assert_eq!(
            files.recreate_capability(requested).status,
            RecreateCapabilityStatus::ConfinementUnavailable
        );
        let outcome = files.recreate_with_content(requested, false, || {
            *observed.lock().unwrap() = true;
            Ok("buffer".to_string())
        });

        assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
        assert!(!*content_read.lock().unwrap());
    }
    assert!(!project.join("missing.md").exists());
    assert!(!outside.join("missing.md").exists());
    assert!(recreate_temps(&project).is_empty());
}

#[test]
fn windows_delete_access_on_each_route_handle_refuses_before_content_or_temp_io() {
    let root = TempDir::new().unwrap();
    let ancestor = root.path().join("ancestor");
    let parent = ancestor.join("parent");
    fs::create_dir_all(&parent).unwrap();

    for conflict_path in [root.path(), ancestor.as_path(), parent.as_path()] {
        let conflicting = open_with_delete(conflict_path);
        let content_read = Arc::new(Mutex::new(false));
        let observed = Arc::clone(&content_read);
        let files = ProjectFiles::new(root.path());

        assert_eq!(
            files
                .recreate_capability("ancestor/parent/missing.md")
                .status,
            RecreateCapabilityStatus::ConfinementUnavailable
        );
        let outcome = files.recreate_with_content("ancestor/parent/missing.md", false, || {
            *observed.lock().unwrap() = true;
            Ok("buffer".to_string())
        });

        assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
        assert!(!*content_read.lock().unwrap());
        assert!(!parent.join("missing.md").exists());
        assert!(recreate_temps(root.path()).is_empty());
        drop(conflicting);
    }
}

#[test]
fn windows_recreate_reports_reappeared_without_opening_or_overwriting_the_target() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("missing.md");
    fs::write(&target, "external version").unwrap();
    let held_target = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&target)
        .unwrap();
    let files = ProjectFiles::new(root.path());

    let outcome = files.recreate("missing.md", "buffer version".to_string(), true);

    assert_eq!(outcome, RecreateOutcome::Reappeared);
    drop(held_target);
    assert_eq!(fs::read_to_string(&target).unwrap(), "external version");
    assert!(recreate_temps(root.path()).is_empty());
}

#[test]
fn two_concurrent_windows_recreators_yield_exactly_one_created() {
    let root = TempDir::new().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();

    for content in ["first writer", "second writer"] {
        let files = ProjectFiles::new(root.path());
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            files.recreate_with_content("missing.md", false, || {
                barrier.wait();
                Ok(content.to_string())
            })
        }));
    }

    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| is_created(outcome))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, RecreateOutcome::Reappeared))
            .count(),
        1
    );
    assert!(matches!(
        fs::read_to_string(root.path().join("missing.md"))
            .unwrap()
            .as_str(),
        "first writer" | "second writer"
    ));
    assert!(recreate_temps(root.path()).is_empty());
}
