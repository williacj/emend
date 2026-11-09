// @vitest-environment jsdom
// ABOUTME: Pins the D15 omission-aware adoption projection's exact provenance copy and identity.
// ABOUTME: Ensures the card never implies the omitted work was included in the saved file.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UntitledAdoptionCard } from "./UntitledAdoptionCard";

describe("UntitledAdoptionCard", () => {
  it("renders the ratified saved-path and omitted-work provenance", () => {
    render(<UntitledAdoptionCard card={{
      id: "adoption-a1",
      kind: "untitled-adoption",
      adoptionId: "a1",
      displacedPath: "old.md",
      destination: "drafts/new.md",
      timestamp: "2026-08-27T00:00:00.000Z",
    }} />);
    const card = document.querySelector('[data-card-kind="untitled-adoption"]');
    expect(card).toHaveAttribute("data-card-id", "adoption-a1");
    expect(screen.getByText(/Untitled saved as/).closest("p")).toHaveTextContent(
      "Untitled saved as drafts/new.md. The unsaved work from old.md that exceeded the session limit was not part of it.",
    );
  });

  function expectQuietCommentCopy(movedCommentCount: number, copy: string): void {
    render(<UntitledAdoptionCard card={{
      id: `adoption-${movedCommentCount}`,
      kind: "untitled-adoption",
      adoptionId: String(movedCommentCount),
      displacedPath: "old.md",
      destination: "drafts/new.md",
      recoveryContentOmitted: false,
      movedCommentCount,
      timestamp: "2026-09-06T00:00:00.000Z",
    }} />);

    expect(screen.getByText(/Untitled saved as/).closest("p")).toHaveTextContent(copy);
    expect(screen.queryByText(/tracked change/i)).not.toBeInTheDocument();
  }

  it("renders the quiet singular nonzero comment count without tracked-change wording", () => {
    expectQuietCommentCopy(1, "Untitled saved as drafts/new.md — 1 comment moved with it.");
  });

  it("renders the quiet plural nonzero comment count without tracked-change wording", () => {
    expectQuietCommentCopy(2, "Untitled saved as drafts/new.md — 2 comments moved with it.");
  });

  it("combines a moved-comment count and an omission outcome in one card", () => {
    render(<UntitledAdoptionCard card={{
      id: "adoption-combined",
      kind: "untitled-adoption",
      adoptionId: "combined",
      displacedPath: "old.md",
      destination: "drafts/new.md",
      recoveryContentOmitted: true,
      movedCommentCount: 2,
      timestamp: "2026-09-06T00:00:00.000Z",
    }} />);

    expect(document.querySelectorAll('[data-card-kind="untitled-adoption"]')).toHaveLength(1);
    expect(screen.getByText(/Untitled saved as/).closest("p")).toHaveTextContent(
      "Untitled saved as drafts/new.md — 2 comments moved with it. The unsaved work from old.md that exceeded the session limit was not part of it.",
    );
  });
});
