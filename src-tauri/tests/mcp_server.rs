// ABOUTME: Integration tests for the real Emend-hosted MCP server (P2a-12, TD-1 §3.2 / §3.5) — drives
// ABOUTME: the loopback + bearer server end-to-end over HTTP: get_document_state/list_documents/propose_changes, auth, confinement, schema.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::thread;

use serde_json::{json, Value};
use tempfile::TempDir;

use emend_lib::agent::mcp::LoopbackMcpServer;
use emend_lib::agent::state::McpContext;
use emend_lib::store::comments::{self, CommentEvent, EventKind};
use emend_lib::store::service::SidecarStore;

/// A project root with two docs and a sidecar on `draft.md`, plus a running loopback server whose
/// protected set is `["draft.md"]` (the single open tab). Returns the bound address, the session
/// token, and the `TempDir` (kept alive for the test's duration).
fn running_server() -> (SocketAddr, String, TempDir) {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("draft.md"), "# Draft\n\nBody.\n").unwrap();
    std::fs::write(root.join("notes.md"), "notes\n").unwrap();

    let store = SidecarStore::new(&root);
    let id = store.get_or_mint_for_path("draft.md").unwrap();
    store.get_or_mint_for_path("notes.md").unwrap();
    store
        .append_comment_event(
            id,
            &CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: "cmt-1".to_string(),
                parent_id: None,
                author: "reviewer".to_string(),
                timestamp: 0,
                kind: EventKind::Create {
                    anchor: None,
                    body: "clarify?".to_string(),
                    severity: Some("H".to_string()),
                    skill: None,
                    workflow_run: None,
                },
            },
        )
        .unwrap();

    let server = LoopbackMcpServer::bind().unwrap();
    let addr = server.local_addr().unwrap();
    let token = server.token().to_string();
    let ctx = McpContext::new(root, vec!["draft.md".to_string()]);
    thread::spawn(move || server.serve(ctx));
    (addr, token, dir)
}

/// Sends one JSON-RPC `tools/call` over a fresh loopback connection and returns `(http_status,
/// parsed_body)`. `token` is sent as `Authorization: Bearer <token>` when `Some`.
fn call(addr: SocketAddr, token: Option<&str>, name: &str, arguments: Value) -> (u16, Value) {
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
    .to_string();
    request(addr, token, &payload)
}

fn request(addr: SocketAddr, token: Option<&str>, payload: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).expect("connect to MCP server");
    let auth = match token {
        Some(t) => format!("Authorization: Bearer {t}\r\n"),
        None => String::new(),
    };
    let req = format!(
        "POST / HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(req.as_bytes()).expect("send request");

    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    let (head, body) = response
        .split_once("\r\n\r\n")
        .expect("response has header/body split");
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .expect("status code");
    let value = serde_json::from_str(body).unwrap_or(Value::Null);
    (status, value)
}

#[test]
fn get_document_state_round_trips_the_td1_shape_for_a_protected_doc() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );

    assert_eq!(status, 200);
    let result = &body["result"]["structuredContent"];
    assert_eq!(result["content"], "# Draft\n\nBody.\n");
    assert!(!result["revision"].as_str().unwrap().is_empty());
    assert!(result["pending_changes"].is_array());
    assert_eq!(result["protection"], "protected");
    // The comment appended to draft.md's sidecar comes back folded.
    let comments = result["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["body"], "clarify?");
}

#[test]
fn get_document_state_reports_unprotected_for_a_doc_that_is_not_an_open_tab() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "notes.md" }),
    );

    assert_eq!(status, 200);
    assert_eq!(
        body["result"]["structuredContent"]["protection"],
        "unprotected"
    );
}

#[test]
fn list_documents_returns_paths_with_protection_state() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(addr, Some(&token), "list_documents", json!({}));

    assert_eq!(status, 200);
    let docs = body["result"]["structuredContent"]["documents"]
        .as_array()
        .unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0]["path"], "draft.md");
    assert_eq!(docs[0]["protection"], "protected");
    assert_eq!(docs[1]["path"], "notes.md");
    assert_eq!(docs[1]["protection"], "unprotected");
}

