// ABOUTME: D23 headless test driver — loopback HTTP over the app's backend document/project commands.
// ABOUTME: Mirrors command edges and a cursor-backed production event channel for no-GUI acceptance.

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cowrite_lib::agent::birth::{DocumentBirthNotice, DocumentBirthObserver};
use cowrite_lib::agent::delivery::{DeliveryNotice, DeliveryObserver};
use cowrite_lib::agent::project::{
    canonical_root, OpenProjectRunObserver, ProjectObservers, SharedOpenProject,
};
use cowrite_lib::agent::run_queue::{
    NoopEmitter, RunQueue, RunQueueState, RunRequest, StopOutcome,
};
use cowrite_lib::agent::session::{AgentSession, SessionError};
use cowrite_lib::commands::adoption::{
    cancel_adoption_on, commit_adoption_on, land_adoption_on, mint_untitled_doc_id_on,
    prepare_adoption_on, reconcile_adoptions_on, AdoptionCoordinator,
};
use cowrite_lib::commands::agent::{
    create_document_direct_observing, propose_changes_direct_observing, spawn_claude_run,
    start_run_on, CommandError as AgentCommandError, DELIVERY_EVENT, DOCUMENT_BIRTH_EVENT,
};
use cowrite_lib::commands::changes::{parse_changes, parse_changes_by_id, DocRef};
use cowrite_lib::commands::comments::{self, AnchorRange as CommentAnchorRange};
use cowrite_lib::commands::diagnostics::{report_render_failure_on, RenderFailureDiagnosticInput};
use cowrite_lib::commands::document::{
    capture_anchor, open_document, recreate_missing_document_capability_on,
    recreate_missing_document_on, resolve_anchor, save_document_as_on, save_document_on,
    AnchorPosition, CommandError,
};
use cowrite_lib::commands::project::{
    close_project_on, current_project_on, new_session, open_project_on,
    project_path_is_enumerable_on, refresh_project_files_on, PROJECT_FILES_EVENT,
    PROJECT_ROUTING_EVENT,
};
use cowrite_lib::commands::providers::{detect_provider_payloads, ProviderStatusPayload};
use cowrite_lib::commands::settings::{get_settings_on, patch_settings_on, SETTINGS_CHANGED_EVENT};
use cowrite_lib::commands::skills::discover_grounding_payload;
use cowrite_lib::commands::tabs::{
    begin_tab_session_on, end_tab_session_on, load_tab_session, prove_tab_session_on,
    save_tab_session_on, set_open_tabs_on, SessionPayload, SessionSavePolicy,
    TabSessionCoordinator,
};
use cowrite_lib::commands::transcript::CommandError as TranscriptCommandError;
use cowrite_lib::instances::{ProjectRouteOutcome, RouteFailure};
use cowrite_lib::project_files::{
    ProjectFilesError, ProjectFilesObserver, ProjectFilesRefreshNotice, ProjectFilesSnapshot,
};
use cowrite_lib::store::comments::{LinkedChangeDecision, RunConclusion};
use cowrite_lib::store::settings::{
    self as settings_store, Settings, SettingsObserver, SettingsPatch, SettingsService,
};
use cowrite_lib::store::transcript::{self as transcript_store, TranscriptEvent};
use cowrite_lib::voice::model_download::{
    DownloadFailure, DownloadResponse, DownloadTransport, HttpTransport,
};
use cowrite_lib::voice::settings::{production_runtime, ProductionVoiceRuntime, VoiceError};
use cowrite_lib::{OPEN_DOCUMENT_EVENT, SAVE_DOCUMENT_AS_EVENT};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;

#[derive(Deserialize)]
struct OpenArgs {
    root: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    root: String,
    path: String,
    content: String,
    // Mirrors the Tauri command arg (camelCase over the wire, per Tauri's JS↔Rust convention);
    // omitted by a caller means the editor default, normalization on (FR-ED-2).
    #[serde(default = "normalize_on_by_default")]
    normalize_line_endings: bool,
}

fn normalize_on_by_default() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAsArgs {
    root: String,
    from_path: String,
    to_path: String,
    content: String,
    #[serde(default = "normalize_on_by_default")]
    normalize_line_endings: bool,
}

#[derive(Deserialize)]
struct RecreateCapabilityArgs {
    path: String,
}

#[derive(Deserialize)]
struct ProjectPathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecreateArgs {
    path: String,
    content: String,
    #[serde(default = "normalize_on_by_default")]
    normalize_line_endings: bool,
}

