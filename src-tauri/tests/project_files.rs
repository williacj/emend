// ABOUTME: TD-18 scanner, native identity reconciliation, and retry-safe rekey integration tests.
// ABOUTME: Pins conservative move evidence, descendants, real adapters, and stale retention.

use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use emend_lib::agent::project::{OpenProject, ProjectObservers};
use emend_lib::agent::watchdog::WriteOutcome;
use emend_lib::project_files::{
    is_project_path_enumerable, is_user_visible, reconcile, EntryKind, NativeRenameMode,
    NormalizedEvent, NormalizedEventKind, PlatformFileId, ProjectFileEntry, ProjectFileMove,
    ProjectFiles, ProjectFilesError, ProjectFilesScanner, ProjectFilesStore, ProjectPathRekeyer,
    RecreateAdapter, RecreateAdapterError, RecreateCapabilityStatus, RecreateOutcome,
    RecreatePublishStatus, RecreateTransaction, UnavailableRecreateAdapter,
};
use emend_lib::store::service::{SidecarError, SidecarStore};
use serde_json::json;
use uuid::Uuid;

fn paths(entries: &[ProjectFileEntry]) -> Vec<&str> {
    fn visit<'a>(entry: &'a ProjectFileEntry, found: &mut Vec<&'a str>) {
        found.push(&entry.path);
        for child in &entry.children {
            visit(child, found);
        }
    }

    let mut found = Vec::new();
    for entry in entries {
        visit(entry, &mut found);
    }
    found
}

fn entry<'a>(entries: &'a [ProjectFileEntry], wanted: &str) -> &'a ProjectFileEntry {
    fn find<'a>(entry: &'a ProjectFileEntry, wanted: &str) -> Option<&'a ProjectFileEntry> {
        if entry.path == wanted {
            return Some(entry);
        }
        entry.children.iter().find_map(|child| find(child, wanted))
    }

    entries
        .iter()
        .find_map(|candidate| find(candidate, wanted))
        .unwrap_or_else(|| panic!("snapshot did not contain {wanted}"))
}

fn file_entry(path: &str) -> ProjectFileEntry {
    identified_entry(path, EntryKind::File, None, Vec::new())
}

fn identified_file(path: &str, id: u128) -> ProjectFileEntry {
    identified_entry(
        path,
        EntryKind::File,
        Some(PlatformFileId::opaque(0, id)),
        Vec::new(),
    )
}

fn identified_entry(
    path: &str,
    kind: EntryKind,
    platform_file_id: Option<PlatformFileId>,
    children: Vec<ProjectFileEntry>,
) -> ProjectFileEntry {
    ProjectFileEntry {
        path: path.to_string(),
        name: path.rsplit('/').next().unwrap_or(path).to_string(),
        kind,
        platform_file_id,
        children,
        warning: None,
    }
}

fn rename_event(mode: NativeRenameMode, paths: &[&str]) -> NormalizedEvent {
    NormalizedEvent {
        kind: NormalizedEventKind::Rename(mode),
        paths: paths.iter().map(|path| (*path).to_string()).collect(),
        tracker: None,
    }
}

fn assert_move(moves: &[ProjectFileMove], old_path: &str, new_path: &str) {
    assert!(
        moves
            .iter()
            .any(|candidate| candidate.old_path == old_path && candidate.new_path == new_path),
        "missing move {old_path} -> {new_path}: {moves:?}"
    );
}

#[test]
fn shipped_one_sided_and_stronger_rename_shapes_accept_the_same_unique_identity() {
    let previous = vec![identified_file("draft.md", 7)];
    let next = vec![identified_file("archive/draft.md", 7)];

    for event in [
        rename_event(NativeRenameMode::Any, &["draft.md"]),
        rename_event(NativeRenameMode::From, &["draft.md"]),
        rename_event(NativeRenameMode::To, &["archive/draft.md"]),
        rename_event(NativeRenameMode::Both, &["draft.md", "archive/draft.md"]),
        NormalizedEvent {
            kind: NormalizedEventKind::Rename(NativeRenameMode::From),
            paths: vec!["draft.md".to_string()],
            tracker: Some(41),
        },
    ] {
        let moves = reconcile(&previous, &next, &[event]);
        assert_eq!(moves.len(), 1);
        assert_move(&moves, "draft.md", "archive/draft.md");
    }
}

#[test]
fn identity_without_endpoint_rename_evidence_never_establishes_a_move() {
    let previous = vec![identified_file("draft.md", 7)];
    let next = vec![identified_file("archive/draft.md", 7)];

    for events in [
        Vec::new(),
        vec![NormalizedEvent {
            kind: NormalizedEventKind::Other,
            paths: vec!["draft.md".to_string()],
            tracker: None,
        }],
        vec![rename_event(NativeRenameMode::Any, &["other.md"])],
    ] {
        assert!(reconcile(&previous, &next, &events).is_empty());
    }
}

#[test]
fn missing_duplicate_or_kind_mismatched_identity_never_establishes_a_move() {
    let rename = [rename_event(
        NativeRenameMode::Both,
        &["draft.md", "archive/draft.md"],
    )];

    assert!(reconcile(
        &[file_entry("draft.md")],
        &[file_entry("archive/draft.md")],
        &rename
    )
    .is_empty());
    assert!(reconcile(
        &[
            identified_file("draft.md", 7),
            identified_file("hard-link.md", 7),
        ],
        &[identified_file("archive/draft.md", 7)],
        &rename,
    )
    .is_empty());
    assert!(reconcile(
        &[identified_file("draft.md", 7)],
        &[
            identified_file("archive/draft.md", 7),
            identified_file("archive/hard-link.md", 7),
        ],
        &rename,
    )
    .is_empty());
    assert!(reconcile(
        &[identified_file("draft.md", 7)],
        &[identified_entry(
            "archive/draft.md",
            EntryKind::Directory,
            Some(PlatformFileId::opaque(0, 7)),
            Vec::new(),
        )],
        &rename,
    )
    .is_empty());
}

