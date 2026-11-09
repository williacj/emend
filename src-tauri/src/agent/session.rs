// ABOUTME: Agent session lifecycle (TD-5) — spawn a CLI headless, stream its stdout events into
// ABOUTME: the J1 activity feed, and stop = kill the whole child process group.

//! The spawn/stream/stop lifecycle shared by every provider adapter (today: Claude Code,
//! `agent::claude`). Kept provider-agnostic over a plain `program + argv`: the adapter module owns
//! *what* to spawn, this module owns *how* to run it.
//!
//! **Stop-safety rides TD-1/FR-AGENT-6 by architecture, not by anything in this module.** Nothing
//! ever lands on a document unless `propose_changes` was called and completed over the MCP server
//! (`agent::mcp`) — so killing the child at any point, even mid-stream, leaves every open document
//! byte-identical. [`AgentSession::saw_propose_changes`] only *observes* that fact (for tests and
//! UI); it plays no role in enforcing it.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use command_group::{CommandGroup, GroupChild};
use serde_json::Value;

use super::activity::{activity_lines, ActivityLine};
use super::claude::MCP_SERVER_NAME;
use super::reply::{provider_error_text, reply_text, successful_result, unusable_resumed_session};

/// The `mcp__cowrite__<tool>` name the stream carries for our own `propose_changes` tool calls
/// (`agent::claude::MCP_SERVER_NAME`, `agent::activity`).
const PROPOSE_CHANGES_TOOL: &str = "mcp__cowrite__propose_changes";

/// Maximum stderr bytes retained for a failed run. The reader drains concurrently, retaining
/// only its newest tail; fatal diagnostics conventionally land last.
const STDERR_TAIL_LIMIT: usize = 16 * 1024;

/// A provider that closed stdout normally gets this bounded window to finish exiting before the
/// process group is contained. This avoids classifying our own cleanup kill as the provider's exit
/// while retaining the old guarantee that a lingering descendant cannot strand queue progress.
const EXIT_AFTER_STDOUT_GRACE: Duration = Duration::from_secs(1);

/// Limit the final drain even if a surviving inherited writer continuously fills the pipe.
const STDERR_FINISH_GRACE: Duration = Duration::from_millis(100);

/// TD-1 §3.2's *delivery* tools: the calls through which a run lands tracked changes
/// (`propose_changes`) or comments (`add_comments`, `reply_to_comment`) on a document — the ones
/// that give a run its own change-set or comment card in the timeline
/// ([`AgentSession::saw_delivery`], #1118). Spelled on the wire under the same
/// `mcp__cowrite__<tool>` convention `PROPOSE_CHANGES_TOOL` above and
/// `agent::activity::line_for_mcp_tool` already read — announced as an `assistant` `tool_use`
/// block. That convention, not a recording, is the ground here: SPIKE-1 exercised no MCP tool call
/// at all (its gap #7, `docs/formats/provider-contract/README.md`), so nothing in the repo records
/// a real CLI emitting one.
///
/// The rest of the §3.2 surface is deliberately absent, and each for its own reason:
/// `get_document_state`/`list_documents` only read, `permission_request` only asks, and
/// `create_document`'s J2 Phase B birth card reports a *completed* direct write (D3) rather than a
/// change set awaiting triage — CJ's ruling names tracked changes and comments, and this list says
/// exactly that and no more.
const DELIVERY_TOOLS: [&str; 3] = [
    PROPOSE_CHANGES_TOOL,
    "mcp__cowrite__add_comments",
    "mcp__cowrite__reply_to_comment",
];

/// One parsed line from the child's stream-JSON stdout: the raw event value plus the J1 activity
/// feed lines it produced (`agent::activity`).
#[derive(Debug, Clone)]
pub struct StreamEvent {
    pub value: Value,
    pub activity: Vec<ActivityLine>,
}

/// A spawned, running (or exited) agent process. Owns the whole child **process group** — a
/// Windows job object or POSIX process group via `command_group` — so
/// [`stop`](AgentSession::stop) kills every descendant the CLI itself may have spawned, not just
/// the immediate child (TD-5 "stop = kill child process group").
///
/// The child handle is behind an `Arc<Mutex<_>>` (rather than owned outright) so
/// [`kill_handle`](Self::kill_handle) can hand out a cheap, `Send + Sync` way to kill the group
/// from a thread other than whichever one is parked in [`next_event`](Self::next_event)'s blocking
/// read — `agent::run_queue`'s `stop` path runs on the IPC-command thread while a background
/// thread drains the stream, and those must not contend with each other (a plain `Mutex<Self>`
/// would deadlock: the reader would hold it for the whole blocking read). `stdout` stays outside
/// the mutex for the same reason: only the reader ever touches it, so it needs no synchronization.
pub struct AgentSession {
    child: Arc<Mutex<GroupChild>>,
    stdout: BufReader<ChildStdout>,
    stderr: StderrReader,
    project_root: PathBuf,
    /// The provider's own session id, captured off the `system/init` event — the value a later
    /// spawn passes back as `--resume` for D4 continuity.
    session_id: Option<String>,
    /// `claude_code_version` off the same `system/init` event (TD §3.4 version-detect).
    provider_version: Option<String>,
    /// Whether a `propose_changes` MCP tool call has been observed anywhere in the stream so far.
    saw_propose_changes: bool,
    /// Whether any [`DELIVERY_TOOLS`] call — tracked changes *or* comments — has been observed
    /// anywhere in the stream so far (a superset of `saw_propose_changes`).
    saw_delivery: bool,
    /// The agent's prose answer for this turn (`agent::reply`), captured off the terminal `result`
    /// event — what `agent::run_queue` carries out on the run's `Completed` phase so the timeline
    /// can render it as an agent chat message (#1118, J2, Principle 5).
    reply: Option<String>,
    /// Whether this process was spawned with a saved provider session identity.
    resume_attempted: bool,
    /// The provider's terminal failure reason, when its result says the turn did not succeed.
    provider_error: Option<String>,
    /// Positive provider-result evidence that the saved resume identity is unusable.
    resume_rejected: bool,
    /// Whether the stream carried the provider's successful terminal result for this turn.
    completed_successfully: bool,
    /// Completion of the dedicated prompt writer. A write failure kills the process group so a
    /// blocked stdout read wakes, then [`next_event`](Self::next_event) routes the failure to the
    /// run queue's terminal `Failed` phase.
    stdin_result: Option<Receiver<std::io::Result<()>>>,
}

