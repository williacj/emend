// ABOUTME: Mints and resolves the portable run identity an "Address with AI" run carries
// ABOUTME: (FR-CMT-2/FR-CMT-5) — shared by the single-thread path and the batch path so both name
// ABOUTME: a run the same way, with one defensive fallback for an empty `start_run` acknowledgement.
const sessionSalt = `${Date.now().toString(36)}${Math.random().toString(36).slice(1)}`;
let runIdCounter = 0;

/**
 * A fresh address-run id. Since #1760 an ordinary run carries the backend's own restart-unique
 * `run-<uuid>` and this is only the fallback `resolvedRunId` reaches when `start_run` names no run,
 * plus the id for a frontend-only failed-run card. The fallback can still be stamped into the
 * published comment-event sidecar (`docs/formats/sidecar/comment-event.schema.json`, FR-X-8/D22),
 * so it must separate sessions and machines rather than merely count within one process (#1782).
 * Match `timeline/types.ts`'s #1728 portability pattern: use Web Crypto where the webview exposes
 * it, otherwise combine a per-process salt with the counter so a D23/non-secure-context fallback
 * does not restart at `run-1`.
 *
 * One call = one run. The single path mints one per thread; a batch mints **one for the whole run**
 * and passes it for every targeted thread, which is what lets the delivery come back as one
 * grouped change-set card (FR-CMT-5/D8). Actually spawning the run this id names rides the
 * agent-run seam — minting it only records that a run started.
 */
export function mintRunId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return `run-${webCrypto.randomUUID()}`;
  runIdCounter += 1;
  return `run-${sessionSalt}-${runIdCounter}`;
}

/**
 * The id an address event should be stamped with, given what `start_run` actually returned
 * (#1721): `startRunId` when it names a real run, or a fresh [`mintRunId`] when it doesn't.
 * A defensive/legacy caller may still supply an empty acknowledgement. That empty string must
 * never reach `deriveThreadState`'s `pending_run` check
 * (`if (thread.pending_run && thread.pending_run_started) …` reads `""` as falsy, i.e. "no run"),
 * so this is the one place every "Address with AI" caller (`timeline/CommentCard`,
 * `editor/CommentPopover`, `timeline/TimelinePanel.handleAddressAll`) resolves that fallback,
 * rather than repeating the same `id || mintRunId()` three times.
 */
export function resolvedRunId(startRunId: string): string {
  return startRunId || mintRunId();
}
