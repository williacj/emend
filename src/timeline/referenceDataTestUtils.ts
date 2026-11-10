// ABOUTME: Shared test helper for reading a composed agent prompt back apart (FR-CHAT-3/FR-CHAT-4)
// ABOUTME: — used by referenceData.test.ts and the TimelinePanel start_run suites; not a test file.
import { expect } from "vitest";
import { REFERENCE_DATA_LABEL } from "./referenceData";

/** FR-CHAT-4's `open_documents` envelope as it appears on the wire (snake_case, `unsaved`). */
export interface OpenDocumentsEnvelope {
  emend_context_version: number;
  kind: "open_documents";
  active: Record<string, unknown> | null;
  also_open: Record<string, unknown>[];
}

/** What `start_run` was actually invoked with, as `commands::agent::start_run` receives it. */
export interface StartRunPayload {
  root: string;
  prompt: string;
  operationTargets: string[];
}

/**
 * Splits a composed prompt back into the user's request, the reference-data block's lines, the
 * envelopes it carries, and the fixed statements between them — the shape a reader (or an agent)
 * actually receives.
 *
 * One place knows the block's layout (label line, then one JSON object per line, statements
 * interleaved as plain text). Three suites assert against it from different vantage points, and a
 * layout change should redden them by breaking this helper rather than by producing three
 * independent and differently-worded failures.
 */
export function parseReferenceData(prompt: string) {
  const [request, block] = prompt.split(`\n\n${REFERENCE_DATA_LABEL}\n`);
  const lines = (block ?? "").split("\n");
  const envelopes = lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { kind: string });
  return {
    request,
    lines,
    /** The block's plain-text lines — FR-CHAT-4's (a)/(a-pathless)/(b) statements. */
    statements: lines.filter((line) => !line.startsWith("{")),
    openDocuments: envelopes.find((e) => e.kind === "open_documents") as
      | OpenDocumentsEnvelope
      | undefined,
    quote: envelopes.find((e) => e.kind === "quoted_selection") as
      | Record<string, unknown>
      | undefined,
  };
}

/**
 * The `open_documents` envelope out of a composed prompt, failing with "no envelope" rather than a
 * JSON parse error when there is none — the diagnostic a regression in a submit path should give.
 */
export function openDocumentsEnvelopeIn(prompt: string): OpenDocumentsEnvelope {
  const envelope = parseReferenceData(prompt).openDocuments;
  expect(envelope, "no open_documents envelope in the composed prompt").toBeDefined();
  return envelope as OpenDocumentsEnvelope;
}

/**
 * The payload the most recent real `start_run` invocation carried, read out of a mocked
 * `@tauri-apps/api/core` `invoke`. A suite that drives the real `agentActivity.startRun` against
 * that boundary is looking at what literally reaches the command — the only vantage point from
 * which FR-CHAT-4's "the prompt names the open documents" claim is falsifiable.
 */
export function lastStartRunPayload(invokeCalls: unknown[][]): StartRunPayload {
  const calls = invokeCalls.filter(([command]) => command === "start_run");
  return calls[calls.length - 1]?.[1] as StartRunPayload;
}
