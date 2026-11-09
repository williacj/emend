// ABOUTME: Validation helper for the Cowrite provider contract (TD-1) — stream-JSON grammar + MCP payloads.
// ABOUTME: Embeds the published docs/formats/provider-contract schemas and validates values/transcripts against them (test-plan §1 contract parity).

//! Reusable validation helper for the Cowrite provider contract.
//!
//! The machine-readable half of the TD-1 contract lives as JSON Schemas under
//! `docs/formats/provider-contract/`. This crate embeds those schemas at build
//! time (via `include_str!`) so validation always runs against the *published*
//! contract — the contract is itself a fixture (test-plan §3). It is the
//! keystone that keeps the fake agent honest (test-plan §1, "contract parity"):
//! fake-agent output and recorded live-smoke transcripts validate against the
//! same schemas the fake is built from.
//!
//! # Example
//! ```
//! use provider_contract::Schema;
//! use serde_json::json;
//!
//! let event = json!({ "type": "result", "subtype": "success", "session_id": "abc" });
//! assert!(provider_contract::is_valid(Schema::ClaudeStreamEvent, &event));
//! ```

use std::sync::OnceLock;

use jsonschema::Validator;
use serde_json::Value;

/// A published provider-contract schema.
///
/// Each variant maps to one file under `docs/formats/provider-contract/`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Schema {
    /// A single Claude Code CLI `stream-json` event (`stream-event.claude.schema.json`).
    ClaudeStreamEvent,
    /// A single GitHub Copilot CLI JSON event (`stream-event.copilot.schema.json`).
    CopilotStreamEvent,
    /// The `mcpServers` config Cowrite injects into a spawned CLI (`mcp-server-config.schema.json`).
    McpServerConfig,
    /// A Copilot `preToolUse` hook decision (`permission-hook-decision.schema.json`).
    PermissionHookDecision,
    /// Arguments for a Cowrite-hosted MCP tool call (`mcp-tool-call.schema.json`).
    McpToolCall,
    /// Claude native permission-prompt-tool arguments, before canonical TD-1 adaptation.
    ClaudePermissionCallback,
}

const CLAUDE_STREAM_EVENT: &str =
    include_str!("../../../../docs/formats/provider-contract/stream-event.claude.schema.json");
const COPILOT_STREAM_EVENT: &str =
    include_str!("../../../../docs/formats/provider-contract/stream-event.copilot.schema.json");
const MCP_SERVER_CONFIG: &str =
    include_str!("../../../../docs/formats/provider-contract/mcp-server-config.schema.json");
const PERMISSION_HOOK_DECISION: &str =
    include_str!("../../../../docs/formats/provider-contract/permission-hook-decision.schema.json");
const MCP_TOOL_CALL: &str =
    include_str!("../../../../docs/formats/provider-contract/mcp-tool-call.schema.json");

const CLAUDE_PERMISSION_CALLBACK: &str = include_str!(
    "../../../../docs/formats/provider-contract/permission-callback.claude.schema.json"
);

impl Schema {
    /// The raw JSON Schema source for this contract (the published document).
    pub fn source(self) -> &'static str {
        match self {
            Schema::ClaudeStreamEvent => CLAUDE_STREAM_EVENT,
            Schema::CopilotStreamEvent => COPILOT_STREAM_EVENT,
            Schema::McpServerConfig => MCP_SERVER_CONFIG,
            Schema::PermissionHookDecision => PERMISSION_HOOK_DECISION,
            Schema::McpToolCall => MCP_TOOL_CALL,
            Schema::ClaudePermissionCallback => CLAUDE_PERMISSION_CALLBACK,
        }
    }
}

struct Compiled {
    claude_stream_event: Validator,
    copilot_stream_event: Validator,
    mcp_server_config: Validator,
    permission_hook_decision: Validator,
    mcp_tool_call: Validator,
    claude_permission_callback: Validator,
}

fn compile(source: &str) -> Validator {
    let schema: Value =
        serde_json::from_str(source).expect("embedded provider-contract schema is valid JSON");
    jsonschema::validator_for(&schema).expect("embedded provider-contract schema compiles")
}

fn compiled() -> &'static Compiled {
    static COMPILED: OnceLock<Compiled> = OnceLock::new();
    COMPILED.get_or_init(|| Compiled {
        claude_stream_event: compile(CLAUDE_STREAM_EVENT),
        copilot_stream_event: compile(COPILOT_STREAM_EVENT),
        mcp_server_config: compile(MCP_SERVER_CONFIG),
        permission_hook_decision: compile(PERMISSION_HOOK_DECISION),
        mcp_tool_call: compile(MCP_TOOL_CALL),
        claude_permission_callback: compile(CLAUDE_PERMISSION_CALLBACK),
    })
}

fn validator(schema: Schema) -> &'static Validator {
    let c = compiled();
    match schema {
        Schema::ClaudeStreamEvent => &c.claude_stream_event,
        Schema::CopilotStreamEvent => &c.copilot_stream_event,
        Schema::McpServerConfig => &c.mcp_server_config,
        Schema::PermissionHookDecision => &c.permission_hook_decision,
        Schema::McpToolCall => &c.mcp_tool_call,
        Schema::ClaudePermissionCallback => &c.claude_permission_callback,
    }
}

/// Returns `true` iff `value` conforms to `schema`.
pub fn is_valid(schema: Schema, value: &Value) -> bool {
    validator(schema).is_valid(value)
}

/// Validates a single decoded value against `schema`.
///
/// On failure returns every validation error rendered as a human-readable
/// string (order is validator-defined).
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

/// Validates a whole JSONL transcript, one event per non-empty line, against a
/// stream-event `schema`.
///
/// Every failing line is reported with its 1-based line number (both JSON parse
/// errors and schema-validation errors). Intended for the stream-event schemas
/// (`ClaudeStreamEvent`, `CopilotStreamEvent`) but works for any schema.
pub fn validate_transcript(schema: Schema, jsonl: &str) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    for (idx, raw) in jsonl.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => {
                if let Err(line_errors) = validate(schema, &value) {
                    for e in line_errors {
                        errors.push(format!("line {line_no}: {e}"));
                    }
                }
            }
            Err(e) => errors.push(format!("line {line_no}: invalid JSON: {e}")),
        }
    }
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
        // Touching the lazily-compiled set forces all five to compile; a broken
        // schema panics here rather than at first use.
        let _ = compiled();
        for schema in [
            Schema::ClaudeStreamEvent,
            Schema::CopilotStreamEvent,
            Schema::McpServerConfig,
            Schema::PermissionHookDecision,
            Schema::McpToolCall,
        ] {
            let doc: Value = serde_json::from_str(schema.source()).unwrap();
            // Every published schema carries a schema_version (integer).
            assert!(
                doc.get("schema_version").and_then(Value::as_u64).is_some(),
                "{schema:?} must carry an integer schema_version"
            );
        }
    }
}
