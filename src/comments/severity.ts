// ABOUTME: Free-form severity string → display letter (P2b-5b, FR-REVIEW-2, ux-design §2's
// ABOUTME: "colour + letter, never colour alone" chip). Distinct from `batchAddress.ts`'s
// ABOUTME: `severityRank`, which orders severities for batch-floor filtering and deliberately
// ABOUTME: leaves "critical" unrankable — a different question from what letter a chip shows.
import type { CommentThread } from "./types";

/**
 * The ratified spellings a severity chip's four letters (`C`/`H`/`M`/`L`) recognize — the same
 * long-form spellings `severityRank` does, plus `"critical"`/`"c"` (the ranking helper leaves
 * critical unrankable by design, since it never needs comparing for a batch floor, but the
 * *display* chip has no such abstinence to keep). Keyed by the trimmed, lowercased input so every
 * lookup site (`severityLetter`'s guessing fallback, `batchChangeSetCard.ts`'s no-guessing chip)
 * shares one definition of "ratified" rather than each re-deriving it (review finding, #537:
 * `commentSeverity` used to filter `severityLetter`'s *output* letter, which let any unranked
 * input starting with c/h/m/l — "cosmetic", "housekeeping" — leak through as a guessed match).
 *
 * A `Map`, not an object literal, because the key is an unvalidated agent-supplied string
 * (`store::comments::Thread.severity` is free-form by ratified design): an object lookup inherits
 * `Object.prototype`, so `"__proto__"`/`"constructor"` answer with a builtin rather than reading as
 * absent — which `ratifiedSeverityLetter` would return in place of `undefined`, and `severityLetter`
 * would return in place of its first-letter fallback. Either way a non-string reaches the chip, where
 * React's render throws on it (`CommentThreadCard`, `ChangeSetCard`) or `setAttribute`/`textContent`
 * coerce it to `● [object Object]` (`editor/severityMarginMarks`) — review finding on PR #613, #537.
 */
const RATIFIED_SEVERITIES = new Map<string, "C" | "H" | "M" | "L">([
  ["critical", "C"],
  ["c", "C"],
  ["high", "H"],
  ["h", "H"],
  ["medium", "M"],
  ["med", "M"],
  ["m", "M"],
  ["low", "L"],
  ["l", "L"],
]);

/**
 * The letter a severity chip renders (`● {letter}`) for a free-form `CommentThread.severity`
 * string.
 *
 * An unrecognized value still renders its own first letter, uppercased, rather than going blank:
 * severity has no ratified vocabulary on the wire, and a silently empty chip would satisfy the
 * "never colour alone" rule by accident (no colour *or* letter) instead of on purpose. An empty or
 * whitespace-only severity has no first letter to take, so it falls back to `"?"` rather than
 * `""` — the wire's `severity` is an unvalidated `Option<String>` (agent-supplied via the MCP
 * `add_comments` path), and `""` is fully representable end-to-end.
 */
export function severityLetter(severity: string): string {
  const trimmed = severity.trim();
  const ratified = RATIFIED_SEVERITIES.get(trimmed.toLowerCase());
  if (ratified) return ratified;
  return trimmed === "" ? "?" : trimmed.charAt(0).toUpperCase();
}

/**
 * The same ratified-vocabulary lookup `severityLetter` uses, without its guessing fallback —
 * `undefined` for anything outside the four ratified spellings rather than a first letter that
 * merely happens to collide with one (`"cosmetic"` must never read as Critical). This is what a
 * chip whose own contract is "no chip at all beats a guessed one" (`batchChangeSetCard.ts`'s
 * `commentSeverity`) needs instead of `severityLetter`.
 */
export function ratifiedSeverityLetter(severity: string): "C" | "H" | "M" | "L" | undefined {
  return RATIFIED_SEVERITIES.get(severity.trim().toLowerCase());
}

/**
 * A thread carries review-finding provenance (D6: "severity-tagged, skill-attributed") when either
 * its severity or its source skill is set — both `null` is D6's "ordinary human comment". Findings
 * are never a separate card kind (issue #355 — the same `CommentThreadCard` renders every
 * provenance), so anything that needs to distinguish a finding from a plain comment (the Findings
 * facet, `timeline/facets.ts`) reads this rather than a `kind`.
 */
export function isFindingProvenance(thread: Pick<CommentThread, "severity" | "skill">): boolean {
  return thread.severity !== null || thread.skill !== null;
}
