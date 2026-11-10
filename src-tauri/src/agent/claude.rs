// ABOUTME: Claude Code CLI adapter (TD-5, TD §3.4) — builds the `claude -p …` invocation that
// ABOUTME: auto-wires the P2a-12 loopback MCP server in, with `--resume` and version-detect support.

//! Pure command-construction for the Claude Code CLI adapter. Building the invocation is kept
//! separate from spawning/streaming it (`agent::session`) so the exact argv Emend would pass to
//! `claude` is unit-testable without a `claude` binary on `PATH` (SPIKE-1 §3.1/§3.3, §7
//! "recommended adapter differences").

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use serde_json::{json, Value};

/// The default `claude` binary Emend spawns, resolved off `PATH`. Explicit binary
/// discovery/pinning across install methods (SPIKE-1 §6 gap #10) is a later unit's job.
pub const BINARY: &str = "claude";

/// Test-only override shared by provider detection and the production spawn path. D23 e2e runs use
/// it to select a deterministic fake provider without risking a real, billable CLI invocation.
pub const BINARY_OVERRIDE_VAR: &str = "EMEND_CLAUDE_BIN";

/// Resolves the executable for every Claude operation. Keeping the override here in the adapter
/// makes detection and spawning observe the same binary.
pub fn binary() -> String {
    env::var(BINARY_OVERRIDE_VAR).unwrap_or_else(|_| BINARY.to_string())
}

/// The Claude Code CLI version this adapter was built and verified against
/// (`docs/spikes/spike1-provider-contract.md`) — the TD §3.4 risk-register "version-detect on
/// spawn" baseline. A spawn below this is not refused (a hard pin would break a still-compatible
/// CLI); see [`version_warning`].
pub const MIN_SUPPORTED_VERSION: &str = "2.1.200";

/// The Emend MCP server's name inside the injected `mcpServers` config — also the
/// `mcp__emend__<tool>` prefix the stream carries for our own tool calls (`agent::activity`).
pub const MCP_SERVER_NAME: &str = "emend";

/// The P2a-12 loopback MCP server a spawned CLI should connect to: its bound address plus the
/// per-session bearer token minted for this run (`agent::mcp::LoopbackMcpServer`).
#[derive(Clone)]
pub struct McpServer {
    pub addr: SocketAddr,
    pub token: String,
    /// Backend-bound run identity; permission callbacks from older runs are refused.
    pub run_id: Option<String>,
}

impl std::fmt::Debug for McpServer {
    /// Hand-written so an accidental `{:?}` on this value — or on a `SpawnRequest` that embeds
    /// it, whose own `#[derive(Debug)]` delegates field-by-field and so calls this impl — never
    /// prints the bearer token (FR-X-2, test-plan §3 token-leakage sweep; issue #413 review,
    /// Important #3: this was previously derived, so debug-formatting the value
    /// `agent::mcp::ProjectMcpServer::mcp_server()` returns leaked it in the clear).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServer")
            .field("addr", &self.addr)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// One request to spawn (or resume) a Claude Code CLI turn.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    /// The project directory the CLI runs in (`cwd`) — every path it touches confines here.
    pub project_dir: PathBuf,
    /// The P2a-12 server to auto-wire in — no manual user configuration step (FR-X-2): the
    /// secret never touches the frontend, only this backend-built argv.
    ///
    /// Every run Emend spawns now carries one (#472): `commands::agent::spawn_claude_run` takes
    /// it from the open project's bound server (TD-17), and a run with no open project to draw one
    /// from *fails* rather than spawning tool-less (D21). `None` stays representable only for a
    /// caller building an invocation for something other than an Emend-hosted turn; it omits
    /// `--mcp-config` and `--permission-prompt-tool` together (see [`build_args`]).
    pub mcp_server: Option<McpServer>,
    /// The provider session to `--resume`, when this spawn continues an earlier one (D4
    /// continuity) rather than starting fresh.
    pub resume_session_id: Option<String>,
}

/// The MCP tool `--permission-prompt-tool` delegates every headless tool-permission decision to
/// (SPIKE-1 §3.3/§3.4, TD-5, J7 / FR-AGENT-3): the `permission_request` tool (TD-1 §3.2) on our own
/// `cowrite` server, named with Claude Code's `mcp__<server>__<tool>` convention (line 25). Built
/// from [`MCP_SERVER_NAME`] so it can never drift from the server name we actually inject. Only
/// meaningful when an [`McpServer`] is wired — the tool lives on that server — so [`build_args`]
/// emits the flag alongside `--mcp-config`, never on its own (see #453: this is what makes D21
/// protection Emend's enforcement rather than the provider CLI's non-interactive default).
///
/// The v2.1.199+ caveat (an `allow` for an MCP tool marked "requires user interaction" is
/// converted to a deny) does not bite here so long as our own `permission_request` tool is *not*
/// marked interaction-requiring — a server-side tool-definition concern, not this argv's.
pub fn permission_prompt_tool() -> String {
    format!("mcp__{MCP_SERVER_NAME}__permission_request")
}

