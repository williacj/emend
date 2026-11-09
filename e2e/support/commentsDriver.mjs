// ABOUTME: Direct, non-mocked HTTP calls to the D23 headless test driver's `commands::comments`
// ABOUTME: routes (P2b-11c) — the same real backend commands `src/comments/ipc.ts` calls, used
// ABOUTME: here to seed pre-existing threads and to play the agent's own half of J4 (the delivery a
// ABOUTME: real wired agent run would eventually produce — see acceptance.spec.mjs's own note on
// ABOUTME: why "Address with AI" itself is still driven through the real UI, not this helper).
import { post } from "./testDriverClient.mjs";

/** Creates a document-level or anchored thread — mirrors `comments/ipc.ts#createComment`. */
export function createComment(root, path, author, body, anchor, timestamp) {
  return post("create_comment", { root, path, author, body, anchor, timestamp });
}

/** The document's current thread list — mirrors `comments/ipc.ts#loadCommentThreads`. */
export function loadCommentThreads(root, path) {
  return post("load_comment_threads", { root, path });
}

/** Links delivered change ids to a thread's pending "Address with AI" run — mirrors
 * `comments/ipc.ts#linkChanges`. Stands in for the tracked-change half of a real agent delivery,
 * which nothing yet spawns behind `address_with_ai` (P2a-15's job) — see this file's own header. */
export function linkChanges(root, path, threadId, author, timestamp, changeIds) {
  return post("link_changes", { root, path, threadId, author, timestamp, changeIds });
}

/** Appends a reply — an ordinary explanatory reply, or (`defense: true`) FR-CMT-4's push-back —
 * mirrors `comments/ipc.ts#replyToComment`. */
export function replyToComment(root, path, threadId, author, body, defense, published, timestamp) {
  return post("reply_comment", { root, path, threadId, author, body, defense, published, timestamp });
}

/**
 * Arms the driver's one-shot batch fault window (#538): the **next** `address_all_with_ai` — the
 * app's own, made by the real UI — has its sidecar made read-only once `failAfter` appends have
 * landed, so the append after that genuinely fails and the run stops part-way (FR-AGENT-6).
 *
 * Not a mock: no application logic is replaced, and no failure is fabricated. The batch runs its
 * production path throughout and the error it reports is the real `store::service` write failing
 * against a real read-only file — the driver only changes the filesystem inside the window
 * `commands::comments::address_all_with_ai_watching` opens between two appends, which is the one
 * deterministic, sleep-free way to reach a *partial* batch until an agent run is wired behind
 * batch address (test-plan §4/§7; see that function's own docs).
 */
export function armBatchAddressFault(failAfter) {
  return post("arm_batch_address_fault", { failAfter });
}
