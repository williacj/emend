// @vitest-environment jsdom
// ABOUTME: Component proof of the document-birth card (#420, J2 Phase B): renders the created path
// ABOUTME: and its size — never a doc kind or `via skill:` line the tool call doesn't carry.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentBirthCard } from "./DocumentBirthCard";
import { createDocumentBirthCard } from "./types";

describe("timeline/DocumentBirthCard", () => {
  it("renders the created path and its size", () => {
    const card = createDocumentBirthCard("drafts/kenosis-daily.md", 1480);
    render(<DocumentBirthCard card={card} />);

    expect(screen.getByText("drafts/kenosis-daily.md")).toHaveAttribute(
      "title",
      "drafts/kenosis-daily.md",
    );
    expect(screen.getByText("1,480 bytes")).toBeInTheDocument();
  });

  it("renders only the path and size — no doc-kind or via-skill line the tool call doesn't carry (scope note)", () => {
    const card = createDocumentBirthCard("drafts/kenosis-daily.md", 1480);
    render(<DocumentBirthCard card={card} />);

    expect(screen.queryByText(/via skill/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sermonette/i)).not.toBeInTheDocument();
  });

  // CJ's ratification on #420 (2026-07-21, UXR-Q6): unlike doc-kind/`via skill:`, this line is
  // added back — it is not a tool field the scope note governs, since the app knows it for certain
  // (it just opened the created path as a tab, App's own birth-pipe wiring).
  it("renders the [Opened in editor] line — the app knows this for certain unlike the dropped tool fields", () => {
    const card = createDocumentBirthCard("drafts/kenosis-daily.md", 1480);
    render(<DocumentBirthCard card={card} />);

    expect(screen.getByText("[Opened in editor]")).toBeInTheDocument();
  });

  it("mirrors the base card's id/kind contract (data-card-id/data-card-kind)", () => {
    const card = createDocumentBirthCard("drafts/a.md", 1, { id: "birth-1" });
    const { container } = render(<DocumentBirthCard card={card} />);

    const article = container.querySelector("article");
    expect(article).toHaveAttribute("data-card-id", "birth-1");
    expect(article).toHaveAttribute("data-card-kind", "document-birth");
  });
});