/// Why spawning an agent process failed.
#[derive(Debug)]
pub enum SessionError {
    Spawn(std::io::Error),
    /// The child was spawned without a piped stdout — every real spawn asks for one; this is an
    /// internal-only error.
    NoStdout,
    /// The child was spawned without a piped stderr — every real spawn asks for one; this is an
    /// internal-only error.
    NoStderr,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Spawn(e) => write!(f, "spawning agent process: {e}"),
            SessionError::NoStdout => write!(f, "spawned agent process has no stdout pipe"),
            SessionError::NoStderr => write!(f, "spawned agent process has no stderr pipe"),
        }
    }
}

impl std::error::Error for SessionError {}

impl AgentSession {
    /// Spawns `program args…` with `cwd` as its working directory, as its own process group,
    /// stdout piped (parsed line-by-line by [`next_event`](Self::next_event)). Stdin is closed
    /// (`Stdio::null`); provider turns that consume a prompt there use
    /// [`spawn_with_stdin`](Self::spawn_with_stdin). Stderr is piped to a dedicated reader thread,
    /// which drains it concurrently so a chatty child cannot fill the OS pipe and deadlock the
    /// stdout reader. Retention is bounded to [`STDERR_TAIL_LIMIT`]; successful-run chatter is
    /// discarded when the child is reaped, while an unsuccessful exit can carry its diagnostic to
    /// the run queue's existing `Failed` phase.
    pub fn spawn(program: &str, args: &[String], cwd: &Path) -> Result<AgentSession, SessionError> {
        Self::spawn_inner(program, args, cwd, None, false)
    }

    /// Spawns a provider turn with `input` delivered verbatim through stdin, then closes the pipe
    /// so the provider can begin the turn. Keeping prompt bytes out of argv avoids the platform
    /// command-line ceilings that large quoted selections can otherwise exceed (D13 / FR-X-1,
    /// FR-CHAT-3).
    ///
    /// Prompt delivery runs on a dedicated writer thread. This method therefore returns the
    /// session and its process-group [`KillHandle`] without waiting for the child to drain the
    /// bounded stdin pipe (FR-X-3, TD-5); Stop remains available even when a provider never reads.
    /// A write failure kills the group and surfaces through [`next_event`](Self::next_event), where
    /// the run queue records it as an honest terminal failure.
    pub fn spawn_with_stdin(
        program: &str,
        args: &[String],
        cwd: &Path,
        input: &[u8],
    ) -> Result<AgentSession, SessionError> {
        Self::spawn_inner(program, args, cwd, Some(input), false)
    }

    /// Provider-turn variant that records whether the adapter supplied a saved resume identity.
    /// The queue uses this fact only together with positive stale-session result evidence.
    pub fn spawn_provider_turn_with_stdin(
        program: &str,
        args: &[String],
        cwd: &Path,
        input: &[u8],
        resume_attempted: bool,
    ) -> Result<AgentSession, SessionError> {
        Self::spawn_inner(program, args, cwd, Some(input), resume_attempted)
    }

