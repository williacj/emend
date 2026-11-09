// ABOUTME: Root component for Cowrite's whole-window author/reviewer boundary; author mode shows
// ABOUTME: the J8 welcome screen until a project is opened (P2a-22), then header chrome above an
// ABOUTME: `.app-body` row that is either workshop
// ABOUTME: mode (timeline centre-stage, no doc open) or the standard authoring layout (tab-aware
// ABOUTME: editor centre + timeline right rail, #409/P2b-6b), plus General autosave Settings. The
// ABOUTME: dev-only e2e test hook (D23)
// ABOUTME: opens a project/doc directly, bypassing the native folder picker Playwright can't
// ABOUTME: drive — this, the native `File > Open…` menu item (#697), and every other document
// ABOUTME: entry point all converge on the same project/request queue.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ProjectOpenStatusRegion } from "./ProjectOpenStatusRegion";
import { WindowChrome } from "./WindowChrome";
import { errorDetail, formatActionFailure, formatDocumentActionFailure, UnsupportedRestoreRefusalError } from "./backend";
import { BatchAddressTrigger, NO_BATCH_FILTER, canBatchAddress, commentCounts, loadCommentThreads, type Anchor, type BatchAddressFilter, type CommentDocumentOwner, type CommentThread } from "./comments";
import { type CommentRunLink } from "./comments/types";
import {
  TabbedEditor,
  type RunActiveCloseRefusal,
  type TabbedEditorHandle,
} from "./editor";
import type { DeliveryTarget } from "./editor/TabbedEditor";
import { DocumentSaveStatus, type DocumentSaveState } from "./editor/DocumentSaveStatus";
import type { DocumentStatusBarPlatform } from "./editor/DocumentStatusBar";
import { parseChanges } from "./editor/ipc";
import type { DecisionSource } from "./editor/trackedChanges";
import { isMac } from "./editor/keymap";
import { CommentCard } from "./timeline/CommentCard";
import {
  EditorOnlyStatusChipView,
  WelcomeScreen,
  pickProjectFolder,
  useProviderStatuses,
} from "./onboarding";
import { ProjectRail, ProjectRailToggle, type ProjectFilesSnapshot } from "./projectRail";
import { isWorkshopMode } from "./stores";
import { changeSetCardFor, listenForDeliveries, type DeliveryNotice } from "./stores/delivery";
import {
  documentBirthCardFor,
  listenForDocumentBirths,
  type DocumentBirthNotice,
} from "./stores/documentBirth";
import { discoverGrounding, groundingCardFor } from "./stores/grounding";
import {
  listenForOpenDocumentRequests,
  listenForSaveDocumentAsRequests,
  pickDocumentFile,
  pickSaveAsPath,
  relativeToProjectRoot,
} from "./stores/menu";
import {
  currentProject,
  listenForProjectRouting,
  openProject,
  routeProjectOpen,
} from "./stores/project";
import {
  focusProjectOpenRecoveryTarget,
  markProjectOpenRetryPending,
  reduceProjectOpenStatus,
  type ProjectOpenStatus,
} from "./stores/projectOpenStatus";
import { subscribeWhileMounted } from "./stores/subscriptions";
import {
  beginAppStatusRequest,
  dismissAppStatus,
  getAppStatus,
  type AppStatusSnapshot,
  setAppStatusAudience,
  setUserAppStatus,
  subscribeAppStatus,
} from "./stores/appStatus";
import { testHarness, type OpenRequest } from "./testHarness";
import {
  getSettingsStoreSnapshot,
  SettingsDialog,
  subscribeSettings,
} from "./settings";
import { useTheme } from "./theme";
import {
  TimelinePanel,
  type ChangeSetDecision,
  type TimelineRunRevealRequest,
} from "./timeline";
import { failedRunStatus } from "./timeline/agentActivity";
import { NO_OPEN_DOCUMENTS, type OpenDocumentsSnapshot } from "./timeline/referenceData";
import { createAgentWorkingCard } from "./timeline/types";
import type { ChangeSetTriageTarget, QuotedExcerpt, TimelineCard } from "./timeline/types";
import { useRenderRecoveryAttempt } from "./renderRecovery/context";
import { VoiceSettingsOpenContext } from "./voice/SharedDictationMic";

interface OpenRequestQueueState {
  current: OpenRequest | null;
  pending: OpenRequest[];
  processing: boolean;
}

function canRestoreSettingsFocus(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target.matches(":disabled")) return false;
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

function MessageStatusRegion({ status, audience }: {
  status: NonNullable<AppStatusSnapshot>;
  audience: "author" | "reviewer";
}) {
  const refusal = status.presentation?.kind === "unsupported-restore-refusal"
    ? status.presentation : null;
  return (
    <div className={`shell-status${refusal ? " shell-status--unsupported-refusal" : ""}`} role="status">
      <p className="shell-status__message">
        {refusal ? (
          <><em>{refusal.path}</em> can’t open as an Emend document.{" "}
            {refusal.outcome === "closed"
              ? "Its tab was closed."
              : <span className="shell-status__reason">Its unsaved work was over the session limit and wasn’t kept.</span>}
          </>
        ) : audience === "reviewer" ? status.reviewerMessage : status.authorMessage}
      </p>
      <button
        type="button"
        className="shell-status__dismiss"
        aria-label="Dismiss message"
        onClick={dismissAppStatus}
      >
        {refusal ? "×" : "Dismiss"}
      </button>
    </div>
  );
}

