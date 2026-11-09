// ABOUTME: `.cowrite/config.json` — the published override for `skills`' ratified discovery
// ABOUTME: defaults (FR-SKILL-5, split of #359 / #421); every path it names is §3.5-confined.

//! **Untrusted input, honestly degraded (FR-X-5).** `.cowrite/config.json` is the one on-disk
//! contract this module reads that isn't wholly authored by Cowrite itself — it travels with a
//! cloned repo, so a configured skill root or workflow glob is exactly the untrusted-path shape
//! §3.5 confinement exists for. [`resolve`] never fails: a missing file is the ordinary "no
//! override" case; an unreadable/malformed file, or any individual path that fails confinement,
//! degrades to the ratified default for the affected piece — but every one of those is still
//! *reported* (via the `issues` out-param, using the same [`super::SkipReason`]/[`super::SkippedSkill`]
//! shape `skills::discover`'s own walk already reports skips through) rather than silently
//! ignored, so a misconfigured repo never looks identical to a well-configured one.
//!
//! **Schema.** Published at `docs/formats/sidecar/project-config.schema.json` (catalog:
//! `docs/formats/sidecar/README.md`), carrying its own `schema_version` (TD-4) independent of the
//! instance's. An unknown *top-level* key is tolerated (forward compatibility — a later card's own
//! override lives beside these); an unknown *value shape* for a key this schema already owns
//! (`skills` not an object, `workflows.glob` not a `<dir>/*.md` string, …) is a contract violation,
//! enforced both by the published schema (`docs/formats/sidecar` conformance tests) and by this
//! module's own parsing, which is deliberately narrower than full JSON Schema so a malformed value
//! degrades rather than panics.
//!
//! **Scope, deliberately narrow.** The workflow override widens *where* the default glob looks,
//! not *how* it looks: like the ratified default (`skills` module doc), only a single top-level
//! directory plus a literal `*.md` suffix is supported — no recursion, no multi-extension globs.
//! A repo that needs more is a future schema_version, not this one (YAGNI).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::path_confine;

use super::{SkipReason, SkippedSkill};

/// Bumped whenever the on-wire shape changes (TD-4: "every file carries `schema_version`").
pub const SCHEMA_VERSION: u32 = 1;

const COWRITE_DIR: &str = ".cowrite";
const CONFIG_FILE: &str = "config.json";

/// The whole `.cowrite/config.json` file (`project-config.schema.json`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub schema_version: u32,
    // `skip_serializing_if` (not just `#[serde(default)]`) so an absent override serializes as an
    // absent key, never `null` — the published schema types `skills`/`workflows` as objects, and a
    // JSON `null` fails that type check (a real config the app itself round-trips must still
    // conform to its own published contract).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<SkillsOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflows: Option<WorkflowsOverride>,
}

/// Overrides for skill discovery (FR-SKILL-5).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillsOverride {
    /// Project-relative directories to walk for `SKILL.md` instead of the whole project tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<String>>,
}

/// Overrides for workflow discovery (FR-SKILL-5).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkflowsOverride {
    /// A `<project-relative-dir>/*.md` glob replacing the default `workflows/*.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
}

/// What [`super::discover`] should actually walk, after applying and confining
/// `.cowrite/config.json`'s overrides. `None` in either field means the ratified default applies —
/// there was no config, the config didn't touch that piece, or the `roots`/`glob` key was simply
/// absent (as opposed to present-but-empty, which is a deliberate "walk nothing" override — see
/// [`resolve`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Resolved {
    pub skill_roots: Option<Vec<PathBuf>>,
    /// Same "present-but-possibly-empty means override in effect" convention as `skill_roots`: a
    /// `workflows.glob` that parses (the supported `<dir>/*.md` shape) but fails §3.5 confinement
    /// still counts as an override in effect — `Some(vec![])`, searching nothing rather than
    /// silently widening back to the default. Only a `glob` that isn't even the right *shape*
    /// (unsupported, e.g. recursive) leaves this `None`, since it was never a legitimate override
    /// attempt to begin with.
    pub workflow_dirs: Option<Vec<PathBuf>>,
}