    fn spawn_inner(
        program: &str,
        args: &[String],
        cwd: &Path,
        input: Option<&[u8]>,
        resume_attempted: bool,
    ) -> Result<AgentSession, SessionError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.group_spawn().map_err(SessionError::Spawn)?;
        let stdin = input.map(|_| {
            child
                .inner()
                .stdin
                .take()
                .expect("stdin was requested as a pipe")
        });
        let stdout = match child.inner().stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::NoStdout);
            }
        };
        let stderr = match child.inner().stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::NoStderr);
            }
        };
        let stderr_redactions = stderr_redactions(args);
        let stderr = match StderrReader::spawn(stderr, stderr_redactions) {
            Ok(stderr) => stderr,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::Spawn(error));
            }
        };
        let child = Arc::new(Mutex::new(child));
        let stdin_result = if let (Some(mut stdin), Some(input)) = (stdin, input) {
            let input = input.to_vec();
            let kill = KillHandle(Arc::clone(&child));
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let result = stdin.write_all(&input);
                let write_failed = result.is_err();
                let _ = sender.send(result);
                if write_failed {
                    // Wake a reader parked on stdout so it can observe and route the write error.
                    let _ = kill.kill();
                }
            });
            Some(receiver)
        } else {
            None
        };
        Ok(AgentSession {
            child,
            stdout: BufReader::new(stdout),
            stderr,
            project_root: cwd.to_path_buf(),
            session_id: None,
            provider_version: None,
            saw_propose_changes: false,
            saw_delivery: false,
            reply: None,
            resume_attempted,
            provider_error: None,
            resume_rejected: false,
            completed_successfully: false,
            stdin_result,
        })
    }

    /// A cheap, cloneable handle that can kill this session's whole process group from any thread
    /// (see the struct docs) — obtain it before handing the session off to whichever thread will
    /// drive [`next_event`](Self::next_event) in a loop.
    pub fn kill_handle(&self) -> KillHandle {
        KillHandle(Arc::clone(&self.child))
    }

    /// Reads and parses the next stream-JSON line, folding it into this session's tracked state
    /// ([`session_id`](Self::session_id), [`provider_version`](Self::provider_version),
    /// [`saw_propose_changes`](Self::saw_propose_changes)) and deriving its J1 activity-feed lines.
    /// Returns `Ok(None)` at end-of-stream (the child closed stdout — normal on exit).
    ///
    /// A line that isn't valid JSON is skipped, not fatal: the misbehavior repertoire's
    /// malformed-output case (test-plan §1) is exactly this — the consumer's parser must survive
    /// it, not crash the session.
    pub fn next_event(&mut self) -> std::io::Result<Option<StreamEvent>> {
        loop {
            self.check_stdin_writer()?;
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line)?;
            self.check_stdin_writer()?;
            if n == 0 {
                self.settle_stdin_writer()?;
                return Ok(None);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            fold_init_field(&value, "session_id", &mut self.session_id);
            fold_init_field(&value, "claude_code_version", &mut self.provider_version);
            check_cowrite_binding(&value)?;
            if is_propose_changes_call(&value) {
                self.saw_propose_changes = true;
            }
            if is_delivery_call(&value) {
                self.saw_delivery = true;
            }
            if let Some(text) = reply_text(&value) {
                self.reply = Some(text);
            }
            if let Some(error) = provider_error_text(&value) {
                self.provider_error = Some(error);
            }
            if self.resume_attempted && unusable_resumed_session(&value) {
                self.resume_rejected = true;
            }
            if successful_result(&value) {
                self.completed_successfully = true;
            }
            let activity = activity_lines(&value, &self.project_root);
            return Ok(Some(StreamEvent { value, activity }));
        }
    }

    fn check_stdin_writer(&mut self) -> std::io::Result<()> {
        let Some(receiver) = &self.stdin_result else {
            return Ok(());
        };
        let result = match receiver.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Disconnected) => Err(std::io::Error::other(
                "agent prompt writer stopped unexpectedly",
            )),
        };
        self.stdin_result = None;
        result.map_err(stdin_error)
    }

    /// At stdout EOF the run queue is about to stop and reap the process anyway. Kill first so a
    /// writer blocked on a full stdin pipe wakes, then collect its result before EOF can be
    /// mistaken for a successful turn. This makes early provider exit deterministically fail.
    fn settle_stdin_writer(&mut self) -> std::io::Result<()> {
        let Some(receiver) = self.stdin_result.take() else {
            return Ok(());
        };
        let _ = self.kill_handle().kill();
        let result = receiver.recv().unwrap_or_else(|_| {
            Err(std::io::Error::other(
                "agent prompt writer stopped unexpectedly",
            ))
        });
        result.map_err(stdin_error)
    }

    /// The provider's own session id, once a `system/init` event has been seen — pass this back
    /// as `resume_session_id` on the next spawn to continue this same provider session (D4).
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// The CLI version reported at `system/init` (feed to `agent::claude::version_warning` for
    /// the TD §3.4 version-drift check).
    pub fn provider_version(&self) -> Option<&str> {
        self.provider_version.as_deref()
    }

    /// Whether a `propose_changes` MCP tool call has been observed in the stream so far.
    pub fn saw_propose_changes(&self) -> bool {
        self.saw_propose_changes
    }

    /// Whether this run has *announced* a delivery — a tracked-change or comment tool call
    /// ([`DELIVERY_TOOLS`]) seen in the stream. The announcement, not the outcome, is deliberately
    /// what this observes: `agent::run_queue` retains it as J7's conservative stopped-run
    /// approximation because a stop can race the MCP boundary (#1404).
    ///
    /// Completed-run reply suppression uses the separate persisted outcome reported by
    /// `RunObserver::delivery_landed`, so an announced delivery that the MCP boundary refuses or
    /// that lands nothing does not suppress [`reply`](Self::reply) (#1118, #1420).
    pub fn saw_delivery(&self) -> bool {
        self.saw_delivery
    }

    /// The agent's answer for this turn, once its terminal `result` event has been read
    /// (`agent::reply`) — `None` while the turn is still in flight, and for a turn that produced
    /// no prose. `agent::run_queue` reads it at end-of-stream and carries it out on the run's
    /// `Completed` phase (#1118).
    pub fn reply(&self) -> Option<&str> {
        self.reply.as_deref()
    }

    pub fn provider_error(&self) -> Option<&str> {
        self.provider_error.as_deref()
    }

    pub fn resume_rejected(&self) -> bool {
        self.resume_rejected
    }

    pub fn completed_successfully(&self) -> bool {
        self.completed_successfully
    }

    /// Stop = kill the whole child process group (TD-5). Safe unconditionally — nothing has
    /// landed on any document unless `propose_changes` completed over the MCP server
    /// (TD-1/FR-AGENT-6 by architecture); this call does not need to consult
    /// [`saw_propose_changes`](Self::saw_propose_changes) first. Waits for the group to finish
    /// exiting so the child (and anything it spawned) is fully reaped before returning.
    pub fn stop(self) -> std::io::Result<SessionExit> {
        let status = {
            let mut child = lock_child(&self.child);
            // Killing an already-exited group returns an `InvalidInput` error (stdlib contract) —
            // a clean exit racing a caller's stop is not itself a failure to report.
            let _ = child.kill();
            child.wait()?
        };
        self.collect_exit(status, false)
    }

    /// Reaps a session after its stdout stream reached EOF. Unlike [`stop`](Self::stop), this lets
    /// a normally exiting provider report its own status before sending a containment kill. The
    /// wait is bounded so a descendant that inherited the process group's descriptors cannot
    /// prevent this run or the queue behind it from resolving.
    pub fn reap(self) -> std::io::Result<SessionExit> {
        let deadline = Instant::now() + EXIT_AFTER_STDOUT_GRACE;
        let (status, forced_after_stdout) = loop {
            let status = { lock_child(&self.child).try_wait()? };
            if let Some(status) = status {
                // `command-group` can report the leader's cached exit while another group member
                // still owns an inherited stderr descriptor. Preserve the leader's own status,
                // but request group cleanup before finishing the independently bounded reader.
                let _ = lock_child(&self.child).kill();
                break (status, false);
            }
            if Instant::now() >= deadline {
                let status = {
                    let mut child = lock_child(&self.child);
                    let _ = child.kill();
                    child.wait()?
                };
                break (status, true);
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        self.collect_exit(status, forced_after_stdout)
    }

    fn collect_exit(
        self,
        status: ExitStatus,
        forced_after_stdout: bool,
    ) -> std::io::Result<SessionExit> {
        let stderr = self.stderr.finish()?;
        Ok(SessionExit {
            status,
            stderr,
            forced_after_stdout,
        })
    }

    /// True once the child process has exited (non-blocking).
    pub fn has_exited(&mut self) -> std::io::Result<bool> {
        Ok(lock_child(&self.child).try_wait()?.is_some())
    }
}

/// The process leader's exit facts, available after group cleanup and bounded stderr collection.
pub struct SessionExit {
    status: ExitStatus,
    stderr: StderrTail,
    forced_after_stdout: bool,
}

impl SessionExit {
    /// A reason for the run queue's existing `Failed` phase when the process itself did not exit
    /// successfully. Stderr is ignored on success because providers routinely write harmless
    /// warnings and connection diagnostics there.
    pub fn failure_message(&self) -> Option<String> {
        if self.status.success() && !self.forced_after_stdout {
            return None;
        }
        let retained: Vec<u8> = self.stderr.bytes.iter().copied().collect();
        let stderr = String::from_utf8_lossy(&retained).trim().to_string();
        let status = if self.forced_after_stdout {
            "agent process did not exit after closing stdout".to_string()
        } else {
            format!("agent process exited unsuccessfully ({})", self.status)
        };
        if stderr.is_empty() {
            Some(status)
        } else if self.stderr.omitted == 0 {
            Some(format!("{status}: {stderr}"))
        } else {
            Some(format!(
                "{status}; {} earlier stderr bytes omitted: {stderr}",
                self.stderr.omitted
            ))
        }
    }
}

struct StderrTail {
    bytes: VecDeque<u8>,
    omitted: usize,
}

impl StderrTail {
    fn new() -> Self {
        Self {
            bytes: VecDeque::with_capacity(STDERR_TAIL_LIMIT),
            omitted: 0,
        }
    }

    fn retain(&mut self, chunk: &[u8]) {
        self.retain_with_limit(chunk, STDERR_TAIL_LIMIT);
    }

    fn retain_with_limit(&mut self, chunk: &[u8], limit: usize) {
        if chunk.len() >= limit {
            self.omitted += self.bytes.len() + chunk.len() - limit;
            self.bytes.clear();
            self.bytes.extend(&chunk[chunk.len() - limit..]);
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(limit);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.omitted += overflow;
        }
        self.bytes.extend(chunk);
    }
}

/// Owns a cancellable reader: every finish/drop requests a bounded final drain and joins it.
/// A surviving inherited writer must never keep a session or an abandoned reader alive.
struct StderrReader {
    finish: mpsc::Sender<()>,
    thread: Option<JoinHandle<std::io::Result<StderrTail>>>,
}

impl StderrReader {
    fn spawn(stderr: ChildStderr, redactions: Vec<String>) -> std::io::Result<Self> {
        let stderr = StderrPipe::new(stderr)?;
        let (finish, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || drain_stderr(stderr, &redactions, Some(&receiver)));
        Ok(Self {
            finish,
            thread: Some(thread),
        })
    }

    fn finish(mut self) -> std::io::Result<StderrTail> {
        let _ = self.finish.send(());
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| std::io::Error::other("agent stderr reader stopped unexpectedly"))?
    }
}

