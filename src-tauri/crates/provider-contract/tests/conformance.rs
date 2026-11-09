// ABOUTME: Conformance tests for the provider-contract schemas (TD-1, test-plan §1 contract parity).
// ABOUTME: SPIKE-1 recorded transcripts validate; malformed payloads are rejected; drift is tolerated.

use provider_contract::{is_valid, validate, validate_transcript, Schema};
use serde_json::json;

const CLAUDE_TRANSCRIPT: &str = include_str!("fixtures/claude-stream.jsonl");
const COPILOT_TRANSCRIPT: &str = include_str!("fixtures/copilot-stream.jsonl");

// --- Recorded SPIKE-1 transcripts validate (acceptance: "SPIKE-1 transcripts validate") ---

#[test]
fn td1_claude_stream_transcript_conforms() {
    // Recorded SPIKE-1 §5.2 Claude Code stream-json transcript.
    if let Err(errors) = validate_transcript(Schema::ClaudeStreamEvent, CLAUDE_TRANSCRIPT) {
        panic!(
            "recorded Claude transcript must conform:\n{}",
            errors.join("\n")
        );
    }
}

#[test]
fn td1_copilot_stream_transcript_conforms() {
    // Recorded SPIKE-1 §5.3 Copilot CLI JSONL transcript.
    if let Err(errors) = validate_transcript(Schema::CopilotStreamEvent, COPILOT_TRANSCRIPT) {
        panic!(
            "recorded Copilot transcript must conform:\n{}",
            errors.join("\n")
        );
    }
}

// --- Drift tolerance: unknown event types still parse (version-drift canary, test-plan §1) ---

#[test]
fn contract_parity_unknown_claude_event_type_tolerated() {
    let future = json!({ "type": "some_future_event", "session_id": "x", "novel_field": 1 });
    assert!(is_valid(Schema::ClaudeStreamEvent, &future));
}

#[test]
fn contract_parity_unknown_copilot_event_type_tolerated() {
    let future = json!({ "type": "assistant.some_future_event", "data": {}, "id": "x" });
    assert!(is_valid(Schema::CopilotStreamEvent, &future));
}

// --- Malformed stream events are rejected ---

#[test]
fn contract_parity_claude_result_missing_session_id_rejected() {
    let bad = json!({ "type": "result", "subtype": "success", "is_error": false });
    assert!(validate(Schema::ClaudeStreamEvent, &bad).is_err());
}

/// #1118: the terminal `result` event's own `result` string is what carries a turn's answer into
/// the timeline (`agent::reply`), so it is a typed field of the published contract rather than an
/// undeclared extra — a provider emitting a non-string there is drift Emend must see, not parse.
#[test]
fn contract_parity_claude_result_with_a_non_string_answer_rejected() {
    let bad = json!({ "type": "result", "subtype": "success", "session_id": "s", "result": 7 });
    assert!(validate(Schema::ClaudeStreamEvent, &bad).is_err());

    // Still optional: a turn that produced no prose is a valid terminal event.
    let no_answer = json!({ "type": "result", "subtype": "success", "session_id": "s" });
    assert!(is_valid(Schema::ClaudeStreamEvent, &no_answer));
}

#[test]
fn contract_parity_claude_event_missing_type_rejected() {
    let bad = json!({ "subtype": "init", "session_id": "x" });
    assert!(validate(Schema::ClaudeStreamEvent, &bad).is_err());
}

#[test]
fn contract_parity_copilot_non_result_event_missing_data_rejected() {
    let bad = json!({ "type": "session.tools_updated", "id": "x" });
    assert!(validate(Schema::CopilotStreamEvent, &bad).is_err());
}

#[test]
fn contract_parity_copilot_assistant_message_missing_model_rejected() {
    let bad = json!({
        "type": "assistant.message",
        "data": { "messageId": "m", "content": "ok" },
        "id": "x"
    });
    assert!(validate(Schema::CopilotStreamEvent, &bad).is_err());
}