#[test]
fn a_mismatched_bearer_token_is_rejected_before_any_tool_runs() {
    let (addr, _token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some("not-the-real-token"),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );

    assert_eq!(status, 401);
    assert_eq!(body["error"]["message"], "unauthorized");
}

#[test]
fn an_absent_bearer_token_is_rejected() {
    let (addr, _token, _dir) = running_server();

    let (status, _body) = call(
        addr,
        None,
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );

    assert_eq!(status, 401);
}

#[test]
fn a_doc_path_escaping_the_project_root_is_refused() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "../escape.md" }),
    );

    // A confinement refusal is a JSON-RPC invalid-params error, not a transport failure.
    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn an_unknown_tool_name_is_rejected_by_the_published_schema() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(addr, Some(&token), "teleport", json!({}));

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn malformed_arguments_are_rejected_by_the_published_schema() {
    let (addr, token, _dir) = running_server();

    // get_document_state requires a `doc` string; omitting it fails schema validation.
    let (status, body) = call(addr, Some(&token), "get_document_state", json!({}));

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn a_get_document_state_for_an_absent_doc_is_a_defined_error() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "ghost.md" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn create_document_writes_a_new_file_and_returns_its_path_and_identity() {
    let (addr, token, dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "create_document",
        json!({ "path": "drafts/outline.md", "content": "# Outline\n\n- one\n- two\n" }),
    );

    assert_eq!(status, 200);
    let result = &body["result"]["structuredContent"];
    assert_eq!(result["path"], "drafts/outline.md");
    assert!(!result["doc_id"].as_str().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("drafts/outline.md")).unwrap(),
        "# Outline\n\n- one\n- two\n"
    );
}

