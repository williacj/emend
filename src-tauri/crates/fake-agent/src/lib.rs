// ABOUTME: Fake-agent library — scenario format and the playback engine.
// ABOUTME: A deterministic test rig (test-plan §1); the spawnable binary (main.rs) is a thin wrapper over this.

pub mod http_tool_server;
pub mod playback;
pub mod scenario;
pub mod tool_server;

pub use http_tool_server::HttpToolServer;
pub use playback::{play, Outcome, Pace, PlaybackError};
pub use scenario::{Scenario, ScenarioError, Step};
pub use tool_server::{RevisionAwareToolServer, StubToolServer, ToolError, ToolServer};
