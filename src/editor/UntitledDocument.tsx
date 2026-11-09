// ABOUTME: The untitled document pane (D12, FR-ED-8, #1379) — an editable buffer with no project
// ABOUTME: file behind it, whose only route into the project is an explicit `[Save As…]`.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorView } from "@codemirror/view";
import { errorDetail, formatActionFailure } from "../backend";
import { DocumentSurface, type DocumentSurfaceHandle } from "./DocumentSurface";
import { commentCounts, type Anchor, type CommentThread } from "../comments/types";
import { KEYMAP } from "./keymap";
import { CommentPopover, type CommentPopoverTarget } from "./CommentPopover";
import { commentAnchors, setSelectedCommentThread } from "./commentHighlights";
import type { SelectionSnapshot } from "./selectionWatcher";
import type { OpenDocumentsSnapshot } from "../timeline/referenceData";
import { loadCommentThreads } from "../comments/ipc";
import type { EditorShellHandle } from "./EditorShell";
import { DEFAULT_SETTINGS, getSettings, type AutosaveSettings } from "../settings";
import {
  changeGeneration,
  decisionGroupClosure,
  decisionsTransaction,
  focusTrackedChange,
  type Decision,
  type ParsedChange,
} from "./trackedChanges";
import { applyAgentDelivery } from "./delivery";
import {
  hasNonLfLineEndings,
  normalizeContentLineEndings,
  serializeDocumentState,
} from "./document";
import {
  openDocument,
  recreateMissingDocument,
  recreateMissingDocumentCapability,
} from "./ipc";
import { focusAnchorInEditor, revealCommentThreadInEditor } from "./focusAnchor";
import {
  createAutosaveScheduler,
  createSaveRunner,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  type AutosaveScheduler,
  type SaveRunner,
} from "./autosave";
import {
  createExternalChangePoller,
  DEFAULT_EXTERNAL_CHANGE_POLL_MS,
  isExternallyChanged,
  type ExternalChangePoller,
} from "./externalChange";
import { CrlfBanner } from "./CrlfBanner";
import { ExternalChangeBanner, type ExternalChangeBannerState } from "./ExternalChangeBanner";
import { ExternalChangeCompare } from "./ExternalChangeCompare";
import {
  MissingOnDiskBanner,
  type MissingRecoveryFailure,
} from "./MissingOnDiskBanner";
import {
  DocumentSaveStatus,
  documentSaveStatusOverflowEntry,
  type DocumentSaveState,
} from "./DocumentSaveStatus";
import type { ProviderStatuses } from "../onboarding/types";
import { agentConnectionStatusItem } from "./DocumentStatusItems";

export interface UntitledDocumentProps {
  timelineReturn?: import("./ViewModeToolbar").TimelineReturnControl;
  /** The project path this buffer used to be saved as, before it became untitled (J2, #932). */
  displacedPath: string;
  /** The buffer's current text — controlled, so `TabbedEditor` owns what gets persisted/saved. */
  content: string;
  /** Fires on every edit; the owner is the source of truth for what this buffer now holds. */
  onChange: (content: string) => void;
  /** `[Save As…]` — opens the native save panel and, on a chosen path, writes and adopts this
   * buffer into the project (D12, FR-ED-8). The owner runs the whole flow; this pane only asks. */
  onSaveAs: () => void;
  /** Fires when the buffer loses focus — the owner's cue to flush any debounced session write
   * immediately (FR-X-4), so navigating away never leaves an edit sitting in the debounce window. */
  onBlur?: () => void;
  /** True while a chosen Save As destination is being written — disables the button so a second
   * click cannot start a second write racing the first. */
  saving?: boolean;
  /** The last Save As attempt's failure detail, or `undefined`/`null` when the last attempt (if
   * any) did not fail. The buffer and this pane are otherwise untouched by a failure — same
   * "changed nothing" guarantee an ordinary Save As gives (ux-design J2). */
  saveError?: string | null;
  /** The current buffer exceeds the per-tab session cap but is still present in this process. */
  liveOverCap?: boolean;
  recoveryContentOmitted?: boolean;
  /** The former project path was refused by D27's document-type gate. */
  unsupportedSource?: boolean;
  lossNoticeCollapsed?: boolean;
  onRecoveryNoticeCollapsedChange?: (collapsed: boolean) => void;
  /** Pathless anchor projection, owned by the checkpointed UUID until Save As adoption. */
  commentProjection?: { revision: string; threads: readonly CommentThread[] };
  /** Binding comment-status mode, effective only after this retained surface has a project path. */
  commentMode?: boolean;
  onCommentThreadSelected?: (threadId: string) => void;
  onColumnThreadSelected?: (threadId: string) => void;
  /**
   * Fired when the author takes the selection popover's quote affordance on a non-empty selection
   * (FR-CHAT-3, D33, J12 Phase E — "`Quote to chat` is admitted"). Forwarded straight to
   * `DocumentSurface.onQuoteSelection`, which is what makes `QuoteAffordance` render at all — omitted
   * here means no destination and this pane's own selection popover renders no quote button, matching
   * `EditorShell`'s identical "no dead UI" convention. The owner (`TabbedEditor`) resolves this tab's
   * D33 identity (`document_path: null` plus its tab-strip label, via `quotedExcerptFor`) before
   * forwarding the quote onward — this pane knows only the raw `{ text, anchor }` capture, the same
   * boundary `EditorShell.onQuoteSelection` already draws (#2304 item 4, unblocked by #2342).
   */
  onQuoteSelection?: (quote: { text: string; anchor: Anchor }) => void;
  /** Backend-minted identity; comment persistence stays structurally absent until it is durable. */
  docId?: string;
  root?: string;
  onCommentThreadsChanged?: (threads: CommentThread[]) => void;
  /** Standalone panes load comments after identity checkpoint; App-owned panes use the active owner loader. */
  loadCommentsOnMount?: boolean;
  commentNow?: () => number;
  openDocuments?: () => OpenDocumentsSnapshot;
  /** Set after Save As lands; the same mounted surface becomes file-backed without a remount. */
  adoptedPath?: string;
  /** Exact bytes/revision landed by adoption; the retained surface starts ordinary lifecycle here. */
  adoptedBaseline?: { content: string; diskContent?: string; revision: string };
  onSaveAdopted?: (content: string, normalizeLineEndings: boolean) => Promise<string | boolean>;
  onAdoptedSaved?: (content: string, diskContent: string, revision: string) => void;
  onSaveAsAdopted?: (content: string, normalizeLineEndings: boolean) => Promise<boolean>;
  autosaveIntervalMs?: number;
  /** App-global reveal preference, applied without remounting the pathless document (TD-26). */
  revealMarkupAtCursor?: boolean;
  externalChangePollMs?: number;
  missing?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveStateChange?: (state: DocumentSaveState | null) => void;
  onExternalChangeSaveBlocked?: () => void;
  onRequestClose?: () => void;
  onMissingResolved?: () => void;
  onError?: (error: unknown) => void;
  provenancePending?: boolean;
  platform?: "win" | "mac";
  /** The app-owned provider probe rendered as FR-X-5's truthful connection status. */
  providerStatuses?: ProviderStatuses;
}