#[test]
fn create_document_refuses_to_overwrite_an_already_protected_document() {
    // D21: draft.md is the seeded open tab — its "unopened" direct-write precondition does not
    // hold, so create_document must refuse rather than silently overwrite it.
    let (addr, token, dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "create_document",
        json!({ "path": "draft.md", "content": "overwritten by the agent" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        "# Draft\n\nBody.\n"
    );
}

#[test]
fn create_document_rejects_a_path_escaping_the_project_root_over_the_wire() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "create_document",
        json!({ "path": "../escape.md", "content": "x" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn create_document_requires_authentication_like_every_other_tool() {
    let (addr, _token, _dir) = running_server();

    let (status, _body) = call(
        addr,
        None,
        "create_document",
        json!({ "path": "drafts/outline.md", "content": "x" }),
    );

    assert_eq!(status, 401);
}

#[test]
fn a_malformed_create_document_call_is_rejected_by_the_published_schema() {
    // The published contract requires both `path` and `content`.
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "create_document",
        json!({ "path": "drafts/outline.md" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn propose_changes_delivers_a_tracked_change_end_to_end() {
    // The agent's delivery path over the real server (P2a-13): read the doc's revision, then
    // propose an edit against it. The applied subset lands as CriticMarkup in the source of truth.
    let (addr, token, _dir) = running_server();

    let (_, state) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let revision = state["result"]["structuredContent"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, body) = call(
        addr,
        Some(&token),
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": revision,
            "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "Intro. " }],
            "summary": "add an intro"
        }),
    );

    assert_eq!(status, 200);
    let result = &body["result"]["structuredContent"];
    let applied = result["applied"].as_array().unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0]["index"], 0);
    assert!(result["change_set_id"].as_str().unwrap().starts_with("cs-"));
    assert!(result["stale"].as_array().unwrap().is_empty());
    assert!(result["unrepresentable"].as_array().unwrap().is_empty());

    // The tracked change is now in the document the server serves back.
    let (_, after) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    assert_eq!(
        after["result"]["structuredContent"]["content"],
        "{++Intro. ++}# Draft\n\nBody.\n"
    );
    let pending = after["result"]["structuredContent"]["pending_changes"]
        .as_array()
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["author"], "agent");
    assert_eq!(pending[0]["change_set"], result["change_set_id"]);
}

#[test]
fn propose_changes_partitions_stale_edits_over_the_wire() {
    // A delivery anchored to a revision the user has since edited past: the edit whose context
    // still matches applies, the conflicted one comes back stale (TD-7 / P6) — not a blanket reject.
    let (addr, token, dir) = running_server();
    std::fs::write(dir.path().join("draft.md"), "one two three four five\n").unwrap();

    let (_, state) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let base_rev = state["result"]["structuredContent"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    // The user keeps typing after the agent read the base: "five" -> "FIVE".
    std::fs::write(dir.path().join("draft.md"), "one two three four FIVE\n").unwrap();

    let (status, body) = call(
        addr,
        Some(&token),
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": base_rev,
            "edits": [
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " },
                { "range": { "offset": 19, "length": 4 }, "replacement": "5" }
            ],
            "summary": "two edits, one now stale"
        }),
    );

    assert_eq!(status, 200);
    let result = &body["result"]["structuredContent"];
    assert_eq!(result["applied"].as_array().unwrap().len(), 1);
    assert_eq!(result["stale"], json!([1]));

    let (_, after) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    assert_eq!(
        after["result"]["structuredContent"]["content"],
        "{++zero ++}one two three four FIVE\n"
    );
}

#[test]
fn a_malformed_propose_changes_call_is_a_json_rpc_invalid_params() {
    // The published contract requires a non-empty `edits` array (minItems 1). An empty batch is
    // refused at the schema boundary — invalid params — before the tool ever runs.
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "propose_changes",
        json!({
            "doc": "draft.md",
            "revision": "rev-whatever",
            "edits": [],
            "summary": "s"
        }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn add_comments_and_reply_to_comment_round_trip_end_to_end() {
    // The comment-side delivery path (P2b-5a): a review finding lands via add_comments (severity
    // + source skill carried through), then the agent defends it via reply_to_comment — the
    // defense flag is durable in the fold, not just a rendering choice.
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "add_comments",
        json!({
            "doc": "draft.md",
            "comments": [
                {
                    "body": "check this claim",
                    "severity": "high",
                    "skill": "fact-check",
                    "workflow_run": "run-7"
                }
            ]
        }),
    );
    assert_eq!(status, 200);
    let ids = body["result"]["structuredContent"]["ids"]
        .as_array()
        .unwrap();
    assert_eq!(ids.len(), 1);
    // TD-14: each entry is {id, placement} — a document-level finding (no anchor) always "places".
    assert_eq!(ids[0]["placement"], "placed");
    let new_comment_id = ids[0]["id"].as_str().unwrap().to_string();

    let (status, reply) = call(
        addr,
        Some(&token),
        "reply_to_comment",
        json!({
            "comment_id": new_comment_id,
            "body": "the claim is sourced in footnote 3",
            "kind": "defense"
        }),
    );
    assert_eq!(status, 200);
    assert!(reply["result"]["structuredContent"]["reply_id"]
        .as_str()
        .unwrap()
        .starts_with("cmt-"));

    let (_, state) = call(
        addr,
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );
    let comments = state["result"]["structuredContent"]["comments"]
        .as_array()
        .unwrap();
    // The pre-seeded cmt-1 plus the one just added.
    assert_eq!(comments.len(), 2);
    let found = comments
        .iter()
        .find(|c| c["id"] == new_comment_id)
        .expect("the newly added comment is present");
    assert_eq!(found["severity"], "high");
    let replies = found["replies"].as_array().unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["defense"], true);
}

#[test]
fn add_comments_supports_a_document_level_finding_over_the_wire() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "add_comments",
        json!({
            "doc": "draft.md",
            "comments": [{ "body": "overall structure needs work" }]
        }),
    );

    assert_eq!(status, 200);
    let ids = body["result"]["structuredContent"]["ids"]
        .as_array()
        .unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(ids[0]["placement"], "placed");
}

