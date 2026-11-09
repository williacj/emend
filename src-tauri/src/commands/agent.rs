// ABOUTME: Thin IPC (§3.1) over `agent::run_queue` — start/stop/state for FR-AGENT-7's one-run-
// ABOUTME: per-project queue; validate -> call -> return, all queue/spawn/kill logic stays in agent::.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::agent::birth::{DocumentBirthNotice, DocumentBirthObserver};
use crate::agent::claude;
use crate::agent::delivery::{DeliveryNotice, DeliveryObserver};
use crate::agent::project::SharedOpenProject;
use crate::agent::run_queue::{
    ActivityEmitter, RunQueue, RunQueueState, RunRequest, RunStatus, StartRunResult, StopOutcome,
};
use crate::agent::session::{AgentSession, SessionError};
use crate::agent::state::McpContext;
use crate::commands::path_confine::{confine, identity_relative};

pub const PERMISSION_EVENT: &str = "cowrite://agent/permission";

pub struct TauriPermissionEmitter(pub AppHandle);
impl crate::agent::permission::PermissionObserver for TauriPermissionEmitter {
    fn requested(&self) {
        use tauri_plugin_notification::NotificationExt;
        if let Err(error) = self
            .0
            .notification()
            .builder()
            .title("Emend")
            .body("The agent is waiting for your permission.")
            .show()
        {
            eprintln!("Emend could not send the permission notification: {error}");
        }
    }

    fn changed(&self, state: &crate::agent::permission::PermissionState) {
        let _ = Emitter::emit(&self.0, PERMISSION_EVENT, state);
    }
}

pub fn permission_state_on(
    session: &SharedOpenProject,
) -> crate::agent::permission::PermissionState {
    session
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|project| project.permissions().state())
        .unwrap_or_default()
}

pub fn decide_permission_on(
    session: &SharedOpenProject,
    run_id: String,
    request_id: String,
    decision: crate::agent::permission::PermissionDecision,
) -> Result<(), CommandError> {
    let broker = session
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|project| project.permissions())
        .ok_or_else(|| CommandError::InvalidArguments("No project is open.".into()))?;
    broker
        .decide(&run_id, &request_id, decision)
        .map_err(CommandError::InvalidArguments)
}

#[tauri::command]
pub fn permission_state(
    session: State<'_, SharedOpenProject>,
) -> crate::agent::permission::PermissionState {
    permission_state_on(&session)
}

#[tauri::command]
pub fn decide_permission(
    session: State<'_, SharedOpenProject>,
    run_id: String,
    request_id: String,
    decision: crate::agent::permission::PermissionDecision,
) -> Result<(), CommandError> {
    decide_permission_on(&session, run_id, request_id, decision)
}

/// The channel `TauriActivityEmitter` pushes every [`RunStatus`] update on — `src/timeline/agentActivity.ts`'s
/// `listen()` call is this string's only consumer; change both together (FR-X-3, the app's first
/// event-emission pattern — see the P2a-21 journal entry).
pub const ACTIVITY_EVENT: &str = "agent://activity";

/// The channel [`TauriDeliveryEmitter`] pushes every landed `propose_changes` on — the J1 Phase B
/// pipe (#346). `src/stores/delivery.ts`'s `DELIVERY_EVENT` is this string's only consumer; change
/// both together.
pub const DELIVERY_EVENT: &str = "cowrite://agent/delivery";

/// The channel [`TauriDocumentBirthEmitter`] pushes every landed `create_document` on — the J2 birth
/// pipe (#420). `src/stores/documentBirth.ts`'s `DOCUMENT_BIRTH_EVENT` is this string's only
/// consumer; change both together.
pub const DOCUMENT_BIRTH_EVENT: &str = "cowrite://agent/document-birth";

/// Bridges `agent::run_queue`'s [`ActivityEmitter`] seam onto a live `AppHandle::emit` — kept as
/// its own newtype (rather than exposing `AppHandle` to `agent::` directly) so `agent::run_queue`
/// stays provider/session-only and free of any Tauri dependency; only this IPC-layer glue knows
/// about the app handle.
pub struct TauriActivityEmitter(pub AppHandle);

impl ActivityEmitter for TauriActivityEmitter {
    fn emit(&self, status: &RunStatus) {
        // A send failure here (e.g. no window has mounted a listener yet) is inert — the next
        // `run_state` poll still reflects the same status, so nothing is lost, only not pushed
        // live this once.
        let _ = Emitter::emit(&self.0, ACTIVITY_EVENT, status);
    }
}

