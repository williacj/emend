// ABOUTME: Stub MCP tool server — the in-process stand-in the fake agent calls (test-plan §1, P0-7).
// ABOUTME: The real loopback server landed in P2a-12 (`cowrite_lib::agent::mcp`, TD-1 §3.2); this stub stays the fake-agent's deterministic in-process seam for scenario round-trips.

use serde_json::{json, Value};

/// A server that answers Cowrite MCP tool calls (TD-1 §3.2 surface).
///
/// This is the seam the fake agent calls through when replaying an `McpCall`
/// step. In production the calls land on the loopback MCP server (`cowrite_lib::
/// agent::mcp`, P2a-12); in tests they land on [`StubToolServer`]. Keeping it a trait means a
/// test can inject a scripted server (P0-8 uses this for stale-revision
/// rejections) without the playback engine knowing which side answered.
///
/// `call` receives the tool `name` and its already-`arguments` payload (the
/// caller schema-validates against `provider_contract::Schema::McpToolCall`
/// before dispatch when validation is on). The returned `Value` is the tool
/// result. There is no published *result* schema yet — the tool-result stream
/// framing was not exercised in SPIKE-1 (gap #7) and is captured during adapter
/// work — so results are asserted by scenario `expect`, not schema-validated.
pub trait ToolServer {
    /// Handle one tool call, returning its result value or an error.
    fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ToolError>;
}

/// Why a tool call could not be answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// The tool name is not part of the TD-1 §3.2 surface.
    UnknownTool(String),
    /// The call could not be completed against a *remote* tool server
    /// ([`HttpToolServer`](crate::HttpToolServer)): a transport failure, or a JSON-RPC error
    /// response — including the `401 unauthorized` a wrong or absent bearer token earns (§3.5).
    Failed(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::UnknownTool(name) => write!(f, "unknown tool: {name}"),
            ToolError::Failed(why) => write!(f, "tool call failed: {why}"),
        }
    }
}

impl std::error::Error for ToolError {}

/// A minimal stand-in for the Cowrite MCP server: every TD-1 §3.2 tool answers
/// with a fixed, well-shaped response. Deterministic (no clocks, no counters) so
/// scenarios can assert exact round-trips via `expect`. Unknown tools error.
///
/// This is intentionally dumb — it does *not* enforce protection (D21) or
/// revision staleness (TD-7); those live in the real tool implementation. P0-8's
/// misbehavior scenarios inject their own [`ToolServer`] when they need a
/// rejecting server.
#[derive(Debug, Default, Clone)]
pub struct StubToolServer;

impl ToolServer for StubToolServer {
    fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ToolError> {
        match name {
            "get_document_state" => Ok(json!({
                "content": "# Stub document\n\nCanned content from the stub tool server.\n",
                "revision": "rev-stub-0001",
                "pending_changes": [],
                "comments": [],
                "protection": "protected"
            })),
            "propose_changes" => Ok(json!({ "change_set_id": "cs-stub-0001" })),
            "add_comments" => {
                // One {id, placement} per submitted comment (TD-14), so a scenario can assert the
                // count. Deterministic stub — every comment canned-answers as cleanly placed.
                let n = arguments
                    .get("comments")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                let ids: Vec<Value> = (0..n)
                    .map(|i| json!({ "id": format!("cmt-stub-{i:04}"), "placement": "placed" }))
                    .collect();
                Ok(json!({ "ids": ids }))
            }
            "reply_to_comment" => Ok(json!({ "reply_id": "reply-stub-0001" })),
            "create_document" => {
                // Mirrors the real tool's response shape (P2b-6a-i, `agent::state::McpContext::
                // create_document`): the created path echoed back plus a minted doc identity —
                // opening the tab is the sibling card's job, out of this tool's response.
                let path = arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(json!({ "path": path, "doc_id": "doc-stub-0001" }))
            }
            "list_documents" => Ok(json!({ "documents": [] })),
            "permission_request" => Ok(
                json!({ "behavior": "deny", "message": "No human permission broker is attached to this fixture." }),
            ),
            other => Err(ToolError::UnknownTool(other.to_string())),
        }
    }
}

/// A tool server that knows the document's current revision and rejects any
/// `propose_changes` carrying a *different* revision as stale (TD-7 revision-token
/// staleness). Matching-revision (and every other) call delegates to
/// [`StubToolServer`]. P0-8's stale-revision misbehavior scenario drives a
/// `propose_changes` against an out-of-date revision and asserts this rejection via
/// the step's `expect`.
///
/// The rejection is a *response value*, not a [`ToolError`]: in the MCP model a
/// stale call is answered, not a transport failure. Shape (provisional — there is
/// no published tool-*result* schema yet, see [`ToolServer`]): `{ "rejected":
/// "stale_revision", "current_revision": <cur>, "submitted_revision": <sent> }`.
#[derive(Debug, Clone)]
pub struct RevisionAwareToolServer {
    current_revision: String,
    inner: StubToolServer,
}