#[test]
fn case_only_spelling_change_is_retained_as_a_move() {
    let moves = reconcile(
        &[identified_file("Draft.md", 7)],
        &[identified_file("draft.md", 7)],
        &[rename_event(NativeRenameMode::Any, &["Draft.md"])],
    );

    assert_eq!(moves.len(), 1);
    assert_move(&moves, "Draft.md", "draft.md");
}

#[test]
fn a_directory_move_carries_only_unique_descendants_at_the_same_suffix() {
    let previous = vec![identified_entry(
        "drafts",
        EntryKind::Directory,
        Some(PlatformFileId::opaque(0, 1)),
        vec![
            identified_file("drafts/kept.md", 2),
            identified_file("drafts/ambiguous.md", 3),
            identified_file("drafts/wrong-suffix.md", 4),
        ],
    )];
    let next = vec![
        identified_entry(
            "archive",
            EntryKind::Directory,
            Some(PlatformFileId::opaque(0, 1)),
            vec![
                identified_file("archive/kept.md", 2),
                identified_file("archive/ambiguous.md", 3),
                identified_file("archive/elsewhere.md", 4),
            ],
        ),
        identified_file("duplicate-ambiguous.md", 3),
    ];

    let moves = reconcile(
        &previous,
        &next,
        &[rename_event(NativeRenameMode::Any, &["drafts"])],
    );

    assert_eq!(moves.len(), 2);
    assert_move(&moves, "drafts", "archive");
    assert_move(&moves, "drafts/kept.md", "archive/kept.md");
}

#[test]
fn visibility_is_case_insensitive_without_hiding_user_authored_dot_paths() {
    for name in [
        ".git",
        ".HG",
        ".SvN",
        ".cowrite",
        "NODE_MODULES",
        "target",
        "Dist",
        "BUILD",
        "coverage",
        ".CACHE",
        "__PYCACHE__",
    ] {
        assert!(!is_user_visible(name, EntryKind::Directory), "{name}");
    }
    for name in [".gitignore", ".GITATTRIBUTES", ".GitModules"] {
        assert!(!is_user_visible(name, EntryKind::File), "{name}");
    }
    assert!(!is_user_visible(".git", EntryKind::Symlink));
    assert!(!is_user_visible(".gitignore", EntryKind::Symlink));

    for (name, kind) in [
        (".claude", EntryKind::Directory),
        (".agents", EntryKind::Directory),
        (".notes", EntryKind::Directory),
        ("workflows", EntryKind::Directory),
        ("SKILL.md", EntryKind::File),
        ("ignored-by-git.md", EntryKind::File),
    ] {
        assert!(is_user_visible(name, kind), "{name}");
    }
}

#[test]
fn project_path_enumerability_uses_the_backend_visibility_rule_for_each_component() {
    for hidden in ["node_modules/pkg/README.md", "notes/.gitignore"] {
        assert!(!is_project_path_enumerable(hidden), "{hidden}");
    }

    for visible in ["notes/deleted.md", "build"] {
        assert!(is_project_path_enumerable(visible), "{visible}");
    }
}

#[test]
fn refresh_builds_a_hierarchical_snapshot_without_applying_gitignore_rules() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("drafts/space here")).unwrap();
    fs::create_dir_all(dir.path().join(".claude/skills/editor")).unwrap();
    fs::create_dir_all(dir.path().join(".agents")).unwrap();
    fs::create_dir_all(dir.path().join("workflows")).unwrap();
    fs::write(dir.path().join("drafts/space here/über.md"), "# Draft\n").unwrap();
    fs::write(
        dir.path().join(".claude/skills/editor/SKILL.md"),
        "---\nname: editor\n---\n",
    )
    .unwrap();
    fs::write(dir.path().join(".agents/reviewer.md"), "# Reviewer\n").unwrap();
    fs::write(dir.path().join("workflows/review.md"), "# Review\n").unwrap();
    fs::write(dir.path().join(".gitignore"), "ignored-by-git.md\n").unwrap();
    fs::write(dir.path().join("ignored-by-git.md"), "still visible\n").unwrap();
    for hidden in [".git", ".cowrite", "node_modules", "coverage", ".cache"] {
        fs::create_dir_all(dir.path().join(hidden)).unwrap();
        fs::write(dir.path().join(hidden).join("secret.md"), "hidden\n").unwrap();
    }

    let snapshot = ProjectFiles::new(dir.path()).refresh().unwrap();
    let found = paths(&snapshot.entries);

    assert_eq!(snapshot.generation, 1);
    assert!(found.contains(&"drafts"));
    assert!(found.contains(&"drafts/space here"));
    assert!(found.contains(&"drafts/space here/über.md"));
    assert!(found.contains(&".claude/skills/editor/SKILL.md"));
    assert!(found.contains(&".agents/reviewer.md"));
    assert!(found.contains(&"workflows/review.md"));
    assert!(found.contains(&"ignored-by-git.md"));
    assert!(!found.contains(&".gitignore"));
    assert!(!found.iter().any(|path| path.ends_with("secret.md")));
    assert_eq!(
        entry(&snapshot.entries, "drafts").kind,
        EntryKind::Directory
    );
    assert_eq!(
        entry(&snapshot.entries, "drafts/space here/über.md").kind,
        EntryKind::File
    );
}

#[test]
fn an_empty_project_is_a_completed_empty_snapshot() {
    let dir = tempfile::TempDir::new().unwrap();

    let snapshot = ProjectFiles::new(dir.path()).refresh().unwrap();

    assert_eq!(snapshot.generation, 1);
    assert!(snapshot.entries.is_empty());
}