/// [`TauriActivityEmitter`]'s sibling for the J1 Phase B delivery pipe (#346): carries a landed
/// `propose_changes` from the bound MCP server's own thread — which has no other route back to the
/// frontend — to the window. The `OpenProject` this is handed to holds it for the project's whole
/// lifetime (TD-17), which is what makes every delivery on that project's server observable.
pub struct TauriDeliveryEmitter(pub AppHandle);

impl DeliveryObserver for TauriDeliveryEmitter {
    fn delivered(&self, notice: &DeliveryNotice) {
        // Inert on failure, and deliberately non-blocking: `propose_changes` does not return to the
        // agent until this does (`DeliveryObserver`'s own contract).
        let _ = Emitter::emit(&self.0, DELIVERY_EVENT, notice);
    }
}

/// The same bridge for the J2 document-birth pipe (#420).
pub struct TauriDocumentBirthEmitter(pub AppHandle);

impl DocumentBirthObserver for TauriDocumentBirthEmitter {
    fn created(&self, notice: &DocumentBirthNotice) {
        let _ = Emitter::emit(&self.0, DOCUMENT_BIRTH_EVENT, notice);
    }
}

/// A command-level input error (§3.1 typed errors). Spawn/queue failures are *not* command errors
/// — they surface as the started run's `Failed` phase through [`run_state`] (FR-X-3: async and
/// observable, never a rejected call that leaves the caller with nothing to poll).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    InvalidArguments(String),
    /// [`create_document_direct`]'s `agent::state::McpContext::create_document` call was refused
    /// or failed (D21 protection, path confinement, a write error, …) — the `ToolError`'s own
    /// `Display` message, carried across the boundary rather than re-typed here (this seam has
    /// exactly one caller today, the D23 test driver, so a single catch-all variant is enough; it
    /// can be split into named variants if a second caller ever needs to branch on the reason).
    ToolFailed(String),
}

/// Builds and spawns the Claude Code CLI invocation for one run (TD-5), reusing the already-tested
/// `agent::claude` argv builder — with the open project's bound TD-1 MCP server injected into it
/// (#472: the seam #412 and #413 each handed to the other, so no spawned run had Cowrite tool
/// access at all). The server is *not* bound here: it belongs to the `OpenProject` the app opened
/// (TD-17, Option B), and a run reads its connection info out of that aggregate.
///
/// This is the one `agent::run_queue::Spawn` this project's `RunQueue` is constructed with
/// (`lib.rs`) — M7 (tech-design §3.5) means one project runs per app instance, so one global queue
/// is FR-AGENT-7-correct by construction; no per-project keying is needed here or in `RunQueue`.
///
/// A run with no open project to draw a server from surfaces as `SessionError::Spawn` — i.e. as the
/// run's `Failed` phase through [`run_state`], exactly as a failure to launch the CLI does (FR-X-3:
/// never a silent gap). It is deliberately *not* downgraded to "spawn anyway without tools": a run
/// that cannot deliver tracked changes is a failed run, not a quietly degraded one (D21).
pub fn spawn_claude_run(
    session: &SharedOpenProject,
    request: &RunRequest,
) -> Result<AgentSession, SessionError> {
    let (mcp_server, resume_session_id) = bound_server(session, &request.project_root)?;
    let resume_attempted = resume_session_id.is_some();
    let (binary, args, cwd, prompt) = claude_invocation(request, mcp_server, resume_session_id);
    AgentSession::spawn_provider_turn_with_stdin(
        &binary,
        &args,
        &cwd,
        prompt.as_bytes(),
        resume_attempted,
    )
}

/// The open project's MCP connection info, plus its stored D4 continuity target (#1723) — the
/// session id (if any) a prior run against this same project established, for a run against
/// `root`.
///
/// Refuses a run whose root is not the open project's rather than binding one for it: under M7 the
/// open project is *the* project, so a mismatch means the frontend and backend disagree about which
/// project is open — spawning an agent against a server bound to a different root would let it read
/// and write outside the project the user is looking at.
///
/// The lock is held only long enough to clone the connection info; the run itself spawns outside it,
/// so a long turn never blocks `commands::project`'s open/close.
fn bound_server(
    session: &SharedOpenProject,
    root: &Path,
) -> Result<(claude::McpServer, Option<String>), SessionError> {
    let guard = session.lock().unwrap_or_else(PoisonError::into_inner);
    match guard.as_ref() {
        Some(project) if project.is_root(root) => {
            Ok((project.mcp_server(), project.resume_session_id()))
        }
        Some(_) => Err(SessionError::Spawn(io::Error::other(
            "this run's project is not the open project — no MCP server is bound for it",
        ))),
        None => Err(SessionError::Spawn(io::Error::other(
            "no project is open, so no MCP server is bound for this run",
        ))),
    }
}

