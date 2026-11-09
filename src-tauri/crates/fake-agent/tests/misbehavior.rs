// ABOUTME: Misbehavior-repertoire tests (test-plan §1) — each scripted misbehavior invocable by name.
// ABOUTME: Test-matrix rows for P0-8 (#34): raw protected-doc write, malformed/oversized/interleaved output, never-terminating stream, stale-revision call, mid-delivery death.

use std::io::Cursor;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use fake_agent::{play, Pace, PlaybackError, RevisionAwareToolServer, Scenario};
use serde_json::Value;

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

/// A fresh, empty working directory unique to `test` (under Cargo's per-target tmp).
fn workdir(test: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(test);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workdir");
    dir
}

fn parse_events(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Misbehavior: raw file-write to a protected doc WITH correlated stream events.
/// The binary performs a direct disk write (bypassing MCP) and emits a correlated
/// `Write` tool_use naming the same file — the setup attribution precedence must
/// resolve (test-plan §1/§3).
#[test]
fn raw_write_to_protected_doc_with_correlated_events() {
    let dir = workdir("raw-write");
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-raw-write-protected.json"))
        .current_dir(&dir)
        .output()
        .expect("spawn fake-agent");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The raw write landed on disk, having skipped the MCP propose_changes contract.
    let written =
        std::fs::read_to_string(dir.join("protected-notes.md")).expect("protected doc was written");
    assert!(written.contains("Rewritten by a misbehaving agent"));

    // ...and the stream carried a correlated Write tool_use naming the same file.
    let events = parse_events(&String::from_utf8(out.stdout).unwrap());
    let announced = dir
        .join("protected-notes.md")
        .canonicalize()
        .expect("written protected doc canonicalizes");
    let correlated = events.iter().any(|e| {
        e["type"] == "assistant"
            && e["message"]["content"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|b| {
                    b["type"] == "tool_use"
                        && b["name"] == "Write"
                        && b["input"]["file_path"]
                            .as_str()
                            .and_then(|path| PathBuf::from(path).canonicalize().ok())
                            .is_some_and(|path| path == announced)
                })
            })
    });
    assert!(
        correlated,
        "a correlated Write tool_use event named the canonical absolute path"
    );
}

/// Misbehavior: malformed output. At least one emitted line is not valid JSON; the
/// process still exits cleanly (the consumer's parser, not the agent, must cope).
#[test]
fn malformed_output_emits_non_json_lines() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-malformed-output.json"))
        .output()
        .expect("spawn fake-agent");
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    let has_garbage = stdout
        .lines()
        .any(|l| !l.is_empty() && serde_json::from_str::<Value>(l).is_err());
    assert!(
        has_garbage,
        "a malformed (non-JSON) line was emitted:\n{stdout}"
    );
}

/// Misbehavior: oversized output. A single emitted line is at least 1 MiB long.
#[test]
fn oversized_output_emits_a_line_over_a_megabyte() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-oversized-output.json"))
        .output()
        .expect("spawn fake-agent");
    assert!(out.status.success());
    let longest = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::len)
        .max()
        .unwrap_or(0);
    assert!(
        longest >= 1024 * 1024,
        "expected an oversized line, longest was {longest} bytes"
    );
}

/// Misbehavior: interleaved output. One event's bytes are split and a second
/// complete event is written into the gap — the two jam together with no framing.
#[test]
fn interleaved_output_jams_events_together() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-interleaved-output.json"))
        .output()
        .expect("spawn fake-agent");
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    // The spliced-in event butts directly against the half-written first event:
    // the first event's `...}` is immediately followed by the second's `{...` with
    // no newline/framing between them (the spliced event's keys re-sort on emit).
    assert!(
        stdout.contains(r#""name":"Read"}{"subtype":"spliced_in_mid_event""#),
        "events interleave with no framing:\n{stdout}"
    );
}

/// Misbehavior: never-terminating stream. The agent emits its opening events then
/// hangs forever; the process cannot exit on its own, so a watchdog must kill it.
#[test]
fn never_terminating_stream_hangs_until_killed() {
    let mut child = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-never-terminates.json"))
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn fake-agent");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // The scenario emits exactly two events before the hang. Reading them is a
    // blocking, condition-based wait — no sleeps (test-plan §4).
    for _ in 0..2 {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).expect("read pre-hang event");
        assert!(n > 0, "expected a pre-hang event");
    }

    // The agent is now parked forever: there is no code path past `hang`, so it
    // cannot have exited. `try_wait` is non-blocking, so this asserts without a race.
    assert!(
        child.try_wait().unwrap().is_none(),
        "process must still be running (never-terminating stream)"
    );

    // Model the consumer's watchdog killing the hung agent.
    child.kill().expect("kill hung agent");
    let status = child.wait().expect("reap killed agent");
    assert!(!status.success(), "a killed process is not a clean exit");
}

/// Misbehavior: stale-revision tool call. The agent proposes against an out-of-date
/// revision; the revision-aware server rejects it, matching the scenario's `expect`.
#[test]
fn stale_revision_tool_call_is_rejected() {
    let s = scenario("claude-stale-revision.json");

    // The document is at rev-current; the scenario proposes against rev-stale-1.
    // A clean return means the server's stale rejection matched the step's `expect`.
    let mut server = RevisionAwareToolServer::new("rev-current");
    play(
        &s,
        Pace::All,
        &mut Cursor::new(Vec::new()),
        &mut Vec::new(),
        true, // validate: the stale call is still well-formed (McpToolCall-valid)
        &mut server,
    )
    .expect("stale call round-trips to the scripted rejection");

    // Teeth: were that same revision current, the call would succeed (change_set_id)
    // rather than be rejected — so the rejection is revision-dependent, not blanket.
    let mut fresh = RevisionAwareToolServer::new("rev-stale-1");
    let err = play(
        &s,
        Pace::All,
        &mut Cursor::new(Vec::new()),
        &mut Vec::new(),
        true,
        &mut fresh,
    )
    .expect_err("a current revision is not rejected, so `expect` no longer matches");
    assert!(matches!(err, PlaybackError::UnexpectedResponse { .. }));
}

/// Misbehavior: mid-delivery death. The process exits with the scripted code before
/// the terminal `result` event — a partial delivery, then a crash.
#[test]
fn mid_delivery_death_exits_before_the_terminal_result() {
    let out = Command::new(bin())
        .arg("--scenario")
        .arg(scenario_path("claude-mid-delivery-death.json"))
        .output()
        .expect("spawn fake-agent");

    // Died abnormally with the scripted exit code.
    assert_eq!(out.status.code(), Some(37));

    let events = parse_events(&String::from_utf8(out.stdout).unwrap());
    // A partial delivery reached stdout...
    assert!(
        events.iter().any(|e| e["type"] == "assistant"),
        "the partial delivery was emitted"
    );
    // ...but the terminal `result` after the exit never did.
    assert!(
        !events.iter().any(|e| e["type"] == "result"),
        "no terminal result event before mid-delivery death"
    );
}