#[cfg(unix)]
#[test]
fn a_directory_link_is_listed_as_non_actionable_context_but_never_descended() {
    use std::os::unix::fs::symlink;

    let project = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    fs::write(outside.path().join("outside.md"), "must not escape\n").unwrap();
    symlink(outside.path(), project.path().join("linked")).unwrap();

    let snapshot = ProjectFiles::new(project.path()).refresh().unwrap();
    let linked = entry(&snapshot.entries, "linked");

    assert_eq!(linked.kind, EntryKind::Symlink);
    assert!(linked.children.is_empty());
    assert!(!paths(&snapshot.entries).contains(&"linked/outside.md"));
}

#[cfg(windows)]
fn create_windows_junction(link: &Path, target: &Path) {
    let output = std::process::Command::new("cmd")
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

#[cfg(windows)]
fn assert_windows_directory_alias_is_not_descended(project: &Path, alias: &str) {
    let snapshot = ProjectFiles::new(project).refresh().unwrap();
    let linked = entry(&snapshot.entries, alias);
    let escaped_child = format!("{alias}/outside.md");

    assert_eq!(linked.kind, EntryKind::Symlink);
    assert!(linked.children.is_empty());
    assert!(
        !paths(&snapshot.entries).contains(&escaped_child.as_str()),
        "a name-surrogate reparse point must not expose its target inside the project snapshot"
    );
}

#[cfg(windows)]
#[test]
fn a_windows_junction_is_listed_as_non_actionable_context_but_never_descended() {
    let fixture = tempfile::TempDir::new().unwrap();
    let project = fixture.path().join("project");
    let outside = fixture.path().join("outside");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("outside.md"), "must not escape\n").unwrap();
    create_windows_junction(&project.join("junction"), &outside);

    assert_windows_directory_alias_is_not_descended(&project, "junction");
}

#[cfg(windows)]
#[test]
fn a_windows_directory_symlink_is_listed_as_non_actionable_context_but_never_descended() {
    use std::os::windows::fs::symlink_dir;

    let fixture = tempfile::TempDir::new().unwrap();
    let project = fixture.path().join("project");
    let outside = fixture.path().join("outside");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("outside.md"), "must not escape\n").unwrap();
    if let Err(error) = symlink_dir(&outside, project.join("directory symlink")) {
        if error.raw_os_error() == Some(1314) {
            eprintln!(
                "directory-symlink proof unavailable: Windows privilege 1314; junction proof remains separate"
            );
            return;
        }
        panic!("could not create the disposable directory symlink: {error}");
    }

    assert_windows_directory_alias_is_not_descended(&project, "directory symlink");
}

#[cfg(unix)]
#[test]
fn an_unreadable_child_is_a_typed_warning_in_an_otherwise_completed_snapshot() {
    use std::os::unix::fs::PermissionsExt;

    use emend_lib::project_files::ProjectFileWarningKind;

    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("healthy.md"), "healthy\n").unwrap();
    let locked = dir.path().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("hidden.md"), "hidden\n").unwrap();
    let locked_file = dir.path().join("locked-file.md");
    fs::write(&locked_file, "hidden\n").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(&locked_file, fs::Permissions::from_mode(0o000)).unwrap();

    let result = ProjectFiles::new(dir.path()).refresh();

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&locked_file, fs::Permissions::from_mode(0o644)).unwrap();
    let snapshot = result.expect("one unreadable child must not fail the whole refresh");
    for path in ["locked", "locked-file.md"] {
        let warning = entry(&snapshot.entries, path)
            .warning
            .as_ref()
            .expect("the unreadable row remains with a warning");
        assert_eq!(warning.kind, ProjectFileWarningKind::Unreadable);
    }
    assert!(entry(&snapshot.entries, "locked").children.is_empty());
    assert!(paths(&snapshot.entries).contains(&"healthy.md"));
    // The wire shape, not just the Rust one: a directory the scan could not read crosses the IPC
    // boundary as a *present* row with no children and a typed warning. That exact triple is what
    // `stores/project.ts:undescendedPaths` reads to keep a document under it out of J2's
    // Missing-on-disk state (#933) — a frontend that only ever sees hand-built snapshots cannot
    // discover a drift here, so it is pinned on the side that produces it.
    let locked_row = entry(&snapshot.entries, "locked");
    assert_eq!(
        serde_json::to_value(locked_row).unwrap(),
        json!({
            "path": "locked",
            "name": "locked",
            "kind": "directory",
            "children": [],
            // The OS's own text, which this test does not fix: the structure is the contract.
            "warning": {
                "kind": "unreadable",
                "message": locked_row.warning.as_ref().unwrap().message,
            },
        })
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_root_is_project_unavailable() {
    use std::os::unix::fs::PermissionsExt;

    let parent = tempfile::TempDir::new().unwrap();
    let root = parent.path().join("locked-project");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();

    let result = ProjectFiles::new(&root).refresh();

    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        result,
        Err(ProjectFilesError::ProjectUnavailable(_))
    ));
}

#[test]
fn deep_paths_and_a_near_windows_limit_relative_path_remain_hierarchical() {
    let dir = tempfile::TempDir::new().unwrap();
    let mut relative = String::new();
    while relative.len() < 220 {
        if !relative.is_empty() {
            relative.push('/');
        }
        relative.push_str("deep-segment");
    }
    relative.push_str("/final document.md");
    fs::create_dir_all(dir.path().join(Path::new(&relative).parent().unwrap())).unwrap();
    fs::write(dir.path().join(&relative), "# Deep\n").unwrap();

    let snapshot = ProjectFiles::new(dir.path()).refresh().unwrap();

    assert!(
        (230..=280).contains(&relative.len()),
        "fixture should exercise a near-260-character relative path"
    );
    assert_eq!(entry(&snapshot.entries, &relative).kind, EntryKind::File);
    #[cfg(any(target_os = "macos", windows))]
    assert!(entry(&snapshot.entries, &relative)
        .platform_file_id
        .is_some());
}

