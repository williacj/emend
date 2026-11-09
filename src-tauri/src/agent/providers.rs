// ABOUTME: Provider CLI detection (FR-X-7, §3.1 `agent/` provider adapters) — read-only, backend-
// ABOUTME: side presence + auth-state probing for Claude Code and Copilot (FR-X-9: never a credential).

use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use command_group::CommandGroup;
use serde::{Deserialize, Serialize};

/// How long a probe process gets before Cowrite gives up on it and reports a safe default rather
/// than hanging the onboarding UI (FR-X-5 names "timeout" explicitly as a case to degrade from).
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The two provider CLIs Cowrite detects (TD §3.4). Provider auth is owned by each CLI (FR-X-9) —
/// every probe here only ever reads presence/state, never a credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    ClaudeCode,
    Copilot,
}

impl ProviderId {
    pub const ALL: [ProviderId; 2] = [ProviderId::ClaudeCode, ProviderId::Copilot];

    /// Test-only override (never set in a real install): lets e2e (which runs on a machine that
    /// may itself have `claude`/`copilot` on `PATH`, as any Cowrite dev box does) redirect provider
    /// operations to a deterministic executable without touching the real `PATH` or mocking the
    /// process boundary. Claude spawning shares its adapter's same override (#1206), so detection
    /// and an eventual run cannot disagree about which executable they address.
    fn binary_name(self) -> String {
        match self {
            ProviderId::ClaudeCode => crate::agent::claude::binary(),
            ProviderId::Copilot => {
                env::var("COWRITE_COPILOT_BIN").unwrap_or_else(|_| "copilot".into())
            }
        }
    }
}

/// One provider's onboarding chip state (FR-X-7): not-installed, installed-but-signed-out (folds
/// in auth-expired — same remediation, "sign in again"), or signed-in with the account the CLI
/// itself reports (never a token — FR-X-9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProviderStatus {
    NotInstalled,
    InstalledSignedOut,
    SignedIn { account: Option<String> },
}

/// The result of an auth check on a CLI already known to be installed — separated from
/// `ProviderStatus` so a probe only has to answer the question it was asked; `detect` composes it
/// with the installed check.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AuthProbe {
    SignedOut,
    SignedIn { account: Option<String> },
}

/// Backend-side, read-only provider probing. Split from `detect`/`detect_all` so the state-machine
/// logic (below) is tested against a fake — real CLI presence varies per dev machine, so the state
/// machine itself must not depend on any CLI actually being installed to be testable.
trait ProviderProbe {
    fn is_installed(&self, provider: ProviderId) -> bool;
    fn auth_state(&self, provider: ProviderId) -> AuthProbe;
}

fn detect(provider: ProviderId, probe: &dyn ProviderProbe) -> ProviderStatus {
    if !probe.is_installed(provider) {
        return ProviderStatus::NotInstalled;
    }
    match probe.auth_state(provider) {
        AuthProbe::SignedOut => ProviderStatus::InstalledSignedOut,
        AuthProbe::SignedIn { account } => ProviderStatus::SignedIn { account },
    }
}

/// Every provider's status, in `ProviderId::ALL` order — the whole Writing partners panel's data
/// in one call (J8).
pub fn detect_all() -> Vec<(ProviderId, ProviderStatus)> {
    let probe = CliProviderProbe;
    ProviderId::ALL
        .iter()
        .map(|&p| (p, detect(p, &probe)))
        .collect()
}

// --- PATH lookup (pure — no process spawned, no global env mutated in tests) ---

fn path_dirs(path_value: &str) -> Vec<PathBuf> {
    env::split_paths(path_value).collect()
}

/// Cross-platform "is `binary` on one of `dirs`": Windows resolves bare names against `PATHEXT`-
/// style extensions (checked explicitly here rather than reading `PATHEXT` itself — Cowrite only
/// ever looks for its two known provider binaries, not arbitrary commands); Unix just checks the
/// bare name (execute-bit is not checked — a non-executable file of that name is already a broken
/// install, not Cowrite's to diagnose further here).
fn binary_exists_in(dirs: &[PathBuf], binary: &str) -> bool {
    let candidates: Vec<String> = if cfg!(windows) {
        ["", ".exe", ".cmd", ".bat"]
            .iter()
            .map(|ext| format!("{binary}{ext}"))
            .collect()
    } else {
        vec![binary.to_string()]
    };
    dirs.iter()
        .any(|dir| candidates.iter().any(|name| dir.join(name).is_file()))
}