#[test]
fn contract_parity_copilot_result_missing_usage_rejected() {
    let bad = json!({ "type": "result", "sessionId": "s", "exitCode": 0 });
    assert!(validate(Schema::CopilotStreamEvent, &bad).is_err());
}

// --- MCP server config (SPIKE-1 §4.3) ---

#[test]
fn td1_mcp_server_config_spike_example_validates() {
    // The exact config schema captured empirically in SPIKE-1 §4.3 (http + local peers).
    let config = json!({
        "mcpServers": {
            "cowrite": {
                "tools": ["*"],
                "timeout": 5000,
                "type": "http",
                "url": "http://127.0.0.1:39999/mcp",
                "headers": { "Authorization": "Bearer test-token-123" }
            },
            "cowrite-stdio": {
                "tools": ["*"],
                "type": "local",
                "command": "node",
                "args": ["server.js", "--port", "1234"],
                "env": { "FOO": "bar" }
            }
        }
    });
    assert_eq!(validate(Schema::McpServerConfig, &config), Ok(()));
}

#[test]
fn td1_mcp_server_config_sse_transport_validates() {
    // `sse` shares the http `url`-required if/then branch; exercise it explicitly.
    let config = json!({
        "mcpServers": {
            "cowrite": { "type": "sse", "url": "http://127.0.0.1:39999/sse" }
        }
    });
    assert_eq!(validate(Schema::McpServerConfig, &config), Ok(()));
}

#[test]
fn contract_parity_mcp_http_server_without_url_rejected() {
    let bad = json!({
        "mcpServers": { "cowrite": { "type": "http", "headers": {} } }
    });
    assert!(validate(Schema::McpServerConfig, &bad).is_err());
}

// --- Permission hook decision (SPIKE-1 §4.4) ---

#[test]
fn td1_permission_hook_decision_validates() {
    for decision in ["allow", "deny", "ask"] {
        let d = json!({ "permissionDecision": decision, "permissionDecisionReason": "why" });
        assert_eq!(validate(Schema::PermissionHookDecision, &d), Ok(()));
    }
}

#[test]
fn contract_parity_permission_hook_invalid_decision_rejected() {
    let bad = json!({ "permissionDecision": "maybe" });
    assert!(validate(Schema::PermissionHookDecision, &bad).is_err());
}

// --- MCP tool-call payloads (TD-1 §3.2) ---

#[test]
fn td1_mcp_propose_changes_call_validates() {
    let call = json!({
        "name": "propose_changes",
        "arguments": {
            "doc": "chapter-1.md",
            "revision": "sha256:abc",
            "edits": [
                { "range": { "offset": 10, "length": 4 }, "replacement": "word", "note": "tighten" }
            ],
            "summary": "Tighten the opening",
            "change_set_meta": { "skill": "line-edit" }
        }
    });
    assert_eq!(validate(Schema::McpToolCall, &call), Ok(()));
}

#[test]
fn td1_mcp_add_comments_and_permission_request_validate() {
    let add = json!({
        "name": "add_comments",
        "arguments": {
            "doc": "chapter-1.md",
            "comments": [
                {
                    "anchor": { "offset": 3, "length": 5, "text_snapshot": "quick" },
                    "body": "unclear",
                    "severity": "high"
                }
            ]
        }
    });
    assert_eq!(validate(Schema::McpToolCall, &add), Ok(()));

    let perm = json!({
        "name": "permission_request",
        "arguments": { "action": "Write", "detail": "notes.md", "why": "draft" }
    });
    assert_eq!(validate(Schema::McpToolCall, &perm), Ok(()));

    let list = json!({ "name": "list_documents", "arguments": {} });
    assert_eq!(validate(Schema::McpToolCall, &list), Ok(()));
}

