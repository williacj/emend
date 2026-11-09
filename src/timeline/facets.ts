// ABOUTME: Facet definitions and pure filter/jump-target logic for the timeline's facet bar
// ABOUTME: (§3.1 `timeline/`, ux-design §4 "facet filters" + "Timeline at scale") — kept
// ABOUTME: independent of rendering so selection/jump correctness is unit-testable directly.
import { isFindingProvenance } from "../comments/severity";
import type { TimelineCard } from "./types";

/**
 * One of the five ratified facets (ux-design §4 "Right rail — timeline ... facet filters (All /
 * Chat / Comments / Changes / Findings)"). `kinds` lists the card `kind`(s) it includes — `null`
 * for "All" (every kind, and no single "most recent kind" jump target).
 */
export interface Facet {
  id: string;
  label: string;
  kinds: readonly TimelineCard["kind"][] | null;
  /**
   * What this facet says when it filters the stream down to nothing — "No comments yet", never a
   * silent blank panel (issue #1727, Principle 7: *"found nothing" is itself honest information*,
   * matching `ProjectRail`'s "No files yet" precedent). Distinct per facet so an empty Findings
   * reads as "no findings" rather than a copy-pasted generic emptiness.
   */
  emptyLabel: string;
  /**
   * Narrows a `kinds` match further — e.g. Findings (P2b-5b, D6). A review finding is never a
   * separate card kind: it's a `"comment"` card whose thread carries review provenance (severity
   * and/or source skill), rendered through the identical `CommentThreadCard` as a plain human
   * comment (issue #355 — forking a parallel "finding card" would be exactly the mistake D6's
   * unified-comment-system decision exists to avoid). So the Findings facet can't select on `kind`
   * alone the way Chat/Comments/Changes do; this is where that extra provenance check lives.
   * Omitted for a facet where `kinds` alone is the whole selection rule.
   */
  match?: (card: TimelineCard) => boolean;
}

export const ALL_FACET_ID = "all";

/** Filter-bar render order. */
export const FACETS: readonly Facet[] = [
  { id: ALL_FACET_ID, label: "All", kinds: null, emptyLabel: "No activity yet" },
  { id: "chat", label: "Chat", kinds: ["chat-message", "agent-working"], emptyLabel: "No chat yet" },
  { id: "comments", label: "Comments", kinds: ["comment"], emptyLabel: "No comments yet" },
  { id: "changes", label: "Changes", kinds: ["change-set"], emptyLabel: "No changes yet" },
  {
    id: "findings",
    label: "Findings",
    kinds: ["comment"],
    match: (card) => card.kind === "comment" && isFindingProvenance(card.thread),
    emptyLabel: "No findings yet",
  },
];

/** Looks up a facet by id — throws on an unknown id rather than silently rendering nothing, the
 * same "loud over silent" rule the rest of this module follows. Exported so `TimelinePanel` can
 * read the active facet's `emptyLabel` without a second lookup table. */
export function facetById(facetId: string): Facet {
  const facet = FACETS.find((f) => f.id === facetId);
  if (!facet) throw new Error(`Unknown timeline facet: ${facetId}`);
  return facet;
}

/**
 * Filters `cards` to `facetId`'s kind(s) — further narrowed by `match` when the facet declares one
 * (Findings) — preserving the stream's existing order (chronological order is the stream's one
 * ordering rule — D4/D6 — this never re-sorts). "All" returns every card unfiltered.
 */
export function filterCardsByFacet(cards: readonly TimelineCard[], facetId: string): TimelineCard[] {
  const facet = facetById(facetId);
  const visible = cards.filter((card) => card.kind !== "comment" || card.thread.withdrawn_at == null || card.thread.visible_when_withdrawn);
  if (facet.kinds === null) return visible;
  const kinds = facet.kinds;
  return visible.filter((card) => kinds.includes(card.kind) && (facet.match?.(card) ?? true));
}

/**
 * The single non-"All" facet whose `kinds`/`match` selects `card` (P2b-1c, UXR-Q2) — the `N new in
 * <Facet> →` affordance's facet-name lookup for a card the active filter just excluded. A card
 * carries exactly one `kind` discriminant (D6), so at most one kind-scoped facet ever claims it;
 * `undefined` for a kind no ratified facet declares. That *is* reachable today — `document-birth`
 * and `project-grounding` (#360/#420) both resolve to `undefined`, an orphan status issue #1727
 * measured and `facets.test.ts` now pins across all six kinds — until a J#/Designer decision (not
 * an Engineer's guess) assigns either one a facet. Kept general rather than hard-coded so that
 * decision is a one-line `FACETS` edit, not a rewrite here.
 */
export function facetForCard(card: TimelineCard): Facet | undefined {
  if (card.kind === "comment" && card.thread.withdrawn_at != null && !card.thread.visible_when_withdrawn) return undefined;
  return FACETS.find(
    (facet) => facet.id !== ALL_FACET_ID && facet.kinds?.includes(card.kind) && (facet.match?.(card) ?? true),
  );
}

/**
 * The index, within an already-`filterCardsByFacet`-filtered array, of the facet-jump target: the
 * most recent — i.e. last, given the stream's chronological order — card of `facetId`'s kind.
 * `undefined` (a no-op jump, never a throw) when the filtered stream is empty, and always for
 * "All" — restoring the full stream has no single "most recent kind" to jump to (ux-design §4
 * ties the jump to "a facet (Changes, Findings…)", not to "All").
 */
export function facetJumpIndex(facetId: string, filteredCards: readonly TimelineCard[]): number | undefined {
  const facet = facetById(facetId);
  if (facet.kinds === null) return undefined;
  return filteredCards.length > 0 ? filteredCards.length - 1 : undefined;
}
