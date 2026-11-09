// ABOUTME: Thin IPC bridge to the backend's `commands::comments` module (P2a-18/P2a-19) —
// ABOUTME: create/reply/resolve/reopen/re-anchor/address-with-AI, and loading current thread state.
// ABOUTME: Outside a Tauri webview (dev-mode e2e per D23, tech-design §3.7) the same calls reach
// ABOUTME: the headless test driver's loopback HTTP surface instead — same commands, no mocking.
import { callBackend } from "../backend";
import {
  type BatchAddressOutcome,
  type CommentThread,
  type LinkedChangeDecision,
  type RunConclusionOutcome,
  type CommentDocumentOwner,
} from "./types";

type OwnerInput = string | CommentDocumentOwner;

function ownerCall(
  command: string,
  owner: OwnerInput,
  content?: string,
): { command: string; args: Record<string, unknown> } {
  const normalized = typeof owner === "string" ? { kind: "path" as const, path: owner } : owner;
  if (normalized.kind === "path") {
    return { command, args: { path: normalized.path } };
  }
  if (content === undefined) throw new Error("live content is required for an untitled comment");
  return {
    command: `${command}_by_id`,
    args: { docId: normalized.docId, content },
  };
}

/** A live selection captured at comment-create time: `content` is the exact buffer text
 * CodeMirror held when the user took the action — dirty or not, never re-read from disk, and
 * `utf16Offset`/`utf16Length` are CodeMirror's own UTF-16 code-unit range within it. Mirrors
 * `commands::comments::AnchorRange` — the backend recaptures the full `textops::Anchor`
 * (snapshot/context/base_revision) from `content` itself, converting to `textops`' byte-indexed
 * space, so this bridge never constructs one itself (TD-2/TD-6).
 * PR #495 review's Critical: the prior `{offset, length}`-only shape fed a raw UTF-16 offset to a
 * byte-indexed slice on the backend's disk-read text — wrong coordinate space *and* wrong text. */
export interface AnchorRange {
  content: string;
  utf16Offset: number;
  utf16Length: number;
}

/** Loads `path`'s current thread state (relative to project `root`). */
export async function loadCommentThreads(root: string, owner: OwnerInput, content?: string): Promise<CommentThread[]> {
  const call = ownerCall("load_comment_threads", owner, content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args });
}

/** Creates a new thread — anchored (`anchor` given) or document-level (`anchor` omitted/null),
 * FR-CMT-1. */
export async function createComment(
  root: string,
  owner: OwnerInput,
  author: string,
  body: string,
  anchor: AnchorRange | null,
  timestamp: number,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("create_comment", owner, content ?? anchor?.content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args, author, body, anchor, timestamp });
}

/** Appends a reply to `threadId`, in causal order (test-plan P5's fold owns the ordering).
 * `published` (FR-CMT-4/D20) is a defense reply's publish-to-external-reviewer flag — pass `false`
 * for an ordinary (non-defense) reply. */
export async function replyToComment(
  root: string,
  owner: OwnerInput,
  threadId: string,
  author: string,
  body: string,
  defense: boolean,
  published: boolean,
  timestamp: number,
  content?: string,
  runId?: string,
): Promise<CommentThread[]> {
  const call = ownerCall(runId ? "reply_comment_for_run" : "reply_comment", owner, content);
  return callBackend<CommentThread[]>(call.command, {
    root,
    ...call.args,
    threadId,
    author,
    body,
    defense,
    published,
    timestamp,
    ...(runId ? { runId } : {}),
  });
}

/** Supersedes only the authored body. The backend rechecks actor and run eligibility in its write lane. */
export async function reviseComment(
  root: string,
  owner: OwnerInput,
  targetId: string,
  body: string,
  timestamp: number,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("revise_own_comment", owner, content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args, targetId, body, timestamp });
}

/** Commits the confirmed Delete as an append-only withdrawal, with child-first eligibility rechecked. */
export async function withdrawComment(
  root: string,
  owner: OwnerInput,
  targetId: string,
  timestamp: number,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("withdraw_own_comment", owner, content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args, targetId, timestamp });
}

/** Manually resolves `threadId` (the open-thread "Resolve" action). */
export async function resolveComment(
  root: string,
  owner: OwnerInput,
  threadId: string,
  author: string,
  timestamp: number,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("resolve_comment", owner, content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args, threadId, author, timestamp });
}

/** Reopens a previously resolved thread. */
export async function reopenComment(
  root: string,
  owner: OwnerInput,
  threadId: string,
  author: string,
  timestamp: number,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("reopen_comment", owner, content);
  return callBackend<CommentThread[]>(call.command, { root, ...call.args, threadId, author, timestamp });
}

/** Commits a manual [Re-anchor] (ux-design.md J4: click → select new home text → confirm) — the
 * original quote stays on the thread regardless (D17); only the live anchor moves. `anchor` is
 * the same content + UTF-16 range shape [`createComment`] takes ([`AnchorRange`]): the backend
 * recaptures the anchor from `anchor.content` (the live buffer text the new-home selection was
 * measured against), never from a re-read of `path`'s on-disk copy (PR #495 review's Critical,
 * issue #517 — `re_anchor_comment` had the identical latent defect `create_comment` was fixed for). */
