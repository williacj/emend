// ABOUTME: Integration tests for skill + workflow discovery (issue #421, P2b-8a-i, split of #359)
// ABOUTME: against real fixture project trees on disk, per test-plan §3's "plain integration tests".

//! FR-SKILL-1/FR-SKILL-5 acceptance: `SKILL.md` discovery at any depth (accept + reject direction
//! on the required `name`+`description` frontmatter), standard ignore dirs excluded, the default
//! `workflows/*.md` glob, nothing copied into an app-owned store (paths + parsed frontmatter only),
//! and a malformed/unreadable `SKILL.md` skipped honestly rather than failing the whole walk
//! (FR-X-5) with the skip reported back to the caller. None of these fixtures write
//! `.cowrite/config.json`, so they exercise the ratified defaults unchanged; the config-override
//! half (P2b-8a-ii, #422) has its own dedicated coverage in `tests/skills_config.rs`.

use std::fs;
use std::path::{Path, PathBuf};

use emend_lib::skills::{self, SkipReason};

/// A fresh, empty project root unique to `test` (under Cargo's per-target tmp dir).
fn project_root(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("skills_discovery")
        .join(test);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create project root");
    dir
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).expect("create parent dirs");
    fs::write(path, content).expect("write fixture file");
}

#[test]
fn discovers_a_skill_md_carrying_both_name_and_description_at_any_depth() {
    let root = project_root("discovers_a_skill_md_carrying_both_name_and_description_at_any_depth");
    let skill_path = root.join("tools/nested/deep/SKILL.md");
    write(
        &skill_path,
        "---\nname: distill\ndescription: Distill lessons from this session into a skill.\n---\n\n# Distill\n",
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(found.skills.len(), 1);
    let skill = &found.skills[0];
    assert_eq!(skill.name, "distill");
    assert_eq!(
        skill.description,
        "Distill lessons from this session into a skill."
    );
    assert_eq!(skill.path, skill_path);
    assert!(found.skipped.is_empty());
}

#[test]
fn a_skill_md_missing_description_is_not_a_skill() {
    let root = project_root("a_skill_md_missing_description_is_not_a_skill");
    write(&root.join("SKILL.md"), "---\nname: incomplete\n---\nbody\n");

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.skills.is_empty(),
        "a SKILL.md missing description must not be reported as a skill"
    );
}

#[test]
fn a_skill_md_missing_name_is_not_a_skill() {
    let root = project_root("a_skill_md_missing_name_is_not_a_skill");
    write(
        &root.join("SKILL.md"),
        "---\ndescription: no name here\n---\nbody\n",
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.skills.is_empty(),
        "a SKILL.md missing name must not be reported as a skill"
    );
}

