// ABOUTME: The tab-aware editor region (P2a-6, FR-ED-3) — owns the open-tab set, per-project
// ABOUTME: session persistence (`store::tab_session`), and the dirty-close/quit guard, wiring the
// ABOUTME: `stores/tabs` display state to a `TabBar` plus one `EditorShell` per open tab. Each
// ABOUTME: completed project-files generation lands here: its moves rekey tabs, while its
// ABOUTME: enumeration plus backend visibility decide Missing on disk (J2, #932/#933/#1444).
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  beginTabSession,
  endTabSession,
  proveTabSession,
  saveDocument,
  saveDocumentAs,
  saveTabSession,
  setOpenTabs,
  type SessionPayload,
  type TabSessionReceipt,
} from "./ipc";
import { EditorShell, type EditorShellHandle } from "./EditorShell";
import type { DocumentSaveState } from "./DocumentSaveStatus";
import type { DocumentStatusBarPlatform } from "./DocumentStatusBar";
import { UntitledDocument } from "./UntitledDocument";
import { normalizeContentLineEndings } from "./document";
import { TabBar } from "./TabBar";
import { DirtyCloseGuard } from "./DirtyCloseGuard";
import { SessionWriteFailureDialog } from "./SessionWriteFailureDialog";
import {
  affectedUntitledTabs,
  composeProposedSession,
  materiallyEqualSession,
  type StagedDecision,
} from "./sessionClose";
import type { Decision, DecisionSource, ParsedChange } from "./trackedChanges";
import { testHarness, type OpenRequest } from "../testHarness";
import {
  adoptUntitledTab,
  closeTab,
  EMPTY_TABS,
  exceedsSessionContentCap,
  isRecoveredTab,
  missingTabPaths,
  openTab,
  recoverUnsupportedTab,
  recoveredTabPaths,
  retainEmptyRecoveryContent,
  rekeyTabPaths,
  restoreFromSession,
  setUntitledDocId,
  setRecoveryNoticeCollapsed,
  setActiveTab,
  setTabDirty,
  tabLabel,
  tabsRequiringCloseGuard,
  toSessionPayload,
  type TabRecord,
  type TabsState,
} from "../stores/tabs";
import {
  isProjectPathEnumerable,
  isSupportedDocumentPath,
  movedPath,
  presentFilePaths,
  undescendedPaths,
  type ProjectFileMove,
  type ProjectFilesSnapshot,
} from "../stores/project";
import { MissingDocumentGuard } from "./MissingDocumentGuard";
import { closeWindow, installQuitGuard } from "../stores/appLifecycle";
import type { Anchor, CommentThread } from "../comments/types";
import { isUnsaved, type OpenDocument, type OpenDocumentsSnapshot } from "../timeline/referenceData";
import { errorDetail, UnsupportedRestoreRefusalError, UserFacingError } from "../backend";
import { createAutosaveScheduler, type AutosaveScheduler } from "./autosave";
import {
  basenameOf,
  pickSaveAsPath as pickSaveAsPathDialog,
  relativeToProjectRoot,
} from "../stores/menu";
import { isMac } from "./keymap";
import { getRunState } from "../timeline/agentActivity";
import { useRenderRecoveryAttempt } from "../renderRecovery/context";
import { clearOwnedUserAppStatus, setOwnedUserAppStatus, type OwnedUserAppStatus } from "../stores/appStatus";
import type { QuotedExcerpt, TimelineCard } from "../timeline/types";
import type { AutosaveSettings } from "../settings";
import type { ProviderStatuses } from "../onboarding/types";
import {
  cancelAdoption,
  commitAdoption,
  landAdoption,
  mintUntitledDocId,
  prepareAdoption,
  reconcileAdoptions,
  type AdoptionReconciliation,
} from "../stores/adoption";
import { DictationFreezeContext } from "../voice/SharedDictationMic";

export interface RunActiveCloseRefusal {
  runId: string;
  returnFocusTo: HTMLElement | null;
  fallbackFocusTarget: HTMLElement | null;
}

export interface TabbedEditorProps {
  /** Platform variant shared by tabs, document status, and the owning window chrome. */
  platform?: DocumentStatusBarPlatform;
  timelineReturn?: import("./ViewModeToolbar").TimelineReturnControl;
  /** App-owned batch control for the active file-backed document toolbar. */
  batchAddressControl?: ReactNode;
  /** The one app-owned provider probe, shared with every document's connection status. */
  providerStatuses?: ProviderStatuses;
  /** Timeline-projected binding mode for the active document status sequence. */
  commentMode?: boolean;
  /**
   * Each distinct `id` is processed exactly once, in order (see `App`'s dev-only test hook). A
   * request naming a project `root` this component hasn't seen yet first restores that project's
   * whole persisted tab session (`store::tab_session`) — not just the one `path` it names — before
   * opening/focusing `path` on top; naming an already-current `root` just opens/focuses `path`.
   * "Reopening a closed project" (FR-ED-3) is therefore a real remount: nothing here fabricates a
   * synthetic reload, a fresh `TabbedEditor` mount with the same `root` restores from disk exactly
   * the way the real app would after a relaunch.
   */
  request: OpenRequest;
  /**
   * Acknowledges that this request reached the existing restore/open path, allowing `App` to
   * present the next queued request without React batching away either one (#1486).
   */
  onRequestProcessed?: (id: number) => void;
  onError?: (error: unknown) => void;
  /** Publishes FR-X-11's mode-safe refused-close status without flattening it into a generic error. */
  onRunActiveCloseRefused?: (refusal: RunActiveCloseRefusal) => void;
  /** Receives D15 cards already persisted by the durable adoption reconciler. */
  onPersistedTimelineCards?: (cards: TimelineCard[]) => void;
  /**
   * Autosave debounce interval (ms) for every open tab's editor, forwarded straight to each
   * `EditorShell`. Undefined = each editor uses its built-in default; the D23 e2e hook overrides it
   * (via `App`) so a dirty-window assertion can pause autosave rather than race the 1 s default.
   */
  autosaveIntervalMs?: number;
  /** App-global reveal-at-cursor preference forwarded to every authoring pane (TD-26). */
  revealMarkupAtCursor?: boolean;
  /**
   * External-change poll interval (ms) for every open tab's editor (FR-ED-7), forwarded straight to
   * each `EditorShell`. Undefined = each editor uses its built-in default; the D23 e2e hook
   * overrides it (via `App`) so a scenario needing the banner resolves on a condition rather than
   * waiting out the 5 s default.
   */
  externalChangePollMs?: number;
  /**
   * Optional native Save-panel boundary for every tab, forwarded unchanged to `EditorShell`.
   * Production leaves it undefined; D23 injects only the next OS-dialog result so browser
   * acceptance can keep the complete in-process Save As path real (test-plan §7b).
   */
  pickSaveAsPath?: (root: string, suggestedPath: string) => Promise<string | null>;
  /**
   * Fires with `tabs.tabs.length > 0` on every change to the open-tab set (P2b-6b) — the only
   * source that can tell `App` "the last tab just closed," which is what returns the app to
   * workshop mode (ux-design §4). Not called until `root` is set (a request has actually been
   * processed); a caller with no project open never mounts this component in the first place.
   */
  onTabsChange?: (hasOpenTabs: boolean) => void;
  /**
   * Fires once the current project's persisted session and requested tab have been committed to
   * the live tab state. Unlike `onTabsChange`, this is readiness, not non-emptiness: after this
   * fires the editor remains ready to consume project generations even when the last tab closes.
   * That distinction lets one-shot move metadata be consumed against a genuinely empty set rather
   * than queued and replayed onto a document opened later (#1446).
   */
  onTabsReady?: () => void;
  /**
   * Fired with every id the *active* tab's document just decided, from any entry point (the
   * imperative `decideChanges` below, or in-editor toolbar/keyboard/popover triage) — forwarded
   * straight from that tab's own `EditorShellHandle.onChangesDecided` (#410). A background tab's
   * decisions never reach this: the timeline's change-set-card reconciliation this feeds only ever
   * concerns the document actually on screen. The decision source is forwarded unchanged so the
   * timeline can distinguish a redo from fresh in-editor triage after reversal (UXR-Q5, #798).
   */
  onChangesDecided?: (ids: string[], source: DecisionSource) => void;
  /** Undo-side counterpart to `onChangesDecided`, scoped to the active tab identically. */
  onChangesReversed?: (ids: string[]) => void;
  /**
   * Called when the *active* tab's user takes the quote affordance on a non-empty selection
   * (FR-CHAT-3, P2b-7). This layer resolves that tab's D33 identity — its project-relative path,
   * or `document_path: null` plus its tab-strip `label` for a document with no file
   * ([`quotedExcerptFor`]) — at capture time before forwarding the quote; a later tab switch
   * therefore cannot retarget it. A background tab's selection cannot be quoted (it is not
   * rendered), so only the active tab's editor receives the callback. Omitted here means no caller
   * has anywhere to send a quote, and every tab omits the affordance rather than rendering dead UI.
   *
   * The type is `QuotedExcerpt` itself (D33): both `EditorShell` (a project document) and
   * `UntitledDocument` (a document with no file, #2304 item 4, wired once #2342 supplied the shared
   * `DocumentSurface`) render this component's own selection popover and route their raw
   * `{ text, anchor }` capture through [`quotedExcerptFor`] here, which is what resolves either arm.
   */
  // @anchor:tabbed-editor-props-on-quote-selection
  onQuoteSelection?: (quote: QuotedExcerpt) => void;
  /**
   * Fires with the active tab's triage target — its path plus its live tracked-change field's parse
   * generation (UXR-Q4) — whenever the active tab changes or that tab's field is (re)seeded, and
   * `null` when no tab is active. `App` hands this to every change-set card so a card can refuse its
   * own triage (visibly disabled, naming its document) when it names a different document or a parse
   * the live field no longer holds — the fail-closed half of #410's triage wiring.
   */
  onTriageTargetChange?: (target: TriageTarget | null) => void;
  /**
   * The most recent agent delivery (#346, J1 Phase B). Each distinct `changeSetId` is applied
   * exactly once — re-applying a set the user has already started triaging would silently undo
   * their decisions — and only to the tab whose path matches `doc`. A delivery naming a document
   * with no tab open is ignored here: the set is on disk and attributed either way, there is just
   * no buffer to reseed (the timeline card is the owner's concern, not this layer's).
   */
  delivery?: DeliveryTarget;
  /**
   * Fires with the active tab's path — or `null` when no *project document* is active: no tab at
   * all (no project open, or the last tab just closed), or an active tab that is at no project
   * path (an untitled recovery document, J2/CJ 2026-08-11, whose buffer has no file and cannot be
   * an agent operation target). Classifying that is this layer's job, not the owner's:
   * the record carrying the fact lives here, and a bare path cannot be classified by inspection.
   *
   * Fires on every change to which tab is active: opening/focusing a tab, switching via
   * the tab bar, or closing the active tab onto a neighbor (`stores/tabs.ts`'s own "close" rule).
   * `App`'s single-owner comment-thread state (#411) is keyed on this — it is the only source that
   * can tell `App` the active document actually changed (a `request` alone under-reports: switching
   * to an *already-open* tab via the tab bar never mints a fresh `request`). A background tab's
   * comment threads are never held in memory precisely because this only ever names the one
   * document on screen, matching `onChangesDecided`'s identical active-tab-only scoping above.
   */
  onActivePathChange?: (path: string | null) => void;
  /** D27's unsupported-source recovery title for window chrome; null for other tabs. */
  onActiveUnsupportedRecoveryTitleChange?: (title: string | null) => void;
  /**
   * Reports the active file-backed tab's save/recovery presentation state for owner-level chrome;
   * `null` for no active project document, including an untitled recovery tab.
   */
  onActiveSaveStateChange?: (state: DocumentSaveState | null) => void;
  /**
   * Reports the active path only after that document's initial load succeeds — same "project
   * document, or `null`" contract as `onActivePathChange` above. A requested path that fails to
   * load is never reported; the failed tab is removed and the previously loaded active tab is
   * reported again. This is the commit point for owner UI such as the project rail. Becoming
   * active is what a recovery document reports as `null`, immediately: it never loads (there is
   * nothing to read), and the rail must stop marking the row it was displaced from.
   */
  onConfirmedActivePathChange?: (path: string | null) => void;
  /**
   * The active document's comment threads, owner-supplied (`App`, #411/TD-15) — forwarded straight
   * to the *active* tab's `EditorShell.commentThreads` and no other, mirroring `onChangesDecided`'s
   * identical active-tab-only scoping above: `App`'s owner state is active-document-scoped by
   * design, so a background tab gets no `commentThreads` at all (its `EditorShell` renders whatever
   * it last had, matching `onChangesDecided`'s "background tab's decisions never reach the caller"
   * precedent one prop over).
   */
  commentThreads?: CommentThread[];
  /** Active-tab gutter/highlight activation while the comments column owns the rail. */
  onColumnThreadSelected?: (threadId: string) => void;
  /** The app shell owns active-tab comment reads, including untitled UUID reads. */
  managedCommentLoading?: boolean;
  /** Active and queued run IDs for the active tab's comment popover. */
  liveRunIds?: readonly string[];
  queuedRunIds?: readonly string[];
  terminalRunIds?: readonly string[];
  /**
   * Forwarded straight to the *active* tab's `EditorShell.onCommentThreadsChanged` — the write half
   * of the pair above. Every mutation made through that tab's own editor-anchored comment popover
   * (create/reply/resolve/reopen/re-anchor/address-with-AI/re-delegate/decide-linked-changes)
   * reaches `App` this way, the same seam `timeline/CommentCard`'s identical prop reaches it
   * through — closing the gap #495 deliberately left for #411 to reconcile (its own module docs
   * name this card three times).
   */
  onCommentThreadsChanged?: (threads: CommentThread[]) => void;
  /**
   * Forwarded straight to the *active* tab's `EditorShell.onAddressRunFailed` (#1777); see that
   * prop, and `timeline/agentActivity.ts`'s `failedRunStatus`, for what it carries. Scoped to the
   * active tab for the same reason the pair above is: only the active tab's popover is on screen for
   * a user to have clicked, so a background tab reporting here would name a request nobody made.
   */
  onAddressRunFailed?: (root: string, error: unknown) => void;
  onAddressRunStarted?: (root: string, run: import("../timeline/agentActivity").StartRunResult) => void;
  onCommentRunLink?: import("./CommentPopover").CommentPopoverProps["onCommentRunLink"];
  /**
   * Injectable clock (test-plan §7) for the *active* tab's comment-thread actions (create/reply/
   * resolve/reopen/re-anchor/address-with-AI/re-delegate/decide-linked-changes) — forwarded
   * straight to `EditorShell.now`, mirroring `autosaveIntervalMs`'s identical "undefined = the
   * built-in default (`Date.now()`), the D23 e2e hook overrides it (via `App`)" contract. Exists so
   * an e2e script can drive the whole comment event log's timestamps itself rather than racing the
   * real wall clock against a browser-internal `Date.now()` call it cannot otherwise read back
   * (test-plan P5's causal `(timestamp, id)` fold makes that race a real, if rare, source of
   * flakiness — P2b-11c).
   */
  commentNow?: () => number;
  /** Active local-comment owner. Unlike `onActivePathChange`, pathless UUID owners are retained. */
  onActiveCommentOwnerChange?: (owner: import("../comments/types").CommentDocumentOwner | null) => void;
}

