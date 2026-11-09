// ABOUTME: The TD-1 §3.2 document-state + delivery tools — `get_document_state`, `list_documents`,
// ABOUTME: `create_document`, `propose_changes`, `add_comments`, `reply_to_comment` — assembled over one project's sidecar store (D21, D17).

//! The non-transport half of the TD-1 §3.2 MCP tool surface. [`McpContext`] binds a project root,
//! its sidecar store, and the current protected set (D21 — for M2a scope, protection = the
//! open-tab set; review sets and operation targets layer in with their owning units) and answers:
//!
//! - [`McpContext::get_document_state`] — `{content, revision, pending_changes[], comments[],
//!   protection}` for one doc (the agent's read path for a protected doc).
//! - [`McpContext::list_documents`] — every known doc path + its protection state (D21 awareness).
//! - [`McpContext::create_document`] — the agent's direct-write path for a brand-new file
//!   (FR-CHAT-2, J2): refused if `path` already names a protected document (D21).
//! - [`McpContext::propose_changes`] — the tracked-change delivery path (P2a-13, TD-7/TD-11).
//! - [`McpContext::add_comments`] / [`McpContext::reply_to_comment`] — the comment-side delivery
//!   path (P2b-5a, FR-REVIEW-2/FR-CMT-4): review findings and ordinary comments land as new
//!   threads; replies (including durably-flagged defenses) attach to an existing one.
//!
//! Every `doc` path is canonicalized and confined to the project root before any read (§3.5): a
//! `..`, symlinked-escape, absolute, or null-byte path is refused, never read. There is no
//! published tool-*result* schema (the SPIKE-1 gap-#7 note in `mcp-tool-call.schema.json`), so the
//! response shapes here are the TD-1 §3.2 contract rendered compactly (AXI note: `get_document_state`
//! stays token-frugal — offsets/lengths, not full anchor context).

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use textops::deliver::{Representability, Unrepresentable};
use textops::{Anchor, Document, Edit, ReAnchor, Revision, RevisionEdit};
use uuid::Uuid;

use crate::agent::birth::{DocumentBirthNotice, DocumentBirthObserver};
use crate::agent::delivery::{
    DeliveredChange, DeliveryNotice, DeliveryObserver, DeliveryOutcomeObserver,
};
use crate::agent::watchdog::SharedProtectedSet;
use crate::commands::document::is_supported_document_path;
use crate::commands::path_confine::{canonical_relative, confine, identity_relative, ConfineError};
use crate::store::atomic;
use crate::store::changes::{self, ChangeRecord, ChangeType};
use crate::store::comments::{self, CommentEvent, EventKind};
use crate::store::service::{SidecarError, SidecarStore};

/// Why a §3.2 tool call could not be answered. Each variant maps to a JSON-RPC error class at the
/// transport boundary (`agent::mcp`); protection is *reported*, never an error (a protected doc is
/// still legitimately readable — D21 governs *writes*).
#[derive(Debug)]
pub enum ToolError {
    /// A §3.2 tool that exists in the surface but is not implemented in this unit
    /// (`propose_changes`, `add_comments`, … arrive in their own phases).
    Unsupported(String),
    /// The `doc` argument was refused by path confinement (§3.5).
    Confinement(ConfineError),
    /// The `doc` argument confined cleanly but names no readable file.
    NotFound(String),
    /// A `reply_to_comment` `comment_id` names no thread or reply in any tracked document.
    UnknownComment(String),
    /// A reply target exists but its author has withdrawn it.
    WithdrawnComment(String),
    /// A required argument was missing or the wrong type (a belt-and-braces check behind schema
    /// validation).
    InvalidArguments(String),
    /// `create_document`'s `path` confined cleanly but names a document already in the protected
    /// set (D21) — direct-write's "unopened" precondition no longer holds, so the write is
    /// refused rather than silently overwriting a protected document.
    Protected(String),
    /// Reading the file or its sidecars failed.
    Io(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::Unsupported(name) => {
                write!(f, "tool not available in this build: {name}")
            }
            ToolError::Confinement(e) => write!(f, "{e}"),
            ToolError::NotFound(doc) => write!(f, "no such document: {doc}"),
            ToolError::UnknownComment(id) => write!(f, "no such comment: {id}"),
            ToolError::WithdrawnComment(id) => write!(f, "comment was withdrawn: {id}"),
            ToolError::InvalidArguments(msg) => write!(f, "invalid arguments: {msg}"),
            ToolError::Protected(doc) => {
                write!(f, "cannot create over a protected document: {doc}")
            }
            ToolError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<ConfineError> for ToolError {
    fn from(e: ConfineError) -> ToolError {
        ToolError::Confinement(e)
    }
}

impl From<SidecarError> for ToolError {
    fn from(e: SidecarError) -> ToolError {
        ToolError::Io(e.to_string())
    }
}

/// A protection state as reported to the agent (D21). "protected" ⇒ the doc is in the current
/// protected set (open tabs, for M2a) and only ever receives agent changes as tracked changes via
/// the MCP contract; the tool boundary enforces that, this field advertises it.
fn protection_label(is_protected: bool) -> &'static str {
    if is_protected {
        "protected"
    } else {
        "unprotected"
    }
}

/// Where an [`McpContext`]'s protected set comes from (issue #414).
///
/// - `Static` — a fixed list handed in at construction. What every unit test in this module (and
///   any caller with no live tab/run feed) uses; never changes over the context's lifetime.
/// - `Live` — a [`SharedProtectedSet`](crate::agent::watchdog::SharedProtectedSet) fed by the live
///   open-tab set and the active run's operation targets (`agent::watchdog::Watchdog`'s own
///   mutators). Read fresh on every call, so a tab opened mid-run is reflected here with no
///   restart — and, because it is the *same* shared set a `Watchdog` enforces against, the tool
///   boundary's protection reporting and the watchdog's direct-write refusal can never disagree
///   about the same doc.
enum ProtectedSource {
    Static(Vec<String>),
    Live(SharedProtectedSet),
}

/// One project's view onto the §3.2 read tools: the root every path is confined to, the sidecar
/// store the pending-changes/comments state is folded from, and the set of currently protected
/// (project-relative) doc paths (D21). Cheap to construct — it holds no open handles.
pub struct McpContext {
    root: PathBuf,
    store: SidecarStore,
    protected: ProtectedSource,
    /// The document text the server has served over this session, keyed by its
    /// revision token (TD-6). `propose_changes` rebases an agent delivery against the
    /// **base** it read (TD-7: "the document as the agent read it") — recovered from
    /// here when the live document has drifted since. `get_document_state` is what
    /// records each served snapshot; a revision never served (and not the live text)
    /// has no recoverable base, so its delivery is treated as wholly stale.
    snapshots: Mutex<HashMap<String, String>>,
    /// Where a landed delivery is announced (#346), if anyone is listening. `None` — the default —
    /// leaves `propose_changes` behaving exactly as it did before the seam existed; the app supplies
    /// an observer that carries the notice to the frontend.
    observer: Option<Arc<dyn DeliveryObserver>>,
    /// The run-queue-facing persistence fact (#1420). Unlike `observer`, this has no frontend
    /// payload and covers comments as well as tracked changes; it fires only after the sidecar or
    /// document write succeeds, never merely because the provider announced a tool call.
    outcome_observer: Option<Arc<dyn DeliveryOutcomeObserver>>,
    /// Where a landed `create_document` is announced (#420, J2 Phase B) — the sibling seam to
    /// `observer` above, for the birth pipe rather than the delivery pipe. `None` — the default —
    /// leaves `create_document` behaving exactly as it did before this seam existed.
    birth_observer: Option<Arc<dyn DocumentBirthObserver>>,
    permissions: Option<Arc<super::permission::PermissionBroker>>,
}

impl McpContext {
    pub fn with_permissions(mut self, broker: Arc<super::permission::PermissionBroker>) -> Self {
        self.permissions = Some(broker);
        self
    }

    pub fn permission_request(
        &self,
        run_id: Option<&str>,
        rpc_id: Value,
        arguments: &Value,
        native: bool,
    ) -> Result<Value, ToolError> {
        match &self.permissions {
            Some(broker) => if native {
                broker.request_for_rpc(run_id, Some(rpc_id), arguments)
            } else {
                broker.request_canonical(run_id, Some(rpc_id), arguments)
            }
            .map_err(ToolError::InvalidArguments),
            None => Ok(if native {
                serde_json::json!({"behavior":"deny","message":"No agent run is available to answer this request."})
            } else {
                serde_json::json!({"deny":{"reason":"No agent run is available to answer this request."}})
            }),
        }
    }

    pub fn cancel_permission(&self, run_id: Option<&str>, rpc_id: &Value) {
        if let Some(broker) = &self.permissions {
            broker.cancel(run_id, rpc_id);
        }
    }

    pub fn close_permissions(&self) {
        if let Some(broker) = &self.permissions {
            broker.close_all();
        }
    }

    /// A context for `root` whose protected set is the fixed list `protected` (project-relative
    /// paths). Never changes after construction — see [`with_shared_protection`](Self::with_shared_protection)
    /// for a context whose protection tracks live tabs/runs. The sidecar store is opened over the
    /// same root.
    pub fn new(root: impl Into<PathBuf>, protected: Vec<String>) -> McpContext {
        McpContext::from_source(root, ProtectedSource::Static(protected))
    }

    /// A context whose protected set is `protected` — a live [`SharedProtectedSet`], typically the
    /// same one a `Watchdog` (`agent::watchdog::Watchdog::protected_set`) is mutating from tab
    /// open/close and run begin/end calls. This context's protection reporting
    /// (`get_document_state`/`list_documents`) always reflects that set's *current* membership, so
    /// a tab opened mid-run becomes "protected" at the tool boundary without rebuilding the context
    /// (issue #414 acceptance: "tracks tab open/close during a run").
    pub fn with_shared_protection(
        root: impl Into<PathBuf>,
        protected: SharedProtectedSet,
    ) -> McpContext {
        McpContext::from_source(root, ProtectedSource::Live(protected))
    }

    fn from_source(root: impl Into<PathBuf>, protected: ProtectedSource) -> McpContext {
        let root = root.into();
        let store = SidecarStore::new(root.clone());
        McpContext {
            root,
            store,
            protected,
            snapshots: Mutex::new(HashMap::new()),
            observer: None,
            outcome_observer: None,
            birth_observer: None,
            permissions: None,
        }
    }

    /// Announce every landed delivery to `observer` (#346 — the J1 Phase B pipe). Builder-style so
    /// the plain [`new`](Self::new) contract stays untouched for the callers (tests, the read-only
    /// tool paths) that have nothing to watch.
    pub fn observing(mut self, observer: Arc<dyn DeliveryObserver>) -> McpContext {
        self.observer = Some(observer);
        self
    }

    /// Report persisted tracked changes/comments to the run owner (#1420). Builder-style like the
    /// frontend-facing observer above; direct/tool tests that do not own a run remain inert.
    pub fn observing_delivery_outcomes(
        mut self,
        observer: Arc<dyn DeliveryOutcomeObserver>,
    ) -> McpContext {
        self.outcome_observer = Some(observer);
        self
    }

    /// Announce every landed `create_document` to `observer` (#420 — the J2 birth pipe). Builder-
    /// style for the same reason as [`observing`](Self::observing) — the plain [`new`](Self::new)
    /// contract stays untouched for callers with nothing to watch.
    pub fn observing_births(mut self, observer: Arc<dyn DocumentBirthObserver>) -> McpContext {
        self.birth_observer = Some(observer);
        self
    }

    /// Record the text the server served at `revision`, so a later `propose_changes`
    /// carrying that revision can recover the base it was anchored against (TD-7).
    ///
    /// `pub(crate)` (rather than private): [`get_document_state`](Self::get_document_state) is the
    /// only *production* caller, but `commands::agent::propose_changes_direct` (the D23 test-driver
    /// entry point, #365) also needs to seed this cache — its whole call is one HTTP round trip
    /// against a freshly built context, so it has no earlier `get_document_state` call on the same
    /// context to have remembered the base through. Still crate-private: no caller outside this
    /// crate has any business writing to the snapshot cache directly.
    pub(crate) fn remember_snapshot(&self, revision: &str, content: &str) {
        self.snapshots
            .lock()
            .expect("snapshot cache mutex is never poisoned")
            .insert(revision.to_string(), content.to_string());
    }

    /// Hand a landed delivery to the observer, if one is watching (#346). A context with no
    /// observer — every read-only path, and every test that isn't asserting this seam — does
    /// nothing here.
    fn notify_delivery(&self, notice: DeliveryNotice) {
        if let Some(observer) = &self.observer {
            observer.delivered(&notice);
        }
    }

    fn notify_delivery_outcome(&self) {
        if let Some(observer) = &self.outcome_observer {
            observer.landed();
        }
    }

    /// Hand a landed `create_document` to the birth observer, if one is watching (#420). A context
    /// with no birth observer — every test that isn't asserting this seam — does nothing here.
    fn notify_birth(&self, notice: DocumentBirthNotice) {
        if let Some(observer) = &self.birth_observer {
            observer.created(&notice);
        }
    }

    /// The text previously served at `revision`, if any.
    fn recall_snapshot(&self, revision: &str) -> Option<String> {
        self.snapshots
            .lock()
            .expect("snapshot cache mutex is never poisoned")
            .get(revision)
            .cloned()
    }

    /// The current protected paths, project-relative — a fresh read every call, so a `Live` source
    /// always reflects whatever its shared set holds *right now* (issue #414).
    fn protected_paths(&self) -> Vec<String> {
        match &self.protected {
            ProtectedSource::Static(list) => list.clone(),
            ProtectedSource::Live(shared) => shared
                .lock()
                .expect("protected set mutex is never poisoned")
                .members()
                .into_iter()
                .collect(),
        }
    }

    /// The protected paths resolved to confined absolute paths, so membership is decided on
    /// canonical filesystem identity rather than fragile string equality (`./a.md` vs `a.md`, and
    /// — the PR #502 review Critical — a case variant on the two shipped filesystems, NTFS and
    /// APFS, which are both case-insensitive). A protected entry that no longer confines (deleted
    /// out from under us) simply drops out.
    fn protected_abs(&self) -> BTreeSet<PathBuf> {
        self.protected_paths()
            .iter()
            .filter_map(|p| confine(&self.root, p).ok())
            .map(|abs| self.resolved_identity(&abs))
            .collect()
    }

    /// The on-disk identity a confined path resolves to: canonicalized when it names a file that
    /// already exists (so a differing-case, `./`-decorated, or otherwise merely-spelled-differently
    /// path agrees with whatever [`protected_abs`](Self::protected_abs) computed for the very same
    /// file), else the lexically confined path itself unchanged — a path with no on-disk
    /// existence yet (a fresh `create_document` target) has nothing to canonicalize against, and
    /// its lexical form is the only identity available. `confine` only canonicalizes far enough to
    /// prove the path doesn't escape the root (`commands::path_confine::confine`'s doc comment);
    /// it deliberately leaves the leaf's case as the caller spelled it, which is exactly the gap
    /// this resolves.
    fn resolved_identity(&self, confined: &Path) -> PathBuf {
        confined
            .canonicalize()
            .unwrap_or_else(|_| confined.to_path_buf())
    }