/// Reads and applies `<project_root>/.cowrite/config.json`. Never fails: every problem —
/// unreadable file, malformed JSON/shape, or a path that fails §3.5 confinement — degrades to the
/// ratified default for the affected piece and is pushed onto `issues` (reusing
/// `skills::discover`'s own skip-reporting shape) rather than silently dropped.
pub fn resolve(project_root: &Path, issues: &mut Vec<SkippedSkill>) -> Resolved {
    let config_path = project_root.join(COWRITE_DIR).join(CONFIG_FILE);

    let raw = match fs::read_to_string(&config_path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Resolved::default(),
        Err(e) => {
            issues.push(SkippedSkill {
                path: config_path,
                reason: SkipReason::ConfigMalformed(e.to_string()),
            });
            return Resolved::default();
        }
    };

    let parsed: ProjectConfig = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            issues.push(SkippedSkill {
                path: config_path,
                reason: SkipReason::ConfigMalformed(e.to_string()),
            });
            return Resolved::default();
        }
    };

    let mut resolved = Resolved::default();

    if let Some(roots) = parsed.skills.and_then(|s| s.roots) {
        // The `roots` key was present (even if empty) — an override is in effect. Each entry is
        // confined independently: a rejected entry is dropped, not followed, but does not widen
        // the remaining, valid entries back out to the whole-tree default (that would defeat the
        // point of a narrowing override just because one sibling entry was untrustworthy).
        let confined = roots
            .iter()
            .filter_map(|root| {
                confine_reporting(
                    project_root,
                    &config_path,
                    &format!("skills.roots {root:?}"),
                    root,
                    issues,
                )
            })
            .collect();
        resolved.skill_roots = Some(confined);
    }

    if let Some(glob) = parsed.workflows.and_then(|w| w.glob) {
        match parse_workflow_glob_dir(&glob) {
            // A well-formed override attempt (the supported shape) counts as "in effect" even if
            // confinement then rejects it — mirrors `skills.roots` above: dropped, not followed,
            // but not silently widened back to the default the override was there to replace.
            Some(dir) => {
                let confined = confine_reporting(
                    project_root,
                    &config_path,
                    &format!("workflows.glob {glob:?}"),
                    dir,
                    issues,
                );
                resolved.workflow_dirs = Some(confined.into_iter().collect());
            }
            None => issues.push(SkippedSkill {
                path: config_path.clone(),
                reason: SkipReason::ConfigMalformed(format!(
                    "workflows.glob {glob:?} is not a supported `<dir>/*.md` shape"
                )),
            }),
        }
    }

    resolved
}

/// Shared by both `skills.roots` (a list) and `workflows.glob` (confining just its directory
/// half): confines `value` against `project_root`, reporting (via `issues`, never failing) a
/// confinement rejection under `context` — a human-readable label naming the field and the exact
/// configured value, since `value` itself may already have been reduced (e.g. a glob's directory
/// portion) by the time it gets here.
fn confine_reporting(
    project_root: &Path,
    config_path: &Path,
    context: &str,
    value: &str,
    issues: &mut Vec<SkippedSkill>,
) -> Option<PathBuf> {
    match path_confine::confine(project_root, value) {
        Ok(path) => Some(path),
        Err(e) => {
            issues.push(SkippedSkill {
                path: config_path.to_path_buf(),
                reason: SkipReason::ConfigPathRejected(format!("{context}: {e}")),
            });
            None
        }
    }
}

/// Extracts the directory half of a `<dir>/*.md` workflow glob (see module doc for why only this
/// one shape is supported). `None` means the value isn't that shape at all — a malformed value,
/// not a confinement failure.
fn parse_workflow_glob_dir(glob: &str) -> Option<&str> {
    glob.strip_suffix("/*.md")
        .filter(|dir| !dir.is_empty() && !dir.contains('*'))
}

#[cfg(test)]
mod pure_tests {
    use super::*;

    #[test]
    fn parse_workflow_glob_dir_accepts_the_supported_shape() {
        assert_eq!(
            parse_workflow_glob_dir("materials/workflows/*.md"),
            Some("materials/workflows")
        );
    }

    #[test]
    fn parse_workflow_glob_dir_rejects_a_recursive_glob() {
        assert_eq!(parse_workflow_glob_dir("workflows/**/*.md"), None);
    }

    #[test]
    fn parse_workflow_glob_dir_rejects_a_bare_pattern_with_no_directory() {
        assert_eq!(parse_workflow_glob_dir("*.md"), None);
    }

    #[test]
    fn parse_workflow_glob_dir_rejects_a_missing_suffix() {
        assert_eq!(parse_workflow_glob_dir("workflows/*.markdown"), None);
    }
}

#[cfg(test)]
mod conformance_tests {
    // Binds this module's wire shape to the *published* contract (FR-X-8, test-plan §3: "the
    // schema is a fixture") — every `ProjectConfig` this module can produce must validate against
    // `docs/formats/sidecar/project-config.schema.json`.
    use super::*;
    use crate::store::schema::{is_valid, Schema};

    #[test]
    fn a_default_config_conforms_to_the_published_schema() {
        assert!(is_valid(
            Schema::ProjectConfig,
            &serde_json::to_value(ProjectConfig {
                schema_version: SCHEMA_VERSION,
                skills: None,
                workflows: None,
            })
            .unwrap()
        ));
    }

    #[test]
    fn a_fully_populated_config_conforms_to_the_published_schema() {
        assert!(is_valid(
            Schema::ProjectConfig,
            &serde_json::to_value(ProjectConfig {
                schema_version: SCHEMA_VERSION,
                skills: Some(SkillsOverride {
                    roots: Some(vec!["tools/skills".to_string()]),
                }),
                workflows: Some(WorkflowsOverride {
                    glob: Some("materials/workflows/*.md".to_string()),
                }),
            })
            .unwrap()
        ));
    }
}
