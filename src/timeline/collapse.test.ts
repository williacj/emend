// ABOUTME: Pins the P2b-1b collapse-boundary predicates directly — in particular the "fully
// ABOUTME: decided, not any decision" change-set boundary the issue calls out (NI-timeline-correctness).
import { describe, expect, it } from "vitest";
// The thread boundary is a comment-domain rule and lives beside the other §2 derivations, but it
// is exercised here beside `isCardCollapsedByDefault`/`itemHeightFor`, the timeline consumers whose
// row-height seed it feeds.
import { isThreadCollapsedByDefault, type CommentThread } from "../comments/types";
import { linkedChange } from "../comments/threadFixture";
import {
  COLLAPSED_ITEM_HEIGHT,
  isAgentWorkingCollapsedByDefault,
  isCardCollapsedByDefault,
  isChangeSetCollapsedByDefault,
  itemHeightFor,
} from "./collapse";
import {
  createAgentWorkingCard,
  createChangeSetCard,
  createChatMessageCard,
  createCommentCard,
  type ChangeSetChange,
} from "./types";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "c1",
    author: "alice",
    last_activity_at: 0,
    anchor: null,
    body: "please clarify",
    edited_at: null,
    withdrawn_at: null,
    published: false,
    visible_when_withdrawn: false,
    targeting_run_ids: [],
    resolved: false,
    orphaned: false,
    reopened: false,
    replies: [],
    severity: null,
    skill: null,
    workflow_run: null,
    pending_run: null,
    pending_runs: [],
    pending_run_started: false,
    pending_guidance: null,
    concluded_run: null,
    linked_changes: [],
    ...overrides,
  };
}

const CHANGES: ChangeSetChange[] = [
  { id: "1", kind: "insertion", section: "§1", newText: "We" },
  { id: "2", kind: "deletion", section: "§1", oldText: "For most of us," },
  { id: "3", kind: "substitution", section: "§2", oldText: "utilize", newText: "use" },
];