    /// An already-resolved absolute identity (see [`resolved_identity`](Self::resolved_identity)),
    /// made project-relative — the one normalized form this module uses everywhere an identity
    /// derived from an agent-supplied path is needed: the D21 protection membership check, the
    /// `docs.json` mint key, and any path echoed back to the agent (PR #502 review Important
    /// finding: a raw, unnormalized spelling must not mint a second doc id, or report a second
    /// identity, for one already-tracked file). Shared with the one other surface that keys
    /// `docs.json` — `commands::changes`'s TD-16 parse join, which *looks up* what this module
    /// mints — so the two can never drift into different spellings of one document.
    fn relative_to_root(&self, abs: &Path) -> Result<String, ToolError> {
        identity_relative(&self.root, abs).map_err(|e| ToolError::Io(e.to_string()))
    }

    /// [`resolved_identity`](Self::resolved_identity) then [`relative_to_root`](Self::relative_to_root)
    /// in one call — the composition every `docs.json` call site in this module keys its mint/lookup
    /// on (PR #502 review round-3 Important: `get_document_state`, `propose_changes`, and
    /// `add_comments` were each still keying on the agent's raw `doc`/`path` spelling after
    /// `create_document` alone was fixed to normalize, so one file could mint two doc ids depending
    /// which tool addressed it).
    fn normalized_identity(&self, confined: &Path) -> Result<String, ToolError> {
        self.relative_to_root(&self.resolved_identity(confined))
    }

    /// `get_document_state(doc)` (TD-1 §3.2): the agent's read path for a protected doc. Returns
    /// `{content, revision, pending_changes[], comments[], protection}`. The `doc` path is confined
    /// to the project root first (§3.5); a doc with no sidecar identity yet reports empty
    /// `pending_changes`/`comments` (not an error).
    pub fn get_document_state(&self, doc: &str) -> Result<Value, ToolError> {
        let confined = confine(&self.root, doc)?;
        let text = match fs::read_to_string(&confined) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(ToolError::NotFound(doc.to_string()))
            }
            Err(e) => return Err(ToolError::Io(e.to_string())),
        };
        let document = Document::new(text);
        // Remember exactly what we served so a later `propose_changes` anchored to
        // this revision can rebase against it even after the user keeps typing (TD-7).
        self.remember_snapshot(document.revision().as_str(), document.text());

        // Same normalized identity `create_document` mints against (PR #502 review round-3
        // Important): a raw, unnormalized `doc` spelling must find the same sidecar record the
        // agent's own earlier `create_document`/`propose_changes`/`add_comments` call minted for
        // this file, or a differently-spelled read reports an empty pending_changes/comments for a
        // document that genuinely has them.
        let identity = self.resolved_identity(&confined);
        let normalized = self.relative_to_root(&identity)?;
        let (pending_changes, comments) = match self.store.doc_id_for_path(&normalized)? {
            Some(id) => (
                pending_changes_view(&self.store.fold_changes(id)?),
                comments_view(&self.store.fold_comments(id)?),
            ),
            None => (Vec::new(), Vec::new()),
        };

        let protection = protection_label(self.protected_abs().contains(&identity));

        let state = DocumentState {
            content: document.text().to_string(),
            revision: document.revision().as_str().to_string(),
            pending_changes,
            comments,
            protection,
        };
        Ok(serde_json::to_value(state).expect("document state serializes"))
    }

    /// `list_documents()` (TD-1 §3.2): every known doc path + its protection state (D21 awareness).
    /// The document universe is the union of the sidecar-tracked docs (`docs.json`) and the current
    /// protected set — a freshly opened tab is protected before it has ever accumulated a sidecar,
    /// so it must still appear. Sorted for deterministic output.
    pub fn list_documents(&self) -> Result<Value, ToolError> {
        let protected_abs = self.protected_abs();

        let mut paths: BTreeSet<String> = self.store.tracked_paths()?.into_iter().collect();
        paths.extend(self.protected_paths());

        let documents: Vec<DocumentEntry> = paths
            .into_iter()
            .map(|path| {
                let is_protected = confine(&self.root, &path)
                    .map(|abs| protected_abs.contains(&self.resolved_identity(&abs)))
                    .unwrap_or(false);
                DocumentEntry {
                    protection: protection_label(is_protected),
                    path,
                }
            })
            .collect();

        Ok(serde_json::to_value(DocumentList { documents }).expect("document list serializes"))
    }

    /// `create_document(path, content)` (TD-1 §3.2): the agent writes a draft file from the
    /// conversation (FR-CHAT-2, J2). Direct write allowed — `path` names no *open* tab yet — but
    /// still through this tool rather than a raw filesystem write, so the app can open/attach it
    /// (the sibling card, out of this unit's scope: this tool returns the created path and its
    /// identity only). Overwriting an existing but *unprotected* file is intended, not an
    /// oversight: D14(1) and D21 both treat a closed file as direct-writable, and FR-AGENT-1
    /// grants the agent autonomous repo writes — `create_document` doesn't first check the file
    /// doesn't already exist.
    ///
    /// 1. **Path confinement (§3.5).** `path` is canonicalized and confined to the project root
    ///    exactly as every other tool's path argument is — `..`, symlink-escape, absolute, and
    ///    null-byte requests are all refused before anything is touched.
    /// 2. **D21 protection refusal.** `create_document`'s direct-write allowance rests on one
    ///    precondition: "the file isn't open yet." A `path` that is already in the protected set
    ///    (open tabs ∪ review sets ∪ operation targets) has that precondition violated — refuse,
    ///    never silently overwrite a document the user or an in-flight run is relying on tracked
    ///    changes to touch. The check is decided on **filesystem identity**
    ///    ([`resolved_identity`](Self::resolved_identity)), not the caller's literal spelling: NTFS
    ///    and APFS are both case-insensitive, so a protected `open.md` must also refuse a
    ///    `create_document` call spelled `Open.md` (PR #502 review Critical) — those two spellings
    ///    are one file on both shipped targets.
    /// 3. **Atomic write.** The content lands via `store::atomic::write` (write-to-temp +
    ///    rename) — a crash mid-write never leaves a partial file on disk.
    /// 4. **Identity.** The doc's sidecar identity is minted through the existing `docs.json` path
    ///    (`SidecarStore::get_or_mint_for_path`, P2a-10) — the same mechanism every other
    ///    path-addressed tool uses, not a second one — keyed on the same normalized
    ///    [`relative_to_root`](Self::relative_to_root) form used for the protection check, so
    ///    `./drafts/a.md`, `drafts/a.md`, and (on a case-insensitive target) `Drafts/A.md` all
    ///    resolve to one doc id instead of up to three (PR #502 review Important finding). The
    ///    normalized path is what's echoed back in the response, not the agent's raw spelling. The
    ///    identity is resolved *before* the write and the write itself targets that resolved path
    ///    (not the caller's literal spelling): on a case-insensitive filesystem, writing to the
    ///    caller's spelling of an *existing* file would rename-through-write-temp-and-rename its
    ///    on-disk directory entry to the caller's case, silently mutating a file's stored spelling
    ///    as a side effect of resolving its identity after the fact.
    pub fn create_document(&self, args: &Value) -> Result<Value, ToolError> {
        let path = str_arg(args, "path")?;
        let content = str_arg(args, "content")?;

        let confined = confine(&self.root, path)?;
        let identity = self.resolved_identity(&confined);
        if self.protected_abs().contains(&identity) {
            return Err(ToolError::Protected(path.to_string()));
        }

        atomic::write(&identity, content.as_bytes()).map_err(|e| ToolError::Io(e.to_string()))?;

        let normalized = self.relative_to_root(&identity)?;
        let doc_id = self.store.get_or_mint_for_path(&normalized)?;

        // #420 (J2 Phase B): announce a document birth only after the atomic write and identity
        // mint succeed. D27 still allows direct agent writes to non-documents, but a birth notice
        // sends App to open the path in the document editor, so those writes stay off this pipe.
        if is_supported_document_path(&identity) {
            self.notify_birth(DocumentBirthNotice {
                path: normalized.clone(),
                size: content.len() as u64,
            });
        }

        Ok(serde_json::json!({ "path": normalized, "doc_id": doc_id.to_string() }))
    }

    /// `propose_changes(doc, revision, edits, summary, change_set_meta)` (TD-1 §3.2):
    /// the agent's tracked-change delivery path. The applied subset lands atomically
    /// as CriticMarkup + TD-4 attribution; the rest comes back partitioned for the
    /// agent to act on. This is the whole TD-7 / TD-11 pipeline over one delivery:
    ///
    /// 1. **Rebase (TD-7).** The proposal is anchored against the `revision` the agent
    ///    read; the live document may have drifted. [`textops::rebase`] applies the
    ///    edits whose context still matches and returns the genuinely conflicted ones
    ///    as `stale` (P6). Group links (`change_set_meta.groups`) decide all-or-none
    ///    (P4b): one stale member stales its whole group. A revision with no
    ///    recoverable base (never served, and not the live text) is wholly stale.
    /// 2. **Round-trip validation (TD-11).** Each applied edit is checked to survive
    ///    its CriticMarkup round-trip. A collision is **refused, never escaped**:
    ///    payload-caused (`payload_collision`) returns for the agent to reword;
    ///    existing-text-caused (`existing_text_collision`) is an honest hard-fail. A
    ///    refusal cascades to its whole group (`group_refused`).
    /// 3. **Atomic delivery (FR-AGENT-6).** The surviving subset is rendered to
    ///    CriticMarkup and written — attribution batch first, then the document via a
    ///    single atomic rename — so no intermediate document state is observable. The
    ///    revision token advances only when something actually lands.
    pub fn propose_changes(&self, args: &Value) -> Result<Value, ToolError> {
        let doc = str_arg(args, "doc")?;
        let revision = str_arg(args, "revision")?;
        let edits = parse_edits(args)?;
        let groups = parse_groups(args, edits.len())?;
        // The agent's headline for the revision — the change-set card's summary line (#346). Read
        // leniently: a delivery that lands but omits its summary is a card with no headline, not a
        // refused delivery (the schema asks for one; nothing here should reject a valid change set
        // over its prose).
        let summary = args.get("summary").and_then(Value::as_str).unwrap_or("");

        let confined = confine(&self.root, doc)?;
        if !is_supported_document_path(&confined) {
            return Err(ToolError::InvalidArguments(format!(
                "tracked changes require a supported Markdown or plain-text document: {doc}"
            )));
        }
        let live = self.read_confined(&confined, doc)?;
        let live_rev = Revision::of(&live).as_str().to_string();

        // A fresh id names this delivery attempt (returned even when nothing lands, so
        // the response shape is stable — the agent always learns the outcome).
        let change_set_id = format!("cs-{}", Uuid::new_v4());

        // Recover the base the agent anchored against (TD-7): the live text if the
        // revision still matches, else whatever we served at that revision.
        let base = if revision == live_rev {
            Some(live.clone())
        } else {
            self.recall_snapshot(revision)
        };
        let Some(base) = base else {
            // No recoverable base and the doc has moved on: the whole delivery is
            // stale (the agent re-reads and retries). Nothing is written, revision
            // stays put.
            return Ok(delivery_response(
                &change_set_id,
                &live_rev,
                &[],
                &(0..edits.len()).collect::<Vec<_>>(),
                &[],
            ));
        };

        validate_ranges(&base, &edits)?;

        // Anchor each proposal edit against the base and rebase onto live.
        let base_doc = Document::new(base.clone());
        let proposal: Vec<RevisionEdit> = edits
            .iter()
            .map(|e| RevisionEdit {
                anchor: Anchor::new(&base_doc, e.offset, e.length),
                replacement: e.replacement.clone(),
            })
            .collect();
        let group_refs: Vec<&[usize]> = groups.iter().map(Vec::as_slice).collect();
        let rebased = textops::rebase(&base, &live, &proposal, &group_refs);

        // TD-11: validate the applied subset (in live coordinates).
        let applied_edits: Vec<Edit> = rebased.applied.iter().map(|a| a.edit.clone()).collect();
        let verdicts = textops::validate(&live, &applied_edits);

        // Attribute refusals to proposal indices, then cascade to whole groups (P4b).
        let mut refusals: HashMap<usize, &'static str> = HashMap::new();
        for (k, applied) in rebased.applied.iter().enumerate() {
            if let Representability::Refused(reason) = verdicts[k] {
                refusals.insert(applied.proposal_index, refusal_reason(reason));
            }
        }
        cascade_group_refusals(&groups, &mut refusals);

        // The surviving subset: applied edits whose proposal index was not refused.
        let keep: Vec<bool> = rebased
            .applied
            .iter()
            .map(|a| !refusals.contains_key(&a.proposal_index))
            .collect();
        let rendered = textops::render_representable(&live, &applied_edits, &keep);

        // Assemble the partitioned response bookkeeping (proposal-index space).
        let stale = rebased.rejected.clone();
        let mut unrepresentable: Vec<(usize, &'static str)> =
            refusals.iter().map(|(&i, &r)| (i, r)).collect();
        unrepresentable.sort_by_key(|(i, _)| *i);

        // Nothing survived to deliver: leave the document (and revision) untouched.
        if rendered.markers.is_empty() {
            return Ok(delivery_response(
                &change_set_id,
                &live_rev,
                &[],
                &stale,
                &unrepresentable,
            ));
        }

        // Build the delivered document + its attribution records.
        let new_text = rendered.text;
        let new_doc = Document::new(new_text.clone());
        let new_rev = new_doc.revision().as_str().to_string();
        let now = changes::now_millis();
        let group_ids = group_id_map(&groups);

        let mut records: Vec<ChangeRecord> = Vec::with_capacity(rendered.markers.len());
        // Each applied marker paired with the proposal index it came from: the response reports
        // that index, and the #346 delivery notice carries the same per-change facts (id, kind,
        // note, group) to the frontend, so both are derived from one list rather than assembled
        // twice.
        let mut applied_response: Vec<(usize, DeliveredChange)> =
            Vec::with_capacity(rendered.markers.len());
        for marker in &rendered.markers {
            let proposal_index = rebased.applied[marker.edit_index].proposal_index;
            // @anchor:change-record-id-mint
            let change_id = format!("chg-{}", Uuid::new_v4());
            let kind = ChangeType::from(marker.kind);
            let group = group_ids.get(&proposal_index).cloned();
            let note = edits[proposal_index].note.clone();
            records.push(ChangeRecord {
                schema_version: changes::SCHEMA_VERSION,
                id: change_id.clone(),
                kind,
                author: changes::AGENT_AUTHOR.to_string(),
                anchor: Anchor::new(&new_doc, marker.span.start, marker.span.len()),
                created_at: now,
                updated_at: now,
                group: group.clone(),
                change_set: Some(change_set_id.clone()),
                note: note.clone(),
            });
            applied_response.push((
                proposal_index,
                DeliveredChange {
                    change_id,
                    kind,
                    note,
                    group,
                },
            ));
        }
        applied_response.sort_by_key(|(i, _)| *i);

        // Atomic delivery: attribution batch first (one write), then the source of
        // truth via a single atomic rename — no observable intermediate doc state. Minted on the
        // normalized identity (PR #502 review round-3 Important), not `doc`'s raw spelling, so a
        // delivery survives being addressed differently than the file's `create_document` call
        // (or an earlier delivery) was. The identity is resolved once and the write targets *it*,
        // never the caller's spelling — same reasoning as `create_document` (see its doc comment):
        // `atomic::write` renames temp-onto-target, and on a case-insensitive filesystem that
        // renames the on-disk directory entry to the caller's case, which would both restamp the
        // user's filename and strand the identity resolved a line earlier (round-4 Important).
        let identity = self.resolved_identity(&confined);
        let doc_id = self
            .store
            .get_or_mint_for_path(&self.relative_to_root(&identity)?)?;
        self.store.append_change_records(doc_id, &records)?;
        atomic::write(&identity, new_text.as_bytes()).map_err(|e| ToolError::Io(e.to_string()))?;
        // A follow-up delivery may anchor against what we just produced.
        self.remember_snapshot(&new_rev, &new_text);

        // Announce the landed set to the app (#346). *After* the write, never before: FR-AGENT-6
        // makes a delivery observable only as complete, so a listener that reacts by reading the
        // document must not be able to catch the pre-delivery text. Only reached when something
        // actually landed — every "nothing applied" path returned above without notifying.
        self.notify_delivery(DeliveryNotice {
            // Canonical spelling, not the agent's: the frontend joins this against tab paths by
            // exact string equality, and `confine` accepted whatever the agent typed.
            doc: canonical_relative(doc),
            change_set_id: change_set_id.clone(),
            revision: new_rev.clone(),
            content: new_text,
            summary: summary.to_string(),
            changes: applied_response
                .iter()
                .map(|(_, change)| change.clone())
                .collect(),
            stale: stale.len(),
            unrepresentable: unrepresentable.len(),
        });
        self.notify_delivery_outcome();

        let applied_json: Vec<Value> = applied_response
            .into_iter()
            .map(|(index, change)| {
                serde_json::json!({
                    "index": index,
                    "change_id": change.change_id,
                    "kind": change.kind,
                })
            })
            .collect();
        Ok(delivery_response(
            &change_set_id,
            &new_rev,
            &applied_json,
            &stale,
            &unrepresentable,
        ))
    }

    /// `add_comments(doc, comments[{anchor?, body, severity?, skill?, workflow_run?}])` (TD-1
    /// §3.2, TD-14): J3 review findings + ordinary comments land as new threads through the same
    /// append-only event log `commands::comments::create_comment` already writes to (FR-REVIEW-2).
    ///
    /// A comment with no `anchor` is document-level. An anchored comment carries a *required*
    /// `text_snapshot` (TD-14) and is resolved against the *live* document, never landed at the
    /// agent's raw offset blindly (P2): an exact match (the common case — the agent read the
    /// current text moments ago) recaptures a fresh [`Anchor`] at the live revision; a mismatch or
    /// out-of-bounds offset is treated as drift and attempts D17 fuzzy re-anchor from the supplied
    /// snapshot/context; a drift that can't be confidently relocated keeps the agent's own quote
    /// exactly as given rather than guessing a new position or dropping the comment
    /// (`resolve_incoming_anchor`). The response carries each comment's [`Placement`] outcome
    /// alongside its id — TD-14's "no silent rebasing, moved to the response contract".
    ///
    /// Every event is authored to [`changes::AGENT_AUTHOR`] — `skill` (if given) already carries
    /// the actual finding source distinctly (FR-REVIEW-2), so `author` doesn't need to.
    pub fn add_comments(&self, args: &Value) -> Result<Value, ToolError> {
        let doc = str_arg(args, "doc")?;
        let incoming = parse_add_comments(args)?;

        let confined = confine(&self.root, doc)?;
        let text = self.read_confined(&confined, doc)?;
        let live = Document::new(text);

        // Normalized identity (PR #502 review round-3 Important), not `doc`'s raw spelling — the
        // same reasoning as `propose_changes`: a comment addressed under a different spelling than
        // the file's other sidecar activity must land on the same `docs.json` record.
        let doc_id = self
            .store
            .get_or_mint_for_path(&self.normalized_identity(&confined)?)?;
        let now = changes::now_millis();

        let mut results = Vec::with_capacity(incoming.len());
        for (index, comment) in incoming.into_iter().enumerate() {
            let (anchor, placement) = match comment.anchor {
                Some(a) => {
                    let (anchor, placement) = resolve_incoming_anchor(a, &live);
                    (Some(anchor), placement)
                }
                None => (None, Placement::Placed),
            };
            let id = format!("cmt-{}", Uuid::new_v4());
            let event = CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: id.clone(),
                parent_id: None,
                author: changes::AGENT_AUTHOR.to_string(),
                // Each comment in a batch gets its own strictly increasing timestamp rather than
                // sharing one: store::comments's (timestamp, id) causal fold (P5) would otherwise
                // fall back to a random UUID tie-break within the batch, silently discarding the
                // agent's own listed order (PR #439 review, Minor 3).
                timestamp: now + index as i64,
                kind: EventKind::Create {
                    anchor,
                    body: comment.body,
                    severity: comment.severity,
                    skill: comment.skill,
                    workflow_run: comment.workflow_run,
                },
            };
            self.store.append_comment_event(doc_id, &event)?;
            self.notify_delivery_outcome();
            results.push(serde_json::json!({ "id": id, "placement": placement }));
        }
        Ok(serde_json::json!({ "ids": results }))
    }

    /// `reply_to_comment(comment_id, body, kind: reply|defense)` (TD-1 §3.2, FR-CMT-4): appends one
    /// reply event to whichever tracked document's comment log already contains `comment_id` — a
    /// thread root or an earlier reply; `reply_to_comment` addresses either, and `store::comments`'
    /// fold resolves the target the same way regardless (P2b-5a: no `doc` argument exists on this
    /// tool, so [`SidecarStore::find_doc_id_by_comment`] locates it).
    ///
    /// `kind` durably distinguishes a defense (no edit proposed) from an ordinary reply **in the
    /// stored event itself**, not just its later rendering — FR-CMT-4's "published to external
    /// reviewers" semantics depend on that durable flag surviving sync. `published` always starts
    /// `false` here: publishing a defense to external reviewers is a human/sync-layer decision
    /// (D20), not something this MCP call controls.
    pub fn reply_to_comment(&self, args: &Value) -> Result<Value, ToolError> {
        self.reply_to_comment_with_run(args, None)
    }

    /// The MCP transport binds this call to its serving run; the agent cannot nominate a
    /// different run in tool arguments. Existing direct single-run callers still infer uniquely.
    pub fn reply_to_comment_for_run(&self, args: &Value, run_id: &str) -> Result<Value, ToolError> {
        self.reply_to_comment_with_run(args, Some(run_id))
    }

    fn reply_to_comment_with_run(
        &self,
        args: &Value,
        serving_run_id: Option<&str>,
    ) -> Result<Value, ToolError> {
        let comment_id = str_arg(args, "comment_id")?;
        let body = str_arg(args, "body")?.to_string();
        let defense = match str_arg(args, "kind")? {
            "reply" => false,
            "defense" => true,
            other => {
                return Err(ToolError::InvalidArguments(format!(
                    "unknown reply kind: {other}"
                )))
            }
        };

        let doc_id = self
            .store
            .find_doc_id_by_comment(comment_id)?
            .ok_or_else(|| ToolError::UnknownComment(comment_id.to_string()))?;

        // The lookup has no document argument and may precede another writer's correction.
        // Re-fold the located document while holding the same lane through the reply append.
        let transaction = self.store.comment_transaction();
        let fold = transaction.fold_comments(doc_id)?;
        #[cfg(test)]
        assert!(crate::store::service::comment_transaction_held());
        let target = fold.threads.values().find_map(|thread| {
            if thread.id == comment_id {
                Some((thread, thread.withdrawn_at.is_some()))
            } else {
                thread
                    .replies
                    .iter()
                    .find(|reply| reply.id == comment_id)
                    .map(|reply| (thread, reply.withdrawn_at.is_some()))
            }
        });
        let thread = match target {
            Some((_, true)) => return Err(ToolError::WithdrawnComment(comment_id.to_string())),
            None => return Err(ToolError::UnknownComment(comment_id.to_string())),
            Some((thread, false)) => thread,
        };
        let run_id = if defense {
            match serving_run_id {
                Some(id) if thread.targeting_run_ids.contains(id) => {
                    if thread
                        .address_event_runs
                        .values()
                        .filter(|run| run.as_str() == id)
                        .count()
                        != 1
                    {
                        return Err(ToolError::InvalidArguments(
                            "Serving run has more than one Address event for this comment.".into(),
                        ));
                    }
                    Some(id.to_string())
                }
                Some(_) => {
                    return Err(ToolError::InvalidArguments(
                        "Serving run did not target this comment.".into(),
                    ))
                }
                None if thread.pending_addresses.len() > 1 => {
                    return Err(ToolError::InvalidArguments(
                        "A run ID is required when this comment has more than one pending run."
                            .into(),
                    ));
                }
                None => thread
                    .pending_addresses
                    .first()
                    .map(|address| address.run_id.clone()),
            }
        } else {
            None
        };

        let id = format!("cmt-{}", Uuid::new_v4());
        let event = CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: id.clone(),
            parent_id: Some(comment_id.to_string()),
            author: changes::AGENT_AUTHOR.to_string(),
            timestamp: changes::now_millis(),
            kind: EventKind::Reply {
                body,
                defense,
                published: false,
                run_id,
            },
        };
        transaction.append_comment_event(doc_id, &event)?;
        drop(transaction);
        self.notify_delivery_outcome();
        Ok(serde_json::json!({ "reply_id": id }))
    }

    /// Read a confined document path, mapping a missing file to [`ToolError::NotFound`].
    fn read_confined(&self, confined: &std::path::Path, doc: &str) -> Result<String, ToolError> {
        match fs::read_to_string(confined) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Err(ToolError::NotFound(doc.to_string()))
            }
            Err(e) => Err(ToolError::Io(e.to_string())),
        }
    }
}

