// ABOUTME: The Emend-hosted MCP server (TD-1) — binds loopback only with a per-session bearer token
// ABOUTME: (§3.5), speaks the MCP lifecycle and tool protocol, dispatches the §3.2 tools over an `McpContext`,
// ABOUTME: and (`ProjectMcpServer`) ties that binding's whole lifetime to one open project (#413).

//! The transport half of the TD-1 contract: a loopback-only HTTP surface that answers JSON-RPC
//! `tools/call` requests for the §3.2 tools implemented in [`super::state`].
//!
//! # Security model (§3.5)
//!
//! - **Loopback bind.** The listener binds `127.0.0.1:0` (an OS-assigned ephemeral port) — never a
//!   routable interface. Nothing off-host can reach it.
//! - **Per-session bearer token.** [`LoopbackMcpServer::bind`] mints a fresh high-entropy token;
//!   [`ProjectMcpServer`] hands it to `agent::claude`'s `--mcp-config` builder so a spawned CLI is
//!   auto-wired in — no manual user configuration step. Every request must carry `Authorization:
//!   Bearer <token>`; a missing or mismatched token is refused with `401` before any tool runs. The
//!   compare is constant-time.
//!
//! # Contract shape
//!
//! One stateless Streamable HTTP endpoint (`POST /`), JSON-RPC 2.0 framing. Initialization
//! negotiates the protocol and tool capability; notifications receive empty HTTP 202 responses.
//! GET returns 405 (the protocol's explicit opt-out from an optional standalone SSE stream).
//! Tool discovery derives input schemas from the same published `McpToolCall` contract used to
//! validate dispatch. Tool values travel in MCP text content and `structuredContent`.
//!
//! # Project-open binding
//!
//! [`LoopbackMcpServer`] is the raw bind/serve primitive; [`ProjectMcpServer`] is the lifecycle
//! wrapper a project's open/close ties to (issue #413, split of #344) — bind + serve-in-background
//! on open, stop-and-close-the-socket on drop (project close), so the token never outlives the
//! session it was minted for.
//!
//! *Who* owns that lifetime is [`super::project::OpenProject`] (TD-17, #472): one aggregate per
//! open project holding this server, the D21 watchdog, and the single protected set they share.
//! `commands::project::{open_project, close_project}` drive it; a run reads the bound server out of
//! it (`commands::agent::spawn_claude_run`) rather than binding one of its own.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use provider_contract::Schema;
use serde_json::{json, Value};
use uuid::Uuid;

use super::birth::DocumentBirthObserver;
use super::claude;
use super::delivery::{DeliveryObserver, DeliveryOutcomeObserver};
use super::state::{McpContext, ToolError};
use super::watchdog::{ProtectedSet, SharedProtectedSet};

/// A bound, not-yet-serving loopback MCP server. Holds the listener and this session's bearer
/// token; [`serve`](LoopbackMcpServer::serve) consumes it to run the accept loop.
pub struct LoopbackMcpServer {
    listener: TcpListener,
    token: String,
}