function AuthorWorkspace({
  platform,
  appStatus,
}: {
  platform: DocumentStatusBarPlatform;
  appStatus: AppStatusSnapshot;
}) {
  const recoveryAttempt = useRenderRecoveryAttempt();
  const { mode, setMode } = useTheme();
  // One live probe feeds onboarding, the opened-project header, and every document status bar.
  // Provider detection can invoke each CLI, so duplicating the hook per surface/tab would multiply
  // that bounded subprocess work on mount and on every window-focus refresh (FR-X-4).
  const providerStatuses = useProviderStatuses();
  const settingsSnapshot = useSyncExternalStore(
    subscribeSettings,
    getSettingsStoreSnapshot,
    getSettingsStoreSnapshot,
  );
  const settings = settingsSnapshot.settings;
  // `undefined` = backend startup hydration pending; `null` = J8 welcome; string = open project.
  // The pending state deliberately renders blank so a routed adoption never flashes Welcome.
  const [project, setProject] = useState<string | null | undefined>(undefined);
  // Async comment admissions retain their submitting root across a project switch. Keep this
  // current even before React commits the next project render so their callbacks cannot append
  // an old root's run card to the new root's incoming-card list.
  const currentProjectRoot = useRef(project);
  const [projectOpenStatus, setProjectOpenStatus] = useState<ProjectOpenStatus | null>(null);
  // Dismissing an in-flight J9 line hides its request updates, not its terminal outcome.
  const dismissedProjectOpenInFlight = useRef<{
    requestId: string | null;
    retryRoot: string | null;
  } | null>(null);
  const retryInFlightRoot = useRef<string | null>(null);
  const projectOpenStatusRegionRef = useRef<HTMLDivElement>(null);
  const closeRefusalFocus = useRef<Pick<
    RunActiveCloseRefusal,
    "returnFocusTo" | "fallbackFocusTarget"
  > | null>(null);
  const pendingCloseRefusalFocusRecovery = useRef(false);
  const revealNonce = useRef(0);
  const [runRevealRequest, setRunRevealRequest] = useState<TimelineRunRevealRequest | undefined>();
  useEffect(() => {
    if (!recoveryAttempt || project === undefined) return;
    recoveryAttempt.registry.patch(recoveryAttempt.token, {
      selector: project === null ? "author-no-project" : "author-project",
    });
    if (project === null) recoveryAttempt.ready();
  }, [project, recoveryAttempt]);
  // TimelinePanel remounts per project, so its permission-navigation focus origin must live at this
  // stable owner until the replacement panel restores it or falls back to its own Timeline host.
  const permissionNavigationFocus = useRef<{
    project: string;
    target: HTMLElement | null;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEntry, setSettingsEntry] = useState<"general" | "voice">("general");
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const openVoiceSettings = useCallback((trigger: HTMLButtonElement) => {
    settingsReturnFocusRef.current = trigger;
    setSettingsEntry("voice");
    setSettingsOpen(true);
  }, []);
  // Every document-open producer converges here. A single replaceable request slot loses
  // intermediate requests when React batches several producers before `TabbedEditor` renders
  // (#1486), so retain later requests until the editor acknowledges the current one.
  const [openRequestQueue, setOpenRequestQueue] = useState<OpenRequestQueueState>({
    current: null,
    pending: [],
    processing: false,
  });
  const request = openRequestQueue.current;
  // Undefined = editors use their built-in default; the D23 hook can override it (see testHarness).
  const [autosaveIntervalMs, setAutosaveIntervalMs] = useState<number | undefined>(undefined);
  const [externalChangePollMs, setExternalChangePollMs] = useState<number | undefined>(undefined);
  // One dev-only answer for the out-of-process native Save panel. An object distinguishes a queued
  // Cancel (`path: null`) from no substitution at all, where `tauri dev` must keep using the real
  // native panel. The click consumes it once, matching one user interaction rather than installing
  // a persistent fake picker.
  const nextSaveAsDialogResult = useRef<{ path: string | null } | null>(null);
  const nextOpenDocumentDialogResult = useRef<{ path: string | null } | null>(null);
  // Undefined = comment-thread actions stamp their events with the real `Date.now()`; the D23 hook
  // can pin it to a fixed value instead (P2b-11c, test-plan §7 — see `testHarness.setCommentNowMs`).
  const [commentNowMs, setCommentNowMs] = useState<number | undefined>(undefined);
  // The two halves of the most recent agent delivery (#346, J1 Phase B), fanned out from one
  // subscription: what the open editor should reseed with, and the card the timeline should raise.
  const [delivery, setDelivery] = useState<DeliveryTarget | null>(null);
  // Agent-originated cards to append to the timeline (`TimelinePanel.incomingCards`) — fed by
  // *either* the delivery pipe above (a `propose_changes` change-set card) or the document-birth
  // pipe below (#420, a `create_document` card): both are agent tool results with no route back to
  // the frontend of their own, so both land here the same way.
  //
  // A *list*, not a single most-recent slot (review of PR #552 @ 9e456349, Important): React 18
  // batches state updates by microtask drain, not by callsite, so two producers writing a single
  // slot in the same drain collapse into one render — and because `TimelinePanel`'s append is
  // driven by an effect on the slot's *value*, the intermediate value is never observed at all
  // (silently dropping a timeline card and the `appendTranscriptEvent` that should have fired for
  // it — a D4 record-integrity defect). Appending to a list instead of replacing a single value
  // means every producer's card survives regardless of how many renders collapse; `TimelinePanel`
  // already dedupes by id (`appendedCardIds`), so handing it the whole list and letting it append
  // whichever entries it hasn't seen yet is what makes the collapse harmless by construction.
  // The list belongs to one open-project lifetime: both project-entry paths pass through
  // `enterProjectRoot` below, which clears it before changing `project`, so the remounted panel
  // can never replay the previous root's cards into the next root's D15 transcript (#1798).
  const [incomingCards, setIncomingCards] = useState<TimelineCard[]>([]);
  const [persistedIncomingCards, setPersistedIncomingCards] = useState<TimelineCard[]>([]);
  const nextRequestId = useRef(0);
  // P2b-6b: "is any document tab open" — the one fact `isWorkshopMode` is derived from. Optimistic
  // on `request` changing (below), authoritative once `TabbedEditor` reports its real tab-set size
  // (its `onTabsChange` prop, wired below) — the only source that can flip this back on "close the
  // last tab."
  const [hasOpenTabs, setHasOpenTabs] = useState(false);
  // The seam into the live editor a mounted `ChangeSetCard`'s triage decides against (#410) — the
  // active tab's `decideChanges`, reached through `TabbedEditor`'s own imperative handle so
  // coordinate authority stays inside `editor/` (TD-13; this shell only ever passes ids across it).
  const tabbedEditorRef = useRef<TabbedEditorHandle>(null);
  useEffect(() => {
    tabbedEditorRef.current?.setAutosaveSettings(settings.autosave);
  }, [settings.autosave.enabled, settings.autosave.interval_ms]);
  // Completed generations that arrived before this project's restored open-tab set was ready. This
  // must be a list, not a latest-snapshot slot: moves are one-shot identity events, so React-style
  // collapsing would silently discard an intermediate move before restored tabs could follow it
  // (#1446).
  const pendingProjectFileGenerations = useRef<ProjectFilesSnapshot[]>([]);
  // Updated synchronously from `TabbedEditor.onTabsReady`, after its asynchronous session restore
  // has committed. Readiness deliberately survives an empty tab set: a mounted editor in workshop
  // mode must consume generations against that empty set so their one-shot moves cannot be replayed
  // onto documents opened later.
  const editorTabsReady = useRef(false);
  // The most recent batch the active tab's editor decided, from ANY entry point (#410's
  // editor→card direction), including its origin so #798 can distinguish redo from fresh editor
  // triage after reversal. `TimelinePanel` owns accumulating ids into the running reconciliation
  // set (see its own `decidedChangeIds` docs for why the accumulation lives there, not here).
  const [lastDecidedChanges, setLastDecidedChanges] = useState<{
    ids: string[];
    source: DecisionSource;
  }>({ ids: [], source: "editor" });
  // The matching one-shot Ctrl+Z event; the panel subtracts this batch from that running set and
  // each mounted card removes it from its own local account (UXR-Q5 Reversed).
  const [lastReversedChangeIds, setLastReversedChangeIds] = useState<string[]>([]);
  // The active tab's triage target (UXR-Q4): which document a change-set card's ids may be decided
  // against, and the parse generation the live tracked-change field holds — reported up by
  // `TabbedEditor` on every active-tab or field-generation change. Fanned out to every change-set
  // card (via `TimelinePanel`) so a card whose document or parse no longer corresponds disables its
  // own triage rather than deciding the wrong text, and re-checked in `handleChangeSetDecide` before
  // any decision is routed. `null` when no tab is active (workshop mode) — every card reads as
  // mismatched, the correct fail-closed state.
  const [triageTarget, setTriageTarget] = useState<ChangeSetTriageTarget | null>(null);
  const [pendingLinkedChangeFocus, setPendingLinkedChangeFocus] = useState<{
    root: string; path: string; changeId: string;
  } | null>(null);
  const [pendingCommentAnchorFocus, setPendingCommentAnchorFocus] = useState<{
    root: string; path: string; anchor: Anchor;
  } | null>(null);
  // #411: the currently active document, relative to `project` — `null` when no tab is active (no
  // project open, or the last tab just closed). Optimistically seeded from `request` below (mirrors
  // `hasOpenTabs`'s own seed) and corrected by `TabbedEditor.onActivePathChange`, the only source
  // that can tell this shell a tab switch happened with no new `request` (switching to an
  // already-open tab via the tab bar).
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(null);
  // The toolbar moves its Address all control into and out of a portal as width changes. Keep
  // J4's filter and deliberate held-thread opt-in above that slot; clear both on document switch.
  const [batchAddressFilter, setBatchAddressFilter] = useState<BatchAddressFilter>(NO_BATCH_FILTER);
  const [batchIncludedHeldKey, setBatchIncludedHeldKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    setBatchAddressFilter(NO_BATCH_FILTER);
    setBatchIncludedHeldKey(null);
  }, [project, activeDocumentPath]);
  const [activeUnsupportedRecoveryTitle, setActiveUnsupportedRecoveryTitle] = useState<string | null>(null);
  const [activeCommentOwner, setActiveCommentOwner] = useState<CommentDocumentOwner | null>(null);
  // The tab layer selects one file-backed pane's existing save/recovery projection for window
  // chrome. Only macOS consumes ordinary Saved here; pending/failure remain document-status facts.
  const [activeDocumentSaveState, setActiveDocumentSaveState] =
    useState<DocumentSaveState | null>(null);
  // J2's rail marks only the path the editor confirms active. A request is merely an attempt: if
  // opening races with deletion or permission loss, this value stays on the current document and
  // the shell status reports the failure instead of moving the rail marker optimistically.
  const [confirmedActiveDocumentPath, setConfirmedActiveDocumentPath] = useState<string | null>(
    null,
  );
  // 3a/3b: Windows owns this toggle in the files rail; macOS owns it in the title bar. Keeping the
  // state here lets either platform collapse the same persistent third `.app-body` child without
  // remounting the editor or timeline (J2; docs/design/specs/platform-variants.md).
  const [filesRailCollapsed, setFilesRailCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const batchAddressAction = useRef<((threadIds: string[], includeHeldThreadIds: string[]) => void) | null>(null);
  const [batchAddressRunning, setBatchAddressRunning] = useState(false);
  const [timelinePermissionStatus, setTimelinePermissionStatus] = useState<{ project: string; pending: boolean } | null>(null);
  const timelinePermissionPending = timelinePermissionStatus?.project === project && timelinePermissionStatus?.pending === true;
  const handleTimelinePermissionPendingChange = useCallback((pending: boolean) => {
    if (!project) return;
    setTimelinePermissionStatus((current) =>
      current?.project === project && current.pending === pending ? current : { project, pending },
    );
  }, [project]);
  const railReturnNonce = useRef(0);
  const [focusComposerRequest, setFocusComposerRequest] = useState<{ project: string; nonce: number } | null>(null);
  const [permissionAttentionRequest, setPermissionAttentionRequest] = useState<{ project: string; nonce: number } | null>(null);
  // #411: this shell is the single owner of the active document's comment-thread state in the
  // mounted app — see `timeline/TimelinePanel.tsx`'s own module doc for why this prop/state pair
  // (rather than a separate global store) is the chosen design. Loaded fresh whenever the active
  // document changes (below) and never held for a document that isn't the one on screen, which is
  // what keeps a closed/backgrounded document's threads from being held in memory indefinitely.
  const activeCommentKey = project && activeCommentOwner
    ? JSON.stringify([project, activeCommentOwner.kind, activeCommentOwner.kind === "path" ? activeCommentOwner.path : activeCommentOwner.docId])
    : null;
  const [commentLoad, setCommentLoad] = useState<{
    key: string;
    phase: "pending" | "loaded" | "failed";
    threads: CommentThread[];
  } | null>(null);
  // UXR-Q13.3: keep one latest accepted run per project/document/thread through terminal
  // projection and tab switches. A run-less admission never calls the updater; a later accepted
  // run replaces both the target and its submit-time sent-text fact for that same thread.
  const [commentRunLinks, setCommentRunLinks] = useState<Record<string, Record<string, CommentRunLink>>>({});
  const recordCommentRunLink = useCallback((root: string, owner: CommentDocumentOwner, threadId: string, link: CommentRunLink) => {
    // Use the submitting card's identity: a slow admission can resolve after a tab/project switch.
    const key = JSON.stringify([root, owner.kind, owner.kind === "path" ? owner.path : owner.docId]);
    setCommentRunLinks((current) => ({
      ...current,
      [key]: { ...current[key], [threadId]: link },
    }));
  }, []);
  const commentThreads = commentLoad?.key === activeCommentKey ? commentLoad.threads : [];
  const commentLoadPhase = commentLoad?.key === activeCommentKey ? commentLoad.phase : "pending";
  const [commentSortByOwner, setCommentSortByOwner] = useState<Record<string, "position" | "recency">>({});
  const commentSort = activeCommentKey ? commentSortByOwner[activeCommentKey] ?? "position" : "position";
  const [commentSortOpen, setCommentSortOpen] = useState(false);
  const [heldEditPositions, setHeldEditPositions] = useState<{
    key: string; slots: Record<string, number>;
  } | null>(null);
  const sortedCommentThreads = [...commentThreads].sort((a, b) => {
    if (commentSort === "recency") {
      return b.last_activity_at - a.last_activity_at || a.id.localeCompare(b.id);
    }
    const aOffset = a.orphaned ? null : a.anchor?.offset ?? null;
    const bOffset = b.orphaned ? null : b.anchor?.offset ?? null;
    if (aOffset === null || bOffset === null) {
      return aOffset === null && bOffset === null ? a.id.localeCompare(b.id) : aOffset === null ? 1 : -1;
    }
    return aOffset - bOffset || a.id.localeCompare(b.id);
  });
  if (commentSort === "recency" && heldEditPositions?.key === activeCommentKey) {
    const slots = heldEditPositions.slots;
    const held = sortedCommentThreads.filter((thread) => slots[thread.id] !== undefined)
      .sort((a, b) => slots[a.id] - slots[b.id]);
    const free = sortedCommentThreads.filter((thread) => slots[thread.id] === undefined);
    for (const thread of held) free.splice(Math.min(slots[thread.id], free.length), 0, thread);
    sortedCommentThreads.splice(0, sortedCommentThreads.length, ...free);
  }
  const [showHiddenByOwner, setShowHiddenByOwner] = useState<Record<string, boolean>>({});
  const showHiddenComments = activeCommentKey ? showHiddenByOwner[activeCommentKey] === true : false;
  const [selectedCommentByOwner, setSelectedCommentByOwner] = useState<Record<string, string>>({});
  const selectedCommentId = activeCommentKey ? selectedCommentByOwner[activeCommentKey] ?? null : null;
  const activeCommentActivationRef = useRef({ key: activeCommentKey, generation: 0 });
  if (activeCommentActivationRef.current.key !== activeCommentKey) {
    activeCommentActivationRef.current = {
      key: activeCommentKey,
      generation: activeCommentActivationRef.current.generation + 1,
    };
  }
  const columnNavigationGenerationRef = useRef(0);
  const commentsBodyRef = useRef<HTMLDivElement>(null);
  const hiddenCommentThreads = sortedCommentThreads.filter((thread) => thread.resolved || thread.withdrawn_at != null);
  const visibleCommentThreads = showHiddenComments
    ? sortedCommentThreads
    : sortedCommentThreads.filter((thread) => !thread.resolved && thread.withdrawn_at == null);
  const visibleCommentOrder = visibleCommentThreads.map((thread) => thread.id).join("\0");
  useLayoutEffect(() => {
    const body = commentsBodyRef.current;
    if (!body || !selectedCommentId) return;
    const card = [...body.querySelectorAll<HTMLElement>("[data-card-id]")]
      .find((candidate) => candidate.dataset.cardId === selectedCommentId);
    if (!card) return;
    const bodyBox = body.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    if (cardBox.top < bodyBox.top) body.scrollTop -= bodyBox.top - cardBox.top;
    else if (cardBox.bottom > bodyBox.bottom) body.scrollTop += cardBox.bottom - bodyBox.bottom;
  }, [selectedCommentId, activeCommentKey, showHiddenComments, visibleCommentOrder]);

  function selectColumnThread(threadId: string) {
    if (!activeCommentKey) return;
    const thread = commentThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    columnNavigationGenerationRef.current += 1;
    tabbedEditorRef.current?.cancelCommentReveal();
    setSelectedCommentByOwner((current) => ({ ...current, [activeCommentKey]: threadId }));
    if (thread.resolved || thread.withdrawn_at != null) {
      setShowHiddenByOwner((current) => ({ ...current, [activeCommentKey]: true }));
    }
  }

  function activateColumnThread(thread: CommentThread) {
    selectColumnThread(thread.id);
    const ownerKey = activeCommentKey;
    const activationGeneration = activeCommentActivationRef.current.generation;
    const navigationGeneration = columnNavigationGenerationRef.current;
    void tabbedEditorRef.current?.revealCommentThread(thread).then((revealed) => {
      if (!revealed && thread.anchor && activeCommentActivationRef.current.key === ownerKey
        && activeCommentActivationRef.current.generation === activationGeneration
        && columnNavigationGenerationRef.current === navigationGeneration) {
        setUserAppStatus("This comment's passage is no longer available in the document.");
      }
    });
  }
  const [liveRunIds, setLiveRunIds] = useState<readonly string[]>([]);
  const [terminalRunIds, setTerminalRunIds] = useState<readonly string[]>([]);
  const [queuedRuns, setQueuedRuns] = useState<{ project: string; ids: readonly string[] } | null>(null);
  const queuedRunIds = queuedRuns && queuedRuns.project === project ? queuedRuns.ids : [];
  const handleQueuedRunIdsChange = useCallback((ids: readonly string[]) => {
    if (project) setQueuedRuns({ project, ids });
  }, [project]);
  // `TimelinePanel` remains the sole facet owner; this is only its binding comment-mode projection
  // into the active document's status sequence (docs/design authoring-shell 4a/4b).
  const [commentMode, setCommentMode] = useState(false);
  // P2b-7 follow-up (#492): the quote-bar's props existed end to end (`EditorShell.onQuoteSelection`,
  // `TimelinePanel.incomingQuote`, `ChatMessageCard.onFocusQuote`) but nothing in the mounted app held
  // the quote state between the two — this shell is that owner, mirroring `delivery`'s identical
  // "one subscription/state, fanned out to the surfaces that need it" role. A fresh object every time
  // `handleQuoteSelection` fires (never mutated in place) is what lets `MessageComposer`'s own
  // identity-keyed re-seed (`incomingQuote !== lastIncoming`) attach it, including a second quote taken
  // before the first was ever sent (see that component's own docs).
  const [pendingQuote, setPendingQuote] = useState<QuotedExcerpt | null>(null);

  useEffect(() => {
    let cancelled = false;
    currentProject()
      .then((root) => {
        if (cancelled) return;
        enterProjectRoot(root);
        if (root !== null) enqueueOpenRequest(root, null);
      })
      .catch((error) => {
        if (cancelled) return;
        currentProjectRoot.current = null;
        setProject(null);
        reportProjectOpenFailure(error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => subscribeWhileMounted(listenForProjectRouting, (notice, isCancelled) => {
    if (isCancelled()) return;
    const dismissed = dismissedProjectOpenInFlight.current;
    if (dismissed && notice.status === "requesting") {
      if (dismissed.requestId === notice.request_id || dismissed.retryRoot === notice.root) {
        dismissedProjectOpenInFlight.current = {
          ...dismissed,
          requestId: notice.request_id,
        };
        return;
      }
      dismissedProjectOpenInFlight.current = null;
    } else if (dismissed && notice.status === "finished"
      && (dismissed.requestId === notice.request_id || dismissed.retryRoot === notice.outcome.root)) {
      dismissedProjectOpenInFlight.current = null;
    }
    beginAppStatusRequest();
    if (notice.status === "finished") retryInFlightRoot.current = null;
    setProjectOpenStatus((current) => {
      if (
        notice.status === "requesting"
        && current?.phase === "finished"
        && current.outcome.status === "failed"
        && current.retryPending
        && current.outcome.root === notice.root
      ) {
        return current;
      }
      return reduceProjectOpenStatus(current, notice);
    });
  }), []);

  useLayoutEffect(() => {
    if (projectOpenStatus !== null || !pendingCloseRefusalFocusRecovery.current) return;
    pendingCloseRefusalFocusRecovery.current = false;
    const destinations = closeRefusalFocus.current;
    focusProjectOpenRecoveryTarget(
      destinations?.returnFocusTo,
      destinations?.fallbackFocusTarget,
    );
  }, [projectOpenStatus]);

  // One boundary for every project entry keeps all project-scoped producer queues in lockstep.
  function enterProjectRoot(root: string | null) {
    currentProjectRoot.current = root;
    if (root !== project) {
      pendingProjectFileGenerations.current = [];
      editorTabsReady.current = false;
      setIncomingCards([]);
      setPersistedIncomingCards([]);
      setSettingsOpen(false);
      setActiveDocumentSaveState(null);
      setActiveUnsupportedRecoveryTitle(null);
      setCommentMode(false);
    }
    setProject(root);
  }

  function reportProjectOpenFailure(error: unknown) {
    setUserAppStatus(formatActionFailure(errorDetail(error)));
  }

  useEffect(() => {
    // Binds the backend's project first, exactly as `openProjectRoot` does (TD-17, #472) — a D23
    // script that opens a project and then starts a run must reach a bound MCP server, not a
    // backend that never learned a project exists. A named path opens directly, while `null`
    // sends the established reset/restore request that constructs a bound workshop shell.
    testHarness.openProject = async (root, path) => {
      beginAppStatusRequest();
      try {
        await openProject(root);
      } catch (error) {
        reportProjectOpenFailure(error);
        return;
      }
      enterProjectRoot(root);
      enqueueOpenRequest(root, path);
    };
    // P2b-11b (J2): mirrors the real "Open a folder…" transition (`handleOpenFolder` below) minus
    // the unautomatable native picker — a fresh project with no restored session lands in workshop
    // mode (J2 Phase A) here exactly as it does in production. Unlike the direct D23 hook above,
    // this product path always exercises TD-20 routing and session restoration.
    testHarness.openProjectFolder = (root) => {
      beginAppStatusRequest();
      return openProjectRoot(root);
    };
    testHarness.setAutosaveIntervalMs = (ms) => setAutosaveIntervalMs(ms);
    testHarness.setExternalChangePollMs = (ms) => setExternalChangePollMs(ms);
    testHarness.setCommentNowMs = (ms) => setCommentNowMs(ms);
    testHarness.setNextSaveAsDialogResult = (path) => {
      nextSaveAsDialogResult.current = { path };
    };
    testHarness.setNextOpenDocumentDialogResult = (path) => {
      nextOpenDocumentDialogResult.current = { path };
    };
    return () => {
      testHarness.openProject = null;
      testHarness.openProjectFolder = null;
      testHarness.setAutosaveIntervalMs = null;
      testHarness.setExternalChangePollMs = null;
      testHarness.setCommentNowMs = null;
      testHarness.setNextSaveAsDialogResult = null;
      testHarness.setNextOpenDocumentDialogResult = null;
      nextSaveAsDialogResult.current = null;
      nextOpenDocumentDialogResult.current = null;
    };
  }, [project]);

  // A stable function identity for a fixed `commentNowMs` (memoized past component re-renders,
  // matching `handleStopRun`'s own reasoning elsewhere in this codebase for a callback threaded
  // into a child that might otherwise resubscribe/reseed on every parent render) — `undefined`
  // (the default, no e2e override) leaves every comment surface on its own built-in `Date.now()`.
  const commentNow = useMemo(
    () => (commentNowMs === undefined ? undefined : () => commentNowMs),
    [commentNowMs],
  );

  // Production builds pass no override. In dev, the stable callback consumes a queued D23 result
  // when present and otherwise delegates to the real panel, so ordinary `tauri dev` remains the
  // same application while Playwright can substitute the one native boundary it cannot drive.
  const pickSaveAsPathForTest = useMemo(
    () =>
      import.meta.env.DEV
        ? async (root: string, suggestedPath: string) => {
            const queued = nextSaveAsDialogResult.current;
            if (queued !== null) {
              nextSaveAsDialogResult.current = null;
              return queued.path;
            }
            return pickSaveAsPath(root, suggestedPath);
          }
        : undefined,
    [],
  );

  /**
   * The J1 Phase B pipe's shared reaction (#346) fans one delivery out to the two surfaces it shows
   * up on. `App` owns this because it is the only
   * layer that holds both — routing this through either surface alone would leave the other to
   * re-subscribe and re-parse the same delivery independently.
   *
   * The delivery is parsed **once** here (TD-11 corollary: one authoritative `parse_changes`
   * snapshot per delivery) and that one snapshot feeds both the editor's reseed and the card's
   * change list, so the redline and the card can never disagree about what landed.
   *
   * A failed parse raises neither: there is no change list to render or triage, and a card claiming
   * a revision with no changes on it would be a lie (UX Principle 7 — degrade honestly).
   */
  function handleDelivery(notice: DeliveryNotice, isCancelled: () => boolean = () => false) {
    // Joined against the delivered document's own TD-4 records (TD-16 ruling 3), so this parse
    // reports the delivery's markers under the very `chg-` ids the notice carries — which is what
    // `changeSetCardFor` selects this delivery's subset by, and what the editor's field is seeded
    // with. Without the document there would be no join, no durable ids, and no card.
    void parseChanges(project ? { root: project, path: notice.doc } : null, notice.content)
      .then((changes) => {
        if (isCancelled()) return;
        setDelivery({
          doc: notice.doc,
          content: notice.content,
          changeSetId: notice.changeSetId,
          changes,
          // The delivery's revision doubles as the tab field's UXR-Q4 parse generation — the same
          // token `changeSetCardFor` puts on the card, so the two correspond once the buffer takes
          // the delivery (and stay mismatched, fail-closed, when a dirty tab suppresses it).
          generation: notice.revision,
        });
        setIncomingCards((prev) => [...prev, changeSetCardFor(notice, changes)]);
      })
      .catch(() => {});
  }

  /**
   * The J1 Phase B pipe (#346): one subscription to the backend's landed-delivery event, reacting
   * through `handleDelivery` above.
   */
  useEffect(() => {
    if (!project) return;
    return subscribeWhileMounted(listenForDeliveries, handleDelivery);
  }, [project]);

  /**
   * The J2 birth pipe's shared reaction (#420, ux-design J2 Phase B) opens the created path as a tab through the
   * existing tab machinery (P2a-6: a fresh `request` for the *same* project just opens/focuses a
   * path, `TabbedEditor`'s own `openTab`, so a document already open stays open and the new one
   * becomes a second tab, never a replacement) and raises the document-birth card in the timeline
   * (`incomingCards`). Both reactions are plain state set from this one handler, so they land in
   * the same conceptual event without either surface remounting — `TimelinePanel` stays mounted at
   * its stable `key={project}` the whole time (D4/J2: the conversation stays the same thread); only
   * its own `cards` state grows. `root` is the project the notice belongs to (the live subscription
   * effect below closes over the `project` it subscribed under), never re-read from the `project`
   * state directly, so a project switch mid-flight can't
   * retarget an in-flight notice at the wrong project.
   */
  function handleDocumentBirth(root: string, notice: DocumentBirthNotice) {
    enqueueOpenRequest(root, notice.path);
    setIncomingCards((prev) => [...prev, documentBirthCardFor(notice)]);
  }

  /**
   * The J2 birth pipe (#420, ux-design J2 Phase B): a landed `create_document` reaches the app as
   * one notice over the real Tauri event bridge; `handleDocumentBirth` above is the reaction.
   */
  useEffect(() => {
    if (!project) return;
    return subscribeWhileMounted(listenForDocumentBirths, (notice, isCancelled) => {
      if (isCancelled()) return;
      handleDocumentBirth(project, notice);
    });
  }, [project]);

  /**
   * The `File > Open…` menu pipe (#697, FR-X-1/FR-ED-3): the native menu fire itself carries no
   * path (`src-tauri/src/menu.rs`'s `OPEN_DOCUMENT_EVENT` doc explains why), so this handler is
   * what actually raises the native file picker (`pickDocumentFile`, mirroring
   * `pickProjectFolder`'s identical Tauri-only/cancel-is-a-no-op shape) and converges the result
   * onto the *same* request queue every other open route already uses (P2a-6) — never a second
   * open path. `root` is captured from the `project` this effect closed over (not re-read from the
   * `project` state after the picker's own await), so a project switch mid-pick can't route a
   * stale pick at the wrong project's tab set — the identical reasoning `handleDocumentBirth`'s own
   * subscription effect already applies via `isCancelled`. The picker itself opens *at* `root`
   * (review of PR #718, Important) rather than wherever the OS last left the app, so the
   * out-of-root refusal below is rarely what the user actually hits.
   *
   * On the welcome screen (`project === null`, the app's default state on every fresh launch) there
   * is no project root to pick a document under, so this instead runs the same "Open a folder…"
   * transition `WelcomeScreen`'s own button already triggers (review of PR #718, Important: left
   * unhandled, Cmd/Ctrl+O on the welcome screen reached a Rust `emit` with no frontend listener at
   * all and did *nothing*, silently — the same undefined-behaviour class the out-of-root refusal
   * would have been had this card left that undecided too). This is the same convention every
   * desktop app applies to Cmd+O against an empty window; disabling the menu item instead would
   * need a new IPC surface to toggle native menu state from the frontend, which is out of scope for
   * this stopgap card.
   *
   * A path outside the open project root is refused rather than opened (`relativeToProjectRoot`
   * returns `null`): sidecar identity is project-root-relative
   * (`store::service::tracked_paths`), so a document outside the root has no sidecar to attach to.
   * Unlike cancelling the picker, that explicit choice is not a no-op: the shell explains the
   * refusal and its recovery path (FR-X-5).
   */
  // @anchor:app-open-document-request-handler
  function handleOpenDocumentRequest(_notice: undefined, isCancelled: () => boolean) {
    if (!project) {
      void handleOpenFolder();
      return;
    }
    beginAppStatusRequest();
    const root = project;
    const queued = nextOpenDocumentDialogResult.current;
    if (queued !== null) nextOpenDocumentDialogResult.current = null;
    void (
      queued === null ? pickDocumentFile(root) : Promise.resolve(queued.path)
    ).then((absolutePath) => {
      if (isCancelled() || !absolutePath) return;
      const path = relativeToProjectRoot(root, absolutePath);
      if (path === null) {
        setUserAppStatus(
          "That file is outside the open project. Open its folder as a project to edit it in Emend.",
        );
        return;
      }
      enqueueOpenRequest(root, path);
      setUserAppStatus(null);
    });
  }

  /**
   * The `File > Open…` menu pipe (#697): one subscription to the backend's menu-fired signal,
   * reacting through `handleOpenDocumentRequest` above. Unlike the delivery/birth pipes, this one
   * subscribes even on the welcome screen (`project === null`) — Cmd/Ctrl+O is live from the app's
   * very first launch, so the listener must be too (review of PR #718, Important, above); the
   * `[project]` key still re-subscribes on every project change so the handler's closure always
   * carries the current `project`, the identical reasoning `handleDocumentBirth`'s own effect uses.
   */
  useEffect(() => {
    return subscribeWhileMounted(listenForOpenDocumentRequests, handleOpenDocumentRequest);
  }, [project]);

  /** `File > Save As…` enters through the active tab's imperative handle, which delegates to the
   * same `EditorShell.saveAs()` used by Missing-on-disk recovery. No document (or an untitled
   * recovery buffer with no editor handle) is an inert request; #1379 owns that lifecycle. */
  function handleSaveDocumentAsRequest(_notice: undefined, isCancelled: () => boolean) {
    if (isCancelled()) return;
    void tabbedEditorRef.current?.saveActiveDocumentAs();
  }

  useEffect(() => {
    return subscribeWhileMounted(listenForSaveDocumentAsRequests, handleSaveDocumentAsRequest);
  }, []);

  /**
   * J8 Screen 2's project card (P2b-8b, #360, FR-SKILL-1): "Grounding is visible from minute
   * one." One `discover_grounding` call per project open — this effect's own `[project]` key is
   * what makes it one-time (the J8 acceptance's literal wording): it fires once per project open
   * and never again for the same open, so a future discovery refresh mechanism re-raises nothing.
   * Always raises a card, even for a project with zero skills and zero workflows (Principle 7:
   * "found nothing" is itself honest information — a silently omitted card would leave a
   * mis-configured repo looking identical to a well-grounded one).
   *
   * A failed call degrades to no card at all, matching this file's own precedent for a best-effort
   * background read that isn't itself the primary content of the screen (the comment-threads load
   * effect's identical "disk unavailable → nothing more to show" degrade above).
   */
  const groundingInFlight = useRef<{ root: string; promise: ReturnType<typeof discoverGrounding> } | null>(null);
  const discoverProjectGrounding = useCallback((root: string) => {
    if (groundingInFlight.current?.root === root) return groundingInFlight.current.promise;
    const promise = discoverGrounding(root);
    groundingInFlight.current = { root, promise };
    const clear = () => {
      if (groundingInFlight.current?.promise === promise) groundingInFlight.current = null;
    };
    void promise.then(clear, clear);
    return promise;
  }, []);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void discoverProjectGrounding(project)
      .then((payload) => {
        if (cancelled) return;
        setIncomingCards((prev) => [...prev, groundingCardFor(payload)]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, discoverProjectGrounding]);

  /**
   * "Opening a folder transitions into the project" (P2a-22 acceptance) — the transition itself is
   * this card's scope; restoring what was open there is P2a-6's `store::tab_session`, reused as-is.
   * A project with a restored active tab opens straight to it (authoring layout, J8 Screen 2's
   * literal branch); a fresh project (no session yet) lands in workshop mode (P2b-6b) within the
   * now-open project's chrome.
   *
   * `routeProjectOpen` is TD-20's backend-owned routing decision. Only `adopted_here` binds this
   * instance and transitions its shell; stay/focus/launch keep this choosing window exactly where
   * it was. It is awaited before an adopted shell transition, so a run cannot start against a
   * project the backend has not bound yet. Rejection or a typed failure preserves the chooser and
   * reports through the shared shell status region (D26/FR-X-5/FR-X-10).
   */
  // @anchor:test-plan-open-project-root
  async function openProjectRoot(root: string) {
    if (retryInFlightRoot.current !== root) {
      closeRefusalFocus.current = null;
      setProjectOpenStatus(null);
    }
    let outcome;
    try {
      outcome = await routeProjectOpen(root);
    } catch (error) {
      if (retryInFlightRoot.current === root) {
        retryInFlightRoot.current = null;
        if (dismissedProjectOpenInFlight.current?.retryRoot === root) {
          dismissedProjectOpenInFlight.current = null;
        }
        setProjectOpenStatus(null);
      }
      reportProjectOpenFailure(error);
      return;
    }
    if (outcome.status === "failed") return;
    if (outcome.status !== "adopted_here") return;
    // Enter through the shared project-state boundary, then let `TabbedEditor` acquire writer
    // authority and restore the session from that same begin snapshot. Reading here first would be
    // an unowned observation that can go stale before authority is granted.
    enterProjectRoot(outcome.root);
    enqueueOpenRequest(outcome.root, null);
  }

  function handleProjectOpenRetry(root: string) {
    if (retryInFlightRoot.current !== null) return;
    retryInFlightRoot.current = root;
    setProjectOpenStatus((current) => current === null ? current : markProjectOpenRetryPending(current));
    void openProjectRoot(root);
  }

  function handleRunActiveCloseRefused(refusal: RunActiveCloseRefusal) {
    if (!project) return;
    beginAppStatusRequest();
    closeRefusalFocus.current = {
      returnFocusTo: refusal.returnFocusTo,
      fallbackFocusTarget: refusal.fallbackFocusTarget,
    };
    setProjectOpenStatus({ phase: "close_blocked", root: project, runId: refusal.runId });
  }

  function handleShowRun(runId: string, landing?: TimelineRunRevealRequest["landing"]) {
    setRunRevealRequest({ runId, nonce: ++revealNonce.current, landing });
  }

  function handleWatchedRunTerminal(runId: string) {
    setProjectOpenStatus((current) => {
      if (current?.phase !== "close_blocked" || current.runId !== runId) return current;
      pendingCloseRefusalFocusRecovery.current =
        projectOpenStatusRegionRef.current?.contains(document.activeElement) ?? false;
      return null;
    });
  }

  async function handleOpenFolder() {
    beginAppStatusRequest();
    const root = await pickProjectFolder();
    if (root) await openProjectRoot(root);
  }

  // Optimistic seed for `hasOpenTabs` (P2b-6b): a new `request` — whether non-null (a tab is about
  // to open/focus) or null (a fresh project with nothing to restore) — is applied immediately so
  // the layout doesn't flash workshop-mode-without-a-placeholder for the one render between
  // "request set" and `TabbedEditor` actually processing it. `TabbedEditor.onTabsChange` (below)
  // is the only thing that can later correct this without a new `request` — closing the last tab.
  useEffect(() => {
    setHasOpenTabs(request !== null && request.path !== null);
  }, [request]);

  // #411's identical optimistic seed, one level down: a new `request` names the path about to
  // become active (or `null`, nothing to restore) immediately, so `commentThreads` starts loading
  // for it without waiting on `TabbedEditor`'s own effect to actually process the request first.
  // `TabbedEditor.onActivePathChange` (wired below) is what corrects this for a same-project tab
  // switch that mints no new `request` at all.
  useEffect(() => {
    setActiveDocumentPath(request?.path ?? null);
  }, [request]);

  useEffect(() => {
    setConfirmedActiveDocumentPath(null);
  }, [project]);

  const workshopMode = isWorkshopMode(hasOpenTabs);
  const statusRegion = projectOpenStatus ? (
    <ProjectOpenStatusRegion
      ref={projectOpenStatusRegionRef}
      platform={platform}
      status={projectOpenStatus}
      onRetry={handleProjectOpenRetry}
      onShowRun={handleShowRun}
      onDismiss={() => {
        if (projectOpenStatus.phase === "requesting") {
          dismissedProjectOpenInFlight.current = {
            requestId: projectOpenStatus.requestId,
            retryRoot: null,
          };
        } else if (projectOpenStatus.phase === "finished" && projectOpenStatus.retryPending) {
          dismissedProjectOpenInFlight.current = {
            requestId: null,
            retryRoot: projectOpenStatus.outcome.root,
          };
        }
        closeRefusalFocus.current = null;
        setProjectOpenStatus(null);
      }}
    />
  ) : appStatus ? (
    <MessageStatusRegion status={appStatus} audience="author" />
  ) : null;

  // #411: (re)loads the active document's comment threads through the existing `store::comments`
  // IPC fold whenever which document is active changes — including to `null` (no active tab), which
  // is what releases a closed/backgrounded document's threads from memory: the previous array is
  // simply replaced, never merged or kept around "just in case" a background tab needs it later
  // (nothing here does; only the active tab's threads are ever rendered, matching `onChangesDecided`'s
  // identical active-tab-only scoping in `editor/TabbedEditor.tsx`).
  //
  // The clear below runs for every `activeDocumentPath` change, not just the null case (review of
  // #498 at 79d3a5e): `commentPath` (== `activeDocumentPath`, passed to `TimelinePanel` below) always
  // advances in the same render this effect's dependency changes, but the load below is async — so
  // without this, `commentThreads` would still hold the *previous* document's array for however long
  // the new load takes, straddling two documents under one `commentPath`. Clearing synchronously
  // before kicking off the load means the header only ever pairs a document's own (possibly empty,
  // still-loading) set with its own path, never someone else's.
  useEffect(() => {
    setCommentSortOpen(false);
    setHeldEditPositions(null);
    if (!project || !activeCommentOwner || !activeCommentKey) {
      setCommentLoad(null);
      return;
    }
    setCommentLoad({ key: activeCommentKey, phase: "pending", threads: [] });
    let cancelled = false;
    const active = tabbedEditorRef.current?.openDocuments().active;
    const content = activeCommentOwner.kind === "id" && active?.path === null && active.label === activeCommentOwner.label
      ? active.content
      : undefined;
    const load = activeCommentOwner.kind === "path"
      ? loadCommentThreads(project, activeCommentOwner.path)
      : content !== undefined
        ? loadCommentThreads(project, activeCommentOwner, content)
        : Promise.reject(new Error("active untitled document content is unavailable"));
    load
      .then((threads) => {
        if (!cancelled) setCommentLoad({ key: activeCommentKey, phase: "loaded", threads });
      })
      // A failed read leaves the column header-only: it cannot claim an empty document.
      .catch(() => {
        if (!cancelled) setCommentLoad({ key: activeCommentKey, phase: "failed", threads: [] });
      });
    return () => {
      cancelled = true;
    };
    // Owner objects are freshly emitted for dirty/save tab updates; identity is the project and
    // path/UUID key. A same-owner render must not restart a read or erase fresher card state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeCommentKey]);

  /**
   * The write half of the single-owner pair (#411): `TimelinePanel`'s own `onCommentThreadsChange`
   * — a mounted `CommentCard`'s mutation, or the panel's own batch-address run — lands here, so a
   * document reopened in a fresh `TimelinePanel` (a new project, `key={project}`) rehydrates from a
   * set that actually reflects it rather than whichever snapshot this shell last loaded.
   */
  function handleCommentThreadsChange(threads: CommentThread[]) {
    if (!activeCommentKey) return;
    if (commentSort === "recency") {
      setHeldEditPositions((current) => {
        const slots = { ...(current?.key === activeCommentKey ? current.slots : {}) };
        for (const after of threads) {
          const before = commentThreads.find((candidate) => candidate.id === after.id);
          if (!before) continue;
          const edited = before.edited_at !== after.edited_at ||
            after.replies.some((reply) => {
              const prior = before.replies.find((candidate) => candidate.id === reply.id);
              return prior !== undefined && prior.edited_at !== reply.edited_at;
            });
          if (edited) {
            // Saving this card cannot move it; every unheld card keeps live Recency order.
            slots[after.id] = slots[after.id] ?? sortedCommentThreads.findIndex((thread) => thread.id === after.id);
          }
        }
        for (const id of Object.keys(slots)) {
          if (!threads.some((thread) => thread.id === id)) delete slots[id];
        }
        return Object.keys(slots).length > 0 ? { key: activeCommentKey, slots } : null;
      });
    }
    setCommentLoad((current) => current?.key === activeCommentKey
      ? { key: activeCommentKey, phase: "loaded", threads }
      : current);
  }

  /**
   * The editor-anchored comment popover's `[Address with AI]` reporting a `start_run` that rejected
   * outright (#1777). The popover sits under `TabbedEditor`/`EditorShell`, so it cannot be handed
   * `TimelinePanel`'s own fold the way a mounted `CommentCard` is — this shell is their nearest
   * common owner, and `incomingCards` is the seam it already raises every other card no producer
   * inside the panel can mint (a delivery's change-set card, a document-birth card). The card is
   * built by `failedRunStatus` — the *same* builder the panel's own two callers use, so all three
   * render one honest terminal state rather than three variations of it; that function's doc owns
   * the rest of the rationale.
   */
  function handleAddressRunFailed(root: string, error: unknown) {
    if (currentProjectRoot.current !== root) return;
    setIncomingCards((current) => [...current, createAgentWorkingCard(failedRunStatus(error))]);
  }

  function handleAddressRunStarted(root: string, run: { id: string; queuedPosition: number | null }) {
    if (currentProjectRoot.current !== root) return;
    setLiveRunIds((current) => current.includes(run.id) ? current : [...current, run.id]);
    setIncomingCards((current) => [...current, createAgentWorkingCard({
      id: run.id,
      phase: run.queuedPosition === null
        ? { phase: "running" }
        : { phase: "queued", position: run.queuedPosition },
      activity: [],
      elapsedSecs: 0,
    })]);
  }

  /**
   * What `TimelinePanel`'s submits (the composer, and a mounted `CommentCard`'s `[Address with AI]`)
   * report as FR-CHAT-4's open-document set (#1724). Routed through `TabbedEditorHandle`, the same
   * imperative seam a change-set card's triage already uses, because the tab layer owns that set —
   * this shell knows only which document is active, which is exactly the half the defect had.
   *
   * Called at each submit rather than evaluated on render: the active document's buffer changes on
   * every keystroke and a background tab's dirty flag never reaches this shell at all, so a value
   * computed here would name a set that had already moved on. `NO_OPEN_DOCUMENTS` before the editor
   * mounts — the welcome screen's own honest answer, and one the panel cannot reach anyway since it
   * has no `root` to run against there (FR-CHAT-1).
   *
   * The popover under `TabbedEditor` is deliberately *not* fed from here: it reads the identical
   * snapshot from that component directly, one prop hop away, rather than climbing to this shell and
   * back down.
   */
  const readOpenDocuments = useCallback(
    (): OpenDocumentsSnapshot => tabbedEditorRef.current?.openDocuments() ?? NO_OPEN_DOCUMENTS,
    // Reads a ref and nothing else, so this identity never needs to change — and must not, since
    // `TimelinePanel` lists it in the dependencies of the memo that keeps its card renderer stable.
    [],
  );

  /**
   * `TimelinePanel`'s `onChangeSetDecide` (#410) — a mounted `ChangeSetCard`'s own triage buttons
   * (`[Accept all]`, `[Reject all]`, per-section, the type-filtered overflow menu) call this with
   * the ids they decided; it routes them to the active tab's live document through
   * `TabbedEditorHandle.decideChanges` and hands back the full id set that document actually
   * decided (P4b's swept-in group co-members included) for the card to reconcile against — never a
   * CM6 view crossing this boundary (TD-13), only ids in and ids out.
   *
   * **Fails closed (UXR-Q4).** Since TD-16 a change-set card's ids are globally unique opaque
   * identities, so a stale card can no longer *resolve* against some other document's changes —
   * deciding it elsewhere is a no-op on ids that field never held, not a wrong-text edit in a
   * protected document. The gate stays because a silent no-op is still a lie to the user: the card
   * refuses to call this at all when its own document/parse no longer matches the live triage target
   * (it disables its controls, naming its document), and this re-check closes the window between the
   * field moving and that render — it routes a decision only when there is an active tab whose live
   * parse generation still equals the target the card was gated against (a non-`null` generation,
   * since a card only ever corresponds to a seeded field). Cross-document routing and re-focus are
   * *mechanically* safe now but remain a J# affordance question (TD-16), so a mismatch is still an
   * honest, visible refusal. Every refusal returns an explicit empty id set to the card; `undefined`
   * remains reserved for a callback that applied the requested ids but has no wider group closure
   * to report, so a no-op can never fall through to the requested ids and look decided.
   */
  function handleChangeSetDecide(ids: string[], decision: ChangeSetDecision): string[] | undefined {
    const handle = tabbedEditorRef.current;
    if (!handle || triageTarget === null || triageTarget.generation === null) return [];
    if (handle.changeGeneration() !== triageTarget.generation) return [];
    return handle.decideChanges(ids, decision) ?? [];
  }

  /**
   * `TabbedEditor`'s `onChangesDecided` (#410's editor→card direction) — fires with every id the
   * active tab's document just decided, from ANY entry point (this shell's own
   * `handleChangeSetDecide` above, or the editor's own toolbar/keyboard/popover triage alike).
   * Forwarded straight through with its source as a fresh batch; `TimelinePanel` owns turning a
   * sequence of these into the running reconciliation set every mounted change-set card reads.
   */
  function handleChangesDecided(ids: string[], source: DecisionSource) {
    setLastDecidedChanges({ ids, source });
  }

  /** Forwards one Ctrl+Z restoration batch so the timeline can subtract it from its account. */
  function handleChangesReversed(ids: string[]) {
    setLastReversedChangeIds(ids);
  }

  /**
   * `TimelinePanel`'s `onFocusQuote` (P2b-7 follow-up, #492) — a clicked quoted excerpt's deep-link
   * back into the text (UX Principle 6) reaches here, and this shell routes it to the active tab's
   * live editor through `TabbedEditorHandle.focusAnchor`, the identical ids-only-across-the-boundary
   * seam `handleChangeSetDecide` above already uses (TD-13: coordinate authority stays inside
   * `editor/`). A background tab, no tab at all, or an anchor whose text has moved on since it was
   * quoted all resolve to the same honest no-op (`focusAnchor`'s own docs) — never a wrong selection.
   */
  function handleFocusQuote(anchor: Anchor) {
    void tabbedEditorRef.current?.focusAnchor(anchor);
  }

  function handleFocusCommentChange(root: string, path: string, changeId: string): boolean {
    if (project !== root) return false;
    if (activeDocumentPath === path && confirmedActiveDocumentPath === path && triageTarget?.doc === path && triageTarget.generation !== null) {
      if (tabbedEditorRef.current?.focusChange(changeId)) return true;
      setUserAppStatus("This linked change is no longer available in the document.");
      return true;
    }
    setPendingLinkedChangeFocus({ root, path, changeId });
    if (activeDocumentPath !== path) enqueueOpenRequest(root, path);
    return true;
  }

  function handleFocusPathlessCommentChange(root: string, docId: string, changeId: string): boolean {
    if (project !== root || activeCommentOwner?.kind !== "id" || activeCommentOwner.docId !== docId) return false;
    if (tabbedEditorRef.current?.focusChange(changeId)) return true;
    setUserAppStatus("This linked change is no longer available in the document.");
    return false;
  }

  function handleFocusCommentAnchor(root: string, path: string, anchor: Anchor) {
    if (project !== root) return;
    setPendingCommentAnchorFocus({ root, path, anchor });
    if (activeDocumentPath !== path) enqueueOpenRequest(root, path);
  }

  function handleFocusPathlessCommentAnchor(root: string, docId: string, anchor: Anchor) {
    if (project !== root || activeCommentOwner?.kind !== "id" || activeCommentOwner.docId !== docId) return;
    void tabbedEditorRef.current?.focusAnchor(anchor).then((focused) => {
      if (!focused) setUserAppStatus("This comment's passage is no longer available in the document.");
    });
  }

  useEffect(() => {
    const pending = pendingCommentAnchorFocus;
    if (!pending) return;
    if (project !== pending.root) {
      setPendingCommentAnchorFocus(null);
      return;
    }
    if (activeDocumentPath !== pending.path || confirmedActiveDocumentPath !== pending.path) return;
    setPendingCommentAnchorFocus(null);
    void tabbedEditorRef.current?.focusAnchor(pending.anchor).then((focused) => {
      if (!focused) setUserAppStatus("This comment's passage is no longer available in the document.");
    });
  }, [pendingCommentAnchorFocus, project, activeDocumentPath, confirmedActiveDocumentPath]);

  useEffect(() => {
    const pending = pendingLinkedChangeFocus;
    if (!pending) return;
    if (project !== pending.root) {
      setPendingLinkedChangeFocus(null);
      return;
    }
    if (confirmedActiveDocumentPath !== pending.path || triageTarget?.doc !== pending.path || triageTarget.generation === null) return;
    setPendingLinkedChangeFocus(null);
    if (!tabbedEditorRef.current?.focusChange(pending.changeId)) {
      setUserAppStatus("This linked change is no longer available in the document.");
    }
  }, [pendingLinkedChangeFocus, project, confirmedActiveDocumentPath, triageTarget]);

  /**
   * The rail's completed generations reaching document identity (#932/#933, TD-18). `ProjectRail` is
   * the app's one consumer of project-files generations — first load, `[Refresh]`, and the automatic
   * announcement channel all land there and are deduped by generation — so this is the single route
   * from "the backend enumerated the project" to "the open tab set follows it," and a generation can
   * be applied neither twice nor not at all: its proven moves rekey the tabs, and what it does not
   * list at all is J2's Missing on disk.
   *
   * Routed through `TabbedEditorHandle`, the same imperative seam `handleChangeSetDecide` and
   * `handleFocusQuote` use, so the open-tab set stays owned by `editor/` and only snapshots cross
   * the boundary. When the editor has not mounted yet — including while `openProjectRoot` is still
   * reading the persisted session — generations wait in order rather than disappearing. Keeping
   * every generation is load-bearing because each can carry one-shot move metadata. This shell's
   * own `activeDocumentPath`/
   * `confirmedActiveDocumentPath` need no separate rekey: they are reported *up* by the tab layer
   * (`onActivePathChange`/`onConfirmedActivePathChange`), so following the move once, where the
   * tabs live, moves the rail's active marker with it — and a missing document's row is simply not
   * in the tree the rail draws, so nothing marks it active either (J2).
   */
  function handleProjectFilesGeneration(snapshot: ProjectFilesSnapshot) {
    const handle =
      request?.root === project && editorTabsReady.current ? tabbedEditorRef.current : null;
    if (handle === null) {
      pendingProjectFileGenerations.current.push(snapshot);
      return;
    }
    handle.applyCompletedGeneration(snapshot);
  }

  function handleTabsChange(hasOpenTabs: boolean) {
    setHasOpenTabs(hasOpenTabs);
  }

  function enqueueOpenRequest(root: string, path: string | null) {
    const next = { root, path, id: nextRequestId.current++ };
    setOpenRequestQueue((current) =>
      current.processing
        ? { ...current, pending: [...current.pending, next] }
        : { current: next, pending: [], processing: true },
    );
  }

  function handleOpenRequestProcessed(id: number) {
    setOpenRequestQueue((current) => {
      if (!current.processing || current.current?.id !== id) return current;
      const [next, ...pending] = current.pending;
      return next
        ? { current: next, pending, processing: true }
        : { ...current, processing: false };
    });
  }

  // The child's explicit post-restore signal is the commit point at which its requested/restored
  // set is available — mounting is too early, while `onTabsChange(false)` can mean either that
  // restore is pending or that a ready editor genuinely has no tabs. Drain every generation that
  // won the startup race in rail order; readiness then remains true across close-last so later
  // generations are consumed immediately against the empty set.
  function handleTabsReady() {
    if (request?.root !== project || tabbedEditorRef.current === null) return;
    editorTabsReady.current = true;
    const pending = pendingProjectFileGenerations.current;
    pendingProjectFileGenerations.current = [];
    for (const snapshot of pending) {
      tabbedEditorRef.current.applyCompletedGeneration(snapshot);
    }
    recoveryAttempt?.ready();
  }

  function handleRailOpen(path: string) {
    beginAppStatusRequest();
    enqueueOpenRequest(project!, path);
  }

  // `null` here means "no project document is active" — no tab at all, or a tab that is at no
  // project path (an untitled recovery document, J2/CJ 2026-08-11). The tab layer resolves which,
  // since the record carrying that fact is its own; this shell only fans the answer out.
  function handleActivePathChange(path: string | null) {
    setActiveDocumentPath(path);
    setPendingLinkedChangeFocus((pending) => pending && path !== pending.path ? null : pending);
    setPendingCommentAnchorFocus((pending) => pending && path !== pending.path ? null : pending);
  }

  if (project === undefined) {
    return <div className="app-shell" aria-busy="true" />;
  }

  if (project === null) {
    return (
      <div className="app-shell app-shell--welcome">
        <WindowChrome platform={platform} title="Emend" />
        {statusRegion}
        <WelcomeScreen onOpenFolder={handleOpenFolder} providerStatuses={providerStatuses} platform={platform} />
      </div>
    );
  }

  const batchTriggerInEditor = Boolean(activeDocumentPath && commentLoadPhase === "loaded" && canBatchAddress(commentThreads));

  return (
    <div className="app-shell">
      <WindowChrome
        platform={platform}
        title={`${platform === "win" ? "Emend — " : ""}${activeUnsupportedRecoveryTitle ?? (activeDocumentPath ?? project).split(/[\\/]/).filter(Boolean).pop() ?? "Emend"}`}
        leading={platform === "mac" ? (
          <ProjectRailToggle
            collapsed={filesRailCollapsed}
            onCollapsedChange={setFilesRailCollapsed}
          />
        ) : undefined}
        status={<EditorOnlyStatusChipView entries={providerStatuses} />}
        actions={<>
          {activeDocumentSaveState && (
            <DocumentSaveStatus
              state={activeDocumentSaveState}
              platform={platform}
              surface="title-bar"
            />
          )}
          <button
            ref={settingsTriggerRef}
            type="button"
            className="app-header__settings"
            data-platform={platform}
            onClick={(event) => {
              settingsReturnFocusRef.current = event.currentTarget;
              setSettingsEntry("general");
              setSettingsOpen(true);
            }}
          >
            Settings
          </button>
        </>}
      />
      {settingsOpen && (
        <SettingsDialog
          themeMode={mode}
          onThemeModeChange={setMode}
          returnFocusTo={settingsReturnFocusRef}
          initialSection={settingsEntry}
          onClose={() => {
            const target = settingsReturnFocusRef.current;
            if (!canRestoreSettingsFocus(target)) {
              settingsReturnFocusRef.current = settingsTriggerRef.current;
            }
            setSettingsOpen(false);
          }}
        />
      )}
      {statusRegion}
      {/*
       * P2b-6b, ux-design §4 "Workshop mode" + J2 Phase A/B: `.editor-region` and `TimelinePanel`
       * keep stable positions within `.app-body` — only the
       * `app-body--workshop` class (below) repositions/resizes them via CSS. That's what makes
       * this a *move*, not a remount: React reconciles `TimelinePanel` by its stable `key={project}`
       * at a stable position in this parent's children regardless of `workshopMode`, so the
       * transition preserves its live stream state (same thread, same cards, same scroll intent) —
       * a remount-and-refetch would violate D4's one-continuous-conversation premise. `hidden`
       * (not conditional rendering) keeps `.editor-region` structurally present too, for the same
       * reason: neither the editor nor the Timeline may remount across this transition.
       * #931 adds the project rail as the persistent third child; CSS orders it to the left.
       * UXR-Q13 adds a comments shell only while the Timeline is collapsed over a document.
       */}
      <VoiceSettingsOpenContext.Provider value={openVoiceSettings}>
      <div className={`app-body${workshopMode ? " app-body--workshop" : ""}`}>
        <main className="editor-region" aria-label="Editor" hidden={workshopMode}>
          {/*
           * `commentThreads`/`onCommentThreadsChanged` (#411, TD-15) — the other half of this
           * shell's single-owner pair, reaching the editor-anchored comment popover (#495)
           * `TabbedEditor` forwards straight to the *active* tab's `EditorShell` and no other
           * (mirrors `onChangesDecided`'s identical active-tab-only scoping just above it): a
           * comment created/mutated in the editor now bubbles into the same `commentThreads` state
           * `TimelinePanel` below reads, and an owner-loaded thread now highlights in the editor
           * that opened it, closing the gap #495 named this card to reconcile.
           */}
          {request && (
            <TabbedEditor
              ref={tabbedEditorRef}
              request={request}
              platform={platform}
              timelineReturn={timelineCollapsed ? {
                pending: timelinePermissionPending,
                onActivate: (_origin, input) => {
                  setTimelineCollapsed(false);
                  if (timelinePermissionPending || input === "keyboard") {
                    railReturnNonce.current += 1;
                    const request = { project, nonce: railReturnNonce.current };
                    if (timelinePermissionPending) setPermissionAttentionRequest(request);
                    else setFocusComposerRequest(request);
                  }
                },
              } : undefined}
              batchAddressControl={batchTriggerInEditor ? (
                <BatchAddressTrigger
                  key={JSON.stringify([project, activeDocumentPath])}
                  floatingPanel
                  threads={commentThreads}
                  filter={batchAddressFilter}
                  onFilterChange={setBatchAddressFilter}
                  includedHeldKey={batchIncludedHeldKey}
                  onIncludedHeldKeyChange={setBatchIncludedHeldKey}
                  liveRunIds={liveRunIds}
                  terminalRunIds={terminalRunIds}
                  onAddressAll={(threadIds, includeHeldThreadIds) => batchAddressAction.current?.(threadIds, includeHeldThreadIds)}
                  running={batchAddressRunning}
                />
              ) : undefined}
              providerStatuses={providerStatuses}
              commentMode={commentMode}
              onRequestProcessed={handleOpenRequestProcessed}
              // @anchor:app-on-error-prop
              onError={(error) => setUserAppStatus(
                formatDocumentActionFailure(error),
                error instanceof UnsupportedRestoreRefusalError
                  ? { kind: "unsupported-restore-refusal", path: error.path, outcome: error.outcome }
                  : undefined,
              )}
              onRunActiveCloseRefused={handleRunActiveCloseRefused}
              onPersistedTimelineCards={(cards) =>
                setPersistedIncomingCards((current) => [...current, ...cards])
              }
              autosaveIntervalMs={autosaveIntervalMs}
              revealMarkupAtCursor={settings.reveal_markup_at_cursor}
              externalChangePollMs={externalChangePollMs}
              pickSaveAsPath={pickSaveAsPathForTest}
              onTabsChange={handleTabsChange}
              onTabsReady={handleTabsReady}
              onChangesDecided={handleChangesDecided}
              onChangesReversed={handleChangesReversed}
              onQuoteSelection={setPendingQuote}
              onTriageTargetChange={setTriageTarget}
              delivery={delivery ?? undefined}
              onActivePathChange={handleActivePathChange}
              onActiveUnsupportedRecoveryTitleChange={setActiveUnsupportedRecoveryTitle}
              onActiveCommentOwnerChange={setActiveCommentOwner}
              onActiveSaveStateChange={setActiveDocumentSaveState}
              onConfirmedActivePathChange={setConfirmedActiveDocumentPath}
              commentThreads={commentThreads}
              onColumnThreadSelected={timelineCollapsed ? selectColumnThread : undefined}
              managedCommentLoading
              liveRunIds={liveRunIds}
              queuedRunIds={queuedRunIds}
              terminalRunIds={terminalRunIds}
              onCommentThreadsChanged={handleCommentThreadsChange}
              onAddressRunFailed={handleAddressRunFailed}
              onAddressRunStarted={handleAddressRunStarted}
              onCommentRunLink={recordCommentRunLink}
              commentNow={commentNow}
            />
          )}
        </main>
        {/*
         * The right rail in authoring mode, centre-stage in workshop mode (#409, #357;
         * ux-design §4 "Right rail — timeline" / "Workshop mode"): only the props `TimelinePanel`
         * already declares and this shell can already supply are threaded through:
         *   - `root`: the open project, so chat cards rehydrate/persist through the existing
         *     per-project transcript store (P2a-17, D15).
         *   - `onChangeSetDecide`/`decidedChangeIds` (#410): routes a mounted `ChangeSetCard`'s
         *     triage into the active tab's live document through `TabbedEditorHandle.decideChanges`
         *     (card→editor) and forwards every id the editor decides, from any entry point, back
         *     down for `TimelinePanel` to reconcile every change-set card's own counts against
         *     (editor→card) — see `handleChangeSetDecide`/`handleChangesDecided` above.
         *   - `commentThreads`/`commentPath`/`onCommentThreadsChange` (#411, J4's batch entry
         *     point): this shell is the single owner of the active document's comment-thread state
         *     — `commentThreads` is loaded from `store::comments` via the effect above whenever
         *     `activeDocumentPath` changes, `commentPath` names which document it belongs to, and
         *     `onCommentThreadsChange` receives a mounted `CommentCard`'s (or the panel's own batch
         *     run's) updated set back. See `timeline/TimelinePanel.tsx`'s own module doc for why
         *     this prop pair (not a separate global store) is the chosen design.
         *   - `incomingQuote`/`onFocusQuote` (P2b-7 follow-up, #492): both halves of the quote-bar's
         *     round trip, threaded through this shell for the first time — `pendingQuote` (set by
         *     `TabbedEditor`'s `onQuoteSelection` above) attaches to the composer as a dismissible
         *     quote, and a click on a sent message's own quoted excerpt reaches `handleFocusQuote`,
         *     which routes it back into the active tab's editor. Every unit either side of this
         *     shell (`EditorShell`, `TimelinePanel`, `ChatMessageCard`) already existed and was
         *     already tested (#446/#358) — this is only the missing wire between them.
         *
         * `key={project}`: forces a fresh `TimelinePanel` (and its rehydrate effect) on every
         * project switch. Without it the panel stays mounted across a `setProject` change and its
         * rehydrate effect prepends the newly-opened project's history onto state still holding the
         * previous project's cards — a display-layer bleed across the D15 per-project boundary that
         * `TimelinePanel`'s own effect comment assumes away ("a project reopen mounts a fresh panel
         * with its own `root`"). Remounting on `project` is what makes that premise true; it is
         * deliberately the *only* thing that remounts this panel — `workshopMode` never does. It is
         * also what resets `TimelinePanel`'s own `decidedChangeIds` accumulation on a project
         * switch, so this shell needs no second reset path for it to keep in lockstep (see that
         * prop's docs).
         */}
        <TimelinePanel
          key={`timeline:${project}`}
          platform={platform}
          collapsed={timelineCollapsed}
          workshopMode={workshopMode}
          onCollapse={() => setTimelineCollapsed(true)}
          focusComposerRequest={focusComposerRequest?.project === project ? focusComposerRequest.nonce : 0}
          onFocusComposerRequestConsumed={(nonce) => {
            setFocusComposerRequest((current) => current?.project === project && current.nonce === nonce ? null : current);
          }}
          onPendingPermissionChange={handleTimelinePermissionPendingChange}
          permissionAttentionRequest={permissionAttentionRequest?.project === project ? permissionAttentionRequest.nonce : 0}
          onPermissionAttentionRequestConsumed={(nonce) => {
            setPermissionAttentionRequest((current) => current?.project === project && current.nonce === nonce ? null : current);
          }}
          root={project}
          permissionProjectFocusRestore={
            permissionNavigationFocus.current && permissionNavigationFocus.current.project !== project
              ? { target: permissionNavigationFocus.current.target }
              : undefined
          }
          onPermissionNavigationActivate={(target) => {
            permissionNavigationFocus.current = { project, target };
          }}
          onPermissionProjectFocusRestored={() => {
            permissionNavigationFocus.current = null;
          }}
          operationTargets={activeDocumentPath ? [activeDocumentPath] : []}
          openDocuments={readOpenDocuments}
          onCommentRunLink={recordCommentRunLink}
          onChangeSetDecide={handleChangeSetDecide}
          decidedChangeIds={lastDecidedChanges.ids}
          decidedChangeSource={lastDecidedChanges.source}
          reversedChangeIds={lastReversedChangeIds}
          triageTarget={triageTarget}
          incomingQuote={pendingQuote}
          onFocusQuote={handleFocusQuote}
          onFocusCommentAnchor={handleFocusCommentAnchor}
          onFocusPathlessCommentAnchor={handleFocusPathlessCommentAnchor}
          onFocusCommentChange={handleFocusCommentChange}
          onFocusPathlessCommentChange={handleFocusPathlessCommentChange}
          incomingCards={incomingCards}
          persistedIncomingCards={persistedIncomingCards}
          commentThreads={commentThreads}
          commentPath={activeDocumentPath ?? undefined}
          commentOwner={activeCommentOwner ?? undefined}
          onCommentThreadsChange={handleCommentThreadsChange}
          commentNow={commentNow}
          onCommentModeChange={setCommentMode}
          onRegisterBatchAddress={(action) => { batchAddressAction.current = action; }}
          onBatchAddressRunningChange={setBatchAddressRunning}
          onBatchRunAccepted={(runId) => {
            setTimelineCollapsed(false);
            handleShowRun(runId, "submitted-turn");
          }}
          onBatchAddressFailed={(detail) => {
            if (timelineCollapsed) setUserAppStatus(detail);
          }}
          batchAddressInEditor={batchTriggerInEditor}
          onLiveRunIdsChange={setLiveRunIds}
          onQueuedRunIdsChange={handleQueuedRunIdsChange}
          onTerminalRunIdsChange={setTerminalRunIds}
          runRevealRequest={runRevealRequest}
          onRunRevealConsumed={(nonce) => {
            setRunRevealRequest((current) => current?.nonce === nonce ? undefined : current);
          }}
          watchedRunId={projectOpenStatus?.phase === "close_blocked" ? projectOpenStatus.runId : undefined}
          onWatchedRunTerminal={handleWatchedRunTerminal}
        />
        <ProjectRail
          key={`project-files:${project}`}
          projectName={project.split(/[\\/]/).filter(Boolean).pop() ?? project}
          projectRoot={project}
          discover={discoverProjectGrounding}
          activePath={confirmedActiveDocumentPath}
          onOpen={handleRailOpen}
          onGeneration={handleProjectFilesGeneration}
          platform={platform}
          collapsed={filesRailCollapsed}
          onCollapsedChange={setFilesRailCollapsed}
        />
        {timelineCollapsed && !workshopMode && (
          <section className="comments-column" aria-label="Comments" data-platform={platform}>
            <header className="comments-column__header">
              <h2>COMMENTS{commentLoadPhase === "loaded" && commentCounts(commentThreads).open > 0
                ? ` · ${commentCounts(commentThreads).open} OPEN`
                : ""}</h2>
              {commentLoadPhase === "loaded" && commentThreads.length > 0 && (
                <div className="comments-column__sort">
                  <button type="button" aria-label={commentSort === "position" ? "Position" : "Recency"}
                    aria-haspopup="menu" aria-expanded={commentSortOpen}
                    onClick={() => setCommentSortOpen((open) => !open)}>
                    {commentSort === "position" ? "Position" : "Recency"} ▾
                  </button>
                  {commentSortOpen && <div role="menu" aria-label="Sort comments">
                    {(["position", "recency"] as const).map((sort) => <button
                      key={sort} type="button" role="menuitem"
                      onClick={() => {
                        if (activeCommentKey) setCommentSortByOwner((current) => ({ ...current, [activeCommentKey]: sort }));
                        setHeldEditPositions(null);
                        setCommentSortOpen(false);
                      }}>
                      {sort === "position" ? "Position" : "Recency"}
                    </button>)}
                  </div>}
                </div>
              )}
            </header>
            {commentLoadPhase === "loaded" && commentThreads.length === 0 && (
              <p className="comments-column__empty">No comments in this document</p>
            )}
            {commentLoadPhase === "loaded" && commentThreads.length > 0 && activeCommentOwner && project && (
              <div className="comments-column__body" ref={commentsBodyRef}>
                {visibleCommentThreads.map((thread, index) => (
                  <CommentCard
                    key={thread.id}
                    card={{
                      id: `column-comment-${thread.id}`,
                      kind: "comment",
                      timestamp: "",
                      root: project,
                      path: activeCommentOwner.kind === "path" ? activeCommentOwner.path : activeCommentOwner.label,
                      docId: activeCommentOwner.kind === "id" ? activeCommentOwner.docId : undefined,
                      thread,
                    }}
                    threads={commentThreads}
                    onThreadsChange={handleCommentThreadsChange}
                    openDocuments={readOpenDocuments}
                    now={commentNow}
                    liveRunIds={liveRunIds}
                    queuedRunIds={queuedRunIds}
                    terminalRunIds={terminalRunIds}
                    onAddressRunFailed={handleAddressRunFailed}
                    onAddressRunStarted={handleAddressRunStarted}
                    runLink={activeCommentKey ? commentRunLinks[activeCommentKey]?.[thread.id] : undefined}
                    onRunLink={(link) => {
                      if (project && activeCommentOwner) recordCommentRunLink(project, activeCommentOwner, thread.id, link);
                    }}
                    onShowRun={(runId) => {
                      setTimelineCollapsed(false);
                      handleShowRun(runId);
                    }}
                    onActivate={() => activateColumnThread(thread)}
                    activationLabel={`Select comment thread ${index + 1} of ${visibleCommentThreads.length}`}
                    selected={selectedCommentId === thread.id}
                    onFocusAnchor={() => activateColumnThread(thread)}
                  />
                ))}
                {hiddenCommentThreads.length > 0 && <button
                  type="button"
                  className="comments-column__hidden"
                  aria-expanded={showHiddenComments}
                  onClick={() => {
                    if (activeCommentKey) setShowHiddenByOwner((current) => ({
                      ...current, [activeCommentKey]: !showHiddenComments,
                    }));
                  }}>
                  {hiddenCommentThreads.length} {hiddenCommentThreads.some((thread) => thread.withdrawn_at != null)
                    ? "hidden threads"
                    : "resolved threads hidden"}
                </button>}
              </div>
            )}
          </section>
        )}
      </div>
      </VoiceSettingsOpenContext.Provider>
    </div>
  );
}

function App({
  platform = isMac ? "mac" : "win",
}: {
  platform?: DocumentStatusBarPlatform;
} = {}) {
  const recoveryAttempt = useRenderRecoveryAttempt();
  const [workspaceMode, setWorkspaceMode] = useState<"author" | "reviewer">("author");
  const appStatus = useSyncExternalStore(subscribeAppStatus, getAppStatus, getAppStatus);

  useEffect(() => {
    setAppStatusAudience(workspaceMode);
    if (workspaceMode === "reviewer") {
      recoveryAttempt?.registry.patch(recoveryAttempt.token, { selector: "reviewer" });
      recoveryAttempt?.ready();
    }
  }, [workspaceMode, recoveryAttempt]);

  useEffect(() => {
    testHarness.showReviewerWorkspace = () => {
      setAppStatusAudience("reviewer");
      setWorkspaceMode("reviewer");
    };
    return () => {
      testHarness.showReviewerWorkspace = null;
    };
  }, []);

  if (workspaceMode === "reviewer") {
    return (
      <div className="app-shell" data-workspace-mode="reviewer">
        {appStatus && <MessageStatusRegion status={appStatus} audience="reviewer" />}
        <main aria-label="Reviewer workspace" />
      </div>
    );
  }

  return <AuthorWorkspace platform={platform} appStatus={appStatus} />;
}

export default App;