#[test]
fn standard_ignore_directories_are_excluded_from_the_walk() {
    let root = project_root("standard_ignore_directories_are_excluded_from_the_walk");
    for ignored in [".git", "node_modules", "target", "dist", "build"] {
        write(
            &root.join(ignored).join("vendored/SKILL.md"),
            "---\nname: ignored\ndescription: should never surface\n---\n",
        );
    }
    write(
        &root.join("real/SKILL.md"),
        "---\nname: real\ndescription: this one should surface\n---\n",
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(
        found.skills.len(),
        1,
        "only the non-ignored SKILL.md should surface"
    );
    assert_eq!(found.skills[0].name, "real");
}

#[test]
fn workflow_discovery_uses_the_default_workflows_star_md_glob() {
    let root = project_root("workflow_discovery_uses_the_default_workflows_star_md_glob");
    write(
        &root.join("workflows/outline.md"),
        "# Outline\n\nSteps...\n",
    );
    write(&root.join("workflows/revise.md"), "# Revise\n\nSteps...\n");
    // Not `.md` — must be excluded.
    write(&root.join("workflows/notes.txt"), "not a workflow\n");
    // Nested one level below `workflows/` — the default glob is `workflows/*.md`, not recursive.
    write(&root.join("workflows/nested/deeper.md"), "# Deeper\n");

    let found = skills::discover(&root).expect("discovery should succeed");

    let names: Vec<_> = found.workflows.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(
        names.len(),
        2,
        "expected exactly the two top-level workflows/*.md files"
    );
    assert!(names.contains(&"outline"));
    assert!(names.contains(&"revise"));
}

#[test]
fn discovery_reports_only_paths_and_parsed_frontmatter_never_file_bodies() {
    let root =
        project_root("discovery_reports_only_paths_and_parsed_frontmatter_never_file_bodies");
    write(
        &root.join("SKILL.md"),
        "---\nname: distill\ndescription: short\n---\n\nThis body text must never be copied anywhere.\n",
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    // Structural guarantee: `Skill` carries no body/content field at all — the type itself is the
    // enforcement, but assert the two fields it does carry are exactly name + description so a
    // future field addition doesn't quietly smuggle file content back in unnoticed.
    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skills[0].name, "distill");
    assert_eq!(found.skills[0].description, "short");
}

#[test]
fn a_skill_md_with_no_closing_delimiter_is_skipped_not_fatal_and_the_skip_is_reported() {
    let root = project_root(
        "a_skill_md_with_no_closing_delimiter_is_skipped_not_fatal_and_the_skip_is_reported",
    );
    let malformed = root.join("broken/SKILL.md");
    write(&malformed, "---\nname: broken\ndescription: never closed\n");
    write(
        &root.join("healthy/SKILL.md"),
        "---\nname: healthy\ndescription: this one still discovers\n---\n",
    );

    let found = skills::discover(&root).expect("discovery should not fail for one bad file");

    assert_eq!(
        found.skills.len(),
        1,
        "the malformed file must not block the healthy one"
    );
    assert_eq!(found.skills[0].name, "healthy");
    assert_eq!(found.skipped.len(), 1);
    assert_eq!(found.skipped[0].path, malformed);
    assert!(matches!(found.skipped[0].reason, SkipReason::Malformed(_)));
}

#[test]
fn a_skill_md_with_no_frontmatter_at_all_is_skipped_and_reported() {
    let root = project_root("a_skill_md_with_no_frontmatter_at_all_is_skipped_and_reported");
    let no_frontmatter = root.join("SKILL.md");
    write(&no_frontmatter, "# Just a heading, no frontmatter block\n");

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(found.skills.is_empty());
    assert_eq!(found.skipped.len(), 1);
    assert_eq!(found.skipped[0].path, no_frontmatter);
    assert!(matches!(found.skipped[0].reason, SkipReason::Malformed(_)));
}

#[test]
fn an_unreadable_skill_md_is_skipped_not_fatal_and_the_skip_is_reported() {
    let root = project_root("an_unreadable_skill_md_is_skipped_not_fatal_and_the_skip_is_reported");
    // Invalid UTF-8 bytes stand in for "unreadable" without depending on platform-specific
    // permission bits (Windows ACLs vs POSIX chmod don't behave the same way in a CI sandbox) — a
    // binary file misnamed `SKILL.md` fails `fs::read_to_string` identically to a permissions error.
    let unreadable = root.join("SKILL.md");
    fs::create_dir_all(unreadable.parent().unwrap()).expect("create parent dirs");
    fs::write(&unreadable, [0xff, 0xfe, 0x00, 0xff]).expect("write invalid utf-8 fixture");
    write(
        &root.join("healthy/SKILL.md"),
        "---\nname: healthy\ndescription: still discovers\n---\n",
    );

    let found =
        skills::discover(&root).expect("discovery should not fail for one unreadable entry");

    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skipped.len(), 1);
    assert_eq!(found.skipped[0].path, unreadable);
    assert!(matches!(found.skipped[0].reason, SkipReason::Unreadable(_)));
}

// Bug #2 (review Important 2): a permission-denied subdirectory must not abort the whole walk and
// discard skills/workflows already found in sibling trees that read fine — only Unix has portable
// permission bits in this sandbox (Windows ACLs behave differently and are unverified here, as
// elsewhere in this module — CI has been disabled since 2026-07-10).
#[cfg(unix)]
#[test]
fn a_permission_denied_subdirectory_does_not_abort_the_whole_walk() {
    use std::os::unix::fs::PermissionsExt;

    let root = project_root("a_permission_denied_subdirectory_does_not_abort_the_whole_walk");
    write(
        &root.join("healthy/SKILL.md"),
        "---\nname: healthy\ndescription: this one still discovers\n---\n",
    );
    let locked = root.join("locked");
    fs::create_dir_all(&locked).expect("create locked dir");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000))
        .expect("lock down the directory");

    let result = skills::discover(&root);

    // Always restore permissions before asserting, so a failing assertion doesn't leave an
    // unremovable fixture directory behind for the next run (project_root() removes it first).
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755))
        .expect("restore permissions for cleanup");

    let found = result.expect("one unreadable subdirectory must not fail the whole walk");
    assert_eq!(
        found.skills.len(),
        1,
        "the healthy sibling skill must still be discovered"
    );
    assert_eq!(found.skills[0].name, "healthy");
    assert_eq!(
        found.skipped.len(),
        1,
        "the unreadable directory must be reported as a skip, not silently dropped"
    );
    assert_eq!(found.skipped[0].path, locked);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::DirectoryUnreadable(_)
    ));
}

// Bug #3 (review round 3, Important 1): `discover_workflows` must honor the same
// subdirectory-level partial-failure contract `walk_for_skills` does — a broken `workflows/` must
// not discard skills already found elsewhere in the project. `workflows` being a regular file
// (`NotADirectory`) needs no special permissions and reproduces on every platform, unlike the
// chmod-based case below.
#[test]
fn a_workflows_path_that_is_a_regular_file_does_not_abort_the_whole_walk() {
    let root =
        project_root("a_workflows_path_that_is_a_regular_file_does_not_abort_the_whole_walk");
    write(
        &root.join("healthy/SKILL.md"),
        "---\nname: healthy\ndescription: this one still discovers\n---\n",
    );
    let workflows_path = root.join("workflows");
    fs::write(&workflows_path, "not a directory\n").expect("write workflows as a plain file");

    let found = skills::discover(&root)
        .expect("a workflows/ that isn't a directory must not fail the whole walk");

    assert_eq!(
        found.skills.len(),
        1,
        "the healthy skill must still be discovered even though workflows/ is broken"
    );
    assert_eq!(found.skills[0].name, "healthy");
    assert!(
        found.workflows.is_empty(),
        "no workflows can be read from a path that isn't a directory"
    );
    assert_eq!(
        found.skipped.len(),
        1,
        "the broken workflows/ path must be reported as a skip, not silently dropped"
    );
    assert_eq!(found.skipped[0].path, workflows_path);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::DirectoryUnreadable(_)
    ));
}