#[test]
fn reply_to_comment_on_an_unknown_id_is_a_json_rpc_invalid_params() {
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "reply_to_comment",
        json!({ "comment_id": "nonexistent", "body": "x", "kind": "reply" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn a_malformed_reply_to_comment_call_is_rejected_by_the_published_schema() {
    // The published contract restricts `kind` to reply|defense.
    let (addr, token, _dir) = running_server();

    let (status, body) = call(
        addr,
        Some(&token),
        "reply_to_comment",
        json!({ "comment_id": "cmt-1", "body": "x", "kind": "shout" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn a_non_post_method_is_rejected() {
    let (addr, token, _dir) = running_server();

    let mut stream = TcpStream::connect(addr).unwrap();
    let req = format!(
        "GET / HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();

    assert!(response.starts_with("HTTP/1.1 405"));
}

#[tokio::test]
async fn official_mcp_client_initializes_discovers_and_calls_the_live_server() {
    use rmcp::transport::streamable_http_client::{
        StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
    };
    use rmcp::{model::CallToolRequestParams, ServiceExt};

    let (addr, token, _dir) = running_server();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/")).auth_header(token),
    );
    let client = tokio::time::timeout(std::time::Duration::from_secs(10), ().serve(transport))
        .await
        .expect("MCP initialization must finish")
        .expect("official client must complete MCP initialization");
    let tools = client.list_all_tools().await.expect("discover tools");
    let names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    for name in [
        "get_document_state",
        "propose_changes",
        "add_comments",
        "reply_to_comment",
        "create_document",
        "list_documents",
        "permission_request",
    ] {
        assert!(names.contains(&name), "missing discovered tool: {name}");
    }
    let result = client
        .call_tool(
            CallToolRequestParams::new("get_document_state")
                .with_arguments(json!({"doc": "draft.md"}).as_object().unwrap().clone()),
        )
        .await
        .expect("SDK must accept the MCP CallToolResult envelope");
    let wire = serde_json::to_value(result).unwrap();
    let state: Value = serde_json::from_str(
        wire["content"][0]["text"]
            .as_str()
            .expect("text tool content"),
    )
    .unwrap();
    assert_eq!(state["content"], "# Draft\n\nBody.\n");
    assert_eq!(state["protection"], "protected");
    for tool in &tools {
        let schema = Value::Object((*tool.input_schema).clone());
        jsonschema::validator_for(&schema).expect("every discovered schema is standalone");
    }
    async fn invoke(
        client: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
        name: &'static str,
        arguments: Value,
    ) -> Value {
        let result = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .expect("call discovered tool");
        let wire = serde_json::to_value(result).unwrap();
        let value: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            wire["structuredContent"], value,
            "text and structured results agree"
        );
        value
    }
    assert_eq!(
        invoke(&client, "list_documents", json!({})).await["documents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let added = invoke(
        &client,
        "add_comments",
        json!({"doc": "draft.md", "comments": [{"body": "Explain the opening"}]}),
    )
    .await;
    invoke(
        &client,
        "reply_to_comment",
        json!({"comment_id": added["ids"][0]["id"], "body": "Here is why", "kind": "reply"}),
    )
    .await;
    let created = invoke(
        &client,
        "create_document",
        json!({"path": "new.md", "content": "New draft"}),
    )
    .await;
    assert_eq!(created["path"], "new.md");
    let delivered = invoke(&client, "propose_changes", json!({"doc": "draft.md", "revision": state["revision"], "edits": [{"range": {"offset": 0, "length": 0}, "replacement": "Intro. "}], "summary": "Explain"})).await;
    assert_eq!(delivered["applied"].as_array().unwrap().len(), 1);
    assert!(std::fs::read_to_string(_dir.path().join("draft.md"))
        .unwrap()
        .starts_with("{++Intro. ++}"));
    client.cancel().await.unwrap();
}

#[test]
fn initialized_notification_has_no_json_rpc_response() {
    let (addr, token, _dir) = running_server();
    let (status, body) = request(
        addr,
        Some(&token),
        &json!({
            "jsonrpc": "2.0", "method": "notifications/initialized"
        })
        .to_string(),
    );
    assert_eq!(status, 202, "notification HTTP status");
    assert_eq!(body, Value::Null, "notifications have no response body");
}

#[test]
fn initialize_negotiates_version_and_rejects_bad_client_shape() {
    let (addr, token, _dir) = running_server();
    for version in ["2025-03-26", "2025-06-18", "future-version"] {
        let (_, body) = request(addr, Some(&token), &json!({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {
            "protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "client", "version": "1"}
        }}).to_string());
        assert_eq!(body["id"], "init");
        assert_eq!(
            body["result"]["protocolVersion"],
            if version == "future-version" {
                "2025-06-18"
            } else {
                version
            }
        );
        assert_eq!(body["result"]["capabilities"], json!({"tools": {}}));
    }
    let (_, invalid) = request(addr, Some(&token), &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}).to_string());
    assert_eq!(
        invalid["error"]["code"], -32602,
        "incomplete initialize refused"
    );
}

#[test]
fn handshake_requires_the_project_bearer_and_rejects_foreign_origins_and_versions() {
    let (addr, token, _dir) = running_server();
    for method in ["initialize", "tools/list", "notifications/initialized"] {
        let (status, _) = request(
            addr,
            None,
            &json!({"jsonrpc": "2.0", "method": method}).to_string(),
        );
        assert_eq!(status, 401, "lifecycle methods require authorization");
    }
    for (method, header, expected) in [
        ("POST", "Origin: https://hostile.example", 403),
        ("GET", "Origin: https://hostile.example", 403),
        ("POST", "MCP-Protocol-Version: 1900-01-01", 400),
    ] {
        let mut stream = TcpStream::connect(addr).unwrap();
        let req = format!("{method} / HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n{header}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(
            response.starts_with(&format!("HTTP/1.1 {expected}")),
            "transport guard {header}: {response}"
        );
    }
}

#[test]
fn notifications_cannot_execute_tools_and_invalid_rpc_envelopes_are_refused() {
    let (addr, token, dir) = running_server();
    let (status, _) = request(addr, Some(&token), &json!({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "create_document", "arguments": {"path": "silent.md", "content": "bad"}}}).to_string());
    assert_eq!(status, 202);
    assert!(
        !dir.path().join("silent.md").exists(),
        "notification must not execute a tool"
    );
    for value in [
        json!([]),
        json!({"method": "tools/list", "id": 1}),
        json!({"jsonrpc": "2.0", "id": null, "method": "tools/list"}),
    ] {
        let (_, body) = request(addr, Some(&token), &value.to_string());
        assert_eq!(body["error"]["code"], -32600, "invalid envelope rejected");
    }
}

#[test]
fn parameterless_tools_accept_omitted_arguments_and_ping_is_supported() {
    let (addr, token, _dir) = running_server();
    let (_, body) = request(addr, Some(&token), &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_documents"}}).to_string());
    assert_eq!(
        body["result"]["structuredContent"]["documents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let (_, ping) = request(
        addr,
        Some(&token),
        &json!({"jsonrpc": "2.0", "id": "ping", "method": "ping"}).to_string(),
    );
    assert_eq!(ping, json!({"jsonrpc": "2.0", "id": "ping", "result": {}}));
}

#[test]
fn real_mcp_handshake_discovers_and_waits_for_a_provider_permission_callback() {
    use emend_lib::agent::permission::{PermissionBroker, PermissionDecision, PermissionState};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let (tx, rx) = mpsc::channel();
    let broker = Arc::new(PermissionBroker::new(
        ".",
        Some(Arc::new(move |state: &PermissionState| {
            tx.send(state.clone()).unwrap();
        })),
    ));
    broker.begin("run-a");
    let dir = TempDir::new().unwrap();
    let server = LoopbackMcpServer::bind().unwrap();
    let addr = server.local_addr().unwrap();
    let token = server.token().to_owned();
    let ctx = McpContext::new(dir.path(), vec![]).with_permissions(Arc::clone(&broker));
    thread::spawn(move || server.serve(ctx));
    let (_, init) = request(addr, Some(&token), &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"permission-fixture","version":"1"}}}).to_string());
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let (_, discovery) = request(
        addr,
        Some(&token),
        &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string(),
    );
    let definition = discovery["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "permission_request")
        .unwrap();
    assert_eq!(
        definition["inputSchema"]["properties"]["tool_name"]["type"], "string",
        "discovery must publish the actual provider callback schema"
    );
    let wire_token = format!("{token}\r\nX-Cowrite-Run: run-a");
    let worker = thread::spawn(move || {
        call(
            addr,
            Some(&wire_token),
            "permission_request",
            json!({"tool_name":"Bash","input":{"command":"python3 check.py","description":"Verify citations"},"tool_use_id":"tool-a"}),
        )
    });
    let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    // The pending callback must not monopolize MCP: a second real request still gets its reply.
    let (_, ping) = request(
        addr,
        Some(&token),
        &json!({"jsonrpc":"2.0","id":3,"method":"ping"}).to_string(),
    );
    assert!(ping["result"].is_object());
    broker
        .decide(
            "run-a",
            &pending.requests[0].id,
            PermissionDecision::Deny {
                reason: "Read the existing report instead".into(),
            },
        )
        .unwrap();
    let (_, result) = worker.join().unwrap();
    assert!(result["result"].get("structuredContent").is_none(), "Claude permission delegation requires a single JSON text result; structuredContent changes the native parser input");
    let decision: Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        decision,
        json!({"behavior":"deny","message":"Read the existing report instead"})
    );
}

#[test]
fn mcp_cancellation_denies_only_the_bound_pending_callback() {
    use emend_lib::agent::permission::{PermissionBroker, PermissionState};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let (tx, rx) = mpsc::channel();
    let broker = Arc::new(PermissionBroker::new(
        ".",
        Some(Arc::new(move |state: &PermissionState| {
            let _ = tx.send(state.clone());
        })),
    ));
    broker.begin("run-a");
    let dir = TempDir::new().unwrap();
    let server = LoopbackMcpServer::bind().unwrap();
    let addr = server.local_addr().unwrap();
    let token = server.token().to_owned();
    let ctx = McpContext::new(dir.path(), vec![]).with_permissions(Arc::clone(&broker));
    thread::spawn(move || server.serve(ctx));
    let wire_token = format!("{token}\r\nX-Cowrite-Run: run-a");
    let callback_token = wire_token.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        done_tx.send(call(addr, Some(&callback_token), "permission_request", json!({"tool_name":"Bash","input":{"command":"python3 check.py"},"tool_use_id":"tool-a"}))).unwrap();
    });
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let cancellation = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"Provider cancelled"}}).to_string();
    let stale_token = format!("{token}\r\nX-Cowrite-Run: previous-run");
    request(addr, Some(&stale_token), &cancellation);
    assert!(
        matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "a previous run cannot cancel this run's request"
    );
    assert_eq!(request(addr, Some(&wire_token), &cancellation).0, 202);
    let (_, response) = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("MCP cancellation must release its pending callback as deny");
    worker.join().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(response["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["behavior"],
        "deny",
        "cancellation must not grant permission"
    );
    assert!(broker.state().requests.is_empty());
    assert_eq!(
        broker.state().run_id.as_deref(),
        Some("run-a"),
        "cancelling one tool call must not end the run"
    );
}