/// Builds the `--mcp-config` payload (the published `McpServerConfig` schema): one `http` server
/// named `cowrite`, pointing at the loopback address with the bearer token in its `Authorization`
/// header — the whole "user configures nothing" contract lives in this one value.
pub fn mcp_config(server: &McpServer) -> Value {
    let mut headers = json!({"Authorization": format!("Bearer {}", server.token)});
    if let Some(run_id) = &server.run_id {
        headers["X-Emend-Run"] = json!(run_id);
    }
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": format!("http://{}/", server.addr),
                "headers": headers
            }
        }
    })
}

/// Builds the full `claude` argv (SPIKE-1 §3.1/§3.3): headless + streaming (`-p --output-format
/// stream-json --verbose`), the MCP config inline when one is wired (`--mcp-config` accepts a raw
/// JSON string — no temp file needed; omitted when `mcp_server` is `None`, see its doc) together
/// with `--permission-prompt-tool` delegating tool-permission decisions to that server's
/// [`permission_prompt_tool`] (J7 / FR-AGENT-3 / TD-5, #453), and `--resume <id>` when
/// `resume_session_id` is set (D4 continuity). The prompt itself is deliberately absent: callers
/// write it to stdin so a large FR-CHAT-3 quoted selection cannot exceed the OS command-line limit
/// (D13 / FR-X-1). Does not include the binary name or prompt — pair with [`BINARY`] and the
/// caller's prompt to spawn (`agent::session::AgentSession::spawn_with_stdin`).
pub fn build_args(request: &SpawnRequest) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    if let Some(server) = &request.mcp_server {
        args.push("--mcp-config".to_string());
        args.push(mcp_config(server).to_string());
        // Delegate every headless tool-permission decision to our own MCP tool (J7 / FR-AGENT-3 /
        // TD-5, #453) rather than leaving it to the provider CLI's non-interactive default — only
        // possible once a server serves that tool, hence inside this same `Some` arm.
        args.push("--permission-prompt-tool".to_string());
        args.push(permission_prompt_tool());
    }
    if let Some(id) = &request.resume_session_id {
        args.push("--resume".to_string());
        args.push(id.clone());
    }
    args
}

/// Compares a stream-observed `claude_code_version` (from the `system/init` event) against
/// [`MIN_SUPPORTED_VERSION`], returning a human-readable warning when the running CLI is older
/// than what this adapter was verified against (TD §3.4 risk-register: "CLI output-format drift
/// across provider versions"). `None` means at-or-above the pinned minimum, or an unparseable
/// version string — never block or alarm on a shape we don't understand.
pub fn version_warning(seen: &str) -> Option<String> {
    let seen_v = parse_version(seen)?;
    let min_v = parse_version(MIN_SUPPORTED_VERSION)?;
    if seen_v < min_v {
        Some(format!(
            "Claude Code CLI {seen} is older than the {MIN_SUPPORTED_VERSION} this adapter was verified against — output-format drift is possible (TD §3.4)."
        ))
    } else {
        None
    }
}

