// ABOUTME: Direct, non-mocked HTTP call to the D23 headless test driver's `/create_document` route
// ABOUTME: (P2b-11b) — the same real `agent::state::McpContext::create_document` write the app's own
// ABOUTME: MCP server performs, standing in for the agent turn nothing yet spawns behind it (#413).
import { post } from "./testDriverClient.mjs";

/**
 * Writes `content` to `path` (project-relative) under `root` through the real `create_document`
 * tool logic — path confinement, atomic write, identity mint all run for real — and returns the
 * same `{path, size}` shape the app's live birth-notice listener receives. The real McpContext
 * observer publishes the notice into the driver's cursor-backed log before this call returns; the
 * mounted production listener consumes it without a second script action (#1827).
 *
 * @returns {Promise<{path: string, size: number}>}
 */
export function createDocument(root, path, content) {
  return post("create_document", { root, path, content });
}
