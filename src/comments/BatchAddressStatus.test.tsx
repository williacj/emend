// @vitest-environment jsdom
// ABOUTME: Unit proof of FR-AGENT-6 outcome honesty for a batch address run (P2b-3a): addressed,
// ABOUTME: skipped and untouched counts are reported distinctly, and an early stop names its reason.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchAddressStatus } from "./BatchAddressStatus";
import type { BatchAddressOutcome } from "./types";

function outcome(overrides: Partial<BatchAddressOutcome> = {}): BatchAddressOutcome {
  return {
    run_id: "batch-1",
    addressed: [],
    skipped: [],
    untouched: [],
    interrupted: null,
    threads: [],
    ...overrides,
  };
}

describe("BatchAddressStatus — FR-AGENT-6 outcome honesty", () => {
  it("reports which threads completed and which were left untouched on an interrupted run", () => {
    render(<BatchAddressStatus batchNumber={1} outcome={outcome({ addressed: ["a"], untouched: ["b", "c"], interrupted: "disk went away" })} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("1 addressed");
    expect(status.textContent).toContain("2 untouched");
    // The reason is surfaced, not swallowed — the user must know the run stopped early.
    expect(status.textContent).toContain("disk went away");
  });

  it("reports skipped threads distinctly from untouched ones", () => {
    render(<BatchAddressStatus batchNumber={1} outcome={outcome({ addressed: ["a", "b"], skipped: ["c"] })} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("2 addressed");
    expect(status.textContent).toContain("1 skipped");
    expect(status.textContent).not.toContain("untouched");
  });

  it("says nothing about interruption after a clean run", () => {
    render(<BatchAddressStatus batchNumber={1} outcome={outcome({ addressed: ["a", "b", "c"] })} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("3 addressed");
    expect(status.textContent).not.toContain("untouched");
    expect(status.textContent).not.toContain("stopped");
  });
});