fn is_installed_impl(path_value: &str, binary: &str) -> bool {
    binary_exists_in(&path_dirs(path_value), binary)
}

// --- Claude Code auth probe: `claude auth status --json` (real subcommand, verified 2.1.212) ---

/// Parses `claude auth status --json`'s documented shape (`{"loggedIn": bool, "email": string,
/// ...}`; extra fields ignored). Any shape that doesn't at least carry `loggedIn: true` reads as
/// signed-out — a probe that can't positively confirm a session must never claim one (FR-X-9).
fn parse_claude_auth_status(json: &str) -> AuthProbe {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return AuthProbe::SignedOut,
    };
    let logged_in = value
        .get("loggedIn")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !logged_in {
        return AuthProbe::SignedOut;
    }
    let account = value
        .get("email")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    AuthProbe::SignedIn { account }
}

// --- Copilot auth probe: no equivalent read-only status subcommand is documented (checked live
// against `copilot --help`/`copilot login --help` at 1.0.69, 2026-07-17) and a headless prompt
// invocation both costs a request and (live-verified) can dispatch to the model — unsuitable for a
// silent, repeatable, window-focus re-check. Approximated via the CLI's own documented headless
// auth precedence (`copilot login --help`): COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN. This
// under-approximates a real `copilot login`-stored session (credential-store-backed, not env-
// based) — tracked as a follow-up spike rather than guessed at here (see PR description). ---

const COPILOT_TOKEN_ENV_VARS: [&str; 3] = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

fn copilot_auth_from_env<F>(get_var: F) -> AuthProbe
where
    F: Fn(&str) -> Option<String>,
{
    let signed_in = COPILOT_TOKEN_ENV_VARS
        .iter()
        .any(|name| get_var(name).is_some_and(|v| !v.is_empty()));
    if signed_in {
        AuthProbe::SignedIn { account: None }
    } else {
        AuthProbe::SignedOut
    }
}

// --- Real probe: spawns the CLIs themselves ---

struct CliProviderProbe;

impl ProviderProbe for CliProviderProbe {
    fn is_installed(&self, provider: ProviderId) -> bool {
        let path_value = env::var("PATH").unwrap_or_default();
        is_installed_impl(&path_value, &provider.binary_name())
    }

    fn auth_state(&self, provider: ProviderId) -> AuthProbe {
        match provider {
            ProviderId::ClaudeCode => {
                match run_bounded(
                    &provider.binary_name(),
                    &["auth", "status", "--json"],
                    PROBE_TIMEOUT,
                ) {
                    Some(output) => {
                        parse_claude_auth_status(&String::from_utf8_lossy(&output.stdout))
                    }
                    None => AuthProbe::SignedOut,
                }
            }
            ProviderId::Copilot => copilot_auth_from_env(|name| env::var(name).ok()),
        }
    }
}

