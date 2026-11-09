// ABOUTME: The one path-free CM6 document surface shared by file-backed and untitled panes (TD-24).
// ABOUTME: It owns the editor mount, render-only extensions, projection chrome, and controlled text.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cursorDocEnd, defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, Transaction, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, placeholder, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import {
  beginAppStatusRequest,
  clearOwnedUserAppStatus,
  setOwnedUserAppStatus,
  setUserAppStatus,
  type OwnedUserAppStatus,
} from "../stores/appStatus";
import { captureAnchor, parseChanges, type DocIdRef, type DocRef } from "./ipc";
import { createDocumentState, editorOffsetText, serializeDocumentState } from "./document";
import {
  formatCommandExtensions,
  formatControlStates,
  toggleBold,
  toggleItalic,
  type FormatCommandResult,
} from "./formatCommands";
import { KEYMAP } from "./keymap";
import { selectionWatcherExtension, type SelectionSnapshot } from "./selectionWatcher";
import {
  revealAtCursorEnabledField,
  setRevealAtCursorEnabled,
  structuralMarkdownExtensions,
} from "./structuralDecorations";
import { spellcheckExtensions } from "./spellcheck";
import {
  changeGeneration,
  decisionSource,
  dropTrackedChanges,
  redlineChromeEffectsChanged,
  restoreTrackedChanges,
  seedTrackedChanges,
  trackedChanges,
  type DecisionSource,
  type ParsedChange,
  redlineExtensions,
} from "./trackedChanges";
import {
  commentHighlightExtensions,
  commentThreadSeedFromDisk,
  setCommentThreads,
  setDocumentRevision,
} from "./commentHighlights";
import { viewModeExtensions, viewModeField } from "./viewMode";
import {
  beginEditorDictation,
  captureEditorDictationTarget,
  clearEditorDictation,
  commitEditorDictationFinal,
  dictationGhostField,
  editorDictationTargetInvalidated,
  retireEditorDictationTarget,
  showEditorDictationPartial,
} from "./dictationGhost";
import { ViewModeToolbar } from "./ViewModeToolbar";
import { RedlineReview } from "./RedlineReview";
import { QuoteAffordance } from "./QuoteAffordance";
import { CommentTrigger } from "./CommentTrigger";
import {
  DocumentStatusBar,
  type DocumentStatusBarItem,
  type DocumentStatusBarPlatform,
  type DocumentStatusBarTrailingItem,
} from "./DocumentStatusBar";
import { retireVoiceDictationOrigin, useVoicePresentation } from "../voice/SharedDictationMic";
import type { VoiceDictationEvent } from "../settings/voiceIpc";
import { voiceStatusEcho } from "../voice/voicePresentation";
import { DisplayModeControl, displayModeOverflowEntries } from "./DisplayModeControl";
import { editorThemeExtensions } from "./editorTheme";
import {
  documentStatusLeadingItems,
  type DocumentStatusLeadingFacts,
} from "./DocumentStatusItems";
import type { Anchor, CommentThread } from "../comments/types";
import { wordCountField, wordCountState } from "./wordCount";

export interface DocumentSurfaceMountOptions {
  content: string;
  /** App-global presentation preference; false is the safe pre-hydration/default value (TD-26). */
  revealMarkupAtCursor?: boolean;
  /** `null` is the canonical pathless CriticMarkup parse (TD-16/TD-24). */
  parseDocument: DocRef | DocIdRef | null;
  /** A file revision when the mounted parse corresponds to disk; pathless parses use `null`. */
  parseGeneration: string | null;
  keyBindings?: readonly KeyBinding[];
  extensions?: readonly Extension[];
  onUpdate?: (update: ViewUpdate) => void;
  onDocumentChange?: (content: string) => void;
  onBlur?: () => void;
  onChangesDecided?: (ids: string[], source: DecisionSource) => void;
  onChangesReversed?: (ids: string[]) => void;
  onChangeGenerationChange?: (generation: string | null) => void;
  onCommentThreadSelected?: (threadId: string) => void;
  ariaLabel?: string;
  placeholderText?: string;
  commentProjection?: {
    sourceText: string;
    revision: string;
    threads: readonly CommentThread[];
  };
  /** Reports canonical parse failures without converting unavailable truth into an empty parse. */
  onParseError?: (error: unknown) => void;
}

