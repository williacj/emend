// ABOUTME: Grounding IPC (P2b-8b, FR-SKILL-1) — the thin command that makes `skills::discover`'s
// ABOUTME: output (plus the repo instruction file) visible to the frontend's project card.

use std::path::Path;

use serde::Serialize;

use crate::skills;

use super::document::CommandError;

/// One discovered skill, trimmed to what the project card renders (§2 J8 Screen 2: name +
/// description, tap to list them) — never the file body (FR-SKILL-2/D10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroundingSkillPayload {
    pub name: String,
    pub description: String,
    /// The discovered SKILL.md, relative to the project root with `/` separators (J2).
    pub path: String,
}

/// One discovered workflow — the default glob carries no frontmatter requirement, so there is no
/// description to show (`skills::Workflow`'s own docs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroundingWorkflowPayload {
    pub name: String,
    /// The discovered workflow file, relative to the project root with `/` separators (J2).
    pub path: String,
}

/// What the project card renders on project open (J8 Screen 2, FR-SKILL-1): every discovered
/// skill and workflow, plus the repo instruction file's name when the project has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroundingPayload {
    pub skills: Vec<GroundingSkillPayload>,
    pub workflows: Vec<GroundingWorkflowPayload>,
    pub instruction_file: Option<String>,
}

/// Walks `project_root` for skills, workflows, and the repo instruction file, and shapes the
/// result into the card's wire payload. Synchronous and self-contained (mirrors
/// `commands::providers::detect_provider_payloads`) so both the async command below and the D23
/// test driver can call it directly.
pub fn discover_grounding_payload(project_root: &Path) -> Result<GroundingPayload, CommandError> {
    // Configured roots pass through `path_confine::confine`, which returns paths below the
    // canonical root. Use that same root for default discovery and relative wire identities.
    let project_root = project_root.canonicalize()?;
    let discovery = skills::discover(&project_root)?;
    Ok(GroundingPayload {
        skills: discovery
            .skills
            .into_iter()
            .map(|skill| {
                Ok(GroundingSkillPayload {
                    name: skill.name,
                    description: skill.description,
                    path: project_relative_path(&project_root, &skill.path)?,
                })
            })
            .collect::<Result<Vec<_>, CommandError>>()?,
        workflows: discovery
            .workflows
            .into_iter()
            .map(|workflow| {
                Ok(GroundingWorkflowPayload {
                    name: workflow.name,
                    path: project_relative_path(&project_root, &workflow.path)?,
                })
            })
            .collect::<Result<Vec<_>, CommandError>>()?,
        instruction_file: skills::find_instruction_file(&project_root),
    })
}

fn project_relative_path(root: &Path, path: &Path) -> Result<String, CommandError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        CommandError::InvalidPath("discovered grounding path is outside the project".into())
    })?;
    let mut components = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(CommandError::InvalidPath(
                "discovered grounding path is not project-relative".into(),
            ));
        };
        components.push(name.to_str().ok_or_else(|| {
            CommandError::InvalidPath("discovered grounding path is not UTF-8".into())
        })?);
    }
    Ok(components.join("/"))
}

/// The project card's one call on project open (J8 Screen 2): discovered skills/workflows plus
/// the repo instruction file, if any.
///
/// `async` + `spawn_blocking` (not a plain sync command), matching `detect_providers`' own
/// reasoning: the walk touches the whole project tree, which can be slow on a large repo, and a
/// sync `#[tauri::command]` runs on the Tauri main thread — offloading it to the blocking pool
/// keeps the UI thread free (FR-X-4).
#[tauri::command]
pub async fn discover_grounding(root: String) -> Result<GroundingPayload, CommandError> {
    tauri::async_runtime::spawn_blocking(move || discover_grounding_payload(Path::new(&root)))
        .await
        .unwrap_or_else(|_| {
            Err(CommandError::Io(
                "grounding discovery task panicked".to_string(),
            ))
        })
}

// See `tests/discover_grounding.rs` for coverage — a fixture-tree integration test (test-plan §3),
// matching `skills::discover`'s own convention, and the only place `CARGO_TARGET_TMPDIR` (the
// fixture root every one of those tests writes under) is available to Cargo.