/// The `(binary, argv, cwd, stdin)` tuple [`spawn_claude_run`] hands to
/// [`AgentSession::spawn_with_stdin`], split out as its own pure function so the composition —
/// `project_root` becomes `cwd`, `prompt` reaches stdin while `-p` selects print mode, the resolved
/// provider binary is named, `mcp_server` is injected, and `resume_session_id` becomes `--resume`
/// (D4 continuity, #1723) — is testable without spawning a real process (a transposed cwd/prompt,
/// or the wrong resolved binary, would otherwise pass every test in this crate, since every
/// `RunQueue` test injects a fake `Spawn`).
///
/// `mcp_server` is taken by value, not as an `Option`: after #472 every spawned run carries a bound
/// server, so "a run with no Cowrite tool access" is not a state this function can express.
/// `resume_session_id` stays an `Option` — the project's first run (or one against a project that
/// has never completed a turn) is honestly fresh, never a fabricated resume.
/// Public so `tests/agent_run_mcp_injection.rs` can assert the *production* argv reaches a real
/// spawned agent, rather than rebuilding an equivalent one and testing its own copy.
pub fn claude_invocation(
    request: &RunRequest,
    mcp_server: claude::McpServer,
    resume_session_id: Option<String>,
) -> (String, Vec<String>, PathBuf, &str) {
    let spawn_request = claude::SpawnRequest {
        project_dir: request.project_root.clone(),
        mcp_server: Some(mcp_server),
        resume_session_id,
    };
    let args = claude::build_args(&spawn_request);
    (
        claude::binary(),
        args,
        request.project_root.clone(),
        &request.prompt,
    )
}

/// `start_run`'s only business rule: a run needs something to say. Split out from the
/// `#[tauri::command]` so it's testable without a Tauri `State<RunQueue>`.
fn validate_prompt(prompt: &str) -> Result<(), CommandError> {
    if prompt.trim().is_empty() {
        return Err(CommandError::InvalidArguments(
            "prompt must not be empty".to_string(),
        ));
    }
    Ok(())
}

/// [`start_run`]'s business logic without a Tauri `State` extractor — what the `#[tauri::command]`
/// wrapper below calls, and what the D23 `crates/test-driver` (no Tauri runtime, so no `State` to
/// extract) calls directly against its own `RunQueue` instance. Kept here rather than duplicated in
/// the driver so both callers validate and construct the request identically.
pub fn start_run_on(
    queue: &RunQueue,
    root: String,
    prompt: String,
    operation_targets: Vec<String>,
) -> Result<StartRunResult, CommandError> {
    validate_prompt(&prompt)?;
    let root_path = Path::new(&root);
    let operation_targets: Result<Vec<String>, CommandError> = operation_targets
        .iter()
        .map(|target| {
            let confined = confine(root_path, target)
                .map_err(|error| CommandError::InvalidArguments(error.to_string()))?;
            identity_relative(root_path, &confined)
                .map_err(|error| CommandError::InvalidArguments(error.to_string()))
        })
        .collect();
    Ok(queue.start_with_queue_position(RunRequest {
        project_root: root.into(),
        prompt,
        operation_targets: operation_targets?,
    }))
}

/// Starts (or, per FR-AGENT-7, queues behind an already-active run) a headless agent turn against
/// `root` with `prompt`. Returns the new run's id and its queue position when it did not spawn
/// immediately; poll [`run_state`] for subsequent phase and queue changes.
#[tauri::command]
// @anchor:start-run-command
pub fn start_run(
    queue: State<RunQueue>,
    root: String,
    prompt: String,
    operation_targets: Vec<String>,
) -> Result<StartRunResult, CommandError> {
    start_run_on(&queue, root, prompt, operation_targets)
}

/// Stops `run_id`: kills it if it's the active run (its phase resolves to `Stopped` shortly after
/// — poll [`run_state`]), cancels it outright if it's still queued (it never spawns), or reports
/// `not_found` (already finished, or unknown).
#[tauri::command]
pub fn stop_run(queue: State<RunQueue>, run_id: String) -> StopOutcome {
    queue.stop(&run_id)
}

