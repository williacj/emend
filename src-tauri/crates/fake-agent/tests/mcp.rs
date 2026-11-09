// ABOUTME: MCP-call scenario harness — drives scenarios' scripted tool calls through the stub server and asserts the schema-validated round-trip.
// ABOUTME: Test-matrix rows for test-plan §1 (fake agent (b): MCP-call scenarios + validation harness, #33/P0-7).

use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use fake_agent::{play, Pace, Scenario, StubToolServer};

fn scenario_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scenarios")
        .join(name)
}

fn scenario(name: &str) -> Scenario {
    Scenario::from_path(scenario_path(name)).expect("scenario parses")
}

/// Path to the compiled fake-agent binary (Cargo sets this for the test target).
fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_fake-agent")
}

/// P0-7 acceptance (#33): a scenario invoking get_document_state and
/// propose_changes round-trips through the stub tool server *with validation on* —
/// each `{name, arguments}` payload passes the `McpToolCall` schema, the stub
/// answers, and the `propose_changes` `expect` matches the canned response.
#[test]
fn mcp_propose_scenario_round_trips_with_validation() {
    let s = scenario("claude-mcp-propose.json");
    let mut out = Vec::new();
    let mut advance = Cursor::new(Vec::new());
    play(
        &s,
        Pace::All,
        &mut advance,
        &mut out,
        true, // validate: calls checked against McpToolCall, events against ClaudeStreamEvent
        &mut StubToolServer,
    )
    .expect("mcp scenario round-trips under validation");

    // MCP is a side channel: only the emit steps reach stdout, in order. The two
    // mcp_call steps (get_document_state, propose_changes) write nothing there.
    let events: Vec<serde_json::Value> = std::str::from_utf8(&out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, vec!["system", "assistant", "result"]);
}

/// The harness catches a broken tool contract: mutating the scenario's `expect`
/// to a value the stub never returns fails the round-trip (proves the assertion
/// has teeth — without this, "round-trips" would be vacuous).
#[test]
fn round_trip_assertion_has_teeth() {
    // Same call, but expect a change_set_id the stub does not produce.
    let json = r#"{
        "name": "teeth",
        "steps": [{ "mcp_call": {
            "tool": "propose_changes",
            "arguments": {
                "doc": "notes.md",
                "revision": "rev-stub-0001",
                "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                "summary": "s"
            },
            "expect": { "change_set_id": "cs-NOPE" }
        } }]
    }"#;
    let s = Scenario::from_json_str(json).unwrap();
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
    .expect_err("mismatched expect fails the round-trip");
    assert!(err.to_string().contains("response mismatch"));
}

/// The spawnable binary runs an MCP scenario end-to-end: exit success, and stdout
/// carries only the stream-JSON events — the MCP calls stay on the side channel
/// (in production, loopback HTTP; here, the binary's default stub server).
#[test]
fn spawned_binary_runs_an_mcp_scenario() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-mcp-propose.json"))
        .arg("--validate")
        .output()
        .expect("spawn fake-agent");

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let types: Vec<String> = stdout
        .lines()
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(types, vec!["system", "assistant", "result"]);
}

/// P2b-5a acceptance (#354): the comment-side delivery path — a review finding
/// lands via `add_comments` (severity/skill/workflow_run carried through) and the
/// agent defends it via `reply_to_comment` — round-trips through the stub tool
/// server *with validation on*, exactly as `claude-mcp-propose` does for
/// `propose_changes`.
#[test]
fn mcp_comments_scenario_round_trips_with_validation() {
    let s = scenario("claude-mcp-comments.json");
    let mut out = Vec::new();
    let mut advance = Cursor::new(Vec::new());
    play(
        &s,
        Pace::All,
        &mut advance,
        &mut out,
        true, // validate: calls checked against McpToolCall, events against ClaudeStreamEvent
        &mut StubToolServer,
    )
    .expect("mcp comments scenario round-trips under validation");

    // MCP is a side channel: only the emit steps reach stdout, in order. The three
    // mcp_call steps (get_document_state, add_comments, reply_to_comment) write
    // nothing there.
    let events: Vec<serde_json::Value> = std::str::from_utf8(&out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, vec!["system", "assistant", "assistant", "result"]);
}

/// The spawnable binary runs the comments scenario end-to-end, mirroring
/// `spawned_binary_runs_an_mcp_scenario` for `add_comments`/`reply_to_comment`.
#[test]
fn spawned_binary_runs_an_mcp_comments_scenario() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-mcp-comments.json"))
        .arg("--validate")
        .output()
        .expect("spawn fake-agent");

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let types: Vec<String> = stdout
        .lines()
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(types, vec!["system", "assistant", "assistant", "result"]);
}

/// P2b-6a-i acceptance (#419): the agent's direct-write draft path — a `create_document` call
/// naming a fresh path — round-trips through the stub tool server *with validation on*, exactly
/// as `claude-mcp-propose`/`claude-mcp-comments` do for their own tools. The `expect` pins the
/// real tool's response shape (`{path, doc_id}` — opening the tab is the sibling card's job).
#[test]
fn mcp_create_document_scenario_round_trips_with_validation() {
    let s = scenario("claude-mcp-create-document.json");
    let mut out = Vec::new();
    let mut advance = Cursor::new(Vec::new());
    play(
        &s,
        Pace::All,
        &mut advance,
        &mut out,
        true, // validate: calls checked against McpToolCall, events against ClaudeStreamEvent
        &mut StubToolServer,
    )
    .expect("mcp create_document scenario round-trips under validation");

    // MCP is a side channel: only the emit steps reach stdout, in order. The one mcp_call step
    // (create_document) writes nothing there.
    let events: Vec<serde_json::Value> = std::str::from_utf8(&out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, vec!["system", "assistant", "result"]);
}

/// The spawnable binary runs the create_document scenario end-to-end, mirroring
/// `spawned_binary_runs_an_mcp_scenario` for `create_document`.
#[test]
fn spawned_binary_runs_an_mcp_create_document_scenario() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-mcp-create-document.json"))
        .arg("--validate")
        .output()
        .expect("spawn fake-agent");

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let types: Vec<String> = stdout
        .lines()
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(types, vec!["system", "assistant", "result"]);
}
