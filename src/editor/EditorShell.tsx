// ABOUTME: The CM6 editor shell (P2a-1, TD-2; P2a-6 dirty tracking + session-restore override +
// ABOUTME: imperative handle; P2a-9 autosave settings; P2a-8 source-view/display-mode toolbar;
// ABOUTME: P2a-21 integrity banners) — mounts a source-as-model EditorView over a project document,
// ABOUTME: saving through the single atomic `save_document` path for every trigger, reporting
// ABOUTME: dirty/clean + CRLF detection, and surfacing the non-modal CRLF, external-change, and
// ABOUTME: Missing-on-disk integrity surfaces (ux-design "Document integrity & lifecycle moments") —
// ABOUTME: the last of which pauses autosave and routes Recreate/Save As recovery (#933).
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { EditorView } from "@codemirror/view";
import {
  editorOffsetText,
  hasNonLfLineEndings,
  normalizeContentLineEndings,
  serializeDocumentState,
} from "./document";
import {
  createAutosaveScheduler,
  createSaveRunner,
  type AutosaveScheduler,
  type SaveRunner,
} from "./autosave";
import { dirtyTrackingExtension, recheckDirty } from "./dirtyTracking";
import {
  openDocument,
  recreateMissingDocument,
  recreateMissingDocumentCapability,
  saveDocument,
  saveDocumentAs,
  type DocumentPayload,
} from "./ipc";
import { focusAnchorInEditor, revealCommentThreadInEditor } from "./focusAnchor";
import { KEYMAP } from "./keymap";
import {
  createExternalChangePoller,
  DEFAULT_EXTERNAL_CHANGE_POLL_MS,
  isExternallyChanged,
  type ExternalChangePoller,
} from "./externalChange";
import { CrlfBanner } from "./CrlfBanner";
import { ExternalChangeBanner, type ExternalChangeBannerState } from "./ExternalChangeBanner";
import { ExternalChangeCompare } from "./ExternalChangeCompare";
import { MissingDocumentGuard } from "./MissingDocumentGuard";
import { MissingOnDiskBanner, type MissingRecoveryFailure } from "./MissingOnDiskBanner";
import { pickSaveAsPath as pickSaveAsPathDialog, relativeToProjectRoot } from "../stores/menu";
import { CommentPopover, type CommentPopoverTarget } from "./CommentPopover";
import {
  commentAnchors,
  commentThreadSeedFromDisk,
  setCommentThreads,
  setDocumentRevision,
  setSelectedCommentThread,
} from "./commentHighlights";
import type { SelectionSnapshot } from "./selectionWatcher";
import { applyAgentDelivery, isAgentDelivery } from "./delivery";
import {
  changeGeneration,
  decisionGroupClosure,
  decisionsTransaction,
  focusTrackedChange,
  type Decision,
  type DecisionSource,
  type ParsedChange,
} from "./trackedChanges";
import type { DocumentStatusBarPlatform, DocumentStatusBarTrailingItem } from "./DocumentStatusBar";
import {
  DocumentSaveStatus,
  documentSaveStatusOverflowEntry,
  type DocumentSaveState,
} from "./DocumentSaveStatus";
import { isMac } from "./keymap";
import { DocumentSurface, type DocumentSurfaceHandle } from "./DocumentSurface";
import { errorDetail } from "../backend";
import { DEFAULT_SETTINGS, getSettings, type AutosaveSettings } from "../settings";
import { loadCommentThreads } from "../comments/ipc";
import { commentCounts, type Anchor, type CommentThread } from "../comments/types";
import type { OpenDocumentsSnapshot } from "../timeline/referenceData";
import type { ProviderStatuses } from "../onboarding/types";
import { agentConnectionStatusItem } from "./DocumentStatusItems";

export interface EditorShellProps {
  /** Project root `path` is relative to (§3.5 path confinement). */
  root: string;
  /** Project-relative path of the document to open. */
  path: string;
  /** Platform chrome for UXR-Q7.2's status-bar foundation. */
  platform?: DocumentStatusBarPlatform;
  timelineReturn?: import("./ViewModeToolbar").TimelineReturnControl;
  batchAddressControl?: ReactNode;
  /** The app-owned provider probe rendered as FR-X-5's truthful connection status. */
  providerStatuses?: ProviderStatuses;
  /**
   * Session-restore override (P2a-6, FR-ED-3): if given and it differs from the text just loaded
   * from disk, the editor mounts showing *this* text instead — the tab's unsaved content from a
   * previous session (`store::tab_session`) — and immediately reports dirty. Ignored (mounts the
   * loaded text, clean) when absent or equal to the loaded text.
   */
  initialContent?: string;
  /**
   * Autosave debounce interval in ms (FR-ED-2). Injectable so the D23 e2e hook can pause autosave
   * (a large interval) and make dirty-window assertions deterministic instead of racing the live
   * interval — the "injectable clock" test-plan §7 requires. Read once when the scheduler is armed
   * (at mount / on a document change), so set it before opening the tab. When unset, the
   * Settings-store interval (`settings.autosave.interval_ms`, P2a-9) is used instead.
   */
  autosaveIntervalMs?: number;
  /** App-global reveal preference, applied without remounting the document (TD-26). */
  revealMarkupAtCursor?: boolean;
  /** Called after a save (autosave or manual) completes successfully. */
  onSaved?: () => void;
  /** Called once the initial document load has succeeded and the editor is mounted. */
  onLoaded?: () => void;
  /**
   * Called if the initial document load fails. When omitted, the failure falls back to `onError`.
   * Kept separate so the tab owner can roll back an optimistic tab open without treating later
   * save, parse, or interaction errors as evidence that the document itself never opened.
   */
  onLoadError?: (error: unknown) => void;
  /** Called if a non-load editor operation fails, or if load fails without `onLoadError`. */
  onError?: (error: unknown) => void;
  /**
   * Fired once when a document with CRLF line endings is opened (FR-ED-2). The banner chrome is
   * P2a-21's scope; this is only the trigger it hooks. `dontConvert` is the "Don't convert this
   * file" action: calling it turns off LF normalization for this open document, so subsequent saves
   * preserve its line endings verbatim. (Session-level dedup — not re-nagging on reopen — is the
   * banner owner's concern, since it owns dismissed-state; this fires once per open.)
   */
  onCrlfDetected?: (dontConvert: () => void) => void;
  /**
   * Called whenever the doc's dirty/clean status changes — never on every keystroke, only on the
   * true/false transition (`dirtyTrackingExtension`). Drives the tab strip's dirty indicator and
   * the FR-ED-3 dirty-close guard.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Reports this file-backed pane's existing save/recovery presentation state to its tab owner.
   * The owner selects only the active document for window chrome; persistence still stays in this
   * shell's single save runner and recovery-phase machine.
   */
  onSaveStateChange?: (state: DocumentSaveState | null) => void;
  /**
   * External-change poll interval in ms (P2a-21, FR-ED-7). Injectable so a test can drive a poll
   * tick deterministically instead of racing the live default (test-plan §7 "injectable clock"),
   * mirroring `autosaveIntervalMs`. Read once when the poller is armed (at mount).
   */
  externalChangePollMs?: number;
  /**
   * Whether a completed project-files generation has proved this document's path absent without a
   * correlated rename/move (J2 **Missing on disk**, #933). Owned by the tab layer, which is where
   * the generation lands, and never inferred here: a failed read is not a deletion, so only the
   * backend's own completed enumeration may put a document into this state.
   *
   * While set, this shell keeps the whole buffer and pauses autosave, manual save writes nothing,
   * and the recovery banner (Keep editing / Save As… / Close…, plus Recreate where TD-18
   * confinement permits) is the only route out. Clearing it — the path reappeared, or a recovery
   * succeeded — resumes autosave with nothing else to undo.
   */
  missing?: boolean;
  /**
   * The native save panel behind `[Save As…]`, injectable for tests exactly as `ProjectRail`'s
   * `refresh`/`subscribe` are (`stores/menu.ts`'s `pickSaveAsPath` in production). Resolves the
   * chosen absolute path, or `null` for a cancellation — which must change nothing at all.
   */
  pickSaveAsPath?: (root: string, suggestedPath: string) => Promise<string | null>;
  /**
   * Fired with the project-relative path a `[Save As…]` actually landed on, once the write and the
   * document's history rekey have both succeeded. The tab layer follows it the same way it follows
   * a proven external move, so the tab, its buffer, and the active marker arrive at the new path.
   */
  onSavedAs?: (path: string) => void;
  /**
   * Fired when a recovery has proved this document is no longer missing — a successful `Recreate`,
   * or a `Recreate` that found the path occupied again (`Reappeared`, which hands the disk side to
   * FR-ED-7). The tab layer clears its own Missing state on it rather than waiting for the next
   * generation to say the same thing.
   */
  onMissingResolved?: () => void;
  /** The banner's `[Close…]`: routed to the tab layer, which owns closing and the destructive
   * confirmation that guards it (the buffer is what is at stake, and the tab layer holds it). */
  onRequestClose?: () => void;
  /** Fired when the dirty-close/quit guard's imperative Save is refused because the ordinary
   * FR-ED-7 banner is unresolved. The tab layer dismisses that guard without closing the tab so
   * this shell can return keyboard attention to the existing Keep mine choice. */
  onExternalChangeSaveBlocked?: () => void;
  /**
   * Fired with every id `dropTrackedChanges` from ANY decision entry point — the imperative
   * `decideChanges` below, the in-editor toolbar/keyboard/popover triage (`RedlineReview`,
   * P2a-5) — reports as decided, so a caller outside `editor/` (the timeline's change-set card,
   * #410) can keep its own bookkeeping honest against a decision it never itself triggered.
   * `source` distinguishes this shell's imperative card seam, direct editor triage, and CM6 redo
   * so reversal followed by a fresh editor decision cannot inherit the card's old attribution.
   */
  onChangesDecided?: (ids: string[], source: DecisionSource) => void;
  /**
   * Undo-side counterpart to `onChangesDecided`: fired with every id a
   * `restoreTrackedChanges` effect re-adds to the live field, so outside consumers can return
   * those changes to Pending (UXR-Q5 Reversed / TD-16 symptom 2b).
   */
  onChangesReversed?: (ids: string[]) => void;
  /**
   * Fired with the live tracked-change field's parse generation (UXR-Q4) whenever it is (re)seeded —
   * at mount (the opened document's revision), on an agent delivery (that delivery's revision), and
   * on a manual reload (`null`, a parse with no stable revision). The mounted-app wiring
   * (`TabbedEditor`→`App`) turns this into the active tab's triage target, which a change-set card
   * checks its own `generation` against before letting the user triage it (#410/UXR-Q4). Not fired
   * for a decision (which drops/maps ids but never re-parses, so the generation is unchanged).
   */
  onChangeGenerationChange?: (generation: string | null) => void;
  /**
   * Called when the user takes the quote affordance on a non-empty selection (P2b-7, UX
   * Principle 6: "quote-selection→anchored-message = selection watcher → timeline quote-bar") —
   * the caller (once a live timeline exists to receive it) attaches `text`/`anchor` as the
   * composer's pending quote. The affordance itself only shows when this is supplied, so an
   * `EditorShell` with no quote destination yet renders no dead button. Omitted here means this
   * shell has no quote destination wired (e.g. tests, or before the timeline right rail is
   * mounted — #409).
   */
  onQuoteSelection?: (quote: { text: string; anchor: Anchor }) => void;
  /**
   * The open document's comment threads (#259, P2b-4a) — owner-supplied, exactly like
   * `TimelinePanel`'s identical `commentThreads` prop: the mounted app's single owner for this
   * state is `App` (#411, TD-15), so this renders whatever it's given rather than loading its own
   * copy. `TabbedEditor` supplies it only for the active tab (mirroring `onChangesDecided`'s
   * identical active-tab-only scoping), so a background tab's `undefined` means no comment surface
   * is wired for it — the highlight layer and popover simply don't render there, matching
   * `onQuoteSelection`'s identical "no destination, no dead UI" convention.
   */
  commentThreads?: CommentThread[];
  /** A collapsed column owns selection when present; the editor popover owns it otherwise. */
  onColumnThreadSelected?: (threadId: string) => void;
  /** Active and queued run IDs used by the comment popover's correction hold. */
  liveRunIds?: readonly string[];
  queuedRunIds?: readonly string[];
  terminalRunIds?: readonly string[];
  /** Binding authoring-shell 4a/4b status mode selected by the timeline Comments facet. */
  commentMode?: boolean;
  /** The acting local identity for anything created/decided through the editor-anchored comment
   * popover (TD-4) — mirrors `timeline/CommentCard`'s identical default ("you"). */
  commentAuthor?: string;
  /** Injectable clock for the comment popover (CLAUDE.md: no reliance on real time in tests),
   * mirrors `timeline/CommentCard`'s identical prop. */
  now?: () => number;
  /**
   * Fired with the document's full updated thread list after ANY mutation made through the
   * editor-anchored comment popover (create/reply/resolve/reopen/re-anchor/address-with-AI/
   * re-delegate/decide-linked-changes) — the seam the single owner (`App`, #411, TD-15) reconciles
   * its own state through, mirroring `onChangesDecided`'s "every entry point reports here"
   * convention.
   */
  onCommentThreadsChanged?: (threads: CommentThread[]) => void;
  /** See `CommentPopover`'s own prop — threaded straight through, unchanged, to the owner that has
   * a surface to render it on (#1777). This shell adds nothing of its own to it and deliberately
   * raises no error presentation for it here. */
  onAddressRunFailed?: (root: string, error: unknown) => void;
  onAddressRunStarted?: (root: string, run: import("../timeline/agentActivity").StartRunResult) => void;
  onCommentRunLink?: import("./CommentPopover").CommentPopoverProps["onCommentRunLink"];
  /** See `CommentPopover`'s own prop — threaded straight through, unchanged, from the tab layer
   * that owns the open-tab set (#1724, FR-CHAT-4). This shell knows only its own document and so
   * has nothing of its own to add to it. */
  openDocuments?: () => OpenDocumentsSnapshot;
}