/// One parsed `propose_changes` edit: a byte range in the base document, its
/// replacement, and an optional note (§3.2 `edits[{range, replacement, note?}]`).
struct ProposalEdit {
    offset: usize,
    length: usize,
    replacement: String,
    note: Option<String>,
}

/// A required string argument, or [`ToolError::InvalidArguments`] if missing/mistyped
/// (a belt-and-braces check behind schema validation).
fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments(format!("missing `{key}`")))
}

/// Parse the `edits` array into [`ProposalEdit`]s. The published schema already
/// guarantees the array shape (non-empty, `{range:{offset,length}, replacement,
/// note?}`); this re-reads it defensively and never panics.
fn parse_edits(args: &Value) -> Result<Vec<ProposalEdit>, ToolError> {
    let items = args
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::InvalidArguments("missing `edits`".to_string()))?;
    items
        .iter()
        .map(|e| {
            let range = e
                .get("range")
                .ok_or_else(|| ToolError::InvalidArguments("edit missing `range`".to_string()))?;
            let offset = usize_field(range, "offset")?;
            let length = usize_field(range, "length")?;
            let replacement = e
                .get("replacement")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidArguments("edit missing `replacement`".to_string())
                })?
                .to_string();
            let note = e.get("note").and_then(Value::as_str).map(str::to_string);
            Ok(ProposalEdit {
                offset,
                length,
                replacement,
                note,
            })
        })
        .collect()
}

/// One `add_comments` comment argument, parsed defensively (the published schema already
/// guarantees the shape — `body` required, everything else optional; this re-reads it without
/// panicking, mirroring `parse_edits`).
struct IncomingComment {
    anchor: Option<IncomingAnchor>,
    body: String,
    severity: Option<String>,
    skill: Option<String>,
    workflow_run: Option<String>,
}

/// One `add_comments` `anchor` argument as the agent sent it: `offset`/`length`/`text_snapshot`
/// are all required (TD-14 — without a snapshot to verify against, a drifted-but-in-bounds offset
/// is indistinguishable from a verified one); `context_before`/`context_after` remain optional and
/// only sharpen [`Anchor::fuzzy_reanchor`]'s disambiguation when drift is detected (D17/P2).
struct IncomingAnchor {
    offset: usize,
    length: usize,
    text_snapshot: String,
    context_before: Option<String>,
    context_after: Option<String>,
}

fn parse_add_comments(args: &Value) -> Result<Vec<IncomingComment>, ToolError> {
    let items = args
        .get("comments")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::InvalidArguments("missing `comments`".to_string()))?;
    items.iter().map(parse_incoming_comment).collect()
}

fn parse_incoming_comment(value: &Value) -> Result<IncomingComment, ToolError> {
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments("comment missing `body`".to_string()))?
        .to_string();
    let anchor = match value.get("anchor") {
        None | Some(Value::Null) => None,
        Some(a) => Some(parse_incoming_anchor(a)?),
    };
    let string_field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Ok(IncomingComment {
        anchor,
        body,
        severity: string_field("severity"),
        skill: string_field("skill"),
        workflow_run: string_field("workflow_run"),
    })
}

fn parse_incoming_anchor(value: &Value) -> Result<IncomingAnchor, ToolError> {
    Ok(IncomingAnchor {
        offset: usize_field(value, "offset")?,
        length: usize_field(value, "length")?,
        text_snapshot: str_arg(value, "text_snapshot")?.to_string(),
        context_before: value
            .get("context_before")
            .and_then(Value::as_str)
            .map(str::to_string),
        context_after: value
            .get("context_after")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Where an anchored `add_comments` comment landed relative to what the agent asked for (TD-14).
/// Returned per comment alongside its id: the comment lane carries no request-side revision token
/// (TD-14 supersedes §3.2's old blanket rule for this lane), so "no silent rebasing" is honored in
/// the response instead — the agent is always told when its own offset was trusted as given,
/// silently corrected via D17, or given up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Placement {
    /// No anchor was given (a document-level finding, FR-REVIEW-2) or the given anchor's required
    /// `text_snapshot` verified exactly against the live document — nothing moved.
    Placed,
    /// The anchor had drifted; D17 fuzzy re-anchor confidently found the quoted text elsewhere and
    /// relocated it there.
    Relocated,
    /// The anchor had drifted and no candidate was distinguishable enough to relocate to (D17) —
    /// the original quote is preserved, but the comment has no live position.
    Orphaned,
}

/// Resolves one incoming `add_comments` anchor argument against `live`'s current text (TD-14) —
/// the honest, never-guess version of "capture an anchor at this offset":
///
/// 1. **Placed.** The offset/length is in bounds and the agent's required `text_snapshot` still
///    names exactly that live text: recapture a fresh [`Anchor::new`] at the live revision.
/// 2. **Relocated.** The live text no longer matches at that offset (or the offset is out of
///    bounds) but [`Anchor::fuzzy_reanchor`] confidently finds the quoted text elsewhere (D17):
///    use that placement.
/// 3. **Orphaned.** Neither of the above: never guess a new position and never drop the comment —
///    keep the anchor exactly as the agent gave it (offset, quote, context), which is D17's
///    "orphan, quote preserved" outcome. `base_revision` is a sentinel unequal to any real
///    document revision (never the live one) so a later orphan re-check treats it honestly as
///    unresolved, not as freshly captured.
fn resolve_incoming_anchor(incoming: IncomingAnchor, live: &Document) -> (Anchor, Placement) {
    let text = live.text();
    let in_bounds_end = incoming.offset.checked_add(incoming.length).filter(|&end| {
        end <= text.len() && text.is_char_boundary(incoming.offset) && text.is_char_boundary(end)
    });

    if let Some(end) = in_bounds_end {
        if incoming.text_snapshot == text[incoming.offset..end] {
            return (
                Anchor::new(live, incoming.offset, incoming.length),
                Placement::Placed,
            );
        }
    }

    let stale = Anchor {
        offset: incoming.offset,
        length: incoming.length,
        text_snapshot: incoming.text_snapshot,
        context_before: incoming.context_before.unwrap_or_default(),
        context_after: incoming.context_after.unwrap_or_default(),
        base_revision: Revision::from_token("mcp:add_comments:unresolved"),
    };
    match stale.fuzzy_reanchor(text, live.revision()) {
        ReAnchor::Anchored(placed) => (placed, Placement::Relocated),
        ReAnchor::Orphan(_) => (stale, Placement::Orphaned),
    }
}

fn usize_field(value: &Value, key: &str) -> Result<usize, ToolError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| ToolError::InvalidArguments(format!("range missing `{key}`")))
}

