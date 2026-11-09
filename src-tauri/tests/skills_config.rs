// ABOUTME: Integration tests for `.emend/config.json` (issue #422, P2b-8a-ii, split of #359)
// ABOUTME: against real fixture project trees on disk, per test-plan §3's "plain integration tests".

//! FR-SKILL-5 acceptance for the config-override half: `.emend/config.json` overrides the skill
//! root(s) and the workflow glob at project open; a missing config leaves the ratified defaults
//! (`tests/skills_discovery.rs`) unchanged; a configured path that escapes the project root is
//! rejected, not followed (§3.5) — covering `..`, an absolute path, and a symlink that resolves
//! outside; and a missing/unreadable/malformed config degrades to the defaults honestly (FR-X-5):
//! reported via `Discovery::skipped`, never silently ignored.

use std::fs;
use std::path::{Path, PathBuf};

use emend_lib::skills::{self, SkipReason};

fn project_root(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("skills_config")
        .join(test);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create project root");
    dir
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).expect("create parent dirs");
    fs::write(path, content).expect("write fixture file");
}

fn write_config(root: &Path, json: &str) {
    write(&root.join(".emend/config.json"), json);
}

fn skill(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n")
}

// -- Absent config: the ratified defaults apply unchanged. --

#[test]
fn an_absent_config_uses_the_ratified_defaults_unchanged() {
    let root = project_root("an_absent_config_uses_the_ratified_defaults_unchanged");
    write(
        &root.join("SKILL.md"),
        &skill("real", "discovered by default"),
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skills[0].name, "real");
    assert!(
        found.skipped.is_empty(),
        "no config at all is not itself a reportable problem"
    );
}

// -- `skills.roots` override: narrows the walk to exactly the configured directories. --

#[test]
fn a_skills_roots_override_narrows_discovery_to_the_configured_directory() {
    let root =
        project_root("a_skills_roots_override_narrows_discovery_to_the_configured_directory");
    write(
        &root.join("tools/skills/SKILL.md"),
        &skill("in-root", "inside the configured root"),
    );
    write(
        &root.join("elsewhere/SKILL.md"),
        &skill("outside-root", "outside the configured root"),
    );
    write_config(
        &root,
        r#"{"schema_version": 1, "skills": {"roots": ["tools/skills"]}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    let names: Vec<_> = found.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["in-root"],
        "only the configured root should be walked, not the whole project"
    );
}

#[test]
fn an_explicitly_empty_skills_roots_override_discovers_no_skills_at_all() {
    // A present-but-empty `roots` key is a deliberate "walk nothing" override, distinct from the
    // key being absent entirely (which is the ratified default, tested above).
    let root = project_root("an_explicitly_empty_skills_roots_override_discovers_no_skills_at_all");
    write(&root.join("SKILL.md"), &skill("real", "should not surface"));
    write_config(&root, r#"{"schema_version": 1, "skills": {"roots": []}}"#);

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(found.skills.is_empty());
}

// -- `workflows.glob` override: relocates the workflow directory. --

#[test]
fn a_workflows_glob_override_relocates_the_workflow_directory() {
    let root = project_root("a_workflows_glob_override_relocates_the_workflow_directory");
    write(&root.join("materials/workflows/outline.md"), "# Outline\n");
    // The *default* location must NOT be read once an override is configured.
    write(&root.join("workflows/revise.md"), "# Revise\n");
    write_config(
        &root,
        r#"{"schema_version": 1, "workflows": {"glob": "materials/workflows/*.md"}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    let names: Vec<_> = found.workflows.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(names, vec!["outline"]);
}

// -- Path confinement holds for the override (§3.5) — this goes first per the card's acceptance. --

#[test]
fn a_skills_roots_entry_using_dot_dot_to_escape_root_is_rejected_not_followed() {
    let root =
        project_root("a_skills_roots_entry_using_dot_dot_to_escape_root_is_rejected_not_followed");
    write(&root.join("SKILL.md"), &skill("real", "still discovered"));
    write_config(
        &root,
        r#"{"schema_version": 1, "skills": {"roots": ["../escape"]}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.skills.is_empty(),
        "the escaping root must be rejected, not walked"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigPathRejected(_)
    ));
}

#[test]
fn a_skills_roots_entry_using_an_absolute_path_is_rejected_not_followed() {
    let root = project_root("a_skills_roots_entry_using_an_absolute_path_is_rejected_not_followed");
    write(&root.join("SKILL.md"), &skill("real", "still discovered"));
    let escape = if cfg!(windows) {
        r#""C:\\evil""#.to_string()
    } else {
        "\"/etc\"".to_string()
    };
    write_config(
        &root,
        &format!(r#"{{"schema_version": 1, "skills": {{"roots": [{escape}]}}}}"#),
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(found.skills.is_empty());
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigPathRejected(_)
    ));
}

#[cfg(unix)]
#[test]
fn a_skills_roots_entry_resolving_through_a_symlink_outside_root_is_rejected_not_followed() {
    let root = project_root(
        "a_skills_roots_entry_resolving_through_a_symlink_outside_root_is_rejected_not_followed",
    );
    let outside = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("skills_config")
        .join("symlink_target_outside_root");
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(&outside).unwrap();
    write(
        &outside.join("SKILL.md"),
        &skill("outside", "must never surface"),
    );
    std::os::unix::fs::symlink(&outside, root.join("escape-link")).unwrap();
    write_config(
        &root,
        r#"{"schema_version": 1, "skills": {"roots": ["escape-link"]}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.skills.is_empty(),
        "a root resolving outside the project via a symlink must be rejected"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigPathRejected(_)
    ));
}

