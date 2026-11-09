// ABOUTME: Agent subsystem (§3.1 `agent/`) — the Cowrite-hosted MCP server (TD-1) the app wires
// ABOUTME: into every spawned CLI: loopback bind + per-session bearer (§3.5), the §3.2 tool surface,
// ABOUTME: and the TD-17 `OpenProject` aggregate that owns them for one open project's lifetime.

pub mod activity;
pub mod birth;
pub mod claude;
pub mod delivery;
pub mod mcp;
pub mod project;
pub mod providers;
pub mod reply;
pub mod run_queue;
pub mod session;
pub mod state;
pub mod watchdog;

pub mod permission;

mod permission_adapter;
