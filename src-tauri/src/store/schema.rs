// ABOUTME: Sidecar schema conformance — embeds the published `docs/formats/sidecar/` JSON
// ABOUTME: Schemas (FR-X-8's portability contract) and validates values against them (test-plan §3 stores).

//! Test-only conformance helper binding `store::comments`/`store::changes`/`store::docs_map` to
//! the *published* JSON Schemas under `docs/formats/sidecar/`.
//!
//! Mirrors the `provider-contract` crate's helper (same embed-at-build-time-via-`include_str!`,
//! compile-once-via-`OnceLock` shape) but stays inside this crate rather than a sibling crate:
//! nothing outside `emend`'s own test suite consumes it yet (TD-10 — a crate boundary is only
//! worth paying for when something needs to depend on the helper without linking the app
//! `cdylib`). `#[cfg(test)]`-gated in `store::mod` accordingly; `jsonschema` is a dev-dependency
//! only.

use std::sync::OnceLock;

use jsonschema::Validator;
use serde_json::Value;

/// A published sidecar schema (`docs/formats/sidecar/`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Schema {
    /// One line of a `.emend/comments/<doc-hash>/<author>.jsonl` event log
    /// (`comment-event.schema.json`) — `store::comments::CommentEvent`.
    CommentEvent,
    /// One record's value in `.emend/changes/<doc-hash>.json` (`change-record.schema.json`) —
    /// `store::changes::ChangeRecord`.
    ChangeRecord,
    /// The whole `.emend/docs.json` file (`docs-map.schema.json`) — `store::docs_map::DocsMap`
    /// (P2a-10).
    DocsMap,
    /// The whole `.emend/config.json` file (`project-config.schema.json`) —
    /// `skills::config::ProjectConfig` (P2b-8a-ii, #422). Unlike the other three, this file is
    /// optional/untrusted input: a missing/malformed one degrades to `skills`'s ratified defaults
    /// rather than failing (FR-X-5), and every path it names is §3.5-confined before use.
    ProjectConfig,
}

const COMMENT_EVENT: &str = include_str!("../../../docs/formats/sidecar/comment-event.schema.json");
const CHANGE_RECORD: &str = include_str!("../../../docs/formats/sidecar/change-record.schema.json");
const DOCS_MAP: &str = include_str!("../../../docs/formats/sidecar/docs-map.schema.json");
const PROJECT_CONFIG: &str =
    include_str!("../../../docs/formats/sidecar/project-config.schema.json");

impl Schema {
    /// The raw JSON Schema source for this contract (the published document).
    pub fn source(self) -> &'static str {
        match self {
            Schema::CommentEvent => COMMENT_EVENT,
            Schema::ChangeRecord => CHANGE_RECORD,
            Schema::DocsMap => DOCS_MAP,
            Schema::ProjectConfig => PROJECT_CONFIG,
        }
    }
}

struct Compiled {
    comment_event: Validator,
    change_record: Validator,
    docs_map: Validator,
    project_config: Validator,
}

fn compile(source: &str) -> Validator {
    let schema: Value =
        serde_json::from_str(source).expect("embedded sidecar schema is valid JSON");
    jsonschema::validator_for(&schema).expect("embedded sidecar schema compiles")
}

fn compiled() -> &'static Compiled {
    static COMPILED: OnceLock<Compiled> = OnceLock::new();
    COMPILED.get_or_init(|| Compiled {
        comment_event: compile(COMMENT_EVENT),
        change_record: compile(CHANGE_RECORD),
        docs_map: compile(DOCS_MAP),
        project_config: compile(PROJECT_CONFIG),
    })
}

fn validator(schema: Schema) -> &'static Validator {
    let c = compiled();
    match schema {
        Schema::CommentEvent => &c.comment_event,
        Schema::ChangeRecord => &c.change_record,
        Schema::DocsMap => &c.docs_map,
        Schema::ProjectConfig => &c.project_config,
    }
}

/// Returns `true` iff `value` conforms to `schema`.
pub fn is_valid(schema: Schema, value: &Value) -> bool {
    validator(schema).is_valid(value)
}

/// Validates a single decoded value against `schema`.
///
/// On failure returns every validation error rendered as a human-readable string (order is
/// validator-defined).
pub fn validate(schema: Schema, value: &Value) -> Result<(), Vec<String>> {
    let errors: Vec<String> = validator(schema)
        .iter_errors(value)
        .map(|e| e.to_string())
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_published_schema_compiles() {
        // Touching the lazily-compiled set forces all three to compile; a broken schema
        // panics here rather than at first use.
        let _ = compiled();
        for schema in [
            Schema::CommentEvent,
            Schema::ChangeRecord,
            Schema::DocsMap,
            Schema::ProjectConfig,
        ] {
            let doc: Value = serde_json::from_str(schema.source()).unwrap();
            // Every published schema carries a schema_version (integer) — TD-4/FR-X-8.
            assert!(
                doc.get("schema_version").and_then(Value::as_u64).is_some(),
                "{schema:?} must carry an integer schema_version"
            );
        }
    }

    #[test]
    fn the_committed_docs_map_example_validates() {
        let example = include_str!("../../../docs/formats/sidecar/examples/docs.example.json");
        let value: Value = serde_json::from_str(example).unwrap();
        assert!(is_valid(Schema::DocsMap, &value));
    }

    #[test]
    fn the_committed_project_config_example_validates() {
        let example =
            include_str!("../../../docs/formats/sidecar/examples/project-config.example.json");
        let value: Value = serde_json::from_str(example).unwrap();
        assert!(is_valid(Schema::ProjectConfig, &value));
    }

    #[test]
    fn a_project_config_missing_schema_version_is_rejected() {
        let value = serde_json::json!({ "skills": { "roots": ["tools"] } });
        assert!(!is_valid(Schema::ProjectConfig, &value));
    }

    #[test]
    fn a_project_config_with_an_unknown_top_level_key_is_tolerated() {
        // Forward compatibility: a key this schema doesn't know yet must not fail validation.
        let value = serde_json::json!({ "schema_version": 1, "future_feature": { "on": true } });
        assert!(is_valid(Schema::ProjectConfig, &value));
    }

    #[test]
    fn a_project_config_workflows_glob_without_the_supported_dir_star_md_shape_is_rejected() {
        let value = serde_json::json!({ "schema_version": 1, "workflows": { "glob": "**/*.md" } });
        assert!(!is_valid(Schema::ProjectConfig, &value));
    }

    #[test]
    fn a_project_config_skills_shaped_as_an_array_instead_of_an_object_is_rejected() {
        let value = serde_json::json!({ "schema_version": 1, "skills": ["tools"] });
        assert!(!is_valid(Schema::ProjectConfig, &value));
    }

    #[test]
    fn a_docs_map_missing_schema_version_is_rejected() {
        let value = serde_json::json!({ "documents": {} });
        assert!(!is_valid(Schema::DocsMap, &value));
    }

    #[test]
    fn a_docs_map_entry_keyed_by_a_non_uuid_is_rejected() {
        let value =
            serde_json::json!({ "schema_version": 1, "documents": { "not-a-uuid": "a.md" } });
        assert!(!is_valid(Schema::DocsMap, &value));
    }
}
