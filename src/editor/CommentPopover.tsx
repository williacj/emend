// ABOUTME: The editor-anchored comment popover (#259, J4, FR-CMT-2) — creates or views a thread
// ABOUTME: inline near its anchor, positioned by the caller (mirrors `RedlinePopover`'s own
// ABOUTME: `coordsAtPos`-computed `style`) and reusing `comments/CommentComposer`/`CommentThreadCard`
// ABOUTME: plus `comments/ipc.ts` rather than re-implementing thread creation or the action set.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { errorDetail } from "../backend";
import { buildAddressPrompt } from "../comments/addressPrompt";
import { CommentComposer, type CommentComposerSelection } from "../comments/CommentComposer";
import { CommentThreadCard } from "../comments/CommentThreadCard";
import {
  createComment,
  decideLinkedChanges,
  loadCommentThreads,
  reAnchorComment,
  replyToComment,
  reopenComment,
  resolveComment,
  reviseComment,
  withdrawComment,
} from "../comments/ipc";
import type { Anchor, CommentDocumentOwner, CommentRunLink, CommentThread, LinkedChangeDecision } from "../comments/types";
import { isMac } from "./keymap";
import { startAddressRun, type StartRunResult } from "../timeline/agentActivity";
import { activeDocumentContentSent, NO_OPEN_DOCUMENTS_READER, type OpenDocumentsSnapshot } from "../timeline/referenceData";

/**
 * What the popover is showing: a not-yet-created thread anchored at (or, with `selection: null`,
 * unanchored from) the live selection at open time, or an existing thread to view/act on. The
 * caller decides which — a click on a `commentHighlights.ts` highlight opens `view`, the editor's
 * own comment trigger (mirroring `QuoteAffordance`) opens `create`.
 *
 * A non-null `selection` also carries `content` — the exact live buffer text the caller measured
 * `offset`/`length` against (mirrors `EditorShell.handleQuote`'s identical `state.doc.toString()`
 * capture for the quote-bar). `handleCreate` below sends both straight through to `createComment`
 * unchanged: the backend, not this component, resolves them into a `textops::Anchor` (PR #495
 * review's Critical — the prior contract dropped `content` and fed a UTF-16 offset to a
 * byte-indexed disk read).
 */
export type CommentPopoverTarget =
  | { kind: "create"; selection: (CommentComposerSelection & { content: string }) | null }
  | { kind: "view"; thread: CommentThread };

