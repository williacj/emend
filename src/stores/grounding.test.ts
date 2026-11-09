// ABOUTME: Tests for the grounding IPC bridge + card mapping (P2b-8b, #360) — the frontend end of
// ABOUTME: J8 Screen 2's project card: which command it calls, and how one `discover_grounding`
// ABOUTME: result becomes a project-grounding card.
import { describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({ callBackend: (...args: unknown[]) => callBackendMock(...args) }));

const { discoverGrounding, groundingCardFor } = await import("./grounding");

describe("discoverGrounding", () => {
  it("calls discover_grounding with the project root and returns the payload", async () => {
    const payload = {
      skills: [{ name: "grammar", description: "Fixes grammar." }],
      workflows: [{ name: "sermon-review" }],
      instructionFile: "CLAUDE.md",
    };
    callBackendMock.mockResolvedValueOnce(payload);

    const result = await discoverGrounding("/project");

    expect(callBackendMock).toHaveBeenCalledWith("discover_grounding", { root: "/project" });
    expect(result).toEqual(payload);
  });
});

describe("groundingCardFor", () => {
  it("carries the payload's skills, workflows, and instruction file onto the card", () => {
    const card = groundingCardFor(
      {
        skills: [{ name: "grammar", description: "Fixes grammar.", path: ".claude/skills/grammar/SKILL.md" }],
        workflows: [{ name: "sermon-review", path: "workflows/sermon-review.md" }],
        instructionFile: "CLAUDE.md",
      },
      { id: "c-1", timestamp: "T" },
    );

    expect(card.kind).toBe("project-grounding");
    expect(card.skills).toEqual([{ name: "grammar", description: "Fixes grammar." }]);
    expect(card.workflows).toEqual([{ name: "sermon-review" }]);
    expect(card.instructionFile).toBe("CLAUDE.md");
    expect(card.id).toBe("c-1");
    expect(card.timestamp).toBe("T");
  });

  it("maps a null instructionFile (the wire's honest 'none') to undefined, never a placeholder string", () => {
    const card = groundingCardFor({ skills: [], workflows: [], instructionFile: null });

    expect(card.instructionFile).toBeUndefined();
  });

  it("generates a distinct id per call when none is given", () => {
    const first = groundingCardFor({ skills: [], workflows: [], instructionFile: null });
    const second = groundingCardFor({ skills: [], workflows: [], instructionFile: null });

    expect(first.id).not.toBe(second.id);
  });
});
