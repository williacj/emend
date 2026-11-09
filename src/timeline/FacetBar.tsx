// ABOUTME: The timeline's facet filter bar (§3.1 `timeline/`, ux-design §4 "Right rail —
// ABOUTME: timeline ... facet filters") — renders the five ratified facets; `TimelinePanel` owns
// ABOUTME: what selecting one does (filter + facet-jump), this component only reports the click.
import { FACETS } from "./facets";

export interface FacetBarProps {
  activeFacetId: string;
  onSelect: (facetId: string) => void;
}

/** Uses the same labeled button-group semantics as the General Settings theme chooser. */
export function FacetBar({ activeFacetId, onSelect }: FacetBarProps) {
  return (
    <div className="timeline-panel__facets" role="group" aria-label="Timeline facets">
      {FACETS.map((facet) => (
        <button
          key={facet.id}
          type="button"
          className="timeline-panel__facet"
          aria-pressed={facet.id === activeFacetId}
          onClick={() => onSelect(facet.id)}
        >
          {facet.label}
        </button>
      ))}
    </div>
  );
}