#[test]
fn completed_snapshots_are_immutable_and_generations_increase_monotonically() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("first.md"), "first\n").unwrap();
    let files = ProjectFiles::new(dir.path());

    let first = files.refresh().unwrap();
    fs::write(dir.path().join("second.md"), "second\n").unwrap();
    let second = files.refresh().unwrap();

    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);
    assert_eq!(paths(&first.entries), vec!["first.md"]);
    assert_eq!(paths(&second.entries), vec!["first.md", "second.md"]);
    assert!(Arc::ptr_eq(
        &second,
        &files.latest_snapshot().expect("latest completed snapshot")
    ));
}

#[test]
fn a_missing_root_is_project_unavailable_and_retains_the_last_completed_snapshot() {
    let parent = tempfile::TempDir::new().unwrap();
    let root = parent.path().join("project");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("draft.md"), "draft\n").unwrap();
    let files = ProjectFiles::new(&root);
    let completed = files.refresh().unwrap();
    fs::remove_dir_all(&root).unwrap();

    let error = files.refresh().unwrap_err();

    assert!(matches!(error, ProjectFilesError::ProjectUnavailable(_)));
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("stale snapshot is retained")
    ));
}

#[derive(Default)]
struct ScriptedScanner {
    outcomes: Mutex<VecDeque<Result<Vec<ProjectFileEntry>, ProjectFilesError>>>,
}

impl ScriptedScanner {
    fn new(outcomes: Vec<Result<Vec<ProjectFileEntry>, ProjectFilesError>>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into()),
        }
    }
}

impl ProjectFilesScanner for ScriptedScanner {
    fn scan(&self, _root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .expect("one scripted result per refresh")
    }
}

#[test]
fn update_failed_retains_the_last_completed_snapshot_and_generation() {
    let scanner = Arc::new(ScriptedScanner::new(vec![
        Ok(vec![file_entry("known.md")]),
        Err(ProjectFilesError::UpdateFailed(
            "directory changed during enumeration".to_string(),
        )),
    ]));
    let files = ProjectFiles::with_scanner("/project", scanner);
    let completed = files.refresh().unwrap();

    let error = files.refresh().unwrap_err();

    assert!(matches!(error, ProjectFilesError::UpdateFailed(_)));
    assert_eq!(completed.generation, 1);
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("stale snapshot is retained")
    ));
}

#[test]
fn a_scan_failure_retains_native_events_for_the_next_refresh() {
    let dir = tempfile::TempDir::new().unwrap();
    let scanner = Arc::new(ScriptedScanner::new(vec![
        Ok(vec![identified_file("draft.md", 7)]),
        Err(ProjectFilesError::UpdateFailed(
            "directory changed during enumeration".to_string(),
        )),
        Ok(vec![identified_file("renamed.md", 7)]),
    ]));
    let files = ProjectFiles::with_scanner(dir.path(), scanner);
    files.refresh().unwrap();

    let error = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["draft.md"])])
        .unwrap_err();
    let refreshed = files.refresh_with_events(Vec::new()).unwrap();

    assert!(matches!(error, ProjectFilesError::UpdateFailed(_)));
    assert_move(&refreshed.moves, "draft.md", "renamed.md");
}

#[test]
fn open_project_owns_the_project_files_service_for_its_whole_lifetime() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    let project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();

    let snapshot = project.project_files().refresh().unwrap();

    assert_eq!(paths(&snapshot.entries), vec!["draft.md"]);
}

#[derive(Clone)]
enum AcquireResult {
    Publish(RecreatePublishStatus),
    PublishError(&'static str),
    ConfinementUnavailable,
}

struct AuditedRecreateAdapter {
    advertised: RecreateCapabilityStatus,
    acquire_result: AcquireResult,
    events: Arc<Mutex<Vec<String>>>,
}

impl RecreateAdapter for AuditedRecreateAdapter {
    fn capability(&self, _root: &Path, path: &Path) -> RecreateCapabilityStatus {
        self.events
            .lock()
            .unwrap()
            .push(format!("capability:{}", path.display()));
        self.advertised
    }

    fn acquire(
        &self,
        _root: &Path,
        path: &Path,
    ) -> Result<Box<dyn RecreateTransaction>, RecreateAdapterError> {
        self.events
            .lock()
            .unwrap()
            .push(format!("acquire:{}", path.display()));
        match self.acquire_result.clone() {
            AcquireResult::Publish(status) => Ok(Box::new(AuditedTransaction {
                result: Ok(status),
                events: Arc::clone(&self.events),
            })),
            AcquireResult::PublishError(message) => Ok(Box::new(AuditedTransaction {
                result: Err(message.to_string()),
                events: Arc::clone(&self.events),
            })),
            AcquireResult::ConfinementUnavailable => {
                Err(RecreateAdapterError::ConfinementUnavailable)
            }
        }
    }
}

struct AuditedTransaction {
    result: Result<RecreatePublishStatus, String>,
    events: Arc<Mutex<Vec<String>>>,
}

impl RecreateTransaction for AuditedTransaction {
    fn publish(self: Box<Self>, content: &[u8]) -> Result<RecreatePublishStatus, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("publish:{}", String::from_utf8_lossy(content)));
        self.result
    }
}

struct AuditedScanner {
    events: Arc<Mutex<Vec<String>>>,
}

impl ProjectFilesScanner for AuditedScanner {
    fn scan(&self, _root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
        self.events.lock().unwrap().push("refresh".to_string());
        Ok(vec![file_entry("missing.md")])
    }
}