/// Parses a dotted `major.minor.patch` version string into a comparable tuple. A non-numeric
/// component (a pre-release suffix, say) fails to parse rather than guess an ordering.
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let mut parts = v.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> McpServer {
        McpServer {
            addr: "127.0.0.1:39999".parse().unwrap(),
            token: "test-token-123".to_string(),
            run_id: None,
        }
    }

    #[test]
    fn mcp_config_matches_the_published_schema_shape() {
        let cfg = mcp_config(&server());
        assert_eq!(cfg["mcpServers"]["emend"]["type"], "http");
        assert_eq!(
            cfg["mcpServers"]["emend"]["url"],
            "http://127.0.0.1:39999/"
        );
        assert_eq!(
            cfg["mcpServers"]["emend"]["headers"]["Authorization"],
            "Bearer test-token-123"
        );
        assert!(
            provider_contract::is_valid(provider_contract::Schema::McpServerConfig, &cfg),
            "{cfg}"
        );
    }

    /// Issue #413 review, Important #3: `SpawnRequest` derives `Debug` and embeds `McpServer`, so
    /// the redaction has to hold on both — a leak that field-derives around a hand-written inner
    /// `Debug` is exactly the kind that reads as covered when it isn't.
    #[test]
    fn debug_formatting_never_prints_the_bearer_token_on_mcp_server_or_a_spawn_request() {
        let mcp_server = server();
        assert!(!format!("{mcp_server:?}").contains("test-token-123"));

        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: Some(server()),
            resume_session_id: None,
        };
        assert!(!format!("{request:?}").contains("test-token-123"));
    }

    #[test]
    fn build_args_is_headless_streaming_and_verbose() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: Some(server()),
            resume_session_id: None,
        };
        let args = build_args(&request);
        assert_eq!(
            args,
            vec![
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--mcp-config",
                &mcp_config(&server()).to_string(),
                "--permission-prompt-tool",
                "mcp__emend__permission_request",
            ],
            "the complete argv contains no prompt; the turn rides stdin instead"
        );
    }

    #[test]
    fn permission_prompt_tool_targets_the_permission_request_tool_on_the_cowrite_server() {
        // Must track MCP_SERVER_NAME (the `mcp__<server>__<tool>` convention, line 25) so the
        // delegated tool name and the injected server name can never drift apart.
        assert_eq!(
            permission_prompt_tool(),
            format!("mcp__{MCP_SERVER_NAME}__permission_request")
        );
        assert_eq!(permission_prompt_tool(), "mcp__emend__permission_request");
    }

    /// J7 / FR-AGENT-3 / TD-5: when an Emend MCP server is wired, every tool call the spawned CLI
    /// wants to make is delegated to our own `permission_request` tool rather than left to the
    /// provider CLI's non-interactive default (#453) — so D21 protection is Emend's enforcement.
    #[test]
    fn build_args_delegates_permission_gating_to_the_emend_mcp_tool_when_a_server_is_wired() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: Some(server()),
            resume_session_id: None,
        };
        let args = build_args(&request);
        let idx = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("a wired run delegates permission to the Emend MCP tool");
        assert_eq!(args[idx + 1], "mcp__emend__permission_request");
    }

    /// The delegation target is a tool served by our own MCP server, so with no server wired there
    /// is no tool to delegate to — the flag must be omitted rather than pointing at a tool that is
    /// not loaded (#453; mirrors `--mcp-config`'s own until-#413 omission above).
    #[test]
    fn build_args_omits_permission_prompt_tool_when_no_server_is_wired() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: None,
            resume_session_id: None,
        };
        let args = build_args(&request);
        assert!(!args.contains(&"--permission-prompt-tool".to_string()));
    }

    #[test]
    fn build_args_carries_the_mcp_config_as_inline_json() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: Some(server()),
            resume_session_id: None,
        };
        let args = build_args(&request);
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        let inline: Value = serde_json::from_str(&args[idx + 1]).expect("inline JSON config");
        assert_eq!(inline["mcpServers"]["emend"]["type"], "http");
    }

    /// P2a integration (#412): a run started before the server-bind card (#413) wires a real
    /// `McpServer` still needs a valid `claude` invocation — just without tool access.
    #[test]
    fn build_args_omits_mcp_config_when_no_server_is_wired() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: None,
            resume_session_id: None,
        };
        let args = build_args(&request);
        assert!(!args.contains(&"--mcp-config".to_string()));
        // Still a valid headless streaming invocation otherwise.
        assert!(args.contains(&"--output-format".to_string()));
    }

    #[test]
    fn build_args_appends_resume_with_the_session_id_when_continuing() {
        let request = SpawnRequest {
            project_dir: "/tmp/project".into(),
            mcp_server: Some(server()),
            resume_session_id: Some("e6639704-0d4d-497d-8898-ef5a938ef849".to_string()),
        };
        let args = build_args(&request);
        let idx = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[idx + 1], "e6639704-0d4d-497d-8898-ef5a938ef849");
    }

    #[test]
    fn version_warning_is_silent_at_or_above_the_pinned_minimum() {
        assert_eq!(version_warning("2.1.200"), None);
        assert_eq!(version_warning("2.1.201"), None);
        assert_eq!(version_warning("3.0.0"), None);
    }

    #[test]
    fn version_warning_fires_below_the_pinned_minimum() {
        let warning = version_warning("2.1.199").expect("older CLI warns");
        assert!(warning.contains("2.1.199"));
        assert!(warning.contains(MIN_SUPPORTED_VERSION));
    }

    #[test]
    fn version_warning_is_silent_on_an_unparseable_version() {
        // Never block/alarm on a version shape this adapter doesn't understand.
        assert_eq!(version_warning("unknown"), None);
        assert_eq!(version_warning("2.1"), None);
    }
}