// Same contract, exercised via a genuinely permission-denied `workflows/` directory rather than a
// `NotADirectory` shape — Unix-only for the same reason as the skills-side chmod test above.
#[cfg(unix)]
#[test]
fn a_permission_denied_workflows_directory_does_not_abort_the_whole_walk() {
    use std::os::unix::fs::PermissionsExt;

    let root =
        project_root("a_permission_denied_workflows_directory_does_not_abort_the_whole_walk");
    write(
        &root.join("healthy/SKILL.md"),
        "---\nname: healthy\ndescription: this one still discovers\n---\n",
    );
    let workflows_dir = root.join("workflows");
    fs::create_dir_all(&workflows_dir).expect("create workflows dir");
    fs::write(workflows_dir.join("outline.md"), "# Outline\n").expect("write workflow fixture");
    fs::set_permissions(&workflows_dir, fs::Permissions::from_mode(0o000))
        .expect("lock down the workflows directory");

    let result = skills::discover(&root);

    // Always restore permissions before asserting, so a failing assertion doesn't leave an
    // unremovable fixture directory behind for the next run (project_root() removes it first).
    fs::set_permissions(&workflows_dir, fs::Permissions::from_mode(0o755))
        .expect("restore permissions for cleanup");

    let found = result.expect("a permission-denied workflows/ must not fail the whole walk");
    assert_eq!(
        found.skills.len(),
        1,
        "the healthy skill must still be discovered even though workflows/ is unreadable"
    );
    assert!(found.workflows.is_empty());
    // `workflows/` is walked twice over — once by `walk_for_skills`, which descends into every
    // non-ignored directory looking for a `SKILL.md`, and once by `discover_workflows` itself — so
    // a permission-denied `workflows/` is independently reported by both (unlike the `NotADirectory`
    // case above, where `walk_for_skills` never attempts to descend into a plain file at all).
    // What matters for FR-X-5 is that every skip is honestly attributed to `workflows/` and none is
    // silently dropped, not the exact count.
    let workflow_skips: Vec<_> = found
        .skipped
        .iter()
        .filter(|s| s.path == workflows_dir)
        .collect();
    assert!(
        !workflow_skips.is_empty(),
        "the unreadable workflows/ directory must be reported as a skip, not silently dropped"
    );
    assert!(
        workflow_skips
            .iter()
            .all(|s| matches!(s.reason, SkipReason::DirectoryUnreadable(_))),
        "every skip attributed to workflows/ must carry DirectoryUnreadable"
    );
    assert_eq!(
        found.skipped.len(),
        workflow_skips.len(),
        "every skip in this fixture must be attributable to workflows/"
    );
}

#[test]
fn ignore_directory_names_are_matched_case_insensitively() {
    let root = project_root("ignore_directory_names_are_matched_case_insensitively");
    write(
        &root.join("Node_Modules/vendored/SKILL.md"),
        "---\nname: ignored\ndescription: should never surface\n---\n",
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.skills.is_empty(),
        "a differently-cased ignore dir must still be excluded"
    );
}

// -- `find_instruction_file` (P2b-8b, #360): the repo instruction file J8's project card names
// ("claude.md") — a distinct, root-only lookup from the skills/workflows walk above.

#[test]
fn finds_a_root_level_claude_md() {
    let root = project_root("finds_a_root_level_claude_md");
    write(&root.join("CLAUDE.md"), "# Instructions\n");

    assert_eq!(
        skills::find_instruction_file(&root),
        Some("CLAUDE.md".to_string())
    );
}

#[test]
fn instruction_file_lookup_is_case_insensitive() {
    let root = project_root("instruction_file_lookup_is_case_insensitive");
    write(&root.join("claude.md"), "# Instructions\n");

    // Reports the name exactly as it's cased on disk, not the canonical spelling — the card
    // renders what the repo actually has.
    assert_eq!(
        skills::find_instruction_file(&root),
        Some("claude.md".to_string())
    );
}

#[test]
fn instruction_file_lookup_is_not_recursive() {
    let root = project_root("instruction_file_lookup_is_not_recursive");
    write(&root.join("docs/CLAUDE.md"), "# Not the root one\n");

    assert_eq!(skills::find_instruction_file(&root), None);
}

#[test]
fn a_project_with_no_instruction_file_reports_none_honestly() {
    let root = project_root("a_project_with_no_instruction_file_reports_none_honestly");
    write(&root.join("README.md"), "# Just a readme\n");

    assert_eq!(skills::find_instruction_file(&root), None);
}
