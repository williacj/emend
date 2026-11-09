// ABOUTME: The project-grounding card variant (P2b-8b, #360, J8 Screen 2, FR-SKILL-1) — a
// ABOUTME: one-time-per-project-open summary of discovered skills/workflows/instruction file that
// ABOUTME: expands (tap) to list each one by name and description.
import { TimelineCard } from "./TimelineCard";
import type { ProjectGroundingCard as ProjectGroundingCardData } from "./types";

export interface ProjectGroundingCardProps {
  card: ProjectGroundingCardData;
}

/** The card's one-line summary — J8 Screen 2's own literal wireframe text, *"Found 9 skills, 5
 * workflows, claude.md"* — built from whatever this project actually has, including the honest
 * zero case (Principle 7: no skills and no workflows still reads "Found 0 skills, 0 workflows",
 * never a hidden card). The instruction-file clause is appended only when one was found — omitted,
 * never a placeholder, when it wasn't (FR-SKILL-1's "if present"). */
function summaryLine(card: ProjectGroundingCardData): string {
  const parts = [
    `${card.skills.length} ${card.skills.length === 1 ? "skill" : "skills"}`,
    `${card.workflows.length} ${card.workflows.length === 1 ? "workflow" : "workflows"}`,
  ];
  if (card.instructionFile) parts.push(card.instructionFile);
  return `Found ${parts.join(", ")}`;
}

/**
 * Renders as a native `<details>`/`<summary>` — the same "tap to expand" idiom
 * `ChangeSetCard`'s per-section/per-comment groups already use, so this card needs no bespoke
 * expand/collapse state or keyboard handling of its own. Collapsed, only the summary line shows;
 * expanded, it lists every discovered skill (name + description) and workflow (name) — or, for a
 * genuinely empty project, says so honestly rather than rendering nothing.
 */
export function ProjectGroundingCard({ card }: ProjectGroundingCardProps) {
  const hasAnythingToList = card.skills.length > 0 || card.workflows.length > 0;
  return (
    <TimelineCard id={card.id} kind={card.kind}>
      <details className="project-grounding-card">
        <summary className="project-grounding-card__summary">{summaryLine(card)}</summary>
        {hasAnythingToList ? (
          <>
            {card.skills.length > 0 && (
              <ul className="project-grounding-card__skills">
                {card.skills.map((skill, index) => (
                  <li key={`${skill.name}-${index}`} className="project-grounding-card__skill">
                    <span className="project-grounding-card__skill-name">{skill.name}</span>
                    <span className="project-grounding-card__skill-description">{skill.description}</span>
                  </li>
                ))}
              </ul>
            )}
            {card.workflows.length > 0 && (
              <ul className="project-grounding-card__workflows">
                {card.workflows.map((workflow, index) => (
                  <li key={`${workflow.name}-${index}`} className="project-grounding-card__workflow">
                    {workflow.name}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="project-grounding-card__empty">No skills or workflows found in this project.</p>
        )}
      </details>
    </TimelineCard>
  );
}
