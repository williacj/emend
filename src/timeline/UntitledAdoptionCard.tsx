// ABOUTME: Renders the D15 projection of an omission-aware untitled-document adoption event.
// ABOUTME: Uses the ratified copy and keeps the durable adoptionId on the base timeline card.

import { TimelineCard } from "./TimelineCard";
import type { UntitledAdoptionCard as UntitledAdoptionCardData } from "./types";

export function UntitledAdoptionCard({ card }: { card: UntitledAdoptionCardData }) {
  return (
    <TimelineCard id={card.id} kind={card.kind}>
      <p>
        Untitled saved as <strong>{card.destination}</strong>
        {(card.movedCommentCount ?? 0) > 0 && (
          <> — {card.movedCommentCount} {card.movedCommentCount === 1 ? "comment" : "comments"} moved with it</>
        )}
        .{card.recoveryContentOmitted !== false && (
          <> The unsaved work from <strong>{card.displacedPath}</strong> that exceeded the session limit was not part of it.</>
        )}
      </p>
    </TimelineCard>
  );
}
