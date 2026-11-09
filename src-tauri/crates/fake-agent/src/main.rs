// ABOUTME: Fake-agent CLI replays stream-JSON scenarios; step pace advances from stdin.
// ABOUTME: Spawn-test flags validate MCP, pipe backpressure, and whole-stdin prompt behavior.

use std::io::{Read, Write};
use std::process::ExitCode;

use fake_agent::{play, HttpToolServer, Outcome, Pace, Scenario, StubToolServer, ToolServer};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(p) => p,
        Err(msg) => {
            eprintln!("fake-agent: {msg}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let mut scenario = match Scenario::from_path(&parsed.scenario_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fake-agent: {e}");
            return ExitCode::from(2);
        }
    };
    let project_root = match std::env::current_dir() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("fake-agent: resolving project root: {error}");
            return ExitCode::from(2);
        }
    };
    scenario.materialize_project_root(&project_root);

    // Test-support only (no scenario needs it — a chatty-stderr misbehavior isn't part of the
    // stream-JSON contract): write `noisy_stderr` bytes to stderr *before* the stdout event
    // stream starts, so a caller who still pipes-and-doesn't-drain stderr deadlocks here, before
    // ever reaching the events its stdout reader is waiting on. Regression coverage for the
    // spawn primitive's stderr handling — `agent::session::AgentSession::spawn` (`Stdio::null`).
    if parsed.noisy_stderr > 0 {
        if let Err(e) = write_noisy_stderr(parsed.noisy_stderr) {
            eprintln!("fake-agent: writing noisy stderr: {e}");
            return ExitCode::FAILURE;
        }
    }

    if let Some(path) = &parsed.wait_before_stdin {
        while !path.exists() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    if parsed.report_stdin {
        let mut input = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut input) {
            eprintln!("fake-agent: reading stdin: {e}");
            return ExitCode::FAILURE;
        }
        println!(
            "{}",
            serde_json::json!({ "type": "result", "stdin": input })
        );
    }

    // stdin = advance channel (only in Step pace); --report-stdin consumes it to EOF first, so
    // that test-support mode is intentionally used only with the default all-at-once pace.
    let stdin = std::io::stdin();
    let mut advance = stdin.lock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    // MCP calls dispatch to the in-process stub by default (deterministic, zero network — what
    // every playback scenario wants). When Cowrite spawns us the way it spawns a real CLI it
    // passes `--mcp-config`, and we then talk real loopback HTTP + bearer token to the server it
    // named — the only way a test can prove the injection actually reaches the tool surface (#472).
    let mut tool_server: Box<dyn ToolServer> = match &parsed.mcp_config {
        Some(config) => match HttpToolServer::from_mcp_config(config) {
            Ok(mut server) => {
                if let Err(e) = server.initialize() {
                    eprintln!("fake-agent: {e}");
                    return ExitCode::from(2);
                }
                Box::new(server)
            }
            Err(e) => {
                eprintln!("fake-agent: {e}");
                return ExitCode::from(2);
            }
        },
        None => Box::new(StubToolServer),
    };

    match play(
        &scenario,
        parsed.pace,
        &mut advance,
        &mut out,
        parsed.validate,
        tool_server.as_mut(),
    ) {
        Ok(Outcome::Completed) => ExitCode::SUCCESS,
        // An `Exit` step (mid-delivery death) — surface its code to the caller so a
        // test can observe the abnormal termination.
        Ok(Outcome::Exited(code)) => ExitCode::from(code),
        Err(e) => {
            eprintln!("fake-agent: {e}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "usage: fake-agent --scenario <path> [--pace all|step] [--validate] \
                     [--noisy-stderr <bytes>] [--wait-before-stdin <path>] [--report-stdin] \
                     [--mcp-config <json>]";

struct Parsed {
    scenario_path: String,
    pace: Pace,
    validate: bool,
    noisy_stderr: usize,
    /// Test-support gate: do not begin consuming stdin until this path exists.
    wait_before_stdin: Option<std::path::PathBuf>,
    /// Test-support mode: consume stdin and report it as one stream-JSON event before playback.
    report_stdin: bool,
    /// The parsed `--mcp-config` payload, when Cowrite injected one (`agent::claude::mcp_config`).
    mcp_config: Option<serde_json::Value>,
}

fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut scenario_path: Option<String> = None;
    let mut pace = Pace::All;
    let mut validate = false;
    let mut noisy_stderr = 0usize;
    let mut wait_before_stdin = None;
    let mut report_stdin = false;
    let mut mcp_config = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scenario" => {
                i += 1;
                scenario_path = Some(args.get(i).ok_or("--scenario requires a path")?.clone());
            }
            "--pace" => {
                i += 1;
                pace = match args.get(i).map(String::as_str) {
                    Some("all") => Pace::All,
                    Some("step") => Pace::Step,
                    _ => return Err("--pace requires 'all' or 'step'".into()),
                };
            }
            "--validate" => validate = true,
            "--report-stdin" => report_stdin = true,
            "--wait-before-stdin" => {
                i += 1;
                wait_before_stdin = Some(
                    args.get(i)
                        .ok_or("--wait-before-stdin requires a path")?
                        .into(),
                );
            }
            "--noisy-stderr" => {
                i += 1;
                let raw = args.get(i).ok_or("--noisy-stderr requires a byte count")?;
                noisy_stderr = raw
                    .parse()
                    .map_err(|_| format!("--noisy-stderr expects a byte count, got {raw:?}"))?;
            }
            // Inline JSON, exactly as the real `claude` CLI takes it (`agent::claude::build_args`
            // pushes `mcp_config(...).to_string()` — no temp file).
            "--mcp-config" => {
                i += 1;
                let raw = args.get(i).ok_or("--mcp-config requires a JSON payload")?;
                mcp_config = Some(
                    serde_json::from_str(raw)
                        .map_err(|e| format!("--mcp-config is not valid JSON: {e}"))?,
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }

    Ok(Parsed {
        scenario_path: scenario_path.ok_or("--scenario is required")?,
        pace,
        validate,
        noisy_stderr,
        wait_before_stdin,
        report_stdin,
        mcp_config,
    })
}

/// Write `bytes` of filler to stderr in bounded chunks (never one giant allocation), flushed at
/// the end. A single blocking `write_all` on a pipe backs up against the OS's bounded pipe
/// buffer exactly like a real chatty CLI would — the scenario this flag exists to reproduce.
fn write_noisy_stderr(bytes: usize) -> std::io::Result<()> {
    const CHUNK: usize = 8192;
    let filler = [b'e'; CHUNK];
    let stderr = std::io::stderr();
    let mut err = stderr.lock();
    let mut remaining = bytes;
    while remaining > 0 {
        let n = remaining.min(CHUNK);
        err.write_all(&filler[..n])?;
        remaining -= n;
    }
    err.flush()
}