export interface CommentPopoverProps {
  /** Matches the containing editor's app-owned platform chrome. */
  platform?: "win" | "mac";
  /** Project root/path the thread belongs to — passed straight through to every `comments/ipc.ts`
   * call, mirroring `timeline/CommentCard`'s identical wiring. */
  root: string;
  /** Discriminated path-or-ID owner; ID owners never expose agent-run controls. */
  document?: CommentDocumentOwner;
  /** Backward-compatible standalone test/input spelling; production supplies `document`. */
  path?: string;
  /** Current CM6 text, required for an ID owner so anchor resolution never reads disk. */
  readContent?: () => string;
  /** The acting local identity for create/reply/resolve/reopen/re-anchor/address (TD-4). Mirrors
   * `timeline/CommentCard`'s identical default. */
  author?: string;
  /** Injectable clock (CLAUDE.md: no reliance on real time in tests), mirrors `timeline/CommentCard`. */
  now?: () => number;
  target: CommentPopoverTarget;
  /** Absolute positioning near the anchor (from `EditorView.coordsAtPos`); omitted in tests or
   * before the view has laid out — mirrors `RedlinePopover`/`QuoteAffordance`. */
  style?: CSSProperties;
  /** Fired with the document's full updated thread list after ANY successful mutation (create,
   * reply, resolve, reopen, re-anchor, address-with-AI, re-delegate, decide-linked-changes) — the
   * seam the caller (`EditorShell`) re-seeds `commentHighlights.ts`'s live anchor field through.
   * Only takes effect while the shell's tracked document revision still matches the live text: on
   * an unsaved edited buffer `EditorShell` drops the re-seed rather than claim a stale offset
   * describes text the buffer no longer holds (PR #495 review, Important #2). That revision now
   * moves with every save (`save_document` returns it, #1121), so the highlight/state colour
   * refreshes on the next save rather than waiting for a remount. */
  onThreadsChanged: (threads: CommentThread[]) => void;
  /** Reports a `start_run` that rejected outright for this thread's Address-with-AI request
   * (#1777) — mirrors `timeline/CommentCard`'s identically-named prop; see
   * `timeline/agentActivity.ts`'s `failedRunStatus` for the rationale and the route this takes
   * (`EditorShell` → `TabbedEditor` → `App`). Omitted in a caller with no timeline to raise it in
   * (e.g. this component's own unit tests), matching every other optional prop here. */
  onAddressRunFailed?: (root: string, error: unknown) => void;
  onAddressRunStarted?: (root: string, run: StartRunResult) => void;
  /** Accepted run identity and D31 fact, captured with the same submit envelope sent to transport. */
  onCommentRunLink?: (root: string, owner: CommentDocumentOwner, threadId: string, link: CommentRunLink) => void;
  onFocusChange?: (changeId: string) => boolean;
  /** Sends an anchored thread's passage to the containing live editor for resolution. */
  onFocusAnchor?: (anchor: Anchor) => void;
  /** Reads every open document at submit time for FR-CHAT-4's `open_documents` envelope (#1724) —
   * supplied by `TabbedEditor`, the tab layer that owns the open-tab set, through `EditorShell`.
   * Defaults to "nothing open" for a caller outside that layer (this component's own unit tests),
   * matching every other optional prop here: an explicit empty envelope, never a missing one. */
  openDocuments?: () => OpenDocumentsSnapshot;
  /** Active and queued run IDs supplied by the timeline's existing run-card projection. */
  liveRunIds?: readonly string[];
  queuedRunIds?: readonly string[];
  terminalRunIds?: readonly string[];
  /** Escape, the close button, or a successful create all call this — the popover is a transient
   * overlay, not a mode (J1: "no mode required"), so it never traps the caret in either direction. */
  onClose: () => void;
}

/**
 * Renders `CommentComposer` (create) or `CommentThreadCard` (view) inside a floating dialog shell,
 * wiring every `CommentThreadCard` action to `comments/ipc.ts` exactly as `timeline/CommentCard`
 * does for the timeline surface — the two call sites intentionally read alike (Rule of Three: this
 * is the second, not yet the third that would earn an extraction) rather than reimplementing the
 * wiring for the editor.
 *
 * A created thread does not switch this popover into `view` mode: `createComment`'s response is
 * the whole updated thread list with no marker for which entry is new, so re-selecting the created
 * thread through its (now-highlighted, via `commentHighlights.ts`) anchor is the honest next step
 * rather than guessing an id. The popover simply reports the new list and closes.
 */