#[test]
fn a_workflows_glob_directory_escaping_root_is_rejected_and_the_default_still_does_not_apply() {
    let root = project_root(
        "a_workflows_glob_directory_escaping_root_is_rejected_and_the_default_still_does_not_apply",
    );
    write(&root.join("workflows/outline.md"), "# Outline\n");
    write_config(
        &root,
        r#"{"schema_version": 1, "workflows": {"glob": "../escape/*.md"}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert!(
        found.workflows.is_empty(),
        "the escaping override is rejected, not silently replaced by the default"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigPathRejected(_)
    ));
}

// -- Honest degrade to defaults (FR-X-5): missing/unreadable/malformed never fails project open. --

#[test]
fn a_malformed_json_config_degrades_to_defaults_and_is_reported() {
    let root = project_root("a_malformed_json_config_degrades_to_defaults_and_is_reported");
    write(&root.join("SKILL.md"), &skill("real", "still discovered"));
    write_config(&root, "{not valid json");

    let found = skills::discover(&root).expect("a malformed config must not fail project open");

    assert_eq!(
        found.skills.len(),
        1,
        "the ratified default (whole-tree walk) still applies"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigMalformed(_)
    ));
}

#[test]
fn a_config_missing_schema_version_degrades_to_defaults_and_is_reported() {
    let root = project_root("a_config_missing_schema_version_degrades_to_defaults_and_is_reported");
    write(&root.join("SKILL.md"), &skill("real", "still discovered"));
    write_config(&root, r#"{"skills": {"roots": ["tools"]}}"#);

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(
        found.skills.len(),
        1,
        "defaults apply, not the malformed override"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigMalformed(_)
    ));
}

#[test]
fn an_unsupported_workflows_glob_shape_degrades_to_the_default_glob_and_is_reported() {
    let root = project_root(
        "an_unsupported_workflows_glob_shape_degrades_to_the_default_glob_and_is_reported",
    );
    write(&root.join("workflows/outline.md"), "# Outline\n");
    // Recursive globs are out of scope for this card (module doc) — an unsupported value shape,
    // not a confinement failure.
    write_config(
        &root,
        r#"{"schema_version": 1, "workflows": {"glob": "workflows/**/*.md"}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(
        found.workflows.len(),
        1,
        "the default `workflows/*.md` glob still applies"
    );
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigMalformed(_)
    ));
}

#[cfg(unix)]
#[test]
fn an_unreadable_config_file_degrades_to_defaults_and_is_reported() {
    use std::os::unix::fs::PermissionsExt;

    let root = project_root("an_unreadable_config_file_degrades_to_defaults_and_is_reported");
    write(&root.join("SKILL.md"), &skill("real", "still discovered"));
    let config_path = root.join(".emend/config.json");
    write(&config_path, r#"{"schema_version": 1}"#);
    fs::set_permissions(&config_path, fs::Permissions::from_mode(0o000)).unwrap();

    let result = skills::discover(&root);

    fs::set_permissions(&config_path, fs::Permissions::from_mode(0o644)).unwrap();

    let found = result.expect("an unreadable config must not fail project open");
    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::ConfigMalformed(_)
    ));
}

// -- Forward compatibility: an unknown top-level key is tolerated, not a degrade. --

#[test]
fn an_unknown_top_level_config_key_is_tolerated_not_a_degrade() {
    let root = project_root("an_unknown_top_level_config_key_is_tolerated_not_a_degrade");
    write(
        &root.join("tools/skills/SKILL.md"),
        &skill("in-root", "inside the configured root"),
    );
    write_config(
        &root,
        r#"{"schema_version": 1, "skills": {"roots": ["tools/skills"]}, "a_future_key": {"anything": true}}"#,
    );

    let found = skills::discover(&root).expect("discovery should succeed");

    assert_eq!(found.skills.len(), 1);
    assert_eq!(found.skills[0].name, "in-root");
    assert!(
        found.skipped.is_empty(),
        "an unrecognized top-level key is forward-compatible, not a reportable problem"
    );
}

// -- A missing configured skill root degrades honestly (reported) without failing project open. --

#[test]
fn a_configured_skill_root_that_does_not_exist_is_reported_but_does_not_fail_discovery() {
    let root = project_root(
        "a_configured_skill_root_that_does_not_exist_is_reported_but_does_not_fail_discovery",
    );
    write(&root.join("SKILL.md"), &skill("default-tree", "not walked"));
    write_config(
        &root,
        r#"{"schema_version": 1, "skills": {"roots": ["does/not/exist"]}}"#,
    );

    let found =
        skills::discover(&root).expect("a missing configured root must not fail project open");

    assert!(found.skills.is_empty());
    assert_eq!(found.skipped.len(), 1);
    assert!(matches!(
        found.skipped[0].reason,
        SkipReason::DirectoryUnreadable(_)
    ));
}