impl Drop for StderrReader {
    fn drop(&mut self) {
        let _ = self.finish.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct StderrPipe(ChildStderr);

impl StderrPipe {
    fn new(stderr: ChildStderr) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: stderr owns this live descriptor throughout both calls; existing flags stay set.
            let flags = unsafe { libc::fcntl(stderr.as_raw_fd(), libc::F_GETFL) };
            if flags == -1
                || unsafe {
                    libc::fcntl(stderr.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
                } == -1
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(Self(stderr))
    }
}

impl Read for StderrPipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};
            let mut available = 0;
            // SAFETY: the owned pipe handle is live and `available` is writable; no buffer is requested.
            let peeked = unsafe {
                PeekNamedPipe(
                    self.0.as_raw_handle(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if peeked == 0 {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    Ok(0)
                } else {
                    Err(error)
                };
            }
            if available == 0 {
                return Err(std::io::ErrorKind::WouldBlock.into());
            }
            // This is the pipe's only reader, so bytes observed by PeekNamedPipe cannot disappear.
            let length = buf.len().min(available as usize);
            self.0.read(&mut buf[..length])
        }
        #[cfg(unix)]
        self.0.read(buf)
    }
}

fn drain_stderr(
    mut stderr: impl Read,
    redactions: &[String],
    finish: Option<&Receiver<()>>,
) -> std::io::Result<StderrTail> {
    let mut tail = StderrTail::new();
    // Keep enough extra prefix to ensure a secret crossing the final-tail boundary is present in
    // full when replacements run. The published capture is still reduced to STDERR_TAIL_LIMIT.
    let capture_limit =
        STDERR_TAIL_LIMIT + redactions.iter().map(String::len).max().unwrap_or_default();
    let mut chunk = [0_u8; 8192];
    let mut deadline = None;
    loop {
        if let Some(finish) = finish {
            if deadline.is_none() && !matches!(finish.try_recv(), Err(TryRecvError::Empty)) {
                deadline = Some(Instant::now() + STDERR_FINISH_GRACE);
            }
        }
        let read = if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            0
        } else {
            match stderr.read(&mut chunk) {
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if deadline.is_some() {
                        0
                    } else {
                        if let Some(finish) = finish {
                            if !matches!(
                                finish.recv_timeout(Duration::from_millis(5)),
                                Err(mpsc::RecvTimeoutError::Timeout)
                            ) {
                                deadline = Some(Instant::now() + STDERR_FINISH_GRACE);
                            }
                        }
                        continue;
                    }
                }
                Err(error) => return Err(error),
            }
        };
        if read == 0 {
            let retained: Vec<u8> = tail.bytes.iter().copied().collect();
            let mut text = String::from_utf8_lossy(&retained).into_owned();
            for secret in redactions {
                text = text.replace(secret, "<redacted>");
            }
            let omitted = tail.omitted;
            let mut redacted = StderrTail::new();
            redacted.omitted = omitted;
            redacted.retain(text.as_bytes());
            return Ok(redacted);
        }
        tail.retain_with_limit(&chunk[..read], capture_limit);
    }
}

