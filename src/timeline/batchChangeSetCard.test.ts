// ABOUTME: Pins `batchChangeSetCardFor` (P2b, #537) — a real `address_all_with_ai` outcome's
// ABOUTME: per-thread accounting mapped onto J4 Batch's grouped-by-comment `ChangeSetCard` metadata.
import { describe, expect, it } from "vitest";
import type { BatchAddressOutcome } from "../comments/types";
import { thread } from "../comments/threadFixture";
import { batchChangeSetCardFor } from "./batchChangeSetCard";

function outcome(overrides: Partial<BatchAddressOutcome> = {}): BatchAddressOutcome {
  return {
    run_id: "run-1",
    addressed: [],
    skipped: [],
    untouched: [],
    interrupted: null,
    threads: [],
    ...overrides,
  };
}

describe("timeline/batchChangeSetCard", () => {
  it("returns undefined when the run addressed nothing", () => {
    expect(batchChangeSetCardFor(outcome({ addressed: [] }))).toBeUndefined();
  });

  it("returns undefined for an unrun (fully interrupted) batch", () => {
    expect(
      batchChangeSetCardFor(outcome({ addressed: [], untouched: ["a", "b"], interrupted: "backend went away" })),
    ).toBeUndefined();
  });

  it("builds one comment group per addressed thread in the outcome's addressed order", () => {
    const card = batchChangeSetCardFor(
      outcome({
        addressed: ["a", "b"],
        threads: [thread("a", { body: "finding A" }), thread("b", { body: "finding B" })],
      }),
    );

    expect(card?.kind).toBe("change-set");
    expect(card?.commentGroups?.map((group) => group.commentId)).toEqual(["a", "b"]);
    expect(card?.commentGroups?.map((group) => group.label)).toEqual(["finding A", "finding B"]);
  });

  it("labels a group from the anchored quote when the thread has one rather than the comment body", () => {
    const anchored = thread("a", {
      body: "Prefer a stronger adjective here.",
      anchor: {
        offset: 6,
        length: 5,
        text_snapshot: "brave",
        context_before: "Hello ",
        context_after: " world",
        base_revision: "rev-1",
      },
    });
    const card = batchChangeSetCardFor(outcome({ addressed: ["a"], threads: [anchored] }));

    expect(card?.commentGroups?.[0].label).toBe("brave");
  });

  it("maps a ratified severity string to its chip letter case-insensitively", () => {
    const card = batchChangeSetCardFor(
      outcome({
        addressed: ["a", "b", "c", "d"],
        threads: [
          thread("a", { severity: "high" }),
          thread("b", { severity: "M" }),
          thread("c", { severity: "low" }),
          thread("d", { severity: "Critical" }),
        ],
      }),
    );

    expect(card?.commentGroups?.map((group) => group.severity)).toEqual(["H", "M", "L", "C"]);
  });

  it("omits the severity chip entirely for a null or unrankable severity — never a guessed letter", () => {
    const card = batchChangeSetCardFor(
      outcome({
        addressed: ["a", "b"],
        threads: [thread("a", { severity: null }), thread("b", { severity: "unranked-finding" })],
      }),
    );

    expect(card?.commentGroups?.map((group) => group.severity)).toEqual([undefined, undefined]);
  });

  // Review finding (#537): `severityLetter`'s guessing fallback (first letter, uppercased) would
  // let these two through as a match for Critical/High respectively — neither is a ratified
  // spelling, so the chip must stay omitted rather than guessed.
  it("omits the severity chip for an unranked severity that merely starts with a ratified letter", () => {
    const card = batchChangeSetCardFor(
      outcome({
        addressed: ["a", "b"],
        threads: [thread("a", { severity: "cosmetic" }), thread("b", { severity: "housekeeping" })],
      }),
    );

    expect(card?.commentGroups?.map((group) => group.severity)).toEqual([undefined, undefined]);
  });

  // Review finding (#537): severity is unvalidated on the wire, so an Object.prototype key reaches the
  // chip lookup. It must read as "no chip", not as an inherited builtin — a non-string severity throws
  // in ChangeSetCard's render and unmounts the timeline.
  it("omits the severity chip for an Object.prototype key rather than an inherited builtin", () => {
    const card = batchChangeSetCardFor(
      outcome({
        addressed: ["a", "b"],
        threads: [thread("a", { severity: "__proto__" }), thread("b", { severity: "constructor" })],
      }),
    );

    expect(card?.commentGroups?.map((group) => group.severity)).toEqual([undefined, undefined]);
  });

  it("drops an addressed id absent from the refreshed thread list rather than inventing a group for it", () => {
    const card = batchChangeSetCardFor(outcome({ addressed: ["a", "ghost"], threads: [thread("a")] }));

    expect(card?.commentGroups?.map((group) => group.commentId)).toEqual(["a"]);
  });

  it("carries no changes/defenses/replies — nothing spawns the batch's provider run yet (P2a-15)", () => {
    const card = batchChangeSetCardFor(outcome({ addressed: ["a"], threads: [thread("a")] }));

    expect(card?.changes).toEqual([]);
    expect(card?.defenses).toEqual([]);
    expect(card?.replyCount).toBe(0);
  });

  it("summarizes the addressed count in the card's own prose summary singular vs. plural", () => {
    const one = batchChangeSetCardFor(outcome({ addressed: ["a"], threads: [thread("a")] }));
    const two = batchChangeSetCardFor(outcome({ addressed: ["a", "b"], threads: [thread("a"), thread("b")] }));

    expect(one?.summary).toBe("Addressed 1 comment.");
    expect(two?.summary).toBe("Addressed 2 comments.");
  });

  it("defaults the card id to a stable run-scoped identity", () => {
    const card = batchChangeSetCardFor(outcome({ run_id: "run-42", addressed: ["a"], threads: [thread("a")] }));

    expect(card?.id).toBe("batch-address-run-42");
  });

  it("accepts an explicit id/timestamp override", () => {
    const card = batchChangeSetCardFor(outcome({ addressed: ["a"], threads: [thread("a")] }), {
      id: "custom-id",
      timestamp: "2026-07-23T00:00:00.000Z",
    });

    expect(card?.id).toBe("custom-id");
    expect(card?.timestamp).toBe("2026-07-23T00:00:00.000Z");
  });

  it("fails closed on triage — a batch card corresponds to no live parse yet", () => {
    const card = batchChangeSetCardFor(outcome({ addressed: ["a"], threads: [thread("a")] }));

    expect(card?.doc).toBe("");
    expect(card?.generation).toBeNull();
  });
});