fn files_with_recreate_adapter(
    root: &Path,
    advertised: RecreateCapabilityStatus,
    acquire_result: AcquireResult,
) -> (ProjectFiles, Arc<Mutex<Vec<String>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let scanner = Arc::new(AuditedScanner {
        events: Arc::clone(&events),
    });
    let adapter = Arc::new(AuditedRecreateAdapter {
        advertised,
        acquire_result,
        events: Arc::clone(&events),
    });
    (
        ProjectFiles::with_scanner_and_recreate_adapter(root, scanner, adapter),
        events,
    )
}

#[test]
fn an_invalid_capability_path_fails_closed_without_reaching_the_adapter() {
    let dir = tempfile::TempDir::new().unwrap();
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::ConfinementUnavailable,
    );

    let capability = files.recreate_capability("notes/../missing.md");

    assert_eq!(capability.path, "notes/../missing.md");
    assert_eq!(
        capability.status,
        RecreateCapabilityStatus::ConfinementUnavailable
    );
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn the_capability_answer_serializes_to_the_shape_the_frontend_gates_recreate_on() {
    // The frontend decides whether `[Recreate]` exists at all by comparing this `status` string
    // (`src/editor/ipc.ts`'s hand-written `RecreateCapability` mirror). On macOS every answer is
    // `confinement_unavailable`, so an `available` spelling that drifted here would go unnoticed by
    // every test that can run there — the action would simply never appear on Windows either.
    let dir = tempfile::TempDir::new().unwrap();
    let (available, _) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::ConfinementUnavailable,
    );
    let (unavailable, _) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::ConfinementUnavailable,
        AcquireResult::ConfinementUnavailable,
    );

    assert_eq!(
        serde_json::to_value(available.recreate_capability("notes/missing.md")).unwrap(),
        serde_json::json!({ "path": "notes/missing.md", "status": "available" })
    );
    assert_eq!(
        serde_json::to_value(unavailable.recreate_capability("notes/missing.md")).unwrap(),
        serde_json::json!({ "path": "notes/missing.md", "status": "confinement_unavailable" })
    );
}

#[test]
fn invalid_invocation_paths_fail_before_adapter_acquisition_or_content_read() {
    let dir = tempfile::TempDir::new().unwrap();
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::Publish(RecreatePublishStatus::Created),
    );
    let absolute = dir.path().join("outside.md").to_string_lossy().into_owned();

    for requested in ["", ".", "notes/../missing.md", "missing\0.md", &absolute] {
        let outcome = files.recreate_with_content(requested, true, || {
            events.lock().unwrap().push("content_read".to_string());
            Ok("buffer".to_string())
        });

        assert!(
            matches!(outcome, RecreateOutcome::Failed { .. }),
            "invalid invocation path {requested:?} must fail"
        );
    }

    assert_eq!(
        *events.lock().unwrap(),
        Vec::<String>::new(),
        "invalid invocation paths must be rejected before adapter acquisition or content access"
    );
}

#[test]
fn unavailable_adapter_refuses_before_content_read_or_refresh_on_every_platform() {
    let dir = tempfile::TempDir::new().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let scanner = Arc::new(AuditedScanner {
        events: Arc::clone(&events),
    });
    let files = ProjectFiles::with_scanner_and_recreate_adapter(
        dir.path(),
        scanner,
        Arc::new(UnavailableRecreateAdapter),
    );

    let capability = files.recreate_capability("missing.md");
    let outcome = files.recreate_with_content("missing.md", false, || {
        events.lock().unwrap().push("content_read".to_string());
        Ok("buffer".to_string())
    });

    assert_eq!(
        capability.status,
        RecreateCapabilityStatus::ConfinementUnavailable
    );
    assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
    assert!(events.lock().unwrap().is_empty());
    assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
}

#[test]
fn capability_loss_is_non_destructive_and_happens_before_content_is_read() {
    let dir = tempfile::TempDir::new().unwrap();
    let target = dir.path().join("missing.md");
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::ConfinementUnavailable,
    );

    assert_eq!(
        files.recreate_capability("missing.md").status,
        RecreateCapabilityStatus::Available
    );
    let outcome = files.recreate_with_content("missing.md", true, || {
        events.lock().unwrap().push("content_read".to_string());
        Ok("unsaved buffer".to_string())
    });

    assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
    assert!(!target.exists());
    assert_eq!(
        *events.lock().unwrap(),
        vec!["capability:missing.md", "acquire:missing.md"]
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_default_adapter_refuses_before_content_or_filesystem_write() {
    let dir = tempfile::TempDir::new().unwrap();
    let content_read = Arc::new(Mutex::new(false));
    let observed = Arc::clone(&content_read);
    let files = ProjectFiles::new(dir.path());

    let capability = files.recreate_capability("missing.md");
    let outcome = files.recreate_with_content("missing.md", true, || {
        *observed.lock().unwrap() = true;
        Ok("buffer".to_string())
    });

    assert_eq!(capability.path, "missing.md");
    assert_eq!(
        capability.status,
        RecreateCapabilityStatus::ConfinementUnavailable
    );
    assert_eq!(outcome, RecreateOutcome::ConfinementUnavailable);
    assert!(!*content_read.lock().unwrap());
    assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
}

#[test]
fn reappeared_is_status_only_without_refresh_or_target_overwrite() {
    let dir = tempfile::TempDir::new().unwrap();
    let target = dir.path().join("missing.md");
    fs::write(&target, "external version").unwrap();
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::Publish(RecreatePublishStatus::Reappeared),
    );

    let outcome = files.recreate("missing.md", "buffer version".to_string(), true);

    assert_eq!(outcome, RecreateOutcome::Reappeared);
    assert_eq!(fs::read_to_string(&target).unwrap(), "external version");
    assert_eq!(
        *events.lock().unwrap(),
        vec!["acquire:missing.md", "publish:buffer version"]
    );
}