fn stderr_redactions(args: &[String]) -> Vec<String> {
    let mut secrets = Vec::new();
    for arg in args {
        if let Ok(value) = serde_json::from_str::<Value>(arg) {
            collect_sensitive_values(&value, &mut secrets);
        }
    }
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    secrets.dedup();
    secrets
}

fn collect_sensitive_values(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let normalized: String = key
                    .chars()
                    .filter(|ch| ch.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect();
                if matches!(
                    normalized.as_str(),
                    "authorization" | "apikey" | "password" | "secret" | "token"
                ) {
                    if let Some(secret) = value.as_str().filter(|secret| !secret.is_empty()) {
                        secrets.push(secret.to_string());
                        if let Some(token) = secret.strip_prefix("Bearer ") {
                            if !token.is_empty() {
                                secrets.push(token.to_string());
                            }
                        }
                    }
                } else {
                    collect_sensitive_values(value, secrets);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_sensitive_values(value, secrets);
            }
        }
        _ => {}
    }
}

/// A cheap, cloneable, `Send + Sync` handle that can kill an [`AgentSession`]'s whole process
/// group from a thread other than the one draining its stream (`agent::run_queue`'s `stop` path —
/// see the struct docs on why this is split out rather than requiring the whole session).
#[derive(Clone)]
pub struct KillHandle(Arc<Mutex<GroupChild>>);

impl KillHandle {
    /// Kill the whole process group (TD-5). Idempotent: killing an already-exited group is a
    /// harmless no-op, matching [`AgentSession::stop`]'s own contract — a caller never needs to
    /// check the session's state first.
    pub fn kill(&self) -> std::io::Result<()> {
        match lock_child(&self.0).kill() {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
            Err(e) => Err(e),
        }
    }
}

fn lock_child(child: &Mutex<GroupChild>) -> std::sync::MutexGuard<'_, GroupChild> {
    child
        .lock()
        .expect("agent session child mutex is never poisoned")
}

