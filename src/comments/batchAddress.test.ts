// ABOUTME: Tests for the batch-address trigger condition and J4's source/severity/review-pass
// ABOUTME: filter set (P2b-3a, FR-CMT-5/D8, J4 Batch, J4-Q1 "filters available but not pre-applied").
import { describe, expect, it } from "vitest";
import {
  NO_BATCH_FILTER,
  canBatchAddress,
  reviewPassesIn,
  selectBatchSelection,
  selectBatchTargets,
  sourcesIn,
  severityRank,
} from "./batchAddress";
import { thread } from "./threadFixture";

describe("canBatchAddress", () => {
  it("counts an open overlapping target even when its scalar pending run is ambiguous", () => {
    const overlap = thread("held", { pending_run: null, pending_runs: [
      { run_id: "run-1", address_event_id: "a1", started: true, guidance: null, corrected: false },
      { run_id: "run-2", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    expect(canBatchAddress([thread("open"), overlap])).toBe(true);
    expect(selectBatchTargets([thread("open"), overlap], NO_BATCH_FILTER, [], []).map((item) => item.id)).toEqual(["open"]);
  });
  it("J10 withdrawn projection excludes deleted roots from Address all", () => {
    const visible = thread("a");
    const deleted = thread("b", { withdrawn_at: 9, visible_when_withdrawn: true });
    expect(selectBatchTargets([visible, deleted], NO_BATCH_FILTER, [], []).map((item) => item.id)).toEqual(["a"]);
    expect(canBatchAddress([visible, deleted])).toBe(false);
  });
  // J4's literal condition: "From the timeline header when >1 open comment".
  it("is false with no comments and with exactly one open comment", () => {
    expect(canBatchAddress([])).toBe(false);
    expect(canBatchAddress([thread("a")])).toBe(false);
  });

  it("is true with more than one open comment", () => {
    expect(canBatchAddress([thread("a"), thread("b")])).toBe(true);
  });

  it("counts unresolved comments even when another run already targets them", () => {
    const threads = [
      thread("a"),
      thread("b", { resolved: true }),
      thread("c", { pending_run: "run-1" }),
    ];
    expect(canBatchAddress(threads)).toBe(true);
  });
});

describe("selectBatchSelection — J4 disclosed narrowing", () => {
  it("counts matching open comments and partitions live and queued holds after filtering", () => {
    const threads = [
      thread("open", { skill: "style" }),
      thread("live", { skill: "style", pending_run: "run-live" }),
      thread("queued", { skill: "style", pending_runs: [{ run_id: "run-queued", address_event_id: "a2", started: false, guidance: null, corrected: false }] }),
      thread("delivered", { skill: "style", targeting_run_ids: ["run-live"] }),
      thread("other", { skill: "accuracy", pending_run: "run-live" }),
      thread("closed", { skill: "style", resolved: true }),
    ];
    const selection = selectBatchSelection(threads, { ...NO_BATCH_FILTER, source: "style" }, ["run-live", "run-queued"], []);
    expect(selection.matching.map((item) => item.id)).toEqual(["open", "live", "queued", "delivered"]);
    expect(selection.available.map((item) => item.id)).toEqual(["open"]);
    expect(selection.held.map((item) => item.id)).toEqual(["live", "queued", "delivered"]);
  });

  it("releases a stale marker after a terminal observation", () => {
    const threads = [thread("free"), thread("stale", { pending_run: "run-ended" })];
    const selection = selectBatchSelection(threads, NO_BATCH_FILTER, [], ["run-ended"]);
    expect(selection.available.map((item) => item.id)).toEqual(["free", "stale"]);
    expect(selection.held).toEqual([]);
  });
});

describe("selectBatchTargets", () => {
  it("excludes a delivered target until its run is terminal", () => {
    const threads = [thread("a"), thread("delivered", { targeting_run_ids: ["run-live"] })];
    expect(selectBatchTargets(threads, NO_BATCH_FILTER, ["run-live"], []).map((item) => item.id)).toEqual(["a"]);
    expect(selectBatchTargets(threads, NO_BATCH_FILTER, [], ["run-live"]).map((item) => item.id)).toEqual(["a", "delivered"]);
  });
  // J4-Q1: batch default is all open comments, filters available but NOT pre-applied.
  it("defaults to every open thread with no filter pre-applied", () => {
    const threads = [
      thread("a", { severity: "low", skill: "style" }),
      thread("b", { severity: "high", skill: "biblical-accuracy" }),
      thread("c", { resolved: true }),
    ];
    expect(selectBatchTargets(threads, NO_BATCH_FILTER, [], []).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("never targets a resolved or already-pending thread", () => {
    const threads = [
      thread("a"),
      thread("b", { resolved: true }),
      thread("c", { pending_run: "run-1" }),
    ];
    expect(selectBatchTargets(threads, NO_BATCH_FILTER, [], []).map((t) => t.id)).toEqual(["a"]);
  });

  it("filters by source (the skill that raised the finding)", () => {
    const threads = [
      thread("a", { skill: "biblical-accuracy" }),
      thread("b", { skill: "style" }),
    ];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, source: "biblical-accuracy" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["a"]);
  });

  it("treats a human comment as the 'human' source", () => {
    const threads = [thread("a", { skill: "style" }), thread("b", { skill: null })];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, source: "human" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["b"]);
  });

  it("filters by severity floor inclusive of the floor itself", () => {
    const threads = [
      thread("a", { severity: "low" }),
      thread("b", { severity: "medium" }),
      thread("c", { severity: "high" }),
    ];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, severityAtLeast: "medium" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("ranks the single-letter severity forms the review path also emits", () => {
    const threads = [thread("a", { severity: "L" }), thread("b", { severity: "H" })];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, severityAtLeast: "medium" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["b"]);
  });

  // Severity is a free-form string on the wire with no ratified vocabulary, so an unrankable or
  // absent severity must not be silently treated as "high" and swept into a filtered batch.
  it("excludes threads with no rankable severity when a severity floor is applied", () => {
    const threads = [
      thread("a", { severity: null }),
      thread("b", { severity: "spicy" }),
      thread("c", { severity: "high" }),
    ];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, severityAtLeast: "low" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["c"]);
  });

  // The mirror of the case above, on the *floor* side: "unfiltered" and "a floor I can't read" are
  // different questions and must not collapse into the same answer. Widening to every open thread
  // would be the exact inversion of the safety stance — a batch sweeping in findings whose severity
  // it never compared. An unreadable floor selects nothing, so the run can only under-target.
  it("selects nothing when the applied severity floor is itself unrankable", () => {
    const threads = [thread("a", { severity: "low" }), thread("b", { severity: "high" })];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, severityAtLeast: "critical" }, [], []);
    expect(targets).toEqual([]);
  });

  it("filters by review pass (the workflow run the finding came from)", () => {
    const threads = [
      thread("a", { workflow_run: "run-42" }),
      thread("b", { workflow_run: "run-7" }),
      thread("c", { workflow_run: null }),
    ];
    const targets = selectBatchTargets(threads, { ...NO_BATCH_FILTER, reviewPass: "run-42" }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["a"]);
  });

  it("combines the three dimensions conjunctively", () => {
    const threads = [
      thread("a", { skill: "style", severity: "high", workflow_run: "run-42" }),
      thread("b", { skill: "style", severity: "low", workflow_run: "run-42" }),
      thread("c", { skill: "style", severity: "high", workflow_run: "run-7" }),
    ];
    const targets = selectBatchTargets(threads, {
      source: "style",
      severityAtLeast: "medium",
      reviewPass: "run-42",
    }, [], []);
    expect(targets.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("filter option discovery", () => {
  it("lists the sources present among open threads with human first when present", () => {
    const threads = [
      thread("a", { skill: "style" }),
      thread("b", { skill: null }),
      thread("c", { skill: "biblical-accuracy" }),
      thread("d", { skill: "style" }),
      thread("e", { skill: "gone", resolved: true }),
    ];
    expect(sourcesIn(threads)).toEqual(["human", "biblical-accuracy", "style"]);
  });

  // Run ids are opaque strings, so the menu order is plain alphabetical (stable), not numeric.
  it("lists the review passes present among open threads deduped and stably ordered", () => {
    const threads = [
      thread("a", { workflow_run: "run-42" }),
      thread("b", { workflow_run: null }),
      thread("c", { workflow_run: "run-7" }),
      thread("d", { workflow_run: "run-42" }),
    ];
    expect(reviewPassesIn(threads)).toEqual(["run-42", "run-7"]);
  });
});

describe("severityRank", () => {
  it("orders low then medium then high case-insensitively across both spellings", () => {
    expect(severityRank("low")).toBeLessThan(severityRank("MEDIUM") as number);
    expect(severityRank("Medium")).toBeLessThan(severityRank("high") as number);
    expect(severityRank("L")).toBe(severityRank("low"));
    expect(severityRank("h")).toBe(severityRank("HIGH"));
  });

  it("is null for an absent or unrecognized severity", () => {
    expect(severityRank(null)).toBeNull();
    expect(severityRank("spicy")).toBeNull();
  });
});
