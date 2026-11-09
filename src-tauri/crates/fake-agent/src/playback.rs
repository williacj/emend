// ABOUTME: Playback engine — replays a scenario's steps to an output stream, deterministically.
// ABOUTME: No wall-clock sleeps: Step pace makes the caller the clock via an advance channel (test-plan §4 determinism).

use crate::scenario::{Scenario, Step};
use crate::tool_server::{ToolError, ToolServer};
use provider_contract::Schema;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// How a playback run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Playback reached the end of the scenario, or the advance stream hit EOF in
    /// `Step` pace (the caller stopped driving) — a normal finish.
    Completed,
    /// An `Exit { code }` step requested termination mid-scenario (P0-8's
    /// mid-delivery death). The binary exits with this `code`; steps after the
    /// `Exit` did not run. (A `Hang` step never returns, so it has no `Outcome`.)
    Exited(u8),
}

/// How playback advances between steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pace {
    /// Emit every step back-to-back, then finish. Deterministic by ordering alone;
    /// the default for e2e where only the event sequence matters.
    All,
    /// Wait for one advance token (a line on the advance reader) before each step.
    /// The caller is the clock — this is the injectable-clock discipline (no sleeps):
    /// a test drives frame-by-frame, and "never terminates" is just "never advance".
    Step,
}

/// Errors that can arise while replaying a scenario.
#[derive(Debug)]
pub enum PlaybackError {
    Io(std::io::Error),
    /// An emitted event failed stream-JSON schema validation (only when `validate`).
    /// `event_index` counts emitted events, not scenario steps — the two diverge
    /// whenever a non-emitting step precedes an emit (an `McpCall`, or P0-8's
    /// `Hang`/`Exit`).
    SchemaViolation {
        event_index: usize,
        errors: Vec<String>,
    },
    /// An `McpCall` step's `{name, arguments}` payload failed `McpToolCall` schema
    /// validation before dispatch (only when `validate`). Our own tools are strict.
    McpCallSchemaViolation {
        tool: String,
        errors: Vec<String>,
    },
    /// The tool server rejected or could not answer an `McpCall` step.
    ToolCall {
        tool: String,
        source: ToolError,
    },
    /// The tool server's response did not equal the step's `expect` value.
    UnexpectedResponse {
        tool: String,
        expected: Value,
        actual: Value,
    },
}

/// The provider-contract schema the fake replays against. Claude Code stream-JSON
/// today; extended per-provider as the fake grows.
const EVENT_SCHEMA: Schema = Schema::ClaudeStreamEvent;

impl std::fmt::Display for PlaybackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlaybackError::Io(e) => write!(f, "playback io: {e}"),
            PlaybackError::SchemaViolation {
                event_index,
                errors,
            } => {
                write!(
                    f,
                    "event {event_index} violates stream-json schema: {}",
                    errors.join("; ")
                )
            }
            PlaybackError::McpCallSchemaViolation { tool, errors } => {
                write!(
                    f,
                    "mcp call {tool:?} violates mcp-tool-call schema: {}",
                    errors.join("; ")
                )
            }
            PlaybackError::ToolCall { tool, source } => {
                write!(f, "mcp call {tool:?} failed: {source}")
            }
            PlaybackError::UnexpectedResponse {
                tool,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "mcp call {tool:?} response mismatch: expected {expected}, got {actual}"
                )
            }
        }
    }
}

impl std::error::Error for PlaybackError {}

impl From<std::io::Error> for PlaybackError {
    fn from(e: std::io::Error) -> Self {
        PlaybackError::Io(e)
    }
}

/// Replay `scenario` to `out`, taking advance tokens from `advance` when `pace` is
/// `Step`. When `validate` is set, each emitted event is checked against the
/// published provider-contract schema before it is written, and each `McpCall`
/// step's payload against `McpToolCall`, before dispatch (fail-fast; leave off for
/// P0-8's deliberately-malformed scenarios).
///
/// `McpCall` steps are dispatched to `tool_server` — the in-process stand-in for
/// the loopback MCP server (TD-1 §3.2; the real one arrives P2a-12). MCP is a side
/// channel: an `McpCall` writes nothing to `out`, so `out` stays pure stream-JSON.
///
/// Determinism: output ordering is exactly the scenario's step order. In `Step`
/// pace, each step is gated on one line from `advance`; reaching EOF on `advance`
/// while waiting ends playback cleanly (the caller stopped driving).
pub fn play<R: BufRead, W: Write>(
    scenario: &Scenario,
    pace: Pace,
    advance: &mut R,
    out: &mut W,
    validate: bool,
    tool_server: &mut dyn ToolServer,
) -> Result<Outcome, PlaybackError> {
    let mut event_index = 0usize;

    for step in &scenario.steps {
        if pace == Pace::Step && !wait_for_advance(advance)? {
            // Advance stream closed before this step: caller stopped driving.
            return Ok(Outcome::Completed);
        }

        match step {
            Step::Emit(event) => {
                if validate {
                    if let Err(errors) = provider_contract::validate(EVENT_SCHEMA, event) {
                        return Err(PlaybackError::SchemaViolation {
                            event_index,
                            errors,
                        });
                    }
                }
                // One event per line (JSON Lines), flushed so a reader sees it now.
                let line = serde_json::to_string(event).expect("serde_json::Value re-serializes");
                out.write_all(line.as_bytes())?;
                out.write_all(b"\n")?;
                out.flush()?;
                event_index += 1;
            }
            Step::McpCall {
                tool,
                arguments,
                expect,
            } => run_mcp_call(tool, arguments, expect.as_ref(), validate, tool_server)?,
            // Misbehavior primitives (P0-8). Raw/oversized output is deliberately
            // unvalidated — emitting invalid or enormous bytes is the point.
            Step::EmitRaw(bytes) => {
                out.write_all(bytes.as_bytes())?;
                out.flush()?;
            }
            Step::EmitOversized { bytes } => emit_oversized(out, *bytes)?,
            Step::WriteFile { path, contents } => {
                // A raw disk write that bypasses the MCP contract; no path
                // confinement (misbehavior by design — that guard is the consumer's).
                std::fs::write(path, contents)?;
            }
            // Never returns: block the thread forever (a never-terminating stream).
            // Steps after a `Hang` are unreachable — the consumer/test kills the process.
            Step::Hang => hang(),
            // Stop mid-scenario and report the exit code (mid-delivery death).
            Step::Exit { code } => return Ok(Outcome::Exited(*code)),
        }
    }

    Ok(Outcome::Completed)
}