/// The current FR-AGENT-7 picture: the active run (if any) and the queue behind it, in order —
/// queue depth and position are read from here, satisfying FR-AGENT-7's "visibly".
#[tauri::command]
pub fn run_state(queue: State<RunQueue>) -> RunQueueState {
    queue.state()
}

/// Performs one `create_document` MCP tool call against `root` directly, over a fresh unprotected
/// [`McpContext`] — no Tauri command, no route the *frontend* ever calls (only the agent's own
/// wired MCP server does that, over the open project's bound binding). This exists so the D23
/// headless test driver can drive that tool call without a live agent turn behind it (P2b-11b's own
/// J2 acceptance script), the identical "same real backend logic, only the caller substituted"
/// contract every other driver route already has (`crates/test-driver`'s own module doc) — the
/// write, path confinement, and D21 refusal all run for real, nothing here reimplements them.
///
/// Since #472 a *spawned* run does reach `create_document` over the bound server, so this is no
/// longer the only way the call can happen. It stays the driver's route for two reasons that a
/// spawned run cannot supply: a real CLI cannot be *scripted* to issue one chosen tool call at a
/// chosen moment. The driver may now supply the same birth-observer seam as a bound server, while
/// this entry point retains its inline notice for callers that also need the command result. (The driver *can* spawn a
/// run: `/start_run` reaches the real `spawn_claude_run`. An earlier draft of this note claimed
/// otherwise — PR #513 review round 6, Minor.)
///
/// Returns the same `{path, size}` shape the app's real birth-notice listener receives
/// (`agent::birth::DocumentBirthNotice`).
pub fn create_document_direct(
    root: PathBuf,
    path: String,
    content: String,
) -> Result<DocumentBirthNotice, CommandError> {
    create_document_direct_observing(root, path, content, None)
}

/// [`create_document_direct`] with the same observer seam a bound project's real MCP context owns.
/// The D23 driver uses this form so its out-of-process caller substitution still publishes through
/// `McpContext::create_document`'s production notification edge rather than copying the returned
/// notice into a second, test-only event path.
pub fn create_document_direct_observing(
    root: PathBuf,
    path: String,
    content: String,
    observer: Option<Arc<dyn DocumentBirthObserver>>,
) -> Result<DocumentBirthNotice, CommandError> {
    let size = content.len() as u64;
    let mut ctx = McpContext::new(root, Vec::new());
    if let Some(observer) = observer {
        ctx = ctx.observing_births(observer);
    }
    let result = ctx
        .create_document(&serde_json::json!({ "path": path, "content": content }))
        .map_err(|e| CommandError::ToolFailed(e.to_string()))?;
    // `create_document`'s `Ok` value is always `{"path": normalized, "doc_id": ...}` (see its own
    // impl) — no fallback-to-caller's-spelling branch needed here.
    let normalized = result["path"]
        .as_str()
        .expect("create_document's Ok result always carries a normalized path")
        .to_string();
    Ok(DocumentBirthNotice {
        path: normalized,
        size,
    })
}

/// Captures the one [`DeliveryNotice`] a single [`McpContext::propose_changes`] call hands its
/// observer, if any lands — [`propose_changes_direct`]'s own private stand-in for the frontend the
/// real `#346` pipe carries a notice to. A landed delivery calls `delivered` at most once per
/// `propose_changes_direct` call (one call, one `McpContext`, one possible notice).
#[derive(Default)]
struct CapturingObserver(Mutex<Option<DeliveryNotice>>);

impl DeliveryObserver for CapturingObserver {
    fn delivered(&self, notice: &DeliveryNotice) {
        *self
            .0
            .lock()
            .expect("capturing observer mutex is never poisoned") = Some(notice.clone());
    }
}

impl CapturingObserver {
    /// Takes whatever notice landed (or `None`), leaving the observer empty — mirrors
    /// `crates/test-driver`'s `BatchFault::take` for the same one-shot-capture shape.
    fn take(&self) -> Option<DeliveryNotice> {
        self.0
            .lock()
            .expect("capturing observer mutex is never poisoned")
            .take()
    }
}

