// ABOUTME: Covers `deriveThreadState`'s derivable subset of ux-design.md §2's seven thread states —
// ABOUTME: P2a-19 closed the FR-CMT-7 gap and UXR-Q10/#1122 split Working out of Addressed — pending,
// ABOUTME: so only Suggestion (D19, P2b-3) is still supplied by a caller.
import { describe, expect, it } from "vitest";
import { commentCounts, deriveLadderRung, deriveThreadState, isHeldByLiveRun, isHeldByRun, isThreadCollapsedByDefault, withoutTerminalPendingRuns, type CommentThread } from "./types";
import { linkedChange, thread as baseThread } from "./threadFixture";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return baseThread("c1", { body: "why here?", ...overrides });
}

describe("comments/types — J10 withdrawn projection", () => {
  it("an overlapping run hold survives an ambiguous scalar and releases only after both terminal observations", () => {
    const overlap = thread({ resolved: true, pending_run: null, pending_runs: [
      { run_id: "run-1", address_event_id: "a1", started: true, guidance: null, corrected: false },
      { run_id: "run-2", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    expect(isHeldByRun(overlap)).toBe(true);
    expect(isHeldByLiveRun(overlap, [], [])).toBe(true);
    expect(isHeldByLiveRun(overlap, [], ["run-1"])).toBe(true);
    expect(isHeldByLiveRun(overlap, [], ["run-1", "run-2"])).toBe(false);
    expect(isThreadCollapsedByDefault(overlap)).toBe(false);
    expect(deriveThreadState(overlap)).toBe("working");
    expect(deriveLadderRung(overlap, ["run-2"])).toBe("working");
  });
  it("projects the surviving guided run after its overlapping peer is terminal", () => {
    const overlap = thread({ pending_run: null, pending_guidance: null, pending_runs: [
      { run_id: "run-guided", address_event_id: "a1", started: true, guidance: "use ESV wording", corrected: false },
      { run_id: "run-queued", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    const visible = withoutTerminalPendingRuns(overlap, ["run-queued"]);
    expect(visible.pending_run).toBe("run-guided");
    expect(visible.pending_guidance).toBe("use ESV wording");
    expect(visible.pending_run_started).toBe(true);
  });
  it("retains a targeting hold after partial delivery and releases only on a positive terminal observation", () => {
    const partial = thread({ pending_run: null, targeting_run_ids: ["run-1"] });
    expect(isHeldByLiveRun(partial, ["run-1"], [])).toBe(true);
    expect(isHeldByLiveRun(partial, [], ["run-1"])).toBe(false);
    const pending = thread({ pending_run: "run-1", targeting_run_ids: ["run-1"] });
    expect(isHeldByLiveRun(pending, [], [])).toBe(true);
    expect(isHeldByLiveRun(pending, [], ["run-1"])).toBe(false);
  });
  it("excludes withdrawn roots from both open and resolved document status counts", () => {
    expect(commentCounts([
      thread(),
      thread({ id: "resolved", resolved: true }),
      thread({ id: "placeholder", withdrawn_at: 10, visible_when_withdrawn: true }),
      thread({ id: "private", withdrawn_at: 11, visible_when_withdrawn: false }),
    ])).toEqual({ open: 1, resolved: 1 });
  });
});

describe("comments/types deriveThreadState", () => {
  it("an unresolved and unorphaned thread is open", () => {
    expect(deriveThreadState(thread())).toBe("open");
  });

  it("a resolved thread is resolved", () => {
    expect(deriveThreadState(thread({ resolved: true }))).toBe("resolved");
  });

  it("an orphaned thread is orphaned regardless of its resolved bit", () => {
    expect(deriveThreadState(thread({ orphaned: true }))).toBe("orphaned");
    expect(deriveThreadState(thread({ orphaned: true, resolved: true }))).toBe("orphaned");
  });

  it("a thread with a pending address run is working, not addressed-pending (#1122)", () => {
    expect(deriveThreadState(thread({ pending_run: "run-1", pending_run_started: true }))).toBe("working");
  });

  it("orphaned still wins over a pending run — ux-design.md §2's precedence order (Orphaned → Working → …)", () => {
    expect(
      deriveThreadState(thread({ orphaned: true, pending_run: "run-1", pending_run_started: true })),
    ).toBe("orphaned");
  });

  it("a pending run outranks reopened, resolved, and undecided linked changes alike", () => {
    expect(
      deriveThreadState(
        thread({
          pending_run: "run-2",
          pending_run_started: true,
          reopened: true,
          resolved: true,
          linked_changes: [linkedChange("chg-1")],
        }),
      ),
    ).toBe("working");
  });

  it("a re-delegated thread still carrying an earlier delivery's undecided linked changes is working while its new run is in flight", () => {
    expect(
      deriveThreadState(
        thread({ pending_run: "run-3", pending_run_started: true, linked_changes: [linkedChange("chg-1")] }),
      ),
    ).toBe("working");
  });

  it("a thread with delivered-but-undecided linked changes is addressed-pending", () => {
    expect(
      deriveThreadState(thread({ linked_changes: [linkedChange("chg-1")] })),
    ).toBe("addressed-pending");
  });

  it("a thread with a rejected linked change is reopened", () => {
    expect(
      deriveThreadState(thread({ reopened: true, linked_changes: [linkedChange("chg-1", { decision: "reject" })] })),
    ).toBe("reopened");
  });

  // Issue #1778, ux-design.md §2 "Batch … Working means started, not targeted" (UXR-Q10/#1122):
  // a batch's own per-thread dispatch sets `pending_run` on every eligible target the moment it
  // fires, but this build has no per-thread signal to say any one of them has actually started —
  // so a merely-targeted thread must not claim Working.
  it("a thread merely targeted by a batch — pending_run set but not started — is not working", () => {
    expect(deriveThreadState(thread({ pending_run: "batch-1", pending_run_started: false }))).toBe("open");
    // The shared fixture defaults to that same shape rather than deriving it from `pending_run`,
    // which would make every future test inherit this card's own defect (`threadFixture.ts`).
    expect(thread({ pending_run: "batch-1" }).pending_run_started).toBe(false);
  });

  it("targeted-but-not-started recomputes to whatever the thread's other facts already say — the acknowledgment ladder mints no new state", () => {
    expect(
      deriveThreadState(
        thread({ pending_run: "batch-1", pending_run_started: false, linked_changes: [linkedChange("chg-1")] }),
      ),
    ).toBe("addressed-pending");
    expect(
      deriveThreadState(
        thread({
          pending_run: "batch-1",
          pending_run_started: false,
          reopened: true,
          linked_changes: [linkedChange("chg-1", { decision: "reject" })],
        }),
      ),
    ).toBe("reopened");
  });

  it("orphaned still wins over a merely-targeted (not-started) run too", () => {
    expect(
      deriveThreadState(thread({ orphaned: true, pending_run: "batch-1", pending_run_started: false })),
    ).toBe("orphaned");
  });

  it("resolved wins over reopened once every linked change is decided with at least one accepted", () => {
    expect(
      deriveThreadState(
        thread({
          resolved: true,
          reopened: false,
          linked_changes: [
            linkedChange("chg-1", { decision: "reject" }),
            linkedChange("chg-2", { decision: "accept" }),
          ],
        }),
      ),
    ).toBe("resolved");
  });
});