#[test]
fn project_mcp_script_grants_reuse_changed_arguments_and_revoke_on_content_controls_and_run() {
    use emend_lib::agent::mcp::ProjectMcpServer;
    use emend_lib::agent::permission::{PermissionDecision, PermissionState};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let dir = TempDir::new().unwrap();
    let script = dir.path().join("citations.py");
    std::fs::write(&script, "print('citations')\n").unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let broker = server.permissions();
    let (tx, rx) = mpsc::channel();
    broker.set_observer(Some(Arc::new(move |state: &PermissionState| {
        if !state.requests.is_empty() {
            let _ = tx.send(state.clone());
        }
    })));
    broker.begin("script-run");
    let addr = server.local_addr();
    let token = server.mcp_server().token;
    let (_, initialized) = request(addr, Some(&token), &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"script-fixture","version":"1"}}}).to_string());
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
    let (_, discovered) = request(
        addr,
        Some(&token),
        &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string(),
    );
    assert!(discovered["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "permission_request"));
    let invoke = |run: &str, input: Value| {
        let wire_token = format!("{token}\r\nX-Cowrite-Run: {run}");
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (_, result) = call(
                addr,
                Some(&wire_token),
                "permission_request",
                json!({"tool_name":"Bash","input":input}),
            );
            let result: Value =
                serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            let _ = tx.send(result);
        });
        (worker, rx)
    };
    let input = |arg: &str| json!({"command":format!("python3 '{}' {arg}", script.to_string_lossy().replace('\\', "/")),"description":"Verify citations"});
    let (worker, done) = invoke("script-run", input("--chapter 1"));
    let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        pending.requests[0].allow_script,
        "production project root must make an absolute contained script eligible"
    );
    broker
        .decide(
            "script-run",
            &pending.requests[0].id,
            PermissionDecision::AllowScript,
        )
        .unwrap();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(2)).unwrap()["behavior"],
        "allow"
    );
    worker.join().unwrap();
    let changed_args = input("--chapter 2");
    let (worker, done) = invoke("script-run", changed_args.clone());
    let reused = done.recv_timeout(Duration::from_secs(2));
    if reused.is_err() {
        broker.end("script-run");
    }
    worker.join().unwrap();
    assert_eq!(
        reused.expect("changed script arguments must reuse the run-local grant"),
        json!({"behavior":"allow","updatedInput":changed_args})
    );
    assert!(
        broker.state().requests.is_empty(),
        "script reuse must not create another card"
    );
    let mut controls = input("--chapter 3");
    controls["dangerouslyDisableSandbox"] = json!(true);
    let (worker, done) = invoke("script-run", controls);
    let pending = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("changed script execution controls must prompt again");
    broker
        .decide(
            "script-run",
            &pending.requests[0].id,
            PermissionDecision::Deny {
                reason: "Keep the sandbox".into(),
            },
        )
        .unwrap();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(2)).unwrap()["behavior"],
        "deny"
    );
    worker.join().unwrap();
    std::fs::write(&script, "print('changed')\n").unwrap();
    let (worker, done) = invoke("script-run", input("--chapter 4"));
    let pending = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("changed script contents must prompt again");
    broker
        .decide(
            "script-run",
            &pending.requests[0].id,
            PermissionDecision::AllowScript,
        )
        .unwrap();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(2)).unwrap()["behavior"],
        "allow"
    );
    worker.join().unwrap();
    broker.end("script-run");
    broker.begin("next-run");
    let (worker, done) = invoke("next-run", input("--chapter 5"));
    rx.recv_timeout(Duration::from_secs(2))
        .expect("a new run must not inherit a script grant");
    broker.end("next-run");
    assert_eq!(
        done.recv_timeout(Duration::from_secs(2)).unwrap()["behavior"],
        "deny"
    );
    worker.join().unwrap();
}