/**
 * An untitled document may hold a buffer displaced by an externally moved document (#932), or a
 * retained legacy buffer whose former path D27 no longer supports (#2515). In both cases this
 * buffer has no current project path; the former path is a label, never a save target.
 * #1379 is what makes that buffer more than a dead end: it can be edited here, and `[Save As…]`
 * carries it plus the comments/tracked changes owned by its checkpointed UUID (FR-ED-8/#1803)
 * into the project at a path the author chooses.
 *
 * There is no autosave here by construction, not as a missing feature: autosave (FR-ED-2) writes to
 * a known project path, and this buffer has none yet. Every edit stays in memory and — debounced,
 * not on every keystroke (FR-X-4) — in the session snapshot (`stores/tabs.ts`'s `toSessionPayload`),
 * until `[Save As…]` gives it a real path.
 *
 * TD-24 gives this pane the same path-free CM6 surface as a file-backed document. Disk machinery is
 * absent rather than guarded: this wrapper supplies only its controlled session buffer and blur
 * flush, while `[Save As…]` remains the owner's explicit adoption route.
 */
export const UntitledDocument = forwardRef<EditorShellHandle, UntitledDocumentProps>(function UntitledDocument({
  timelineReturn,
  displacedPath,
  content,
  onChange,
  onSaveAs,
  onBlur,
  saving = false,
  saveError = null,
  liveOverCap = false,
  recoveryContentOmitted = false,
  unsupportedSource = false,
  lossNoticeCollapsed = false,
  onRecoveryNoticeCollapsedChange,
  commentProjection,
  commentMode = false,
  onCommentThreadSelected,
  onColumnThreadSelected,
  onQuoteSelection,
  docId,
  root,
  onCommentThreadsChanged,
  loadCommentsOnMount = true,
  commentNow,
  openDocuments,
  adoptedPath,
  adoptedBaseline,
  onSaveAdopted,
  onAdoptedSaved,
  onSaveAsAdopted,
  autosaveIntervalMs,
  revealMarkupAtCursor = false,
  externalChangePollMs,
  missing = false,
  onDirtyChange,
  onSaveStateChange,
  onExternalChangeSaveBlocked,
  onRequestClose,
  onMissingResolved,
  onError,
  provenancePending = false,
  platform = "win",
  providerStatuses = null,
}: UntitledDocumentProps, ref) {
  const surfaceRef = useRef<DocumentSurfaceHandle>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverTarget | null>(null);
  const commentThreads = commentProjection?.threads ?? [];
  const commentThreadsRef = useRef(commentThreads);
  commentThreadsRef.current = commentThreads;
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onSaveAsRef = useRef(onSaveAs);
  const onSaveAdoptedRef = useRef(onSaveAdopted);
  const onAdoptedSavedRef = useRef(onAdoptedSaved);
  const onSaveAsAdoptedRef = useRef(onSaveAsAdopted);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onExternalChangeSaveBlockedRef = useRef(onExternalChangeSaveBlocked);
  const onErrorRef = useRef(onError);
  const onCommentThreadSelectedRef = useRef(onCommentThreadSelected);
  const onColumnThreadSelectedRef = useRef(onColumnThreadSelected);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;
  onSaveAsRef.current = onSaveAs;
  onSaveAdoptedRef.current = onSaveAdopted;
  onAdoptedSavedRef.current = onAdoptedSaved;
  onSaveAsAdoptedRef.current = onSaveAsAdopted;
  onDirtyChangeRef.current = onDirtyChange;
  onSaveStateChangeRef.current = onSaveStateChange;
  onExternalChangeSaveBlockedRef.current = onExternalChangeSaveBlocked;
  onErrorRef.current = onError;
  onCommentThreadSelectedRef.current = onCommentThreadSelected;
  onColumnThreadSelectedRef.current = onColumnThreadSelected;
  const missingRef = useRef(missing);
  missingRef.current = missing;
  const externalChangeRef = useRef<{ diskContent: string; diskRevision: string } | null>(null);
  const savedContentRef = useRef("");
  const diskContentRef = useRef("");
  const normalizeLineEndingsRef = useRef(true);
  const saveRunnerRef = useRef<SaveRunner | null>(null);
  const autosaveSchedulerRef = useRef<AutosaveScheduler | null>(null);
  const retiredForMoveRef = useRef(false);
  const autosaveSettingsRef = useRef<AutosaveSettings>({
    enabled: true,
    interval_ms: autosaveIntervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS,
  });
  const autosaveSettingsExplicitRef = useRef(false);
  const lifecyclePathRef = useRef<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [crlfBannerOpen, setCrlfBannerOpen] = useState(false);
  const [externalChange, setExternalChange] = useState<{
    diskContent: string;
    diskRevision: string;
  } | null>(null);
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
  const saveAuthorizationEpochRef = useRef(0);
  const dismissedDiskContentRef = useRef<string | null>(null);
  const ownPublicationRef = useRef<string | null>(null);
  const lastSaveErrorRef = useRef<unknown>(null);
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [missingBannerOpen, setMissingBannerOpen] = useState(true);
  const [recreateCapable, setRecreateCapable] = useState(false);
  const [recoveryFailure, setRecoveryFailure] = useState<MissingRecoveryFailure | null>(null);
  const [unsupportedNoticeHidden, setUnsupportedNoticeHidden] = useState(false);

  const publishDirty = (dirty: boolean) => {
    if (isDirtyRef.current === dirty) return;
    isDirtyRef.current = dirty;
    setIsDirty(dirty);
    onDirtyChangeRef.current?.(dirty);
  };

  const saveCurrent = async (): Promise<boolean> => {
    if (
      retiredForMoveRef.current
      ||
      !lifecyclePathRef.current
      || missingRef.current
      || externalChangeRef.current
      || recoveryPhaseRef.current
      || !viewRef.current
    ) {
      if (externalChangeRef.current) {
        setSaveBlocked(true);
        onExternalChangeSaveBlockedRef.current?.();
      }
      return false;
    }
    autosaveSchedulerRef.current?.cancel();
    return await (saveRunnerRef.current?.(serializeDocumentState(viewRef.current.state))
      ?? Promise.resolve(false));
  };
  const saveAsCurrent = async (): Promise<boolean> => {
    if (retiredForMoveRef.current) return false;
    if (!viewRef.current || !onSaveAsAdoptedRef.current) {
      onSaveAsRef.current();
      return false;
    }
    autosaveSchedulerRef.current?.cancel();
    return await onSaveAsAdoptedRef.current(
      serializeDocumentState(viewRef.current.state),
      normalizeLineEndingsRef.current,
    );
  };
  const placeholder =
    recoveryContentOmitted && content.length === 0
      ? "Nothing was recovered into this document — you can start writing here."
      : undefined;

  useEffect(() => {
    surfaceRef.current?.mount({
      content,
      revealMarkupAtCursor,
      parseDocument: docId && root ? { root, docId } : null,
      parseGeneration: null,
      keyBindings: [
        {
          key: KEYMAP.save.spec,
          preventDefault: true,
          run: () => {
            if (onSaveAdoptedRef.current) void saveCurrent();
            else onSaveAsRef.current();
            return true;
          },
        },
      ],
      onDocumentChange: (next) => {
        onChangeRef.current(next);
        if (retiredForMoveRef.current || !lifecyclePathRef.current) return;
        publishDirty(next !== savedContentRef.current);
        if (autosaveSettingsRef.current.enabled) autosaveSchedulerRef.current?.schedule();
      },
      onBlur: () => {
        if (!retiredForMoveRef.current && lifecyclePathRef.current) autosaveSchedulerRef.current?.flush();
        onBlurRef.current?.();
      },
      ariaLabel: "Untitled document text",
      placeholderText: placeholder,
      onCommentThreadSelected: (threadId) => {
        const thread = commentThreadsRef.current.find((candidate) => candidate.id === threadId);
        if (onColumnThreadSelectedRef.current) {
          setCommentPopover(null);
          onColumnThreadSelectedRef.current(threadId);
          return;
        }
        if (thread) setCommentPopover({ kind: "view", thread });
        onCommentThreadSelectedRef.current?.(threadId);
      },
      commentProjection: commentProjection
        ? { ...commentProjection, sourceText: content }
        : undefined,
      onParseError: (error) => onErrorRef.current?.(error),
    });
    return () => surfaceRef.current?.destroy();
    // One mount per tab. The controlled owner value is reconciled by the effect below without
    // replacing the EditorView, caret, or undo history (TD-24/J12).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    surfaceRef.current?.setRevealMarkupAtCursor(revealMarkupAtCursor);
  }, [revealMarkupAtCursor]);

  useEffect(() => {
    if (root && (adoptedPath || docId)) {
      surfaceRef.current?.setParseDocument(
        adoptedPath ? { root, path: adoptedPath } : { root, docId: docId! },
        adoptedPath ? adoptedBaseline?.revision ?? null : null,
      );
    }
    if (loadCommentsOnMount && docId && root && !adoptedPath) {
      const owner = { kind: "id" as const, docId, label: `Untitled — recovered from ${displacedPath}` };
      void loadCommentThreads(root, owner, viewRef.current?.state.doc.toString() ?? content)
        .then((threads) => onCommentThreadsChanged?.(threads))
        .catch(() => {});
    }
    // Identity is published only after its session checkpoint; this is the first sidecar read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, root, adoptedPath, adoptedBaseline?.revision]);

  useEffect(() => {
    if (!root || !adoptedPath || !adoptedBaseline || lifecyclePathRef.current === adoptedPath) return;
    lifecyclePathRef.current = adoptedPath;
    retiredForMoveRef.current = false;
    savedContentRef.current = adoptedBaseline.content;
    diskContentRef.current = adoptedBaseline.diskContent ?? adoptedBaseline.content;
    normalizeLineEndingsRef.current = true;
    const dirty = viewRef.current
      ? serializeDocumentState(viewRef.current.state) !== adoptedBaseline.content
      : content !== adoptedBaseline.content;
    publishDirty(dirty);
    setLastSavedAt(Date.now());
    setCrlfBannerOpen(hasNonLfLineEndings(adoptedBaseline.content));
    setRecoveryPhase(null);
    dismissedDiskContentRef.current = null;
    ownPublicationRef.current = null;

    saveRunnerRef.current = createSaveRunner(async (nextContent) => {
      if (retiredForMoveRef.current || missingRef.current || externalChangeRef.current) return false;
      const issuedEpoch = saveAuthorizationEpochRef.current;
      const normalize = normalizeLineEndingsRef.current;
      const written = normalize ? normalizeContentLineEndings(nextContent) : nextContent;
      ownPublicationRef.current = written;
      let saved: string | boolean = false;
      try {
        saved = await onSaveAdoptedRef.current?.(nextContent, normalize) ?? false;
      } catch (error: unknown) {
        lastSaveErrorRef.current = error;
        throw error;
      } finally {
        if (ownPublicationRef.current === written) ownPublicationRef.current = null;
      }
      if (
        !saved || missingRef.current || retiredForMoveRef.current
        || lifecyclePathRef.current !== adoptedPath
      ) return false;
      // The write really landed even when a newer disk revision won the UI race. Record only that
      // disk observation here; the live buffer may be declared saved solely if its authorization
      // epoch still owns the document's unresolved external-change episode.
      diskContentRef.current = written;
      if (issuedEpoch !== saveAuthorizationEpochRef.current || externalChangeRef.current) return false;
      savedContentRef.current = nextContent;
      onAdoptedSavedRef.current?.(
        nextContent,
        written,
        typeof saved === "string" ? saved : adoptedBaseline.revision,
      );
      publishDirty(false);
      setLastSavedAt(Date.now());
      return true;
    });
    const configureAutosave = (settings: AutosaveSettings) => {
      autosaveSchedulerRef.current?.cancel();
      autosaveSettingsRef.current = settings;
      autosaveSchedulerRef.current = createAutosaveScheduler(
        () => { void saveCurrent(); },
        autosaveIntervalMs ?? settings.interval_ms,
      );
      if (settings.enabled && isDirtyRef.current) autosaveSchedulerRef.current.schedule();
    };
    configureAutosave(autosaveSettingsRef.current);
    void getSettings()
      .catch(() => DEFAULT_SETTINGS)
      .then((settings) => {
        if (lifecyclePathRef.current === adoptedPath && !autosaveSettingsExplicitRef.current) {
          configureAutosave(settings?.autosave ?? DEFAULT_SETTINGS.autosave);
        }
      });

    const checkDisk = async () => {
      if (missingRef.current || externalChangeRef.current) return;
      try {
        const disk = await openDocument(root, adoptedPath);
        const isOwnPublication = ownPublicationRef.current === disk.content;
        if (
          !isOwnPublication
          && isExternallyChanged(disk.content, diskContentRef.current)
          && disk.content !== dismissedDiskContentRef.current
        ) {
          const change = { diskContent: disk.content, diskRevision: disk.revision };
          saveAuthorizationEpochRef.current += 1;
          externalChangeRef.current = change;
          autosaveSchedulerRef.current?.cancel();
          saveRunnerRef.current?.cancelTrailing();
          setExternalChange(change);
          setRecoveryPhase(null);
          setSaveBlocked(false);
        }
      } catch {
        // Project generations own Missing. A transient polling failure is retried on the next tick.
      }
    };
    const poller: ExternalChangePoller = createExternalChangePoller(
      checkDisk,
      externalChangePollMs ?? DEFAULT_EXTERNAL_CHANGE_POLL_MS,
    );
    poller.start();
    return () => {
      saveAuthorizationEpochRef.current += 1;
      poller.stop();
      autosaveSchedulerRef.current?.cancel();
      saveRunnerRef.current?.cancelTrailing();
    };
    // Activation is keyed by the one retained surface's adopted path. Callback identities are refs.
  // A successful ordinary save refreshes the parent's baseline for future moves. That same-path
  // refresh must not tear down this active poller/scheduler; only a path transition reactivates it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, adoptedPath]);

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current ? serializeDocumentState(viewRef.current.state) : undefined,
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
      saveAuthorizationEpochRef.current += 1;
      autosaveSchedulerRef.current?.cancel();
      saveRunnerRef.current?.cancelTrailing();
    },
    save: () => saveCurrent(),
    saveAs: () => saveAsCurrent(),
    setAutosaveSettings: (settings: AutosaveSettings) => {
      autosaveSettingsExplicitRef.current = true;
      autosaveSettingsRef.current = settings;
      if (!adoptedPath) return;
      autosaveSchedulerRef.current?.cancel();
      autosaveSchedulerRef.current = createAutosaveScheduler(
        () => { void saveCurrent(); },
        autosaveIntervalMs ?? settings.interval_ms,
      );
      if (settings.enabled && isDirtyRef.current) autosaveSchedulerRef.current.schedule();
    },
    showMissingActions: () => setMissingBannerOpen(true),
    decideChanges: (ids: string[], decision: Decision) => {
      const view = viewRef.current;
      if (!view) return null;
      const decided = decisionGroupClosure(view.state, ids);
      const spec = decisionsTransaction(view.state, ids, decision, "card");
      if (spec) view.dispatch(spec);
      return decided;
    },
    changeGeneration: () => viewRef.current ? changeGeneration(viewRef.current.state) : null,
    applyDelivery: (next: string, changes: ParsedChange[], generation: string) => {
      const view = viewRef.current;
      if (view) applyAgentDelivery(view, next, { changes, generation });
    },
    focusAnchor: (anchor) => focusAnchorInEditor(viewRef.current, anchor),
    revealCommentThread: (thread, isCurrent) => revealCommentThreadInEditor(viewRef.current, thread, isCurrent),
    focusChange: (changeId) => viewRef.current ? focusTrackedChange(viewRef.current, changeId) : false,
  }), [adoptedPath, autosaveIntervalMs]);

  useEffect(() => {
    surfaceRef.current?.replaceContent(content);
  }, [content]);

  useEffect(() => {
    if (!adoptedPath) return;
    if (missing) {
      autosaveSchedulerRef.current?.cancel();
      saveRunnerRef.current?.cancelTrailing();
      setMissingBannerOpen(true);
      setRecoveryFailure(null);
      let cancelled = false;
      recreateMissingDocumentCapability(adoptedPath)
        .then((capability) => {
          if (!cancelled) setRecreateCapable(capability.status === "available");
        })
        .catch(() => {
          if (!cancelled) setRecreateCapable(false);
        });
      return () => { cancelled = true; };
    }
    setRecreateCapable(false);
    setRecoveryFailure(null);
  }, [adoptedPath, missing]);

  useEffect(() => {
    if (!commentProjection) return;
    surfaceRef.current?.projectComments({ ...commentProjection, sourceText: content });
  }, [commentProjection, content]);

  const toggleCollapsed = () => onRecoveryNoticeCollapsedChange?.(!lossNoticeCollapsed);
  const closeCommentPopover = () => {
    viewRef.current?.dispatch({ effects: setSelectedCommentThread.of(null) });
    setCommentPopover(null);
  };
  const { open: openCommentCount, resolved: resolvedCommentCount } = commentCounts(commentThreads);
  const saveState = useMemo<DocumentSaveState | null>(
    () => recoveryPhase?.kind === "reloading" || recoveryPhase?.kind === "pending"
      ? { kind: "reload-write-pending" }
      : recoveryPhase?.kind === "failed"
        ? { kind: "reload-write-failed" }
        : externalChange
          ? { kind: "writes-paused" }
          : adoptedPath && lastSavedAt !== null
            ? { kind: "saved", at: lastSavedAt }
            : null,
    [adoptedPath, externalChange, lastSavedAt, recoveryPhase?.kind],
  );
  useEffect(() => onSaveStateChangeRef.current?.(saveState), [saveState]);
  const saveStatusOverflowEntry = saveState
    ? documentSaveStatusOverflowEntry(saveState, platform)
    : null;
  const attemptRecoveryWrite = async (nextContent: string, retry: boolean) => {
    const issuedEpoch = saveAuthorizationEpochRef.current;
    let diskSide = nextContent;
    if (retry) {
      const current = recoveryPhaseRef.current;
      if (current?.kind !== "failed" || current.retrying) return;
      diskSide = current.diskContent;
      setRecoveryPhase({ ...current, retrying: true });
    } else {
      setRecoveryPhase({ kind: "reloading" });
    }
    // Let the shared busy state paint before the durable write progresses to the bannerless pending
    // phase, matching the ordinary EditorShell recovery lifecycle.
    await Promise.resolve();
    if (!viewRef.current || saveAuthorizationEpochRef.current !== issuedEpoch) return;
    if (!retry) setRecoveryPhase({ kind: "pending" });
    lastSaveErrorRef.current = null;
    const succeeded = saveRunnerRef.current ? await saveRunnerRef.current(nextContent) : false;
    if (!viewRef.current || saveAuthorizationEpochRef.current !== issuedEpoch) return;
    if (succeeded) {
      setRecoveryPhase(null);
      return;
    }
    setRecoveryPhase({
      kind: "failed",
      reason: errorDetail(lastSaveErrorRef.current) || "Emend couldn’t finish the write.",
      retrying: false,
      diskContent: diskSide,
    });
  };
  const handleReload = () => {
    if (!externalChange || !viewRef.current) return;
    const diskContent = externalChange.diskContent;
    surfaceRef.current?.replaceContent(diskContent);
    onChangeRef.current(diskContent);
    publishDirty(diskContent !== savedContentRef.current);
    dismissedDiskContentRef.current = diskContent;
    autosaveSchedulerRef.current?.cancel();
    saveRunnerRef.current?.cancelTrailing();
    externalChangeRef.current = null;
    setExternalChange(null);
    setSaveBlocked(false);
    setComparing(false);
    void attemptRecoveryWrite(diskContent, false);
  };
  const handleTryAgain = () => {
    if (!viewRef.current) return;
    void attemptRecoveryWrite(serializeDocumentState(viewRef.current.state), true);
  };
  const handleKeepMine = () => {
    if (!externalChange) return;
    dismissedDiskContentRef.current = externalChange.diskContent;
    externalChangeRef.current = null;
    setExternalChange(null);
    setSaveBlocked(false);
    void saveCurrent();
  };
  const bannerState: ExternalChangeBannerState | null = recoveryPhase?.kind === "reloading"
    ? { kind: "reloading" }
    : recoveryPhase?.kind === "failed"
      ? { kind: "failed", reason: recoveryPhase.reason, retrying: recoveryPhase.retrying }
      : externalChange
        ? { kind: "observed", blocked: saveBlocked }
        : null;
  const compareDiskContent = externalChange?.diskContent
    ?? (recoveryPhase?.kind === "failed" ? recoveryPhase.diskContent : null);
  const handleRecreate = () => {
    if (!adoptedPath || !viewRef.current) return;
    const liveContent = serializeDocumentState(viewRef.current.state);
    const normalize = normalizeLineEndingsRef.current;
    void recreateMissingDocument(adoptedPath, liveContent, normalize)
      .then((outcome) => {
        if (outcome.status === "created") {
          savedContentRef.current = liveContent;
          diskContentRef.current = normalize
            ? normalizeContentLineEndings(liveContent)
            : liveContent;
          publishDirty(false);
          setLastSavedAt(Date.now());
          setMissingBannerOpen(false);
          onMissingResolved?.();
        } else if (outcome.status === "reappeared") {
          setMissingBannerOpen(false);
          onMissingResolved?.();
        } else if (outcome.status === "confinement_unavailable") {
          setRecreateCapable(false);
          setRecoveryFailure({ kind: "confinement" });
        } else {
          setRecoveryFailure({ kind: "error", detail: outcome.message });
        }
      })
      .catch((error: unknown) => {
        onErrorRef.current?.(error);
        setRecoveryFailure({ kind: "error", detail: String(error) });
      });
  };
  const untitledBeforeHost = (
    <>
      {!adoptedPath && unsupportedSource && !unsupportedNoticeHidden && (
        <section className="untitled-document__source-notice" role="region"
          aria-label="Unsupported document recovery notice" aria-live="polite">
          <div className="untitled-document__source-copy">
            <p className="untitled-document__source-title"><em>{displacedPath}</em> can’t open as an Emend document.</p>
            <p className="untitled-document__source-detail">Emend won’t open or write that file. The unsaved text this tab held is here, in an untitled document you can edit. <code>Save As…</code> saves it to a supported document path in this project — not to the original file.</p>
          </div>
          <button type="button" className="untitled-document__source-dismiss"
            onClick={() => setUnsupportedNoticeHidden(true)}>Hide message</button>
        </section>
      )}
      {!adoptedPath && (liveOverCap || recoveryContentOmitted) && (
        <section
          className={`untitled-document__loss-notice${
            lossNoticeCollapsed && !liveOverCap
              ? " untitled-document__loss-notice--collapsed"
              : ""
          }`}
          role="region"
          aria-label={
            liveOverCap
              ? recoveryContentOmitted
                ? `Session durability and recovery notice, untitled document from ${displacedPath}`
                : `Session durability warning, untitled document from ${displacedPath}`
              : `Recovery notice, untitled document from ${displacedPath}`
          }
          aria-live="polite"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !lossNoticeCollapsed) {
              event.preventDefault();
              onRecoveryNoticeCollapsedChange?.(true);
            }
          }}
        >
          <span className="untitled-document__loss-dot" aria-hidden="true" />
          <div className="untitled-document__loss-copy">
            {liveOverCap && (
              <div className="untitled-document__live-copy">
                <p className="untitled-document__loss-consequence">
                  This work is here, but Emend can't keep it in your session.
                </p>
                <p className="untitled-document__loss-reason">
                  {recoveryContentOmitted ? "What you have written since is" : "It's"} larger than
                  the 2 MiB Emend can hold per tab, so it won't be there after you quit. Nothing
                  has been lost — the text is in front of you. <code>Save As…</code> puts it in the
                  project, and that is the only way to keep it.
                </p>
              </div>
            )}
            {recoveryContentOmitted && (
              <div
                className={liveOverCap ? "untitled-document__historical-loss" : undefined}
              >
                {liveOverCap && <hr className="untitled-document__loss-separator" />}
                {lossNoticeCollapsed ? (
                  <p className="untitled-document__loss-summary">
                    Earlier unsaved work not preserved
                  </p>
                ) : liveOverCap ? (
                  <p className="untitled-document__loss-reason">
                    <strong>Separately:</strong> the earlier unsaved work this tab was opened to
                    hold was not preserved, and Emend can't restore it. Saving now keeps what you
                    wrote — it doesn't bring that back.
                  </p>
                ) : (
                  <>
                    <p className="untitled-document__loss-consequence">
                      {unsupportedSource
                        ? "Some earlier unsaved work in this tab couldn’t be preserved."
                        : "Your earlier unsaved work couldn’t be preserved."}
                    </p>
                    {unsupportedSource ? (
                      <p className="untitled-document__loss-reason">
                        What is here is the text that was kept. It doesn’t bring back what wasn’t.
                      </p>
                    ) : <p className="untitled-document__loss-reason">
                      <span className="untitled-document__loss-provenance">
                        This untitled tab holds work from <em>{displacedPath}</em>.{' '}
                      </span>
                      An earlier unsaved buffer was larger than the 2 MiB Emend
                      keeps per tab in its session, so it wasn’t kept, and Emend can’t restore it.
                      <span className="untitled-document__loss-full">
                        {' '}You can edit this untitled document, and <code>Save As…</code> adds its
                        current text to the project.
                      </span>
                      <span className="untitled-document__loss-short">
                        {' '}You can write here; <code>Save As…</code> adds the current text to the project.
                      </span>
                      {' '}It doesn’t bring back what wasn’t kept.
                    </p>}
                  </>
                )}
              </div>
            )}
          </div>
          {recoveryContentOmitted && (
            <button
              type="button"
              className="untitled-document__loss-toggle"
              aria-expanded={!lossNoticeCollapsed}
              aria-label={
                lossNoticeCollapsed
                  ? "Earlier unsaved work not preserved — show details"
                  : "Hide message"
              }
              onClick={toggleCollapsed}
            >
              {lossNoticeCollapsed ? "Details" : "Hide message"}
            </button>
          )}
        </section>
      )}
      {!adoptedPath && saveError !== null && (
        // `role="status"` — non-modal, matching the app's other failure surfaces
        // (`MissingOnDiskBanner`, the shell status region) exactly, not by default.
        <p className="untitled-document__error" role="status">
          {formatActionFailure(saveError)}
        </p>
      )}
      {!adoptedPath && <div className="untitled-document__conditions" aria-label="Untitled document status">
        <span className="untitled-document__condition untitled-document__condition--editable">
          Editable
        </span>
        <span className="untitled-document__condition">Untitled</span>
        <span className="untitled-document__condition untitled-document__condition--project">
          Not in this project
        </span>
        <span className="untitled-document__condition untitled-document__condition--saved">
          Saved nowhere yet
        </span>
      </div>}
    </>
  );
  return (
    <section
      className={adoptedPath ? "editor-shell" : "untitled-document"}
      aria-label={adoptedPath ? `Document ${adoptedPath}` : `Untitled document, recovered from ${displacedPath}`}
      data-platform={platform}
    >
      <DocumentSurface
        ref={surfaceRef}
        platform={platform}
        timelineReturn={timelineReturn}
        hostClassName={adoptedPath ? "editor-shell__host" : "untitled-document__buffer"}
        onQuoteSelection={onQuoteSelection}
        onViewChange={(view) => { viewRef.current = view; }}
        selectionActionsHidden={commentPopover !== null}
        onCommentSelection={(docId || adoptedPath) ? (selection) =>
          setCommentPopover({ kind: "create", selection }) : undefined}
        renderOverlay={(view, selection) =>
          commentPopover && root && (docId || adoptedPath) ? (
            <CommentPopover
              key={commentPopover.kind === "view" ? commentPopover.thread.id : "create"}
              root={root}
              platform={platform}
              document={adoptedPath
                ? { kind: "path", path: adoptedPath }
                : { kind: "id", docId: docId!, label: `Untitled — recovered from ${displacedPath}` }}
              readContent={() => view.state.doc.toString()}
              target={commentPopover}
              style={commentPopoverStyle(view, commentPopover, selection)}
              now={commentNow}
              onThreadsChanged={(threads) => onCommentThreadsChanged?.(threads)}
              onFocusChange={(changeId) => focusTrackedChange(view, changeId)}
              onFocusAnchor={(anchor) => {
                void focusAnchorInEditor(viewRef.current, anchor).then((focused) => {
                  if (focused) closeCommentPopover();
                });
              }}
              openDocuments={openDocuments}
              onClose={closeCommentPopover}
            />
          ) : null}
        beforeHost={adoptedPath ? (
          <>
            {bannerState && !comparing && !missing && (
              <ExternalChangeBanner
                path={adoptedPath}
                state={bannerState}
                isDirty={isDirty}
                onReload={handleReload}
                onKeepMine={handleKeepMine}
                onCompare={() => setComparing(true)}
                onTryAgain={handleTryAgain}
                onSaveAs={() => { void saveAsCurrent(); }}
                platform={platform}
              />
            )}
            {compareDiskContent !== null && comparing && (
              <ExternalChangeCompare
                path={adoptedPath}
                localContent={viewRef.current ? serializeDocumentState(viewRef.current.state) : content}
                diskContent={compareDiskContent}
                onClose={() => setComparing(false)}
              />
            )}
            {missing && missingBannerOpen && (
              <MissingOnDiskBanner
                recreatable={recreateCapable}
                failure={recoveryFailure}
                onKeepEditing={() => setMissingBannerOpen(false)}
                onSaveAs={() => { void saveAsCurrent(); }}
                onClose={() => onRequestClose?.()}
                onRecreate={handleRecreate}
              />
            )}
            {crlfBannerOpen && (
              <CrlfBanner
                onOk={() => setCrlfBannerOpen(false)}
                onDontConvert={() => {
                  normalizeLineEndingsRef.current = false;
                  setCrlfBannerOpen(false);
                }}
              />
            )}
          </>
        ) : untitledBeforeHost}
        documentStatusFacts={{
          openCommentCount: (docId || adoptedPath) ? openCommentCount : null,
          resolvedCommentCount: adoptedPath ? resolvedCommentCount : undefined,
          commentMode: Boolean(adoptedPath) && commentMode,
          unattributedChanges: !adoptedPath,
        }}
        trailingStatusItems={[
          ...(saveState && saveStatusOverflowEntry ? [{
            id: "save-state",
            content: <DocumentSaveStatus state={saveState} platform={platform} />,
            overflowEntries: [saveStatusOverflowEntry] as const,
          }] : []),
          agentConnectionStatusItem(providerStatuses),
        ]}
        afterHost={!adoptedPath ? (
          <div className="untitled-document__actions">
            <span className="untitled-document__autosave">
              No autosave — there is no project path yet.
            </span>
            <button
              type="button"
              className="untitled-document__save-as"
              onClick={onSaveAs}
              disabled={saving}
            >
              Save As…
            </button>
          </div>
        ) : provenancePending ? (
          <div className="untitled-adoption-pending" role="status">
            Saved to {adoptedPath}. Emend hasn't yet recorded that the earlier unsaved work
            wasn't part of it — it will finish next time it can.
          </div>
        ) : undefined}
      />
    </section>
  );
});

function commentPopoverStyle(
  view: EditorView,
  target: CommentPopoverTarget,
  selection: SelectionSnapshot | null,
): CSSProperties | undefined {
  const at = target.kind === "create"
    ? selection?.offset === undefined ? null : selection.offset + selection.length
    : commentAnchors(view.state).find((anchor) => anchor.threadId === target.thread.id)?.to;
  if (at === null || at === undefined) return undefined;
  try {
    const coords = view.coordsAtPos(at);
    return coords ? { position: "absolute", top: coords.bottom, left: coords.left } : undefined;
  } catch {
    return undefined;
  }
}