describe("timeline/collapse — isThreadCollapsedByDefault", () => {
  it("collapses a resolved thread", () => {
    expect(isThreadCollapsedByDefault(thread({ resolved: true }))).toBe(true);
  });

  it("sizes a retained withdrawn placeholder for its visible replies even if it was resolved", () => {
    const card = createCommentCard("/project", "doc.md", thread({
      resolved: true,
      withdrawn_at: 10,
      visible_when_withdrawn: true,
      replies: [{ id: "reply", parent_id: "c1", author: "bob", body: "late", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    }));
    expect(isCardCollapsedByDefault(card)).toBe(false);
    expect(itemHeightFor(card, {}, 180)).toBe(180);
    expect(itemHeightFor(card, { [card.id]: true }, 180)).toBe(180);
  });

  it("keeps an offscreen resolved comment expanded while its targeting run remains live after delivery", () => {
    const card = createCommentCard("/project", "doc.md", thread({ resolved: true, pending_run: null, targeting_run_ids: ["run-1"] }));
    expect(itemHeightFor(card, { [card.id]: true }, 180, ["run-1"], [])).toBe(180);
    expect(itemHeightFor(card, {}, 180, [], ["run-1"])).toBe(COLLAPSED_ITEM_HEIGHT);
  });

  it("sizes an overlapping target as expanded until both pending runs are terminal", () => {
    const card = createCommentCard("/project", "doc.md", thread({ resolved: true, pending_runs: [
      { run_id: "run-1", address_event_id: "a1", started: true, guidance: null, corrected: false },
      { run_id: "run-2", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] }));
    expect(itemHeightFor(card, {}, 180, [], ["run-1"])).toBe(180);
    expect(itemHeightFor(card, {}, 180, [], ["run-1", "run-2"])).toBe(COLLAPSED_ITEM_HEIGHT);
  });

  it.each<[string, Partial<CommentThread>]>([
    ["open", {}],
    ["orphaned", { orphaned: true }],
    ["reopened", { resolved: false, reopened: true }],
    ["addressed-pending (pending_run)", { pending_run: "run-1" }],
    ["addressed-pending (undecided linked change)", { linked_changes: [linkedChange("chg-1")] }],
  ])("does not collapse %s", (_label, overrides) => {
    expect(isThreadCollapsedByDefault(thread(overrides))).toBe(false);
  });

  // ux-design §2's collapse rule, verbatim: "A thread with a live run is in none of those sets."
  // The axis is which kind of run holds the thread — queued, targeted-but-unstarted, or started —
  // because §2's guarantee ("the ladder never withdraws a live acknowledgment") does not
  // distinguish them, and collapsing the card would hide the rung line under it (issue #2228).
  // `pending_run_started: true` reads as *Working* and was never in the collapse set; the other
  // two recompute to *resolved* and are the cases this clause exists for.
  it("does not collapse a resolved thread held by a run that has started work on it", () => {
    expect(
      isThreadCollapsedByDefault(thread({ resolved: true, pending_run: "run-1", pending_run_started: true })),
    ).toBe(false);
  });

  it("does not collapse a resolved thread held by a run that merely targets it", () => {
    expect(
      isThreadCollapsedByDefault(thread({ resolved: true, pending_run: "batch-1", pending_run_started: false })),
    ).toBe(false);
  });

  it("still collapses a resolved thread once the run that held it has gone", () => {
    expect(isThreadCollapsedByDefault(thread({ resolved: true, pending_run: null }))).toBe(true);
  });
});

describe("timeline/collapse — isChangeSetCollapsedByDefault (the fully-decided boundary)", () => {
  it("does not collapse when nothing is decided", () => {
    expect(isChangeSetCollapsedByDefault(CHANGES, new Set())).toBe(false);
  });

  it("does not collapse when only some changes are decided — the boundary is 'fully', not 'any'", () => {
    expect(isChangeSetCollapsedByDefault(CHANGES, new Set(["1", "2"]))).toBe(false);
  });

  it("collapses once every change is decided", () => {
    expect(isChangeSetCollapsedByDefault(CHANGES, new Set(["1", "2", "3"]))).toBe(true);
  });

  it("a change-set with no changes at all never collapses by this rule — there is no 'every change decided' to have reached", () => {
    expect(isChangeSetCollapsedByDefault([], new Set())).toBe(false);
  });
});

describe("timeline/collapse — isCardCollapsedByDefault (per-kind dispatch)", () => {
  it("a chat-message card never collapses — it carries no collapse rule", () => {
    expect(isCardCollapsedByDefault(createChatMessageCard("user", "hi"))).toBe(false);
  });

  it("a comment card collapses exactly when its thread is resolved", () => {
    expect(isCardCollapsedByDefault(createCommentCard("/p", "d.md", thread({ resolved: true })))).toBe(true);
    expect(isCardCollapsedByDefault(createCommentCard("/p", "d.md", thread()))).toBe(false);
  });

  it("a freshly delivered change-set card (nothing decided yet) does not collapse", () => {
    expect(isCardCollapsedByDefault(createChangeSetCard("cs1", "summary", CHANGES))).toBe(false);
  });

  it("a successfully completed run collapses by default", () => {
    const card = createAgentWorkingCard({
      id: "run-1",
      phase: { phase: "completed", reply: null },
      activity: [],
      elapsedSecs: 3,
    });
    expect(isAgentWorkingCollapsedByDefault(card)).toBe(true);
    expect(isCardCollapsedByDefault(card)).toBe(true);
    expect(itemHeightFor(card, {}, 96)).toBe(COLLAPSED_ITEM_HEIGHT);
  });

  it.each([
    ["queued", { phase: "queued", position: 1 } as const],
    ["running", { phase: "running" } as const],
    ["cancelled", { phase: "cancelled" } as const],
    ["stopped", { phase: "stopped", delivered: false } as const],
    ["failed", { phase: "failed", message: "provider exited" } as const],
  ])("keeps a %s run expanded", (_label, phase) => {
    const card = createAgentWorkingCard({
      id: "run-1",
      phase,
      activity: [],
      elapsedSecs: 3,
    });
    expect(isAgentWorkingCollapsedByDefault(card)).toBe(false);
    expect(isCardCollapsedByDefault(card)).toBe(false);
    expect(itemHeightFor(card, {}, 96)).toBe(96);
  });

  it("an agent-working card never collapses — a live run carries no collapse rule", () => {
    const card = createAgentWorkingCard({
      id: "run-live",
      phase: { phase: "running" },
      activity: [],
      elapsedSecs: 3,
    });
    expect(isCardCollapsedByDefault(card)).toBe(false);
  });
});

describe("timeline/collapse — itemHeightFor (virtualization composition)", () => {
  const EXPANDED_HEIGHT = 96;

  it("uses the expanded height for a card with no override and no default collapse rule", () => {
    const card = createChatMessageCard("user", "hi", { id: "m1" });
    expect(itemHeightFor(card, {}, EXPANDED_HEIGHT)).toBe(EXPANDED_HEIGHT);
  });

  it("uses the collapsed height for a card whose default rule says collapsed, with no override recorded yet", () => {
    const card = createCommentCard("/p", "d.md", thread({ resolved: true }), { id: "cm1" });
    expect(itemHeightFor(card, {}, EXPANDED_HEIGHT)).toBe(COLLAPSED_ITEM_HEIGHT);
  });

  it("an explicit override takes precedence over the data-driven default in either direction", () => {
    const resolvedCard = createCommentCard("/p", "d.md", thread({ resolved: true }), { id: "cm1" });
    expect(itemHeightFor(resolvedCard, { cm1: false }, EXPANDED_HEIGHT)).toBe(EXPANDED_HEIGHT);

    const openCard = createCommentCard("/p", "d.md", thread(), { id: "cm2" });
    expect(itemHeightFor(openCard, { cm2: true }, EXPANDED_HEIGHT)).toBe(COLLAPSED_ITEM_HEIGHT);
  });

  it("the collapsed height is always shorter than the expanded height", () => {
    expect(COLLAPSED_ITEM_HEIGHT).toBeLessThan(EXPANDED_HEIGHT);
  });
});