/**
 * The part of a delivery notice this layer needs: which document, what text, its identity, and the
 * delivery's parse. The parse is carried rather than fetched here so the whole delivery rides one
 * authoritative `parse_changes` snapshot (TD-11 corollary) shared with the timeline's card.
 */
export interface DeliveryTarget {
  doc: string;
  content: string;
  changeSetId: string;
  changes: ParsedChange[];
  /** The delivery's revision — seeded into the target tab's tracked-change field as its UXR-Q4
   * parse generation (the same token the timeline change-set card carries) so the two correspond. */
  generation: string;
}

/** Which document a change-set card's triage may be routed into, and the parse generation that
 * document's live tracked-change field currently holds (UXR-Q4) — the active tab's identity, lifted
 * to `App` so a change-set card can fail its own triage closed when it names a different document or
 * a stale parse (mirrors `timeline/types.ts`'s `ChangeSetTriageTarget`, defined there so the
 * timeline module need not import this one). `null` when no tab is active. */
export interface TriageTarget {
  doc: string;
  generation: string | null;
}

/** Imperative surface a caller outside the tab layer needs to route a decision by id into
 * whichever document is currently active (#410) — the seam that keeps coordinate authority inside
 * `editor/` (TD-13) while letting the timeline's change-set card pass only ids across the
 * boundary. */
export interface TabbedEditorHandle {
  /** Routes the general File menu action into the active saved document's existing Save As seam.
   * Resolves false when no ordinary editor is active; #1379 owns untitled adoption. */
  saveActiveDocumentAs(): Promise<boolean>;
  /** Applies a persisted autosave change to every mounted ordinary document without remounting. */
  setAutosaveSettings(settings: AutosaveSettings): void;
  /**
   * Decides `ids` (and every group co-member, P4b) against the *active* tab's live document —
   * delegates straight to that tab's `EditorShellHandle.decideChanges`. Returns `null` when there
   * is no active tab/editor handle, and an explicit empty array when the live field resolves none
   * of the ids.
   */
  decideChanges(ids: string[], decision: Decision): string[] | null;
  /** The active tab's live tracked-change parse generation (UXR-Q4), or `null` when no tab is active
   * or its field is unseeded — the token `App.handleChangeSetDecide` re-checks against the deciding
   * card's own generation before routing, so a decision can never land on a stale/other parse even
   * if the card's own render-time gate lagged. */
  changeGeneration(): string | null;
  /**
   * Selects and scrolls to `anchor`'s range in the *active* tab's document — delegates straight
   * to that tab's `EditorShellHandle.focusAnchor` (P2b-7 follow-up, #492: the timeline quote-bar's
   * deep-link-back). Resolves `false` when there is no active tab or that tab's own resolution
   * fails (the anchor's text has moved on since it was captured — see that method's own docs).
   */
  focusAnchor(anchor: Anchor): Promise<boolean>;
  /** Reveals a live comment by identity without changing the active editor selection or focus. */
  revealCommentThread(thread: Pick<CommentThread, "id" | "anchor" | "withdrawn_at">): Promise<boolean>;
  /** Invalidates a pending passage lookup when the gutter selects a newer comment directly. */
  cancelCommentReveal(): void;
  /** Focuses one live tracked change in the active tab by stable ID. */
  focusChange(changeId: string): boolean;
  /**
   * Every open document as FR-CHAT-4's `open_documents` envelope needs it, read at the moment a run
   * is submitted (#1724): the tab set in strip order with the active one distinguished, a project
   * document's FR-ED-3 dirty flag, and — only where the envelope will actually carry it — the
   * active tab's live buffer. Imperative for the same reason the envelope is captured at submit
   * rather than at render: the active buffer changes on every keystroke, and a run must name what
   * the user was looking at when they pressed Send.
   *
   * Reports clause (1) of D21's union (the open tabs) as its *conceptual* scope, which is why an
   * untitled recovery document is listed here while the backend's operative open-tab set excludes
   * it (D21's 2026-08-28 clause) — different questions, and D21 says so. Naming grants nothing:
   * this changes no operation target, no edit authority, and no protection.
   */
  // @anchor:tabbed-editor-open-documents-doc
  openDocuments(): OpenDocumentsSnapshot;
  /**
   * Takes one completed project-files generation — the single route from "the backend enumerated
   * the project" to document identity (#932, #933). Two things happen, in this order and only this
   * order:
   *
   * 1. **Its proven moves are followed** (TD-18): every open tab the backend proved moved keeps its
   *    buffer, dirty state, strip position, and — if it was active — the active marker, now under
   *    its new path.
   * 2. **What is left without an enumerable file is Missing on disk** (J2): every open tab whose
   *    path this generation does not list — read after the moves, against the paths the tabs now
   *    have — is qualified through TD-18's backend visibility rule. A document the backend proved
   *    moved is therefore at a listed path and is not missing, while an ambiguous descendant it
   *    could not correlate stayed on an enumerable path this generation does not list and lands
   *    here honestly rather than being repointed at another file. A deliberately opened document
   *    under backend-hidden tooling stays outside a state that falsely claims its file is gone.
   *
   * Recomputed whenever either input changes: a new generation is evaluated against the open tabs
   * on hand, and a changed open-tab set is evaluated against the latest completed generation. That
   * second direction is what makes a session restored after the first generation deterministic
   * rather than dependent on which async read happened to win (#1446). The set is not accumulated,
   * so a path that appears again simply isn't in the next answer.
   *
   * Imperative rather than a prop because a generation is an *event*: React batches state updates by
   * microtask drain, so two generations landing in one drain would collapse and the intermediate
   * one — with its own moves — would never be observed (the defect `App`'s `incomingCards` list
   * exists to avoid). A direct call cannot collapse.
   */
  applyCompletedGeneration(snapshot: ProjectFilesSnapshot): void;
}

/** State updater dropping `path` from a path-keyed map — the same reference back when it holds no
 * such key, so a close that touches neither map costs no re-render. */
function without<V>(path: string) {
  return (previous: Map<string, V>): Map<string, V> => {
    if (!previous.has(path)) return previous;
    const next = new Map(previous);
    next.delete(path);
    return next;
  };
}

/** Whether a set already holds exactly `members` — lets an unchanged Missing set come back as the
 * same reference, so a generation that changes nothing about it costs no re-render (the ordinary
 * case: every refresh of a project with all its files present). */
function sameMembers(set: ReadonlySet<string>, members: readonly string[]): boolean {
  return set.size === members.length && members.every((member) => set.has(member));
}

/** `set` without `path` — the same reference back when it never held it (`without` above, for the
 * path-keyed maps, with a set's own shape). */
function withoutPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (!set.has(path)) return set;
  const next = new Set(set);
  next.delete(path);
  return next;
}

/** The active tab's path when that tab is a project document, `null` when no tab is active or the
 * active one is an untitled recovery document (which is at no project path — J2, CJ 2026-08-11). */
function activeProjectDocumentPath(tabs: TabsState): string | null {
  const active = tabs.tabs.find((tab) => tab.path === tabs.activePath);
  return active === undefined || isRecoveredTab(active) ? null : active.path;
}

/**
 * `quote`, captured on `tab`, as FR-CHAT-3's `QuotedExcerpt` (D33): the path-bearing form for an
 * ordinary project document, or `documentPath: null` plus `tabLabel`'s own disambiguated label for
 * a document with no file — the identity `recoveredFrom` (never the spelling of `path`) already
 * decides everywhere else a tab's identity is reported, most directly `openDocumentsSnapshot`'s own
 * `describe` above, which this mirrors so FR-CHAT-3's quote and FR-CHAT-4's `open_documents` name an
 * untitled document with the same words (D33's "one identity convention across both envelopes").
 *
 * Exported and unit-tested directly (`TabbedEditor.test.tsx`) as well as through the render wiring
 * below: both call sites — `EditorShell` (a project document) and `UntitledDocument` (a document
 * with no file, #2304 item 4) — pass the active tab's own record here, so the path-bearing and
 * pathless arms are each reachable through this component in production, not merely in a unit test.
 *
 * `openTabs` is **required**, not optional (PR #2360 review, Minor): every production `tabLabel`
 * call site in `src/` — including `openDocumentsSnapshot`'s own `describe` this mirrors — passes the
 * full open-tab set, and an omitted `openTabs` silently drops `tabLabel`'s collision ordinal
 * (`tabLabel(b, [a, b])` is `"Untitled — recovered from b.md (2)"`; `tabLabel(b)` alone is
 * `"Untitled — recovered from b.md"`, no `(2)`), which is exactly the displaced-collision case D33's
 * "one identity convention across both envelopes" exists to keep in step with `open_documents`. This
 * function is exported specifically so a future caller (#2342's own follow-up) composes it — a
 * one-identity-convention guarantee that only holds when a caller remembers an optional argument is
 * not a guarantee, so the type makes the omission impossible rather than merely inadvisable.
 */
export function quotedExcerptFor(
  tab: TabRecord,
  quote: { text: string; anchor: Anchor },
  openTabs: readonly TabRecord[],
): QuotedExcerpt {
  return isRecoveredTab(tab)
    ? { documentPath: null, label: tabLabel(tab, openTabs), text: quote.text, anchor: quote.anchor }
    : { documentPath: tab.path, text: quote.text, anchor: quote.anchor };
}

function backendErrorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("kind" in error)) return null;
  return typeof error.kind === "string" ? error.kind : null;
}