fn stdin_error(error: std::io::Error) -> std::io::Error {
    let kind = error.kind();
    std::io::Error::new(kind, format!("writing agent prompt to stdin: {error}"))
}

/// Captures a string `field` off a `system/init` event into `slot`, once — used for both
/// `session_id` and `claude_code_version`, the two facts this session needs out of that one
/// bootstrap event. Later events (which for `session_id` also carry the same, unchanged value)
/// never overwrite an already-captured slot.
fn fold_init_field(event: &Value, field: &str, slot: &mut Option<String>) {
    if slot.is_some() || !is_system_init(event) {
        return;
    }
    if let Some(v) = event.get(field).and_then(Value::as_str) {
        *slot = Some(v.to_string());
    }
}

/// The provider inventory is optional in the stream contract. Once advertised, every Cowrite
/// entry must establish a connected binding before the required document tools can be used.
fn check_cowrite_binding(event: &Value) -> std::io::Result<()> {
    if !is_system_init(event) {
        return Ok(());
    }
    let Some(inventory) = event.get("mcp_servers") else {
        return Ok(());
    };
    let failure =
        || std::io::Error::other("The agent could not connect to Cowrite's document tools.");
    let servers = inventory.as_array().ok_or_else(failure)?;
    let mut found = false;
    for server in servers {
        if server.get("name").and_then(Value::as_str) != Some(MCP_SERVER_NAME) {
            continue;
        }
        found = true;
        if server.get("status").and_then(Value::as_str) != Some("connected") {
            return Err(failure());
        }
    }
    if found {
        Ok(())
    } else {
        Err(failure())
    }
}

fn is_system_init(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("system")
        && event.get("subtype").and_then(Value::as_str) == Some("init")
}

/// The tool names announced by `event`, which is a call only when it is an `assistant` message
/// envelope carrying `tool_use` blocks (`agent::activity`'s `mcp__cowrite__<tool>` naming
/// convention). Every other event — including a `user` envelope's `tool_result`, and prose that
/// merely names a tool — announces nothing.
fn announced_tools(event: &Value) -> impl Iterator<Item = &str> {
    let blocks = if event.get("type").and_then(Value::as_str) == Some("assistant") {
        event["message"]["content"].as_array().map(Vec::as_slice)
    } else {
        None
    };
    blocks.unwrap_or_default().iter().filter_map(|block| {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            return None;
        }
        block.get("name").and_then(Value::as_str)
    })
}

/// True iff `event` announces a `propose_changes` MCP tool call.
fn is_propose_changes_call(event: &Value) -> bool {
    announced_tools(event).any(|tool| tool == PROPOSE_CHANGES_TOOL)
}