export interface DocumentSurfaceHandle {
  mount(options: DocumentSurfaceMountOptions): EditorView;
  destroy(): void;
  view(): EditorView | null;
  /** Reconciles a controlled owner value without replacing the CM6 instance. */
  replaceContent(content: string): void;
  projectComments(projection: DocumentSurfaceMountOptions["commentProjection"]): void;
  /** Rebinds the tracked-change join from pathless/unrecorded to a checkpointed document owner. */
  setParseDocument(document: DocRef | DocIdRef | null, generation: string | null): void;
  /** Applies the app-global presentation preference without replacing the CM6 instance. */
  setRevealMarkupAtCursor(enabled: boolean): void;
  /** Captures the original target before Rust Start, after any first-use model download. */
  captureDictationTarget(): boolean;
  /** Retires an unaccepted target or the current ghost without changing source. */
  retireDictationTarget(): void;
  /** Gives an accepted generation authority over the captured editor target. */
  beginDictation(generation: number): boolean;
  /** Projects a matching live partial without changing source or undo history. */
  showDictationPartial(generation: number, text: string): boolean;
  /** Clears a matching provisional session without editing source. */
  clearDictation(generation: number): boolean;
  /** Commits one matching Final as an isolated, editable source transaction. */
  commitDictationFinal(generation: number, text: string): boolean;
}

export interface DocumentSurfaceProps {
  platform: DocumentStatusBarPlatform;
  timelineReturn?: import("./ViewModeToolbar").TimelineReturnControl;
  batchAddressControl?: ReactNode;
  hidden?: boolean;
  hostClassName?: string;
  beforeHost?: ReactNode;
  /** Caller-owned pane chrome that belongs below the document but above the window status bar. */
  afterHost?: ReactNode;
  leadingStatusItems?: readonly DocumentStatusBarItem[];
  /** Facts whose word and tracked-change counts are owned by this mounted CM6 surface. */
  documentStatusFacts?: Omit<DocumentStatusLeadingFacts, "wordCount" | "trackedChangeCount">;
  trailingStatusItems?: readonly DocumentStatusBarTrailingItem[];
  onViewChange?: (view: EditorView | null) => void;
  onQuoteSelection?: (quote: { text: string; anchor: Anchor }) => void;
  onQuoteError?: (error: unknown) => void;
  onCommentSelection?: (selection: {
    offset: number;
    length: number;
    preview: string;
    content: string;
  }) => void;
  selectionActionsHidden?: boolean;
  renderOverlay?: (view: EditorView, selection: SelectionSnapshot | null) => ReactNode;
}

/**
 * TD-24's structural boundary. It has no open/save/autosave/external-change capability: callers may
 * add in-memory CM extensions and key bindings, but all disk machinery remains in `EditorShell`.
 */