impl RevisionAwareToolServer {
    /// A server whose document is at `current_revision`; `propose_changes` against
    /// any other revision is rejected as stale.
    pub fn new(current_revision: impl Into<String>) -> Self {
        Self {
            current_revision: current_revision.into(),
            inner: StubToolServer,
        }
    }
}

impl ToolServer for RevisionAwareToolServer {
    fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ToolError> {
        // `propose_changes` is the only TD-1 §3.2 tool carrying a revision token.
        if name == "propose_changes" {
            if let Some(submitted) = arguments.get("revision").and_then(Value::as_str) {
                if submitted != self.current_revision {
                    return Ok(json!({
                        "rejected": "stale_revision",
                        "current_revision": self.current_revision,
                        "submitted_revision": submitted,
                    }));
                }
            }
        }
        self.inner.call(name, arguments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_document_state_returns_a_td1_shaped_response() {
        let mut server = StubToolServer;
        let resp = server
            .call("get_document_state", &json!({ "doc": "notes.md" }))
            .expect("stub answers get_document_state");
        // TD-1 §3.2: {content, revision, pending_changes[], comments[], protection}.
        assert!(resp.get("content").is_some());
        assert!(resp.get("revision").is_some());
        assert!(resp["pending_changes"].is_array());
        assert!(resp["comments"].is_array());
        assert!(resp.get("protection").is_some());
    }

    #[test]
    fn create_document_echoes_the_path_and_mints_a_doc_id() {
        let mut server = StubToolServer;
        let resp = server
            .call(
                "create_document",
                &json!({ "path": "chapters/02-draft.md", "content": "# Chapter 2\n" }),
            )
            .expect("stub answers create_document");
        assert_eq!(resp["path"], "chapters/02-draft.md");
        assert_eq!(resp["doc_id"], "doc-stub-0001");
    }

    #[test]
    fn propose_changes_returns_a_change_set_id() {
        let mut server = StubToolServer;
        let resp = server
            .call(
                "propose_changes",
                &json!({
                    "doc": "notes.md",
                    "revision": "rev-stub-0001",
                    "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                    "summary": "add x"
                }),
            )
            .expect("stub answers propose_changes");
        assert_eq!(resp["change_set_id"], "cs-stub-0001");
    }

    #[test]
    fn add_comments_returns_one_id_per_comment() {
        let mut server = StubToolServer;
        let resp = server
            .call(
                "add_comments",
                &json!({ "doc": "notes.md", "comments": [{}, {}, {}] }),
            )
            .unwrap();
        let ids = resp["ids"].as_array().unwrap();
        assert_eq!(ids.len(), 3);
        // TD-14: each entry is {id, placement}, not a bare id string.
        for entry in ids {
            assert!(entry["id"].as_str().unwrap().starts_with("cmt-stub-"));
            assert_eq!(entry["placement"], "placed");
        }
    }

    #[test]
    fn responses_are_deterministic() {
        let mut a = StubToolServer;
        let mut b = StubToolServer;
        let args = json!({ "doc": "notes.md" });
        assert_eq!(
            a.call("get_document_state", &args).unwrap(),
            b.call("get_document_state", &args).unwrap()
        );
    }

    #[test]
    fn unknown_tool_is_an_error() {
        let mut server = StubToolServer;
        let err = server.call("teleport", &json!({})).unwrap_err();
        assert_eq!(err, ToolError::UnknownTool("teleport".to_string()));
    }

    #[test]
    fn revision_aware_server_rejects_a_stale_propose() {
        let mut server = RevisionAwareToolServer::new("rev-current");
        let resp = server
            .call(
                "propose_changes",
                &json!({
                    "doc": "notes.md",
                    "revision": "rev-old",
                    "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                    "summary": "s"
                }),
            )
            .unwrap();
        assert_eq!(
            resp,
            json!({
                "rejected": "stale_revision",
                "current_revision": "rev-current",
                "submitted_revision": "rev-old"
            })
        );
    }

    #[test]
    fn revision_aware_server_accepts_a_current_propose() {
        // A matching revision is not stale: it delegates to the stub (change_set_id).
        let mut server = RevisionAwareToolServer::new("rev-current");
        let resp = server
            .call(
                "propose_changes",
                &json!({
                    "doc": "notes.md",
                    "revision": "rev-current",
                    "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                    "summary": "s"
                }),
            )
            .unwrap();
        assert_eq!(resp["change_set_id"], "cs-stub-0001");
    }

    #[test]
    fn revision_aware_server_delegates_other_tools() {
        // Only propose_changes carries a revision; other tools pass straight through.
        let mut server = RevisionAwareToolServer::new("rev-current");
        let resp = server
            .call("get_document_state", &json!({ "doc": "notes.md" }))
            .unwrap();
        assert!(resp.get("content").is_some());
    }
}
