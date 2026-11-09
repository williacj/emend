// ABOUTME: e2e-able tests that spawn the fake-agent binary and assert its stream-JSON playback.
// ABOUTME: Test-matrix rows for test-plan §1 (fake agent (a): binary + scripted stream-JSON playback).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Path to the compiled fake-agent binary (Cargo sets this for the test target).
fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_fake-agent")
}

/// Path to a scenario file shipped with the crate.
fn scenario(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scenarios")
        .join(name)
}

/// test-plan §1 — the binary replays a scripted scenario's stream-JSON events, in
/// order, one JSON object per line.
#[test]
fn spawned_binary_replays_scenario_events_in_order() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario("claude-minimal-success.json"))
        .arg("--pace")
        .arg("all")
        .output()
        .expect("spawn fake-agent");

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let stdout = String::from_utf8(out.stdout).unwrap();
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(|l| serde_json::from_str(l).expect("each line is a JSON object"))
        .collect();

    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        vec![
            "system",
            "rate_limit_event",
            "system",
            "assistant",
            "result"
        ]
    );
    // Content survives the round-trip byte-for-byte-in-meaning.
    assert_eq!(events[3]["message"]["content"][0]["text"], "ok");
    assert_eq!(events[4]["subtype"], "success");
}

/// test-plan §1 — a second, independent scenario (tool-use turn) also replays in
/// order. Two example scenarios is an acceptance item for #32.
#[test]
fn spawned_binary_replays_tool_use_scenario() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario("claude-read-then-answer.json"))
        .output()
        .expect("spawn fake-agent");

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();

    assert_eq!(events.len(), 5);
    assert_eq!(events[1]["message"]["content"][0]["type"], "tool_use");
    assert_eq!(events[2]["message"]["content"][0]["type"], "tool_result");
    assert_eq!(events[4]["subtype"], "success");
}

/// test-plan §1 / §4 determinism — in step pace the caller is the clock: each
/// advance token yields exactly one more event, with no wall-clock sleeps. This
/// also demonstrates the mechanism P0-8 will use for a never-terminating stream
/// (simply stop advancing).
#[test]
fn step_pace_emits_one_event_per_advance_token() {
    let mut child = Command::new(bin())
        .arg("--scenario")
        .arg(scenario("claude-minimal-success.json"))
        .arg("--pace")
        .arg("step")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn fake-agent");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // The scenario has 5 steps. Each advance gates exactly one event; read_line
    // blocks until that event arrives, so this lockstep needs no sleeps.
    let mut collected = Vec::new();
    for _ in 0..5 {
        writeln!(stdin).unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        let n = stdout.read_line(&mut line).unwrap();
        assert!(n > 0, "expected an event after advancing");
        let ev: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        collected.push(ev["type"].as_str().unwrap().to_string());
    }

    // Closing stdin ends the advance stream; the child finishes cleanly.
    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());

    assert_eq!(
        collected,
        vec![
            "system",
            "rate_limit_event",
            "system",
            "assistant",
            "result"
        ]
    );
}

/// Missing/invalid arguments fail fast with a non-zero, non-crash exit code.
#[test]
fn missing_scenario_arg_exits_with_usage_error() {
    let out = Command::new(bin()).output().expect("spawn fake-agent");
    assert!(!out.status.success());
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}