impl LoopbackMcpServer {
    /// Binds `127.0.0.1` on an OS-assigned ephemeral port and mints this session's bearer token.
    /// Binding is separate from serving so the caller can read [`local_addr`](Self::local_addr) and
    /// [`token`](Self::token) — to wire into a spawned CLI's config — before the accept loop starts.
    pub fn bind() -> io::Result<LoopbackMcpServer> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        Ok(LoopbackMcpServer {
            listener,
            token: mint_token(),
        })
    }

    /// The loopback address the server is bound to (its `127.0.0.1:<port>`).
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// This session's bearer token — the app injects it into the spawned CLI's MCP config so only
    /// children Emend spawned can call the tools (§3.5).
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Serves requests against `ctx` forever (one request per connection, `Connection: close` — a
    /// local IPC channel, not a high-throughput server; TD-1 "one call per change-set, not chatty").
    pub fn serve(self, ctx: McpContext) {
        self.serve_until(ctx, &AtomicBool::new(false));
    }

    fn serve_until(self, ctx: McpContext, stop: &AtomicBool) {
        if self.listener.set_nonblocking(true).is_err() {
            return;
        }
        // A pending permission must leave room for discovery, reads, and other queued callbacks.
        // Scoped workers are joined at shutdown; socket timeouts still bound incomplete requests.
        let active = std::sync::atomic::AtomicUsize::new(0);
        thread::scope(|scope| {
            while !stop.load(Ordering::Relaxed) {
                match self.listener.accept() {
                    Ok((stream, _)) => {
                        if active.load(Ordering::Acquire) >= 32 {
                            drop(stream);
                            continue;
                        }
                        let _ = stream.set_nonblocking(false);
                        active.fetch_add(1, Ordering::AcqRel);
                        let active = &active;
                        let ctx = &ctx;
                        let token = &self.token;
                        scope.spawn(move || {
                            handle(stream, token, ctx);
                            active.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            }
            ctx.close_permissions();
        });
    }
}

/// A [`LoopbackMcpServer`] bound and served for the lifetime of one open project (TD-1, §3.5;
/// issue #413, split of #344 — "bind the MCP server on project open"). Binding happens eagerly in
/// [`open`](Self::open); serving runs on a background thread until this value is dropped, which is
/// also when the project closes: `Drop` stops the accept loop and joins the thread, so the bound
/// socket is closed and the per-session token stops being honored by anything before `open`
/// returns to a caller that then reopens the project (or the process exits) — "closing the project
/// unbinds it and the token does not outlive it."
///
/// [`mcp_server`](Self::mcp_server) is the one sanctioned way this binding's connection info (the
/// loopback address plus the bearer token) leaves this type — it hands back
/// `agent::claude::McpServer`, the value the CLI-spawn adapter injects into a spawned CLI's own
/// `--mcp-config` (FR-X-2: backend-to-backend only, never returned to the frontend). Both this
/// type's `Debug` (below) and `agent::claude::McpServer`'s own `Debug` are implemented by hand to
/// redact the token, so an accidental `{:?}` on either this binding or the value it returns —
/// including a `SpawnRequest` built from that value — never prints it (issue #413 review,
/// Important #3; previously only this type's `Debug` was hand-written).
pub struct ProjectMcpServer {
    addr: SocketAddr,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    protected: SharedProtectedSet,
    permissions: Arc<super::permission::PermissionBroker>,
}

impl ProjectMcpServer {
    /// Binds a fresh loopback MCP server for the project at `root` and starts serving it on a
    /// background thread, with its own private, freshly empty protected set. Use
    /// [`open_with_protection`](Self::open_with_protection) instead when a `Watchdog` (or any other
    /// live tab/run feed, issue #414) needs to share this server's protected set rather than have
    /// it start and stay empty.
    pub fn open(root: impl Into<PathBuf>) -> io::Result<ProjectMcpServer> {
        ProjectMcpServer::open_with_protection(root, Arc::new(Mutex::new(ProtectedSet::new())))
    }

    /// Like [`open`](Self::open), but serving [`McpContext::with_shared_protection`] over
    /// `protected` — typically the exact [`SharedProtectedSet`] a `Watchdog`
    /// (`agent::watchdog::Watchdog::protected_set`) is mutating from the live open-tab set and the
    /// active run's operation targets (issue #414). Because it's the same shared set, a tab opened
    /// or a run begun *after* this server is already serving is reported "protected" at the tool
    /// boundary immediately — no rebind, no restart.
    pub fn open_with_protection(
        root: impl Into<PathBuf>,
        protected: SharedProtectedSet,
    ) -> io::Result<ProjectMcpServer> {
        ProjectMcpServer::open_with(root, protected, None, None, None)
    }

    /// [`open`](Self::open), plus a [`DeliveryObserver`] every landed `propose_changes` on this
    /// project's server is announced to (#346 — the J1 Phase B pipe). This is how a delivery
    /// reaches the app at all: the MCP server runs on its own thread with no route back to the
    /// frontend otherwise, so the caller that owns the project binding supplies the observer that
    /// carries each notice onward. Starts with its own private, freshly empty protected set — like
    /// [`open`](Self::open), not [`open_with_protection`](Self::open_with_protection); nothing
    /// today needs both a shared protected set and an observer on the same binding.
    pub fn open_observing(
        root: impl Into<PathBuf>,
        observer: Arc<dyn DeliveryObserver>,
    ) -> io::Result<ProjectMcpServer> {
        ProjectMcpServer::open_with(
            root,
            Arc::new(Mutex::new(ProtectedSet::new())),
            Some(observer),
            None,
            None,
        )
    }

    /// [`open`](Self::open), plus a [`DocumentBirthObserver`] every landed `create_document` on
    /// this project's server is announced to (#420 — the J2 birth pipe, the sibling of
    /// [`open_observing`](Self::open_observing) for `propose_changes`). Same reasoning: the MCP
    /// server runs on its own thread with no route back to the frontend otherwise.
    pub fn open_observing_births(
        root: impl Into<PathBuf>,
        observer: Arc<dyn DocumentBirthObserver>,
    ) -> io::Result<ProjectMcpServer> {
        ProjectMcpServer::open_with(
            root,
            Arc::new(Mutex::new(ProtectedSet::new())),
            None,
            Some(observer),
            None,
        )
    }

    /// [`open_with_protection`](Self::open_with_protection) *and* both announcement seams at once —
    /// the constructor the TD-17 [`OpenProject`] aggregate uses (#472), and the reason the three
    /// constructors above are no longer jointly sufficient: one open project needs the shared
    /// protected set (so the tool boundary and the watchdog read one union) **and** the #346
    /// delivery / #420 birth observers (so a landed tool call reaches the app) on the *same*
    /// binding. Each observer is optional because a caller may have no route for that announcement;
    /// the D23 driver, for example, carries project-files notices but not these delivery/birth ones.
    ///
    /// [`OpenProject`]: super::project::OpenProject
    pub fn open_with_protection_observing(
        root: impl Into<PathBuf>,
        protected: SharedProtectedSet,
        observer: Option<Arc<dyn DeliveryObserver>>,
        birth_observer: Option<Arc<dyn DocumentBirthObserver>>,
        outcome_observer: Option<Arc<dyn DeliveryOutcomeObserver>>,
    ) -> io::Result<ProjectMcpServer> {
        ProjectMcpServer::open_with(root, protected, observer, birth_observer, outcome_observer)
    }

    fn open_with(
        root: impl Into<PathBuf>,
        protected: SharedProtectedSet,
        observer: Option<Arc<dyn DeliveryObserver>>,
        birth_observer: Option<Arc<dyn DocumentBirthObserver>>,
        outcome_observer: Option<Arc<dyn DeliveryOutcomeObserver>>,
    ) -> io::Result<ProjectMcpServer> {
        let server = LoopbackMcpServer::bind()?;
        let addr = server.local_addr()?;
        let token = server.token().to_string();
        let root = root.into();
        let permissions = Arc::new(super::permission::PermissionBroker::new(root.clone(), None));
        let ctx = McpContext::with_shared_protection(root, Arc::clone(&protected))
            .with_permissions(Arc::clone(&permissions));
        let ctx = match observer {
            Some(observer) => ctx.observing(observer),
            None => ctx,
        };
        let ctx = match birth_observer {
            Some(observer) => ctx.observing_births(observer),
            None => ctx,
        };
        let ctx = match outcome_observer {
            Some(observer) => ctx.observing_delivery_outcomes(observer),
            None => ctx,
        };

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::spawn(move || server.serve_until(ctx, &thread_stop));

        Ok(ProjectMcpServer {
            addr,
            token,
            stop,
            thread: Some(thread),
            protected,
            permissions,
        })
    }

    pub fn permissions(&self) -> Arc<super::permission::PermissionBroker> {
        Arc::clone(&self.permissions)
    }

    /// The loopback address this project's server is bound to.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The connection info Emend's own CLI-spawn adapter (`agent::claude`) injects into a spawned
    /// CLI's `--mcp-config` (TD-1: "the user never configures anything"). Backend-only — never
    /// surfaced to the frontend and never logged (FR-X-2).
    pub fn mcp_server(&self) -> claude::McpServer {
        claude::McpServer {
            addr: self.addr,
            token: self.token.clone(),
            run_id: self.permissions.state().run_id,
        }
    }

    /// A clone of the live protected set this server's `McpContext` reads its protection reporting
    /// from — hand to a `Watchdog::with_protected_set` (or any other writer) so tab opens/closes and
    /// run begin/end are visible at the tool boundary the instant they happen (issue #414).
    pub fn protected_set(&self) -> SharedProtectedSet {
        Arc::clone(&self.protected)
    }
}

impl std::fmt::Debug for ProjectMcpServer {
    /// Hand-written so an accidental `{:?}`/log call can never print the bearer token — the
    /// test-plan §3 token-leakage sweep's belt-and-braces case.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectMcpServer")
            .field("addr", &self.addr)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl Drop for ProjectMcpServer {
    /// "Closing the project unbinds it": signal the accept loop to stop and wait for it to
    /// actually exit before returning, so a caller that immediately reopens the same project
    /// never races the old listener for the port. Bounded by `serve_until`'s poll interval while
    /// idle, and by [`STREAM_TIMEOUT`] when a connection is stalled mid-request — never an
    /// unconditional block on a client that opens a connection and never finishes it (issue #413
    /// review, Important #2; the stall is reachable pre-auth, since `read_request` runs before
    /// `authorized`).
    fn drop(&mut self) {
        self.permissions.close_all();
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A per-session bearer token: two v4 UUIDs (≈244 bits of OS-random entropy) with the hyphens
/// stripped. Ample for a loopback, single-session credential; regenerated on every `bind`.
fn mint_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Bounds every blocking read/write in [`handle`] so a stalled or malicious connection cannot
/// hang the serving thread forever — and, transitively, cannot hang [`ProjectMcpServer::drop`]'s
/// join on that thread (issue #413 review, Important #2). Generous for a local IPC "one call per
/// change-set, not chatty" contract; tight enough to bound a stuck project close to a few
/// seconds rather than indefinitely.
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);

fn handle(mut stream: TcpStream, token: &str, ctx: &McpContext) {
    // No token is required to reach this: the stall this guards against (a connection opened
    // and then never completing its request) happens in `read_request`, which runs before
    // `authorized` below.
    let _ = stream.set_read_timeout(Some(STREAM_TIMEOUT));
    let _ = stream.set_write_timeout(Some(STREAM_TIMEOUT));

    let (status, body) = match read_request(&stream) {
        Ok(req) if !req.method.is_empty() => {
            if authorized(token, req.authorization.as_deref()) {
                if req.origin.as_deref().is_some_and(|origin| {
                    stream
                        .local_addr()
                        .map(|addr| origin != format!("http://{addr}"))
                        .unwrap_or(true)
                }) {
                    (403, rpc_error(Value::Null, -32600, "origin not allowed"))
                } else if req
                    .protocol_version
                    .as_deref()
                    .is_some_and(|v| !SUPPORTED_VERSIONS.contains(&v))
                {
                    (
                        400,
                        rpc_error(Value::Null, -32600, "unsupported MCP protocol version"),
                    )
                } else if req.method != "POST" {
                    (405, rpc_error(Value::Null, -32600, "method not allowed"))
                } else {
                    let body = dispatch(&req.body, ctx, req.run_id.as_deref());
                    (if body.is_empty() { 202 } else { 200 }, body)
                }
            } else {
                (401, rpc_error(Value::Null, -32001, "unauthorized"))
            }
        }
        Ok(req) if req.method.is_empty() => {
            (400, rpc_error(Value::Null, -32700, "malformed request"))
        }
        Ok(_) => (405, rpc_error(Value::Null, -32600, "method not allowed")),
        Err(_) => (400, rpc_error(Value::Null, -32700, "malformed request")),
    };
    write_response(&mut stream, status, &body);
}

/// Constant-time bearer check: the provided `Authorization` header must be exactly
/// `Bearer <token>`. Absent header or any mismatch fails. Length differs only by the (non-secret)
/// fixed token length, so the early length return leaks nothing.
fn authorized(expected: &str, header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };
    let Some(provided) = header.strip_prefix("Bearer ") else {
        return false;
    };
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

const SUPPORTED_VERSIONS: &[&str] = &["2025-03-26", "2025-06-18"];
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Parses a JSON-RPC message and returns its response, or an empty body for a notification.
/// Schema-invalid `params` and unknown/unsupported tools become JSON-RPC errors —
/// the caller wraps this in HTTP 200 (a JSON-RPC method error is not a transport failure).
fn dispatch(body: &str, ctx: &McpContext, run_id: Option<&str>) -> String {
    let request: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return rpc_error(Value::Null, -32700, &format!("parse error: {e}")),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);

    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !request.get("method").is_some_and(Value::is_string)
        || request
            .get("id")
            .is_some_and(|id| !(id.is_string() || id.is_i64() || id.is_u64()))
    {
        return rpc_error(Value::Null, -32600, "invalid JSON-RPC request");
    }
    // JSON-RPC notifications never receive a reply, including unknown notification methods.
    // Cancellation identifies a pending permission by its bound run and JSON-RPC request id.
    if request.get("id").is_none() {
        if request["method"] == "notifications/cancelled" {
            if let Some(request_id) = request
                .get("params")
                .and_then(|params| params.get("requestId"))
            {
                ctx.cancel_permission(run_id, request_id);
            }
        }
        return String::new();
    }
    match request.get("method").and_then(Value::as_str) {
        Some("initialize") => {
            let params = &request["params"];
            let Some(version) = params["protocolVersion"].as_str() else {
                return rpc_error(id, -32602, "initialize requires protocolVersion");
            };
            if !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string()
                || !params["clientInfo"]["version"].is_string()
            {
                return rpc_error(
                    id,
                    -32602,
                    "initialize requires capabilities and clientInfo",
                );
            }
            return rpc_result(
                id,
                json!({
                    "protocolVersion": if SUPPORTED_VERSIONS.contains(&version) { version } else { PROTOCOL_VERSION },
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "emend", "version": env!("CARGO_PKG_VERSION") }
                }),
            );
        }
        Some("ping") => return rpc_result(id, json!({})),
        Some("tools/list") => return rpc_result(id, json!({ "tools": tool_definitions() })),
        Some("tools/call") => {}
        Some(other) => return rpc_error(id, -32601, &format!("method not found: {other}")),
        None => return rpc_error(id, -32600, "missing method"),
    }

    let mut params = request.get("params").cloned().unwrap_or(Value::Null);
    // MCP permits omitted arguments for parameterless tools.
    if params.is_object() && params.get("arguments").is_none() {
        params["arguments"] = json!({});
    }
    // The published contract (NI-contract-tool-surface): unknown tool name or malformed arguments
    // are rejected exactly as the fake agent's own calls are.
    let native_permission =
        params["name"] == "permission_request" && params["arguments"].get("tool_name").is_some();
    let validation = if native_permission {
        provider_contract::validate(Schema::ClaudePermissionCallback, &params["arguments"])
    } else {
        provider_contract::validate(Schema::McpToolCall, &params)
    };
    if let Err(errors) = validation {
        return rpc_error(
            id,
            -32602,
            &format!("invalid params: {}", errors.join("; ")),
        );
    }

    let name = params["name"].as_str().unwrap_or_default();
    let arguments = &params["arguments"];
    match if name == "permission_request" {
        ctx.permission_request(run_id, id.clone(), arguments, native_permission)
    } else {
        call_tool(name, arguments, ctx, run_id)
    } {
        Ok(value) => {
            let mut result = json!({
                "content": [{ "type": "text", "text": value.to_string() }],
                "isError": false
            });
            // Claude's permission delegate parses one JSON text result. Its general MCP
            // structured-content conversion otherwise changes that parser's input.
            if name != "permission_request" {
                result["structuredContent"] = value;
            }
            rpc_result(id, result)
        }
        Err(e) => rpc_error(id, error_code(&e), &e.to_string()),
    }
}

/// Publishes standalone input schemas from the dispatch contract. Expanding its local references
/// keeps nested anchors valid without repeating every other tool's schema in each definition.
fn tool_definitions() -> Vec<Value> {
    let contract: Value = serde_json::from_str(Schema::McpToolCall.source())
        .expect("embedded MCP contract is valid JSON");
    contract["allOf"].as_array().expect("tool discriminators").iter().map(|branch| {
        let name = branch["if"]["properties"]["name"]["const"].as_str().expect("tool name");
        let reference = branch["then"]["properties"]["arguments"]["$ref"].as_str().expect("argument schema");
        let schema = if name == "permission_request" {
            serde_json::from_str(Schema::ClaudePermissionCallback.source()).expect("native callback schema")
        } else { expand_schema(&json!({ "$ref": reference }), &contract) };
        let description = match name {
            "get_document_state" => "Read a project document's raw content, revision, pending changes, comments, and protection. Offsets are raw-file UTF-8 byte offsets.",
            "propose_changes" => "Deliver tracked changes against a revision from get_document_state. Protected documents must be edited through this tool. Returns applied and refused edit outcomes.",
            "add_comments" => "Add document-level or anchored comments. Anchors use raw-file UTF-8 byte offsets and the quoted text snapshot.",
            "reply_to_comment" => "Reply to a comment by its id from get_document_state; kind defense explains why no edit is needed.",
            "create_document" => "Create a new project document. Refuses overwrites and protected documents.",
            "list_documents" => "List project documents and their protection states.",
            "permission_request" => "Provider permission callback: waits for a decision on the active run card. Denials carry user guidance; approvals preserve the original input.",
            _ => unreachable!("every published tool has a description"),
        };
        json!({ "name": name, "description": description, "inputSchema": schema })
    }).collect()
}

/// The embedded contract uses acyclic local references with no sibling keywords.
fn expand_schema(schema: &Value, contract: &Value) -> Value {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return expand_schema(
            contract
                .pointer(reference.strip_prefix('#').expect("local schema reference"))
                .expect("referenced schema exists"),
            contract,
        );
    }
    match schema {
        Value::Object(properties) => Value::Object(
            properties
                .iter()
                .map(|(key, value)| (key.clone(), expand_schema(value, contract)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|value| expand_schema(value, contract))
                .collect(),
        ),
        value => value.clone(),
    }
}

/// Dispatches a schema-valid tool call to its implementation. The §3.2 read tools,
/// `create_document` (the agent's direct-write draft path, P2b-6a-i), `propose_changes` (the
/// agent's tracked-change delivery path, P2a-13), and `add_comments`/`reply_to_comment` (the
/// comment-side delivery path, P2b-5a) land here; any other in-surface name is a defined
/// `Unsupported` error (its owning unit implements it).
fn call_tool(
    name: &str,
    arguments: &Value,
    ctx: &McpContext,
    run_id: Option<&str>,
) -> Result<Value, ToolError> {
    match name {
        "get_document_state" => {
            let doc = arguments
                .get("doc")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::InvalidArguments("missing `doc`".to_string()))?;
            ctx.get_document_state(doc)
        }
        "list_documents" => ctx.list_documents(),
        "create_document" => ctx.create_document(arguments),
        "propose_changes" => ctx.propose_changes(arguments),
        "add_comments" => ctx.add_comments(arguments),
        "reply_to_comment" => match run_id {
            Some(id) => ctx.reply_to_comment_for_run(arguments, id),
            None => ctx.reply_to_comment(arguments),
        },
        other => Err(ToolError::Unsupported(other.to_string())),
    }
}

/// Maps a [`ToolError`] to a JSON-RPC error code: bad arguments/paths → invalid params (-32602),
/// an unimplemented tool → method not found (-32601), everything else → internal error (-32603).
fn error_code(error: &ToolError) -> i32 {
    match error {
        ToolError::Confinement(_)
        | ToolError::NotFound(_)
        | ToolError::UnknownComment(_)
        | ToolError::WithdrawnComment(_)
        | ToolError::InvalidArguments(_)
        | ToolError::Protected(_) => -32602,
        ToolError::Unsupported(_) => -32601,
        ToolError::Io(_) => -32603,
    }
}

fn rpc_result(id: Value, value: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": value }).to_string()
}

fn rpc_error(id: Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// One parsed HTTP request: the method, the `Authorization` header (if any), and the body. Path is
/// ignored — the server has a single endpoint.
struct Request {
    method: String,
    authorization: Option<String>,
    origin: Option<String>,
    protocol_version: Option<String>,
    run_id: Option<String>,
    body: String,
}

/// Reads through a `BufReader` that *borrows* the stream, never one that duplicates the handle.
/// On Windows a duplicated socket handle is briefly inheritable, so a `CreateProcess` racing on
/// another thread (Rust's `Command` always passes `bInheritHandles: TRUE`, and this process spawns
/// agent CLIs while the server is serving) leaks the live connection into the child. The server's
/// own `closesocket` is then no longer the last reference, and when the child exits the kernel
/// tears the socket down *abortively* — the peer gets an RST instead of a clean EOF after an
/// already-complete response. Borrowing keeps one handle per connection, so the close stays
/// graceful. Enforced for the whole workspace by `tests/socket_handles.rs`.
fn read_request(stream: &TcpStream) -> io::Result<Request> {
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    let mut content_length = 0usize;
    let mut authorization = None;
    let mut origin = None;
    let mut protocol_version = None;
    let mut run_id = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if lower.starts_with("origin:") {
            origin = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        } else if lower.starts_with("mcp-protocol-version:") {
            protocol_version = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        } else if lower.starts_with("x-emend-run:") {
            run_id = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        } else if lower.starts_with("authorization:") {
            // Keep the original-case value (the token is case-sensitive); only the header name
            // was matched case-insensitively.
            authorization = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        }
    }

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        authorization,
        origin,
        protocol_version,
        run_id,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        403 => "Forbidden",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_listens_on_loopback_only() {
        let server = LoopbackMcpServer::bind().unwrap();
        let addr = server.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.ip(), Ipv4Addr::LOCALHOST);
        assert_ne!(addr.port(), 0);
    }

    #[test]
    fn each_bind_mints_a_distinct_high_entropy_token() {
        let a = LoopbackMcpServer::bind().unwrap();
        let b = LoopbackMcpServer::bind().unwrap();
        assert_ne!(a.token(), b.token());
        assert_eq!(a.token().len(), 64); // two hyphen-stripped v4 UUIDs
    }

    #[test]
    fn authorized_accepts_only_the_exact_bearer_token() {
        assert!(authorized("secret", Some("Bearer secret")));
        assert!(!authorized("secret", Some("Bearer wrong")));
        assert!(!authorized("secret", Some("Bearer secre"))); // length mismatch
        assert!(!authorized("secret", Some("secret"))); // no scheme
        assert!(!authorized("secret", None)); // absent
    }
}