/// Performs one `propose_changes` MCP tool call against `root` directly, over a fresh [`McpContext`]
/// — the same "same real backend logic, only the caller substituted" contract [`create_document_direct`]
/// documents above, this time for the J1 Phase B delivery path (P2a-13/#346) so the D23 headless
/// test driver can drive it without a live agent run behind it (the J1 acceptance script, #365).
/// Since #472 a spawned run *does* reach `propose_changes` over the open project's bound server
/// (`spawn_claude_run`'s own doc), so this is no longer the only way to produce a delivery. It
/// remains the driver's route for the same two reasons [`create_document_direct`] gives above: a
/// spawned CLI cannot be scripted to deliver one chosen proposal, and the driver's project carries
/// no `DeliveryObserver`, so a delivery on its own server reaches nobody — hence the notice is
/// returned inline here.
///
/// `base_content` is what the agent last read (TD-7's "the document as the agent read it") —
/// `revision` is derived from it, never taken on trust from the caller, so the two can never
/// disagree. This entry point is one HTTP round trip against a *fresh* context, unlike a live
/// run's single long-lived one, so it has no earlier `get_document_state` call of its own to have
/// remembered that base through; it seeds [`McpContext::remember_snapshot`] itself before proposing,
/// which is exactly what lets a caller reproduce TD-7's partial-apply case end to end — write
/// `base_content` to disk, capture it, overwrite the file with "what the user typed since" (a real
/// filesystem mutation, not a mock), then propose edits anchored to the base: the ones the live text
/// has since diverged under go stale, the rest still land as one complete attributed subset.
///
/// Returns `Ok(None)` when the delivery lands nothing at all (wholly stale, or every edit refused as
/// unrepresentable) — FR-AGENT-6's "a delivery that lands nothing raises no notice," mirrored here
/// rather than forcing an error for an outcome `propose_changes` itself treats as a normal response.
pub fn propose_changes_direct(
    root: PathBuf,
    doc: String,
    base_content: String,
    edits: serde_json::Value,
    summary: String,
    change_set_meta: Option<serde_json::Value>,
) -> Result<Option<DeliveryNotice>, CommandError> {
    propose_changes_direct_observing(
        root,
        doc,
        base_content,
        edits,
        summary,
        change_set_meta,
        None,
    )
}

/// [`propose_changes_direct`] with a supplied production delivery observer. The returned notice is
/// retained for existing driver callers, while event publication is performed by the real
/// `McpContext::propose_changes` callback.
pub fn propose_changes_direct_observing(
    root: PathBuf,
    doc: String,
    base_content: String,
    edits: serde_json::Value,
    summary: String,
    change_set_meta: Option<serde_json::Value>,
    supplied_observer: Option<Arc<dyn DeliveryObserver>>,
) -> Result<Option<DeliveryNotice>, CommandError> {
    let revision = textops::Revision::of(&base_content).as_str().to_string();
    let observer = Arc::new(CapturingObserver::default());
    let delivery_observer: Arc<dyn DeliveryObserver> = match supplied_observer {
        Some(supplied) => Arc::new(FanoutDeliveryObserver {
            first: Arc::clone(&observer) as Arc<dyn DeliveryObserver>,
            second: supplied,
        }),
        None => Arc::clone(&observer) as Arc<dyn DeliveryObserver>,
    };
    let ctx = McpContext::new(root, Vec::new()).observing(delivery_observer);
    ctx.remember_snapshot(&revision, &base_content);

    let mut args = serde_json::json!({
        "doc": doc,
        "revision": revision,
        "edits": edits,
        "summary": summary,
    });
    if let Some(meta) = change_set_meta {
        args["change_set_meta"] = meta;
    }
    ctx.propose_changes(&args)
        .map_err(|e| CommandError::ToolFailed(e.to_string()))?;

    Ok(observer.take())
}

struct FanoutDeliveryObserver {
    first: Arc<dyn DeliveryObserver>,
    second: Arc<dyn DeliveryObserver>,
}

