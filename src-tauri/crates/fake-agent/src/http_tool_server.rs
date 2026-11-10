// ABOUTME: The fake agent's real-transport tool server — initializes and discovers MCP tools over loopback
// ABOUTME: HTTP to whatever `--mcp-config` Emend injected, so a spawned run's MCP wiring (#472)
// ABOUTME: can be proven end-to-end instead of stubbed in-process.

//! [`StubToolServer`](crate::StubToolServer) answers MCP calls in-process — deterministic, zero
//! network, and the right default for every scenario that is exercising *playback*.
//!
//! This is the other half: when the fake agent is spawned the way Emend spawns a real CLI, it is
//! handed `--mcp-config` — one `http` server with a URL and an `Authorization: Bearer <token>`
//! header (TD-1 §3.5, `agent::claude::mcp_config`). [`HttpToolServer`] is what consumes it, so a
//! test can assert that the address and token Emend injected genuinely reach Emend's own tool
//! surface, with the bearer check genuinely in the path.
//!
//! Deliberately hand-rolled HTTP (no new dependencies), matching this workspace's existing
//! loopback-server precedent (`emend_lib::agent::mcp`, `test-driver`): one request per
//! connection, `Connection: close`, no keep-alive.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

use crate::tool_server::{ToolError, ToolServer};

/// Bounds every blocking read/write against the server, mirroring the server side's own
/// `STREAM_TIMEOUT` (`emend_lib::agent::mcp`). A wedged server must fail this call — and so the
/// test driving it — rather than hang the suite forever (test-plan §4: no unbounded waits).
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);

/// The name Emend registers its server under inside `mcpServers` (`agent::claude`'s
/// `MCP_SERVER_NAME`) — the entry this reads its connection info from.
const MCP_SERVER_KEY: &str = "emend";

/// A [`ToolServer`] that forwards every call over real loopback HTTP to the MCP server named in a
/// `--mcp-config` payload, carrying that payload's `Authorization` header.
#[derive(Clone)]
pub struct HttpToolServer {
    /// `host:port` parsed out of the config's `url` — what [`TcpStream::connect`] dials.
    authority: String,
    /// The request path from the config's `url` (Emend's server has one endpoint, `/`).
    path: String,
    /// The `Authorization` header value to present, verbatim.
    authorization: Option<String>,
    run_id: Option<String>,
    tools: Option<Vec<String>>,
    protocol_version: Option<String>,
    next_id: u64,
}

impl std::fmt::Debug for HttpToolServer {
    /// Hand-written so an accidental `{:?}` cannot print the bearer token — the same
    /// token-leakage discipline `emend_lib::agent::claude::McpServer` keeps on the other side.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpToolServer")
            .field("authority", &self.authority)
            .field("path", &self.path)
            .field("authorization", &"<redacted>")
            .finish()
    }
}

impl HttpToolServer {
    /// Reads the `emend` entry out of a `--mcp-config` payload (the published `McpServerConfig`
    /// shape). Returns the reason as a plain string when the payload has no usable entry — the
    /// binary reports it and exits non-zero rather than silently falling back to the stub, which
    /// would make a broken injection look like a passing test.
    pub fn from_mcp_config(config: &Value) -> Result<HttpToolServer, String> {
        let server = config
            .get("mcpServers")
            .and_then(|s| s.get(MCP_SERVER_KEY))
            .ok_or_else(|| format!("--mcp-config has no `mcpServers.{MCP_SERVER_KEY}` entry"))?;

        let url = server
            .get("url")
            .and_then(Value::as_str)
            .ok_or("--mcp-config entry has no `url`")?;
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| format!("--mcp-config `url` is not http://: {url}"))?;
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority.to_string(), format!("/{path}")),
            None => (rest.to_string(), "/".to_string()),
        };

        let authorization = server
            .get("headers")
            .and_then(|h| h.get("Authorization"))
            .and_then(Value::as_str)
            .map(str::to_string);

        Ok(HttpToolServer {
            authority,
            path,
            authorization,
            run_id: server
                .get("headers")
                .and_then(|h| h.get("X-Emend-Run"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            tools: None,
            protocol_version: None,
            next_id: 1,
        })
    }
}

