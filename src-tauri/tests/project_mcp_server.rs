// ABOUTME: Integration tests for binding the TD-1 MCP server on project open (#413, split of #344,
// ABOUTME: TD-1/§3.5) — `agent::mcp::ProjectMcpServer` ties a loopback+bearer server's lifetime to
// ABOUTME: the project session and hands its connection info to the CLI-spawn adapter (agent::claude).

use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::json;
use tempfile::TempDir;

use emend_lib::agent::claude::{self, McpServer};
use emend_lib::agent::mcp::ProjectMcpServer;

mod common;
use common::mcp_call;

/// Written first (issue #413 acceptance): a call presenting a wrong or absent token is rejected —
/// before any tool runs — on a server bound the way a real project open binds one.
#[test]
fn a_wrong_or_absent_token_is_rejected_on_a_freshly_opened_project() {
    let dir = TempDir::new().unwrap();
    let server = ProjectMcpServer::open(dir.path()).expect("bind the project's MCP server");

    let (status, body) = mcp_call(
        server.local_addr(),
        Some("not-the-real-token"),
        "list_documents",
        json!({}),
    );
    assert_eq!(status, 401);
    assert_eq!(body["error"]["message"], "unauthorized");

    let (status, _) = mcp_call(server.local_addr(), None, "list_documents", json!({}));
    assert_eq!(status, 401);
}

#[test]
fn open_binds_loopback_only_with_a_fresh_high_entropy_token_per_project() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let a = ProjectMcpServer::open(dir_a.path()).unwrap();
    let b = ProjectMcpServer::open(dir_b.path()).unwrap();

    assert!(a.local_addr().ip().is_loopback());
    assert_ne!(a.local_addr().port(), 0);
    // Two independently opened projects never share a bearer token (§3.5 per-session secrecy).
    assert_ne!(a.mcp_server().token, b.mcp_server().token);
}

#[test]
fn a_correctly_authorized_call_reaches_the_real_tool_surface() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("draft.md"), "hello\n").unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let token = server.mcp_server().token;

    let (status, body) = mcp_call(
        server.local_addr(),
        Some(&token),
        "get_document_state",
        json!({ "doc": "draft.md" }),
    );

    assert_eq!(status, 200);
    assert_eq!(body["result"]["structuredContent"]["content"], "hello\n");
}

/// TD-1: "the connection config is injected into the spawned CLI's environment/config so no user
/// setup is required" — the binding's `mcp_server()` is exactly the value the sibling run-commands
/// unit will pass into `agent::claude::SpawnRequest`; prove it round-trips through the adapter's
/// own `--mcp-config` builder untouched.
#[test]
fn mcp_server_feeds_the_claude_adapters_mcp_config_injection_unchanged() {
    let dir = TempDir::new().unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();

    let McpServer { addr, token, .. } = server.mcp_server();
    assert_eq!(addr, server.local_addr());

    let config = claude::mcp_config(&server.mcp_server());
    assert_eq!(
        config["mcpServers"]["cowrite"]["url"],
        format!("http://{addr}/")
    );
    assert_eq!(
        config["mcpServers"]["cowrite"]["headers"]["Authorization"],
        format!("Bearer {token}")
    );
    assert!(provider_contract::is_valid(
        provider_contract::Schema::McpServerConfig,
        &config
    ));
}

/// Issue #413 acceptance: "closing the project unbinds it and the token does not outlive it."
#[test]
fn closing_the_project_unbinds_the_server_and_the_old_address_stops_accepting() {
    let dir = TempDir::new().unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let addr = server.local_addr();

    drop(server); // "closing the project" — Drop stops serving and closes the bound socket.

    // Nothing is listening at `addr` anymore; a fresh connection attempt is refused, not merely
    // unauthorized. Retried briefly: the accept loop's teardown is synchronous in `Drop` (joined),
    // but leave a small margin for the OS to actually release the port.
    let mut refused = false;
    for _ in 0..20 {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(50)) {
            Err(_) => {
                refused = true;
                break;
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    assert!(
        refused,
        "the old address must stop accepting once the project closes"
    );
}

/// Token-leakage sweep (test-plan §3): even a raw `{:?}` on the binding — or on the
/// `agent::claude::McpServer` it hands back to the CLI-spawn adapter (issue #413 review,
/// Important #3) — must never print the secret. Belt-and-braces against an accidental future
/// debug-log call anywhere along that path.
#[test]
fn debug_formatting_never_prints_the_bearer_token() {
    let dir = TempDir::new().unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let token = server.mcp_server().token;

    let debugged = format!("{server:?}");
    assert!(
        !debugged.contains(&token),
        "the bearer token leaked into ProjectMcpServer's Debug output"
    );

    let returned = format!("{:?}", server.mcp_server());
    assert!(
        !returned.contains(&token),
        "the bearer token leaked into the returned McpServer's Debug output"
    );
}

/// Issue #413 review, Important #2: a connection opened but never completing its request must
/// not hang project close forever. No token is needed to trigger the stall — it happens in
/// `read_request`, which runs before authorization. Reproduces by holding a connection open
/// while dropping the server on a background thread, bounding the wait for that drop to return
/// (the same "bound a possibly-hanging operation" pattern `tests/agent_session.rs` uses).
#[test]
fn a_stalled_connection_does_not_hang_project_close() {
    let dir = TempDir::new().unwrap();
    let server = ProjectMcpServer::open(dir.path()).unwrap();
    let addr = server.local_addr();

    // Held for the test's duration so the connection stays open without ever sending a
    // complete request.
    let _stalled = TcpStream::connect(addr).expect("open a connection that will stall");

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        drop(server); // must not block this thread forever
        let _ = tx.send(());
    });

    rx.recv_timeout(Duration::from_secs(10)).expect(
        "closing the project must not hang on a connection that never finishes its request",
    );
}
