// ABOUTME: Schema-validation tests — the example scenarios emit only contract-valid stream-JSON.
// ABOUTME: Acceptance for #32 ("schema validation in its own tests"); test-plan §1 contract-parity.

use std::path::PathBuf;

use fake_agent::{Scenario, Step};
use provider_contract::Schema;

fn scenario(name: &str) -> Scenario {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scenarios")
        .join(name);
    Scenario::from_path(path).expect("scenario parses")
}

/// The shipped example scenarios (one per file). Both `emit` and `mcp_call` steps
/// carry payloads that must satisfy the published provider contract.
const EXAMPLE_SCENARIOS: &[&str] = &[
    "claude-minimal-success.json",
    "claude-read-then-answer.json",
    "claude-mcp-propose.json",
    "claude-mcp-comments.json",
    "claude-mcp-create-document.json",
];

/// Every event every shipped scenario emits must satisfy the published provider
/// contract, and every scripted MCP call must satisfy the strict `McpToolCall`
/// schema — the fake stays honest against both grammars it claims to speak.
#[test]
fn every_example_scenario_step_is_contract_valid() {
    for name in EXAMPLE_SCENARIOS {
        let s = scenario(name);
        for (i, step) in s.steps.iter().enumerate() {
            match step {
                Step::Emit(event) => assert!(
                    provider_contract::is_valid(Schema::ClaudeStreamEvent, event),
                    "{name} step {i} (emit) invalid: {:?}",
                    provider_contract::validate(Schema::ClaudeStreamEvent, event)
                ),
                Step::McpCall {
                    tool, arguments, ..
                } => {
                    let call = serde_json::json!({ "name": tool, "arguments": arguments });
                    assert!(
                        provider_contract::is_valid(Schema::McpToolCall, &call),
                        "{name} step {i} (mcp_call {tool}) invalid: {:?}",
                        provider_contract::validate(Schema::McpToolCall, &call)
                    );
                }
                // The clean example scenarios contain only emit/mcp_call. P0-8's
                // misbehavior primitives carry no contract to validate and must
                // never appear here — flag it loudly if one ever does.
                other => panic!(
                    "{name} step {i}: example scenarios contain only emit/mcp_call, got {other:?}"
                ),
            }
        }
    }
}

/// The contract has teeth: a plausible-but-wrong event is rejected. Without this,
/// "every scenario validates" would be vacuous. A result event omits its required
/// `session_id` — the drift-tolerant schema still pins load-bearing fields.
#[test]
fn schema_rejects_a_result_event_missing_session_id() {
    let bad = serde_json::json!({ "type": "result", "subtype": "success" });
    assert!(!provider_contract::is_valid(
        Schema::ClaudeStreamEvent,
        &bad
    ));
}
