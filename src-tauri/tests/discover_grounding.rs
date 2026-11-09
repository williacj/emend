// ABOUTME: Integration tests for the `discover_grounding` IPC command (P2b-8b, #360, FR-SKILL-1) —
// ABOUTME: the project card's one call, shaping `skills::discover` + the instruction-file lookup.

use std::fs;
use std::path::PathBuf;

use emend_lib::commands::skills::{
    discover_grounding_payload, GroundingSkillPayload, GroundingWorkflowPayload,
};

fn project_root(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("discover_grounding")
        .join(test);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create project root");
    dir
}

#[test]
fn shapes_discovered_skills_workflows_and_the_instruction_file_into_the_wire_payload() {
    let root = project_root(
        "shapes_discovered_skills_workflows_and_the_instruction_file_into_the_wire_payload",
    );
    fs::write(
        root.join("SKILL.md"),
        "---\nname: distill\ndescription: Distill lessons into a skill.\n---\n",
    )
    .expect("write skill fixture");
    fs::create_dir_all(root.join("workflows")).expect("create workflows dir");
    fs::write(root.join("workflows/review.md"), "# Review\n").expect("write workflow fixture");
    fs::write(root.join("CLAUDE.md"), "# Instructions\n").expect("write instruction file");

    let payload = discover_grounding_payload(&root).expect("discovery should succeed");

    assert_eq!(
        payload.skills,
        vec![GroundingSkillPayload {
            name: "distill".to_string(),
            description: "Distill lessons into a skill.".to_string(),
            path: "SKILL.md".to_string(),
        }]
    );
    assert_eq!(
        payload.workflows,
        vec![GroundingWorkflowPayload {
            name: "review".to_string(),
            path: "workflows/review.md".to_string(),
        }]
    );
    assert_eq!(payload.instruction_file, Some("CLAUDE.md".to_string()));
}

#[test]
fn a_project_with_nothing_to_find_reports_honest_empty_counts_not_an_error() {
    let root =
        project_root("a_project_with_nothing_to_find_reports_honest_empty_counts_not_an_error");

    let payload = discover_grounding_payload(&root).expect("discovery should succeed");

    assert!(payload.skills.is_empty());
    assert!(payload.workflows.is_empty());
    assert_eq!(payload.instruction_file, None);
}

#[test]
fn a_skill_with_no_name_or_description_is_excluded_but_still_counted_honestly() {
    let root =
        project_root("a_skill_with_no_name_or_description_is_excluded_but_still_counted_honestly");
    fs::write(root.join("SKILL.md"), "---\nname: incomplete\n---\n").expect("write skill fixture");

    let payload = discover_grounding_payload(&root).expect("discovery should succeed");

    assert!(
        payload.skills.is_empty(),
        "a SKILL.md missing description must not surface as a discovered skill"
    );
}

#[test]
fn discovery_paths_are_project_relative_for_rail_ownership() {
    let root = project_root("discovery_paths_are_project_relative_for_rail_ownership");
    let skill = root.join(".claude/skills/review/SKILL.md");
    let nested = root.join(".claude/skills/review/revision/SKILL.md");
    let workflow = root.join(".claude/skills/review/workflows/polish.md");
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    fs::create_dir_all(workflow.parent().unwrap()).unwrap();
    fs::write(
        &skill,
        "---\nname: review\ndescription: Review a draft.\n---\n",
    )
    .unwrap();
    fs::write(
        &nested,
        "---\nname: revision\ndescription: Revise a draft.\n---\n",
    )
    .unwrap();
    fs::write(&workflow, "# Polish\n").unwrap();
    fs::create_dir_all(root.join(".cowrite")).unwrap();
    fs::write(
        root.join(".cowrite/config.json"),
        r#"{"schema_version":1,"workflows":{"glob":".claude/skills/review/workflows/*.md"}}"#,
    )
    .unwrap();

    let payload = serde_json::to_value(discover_grounding_payload(&root).unwrap()).unwrap();
    let skills = payload["skills"].as_array().unwrap();
    let review = skills.iter().find(|item| item["name"] == "review").unwrap();
    let revision = skills
        .iter()
        .find(|item| item["name"] == "revision")
        .unwrap();
    assert_eq!(review["path"], ".claude/skills/review/SKILL.md");
    assert_eq!(revision["path"], ".claude/skills/review/revision/SKILL.md");
    assert_eq!(
        payload["workflows"][0]["path"],
        ".claude/skills/review/workflows/polish.md"
    );
}

#[test]
fn configured_discovery_uses_canonical_root_for_relative_paths() {
    let root = project_root("configured_discovery_uses_canonical_root_for_relative_paths");
    fs::create_dir_all(root.join("subdir")).unwrap();
    fs::create_dir_all(root.join("skills")).unwrap();
    fs::create_dir_all(root.join("workflows")).unwrap();
    fs::create_dir_all(root.join(".cowrite")).unwrap();
    fs::write(
        root.join("skills/SKILL.md"),
        "---\nname: draft\ndescription: Draft prose.\n---\n",
    )
    .unwrap();
    fs::write(root.join("workflows/review.md"), "# Review\n").unwrap();
    fs::write(
        root.join(".cowrite/config.json"),
        r#"{"schema_version":1,"skills":{"roots":["skills"]},"workflows":{"glob":"workflows/*.md"}}"#,
    )
    .unwrap();

    let requested_root = root.join("subdir/..");
    let payload = discover_grounding_payload(&requested_root).unwrap();

    assert_eq!(payload.skills[0].path, "skills/SKILL.md");
    assert_eq!(payload.workflows[0].path, "workflows/review.md");
}
