// ABOUTME: Shared helpers for the integration-test suites — locating the compiled `fake-agent`
// ABOUTME: binary (the spawnable stand-in for a real provider CLI), minting per-test workdirs, and
// ABOUTME: initializing, discovering, and calling a bound MCP server over real loopback HTTP.

// Cargo compiles this module separately into each integration-test binary that declares
// `mod common`, so any helper a given suite doesn't call is "dead" from that binary's point of
// view. Allowed once here rather than per item.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::{json, Value};

/// The compiled `fake-agent` binary's path, standing in for `claude` in these tests
/// (`agent::session::spawn` only cares about "a program that speaks stream-JSON on stdout",
/// never about the real CLI's own flags).
///
/// `CARGO_BIN_EXE_<name>` only resolves for binaries of the *same* package (fake-agent's own
/// `tests/` use it directly) — emend is a different package, so it is built on demand here and
/// located via the workspace's shared `target/` dir (every member's binaries land alongside this
/// test binary's own).
pub fn fake_agent_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut build = Command::new(env!("CARGO"));
        build.args(["build", "--package", "fake-agent", "--bin", "fake-agent"]);
        if !cfg!(debug_assertions) {
            build.arg("--release");
        }
        let status = build
            .current_dir(&manifest_dir)
            .status()
            .expect("run cargo build for fake-agent");
        assert!(status.success(), "failed to build the fake-agent binary");

        let exe = std::env::current_exe().expect("this test binary's own path");
        let mut dir = exe
            .parent()
            .expect("test binary has a parent dir")
            .to_path_buf();
        if dir.ends_with("deps") {
            dir.pop();
        }
        let name = if cfg!(windows) {
            "fake-agent.exe"
        } else {
            "fake-agent"
        };
        dir.join(name)
    })
    .as_path()
}

/// Path to a shipped fake-agent scenario (the fake-agent crate's own fixture corpus,
/// `crates/fake-agent/scenarios/`).
pub fn fake_agent_scenario(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("crates/fake-agent/scenarios")
        .join(name)
}

/// A fresh, empty working directory unique to `test` (under Cargo's per-target tmp dir).
pub fn workdir(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(test);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workdir");
    dir
}

/// Initializes and discovers the bound MCP server, then sends one JSON-RPC `tools/call` and
/// returns `(http_status, parsed_body)`. `token` is `None` to send no `Authorization` header at all
/// — the unauthorized case `agent::mcp` refuses with 401 before any tool runs.
///
/// Hand-rolled to match the server's own hand-rolled transport (this workspace carries no HTTP
/// client dependency, the precedent `agent::mcp` and `crates/test-driver` already set). Extracted
/// here because four integration suites had each grown their own near-identical copy — one of which
/// said so in a comment (CLAUDE.md: never copy-paste, Rule of Three).
pub fn mcp_call(
    addr: SocketAddr,
    token: Option<&str>,
    name: &str,
    arguments: Value,
) -> (u16, Value) {
    if let Some(token) = token {
        let (status, _) = mcp_request(
            addr,
            Some(token),
            json!({
                "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": { "name": "emend-integration-test", "version": "1" }
                }
            }),
        );
        if status == 200 {
            assert_eq!(
                mcp_request(
                    addr,
                    Some(token),
                    json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
                )
                .0,
                202
            );
            let (_, listed) = mcp_request(
                addr,
                Some(token),
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            );
            assert!(
                listed["result"]["tools"].is_array(),
                "tool discovery must succeed"
            );
        }
    }
    mcp_request(
        addr,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }),
    )
}

fn mcp_request(addr: SocketAddr, token: Option<&str>, payload: Value) -> (u16, Value) {
    let payload = payload.to_string();
    let auth = match token {
        Some(t) => format!("Authorization: Bearer {t}\r\n"),
        None => String::new(),
    };
    let request = format!(
        "POST / HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );

    let mut stream = TcpStream::connect(addr).expect("connect to the MCP server");
    stream.write_all(request.as_bytes()).expect("send request");

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
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

/// [`mcp_call`] for the authorized happy path: asserts the transport succeeded (HTTP 200) and hands
/// back just the JSON-RPC body, which is all a caller driving a tool for its *effect* cares about.
pub fn mcp_call_ok(addr: SocketAddr, token: &str, name: &str, arguments: Value) -> Value {
    let (status, body) = mcp_call(addr, Some(token), name, arguments);
    assert_eq!(
        status, 200,
        "tool call was refused at the transport: {body}"
    );
    body
}

/// Whether `addr` has stopped accepting connections — how an unbound MCP server is asserted.
/// Retried briefly: a listener closing and the OS releasing its port are not the same instant.
pub fn still_refuses(addr: SocketAddr) -> bool {
    for _ in 0..20 {
        match TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(50)) {
            Err(_) => return true,
            Ok(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
    false
}