impl HttpToolServer {
    /// Complete the provider lifecycle before playback, even when a scenario never calls a tool.
    /// A failed handshake or discovery is an error, never an in-process stub fallback.
    pub fn initialize(&mut self) -> Result<(), ToolError> {
        if self.tools.is_some() {
            return Ok(());
        }
        let result = self.rpc(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "emend-fake-agent", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        let version = result["protocolVersion"]
            .as_str()
            .filter(|v| ["2025-03-26", "2025-06-18"].contains(v))
            .ok_or_else(|| ToolError::Failed("initialize: unsupported protocol version".into()))?;
        if !result["capabilities"]["tools"].is_object() {
            return Err(ToolError::Failed(
                "initialize: missing tools capability".into(),
            ));
        }
        self.protocol_version = Some(version.to_string());
        let response =
            self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;
        if response.is_some() {
            return Err(ToolError::Failed(
                "initialized notification must have an empty 202 response".into(),
            ));
        }
        let mut tools = Vec::new();
        let mut cursor = None;
        loop {
            let params = cursor
                .as_ref()
                .map(|c| json!({"cursor": c}))
                .unwrap_or_else(|| json!({}));
            let listed = self.rpc("tools/list", params)?;
            for tool in listed["tools"]
                .as_array()
                .ok_or_else(|| ToolError::Failed("tools/list: missing tools".into()))?
            {
                let name = tool["name"]
                    .as_str()
                    .ok_or_else(|| ToolError::Failed("tools/list: missing tool name".into()))?;
                if tool["inputSchema"]["type"] != "object" {
                    return Err(ToolError::Failed(format!(
                        "tools/list: {name} has no object input schema"
                    )));
                }
                tools.push(name.to_string());
            }
            let next = listed["nextCursor"].as_str().map(str::to_string);
            if next.is_none() {
                break;
            }
            if next == cursor {
                return Err(ToolError::Failed("tools/list: repeated cursor".into()));
            }
            cursor = next;
        }
        self.tools = Some(tools);
        Ok(())
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        let id = self.next_id;
        self.next_id += 1;
        let body = self
            .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?
            .ok_or_else(|| ToolError::Failed(format!("{method}: missing JSON-RPC response")))?;
        if body["jsonrpc"] != "2.0" || body["id"] != id {
            return Err(ToolError::Failed(format!(
                "{method}: invalid JSON-RPC response identity"
            )));
        }
        if let Some(error) = body.get("error") {
            return Err(ToolError::Failed(format!(
                "{method}: {}",
                error["message"].as_str().unwrap_or("unknown error")
            )));
        }
        body.get("result")
            .cloned()
            .ok_or_else(|| ToolError::Failed(format!("{method}: missing result")))
    }

    fn send(&self, message: &Value) -> Result<Option<Value>, ToolError> {
        let payload = message.to_string();
        let auth = self
            .authorization
            .as_ref()
            .map(|value| format!("Authorization: {value}\r\n"))
            .unwrap_or_default();
        let version = self
            .protocol_version
            .as_ref()
            .map(|value| format!("MCP-Protocol-Version: {value}\r\n"))
            .unwrap_or_default();
        let run = self
            .run_id
            .as_ref()
            .map(|id| format!("X-Emend-Run: {id}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\n{auth}{version}{run}Content-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            self.path, self.authority, payload.len()
        );
        let mut stream = TcpStream::connect(&self.authority)
            .map_err(|e| ToolError::Failed(format!("connecting to {}: {e}", self.authority)))?;
        let permission_wait =
            message["method"] == "tools/call" && message["params"]["name"] == "permission_request";
        let _ = stream.set_read_timeout(if permission_wait {
            None
        } else {
            Some(STREAM_TIMEOUT)
        });
        let _ = stream.set_write_timeout(Some(STREAM_TIMEOUT));
        stream
            .write_all(request.as_bytes())
            .map_err(|e| ToolError::Failed(format!("sending MCP message: {e}")))?;
        let (status, response) = read_response(&stream)
            .map_err(|e| ToolError::Failed(format!("reading MCP response: {e}")))?;
        if status == 202 && response.is_empty() {
            return Ok(None);
        }
        if status != 200 {
            return Err(ToolError::Failed(format!("MCP HTTP status {status}")));
        }
        serde_json::from_str(&response)
            .map(Some)
            .map_err(|e| ToolError::Failed(format!("MCP response is not JSON: {e}")))
    }
}

impl ToolServer for HttpToolServer {
    fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ToolError> {
        self.initialize()?;
        if !self
            .tools
            .as_ref()
            .expect("initialized tools")
            .iter()
            .any(|tool| tool == name)
        {
            return Err(ToolError::UnknownTool(name.to_string()));
        }
        let result = self.rpc("tools/call", json!({"name": name, "arguments": arguments}))?;
        let content = result["content"]
            .as_array()
            .ok_or_else(|| ToolError::Failed("tools/call: missing MCP content".into()))?;
        let text = content
            .first()
            .filter(|c| c["type"] == "text")
            .and_then(|c| c["text"].as_str())
            .ok_or_else(|| ToolError::Failed("tools/call: missing text result".into()))?;
        if result["isError"] == true {
            return Err(ToolError::Failed(text.to_string()));
        }
        serde_json::from_str(text)
            .map_err(|e| ToolError::Failed(format!("tool content is not JSON: {e}")))
    }
}

/// Reads one HTTP response and returns its body. `Content-Length` is honored when present;
/// otherwise the body runs to end-of-stream (`Connection: close`).
///
/// Borrows the stream rather than `try_clone`-ing it, for the reason spelled out on
/// `agent::mcp::read_request`: the Windows duplicate-handle inheritance race.
fn read_response(stream: &TcpStream) -> std::io::Result<(u16, String)> {
    let mut reader = BufReader::new(stream);

    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "missing HTTP status")
        })?;

    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().ok();
        }
    }

    let mut body = String::new();
    match content_length {
        Some(len) => {
            let mut buf = vec![0u8; len];
            reader.read_exact(&mut buf)?;
            body.push_str(&String::from_utf8_lossy(&buf));
        }
        None => {
            reader.read_to_string(&mut body)?;
        }
    }
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exactly what `emend_lib::agent::claude::mcp_config` emits.
    fn config(url: &str) -> Value {
        json!({
            "mcpServers": {
                "emend": {
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": "Bearer tok-123" }
                }
            }
        })
    }

    #[test]
    fn a_tools_call_only_server_is_refused_before_any_tool_dispatch() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            let body = if request["method"] == "initialize" {
                json!({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "method not found: initialize"}})
            } else {
                json!({"jsonrpc": "2.0", "id": request["id"], "result": {"content": [{"type": "text", "text": "{}"}]}})
            }.to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        let mut server =
            HttpToolServer::from_mcp_config(&config(&format!("http://{addr}/"))).unwrap();
        let result = server.call("list_documents", &json!({}));
        thread.join().unwrap();
        assert!(
            matches!(result, Err(ToolError::Failed(ref reason)) if reason.contains("method not found: initialize")),
            "handshake failure must prevent tool dispatch: {result:?}"
        );
    }

    #[test]
    fn reads_the_authority_path_and_bearer_header_out_of_an_injected_config() {
        let server = HttpToolServer::from_mcp_config(&config("http://127.0.0.1:54321/")).unwrap();
        assert_eq!(server.authority, "127.0.0.1:54321");
        assert_eq!(server.path, "/");
        assert_eq!(server.authorization.as_deref(), Some("Bearer tok-123"));
    }

    #[test]
    fn a_config_without_an_emend_entry_is_an_error_not_a_silent_stub_fallback() {
        let err = HttpToolServer::from_mcp_config(&json!({ "mcpServers": {} })).unwrap_err();
        assert!(err.contains("mcpServers.emend"));
    }

    #[test]
    fn a_non_http_url_is_an_error() {
        assert!(HttpToolServer::from_mcp_config(&config("stdio://whatever")).is_err());
    }

    #[test]
    fn debug_formatting_never_prints_the_bearer_token() {
        let server = HttpToolServer::from_mcp_config(&config("http://127.0.0.1:54321/")).unwrap();
        assert!(!format!("{server:?}").contains("tok-123"));
    }

    #[test]
    fn an_unreachable_server_fails_the_call_rather_than_hanging_or_panicking() {
        // Port 1 on loopback: nothing is listening, so `connect` is refused immediately.
        let mut server = HttpToolServer::from_mcp_config(&config("http://127.0.0.1:1/")).unwrap();
        let err = server.call("list_documents", &json!({})).unwrap_err();
        assert!(matches!(err, ToolError::Failed(_)));
    }
}