export function CommentPopover({
  root,
  platform = isMac ? "mac" : "win",
  document,
  path,
  readContent,
  author = "you",
  now,
  target,
  style,
  onThreadsChanged,
  onAddressRunFailed,
  onAddressRunStarted,
  onCommentRunLink,
  onFocusChange,
  onFocusAnchor,
  openDocuments = NO_OPEN_DOCUMENTS_READER,
  liveRunIds,
  queuedRunIds,
  terminalRunIds,
  onClose,
}: CommentPopoverProps) {
  const owner: CommentDocumentOwner = document ?? { kind: "path", path: path ?? "" };
  const liveContent = () => readContent?.() ?? "";
  const timestamp = () => now?.() ?? Date.now();
  // The identity a *different* target changes: a different thread id, or switching to/from create
  // mode. Resets the locally-tracked thread below only when this actually changes — not on every
  // render, and not when `applyUpdated` below updates the same thread in place.
  const targetKey = target.kind === "view" ? `view:${target.thread.id}` : "create";
  const [thread, setThread] = useState<CommentThread | null>(
    target.kind === "view" ? target.thread : null,
  );
  const [admittingRun, setAdmittingRun] = useState(false);

  // Opening the popover unmounts whatever the user just clicked (the trigger, or the CM6
  // highlight), so nothing autofocuses inside it — without the `dialogRef.current.focus()` below,
  // focus falls to `<body>` and the `onKeyDown` Escape handler further down (bound on this dialog
  // div) never receives a real keystroke (PR #495 review, Important #3: the prior claim that this
  // "mirrors `RedlinePopover`'s identical handling" was true, but `RedlinePopover` has the identical
  // unreached-Escape gap, not a working pattern to mirror). `tabIndex={-1}` on the div makes it
  // focusable without adding it to normal Tab order.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setThread(target.kind === "view" ? target.thread : null);
    dialogRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resets/refocuses only on a genuine target switch
  }, [targetKey]);
  // The editor owner can replace a thread while this same-ID popover stays open. The target key
  // above intentionally does not change, so consume its new fold without stealing focus again.
  useEffect(() => {
    if (target.kind !== "view") return;
    if (target.thread.withdrawn_at != null) {
      onClose();
      return;
    }
    setThread(target.thread);
  }, [target.kind === "view" ? target.thread : null]);

  // Mirrors `CommentCard.tsx`'s `applyUpdated`: re-renders this popover's own view from the fresh
  // thread list (so e.g. clicking Resolve shows "Resolved" immediately) while also bubbling the
  // whole list up so the caller's highlight layer stays in step.
  const applyUpdated = (threads: CommentThread[]) => {
    onThreadsChanged(threads);
    if (!thread) return;
    const updated = threads.find((candidate) => candidate.id === thread.id);
    if (updated) setThread(updated);
    else onClose();
  };

  // Mirrors `timeline/CommentCard.tsx`'s identically-named helper (#1721, the 5th orphaned seam of
  // #344): `address_with_ai` only ever recorded the pending transition — nothing called
  // `start_run`, so the thread flipped to Working and stayed there forever with no run behind it.
  // `start_run` mints the run's real id; `resolvedRunId` is what gets stamped onto the pending
  // event, so the two calls always name the same run (see that helper's own doc for the defensive
  // empty-response fallback). `activeThread` is taken as a parameter (rather than closing over the
  // component's own `thread` state) because it is only ever called from the `thread`-truthy branch
  // below, where TS has already narrowed it past `null`.
  const dispatchAddress = async (activeThread: CommentThread, guidance: string | null) => {
    setAdmittingRun(true);
    const prompt = buildAddressPrompt(activeThread, guidance);
    let updated: CommentThread[];
    let admittedRun: StartRunResult | null;
    let submittedDocuments: OpenDocumentsSnapshot;
    try {
      // FR-CHAT-4: a single "Address with AI" run names the open documents exactly as a chat turn
      // does — read at submit, the same boundary as the `[path]` operation target beside it.
      if (owner.kind !== "path") return;
      submittedDocuments = openDocuments();
      ({ threads: updated, run: admittedRun } = await startAddressRun(
        root, owner.path, [activeThread.id], author, timestamp(), prompt, false, guidance,
        { openDocuments: submittedDocuments },
      ));
    } catch (error: unknown) {
      // No run ever started — see `timeline/CommentCard.tsx`'s identical `dispatchAddress` for why
      // this must not stamp a pending event naming a run that doesn't exist, and why staying silent
      // about the rejection instead of reporting it was the other half of the same defect (#1777).
      onAddressRunFailed?.(root, error);
      return;
    } finally {
      setAdmittingRun(false);
    }
    if (admittedRun) {
      onAddressRunStarted?.(root, admittedRun);
      onCommentRunLink?.(root, owner, activeThread.id, {
        runId: admittedRun.id,
        sentText: activeDocumentContentSent(submittedDocuments),
      });
    }
    applyUpdated(updated);
  };

  const handleCreate = (body: string) => {
    const anchor =
      target.kind === "create" && target.selection
        ? {
            content: target.selection.content,
            utf16Offset: target.selection.offset,
            utf16Length: target.selection.length,
          }
        : null;
    const created = owner.kind === "id"
      ? createComment(root, owner, author, body, anchor, timestamp(), liveContent())
      : createComment(root, owner.path, author, body, anchor, timestamp());
    void created.then((threads) => {
      onThreadsChanged(threads);
      onClose();
    });
  };

  // Escape dismisses without acting — the popover is a transient overlay, not a mode (J1), so it
  // must never trap the user. Reachable from a real focus state via the `dialogRef` focus-on-open
  // above (PR #495 review, Important #3) — bare `onKeyDown` alone, as `RedlinePopover` still has it,
  // is not, since nothing else in this dialog autofocuses.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label={thread ? "Comment thread" : "New comment"}
      className={thread ? "comment-popover" : "comment-popover comment-popover--compose"}
      data-platform={platform}
      style={style}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <button type="button" className="comment-popover__close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      {thread ? (
        <CommentThreadCard
          thread={thread}
          author={author}
          localOnly={owner.kind === "id"}
          correctionAdmissionPending={admittingRun}
          liveRunIds={liveRunIds}
          queuedRunIds={queuedRunIds}
          terminalRunIds={terminalRunIds}
          onRevise={async (targetId, body) => {
            const updated = await reviseComment(root, owner, targetId, body, timestamp(), owner.kind === "id" ? liveContent() : undefined);
            applyUpdated(updated);
          }}
          onWithdraw={async (targetId) => {
            try {
              const updated = await withdrawComment(root, owner, targetId, timestamp(), owner.kind === "id" ? liveContent() : undefined);
              applyUpdated(updated);
            } catch (error) {
              // A reply may arrive after the confirmation opened. Refresh the thread so the
              // refusal and the newly blocking reply appear together in this same popover.
              if (errorDetail(error) === "Delete replies first.") {
                await loadCommentThreads(root, owner, owner.kind === "id" ? liveContent() : undefined).then(applyUpdated, () => {});
              }
              throw error;
            }
          }}
          onReply={(body, defense) => {
            const updated = owner.kind === "id"
              ? replyToComment(root, owner, thread.id, author, body, defense, false, timestamp(), liveContent())
              : replyToComment(root, owner.path, thread.id, author, body, defense, false, timestamp());
            void updated.then(
              applyUpdated,
            );
          }}
          onResolve={async () => {
            const updated = owner.kind === "id"
              ? resolveComment(root, owner, thread.id, author, timestamp(), liveContent())
              : resolveComment(root, owner.path, thread.id, author, timestamp());
            applyUpdated(await updated);
          }}
          onReopen={() => {
            const updated = owner.kind === "id"
              ? reopenComment(root, owner, thread.id, author, timestamp(), liveContent())
              : reopenComment(root, owner.path, thread.id, author, timestamp());
            void updated.then(applyUpdated);
          }}
          onReAnchor={(content, offset, length) => {
            const anchor = {
              content,
              utf16Offset: offset,
              utf16Length: length,
            };
            const updated = owner.kind === "id"
              ? reAnchorComment(root, owner, thread.id, author, timestamp(), anchor, liveContent())
              : reAnchorComment(root, owner.path, thread.id, author, timestamp(), anchor);
            void updated.then(applyUpdated);
          }}
          onAddressWithAI={owner.kind === "path" ? () => {
            void dispatchAddress(thread, null);
          } : undefined}
          onReDelegate={owner.kind === "path" ? (guidance) => {
            void dispatchAddress(thread, guidance);
          } : undefined}
          onDecideLinkedChanges={(changeIds: string[], decision: LinkedChangeDecision) => {
            const updated = owner.kind === "id"
              ? decideLinkedChanges(root, owner, thread.id, author, timestamp(), changeIds, decision, liveContent())
              : decideLinkedChanges(root, owner.path, thread.id, author, timestamp(), changeIds, decision);
            void updated.then(
              applyUpdated,
            );
          }}
          onFocusChange={onFocusChange}
          onFocusAnchor={onFocusAnchor}
          now={now}
        />
      ) : (
        <CommentComposer
          selection={target.kind === "create" ? target.selection : null}
          onSubmit={handleCreate}
          onCancel={onClose}
        />
      )}
    </div>
  );
}