export const DocumentSurface = forwardRef<DocumentSurfaceHandle, DocumentSurfaceProps>(
  function DocumentSurface(
    {
      platform,
      timelineReturn,
      batchAddressControl,
      hidden = false,
      hostClassName = "editor-shell__host",
      beforeHost,
      afterHost,
      leadingStatusItems,
      documentStatusFacts,
      trailingStatusItems = [],
      onViewChange,
      onQuoteSelection,
      onQuoteError,
      onCommentSelection,
      selectionActionsHidden = false,
      renderOverlay,
    },
    ref,
  ) {
    const voiceState = useVoicePresentation();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const dictationTargetCapturedRef = useRef(false);
    const dictationGenerationRef = useRef<number | null>(null);
    const dictationCaptureEpochRef = useRef(0);
    const focusListenerRef = useRef<{ view: EditorView; listener: () => void } | null>(null);
    const endNavigationRef = useRef<{
      view: EditorView;
      refresh: () => void;
      stop: () => void;
    } | null>(null);
    const reconcilingRef = useRef(false);
    const parsePolicyRef = useRef<{
      document: DocRef | DocIdRef | null;
      generation: string | null;
    } | null>(null);
    const parseRequestRef = useRef(0);
    const parsePendingRef = useRef(false);
    const parseErrorRef = useRef<((error: unknown) => void) | undefined>(undefined);
    const [reviewView, setReviewView] = useState<EditorView | null>(null);
    const [version, setVersion] = useState(0);
    const [statusTrackedChangeCount, setStatusTrackedChangeCount] = useState(0);
    const [statusWordCount, setStatusWordCount] = useState(0);
    const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
    const selectionActionsRef = useRef<HTMLDivElement | null>(null);
    const redlineClickRef = useRef<((pos: number) => void) | null>(null);
    const pendingFormatStatusRef = useRef<{
      view: EditorView;
      doc: Text;
      selection: EditorSelection;
      control: "bold" | "italic";
      owner: OwnedUserAppStatus;
    } | null>(null);
    const onViewChangeRef = useRef(onViewChange);
    onViewChangeRef.current = onViewChange;
    const onCommentSelectionRef = useRef(onCommentSelection);
    onCommentSelectionRef.current = onCommentSelection;
    const commentSelectionAvailable = Boolean(onCommentSelection);

    const handleDictationRetire = useCallback(() => {
      dictationCaptureEpochRef.current += 1;
      dictationTargetCapturedRef.current = false;
      dictationGenerationRef.current = null;
      const view = viewRef.current;
      if (view) retireEditorDictationTarget(view);
    }, []);
    const handleDictationStart = useCallback(() => {
      dictationCaptureEpochRef.current += 1;
      const view = viewRef.current;
      dictationTargetCapturedRef.current = Boolean(view && captureEditorDictationTarget(view));
      dictationGenerationRef.current = null;
    }, []);
    const handleDictationEvent = useCallback(function handleDictationEvent(event: VoiceDictationEvent) {
      const view = viewRef.current;
      if (!view || !dictationTargetCapturedRef.current) {
        retireVoiceDictationOrigin(handleDictationEvent);
        return;
      }
      if (event.kind === "recording" || event.kind === "partial" || event.kind === "final") {
        if (dictationGenerationRef.current === null) {
          if (!beginEditorDictation(view, event.generation)) {
            retireVoiceDictationOrigin(handleDictationEvent);
            return;
          }
          dictationGenerationRef.current = event.generation;
        }
        if (dictationGenerationRef.current !== event.generation) return;
      }
      if (event.kind === "partial") showEditorDictationPartial(view, event.generation, event.text);
      if (event.kind === "final") {
        if (!commitEditorDictationFinal(view, event.generation, event.text)) retireEditorDictationTarget(view);
        dictationTargetCapturedRef.current = false;
        dictationGenerationRef.current = null;
      }
      if (event.kind === "failed" || event.kind === "cancelled") {
        clearEditorDictation(view, event.generation);
        retireEditorDictationTarget(view);
        dictationTargetCapturedRef.current = false;
        dictationGenerationRef.current = null;
      }
    }, []);
    const retireDictationOrigin = useCallback(() => {
      retireVoiceDictationOrigin(handleDictationEvent);
      handleDictationRetire();
    }, [handleDictationEvent, handleDictationRetire]);

    useLayoutEffect(() => {
      if (reviewView?.state.readOnly && (dictationTargetCapturedRef.current || dictationGenerationRef.current !== null)) {
        retireDictationOrigin();
      }
    }, [reviewView, version, retireDictationOrigin]);

    const deliverCommentSelection = (view: EditorView, selected: SelectionSnapshot) => {
      onCommentSelectionRef.current?.({
        offset: selected.offset,
        length: selected.length,
        preview: selected.text,
        content: editorOffsetText(view.state),
      });
    };

    const clearPendingFormatStatus = () => {
      const pending = pendingFormatStatusRef.current;
      if (!pending) return;
      clearOwnedUserAppStatus(pending.owner);
      pendingFormatStatusRef.current = null;
    };

    const clearEndNavigation = () => {
      const follow = endNavigationRef.current;
      endNavigationRef.current = null;
      follow?.stop();
    };

    const followDocumentEnd = (view: EditorView) => {
      clearEndNavigation();
      const host = hostRef.current;
      if (!host) return;
      let frame: number | null = null;
      const refresh = () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (
            viewRef.current !== view ||
            hostRef.current !== host ||
            !view.hasFocus ||
            view.state.selection.main.head !== view.state.doc.length
          ) {
            clearEndNavigation();
            return;
          }
          const caret = view.coordsAtPos(view.state.doc.length);
          const bounds = host.getBoundingClientRect();
          if (caret && caret.bottom > bounds.bottom - 1) {
            host.scrollTop = host.scrollHeight;
          }
        });
      };
      const cancel = () => clearEndNavigation();
      host.addEventListener("scroll", refresh);
      host.addEventListener("wheel", cancel, { passive: true });
      host.addEventListener("pointerdown", cancel);
      view.contentDOM.addEventListener("blur", cancel);
      endNavigationRef.current = {
        view,
        refresh,
        stop: () => {
          if (frame !== null) cancelAnimationFrame(frame);
          host.removeEventListener("scroll", refresh);
          host.removeEventListener("wheel", cancel);
          host.removeEventListener("pointerdown", cancel);
          view.contentDOM.removeEventListener("blur", cancel);
        },
      };
      refresh();
    };

    const reconcilePendingFormatStatus = (view: EditorView) => {
      const pending = pendingFormatStatusRef.current;
      if (!pending) return;
      if (
        pending.view !== view ||
        pending.doc !== view.state.doc ||
        !pending.selection.eq(view.state.selection) ||
        formatControlStates(view.state)[pending.control] !== "pending"
      ) {
        clearPendingFormatStatus();
      }
    };

    const runFormatShortcut = (
      view: EditorView,
      control: "bold" | "italic",
      run: (currentView: EditorView) => FormatCommandResult,
    ) => {
      clearPendingFormatStatus();
      beginAppStatusRequest();
      const result = run(view);
      if (result.status === "pending") {
        pendingFormatStatusRef.current = {
          view,
          doc: view.state.doc,
          selection: view.state.selection,
          control,
          owner: setOwnedUserAppStatus(
            "Formatting is still loading for this part of the document. Try again in a moment.",
          ),
        };
      } else if (result.status === "unavailable") {
        setUserAppStatus(result.reason);
      }
      return true;
    };

    const parseAndSeed = (
      view: EditorView,
      content: string,
      policy: NonNullable<typeof parsePolicyRef.current>,
    ) => {
      const request = ++parseRequestRef.current;
      parsePendingRef.current = true;
      void parseChanges(policy.document, content)
        .then((changes: ParsedChange[]) => {
          if (viewRef.current !== view || parseRequestRef.current !== request) return;
          // This request is still authoritative even if the user edited during its IPC round trip.
          // Release its pending latch before rejecting the stale content, so live CM6 decisions and
          // later seeds can resume status projection. A superseded request never clears the latch.
          parsePendingRef.current = false;
          if (editorOffsetText(view.state) !== content) return;
          view.dispatch({
            effects: seedTrackedChanges.of({ changes, generation: policy.generation }),
          });
        })
        .catch((error: unknown) => {
          if (viewRef.current !== view || parseRequestRef.current !== request) return;
          parsePendingRef.current = false;
          parseErrorRef.current?.(error);
        });
    };

    const destroy = () => {
      const view = viewRef.current;
      if (!view) return;
      retireDictationOrigin();
      clearEndNavigation();
      parseRequestRef.current += 1;
      parsePendingRef.current = false;
      parsePolicyRef.current = null;
      parseErrorRef.current = undefined;
      if (focusListenerRef.current?.view === view) {
        view.contentDOM.removeEventListener("focus", focusListenerRef.current.listener);
        focusListenerRef.current = null;
      }
      clearPendingFormatStatus();
      view.destroy();
      viewRef.current = null;
      setReviewView(null);
      setStatusTrackedChangeCount(0);
      setStatusWordCount(0);
      setSelection(null);
      onViewChangeRef.current?.(null);
    };

    useImperativeHandle(
      ref,
      () => ({
        mount(options) {
          if (!hostRef.current) throw new Error("DocumentSurface host is not mounted");
          destroy();

          const view = new EditorView({
            state: createDocumentState(options.content, [
              history(),
              wordCountField,
              EditorView.lineWrapping,
              ...editorThemeExtensions(),
              Prec.high(
                keymap.of([
                  {
                    key: KEYMAP.bold.spec,
                    run: (currentView) => runFormatShortcut(currentView, "bold", toggleBold),
                  },
                  {
                    key: KEYMAP.italic.spec,
                    run: (currentView) => runFormatShortcut(currentView, "italic", toggleItalic),
                  },
                ]),
              ),
              keymap.of([
                ...(options.keyBindings ?? []),
                ...historyKeymap,
                {
                  key: KEYMAP.documentEnd.spec,
                  run: (currentView) => {
                    cursorDocEnd(currentView);
                    // CM6 may re-anchor after measuring a long wrapped document. Keep this
                    // navigation intent on the actual host until a different user action or
                    // selection supersedes it, correcting only an offscreen end caret.
                    followDocumentEnd(currentView);
                    return true;
                  },
                },
                ...defaultKeymap,
              ]),
              EditorView.updateListener.of((update) => {
                if (dictationTargetCapturedRef.current &&
                  editorDictationTargetInvalidated(update.startState, update.state)) {
                  const captureEpoch = dictationCaptureEpochRef.current;
                  // CM6 refuses nested dispatch inside an update listener. The field already
                  // denies Final; release the native lease at the next microtask boundary.
                  queueMicrotask(() => {
                    if (viewRef.current === update.view &&
                      dictationCaptureEpochRef.current === captureEpoch &&
                      dictationTargetCapturedRef.current) retireDictationOrigin();
                  });
                }
                const endNavigation = endNavigationRef.current;
                if (endNavigation?.view === update.view) {
                  if (
                    !update.view.hasFocus ||
                    update.state.selection.main.head !== update.state.doc.length
                  ) {
                    clearEndNavigation();
                  } else if (
                    update.heightChanged || update.geometryChanged || update.viewportChanged
                  ) {
                    endNavigation.refresh();
                  }
                }
                if (
                  update.docChanged ||
                  update.selectionSet ||
                  syntaxTree(update.startState) !== syntaxTree(update.state) ||
                  update.transactions.some(redlineChromeEffectsChanged)
                ) {
                  setVersion((current) => current + 1);
                }
                reconcilePendingFormatStatus(update.view);
                const previousTrackedChangeCount = trackedChanges(update.startState).length;
                const nextTrackedChangeCount = trackedChanges(update.state).length;
                const canonicalParseEstablished = update.transactions.some((transaction) =>
                  transaction.effects.some((effect) => effect.is(seedTrackedChanges)),
                );
                if (
                  !parsePendingRef.current &&
                  (canonicalParseEstablished ||
                    previousTrackedChangeCount !== nextTrackedChangeCount)
                ) {
                  setStatusTrackedChangeCount(nextTrackedChangeCount);
                }
                if (update.docChanged) {
                  setStatusWordCount(wordCountState(update.state).count);
                }
                if (update.docChanged && !reconcilingRef.current) {
                  options.onDocumentChange?.(serializeDocumentState(update.state));
                }
                for (const transaction of update.transactions) {
                  const decided = transaction.effects
                    .filter((effect) => effect.is(dropTrackedChanges))
                    .flatMap((effect) => effect.value);
                  if (decided.length > 0) {
                    const source: DecisionSource = transaction.isUserEvent("redo")
                      ? "redo"
                      : (transaction.annotation(decisionSource) ?? "editor");
                    options.onChangesDecided?.(decided, source);
                  }
                }
                const reversed = update.transactions.flatMap((transaction) =>
                  transaction.effects
                    .filter((effect) => effect.is(restoreTrackedChanges))
                    .flatMap((effect) => effect.value.map((change) => change.id)),
                );
                if (reversed.length > 0) options.onChangesReversed?.(reversed);
                if (
                  update.transactions.some((transaction) =>
                    transaction.effects.some((effect) => effect.is(seedTrackedChanges)),
                  )
                ) {
                  options.onChangeGenerationChange?.(changeGeneration(update.state));
                }
                options.onUpdate?.(update);
              }),
              EditorView.domEventHandlers({
                mousedown(event, currentView) {
                  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
                  if (pos !== null) redlineClickRef.current?.(pos);
                  return false;
                },
                blur() {
                  options.onBlur?.();
                  return false;
                },
              }),
              selectionWatcherExtension((next) => setSelection(next)),
              ...viewModeExtensions(),
              dictationGhostField,
              ...formatCommandExtensions(),
              ...structuralMarkdownExtensions(),
              revealAtCursorEnabledField.init(() => options.revealMarkupAtCursor ?? false),
              ...redlineExtensions(),
              ...spellcheckExtensions(),
              ...commentHighlightExtensions(
                (threadId) => options.onCommentThreadSelected?.(threadId),
                (selected) => {
                  const current = viewRef.current;
                  if (current) deliverCommentSelection(current, selected);
                },
                () => Boolean(onCommentSelectionRef.current),
              ),
              ...(options.ariaLabel
                ? [EditorView.contentAttributes.of({ "aria-label": options.ariaLabel })]
                : []),
              ...(options.placeholderText ? [placeholder(options.placeholderText)] : []),
              ...(options.extensions ?? []),
            ]),
            parent: hostRef.current,
          });
          viewRef.current = view;
          const parsePolicy = {
            document: options.parseDocument,
            generation: options.parseGeneration,
          };
          parsePolicyRef.current = parsePolicy;
          parseErrorRef.current = options.onParseError;
          const syncSelectionOnFocus = () =>
            view.dispatch({ selection: view.state.selection });
          view.contentDOM.addEventListener("focus", syncSelectionOnFocus);
          focusListenerRef.current = { view, listener: syncSelectionOnFocus };
          setReviewView(view);
          setStatusWordCount(wordCountState(view.state).count);
          onViewChangeRef.current?.(view);

          if (options.commentProjection) {
            const { sourceText, revision, threads } = options.commentProjection;
            const seed = commentThreadSeedFromDisk(view.state, sourceText, threads, revision);
            view.dispatch({
              effects: [
                setDocumentRevision.of(revision),
                ...(seed ? [setCommentThreads.of(seed)] : []),
              ],
            });
          }

          parseAndSeed(view, editorOffsetText(view.state), parsePolicy);
          return view;
        },
        destroy,
        view: () => viewRef.current,
        replaceContent(content) {
          const view = viewRef.current;
          const parsePolicy = parsePolicyRef.current;
          if (!view || !parsePolicy || serializeDocumentState(view.state) === content) return;
          // The empty seed removes stale redline chrome immediately, but the status projection
          // keeps its last established count until this newer canonical parse succeeds. A failed
          // or superseded parse therefore cannot manufacture a truthful-looking zero.
          parsePendingRef.current = true;
          reconcilingRef.current = true;
          try {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
              effects: seedTrackedChanges.of({ changes: [], generation: parsePolicy.generation }),
              annotations: Transaction.addToHistory.of(false),
            });
          } finally {
            reconcilingRef.current = false;
          }
          parseAndSeed(view, editorOffsetText(view.state), parsePolicy);
        },
        projectComments(projection) {
          const view = viewRef.current;
          if (!view || !projection) return;
          const { sourceText, revision, threads } = projection;
          const seed = commentThreadSeedFromDisk(view.state, sourceText, threads, revision);
          if (!seed) return;
          view.dispatch({ effects: [setDocumentRevision.of(revision), setCommentThreads.of(seed)] });
        },
        setParseDocument(document, generation) {
          const view = viewRef.current;
          if (!view) return;
          const policy = { document, generation };
          parsePolicyRef.current = policy;
          parseAndSeed(view, editorOffsetText(view.state), policy);
        },
        setRevealMarkupAtCursor(enabled) {
          const view = viewRef.current;
          if (!view || view.state.field(revealAtCursorEnabledField) === enabled) return;
          view.dispatch({ effects: setRevealAtCursorEnabled.of(enabled) });
        },
        captureDictationTarget() {
          const view = viewRef.current;
          return view ? captureEditorDictationTarget(view) : false;
        },
        retireDictationTarget() {
          retireDictationOrigin();
        },
        beginDictation(generation) {
          const view = viewRef.current;
          return view ? beginEditorDictation(view, generation) : false;
        },
        showDictationPartial(generation, text) {
          const view = viewRef.current;
          return view ? showEditorDictationPartial(view, generation, text) : false;
        },
        clearDictation(generation) {
          const view = viewRef.current;
          return view ? clearEditorDictation(view, generation) : false;
        },
        commitDictationFinal(generation, text) {
          const view = viewRef.current;
          return view ? commitEditorDictationFinal(view, generation, text) : false;
        },
      }),
      [retireDictationOrigin],
    );

    useEffect(() => destroy, []);

    useEffect(() => {
      const view = viewRef.current;
      if (view) view.dispatch({ selection: view.state.selection });
    }, [commentSelectionAvailable]);

    useLayoutEffect(() => {
      const actions = selectionActionsRef.current;
      if (!actions || !selection || !reviewView) return;
      const column = actions.closest<HTMLElement>(".untitled-document, .editor-shell");
      if (!column) return;
      const position = () => {
        const anchor = selectionCoordsStyle(reviewView, selection.offset + selection.length);
        if (typeof anchor?.top !== "number" || typeof anchor.left !== "number") return;
        actions.style.top = `${anchor.top}px`;
        actions.style.left = `${anchor.left}px`;
        actions.style.transform = "";
        const actionBox = actions.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        const shift = Math.max(columnBox.left - actionBox.left,
          Math.min(0, columnBox.right - actionBox.right));
        if (shift) actions.style.transform = `translateX(${shift}px)`;
      };
      position();
      const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
      resizeObserver?.observe(column);
      resizeObserver?.observe(actions);
      window.addEventListener("resize", position);
      reviewView.scrollDOM.addEventListener("scroll", position, { passive: true });
      return () => {
        resizeObserver?.disconnect();
        window.removeEventListener("resize", position);
        reviewView.scrollDOM.removeEventListener("scroll", position);
      };
    }, [reviewView, selection, hidden, selectionActionsHidden, onCommentSelection, onQuoteSelection]);

    const handleQuote = () => {
      const view = viewRef.current;
      if (!view || !selection) return;
      const content = editorOffsetText(view.state);
      void captureAnchor(content, selection.offset, selection.length)
        .then((anchor) => onQuoteSelection?.({ text: selection.text, anchor }))
        .catch((error: unknown) => onQuoteError?.(error));
    };
    const handleComment = () => {
      const view = viewRef.current;
      if (!view || !selection) return;
      deliverCommentSelection(view, selection);
    };
    const displayItem: DocumentStatusBarTrailingItem | null = reviewView
      ? {
          id: "display-mode",
          content: <DisplayModeControl view={reviewView} version={version} />,
          overflowEntries: displayModeOverflowEntries(
            reviewView,
            reviewView.state.field(viewModeField).displayMode,
          ),
        }
      : null;
    const projectedLeadingItems =
      leadingStatusItems ??
      (reviewView && documentStatusFacts
        ? documentStatusLeadingItems({
            wordCount: statusWordCount,
            trackedChangeCount: statusTrackedChangeCount,
            ...documentStatusFacts,
          })
        : undefined);
    const voiceEcho = voiceStatusEcho(voiceState);
    const leadingWithVoice = voiceEcho && reviewView
      ? [...(projectedLeadingItems ?? []), {
          id: "voice-status",
          content: <span className={voiceEcho.error ? "dictation-status-echo dictation-status-echo--error" : "dictation-status-echo"}>{voiceEcho.text}</span>,
        }]
      : projectedLeadingItems;

    return (
      <>
        <ViewModeToolbar
          view={reviewView}
          version={version}
          platform={platform}
          timelineReturn={timelineReturn}
          batchAddressControl={batchAddressControl}
          onDictationEvent={handleDictationEvent}
          onDictationStart={handleDictationStart}
          onDictationRetire={handleDictationRetire}
          contextControls={
            !hidden && reviewView && trackedChanges(reviewView.state).length > 0 ? (
              <RedlineReview
                view={reviewView}
                version={version}
                clickBridge={redlineClickRef}
                embedded
              />
            ) : null
          }
        />
        {beforeHost}
        {!hidden &&
          !selectionActionsHidden &&
          selection &&
          reviewView &&
          (onQuoteSelection || onCommentSelection) && (
            <div
              className="editor-shell__selection-affordances"
              data-platform={platform}
              ref={selectionActionsRef}
              style={selectionCoordsStyle(reviewView, selection.offset + selection.length)}
            >
              {onCommentSelection && <CommentTrigger onComment={handleComment} />}
              {onQuoteSelection && <QuoteAffordance onQuote={handleQuote} />}
            </div>
          )}
        {reviewView && renderOverlay?.(reviewView, selection)}
        <div
          className={hostClassName}
          ref={hostRef}
          data-selection-actions-hidden={selectionActionsHidden ? "true" : undefined}
          style={hidden ? { display: "none" } : undefined}
        />
        {afterHost}
        <DocumentStatusBar
          platform={platform}
          leadingItems={leadingWithVoice}
          trailingItems={[...(displayItem ? [displayItem] : []), ...trailingStatusItems]}
        />
      </>
    );
  },
);

/** Position selection chrome just beyond its range; layout-less tests intentionally get no style. */
function selectionCoordsStyle(view: EditorView, pos: number): CSSProperties | undefined {
  try {
    const coords = view.coordsAtPos(pos);
    return coords
      ? { position: "absolute", top: coords.bottom, left: coords.left }
      : undefined;
  } catch {
    return undefined;
  }
}
