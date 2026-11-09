// ABOUTME: The `N new in <Facet> →` affordance (§3.1 `timeline/`, P2b-1c/UXR-Q2 — ux-design §4):
// ABOUTME: `TimelinePanel` owns the count/dismiss lifecycle, this only renders and reports the click.
export interface NewInFacetAffordanceProps {
  /** The facet the excluded submitted card(s) belong to (e.g. "Chat") — never "All", since "All"
   * never excludes anything (`facetForCard` only ever resolves a kind-scoped facet). */
  facetLabel: string;
  /** How many submitted cards have landed outside the active filter since this last showed. */
  count: number;
  /** Facet-jump to `facetLabel`'s facet and land on the (most recent, i.e. just-submitted) card of
   * that kind — `TimelinePanel` wires this straight to the same handler `FacetBar` uses, so this is
   * ordinary facet-jump with a count on it, not a second navigation pattern. */
  onClick: () => void;
}

/** Mirrors `FacetBar`'s button treatment (`timeline-panel__facet`) rather than inventing a second
 * button style — this is a facet-jump trigger wearing a count, not a distinct control family. */
export function NewInFacetAffordance({ facetLabel, count, onClick }: NewInFacetAffordanceProps) {
  return (
    <button type="button" className="timeline-panel__new-in-facet" onClick={onClick}>
      {count} new in {facetLabel} →
    </button>
  );
}