impl DeliveryObserver for FanoutDeliveryObserver {
    fn delivered(&self, notice: &DeliveryNotice) {
        self.first.delivered(notice);
        self.second.delivered(notice);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "e6639704-657d-4f23-8225-2f41647dbe31";

    fn request(prompt: &str) -> RunRequest {
        RunRequest {
            project_root: PathBuf::from("/tmp/some-project"),
            prompt: prompt.to_string(),
            operation_targets: Vec::new(),
        }
    }

    /// A stand-in for a bound project server — `claude_invocation` only ever passes the value
    /// through to the argv builder, so it needs no live listener behind it. The end-to-end
    /// "a spawned agent actually reaches a real bound server" claim is
    /// `tests/agent_run_mcp_injection.rs`'s.
    fn server() -> claude::McpServer {
        claude::McpServer {
            addr: "127.0.0.1:39999".parse().unwrap(),
            token: "test-token-123".to_string(),
            run_id: None,
        }
    }

    #[test]
    fn validate_prompt_rejects_empty_and_whitespace_only_prompts() {
        assert!(matches!(
            validate_prompt(""),
            Err(CommandError::InvalidArguments(_))
        ));
        assert!(matches!(
            validate_prompt("   \n\t"),
            Err(CommandError::InvalidArguments(_))
        ));
    }

    #[test]
    fn validate_prompt_accepts_a_non_blank_prompt() {
        assert!(validate_prompt("draft something").is_ok());
    }

    #[test]
    fn claude_invocation_names_the_claude_binary() {
        let (binary, _, _, _) = claude_invocation(&request("hello"), server(), None);
        assert_eq!(binary, claude::BINARY);
    }

    #[test]
    fn claude_invocation_runs_in_the_project_root_as_cwd() {
        let req = request("hello");
        let (_, _, cwd, _) = claude_invocation(&req, server(), None);
        assert_eq!(cwd, req.project_root);
    }

    #[test]
    fn claude_invocation_delivers_the_prompt_on_stdin_while_dash_p_selects_print_mode() {
        let req = request("Tighten the opening paragraph");
        let (_, args, _, stdin) = claude_invocation(&req, server(), None);
        assert_eq!(args[0], "-p");
        assert!(!args.contains(&req.prompt));
        assert_eq!(stdin, req.prompt);
    }

    /// #472: this asserted the *opposite* until now (`..._omits_mcp_config_until_413_wires_a_server`)
    /// — the injection was the seam none of #344's three split cards owned.
    #[test]
    fn claude_invocation_injects_the_bound_servers_mcp_config() {
        let (_, args, _, _) = claude_invocation(&request("hello"), server(), None);
        let i = args
            .iter()
            .position(|a| a == "--mcp-config")
            .expect("every spawned run carries --mcp-config");
        assert_eq!(args[i + 1], claude::mcp_config(&server()).to_string());
    }

    /// #1723: the one production caller must pass a stored resume id through to `--resume` when it
    /// has one — the exact wire `build_args_appends_resume_with_the_session_id_when_continuing`
    /// (`agent::claude`) already proves in isolation, closed here at the caller that was hardcoding
    /// `None`.
    #[test]
    fn claude_invocation_appends_resume_when_a_session_id_is_given() {
        let (_, args, _, _) =
            claude_invocation(&request("hello"), server(), Some(SESSION_ID.to_string()));
        let i = args
            .iter()
            .position(|a| a == "--resume")
            .expect("a given resume_session_id must reach --resume");
        assert_eq!(args[i + 1], SESSION_ID);
    }

    /// The honest negative: no stored session id means no `--resume` at all — a fresh turn, not a
    /// fabricated one.
    #[test]
    fn claude_invocation_omits_resume_when_no_session_id_is_given() {
        let (_, args, _, _) = claude_invocation(&request("hello"), server(), None);
        assert!(!args.contains(&"--resume".to_string()));
    }

    /// A run draws its server from the open project (TD-17) — the same address and token for every
    /// run against it, since the binding is the *project's*, not the run's: no port, thread or
    /// credential churns per turn, and §3.5's "per-session" token stays per session.
    #[test]
    fn a_run_takes_the_open_projects_bound_server() {
        let dir = tempfile::TempDir::new().unwrap();
        let session = open_session(dir.path());

        let (first, _) = bound_server(&session, dir.path()).expect("the open project's server");
        let (second, _) = bound_server(&session, dir.path()).expect("the open project's server");

        assert!(first.addr.ip().is_loopback());
        assert!(!first.token.is_empty());
        assert_eq!(first.addr, second.addr);
        assert_eq!(first.token, second.token);
    }

    /// #1723: a freshly opened project — no run has completed against it yet — has nothing to
    /// resume. The honest "no fabricated continuity" case at this seam.
    #[test]
    fn a_freshly_opened_projects_bound_server_carries_no_resume_session_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let session = open_session(dir.path());

        let (_, resume_session_id) =
            bound_server(&session, dir.path()).expect("the open project's server");

        assert_eq!(resume_session_id, None);
    }