export const TabbedEditor = forwardRef<TabbedEditorHandle, TabbedEditorProps>(function TabbedEditor(
  {
    request,
    platform = isMac ? "mac" : "win",
    timelineReturn,
    batchAddressControl,
    providerStatuses = null,
    commentMode = false,
    onRequestProcessed,
    onError,
    onRunActiveCloseRefused,
    onPersistedTimelineCards,
    autosaveIntervalMs,
    revealMarkupAtCursor = false,
    externalChangePollMs,
    pickSaveAsPath = pickSaveAsPathDialog,
    onTabsChange,
    onTabsReady,
    onChangesDecided,
    onChangesReversed,
    onQuoteSelection,
    onTriageTargetChange,
    delivery,
    onActivePathChange,
    onActiveUnsupportedRecoveryTitleChange,
    onActiveSaveStateChange,
    onConfirmedActivePathChange,
    commentThreads,
    managedCommentLoading = false,
    liveRunIds,
    queuedRunIds,
    terminalRunIds,
    onCommentThreadsChanged,
    onColumnThreadSelected,
    onAddressRunFailed,
    onAddressRunStarted,
    onCommentRunLink,
    commentNow,
    onActiveCommentOwnerChange,
  },
  ref,
) {
  const recoveryAttempt = useRenderRecoveryAttempt();
  const [root, setRoot] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabsState>(EMPTY_TABS);
  const previousActivePath = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousActivePath.current;
    if (previous === tabs.activePath) return;
    if (previous) editorHandles.current.get(previous)?.retireDictationTarget();
    previousActivePath.current = tabs.activePath;
  }, [tabs.activePath]);
  // The root whose asynchronous session restore has been committed to `tabs`. This is deliberately
  // separate from whether `tabs` is empty: closing the last tab does not make the mounted editor
  // unready, and generations received in workshop mode must still consume their one-shot moves.
  const [readyRoot, setReadyRoot] = useState<string | null>(null);
  // Session-restore content overrides (`unsavedContent`, keyed by path) — read once as each tab's
  // `EditorShell` mounts, then irrelevant (the live editor is the source of truth after that). The
  // one exception is an untitled document (D12, #1379): it mounts no `EditorShell` (no path to key
  // one on yet), so its `UntitledDocument` pane both reads and — via `onChange` below — keeps writing
  // this same map, which is what makes it the ongoing source of truth for that tab's buffer instead
  // of a one-time seed.
  const [restoredContent, setRestoredContent] = useState<Map<string, string>>(new Map());
  const [guardQueue, setGuardQueue] = useState<string[]>([]);
  const [sessionFinalizing, setSessionFinalizing] = useState(false);
  const [sessionSavingVisible, setSessionSavingVisible] = useState(false);
  const closeAttemptTargetRef = useRef<HTMLDivElement>(null);
  const preCloseFocusRef = useRef<HTMLElement | null>(null);
  // Set when a close attempt ends with the window still here and nothing carried out, so the focus
  // restore can wait for the freeze to lift rather than race the render that lifts it.
  const restoreFocusOnUnfreezeRef = useRef(false);
  // React state paints the lock; this ref acquires it synchronously so tab callbacks cannot race
  // the render that applies `inert` after the final payload has already been composed (9d.1).
  const sessionFinalizingRef = useRef(false);
  const [sessionFailure, setSessionFailure] = useState<{
    affectedLabels: string[];
    detail: string;
    baseline: "prior" | "none" | "unknown";
    retrying: boolean;
  } | null>(null);
  // Every open tab a completed generation proved has no file at its path (J2 Missing on disk,
  // #933). Held here, not in `TabsState`, because it is not session state: it is a fact about the
  // project tree that the next generation re-establishes from scratch, and persisting it would let
  // a stale answer outlive the enumeration that produced it.
  const [missingPaths, setMissingPaths] = useState<ReadonlySet<string>>(() => new Set());
  // The latest completed generation's two Missing-on-disk inputs. A generation and the persisted
  // tab session are independent async reads on startup, so retaining this evidence is what lets a
  // later-restored open-tab set be evaluated without waiting for another filesystem refresh
  // (#1446). The snapshot itself is not retained: its moves are one-shot events and must never be
  // replayed merely because another tab opened.
  const completedGenerationEvidence = useRef<{
    present: ReadonlySet<string>;
    undescended: ReadonlySet<string>;
  } | null>(null);
  // Recreate and Save As establish presence more recently than the completed generation currently
  // on hand. Keep that local proof until the next generation supersedes it, so re-evaluating after
  // a later tab-set change cannot put a successfully recovered document straight back into Missing.
  const presentSinceGeneration = useRef<Set<string>>(new Set());
  // The tab whose destructive close confirmation is open (`"This file no longer exists on disk…"`).
  // Separate from `guardQueue`, which is FR-ED-3's unsaved-changes guard: this one is asked even for
  // a clean tab, because the buffer is the only copy of a document with no file.
  const [missingCloseGuardPath, setMissingCloseGuardPath] = useState<string | null>(null);
  // Each open untitled document's own `[Save As…]` attempt (D12, FR-ED-8, #1379), keyed by its
  // current tab path: `saving` disables the button against a double-click racing two writes, and
  // `error` is the last attempt's failure detail (cleared on a fresh attempt, and absent for a tab
  // that has never tried). Held separately from `TabsState` for the same reason `missingPaths` is:
  // it is not session state, and a tab whose Save As hasn't run yet needs no entry at all.
  const [untitledSaveState, setUntitledSaveState] = useState<
    Map<string, { saving: boolean; error: string | null }>
  >(new Map());
  // State disables the rendered button after React commits; this ref closes the smaller same-tick
  // race and joins pane/guard entry points onto the exact same irreversible operation (9d.2).
  const untitledSaveInFlight = useRef(new Map<string, Promise<void>>());
  const untitledIdentityInFlight = useRef(new Map<string, Promise<string>>());
  const [adoptedBaselines, setAdoptedBaselines] = useState<
    Map<string, { content: string; diskContent?: string; revision: string }>
  >(new Map());
  const [provenancePendingPaths, setProvenancePendingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const applyAdoptionReconciliation = (result: AdoptionReconciliation) => {
    setProvenancePendingPaths(new Set(result.pendingDestinations));
    for (const collision of result.collisions ?? []) {
      onError?.(new UserFacingError(
        `Cowrite kept the existing comment and change history for ${collision.destination}. `
        + "The untitled document’s separate history is still preserved, and adoption will remain pending.",
      ));
    }
    if (result.published.length > 0) onPersistedTimelineCards?.(result.published);
  };
  // Each open tab's live tracked-change parse generation (UXR-Q4), keyed by path — reported up by
  // each `EditorShell.onChangeGenerationChange` as its field is (re)seeded. Only the active tab's
  // value becomes the triage target below, but every tab's is tracked so switching to a background
  // tab reports *its* generation, not a stale one.
  const [generations, setGenerations] = useState<Map<string, string | null>>(new Map());
  // Save/recovery presentation belongs to each mounted file-backed pane. Retain every pane's last
  // report so switching to a background tab selects its own state for macOS window chrome; only
  // the active path is emitted to the owner below.
  const [saveStates, setSaveStates] = useState<Map<string, DocumentSaveState | null>>(new Map());
  // Opening a tab is intentionally optimistic so its loading pane can render. Owner chrome must
  // not treat that path as current until `EditorShell` confirms the initial disk read succeeded.
  const loadedPaths = useRef<Set<string>>(new Set());
  // Only tabs newly introduced by an open request may be rolled back when their first load fails.
  // Restored tabs — especially dirty ones carrying `unsavedContent` — must remain in the session;
  // removing one would let the persistence effect discard the only durable copy of that buffer.
  const rollbackPaths = useRef<Set<string>>(new Set());
  // A legacy restored tab with no retained work may be dropped if the document command returns
  // D27's typed unsupported-type refusal. Keep dirty and over-cap snapshots out of this set: their
  // recovery policy is separate, and a session rewrite must not erase their evidence.
  const restoredCleanPaths = useRef<Set<string>>(new Set());
  // Only a legacy session's retained, file-backed edit may become an untitled recovery document
  // after D27 refuses its type. A newly opened unsupported path has no buffer to recover.
  const restoredDirtyPaths = useRef<Set<string>>(new Set());
  const recoveryStatuses = useRef(new Map<string, OwnedUserAppStatus>());
  const clearRecoveryStatus = (path: string) => {
    const owned = recoveryStatuses.current.get(path);
    if (owned) clearOwnedUserAppStatus(owned);
    recoveryStatuses.current.delete(path);
  };

  const rootRef = useRef(root);
  rootRef.current = root;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tabActivationRef = useRef({ path: tabs.activePath, generation: 0 });
  if (tabActivationRef.current.path !== tabs.activePath) {
    tabActivationRef.current = {
      path: tabs.activePath,
      generation: tabActivationRef.current.generation + 1,
    };
  }
  const commentNavigationGenerationRef = useRef(0);
  const tabFeedRef = useRef(Promise.resolve());
  // Keeps component-level producers ordered before they enter the receipt-aware IPC lane. This
  // ref is also the drain point used before a project switch releases that lane.
  const sessionSaveRef = useRef(Promise.resolve());
  const lastPersistedSession = useRef<SessionPayload | null>(null);
  const stagedDecisions = useRef(new Map<string, StagedDecision>());
  const closeAttemptGeneration = useRef(0);
  // The request whose session read has not settled yet. The tab-reporting effect must still feed
  // owner state and D21 protection during this window; only a session write is unsafe because it
  // could replace the file before the read returns (#1393).
  const pendingSessionRestoreRequest = useRef<number | null>(null);
  const restoredContentRef = useRef(restoredContent);
  restoredContentRef.current = restoredContent;
  const editorHandles = useRef(new Map<string, EditorShellHandle>());
  const refCallbacks = useRef(new Map<string, (handle: EditorShellHandle | null) => void>());
  /**
   * `path`'s live content for whatever currently holds it: the mounted `EditorShell`'s buffer when
   * one exists, else the restore-override map — the shape `toSessionPayload`'s content-getter needs
   * (`getContent()` is `undefined` until an `EditorShell`'s async load lands, and an untitled
   * document mounts no `EditorShell` at all — see `restoredContent`'s own comment above). Shared by
   * the tab-set persistence effect and the untitled scheduler below so both read the same fallback
   * order rather than each spelling it separately.
   */
  const liveContentOf = (path: string): string =>
    editorHandles.current.get(path)?.getContent() ?? restoredContentRef.current.get(path) ?? "";
  /**
   * Reads [`TabbedEditorHandle.openDocuments`] off the live tab state — see that method's docs.
   *
   * Which of the two shapes a tab takes is decided by `recoveredFrom`, the field, never by the
   * spelling of `path` — exactly as every other consumer of a tab decides it (`stores/tabs.ts`): an
   * untitled recovery document has no file, so it is named by the label its tab strip shows rather
   * than by its internal `untitled:<n>:…` identity, which is itself a legal project-relative path
   * and would be indistinguishable from one (D21, CJ 2026-08-28).
   *
   * A buffer is serialized only for an active document the envelope will actually carry it for, and
   * that decision is `isUnsaved`'s — FR-CHAT-4's own two-limb rule, imported rather than restated,
   * because a second copy of it here is precisely how an untitled document loses the only route to
   * its text. So a background tab's buffer is never materialized at all, and a clean active
   * document costs no serialization of the whole document per submit.
   */
  const openDocumentsSnapshot = (): OpenDocumentsSnapshot => {
    const { tabs, activePath } = tabsRef.current;
    const describe = (tab: TabRecord): OpenDocument =>
      isRecoveredTab(tab)
        ? { path: null, label: tabLabel(tab, tabs) }
        : { path: tab.path, dirty: tab.dirty };
    const active = tabs.find((tab) => tab.path === activePath);
    if (active === undefined) return { active: null, alsoOpen: tabs.map(describe) };
    const activeDocument = describe(active);
    return {
      active: isUnsaved(activeDocument)
        ? { ...activeDocument, content: liveContentOf(active.path) }
        : activeDocument,
      alsoOpen: tabs.filter((tab) => tab !== active).map(describe),
    };
  };
  /**
   * Adds one already-materialized snapshot to the authoritative session-write lane. The IPC facade
   * serializes it and carries the backend receipt revision into the next write; callers capture
   * both values now so a queued snapshot is never retargeted or rebuilt from later state.
   * A project switch suppresses every producer, including the untitled scheduler, until that
   * project's session read settles; writing during that window could clobber the session being read.
   */
  const queueSessionOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = sessionSaveRef.current.catch(() => undefined).then(operation);
    sessionSaveRef.current = result.then(() => undefined, () => undefined);
    return result;
  };
  const beginRecoverySession = async (projectRoot: string): Promise<SessionPayload> => {
    if (!recoveryAttempt) return beginTabSession(projectRoot);
    return recoveryAttempt.sessionGate.acquire(
      projectRoot,
      () => beginTabSession(projectRoot),
      () => endTabSession(projectRoot),
    );
  };
  const endRecoverySession = (projectRoot: string): Promise<void> => recoveryAttempt
    ? recoveryAttempt.sessionGate.end(projectRoot, () => endTabSession(projectRoot))
    : endTabSession(projectRoot);
  const saveRecoverySession = (
    projectRoot: string,
    payload: SessionPayload,
    policy?: "background" | "require_untitled_lossless",
  ): Promise<TabSessionReceipt> => {
    const save = () => policy === undefined
      ? saveTabSession(projectRoot, payload)
      : saveTabSession(projectRoot, payload, policy);
    return recoveryAttempt ? recoveryAttempt.sessionGate.save(payload, save) : save();
  };
  const enqueueSessionSave = (projectRoot: string, payload: SessionPayload): Promise<void> => {
    if (pendingSessionRestoreRequest.current !== null) return Promise.resolve();
    return queueSessionOperation(() => saveRecoverySession(projectRoot, payload))
      .then((receipt) => {
        if (receipt?.session) lastPersistedSession.current = receipt.session;
      })
      .catch((error: unknown) => onError?.(error));
  };
  const ensureUntitledIdentity = (tab: TabRecord): Promise<string> => {
    const current = tabsRef.current.tabs.find((candidate) => candidate.path === tab.path);
    if (current?.docId) return Promise.resolve(current.docId);
    const existing = untitledIdentityInFlight.current.get(tab.path);
    if (existing) return existing;
    const projectRoot = rootRef.current;
    if (!projectRoot) return Promise.reject(new Error("No project is open"));
    const operation = mintUntitledDocId(projectRoot)
      .then((docId) => queueSessionOperation(async () => {
        if (rootRef.current !== projectRoot) throw new Error("The project changed before identity was saved");
        const live = tabsRef.current.tabs.find((candidate) => candidate.path === tab.path);
        if (live?.docId) return live.docId;
        const next = setUntitledDocId(tabsRef.current, tab.path, docId);
        if (next !== tabsRef.current) {
          const payload = toSessionPayload(next, liveContentOf);
          const receipt = await saveRecoverySession(projectRoot, payload);
          if (receipt?.session) lastPersistedSession.current = receipt.session;
          tabsRef.current = next;
          setTabs(next);
        }
        return next.tabs.find((candidate) => candidate.path === tab.path)?.docId ?? docId;
      }))
      .finally(() => untitledIdentityInFlight.current.delete(tab.path));
    untitledIdentityInFlight.current.set(tab.path, operation);
    return operation;
  };
  /**
   * Debounces the whole-session write an untitled document's own edits trigger (`handleUntitledChange`
   * below), FR-X-4: a write per keystroke — a full `toSessionPayload` serialization of every open
   * tab plus a blocking IPC round trip — freezes the UI, which is exactly what `editor/autosave.ts`
   * exists to prevent for an ordinary document's autosave. One scheduler for the whole session
   * (not one per untitled tab) because the write it debounces is already whole-session. Each
   * invocation reads the current refs and materializes its snapshot before enqueueing those captured
   * values through #1822's serialized lane. That lane already sequences writes, so another runner
   * in front of it would only delay capture and let a project switch retarget a trailing flush.
   *
   * The tab-set-change persistence effect below enqueues a complete snapshot on every
   * open/close/switch/dirty transition, then cancels any pending debounced write on the same change —
   * the fresh queued snapshot makes the stale one redundant, not a data-loss risk.
   * `onBlur` is the ordinary flush point. Native close does not trust that debounce at all: the
   * coordinated close composes the live buffers directly and awaits the authoritative final
   * receipt/proof before allowing destruction.
   */
  const untitledScheduler = useRef<AutosaveScheduler | null>(null);
  if (untitledScheduler.current === null) {
    untitledScheduler.current = createAutosaveScheduler(() => {
      const projectRoot = rootRef.current;
      if (!projectRoot) return;
      const payload = toSessionPayload(tabsRef.current, liveContentOf);
      void enqueueSessionSave(projectRoot, payload);
    });
  }
  // How many times a path's pane has been mounted. A pane is keyed by path, which is the identity
  // React reconciles on; the count is what lets a path's pane be replaced rather than reused when
  // the document living at that path changes underneath it (see `applyProjectFileMoves`).
  const paneMounts = useRef(new Map<string, number>());
  const processedRequestId = useRef<number | null>(null);
  // Every change set already applied, not merely the most recent one: a single slot only catches a
  // *consecutive* repeat, so any re-render carrying an older set would re-apply it and revert the
  // buffer past a newer delivery. Bounded by the deliveries in one panel mount, which is small.
  const appliedChangeSetIds = useRef(new Set<string>());
  // Async visibility answers are fenced by reconciliation order: a slower answer for an older
  // generation or open-tab set must never replace the Missing set established by newer evidence.
  const missingEvaluation = useRef(0);
  const quittingRef = useRef(false);
  const coordinatedCloseRef = useRef<() => void>(() => {});
  const lifecycleEpoch = useRef(0);
  const mountedRef = useRef(true);

  // React StrictMode probes effects with a setup→cleanup→setup cycle. Defer the release one
  // microtask so that probe can cancel it by advancing the epoch, while a real unmount drains and
  // releases the lane before this renderer later tries to reopen the same project.
  useEffect(() => {
    mountedRef.current = true;
    const epoch = ++lifecycleEpoch.current;
    return () => {
      // An untitled buffer's debounce closes over this component's refs. Cancel it synchronously:
      // after unmount it must not enqueue a stale snapshot into a later test/window/project's
      // mocked or reacquired writer lane. StrictMode's probe cleanup is safe because `cancel()`
      // only clears the pending timer; the retained scheduler can be scheduled again after setup.
      untitledScheduler.current?.cancel();
      queueMicrotask(() => {
        if (lifecycleEpoch.current !== epoch) return;
        mountedRef.current = false;
        for (const path of recoveryStatuses.current.keys()) clearRecoveryStatus(path);
        const projectRoot = rootRef.current;
        if (projectRoot) {
          void sessionSaveRef.current
            .catch(() => undefined)
            .then(() => endRecoverySession(projectRoot))
            .catch((error: unknown) => onError?.(error));
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this is component lifetime, not props.
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      saveActiveDocumentAs: async () => {
        if (sessionFinalizingRef.current) return false;
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return false;
        return (await editorHandles.current.get(activePath)?.saveAs()) ?? false;
      },
      setAutosaveSettings: (settings) => {
        for (const editor of editorHandles.current.values()) editor.setAutosaveSettings(settings);
      },
      decideChanges: (ids, decision) => {
        if (sessionFinalizingRef.current) return null;
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return null;
        return editorHandles.current.get(activePath)?.decideChanges(ids, decision) ?? null;
      },
      changeGeneration: () => {
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return null;
        return editorHandles.current.get(activePath)?.changeGeneration() ?? null;
      },
      focusAnchor: async (anchor) => {
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return false;
        return (await editorHandles.current.get(activePath)?.focusAnchor(anchor)) ?? false;
      },
      revealCommentThread: async (thread) => {
        const navigationGeneration = ++commentNavigationGenerationRef.current;
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return false;
        const activationGeneration = tabActivationRef.current.generation;
        return (await editorHandles.current.get(activePath)?.revealCommentThread(
          thread, () => tabsRef.current.activePath === activePath
            && tabActivationRef.current.generation === activationGeneration
            && commentNavigationGenerationRef.current === navigationGeneration,
        )) ?? false;
      },
      cancelCommentReveal: () => { commentNavigationGenerationRef.current += 1; },
      focusChange: (changeId) => {
        const activePath = tabsRef.current.activePath;
        if (activePath === null) return false;
        return editorHandles.current.get(activePath)?.focusChange(changeId) ?? false;
      },
      openDocuments: openDocumentsSnapshot,
      applyCompletedGeneration: (snapshot) => {
        if (sessionFinalizingRef.current) return;
        applyCompletedGeneration(snapshot);
      },
    }),
    [],
  );

  /** Re-evaluates one open-tab set against the latest completed generation on hand. */
  function reconcileMissingPaths(currentTabs: TabsState) {
    const evaluation = ++missingEvaluation.current;
    const evidence = completedGenerationEvidence.current;
    if (evidence === null) return;
    const present =
      presentSinceGeneration.current.size === 0
        ? evidence.present
        : new Set([...evidence.present, ...presentSinceGeneration.current]);
    const candidates = missingTabPaths(currentTabs, present, evidence.undescended);
    if (candidates.length === 0) {
      setMissingPaths((previous) => (sameMembers(previous, candidates) ? previous : new Set()));
      return;
    }

    void Promise.all(
      candidates.map(async (path) => ((await isProjectPathEnumerable(path)) ? path : null)),
    )
      .then((answers) => {
        if (evaluation !== missingEvaluation.current) return;
        const missing = answers.filter((path): path is string => path !== null);
        setMissingPaths((previous) => (sameMembers(previous, missing) ? previous : new Set(missing)));
      })
      .catch((error: unknown) => {
        if (evaluation !== missingEvaluation.current) return;
        // The generation did prove these paths absent; only their hidden/tooling exemption is
        // unknown. Fail toward J2 protection so autosave cannot recreate a genuinely deleted file.
        setMissingPaths((previous) =>
          sameMembers(previous, candidates) ? previous : new Set(candidates),
        );
        onError?.(error);
      });
  }

  /**
   * One completed generation reaching document identity: follow its proven moves, retain both
   * halves of its Missing-on-disk evidence, then evaluate the tab state those moves produced.
   * `tabsRef` is updated synchronously by `applyProjectFileMoves`, so this sees the post-move paths
   * even though React has not re-rendered yet — which is what keeps the set keyed to the paths the
   * tabs actually have.
   *
   * Retaining the evidence (but not replayable moves) makes this a real two-input reconciliation:
   * the effect below runs the same evaluation when session restore or another open/close transition
   * changes the open-tab set after this generation has already landed (#1446). Every otherwise
   * absent candidate is qualified through TD-18's backend-owned visibility predicate, since absence
   * can prove deletion only where the scanner would enumerate that path (#1444).
   */
  function applyCompletedGeneration(snapshot: ProjectFilesSnapshot) {
    applyProjectFileMoves(snapshot.moves);
    completedGenerationEvidence.current = {
      present: presentFilePaths(snapshot.entries),
      undescended: undescendedPaths(snapshot.entries),
    };
    presentSinceGeneration.current.clear();
    reconcileMissingPaths(tabsRef.current);
  }

  /**
   * Rekeys every path-keyed thing this layer holds for the tabs TD-18 proved moved (#932).
   *
   * A moved tab's `EditorShell` necessarily reloads — it is keyed on the path, and even in place it
   * reads its document from `(root, path)` — so a *dirty* tab's live text is captured here and
   * handed to the remount as its `initialContent` seed, exactly the way a restored dirty tab is
   * rehydrated. That is what makes a rename carry the *buffer* and not just the tab: without it the
   * reload would silently replace unsaved work with whatever is on disk at the new path. A clean
   * tab carries nothing and loads the new path from disk: its buffer *is* the old file's content,
   * so seeding it would hide a file that genuinely changed behind text matching neither side, with
   * the FR-ED-7 poller comparing the new disk content against itself and never offering
   * reload/keep-mine/merge.
   *
   * `loadedPaths` is rekeyed rather than cleared so the active marker moves straight to the new
   * path instead of blinking through "nothing is loaded" while the reload lands — the document was
   * never closed, only renamed. The parse generation and editor handle are *not* carried: the
   * remounted editor mints its own, and a stale one would let a change-set card believe it still
   * corresponds (UXR-Q4 fails closed on a missing generation, which is the honest state here).
   *
   * A destination that is itself an open document's path is a displacement (CJ, 2026-08-11; J2):
   * the moved document becomes the sole document there, so the destination's *own* editor state is
   * evicted too — it describes a different document now — and the displaced document's unsaved work
   * leaves with it, as the untitled recovery document `recoveredTabPaths` names.
   */
  // @anchor:untitled-handle-delete-on-rekey
  function applyProjectFileMoves(moves: readonly ProjectFileMove[], prewrittenAdoptedDestination?: string) {
    const current = tabsRef.current;
    const rekeyed = current.tabs
      .map((tab) => ({ from: tab.path, to: movedPath(tab.path, moves) }))
      .filter((entry): entry is { from: string; to: string } => entry.to !== null);
    if (rekeyed.length === 0) return;
    const recovered = recoveredTabPaths(current, moves);
    const dirtyPaths = new Set(current.tabs.filter((tab) => tab.dirty).map((tab) => tab.path));

    // Read the live buffers *now*, not inside the updater below: a state updater is not guaranteed
    // to run synchronously, and by the time React invokes it these handles have been dropped and the
    // moved tab's `EditorShell` unmounted — the carried text would silently come back `undefined`
    // and the reload would replace the user's unsaved work with whatever is on disk.
    const carried = [...rekeyed.filter(({ from }) =>
      dirtyPaths.has(from) || current.tabs.some((tab) => tab.path === from && tab.surfaceIdentity),
    ), ...recovered].map(
      ({ from, to }) => ({ from, to, content: editorHandles.current.get(from)?.getContent() }),
    );
    // Every identity whose editor state this transition invalidates: each old path, and each
    // destination — which either had no editor at all, or had the *displaced* document's, whose
    // handle, parse generation, and restore override all describe a document that no longer lives
    // there. (A displaced path is always some move's destination, so this covers it.)
    const evicted = rekeyed.flatMap(({ from, to }) => [from, to]);
    for (const path of evicted) {
      const handle = editorHandles.current.get(path);
      handle?.retireDictationTarget();
      handle?.retireAutosaveForMove();
    }
    setAdoptedBaselines((previous) => {
      if (!evicted.some((path) => previous.has(path))) return previous;
      const next = new Map(previous);
      const carried = rekeyed
        .filter(({ from }) => current.tabs.some((tab) => tab.path === from && tab.surfaceIdentity))
        .map(({ from, to }) => ({
          to,
          baseline: previous.get(from)
            ?? (to === prewrittenAdoptedDestination ? previous.get(to) : undefined),
        }));
      for (const path of evicted) next.delete(path);
      for (const { to, baseline } of carried) {
        if (baseline) next.set(to, baseline);
      }
      return next;
    });
    setRestoredContent((previous) => {
      const next = new Map(previous);
      for (const path of evicted) next.delete(path);
      for (const { from, to, content } of carried) {
        // A tab restored but not yet hydrated has no live editor to read; its restore override is
        // still the only copy of that buffer, so it carries instead.
        const buffer = content ?? previous.get(from);
        if (buffer !== undefined) next.set(to, buffer);
      }
      return next;
    });
    setGenerations((previous) => {
      const next = new Map(previous);
      for (const path of evicted) next.delete(path);
      return next;
    });
    setSaveStates((previous) => {
      const next = new Map(previous);
      for (const path of evicted) next.delete(path);
      return next;
    });
    for (const paths of [loadedPaths.current, rollbackPaths.current, restoredCleanPaths.current]) {
      const moved = rekeyed.filter(({ from }) => paths.has(from)).map(({ to }) => to);
      for (const path of evicted) paths.delete(path);
      for (const path of moved) paths.add(path);
    }
    for (const path of evicted) {
      editorHandles.current.delete(path);
      refCallbacks.current.delete(path);
    }
    // A destination that was already open keeps its React key through this transition, so React
    // would *reuse* the displaced document's mounted `EditorShell` — same key, same `(root, path)`
    // deps, no reload — and the moved document's carried buffer would never be read while the
    // displaced document's text sat under the moved document's identity (a save would then write
    // the wrong document to that path). Counting the mount gives the survivor a genuinely new key.
    for (const { to } of rekeyed) {
      if (current.tabs.some((tab) => tab.path === to)) {
        paneMounts.current.set(to, (paneMounts.current.get(to) ?? 0) + 1);
      }
    }
    const next = rekeyTabPaths(current, moves);
    tabsRef.current = next;
    setTabs(next);
  }

  // Records one tab's live parse generation (UXR-Q4) as its `EditorShell` reports a (re)seed. A
  // no-op when unchanged so a re-seed to the same generation doesn't churn the triage-target effect.
  const recordGeneration = (path: string, generation: string | null) => {
    setGenerations((prev) => {
      if (prev.has(path) && prev.get(path) === generation) return prev;
      const next = new Map(prev);
      next.set(path, generation);
      return next;
    });
  };

  const recordSaveState = (path: string, state: DocumentSaveState | null) => {
    setSaveStates((previous) => {
      const prior = previous.get(path);
      if (
        prior?.kind === state?.kind &&
        (prior?.kind !== "saved" || (state?.kind === "saved" && prior.at === state.at))
      ) {
        return previous;
      }
      const next = new Map(previous);
      next.set(path, state);
      return next;
    });
  };

  const paneKeyFor = (tab: TabRecord) => {
    const identity = tab.surfaceIdentity ?? tab.path;
    return `${identity}#${paneMounts.current.get(identity) ?? 0}`;
  };

  // A stable ref-callback per tab path, cached across renders — an inline arrow function passed
  // straight to `ref` would get a new identity every render, making React detach+reattach every
  // open tab's `EditorShellHandle` on every state change (any keystroke's dirty transition
  // included) even though nothing about the mounted `EditorShell` itself changed.
  const editorRefFor = (path: string) => {
    let cb = refCallbacks.current.get(path);
    if (!cb) {
      cb = (handle) => {
        if (handle) editorHandles.current.set(path, handle);
        else editorHandles.current.delete(path);
      };
      refCallbacks.current.set(path, cb);
    }
    return cb;
  };

  // Processes each distinct dev-only test-hook request exactly once, in order (D23).
  useEffect(() => {
    if (processedRequestId.current === request.id) return;
    processedRequestId.current = request.id;
    // A request is an event, not deferred intent. Once close finalization captures its immutable
    // payload, acknowledge a later request without replaying it into a window that is closing.
    if (sessionFinalizingRef.current) {
      onRequestProcessed?.(request.id);
      return;
    }

    (async () => {
      try {
        if (request.root !== rootRef.current) {
          pendingSessionRestoreRequest.current = request.id;
          const previousRoot = rootRef.current;
          // The visible root and all root-scoped state remain owned by the previous project until
          // the outgoing lane has drained and the backend has granted the new authority. A refused
          // begin therefore commits nothing and the next request retries instead of bypassing the
          // authority boundary through an optimistically changed `rootRef`.
          await sessionSaveRef.current.catch(() => undefined);
          const session = await beginRecoverySession(request.root);
          // The outgoing save and authority acquisition are asynchronous. A native close can latch
          // finalization while either is pending, so recheck at the commit boundary as well as at
          // effect entry; the immutable close payload must remain the only state that can win.
          if (!mountedRef.current || sessionFinalizingRef.current) {
            await endRecoverySession(request.root);
            return;
          }
          loadedPaths.current.clear();
          rollbackPaths.current.clear();
          restoredCleanPaths.current.clear();
          restoredDirtyPaths.current.clear();
          for (const path of recoveryStatuses.current.keys()) clearRecoveryStatus(path);
          completedGenerationEvidence.current = null;
          presentSinceGeneration.current.clear();
          missingEvaluation.current += 1;
          setMissingPaths(new Set());
          setSaveStates(new Map());
          setReadyRoot(null);
          setRoot(request.root);
          rootRef.current = request.root;
          lastPersistedSession.current = session;
          stagedDecisions.current.clear();
          setSessionFailure(null);
          setSessionFinalizing(false);
          void reconcileAdoptions(request.root)
            .then((result) => {
              if (rootRef.current !== request.root) return;
              applyAdoptionReconciliation(result);
            })
            .catch((error: unknown) => onError?.(error));
          const restored = restoreFromSession(session);
          restoredCleanPaths.current = new Set(
            session.tabs
              .filter((tab) =>
                tab.recoveredFrom === null &&
                tab.unsavedContent === null &&
                tab.unsavedContentOmitted !== true
              )
              .map((tab) => tab.path),
          );
          restoredDirtyPaths.current = new Set(
            session.tabs
              .filter((tab) =>
                tab.recoveredFrom === null && tab.unsavedContent !== null
              )
              .map((tab) => tab.path),
          );
          const overrides = new Map<string, string>();
          for (const tab of session.tabs) {
            if (tab.unsavedContent !== null) overrides.set(tab.path, tab.unsavedContent);
          }
          if (request.path !== null && !restored.tabs.some((tab) => tab.path === request.path)) {
            rollbackPaths.current.add(request.path);
          }
          const nextTabs = request.path === null ? restored : openTab(restored, request.path);
          // Keep the imperative snapshots in step with the state commit even when React batches the
          // render until after the outgoing release. They are the exact new-root state the explicit
          // post-release checkpoint below must persist; later edits still replace them on render.
          restoredContentRef.current = overrides;
          tabsRef.current = nextTabs;
          setRestoredContent(overrides);
          setTabs(nextTabs);
          setReadyRoot(request.root);
          if (previousRoot) {
            await endRecoverySession(previousRoot).catch((error: unknown) => onError?.(error));
            // The tab effect may already have observed `nextTabs` while restore suppression was
            // still active. Clearing a ref does not rerender, so checkpoint the latest new-root
            // payload explicitly after the old lane releases. Fence both request and root: a later
            // transition must never be serialized back into this acquired root.
            if (
              pendingSessionRestoreRequest.current === request.id &&
              rootRef.current === request.root
            ) {
              pendingSessionRestoreRequest.current = null;
              await enqueueSessionSave(
                request.root,
                toSessionPayload(tabsRef.current, liveContentOf),
              );
            }
          }
        } else {
          const requestedPath = request.path;
          if (
            requestedPath !== null &&
            !tabsRef.current.tabs.some((tab) => tab.path === requestedPath)
          ) {
            rollbackPaths.current.add(requestedPath);
          }
          if (requestedPath !== null) setTabs((current) => openTab(current, requestedPath));
        }
      } catch (error) {
        if (recoveryAttempt?.token.phase === "remount") recoveryAttempt.failed();
        onError?.(error);
      } finally {
        if (pendingSessionRestoreRequest.current === request.id) {
          pendingSessionRestoreRequest.current = null;
        }
        onRequestProcessed?.(request.id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when `request` changes
  }, [request]);

  // The other half of #1446's two-input reconciliation. Only tab identities participate: changing
  // the active tab or dirty flag does not change the open set and must not reconsider a recovery
  // action against an older generation. A generation that landed before the begin snapshot resolves
  // is retained above, so the authoritative begin snapshot reaches the same calculation here.
  const openTabIdentityKey = JSON.stringify(
    tabs.tabs.map((tab) => [tab.path, tab.recoveredFrom ?? null]),
  );
  useEffect(() => {
    reconcileMissingPaths(tabs);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialized open identities are
    // the input; active/dirty changes deliberately do not re-run Missing reconciliation.
  }, [openTabIdentityKey]);

  // Routes each agent delivery into the tab that has its document open (#346). Keyed on
  // `changeSetId` rather than on the prop's object identity, so an owner that re-renders (or
  // rebuilds the object) can never re-apply a set — the editor handle reseeds the whole
  // tracked-change snapshot, so a second application would wipe out triage decisions already made.
  // Deliberately does *not* focus, switch to, or open a tab: a delivery to a background document
  // stays in the background (UX Principle 2 — only the pending-change counter and the card move).
  useEffect(() => {
    if (!delivery || appliedChangeSetIds.current.has(delivery.changeSetId)) return;
    const handle = editorHandles.current.get(delivery.doc);
    // No tab open on the delivered doc: nothing to reseed. Still marked applied, so a later
    // re-render doesn't retry a delivery whose moment has passed.
    appliedChangeSetIds.current.add(delivery.changeSetId);
    if (!handle) return;
    handle.applyDelivery(delivery.content, delivery.changes, delivery.generation);
  }, [delivery]);

  // The active tab's triage target (UXR-Q4): its path plus its live parse generation, re-emitted
  // whenever the active tab changes or that tab's generation moves (a delivery reseed, a reload, or
  // the initial mount seed). `App` fans this out to every change-set card so a card whose document
  // or parse no longer matches the live field disables its own triage rather than deciding the wrong
  // text. `null` when no tab is active — every card then reads as mismatched (nothing to triage
  // into), which is the correct fail-closed state for workshop mode.
  useEffect(() => {
    const activePath = tabs.activePath;
    onTriageTargetChange?.(
      activePath === null ? null : { doc: activePath, generation: generations.get(activePath) ?? null },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onTriageTargetChange identity shouldn't
    // retrigger this; it re-runs only when the active tab or a tab's generation changes.
  }, [tabs.activePath, generations]);

  // Persists the whole session on every change to the tab set (open/close/switch/dirty) — one
  // place, so every code path that touches `tabs` (not just an explicit "close" action) keeps
  // `store::tab_session` current, covering both halves of FR-ED-3's restore requirement (the open
  // tab set, and dirty tabs' capped unsaved content).
  useEffect(() => {
    const projectRoot = rootRef.current;
    if (!projectRoot) return;
    // What the owner is told is active: the active tab's path when it is a *project document*, and
    // `null` when it is not one — no tab at all, or an untitled recovery document, whose buffer has
    // no file and cannot be an agent operation target (J2, CJ 2026-08-11). Resolved here
    // rather than by the shell because the record carrying that fact lives here; every surface keyed
    // on "which project document is active" — comment threads, a run's D21 operation targets, the
    // rail's active row — then reads "none" without re-deriving it from a path it cannot classify.
    const activeDocumentPath = activeProjectDocumentPath(tabs);
    const payload = toSessionPayload(tabs, liveContentOf);
    // The IPC facade serializes this under one backend writer token and CAS revision; `payload`
    // itself is still captured now so a deferred call sends the snapshot current at this change.
    // This effect always fires once on mount. The request effect keeps `rootRef` on the prior root
    // until the new begin snapshot grants authority, while `pendingSessionRestoreRequest` also
    // suppresses writes during that acquisition. A cross-root transition explicitly checkpoints
    // the latest new-root payload after the old lane releases because clearing the suppression ref
    // alone cannot rerun this effect; later tab changes then persist normally. A refused begin
    // cannot disable D21 protection or owner state for the owned project.
    if (!quittingRef.current) void enqueueSessionSave(projectRoot, payload);
    // The current complete payload was enqueued above before the older debounced untitled-buffer
    // request is cancelled, so cancelling that stale request cannot discard the latest tab state.
    untitledScheduler.current?.cancel();
    // Serialize whole-set snapshots so quick transitions cannot arrive out of order and resurrect
    // a tab that the later UI state already closed.
    // An untitled recovery document is conceptually inside D21's protected scope because it is open
    // in a tab, but this filter deliberately keeps it out of the backend's operative protected set:
    // without a file there is nothing to watch, rekey on move, or deliver tracked changes into. Its
    // protection is vacuous, not absent. Which tabs those are is the record's own
    // `recoveredFrom`, never the shape of a path — a project document legitimately named
    // `untitled:1:notes.md` is a real document and must stay protected (CJ, 2026-08-12).
    // @anchor:functional-spec-open-doc-paths-filter
    const openDocumentPaths = tabs.tabs.filter((tab) => !isRecoveredTab(tab)).map((tab) => tab.path);
    tabFeedRef.current = tabFeedRef.current.catch(() => {}).then(() => {
      if (recoveryAttempt) {
        return recoveryAttempt.sessionGate.publishOpenTabs(
          () => setOpenTabs(projectRoot, openDocumentPaths, activeDocumentPath),
        );
      }
      return setOpenTabs(projectRoot, openDocumentPaths, activeDocumentPath);
    }).catch((error: unknown) => onError?.(error));
    // P2b-6b: the only place that can tell `App` "the open-tab set became/stopped being empty" —
    // in particular "the last tab just closed," which is what returns the app to workshop mode
    // (ux-design §4). Riding this effect's existing `tabs`-change/`projectRoot`-set guard means it
    // never fires before a request has actually landed (a fresh mount with no root yet).
    onTabsChange?.(tabs.tabs.length > 0);
    // #411: the same "one place" argument above applies to which document is active — open/close/
    // switch are exactly the transitions that can change `tabs.activePath`, so reporting it here
    // (rather than a second effect keyed on `tabs.activePath` alone) can't drift out of step with
    // `onTabsChange`'s own accounting of the same `tabs` change.
    onActivePathChange?.(activeDocumentPath);
    const activeTab = tabs.tabs.find((tab) => tab.path === tabs.activePath);
    onActiveUnsupportedRecoveryTitleChange?.(
      activeTab && isRecoveredTab(activeTab) && !isSupportedDocumentPath(activeTab.recoveredFrom)
        ? `Untitled — from ${activeTab.recoveredFrom}`
        : null,
    );
    onActiveCommentOwnerChange?.(
      activeTab === undefined
        ? null
        : isRecoveredTab(activeTab)
          ? activeTab.docId
            ? { kind: "id", docId: activeTab.docId, label: tabLabel(activeTab, tabs.tabs) }
            : null
          : { kind: "path", path: activeTab.path },
    );
    // A recovery document never "loads" — there is nothing to read — but the transition to it must
    // still be reported, as `null`: the row it was displaced from belongs to the moved document
    // now, and without this the rail would keep marking that row for a document that is no longer
    // there. `null` reaches the owner immediately for the same reason it needs no load.
    if (activeDocumentPath === null || loadedPaths.current.has(activeDocumentPath)) {
      onConfirmedActivePathChange?.(activeDocumentPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- owner callback identities shouldn't
    // retrigger this on their own; it re-runs only when `tabs` itself changes.
  }, [tabs]);

  // A pathless document's controls stay absent until its UUID is present in an acknowledged
  // session checkpoint. That makes the first possible sidecar write occur strictly after identity
  // durability, while legacy snapshots without `docId` upgrade in place without losing content.
  useEffect(() => {
    const projectRoot = rootRef.current;
    if (!projectRoot || readyRoot !== projectRoot) return;
    for (const tab of tabs.tabs) {
      if (!isRecoveredTab(tab) || tab.docId || untitledIdentityInFlight.current.has(tab.path)) continue;
      void ensureUntitledIdentity(tab).catch((error: unknown) => onError?.(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tab/root readiness owns this upgrade.
  }, [tabs, readyRoot]);

  // Keep the established tab/workshop owner notification above ahead of the new window-chrome
  // projection on a restored-tab commit. In particular, observing a pane's disk read must never
  // leave App waiting behind an unrelated save-state notification to exit workshop mode.
  useEffect(() => {
    const activePath = activeProjectDocumentPath(tabs);
    onActiveSaveStateChange?.(activePath === null ? null : (saveStates.get(activePath) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- owner callback identity shouldn't
    // retrigger this; active document identity or one pane's reported state are the only inputs.
  }, [tabs.activePath, tabs.tabs, saveStates]);

  // Readiness follows the completed session restore, not the first non-empty `onTabsChange`.
  // Declaring this after the persistence/tab-reporting effect above also means all restore state
  // (including a dirty tab's content override) is committed before App can drain early generations.
  useEffect(() => {
    if (readyRoot === null || readyRoot !== rootRef.current) return;
    onTabsReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback identity must not turn this
    // one-shot readiness transition into another notification for the same restored root.
  }, [readyRoot]);

  /**
   * Returns the author to where the close attempt took them from (J2, § *Save-as latching,
   * session-write finalization, and focus*). Only ever called for an attempt that ended having
   * changed nothing, which is why one destination serves cancelling and a refused close alike.
   */
  const restorePreCloseFocus = () => {
    if (preCloseFocusRef.current?.isConnected) preCloseFocusRef.current.focus();
  };

  // The pane is `inert` while the freeze holds, so focus cannot return until React has committed
  // the render that lifts it — a microtask queued beside `setSessionFinalizing(false)` would run
  // against the still-inert subtree. This effect is that commit (UXR-Q20.4, CJ 2026-09-05).
  // #2345: jsdom does not enforce `inert`, and D23 cannot enter this native refused-close path;
  // current tests verify the restore request, not the browser's focus timing after unfreeze.
  useEffect(() => {
    if (sessionFinalizing || !restoreFocusOnUnfreezeRef.current) return;
    restoreFocusOnUnfreezeRef.current = false;
    restorePreCloseFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the freeze lifting is the only input;
    // the ref is read, never subscribed to.
  }, [sessionFinalizing]);

  const finalizeCloseAttempt = async (retrying = false) => {
    const projectRoot = rootRef.current;
    const baseline = lastPersistedSession.current;
    if (!projectRoot || baseline === null) {
      quittingRef.current = false;
      return;
    }
    // `beginCoordinatedClose` owns one stable generation before its first await. A retry remains
    // part of that retained attempt; cancellation/override advance the counter to fence callbacks.
    const generation = closeAttemptGeneration.current;
    const live = toSessionPayload(tabsRef.current, liveContentOf);
    const proposed = composeProposedSession(live, stagedDecisions.current);
    const delta = !materiallyEqualSession(proposed, baseline);
    const affectedLabels = affectedUntitledTabs(baseline, proposed, stagedDecisions.current);
    // The immutable payload excludes provisional speech. Revoke every mounted editor target
    // before the pane freezes so a late owner Final cannot enter the already-composed text.
    for (const handle of editorHandles.current.values()) handle.retireDictationTarget();
    // The pane becomes inert for this immutable payload. Move focus to its non-inert shell owner
    // first; leaving focus inside an inert subtree makes the close state unreachable to keyboard
    // and assistive-technology users.
    closeAttemptTargetRef.current?.focus();
    sessionFinalizingRef.current = true;
    setSessionFinalizing(true);
    setSessionFailure((current) => current && retrying ? { ...current, retrying: true } : null);
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    if (delta) statusTimer = setTimeout(() => setSessionSavingVisible(true), 400);
    try {
      const receipt = await queueSessionOperation<TabSessionReceipt>(() =>
        delta
          ? saveRecoverySession(projectRoot, proposed, "require_untitled_lossless")
          : proveTabSession(projectRoot, proposed),
      );
      if (generation !== closeAttemptGeneration.current) return;
      const recoveryPaths = new Set(
        proposed.tabs.filter((tab) => tab.recoveredFrom !== null).map((tab) => tab.path),
      );
      const recoveryOutcomes = receipt.outcomes.filter((outcome) => recoveryPaths.has(outcome.path));
      const proofExact = recoveryOutcomes.length === recoveryPaths.size
        && recoveryOutcomes.every((outcome) => outcome.status === "persisted_exact");
      if (!proofExact) {
        throw { kind: "SessionProofUnusable", message: "Cowrite could not confirm every untitled buffer was stored exactly" };
      }
      lastPersistedSession.current = receipt.session;
      stagedDecisions.current.clear();
      quittingRef.current = false;
      setSessionFailure(null);
      try {
        await closeWindow();
      } catch (closeError: unknown) {
        // The session is committed; only the window refused to close. Letting this fall into the
        // catch below would raise the write-failure dialog, telling the author no new session was
        // committed when one was — and pointing them at an older session that will not reopen
        // (#2327). J2's write-failure disclosure describes a failed write, not a failed close.
        //
        // The queue's closes are carried out by the window going away, so a window that stays open
        // has carried out none of them: the session just committed describes tabs that are still on
        // screen. Put back the session that describes the real window before anything else can
        // write — otherwise the next ordinary write resurrects a discarded untitled document with
        // nobody asked, and a kill in between reopens a window the author never got.
        //
        // Only a write can need putting back: the no-delta path proves the durable session without
        // writing, and J2 keeps it that way ("it does not write again"). A newer attempt owns the
        // session once the generation moves, so a superseded one must not write behind it. The lane
        // itself declines while a project switch is reading a session — that switch is replacing
        // the very tab set this would describe.
        if (delta && generation === closeAttemptGeneration.current) {
          await enqueueSessionSave(projectRoot, toSessionPayload(tabsRef.current, liveContentOf));
        }
        // The attempt is over and the window is still here with everything in it, so the author
        // gets their place back — the destination cancelling already uses, requested here and
        // carried out by the effect above once the freeze lifts.
        if (generation === closeAttemptGeneration.current) restoreFocusOnUnfreezeRef.current = true;
        onError?.(new UserFacingError(
          `The window didn’t close, so nothing was closed or discarded. ${errorDetail(closeError)}`,
        ));
      }
    } catch (error: unknown) {
      if (generation !== closeAttemptGeneration.current) return;
      if (backendErrorKind(error) === "UntitledContentOmitted") {
        sessionFinalizingRef.current = false;
        setSessionFinalizing(false);
        const firstOverCap = tabsRef.current.tabs.find(
          (tab) => isRecoveredTab(tab) && exceedsSessionContentCap(liveContentOf(tab.path)),
        );
        if (firstOverCap) {
          setGuardQueue((queue) => [firstOverCap.path, ...queue.filter((path) => path !== firstOverCap.path)]);
          return;
        }
      }
      setSessionFailure({
        affectedLabels,
        detail: errorDetail(error),
        baseline: backendErrorKind(error) === "SessionProofUnusable"
          ? "unknown"
          : baseline.tabs.length === 0 ? "none" : "prior",
        retrying: false,
      });
    } finally {
      if (statusTimer !== undefined) clearTimeout(statusTimer);
      if (generation === closeAttemptGeneration.current) {
        sessionFinalizingRef.current = false;
        setSessionSavingVisible(false);
        setSessionFinalizing(false);
      }
    }
  };

  const beginCoordinatedClose = async () => {
    if (quittingRef.current) return;
    // Acquire the native-close attempt before FR-X-11's awaited IPC. A second native event in that
    // window joins this attempt instead of starting another preflight and terminal write/proof.
    quittingRef.current = true;
    const generation = ++closeAttemptGeneration.current;
    preCloseFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    let runState: Awaited<ReturnType<typeof getRunState>>;
    try {
      // @anchor:tabbed-editor-run-state-preflight
      runState = await getRunState();
    } catch (error: unknown) {
      if (generation === closeAttemptGeneration.current) {
        quittingRef.current = false;
        onError?.(error);
      }
      return;
    }
    if (generation !== closeAttemptGeneration.current) return;
    if (runState.active?.phase.phase === "running") {
      quittingRef.current = false;
      if (onRunActiveCloseRefused) {
        onRunActiveCloseRefused({
          runId: runState.active.id,
          returnFocusTo: preCloseFocusRef.current,
          fallbackFocusTarget: closeAttemptTargetRef.current,
        });
      } else {
        onError?.(new Error(`${runState.active.id} is still running. Stop it first, then close — nothing has been closed or saved.`));
      }
      return;
    }
    stagedDecisions.current.clear();
    const guarded = tabsRequiringCloseGuard(
      tabsRef.current,
      tabsRef.current.tabs.map((tab) => tab.path),
    );
    setGuardQueue(guarded);
    if (guarded.length === 0) void finalizeCloseAttempt();
  };
  coordinatedCloseRef.current = () => void beginCoordinatedClose();

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const trigger = () => coordinatedCloseRef.current();
    testHarness.requestCoordinatedClose = trigger;
    return () => {
      if (testHarness.requestCoordinatedClose === trigger) testHarness.requestCoordinatedClose = null;
    };
  }, []);

  useEffect(() => {
    if (!recoveryAttempt) return;
    recoveryAttempt.registry.patch(recoveryAttempt.token, {
      closeGuards: {
        dirty: tabs.tabs.some((tab) => tab.dirty),
        untitled: tabs.tabs.some(isRecoveredTab),
        reviewerDraft: false,
      },
    });
  }, [recoveryAttempt, tabs]);

  // Installed once — `getTabs` reads `tabsRef` fresh on every close attempt, so the listener
  // itself never needs re-registering just because `tabs` changed (that would mean an extra
  // native-window IPC round trip on every keystroke-driven dirty transition).
  useEffect(() => {
    if (recoveryAttempt) {
      recoveryAttempt.registry.registerOrdinaryClose(
        recoveryAttempt.token,
        () => coordinatedCloseRef.current(),
      );
      return () => recoveryAttempt.registry.registerOrdinaryClose(recoveryAttempt.token, null);
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    installQuitGuard(
      () => tabsRef.current,
      () => {},
      undefined,
      () => void beginCoordinatedClose(),
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [recoveryAttempt]);

  useEffect(() => {
    if (quittingRef.current && guardQueue.length === 0 && !sessionFinalizing && sessionFailure === null) {
      void finalizeCloseAttempt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finalization is edge-triggered by the queue.
  }, [guardQueue]);

  // @anchor:untitled-handle-delete-on-close
  const closeTabNow = (path: string) => {
    setTabs((current) => closeTab(current, path));
    // A closed tab is no longer a document whose file can be missing — and a reopened one is
    // re-evaluated by the next generation, so a lingering entry could only mislead.
    setMissingPaths((previous) => withoutPath(previous, path));
    setMissingCloseGuardPath((current) => (current === path ? null : current));
    loadedPaths.current.delete(path);
    rollbackPaths.current.delete(path);
    restoredCleanPaths.current.delete(path);
    restoredDirtyPaths.current.delete(path);
    clearRecoveryStatus(path);
    editorHandles.current.delete(path);
    refCallbacks.current.delete(path);
    paneMounts.current.delete(path);
    // Drop the closed tab's tracked parse generation too (symmetric with the handle/ref cleanup) —
    // a reopened tab remounts and reseeds its own, so a lingering entry could only ever mislead.
    setGenerations(without(path));
    setSaveStates(without(path));
    // And its restore override, which is a spent hydration seed for an ordinary tab but the buffer
    // itself for a recovery document — handing a reopened tab the very edit its author discarded.
    setRestoredContent(without(path));
    // A closed untitled document's Save As attempt, if any, describes a buffer that no longer
    // exists — a reopened identity (a fresh displacement mints its own) must not inherit it.
    setUntitledSave(path, null);
  };

  const handleSelect = (path: string) => {
    if (sessionFinalizingRef.current) return;
    if (path !== tabs.activePath) {
      editorHandles.current.get(tabs.activePath ?? "")?.retireDictationTarget();
    }
    setTabs((current) => setActiveTab(current, path));
  };

  const handleRequestClose = (path: string) => {
    if (sessionFinalizingRef.current) return;
    // A missing document's close is guarded whether or not the tab is dirty, and by its own
    // confirmation: the buffer is the only copy left of a document with no file, so "discard it" is
    // a destructive choice the user must make explicitly (J2, ux-design). This outranks FR-ED-3's
    // unsaved-changes guard, whose `Save` would promise a write to a path that no longer exists.
    if (missingPaths.has(path)) {
      setMissingCloseGuardPath(path);
      return;
    }
    if (tabsRequiringCloseGuard(tabs, [path]).length === 0) {
      closeTabNow(path);
      return;
    }
    setGuardQueue((queue) => (queue.includes(path) ? queue : [...queue, path]));
  };

  /**
   * A `[Save As…]` that landed: the document now lives at `to`, so this is followed exactly like a
   * proven external move — same rekey, same carried buffer, same active marker — and the old path
   * leaves the Missing set with it. The rail's row for the new path arrives with TD-18's own
   * announcement of the generation that write produced.
   */
  const handleSavedAs = (from: string, to: string) => {
    editorHandles.current.get(from)?.retireDictationTarget();
    setMissingCloseGuardPath((current) => (current === from ? null : current));
    setMissingPaths((previous) => withoutPath(previous, from));
    presentSinceGeneration.current.add(to);
    applyProjectFileMoves([{ old_path: from, new_path: to, kind: "file" }], to);
  };

  /**
   * Every edit to an open untitled document's buffer (D12, #1379) — kept in `restoredContent`,
   * which is what `toSessionPayload` reads for a tab with no mounted `EditorShell`.
   *
   * The persistence effect below only re-runs when `tabs` itself changes, and editing this buffer
   * changes neither the open-tab set nor any tab's `dirty` flag (a recovery/untitled document is
   * never `dirty` — its whole buffer *is* what gets persisted, by design, `stores/tabs.ts`). Nothing
   * else would ever re-save the session for it, and unlike an ordinary document there is no file for
   * autosave to fall back on — this snapshot is the buffer's *only* durable copy. So every edit has
   * to reach the session file, but not *synchronously, on this keystroke*: `untitledScheduler`
   * (FR-X-4) debounces the actual write, the same way `editor/autosave.ts` already does for an
   * ordinary document. `onBlur` flushes it; a tab-set change first enqueues its current complete
   * snapshot, then cancels the older scheduled request. Native close instead snapshots this same
   * live ref directly into its awaited final write/proof path. `restoredContentRef` is
   * still updated synchronously, not just via
   * `setRestoredContent`, because `liveContentOf` above (shared with the debounced write and the
   * main persistence effect) reads through the ref — and the state update alone would not be
   * reflected there until the next render.
   */
  // @anchor:untitled-change-schedule-caller
  const handleUntitledChange = (tab: TabRecord, content: string) => {
    const path = tab.path;
    setRestoredContent((previous) => {
      const next = new Map(previous);
      next.set(path, content);
      return next;
    });
    restoredContentRef.current = new Map(restoredContentRef.current).set(path, content);
    if (content === "" && tab.recoveryContentOmitted) {
      const next = retainEmptyRecoveryContent(tabsRef.current, path);
      if (next !== tabsRef.current) {
        tabsRef.current = next;
        setTabs(next);
      }
    }
    if (!rootRef.current) return;
    if (tab.surfaceIdentity) {
      setTabs((current) => setTabDirty(current, path, true));
    } else {
      untitledScheduler.current?.schedule();
    }
  };

  const saveAdoptedDocument = async (
    path: string,
    content: string,
    normalizeLineEndings: boolean,
  ): Promise<string | false> => {
    const projectRoot = rootRef.current;
    const tab = tabsRef.current.tabs.find((candidate) => candidate.path === path);
    if (!projectRoot || !tab?.surfaceIdentity) return false;
    try {
      return await saveDocument(projectRoot, path, content, normalizeLineEndings);
    } catch (error: unknown) {
      onError?.(error);
      throw error;
    }
  };

  const recordAdoptedSavedBaseline = (
    path: string,
    surfaceIdentity: string,
    content: string,
    diskContent: string,
    revision: string,
  ) => {
    if (!tabsRef.current.tabs.some((tab) =>
      tab.path === path && tab.surfaceIdentity === surfaceIdentity
    )) return;
    setAdoptedBaselines((previous) => new Map(previous).set(path, {
      content,
      diskContent,
      revision,
    }));
  };

  const saveAdoptedDocumentAs = async (
    path: string,
    content: string,
    normalizeLineEndings: boolean,
  ): Promise<boolean> => {
    const projectRoot = rootRef.current;
    if (!projectRoot) return false;
    let chosen: string | null;
    try {
      chosen = await pickSaveAsPath(projectRoot, path);
    } catch (error: unknown) {
      onError?.(error);
      return false;
    }
    if (chosen === null) return false;
    const destination = relativeToProjectRoot(projectRoot, chosen);
    if (destination === null) {
      onError?.({ kind: "InvalidPath", message: "That file is outside the open project." });
      return false;
    }
    if (tabsRef.current.tabs.some((tab) => tab.path !== path && tab.path === destination)) {
      onError?.({ kind: "InvalidPath", message: "That file is already open in another tab." });
      return false;
    }
    try {
      const revision = await saveDocumentAs(
        projectRoot,
        path,
        destination,
        content,
        normalizeLineEndings,
      );
      setAdoptedBaselines((previous) => {
        const next = new Map(previous);
        next.delete(path);
        next.set(destination, {
          content,
          diskContent: normalizeLineEndings ? normalizeContentLineEndings(content) : content,
          revision,
        });
        return next;
      });
      handleSavedAs(path, destination);
      return true;
    } catch (error: unknown) {
      onError?.(error);
      return false;
    }
  };

  /** `onBlur` for the untitled buffer's `<textarea>` (FR-X-4): flushes any pending debounced write
   * immediately, so navigating away — switching tabs, or the window losing focus — never leaves an
   * edit sitting in the debounce window with nothing left to flush it. */
  const handleUntitledBlur = (tab: TabRecord) => {
    if (!tab.surfaceIdentity) untitledScheduler.current?.flush();
  };

  const setUntitledSave = (path: string, state: { saving: boolean; error: string | null } | null) => {
    setUntitledSaveState((previous) => {
      const next = new Map(previous);
      if (state === null) next.delete(path);
      else next.set(path, state);
      return next;
    });
  };

  /**
   * `[Save As…]` for an untitled document (D12, FR-ED-8, #1379/#1803). Its checkpointed UUID owns
   * pathless sidecars before a file exists. The durable adoption event is prepared before the file
   * write, then reconciled through the sidecar store. Once the file lands it follows the same
   * rekey/rail path as an ordinary Save As — even if provenance remains pending, and without
   * replacing the mounted authoring surface.
   *
   * The picker is seeded with `tab.recoveredFrom`'s bare filename, not its full path: that full path
   * is, by construction, the path a *different* open tab now occupies (the reason this buffer is
   * untitled at all), so pre-filling it would default the picker to overwriting that document.
   * Whatever the user ultimately picks is still refused below if it names an already-open tab —
   * every sibling tab-state transition (`openTab`, `rekeyTabPaths`) guards a destination collision
   * the same way, since two tabs sharing one `path` would share `paneKeyFor`'s key and the second
   * could never be selected, closed, or marked dirty again.
   */
  // @anchor:untitled-save-as-restored-content-read
  const performUntitledSaveAs = async (tab: TabRecord) => {
    if (!root || tab.recoveredFrom === undefined) return;
    const path = tab.path;
    setUntitledSave(path, { saving: true, error: null });
    let chosen: string | null;
    try {
      chosen = await pickSaveAsPath(root, basenameOf(tab.recoveredFrom));
    } catch (error: unknown) {
      setUntitledSave(path, {
        saving: false,
        error: `Couldn’t open Save As — ${errorDetail(error)}. This document is unchanged.`,
      });
      return;
    }
    if (chosen === null) {
      setUntitledSave(path, null);
      return;
    }
    let destination = relativeToProjectRoot(root, chosen);
    if (destination === null) {
      setUntitledSave(path, {
        saving: false,
        error: "That file is outside the open project.",
      });
      return;
    }
    if (tabsRef.current.tabs.some((other) => other.path !== path && other.path === destination)) {
      setUntitledSave(path, {
        saving: false,
        error: "That file is already open in another tab.",
      });
      return;
    }
    const content = restoredContentRef.current.get(path) ?? "";
    let docId: string;
    try {
      docId = await ensureUntitledIdentity(tab);
    } catch (error: unknown) {
      setUntitledSave(path, { saving: false, error: `Couldn't prepare this document — ${errorDetail(error)}.` });
      return;
    }
    const recordsOmission = tab.recoveryContentOmitted === true;
    const adoptionId = globalThis.crypto?.randomUUID?.() ?? `adoption-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    {
      try {
        destination = await prepareAdoption(
          root,
          adoptionId,
          tab.recoveredFrom,
          destination,
          docId,
          recordsOmission,
          content,
          new Date().toISOString(),
        ) || destination;
      } catch (error: unknown) {
        setUntitledSave(path, {
          saving: false,
          error: `Couldn’t prepare Save As — ${errorDetail(error)}. Nothing was written, and this document is unchanged.`,
        });
        return;
      }
    }
    let landedRevision: string;
    let landedPersistencePending = false;
    try {
      // This buffer has never passed through the ordinary document-open line-ending policy. CJ's
      // #1379 ruling therefore keeps its bytes exactly as authored during adoption, including CRLF.
      const receipt = await landAdoption(root, adoptionId, content);
      landedRevision = receipt.revision;
      destination = receipt.destination;
      landedPersistencePending = receipt.pending;
      // Landed bytes change this retained surface's document identity. The pre-adoption
      // recording cannot write its later Final into the new path-owned document.
      editorHandles.current.get(path)?.retireDictationTarget();
    } catch (error: unknown) {
      void cancelAdoption(root, adoptionId).catch(() => {});
      setUntitledSave(path, {
        saving: false,
        error: `Couldn’t save to ${destination} — ${errorDetail(error)}. Nothing was written, and this document is unchanged.`,
      });
      return;
    }
    setProvenancePendingPaths((current) => new Set([...current, destination]));
    try {
      // The combined backend edge normally promotes the durable phase itself. A typed pending
      // receipt means bytes already landed but one of its follow-up records needs this idempotent
      // retry; it must never fall into the cancellable/no-write error branch above.
      if (landedPersistencePending) {
        await commitAdoption(root, adoptionId, landedRevision);
      }
      const result = await reconcileAdoptions(root);
      applyAdoptionReconciliation(result);
    } catch (error: unknown) {
      // The file already landed. It is now an ordinary project document even while the durable
      // provenance event remains pending for relaunch reconciliation.
      onError?.(error);
    }
    presentSinceGeneration.current.add(destination);
    // The retained surface has already hydrated its adopted baseline. Treat it as an ordinary
    // loaded document so the active-path confirmation reaches App on the same rekey commit.
    loadedPaths.current.add(destination);
    setUntitledSave(path, null);
    setAdoptedBaselines((previous) => {
      const next = new Map(previous);
      next.delete(path);
      next.set(destination, { content, revision: landedRevision });
      return next;
    });
    // Edits may land while prepare/write/commit are awaited. Keep those live bytes in the retained
    // surface and mark them dirty against the exact snapshot that reached disk.
    const liveContent = restoredContentRef.current.get(path) ?? content;
    setRestoredContent((previous) => {
      const next = new Map(previous);
      next.delete(path);
      next.set(destination, liveContent);
      return next;
    });
    restoredContentRef.current = new Map(restoredContentRef.current);
    restoredContentRef.current.delete(path);
    restoredContentRef.current.set(destination, liveContent);
    setTabs((current) => {
      const adopted = adoptUntitledTab(current, path, destination);
      return liveContent === content ? adopted : setTabDirty(adopted, destination, true);
    });
    // Save As is non-destructive: the adopted document stays open, while only this now-resolved
    // close decision leaves the queue. Cancellation and failure return above and deliberately keep
    // the guard in place.
    setGuardQueue((queue) => queue.filter((queuedPath) => queuedPath !== path));
    clearRecoveryStatus(path);
  };

  const handleUntitledSaveAs = (tab: TabRecord): Promise<void> => {
    const existing = untitledSaveInFlight.current.get(tab.path);
    if (existing) return existing;
    const operation = performUntitledSaveAs(tab);
    untitledSaveInFlight.current.set(tab.path, operation);
    void operation.finally(() => {
      if (untitledSaveInFlight.current.get(tab.path) === operation) {
        untitledSaveInFlight.current.delete(tab.path);
      }
    });
    return operation;
  };

  /** A recovery proved the document is no longer missing (a `Recreate` that created the file, or one
   * that found the path occupied again and handed the disk side to FR-ED-7). The next generation
   * would say the same thing; clearing here is what makes the banner and the paused autosave end
   * with the action rather than with the refresh. */
  const handleMissingResolved = (path: string) => {
    setMissingCloseGuardPath((current) => (current === path ? null : current));
    setMissingPaths((previous) => withoutPath(previous, path));
    presentSinceGeneration.current.add(path);
  };

  const guardPath = guardQueue[0] ?? null;
  const guardTab = tabs.tabs.find((tab) => tab.path === guardPath);
  const liveOverCapPaths = new Set(
    tabs.tabs
      .filter(
        (tab) => isRecoveredTab(tab) && exceedsSessionContentCap(liveContentOf(tab.path)),
      )
      .map((tab) => tab.path),
  );

  const resolveGuard = async (action: "save" | "discard" | "cancel") => {
    if (!guardPath) return;
    if (action === "cancel") {
      quittingRef.current = false;
      setGuardQueue([]);
      return;
    }
    if (action === "save") {
      const succeeded = await editorHandles.current.get(guardPath)?.save();
      // Only a *confirmed* success may discard the edit by closing the tab. An ordinary failed save
      // (`false`) or a save we couldn't dispatch (no handle → `undefined`) leaves this guard open;
      // an FR-ED-7 refusal has already used `onExternalChangeSaveBlocked` to dismiss the guard and
      // return attention to Keep mine, still without closing the tab. (A dirty tab always has a
      // mounted handle, so `undefined` is defensive.)
      if (succeeded !== true) return;
    }
    if (quittingRef.current) {
      stagedDecisions.current.set(
        guardPath,
        action === "discard" ? "discard-recorded" : "saved",
      );
      setGuardQueue((queue) => queue.slice(1));
      return;
    }
    closeTabNow(guardPath);
    setGuardQueue((queue) => queue.slice(1));
  };

  if (!root) return null;

  return (
    <div className="tabbed-editor">
      <DictationFreezeContext.Provider value={sessionFinalizing}>
      <div
        className="tabbed-editor__mutable-surface"
        aria-busy={sessionFinalizing}
        inert={sessionFinalizing}
        style={sessionFinalizing ? { opacity: 0.55, pointerEvents: "none" } : undefined}
      >
      <TabBar
        tabs={tabs.tabs}
        activePath={tabs.activePath}
        onSelect={handleSelect}
        onRequestClose={handleRequestClose}
        liveOverCapPaths={liveOverCapPaths}
        missingPaths={missingPaths}
        onActivateMissing={(path) => {
          // Activating the persistent status reopens the recovery actions on that document — so it
          // focuses the tab first, since the actions live in the pane the tab shows (ux-design:
          // "activating that status reopens these actions").
          handleSelect(path);
          editorHandles.current.get(path)?.showMissingActions();
        }}
      />
      <div
        className="tabbed-editor__panes"
      >
        {tabs.tabs.map((tab) => (
          <div
            key={paneKeyFor(tab)}
            className="tabbed-editor__pane"
            style={{ display: tab.path === tabs.activePath ? "block" : "none" }}
          >
            {isRecoveredTab(tab) || tab.surfaceIdentity ? (
              // An untitled document has no file to open, poll, or protect — its buffer is all
              // there is of it, held in the same restore-override map a session's unsaved content
              // rides in (and persisted right back into that session below). `[Save As…]` is its one
              // route into the project (D12, FR-ED-8, #1379/#1803); a landed save adopts its UUID
              // and changes this same mounted surface from pathless to path-owned operation.
              <UntitledDocument
                ref={editorRefFor(tab.path)}
                timelineReturn={tab.path === tabs.activePath ? timelineReturn : undefined}
                docId={tab.docId}
                loadCommentsOnMount={!managedCommentLoading}
                root={root}
                displacedPath={tab.recoveredFrom ?? tab.adoptedDisplacedPath ?? tab.path}
                adoptedPath={tab.surfaceIdentity ? tab.path : undefined}
                adoptedBaseline={tab.surfaceIdentity ? adoptedBaselines.get(tab.path) : undefined}
                content={restoredContent.get(tab.path) ?? ""}
                liveOverCap={liveOverCapPaths.has(tab.path)}
                recoveryContentOmitted={tab.recoveryContentOmitted === true}
                unsupportedSource={tab.recoveredFrom !== undefined && !isSupportedDocumentPath(tab.recoveredFrom)}
                lossNoticeCollapsed={tab.lossNoticeCollapsed === true}
                onRecoveryNoticeCollapsedChange={(collapsed) =>
                  setTabs((current) =>
                    setRecoveryNoticeCollapsed(current, tab.path, collapsed),
                  )
                }
                onChange={(content) => handleUntitledChange(tab, content)}
                onBlur={() => handleUntitledBlur(tab)}
                onSaveAs={() => void handleUntitledSaveAs(tab)}
                onSaveAdopted={tab.surfaceIdentity
                  ? (content, normalize) => saveAdoptedDocument(tab.path, content, normalize)
                  : undefined}
                onAdoptedSaved={tab.surfaceIdentity
                  ? (content, diskContent, revision) => recordAdoptedSavedBaseline(
                    tab.path, tab.surfaceIdentity!, content, diskContent, revision,
                  )
                  : undefined}
                onSaveAsAdopted={tab.surfaceIdentity
                  ? (content, normalize) => saveAdoptedDocumentAs(tab.path, content, normalize)
                  : undefined}
                autosaveIntervalMs={autosaveIntervalMs}
                revealMarkupAtCursor={revealMarkupAtCursor}
                externalChangePollMs={externalChangePollMs}
                missing={missingPaths.has(tab.path)}
                onDirtyChange={(dirty) =>
                  setTabs((current) => setTabDirty(current, tab.path, dirty))
                }
                onSaveStateChange={(state) => recordSaveState(tab.path, state)}
                onExternalChangeSaveBlocked={() => {
                  quittingRef.current = false;
                  setGuardQueue([]);
                }}
                onRequestClose={() => handleRequestClose(tab.path)}
                onMissingResolved={() => handleMissingResolved(tab.path)}
                onError={onError}
                provenancePending={provenancePendingPaths.has(tab.path)}
                saving={untitledSaveState.get(tab.path)?.saving ?? false}
                saveError={untitledSaveState.get(tab.path)?.error ?? null}
                onQuoteSelection={
                  tab.path === tabs.activePath && onQuoteSelection
                    ? (quote) => onQuoteSelection(quotedExcerptFor(tab, quote, tabs.tabs))
                    : undefined
                }
                platform={platform}
                providerStatuses={providerStatuses}
                commentProjection={{
                  revision: commentThreads?.find((thread) => thread.anchor)?.anchor?.base_revision ?? "",
                  threads: tab.path === tabs.activePath ? (commentThreads ?? []) : [],
                }}
                commentMode={tab.path === tabs.activePath && commentMode}
                onColumnThreadSelected={tab.path === tabs.activePath ? onColumnThreadSelected : undefined}
                onCommentThreadsChanged={
                  tab.path === tabs.activePath ? onCommentThreadsChanged : undefined
                }
                commentNow={commentNow}
                openDocuments={openDocumentsSnapshot}
              />
            ) : (
              <>
              <EditorShell
                ref={editorRefFor(tab.path)}
                timelineReturn={tab.path === tabs.activePath ? timelineReturn : undefined}
                root={root}
                path={tab.path}
                platform={platform}
                providerStatuses={providerStatuses}
                initialContent={restoredContent.get(tab.path)}
                autosaveIntervalMs={autosaveIntervalMs}
                revealMarkupAtCursor={revealMarkupAtCursor}
                externalChangePollMs={externalChangePollMs}
                pickSaveAsPath={pickSaveAsPath}
                missing={missingPaths.has(tab.path)}
                onSavedAs={(destination) => handleSavedAs(tab.path, destination)}
                onMissingResolved={() => handleMissingResolved(tab.path)}
                onRequestClose={() => handleRequestClose(tab.path)}
                onExternalChangeSaveBlocked={() => {
                  // CJ-ratified #1599: Save is not implicit Keep mine. Abort a close/quit sequence,
                  // leave every dirty tab intact, and uncover this tab's existing FR-ED-7 banner;
                  // EditorShell focuses its Keep mine action after this state commits.
                  quittingRef.current = false;
                  setGuardQueue([]);
                }}
                onLoaded={() => {
                  loadedPaths.current.add(tab.path);
                  rollbackPaths.current.delete(tab.path);
                  restoredCleanPaths.current.delete(tab.path);
                  restoredDirtyPaths.current.delete(tab.path);
                  if (tabsRef.current.activePath === tab.path) {
                    onConfirmedActivePathChange?.(tab.path);
                  }
                }}
                onLoadError={(error) => {
                  const unsupportedDocument =
                    typeof error === "object" &&
                    error !== null &&
                    "kind" in error &&
                    error.kind === "InvalidDocument";
                  const cleanUnsupportedRestore = unsupportedDocument && restoredCleanPaths.current.has(tab.path);
                  let recoveredIdentity: string | null = null;
                  if (unsupportedDocument && restoredDirtyPaths.current.has(tab.path)) {
                    const content = restoredContentRef.current.get(tab.path);
                    if (content !== undefined) {
                      const current = tabsRef.current;
                      const recovered = recoverUnsupportedTab(current, tab.path);
                      if (recovered !== current) {
                        const index = current.tabs.findIndex((entry) => entry.path === tab.path);
                        const identity = recovered.tabs[index].path;
                        const overrides = new Map(restoredContentRef.current);
                        overrides.delete(tab.path);
                        overrides.set(identity, content);
                        restoredContentRef.current = overrides;
                        setRestoredContent(overrides);
                        tabsRef.current = recovered;
                        setTabs(recovered);
                        restoredDirtyPaths.current.delete(tab.path);
                        editorHandles.current.delete(tab.path);
                        refCallbacks.current.delete(tab.path);
                        paneMounts.current.delete(tab.path);
                        recoveredIdentity = identity;
                      }
                    }
                  }
                  if (
                    rollbackPaths.current.has(tab.path) ||
                    cleanUnsupportedRestore
                  ) closeTabNow(tab.path);
                  if (recoveredIdentity !== null) {
                    recoveryStatuses.current.set(recoveredIdentity, setOwnedUserAppStatus(
                      `${tab.path} can’t open as a Cowrite document. Its retained text is editable in an untitled tab; use Save As to save it to a supported document path.`,
                    ));
                  } else if (unsupportedDocument && tab.recoveryContentOmitted) {
                    onError?.(new UnsupportedRestoreRefusalError(
                      `${tab.path} can’t open as a Cowrite document. Its unsaved work was over the session limit and wasn’t kept.`,
                      tab.path,
                      "omitted",
                    ));
                  } else if (cleanUnsupportedRestore) {
                    onError?.(new UnsupportedRestoreRefusalError(
                      `${tab.path} can’t open as a Cowrite document. Its tab was closed.`,
                      tab.path,
                      "closed",
                    ));
                  } else {
                    onError?.(error);
                  }
                }}
                onDirtyChange={(dirty) => {
                  if (dirty) restoredCleanPaths.current.delete(tab.path);
                  setTabs((current) => setTabDirty(current, tab.path, dirty));
                }}
                onSaveStateChange={(state) => recordSaveState(tab.path, state)}
                onError={onError}
                onChangesDecided={tab.path === tabs.activePath ? onChangesDecided : undefined}
                onChangesReversed={tab.path === tabs.activePath ? onChangesReversed : undefined}
                onQuoteSelection={
                  tab.path === tabs.activePath && onQuoteSelection
                    ? (quote) => onQuoteSelection(quotedExcerptFor(tab, quote, tabs.tabs))
                    : undefined
                }
                onChangeGenerationChange={(generation) => recordGeneration(tab.path, generation)}
                batchAddressControl={tab.path === tabs.activePath ? batchAddressControl : undefined}
                commentThreads={tab.path === tabs.activePath ? commentThreads : undefined}
                onColumnThreadSelected={tab.path === tabs.activePath ? onColumnThreadSelected : undefined}
                liveRunIds={tab.path === tabs.activePath ? liveRunIds : undefined}
                queuedRunIds={tab.path === tabs.activePath ? queuedRunIds : undefined}
                terminalRunIds={tab.path === tabs.activePath ? terminalRunIds : undefined}
                commentMode={tab.path === tabs.activePath && commentMode}
                onCommentThreadsChanged={
                  tab.path === tabs.activePath ? onCommentThreadsChanged : undefined
                }
                onAddressRunFailed={tab.path === tabs.activePath ? onAddressRunFailed : undefined}
                onAddressRunStarted={tab.path === tabs.activePath ? onAddressRunStarted : undefined}
                onCommentRunLink={tab.path === tabs.activePath ? onCommentRunLink : undefined}
                openDocuments={openDocumentsSnapshot}
                now={commentNow}
              />
              {provenancePendingPaths.has(tab.path) && (
                <div className="untitled-adoption-pending" role="status">
                  Saved to {tab.path}. Cowrite hasn't yet recorded that the earlier unsaved work
                  wasn't part of it — it will finish next time it can.
                </div>
              )}
              </>
            )}
          </div>
        ))}
      </div>
      </div>
      </DictationFreezeContext.Provider>
      <div
        ref={closeAttemptTargetRef}
        className="tabbed-editor__session-target"
        tabIndex={-1}
        aria-label={sessionFinalizing ? "Session close attempt" : undefined}
      >
        {sessionSavingVisible && (
          <div
            className="tabbed-editor__session-status"
            data-platform={platform}
            role="status"
          >
            <span aria-hidden="true">●</span> Saving your session…
          </div>
        )}
      </div>
      {missingCloseGuardPath !== null && (
        <MissingDocumentGuard
          kind="close"
          label={missingCloseGuardPath}
          onCancel={() => setMissingCloseGuardPath(null)}
          onSaveAs={() => {
            // Saving elsewhere is the non-destructive way out of this dialog: on success the
            // document has a file again (at the new path, carried there with its history), so the
            // tab stays open there rather than being closed on top of work just rescued. A
            // cancellation or failure changed nothing and leaves this dialog exactly as it was.
            void editorHandles.current.get(missingCloseGuardPath)?.saveAs();
          }}
          onDiscard={() => closeTabNow(missingCloseGuardPath)}
        />
      )}
      {guardTab && (
        <DirtyCloseGuard
          label={tabLabel(guardTab, tabs.tabs)}
          // An untitled recovery document has no autosave path but does have CJ's ratified Save As
          // route, so its destructive-close guard offers that non-destructive exit. Missing on disk
          // stays distinct: its tab-strip close uses `MissingDocumentGuard` above, while its quit
          // route reaches this generic guard without an implicit write to the absent path.
          onSave={
            isRecoveredTab(guardTab)
              ? () => void handleUntitledSaveAs(guardTab)
              : missingPaths.has(guardTab.path)
                ? undefined
                : () => void resolveGuard("save")
          }
          saveLabel={isRecoveredTab(guardTab) ? "Save As…" : undefined}
          saving={untitledSaveState.get(guardTab.path)?.saving ?? false}
          saveError={untitledSaveState.get(guardTab.path)?.error ?? null}
          recoveryVariant={
            isRecoveredTab(guardTab)
              ? guardTab.recoveryContentOmitted === true
                ? liveContentOf(guardTab.path).length === 0
                  ? "restored-omitted-empty"
                  : "omitted-with-edits"
                : liveContentOf(guardTab.path).length === 0
                  ? "preserved-empty"
                  : liveOverCapPaths.has(guardTab.path)
                    ? "live-over-cap"
                    : "only-copy"
              : undefined
          }
          discardLabel={isRecoveredTab(guardTab) ? "Discard this untitled document" : undefined}
          onDiscard={() => void resolveGuard("discard")}
          onCancel={() => void resolveGuard("cancel")}
        />
      )}
      {sessionFailure && (
        <SessionWriteFailureDialog
          affectedLabels={sessionFailure.affectedLabels}
          detail={sessionFailure.detail}
          baseline={sessionFailure.baseline}
          retrying={sessionFailure.retrying}
          onQuitAnyway={() => {
            ++closeAttemptGeneration.current;
            stagedDecisions.current.clear();
            setSessionFailure(null);
            quittingRef.current = false;
            closeWindow().catch((error: unknown) => {
              // Nothing was written and nothing closed, so the author is still where they were —
              // say why rather than leaving an unattributed rejection to explain it (#2327), and
              // put them back where they were. No freeze to wait for on this branch: it lifted when
              // the write failed, and the dialog that held focus has already unmounted.
              restorePreCloseFocus();
              onError?.(new UserFacingError(
                `The window didn’t close. Your latest session changes are still unsaved. ${errorDetail(error)}`,
              ));
            });
          }}
          onRetry={() => void finalizeCloseAttempt(true)}
          onStayOpen={() => {
            ++closeAttemptGeneration.current;
            stagedDecisions.current.clear();
            quittingRef.current = false;
            setGuardQueue([]);
            setSessionFailure(null);
            queueMicrotask(() => {
              restorePreCloseFocus();
            });
          }}
        />
      )}
    </div>
  );
});