export async function reAnchorComment(
  root: string,
  owner: OwnerInput,
  threadId: string,
  author: string,
  timestamp: number,
  anchor: AnchorRange,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("re_anchor_comment", owner, content ?? anchor.content);
  return callBackend<CommentThread[]>(call.command, {
    root,
    ...call.args,
    threadId,
    author,
    timestamp,
    anchor,
  });
}

/** Starts an "Address with AI" run against `threadId` (FR-CMT-2, ux-design.md J4) — the thread
 * reads "addressed — pending review" until the run's delivery lands ([`linkChanges`] and/or a
 * defense [`replyToComment`]). Spawning/streaming the run itself is P2a-15's job, out of scope
 * here. `guidance` is the [Try again — add guidance…] re-delegation note on a reopened thread
 * (omit/`null` for a first address). */
export async function addressWithAI(
  root: string,
  path: string,
  threadId: string,
  author: string,
  timestamp: number,
  runId: string,
  guidance: string | null = null,
): Promise<CommentThread[]> {
  return callBackend<CommentThread[]>("address_with_ai", {
    root,
    path,
    threadId,
    author,
    timestamp,
    runId,
    guidance,
  });
}

/** Concludes `threadId`'s in-flight address run without a delivery (issue #1381, ux-design.md §2's
 * exit table) — clears `pending_run`/`pending_guidance` and records the exit note, whether the run
 * was stopped from the run card, failed (CLI spawn/read error), or is being reconciled as failed
 * because it's no longer live. A no-op (per the store's own guard) if `runId` no longer names this
 * thread's current pending run — the caller never has to check first. */
export async function concludeAddressRun(
  root: string,
  path: string,
  threadId: string,
  author: string,
  timestamp: number,
  runId: string,
  outcome: RunConclusionOutcome,
): Promise<CommentThread[]> {
  return callBackend<CommentThread[]>("conclude_address_run", {
    root,
    path,
    threadId,
    author,
    timestamp,
    runId,
    outcome,
  });
}

/**
 * Starts one "Address all…" batch run across `threadIds` under a single shared `runId` (FR-CMT-5/D8,
 * ux-design.md J4 Batch) — every targeted thread takes the same "addressed — pending review"
 * transition the single path uses. Pick `threadIds` with `batchAddress.ts`'s
 * `selectBatchSelection` and current live/terminal run IDs;
 * the backend independently re-checks eligibility, so a stale selection can never mis-address a
 * resolved thread.
 *
 * Unlike the single-thread commands this returns a `BatchAddressOutcome`, not a bare thread list:
 * FR-AGENT-6 requires the caller be told *which* threads completed and which were never started. A
 * failed/unreachable backend rejects like any other `callBackend` call — `TimelinePanel`'s own
 * caller already turns that rejection into an honest `unrunBatch` outcome (see its
 * `handleAddressAll`), so this bridge doesn't need a second, duplicate no-backend fallback. That
 * fallback is covered end to end (pre-dating this bridge's rewrite, unchanged by it) by
 * `TimelinePanel.batchAddress.test.tsx`'s "reports a failed call as an interrupted run with every
 * target untouched" — PR #536 review flagged this claim as unverified without having found that
 * test; cited here so the next reader doesn't repeat the search.
 */
export async function addressAllWithAI(
  root: string,
  path: string,
  threadIds: string[],
  author: string,
  timestamp: number,
  runId: string,
): Promise<BatchAddressOutcome> {
  return callBackend<BatchAddressOutcome>("address_all_with_ai", { root, path, threadIds, author, timestamp, runId });
}

/** Links `changeIds` (the tracked changes `propose_changes`, P2a-13, proposed) to `threadId`'s
 * address-run delivery (FR-CMT-2/7) — pairs with a [`replyToComment`] call carrying the agent's
 * explanation for the same delivery. Each change starts undecided. */
export async function linkChanges(
  root: string,
  path: string,
  threadId: string,
  author: string,
  timestamp: number,
  changeIds: string[],
  runId?: string,
): Promise<CommentThread[]> {
  return callBackend<CommentThread[]>(runId ? "link_changes_for_run" : "link_changes", {
    root, path, threadId, author, timestamp, changeIds, ...(runId ? { runId } : {}),
  });
}

/** Records `decision` for every id in `changeIds`, linked to `threadId` (FR-CMT-7) — covers both
 * [Accept both]/bulk-reject and a future 1-by-1 caller passing a single id. */
export async function decideLinkedChanges(
  root: string,
  owner: OwnerInput,
  threadId: string,
  author: string,
  timestamp: number,
  changeIds: string[],
  decision: LinkedChangeDecision,
  content?: string,
): Promise<CommentThread[]> {
  const call = ownerCall("decide_linked_changes", owner, content);
  return callBackend<CommentThread[]>(call.command, {
    root,
    ...call.args,
    threadId,
    author,
    timestamp,
    changeIds,
    decision,
  });
}