    /// #1723: the production read edge, pinned end to end through the real seam rather than around
    /// it — a run establishes a session on the open project, and the *next* spawn's `bound_server`
    /// hands that id back for `--resume`. The card exists because `spawn_claude_run` hardcoded
    /// `None` where no test could see it; without this cell the same defect hides one level up,
    /// since the only other `bound_server` test asserts `None` (which a hardcoded `None` also
    /// returns).
    #[test]
    fn a_bound_server_carries_the_session_id_a_prior_run_established_on_the_project() {
        use crate::agent::project::OpenProjectRunObserver;
        use crate::agent::run_queue::RunObserver;

        let dir = tempfile::TempDir::new().unwrap();
        let session = open_session(dir.path());

        OpenProjectRunObserver::new(Arc::clone(&session))
            .session_established("run-1", SESSION_ID)
            .unwrap();
        let (_, resume_session_id) =
            bound_server(&session, dir.path()).expect("the open project's server");

        assert_eq!(
            resume_session_id.as_deref(),
            Some(SESSION_ID),
            "the next spawn must read back the session id the prior run established"
        );
    }

    /// D21/FR-X-3: a run that cannot reach the Cowrite tool surface is a *failed* run, never a
    /// quietly tool-less one. With no project open there is no bound server to inject.
    #[test]
    fn a_run_with_no_open_project_fails_rather_than_spawning_without_tools() {
        let session = crate::commands::project::new_session();
        let err = bound_server(&session, Path::new("/tmp/some-project")).unwrap_err();
        assert!(matches!(err, SessionError::Spawn(_)));
    }

    /// The same refusal for the disagreement case: under M7 the open project *is* the project, so a
    /// run against some other root must not be handed this project's server (nor silently bind one
    /// for a root the user is not looking at).
    #[test]
    fn a_run_against_a_root_other_than_the_open_project_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        let other = tempfile::TempDir::new().unwrap();
        let session = open_session(dir.path());