/// Runs `binary args...`, waiting up to `timeout` before killing it and giving up (`None`) rather
/// than blocking the onboarding UI indefinitely (FR-X-5's "timeout" case). `None` also covers a
/// spawn failure (binary vanished between the installed check and this call).
///
/// Spawned via `command_group` (`group_spawn`, matching `agent::session::AgentSession::spawn`,
/// TD-5 "stop = kill child process group") rather than a bare `Command::spawn` — a CLI resolved on
/// Windows as e.g. `claude.cmd` runs via `cmd.exe` -> node, so killing only the direct child on the
/// timeout branch would orphan the node subtree rather than actually stopping the probe.
fn run_bounded(binary: &str, args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // `command_group` sets creation flags on the inner Command at spawn time, replacing any
    // flags set on Command itself. The group builder must receive CREATE_NO_WINDOW so probing a
    // Windows `.cmd` provider shim never opens a console over Cowrite's GUI.
    #[cfg(windows)]
    let mut child = command
        .group()
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    #[cfg(not(windows))]
    let mut child = command.group_spawn().ok()?;

    // Pipes are drained only after exit (below), so a probe writing more than one OS pipe buffer
    // (~64KB) of stdout/stderr before exiting would block on the write and never exit — it would
    // then hit the deadline and degrade to `None` (signed-out). Safe either way, and the only probe
    // routed here (`claude auth status --json`) emits a tiny fixed object, so this stays theoretical.
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            // The process has already exited. `try_wait` here reaps the whole group (the crate's
            // process-group-aware `waitpid(-pgid, WNOHANG)`), so a *second* group-wide reap via
            // `wait_with_output` would race an already-empty group and fail with ECHILD (verified:
            // `command-group` 5.0.1's `wait_with_output` doesn't consult the cached exit status the
            // way `wait`/`try_wait` do). Read the pipes and take the status by hand instead — safe
            // to do sequentially here (no deadlock risk) because the process has already exited, so
            // nothing can still be blocked writing to the pipe this call isn't reading yet.
            Ok(Some(_status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut out) = child.inner().stdout.take() {
                    let _ = out.read_to_end(&mut stdout);
                }
                if let Some(mut err) = child.inner().stderr.take() {
                    let _ = err.read_to_end(&mut stderr);
                }
                let status = child.wait().ok()?;
                return Some(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    // --- detect/detect_all state machine (fake probe — no real CLI required) ---

    struct FakeProbe {
        installed: HashMap<ProviderId, bool>,
        auth: HashMap<ProviderId, AuthProbe>,
    }

    impl FakeProbe {
        fn new() -> Self {
            FakeProbe {
                installed: HashMap::new(),
                auth: HashMap::new(),
            }
        }

        fn not_installed(mut self, p: ProviderId) -> Self {
            self.installed.insert(p, false);
            self
        }

        fn signed_out(mut self, p: ProviderId) -> Self {
            self.installed.insert(p, true);
            self.auth.insert(p, AuthProbe::SignedOut);
            self
        }

        fn signed_in(mut self, p: ProviderId, account: Option<&str>) -> Self {
            self.installed.insert(p, true);
            self.auth.insert(
                p,
                AuthProbe::SignedIn {
                    account: account.map(str::to_string),
                },
            );
            self
        }
    }

    impl ProviderProbe for FakeProbe {
        fn is_installed(&self, provider: ProviderId) -> bool {
            *self.installed.get(&provider).unwrap_or(&false)
        }

        fn auth_state(&self, provider: ProviderId) -> AuthProbe {
            self.auth
                .get(&provider)
                .cloned()
                .unwrap_or(AuthProbe::SignedOut)
        }
    }

    #[test]
    fn a_provider_never_probed_for_auth_because_it_is_not_installed_reports_not_installed() {
        let probe = FakeProbe::new().not_installed(ProviderId::ClaudeCode);
        assert_eq!(
            detect(ProviderId::ClaudeCode, &probe),
            ProviderStatus::NotInstalled
        );
    }

    #[test]
    fn installed_but_signed_out_is_distinct_from_not_installed() {
        let probe = FakeProbe::new().signed_out(ProviderId::ClaudeCode);
        assert_eq!(
            detect(ProviderId::ClaudeCode, &probe),
            ProviderStatus::InstalledSignedOut
        );
    }

    #[test]
    fn signed_in_carries_the_account_the_probe_reported() {
        let probe = FakeProbe::new().signed_in(ProviderId::ClaudeCode, Some("cj@example.com"));
        assert_eq!(
            detect(ProviderId::ClaudeCode, &probe),
            ProviderStatus::SignedIn {
                account: Some("cj@example.com".to_string())
            }
        );
    }

    #[test]
    fn signed_in_with_no_reported_account_still_reads_as_signed_in() {
        let probe = FakeProbe::new().signed_in(ProviderId::Copilot, None);
        assert_eq!(
            detect(ProviderId::Copilot, &probe),
            ProviderStatus::SignedIn { account: None }
        );
    }

    #[test]
    fn zero_providers_installed_reports_not_installed_for_both() {
        let probe = FakeProbe::new()
            .not_installed(ProviderId::ClaudeCode)
            .not_installed(ProviderId::Copilot);
        let all = ProviderId::ALL.map(|p| detect(p, &probe));
        assert_eq!(
            all,
            [ProviderStatus::NotInstalled, ProviderStatus::NotInstalled]
        );
    }

    #[test]
    fn each_provider_is_probed_independently() {
        // One installed+signed-in, the other genuinely absent — not a shared/global result.
        let probe = FakeProbe::new()
            .signed_in(ProviderId::ClaudeCode, Some("cj@example.com"))
            .not_installed(ProviderId::Copilot);
        assert_eq!(
            detect(ProviderId::ClaudeCode, &probe),
            ProviderStatus::SignedIn {
                account: Some("cj@example.com".to_string())
            }
        );
        assert_eq!(
            detect(ProviderId::Copilot, &probe),
            ProviderStatus::NotInstalled
        );
    }

    // --- PATH lookup (pure — injected PATH string, no global env mutation) ---

    #[test]
    fn a_binary_present_in_a_path_directory_is_installed() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("claude"), b"#!/bin/sh\n").unwrap();
        assert!(is_installed_impl(&dir.path().to_string_lossy(), "claude"));
    }

    #[test]
    fn a_binary_absent_from_every_path_directory_is_not_installed() {
        let dir = TempDir::new().unwrap();
        assert!(!is_installed_impl(&dir.path().to_string_lossy(), "claude"));
    }

    #[test]
    fn a_binary_found_in_a_later_path_directory_still_counts() {
        let empty = TempDir::new().unwrap();
        let with_binary = TempDir::new().unwrap();
        std::fs::write(with_binary.path().join("copilot"), b"#!/bin/sh\n").unwrap();
        let joined = env::join_paths([empty.path(), with_binary.path()]).unwrap();
        assert!(is_installed_impl(&joined.to_string_lossy(), "copilot"));
    }

    #[test]
    fn an_empty_path_value_is_not_installed_rather_than_a_panic() {
        assert!(!is_installed_impl("", "claude"));
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_a_dot_exe_suffixed_binary_still_resolves_the_bare_name() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("claude.exe"), b"").unwrap();
        assert!(is_installed_impl(&dir.path().to_string_lossy(), "claude"));
    }

    // --- Claude auth-status JSON parsing (pure — real captured shape, 2026-07-17 live check) ---

    #[test]
    fn a_logged_in_status_reports_signed_in_with_the_email() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"cj@example.com","orgId":"x","orgName":"x","subscriptionType":"max"}"#;
        assert_eq!(
            parse_claude_auth_status(json),
            AuthProbe::SignedIn {
                account: Some("cj@example.com".to_string())
            }
        );
    }

    #[test]
    fn a_logged_out_status_reports_signed_out() {
        assert_eq!(
            parse_claude_auth_status(r#"{"loggedIn":false}"#),
            AuthProbe::SignedOut
        );
    }

    #[test]
    fn a_logged_in_status_missing_email_still_reports_signed_in_with_no_account() {
        assert_eq!(
            parse_claude_auth_status(r#"{"loggedIn":true}"#),
            AuthProbe::SignedIn { account: None }
        );
    }

    #[test]
    fn malformed_json_reports_signed_out_never_a_false_positive() {
        assert_eq!(parse_claude_auth_status("not json"), AuthProbe::SignedOut);
    }

    #[test]
    fn an_empty_object_reports_signed_out() {
        assert_eq!(parse_claude_auth_status("{}"), AuthProbe::SignedOut);
    }

    // --- Copilot env-token approximation (pure — injected lookup, no global env mutation) ---

    #[test]
    fn no_recognized_token_env_var_reports_signed_out() {
        assert_eq!(copilot_auth_from_env(|_| None), AuthProbe::SignedOut);
    }

    #[test]
    fn a_copilot_github_token_reports_signed_in_with_no_known_account() {
        let result = copilot_auth_from_env(|name| {
            (name == "COPILOT_GITHUB_TOKEN").then(|| "token-value".to_string())
        });
        assert_eq!(result, AuthProbe::SignedIn { account: None });
    }

    #[test]
    fn gh_token_alone_also_reports_signed_in_per_the_documented_precedence() {
        let result =
            copilot_auth_from_env(|name| (name == "GH_TOKEN").then(|| "token-value".to_string()));
        assert_eq!(result, AuthProbe::SignedIn { account: None });
    }

    #[test]
    fn an_empty_token_value_does_not_count_as_signed_in() {
        let result = copilot_auth_from_env(|name| (name == "GH_TOKEN").then(String::new));
        assert_eq!(result, AuthProbe::SignedOut);
    }

    // --- Bounded process execution ---

    #[test]
    fn a_nonexistent_binary_returns_none_rather_than_panicking() {
        assert!(run_bounded(
            "cowrite-test-binary-does-not-exist",
            &[],
            Duration::from_millis(200)
        )
        .is_none());
    }

    #[test]
    fn a_binary_that_exits_quickly_returns_its_output() {
        let bin = if cfg!(windows) { "cmd" } else { "echo" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "echo", "hi"]
        } else {
            &["hi"]
        };
        let output = run_bounded(bin, args, Duration::from_secs(2)).unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("hi"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cmd_probe_has_no_visible_console() {
        if std::env::var_os("COWRITE_PROBE_CONSOLE_PARENT").is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "agent::providers::tests::windows_cmd_probe_has_no_visible_console",
                    "--nocapture",
                ])
                .env("COWRITE_PROBE_CONSOLE_PARENT", "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
        if unsafe { GetConsoleWindow() }.is_null() && unsafe { AllocConsole() } == 0 {
            eprintln!("interactive console unavailable; native console inheritance check skipped");
            return;
        }
        assert!(!unsafe { GetConsoleWindow() }.is_null());

        let dir = TempDir::new().unwrap();
        let shim = dir.path().join("claude.cmd");
        let test_exe = std::env::current_exe().unwrap();
        std::fs::write(
            &shim,
            format!(
                "@echo off\r\nset COWRITE_PROBE_CONSOLE_CHILD=1\r\n\"{}\" --exact agent::providers::tests::probe_console_visibility_child --nocapture\r\n",
                test_exe.display()
            ),
        )
        .unwrap();

        let output = run_bounded(shim.to_str().unwrap(), &[], Duration::from_secs(10)).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("COWRITE_PROBE_HAS_CONSOLE=false"),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[cfg(windows)]
    #[test]
    fn probe_console_visibility_child() {
        if std::env::var_os("COWRITE_PROBE_CONSOLE_CHILD").is_none() {
            return;
        }
        use windows_sys::Win32::System::Console::GetConsoleWindow;
        let console = unsafe { GetConsoleWindow() };
        println!("COWRITE_PROBE_HAS_CONSOLE={}", !console.is_null());
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_that_outlives_the_timeout_is_killed_and_reported_as_none() {
        let start = Instant::now();
        let result = run_bounded("sh", &["-c", "sleep 5"], Duration::from_millis(200));
        assert!(result.is_none());
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "should not wait out the full sleep"
        );
    }

    // Regression test for the reviewed Important finding (T5, TD-5): a bare `Command::kill` only
    // reaps the *direct* child, orphaning anything that child itself spawned. Here `sh`'s direct
    // pid is the deadline-killed one, but it detaches a backgrounded grandchild job first, which
    // (with job control off, the default for a non-interactive `sh -c`) stays in the *same*
    // process group rather than getting its own — exactly the shape a real CLI resolved via a
    // wrapper (e.g. Windows' `claude.cmd` -> `cmd.exe` -> node) has. A group-wide kill (this
    // module's `group_spawn`/`kill`) must take the grandchild down with it; a direct-child-only
    // kill would leave it running, and it would touch `marker` ~1s later once the fix regresses.
    #[cfg(unix)]
    #[test]
    fn timing_out_kills_the_whole_process_group_not_just_the_direct_child() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("orphan-survived");
        let script = format!("(sleep 1 && touch {}) & sleep 30", marker.display());
        let result = run_bounded("sh", &["-c", &script], Duration::from_millis(200));
        assert!(result.is_none());

        thread::sleep(Duration::from_millis(1500));
        assert!(
            !marker.exists(),
            "a backgrounded grandchild survived the timeout kill and wrote its marker \
             (group-wide kill regressed to a direct-child-only kill)"
        );
    }
}