#[test]
fn contract_parity_mcp_unknown_tool_rejected() {
    let bad = json!({ "name": "delete_everything", "arguments": {} });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn contract_parity_mcp_propose_changes_missing_revision_rejected() {
    let bad = json!({
        "name": "propose_changes",
        "arguments": {
            "doc": "chapter-1.md",
            "edits": [{ "range": { "offset": 0, "length": 1 }, "replacement": "x" }],
            "summary": "s"
        }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn contract_parity_mcp_propose_changes_unknown_arg_rejected() {
    // Our own tools: unknown arguments are a contract violation (additionalProperties: false).
    let bad = json!({
        "name": "propose_changes",
        "arguments": {
            "doc": "chapter-1.md",
            "revision": "sha256:abc",
            "edits": [{ "range": { "offset": 0, "length": 1 }, "replacement": "x" }],
            "summary": "s",
            "bogus": true
        }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn contract_parity_mcp_reply_invalid_kind_rejected() {
    let bad = json!({
        "name": "reply_to_comment",
        "arguments": { "comment_id": "c1", "body": "b", "kind": "shout" }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn td1_mcp_add_comments_document_level_finding_validates_with_no_anchor() {
    // FR-REVIEW-2: document-level findings/comments carry no anchor at all.
    let add = json!({
        "name": "add_comments",
        "arguments": {
            "doc": "chapter-1.md",
            "comments": [
                {
                    "body": "overall tone drifts from the style guide",
                    "severity": "medium",
                    "skill": "voice-consistency",
                    "workflow_run": "run-42"
                }
            ]
        }
    });
    assert_eq!(validate(Schema::McpToolCall, &add), Ok(()));
}

#[test]
fn contract_parity_mcp_add_comments_missing_body_rejected() {
    let bad = json!({
        "name": "add_comments",
        "arguments": {
            "doc": "chapter-1.md",
            "comments": [{ "anchor": { "offset": 0, "length": 1, "text_snapshot": "x" } }]
        }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn contract_parity_mcp_add_comments_anchor_missing_text_snapshot_rejected() {
    // TD-14 condition 1: text_snapshot is required on every add_comments anchor.
    let bad = json!({
        "name": "add_comments",
        "arguments": {
            "doc": "chapter-1.md",
            "comments": [
                { "anchor": { "offset": 3, "length": 5 }, "body": "unclear" }
            ]
        }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn td1_mcp_reply_to_comment_defense_validates() {
    let reply = json!({
        "name": "reply_to_comment",
        "arguments": { "comment_id": "cmt-1", "body": "the wording is already correct", "kind": "defense" }
    });
    assert_eq!(validate(Schema::McpToolCall, &reply), Ok(()));
}

#[test]
fn td1_mcp_create_document_call_validates() {
    let call = json!({
        "name": "create_document",
        "arguments": {
            "path": "chapters/02-draft.md",
            "content": "# Chapter 2\n\nDrafted from the conversation.\n"
        }
    });
    assert_eq!(validate(Schema::McpToolCall, &call), Ok(()));
}

#[test]
fn contract_parity_mcp_create_document_missing_content_rejected() {
    let bad = json!({
        "name": "create_document",
        "arguments": { "path": "chapters/02-draft.md" }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn contract_parity_mcp_create_document_unknown_arg_rejected() {
    let bad = json!({
        "name": "create_document",
        "arguments": {
            "path": "chapters/02-draft.md",
            "content": "text",
            "overwrite": true
        }
    });
    assert!(validate(Schema::McpToolCall, &bad).is_err());
}

#[test]
fn claude_native_permission_callback_is_adapted_separately_from_td1() {
    let arguments = json!({"tool_name":"Bash","input":{"command":"python3 check.py","description":"check"},"tool_use_id":"fixture"});
    assert_eq!(
        validate(Schema::ClaudePermissionCallback, &arguments),
        Ok(())
    );
    assert!(validate(
        Schema::McpToolCall,
        &json!({"name":"permission_request","arguments":arguments})
    )
    .is_err());
    assert!(validate(
        Schema::ClaudePermissionCallback,
        &json!({"action":"Bash","detail":"python3 check.py","why":"check"})
    )
    .is_err());
}