        let err = bound_server(&session, other.path()).unwrap_err();
        assert!(matches!(err, SessionError::Spawn(_)));
    }

    /// `spawn_claude_run` end to end at this layer: no project open → the run fails at the seam
    /// before any process is spawned, so no `claude` binary is needed to assert it.
    #[test]
    fn spawn_claude_run_fails_a_run_that_has_no_bound_server_to_inject() {
        let session = crate::commands::project::new_session();
        // `AgentSession` has no `Debug`, so the outcome is matched rather than `unwrap_err`'d.
        assert!(matches!(
            spawn_claude_run(&session, &request("hello")),
            Err(SessionError::Spawn(_))
        ));
    }

    /// A session with `root` open, over the real `commands::project` transition — never a
    /// hand-built `OpenProject`, so these tests exercise the same path the IPC command takes.
    fn open_session(root: &std::path::Path) -> SharedOpenProject {
        let session = crate::commands::project::new_session();
        crate::commands::project::open_project_on(
            &session,
            root.display().to_string(),
            crate::agent::project::ProjectObservers::default(),
        )
        .expect("open the project");
        session
    }

    /// A spawner that never actually spawns a process, mirroring `agent::run_queue`'s own test
    /// double — `start_run_on` only needs a real `RunQueue` to call into, not a real child.
    fn always_fails(_request: &RunRequest) -> Result<AgentSession, SessionError> {
        Err(SessionError::Spawn(std::io::Error::other(
            "no such provider in this test",
        )))
    }

    #[test]
    fn start_run_on_rejects_a_blank_prompt_before_ever_touching_the_queue() {
        let queue = RunQueue::new(always_fails as fn(&RunRequest) -> _);
        let err = start_run_on(
            &queue,
            "/tmp/project".to_string(),
            "  ".to_string(),
            Vec::new(),
        )
        .unwrap_err();
        assert!(matches!(err, CommandError::InvalidArguments(_)));
        assert!(
            queue.state().active.is_none(),
            "an invalid request never reaches the queue"
        );
    }

    #[test]
    fn start_run_on_starts_a_run_against_the_shared_queue_for_a_non_blank_prompt() {
        let queue = RunQueue::new(always_fails as fn(&RunRequest) -> _);
        let result = start_run_on(
            &queue,
            "/tmp/project".to_string(),
            "draft something".to_string(),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(queue.state().active.unwrap().id, result.id);
        assert_eq!(result.queued_position, None);
    }

    // --- create_document_direct (P2b-11b's J2 driver seam) ---------------------------------

    #[test]
    fn create_document_direct_writes_the_file_and_returns_its_normalized_path_and_size() {
        let dir = tempfile::TempDir::new().unwrap();
        let notice = create_document_direct(
            dir.path().to_path_buf(),
            "./drafts/outline.md".to_string(),
            "# Outline\n\nOnce upon a time.\n".to_string(),
        )
        .unwrap();

        assert_eq!(notice.path, "drafts/outline.md");
        assert_eq!(notice.size, "# Outline\n\nOnce upon a time.\n".len() as u64);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("drafts/outline.md")).unwrap(),
            "# Outline\n\nOnce upon a time.\n"
        );
    }

    #[test]
    fn create_document_direct_rejects_a_path_escaping_the_project_root() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = create_document_direct(
            dir.path().to_path_buf(),
            "../escape.md".to_string(),
            "x".to_string(),
        )
        .unwrap_err();
        assert!(matches!(err, CommandError::ToolFailed(_)));
    }

    // --- propose_changes_direct (the J1 acceptance script's driver seam, #365) -------------

    #[test]
    fn propose_changes_direct_delivers_a_clean_insertion_and_reports_the_notice() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = "hello world\n";
        std::fs::write(dir.path().join("draft.md"), base).unwrap();

        let notice = propose_changes_direct(
            dir.path().to_path_buf(),
            "draft.md".to_string(),
            base.to_string(),
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            "Made it braver".to_string(),
            None,
        )
        .unwrap()
        .expect("a clean delivery lands and raises a notice");

        assert_eq!(notice.doc, "draft.md");
        assert_eq!(notice.summary, "Made it braver");
        assert_eq!(notice.changes.len(), 1);
        assert_eq!(notice.stale, 0);
        assert_eq!(notice.unrepresentable, 0);
        assert_eq!(
            notice.content,
            std::fs::read_to_string(dir.path().join("draft.md")).unwrap()
        );
        assert!(notice.content.contains("brave"));
    }

    #[test]
    fn propose_changes_direct_reports_the_applied_subset_when_the_live_text_has_moved_on() {
        // TD-7 partial apply: the base is what the agent read; the file is overwritten with what
        // the user typed since (a real filesystem mutation, not a mock) before the edits — one
        // anchored to untouched text, one to text the user has since changed — are proposed.
        let dir = tempfile::TempDir::new().unwrap();
        let base = "one two three four five\n";
        std::fs::write(dir.path().join("draft.md"), base).unwrap();
        let live = "one two three four FIVE\n";
        std::fs::write(dir.path().join("draft.md"), live).unwrap();

        let notice = propose_changes_direct(
            dir.path().to_path_buf(),
            "draft.md".to_string(),
            base.to_string(),
            serde_json::json!([
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " },
                { "range": { "offset": 19, "length": 4 }, "replacement": "5" }
            ]),
            "renumber".to_string(),
            None,
        )
        .unwrap()
        .expect("the untouched-text edit still lands as one complete attributed subset");

        assert_eq!(notice.changes.len(), 1);
        assert_eq!(notice.stale, 1);
        assert_eq!(notice.content, "{++zero ++}one two three four FIVE\n");
        // The stale edit never landed — the user's own "FIVE" survives untouched.
        assert!(notice.content.contains("FIVE"));
    }

    #[test]
    fn propose_changes_direct_reports_no_notice_when_the_whole_delivery_is_stale() {
        // No representable base survives the rebase (the agent's every edit collides with what the
        // user typed) — FR-AGENT-6: nothing lands, so there is nothing to notify the frontend of.
        let dir = tempfile::TempDir::new().unwrap();
        let base = "one two three\n";
        std::fs::write(dir.path().join("draft.md"), base).unwrap();
        let live = "ONE TWO THREE\n";
        std::fs::write(dir.path().join("draft.md"), live).unwrap();

        let notice = propose_changes_direct(
            dir.path().to_path_buf(),
            "draft.md".to_string(),
            base.to_string(),
            serde_json::json!([{ "range": { "offset": 0, "length": 13 }, "replacement": "rewritten" }]),
            "rewrite".to_string(),
            None,
        )
        .unwrap();

        assert!(notice.is_none());
        // The live text is genuinely untouched (FR-AGENT-6: complete or nothing, never partial).
        assert_eq!(
            std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
            live
        );
    }

    #[test]
    fn propose_changes_direct_rejects_a_range_outside_the_document() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = "short\n";
        std::fs::write(dir.path().join("draft.md"), base).unwrap();

        let err = propose_changes_direct(
            dir.path().to_path_buf(),
            "draft.md".to_string(),
            base.to_string(),
            serde_json::json!([{ "range": { "offset": 0, "length": 9999 }, "replacement": "x" }]),
            "s".to_string(),
            None,
        )
        .unwrap_err();

        assert!(matches!(err, CommandError::ToolFailed(_)));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
            base
        );
    }
}