#[test]
fn created_runs_the_ordinary_refresh_and_returns_its_completed_snapshot() {
    let dir = tempfile::TempDir::new().unwrap();
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::Publish(RecreatePublishStatus::Created),
    );

    let outcome = files.recreate("missing.md", "line one\r\nline two\r\n".to_string(), true);

    let RecreateOutcome::Created {
        snapshot: Some(snapshot),
        refresh_error: None,
    } = outcome
    else {
        panic!("expected Created with a completed refresh, got {outcome:?}");
    };
    assert_eq!(snapshot.generation, 1);
    assert_eq!(paths(&snapshot.entries), vec!["missing.md"]);
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "acquire:missing.md",
            "publish:line one\nline two\n",
            "refresh"
        ]
    );
}

#[test]
fn an_ordinary_publication_failure_preserves_the_buffer_and_missing_target() {
    let dir = tempfile::TempDir::new().unwrap();
    let target = dir.path().join("missing.md");
    let (files, events) = files_with_recreate_adapter(
        dir.path(),
        RecreateCapabilityStatus::Available,
        AcquireResult::PublishError("temp flush failed"),
    );
    let buffer = "unsaved buffer".to_string();

    let outcome = files.recreate_with_content("missing.md", false, || {
        events.lock().unwrap().push("content_read".to_string());
        Ok(buffer.clone())
    });

    assert_eq!(
        outcome,
        RecreateOutcome::Failed {
            message: "temp flush failed".to_string()
        }
    );
    assert_eq!(buffer, "unsaved buffer");
    assert!(!target.exists());
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "acquire:missing.md",
            "content_read",
            "publish:unsaved buffer"
        ]
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn the_real_platform_adapter_retains_file_and_directory_identity_across_a_rename() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::create_dir(dir.path().join("drafts space")).unwrap();
    fs::write(dir.path().join("drafts space/über.md"), "draft\n").unwrap();
    let before = ProjectFiles::new(dir.path()).refresh().unwrap();
    let file_id = entry(&before.entries, "drafts space/über.md")
        .platform_file_id
        .clone()
        .expect("a shipped adapter records a file identity");
    let directory_id = entry(&before.entries, "drafts space")
        .platform_file_id
        .clone()
        .expect("a shipped adapter records a directory identity");

    fs::rename(
        dir.path().join("drafts space"),
        dir.path().join("archived space"),
    )
    .unwrap();
    let after = ProjectFiles::new(dir.path()).refresh().unwrap();

    assert_eq!(
        entry(&after.entries, "archived space/über.md").platform_file_id,
        Some(file_id)
    );
    assert_eq!(
        entry(&after.entries, "archived space").platform_file_id,
        Some(directory_id)
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn the_real_platform_adapter_exposes_hard_links_as_duplicate_identity() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "same object\n").unwrap();
    fs::hard_link(dir.path().join("draft.md"), dir.path().join("copy.md")).unwrap();

    let snapshot = ProjectFiles::new(dir.path()).refresh().unwrap();

    assert_eq!(
        entry(&snapshot.entries, "draft.md").platform_file_id,
        entry(&snapshot.entries, "copy.md").platform_file_id
    );
    assert!(entry(&snapshot.entries, "draft.md")
        .platform_file_id
        .is_some());
}

struct InjectedFailureStore {
    inner: SidecarStore,
    fail_on_renames: Vec<usize>,
    rename_attempts: AtomicUsize,
}

impl InjectedFailureStore {
    fn new(root: &Path) -> Self {
        Self::failing_on(root, &[1])
    }

    fn failing_on(root: &Path, rename_attempts: &[usize]) -> Self {
        Self {
            inner: SidecarStore::new(root),
            fail_on_renames: rename_attempts.to_vec(),
            rename_attempts: AtomicUsize::new(0),
        }
    }
}

impl ProjectFilesStore for InjectedFailureStore {
    fn doc_id_for_path(&self, path: &str) -> Result<Option<Uuid>, SidecarError> {
        self.inner.doc_id_for_path(path)
    }

    fn rename_all(&self, moves: &[(Uuid, String)]) -> Result<(), SidecarError> {
        for _ in moves {
            let attempt = self.rename_attempts.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_on_renames.contains(&attempt) {
                return Err(SidecarError::Io(std::io::Error::other(
                    "injected docs.json rename failure",
                )));
            }
        }
        self.inner.rename_all(moves)
    }
}

#[derive(Default)]
struct RecordingRekeyer {
    moves: Mutex<Vec<(String, String)>>,
}

impl ProjectPathRekeyer for RecordingRekeyer {
    fn rekey_path(&self, old_path: &str, new_path: &str) {
        self.moves
            .lock()
            .unwrap()
            .push((old_path.to_string(), new_path.to_string()));
    }
}

