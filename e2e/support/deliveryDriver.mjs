// ABOUTME: Direct, non-mocked HTTP call to the D23 headless test driver's `/propose_changes` route
// ABOUTME: (P2b-11a, #365) — the same real `agent::state::McpContext::propose_changes` rebase,
// ABOUTME: attribution and atomic write the app's own MCP server performs, standing in for the
// ABOUTME: agent turn nothing yet spawns behind it (no `McpServer` is wired into a run yet).
import { post } from "./testDriverClient.mjs";

/**
 * Proposes `edits` against `doc` under `root`, anchored to `baseContent` (TD-7: "the document as
 * the agent read it") — the real rebase/attribution/atomic-write logic runs, so a live divergence
 * between `baseContent` and whatever is actually on disk (e.g. the user kept typing, or this script
 * wrote over the file directly) genuinely exercises TD-7's partial-apply path, not a simulation of
 * it. Returns the same `DeliveryNotice` shape `stores/delivery.ts` mirrors on the frontend, or `null`
 * when nothing landed at all (FR-AGENT-6: a wholly-stale or wholly-unrepresentable delivery raises
 * no notice). A landed notice is also published by the real McpContext observer into the driver's
 * cursor-backed log, so the mounted production listener consumes it without a script injection.
 *
 * @param {string} root
 * @param {string} doc
 * @param {string} baseContent
 * @param {Array<{range: {offset: number, length: number}, replacement: string, note?: string}>} edits
 * @param {string} summary
 * @param {{groups?: number[][]}} [changeSetMeta]
 * @returns {Promise<import("../../src/stores/delivery.js").DeliveryNotice | null>}
 */
export function proposeChanges(root, doc, baseContent, edits, summary, changeSetMeta) {
  return post("propose_changes", { root, doc, baseContent, edits, summary, changeSetMeta });
}