#[derive(Deserialize)]
struct ParseChangesArgs {
    /// The document the parse joins against (TD-16 ruling 3) — omitted by a caller with no
    /// project, exactly as the Tauri command's own `Option` allows.
    #[serde(default)]
    doc: Option<DocRef>,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdContentArgs {
    root: String,
    doc_id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureAnchorArgs {
    content: String,
    utf16_offset: usize,
    utf16_length: usize,
}

#[derive(Deserialize)]
struct ResolveAnchorArgs {
    content: String,
    anchor: textops::Anchor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginTabSessionArgs {
    root: String,
    writer_id: String,
    attachment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTabSessionArgs {
    root: String,
    writer_id: String,
    attachment_id: String,
    expected_revision: String,
    session: SessionPayload,
    policy: SessionSavePolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndTabSessionArgs {
    root: String,
    writer_id: String,
    attachment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareAdoptionArgs {
    root: String,
    adoption_id: String,
    displaced_path: String,
    destination: String,
    doc_id: String,
    recovery_content_omitted: bool,
    content: String,
    timestamp: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitAdoptionArgs {
    root: String,
    adoption_id: String,
    landed_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LandAdoptionArgs {
    root: String,
    adoption_id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelAdoptionArgs {
    root: String,
    adoption_id: String,
}

#[derive(Deserialize)]
struct LoadTabSessionArgs {
    root: String,
}

/// `detect_providers` takes no arguments — the caller still posts a JSON body (`{}`), same as
/// every other driver route.
#[derive(Deserialize)]
struct NoArgs {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportRenderFailureArgs {
    input: RenderFailureDiagnosticInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsArgs {
    #[serde(default)]
    cursor: u64,
    #[serde(default)]
    epoch: Option<String>,
    #[serde(default)]
    wait_ms: u64,
}

#[derive(Deserialize)]
struct OpenProjectArgs {
    root: String,
}

#[derive(Deserialize)]
struct DiscoverGroundingArgs {
    root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRunArgs {
    root: String,
    prompt: String,
    operation_targets: Vec<String>,
}

#[derive(Deserialize)]
struct SetOpenTabsArgs {
    root: String,
    paths: Vec<String>,
}

/// Stands in for the agent's own not-yet-wired `create_document` MCP call (#413's live-run MCP
/// binding hasn't landed yet — see `commands::agent::create_document_direct`'s own docs) so a J2
/// e2e script can drive the real write + birth-notice shape through this loopback surface
/// (P2b-11b), the same "substitute the caller, never the logic" contract every other route here
/// already has.
#[derive(Deserialize)]
struct CreateDocumentArgs {
    root: String,
    path: String,
    content: String,
}

/// Stands in for the agent's own `propose_changes` MCP call (the J1 Phase B delivery pipe, #346) —
/// no spawned run has an `McpServer` wired in yet (`commands::agent::propose_changes_direct`'s own
/// docs), so a J1 acceptance script (#365) drives the real rebase/attribution/atomic-write logic
/// through this loopback surface instead, the same "substitute the caller, never the logic"
/// contract every other route here already has. `base_content` (what the agent last read) and
/// `edits` (raw JSON, `propose_changes`'s own wire shape: `{range:{offset,length}, replacement,
/// note?}[]`) let a script reproduce TD-7's partial-apply case end to end by writing over the file
/// between capturing `base_content` and calling this route.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposeChangesArgs {
    root: String,
    doc: String,
    base_content: String,
    edits: serde_json::Value,
    summary: String,
    change_set_meta: Option<serde_json::Value>,
}

/// Camel-cased (`runId`) to mirror what a real Tauri IPC caller sends (`invoke("stop_run", {
/// runId })` — Tauri's JS↔Rust arg-name convention, `src/comments/ipc.ts`'s own `threadId` calls
/// are the established precedent), even though this driver never goes through that macro itself.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopRunArgs {
    run_id: String,
}

// --- comments (P2b-11c: wires `commands::comments` in so J4's e2e journeys can drive it, mirroring
// every other route's "same commands, only the transport is substituted" contract) -----------------

#[derive(Deserialize)]
struct LoadCommentThreadsArgs {
    root: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCommentArgs {
    root: String,
    path: String,
    author: String,
    body: String,
    anchor: Option<CommentAnchorRange>,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCommentByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    author: String,
    body: String,
    anchor: Option<CommentAnchorRange>,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyCommentArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyCommentForRunArgs {
    #[serde(flatten)]
    reply: ReplyCommentArgs,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyCommentByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    body: String,
    defense: bool,
    published: bool,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviseOwnCommentArgs {
    root: String,
    path: String,
    target_id: String,
    body: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawOwnCommentArgs {
    root: String,
    path: String,
    target_id: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviseOwnCommentByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    body: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawOwnCommentByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    target_id: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdentityArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdentityByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReAnchorCommentArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    anchor: CommentAnchorRange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReAnchorCommentByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    anchor: CommentAnchorRange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressWithAiArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    run_id: String,
    guidance: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcludeAddressRunArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    run_id: String,
    outcome: RunConclusion,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressAllWithAiArgs {
    root: String,
    path: String,
    thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAddressRunArgs {
    root: String,
    path: String,
    thread_ids: Vec<String>,
    #[serde(default)]
    include_held_thread_ids: Vec<String>,
    author: String,
    timestamp: i64,
    prompt: String,
    reference_data: String,
    batch: bool,
    guidance: Option<String>,
}

/// `/patch_settings`'s request body mirrors the Tauri command's field-scoped `patch` argument.
#[derive(Deserialize)]
struct PatchSettingsArgs {
    patch: SettingsPatch,
}

#[derive(Deserialize)]
struct SetVoiceEnabledArgs {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectVoiceInputDeviceArgs {
    device_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelVoiceDictationArgs {
    expected_generation: u64,
}

/// `/append_transcript_event`'s request body — mirrors `commands::transcript::append_transcript_event`'s
/// `root`/`event` args.
#[derive(Deserialize)]
struct AppendTranscriptEventArgs {
    root: String,
    event: TranscriptEvent,
}

/// `/load_transcript`'s request body — mirrors `commands::transcript::load_transcript`'s `root` arg.
#[derive(Deserialize)]
struct LoadTranscriptArgs {
    root: String,
}

/// Arms the batch fault window (#538) — see [`BatchFault`].
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmBatchAddressFaultArgs {
    /// How many of the next batch's appends may land before its sidecar is made unwritable.
    fail_after: usize,
}

/// A one-shot fault window over the batch-address path, so an e2e script can reach FR-AGENT-6's
/// *partial* batch (#538): the next `/address_all_with_ai` after `/arm_batch_address_fault` has
/// its own sidecar made read-only once `fail_after` appends have landed, and the append after
/// that genuinely fails.
///
/// The fault is real and the failing code is the production code: the driver only changes the
/// filesystem inside the window `commands::comments::address_all_with_ai_watching` opens between
/// two appends — the error the batch reports comes from the real `store::service` write against a
/// real read-only file, so nothing here mocks or replaces the batch's own logic (test-plan §4,
/// CLAUDE.md: never mock in e2e). Without it a partial batch is unreachable from outside the
/// backend: every target writes to the same file, so failing it up front fails the *first* append,
/// and racing a real mutation into the gap would need a sleep (test-plan §7 forbids that).
///
/// Consumed by the batch it arms (so the interrupted run's *retry* behaves normally), and the
/// file's permissions are restored as soon as that batch returns — the window belongs to one run,
/// never to the driver process.
#[derive(Default)]
struct BatchFault {
    fail_after: Mutex<Option<usize>>,
}

/// A production announcement retained for the current project's lifetime. Unlike the former
/// project-files drain, one consumer never removes another consumer's facts: each browser advances
/// its own cursor through this append-only sequence.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverEvent {
    cursor: u64,
    event: &'static str,
    payload: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverEventBatch {
    epoch: String,
    cursor: u64,
    events: Vec<DriverEvent>,
}

struct DriverEventState {
    epoch: String,
    project_root: Option<std::path::PathBuf>,
    floor: u64,
    cursor: u64,
    events: Vec<DriverEvent>,
}

struct DriverEventLog {
    state: Mutex<DriverEventState>,
    changed: Condvar,
    waiters: AtomicUsize,
}

const MAX_EVENT_WAIT: Duration = Duration::from_secs(1);
const MAX_EVENT_WAITERS: usize = 8;
const EVENT_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
static ROUTE_REQUEST_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

fn bounded_event_wait(wait_ms: u64) -> Duration {
    Duration::from_millis(wait_ms).min(MAX_EVENT_WAIT)
}

impl Default for DriverEventLog {
    fn default() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            state: Mutex::new(DriverEventState {
                epoch: format!("{}-{nonce}-0", std::process::id()),
                project_root: None,
                floor: 0,
                cursor: 0,
                events: Vec::new(),
            }),
            changed: Condvar::new(),
            waiters: AtomicUsize::new(0),
        }
    }
}

impl DriverEventLog {
    fn append<T: Serialize>(&self, event: &'static str, payload: &T) {
        let payload = serde_json::to_value(payload).expect("driver event payload serializes");
        let mut state = self.state.lock().expect("driver event lock");
        state.cursor += 1;
        let cursor = state.cursor;
        state.events.push(DriverEvent {
            cursor,
            event,
            payload,
        });
        drop(state);
        self.changed.notify_all();
    }

    fn append_for<T: Serialize>(&self, root: &Path, event: &'static str, payload: &T) {
        let payload = serde_json::to_value(payload).expect("driver event payload serializes");
        self.append_for_value(root, event, payload, || {});
    }

    fn append_for_value(
        &self,
        root: &Path,
        event: &'static str,
        payload: serde_json::Value,
        after_lock: impl FnOnce(),
    ) {
        let root = canonical_root(root);
        let mut state = self.state.lock().expect("driver event lock");
        after_lock();
        if state.project_root.as_ref() != Some(&root) {
            return;
        }
        state.cursor += 1;
        let cursor = state.cursor;
        state.events.push(DriverEvent {
            cursor,
            event,
            payload,
        });
        drop(state);
        self.changed.notify_all();
    }

    fn project_opened(&self, root: &Path) {
        let root = canonical_root(root);
        let mut state = self.state.lock().expect("driver event lock");
        if state.project_root.as_ref() == Some(&root) {
            return;
        }
        state.project_root = Some(root);
        self.reset_locked(&mut state);
    }

    fn project_closed(&self) {
        let mut state = self.state.lock().expect("driver event lock");
        if state.project_root.take().is_some() {
            self.reset_locked(&mut state);
        }
    }

    fn reset_locked(&self, state: &mut DriverEventState) {
        state.floor = state.cursor;
        state.events.clear();
        let generation = state
            .epoch
            .rsplit_once('-')
            .and_then(|(_, value)| value.parse::<u64>().ok())
            .unwrap_or(0)
            + 1;
        let prefix = state
            .epoch
            .rsplit_once('-')
            .map_or(state.epoch.as_str(), |v| v.0);
        state.epoch = format!("{prefix}-{generation}");
        self.changed.notify_all();
    }

    fn poll(&self, args: EventsArgs) -> DriverEventBatch {
        let requested_wait = bounded_event_wait(args.wait_ms);
        let mut state = self.state.lock().expect("driver event lock");
        let initial_epoch = state.epoch.clone();
        let available = |state: &DriverEventState| {
            args.epoch.as_deref() != Some(state.epoch.as_str())
                || state.cursor > args.cursor.max(state.floor)
        };
        if !available(&state) && !requested_wait.is_zero() {
            let (next, _) = self
                .changed
                .wait_timeout_while(state, requested_wait, |current| {
                    current.epoch == initial_epoch && !available(current)
                })
                .expect("driver event wait lock");
            state = next;
        }
        let cursor = if args.epoch.as_deref() == Some(state.epoch.as_str()) {
            args.cursor.max(state.floor)
        } else {
            state.floor
        };
        DriverEventBatch {
            epoch: state.epoch.clone(),
            cursor: state.cursor,
            events: state
                .events
                .iter()
                .filter(|event| event.cursor > cursor)
                .cloned()
                .collect(),
        }
    }

    fn try_acquire_waiter(self: &Arc<Self>) -> Option<EventWaiter> {
        let previous = self.waiters.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_EVENT_WAITERS {
            self.waiters.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(EventWaiter(Arc::clone(self)))
    }
}

struct DriverSettingsObserver(Arc<DriverEventLog>);

impl SettingsObserver for DriverSettingsObserver {
    fn changed(&self, settings: &Settings) {
        self.0.append(SETTINGS_CHANGED_EVENT, settings);
    }
}

struct EventWaiter(Arc<DriverEventLog>);

impl Drop for EventWaiter {
    fn drop(&mut self) {
        self.0.waiters.fetch_sub(1, Ordering::AcqRel);
    }
}

/// One observer is bound to one real open-project identity. That root tag keeps a late callback
/// from a displaced project from leaking into its successor's epoch.
struct DriverProjectObserver {
    events: Arc<DriverEventLog>,
    root: std::path::PathBuf,
    state: Mutex<DriverProjectObserverState>,
}

#[derive(Default)]
struct DriverProjectObserverState {
    active: bool,
    pending: Vec<(&'static str, serde_json::Value)>,
}

impl DriverProjectObserver {
    fn new(events: Arc<DriverEventLog>, root: impl Into<std::path::PathBuf>) -> Self {
        Self {
            events,
            root: root.into(),
            state: Mutex::new(DriverProjectObserverState::default()),
        }
    }

    fn announce<T: Serialize>(&self, event: &'static str, payload: &T) {
        let value = serde_json::to_value(payload).expect("driver project event serializes");
        let mut state = self.state.lock().expect("driver project observer lock");
        if state.active {
            self.events.append_for(&self.root, event, &value);
        } else {
            state.pending.push((event, value));
        }
    }

    /// Makes this observer live after its project transition has actually succeeded. Announcements
    /// produced while `OpenProject::open` was binding are retained and flushed in their original
    /// order; a failed open never activates or publishes them.
    fn activate(&self) {
        let mut state = self.state.lock().expect("driver project observer lock");
        state.active = true;
        for (event, payload) in state.pending.drain(..) {
            self.events.append_for(&self.root, event, &payload);
        }
    }
}

impl ProjectFilesObserver for DriverProjectObserver {
    fn refresh_started(&self) {
        self.announce(PROJECT_FILES_EVENT, &ProjectFilesRefreshNotice::Started);
    }

    fn refresh_completed(&self, snapshot: &ProjectFilesSnapshot) {
        self.announce(
            PROJECT_FILES_EVENT,
            &ProjectFilesRefreshNotice::Completed {
                snapshot: snapshot.clone(),
            },
        );
    }

    fn refresh_failed(&self, error: &ProjectFilesError) {
        self.announce(
            PROJECT_FILES_EVENT,
            &ProjectFilesRefreshNotice::Failed {
                error: error.clone(),
            },
        );
    }
}

impl DeliveryObserver for DriverProjectObserver {
    fn delivered(&self, notice: &DeliveryNotice) {
        self.announce(DELIVERY_EVENT, notice);
    }
}

impl cowrite_lib::agent::permission::PermissionObserver for DriverProjectObserver {
    fn changed(&self, state: &cowrite_lib::agent::permission::PermissionState) {
        self.announce(cowrite_lib::commands::agent::PERMISSION_EVENT, state);
    }
}

impl DocumentBirthObserver for DriverProjectObserver {
    fn created(&self, notice: &DocumentBirthNotice) {
        self.announce(DOCUMENT_BIRTH_EVENT, notice);
    }
}

#[cfg(test)]
mod driver_voice_event_tests {
    use super::*;
    use cowrite_lib::voice::settings::VoiceDictationEvent;

    #[test]
    fn dictation_partial_keeps_generation_through_driver_poll() {
        let events = DriverEventLog::default();
        events.append(
            cowrite_lib::commands::voice::VOICE_DICTATION_EVENT,
            &VoiceDictationEvent::Partial {
                generation: 37,
                text: "provisional words".into(),
            },
        );
        let batch = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        assert_eq!(
            serde_json::to_value(batch.events).unwrap(),
            serde_json::json!([{
                "cursor": 1,
                "event": "voice://dictation",
                "payload": {
                    "kind": "partial",
                    "generation": 37,
                    "text": "provisional words",
                },
            }])
        );
    }
}

#[cfg(test)]
mod driver_project_files_event_tests {
    use super::*;

    #[test]
    fn project_files_event_queue_carries_started_completed_and_failed_notices() {
        let events = Arc::new(DriverEventLog::default());
        let root = tempfile::tempdir().unwrap();
        events.project_opened(root.path());
        let observer = DriverProjectObserver::new(Arc::clone(&events), root.path());
        observer.activate();
        observer.refresh_started();
        observer.refresh_completed(&ProjectFilesSnapshot {
            generation: 7,
            entries: Vec::new(),
            moves: Vec::new(),
        });
        observer.refresh_failed(&ProjectFilesError::UpdateFailed("scan failed".to_string()));

        let values = serde_json::to_value(
            events
                .poll(EventsArgs {
                    cursor: 0,
                    epoch: None,
                    wait_ms: 0,
                })
                .events,
        )
        .unwrap();
        assert_eq!(
            values,
            serde_json::json!([
                { "cursor": 1, "event": PROJECT_FILES_EVENT, "payload": { "status": "started" } },
                {
                    "cursor": 2,
                    "event": PROJECT_FILES_EVENT,
                    "payload": {
                        "status": "completed",
                        "snapshot": { "generation": 7, "entries": [], "moves": [] },
                    },
                },
                {
                    "cursor": 3,
                    "event": PROJECT_FILES_EVENT,
                    "payload": {
                        "status": "failed",
                        "error": { "kind": "UpdateFailed", "message": "scan failed" },
                    },
                },
            ])
        );
    }

    #[test]
    fn event_log_replays_every_event_in_order_without_destructive_reads() {
        let events = DriverEventLog::default();
        events.append(OPEN_DOCUMENT_EVENT, &serde_json::Value::Null);
        events.append(SAVE_DOCUMENT_AS_EVENT, &serde_json::Value::Null);

        let first = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        let second = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });

        assert_eq!(first.events.len(), 2);
        assert_eq!(
            second.events.len(),
            2,
            "a second cursor gets the same replay"
        );
        assert_eq!(first.events[0].event, OPEN_DOCUMENT_EVENT);
        assert_eq!(first.events[1].event, SAVE_DOCUMENT_AS_EVENT);
        let caught_up = events.poll(EventsArgs {
            cursor: first.cursor,
            epoch: Some(first.epoch),
            wait_ms: 0,
        });
        assert!(caught_up.events.is_empty());
    }

    #[test]
    fn same_project_retains_history_while_replacement_and_close_fence_it() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let events = DriverEventLog::default();
        events.project_opened(first.path());
        events.append(OPEN_DOCUMENT_EVENT, &serde_json::Value::Null);
        let before = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });

        events.project_opened(first.path());
        let retained = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        assert_eq!(retained.events.len(), 1);
        assert_eq!(retained.epoch, before.epoch);

        events.project_opened(second.path());
        let replaced = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        assert!(replaced.events.is_empty());
        assert_ne!(replaced.epoch, before.epoch);

        events.append(SAVE_DOCUMENT_AS_EVENT, &serde_json::Value::Null);
        events.project_closed();
        let closed = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        assert!(closed.events.is_empty());
        assert_ne!(closed.epoch, replaced.epoch);
    }

    #[test]
    fn cursor_ahead_of_a_restarted_driver_recovers_through_epoch() {
        let events = DriverEventLog::default();
        events.append(OPEN_DOCUMENT_EVENT, &serde_json::Value::Null);
        let batch = events.poll(EventsArgs {
            cursor: u64::MAX,
            epoch: Some("an older process".to_string()),
            wait_ms: 0,
        });
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.cursor, 1);
    }

    #[test]
    fn project_scoped_observer_refuses_a_notice_for_another_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let events = Arc::new(DriverEventLog::default());
        events.project_opened(first.path());
        let wrong = DriverProjectObserver::new(Arc::clone(&events), second.path());
        wrong.activate();
        wrong.created(&DocumentBirthNotice {
            path: "wrong.md".to_string(),
            size: 5,
        });
        assert!(events
            .poll(EventsArgs {
                cursor: 0,
                epoch: None,
                wait_ms: 0
            })
            .events
            .is_empty());
    }

    #[test]
    fn event_waiter_permits_are_hard_bounded_and_reusable_after_cancellation() {
        let events = Arc::new(DriverEventLog::default());
        let permits: Vec<_> = (0..MAX_EVENT_WAITERS)
            .map(|_| events.try_acquire_waiter().expect("capacity permit"))
            .collect();
        assert!(events.try_acquire_waiter().is_none());
        drop(permits);
        assert!(events.try_acquire_waiter().is_some());
    }

    #[test]
    fn eight_non_reading_event_clients_time_out_and_release_every_waiter_permit() {
        use socket2::{Domain, Protocol, SockAddr, Socket, Type};
        use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
        use std::sync::Barrier;
        use std::time::Instant;

        fn backpressured_pair() -> (TcpStream, TcpStream) {
            let listener = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
            listener.set_send_buffer_size(1_024).unwrap();
            listener
                .bind(&SockAddr::from(SocketAddr::V4(SocketAddrV4::new(
                    Ipv4Addr::LOCALHOST,
                    0,
                ))))
                .unwrap();
            listener.listen(1).unwrap();
            let address = listener.local_addr().unwrap();

            let client = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
            client.set_recv_buffer_size(1_024).unwrap();
            client.connect(&address).unwrap();
            let (server, _) = listener.accept().unwrap();
            server.set_send_buffer_size(1_024).unwrap();
            (server.into(), client.into())
        }

        let events = Arc::new(DriverEventLog::default());
        let start = Arc::new(Barrier::new(MAX_EVENT_WAITERS + 1));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let mut clients = Vec::with_capacity(MAX_EVENT_WAITERS);
        let mut writers = Vec::with_capacity(MAX_EVENT_WAITERS);
        for _ in 0..MAX_EVENT_WAITERS {
            let (server, client) = backpressured_pair();
            clients.push(client);
            let permit = events.try_acquire_waiter().expect("event waiter permit");
            let start = Arc::clone(&start);
            let entered_tx = entered_tx.clone();
            let completed_tx = completed_tx.clone();
            writers.push(std::thread::spawn(move || {
                start.wait();
                let outcome = write_event_response_with(server, permit, |stream| {
                    entered_tx.send(()).unwrap();
                    let chunk = [b'x'; 64 * 1024];
                    loop {
                        stream.write_all(&chunk)?;
                    }
                });
                completed_tx.send(outcome).unwrap();
            }));
        }
        drop(entered_tx);
        drop(completed_tx);
        assert!(events.try_acquire_waiter().is_none());
        let started = Instant::now();
        start.wait();
        let entered_deadline = started + EVENT_RESPONSE_WRITE_TIMEOUT;
        let mut entered = 0;
        while entered < MAX_EVENT_WAITERS {
            let remaining = entered_deadline.saturating_duration_since(Instant::now());
            match entered_rx.recv_timeout(remaining) {
                Ok(()) => entered += 1,
                Err(_) => break,
            }
        }
        let all_permits_held_during_write = events.try_acquire_waiter().is_none();
        let mut outcomes = Vec::with_capacity(MAX_EVENT_WAITERS);
        let deadline = started + EVENT_RESPONSE_WRITE_TIMEOUT * 2;
        while outcomes.len() < MAX_EVENT_WAITERS {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match completed_rx.recv_timeout(remaining) {
                Ok(outcome) => outcomes.push(outcome),
                Err(_) => break,
            }
        }
        let completed_before_deadline = outcomes.len() == MAX_EVENT_WAITERS;
        drop(clients);
        for writer in writers {
            writer.join().expect("event response writer panicked");
        }
        assert_eq!(
            entered, MAX_EVENT_WAITERS,
            "not every event response entered its real socket write"
        );
        assert!(
            all_permits_held_during_write,
            "an in-flight event response released its waiter permit early"
        );
        assert!(
            completed_before_deadline,
            "only {}/{} non-reading event responses released before the bounded deadline",
            outcomes.len(),
            MAX_EVENT_WAITERS
        );
        for outcome in outcomes {
            let error =
                outcome.expect_err("a non-reading event client accepted an unbounded response");
            assert!(
                matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ),
                "event response ended for an unexpected reason: {error:?}"
            );
        }
        assert!(
            started.elapsed() >= EVENT_RESPONSE_WRITE_TIMEOUT / 2,
            "non-reading event responses ended before backpressure: {:?}",
            started.elapsed()
        );
        assert!(
            started.elapsed() < EVENT_RESPONSE_WRITE_TIMEOUT * 2,
            "non-reading event clients held capacity for {:?}",
            started.elapsed()
        );
        assert!(
            events.try_acquire_waiter().is_some(),
            "timed-out event responses did not release waiter capacity"
        );
    }

    #[test]
    fn event_response_deadline_survives_continuous_reader_progress() {
        let events = Arc::new(DriverEventLog::default());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let permit = events.try_acquire_waiter().unwrap();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let (outcome, bytes_read) = std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                let mut client = &client;
                let mut bytes = 0;
                let mut buffer = [0; 64 * 1024];
                loop {
                    match client.read(&mut buffer) {
                        Ok(0) | Err(_) => return bytes,
                        Ok(count) => bytes += count,
                    }
                }
            });
            let writer = scope.spawn(move || {
                let result = write_event_response_with(server, permit, |stream| loop {
                    stream.write_all(&[b'x'; 64 * 1024])?;
                });
                finished_tx.send(result).unwrap();
            });
            let outcome = finished_rx.recv_timeout(EVENT_RESPONSE_WRITE_TIMEOUT * 2);
            // The reader stands in for an external client. Close it even on regression so the
            // blocked writer cannot outlive a failed assertion or hang the test process.
            let _ = client.shutdown(std::net::Shutdown::Both);
            writer.join().unwrap();
            (outcome, reader.join().unwrap())
        });
        assert!(
            bytes_read > 64 * 1024,
            "the peer made no repeated socket progress"
        );
        let error = outcome
            .expect("continuous reader progress extended the response deadline")
            .expect_err("an unbounded event response completed successfully");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(events.waiters.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_reading_event_client_receives_the_complete_response_and_releases_its_permit() {
        let events = Arc::new(DriverEventLog::default());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(EVENT_RESPONSE_WRITE_TIMEOUT * 2))
            .unwrap();
        let (server, _) = listener.accept().unwrap();
        let permit = events.try_acquire_waiter().unwrap();
        let body = serde_json::json!({"events": ["a".repeat(128 * 1024)]}).to_string();
        let received = std::thread::scope(|scope| {
            let writer = scope.spawn(|| write_event_response(server, permit, 200, &body));
            let mut received = String::new();
            client.read_to_string(&mut received).unwrap();
            writer.join().unwrap().unwrap();
            received
        });
        let (headers, received_body) = received.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(headers.contains(&format!("Content-Length: {}\r\n", body.len())));
        assert_eq!(
            received_body, body,
            "event response bytes changed during deadline enforcement"
        );
        assert_eq!(events.waiters.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn client_wait_requests_are_capped_by_the_server() {
        assert_eq!(bounded_event_wait(60_000), MAX_EVENT_WAIT);
        assert_eq!(bounded_event_wait(25), Duration::from_millis(25));
    }

    #[test]
    fn long_poll_wakes_on_an_event_and_on_a_project_epoch_change() {
        let events = Arc::new(DriverEventLog::default());
        let initial = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        let (sent, received) = std::sync::mpsc::channel();
        let waiting = Arc::clone(&events);
        std::thread::spawn(move || {
            sent.send(waiting.poll(EventsArgs {
                cursor: initial.cursor,
                epoch: Some(initial.epoch),
                wait_ms: 1_000,
            }))
            .unwrap();
        });
        events.append(OPEN_DOCUMENT_EVENT, &serde_json::Value::Null);
        let event_batch = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event_batch.events.len(), 1);

        let (sent, received) = std::sync::mpsc::channel();
        let waiting = Arc::clone(&events);
        let cursor = event_batch.cursor;
        let epoch = event_batch.epoch;
        std::thread::spawn(move || {
            sent.send(waiting.poll(EventsArgs {
                cursor,
                epoch: Some(epoch),
                wait_ms: 1_000,
            }))
            .unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        events.project_opened(root.path());
        let reset = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(reset.events.is_empty());
    }

    #[test]
    fn project_replacement_cannot_land_between_a_root_check_and_append() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().to_path_buf();
        let second_root = second.path().to_path_buf();
        let events = Arc::new(DriverEventLog::default());
        events.project_opened(&first_root);
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let appending = Arc::clone(&events);
        let append = std::thread::spawn(move || {
            appending.append_for_value(
                &first_root,
                DOCUMENT_BIRTH_EVENT,
                serde_json::json!({ "path": "late.md", "size": 4 }),
                || {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            );
        });
        locked_rx.recv().unwrap();
        let replacing = Arc::clone(&events);
        let (replaced_tx, replaced_rx) = std::sync::mpsc::channel();
        let replace = std::thread::spawn(move || {
            replacing.project_opened(&second_root);
            replaced_tx.send(()).unwrap();
        });
        assert!(
            replaced_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "project replacement passed the root-check/append lock"
        );
        release_tx.send(()).unwrap();
        append.join().unwrap();
        replace.join().unwrap();

        let batch = events.poll(EventsArgs {
            cursor: 0,
            epoch: None,
            wait_ms: 0,
        });
        assert!(
            batch.events.is_empty(),
            "outgoing event crossed into successor: {:?}",
            batch.events
        );
    }
}

impl BatchFault {
    fn arm(&self, fail_after: usize) {
        *self.fail_after.lock().expect("batch fault lock") = Some(fail_after);
    }

    /// Takes the armed count, disarming it — a batch always runs against at most one fault.
    fn take(&self) -> Option<usize> {
        self.fail_after.lock().expect("batch fault lock").take()
    }
}

/// Makes `path` read-only, returning its previous permissions so the caller can put it back.
/// `None` when the file can't be read or re-permissioned at all, in which case no fault was
/// installed and the batch simply completes — an armed window that silently half-applied would be
/// worse than one that never fired.
fn make_unwritable(path: &Path) -> Option<fs::Permissions> {
    let original = fs::metadata(path).ok()?.permissions();
    let mut read_only = original.clone();
    read_only.set_readonly(true);
    fs::set_permissions(path, read_only).ok()?;
    Some(original)
}

/// The real `address_all_with_ai`, run inside whatever fault window is armed ([`BatchFault`]) —
/// its own function rather than a block in the dispatch table, which is otherwise a flat map of
/// route → command call.
fn address_all(
    a: AddressAllWithAiArgs,
    fault: &BatchFault,
) -> Result<comments::BatchAddressOutcome, comments::CommandError> {
    // Armed or not, the batch below is the production one: an unarmed window is the same no-op
    // closure the shipped `address_all_with_ai` passes.
    let fail_after = fault.take();
    let mut faulted = None;
    let outcome = comments::address_all_with_ai_watching(
        a.root,
        a.path,
        a.thread_ids,
        a.author,
        a.timestamp,
        a.run_id,
        |landed, sidecar| {
            if Some(landed) == fail_after {
                faulted =
                    make_unwritable(sidecar).map(|original| (sidecar.to_path_buf(), original));
            }
        },
    );
    // The window closes with the batch that opened it, so the next run — the retry a user makes
    // after an interruption — writes to a normal file again.
    if let Some((sidecar, original)) = faulted {
        let _ = fs::set_permissions(sidecar, original);
    }
    outcome
}

fn start_address_run(
    queue: &RunQueue,
    a: StartAddressRunArgs,
    fault: &BatchFault,
) -> Result<comments::StartAddressRunOutcome, comments::CommandError> {
    let fail_after = if a.batch { fault.take() } else { None };
    let mut faulted = None;
    let outcome = comments::start_address_run_on_watching_with_inclusions(
        queue,
        a.root,
        a.path,
        a.thread_ids,
        a.include_held_thread_ids,
        a.author,
        a.timestamp,
        a.prompt,
        a.reference_data,
        a.batch,
        a.guidance,
        |landed, sidecar| {
            if Some(landed) == fail_after {
                faulted =
                    make_unwritable(sidecar).map(|original| (sidecar.to_path_buf(), original));
            }
        },
    );
    if let Some((sidecar, original)) = faulted {
        let _ = fs::set_permissions(sidecar, original);
    }
    outcome
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkChangesArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkChangesForRunArgs {
    #[serde(flatten)]
    link: LinkChangesArgs,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecideLinkedChangesArgs {
    root: String,
    path: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    decision: LinkedChangeDecision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecideLinkedChangesByIdArgs {
    root: String,
    doc_id: String,
    content: String,
    thread_id: String,
    author: String,
    timestamp: i64,
    change_ids: Vec<String>,
    decision: LinkedChangeDecision,
}

/// Escape hatch (never set by Playwright, CI, or anything else in this repo) for
/// [`guarded_spawn_claude_run`]'s fail-closed default: anything but the exact value `1` — unset
/// included — means "refuse", exactly the property #1149 needed ([`allow_real_spawn`] holds that
/// reading). Deliberately its own name, not `COWRITE_CLAUDE_BIN`: this gate decides whether the
/// driver may delegate to the production spawn path at all, while the provider override selects
/// which executable that path invokes (#1206).
const ALLOW_REAL_CLAUDE_SPAWN_VAR: &str = "COWRITE_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN";

/// [`spawn_claude_run`] behind a fail-closed gate: refuses — before `claude_invocation` builds an
/// argv or anything touches `PATH` — unless `allow_real_spawn` is `true`. Split from
/// [`guarded_spawn_claude_run`] so the refusal is unit-testable without any process-wide env
/// mutation (`cargo test` runs this binary's tests on parallel threads sharing one process
/// environment; a pure `bool`-in, `Result`-out function needs none of that).
fn guarded_spawn(
    allow_real_spawn: bool,
    session: &SharedOpenProject,
    request: &RunRequest,
) -> Result<AgentSession, SessionError> {
    if !allow_real_spawn {
        return Err(SessionError::Spawn(std::io::Error::other(format!(
            "test-driver refuses to spawn the real, billable `claude` CLI by default (#1149) — \
             set {ALLOW_REAL_CLAUDE_SPAWN_VAR}=1 first if a real, billed run through this driver \
             is genuinely what you want"
        ))));
    }
    spawn_claude_run(session, request)
}

/// Whether a raw [`ALLOW_REAL_CLAUDE_SPAWN_VAR`] reading opens the hatch. Only the exact value the
/// refusal message names (`1`) does: a presence check would have made `…=0` — the spelling a reader
/// would reach for to turn the hatch *off* — enable real billing instead (#1149 PR review, round 2).
/// Pure over the reading so every value is unit-testable without mutating this process's
/// environment.
fn allow_real_spawn(var: Option<OsString>) -> bool {
    var.is_some_and(|value| value == "1")
}

/// [`guarded_spawn`], reading its `allow_real_spawn` bit from [`ALLOW_REAL_CLAUDE_SPAWN_VAR`] —
/// what [`serve`] actually wires into its `RunQueue`. `serve_with_queue`'s own callers get an
/// equivalent guard for free by injecting their own `Spawn` double instead of the real
/// `spawn_claude_run`; `serve` has no caller-supplied double to lean on, so it needs one of its own
/// (#1149: this function used to be exactly `spawn_claude_run`, unguarded).
fn guarded_spawn_claude_run(
    session: &SharedOpenProject,
    request: &RunRequest,
) -> Result<AgentSession, SessionError> {
    guarded_spawn(
        allow_real_spawn(std::env::var_os(ALLOW_REAL_CLAUDE_SPAWN_VAR)),
        session,
        request,
    )
}

/// Serves accepted connections on `listener` forever, spawning agent runs through
/// [`guarded_spawn_claude_run`] — the production entry point (`test-driver` binary, dev-mode e2e)
/// and the one every non-agent test in `tests/http.rs` uses. The default guard refusal, or a
/// permitted run whose resolved Claude binary cannot be spawned, becomes that run's own `failed`
/// phase (never a driver-route error), exactly as it would through the real Tauri command. A D23
/// caller that deliberately opens the guard can set `COWRITE_CLAUDE_BIN` to a deterministic fake;
/// the production default remains `claude` on `PATH`. See [`serve_with_queue`] for why most
/// agent-run tests use that injected seam instead.
pub fn serve(listener: TcpListener) {
    // Mirrors `src-tauri/src/lib.rs`'s own `.setup()`: one open-project slot per driver instance,
    // opened by `/open_project` and read by the spawner, so a run started through the driver is
    // auto-wired to that project's Cowrite tool surface exactly as one started through Tauri IPC is
    // (TD-1/TD-17, #472).
    let session = new_session();
    let spawn_session = Arc::clone(&session);
    let queue = RunQueue::with_observers(
        move |request: &RunRequest| guarded_spawn_claude_run(&spawn_session, request),
        Arc::new(NoopEmitter),
        Arc::new(OpenProjectRunObserver::new(Arc::clone(&session))),
    );
    serve_with_queue_in(
        listener,
        queue,
        session,
        production_voice_transport_factory(),
    );
}

/// Serves accepted connections on `listener` forever (one request per connection, no
/// keep-alive — this is a test-only loopback surface, not a production server). Each `POST
/// /<command>` dispatches straight to the same `commands::document`/`commands::agent` functions
/// the Tauri IPC layer calls: the driver is a transport substitute, not a reimplementation.
///
/// Holds one `queue` for the lifetime of the server (mirrors `lib.rs`'s own app-instance-scoped
/// queue, M7/tech-design §3.5: one project runs per app instance, so one global queue is correct
/// by construction here too). Exposed as its own function (rather than folded into [`serve`]) so
/// `tests/http.rs`'s agent-run coverage can inject a scenario/always-fails [`Spawn`](cowrite_lib::agent::run_queue::Spawn)
/// double instead of the real `spawn_claude_run` [`serve`] always uses — spawning the *real* CLI
/// from `cargo test` would fire a real `claude` process, costing real provider tokens (and
/// non-deterministic output) on any machine that happens to have `claude` on `PATH`, this harness's
/// own dev/CI machines included, exactly the live-call risk `agent::run_queue`'s own tests avoid by
/// injecting a fake `Spawn`.
///
/// The HTTP driver remains request/response (§3.7): run progress is read from `/run_state`, while
/// production backend notices are long-polled from the cursor-backed `/events` log. Event waits are
/// the sole route dispatched off the serial command lane, so they cannot stall an ordinary command.
pub fn serve_with_queue(listener: TcpListener, queue: RunQueue) {
    serve_with_queue_in(
        listener,
        queue,
        new_session(),
        production_voice_transport_factory(),
    );
}

/// Test-only transport seam for the real HTTP command route. A held fake stream proves the
/// driver keeps status and cancel reachable while a model response is still in progress.
pub type VoiceTransportFactory =
    Arc<dyn Fn() -> Result<Box<dyn DownloadTransport + Send + Sync>, VoiceError> + Send + Sync>;

fn production_voice_transport_factory() -> VoiceTransportFactory {
    Arc::new(|| {
        HttpTransport::new()
            .map(|transport| Box::new(transport) as Box<dyn DownloadTransport + Send + Sync>)
            .map_err(|_| VoiceError::DownloadUnavailable)
    })
}

struct VoiceTransport(Box<dyn DownloadTransport + Send + Sync>);

impl DownloadTransport for VoiceTransport {
    fn open(
        &self,
        url: &str,
        offset: u64,
        cancel: &cowrite_lib::voice::model_download::DownloadCancellation,
    ) -> Result<DownloadResponse, DownloadFailure> {
        self.0.open(url, offset, cancel)
    }
}

pub fn serve_with_queue_and_voice_transport(
    listener: TcpListener,
    queue: RunQueue,
    transport: VoiceTransportFactory,
) {
    serve_with_queue_in(listener, queue, new_session(), transport);
}

/// Every piece of server-lifetime state a connection may need, bundled behind one reference so
/// `handle`/`dispatch` take one parameter each instead of accumulating a positional one per route
/// family (clippy's `too_many_arguments` — `dispatch` hit 8 before this bundling). Built once in
/// [`serve_with_queue_in`] and borrowed for every accepted connection, exactly like the loose
/// bindings it replaces.
struct DriverState {
    queue: Arc<RunQueue>,
    fault: Arc<BatchFault>,
    session: SharedOpenProject,
    events: Arc<DriverEventLog>,
    settings: Arc<SettingsService>,
    voice: Arc<ProductionVoiceRuntime>,
    voice_transport: VoiceTransportFactory,
    reconciled: Arc<comments::ReconciledDocs>,
    data_dir: std::path::PathBuf,
    tab_sessions: Arc<TabSessionCoordinator>,
    adoptions: Arc<AdoptionCoordinator>,
}

/// [`serve_with_queue`] against a caller-supplied open-project session — what [`serve`] uses so the
/// slot `/open_project` fills is the same one its spawner reads the bound MCP server out of.
fn serve_with_queue_in(
    listener: TcpListener,
    queue: RunQueue,
    session: SharedOpenProject,
    voice_transport: VoiceTransportFactory,
) {
    // Server-lifetime like `queue`, for the same reason: one project runs per app instance, so one
    // armed-fault cell is all a script can meaningfully address (it is consumed by the next batch
    // either way — see [`BatchFault`]).
    let fault = Arc::new(BatchFault::default());
    let events = Arc::new(DriverEventLog::default());
    // Server-lifetime like `queue` (issue #1381) — mirrors `lib.rs`'s own `.manage(ReconciledDocs::
    // default())`: one gate per driver instance, so `/load_comment_threads`'s startup reconciliation
    // fires at most once per document for this driver's whole run, the same "at startup, not every
    // load" contract the real Tauri command has.
    let reconciled = Arc::new(comments::ReconciledDocs::default());
    // `commands::settings`/`commands::transcript` normally resolve the OS app-config/app-local-data
    // dirs from a Tauri `AppHandle` this driver has no runtime to produce (#1395); this stands in
    // for both, scoped to this driver process's own lifetime — never a fixed/shared path, so two
    // driver instances (e.g. concurrent Playwright runs on distinct ports) never collide.
    let data_dir = TempDir::new().expect("create test-driver settings/transcript data dir");
    let settings = Arc::new(
        SettingsService::watch(
            &settings_store::settings_file(data_dir.path()),
            Arc::new(DriverSettingsObserver(Arc::clone(&events))),
        )
        .expect("start test-driver settings service"),
    );
    let tab_sessions = Arc::new(TabSessionCoordinator::new(data_dir.path().to_path_buf()));
    let adoptions = Arc::new(AdoptionCoordinator::new(data_dir.path().to_path_buf()));
    let state = Arc::new(DriverState {
        queue: Arc::new(queue),
        fault,
        session,
        events,
        settings,
        voice: Arc::new(production_runtime(data_dir.path())),
        voice_transport,
        reconciled,
        data_dir: data_dir.path().to_path_buf(),
        tab_sessions,
        adoptions,
    });
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle(stream, &state),
            Err(_) => continue,
        }
    }
}

fn handle(mut stream: TcpStream, state: &Arc<DriverState>) {
    // The dev-mode e2e caller (`src/editor/ipc.ts`, D23) is the Vite dev server's page fetching
    // this driver's *different* origin — the browser preflights that cross-origin POST with an
    // OPTIONS request, and refuses the real response too unless it carries the same CORS headers.
    // A loopback test-only surface has no meaningful "origin" to restrict, so it allows any.
    //
    let request = match read_request(&stream) {
        Ok((method, _, _)) if method == "OPTIONS" => (204, String::new()),
        Ok((method, _, _)) if method != "POST" => (405, error_body("method not allowed")),
        Ok((_, path, body)) if path == "/events" => {
            let Some(permit) = state.events.try_acquire_waiter() else {
                let _ = write_response(
                    &mut stream,
                    503,
                    &error_body("event waiter capacity reached"),
                );
                return;
            };
            let state = Arc::clone(state);
            std::thread::spawn(move || {
                let (status, body) = dispatch(&path, &body, &state);
                let _ = write_event_response(stream, permit, status, &body);
            });
            return;
        }
        Ok((_, path, body)) if path == "/download_voice_model" => {
            // The response still completes when the command does, but this request cannot occupy
            // the serial accept lane: Cancel and status must be callable during a slow stream.
            let state = Arc::clone(state);
            std::thread::spawn(move || {
                let (status, body) = dispatch(&path, &body, &state);
                let _ = write_response(&mut stream, status, &body);
            });
            return;
        }
        Ok((_, path, body)) => dispatch(&path, &body, state),
        Err(error) if is_timeout(&error) => (408, error_body("request read timed out")),
        Err(_) => (400, error_body("malformed request")),
    };
    let _ = write_response(&mut stream, request.0, &request.1);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecidePermissionArgs {
    run_id: String,
    request_id: String,
    decision: cowrite_lib::agent::permission::PermissionDecision,
}

fn dispatch(path: &str, body: &str, state: &DriverState) -> (u16, String) {
    let queue = &state.queue;
    let fault = &state.fault;
    let session = &state.session;
    let events = &state.events;
    let settings = &state.settings;
    let voice = &state.voice;
    let voice_transport = &state.voice_transport;
    let reconciled = &state.reconciled;
    let data_dir = &state.data_dir;
    let tab_sessions = &state.tab_sessions;
    let adoptions = &state.adoptions;
    match path {
        "/permission_state" => run(body, |_: NoArgs| {
            Ok::<_, String>(cowrite_lib::commands::agent::permission_state_on(session))
        }),
        "/decide_permission" => run(body, |a: DecidePermissionArgs| {
            cowrite_lib::commands::agent::decide_permission_on(
                session,
                a.run_id,
                a.request_id,
                a.decision,
            )
        }),
        // The direct TD-17 construction seam (#472) used only by D23's document fixture. Product
        // folder choices use `/route_project_open` below. All notices share the cursor-backed
        // polling transport.
        "/open_project" => run(body, |a: OpenProjectArgs| {
            let changes_project = session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .is_none_or(|open| !open.is_root(&a.root));
            let observer = Arc::new(DriverProjectObserver::new(
                Arc::clone(events),
                std::path::PathBuf::from(&a.root),
            ));
            let result = open_project_on(
                session,
                a.root.clone(),
                ProjectObservers {
                    permissions: Some(Arc::clone(&observer)
                        as Arc<dyn cowrite_lib::agent::permission::PermissionObserver>),
                    delivery: Some(Arc::clone(&observer) as Arc<dyn DeliveryObserver>),
                    births: Some(Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>),
                    project_files: Some(Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>),
                },
            );
            // Tauri dispatches events synchronously, but D23 queues them until the next poll. Once
            // a project replacement succeeds, an undrained notice can only name the outgoing
            // project; discard it before the HTTP response lets the new rail mount. A same-project
            // no-op keeps its queue, and a failed replacement keeps the still-live project's queue.
            if changes_project && result.is_ok() {
                events.project_opened(Path::new(&a.root));
            }
            if result.is_ok() {
                observer.activate();
            }
            result
        }),
        // D23 cannot drive two GUI processes from one Playwright session, so TD-20(10) calls for
        // a fake router at this boundary. It mirrors the Rust-owned outcome/notice vocabulary and
        // the choosing-instance invariant while leaving every production routing decision in
        // `instances::ProjectRouter`: empty adopts, same-root stays, another-root reports launch
        // without replacing the driver's live project.
        "/route_project_open" => run(body, |a: OpenProjectArgs| {
            let sequence = ROUTE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let request_id = format!("00000000-0000-0000-0000-{sequence:012x}");
            let canonical = match cowrite_lib::store::project_identity::require_canonical_root(
                Path::new(&a.root),
            ) {
                Ok(root) => root,
                Err(_) => {
                    let root = a.root;
                    let outcome = ProjectRouteOutcome::failed_undetermined(
                        root.clone(),
                        RouteFailure::ProjectUnavailable,
                    );
                    events.append(
                        PROJECT_ROUTING_EVENT,
                        &serde_json::json!({
                            "status": "requesting",
                            "request_id": &request_id,
                            "root": root,
                            "queued": 0,
                        }),
                    );
                    events.append(
                        PROJECT_ROUTING_EVENT,
                        &serde_json::json!({
                            "status": "finished",
                            "request_id": &request_id,
                            "outcome": &outcome,
                        }),
                    );
                    return Ok::<_, String>(outcome);
                }
            };
            let root = a.root;
            let current_root = session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .map(|open| open.root().to_path_buf());
            let outcome = match current_root {
                Some(current) if current == canonical => {
                    ProjectRouteOutcome::AlreadyOpenHere { root: root.clone() }
                }
                Some(_) => ProjectRouteOutcome::OpenedNew { root: root.clone() },
                None => {
                    let observer = Arc::new(DriverProjectObserver::new(
                        Arc::clone(events),
                        canonical.clone(),
                    ));
                    match open_project_on(
                        session,
                        root.clone(),
                        ProjectObservers {
                            permissions: Some(Arc::clone(&observer)
                                as Arc<dyn cowrite_lib::agent::permission::PermissionObserver>),
                            delivery: Some(Arc::clone(&observer) as Arc<dyn DeliveryObserver>),
                            births: Some(Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>),
                            project_files: Some(
                                Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>
                            ),
                        },
                    ) {
                        Ok(()) => {
                            events.project_opened(&canonical);
                            observer.activate();
                            ProjectRouteOutcome::AdoptedHere { root: root.clone() }
                        }
                        Err(_) => ProjectRouteOutcome::failed_undetermined(
                            root.clone(),
                            RouteFailure::OpenFailed,
                        ),
                    }
                }
            };
            events.append(
                PROJECT_ROUTING_EVENT,
                &serde_json::json!({
                    "status": "requesting",
                    "request_id": &request_id,
                    "root": root,
                    "queued": 0,
                }),
            );
            events.append(
                PROJECT_ROUTING_EVENT,
                &serde_json::json!({
                    "status": "finished",
                    "request_id": &request_id,
                    "outcome": &outcome,
                }),
            );
            Ok::<_, String>(outcome)
        }),
        "/close_project" => run(body, |_: NoArgs| {
            let had_project = session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_some();
            let result = close_project_on(session, queue);
            if had_project && result.is_ok() {
                events.project_closed();
            }
            result
        }),
        "/current_project" => run(body, |_: NoArgs| {
            Ok::<_, String>(current_project_on(session))
        }),
        "/refresh_project_files" => run(body, |_: NoArgs| refresh_project_files_on(session)),
        "/events" => run(body, |a: EventsArgs| Ok::<_, String>(events.poll(a))),
        "/request_open_document" => run(body, |_: NoArgs| {
            events.append(OPEN_DOCUMENT_EVENT, &serde_json::Value::Null);
            Ok::<_, String>(())
        }),
        "/request_save_document_as" => run(body, |_: NoArgs| {
            events.append(SAVE_DOCUMENT_AS_EVENT, &serde_json::Value::Null);
            Ok::<_, String>(())
        }),
        "/project_path_is_enumerable" => run(body, |a: ProjectPathArgs| {
            Ok::<_, String>(project_path_is_enumerable_on(&a.path))
        }),
        "/recreate_missing_document_capability" => run(body, |a: RecreateCapabilityArgs| {
            Ok::<_, String>(recreate_missing_document_capability_on(session, a.path))
        }),
        "/recreate_missing_document" => run(body, |a: RecreateArgs| {
            Ok::<_, String>(recreate_missing_document_on(
                session,
                a.path,
                a.content,
                a.normalize_line_endings,
            ))
        }),
        "/open_document" => run(body, |a: OpenArgs| open_document(a.root, a.path)),
        "/parse_changes" => run(body, |a: ParseChangesArgs| parse_changes(a.doc, a.content)),
        "/parse_changes_by_id" => run(body, |a: IdContentArgs| {
            parse_changes_by_id(a.root, a.doc_id, a.content)
        }),
        "/capture_anchor" => run(body, |a: CaptureAnchorArgs| {
            capture_anchor(a.content, a.utf16_offset, a.utf16_length)
        }),
        "/resolve_anchor" => run(body, |a: ResolveAnchorArgs| {
            Ok::<Option<AnchorPosition>, CommandError>(resolve_anchor(a.content, a.anchor))
        }),
        "/save_document" => run(body, |a: SaveArgs| {
            save_document_on(session, a.root, a.path, a.content, a.normalize_line_endings)
        }),
        "/save_document_as" => run(body, |a: SaveAsArgs| {
            save_document_as_on(
                session,
                a.root,
                a.from_path,
                a.to_path,
                a.content,
                a.normalize_line_endings,
            )
        }),
        "/begin_tab_session" => run(body, |a: BeginTabSessionArgs| {
            begin_tab_session_on(tab_sessions, a.root, a.writer_id, a.attachment_id)
        }),
        "/save_tab_session" => run(body, |a: SaveTabSessionArgs| {
            save_tab_session_on(
                tab_sessions,
                a.root,
                a.writer_id,
                a.attachment_id,
                a.expected_revision,
                a.session,
                a.policy,
            )
        }),
        "/prove_tab_session" => run(body, |a: SaveTabSessionArgs| {
            prove_tab_session_on(
                tab_sessions,
                a.root,
                a.writer_id,
                a.attachment_id,
                a.expected_revision,
                a.session,
            )
        }),
        "/end_tab_session" => run(body, |a: EndTabSessionArgs| {
            end_tab_session_on(tab_sessions, a.root, a.writer_id, a.attachment_id)
        }),
        "/prepare_adoption" => run(body, |a: PrepareAdoptionArgs| {
            prepare_adoption_on(
                adoptions,
                a.root,
                a.adoption_id,
                a.displaced_path,
                a.destination,
                a.doc_id,
                a.recovery_content_omitted,
                a.content,
                a.timestamp,
            )
        }),
        "/land_adoption" => run(body, |a: LandAdoptionArgs| {
            land_adoption_on(adoptions, session, a.root, a.adoption_id, a.content)
        }),
        "/commit_adoption" => run(body, |a: CommitAdoptionArgs| {
            commit_adoption_on(adoptions, a.root, a.adoption_id, a.landed_revision)
        }),
        "/cancel_adoption" => run(body, |a: CancelAdoptionArgs| {
            cancel_adoption_on(adoptions, a.root, a.adoption_id)
        }),
        "/reconcile_adoptions" => run(body, |a: LoadTabSessionArgs| {
            reconcile_adoptions_on(adoptions, a.root)
        }),
        "/mint_untitled_doc_id" => run(body, |a: LoadTabSessionArgs| {
            mint_untitled_doc_id_on(a.root)
        }),
        "/load_tab_session" => run(body, |a: LoadTabSessionArgs| load_tab_session(a.root)),
        "/set_open_tabs" => run(body, |a: SetOpenTabsArgs| {
            set_open_tabs_on(session, a.root, a.paths)
        }),
        // §7b's Corollary B routes (#1395): `settings/ipc.ts` and `timeline/ipc.ts` reach these
        // through `callBackend` exactly like every other route here. The app-scoped service is the
        // same production owner Tauri manages; only its config directory and event observer differ.
        "/get_settings" => run(body, |_: NoArgs| get_settings_on(settings)),
        "/patch_settings" => run(body, |a: PatchSettingsArgs| {
            patch_settings_on(settings, a.patch)
        }),
        "/get_voice_status" => run(body, |_: NoArgs| voice.status(settings)),
        "/set_voice_enabled" => run(body, |a: SetVoiceEnabledArgs| {
            voice.set_enabled(settings, a.enabled)?;
            voice.status(settings)
        }),
        "/select_voice_input_device" => run(body, |a: SelectVoiceInputDeviceArgs| {
            voice.select_input_device(settings, a.device_id.as_deref())?;
            voice.status(settings)
        }),
        "/download_voice_model" => run(body, |_: NoArgs| {
            let transport = voice_transport()?;
            voice.download_model_with_notice(VoiceTransport(transport), |notice| {
                events.append(cowrite_lib::commands::voice::VOICE_DOWNLOAD_EVENT, &notice);
            })
        }),
        "/cancel_voice_download" => run(body, |_: NoArgs| {
            voice.cancel_model_download_with_event(|notice| {
                events.append(cowrite_lib::commands::voice::VOICE_DOWNLOAD_EVENT, &notice);
            })
        }),
        "/remove_voice_model" => run(body, |_: NoArgs| {
            voice.remove_model()?;
            voice.status(settings)
        }),
        "/start_voice_dictation" => run(body, |_: NoArgs| {
            voice.start_dictation(settings, |phase| {
                events.append(cowrite_lib::commands::voice::VOICE_DICTATION_EVENT, &phase);
            })
        }),
        "/stop_voice_dictation" => run(body, |_: NoArgs| {
            voice.stop_dictation(settings, |phase| {
                events.append(cowrite_lib::commands::voice::VOICE_DICTATION_EVENT, &phase);
            })
        }),
        "/cancel_voice_dictation" => run(body, |a: CancelVoiceDictationArgs| {
            voice.cancel_dictation(settings, a.expected_generation, |phase| {
                events.append(cowrite_lib::commands::voice::VOICE_DICTATION_EVENT, &phase);
            })
        }),
        "/append_transcript_event" => run(body, |a: AppendTranscriptEventArgs| {
            transcript_store::append(
                &transcript_store::transcript_file(data_dir, Path::new(&a.root)),
                &a.event,
            )
            .map_err(TranscriptCommandError::from)
        }),
        "/load_transcript" => run(body, |a: LoadTranscriptArgs| {
            transcript_store::read_all(&transcript_store::transcript_file(
                data_dir,
                Path::new(&a.root),
            ))
            .map_err(TranscriptCommandError::from)
        }),
        "/detect_providers" => run(body, |_: NoArgs| {
            // Calls the sync helper (not the async `#[tauri::command]`) — the driver has no Tauri
            // async runtime and already runs off the main thread, so the offload isn't needed here.
            Ok::<Vec<ProviderStatusPayload>, CommandError>(detect_provider_payloads())
        }),
        // `commands::agent::start_run`/`stop_run`/`run_state` all take a Tauri `State<RunQueue>`
        // extractor this driver has no runtime to produce — `start_run_on` is the extractor-free
        // seam built for exactly this (`commands::agent`'s own docs); `stop`/`state` are plain
        // `RunQueue` methods already, no wrapper needed.
        "/start_run" => run(body, |a: StartRunArgs| {
            start_run_on(queue, a.root, a.prompt, a.operation_targets)
        }),
        "/start_address_run" => run(body, |a: StartAddressRunArgs| {
            start_address_run(queue, a, fault)
        }),
        "/stop_run" => run(body, |a: StopRunArgs| {
            Ok::<StopOutcome, AgentCommandError>(queue.stop(&a.run_id))
        }),
        "/run_state" => run(body, |_: NoArgs| {
            Ok::<RunQueueState, AgentCommandError>(queue.state())
        }),
        "/report_render_failure" => run_render_failure(body),
        "/discover_grounding" => run(body, |a: DiscoverGroundingArgs| {
            // Calls the sync helper (not the async `#[tauri::command]`), matching
            // `/detect_providers`'s own reasoning: no Tauri async runtime to offload to here, and
            // this driver already runs off the main thread.
            discover_grounding_payload(std::path::Path::new(&a.root))
        }),
        "/create_document" => run(body, |a: CreateDocumentArgs| {
            let root = std::path::PathBuf::from(a.root);
            let observer = Arc::new(DriverProjectObserver::new(Arc::clone(events), root.clone()));
            observer.activate();
            create_document_direct_observing(root, a.path, a.content, Some(observer))
        }),
        "/propose_changes" => run(body, |a: ProposeChangesArgs| {
            let root = std::path::PathBuf::from(a.root);
            let observer = Arc::new(DriverProjectObserver::new(Arc::clone(events), root.clone()));
            observer.activate();
            propose_changes_direct_observing(
                root,
                a.doc,
                a.base_content,
                a.edits,
                a.summary,
                a.change_set_meta,
                Some(observer),
            )
        }),
        // `commands::comments::load_comment_threads` takes a Tauri `State<RunQueue>` extractor this
        // driver has no runtime to produce — `load_comment_threads_on` is the extractor-free seam
        // built for exactly this (mirrors `/start_run`'s identical `start_run_on` reasoning just
        // below), fed this driver's own `queue`'s known run ids so #1381's startup reconciliation
        // still runs against a real (not empty-by-omission) picture of what's active/queued/finished.
        "/load_comment_threads" => run(body, |a: LoadCommentThreadsArgs| {
            comments::load_comment_threads_on(
                &a.root,
                &a.path,
                &queue.state().known_run_ids(),
                reconciled,
                comments::now_millis,
            )
        }),
        "/load_comment_threads_by_id" => run(body, |a: IdContentArgs| {
            comments::load_comment_threads_by_id(a.root, a.doc_id, a.content)
        }),
        "/create_comment" => run(body, |a: CreateCommentArgs| {
            comments::create_comment(a.root, a.path, a.author, a.body, a.anchor, a.timestamp)
        }),
        "/create_comment_by_id" => run(body, |a: CreateCommentByIdArgs| {
            comments::create_comment_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.author,
                a.body,
                a.anchor,
                a.timestamp,
            )
        }),
        "/reply_comment" => run(body, |a: ReplyCommentArgs| {
            comments::reply_comment(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.body,
                a.defense,
                a.published,
                a.timestamp,
            )
        }),
        "/reply_comment_for_run" => run(body, |a: ReplyCommentForRunArgs| {
            comments::reply_comment_for_run(
                a.reply.root,
                a.reply.path,
                a.reply.thread_id,
                a.reply.author,
                a.reply.body,
                a.reply.defense,
                a.reply.published,
                a.reply.timestamp,
                a.run_id,
            )
        }),
        "/reply_comment_by_id" => run(body, |a: ReplyCommentByIdArgs| {
            comments::reply_comment_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.thread_id,
                a.author,
                a.body,
                a.defense,
                a.published,
                a.timestamp,
            )
        }),
        "/revise_own_comment" => run(body, |a: ReviseOwnCommentArgs| {
            comments::revise_comment_on(
                queue,
                a.root,
                a.path,
                a.target_id,
                "you".into(),
                a.body,
                a.timestamp,
            )
        }),
        "/withdraw_own_comment" => run(body, |a: WithdrawOwnCommentArgs| {
            comments::withdraw_comment_on(
                queue,
                a.root,
                a.path,
                a.target_id,
                "you".into(),
                a.timestamp,
            )
        }),
        "/revise_own_comment_by_id" => run(body, |a: ReviseOwnCommentByIdArgs| {
            comments::revise_comment_by_id_on(
                queue,
                a.root,
                a.doc_id,
                a.content,
                a.target_id,
                "you".into(),
                a.body,
                a.timestamp,
            )
        }),
        "/withdraw_own_comment_by_id" => run(body, |a: WithdrawOwnCommentByIdArgs| {
            comments::withdraw_comment_by_id_on(
                queue,
                a.root,
                a.doc_id,
                a.content,
                a.target_id,
                "you".into(),
                a.timestamp,
            )
        }),
        "/resolve_comment" => run(body, |a: ThreadIdentityArgs| {
            comments::resolve_comment(a.root, a.path, a.thread_id, a.author, a.timestamp)
        }),
        "/resolve_comment_by_id" => run(body, |a: ThreadIdentityByIdArgs| {
            comments::resolve_comment_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.thread_id,
                a.author,
                a.timestamp,
            )
        }),
        "/reopen_comment" => run(body, |a: ThreadIdentityArgs| {
            comments::reopen_comment(a.root, a.path, a.thread_id, a.author, a.timestamp)
        }),
        "/reopen_comment_by_id" => run(body, |a: ThreadIdentityByIdArgs| {
            comments::reopen_comment_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.thread_id,
                a.author,
                a.timestamp,
            )
        }),
        "/re_anchor_comment" => run(body, |a: ReAnchorCommentArgs| {
            comments::re_anchor_comment(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.timestamp,
                a.anchor,
            )
        }),
        "/re_anchor_comment_by_id" => run(body, |a: ReAnchorCommentByIdArgs| {
            comments::re_anchor_comment_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.thread_id,
                a.author,
                a.timestamp,
                a.anchor,
            )
        }),
        "/address_with_ai" => run(body, |a: AddressWithAiArgs| {
            comments::address_with_ai(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.timestamp,
                a.run_id,
                a.guidance,
            )
        }),
        "/conclude_address_run" => run(body, |a: ConcludeAddressRunArgs| {
            comments::conclude_address_run(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.timestamp,
                a.run_id,
                a.outcome,
            )
        }),
        "/arm_batch_address_fault" => run(body, |a: ArmBatchAddressFaultArgs| {
            fault.arm(a.fail_after);
            Ok::<usize, CommandError>(a.fail_after)
        }),
        "/address_all_with_ai" => run(body, |a: AddressAllWithAiArgs| address_all(a, fault)),
        "/link_changes" => run(body, |a: LinkChangesArgs| {
            comments::link_changes(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.timestamp,
                a.change_ids,
            )
        }),
        "/link_changes_for_run" => run(body, |a: LinkChangesForRunArgs| {
            comments::link_changes_for_run(
                a.link.root,
                a.link.path,
                a.link.thread_id,
                a.link.author,
                a.link.timestamp,
                a.link.change_ids,
                a.run_id,
            )
        }),
        "/decide_linked_changes" => run(body, |a: DecideLinkedChangesArgs| {
            comments::decide_linked_changes(
                a.root,
                a.path,
                a.thread_id,
                a.author,
                a.timestamp,
                a.change_ids,
                a.decision,
            )
        }),
        "/decide_linked_changes_by_id" => run(body, |a: DecideLinkedChangesByIdArgs| {
            comments::decide_linked_changes_by_id(
                a.root,
                a.doc_id,
                a.content,
                a.thread_id,
                a.author,
                a.timestamp,
                a.change_ids,
                a.decision,
            )
        }),
        _ => (404, error_body("no such command")),
    }
}

fn run<A, T, E, F>(body: &str, f: F) -> (u16, String)
where
    A: for<'de> Deserialize<'de>,
    T: Serialize,
    E: Serialize,
    F: FnOnce(A) -> Result<T, E>,
{
    let args = match serde_json::from_str::<A>(body) {
        Ok(a) => a,
        Err(e) => return (400, error_body(&format!("bad args: {e}"))),
    };
    match f(args) {
        Ok(value) => (
            200,
            serde_json::to_string(&value).expect("serialize command result"),
        ),
        Err(err) => (
            422,
            serde_json::to_string(&err).expect("serialize command error"),
        ),
    }
}

fn run_render_failure(body: &str) -> (u16, String) {
    let args = match serde_json::from_str::<ReportRenderFailureArgs>(body) {
        Ok(args) => args,
        Err(_) => return (400, error_body("invalid render failure diagnostic")),
    };
    match report_render_failure_on(args.input) {
        Ok(value) => (
            200,
            serde_json::to_string(&value).expect("serialize command result"),
        ),
        Err(error) => (
            422,
            serde_json::to_string(&error).expect("serialize command error"),
        ),
    }
}

fn error_body(message: &str) -> String {
    serde_json::json!({ "kind": "DriverError", "message": message }).to_string()
}

/// How long an accepted connection may stay silent before the serial accept loop gives up on it and
/// moves to the next one (#1554). Connections are served one at a time, so a client that opens one
/// and sends nothing holds every later request behind it: in a traced acceptance run one such
/// connection held the loop for 37.7 seconds while the e2e fixture teardown's `close_project`
/// waited, and that test exhausted Playwright's 30-second bound. Chosen against the measured
/// population — across 9,040 traced connections in four full runs, all six silent ones aside, every
/// request-bearing connection parsed within 21ms — and against the teardown's own 8-second
/// `close_project` budget, which one silent connection can then no longer consume.
const REQUEST_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long the rest of a request may take once its first line has arrived. A client that has
/// started sending is not the pathology above, and dropping one would invent failures under load,
/// so it gets far more room — bounded only so that no wait here is unbounded.
const REQUEST_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Whether `error` is one of the read bounds above expiring. A read that times out reports
/// `WouldBlock` on some platforms and `TimedOut` on others, so both spellings mean the same here.
fn is_timeout(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// Reads a single HTTP/1.1 request line, `Content-Length` header, and body off `stream`. No
/// other headers are interpreted — the driver's callers (Playwright/Node, curl) always send one.
///
/// Borrows the stream rather than `try_clone`-ing it: on Windows the duplicated socket handle is
/// briefly inheritable, so a `CreateProcess` racing on another thread leaks the connection into
/// the child and the eventual close turns abortive (RST) instead of a clean EOF. Same reasoning as
/// `agent::mcp::read_request`, which this server's shape mirrors.
fn read_request(stream: &TcpStream) -> std::io::Result<(String, String, String)> {
    let mut reader = BufReader::new(stream);

    // Only the wait for a request to begin is held to the short bound; a connection that has said
    // nothing at all is the one that starves the accept loop (#1554).
    stream.set_read_timeout(Some(REQUEST_START_TIMEOUT))?;
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    stream.set_read_timeout(Some(REQUEST_BODY_TIMEOUT))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .map(str::trim)
        {
            content_length = value.parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    Ok((method, path, String::from_utf8_lossy(&body).into_owned()))
}

fn write_response(stream: &mut impl Write, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        422 => "Unprocessable Entity",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body.as_bytes())
}

fn write_event_response(
    stream: TcpStream,
    permit: EventWaiter,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    write_event_response_with(stream, permit, move |stream| {
        write_response(stream, status, body)
    })
}

fn write_event_response_with(
    stream: TcpStream,
    permit: EventWaiter,
    write: impl FnOnce(&mut EventResponseWriter) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let _permit = permit;
    let mut writer = EventResponseWriter::new(stream)?;
    write(&mut writer)
}

/// One deadline covers headers, body, partial writes, and readiness waits. A blocking socket's
/// per-write timeout can restart while the peer makes progress and cannot bound the response.
struct EventResponseWriter {
    stream: mio::net::TcpStream,
    poll: mio::Poll,
    events: mio::Events,
    deadline: Instant,
}

impl EventResponseWriter {
    fn new(stream: TcpStream) -> std::io::Result<Self> {
        let deadline = Instant::now() + EVENT_RESPONSE_WRITE_TIMEOUT;
        stream.set_nonblocking(true)?;
        let mut stream = mio::net::TcpStream::from_std(stream);
        let poll = mio::Poll::new()?;
        poll.registry()
            .register(&mut stream, mio::Token(0), mio::Interest::WRITABLE)?;
        Ok(Self {
            stream,
            poll,
            events: mio::Events::with_capacity(1),
            deadline,
        })
    }

    fn remaining(&self) -> std::io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "event response write deadline elapsed",
                )
            })
    }
}

impl Write for EventResponseWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        loop {
            self.remaining()?;
            match self.stream.write(bytes) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let remaining = self.remaining()?;
                    match self.poll.poll(&mut self.events, Some(remaining)) {
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        result => result?,
                    }
                }
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// The serial accept loop's head-of-line bound (#1554). A real acceptance run does produce
/// connections that are accepted and then stay silent; one held this loop for 37.7 seconds while
/// the e2e fixture teardown's `close_project` waited behind it and the test exhausted Playwright's
/// 30-second bound. These cells drive the real `serve` loop over real loopback sockets.
#[cfg(test)]
mod head_of_line_tests {
    use super::*;
    use std::time::Instant;

    fn start_driver() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let address = listener.local_addr().expect("read the bound port");
        std::thread::spawn(move || serve(listener));
        address
    }

    fn request(stream: &mut TcpStream, path: &str) -> String {
        stream
            .write_all(
                format!("POST {path} HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}")
                    .as_bytes(),
            )
            .expect("send a request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read a reply");
        response
    }

    /// A connection that sends nothing cannot hold a later request past the read bound. Without
    /// that bound the request below is never answered at all — the client's own read timeout
    /// expires first, which is exactly what the fixture teardown saw.
    #[test]
    fn a_silent_connection_cannot_hold_a_later_request_indefinitely() {
        let address = start_driver();
        let silent = TcpStream::connect(address).expect("open a silent connection");

        let started = Instant::now();
        let mut client = TcpStream::connect(address).expect("open a second connection");
        client
            .set_read_timeout(Some(REQUEST_START_TIMEOUT * 8))
            .expect("bound this client's own wait");
        let response = request(&mut client, "/close_project");

        assert!(
            response.starts_with("HTTP/1.1 200"),
            "the queued request must still be served: {response}"
        );
        assert!(
            started.elapsed() < REQUEST_START_TIMEOUT * 4,
            "the silent connection held the loop for {:?}",
            started.elapsed()
        );
        drop(silent);
    }

    /// The silent connection is answered too, and with the status that says what happened to it —
    /// a timed-out read is not a malformed request.
    #[test]
    fn a_silent_connection_is_answered_with_a_request_timeout() {
        let address = start_driver();
        let mut silent = TcpStream::connect(address).expect("open a silent connection");
        silent
            .set_read_timeout(Some(REQUEST_START_TIMEOUT * 8))
            .expect("bound this client's own wait");

        let mut response = String::new();
        silent.read_to_string(&mut response).expect("read a reply");

        assert!(
            response.starts_with("HTTP/1.1 408 Request Timeout"),
            "expected the read bound's own status: {response}"
        );
    }

    /// The discriminating negative, and the reason the short bound covers only the first line: a
    /// client that has started sending is not the pathology, so a pause *longer* than that bound
    /// between its headers and its body must still be served rather than invent a failure.
    #[test]
    fn a_request_that_pauses_after_its_headers_is_still_served() {
        let address = start_driver();
        let mut client = TcpStream::connect(address).expect("open a connection");
        client
            .set_read_timeout(Some(REQUEST_BODY_TIMEOUT))
            .expect("bound this client's own wait");

        client
            .write_all(b"POST /close_project HTTP/1.1\r\nContent-Length: 2\r\n\r\n")
            .expect("send the headers");
        std::thread::sleep(REQUEST_START_TIMEOUT + std::time::Duration::from_millis(500));
        client.write_all(b"{}").expect("send the body");

        let mut response = String::new();
        client.read_to_string(&mut response).expect("read a reply");

        assert!(
            response.starts_with("HTTP/1.1 200"),
            "a slow but live request must still be served: {response}"
        );
    }
}

#[cfg(test)]
mod guarded_spawn_tests {
    use super::*;
    use std::path::PathBuf;

    fn request() -> RunRequest {
        RunRequest {
            project_root: PathBuf::from("/tmp/some-project"),
            prompt: "revise the opening".to_string(),
            operation_targets: Vec::new(),
        }
    }

    /// The fail-closed default (#1149): with `allow_real_spawn` false, refuses before ever
    /// reaching `spawn_claude_run` — no bound MCP server is needed for this to fail, unlike a real
    /// spawn attempt, which is itself evidence that `spawn_claude_run` was never called.
    #[test]
    fn refuses_by_default_without_touching_spawn_claude_run() {
        let session = new_session();
        let err = match guarded_spawn(false, &session, &request()) {
            Err(e) => e,
            Ok(_) => panic!("must refuse by default"),
        };
        let message = err.to_string();
        assert!(
            message.contains("#1149"),
            "expected the guard's own refusal, got: {message}"
        );
        assert!(
            message.contains(ALLOW_REAL_CLAUDE_SPAWN_VAR),
            "refusal should name the escape hatch: {message}"
        );
    }

    /// `allow_real_spawn: true` delegates to the real `spawn_claude_run` — proven here by the
    /// *different* failure it produces (no project open, so no MCP server is bound), which could
    /// only happen if the guard's own early return above was skipped.
    #[test]
    fn allow_real_spawn_true_delegates_to_the_real_spawn_claude_run() {
        let session = new_session();
        let err = match guarded_spawn(true, &session, &request()) {
            Err(e) => e,
            Ok(_) => panic!("no project is open, so this must fail"),
        };
        let message = err.to_string();
        assert!(
            !message.contains("#1149"),
            "an allowed spawn must not still carry the guard's own refusal: {message}"
        );
        assert!(
            message.contains("no project is open"),
            "expected spawn_claude_run's own bound_server refusal, got: {message}"
        );
    }

    /// Only the exact value the refusal message tells the reader to set opens the hatch: a
    /// presence-based check would have let `…=0` (or an empty value) bill a real provider turn
    /// while the message still said "set `…=1`" (#1149 PR review, round 2). Pure over an
    /// `Option<OsString>`, so every value can be pinned without touching this process's env.
    #[test]
    fn the_escape_hatch_opens_only_for_the_exact_value_the_refusal_names() {
        assert!(allow_real_spawn(Some(OsString::from("1"))));

        for refused in ["0", "", "true", "yes", " 1"] {
            assert!(
                !allow_real_spawn(Some(OsString::from(refused))),
                "{ALLOW_REAL_CLAUDE_SPAWN_VAR}={refused:?} must not open the hatch"
            );
        }
        assert!(!allow_real_spawn(None), "unset must stay fail-closed");
    }

    /// [`guarded_spawn_claude_run`] reads [`ALLOW_REAL_CLAUDE_SPAWN_VAR`] itself — exercised
    /// end-to-end (not just `guarded_spawn`'s pure bool) so a rename or a dropped read regresses
    /// visibly. Scoped to this one process-env read (never a write) so it stays safe next to the
    /// `allow`-branch test above running on another thread in the same binary.
    #[test]
    fn guarded_spawn_claude_run_refuses_when_the_escape_hatch_var_is_unset_in_this_process() {
        // Never set by this test suite (or anything else in the repo) — asserting its absence is
        // itself part of what makes the default fail-closed.
        assert!(
            std::env::var_os(ALLOW_REAL_CLAUDE_SPAWN_VAR).is_none(),
            "{ALLOW_REAL_CLAUDE_SPAWN_VAR} must not be set in this test process"
        );
        let session = new_session();
        let err = match guarded_spawn_claude_run(&session, &request()) {
            Err(e) => e,
            Ok(_) => panic!("must refuse"),
        };
        assert!(err.to_string().contains("#1149"));
    }
}