/// Emit a single oversized line: a well-formed assistant/text event whose text
/// field is `bytes` of filler, so only the line *length* is anomalous. Streamed in
/// chunks to avoid a giant allocation; never schema-validated.
fn emit_oversized<W: Write>(out: &mut W, bytes: usize) -> Result<(), PlaybackError> {
    const PREFIX: &[u8] = br#"{"type":"assistant","message":{"content":[{"type":"text","text":""#;
    const SUFFIX: &[u8] = br#""}]}}"#;
    const CHUNK: usize = 8192;

    out.write_all(PREFIX)?;
    let filler = [b'A'; CHUNK];
    let mut remaining = bytes;
    while remaining > 0 {
        let n = remaining.min(CHUNK);
        out.write_all(&filler[..n])?;
        remaining -= n;
    }
    out.write_all(SUFFIX)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

/// Block the current thread forever without spinning or sleeping. `park` may wake
/// spuriously, so it loops; no wall-clock is involved — the process simply never
/// proceeds until something outside (a watchdog, or a test's `kill`) terminates it.
fn hang() -> ! {
    loop {
        std::thread::park();
    }
}

/// Dispatch one `McpCall` step: validate the `{name, arguments}` payload (when
/// `validate`), call the server, and assert the response against `expect` if set.
fn run_mcp_call(
    tool: &str,
    arguments: &Value,
    expect: Option<&Value>,
    validate: bool,
    tool_server: &mut dyn ToolServer,
) -> Result<(), PlaybackError> {
    if validate {
        let call = json!({ "name": tool, "arguments": arguments });
        if let Err(errors) = provider_contract::validate(Schema::McpToolCall, &call) {
            return Err(PlaybackError::McpCallSchemaViolation {
                tool: tool.to_string(),
                errors,
            });
        }
    }

    let response = tool_server
        .call(tool, arguments)
        .map_err(|source| PlaybackError::ToolCall {
            tool: tool.to_string(),
            source,
        })?;

    if let Some(expected) = expect {
        if &response != expected {
            return Err(PlaybackError::UnexpectedResponse {
                tool: tool.to_string(),
                expected: expected.clone(),
                actual: response,
            });
        }
    }

    Ok(())
}

/// Block until one advance token (a line) arrives. Returns `Ok(true)` on a token,
/// `Ok(false)` at EOF (no more tokens will come).
fn wait_for_advance<R: BufRead>(advance: &mut R) -> Result<bool, PlaybackError> {
    let mut buf = String::new();
    let n = advance.read_line(&mut buf)?;
    Ok(n != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Scenario;
    use crate::tool_server::StubToolServer;
    use std::io::Cursor;

    fn scenario(steps: &str) -> Scenario {
        Scenario::from_json_str(&format!(r#"{{ "name": "t", "steps": [{steps}] }}"#)).unwrap()
    }

    #[test]
    fn all_pace_emits_every_step_in_order() {
        let s = scenario(
            r#"{ "emit": { "type": "assistant", "message": { "content": [] } } },
               { "emit": { "type": "result", "subtype": "success", "is_error": false, "session_id": "x" } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();

        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"type\":\"assistant\""));
        assert!(lines[1].contains("\"type\":\"result\""));
    }

    #[test]
    fn step_pace_stops_when_advance_stream_ends_early() {
        // Two steps, but only one advance token: exactly one event emitted, clean exit.
        let s = scenario(
            r#"{ "emit": { "type": "assistant", "message": { "content": [] } } },
               { "emit": { "type": "result", "subtype": "success", "is_error": false, "session_id": "x" } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(b"\n".to_vec());
        play(
            &s,
            Pace::Step,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();

        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"type\":\"assistant\""));
    }

    #[test]
    fn validate_rejects_a_malformed_event() {
        // A result event missing its required `session_id` fails fast when validation is on.
        let s = scenario(r#"{ "emit": { "type": "result", "subtype": "success" } }"#);
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let err = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            true,
            &mut StubToolServer,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            PlaybackError::SchemaViolation { event_index: 0, .. }
        ));
        assert!(out.is_empty(), "nothing is written when validation fails");
    }

    #[test]
    fn mcp_call_step_writes_nothing_to_the_event_stream() {
        // MCP is a side channel: an mcp_call dispatches to the server but emits no
        // stdout line, so out stays pure stream-JSON.
        let s = scenario(
            r#"{ "mcp_call": { "tool": "get_document_state", "arguments": { "doc": "n.md" } } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            true,
            &mut StubToolServer,
        )
        .unwrap();
        assert!(
            out.is_empty(),
            "mcp_call writes nothing to the event stream"
        );
    }

    #[test]
    fn mcp_call_expect_mismatch_is_an_error() {
        let s = scenario(
            r#"{ "mcp_call": { "tool": "propose_changes",
                 "arguments": { "doc": "n.md", "revision": "rev-stub-0001",
                                "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                                "summary": "s" },
                 "expect": { "change_set_id": "WRONG" } } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let err = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            true,
            &mut StubToolServer,
        )
        .unwrap_err();
        assert!(matches!(err, PlaybackError::UnexpectedResponse { .. }));
    }

    #[test]
    fn validate_rejects_a_malformed_mcp_call() {
        // propose_changes with no edits[] violates the strict McpToolCall schema.
        let s = scenario(
            r#"{ "mcp_call": { "tool": "propose_changes",
                 "arguments": { "doc": "n.md", "revision": "r", "summary": "s", "edits": [] } } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let err = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            true,
            &mut StubToolServer,
        )
        .unwrap_err();
        assert!(matches!(err, PlaybackError::McpCallSchemaViolation { .. }));
    }

    #[test]
    fn emit_raw_writes_bytes_verbatim_so_output_can_interleave() {
        // A partial fragment, then a full emit line: the emit's bytes are jammed
        // straight onto the fragment (no framing added around emit_raw), and a
        // closing fragment follows — byte-level interleaving of two "events".
        let s = scenario(
            r#"{ "emit_raw": "{\"type\":\"assistant\",\"content\":[" },
               { "emit": { "type": "system", "subtype": "x" } },
               { "emit_raw": "]}\n" }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let outcome = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Completed);
        let text = String::from_utf8(out).unwrap();
        // The emit's opening brace butts directly against the raw fragment's `[`
        // (the emit re-serializes with keys sorted, as serde_json::Value does).
        assert_eq!(
            text,
            "{\"type\":\"assistant\",\"content\":[{\"subtype\":\"x\",\"type\":\"system\"}\n]}\n"
        );
    }

    #[test]
    fn emit_oversized_produces_one_over_long_line() {
        let s = scenario(r#"{ "emit_oversized": { "bytes": 100000 } }"#);
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "oversized output is a single line");
        assert!(lines[0].len() >= 100_000, "line is at least `bytes` long");
        // Still parseable JSON — only the size is anomalous, not the shape.
        let v: Value = serde_json::from_str(lines[0]).expect("oversized line is valid JSON");
        assert_eq!(v["type"], "assistant");
    }

    #[test]
    fn write_file_writes_bytes_to_disk_bypassing_mcp() {
        // A unique path under the OS temp dir (CARGO_TARGET_TMPDIR is not set for
        // lib tests); process id keeps parallel test binaries from colliding.
        let path =
            std::env::temp_dir().join(format!("fake-agent-wf-unit-{}.md", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let s = Scenario::from_json_str(&format!(
            r#"{{ "name": "wf", "steps": [{{ "write_file": {{ "path": {:?}, "contents": "raw bytes\n" }} }}] }}"#,
            path.to_str().unwrap()
        ))
        .unwrap();
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();
        assert!(
            out.is_empty(),
            "write_file writes nothing to the event stream"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "raw bytes\n");
    }

    #[test]
    fn exit_step_stops_playback_and_reports_the_code() {
        // The pre-exit emit reaches stdout; the post-exit emit never runs.
        let s = scenario(
            r#"{ "emit": { "type": "assistant" } },
               { "exit": { "code": 9 } },
               { "emit": { "type": "result" } }"#,
        );
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let outcome = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Exited(9));
        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("assistant"));
    }

    #[test]
    fn malformed_mcp_call_dispatches_when_validation_is_off() {
        // With validation off (P0-8 posture) an ill-shaped call still reaches the
        // server — here an unknown tool, which the stub rejects as a ToolCall error.
        let s = scenario(r#"{ "mcp_call": { "tool": "teleport", "arguments": {} } }"#);
        let mut out = Vec::new();
        let mut advance = Cursor::new(Vec::new());
        let err = play(
            &s,
            Pace::All,
            &mut advance,
            &mut out,
            false,
            &mut StubToolServer,
        )
        .unwrap_err();
        assert!(matches!(err, PlaybackError::ToolCall { .. }));
    }
}