#[test]
fn a_sidecar_failure_retains_the_exact_candidate_and_retry_rekeys_before_publication() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    let doc_id = durable.get_or_mint_for_path("draft.md").unwrap();
    let recorder = Arc::new(RecordingRekeyer::default());
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::new(dir.path())),
        Arc::clone(&recorder) as Arc<dyn ProjectPathRekeyer>,
    );
    let completed = files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();

    let error = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["draft.md"])])
        .unwrap_err();

    assert!(matches!(error, ProjectFilesError::UpdateFailed(_)));
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("old snapshot stays visible")
    ));
    assert_eq!(
        durable.path_for(doc_id).unwrap().as_deref(),
        Some("draft.md")
    );
    assert!(recorder.moves.lock().unwrap().is_empty());

    fs::write(dir.path().join("arrived-after-failure.md"), "later\n").unwrap();
    let retried = files.refresh().unwrap();

    assert_eq!(retried.generation, 2);
    assert_move(&retried.moves, "draft.md", "renamed.md");
    assert!(!paths(&retried.entries).contains(&"arrived-after-failure.md"));
    assert_eq!(
        durable.path_for(doc_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert_eq!(
        *recorder.moves.lock().unwrap(),
        vec![("draft.md".to_string(), "renamed.md".to_string())]
    );
}

#[test]
fn a_claimed_history_destination_retains_the_candidate_and_intervening_events_for_retry() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    fs::write(dir.path().join("notes.md"), "notes\n").unwrap();
    let durable = Arc::new(SidecarStore::new(dir.path()));
    let moved_id = durable.get_or_mint_for_path("draft.md").unwrap();
    let notes_id = durable.get_or_mint_for_path("notes.md").unwrap();
    let existing_id = durable.get_or_mint_for_path("renamed.md").unwrap();
    let recorder = Arc::new(RecordingRekeyer::default());
    let files = ProjectFiles::with_rekeyer(
        dir.path(),
        Arc::clone(&recorder) as Arc<dyn ProjectPathRekeyer>,
    );
    let completed = files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();

    let first_error = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["draft.md"])])
        .unwrap_err();

    assert!(matches!(
        first_error,
        ProjectFilesError::UpdateFailed(message) if message.contains("already claimed")
    ));
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("old snapshot stays visible")
    ));
    assert_eq!(
        durable.path_for(moved_id).unwrap().as_deref(),
        Some("draft.md")
    );
    assert_eq!(
        durable.path_for(existing_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert_eq!(
        durable.doc_id_for_path("renamed.md").unwrap(),
        Some(existing_id)
    );
    assert!(recorder.moves.lock().unwrap().is_empty());

    fs::rename(
        dir.path().join("notes.md"),
        dir.path().join("moved-notes.md"),
    )
    .unwrap();
    let second_error = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["notes.md"])])
        .unwrap_err();

    assert!(matches!(
        second_error,
        ProjectFilesError::UpdateFailed(message) if message.contains("already claimed")
    ));
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("old snapshot stays visible")
    ));
    assert!(recorder.moves.lock().unwrap().is_empty());

    durable.rename(existing_id, "displaced.md").unwrap();
    let retried = files.refresh_with_events(Vec::new()).unwrap();

    assert_eq!(retried.generation, 3);
    assert_move(&retried.moves, "notes.md", "moved-notes.md");
    assert_eq!(
        durable.path_for(moved_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert_eq!(
        durable.path_for(notes_id).unwrap().as_deref(),
        Some("moved-notes.md")
    );
    assert_eq!(
        *recorder.moves.lock().unwrap(),
        vec![
            ("draft.md".to_string(), "renamed.md".to_string()),
            ("notes.md".to_string(), "moved-notes.md".to_string()),
        ]
    );
}

#[test]
fn retry_with_events_commits_the_retained_candidate_then_reconciles_the_intervening_batch() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    fs::write(dir.path().join("notes.md"), "notes\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    let draft_id = durable.get_or_mint_for_path("draft.md").unwrap();
    let notes_id = durable.get_or_mint_for_path("notes.md").unwrap();
    let recorder = Arc::new(RecordingRekeyer::default());
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::new(dir.path())),
        Arc::clone(&recorder) as Arc<dyn ProjectPathRekeyer>,
    );
    files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();
    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["draft.md"])])
        .unwrap_err();
    fs::rename(
        dir.path().join("notes.md"),
        dir.path().join("moved-notes.md"),
    )
    .unwrap();

    let refreshed = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["notes.md"])])
        .unwrap();

    assert_eq!(refreshed.generation, 3);
    assert_move(&refreshed.moves, "notes.md", "moved-notes.md");
    assert_eq!(
        durable.path_for(draft_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert_eq!(
        durable.path_for(notes_id).unwrap().as_deref(),
        Some("moved-notes.md")
    );
    assert_eq!(
        *recorder.moves.lock().unwrap(),
        vec![
            ("draft.md".to_string(), "renamed.md".to_string()),
            ("notes.md".to_string(), "moved-notes.md".to_string()),
        ]
    );
}

#[test]
fn a_second_retry_failure_retains_the_intervening_event_batch() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    fs::write(dir.path().join("notes.md"), "notes\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    let draft_id = durable.get_or_mint_for_path("draft.md").unwrap();
    let notes_id = durable.get_or_mint_for_path("notes.md").unwrap();
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::failing_on(dir.path(), &[1, 2])),
        Arc::new(RecordingRekeyer::default()),
    );
    files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();
    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["draft.md"])])
        .unwrap_err();
    fs::rename(
        dir.path().join("notes.md"),
        dir.path().join("moved-notes.md"),
    )
    .unwrap();

    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["notes.md"])])
        .unwrap_err();
    let refreshed = files.refresh_with_events(Vec::new()).unwrap();

    assert_eq!(refreshed.generation, 3);
    assert_move(&refreshed.moves, "notes.md", "moved-notes.md");
    assert_eq!(
        durable.path_for(draft_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert_eq!(
        durable.path_for(notes_id).unwrap().as_deref(),
        Some("moved-notes.md")
    );
}

#[test]
fn a_second_move_failure_retries_the_whole_directory_candidate_before_live_rekey() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::create_dir(dir.path().join("drafts")).unwrap();
    fs::write(dir.path().join("drafts/kept.md"), "draft\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    let directory_id = durable.get_or_mint_for_path("drafts").unwrap();
    let document_id = durable.get_or_mint_for_path("drafts/kept.md").unwrap();
    let recorder = Arc::new(RecordingRekeyer::default());
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::failing_on(dir.path(), &[2])),
        Arc::clone(&recorder) as Arc<dyn ProjectPathRekeyer>,
    );
    let completed = files.refresh().unwrap();
    fs::rename(dir.path().join("drafts"), dir.path().join("archive")).unwrap();

    let error = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["drafts"])])
        .unwrap_err();

    assert!(matches!(error, ProjectFilesError::UpdateFailed(_)));
    assert!(Arc::ptr_eq(
        &completed,
        &files.latest_snapshot().expect("old snapshot stays visible")
    ));
    assert_eq!(
        durable.path_for(directory_id).unwrap().as_deref(),
        Some("drafts")
    );
    assert_eq!(
        durable.path_for(document_id).unwrap().as_deref(),
        Some("drafts/kept.md")
    );
    assert!(recorder.moves.lock().unwrap().is_empty());

    let retried = files.refresh().unwrap();

    assert_eq!(retried.generation, 2);
    assert_move(&retried.moves, "drafts", "archive");
    assert_move(&retried.moves, "drafts/kept.md", "archive/kept.md");
    assert_eq!(
        durable.path_for(document_id).unwrap().as_deref(),
        Some("archive/kept.md")
    );
    assert_eq!(
        *recorder.moves.lock().unwrap(),
        vec![
            ("drafts".to_string(), "archive".to_string()),
            ("drafts/kept.md".to_string(), "archive/kept.md".to_string()),
        ]
    );
}