/** Imperative surface the tab layer (`editor/TabbedEditor.tsx`) needs beyond props/callbacks. */
export interface EditorShellHandle extends Pick<DocumentSurfaceHandle,
  "captureDictationTarget" | "retireDictationTarget" | "beginDictation" |
  "showDictationPartial" | "clearDictation" | "commitDictationFinal"> {
  /**
   * The mounted doc's exact current text (TD-2 — no serializer, this is `state.doc` verbatim).
   * `undefined` until the view has actually mounted (the `open_document` load is async — the
   * handle exists on ref-attach, before that load lands) — callers that persist this content
   * (`toSessionPayload`) must treat `undefined` as "not known yet," never coerce it to `""`, or a
   * restore-then-persist race clobbers a just-restored dirty tab's real content with empty text.
   */
  getContent(): string | undefined;
  /** Stops old-path saves after a correlated external move has carried this buffer elsewhere. */
  retireAutosaveForMove(): void;
  /**
   * Saves the current content the same way Cmd/Ctrl+S does — through the same single-flight
   * runner as autosave/manual-save (FR-ED-2), so a dirty-close-guard save can't race an in-flight
   * autosave write. Resolves once a write actually carrying this content (or one that superseded
   * it) completes, with `true` if that write succeeded and `false` if it failed, there was nothing
   * to save, or an unresolved FR-ED-7 divergence refused the write. That last refusal also returns
   * attention to Keep mine; callers must not treat resolution alone as success (see FR-ED-3's
   * dirty-close guard, which must not discard the edit by closing the tab on a refused/failed save).
   */
  save(): Promise<boolean>;
  /** Applies a successfully persisted Settings change to this mounted scheduler without remounting
   * the document (and therefore without losing its caret or undo history). */
  setAutosaveSettings(settings: AutosaveSettings): void;
  /**
   * Decides `ids` (and every group co-member, P4b) against the live document — the seam a caller
   * outside `editor/` reaches through rather than a raw CM6 view, so coordinate authority stays
   * inside this module (TD-13): the caller passes ids, this dispatches the one group-atomic
   * transaction (`trackedChanges.ts`'s `decisionsTransaction`) and hands back the *full* id set it
   * actually decided (the passed ids plus any swept-in co-member) — never a re-parse (TD-11).
   * Returns `null` before the view has mounted. Once mounted, returns an explicit empty array when
   * none of `ids` names a still-live change (e.g. already decided), so a caller can distinguish
   * "nothing was decided" from a callback that simply has no wider id set to report.
   *
   * **Identity, and what still guards it.** Since TD-16 an id is opaque and globally unique: a
   * change that joined a TD-4 record crosses the parse boundary as its durable `chg-` id, one that
   * did not as a `snap:<doc>:<generation>:<ordinal>` synthetic scoped to that document and that
   * parse. A stale id therefore no longer *resolves* against a different live change — it simply
   * names nothing here, and this seam's `null`/subset return is the honest outcome. The remaining
   * correspondence check is a UX one, not a safety one: `changeGeneration` below exposes the token a
   * caller compares against a change-set card's own `generation` so triage fails visibly closed
   * rather than silently doing nothing (UXR-Q4; `App.handleChangeSetDecide` does exactly this).
   */
  decideChanges(ids: string[], decision: Decision): string[] | null;
  /**
   * Runs J2's `[Save As…]` for this document: raises the save panel, refuses a destination outside
   * the project, writes the live buffer there and carries the document's history with it. Resolves
   * `true` only when bytes actually landed — a cancellation and every failure resolve `false`
   * having changed nothing, which is what lets a caller (the close guard) keep the tab open rather
   * than discarding a buffer it never managed to save.
   */
  saveAs(): Promise<boolean>;
  /**
   * Reopens the Missing-on-disk recovery actions after `[Keep editing]` dismissed them — what
   * activating the tab's persistent `Missing on disk` status does (ux-design). A no-op when this
   * document is not missing.
   */
  showMissingActions(): void;
  /**
   * The parse generation the live tracked-change field was last seeded with (UXR-Q4) — the token a
   * caller outside `editor/` compares against a change-set card's `generation` to know whether that
   * card's ids still correspond to this document's live changes before decideing them. `null` before
   * any seed, or for a seed with no stable revision (a manual reload). Read fresh; never cached.
   */
  changeGeneration(): string | null;
  /**
   * Lands an agent-delivered change set in this open buffer (#346, J1 Phase B): applies the
   * delivered text and its tracked-change seed as **one** transaction (`applyAgentDelivery`), so
   * there is no window where the markup is visible but unattributed (FR-AGENT-6). The user's caret,
   * selection, scroll and focus are left untouched (UX Principle 2) and the transaction stays out of
   * the undo history (TD §3.3 — Reject is the reversal).
   *
   * `changes` is the delivery's parse, supplied by the caller rather than fetched here: the same
   * snapshot feeds the timeline's change-set card, and the TD-11 corollary wants exactly *one*
   * authoritative parse per delivery, not one per surface that reacts to it.
   *
   * `content` is what the backend already wrote to disk. On a **clean** tab this also moves the
   * dirty and disk baselines: the tab stays clean (this is not an unsaved edit) and the FR-ED-7
   * external-change poller does not mistake Cowrite's own delivery for an outside write (finding
   * M11 — an agent-attributed write is a tracked change, never that banner).
   *
   * On a **dirty** tab (the buffer differs from the saved baseline) this is deliberately a no-op on
   * the buffer — applying would silently destroy the user's unsaved edit (UXR-Q3, ux-design §5 +
   * J1 Phase B: "suppress + banner"). The delivered set is still on disk/sidecar and its change-set
   * card still reaches the timeline; the FR-ED-7 poller surfaces the on-disk change as an external
   * change (Keep mine the highlighted default) rather than overwriting the in-progress edit. The
   * field's parse generation does **not** move in that case, so the change-set card (which carries
   * `generation`) does not correspond to the still-unseeded field and its triage fails closed
   * (UXR-Q4) — the buffer is never decided against ids it never took. That state is escapable, not
   * terminal: taking the banner's **Reload** replaces the buffer with the delivered bytes and seeds
   * the generation off the revision read with them, so the card corresponds again and its triage
   * re-enables — exactly when it is provable, never on a guess.
   *
   * `generation` is the delivery's revision (`notice.revision`) — the same token the timeline card
   * carries, seeded into the field on a clean-tab apply so the two correspond (UXR-Q4).
   */
  applyDelivery(content: string, changes: ParsedChange[], generation: string): void;
  /**
   * Selects and scrolls to `anchor`'s range in the live buffer — the timeline quote-bar's
   * deep-link-back (P2b-7 follow-up, #492, UX Principle 6 "everything in the panel deep-links
   * into the text"). Resolves `true` once the view scrolled/selected, `false` when there is no
   * mounted view or `anchor`'s recorded text no longer sits where it was captured (the document
   * moved on since — an honest no-op rather than guessing at a stale position, D17/P2; see
   * `resolveAnchor`'s own docs). Unlike `onQuoteSelection`'s capture path, this *is* a deliberate
   * focus/scroll (the whole point of following a deep link), not a caret-steal to guard against.
   */
  focusAnchor(anchor: Anchor): Promise<boolean>;
  /** Reveals a comment's live anchor without moving the current editor selection or focus. */
  revealCommentThread(thread: Pick<CommentThread, "id" | "anchor" | "withdrawn_at">, isCurrent?: () => boolean): Promise<boolean>;
  /** Focuses an already-live tracked change by its stable ID, without deciding it. */
  focusChange(changeId: string): boolean;
}

/**
 * Mounts a CM6 `EditorView` whose doc string is the file's exact content (TD-2 source-as-model):
 * loads `path` via `open_document` on mount, then saves through the single `save_document` path —
 * atomically and LF-normalized backend-side (FR-ED-2) — for all four triggers:
 *   - **autosave:** a debounce whose on/off and interval come from the Settings store (P2a-9,
 *     `settings.autosave`); when disabled, edits don't arm it (manual save still works);
 *   - **manual save:** Cmd/Ctrl+S, which saves immediately and drops any pending autosave;
 *   - **imperative save:** the tab layer's dirty-close guard, via `EditorShellHandle.save()`;
 *   - **unmount:** a final flush of a pending autosave so switching docs never drops the last edits.
 * An unresolved FR-ED-7 external-change choice pauses every write to that path across all four
 * triggers; only explicit Keep mine authorizes and immediately saves edits accumulated meanwhile.
 *
 * Autosave settings are read when the document opens; the General Settings surface can replace the
 * mounted scheduler through `setAutosaveSettings` without remounting CodeMirror or losing its
 * caret/undo history. A settings read failure falls back to defaults so it never blocks editing.
 *
 * Owner callbacks are read through refs and updated every render, so an inline callback identity
 * doesn't re-trigger the load-and-mount effect below — only a genuine `root`/`path` change (a
 * different document) does.
 */