/// Parse optional group links from `change_set_meta.groups` — an array of arrays of
/// edit indices, decided all-or-none through rebase and refusal (P4b). Absent → every
/// edit is its own singleton. Validates that every index is in range and appears in at
/// most one group (the disjointness `textops::apply::Grouping` requires), refusing a
/// malformed grouping rather than letting it panic downstream.
fn parse_groups(args: &Value, edit_count: usize) -> Result<Vec<Vec<usize>>, ToolError> {
    let Some(meta) = args.get("change_set_meta") else {
        return Ok(Vec::new());
    };
    let Some(groups) = meta.get("groups") else {
        return Ok(Vec::new());
    };
    let groups = groups.as_array().ok_or_else(|| {
        ToolError::InvalidArguments("`change_set_meta.groups` must be an array".to_string())
    })?;

    let mut seen = vec![false; edit_count];
    let mut parsed = Vec::with_capacity(groups.len());
    for group in groups {
        let members = group.as_array().ok_or_else(|| {
            ToolError::InvalidArguments("each group must be an array of edit indices".to_string())
        })?;
        let mut list = Vec::with_capacity(members.len());
        for m in members {
            let idx = m
                .as_u64()
                .map(|n| n as usize)
                .filter(|&i| i < edit_count)
                .ok_or_else(|| {
                    ToolError::InvalidArguments(format!(
                        "group member out of range 0..{edit_count}"
                    ))
                })?;
            if seen[idx] {
                return Err(ToolError::InvalidArguments(format!(
                    "edit {idx} appears in more than one group"
                )));
            }
            seen[idx] = true;
            list.push(idx);
        }
        parsed.push(list);
    }
    Ok(parsed)
}

/// Validate that every edit's range is a real, char-boundary sub-range of `base` and
/// that the edits are disjoint — the contract [`textops::rebase`] / `apply_edits`
/// assume. A malformed proposal is refused, never applied.
fn validate_ranges(base: &str, edits: &[ProposalEdit]) -> Result<(), ToolError> {
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(edits.len());
    for (i, e) in edits.iter().enumerate() {
        let end = e
            .offset
            .checked_add(e.length)
            .ok_or_else(|| ToolError::InvalidArguments(format!("edit {i} range overflows")))?;
        if end > base.len() || !base.is_char_boundary(e.offset) || !base.is_char_boundary(end) {
            return Err(ToolError::InvalidArguments(format!(
                "edit {i} range {}..{end} is not a valid span of the base document",
                e.offset
            )));
        }
        ranges.push((e.offset, end));
    }
    ranges.sort_by_key(|(start, _)| *start);
    for w in ranges.windows(2) {
        if w[1].0 < w[0].1 {
            return Err(ToolError::InvalidArguments(
                "edits overlap in the base document".to_string(),
            ));
        }
    }
    Ok(())
}

/// Cascade a refusal to every co-member of its group (P4b: an unrepresentable edit
/// refuses its whole group). A member refused only because a group-mate was
/// unrepresentable is reported as `group_refused` (it was neither stale nor itself a
/// collision). Groups are disjoint, so one pass reaches a fixpoint.
fn cascade_group_refusals(groups: &[Vec<usize>], refusals: &mut HashMap<usize, &'static str>) {
    for group in groups {
        if group.iter().any(|i| refusals.contains_key(i)) {
            for &i in group {
                refusals.entry(i).or_insert("group_refused");
            }
        }
    }
}

/// Assign each grouped edit a stable group id (singletons get none), so co-members
/// share a `group` in their attribution records (mirrors `textops::apply::Grouping`).
fn group_id_map(groups: &[Vec<usize>]) -> HashMap<usize, String> {
    let mut map = HashMap::new();
    for group in groups {
        // @anchor:change-group-id-mint
        let id = format!("grp-{}", Uuid::new_v4());
        for &member in group {
            map.insert(member, id.clone());
        }
    }
    map
}

/// The response `reason` for a TD-11 refusal — the discriminated reason the agent
/// routes on (payload → reword; existing text → hard-fail), distinct from staleness.
fn refusal_reason(reason: Unrepresentable) -> &'static str {
    match reason {
        Unrepresentable::Payload => "payload_collision",
        Unrepresentable::ExistingText => "existing_text_collision",
    }
}