#[test]
fn script_changed_while_waiting_cannot_be_approved_from_stale_display() {
    use emend_lib::agent::mcp::ProjectMcpServer;
    use emend_lib::agent::permission::{PermissionDecision, PermissionState};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let dir = TempDir::new().unwrap();
    let script = dir.path().join("check.py");
    std::fs::write(&script, "print('original')\n").unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let broker = server.permissions();
    let (tx, rx) = mpsc::channel();
    broker.set_observer(Some(Arc::new(move |state: &PermissionState| {
        if !state.requests.is_empty() {
            let _ = tx.send(state.clone());
        }
    })));
    broker.begin("run");
    let addr = server.local_addr();
    let wire_token = format!("{}\r\nX-Cowrite-Run: run", server.mcp_server().token);
    let worker = thread::spawn(move || {
        call(
            addr,
            Some(&wire_token),
            "permission_request",
            json!({"tool_name":"Bash","input":{"command":format!("python3 '{}'",script.to_string_lossy().replace('\\', "/"))}}),
        )
    });
    let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        pending.requests[0].allow_script,
        "the displayed script must be eligible before its contents change"
    );
    std::fs::write(dir.path().join("check.py"), "print('changed')\n").unwrap();
    assert!(
        broker
            .decide(
                "run",
                &pending.requests[0].id,
                PermissionDecision::AllowScript
            )
            .is_err(),
        "a stale displayed script identity must not authorize changed contents"
    );
    assert_eq!(broker.state().requests.len(), 1);
    broker.end("run");
    worker.join().unwrap();
}
