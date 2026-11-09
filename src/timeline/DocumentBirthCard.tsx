// ABOUTME: The document-birth card variant (§3.1 `timeline/`, J2 Phase B) — a successful
// ABOUTME: `create_document` call: the created path plus its size, exactly what the tool returned.
import { TimelineCard } from "./TimelineCard";
import type { DocumentBirthCard as DocumentBirthCardData } from "./types";

export interface DocumentBirthCardProps {
  card: DocumentBirthCardData;
}

/**
 * ux-design.md §3 J2 Phase B's own wireframe also shows a doc-kind line and a `via skill:`
 * attribution — `create_document(path, content)` carries neither and no ratified channel supplies
 * them (issue #420 scope note: render what the tool actually carries, never invent tool fields for
 * the annotation). This renders the path and the size the tool's own call reported, plus
 * `[Opened in editor]` — unlike the two dropped lines, that one is not a tool field the scope note
 * governs: the app knows it for certain, since it has already opened `path` as a tab by the time
 * this card lands (App's own `incomingCards` wiring). Ratified by CJ on #420 (2026-07-21, UXR-Q6;
 * `docs/ux-design.md` §5).
 */
export function DocumentBirthCard({ card }: DocumentBirthCardProps) {
  return (
    <TimelineCard
      id={card.id}
      kind={card.kind}
      header={<span className="document-birth-card__header">⬒ Draft created · Agent</span>}
    >
      <p className="document-birth-card__path" title={card.path}>
        {card.path}
      </p>
      <p className="document-birth-card__size">{card.size.toLocaleString()} bytes</p>
      <p className="document-birth-card__opened">[Opened in editor]</p>
    </TimelineCard>
  );
}