/// True iff `event` announces a call that lands tracked changes or comments ([`DELIVERY_TOOLS`]).
fn is_delivery_call(event: &Value) -> bool {
    announced_tools(event).any(|tool| DELIVERY_TOOLS.contains(&tool))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Uses the same Rust-created ChildStderr handles as production on both Unix and Windows.
    /// The fixture flushes its bytes before readiness, then keeps the writer open on a stdin read.
    fn with_open_stderr_writer<T: Send + 'static>(
        payload: &str,
        assertion: &str,
        collect: impl FnOnce(ChildStderr) -> T + Send + 'static,
    ) -> T {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "agent::session::tests::stderr_pipe_writer_fixture",
                "--nocapture",
            ])
            .env("EMEND_STDERR_FIXTURE_PAYLOAD", payload)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(
                stdout.read_line(&mut line).unwrap(),
                0,
                "stderr writer fixture must become ready"
            );
            if line.trim() == "STDERR_WRITER_READY" {
                break;
            }
        }
        let (done, completed) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = done.send(collect(stderr));
        });
        let result = completed.recv_timeout(Duration::from_secs(2));
        let writer_was_open = child.try_wait().unwrap().is_none();
        // A broken blocking reader is released before asserting, so the red test leaves no worker.
        child.kill().unwrap();
        child.wait().unwrap();
        worker.join().unwrap();
        assert!(
            writer_was_open,
            "the real child must keep its stderr writer open throughout collection"
        );
        result.expect(assertion)
    }

    #[test]
    fn stderr_finish_is_bounded_with_a_real_open_empty_pipe() {
        let tail = with_open_stderr_writer("", "finish must return within two seconds while the real stderr writer remains open and empty", |stderr| {
            StderrReader::spawn(stderr, vec![]).unwrap().finish().unwrap()
        });
        assert!(tail.bytes.is_empty());
    }

    #[test]
    fn stderr_drop_is_bounded_with_a_real_open_empty_pipe() {
        with_open_stderr_writer("", "Drop must return within two seconds while the real stderr writer remains open and empty", |stderr| {
            drop(StderrReader::spawn(stderr, vec![]).unwrap());
        });
    }

    #[test]
    fn stderr_finish_retains_buffered_bytes_from_a_real_open_pipe() {
        let tail = with_open_stderr_writer(
            "buffered fatal diagnostic",
            "finish must return within two seconds while buffered stderr has an open writer",
            |stderr| {
                StderrReader::spawn(stderr, vec![])
                    .unwrap()
                    .finish()
                    .unwrap()
            },
        );
        assert_eq!(
            tail.bytes.into_iter().collect::<Vec<_>>(),
            b"buffered fatal diagnostic",
            "finish must retain stderr bytes buffered before collection starts"
        );
    }

    #[test]
    #[ignore = "subprocess fixture for real stderr pipe boundary tests"]
    fn stderr_pipe_writer_fixture() {
        let payload = std::env::var("EMEND_STDERR_FIXTURE_PAYLOAD").unwrap();
        std::io::stderr().write_all(payload.as_bytes()).unwrap();
        std::io::stderr().flush().unwrap();
        println!("\nSTDERR_WRITER_READY");
        std::io::stdout().flush().unwrap();
        let mut release = [0];
        let _ = std::io::stdin().read(&mut release).unwrap();
    }

    #[test]
    fn advertised_cowrite_inventory_requires_a_connected_binding() {
        let inventories = [
            json!(null),
            json!({}),
            json!([]),
            json!([{"name": "calendar", "status": "connected"}]),
            json!([{"name": "cowrite-other", "status": "connected"}]),
            json!([{"name": "cowrite", "status": "failed"}]),
            json!([{"name": "cowrite", "status": "needs-auth"}]),
            json!([{"name": "cowrite", "status": "starting"}]),
            json!([{"name": "cowrite", "status": "Connected"}]),
            json!([{"name": "cowrite", "status": "unknown future status"}]),
            json!([{"name": "cowrite"}]),
            json!([{"name": "cowrite", "status": null}]),
            json!([{"name": "cowrite", "status": 1}]),
            json!([{"name": "cowrite", "status": "connected"}, {"name": "cowrite", "status": "failed"}]),
            json!([{"name": "cowrite", "status": "failed"}, {"name": "cowrite", "status": "connected"}]),
        ];
        for inventory in inventories {
            assert!(
                check_cowrite_binding(
                    &json!({"type": "system", "subtype": "init", "mcp_servers": inventory})
                )
                .is_err(),
                "advertised inventory did not establish Cowrite: {inventory}"
            );
        }
    }

    #[test]
    fn connected_cowrite_ignores_unrelated_server_statuses() {
        for unrelated in [
            json!({"name": "calendar", "status": "failed"}),
            json!({"name": "cowrite-other", "status": "needs-auth"}),
            json!({"name": "unknown"}),
            json!(null),
        ] {
            let event = json!({"type": "system", "subtype": "init", "mcp_servers": [unrelated, {"name": "cowrite", "status": "connected"}]});
            assert!(
                check_cowrite_binding(&event).is_ok(),
                "an unrelated server rejected a connected Cowrite binding"
            );
        }
    }

    #[test]
    fn cowrite_binding_check_preserves_optional_inventory_and_event_discrimination() {
        for event in [
            json!({"type": "system", "subtype": "init"}),
            json!({"type": "assistant", "subtype": "init", "mcp_servers": []}),
            json!({"type": "system", "subtype": "other", "mcp_servers": []}),
            json!({"type": "result", "mcp_servers": []}),
        ] {
            assert!(
                check_cowrite_binding(&event).is_ok(),
                "optional inventory or a non-init event was rejected: {event}"
            );
        }
    }

    #[test]
    fn cowrite_binding_failure_never_echoes_provider_inventory() {
        let event = json!({"type": "system", "subtype": "init", "mcp_servers": [{"name": "cowrite", "status": "Bearer secret-provider-inventory", "url": "https://credential@example.invalid"}]});
        let error = check_cowrite_binding(&event).unwrap_err().to_string();
        assert_eq!(
            error, "The agent could not connect to Cowrite's document tools.",
            "provider-controlled inventory leaked into the run diagnostic"
        );
    }

    #[test]
    fn finishing_stderr_collection_is_bounded_even_with_continuous_output() {
        let (finish, receiver) = mpsc::channel();
        finish.send(()).unwrap();
        let (done, completed) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let result = drain_stderr(std::io::repeat(b'x'), &[], Some(&receiver));
            let _ = done.send(result);
        });
        let tail = completed
            .recv_timeout(Duration::from_secs(2))
            .expect("continuous stderr must not extend the final collection bound")
            .unwrap();
        reader.join().unwrap();
        assert_eq!(tail.bytes.len(), STDERR_TAIL_LIMIT);
    }

    #[test]
    fn stderr_capture_retains_only_the_newest_bounded_tail_across_chunks() {
        let mut tail = StderrTail::new();
        let first = vec![b'a'; STDERR_TAIL_LIMIT - 3];
        tail.retain(&first);
        tail.retain(b"bcdef");

        assert_eq!(tail.bytes.len(), STDERR_TAIL_LIMIT);
        assert_eq!(tail.omitted, 2);
        assert_eq!(
            tail.bytes.iter().copied().collect::<Vec<_>>()[STDERR_TAIL_LIMIT - 5..],
            *b"bcdef"
        );
    }

    #[test]
    fn stderr_redactions_remove_inline_mcp_authorization_values_and_bare_tokens() {
        let args = vec![json!({
            "mcpServers": { "cowrite": { "headers": {
                "Authorization": "Bearer test-token-123"
            } } }
        })
        .to_string()];
        let redactions = stderr_redactions(&args);
        let mut stderr = b"fatal: Bearer test-token-123 (test-token-123)".as_slice();
        let tail = drain_stderr(&mut stderr, &redactions, None).unwrap();
        let retained: Vec<u8> = tail.bytes.iter().copied().collect();
        let text = String::from_utf8(retained).unwrap();

        assert_eq!(text, "fatal: <redacted> (<redacted>)");

        let prefix = "x".repeat(STDERR_TAIL_LIMIT - "Bearer test-token-123".len() + 4);
        let boundary = format!("{prefix}Bearer test-token-123");
        let tail = drain_stderr(boundary.as_bytes(), &redactions, None).unwrap();
        let retained: Vec<u8> = tail.bytes.iter().copied().collect();
        let text = String::from_utf8(retained).unwrap();

        assert!(!text.contains("test-token-123"));
        assert!(text.ends_with("<redacted>"));
        assert!(text.len() <= STDERR_TAIL_LIMIT);
    }

    #[test]
    fn fold_init_field_captures_it_from_system_init_only() {
        let mut slot = None;
        let non_init = json!({ "type": "assistant", "session_id": "wrong" });
        fold_init_field(&non_init, "session_id", &mut slot);
        assert_eq!(slot, None);

        let init = json!({ "type": "system", "subtype": "init", "session_id": "abc-123" });
        fold_init_field(&init, "session_id", &mut slot);
        assert_eq!(slot.as_deref(), Some("abc-123"));
    }

    #[test]
    fn fold_init_field_does_not_overwrite_once_set() {
        let mut slot = Some("first".to_string());
        let init = json!({ "type": "system", "subtype": "init", "session_id": "second" });
        fold_init_field(&init, "session_id", &mut slot);
        assert_eq!(slot.as_deref(), Some("first"));
    }

    #[test]
    fn fold_init_field_reads_whichever_field_name_is_asked_for() {
        let mut slot = None;
        let init = json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "claude_code_version": "2.1.200"
        });
        fold_init_field(&init, "claude_code_version", &mut slot);
        assert_eq!(slot.as_deref(), Some("2.1.200"));
    }

    #[test]
    fn is_propose_changes_call_detects_the_mcp_tool_use_block() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "mcp__cowrite__propose_changes", "input": {} }
            ] }
        });
        assert!(is_propose_changes_call(&event));
    }

    #[test]
    fn is_propose_changes_call_is_false_for_other_tool_use_and_events() {
        let other_tool = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": {} }
            ] }
        });
        assert!(!is_propose_changes_call(&other_tool));

        let non_assistant = json!({ "type": "result", "subtype": "success", "session_id": "s" });
        assert!(!is_propose_changes_call(&non_assistant));
    }

    fn tool_use_event(name: &str) -> Value {
        json!({
            "type": "assistant",
            "message": { "content": [ { "type": "tool_use", "name": name, "input": {} } ] }
        })
    }

    /// Every tool through which a run lands tracked changes or comments — CJ's #1118 ruling names
    /// both lanes, so both are asserted here rather than only the `propose_changes` one the stop
    /// path already had.
    #[test]
    fn is_delivery_call_detects_the_tracked_change_and_comment_tools() {
        for tool in [
            "mcp__cowrite__propose_changes",
            "mcp__cowrite__add_comments",
            "mcp__cowrite__reply_to_comment",
        ] {
            assert!(is_delivery_call(&tool_use_event(tool)), "{tool} delivers");
        }
    }

    /// The near-matches that must be rejected, or the rule degenerates into "any MCP tool call
    /// suppresses the answer": the read-only lane, the permission ask, and `create_document` (its
    /// J2 birth card reports a completed direct write, not a pending change set — see
    /// [`DELIVERY_TOOLS`]). A plain provider tool and a non-`assistant` envelope carrying the same
    /// name are rejected too — only an assistant's own announcement is a call.
    #[test]
    fn is_delivery_call_is_false_for_every_tool_that_lands_nothing() {
        for tool in [
            "mcp__cowrite__get_document_state",
            "mcp__cowrite__list_documents",
            "mcp__cowrite__permission_request",
            "mcp__cowrite__create_document",
            "Read",
            "Write",
        ] {
            assert!(
                !is_delivery_call(&tool_use_event(tool)),
                "{tool} lands no tracked change or comment"
            );
        }

        // Each guard alone, so neither can hide behind the other. A `tool_result` block in an
        // otherwise-eligible assistant envelope is a tool *reporting back*, not a call…
        let tool_result = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_result", "name": "mcp__cowrite__propose_changes" }
            ] }
        });
        assert!(!is_delivery_call(&tool_result));

        // …and an otherwise-eligible `tool_use` block outside an assistant envelope is not the
        // agent announcing its own call (a `user` event carries tool results; only a malformed or
        // interleaved stream would put a call there — `agent::activity` makes the same judgment).
        let non_assistant_envelope = json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_use", "name": "mcp__cowrite__propose_changes", "input": {} }
            ] }
        });
        assert!(!is_delivery_call(&non_assistant_envelope));

        let text_naming_the_tool = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "I will call mcp__cowrite__propose_changes next." }
            ] }
        });
        assert!(!is_delivery_call(&text_naming_the_tool));
    }
}