export const EditorShell = forwardRef<EditorShellHandle, EditorShellProps>(function EditorShell(
  {
    root,
    path,
    platform,
    timelineReturn,
    batchAddressControl,
    providerStatuses = null,
    initialContent,
    autosaveIntervalMs,
    revealMarkupAtCursor = false,
    externalChangePollMs,
    missing = false,
    pickSaveAsPath = pickSaveAsPathDialog,
    onSavedAs,
    onMissingResolved,
    onRequestClose,
    onExternalChangeSaveBlocked,
    onSaved,
    onLoaded,
    onLoadError,
    onError,
    onCrlfDetected,
    onDirtyChange,
    onSaveStateChange,
    onChangesDecided,
    onChangesReversed,
    onChangeGenerationChange,
    onQuoteSelection,
    commentThreads,
    onColumnThreadSelected,
    liveRunIds,
    queuedRunIds,
    terminalRunIds,
    commentMode = false,
    commentAuthor = "you",
    now,
    onCommentThreadsChanged,
    onAddressRunFailed,
    onAddressRunStarted,
    onCommentRunLink,
    openDocuments,
  },
  ref,
) {
  const surfaceRef = useRef<DocumentSurfaceHandle | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The last-saved-to-disk text — dirty tracking's baseline. Starts at whatever `open_document`
  // returned (the override, if any, is a *display* choice, not a change to what's on disk) and
  // moves forward on every successful save (autosave, manual, or imperative). Deliberately *not*
  // normalization-adjusted: `dirtyTrackingExtension` compares this against
  // `serializeDocumentState(view.state)`, which always serializes with the view's own lineSeparator
  // (fixed at mount, `document.ts`) — so this baseline must stay in that same non-normalized shape,
  // or a CRLF document would read as permanently dirty immediately after a successful save.
  // @anchor:editor-shell-saved-content-ref
  const savedContentRef = useRef<string>("");
  // The last-known-actual-disk-bytes — the external-change poll's baseline (FR-ED-7), tracked
  // separately from `savedContentRef` above. Starts equal to it (a freshly loaded/reloaded document
  // mirrors disk exactly) but a *normalizing* save diverges the two: `save_document` LF-normalizes
  // CRLF/lone-CR on disk (FR-ED-2), so this baseline mirrors that transform
  // (`normalizeContentLineEndings`) while the dirty baseline above stays in the view's own line
  // endings — otherwise the very next poll reads back the now-LF disk and falsely reports an
  // out-of-band change against the file's own save (review finding, P2a-21).
  // @anchor:editor-shell-disk-content-ref
  const diskContentRef = useRef<string>("");
  // The CRLF banner's state: `null` when hidden, or the `dontConvert` closure the mount effect
  // captured (flips the per-document `normalizeLineEndings` flag off) once the user opts out.
  const [crlfBanner, setCrlfBanner] = useState<{ dontConvert: () => void } | null>(null);
  // The external-change banner's state (FR-ED-7): `null` when no divergence is known; otherwise the
  // disk content the poll last read, which Reload/Compare both read from — carried with the
  // revision of those exact bytes so Reload can seed the field's UXR-Q4 generation with it (a
  // reloaded buffer provably holds that parse, which is what re-enables a delivery's change-set
  // card after the UXR-Q3 dirty-tab suppression).
  type ExternalChange = {
    diskContent: string;
    diskRevision: string;
  };
  const [externalChange, setExternalChangeState] = useState<ExternalChange | null>(null);
  // The poll/save callbacks live for the whole CM6 mount and cannot see later React state. Update
  // this ref before scheduling a render so even an autosave landing between detection and paint
  // observes the unresolved FR-ED-7 choice and writes nothing (#1599).
  const externalChangeRef = useRef<ExternalChange | null>(null);
  // Incremented when this mount's ordinary-write authorization is invalidated. A save issued under
  // an older epoch may finish (detection-bound v1), but it no longer owns dirty or captured state.
  const saveAuthorizationEpochRef = useRef(0);
  // Whether the *current* observed episode has already had a manual/dirty-close Save blocked
  // against it (#2074 AC3) — rewrites both banner lines and is what focuses `Keep mine`. Reset
  // whenever the episode itself changes (resolved, or a fresh divergence replaces it): a rewritten
  // heading belongs to the attempt that produced it, never to a later, different episode.
  const [saveBlocked, setSaveBlocked] = useState(false);
  const updateExternalChange = (next: ExternalChange | null) => {
    externalChangeRef.current = next;
    setExternalChangeState(next);
    setSaveBlocked(false);
  };
  const [comparing, setComparing] = useState(false);
  const [externalChangeAttentionRequest, setExternalChangeAttentionRequest] = useState(0);
  const keepMineActionRef = useRef<HTMLButtonElement | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const nowRef = useRef(now ?? Date.now);
  nowRef.current = now ?? Date.now;
  // The Reload recovery-write presentation phases (#2074 AC1, document-integrity.md 11c.3–11c.5):
  // `null` outside an in-progress recovery. `reloading` is the brief busy banner (11c.3, `aria-
  // busy`, dimmed-but-mounted actions) that covers the buffer swap + issuing the write; it yields
  // to `pending` (11c.4) one microtask later, while the write is still in flight — a bannerless,
  // honestly-dirty window carried by the ordinary tab dot and status-bar recovery readout (AC5).
  // `failed` is the CJ-ratified #1641 disposition
  // (11c.5); its `diskContent` is kept so a Compare opened from the failure state still has its "on
  // disk" side once `externalChange` itself has already gone (the episode resolved when Reload was
  // clicked, not when the recovery write settles). A `Try again` retry (AC7) stays in `failed` the
  // whole time, toggling `retrying` — it does not re-enter `reloading`/`pending`, which describe
  // Reload's own "bringing in the version from disk" copy; a retry brings in nothing new, it
  // resubmits the buffer that is already there, so reusing that copy would be dishonest.
  type RecoveryPhase =
    | { kind: "reloading" }
    | { kind: "pending" }
    | { kind: "failed"; reason: string; retrying: boolean; diskContent: string };
  const [recoveryPhase, setRecoveryPhaseState] = useState<RecoveryPhase | null>(null);
  const recoveryPhaseRef = useRef<RecoveryPhase | null>(null);
  const setRecoveryPhase = (next: RecoveryPhase | null) => {
    recoveryPhaseRef.current = next;
    setRecoveryPhaseState(next);
  };
  // The raw error the atomic save runner's write callback last caught, so a recovery write's
  // failure banner can carry the *real* normalized reason (#2074 AC6) — the runner's own public
  // interface only ever resolves a boolean (`createSaveRunner`'s docs), so this is the one seam
  // that can see the underlying error. Cleared before every attempt so a stale value from an
  // unrelated earlier failure can never be misattributed to this one.
  const lastSaveErrorRef = useRef<unknown>(null);
  // The Missing-on-disk recovery surface (J2, #933). The banner is showing whenever the document is
  // missing and `[Keep editing]` has not dismissed it; the tab's persistent status reopens it
  // (`showMissingActions`). `recreateCapable` is TD-18's advisory answer for *this* path — the only
  // thing that puts `[Recreate]` on screen — and `recoveryFailure` is the recorded non-modal failure
  // a refused or failed attempt leaves behind, with the buffer and this state untouched.
  // Kept open while not Missing so the first render that enters the state already carries its
  // actions; an effect-only false→true transition would paint the persistent status one turn before
  // the banner and make the entry contract timing-dependent.
  const [missingBannerOpen, setMissingBannerOpen] = useState(true);
  const [recreateCapable, setRecreateCapable] = useState(false);
  const [recoveryFailure, setRecoveryFailure] = useState<MissingRecoveryFailure | null>(null);
  // The guarded choice a manual Save on a missing document gets instead of a write (ux-design).
  const [saveGuardOpen, setSaveGuardOpen] = useState(false);
  // The open document's comment threads (#259) — seeded from the `commentThreads` prop and
  // re-seeded whenever it changes (mirrors `TimelinePanel`'s identical `commentThreads`-prop
  // contract), plus updated locally whenever a mutation made through this shell's own comment
  // popover returns a fresh list. `commentThreadsRef` mirrors it for the CM6 click handler built
  // once inside the mount effect below, which cannot see a later render's state directly.
  const [commentThreadsState, setCommentThreadsState] = useState<CommentThread[]>(commentThreads ?? []);
  const commentThreadsRef = useRef(commentThreadsState);
  commentThreadsRef.current = commentThreadsState;
  // The revision the mounted view's text was loaded at (`open_document`'s `DocumentPayload.revision`,
  // TD-6) — the value every comment-thread seed dispatch is declared against
  // (`commentHighlights.ts`'s `setDocumentRevision`). `null` until the load resolves; a seed
  // dispatched before then would have nothing honest to declare, so seeding waits for it.
  const documentRevisionRef = useRef<string | null>(null);
  // The editor-anchored comment popover's state (#259, J4): `null` when closed, otherwise what
  // it's showing (create a thread at a selection, or view/act on an existing one). `null` when
  // closed. Deliberately holds no position: like `QuoteAffordance`'s and `RedlineReview`'s popover,
  // `style` is derived fresh at render time (`commentPopoverStyle` below) from the *live* view —
  // storing a snapshot here would go stale the moment an edit or scroll moved the anchor while the
  // popover stayed open.
  const [commentPopover, setCommentPopover] = useState<CommentPopoverTarget | null>(null);
  const popoverThread = commentPopover?.kind === "view"
    ? commentThreadsState.find((thread) => thread.id === commentPopover.thread.id)
    : null;
  useEffect(() => {
    if (commentPopover?.kind !== "view" || !commentThreads) return;
    if (popoverThread && popoverThread.withdrawn_at == null) return;
    viewRef.current?.dispatch({ effects: setSelectedCommentThread.of(null) });
    setCommentPopover(null);
  }, [commentPopover, commentThreads, popoverThread]);
  // A disk content the user has already said "Keep mine" to — suppresses re-showing the banner for
  // that exact content on the next poll (a real further external change still re-triggers it).
  const dismissedDiskContentRef = useRef<string | null>(null);
  // Read by the mount effect's long-lived closures (the update listener, the unmount flush, the
  // manual-save keybinding), which cannot see a later render's props — this is what makes "autosave
  // pauses while the file is missing" true for edits made after the document went missing.
  const missingRef = useRef(missing);
  missingRef.current = missing;
  // What is at this document's path stops being known the moment its file goes missing: the path is
  // free, and anything — a concurrent creator, a restored backup, the same file again — can occupy
  // it at any instant. So the write pause J2 raises outlasts the missing state itself, from that
  // moment until a completed read re-establishes the disk side (the FR-ED-7 check below, or a
  // `Recreate` that published bytes Cowrite chose). Ending Missing is not that read: a write
  // resuming with it would overwrite bytes nobody has looked at, which is the disk side FR-ED-7
  // exists to preserve and the source of truth TD-2 makes the file (#1595).
  const diskStateUnknownRef = useRef(false);
  // An autosave the pause above refused. It runs once the read lifts the pause having found nothing
  // to preserve; a divergence drops it instead, because writing then is exactly the silent overwrite
  // FR-ED-7 forbids — the banner that read raised now owns that choice.
  const autosaveDeferredRef = useRef(false);
  // Which question the disk answers are answering. Every read takes the current value when it is
  // issued and may only speak once it lands if nothing has moved it since: an answer overtaken by a
  // newer question describes a path this document has already asked about again. Two things move it
  // — a read starting, and an event that makes every outstanding read obsolete (the file going
  // missing, or a `Recreate` publishing the bytes itself). Without it, a read issued *before* the
  // file vanished can land after it comes back and settle the episode with pre-deletion bytes,
  // resuming writes over whatever now occupies the path — the same loss by a longer route (#1595).
  const diskReadGenerationRef = useRef(0);
  // Whether a divergence has been raised and not yet answered. `externalChange` is the same fact as
  // React state, but a save that waited out the pause resumes inside the read's own continuation,
  // one render too early to see it — so the ref is what that save consults (review round 1).
  const divergenceUndecidedRef = useRef(false);
  // Whether this Missing episode has already reported that its settling read cannot complete. The
  // pause makes an ordinarily transient poll failure load-bearing — it is the only thing that lifts
  // the pause — so it is surfaced once per episode rather than silently or on every tick (FR-X-5).
  const pauseReadFailureReportedRef = useRef(false);
  // Whether the *unguarded tail* of `checkDiskForExternalChange` — after the read itself has already
  // succeeded — has already reported a failure since the last check that completed normally (#1701).
  // Deliberately a separate ref from `pauseReadFailureReportedRef` above: that one is scoped to a
  // Missing *episode* and reset when the episode ends (below); a tail throw can happen on any tick,
  // inside or outside a Missing episode, so it has no episode to be scoped to and needs its own
  // once-per-failure-run memory instead (FR-X-5's once-per-episode discipline, generalized to "once
  // per run of consecutive failures" for a check with no episode).
  const checkFailureReportedRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  const onLoadedRef = useRef(onLoaded);
  const onLoadErrorRef = useRef(onLoadError);
  const onErrorRef = useRef(onError);
  const onCrlfDetectedRef = useRef(onCrlfDetected);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onChangesDecidedRef = useRef(onChangesDecided);
  const onChangesReversedRef = useRef(onChangesReversed);
  const onChangeGenerationChangeRef = useRef(onChangeGenerationChange);
  const onQuoteSelectionRef = useRef(onQuoteSelection);
  const onCommentThreadsChangedRef = useRef(onCommentThreadsChanged);
  const onColumnThreadSelectedRef = useRef(onColumnThreadSelected);
  const onExternalChangeSaveBlockedRef = useRef(onExternalChangeSaveBlocked);
  onSavedRef.current = onSaved;
  onLoadedRef.current = onLoaded;
  onLoadErrorRef.current = onLoadError;
  onErrorRef.current = onError;
  onCrlfDetectedRef.current = onCrlfDetected;
  onDirtyChangeRef.current = onDirtyChange;
  onSaveStateChangeRef.current = onSaveStateChange;
  onChangesDecidedRef.current = onChangesDecided;
  onChangesReversedRef.current = onChangesReversed;
  onChangeGenerationChangeRef.current = onChangeGenerationChange;
  onQuoteSelectionRef.current = onQuoteSelection;
  onCommentThreadsChangedRef.current = onCommentThreadsChanged;
  onColumnThreadSelectedRef.current = onColumnThreadSelected;
  onExternalChangeSaveBlockedRef.current = onExternalChangeSaveBlocked;
  // Read through a ref so the mount effect can arm the scheduler with the current interval without
  // taking `autosaveIntervalMs` as a dep (that would remount the CM6 view — losing cursor/undo —
  // just to change a timer). The scheduler captures the value once, when it's created.
  const autosaveIntervalRef = useRef(autosaveIntervalMs);
  autosaveIntervalRef.current = autosaveIntervalMs;
  const revealMarkupAtCursorRef = useRef(revealMarkupAtCursor);
  revealMarkupAtCursorRef.current = revealMarkupAtCursor;
  const externalChangePollRef = useRef(externalChangePollMs);
  externalChangePollRef.current = externalChangePollMs;

  // The current document's explicit-save entry point (set by the mount effect below) — the
  // imperative handle reuses it rather than writing directly, so a dirty-close-guard save shares
  // FR-ED-2's single-flight serialization instead of racing an in-flight autosave/manual save, and
  // waits out the same write pause instead of stepping over it.
  const saveNowRef = useRef<(() => Promise<boolean>) | null>(null);
  // The underlying runner is also reachable by the detection and recovery boundaries: detection
  // revokes any coalesced request that has not been issued, while Keep mine is the one choice that
  // may immediately issue the accumulated buffer.
  const runSaveRef = useRef<SaveRunner | null>(null);
  // This document's autosave scheduler, reachable from outside the mount effect so either Missing
  // transition can drop a pending write before it fires: entering, a debounce armed a moment before
  // the file disappeared must not become the "silent recreate" ux-design forbids; leaving, one armed
  // while it was gone must not become a write over whatever took the path (#1595).
  const schedulerRef = useRef<AutosaveScheduler | null>(null);
  const retiredForMoveRef = useRef(false);
  // Settings changes arrive after the mount effect has built its document-scoped scheduler. The
  // ref keeps that reconfiguration inside the same effect lifetime rather than making settings an
  // effect dependency (which would destroy/recreate CodeMirror and lose caret/undo state).
  const reconfigureAutosaveRef = useRef<(settings: AutosaveSettings) => void>(() => {});
  const autosaveEnabledRef = useRef(true);
  const autosaveSettingsGenerationRef = useRef(0);
  // The FR-ED-7 poll's own check, so the moments that need the disk side established *now* — a
  // Recreate that came back `Reappeared`, leaving Missing at all, an explicit save waiting on the
  // pause — can have it instead of waiting out an interval.
  const pollNowRef = useRef<(() => Promise<void>) | null>(null);
  // The per-document LF-normalization policy (FR-ED-2's "Don't convert this file" opt-out) as a
  // ref, because Recreate and Save As are React handlers outside the mount effect that owns it and
  // must write with the same policy the ordinary save path uses.
  const normalizeLineEndingsRef = useRef(true);
  // `runSaveAs` is defined below (it needs the render-scope handlers), while the imperative handle
  // is built once with no deps — the same ref idiom the callback props above use.
  const saveAsRef = useRef<() => Promise<boolean>>(async () => false);

  useImperativeHandle(
    ref,
    () => ({
      getContent: () =>
        viewRef.current ? serializeDocumentState(viewRef.current.state) : undefined,
      captureDictationTarget: () => surfaceRef.current?.captureDictationTarget() ?? false,
      retireDictationTarget: () => surfaceRef.current?.retireDictationTarget(),
      beginDictation: (generation) => surfaceRef.current?.beginDictation(generation) ?? false,
      showDictationPartial: (generation, text) =>
        surfaceRef.current?.showDictationPartial(generation, text) ?? false,
      clearDictation: (generation) => surfaceRef.current?.clearDictation(generation) ?? false,
      commitDictationFinal: (generation, text) =>
        surfaceRef.current?.commitDictationFinal(generation, text) ?? false,
      retireAutosaveForMove: () => {
        retiredForMoveRef.current = true;
        schedulerRef.current?.cancel();
        runSaveRef.current?.cancelTrailing();
      },
      save: async () => {
        // A missing document has nowhere to be saved: reporting `false` is what keeps the caller's
        // close/quit guard open instead of discarding the buffer on a write that never happened
        // (the tab layer offers `[Save As…]` there instead — `TabbedEditor`'s Missing close guard).
        if (retiredForMoveRef.current || !viewRef.current || !saveNowRef.current || missingRef.current) return false;
        const saved = await saveNowRef.current();
        if (!saved && externalChangeRef.current) {
          schedulerRef.current?.cancel();
          runSaveRef.current?.cancelTrailing();
          onExternalChangeSaveBlockedRef.current?.();
          setComparing(false);
          // #2074 AC3: rewrites both banner lines and is what focuses `Keep mine` below.
          setSaveBlocked(true);
          setExternalChangeAttentionRequest((request) => request + 1);
        }
        return saved;
      },
      setAutosaveSettings: (settings) => {
        autosaveSettingsGenerationRef.current += 1;
        reconfigureAutosaveRef.current(settings);
      },
      saveAs: () => saveAsRef.current(),
      showMissingActions: () => {
        if (!missingRef.current) return;
        setRecoveryFailure(null);
        setMissingBannerOpen(true);
      },
      decideChanges: (ids, decision) => {
        if (!viewRef.current) return null;
        const decided = decisionGroupClosure(viewRef.current.state, ids);
        if (decided.length === 0) return [];
        const spec = decisionsTransaction(viewRef.current.state, ids, decision, "card");
        if (!spec) return [];
        viewRef.current.dispatch(spec);
        return decided;
      },
      changeGeneration: () => (viewRef.current ? changeGeneration(viewRef.current.state) : null),
      applyDelivery: (content: string, changes: ParsedChange[], generation: string) => {
        if (!viewRef.current) return;
        // UXR-Q3 (ux-design §5 + J1 Phase B edge state — "suppress + banner"): a delivery may only
        // land in the buffer when the tab is *clean*. On a dirty tab the buffer holds unsaved user
        // edits; replacing it (and moving the baselines) would silently destroy that work and mark
        // the tab clean — the very loss this branch exists to make impossible, not merely
        // recoverable. So on a dirty tab: apply nothing, move NEITHER baseline, do not reseed. The
        // delivered set is already on disk/sidecar (and its change-set card still reaches the
        // timeline); the FR-ED-7 poller then sees disk ≠ the unmoved `diskContentRef` and raises the
        // external-change banner (Keep mine the highlighted default) for the user to resolve.
        const dirty = serializeDocumentState(viewRef.current.state) !== savedContentRef.current;
        if (dirty) return;
        // Clean tab (finding M11): an agent-attributed write is a tracked change, never an outside
        // edit. Both baselines move *before* the dispatch, exactly as `handleReload` does — the
        // delivered text is already on disk, so the tab stays clean and the FR-ED-7 poller has
        // nothing to report.
        savedContentRef.current = content;
        diskContentRef.current = content;
        // `generation` rides the same seed effect, so the field's UXR-Q4 correspondence token moves
        // to the delivery's revision in lockstep with the reseed — the card carrying that same
        // revision now corresponds, and every other card does not.
        applyAgentDelivery(viewRef.current, content, { changes, generation });
      },
      focusAnchor: (anchor: Anchor) => focusAnchorInEditor(viewRef.current, anchor),
      revealCommentThread: (thread, isCurrent) => revealCommentThreadInEditor(viewRef.current, thread, isCurrent),
      focusChange: (changeId: string) => {
        const view = viewRef.current;
        return view ? focusTrackedChange(view, changeId) : false;
      },
    }),
    [],
  );

  // A later `commentThreads` prop actually reaches rendered state (mirrors `TimelinePanel:227-228`'s
  // identical re-seed-on-identity contract) — the seam the single owner (`App`, #411) reaches
  // whenever its own `commentThreads` state changes (a document switch, or a mutation reported back
  // through `onCommentThreadsChanged` from any surface).
  useEffect(() => {
    if (commentThreads) setCommentThreadsState(commentThreads);
  }, [commentThreads]);

  // Re-seeds the live CM6 highlight layer whenever the thread list changes *after* the document has
  // loaded — a prop update, or a mutation made through this shell's own comment popover
  // (`applyCommentThreads` below). The initial seed (dispatched by the mount effect once its own
  // load resolves, in the same transaction as `setDocumentRevision`) is deliberately not this
  // effect's job: it needs to declare the revision atomically with the seed the very first time,
  // which this effect — running before `documentRevisionRef` is set — cannot yet do.
  //
  // `documentRevisionField` nulls out on every `docChanged`, so between an edit and the next save
  // this dispatch is deliberately a no-op: a dirty buffer's stored threads were anchored against
  // different text, and drawing them would be the confidently-wrong position P2 forbids (PR #495
  // review, Important #2). It is not a dead end for the life of the mount, though — a successful
  // save re-declares the buffer's revision from the one `save_document` returns and re-seeds
  // against it (`reseedCommentThreadsAfterSave` in the mount effect below, #1121), so a comment
  // created or resolved on an edited buffer gets its highlight at the next save.
  //
  // The declared revision alone is not enough, though (#1326/#1799): it names the buffer's *bytes*,
  // while the backend-resolved offsets index the raw disk text and CM6 counts every line break as
  // one position. `diskContentRef` is the last-known actual disk text those offsets describe. The
  // shared seed preparer verifies that the bytes are either its CM6-position text or its exact
  // serialization, then projects raw ranges through its line map; true divergence still refuses.
  useEffect(() => {
    if (!viewRef.current || documentRevisionRef.current === null) return;
    const seed = commentThreadSeedFromDisk(
      viewRef.current.state,
      diskContentRef.current,
      commentThreadsState,
      documentRevisionRef.current,
    );
    if (!seed) return;
    viewRef.current.dispatch({
      effects: setCommentThreads.of(seed),
    });
  }, [commentThreadsState]);

  // Opens the comment popover in view mode for the thread anchored where the user clicked
  // (`commentHighlights.ts`'s deep-link click, wired below) — reads live off refs rather than
  // render-time state/closures, since the CM6 extension calling this is built once inside the
  // mount effect. Position is derived at render time (`commentPopoverStyle` below), not here.
  const handleSelectCommentThread = (threadId: string) => {
    const thread = commentThreadsRef.current.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    if (onColumnThreadSelectedRef.current) {
      setCommentPopover(null);
      onColumnThreadSelectedRef.current(threadId);
      return;
    }
    setCommentPopover({ kind: "view", thread });
  };

  /** Closes the selected thread's popover and restores its ordinary open-anchor treatment. */
  const closeCommentPopover = () => {
    viewRef.current?.dispatch({ effects: setSelectedCommentThread.of(null) });
    setCommentPopover(null);
  };

  // Every entry point the comment popover's mutations report through (create/reply/resolve/reopen/
  // re-anchor/address-with-AI/re-delegate/decide-linked-changes) — updates this shell's own
  // rendered copy (which re-seeds the highlight layer via the effect above) and bubbles the full
  // list to `onCommentThreadsChanged` for the single owner (`App`, #411, TD-15) to reconcile. The
  // post-save re-read below reports through here too, so the freshly re-anchored list the backend
  // returns is the one every surface holds, not a second copy this shell keeps to itself.
  const applyCommentThreads = (threads: CommentThread[]) => {
    setCommentThreadsState(threads);
    onCommentThreadsChangedRef.current?.(threads);
  };
  // Reached from inside the mount effect (built once, so it cannot see a later render's closure) —
  // the same ref idiom the callback props above use.
  const applyCommentThreadsRef = useRef(applyCommentThreads);
  applyCommentThreadsRef.current = applyCommentThreads;

  useEffect(() => {
    let cancelled = false;
    // Bytes belonging to the ordinary save currently issued by *this* effect's document identity. A
    // poll may observe those bytes before the save promise's completion runs; this identity lets it
    // recognize Cowrite's own publication during that narrow window without freezing a later
    // external side. Deliberately a plain closure-local, not a `useRef` — every other participant in
    // the save/poll callbacks below (`cancelled`, `runSave`, `checkDiskForExternalChange`, `scheduler`)
    // is already scoped to this one effect run. A shared ref here (a prior revision of this code) let
    // a trailing write issued under a *prior* document identity, still executing after that document
    // unmounted, briefly overwrite the ref that this identity's poll reads — so the successor
    // document's poll could misread a stale publication as its own (review round: cross-document
    // identity poisoning, #1599). Scoping it here makes that leak structurally impossible: a stale
    // continuation from the old effect closes over the old effect's own `ownPublication` binding,
    // never this one's — and needs no explicit reset, since a fresh binding is what every effect run
    // already gets for free.
    let ownPublication: { content: string } | null = null;
    // A completion from the prior document identity cannot update this mount's baselines.
    saveAuthorizationEpochRef.current += 1;
    // Per-file LF-normalization policy: on by default (FR-ED-2), flipped off if the user chooses
    // "Don't convert this file" from the CRLF banner. Resets to the default when a different
    // document loads (the effect re-runs on `root`/`path`).
    normalizeLineEndingsRef.current = true;
    // Fresh banner state for the document this effect is (re)mounting for — a prior tab's
    // integrity banners must not bleed into a new one.
    setCrlfBanner(null);
    updateExternalChange(null);
    setRecoveryPhase(null);
    setComparing(false);
    setSaveGuardOpen(false);
    setRecoveryFailure(null);
    setIsDirty(false);
    isDirtyRef.current = false;
    setLastSavedAt(null);
    setCommentPopover(null);
    documentRevisionRef.current = null;
    dismissedDiskContentRef.current = null;
    // The write pause and everything it accumulated belong to the document that raised them. Left
    // behind, they silently kill the next document's autosave — and a deferred bit left set makes
    // that document's first settling read write a buffer nobody asked to save (review round 1).
    diskStateUnknownRef.current = false;
    autosaveDeferredRef.current = false;
    divergenceUndecidedRef.current = false;
    pauseReadFailureReportedRef.current = false;
    checkFailureReportedRef.current = false;

    // A save is the second (and only repeatable) moment the buffer's text provably *is* a named
    // backend revision — the load being the first — so it is where the comment-highlight seam
    // `documentRevisionField` closes on the first keystroke re-opens (#1121). `written` is what
    // actually landed on disk and `revision` names exactly those bytes (`save_document`'s return).
    //
    // The thread list is re-read rather than re-declared: `load_comment_threads` resolves every
    // anchor against the document's on-disk text (`commands::comments::resolved_threads`), which
    // this write just made identical to the buffer — so its offsets are in the very revision being
    // declared, and a thread whose text is gone comes back `orphaned` for the D17/FR-CMT-6 orphan
    // card instead of keeping a stale offset. Re-declaring the list already in state would claim
    // offsets resolved against the *pre-save* disk text describe the new revision, which is the
    // confidently-wrong position the revision gate exists to refuse (P2).
    const reseedCommentThreadsAfterSave = async (revision: string, written: string) => {
      // Nothing anchored in this document: no read (a save fires on every autosave tick, and the
      // overwhelmingly common document has no comments at all) and nothing to seed — just declare
      // the revision, so a *later* mutation's own re-seed can land.
      const known = commentThreadsRef.current;
      let threads: CommentThread[] | null = null;
      if (known.length > 0) {
        try {
          threads = await loadCommentThreads(root, path);
        } catch {
          // `threads` stays null, so nothing is seeded this round and the highlights are left
          // exactly where CM6 has mapped them — stale colours at honest positions. The revision
          // below is still declared: it names what the write put on disk whether or not the
          // sidecar could be read, so withholding it would cost the *next* mutation its highlight
          // too. The next save retries the read; nothing here is worth an error banner.
        }
      }
      if (cancelled || !viewRef.current) return;
      // The backend resolved these offsets against `written`, while the effect below consumes CM6
      // positions. The shared seed adapter accepts either honest form: LF bytes from a normalizing
      // save already share CM6's coordinate axis, while raw CRLF bytes from FR-ED-2's opt-out are
      // projected through the buffer's line map. A keystroke landing during the read, a session
      // restore, or any other buffer/disk divergence matches neither form and still refuses rather
      // than drawing a confidently wrong span (D17/FR-CMT-6, P2).
      // A mutation landed while the read was in flight, so this list is already the older of the
      // two — drop the list rather than let it overwrite the newer one (the next save re-reads).
      // The revision is declared regardless: it names this buffer whichever list is in hand, so
      // withholding it would cost a *later* mutation its seed as well, for no gain.
      if (commentThreadsRef.current !== known) threads = null;
      const seed = threads
        ? commentThreadSeedFromDisk(viewRef.current.state, written, threads, revision)
        : null;
      if (threads && !seed) return;
      documentRevisionRef.current = revision;
      viewRef.current.dispatch({
        effects: [
          setDocumentRevision.of(revision),
          ...(seed ? [setCommentThreads.of(seed)] : []),
        ],
      });
      if (threads) applyCommentThreadsRef.current(threads);
    };

    // Single-flight per document: overlapping triggers (manual-save-over-autosave, a debounced save
    // while the prior write is still landing, the unmount flush, and the tab layer's imperative
    // save) must not issue two concurrent `save_document` calls for one path — they would collide
    // on the shared atomic-write temp file. The runner serializes them and lets the latest content
    // win; each caller's own promise resolves once the write that actually carries its content
    // lands (see `createSaveRunner`).
    const runSave = createSaveRunner(async (content) => {
      // This callback is the issuance boundary, including for a coalesced trailing request. Entry
      // guards improve responsiveness; this recheck is what makes not-yet-issued work revocable.
      if (retiredForMoveRef.current || missingRef.current || externalChangeRef.current) return false;
      // Own the error presentation at issuance. A newer external revision may supersede a Reload
      // while its write is in flight, but a late failure from that recovery write still must not
      // become a separate application-wide error above the current integrity choice.
      const recoveryWrite = recoveryPhaseRef.current !== null;
      const issuedEpoch = saveAuthorizationEpochRef.current;
      const written = normalizeLineEndingsRef.current
        ? normalizeContentLineEndings(content)
        : content;
      const publication = { content: written };
      ownPublication = publication;
      try {
        const revision = await saveDocument(root, path, content, normalizeLineEndingsRef.current);
        // Whatever else changed while this write was in flight, its atomic completion is the newest
        // disk state Cowrite itself has observed. Keep this disk-only baseline current so a poll
        // between an explicit Keep mine and its queued write does not misclassify this known
        // publication as a second outside edit. The captured side and dirty baseline stay frozen.
        // A completion from an unmounted document (or one whose path is currently Missing) cannot
        // establish the current mount's disk baseline. Divergence within this same live mount may:
        // that is the known-publication case the next line records.
        if (ownPublication === publication) ownPublication = null;
        if (cancelled || missingRef.current) return false;
        diskContentRef.current = written;
        // CJ-ratified detection-bound v1 (#1599): an atomic save issued before detection may finish,
        // but its completion handling cannot replace the capture or declare the buffer clean.
        if (
          issuedEpoch !== saveAuthorizationEpochRef.current ||
          missingRef.current ||
          externalChangeRef.current
        ) {
          return false;
        }
        savedContentRef.current = content;
        // The baseline just moved but this dispatch touches no text — `recheckDirty` is what
        // makes `dirtyTrackingExtension` notice (see its module docs); calling `onDirtyChangeRef`
        // directly here instead would desync from the extension's own dedup memory.
        viewRef.current?.dispatch({ effects: recheckDirty.of() });
        setLastSavedAt(nowRef.current());
        onSavedRef.current?.();
        // Detached from the save's own promise: the write has landed and the caller (autosave,
        // the dirty-close guard) is owed nothing further — the re-seed is a highlight refresh,
        // not part of persistence, and must not delay or fail it.
        void reseedCommentThreadsAfterSave(revision, written);
        return true;
      } catch (error: unknown) {
        if (ownPublication === publication) ownPublication = null;
        // The one seam that can see the underlying error: `runSave`'s own public interface only
        // ever resolves a boolean (`createSaveRunner`'s docs). A Reload recovery write's failure
        // banner reads this to carry the real normalized reason (#2074 AC6) rather than a generic
        // one. A recovery failure is already presented by its contextual 11c.5 banner; ordinary
        // save failures continue through the application-wide error channel.
        lastSaveErrorRef.current = error;
        if (!recoveryWrite) onErrorRef.current?.(error);
        // Re-throw so `createSaveRunner` resolves this call's waiters `false`; it swallows the
        // rejection only to keep the serialization chain usable for later authorized work.
        throw error;
      }
    });
    runSaveRef.current = runSave;

    const triggerSave = (): void => {
      // Nothing is written for a document whose file is gone or whose FR-ED-7 changed-on-disk
      // choice remains unresolved. Guarded here because the debounce and unmount flush both arrive
      // through this one function — including a debounce armed just before either state landed.
      // The other two entry points refuse earlier and return attention to their guarded choice.
      // `recoveryPhaseRef` (#2074 AC6) extends the same pause through a Reload recovery attempt —
      // busy, pending, or failed — so an ordinary autosave tick cannot race `attemptRecoveryWrite`'s
      // own direct call to the runner; only `Try again`/`Save As…` may write during that window.
      if (
        !viewRef.current ||
        retiredForMoveRef.current ||
        missingRef.current ||
        externalChangeRef.current ||
        divergenceUndecidedRef.current ||
        recoveryPhaseRef.current !== null
      ) {
        return;
      }
      // The file is back but nothing has read it yet, so these bytes could land on top of whatever
      // took the path over (#1595). An automatic save waits for the read that settles it.
      if (diskStateUnknownRef.current) {
        autosaveDeferredRef.current = true;
        return;
      }
      void runSave(serializeDocumentState(viewRef.current.state));
    };

    /**
     * Lifts the write pause a Missing episode raised, now that a completed read has said what is at
     * this path. An autosave the pause refused runs here — unless that read found a divergence, in
     * which case FR-ED-7's banner owns the disk side and an automatic write over it is precisely the
     * silent overwrite the requirement forbids.
     */
    const resumeWrites = (diverged: boolean): void => {
      diskStateUnknownRef.current = false;
      const deferred = autosaveDeferredRef.current;
      autosaveDeferredRef.current = false;
      if (deferred && !diverged) triggerSave();
    };

    /**
     * An explicit save — Cmd/Ctrl+S, or the close/quit guard's imperative one. Unlike autosave it
     * is the user's own act, so the pause delays it rather than dropping it: it waits for the read
     * that establishes the disk side (raising FR-ED-7's banner if the file came back as someone
     * else's) and then writes. `false` means no write was issued at all, which is what keeps a
     * caller's guard — and the buffer it protects — open.
     */
    const saveNow = async (): Promise<boolean> => {
      // A Reload recovery attempt (#2074 AC6) is the same kind of pause: refusing here is what
      // keeps the write pause active through the failed state, and leaves the dirty-close guard
      // open rather than discarding the buffer on a write this function never actually issued.
      if (retiredForMoveRef.current || externalChangeRef.current || divergenceUndecidedRef.current || recoveryPhaseRef.current !== null) {
        return false;
      }
      if (diskStateUnknownRef.current) {
        try {
          await pollNowRef.current?.();
        } catch {
          // The settling poll's own tail already reported this failure where it had a consumer
          // (`onErrorRef`), or is escaping as the unhandled rejection the poller deliberately does
          // not catch (#1701) where it had none. Ordinarily the failure happens before that tail's
          // `resumeWrites` call, so `diskStateUnknownRef.current` is still true and the check right
          // below already refuses honestly; even in the narrower case where the throw originates
          // inside `resumeWrites` itself after it has already run, the disk side was genuinely read
          // in that ordering, so refusing here costs nothing either way. This catch exists only so
          // the same rejection does not also reject `saveNow` itself and, through it, the dirty-close
          // guard's un-try/catch'd `await ... .save()` (`TabbedEditor.tsx`), which would otherwise
          // neither close nor report.
        }
        // Still unknown means that read failed, so the path cannot be read at all: there is nothing
        // safe to write over, and refusing honestly beats guessing (FR-X-5).
        if (diskStateUnknownRef.current) return false;
        // The read that lifted the pause found another writer's bytes and raised FR-ED-7 for them.
        // Writing now destroys precisely what that banner is offering, before the user has answered
        // it — and the caller here is a close/quit guard whose user is answering "save before
        // closing?", not "overwrite the stranger's file". `false` is what keeps that guard, and the
        // buffer it protects, open. Only this window is refused: a divergence the user has already
        // been living with is the ordinary FR-ED-7 flow, unchanged (review round 1, Critical 2).
        if (divergenceUndecidedRef.current || externalChangeRef.current) return false;
      }
      // The read above is a round trip the document could have been unmounted or gone missing
      // across, so the view and the pause are re-checked on this side of it.
      if (retiredForMoveRef.current || !viewRef.current || missingRef.current) return false;
      return await runSave(serializeDocumentState(viewRef.current.state));
    };
    saveNowRef.current = saveNow;

    // Created once the settings load resolves the interval; manual save and unmount-flush reach it
    // through this outer binding (a `?.` — a save before settings arrive just has nothing to flush).
    let scheduler: AutosaveScheduler | null = null;
    // Created once the doc has loaded (below); stopped on unmount alongside the scheduler.
    let poller: ExternalChangePoller | null = null;
    let mountedView: EditorView | null = null;

    // @anchor:editor-shell-manual-save-keybinding
    const manualSave = (): boolean => {
      // A missing document's manual save performs no write and reopens the guarded choice instead
      // (ux-design: `"This file is missing from disk. [Cancel] [Save As…]"`, plus `[Recreate]` when
      // confinement permits) — the key is still consumed, so nothing else claims it.
      if (missingRef.current) {
        scheduler?.cancel();
        setSaveGuardOpen(true);
        return true;
      }
      scheduler?.cancel();
      void saveNow().then((saved) => {
        if (!saved && externalChangeRef.current) {
          runSave.cancelTrailing();
          setComparing(false);
          // #2074 AC3: rewrites both banner lines and is what focuses `Keep mine` below — the
          // primary Ctrl/Cmd+S path must set this the same way the imperative `save()` handle does,
          // or a blocked manual save never shows the ratified blocked-Save copy (review Important 1).
          setSaveBlocked(true);
          setExternalChangeAttentionRequest((request) => request + 1);
        }
      });
      return true;
    };

    const configureAutosave = (autosave: AutosaveSettings) => {
      scheduler?.cancel();
      autosaveEnabledRef.current = autosave.enabled;
      // The D23 e2e hook remains the injectable-clock authority over interval only. A real Settings
      // toggle still controls whether user edits arm this scheduler at all.
      scheduler = createAutosaveScheduler(
        triggerSave,
        autosaveIntervalRef.current ?? autosave.interval_ms,
      );
      schedulerRef.current = scheduler;
      if (autosave.enabled && isDirtyRef.current) scheduler.schedule();
    };
    reconfigureAutosaveRef.current = configureAutosave;
    const settingsGenerationAtLoad = autosaveSettingsGenerationRef.current;

    // A settings read failure must never block editing — fall back to the defaults.
    Promise.all([openDocument(root, path), getSettings().catch(() => DEFAULT_SETTINGS)])
      .then(([{ content, revision }, settings]) => {
        if (cancelled || !surfaceRef.current) return;
        // A user can commit Settings while this document's initial read is still in flight. Never
        // let the older read win that race and roll the live scheduler back to its pre-save value.
        if (settingsGenerationAtLoad === autosaveSettingsGenerationRef.current) {
          configureAutosave(settings.autosave);
        }
        savedContentRef.current = content;
        diskContentRef.current = content;
        const displayContent =
          initialContent !== undefined && initialContent !== content ? initialContent : content;
        const surface = surfaceRef.current;
        if (!surface) return;
        const view = surface.mount({
          content: displayContent,
          revealMarkupAtCursor: revealMarkupAtCursorRef.current,
          parseDocument: { root, path },
          parseGeneration: displayContent === content ? revision : null,
          keyBindings: [
            // Key spec comes from `editor/keymap.ts` (P2b-9b, #362) — the single place this
            // app's Cmd/Ctrl bindings are defined.
            { key: KEYMAP.save.spec, run: manualSave, preventDefault: true },
          ],
          extensions: [
            dirtyTrackingExtension(
              () => savedContentRef.current,
              (dirty) => {
                onDirtyChangeRef.current?.(dirty);
                isDirtyRef.current = dirty;
                setIsDirty(dirty);
              },
            ),
          ],
          onUpdate: (update) => {
            // Agent deliveries are already persisted; only user edits arm file autosave.
            if (update.docChanged && autosaveEnabledRef.current && !isAgentDelivery(update)) {
              scheduler?.schedule();
            }
          },
          onChangesDecided: (ids, source) => onChangesDecidedRef.current?.(ids, source),
          onChangesReversed: (ids) => onChangesReversedRef.current?.(ids),
          onChangeGenerationChange: (generation) =>
            onChangeGenerationChangeRef.current?.(generation),
          onCommentThreadSelected: handleSelectCommentThread,
          commentProjection: {
            sourceText: content,
            revision,
            threads: commentThreadsRef.current,
          },
          onParseError: (error) => onErrorRef.current?.(error),
        });
        mountedView = view;
        viewRef.current = view;
        documentRevisionRef.current = revision;
        if (hasNonLfLineEndings(content)) {
          const dontConvert = () => {
            normalizeLineEndingsRef.current = false;
          };
          onCrlfDetectedRef.current?.(dontConvert);
          setCrlfBanner({ dontConvert });
        }
        if (displayContent !== content) {
          // Route the initial dirty announcement through the extension itself (a `recheckDirty`
          // dispatch, no text change) rather than calling `onDirtyChangeRef` directly — the
          // extension owns the one `lastDirty` memory; bypassing it here would desync from a
          // later save's own `recheckDirty` dispatch.
          viewRef.current.dispatch({ effects: recheckDirty.of() });
        }

        // External-change detection (FR-ED-7): a bounded-interval poll rather than a live FS watch
        // — `openDocument` is already a pure, side-effect-free read (§3.1), so reusing it here needs
        // no new backend surface. A poll in flight is never overlapped (`createExternalChangePoller`);
        // a divergence the user already dismissed via "Keep mine" for this exact disk content is not
        // re-shown until the disk changes again.
        // @anchor:editor-shell-external-change-check
        const checkDiskForExternalChange = async () => {
          if (cancelled || !viewRef.current) return;
          const generation = ++diskReadGenerationRef.current;
          let disk: DocumentPayload;
          try {
            disk = await openDocument(root, path);
          } catch (error: unknown) {
            // A transient read failure (e.g. the file briefly missing mid-external-write) is not
            // reported as an editor error — the next poll tries again. Any write pause stays on:
            // nothing here established what is at the path.
            //
            // Except while that pause is up and the document is no longer missing: this read is then
            // the only thing that can lift it, so a path that stays unreadable stops autosave for
            // good. Say so once per episode — never silently, never once per tick (FR-X-5).
            if (
              diskStateUnknownRef.current &&
              !missingRef.current &&
              !pauseReadFailureReportedRef.current
            ) {
              pauseReadFailureReportedRef.current = true;
              onErrorRef.current?.(error);
            }
            return;
          }
          try {
            // Superseded: something asked about this path again while this read was in flight, so
            // these bytes are no longer an answer about it. Silently dropping them is the point —
            // reporting them would raise FR-ED-7 for content that is not there, and settling the
            // Missing episode with them would resume writes over bytes never read.
            if (cancelled || generation !== diskReadGenerationRef.current) return;
            // A read can beat the completion continuation of the save whose atomic publication it is
            // observing. Recognize that issued payload specifically, and move only the disk baseline:
            // captured C remains the choice until a genuinely different external D arrives.
            const isOwnPublication = disk.content === ownPublication?.content;
            if (isOwnPublication) diskContentRef.current = disk.content;
            // "Keep mine" against exactly these bytes is a decision already taken: not a divergence
            // to raise again, and not a reason to hold a write back either — the same
            // `dismissedDiskContentRef` mechanism, and `handleReload` now sets it identically
            // (review CRITICAL, PR #2108). FR-ED-7 detection is otherwise never suppressed by a
            // Reload recovery attempt: an unbounded silence here — nothing observed, `Try again`
            // free to overwrite a third party's newer bytes — is exactly the silent overwrite this
            // requirement forbids. A *different* disk revision arriving during `reloading`/
            // `pending`/`failed` still diverges normally and still captures below.
            const diverged =
              !isOwnPublication &&
              isExternallyChanged(disk.content, diskContentRef.current) &&
              disk.content !== dismissedDiskContentRef.current;
            if (diverged) {
              const captured = externalChangeRef.current;
              const isCurrentCapture =
                captured?.diskContent === disk.content && captured.diskRevision === disk.revision;
              // A later genuine disk revision becomes the side Reload/Compare/Keep mine resolve.
              // Repeated polls of that same revision are no-ops, while Cowrite's own A was excluded
              // above even if its read landed before A's completion continuation.
              if (!isCurrentCapture) {
                saveAuthorizationEpochRef.current += 1;
                scheduler?.cancel();
                runSave.cancelTrailing();
                updateExternalChange({ diskContent: disk.content, diskRevision: disk.revision });
                // A genuinely new external write supersedes any Reload recovery attempt already in
                // progress (#2074) — `attemptRecoveryWrite`'s own `issuedEpoch` check (bumped just
                // above) is what stops that stale attempt from later overwriting this with a phase
                // that no longer applies. The fresh `externalChange` this just set drives the
                // ordinary observed banner (`bannerState` below) the instant this commits.
                setRecoveryPhase(null);
              }
              // Mirrored into a ref because a save waiting out the pause resumes in this same
              // continuation, before React has re-rendered — the state above is not readable there,
              // and that save is exactly who needs to know (`saveNow`).
              divergenceUndecidedRef.current = true;
            }
            // This completed read is what re-establishes the disk side after a Missing episode — but
            // only once the tab layer has actually ended that state, since writes must not resume
            // while the document is still missing (#1595).
            if (!missingRef.current) resumeWrites(diverged);
            // A tick that reaches here never touched the failure path below — the next tick starts
            // this run's failure bookkeeping fresh, so a later failure is reported again (FR-X-5).
            checkFailureReportedRef.current = false;
          } catch (error: unknown) {
            // This tick could not settle the disk side. Nothing here established what is at the path,
            // so any write pause stays up — resuming from a failed tick is the silent overwrite
            // FR-ED-7 forbids. With no consumer there is no way to state the failure (FR-X-5), so it
            // is left to escape as the unhandled rejection the poller deliberately does not catch —
            // the only channel that reddens a test run (#1690). A consumer, once told, is the honest
            // report.
            if (!onErrorRef.current) throw error;
            if (!checkFailureReportedRef.current) {
              checkFailureReportedRef.current = true;
              onErrorRef.current(error);
            }
          }
        };
        pollNowRef.current = checkDiskForExternalChange;
        poller = createExternalChangePoller(
          checkDiskForExternalChange,
          externalChangePollRef.current ?? DEFAULT_EXTERNAL_CHANGE_POLL_MS,
        );
        poller.start();
        if (displayContent === content) setLastSavedAt(nowRef.current());
        onLoadedRef.current?.();
      })
      .catch((error: unknown) => {
        if (!cancelled) (onLoadErrorRef.current ?? onErrorRef.current)?.(error);
      });

    return () => {
      cancelled = true;
      // Flush a pending autosave before tearing down so switching documents never drops the last
      // edits (`triggerSave` captures the content synchronously, so the write survives `destroy`).
      // Inside the write pause this flush defers instead of writing, so those edits are not saved
      // here: the document has no established disk state to write to, and unsaved is recoverable
      // where a write over another writer's file is not. The buffer itself is retained by the tab
      // layer, which is what makes that the safe direction (J2, FR-ED-7).
      //
      // Deliberately *not* followed by `runSave.cancelTrailing()`: a prior revision of this cleanup
      // cancelled the flush's own just-queued trailing write (coalesced here whenever an ordinary
      // save was already in flight at teardown), silently dropping the final edits on an ordinary,
      // non-divergent document — exceeding what FR-ED-7/ux-design scope to "while the choice is
      // unresolved" (review finding, #1599). The divergent path needs no cancel here either: raising
      // the pause already calls `scheduler?.cancel()` + `runSave.cancelTrailing()` at detection
      // (below), so nothing is ever queued by the time this flush would coalesce into it.
      if (!retiredForMoveRef.current) scheduler?.flush();
      saveAuthorizationEpochRef.current += 1;
      schedulerRef.current = null;
      reconfigureAutosaveRef.current = () => {};
      pollNowRef.current = null;
      poller?.stop();
      if (mountedView) surfaceRef.current?.destroy();
      viewRef.current = null;
      saveNowRef.current = null;
      runSaveRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialContent` is a mount-time seed only
  }, [root, path]);

  useEffect(() => {
    surfaceRef.current?.setRevealMarkupAtCursor(revealMarkupAtCursor);
  }, [revealMarkupAtCursor]);

  /**
   * Entering and leaving **Missing on disk** (J2, #933). Entering: drop any pending autosave before
   * it can fire (the debounce may have been armed a keystroke before the file disappeared), stop
   * treating this path's contents as known, raise the banner, and ask TD-18 whether `[Recreate]` may
   * be offered *for this exact path* — a query, never a token, so the answer stays advisory and
   * invocation re-acquires. Leaving: clear the whole recovery surface, and hand what is now at the
   * path to the one thing that can say what it holds.
   *
   * A capability query that fails is read as unavailable — the fail-closed direction, and the same
   * answer macOS gives by design.
   */
  useEffect(() => {
    if (!missing) {
      // Prime the next Missing transition. The banner is still absent because rendering is gated by
      // `missing`; this only prevents a one-render gap when the next completed generation enters it.
      setMissingBannerOpen(true);
      setRecoveryFailure(null);
      setSaveGuardOpen(false);
      setRecreateCapable(false);
      // Coming back out of Missing (#1595). The debounce armed while the file was gone carries an
      // edit autosave already refused once, and the transition must not be what resurrects it — so
      // drop it, and read the path now rather than an interval later, because until that read lands
      // nobody knows whether the file came back as this document's or as somebody else's.
      if (diskStateUnknownRef.current) {
        schedulerRef.current?.cancel();
        void pollNowRef.current?.();
      }
      return;
    }
    diskStateUnknownRef.current = true;
    // Every read still in flight was asked of a file that has since vanished, so none of them can
    // answer for this path any more. Retiring them HERE, not at the next read, is what makes the
    // pause survive the exit: React sets `missingRef.current = false` during the leaving render but
    // runs the leaving effect on a later task, and a stale read landing in that window would clear
    // the pause — which is the flag that effect's debounce-cancel and immediate read are both gated
    // on. It would skip both, and the debounce armed while the file was gone would fire over a path
    // nothing has read since it came back (#1595, review round 1).
    diskReadGenerationRef.current += 1;
    pauseReadFailureReportedRef.current = false;
    // The path's identity is gone with the file, so nothing learned about its previous occupant
    // still describes it: a "Keep mine" dismissal must not suppress FR-ED-7 for a *new* occupant
    // that happens to carry those bytes, and a divergence about content that no longer exists must
    // not outlive it. `handleRecreate`'s `created` branch clears the same three, one exit over.
    dismissedDiskContentRef.current = null;
    divergenceUndecidedRef.current = false;
    saveAuthorizationEpochRef.current += 1;
    updateExternalChange(null);
    // A Reload recovery episode (#2074) belongs to the disk side that raised it — a Missing
    // transition, either direction, means that side no longer describes the same thing (the file
    // vanished mid-recovery, or a *different* file just reappeared), so a stale `reloading`/
    // `pending`/`failed` banner must not survive across it.
    setRecoveryPhase(null);
    setComparing(false);
    schedulerRef.current?.cancel();
    runSaveRef.current?.cancelTrailing();
    setRecoveryFailure(null);
    let cancelled = false;
    recreateMissingDocumentCapability(path)
      .then((capability) => {
        if (!cancelled) setRecreateCapable(capability.status === "available");
      })
      .catch(() => {
        if (!cancelled) setRecreateCapable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [missing, path]);

  /**
   * `[Recreate]` — writes the buffer back to the original path, and only while TD-18 confinement
   * still holds and that path is still absent. Every exit but `created` deliberately leaves the
   * view, buffer, rail and Missing state exactly as they were:
   *
   * - `created`: the file exists again with these bytes, so both baselines move to what was written
   *   (the tab is clean, and the FR-ED-7 poller has nothing to report), and the tab layer clears
   *   Missing — which is what resumes autosave. The restored rail row arrives with TD-18's own
   *   announcement of the generation this write produced.
   * - `reappeared`: nothing was overwritten and the target was never read. Missing is over, and the
   *   disk side belongs to FR-ED-7's changed-contents flow — so the poll runs immediately rather
   *   than after an interval, and it (not this) decides whether anything differs.
   * - `confinement_unavailable` / `failed`: the recorded non-modal failure, with `[Save As…]` still
   *   available.
   */
  const handleRecreate = () => {
    const view = viewRef.current;
    if (!view) return;
    setSaveGuardOpen(false);
    const content = serializeDocumentState(view.state);
    const normalize = normalizeLineEndingsRef.current;
    recreateMissingDocument(path, content, normalize)
      .then((outcome) => {
        if (!viewRef.current) return;
        switch (outcome.status) {
          case "created": {
            savedContentRef.current = content;
            diskContentRef.current = normalize ? normalizeContentLineEndings(content) : content;
            // This publication *is* what is at the path — written under transaction-long confinement
            // with replacement disabled — so the Missing episode's write pause ends here, with no
            // read needed to establish it (ux-design: Recreate "clears the missing state, and
            // resumes autosave"). It is also the newest fact about the path, which retires every
            // read still in flight: each was asked before these bytes existed.
            diskStateUnknownRef.current = false;
            diskReadGenerationRef.current += 1;
            viewRef.current.dispatch({ effects: recheckDirty.of() });
            // Any divergence a poll noticed before the file vanished describes bytes this write has
            // now replaced — raising FR-ED-7's banner for it the moment the Missing state ends would
            // report Cowrite's own write as an outside change (finding M11's rule, one path over).
            updateExternalChange(null);
            setComparing(false);
            divergenceUndecidedRef.current = false;
            dismissedDiskContentRef.current = null;
            setMissingBannerOpen(false);
            onMissingResolved?.();
            return;
          }
          case "reappeared": {
            setMissingBannerOpen(false);
            onMissingResolved?.();
            void pollNowRef.current?.();
            return;
          }
          case "confinement_unavailable": {
            setRecreateCapable(false);
            setRecoveryFailure({ kind: "confinement" });
            setMissingBannerOpen(true);
            return;
          }
          default: {
            setRecoveryFailure({ kind: "error", detail: outcome.message });
            setMissingBannerOpen(true);
          }
        }
      })
      .catch((error: unknown) => {
        if (!viewRef.current) return;
        setRecoveryFailure({ kind: "error", detail: errorDetail(error) });
        setMissingBannerOpen(true);
      });
  };

  /**
   * `[Save As…]` — the recovery that always exists, missing document or not. The panel opens inside
   * the project and a destination outside it is refused rather than written (the same rule
   * `File > Open…` applies to the other direction, `stores/menu.ts`), because a document outside the
   * root has no sidecar identity to carry its history to.
   *
   * Resolves `true` only when bytes landed. A cancellation resolves `false` having asked the backend
   * nothing at all, and a failed write resolves `false` after a backend that already guarantees it
   * changed nothing (`save_document_as`'s history-first ordering).
   */
  const runSaveAs = async (): Promise<boolean> => {
    if (!viewRef.current) return false;
    let chosen: string | null = null;
    try {
      chosen = await pickSaveAsPath(root, path);
    } catch (error: unknown) {
      onErrorRef.current?.(error);
      return false;
    }
    if (chosen === null) return false;
    const destination = relativeToProjectRoot(root, chosen);
    if (destination === null) {
      onErrorRef.current?.({
        kind: "InvalidPath",
        message: "That file is outside the open project.",
      });
      return false;
    }
    // Read after the panel closes, not before it opened: what is saved is what the buffer holds
    // when the write is actually issued (the panel is a round trip the user could have typed
    // through), and the view is re-checked because an unmount could have landed in that window.
    if (!viewRef.current) return false;
    const content = serializeDocumentState(viewRef.current.state);
    try {
      await saveDocumentAs(root, path, destination, content, normalizeLineEndingsRef.current);
    } catch (error: unknown) {
      onErrorRef.current?.(error);
      return false;
    }
    setSaveGuardOpen(false);
    setMissingBannerOpen(false);
    // The tab layer follows this the way it follows a proven external move: this shell is about to
    // be remounted at the new path with this buffer, so nothing else here needs updating.
    onSavedAs?.(destination);
    return true;
  };
  saveAsRef.current = runSaveAs;

  // External-change banner actions (FR-ED-7 — never silently overwrite either side): each is an
  // explicit user choice, never automatic.

  /**
   * Drives the recovery write's presentation phases (#2074 AC1/AC4/AC5/AC6/AC7) around the *same*
   * atomic save runner Reload always used — never a second one. `isRetry` distinguishes Reload's
   * own first attempt (which owns the `reloading`→`pending` busy/dirty sequence, AC4/AC5) from a
   * `Try again` retry (which stays inside the `failed` state, toggling `retrying`, AC7) — see the
   * `RecoveryPhase` type doc above for why they are not the same transition.
   *
   * Bounded to one in-flight attempt (AC7): a retry re-checks that this episode is actually
   * `failed` and not already retrying before doing anything, so a second click while one attempt is
   * still outstanding is a no-op rather than a second overlapping write.
   *
   * `diskSide` is threaded separately from `content` (review Important 2, PR #2108): `content` is
   * whatever is being *submitted* — the current buffer on a retry, which may hold edits made since
   * the failure — while `diskSide` is what is genuinely still on disk (unchanged by a failed write)
   * and is what Compare must keep showing. On the first attempt they are the same value; a retry
   * carries the already-recorded `diskSide` forward instead of re-deriving it from `content`.
   *
   * `issuedEpoch` guards against a genuinely new external divergence arriving while this attempt is
   * outstanding (review CRITICAL, PR #2108): the poll bumps `saveAuthorizationEpochRef` and clears
   * `recoveryPhase` itself the moment it captures one (below), so if the epoch has moved by the time
   * this attempt would otherwise report reloading/pending/failed, that capture already owns the
   * banner and this attempt must not overwrite it with a stale phase.
   */
  const attemptRecoveryWrite = async (content: string, isRetry: boolean) => {
    const issuedEpoch = saveAuthorizationEpochRef.current;
    let diskSide: string;
    if (isRetry) {
      const current = recoveryPhaseRef.current;
      if (current?.kind !== "failed" || current.retrying) return;
      diskSide = current.diskContent;
      setRecoveryPhase({ ...current, retrying: true });
    } else {
      diskSide = content;
      setRecoveryPhase({ kind: "reloading" });
    }
    // Yield one microtask so the phase transition above actually commits and paints before the
    // (usually much longer) write settles — React's automatic batching could otherwise fold this
    // and the next state update into a single commit, and the intermediate busy state the tests and
    // AC4 rely on being observable would never actually render.
    await Promise.resolve();
    if (!viewRef.current || saveAuthorizationEpochRef.current !== issuedEpoch) return;
    if (!isRetry) setRecoveryPhase({ kind: "pending" });
    lastSaveErrorRef.current = null;
    const succeeded = runSaveRef.current ? await runSaveRef.current(content) : false;
    if (!viewRef.current || saveAuthorizationEpochRef.current !== issuedEpoch) return;
    if (succeeded) {
      setRecoveryPhase(null);
      return;
    }
    const reason = errorDetail(lastSaveErrorRef.current) || "Emend couldn’t finish the write.";
    setRecoveryPhase({ kind: "failed", reason, retrying: false, diskContent: diskSide });
  };

  const handleReload = () => {
    if (!viewRef.current || !externalChange) return;
    const { diskContent, diskRevision } = externalChange;
    // The captured side may no longer be what is on disk: detection-bound v1 permits an already-
    // issued save to publish after capture. Replace the buffer now, but leave its dirty baseline
    // untouched until the explicit recovery write below makes these bytes durable.
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: diskContent },
    });
    // Re-seed through the shared surface's stale-fenced canonical parser. Its input is the *view*
    // text the replace above produced (CM6 position space), while the generation names the exact
    // disk revision now mounted. A matching change-set card can therefore become triageable again
    // without this wrapper creating a second parser owner.
    surfaceRef.current?.setParseDocument({ root, path }, diskRevision);
    // Mark these captured bytes dismissed (review CRITICAL, PR #2108) — the same mechanism Keep
    // mine already uses, not `diskContentRef`: that ref means "what Cowrite last confirmed IS on
    // disk" (moved only by an actual read or an actual write's own completion, `runSave`'s
    // unconditional `diskContentRef.current = written`), and advancing it here on a mere click
    // would be wrong under detection-bound v1 — an already-issued save from *before* detection may
    // complete with *different* bytes after this exact capture, which is real evidence this ref
    // must still reflect. `dismissedDiskContentRef` only says "do not re-raise these exact bytes as
    // a fresh surprise", which is what actually stops the poll from re-reporting the very content
    // Reload just captured as a *new* divergence on every tick while the recovery write is
    // unresolved (a real divergence — different bytes — still raises normally; see the `diverged`
    // predicate below, which no longer special-cases the recovery phase at all).
    dismissedDiskContentRef.current = diskContent;
    schedulerRef.current?.cancel();
    runSaveRef.current?.cancelTrailing();
    divergenceUndecidedRef.current = false;
    updateExternalChange(null);
    setComparing(false);
    void attemptRecoveryWrite(diskContent, false);
  };

  /** `Try again` (#2074 AC6/AC7): resubmits whatever the buffer currently holds — not the bytes
   * captured at Reload time — since typing is never blocked while this banner is up (ux-design
   * Principle 2) and a further edit made since the failure is what the author now wants saved. */
  const handleTryAgain = () => {
    if (!viewRef.current) return;
    void attemptRecoveryWrite(serializeDocumentState(viewRef.current.state), true);
  };

  const handleKeepMine = () => {
    if (!externalChange) return;
    // A deliberate, explicit choice (never a silent overwrite). CJ-ratified #1599 requires edits
    // accumulated while autosave was paused to land immediately, with no further keystroke or
    // manual Save. A clean buffer has no accumulated edit to write.
    dismissedDiskContentRef.current = externalChange.diskContent;
    const view = viewRef.current;
    const content = view ? serializeDocumentState(view.state) : null;
    const hasAccumulatedEdits = content !== null && content !== savedContentRef.current;
    schedulerRef.current?.cancel();
    runSaveRef.current?.cancelTrailing();
    divergenceUndecidedRef.current = false;
    updateExternalChange(null);
    setComparing(false);
    if (hasAccumulatedEdits && content !== null && runSaveRef.current) {
      void runSaveRef.current(content);
    }
  };

  const handleCompare = () => setComparing(true);
  const handleCloseCompare = () => setComparing(false);

  // A background poll must never steal focus, but a Save the user explicitly asked for while the
  // choice is unresolved returns attention to that existing choice. This effect runs after both
  // this shell and TabbedEditor's dirty-close guard state commit, so the target is visible.
  useEffect(() => {
    if (externalChangeAttentionRequest === 0) return;
    keepMineActionRef.current?.focus();
  }, [externalChangeAttentionRequest]);

  // What the one FR-ED-7 banner (#2074 AC1) shows, computed once so `reloading`/`failed` and the
  // ordinary `observed` choice share the same JSX slot below — the component stays mounted across
  // an observed→reloading transition instead of unmounting and remounting, which is what keeps its
  // `role="status"` from re-announcing itself on every phase change (document-integrity.md
  // "Announcement copy" / "Nothing is announced on entry"). `reload-write-pending` (AC5) has no
  // member here at all: between the buffer swap and a successful recovery write the banner resolves
  // to `null`; the ordinary tab dot and `saveStatusState` below carry 11c.4's two honest signals.
  const bannerState: ExternalChangeBannerState | null =
    recoveryPhase?.kind === "reloading"
      ? { kind: "reloading" }
      : recoveryPhase?.kind === "failed"
        ? { kind: "failed", reason: recoveryPhase.reason, retrying: recoveryPhase.retrying }
        : externalChange
          ? { kind: "observed", blocked: saveBlocked }
          : null;
  // Compare's "on disk" side survives past the point `externalChange` itself clears (Reload
  // resolves that episode immediately on click, AC1) — carried in the `failed` phase's own
  // `diskContent` so Compare still works from the failure banner (AC7).
  const compareDiskContent =
    externalChange?.diskContent ??
    (recoveryPhase?.kind === "failed" ? recoveryPhase.diskContent : null);
  const saveStatusState = useMemo<DocumentSaveState | null>(
    () =>
      recoveryPhase?.kind === "reloading" || recoveryPhase?.kind === "pending"
        ? { kind: "reload-write-pending" }
        : recoveryPhase?.kind === "failed"
          ? { kind: "reload-write-failed" }
          : externalChange
            ? { kind: "writes-paused" }
            : lastSavedAt === null
              ? null
              : { kind: "saved", at: lastSavedAt },
    [externalChange, lastSavedAt, recoveryPhase?.kind],
  );
  useEffect(() => {
    onSaveStateChangeRef.current?.(saveStatusState);
  }, [saveStatusState]);
  const statusPlatform = platform ?? (isMac ? "mac" : "win");
  const saveStatusOverflowEntry = saveStatusState
    ? documentSaveStatusOverflowEntry(saveStatusState, statusPlatform)
    : null;
  const trailingStatusItems: readonly DocumentStatusBarTrailingItem[] =
    saveStatusState && saveStatusOverflowEntry
      ? [
          {
            id: "save-state",
            content: <DocumentSaveStatus state={saveStatusState} platform={statusPlatform} />,
            overflowEntries: [saveStatusOverflowEntry],
          },
        ]
      : [];

  return (
    <div className="editor-shell">
      <DocumentSurface
        ref={surfaceRef}
        platform={statusPlatform}
        timelineReturn={timelineReturn}
        batchAddressControl={batchAddressControl}
        hidden={comparing}
        selectionActionsHidden={commentPopover !== null}
        onViewChange={(view) => {
          viewRef.current = view;
        }}
        onQuoteSelection={onQuoteSelection}
        onQuoteError={(error) => onErrorRef.current?.(error)}
        onCommentSelection={(selected) =>
          setCommentPopover({ kind: "create", selection: selected })
        }
        beforeHost={
          <>
            {/* Never alongside the Missing banner: while this document has no file there is nothing
                for "changed on disk" to be about. */}
            {bannerState && !comparing && !missing && (
              <ExternalChangeBanner
                path={path}
                state={bannerState}
                isDirty={isDirty}
                onReload={handleReload}
                onKeepMine={handleKeepMine}
                onCompare={handleCompare}
                onTryAgain={handleTryAgain}
                onSaveAs={() => void runSaveAs()}
                keepMineRef={keepMineActionRef}
              />
            )}
            {compareDiskContent !== null && comparing && (
              <ExternalChangeCompare
                path={path}
                localContent={viewRef.current ? serializeDocumentState(viewRef.current.state) : ""}
                diskContent={compareDiskContent}
                onClose={handleCloseCompare}
              />
            )}
            {missing && missingBannerOpen && !comparing && (
              <MissingOnDiskBanner
                recreatable={recreateCapable}
                failure={recoveryFailure}
                onKeepEditing={() => setMissingBannerOpen(false)}
                onSaveAs={() => void runSaveAs()}
                onClose={() => onRequestClose?.()}
                onRecreate={handleRecreate}
              />
            )}
            {missing && saveGuardOpen && (
              <MissingDocumentGuard
                kind="save"
                label={path}
                recreatable={recreateCapable}
                onCancel={() => setSaveGuardOpen(false)}
                onSaveAs={() => void runSaveAs()}
                onRecreate={handleRecreate}
              />
            )}
            {crlfBanner && (
              <CrlfBanner
                onOk={() => setCrlfBanner(null)}
                onDontConvert={() => {
                  crlfBanner.dontConvert();
                  setCrlfBanner(null);
                }}
              />
            )}
          </>
        }
        renderOverlay={(view, liveSelection) =>
          commentPopover && (commentPopover.kind !== "view" || (popoverThread && popoverThread.withdrawn_at == null)) ? (
            <CommentPopover
              key={commentPopover.kind === "view" ? commentPopover.thread.id : "create"}
              root={root}
              platform={statusPlatform}
              document={{ kind: "path", path }}
              readContent={() => viewRef.current ? editorOffsetText(viewRef.current.state) : ""}
              author={commentAuthor}
              now={now}
              target={commentPopover.kind === "view" ? { kind: "view", thread: popoverThread! } : commentPopover}
              style={commentPopoverStyle(view, commentPopover, liveSelection)}
              onThreadsChanged={applyCommentThreads}
              onAddressRunFailed={onAddressRunFailed}
              onAddressRunStarted={onAddressRunStarted}
              onCommentRunLink={onCommentRunLink}
              onFocusChange={(changeId) => {
                const view = viewRef.current;
                return view ? focusTrackedChange(view, changeId) : false;
              }}
              onFocusAnchor={(anchor) => {
                void focusAnchorInEditor(viewRef.current, anchor).then((focused) => {
                  if (focused) closeCommentPopover();
                });
              }}
              openDocuments={openDocuments}
              liveRunIds={liveRunIds}
              queuedRunIds={queuedRunIds}
              terminalRunIds={terminalRunIds}
              onClose={closeCommentPopover}
            />
          ) : null
        }
        documentStatusFacts={{
          openCommentCount: commentCounts(commentThreadsState).open,
          resolvedCommentCount: commentCounts(commentThreadsState).resolved,
          commentMode,
        }}
        trailingStatusItems={[
          ...trailingStatusItems,
          agentConnectionStatusItem(providerStatuses),
        ]}
      />
    </div>
  );
});

/** Absolute positioning just past a document offset (the selection's end), or `undefined` when the
 * view has no layout yet (headless tests / before first paint) — mirrors `RedlineReview`'s
 * identical `coordsAtPos`-based helper for its own popover. */
function selectionCoordsStyle(view: EditorView, pos: number): CSSProperties | undefined {
  let coords: { bottom: number; left: number } | null = null;
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    return undefined;
  }
  if (!coords) return undefined;
  return { position: "absolute", top: coords.bottom, left: coords.left };
}

/** Where the comment popover floats (#259) — the create case reuses the selection's own live end
 * (identical to `QuoteAffordance`/`CommentTrigger`'s positioning); the view case looks up the
 * target thread's *current* anchor (`commentAnchors`, already mapped through every edit since
 * seeding) each render, so a popover left open through an edit or a scroll never floats over a
 * stale position. `undefined` (unpositioned, matching every other popover here) when the view
 * has no layout yet, or — already orphaned/dropped since the popover opened — no live anchor. */
function commentPopoverStyle(
  view: EditorView,
  target: CommentPopoverTarget,
  selection: SelectionSnapshot | null,
): CSSProperties | undefined {
  if (target.kind === "create") {
    return selection ? selectionCoordsStyle(view, selection.offset + selection.length) : undefined;
  }
  const anchor = commentAnchors(view.state).find((candidate) => candidate.threadId === target.thread.id);
  return anchor ? selectionCoordsStyle(view, anchor.to) : undefined;
}