/// Assemble the `propose_changes` response: the change-set id, the document revision
/// after the delivery (advances only when something landed), and the three-way
/// partition of the proposal — `applied` (delivered as tracked changes), `stale`
/// (context no longer matches — re-read and retry, TD-7), and `unrepresentable`
/// (refused with a discriminated reason, TD-11).
fn delivery_response(
    change_set_id: &str,
    revision: &str,
    applied: &[Value],
    stale: &[usize],
    unrepresentable: &[(usize, &'static str)],
) -> Value {
    let unrepresentable: Vec<Value> = unrepresentable
        .iter()
        .map(|(index, reason)| serde_json::json!({ "index": index, "reason": reason }))
        .collect();
    serde_json::json!({
        "change_set_id": change_set_id,
        "revision": revision,
        "applied": applied,
        "stale": stale,
        "unrepresentable": unrepresentable,
    })
}

/// The `get_document_state` response (TD-1 §3.2 `{content, revision, pending_changes[], comments[],
/// protection}`).
#[derive(Serialize)]
struct DocumentState {
    content: String,
    revision: String,
    pending_changes: Vec<PendingChangeView>,
    comments: Vec<CommentView>,
    protection: &'static str,
}

/// The `list_documents` response (`{documents: [{path, protection}]}`).
#[derive(Serialize)]
struct DocumentList {
    documents: Vec<DocumentEntry>,
}

#[derive(Serialize)]
struct DocumentEntry {
    path: String,
    protection: &'static str,
}

/// A pending change as the agent sees it — attribution + a compact offset/length range (the range
/// it would target with `propose_changes`), not the full re-anchoring context the app keeps.
#[derive(Serialize)]
struct PendingChangeView {
    id: String,
    kind: changes::ChangeType,
    author: String,
    anchor: AnchorView,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    change_set: Option<String>,
}

/// A folded comment thread as the agent sees it (current state per test-plan P5).
#[derive(Serialize)]
struct CommentView {
    id: String,
    author: String,
    body: String,
    /// A withdrawn root is included only as a bodyless context wrapper for a late live reply.
    withdrawn: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<AnchorView>,
    resolved: bool,
    replies: Vec<ReplyView>,
}

#[derive(Serialize)]
struct ReplyView {
    id: String,
    author: String,
    body: String,
    defense: bool,
}

/// The compact anchor the read tools expose: raw-file offset + length, the coordinate space
/// `propose_changes` ranges live in (TD-6). The re-anchoring context (`text_snapshot`,
/// `context_before/after`) is the app's internal drift-recovery data, not the agent's concern.
#[derive(Serialize)]
struct AnchorView {
    offset: usize,
    length: usize,
}

impl AnchorView {
    fn of(anchor: &textops::Anchor) -> AnchorView {
        AnchorView {
            offset: anchor.offset,
            length: anchor.length,
        }
    }
}

fn pending_changes_view(fold: &changes::Fold) -> Vec<PendingChangeView> {
    fold.changes
        .values()
        .map(|c| PendingChangeView {
            id: c.id.clone(),
            kind: c.kind,
            author: c.author.clone(),
            anchor: AnchorView::of(&c.anchor),
            note: c.note.clone(),
            group: c.group.clone(),
            change_set: c.change_set.clone(),
        })
        .collect()
}

fn comments_view(fold: &comments::Fold) -> Vec<CommentView> {
    fold.threads
        .values()
        .filter(|t| t.withdrawn_at.is_none() || t.replies.iter().any(|r| r.withdrawn_at.is_none()))
        .map(|t| {
            let withdrawn = t.withdrawn_at.is_some();
            CommentView {
                id: t.id.clone(),
                author: t.author.clone(),
                body: if withdrawn {
                    String::new()
                } else {
                    t.body.clone()
                },
                withdrawn,
                severity: if withdrawn { None } else { t.severity.clone() },
                anchor: if withdrawn {
                    None
                } else {
                    t.anchor.as_ref().map(AnchorView::of)
                },
                resolved: t.resolved,
                replies: t
                    .replies
                    .iter()
                    .filter(|r| r.withdrawn_at.is_none())
                    .map(|r| ReplyView {
                        id: r.id.clone(),
                        author: r.author.clone(),
                        body: r.body.clone(),
                        defense: r.defense,
                    })
                    .collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::changes::ChangeRecord;
    use crate::store::comments::{CommentEvent, EventKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    #[test]
    fn withdrawn_comments_are_not_offered_to_the_agent() {
        fn event(
            id: &str,
            parent_id: Option<&str>,
            author: &str,
            timestamp: i64,
            kind: EventKind,
        ) -> CommentEvent {
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: id.into(),
                parent_id: parent_id.map(str::to_string),
                author: author.into(),
                timestamp,
                kind,
            }
        }
        let fold = comments::fold([
            event(
                "c1",
                None,
                "alice",
                1,
                EventKind::Create {
                    anchor: None,
                    body: "private".into(),
                    severity: None,
                    skill: None,
                    workflow_run: None,
                },
            ),
            event(
                "r1",
                Some("c1"),
                "bob",
                2,
                EventKind::Reply {
                    body: "survives".into(),
                    defense: false,
                    published: false,
                    run_id: None,
                },
            ),
            event("w1", Some("c1"), "alice", 3, EventKind::Withdraw),
            event(
                "c2",
                None,
                "alice",
                4,
                EventKind::Create {
                    anchor: None,
                    body: "live".into(),
                    severity: None,
                    skill: None,
                    workflow_run: None,
                },
            ),
            event(
                "r2",
                Some("c2"),
                "alice",
                5,
                EventKind::Reply {
                    body: "private reply".into(),
                    defense: false,
                    published: false,
                    run_id: None,
                },
            ),
            event("w2", Some("r2"), "alice", 6, EventKind::Withdraw),
        ]);
        assert_eq!(fold.threads["c1"].replies[0].body, "survives");
        let view = comments_view(&fold);
        assert_eq!(view.len(), 2);
        assert_eq!(view[0].id, "c1");
        assert!(view[0].withdrawn);
        assert!(view[0].body.is_empty());
        assert_eq!(view[0].replies[0].body, "survives");
        assert_eq!(view[1].id, "c2");
        assert!(!view[1].withdrawn);
        assert!(view[1].replies.is_empty());
    }

    #[test]
    fn late_reply_under_withdrawn_root_is_offered_with_explicit_parent_status() {
        fn event(
            id: &str,
            parent_id: Option<&str>,
            author: &str,
            timestamp: i64,
            kind: EventKind,
        ) -> CommentEvent {
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: id.into(),
                parent_id: parent_id.map(str::to_string),
                author: author.into(),
                timestamp,
                kind,
            }
        }
        let create = |body: &str| EventKind::Create {
            anchor: None,
            body: body.into(),
            severity: None,
            skill: None,
            workflow_run: None,
        };
        let reply = |body: &str| EventKind::Reply {
            body: body.into(),
            defense: false,
            published: false,
            run_id: None,
        };
        let fold = comments::fold([
            event("c1", None, "alice", 1, create("deleted words")),
            event("r1", Some("c1"), "bob", 2, reply("historical reply")),
            event("w1", Some("r1"), "bob", 3, EventKind::Withdraw),
            event("w2", Some("c1"), "alice", 4, EventKind::Withdraw),
            event("r2", Some("c1"), "alice", 5, reply("late live reply")),
            event("c2", None, "carol", 6, create("ordinary root")),
        ]);

        let view = serde_json::to_value(comments_view(&fold)).unwrap();
        assert_eq!(view.as_array().unwrap().len(), 2);
        assert_eq!(view[0]["id"], "c1");
        assert_eq!(view[0]["withdrawn"], true);
        assert_eq!(view[0]["body"], "");
        assert_eq!(view[0]["replies"].as_array().unwrap().len(), 1);
        assert_eq!(view[0]["replies"][0]["body"], "late live reply");
        assert_eq!(view[1]["id"], "c2");
        assert_eq!(view[1]["withdrawn"], false);
        assert_eq!(view[1]["body"], "ordinary root");
    }

    /// A project root with `path` written to `contents`, plus its opened sidecar store.
    fn project(path: &str, contents: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join(path);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&file, contents).unwrap();
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    fn change_record(id: &str, doc_text: &str) -> ChangeRecord {
        let doc = Document::new(doc_text);
        ChangeRecord {
            schema_version: changes::SCHEMA_VERSION,
            id: id.to_string(),
            kind: changes::ChangeType::Insertion,
            author: "claude-code".to_string(),
            anchor: textops::Anchor::new(&doc, 0, 5),
            created_at: 0,
            updated_at: 0,
            group: None,
            change_set: Some("cs-1".to_string()),
            note: Some("added intro".to_string()),
        }
    }

    fn comment_create(id: &str, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: comments::SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: None,
            author: "reviewer".to_string(),
            timestamp: 0,
            kind: EventKind::Create {
                anchor: None,
                body: body.to_string(),
                severity: Some("H".to_string()),
                skill: None,
                workflow_run: None,
            },
        }
    }

    #[test]
    fn get_document_state_returns_the_td1_shape_for_an_unprotected_doc() {
        let (_dir, root) = project("notes.md", "# Notes\n\nBody.\n");
        let ctx = McpContext::new(root, vec![]);

        let state = ctx.get_document_state("notes.md").unwrap();

        assert_eq!(state["content"], "# Notes\n\nBody.\n");
        assert_eq!(
            state["revision"],
            Document::new("# Notes\n\nBody.\n").revision().as_str()
        );
        assert!(state["pending_changes"].as_array().unwrap().is_empty());
        assert!(state["comments"].as_array().unwrap().is_empty());
        assert_eq!(state["protection"], "unprotected");
    }

    #[test]
    fn get_document_state_reports_protection_for_an_open_tab_doc() {
        let (_dir, root) = project("open.md", "hello\n");
        let ctx = McpContext::new(root, vec!["open.md".to_string()]);

        let state = ctx.get_document_state("open.md").unwrap();

        assert_eq!(state["protection"], "protected");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn get_document_state_reports_protection_for_a_case_variant_spelling_of_an_open_tab_doc() {
        // simplify pass over the create_document D21 fix (issue #419 / PR #502 review): once
        // `protected_abs()` started resolving each *protected* entry's filesystem identity, every
        // caller comparing a `doc` argument against it needed to resolve that argument's identity
        // too, or the exact same case-insensitive-filesystem gap reopens here — just as a wrong
        // "unprotected" report rather than a silent overwrite. Gated like the create_document
        // case-variant tests: NTFS/APFS only, a case-sensitive filesystem has no such gap.
        let (_dir, root) = project("open.md", "hello\n");
        let ctx = McpContext::new(root, vec!["open.md".to_string()]);

        let state = ctx.get_document_state("Open.md").unwrap();

        assert_eq!(state["protection"], "protected");
    }

    #[test]
    fn get_document_state_folds_pending_changes_recorded_under_a_dot_decorated_spelling() {
        // PR #502 review round-3 Important: `docs.json` is now keyed on one normalized identity
        // everywhere in this module, so a `get_document_state` call spelled differently than the
        // delivery that minted the record must still find it — not silently report an empty
        // pending_changes for a document that genuinely has one. `./` normalization is portable
        // (not filesystem-case-dependent), so this runs on every CI leg.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);
        let rev = rev_of(content);

        propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        let state = ctx.get_document_state("./draft.md").unwrap();
        let changes = state["pending_changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1, "state = {state:?}");
        assert_eq!(changes[0]["note"], "clarity");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn get_document_state_folds_pending_changes_recorded_under_a_case_variant_spelling() {
        // The case-insensitive-filesystem leg of the same round-3 Important — gated for the same
        // reason as the other case-variant tests: on ubuntu-latest CI's case-sensitive filesystem
        // the two spellings are genuinely different files.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);
        let rev = rev_of(content);

        propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        let state = ctx.get_document_state("Draft.md").unwrap();
        let changes = state["pending_changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1, "state = {state:?}");
    }

    #[test]
    fn get_document_state_reports_protection_live_from_a_shared_protected_set() {
        // Issue #414: a context built over a `SharedProtectedSet` (the same live union a
        // `Watchdog` feeds from tab open/close and run begin/end) reflects membership changes
        // made *after* construction, with no restart.
        let (_dir, root) = project("draft.md", "hello\n");
        let mut watchdog = crate::agent::watchdog::Watchdog::new(&root);
        let ctx = McpContext::with_shared_protection(&root, watchdog.protected_set());

        assert_eq!(
            ctx.get_document_state("draft.md").unwrap()["protection"],
            "unprotected"
        );

        // A tab opens mid-run (or at any point) on the watchdog side...
        watchdog.open_tab("draft.md");
        // ...and the tool boundary sees it protected immediately, through the same context.
        assert_eq!(
            ctx.get_document_state("draft.md").unwrap()["protection"],
            "protected"
        );

        watchdog.close_tab("draft.md");
        assert_eq!(
            ctx.get_document_state("draft.md").unwrap()["protection"],
            "unprotected"
        );
    }

    #[test]
    fn an_operation_target_that_was_never_a_tab_is_protected_via_the_shared_set() {
        // Acceptance 3 (#414): the union is genuine — a doc pinned only as a run's operation
        // target (never opened as a tab) is still reported protected at the tool boundary, while
        // an unrelated, untargeted file stays reported unprotected (the permissive half).
        let (_dir, root) = project("targeted.md", "x\n");
        fs::write(root.join("untouched.md"), "y\n").unwrap();
        let mut watchdog = crate::agent::watchdog::Watchdog::new(&root);
        let ctx = McpContext::with_shared_protection(&root, watchdog.protected_set());

        watchdog.begin_run("run-1", &["targeted.md".to_string()]);

        assert_eq!(
            ctx.get_document_state("targeted.md").unwrap()["protection"],
            "protected"
        );
        assert_eq!(
            ctx.get_document_state("untouched.md").unwrap()["protection"],
            "unprotected"
        );
    }

    #[test]
    fn get_document_state_folds_pending_changes_and_comments_from_the_sidecars() {
        let (_dir, root) = project("draft.md", "The quick fox.\n");
        let store = SidecarStore::new(&root);
        let id = store.get_or_mint_for_path("draft.md").unwrap();
        store
            .append_change_record(id, &change_record("chg-1", "The quick fox.\n"))
            .unwrap();
        store
            .append_comment_event(id, &comment_create("cmt-1", "why here?"))
            .unwrap();

        let ctx = McpContext::new(root, vec!["draft.md".to_string()]);
        let state = ctx.get_document_state("draft.md").unwrap();

        let changes = state["pending_changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["id"], "chg-1");
        assert_eq!(changes[0]["kind"], "insertion");
        assert_eq!(changes[0]["author"], "claude-code");
        assert_eq!(changes[0]["anchor"]["offset"], 0);
        assert_eq!(changes[0]["anchor"]["length"], 5);
        assert_eq!(changes[0]["note"], "added intro");
        assert_eq!(changes[0]["change_set"], "cs-1");

        let comments = state["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0]["id"], "cmt-1");
        assert_eq!(comments[0]["body"], "why here?");
        assert_eq!(comments[0]["severity"], "H");
        assert_eq!(comments[0]["resolved"], false);
    }

    #[test]
    fn get_document_state_rejects_a_path_escaping_the_root() {
        let (_dir, root) = project("notes.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        assert!(matches!(
            ctx.get_document_state("../escape.md"),
            Err(ToolError::Confinement(_))
        ));
    }

    #[test]
    fn get_document_state_rejects_a_null_byte_path() {
        let (_dir, root) = project("notes.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        assert!(matches!(
            ctx.get_document_state("a\0b.md"),
            Err(ToolError::Confinement(_))
        ));
    }

    #[test]
    fn get_document_state_on_an_absent_doc_is_not_found_not_a_panic() {
        let (_dir, root) = project("notes.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        assert!(matches!(
            ctx.get_document_state("ghost.md"),
            Err(ToolError::NotFound(_))
        ));
    }

    #[test]
    fn list_documents_reports_tracked_and_protected_paths_with_protection() {
        let (_dir, root) = project("a.md", "a\n");
        fs::write(root.join("b.md"), "b\n").unwrap();
        let store = SidecarStore::new(&root);
        store.get_or_mint_for_path("a.md").unwrap();
        store.get_or_mint_for_path("b.md").unwrap();

        // Only a.md is an open tab.
        let ctx = McpContext::new(root, vec!["a.md".to_string()]);
        let list = ctx.list_documents().unwrap();

        let docs = list["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0]["path"], "a.md");
        assert_eq!(docs[0]["protection"], "protected");
        assert_eq!(docs[1]["path"], "b.md");
        assert_eq!(docs[1]["protection"], "unprotected");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn list_documents_reports_protected_for_a_tracked_path_spelled_differently_than_the_open_tab() {
        // Same simplify-pass fix as get_document_state's case-variant test: `docs.json` and the
        // live protected set are two independent sources, so nothing stops them recording two
        // different spellings of what is, on a case-insensitive filesystem, one file. The listed
        // entry (from `docs.json`, "A.md") must still resolve to "protected" against a tab opened
        // as "a.md". Gated to the two case-insensitive shipped targets, as above.
        let (_dir, root) = project("a.md", "a\n");
        let store = SidecarStore::new(&root);
        store.get_or_mint_for_path("A.md").unwrap();

        let ctx = McpContext::new(root, vec!["a.md".to_string()]);
        let list = ctx.list_documents().unwrap();

        // "A.md" (tracked) and "a.md" (the open tab) are distinct *strings* — the document
        // universe still lists both — but both must report protected, since they name the same
        // on-disk file.
        let docs = list["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 2);
        for doc in docs {
            assert_eq!(doc["protection"], "protected", "doc = {doc:?}");
        }
    }

    #[test]
    fn list_documents_includes_an_open_tab_with_no_sidecar_yet() {
        // A freshly opened doc is protected before it has ever accumulated a sidecar identity.
        let (_dir, root) = project("fresh.md", "fresh\n");
        let ctx = McpContext::new(root, vec!["fresh.md".to_string()]);

        let list = ctx.list_documents().unwrap();
        let docs = list["documents"].as_array().unwrap();

        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["path"], "fresh.md");
        assert_eq!(docs[0]["protection"], "protected");
    }

    // --- create_document: path confinement + D21 protection refusal + atomic write (P2b-6a-i) --

    #[test]
    fn create_document_refuses_a_path_naming_an_already_protected_document() {
        // The card's one genuine trap: "unopened" is the precondition direct-write rests on
        // (D3/D21) — a path that is already protected (here, an open tab) must be refused, not
        // silently overwritten, even though create_document is otherwise a direct-write tool.
        let (_dir, root) = project("open.md", "existing content\n");
        let ctx = McpContext::new(root.clone(), vec!["open.md".to_string()]);

        let out = ctx.create_document(&serde_json::json!({
            "path": "open.md",
            "content": "an agent overwrite attempt"
        }));

        assert!(matches!(out, Err(ToolError::Protected(_))));
        assert_eq!(read(&root, "open.md"), "existing content\n");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn create_document_refuses_a_case_variant_path_naming_an_already_protected_document() {
        // CJ's fix direction (issue #419): the D21 refusal must be decided on the *file's*
        // identity, not the caller's spelling. NTFS and APFS — Emend's two shipped
        // filesystems — are both case-insensitive, so `Open.md` and an open `open.md` tab name
        // the same on-disk file; a `create_document("Open.md", ...)` call must be refused exactly
        // as `create_document("open.md", ...)` is, and must not touch the file on disk. Gated to
        // the two case-insensitive shipped targets: on a case-sensitive filesystem (the
        // ubuntu-latest CI leg, not a shipped target) "Open.md" and "open.md" are genuinely
        // different files, so there is no bypass to guard against there.
        let (_dir, root) = project("open.md", "existing content\n");
        let ctx = McpContext::new(root.clone(), vec!["open.md".to_string()]);

        let out = ctx.create_document(&serde_json::json!({
            "path": "Open.md",
            "content": "an agent overwrite attempt via a case variant"
        }));

        assert!(matches!(out, Err(ToolError::Protected(_))));
        assert_eq!(read(&root, "open.md"), "existing content\n");
    }

    #[test]
    fn create_document_mints_the_same_identity_for_a_dot_decorated_spelling_of_an_existing_doc() {
        // PR #502 review Important finding, the same root cause as the Critical above: identity
        // must come from the *normalized* path, not the agent's raw spelling, or "./drafts/a.md"
        // and "drafts/a.md" mint two doc ids for one file. `./` normalization is portable (not
        // filesystem-case-dependent), so this runs on every CI leg.
        let (_dir, root) = project("drafts/a.md", "first\n");
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("drafts/a.md").unwrap();

        let ctx = McpContext::new(root, vec![]);
        let out = ctx
            .create_document(&serde_json::json!({
                "path": "./drafts/a.md",
                "content": "overwrite via a dot-decorated spelling"
            }))
            .unwrap();

        assert_eq!(out["path"], "drafts/a.md");
        assert_eq!(out["doc_id"], existing_id.to_string());
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn create_document_mints_the_same_identity_for_a_case_variant_spelling_of_an_existing_doc() {
        // The case-insensitive-filesystem leg of the same Important finding — gated for the same
        // reason as the protection-refusal case-variant test above.
        let (_dir, root) = project("drafts/a.md", "first\n");
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("drafts/a.md").unwrap();

        let ctx = McpContext::new(root, vec![]);
        let out = ctx
            .create_document(&serde_json::json!({
                "path": "Drafts/A.md",
                "content": "overwrite via a case-variant spelling"
            }))
            .unwrap();

        assert_eq!(out["path"], "drafts/a.md");
        assert_eq!(out["doc_id"], existing_id.to_string());
    }

    #[test]
    fn create_document_writes_a_new_unprotected_file_and_mints_its_identity_via_docs_json() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let ctx = McpContext::new(root.clone(), vec![]);

        let out = ctx
            .create_document(&serde_json::json!({
                "path": "drafts/new-chapter.md",
                "content": "# New Chapter\n\nOnce upon a time.\n"
            }))
            .unwrap();

        assert_eq!(out["path"], "drafts/new-chapter.md");
        let doc_id = out["doc_id"]
            .as_str()
            .expect("doc_id is a string")
            .to_string();
        assert!(!doc_id.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("drafts/new-chapter.md")).unwrap(),
            "# New Chapter\n\nOnce upon a time.\n"
        );

        // The identity is minted through the existing docs.json path (P2a-10) — not a second
        // identity mechanism — so the same store sees exactly this id for exactly this path.
        let store = SidecarStore::new(&root);
        assert_eq!(
            store
                .doc_id_for_path("drafts/new-chapter.md")
                .unwrap()
                .unwrap()
                .to_string(),
            doc_id
        );
    }

    #[test]
    fn create_document_writes_atomically_leaving_no_stray_tmp_file_behind() {
        // Mirrors store::atomic's own "no stray .tmp on success" guarantee, exercised at this
        // tool's boundary: create_document's write-to-temp-then-rename never leaves a `.tmp`
        // sibling around once the call returns.
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let ctx = McpContext::new(root.clone(), vec![]);

        ctx.create_document(&serde_json::json!({ "path": "draft.md", "content": "hello\n" }))
            .unwrap();

        let names: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".tmp")));
        assert!(names.contains(&"draft.md".to_string()));
    }

    #[test]
    fn create_document_rejects_a_path_escaping_the_project_root() {
        let (_dir, root) = project("notes.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        let out = ctx.create_document(&serde_json::json!({
            "path": "../escape.md",
            "content": "x"
        }));
        assert!(matches!(out, Err(ToolError::Confinement(_))));
    }

    #[test]
    fn create_document_rejects_a_null_byte_path() {
        let (_dir, root) = project("notes.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        let out = ctx.create_document(&serde_json::json!({
            "path": "a\0b.md",
            "content": "x"
        }));
        assert!(matches!(out, Err(ToolError::Confinement(_))));
    }

    #[cfg(unix)]
    #[test]
    fn create_document_rejects_a_symlinked_directory_escaping_the_root() {
        let (_dir, root) = project("notes.md", "x\n");
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        let ctx = McpContext::new(root, vec![]);

        let out = ctx.create_document(&serde_json::json!({
            "path": "escape/file.md",
            "content": "x"
        }));
        assert!(matches!(out, Err(ToolError::Confinement(_))));
    }

    #[test]
    fn create_document_requires_a_path_argument() {
        let dir = TempDir::new().unwrap();
        let ctx = McpContext::new(dir.path().to_path_buf(), vec![]);
        let out = ctx.create_document(&serde_json::json!({ "content": "x" }));
        assert!(matches!(out, Err(ToolError::InvalidArguments(_))));
    }

    #[test]
    fn create_document_requires_a_content_argument() {
        let dir = TempDir::new().unwrap();
        let ctx = McpContext::new(dir.path().to_path_buf(), vec![]);
        let out = ctx.create_document(&serde_json::json!({ "path": "draft.md" }));
        assert!(matches!(out, Err(ToolError::InvalidArguments(_))));
    }

    // --- create_document: document-birth notice (#420, J2 Phase B) -----------------------

    /// Records every birth notice this observer is handed, for assertion — mirrors
    /// `RecordingObserver` below, `DeliveryObserver`'s own equivalent.
    struct RecordingBirthObserver {
        seen: Mutex<Vec<DocumentBirthNotice>>,
    }

    impl RecordingBirthObserver {
        fn new() -> Arc<RecordingBirthObserver> {
            Arc::new(RecordingBirthObserver {
                seen: Mutex::new(Vec::new()),
            })
        }

        fn seen(&self) -> Vec<DocumentBirthNotice> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl DocumentBirthObserver for RecordingBirthObserver {
        fn created(&self, notice: &DocumentBirthNotice) {
            self.seen.lock().unwrap().push(notice.clone());
        }
    }

    #[test]
    fn create_document_notifies_birth_only_for_supported_document_types() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let observer = RecordingBirthObserver::new();
        let ctx = McpContext::new(root.clone(), vec![])
            .observing_births(Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>);

        let result = ctx
            .create_document(&serde_json::json!({
                "path": "index.html", "content": "<p>repo file</p>"
            }))
            .unwrap();
        assert_eq!(result["path"], "index.html");
        assert_eq!(read(&root, "index.html"), "<p>repo file</p>");
        assert!(ctx.store.doc_id_for_path("index.html").unwrap().is_some());
        assert!(observer.seen().is_empty());

        ctx.create_document(&serde_json::json!({
            "path": "draft.MD", "content": "# Draft\n"
        }))
        .unwrap();
        assert_eq!(read(&root, "draft.MD"), "# Draft\n");
        assert_eq!(observer.seen().len(), 1);
        assert_eq!(observer.seen()[0].path, "draft.MD");
    }

    #[test]
    fn create_document_notifies_the_birth_observer_with_the_normalized_path_and_byte_size() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let observer = RecordingBirthObserver::new();
        let ctx = McpContext::new(root, vec![])
            .observing_births(Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>);

        ctx.create_document(&serde_json::json!({
            "path": "./drafts/new-chapter.md",
            "content": "# New Chapter\n\nOnce upon a time.\n"
        }))
        .unwrap();

        let seen = observer.seen();
        assert_eq!(seen.len(), 1, "one landed create_document, one notice");
        // Normalized (`./` stripped), matching the tool's own response `path` — never the agent's
        // raw spelling (mirrors create_document's own doc-id-mint normalization).
        assert_eq!(seen[0].path, "drafts/new-chapter.md");
        assert_eq!(
            seen[0].size,
            "# New Chapter\n\nOnce upon a time.\n".len() as u64
        );
    }

    #[test]
    fn create_document_refused_over_d21_protection_notifies_no_birth() {
        // FR-AGENT-6's "or nothing" reasoning, on the birth pipe: a refused write never touched
        // disk, so there is no document to open/attach — raising a notice here would send the app
        // to open a tab for a file that was never written.
        let (_dir, root) = project("open.md", "existing content\n");
        let observer = RecordingBirthObserver::new();
        let ctx = McpContext::new(root, vec!["open.md".to_string()])
            .observing_births(Arc::clone(&observer) as Arc<dyn DocumentBirthObserver>);

        let out = ctx.create_document(&serde_json::json!({
            "path": "open.md",
            "content": "an agent overwrite attempt"
        }));

        assert!(matches!(out, Err(ToolError::Protected(_))));
        assert!(observer.seen().is_empty());
    }

    #[test]
    fn a_context_with_no_birth_observer_creates_exactly_as_before() {
        // The observer is optional, exactly like `DeliveryObserver`'s own equivalent test — a
        // context built via the plain `McpContext::new` (every other test in this module) must
        // still create successfully with nothing watching.
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let ctx = McpContext::new(root.clone(), vec![]);

        let out = ctx
            .create_document(&serde_json::json!({ "path": "draft.md", "content": "hello\n" }))
            .unwrap();

        assert_eq!(out["path"], "draft.md");
        assert_eq!(
            fs::read_to_string(root.join("draft.md")).unwrap(),
            "hello\n"
        );
    }

    // --- propose_changes: TD-7 rebase + TD-11 validation + atomic delivery (P2a-13) -----

    fn rev_of(text: &str) -> String {
        Document::new(text).revision().as_str().to_string()
    }

    fn read(root: &std::path::Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap()
    }

    /// A fake-agent `propose_changes` call (test-plan §1): assemble the §3.2 args and
    /// dispatch to the tool, returning its JSON response.
    fn propose(
        ctx: &McpContext,
        doc: &str,
        revision: &str,
        edits: Value,
        meta: Option<Value>,
    ) -> Value {
        let mut args = serde_json::json!({
            "doc": doc,
            "revision": revision,
            "edits": edits,
            "summary": "s",
        });
        if let Some(m) = meta {
            args["change_set_meta"] = m;
        }
        ctx.propose_changes(&args).unwrap()
    }

    #[test]
    fn propose_changes_respects_d27_document_types() {
        let content = "hello world\n";
        for path in ["draft.html", "draft.rs"] {
            let (_dir, root) = project(path, content);
            let ctx = McpContext::new(root.clone(), vec![]);
            let result = ctx.propose_changes(&serde_json::json!({
                "doc": path,
                "revision": rev_of(content),
                "edits": [{ "range": { "offset": 6, "length": 0 }, "replacement": "brave " }],
                "summary": "clarity"
            }));
            assert!(
                matches!(result, Err(ToolError::InvalidArguments(_))),
                "{path}: {result:?}"
            );
            assert_eq!(read(&root, path), content);
            assert_eq!(ctx.store.doc_id_for_path(path).unwrap(), None);
        }

        for path in ["draft.MD", "draft.Txt"] {
            let (_dir, root) = project(path, content);
            let ctx = McpContext::new(root.clone(), vec![]);
            let result = ctx
                .propose_changes(&serde_json::json!({
                    "doc": path,
                    "revision": rev_of(content),
                    "edits": [{ "range": { "offset": 6, "length": 0 }, "replacement": "brave " }],
                    "summary": "clarity"
                }))
                .unwrap();
            assert_eq!(result["applied"].as_array().unwrap().len(), 1);
            assert_eq!(read(&root, path), "hello {++brave ++}world\n");
        }

        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let ctx = McpContext::new(root.clone(), vec![]);
        ctx.create_document(&serde_json::json!({
            "path": "unprotected.html", "content": "direct write"
        }))
        .unwrap();
        assert_eq!(read(&root, "unprotected.html"), "direct write");
    }

    #[test]
    fn propose_changes_delivers_a_clean_insertion_as_a_tracked_change() {
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec!["draft.md".to_string()]);
        let rev = rev_of(content);

        let out = propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        let applied = out["applied"].as_array().unwrap();
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0]["index"], 0);
        assert_eq!(applied[0]["kind"], "insertion");
        assert!(applied[0]["change_id"]
            .as_str()
            .unwrap()
            .starts_with("chg-"));
        assert!(out["stale"].as_array().unwrap().is_empty());
        assert!(out["unrepresentable"].as_array().unwrap().is_empty());
        assert!(out["change_set_id"].as_str().unwrap().starts_with("cs-"));

        // The source of truth now carries the tracked change, and the revision advanced.
        assert_eq!(read(&root, "draft.md"), "hello {++brave ++}world\n");
        assert_ne!(out["revision"].as_str().unwrap(), rev);
        assert_eq!(out["revision"], rev_of("hello {++brave ++}world\n"));

        // Attribution folded into the sidecar: authored to the agent, carrying the note
        // and the delivery's change_set (TD-4).
        let state = ctx.get_document_state("draft.md").unwrap();
        let changes = state["pending_changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["author"], "agent");
        assert_eq!(changes[0]["note"], "clarity");
        assert_eq!(changes[0]["change_set"], out["change_set_id"]);
    }

    #[test]
    fn propose_changes_partitions_stale_edits_and_applies_the_rest() {
        let base = "one two three four five\n";
        let (_dir, root) = project("draft.md", base);
        let ctx = McpContext::new(root.clone(), vec![]);
        let base_rev = rev_of(base);

        // The agent reads the base; the server remembers that snapshot for rebasing (TD-7).
        ctx.get_document_state("draft.md").unwrap();
        // The user keeps typing while the agent works: "five" -> "FIVE".
        let live = "one two three four FIVE\n";
        fs::write(root.join("draft.md"), live).unwrap();

        // Anchored to the base: insert at the untouched head, substitute the touched tail.
        let out = propose(
            &ctx,
            "draft.md",
            &base_rev,
            serde_json::json!([
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " },
                { "range": { "offset": 19, "length": 4 }, "replacement": "5" }
            ]),
            None,
        );

        let applied = out["applied"].as_array().unwrap();
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0]["index"], 0);
        assert_eq!(out["stale"], serde_json::json!([1]));
        assert!(out["unrepresentable"].as_array().unwrap().is_empty());

        // The applied edit landed on the *live* text; the stale one neither applied nor corrupted it.
        assert_eq!(
            read(&root, "draft.md"),
            "{++zero ++}one two three four FIVE\n"
        );
    }

    #[test]
    fn a_stale_group_member_stales_the_whole_group() {
        let base = "one two three four five\n";
        let (_dir, root) = project("draft.md", base);
        let ctx = McpContext::new(root.clone(), vec![]);
        let base_rev = rev_of(base);
        ctx.get_document_state("draft.md").unwrap();
        let live = "one two three four FIVE\n";
        fs::write(root.join("draft.md"), live).unwrap();

        let out = propose(
            &ctx,
            "draft.md",
            &base_rev,
            serde_json::json!([
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " },
                { "range": { "offset": 19, "length": 4 }, "replacement": "5" }
            ]),
            Some(serde_json::json!({ "groups": [[0, 1]] })),
        );

        // edit 1 is stale; the group cascades the whole set to stale (P4b) — nothing lands.
        assert!(out["applied"].as_array().unwrap().is_empty());
        let mut stale: Vec<u64> = out["stale"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        stale.sort_unstable();
        assert_eq!(stale, vec![0, 1]);

        // All-or-none: the live document and its revision are untouched.
        assert_eq!(read(&root, "draft.md"), live);
        assert_eq!(out["revision"], rev_of(live));
    }

    #[test]
    fn a_payload_collision_returns_a_reword_response_and_writes_nothing() {
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);
        let rev = rev_of(content);

        // The inserted payload carries its own closer: unrepresentable, agent-owned (TD-11).
        let out = propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "a++}b" }
            ]),
            None,
        );

        assert!(out["applied"].as_array().unwrap().is_empty());
        assert!(out["stale"].as_array().unwrap().is_empty());
        assert_eq!(
            out["unrepresentable"],
            serde_json::json!([{ "index": 0, "reason": "payload_collision" }])
        );
        // Never tracked, never delivered: doc + revision untouched.
        assert_eq!(read(&root, "draft.md"), content);
        assert_eq!(out["revision"], rev);
    }

    #[test]
    fn an_existing_text_collision_is_an_honest_hard_fail() {
        let content = "keep a--}b end\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);
        let rev = rev_of(content);

        // Deleting "a--}" would truncate the marker on bytes the agent cannot reword (TD-11).
        let out = propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 5, "length": 4 }, "replacement": "" }
            ]),
            None,
        );

        assert!(out["applied"].as_array().unwrap().is_empty());
        assert_eq!(
            out["unrepresentable"],
            serde_json::json!([{ "index": 0, "reason": "existing_text_collision" }])
        );
        assert_eq!(read(&root, "draft.md"), content);
    }

    #[test]
    fn an_unrepresentable_group_member_refuses_its_whole_group() {
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);
        let rev = rev_of(content);

        let out = propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave " },
                { "range": { "offset": 0, "length": 0 }, "replacement": "x++}" }
            ]),
            Some(serde_json::json!({ "groups": [[0, 1]] })),
        );

        assert!(out["applied"].as_array().unwrap().is_empty());
        // edit 1 is the collision; edit 0 is refused only because its group-mate was.
        let refused: HashMap<u64, String> = out["unrepresentable"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                (
                    v["index"].as_u64().unwrap(),
                    v["reason"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(refused[&1], "payload_collision");
        assert_eq!(refused[&0], "group_refused");
        assert_eq!(read(&root, "draft.md"), content);
    }

    #[test]
    fn a_delivery_against_an_unrecoverable_base_is_wholly_stale() {
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);

        // A revision the server never served and that is not the live text: no base to
        // rebase against, so the whole delivery is stale (re-read and retry).
        let out = propose(
            &ctx,
            "draft.md",
            "rev-never-served",
            serde_json::json!([
                { "range": { "offset": 0, "length": 0 }, "replacement": "zero " }
            ]),
            None,
        );

        assert!(out["applied"].as_array().unwrap().is_empty());
        assert_eq!(out["stale"], serde_json::json!([0]));
        assert_eq!(read(&root, "draft.md"), content);
        assert_eq!(out["revision"], rev_of(content));
    }

    #[test]
    fn propose_changes_rejects_a_range_outside_the_document() {
        let content = "short\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);
        let rev = rev_of(content);

        let args = serde_json::json!({
            "doc": "draft.md",
            "revision": rev,
            "summary": "s",
            "edits": [{ "range": { "offset": 0, "length": 9999 }, "replacement": "x" }],
        });
        assert!(matches!(
            ctx.propose_changes(&args),
            Err(ToolError::InvalidArguments(_))
        ));
        // A malformed proposal never touches the document.
        assert_eq!(read(&root, "draft.md"), content);
    }

    #[test]
    fn propose_changes_attributes_the_delivery_to_the_existing_doc_id_despite_a_dot_decorated_spelling(
    ) {
        // PR #502 review round-3 Important: `propose_changes` must mint/find `docs.json`'s id on
        // the normalized identity, or a delivery addressed differently than an earlier one splits
        // one file's change history across two doc ids. Portable leg.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("draft.md").unwrap();
        let ctx = McpContext::new(root, vec![]);
        let rev = rev_of(content);

        propose(
            &ctx,
            "./draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        assert_eq!(
            store.doc_id_for_path("draft.md").unwrap().unwrap(),
            existing_id,
            "the delivery must not have minted a second id"
        );
        assert_eq!(store.fold_changes(existing_id).unwrap().changes.len(), 1);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn propose_changes_attributes_the_delivery_to_the_existing_doc_id_despite_a_case_variant_spelling(
    ) {
        // The case-insensitive-filesystem leg of the same round-3 Important — gated as the other
        // case-variant tests are: no bypass exists on ubuntu-latest CI's case-sensitive filesystem.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("draft.md").unwrap();
        let ctx = McpContext::new(root, vec![]);
        let rev = rev_of(content);

        propose(
            &ctx,
            "Draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        assert_eq!(
            store.doc_id_for_path("draft.md").unwrap().unwrap(),
            existing_id,
            "the delivery must not have minted a second id"
        );
        assert_eq!(store.fold_changes(existing_id).unwrap().changes.len(), 1);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn propose_changes_under_a_case_variant_spelling_leaves_the_filename_and_the_delivery_reachable(
    ) {
        // PR #502 review round-4 Important. The sibling test above asserts the *mint* side with a
        // raw `docs.json` string lookup, which cannot observe what the write does afterwards.
        // `atomic::write` is write-temp-then-rename, and on NTFS/APFS a rename onto a
        // differing-case sibling renames the directory entry — so writing the caller's spelling
        // silently restamps the user's filename and strands the identity resolved just before it,
        // leaving the delivery unreachable via `get_document_state` under *any* spelling.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);
        let rev = rev_of(content);

        propose(
            &ctx,
            "Draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        let markdown_on_disk: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".md"))
            .collect();
        assert_eq!(
            markdown_on_disk,
            vec!["draft.md".to_string()],
            "the write must not restamp the user's on-disk filename to the agent's spelling"
        );

        // The delivery has to survive the write it was recorded for — read back through the
        // canonicalizing tool path, which is what an agent actually calls.
        let state = ctx.get_document_state("draft.md").unwrap();
        assert_eq!(
            state["pending_changes"].as_array().unwrap().len(),
            1,
            "the delivery must stay retrievable under the file's real spelling"
        );
    }

    // --- add_comments (P2b-5a: FR-REVIEW-2, D17/P2 anchor honesty) -------------------------

    #[test]
    fn add_comments_mints_one_id_per_comment_and_folds_into_get_document_state() {
        let content = "The quick brown fox jumps.\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);

        let out = ctx
            .add_comments(&serde_json::json!({
                "doc": "draft.md",
                "comments": [
                    {
                        "anchor": { "offset": 4, "length": 5, "text_snapshot": "quick" },
                        "body": "why quick?"
                    },
                    { "body": "overall tone is off" }
                ]
            }))
            .unwrap();

        // TD-14: each entry is {id, placement}, not a bare id string.
        let ids = out["ids"].as_array().unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids
            .iter()
            .all(|v| v["id"].as_str().unwrap().starts_with("cmt-")));
        assert!(ids.iter().all(|v| v["placement"] == "placed"));

        let state = ctx.get_document_state("draft.md").unwrap();
        let comments = state["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 2);
        let bodies: Vec<&str> = comments
            .iter()
            .map(|c| c["body"].as_str().unwrap())
            .collect();
        assert!(bodies.contains(&"why quick?"));
        assert!(bodies.contains(&"overall tone is off"));
    }

    #[test]
    fn add_comments_captures_a_fresh_anchor_at_the_given_live_offset() {
        let content = "The quick brown fox jumps.\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);

        let out = ctx
            .add_comments(&serde_json::json!({
                "doc": "draft.md",
                "comments": [
                    {
                        "anchor": { "offset": 4, "length": 5, "text_snapshot": "quick" },
                        "body": "why quick?"
                    }
                ]
            }))
            .unwrap();
        assert_eq!(out["ids"][0]["placement"], "placed");

        let state = ctx.get_document_state("draft.md").unwrap();
        let anchor = &state["comments"][0]["anchor"];
        assert_eq!(anchor["offset"], 4);
        assert_eq!(anchor["length"], 5);
    }

    #[test]
    fn add_comments_carries_severity_skill_and_workflow_run_through_the_fold() {
        // FR-REVIEW-2: review findings land with severity/source-skill/run attribution.
        let content = "Some prose.\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);

        ctx.add_comments(&serde_json::json!({
            "doc": "draft.md",
            "comments": [{
                "body": "check this citation",
                "severity": "high",
                "skill": "biblical-accuracy",
                "workflow_run": "run-42"
            }]
        }))
        .unwrap();

        let state = ctx.get_document_state("draft.md").unwrap();
        let comment = &state["comments"][0];
        assert_eq!(comment["severity"], "high");
        assert!(comment["anchor"].is_null());
    }

    #[test]
    fn add_comments_supports_a_document_level_finding_with_no_anchor() {
        // FR-REVIEW-2 names document-level findings explicitly.
        let content = "Some prose.\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);

        ctx.add_comments(&serde_json::json!({
            "doc": "draft.md",
            "comments": [{ "body": "document-level note" }]
        }))
        .unwrap();

        let state = ctx.get_document_state("draft.md").unwrap();
        assert!(state["comments"][0]["anchor"].is_null());
    }

    #[test]
    fn add_comments_relocates_a_drifted_anchor_via_fuzzy_reanchor_rather_than_the_wrong_offset() {
        // The agent read the doc, then the document moved on before add_comments landed: the
        // quoted text is still present, just at a different offset. Never trust the stale raw
        // offset (P2) — relocate to where the quote actually is.
        let live_content = "Intro. The quick brown fox jumps over the lazy dog.\n";
        let (_dir, root) = project("draft.md", live_content);
        let ctx = McpContext::new(root, vec![]);

        // The agent's stale offset (as if "quick" were still at offset 4, pre-"Intro. " insert).
        let out = ctx
            .add_comments(&serde_json::json!({
                "doc": "draft.md",
                "comments": [{
                    "anchor": {
                        "offset": 4,
                        "length": 5,
                        "text_snapshot": "quick",
                        "context_before": "The ",
                        "context_after": " brown fox jumps over the lazy dog."
                    },
                    "body": "why quick?"
                }]
            }))
            .unwrap();
        // TD-14: the response tells the agent its finding moved rather than staying silent.
        assert_eq!(out["ids"][0]["placement"], "relocated");

        let state = ctx.get_document_state("draft.md").unwrap();
        let anchor = &state["comments"][0]["anchor"];
        // "quick" actually lives at offset 11 in the live text, not the stale offset 4.
        assert_eq!(anchor["offset"], 11);
        assert_eq!(anchor["length"], 5);
    }

    #[test]
    fn add_comments_orphans_rather_than_drops_or_mislocates_when_the_quote_is_gone() {
        let live_content = "A totally different paragraph now.\n";
        let (_dir, root) = project("draft.md", live_content);
        let ctx = McpContext::new(root, vec![]);

        let out = ctx
            .add_comments(&serde_json::json!({
                "doc": "draft.md",
                "comments": [{
                    "anchor": {
                        "offset": 4,
                        "length": 5,
                        "text_snapshot": "quick",
                        "context_before": "The ",
                        "context_after": " brown fox"
                    },
                    "body": "why quick?"
                }]
            }))
            .unwrap();
        // TD-14: the response tells the agent its finding never found a live home.
        assert_eq!(out["ids"][0]["placement"], "orphaned");

        let state = ctx.get_document_state("draft.md").unwrap();
        // Never silently dropped: still one comment, and its anchor keeps the original quote —
        // never landed at some arbitrary live offset it no longer names (D17/P2).
        let comments = state["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 1);
        assert!(comments[0]["anchor"].is_object());
    }

    #[test]
    fn add_comments_gives_each_comment_in_a_batch_a_distinct_increasing_timestamp() {
        // PR #439 review, Minor 3: a single shared timestamp for the whole batch left
        // store::comments's (timestamp, id) causal fold (P5) to a random UUID tie-break within
        // the batch, silently discarding the agent's own listed order. Each comment now gets its
        // own, strictly increasing timestamp instead — read straight off the on-disk event log,
        // since the folded `comments_view` the tool response exposes carries no timestamp.
        let content = "Some prose.\n";
        let (_dir, root) = project("draft.md", content);
        let store = SidecarStore::new(&root);
        let ctx = McpContext::new(root.clone(), vec![]);

        ctx.add_comments(&serde_json::json!({
            "doc": "draft.md",
            "comments": [
                { "body": "first" },
                { "body": "second" },
                { "body": "third" }
            ]
        }))
        .unwrap();

        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        let log = root
            .join(".emend")
            .join("comments")
            .join(doc_id.to_string())
            .join(format!("{}.jsonl", changes::AGENT_AUTHOR));
        let events: Vec<Value> = fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(events.len(), 3);
        let bodies: Vec<&str> = events.iter().map(|e| e["body"].as_str().unwrap()).collect();
        // On-disk append order matches the agent's listed order.
        assert_eq!(bodies, vec!["first", "second", "third"]);
        let timestamps: Vec<i64> = events
            .iter()
            .map(|e| e["timestamp"].as_i64().unwrap())
            .collect();
        assert!(timestamps[0] < timestamps[1]);
        assert!(timestamps[1] < timestamps[2]);
    }

    #[test]
    fn add_comments_rejects_an_anchor_missing_text_snapshot() {
        // TD-14 condition 1 (PR #439 review, ratified by CJ): text_snapshot is now required on
        // every add_comments anchor. Without it, a drifted-but-in-bounds offset was previously
        // indistinguishable from a verified one — a silent wrong position (Minor 1) — and the
        // orphan path had nothing to preserve as the quote (Minor 2). Reject the whole call.
        let content = "The quick brown fox jumps.\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root, vec![]);

        let out = ctx.add_comments(&serde_json::json!({
            "doc": "draft.md",
            "comments": [
                { "anchor": { "offset": 4, "length": 5 }, "body": "why quick?" }
            ]
        }));

        assert!(matches!(out, Err(ToolError::InvalidArguments(_))));
    }

    #[test]
    fn add_comments_rejects_a_doc_path_escaping_the_project_root() {
        let (_dir, root) = project("draft.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        let out = ctx.add_comments(&serde_json::json!({
            "doc": "../escape.md",
            "comments": [{ "body": "x" }]
        }));
        assert!(matches!(out, Err(ToolError::Confinement(_))));
    }

    #[test]
    fn add_comments_on_an_absent_doc_is_not_found() {
        let (_dir, root) = project("draft.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        let out = ctx.add_comments(&serde_json::json!({
            "doc": "ghost.md",
            "comments": [{ "body": "x" }]
        }));
        assert!(matches!(out, Err(ToolError::NotFound(_))));
    }

    #[test]
    fn add_comments_attributes_the_comment_to_the_existing_doc_id_despite_a_dot_decorated_spelling()
    {
        // PR #502 review round-3 Important: `add_comments` must mint/find `docs.json`'s id on the
        // normalized identity, or a comment addressed differently than the file's other sidecar
        // activity lands under a second, disconnected doc id. Portable leg.
        let (_dir, root) = project("draft.md", "hello world\n");
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("draft.md").unwrap();
        let ctx = McpContext::new(root, vec![]);

        ctx.add_comments(&serde_json::json!({
            "doc": "./draft.md",
            "comments": [{ "body": "why here?" }]
        }))
        .unwrap();

        assert_eq!(
            store.doc_id_for_path("draft.md").unwrap().unwrap(),
            existing_id,
            "the comment must not have minted a second id"
        );
        assert_eq!(store.fold_comments(existing_id).unwrap().threads.len(), 1);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn add_comments_attributes_the_comment_to_the_existing_doc_id_despite_a_case_variant_spelling()
    {
        // The case-insensitive-filesystem leg of the same round-3 Important — gated as the other
        // case-variant tests are: no bypass exists on ubuntu-latest CI's case-sensitive filesystem.
        let (_dir, root) = project("draft.md", "hello world\n");
        let store = SidecarStore::new(&root);
        let existing_id = store.get_or_mint_for_path("draft.md").unwrap();
        let ctx = McpContext::new(root, vec![]);

        ctx.add_comments(&serde_json::json!({
            "doc": "Draft.md",
            "comments": [{ "body": "why here?" }]
        }))
        .unwrap();

        assert_eq!(
            store.doc_id_for_path("draft.md").unwrap().unwrap(),
            existing_id,
            "the comment must not have minted a second id"
        );
        assert_eq!(store.fold_comments(existing_id).unwrap().threads.len(), 1);
    }

    // --- reply_to_comment (P2b-5a: FR-CMT-4 — defense flagged distinctly) -------------------

    fn seed_thread(store: &SidecarStore, doc_id: uuid::Uuid, id: &str, body: &str) {
        store
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: id.to_string(),
                    parent_id: None,
                    author: "reviewer".to_string(),
                    timestamp: 0,
                    kind: EventKind::Create {
                        anchor: None,
                        body: body.to_string(),
                        severity: None,
                        skill: None,
                        workflow_run: None,
                    },
                },
            )
            .unwrap();
    }

    #[test]
    fn reply_to_comment_appends_an_ordinary_reply() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "cmt-1", "why here?");

        let ctx = McpContext::new(root, vec![]);
        let out = ctx
            .reply_to_comment(&serde_json::json!({
                "comment_id": "cmt-1",
                "body": "on it",
                "kind": "reply"
            }))
            .unwrap();
        assert!(out["reply_id"].as_str().unwrap().starts_with("cmt-"));

        let state = ctx.get_document_state("draft.md").unwrap();
        let replies = state["comments"][0]["replies"].as_array().unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["body"], "on it");
        assert_eq!(replies[0]["defense"], false);
    }

    #[test]
    fn reply_to_comment_refuses_withdrawn_targets() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "withdrawn-root", "old words");
        seed_thread(&store, doc_id, "live-root", "current words");
        for event in [
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: "withdrawn-reply".into(),
                parent_id: Some("live-root".into()),
                author: "reviewer".into(),
                timestamp: 1,
                kind: EventKind::Reply {
                    body: "old reply".into(),
                    defense: false,
                    published: false,
                    run_id: None,
                },
            },
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: "withdraw-root-event".into(),
                parent_id: Some("withdrawn-root".into()),
                author: "reviewer".into(),
                timestamp: 2,
                kind: EventKind::Withdraw,
            },
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: "withdraw-reply-event".into(),
                parent_id: Some("withdrawn-reply".into()),
                author: "reviewer".into(),
                timestamp: 3,
                kind: EventKind::Withdraw,
            },
            CommentEvent {
                schema_version: comments::SCHEMA_VERSION,
                id: "late-live-reply".into(),
                parent_id: Some("withdrawn-root".into()),
                author: "reviewer".into(),
                timestamp: 4,
                kind: EventKind::Reply {
                    body: "arrived after withdrawal".into(),
                    defense: false,
                    published: false,
                    run_id: None,
                },
            },
        ] {
            store.append_comment_event(doc_id, &event).unwrap();
        }
        let ctx = McpContext::new(root, vec![]);
        for target in ["withdrawn-root", "withdrawn-reply"] {
            let result = ctx.reply_to_comment(&serde_json::json!({
                "comment_id": target,
                "body": "must not land",
                "kind": "reply"
            }));
            assert!(
                matches!(result, Err(ToolError::WithdrawnComment(_))),
                "{result:?}"
            );
        }
        let fold = store.fold_comments(doc_id).unwrap();
        assert_eq!(fold.threads["withdrawn-root"].replies.len(), 1);
        assert_eq!(
            fold.threads["withdrawn-root"].replies[0].body,
            "arrived after withdrawal"
        );
        assert_eq!(fold.threads["live-root"].replies.len(), 1);
        ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "live-root", "body": "new reply", "kind": "reply"
        }))
        .unwrap();
        let fold = store.fold_comments(doc_id).unwrap();
        assert_eq!(fold.threads["live-root"].replies.len(), 2);
        assert_eq!(fold.threads["live-root"].replies[1].body, "new reply");
    }

    #[test]
    fn reply_to_comment_flags_a_defense_distinctly_in_the_stored_event() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "cmt-1", "why here?");

        let ctx = McpContext::new(root, vec![]);
        ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "cmt-1",
            "body": "the wording is already correct",
            "kind": "defense"
        }))
        .unwrap();

        // Not just "rendered differently later" — the fold's own reply carries the flag.
        let fold = store.fold_comments(doc_id).unwrap();
        let thread = &fold.threads["cmt-1"];
        assert_eq!(thread.replies.len(), 1);
        assert!(thread.replies[0].defense);
        // Publishing to external reviewers is a separate, human/sync-layer decision (D20).
        assert!(!thread.replies[0].published);
    }

    #[test]
    fn mcp_defense_uses_the_serving_run_identity() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "cmt-1", "why here?");
        for (event_id, run_id, timestamp) in [("a1", "run-1", 1), ("a2", "run-2", 2)] {
            store
                .append_comment_event(
                    doc_id,
                    &CommentEvent {
                        schema_version: comments::SCHEMA_VERSION,
                        id: event_id.into(),
                        parent_id: Some("cmt-1".into()),
                        author: "author".into(),
                        timestamp,
                        kind: EventKind::Address {
                            run_id: run_id.into(),
                            guidance: None,
                            started: false,
                        },
                    },
                )
                .unwrap();
        }
        let ctx = McpContext::new(root, vec![]);
        let args = serde_json::json!({
            "comment_id": "cmt-1", "body": "wording is correct", "kind": "defense"
        });
        assert!(matches!(
            ctx.reply_to_comment(&args),
            Err(ToolError::InvalidArguments(_))
        ));
        ctx.reply_to_comment_for_run(&args, "run-1").unwrap();
        let fold = store.fold_comments(doc_id).unwrap();
        assert_eq!(fold.threads["cmt-1"].pending_addresses.len(), 1);
        assert_eq!(fold.threads["cmt-1"].pending_addresses[0].run_id, "run-2");
        assert_eq!(fold.threads["cmt-1"].replies[0].parent_id, "cmt-1");
    }

    #[test]
    fn reply_to_comment_addresses_a_reply_id_not_just_a_thread_root() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "cmt-1", "why here?");
        store
            .append_comment_event(
                doc_id,
                &CommentEvent {
                    schema_version: comments::SCHEMA_VERSION,
                    id: "cmt-2".to_string(),
                    parent_id: Some("cmt-1".to_string()),
                    author: "bob".to_string(),
                    timestamp: 1,
                    kind: EventKind::Reply {
                        body: "good catch".to_string(),
                        defense: false,
                        published: false,
                        run_id: None,
                    },
                },
            )
            .unwrap();

        let ctx = McpContext::new(root, vec![]);
        ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "cmt-2",
            "body": "agreed, fixing",
            "kind": "reply"
        }))
        .unwrap();

        let fold = store.fold_comments(doc_id).unwrap();
        // Both replies land on the same root thread, in causal order.
        assert_eq!(fold.threads["cmt-1"].replies.len(), 2);
        assert_eq!(fold.threads["cmt-1"].replies[1].body, "agreed, fixing");
    }

    #[test]
    fn reply_to_comment_on_an_unknown_id_is_a_defined_error() {
        let (_dir, root) = project("draft.md", "x\n");
        let ctx = McpContext::new(root, vec![]);
        let out = ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "nonexistent",
            "body": "x",
            "kind": "reply"
        }));
        assert!(matches!(out, Err(ToolError::UnknownComment(_))));
    }

    #[test]
    fn reply_to_comment_rejects_an_unknown_kind() {
        let (_dir, root) = project("draft.md", "x\n");
        let store = SidecarStore::new(&root);
        let doc_id = store.get_or_mint_for_path("draft.md").unwrap();
        seed_thread(&store, doc_id, "cmt-1", "why here?");

        let ctx = McpContext::new(root, vec![]);
        let out = ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "cmt-1",
            "body": "x",
            "kind": "shout"
        }));
        assert!(matches!(out, Err(ToolError::InvalidArguments(_))));
    }

    // --- delivery notification: the frontend-facing half of a landed delivery (#346) ------

    /// Records every notice it is handed, plus what the delivered file held *at the moment*
    /// each notice arrived — the FR-AGENT-6 assertion needs the second one (a notice raised
    /// before the atomic write would let the frontend read a pre-delivery document).
    #[derive(Default)]
    struct RecordingObserver {
        notices: Mutex<Vec<(DeliveryNotice, String)>>,
        doc_path: PathBuf,
    }

    impl RecordingObserver {
        fn new(doc_path: PathBuf) -> Arc<RecordingObserver> {
            Arc::new(RecordingObserver {
                notices: Mutex::new(Vec::new()),
                doc_path,
            })
        }

        fn notices(&self) -> Vec<(DeliveryNotice, String)> {
            self.notices.lock().unwrap().clone()
        }
    }

    impl DeliveryObserver for RecordingObserver {
        fn delivered(&self, notice: &DeliveryNotice) {
            let on_disk = fs::read_to_string(&self.doc_path).unwrap_or_default();
            self.notices.lock().unwrap().push((notice.clone(), on_disk));
        }
    }

    #[derive(Default)]
    struct RecordingOutcomeObserver(AtomicUsize);

    impl DeliveryOutcomeObserver for RecordingOutcomeObserver {
        fn landed(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl RecordingOutcomeObserver {
        fn count(&self) -> usize {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn a_landed_delivery_notifies_the_observer_with_what_the_frontend_needs() {
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let observer = RecordingObserver::new(root.join("draft.md"));
        let outcome = Arc::new(RecordingOutcomeObserver::default());
        let ctx = McpContext::new(root.clone(), vec!["draft.md".to_string()])
            .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>)
            .observing_delivery_outcomes(Arc::clone(&outcome) as Arc<dyn DeliveryOutcomeObserver>);
        let rev = rev_of(content);

        let out = propose(
            &ctx,
            "draft.md",
            &rev,
            serde_json::json!([
                { "range": { "offset": 6, "length": 0 }, "replacement": "brave ", "note": "clarity" }
            ]),
            None,
        );

        let notices = observer.notices();
        assert_eq!(
            notices.len(),
            1,
            "one landed delivery raises exactly one notice"
        );
        let (notice, _) = &notices[0];

        // Everything the open editor needs to reseed itself, and the card needs to render.
        assert_eq!(notice.doc, "draft.md");
        assert_eq!(notice.change_set_id, out["change_set_id"].as_str().unwrap());
        assert_eq!(notice.revision, out["revision"].as_str().unwrap());
        assert_eq!(notice.content, "hello {++brave ++}world\n");
        assert_eq!(notice.summary, "s");
        assert_eq!(notice.stale, 0);
        assert_eq!(notice.unrepresentable, 0);
        assert_eq!(outcome.count(), 1, "the persisted delivery is the outcome");

        assert_eq!(notice.changes.len(), 1);
        assert_eq!(notice.changes[0].kind, ChangeType::Insertion);
        assert_eq!(notice.changes[0].note.as_deref(), Some("clarity"));
        assert_eq!(
            notice.changes[0].change_id,
            out["applied"][0]["change_id"].as_str().unwrap()
        );
    }

    #[test]
    fn the_notice_names_the_document_canonically_whatever_spelling_the_agent_used() {
        // The frontend joins `notice.doc` against tab paths by exact string equality, so the
        // notice must carry the one canonical spelling — not whatever the agent happened to type.
        // `confine` accepts every spelling below as the same file; only one matches a tab key, and
        // a miss is silent (the card lands, the buffer never redlines, and the FR-ED-7 poller then
        // reports Emend's own agent write as an outside change — the M11 outcome #346 prevents).
        let content = "hello world\n";
        let spellings: &[&str] = if cfg!(windows) {
            &[
                "notes/outline.md",
                "./notes/outline.md",
                r"notes\outline.md",
            ]
        } else {
            &["notes/outline.md", "./notes/outline.md"]
        };

        for spelling in spellings {
            let (_dir, root) = project("notes/outline.md", content);
            let observer = RecordingObserver::new(root.join("notes/outline.md"));
            let ctx = McpContext::new(root.clone(), vec!["notes/outline.md".to_string()])
                .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>);

            propose(
                &ctx,
                spelling,
                &rev_of(content),
                serde_json::json!([
                    { "range": { "offset": 6, "length": 0 }, "replacement": "brave " }
                ]),
                None,
            );

            let notices = observer.notices();
            assert_eq!(notices.len(), 1, "{spelling} landed a delivery");
            assert_eq!(
                notices[0].0.doc, "notes/outline.md",
                "{spelling} must be announced canonically"
            );
        }
    }

    #[test]
    fn the_notice_never_arrives_before_the_delivered_document_is_on_disk() {
        // FR-AGENT-6 at this seam: the delivery is observable only as complete. A frontend
        // that reacts to the notice by reading the document must never see the pre-delivery
        // text — so the atomic write has to precede the notification, not follow it.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let observer = RecordingObserver::new(root.join("draft.md"));
        let ctx = McpContext::new(root.clone(), vec![])
            .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>);

        propose(
            &ctx,
            "draft.md",
            &rev_of(content),
            serde_json::json!([{ "range": { "offset": 6, "length": 0 }, "replacement": "brave " }]),
            None,
        );

        let notices = observer.notices();
        let (notice, on_disk_when_notified) = &notices[0];
        assert_eq!(on_disk_when_notified, &notice.content);
        assert_ne!(on_disk_when_notified, content);
    }

    #[test]
    fn a_wholly_stale_delivery_notifies_nothing() {
        // Nothing landed, so there is no change set to redline and no card to raise —
        // a notice here would put an empty change-set card in the timeline (FR-AGENT-6:
        // "complete attributed set or nothing" — this is the "or nothing" half).
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let observer = RecordingObserver::new(root.join("draft.md"));
        let outcome = Arc::new(RecordingOutcomeObserver::default());
        let ctx = McpContext::new(root.clone(), vec![])
            .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>)
            .observing_delivery_outcomes(Arc::clone(&outcome) as Arc<dyn DeliveryOutcomeObserver>);

        let out = propose(
            &ctx,
            "draft.md",
            "rev-never-served",
            serde_json::json!([{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }]),
            None,
        );

        assert_eq!(out["applied"].as_array().unwrap().len(), 0);
        assert!(observer.notices().is_empty());
        assert_eq!(
            outcome.count(),
            0,
            "an announcement cannot manufacture an outcome"
        );
        assert_eq!(read(&root, "draft.md"), content);
    }

    #[test]
    fn persisted_comments_and_replies_are_delivery_outcomes_but_refused_calls_are_not() {
        let (_dir, root) = project("draft.md", "x\n");
        let outcome = Arc::new(RecordingOutcomeObserver::default());
        let ctx = McpContext::new(root, vec![])
            .observing_delivery_outcomes(Arc::clone(&outcome) as Arc<dyn DeliveryOutcomeObserver>);

        let added = ctx
            .add_comments(&serde_json::json!({
                "doc": "draft.md",
                "comments": [{ "body": "explain this" }]
            }))
            .unwrap();
        let comment_id = added["ids"][0]["id"].as_str().unwrap();
        assert_eq!(
            outcome.count(),
            1,
            "a persisted comment must become a delivery outcome"
        );

        ctx.reply_to_comment(&serde_json::json!({
            "comment_id": comment_id,
            "body": "clarified",
            "kind": "reply"
        }))
        .unwrap();
        assert_eq!(
            outcome.count(),
            2,
            "a persisted reply must become a delivery outcome"
        );

        let refused = ctx.reply_to_comment(&serde_json::json!({
            "comment_id": "cmt-not-present",
            "body": "nothing lands",
            "kind": "reply"
        }));
        assert!(matches!(refused, Err(ToolError::UnknownComment(_))));
        assert_eq!(outcome.count(), 2, "a refused call persisted nothing");
    }

    #[test]
    fn a_partially_stale_delivery_notifies_the_applied_subset_and_says_what_went_stale() {
        // TD-7 honesty: the applied subset is itself one complete attributed set, and the
        // notice carries the stale count the card reports rather than quietly claiming all
        // of the proposal landed.
        let base = "one two three four five\n";
        let (_dir, root) = project("draft.md", base);
        let observer = RecordingObserver::new(root.join("draft.md"));
        let ctx = McpContext::new(root.clone(), vec![])
            .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>);

        ctx.get_document_state("draft.md").unwrap();
        // The user keeps typing while the agent works: "five" -> "FIVE".
        fs::write(root.join("draft.md"), "one two three four FIVE\n").unwrap();

        let out = propose(
            &ctx,
            "draft.md",
            &rev_of(base),
            serde_json::json!([
                { "range": { "offset": 0, "length": 3 }, "replacement": "ONE" },
                { "range": { "offset": 19, "length": 4 }, "replacement": "cinq" },
            ]),
            None,
        );

        let notices = observer.notices();
        assert_eq!(notices.len(), 1);
        let (notice, on_disk) = &notices[0];

        assert_eq!(
            notice.changes.len(),
            out["applied"].as_array().unwrap().len()
        );
        assert_eq!(notice.stale, out["stale"].as_array().unwrap().len());
        assert!(notice.stale > 0, "the drifted tail edit is genuinely stale");
        // The applied subset is complete on disk at notification time — a partial outcome is
        // still delivered atomically.
        assert_eq!(on_disk, &notice.content);
    }

    #[test]
    fn the_notice_lists_only_this_deliverys_own_changes_under_their_durable_ids() {
        // The frontend parses the delivered content itself (TD-2) and needs to know which of the
        // markers it finds belong to *this* delivery — a document generally also carries markers
        // from earlier ones. Since TD-16 that join is the durable `chg-` id the parse now reports
        // for a recorded marker, so the notice must list this delivery's changes and only those,
        // each under the id its attribution record was written with.
        let content = "🎉 {++earlier++} tail\n";
        let (_dir, root) = project("draft.md", content);
        let observer = RecordingObserver::new(root.join("draft.md"));
        let ctx = McpContext::new(root.clone(), vec![])
            .observing(Arc::clone(&observer) as Arc<dyn DeliveryObserver>);

        // Append to the tail, leaving the pre-existing `{++earlier++}` marker untouched.
        let tail = content.find("tail").unwrap();
        propose(
            &ctx,
            "draft.md",
            &rev_of(content),
            serde_json::json!([{ "range": { "offset": tail, "length": 4 }, "replacement": "TAIL" }]),
            None,
        );

        let notices = observer.notices();
        let (notice, _) = &notices[0];
        assert_eq!(
            notice.changes.len(),
            1,
            "only this delivery's own marker is listed"
        );
        assert!(
            notice.content.contains("{++earlier++}"),
            "the earlier delivery's marker is still in the document — and still unlisted"
        );

        // The listed id is the one this delivery's attribution record carries, so the frontend's
        // parse of `content` (which reports a recorded marker under its record id) selects this
        // delivery's own subset by that shared identity.
        let store = SidecarStore::new(&root);
        let doc_id = store.doc_id_for_path("draft.md").unwrap().unwrap();
        let recorded: Vec<String> = store
            .fold_changes(doc_id)
            .unwrap()
            .changes
            .into_keys()
            .collect();
        assert_eq!(recorded, vec![notice.changes[0].change_id.clone()]);
    }

    #[test]
    fn a_context_with_no_observer_delivers_exactly_as_before() {
        // The observer is optional: the tool's own contract (response, document, sidecar) is
        // unchanged for a context nobody is watching.
        let content = "hello world\n";
        let (_dir, root) = project("draft.md", content);
        let ctx = McpContext::new(root.clone(), vec![]);

        let out = propose(
            &ctx,
            "draft.md",
            &rev_of(content),
            serde_json::json!([{ "range": { "offset": 6, "length": 0 }, "replacement": "brave " }]),
            None,
        );

        assert_eq!(out["applied"].as_array().unwrap().len(), 1);
        assert_eq!(read(&root, "draft.md"), "hello {++brave ++}world\n");
    }
}
