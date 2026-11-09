// @vitest-environment jsdom
// ABOUTME: Component proof of the project-grounding card (P2b-8b, #360, J8 Screen 2): the summary
// ABOUTME: line's exact wording, the tap-to-list expansion, and the honest zero-count case.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectGroundingCard } from "./ProjectGroundingCard";
import { createProjectGroundingCard } from "./types";

describe("timeline/ProjectGroundingCard", () => {
  it('renders J8\'s own summary shape — "Found N skills, M workflows, <instruction file>"', () => {
    const card = createProjectGroundingCard(
      [
        { name: "grammar", description: "Fixes grammar." },
        { name: "distill", description: "Distills lessons." },
      ],
      [{ name: "sermon-review" }],
      "CLAUDE.md",
    );
    render(<ProjectGroundingCard card={card} />);

    expect(screen.getByText("Found 2 skills, 1 workflow, CLAUDE.md")).toBeInTheDocument();
  });

  it("omits the instruction-file clause entirely when the project has none — never a placeholder", () => {
    const card = createProjectGroundingCard([{ name: "grammar", description: "Fixes grammar." }], [], undefined);
    render(<ProjectGroundingCard card={card} />);

    expect(screen.getByText("Found 1 skill, 0 workflows")).toBeInTheDocument();
  });

  it("still raises an honest card for a project with zero skills and zero workflows (Principle 7)", () => {
    const card = createProjectGroundingCard([], [], undefined);
    render(<ProjectGroundingCard card={card} />);

    expect(screen.getByText("Found 0 skills, 0 workflows")).toBeInTheDocument();
    expect(screen.getByText("No skills or workflows found in this project.")).toBeInTheDocument();
  });

  it("tapping the summary lists every discovered skill by name and description", () => {
    const card = createProjectGroundingCard(
      [{ name: "grammar", description: "Fixes grammar issues in prose." }],
      [{ name: "sermon-review" }],
      "CLAUDE.md",
    );
    render(<ProjectGroundingCard card={card} />);

    // Collapsed by default: the native `<details>` starts closed, so the list exists in the DOM
    // but is not visible — `toBeInTheDocument` alone wouldn't catch a details left open by mistake.
    expect(screen.getByText("Fixes grammar issues in prose.")).not.toBeVisible();

    fireEvent.click(screen.getByText("Found 1 skill, 1 workflow, CLAUDE.md"));

    expect(screen.getByText("grammar")).toBeInTheDocument();
    expect(screen.getByText("Fixes grammar issues in prose.")).toBeInTheDocument();
    expect(screen.getByText("sermon-review")).toBeInTheDocument();
  });

  it("mirrors the base card's id/kind contract (data-card-id/data-card-kind)", () => {
    const card = createProjectGroundingCard([], [], undefined, { id: "grounding-1" });
    const { container } = render(<ProjectGroundingCard card={card} />);

    const article = container.querySelector("article");
    expect(article).toHaveAttribute("data-card-id", "grounding-1");
    expect(article).toHaveAttribute("data-card-kind", "project-grounding");
  });
});