#[test]
fn failed_multi_move_retry_revalidation_leaves_every_history_path_unchanged() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::create_dir(dir.path().join("drafts")).unwrap();
    fs::write(dir.path().join("drafts/kept.md"), "draft\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    durable.get_or_mint_for_path("drafts").unwrap();
    durable.get_or_mint_for_path("drafts/kept.md").unwrap();
    let docs_json = dir.path().join(".cowrite/docs.json");
    let before = fs::read(&docs_json).unwrap();
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::failing_on(dir.path(), &[2])),
        Arc::new(RecordingRekeyer::default()),
    );
    files.refresh().unwrap();
    fs::rename(dir.path().join("drafts"), dir.path().join("archive")).unwrap();
    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["drafts"])])
        .unwrap_err();

    fs::rename(dir.path().join("archive"), dir.path().join("drafts")).unwrap();
    let refreshed = files.refresh().unwrap();

    assert!(refreshed.moves.is_empty());
    assert_eq!(fs::read(docs_json).unwrap(), before);
}

#[test]
fn failed_retry_revalidation_discards_the_candidate_and_performs_an_ordinary_refresh() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    fs::write(dir.path().join("notes.md"), "notes\n").unwrap();
    let durable = SidecarStore::new(dir.path());
    let draft_id = durable.get_or_mint_for_path("draft.md").unwrap();
    let notes_id = durable.get_or_mint_for_path("notes.md").unwrap();
    let recorder = Arc::new(RecordingRekeyer::default());
    let files = ProjectFiles::with_store_and_rekeyer(
        dir.path(),
        Arc::new(InjectedFailureStore::failing_on(dir.path(), &[1, 2])),
        Arc::clone(&recorder) as Arc<dyn ProjectPathRekeyer>,
    );
    files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();
    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::To, &["renamed.md"])])
        .unwrap_err();
    fs::rename(
        dir.path().join("notes.md"),
        dir.path().join("moved-notes.md"),
    )
    .unwrap();
    files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["notes.md"])])
        .unwrap_err();
    fs::rename(
        dir.path().join("renamed.md"),
        dir.path().join("same-name-different-object.md"),
    )
    .unwrap();
    fs::write(dir.path().join("renamed.md"), "replacement\n").unwrap();

    let refreshed = files.refresh().unwrap();

    assert_move(&refreshed.moves, "notes.md", "moved-notes.md");
    assert!(paths(&refreshed.entries).contains(&"renamed.md"));
    assert!(paths(&refreshed.entries).contains(&"same-name-different-object.md"));
    assert_eq!(
        durable.path_for(draft_id).unwrap().as_deref(),
        Some("draft.md")
    );
    assert_eq!(
        durable.path_for(notes_id).unwrap().as_deref(),
        Some("moved-notes.md")
    );
    assert_eq!(
        *recorder.moves.lock().unwrap(),
        vec![("notes.md".to_string(), "moved-notes.md".to_string())]
    );
}

#[test]
fn open_project_rekeys_live_protection_and_history_before_publishing_the_move() {
    let dir = tempfile::TempDir::new().unwrap();
    fs::write(dir.path().join("draft.md"), "draft\n").unwrap();
    let store = SidecarStore::new(dir.path());
    let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
    let mut project = OpenProject::open(dir.path(), ProjectObservers::default()).unwrap();
    project.watchdog_mut().open_tab("draft.md");
    project
        .watchdog_mut()
        .begin_run("run-1", &["draft.md".to_string()]);
    project.watchdog_mut().observe(
        "run-1",
        &json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Write", "input": { "file_path": "draft.md" } }
            ] }
        }),
    );
    let files = project.project_files();
    files.refresh().unwrap();
    fs::rename(dir.path().join("draft.md"), dir.path().join("renamed.md")).unwrap();

    let snapshot = files
        .refresh_with_events(vec![rename_event(NativeRenameMode::Any, &["renamed.md"])])
        .unwrap();

    assert_move(&snapshot.moves, "draft.md", "renamed.md");
    assert_eq!(
        store.path_for(doc_id).unwrap().as_deref(),
        Some("renamed.md")
    );
    assert!(!project.watchdog_mut().is_protected("draft.md"));
    assert!(project.watchdog_mut().is_protected("renamed.md"));
    fs::write(dir.path().join("renamed.md"), "user edit\n").unwrap();
    assert_eq!(
        project.watchdog_mut().on_write("renamed.md").unwrap(),
        WriteOutcome::ExternalChange
    );
}
