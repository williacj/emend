// ABOUTME: Pins the facet filter/jump-target logic (issue #347, P2b-1a) — kept independent of
// ABOUTME: rendering so selection correctness and jump-target correctness are unit-testable
// ABOUTME: without mounting React, matching virtualization.ts/changeSetReview.ts's precedent.
import { describe, expect, it } from "vitest";
import type { ChangeSetCard, ChatMessageCard, CommentCard, TimelineCard } from "./types";
import { thread } from "../comments/threadFixture";
import { ALL_FACET_ID, FACETS, facetForCard, facetJumpIndex, filterCardsByFacet } from "./facets";

const TS = "2026-07-01T00:00:00.000Z";

function chat(id: string, timestamp: string): ChatMessageCard {
  return { id, kind: "chat-message", author: "user", body: `body-${id}`, timestamp };
}

function comment(id: string, timestamp: string): CommentCard {
  return {
    id,
    kind: "comment",
    root: "/project",
    path: "doc.md",
    timestamp,
    thread: thread(id, { body: `thread-${id}` }),
  };
}

function changeSet(id: string, timestamp: string): ChangeSetCard {
  return { id, kind: "change-set", doc: `${id}.md`, generation: null, changeSetId: id, summary: `summary-${id}`, changes: [], timestamp };
}

describe("timeline/facets FACETS", () => {
  it("declares exactly the five ratified facets in filter-bar order (ux-design §4)", () => {
    expect(FACETS.map((f) => f.label)).toEqual(["All", "Chat", "Comments", "Changes", "Findings"]);
  });

  it("the All facet has no id collision with any kind-scoped facet", () => {
    expect(ALL_FACET_ID).toBe("all");
    expect(FACETS.find((f) => f.id === ALL_FACET_ID)?.kinds).toBeNull();
  });
});

describe("timeline/facets filterCardsByFacet", () => {
  it("hides private withdrawn roots from every facet while retaining published placeholders", () => {
    const privateRoot = { ...comment("private", TS), thread: thread("private", { withdrawn_at: 10, visible_when_withdrawn: false }) };
    const placeholder = { ...comment("seen", TS), thread: thread("seen", { withdrawn_at: 10, visible_when_withdrawn: true, published: true }) };
    expect(filterCardsByFacet([privateRoot, placeholder], "all").map((card) => card.id)).toEqual(["seen"]);
    expect(filterCardsByFacet([privateRoot, placeholder], "comments").map((card) => card.id)).toEqual(["seen"]);
    expect(facetForCard(privateRoot)).toBeUndefined();
    expect(facetForCard(placeholder)?.id).toBe("comments");
  });

  const cards: TimelineCard[] = [
    chat("c1", "2026-07-01T00:00:00.000Z"),
    comment("m1", "2026-07-01T00:01:00.000Z"),
    changeSet("s1", "2026-07-01T00:02:00.000Z"),
    chat("c2", "2026-07-01T00:03:00.000Z"),
  ];

  it("All restores the full unfiltered stream in its original order", () => {
    expect(filterCardsByFacet(cards, "all")).toEqual(cards);
  });

  it("Chat filters to only chat-message cards", () => {
    expect(filterCardsByFacet(cards, "chat").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("Comments filters to only comment cards", () => {
    expect(filterCardsByFacet(cards, "comments").map((c) => c.id)).toEqual(["m1"]);
  });

  it("Changes filters to only change-set cards", () => {
    expect(filterCardsByFacet(cards, "changes").map((c) => c.id)).toEqual(["s1"]);
  });

  it("Findings excludes an ordinary comment card carrying no finding provenance", () => {
    // `comment("m1", …)` (the fixture above) uses `threadFixture.ts`'s defaults — severity/skill
    // both null, D6's "ordinary human comment" — so no card in `cards` should ever match Findings.
    expect(filterCardsByFacet(cards, "findings")).toEqual([]);
  });

  it("Findings selects a comment card whose thread carries review provenance (severity and/or skill) — issue #355", () => {
    // A finding is never a separate card `kind` (D6: the same CommentThreadCard renders every
    // comment provenance) — Findings selects on the thread's own severity/skill fields instead.
    const finding: TimelineCard = {
      id: "f1",
      kind: "comment",
      root: "/project",
      path: "doc.md",
      timestamp: "2026-07-01T00:04:00.000Z",
      thread: thread("f1", { severity: "high", skill: "biblical-accuracy" }),
    };
    expect(filterCardsByFacet([...cards, finding], "findings").map((c) => c.id)).toEqual(["f1"]);
  });

  it("Findings selects a thread with only skill set (no severity) — either provenance field qualifies", () => {
    const finding: TimelineCard = {
      id: "f2",
      kind: "comment",
      root: "/project",
      path: "doc.md",
      timestamp: "2026-07-01T00:05:00.000Z",
      thread: thread("f2", { skill: "style" }),
    };
    expect(filterCardsByFacet([...cards, finding], "findings").map((c) => c.id)).toEqual(["f2"]);
  });

  it("throws on an unknown facet id rather than silently returning nothing", () => {
    expect(() => filterCardsByFacet(cards, "bogus")).toThrow();
  });
});

describe("timeline/facets facetForCard (P2b-1c, UXR-Q2 affordance facet lookup)", () => {
  it("resolves a chat-message card to the Chat facet", () => {
    expect(facetForCard(chat("c1", "2026-07-01T00:00:00.000Z"))?.id).toBe("chat");
  });

  it("keeps queued agent acknowledgements visible in the Chat facet", () => {
    const activity: TimelineCard = {
      id: "run-1",
      kind: "agent-working",
      runId: "run-1",
      phase: { phase: "queued", position: 1 },
      activity: [],
      elapsedSecs: 0,
      timestamp: "2026-07-01T00:00:00.000Z",
    };

    expect(filterCardsByFacet([activity], "chat")).toEqual([activity]);
    expect(facetForCard(activity)?.id).toBe("chat");
  });

  it("resolves a change-set card to the Changes facet", () => {
    expect(facetForCard(changeSet("s1", "2026-07-01T00:00:00.000Z"))?.id).toBe("changes");
  });

  it("resolves an ordinary comment card (no finding provenance) to Comments — not Findings", () => {
    expect(facetForCard(comment("m1", "2026-07-01T00:00:00.000Z"))?.id).toBe("comments");
  });

  it("resolves a comment card carrying finding provenance to Comments — declared before Findings in filter-bar order", () => {
    // Both facets' `kinds` include "comment" and `filterCardsByFacet` would put this card in either
    // one; `facetForCard` picks the first FACETS entry that claims it, which is the broader
    // "Comments" facet. Not a load-bearing choice today (no submittable card carries finding
    // provenance yet), just the honest behavior of "first declared facet wins".
    const finding: TimelineCard = {
      id: "f1",
      kind: "comment",
      root: "/project",
      path: "doc.md",
      timestamp: "2026-07-01T00:00:00.000Z",
      thread: thread("f1", { severity: "high" }),
    };
    expect(facetForCard(finding)?.id).toBe("comments");
  });
});

describe("timeline/facets facetJumpIndex", () => {
  const cards: TimelineCard[] = [
    chat("c1", "2026-07-01T00:00:00.000Z"),
    chat("c2", "2026-07-01T00:01:00.000Z"),
    chat("c3", "2026-07-01T00:02:00.000Z"),
  ];

  it("points at the last — most recent given the stream's chronological order — matching card", () => {
    const filtered = filterCardsByFacet(cards, "chat");
    expect(facetJumpIndex("chat", filtered)).toBe(2);
    expect(filtered[facetJumpIndex("chat", filtered)!].id).toBe("c3");
  });

  it("is undefined — a no-op jump never a throw — when the filtered stream is empty", () => {
    expect(facetJumpIndex("findings", filterCardsByFacet(cards, "findings"))).toBeUndefined();
  });

  it("is undefined for All — restoring the full stream has no single 'most recent kind' target", () => {
    expect(facetJumpIndex("all", filterCardsByFacet(cards, "all"))).toBeUndefined();
  });
});

describe("timeline/facets — every card kind exercised, not just the three that map cleanly (issue #1727)", () => {
  // One fixture per `TimelineCard["kind"]`. Typed as `Record<TimelineCard["kind"], TimelineCard>`
  // so a kind added to the union without a fixture here is a compile error, not a silently passing
  // test — `mixedFacetCards` (the component-level fixture) cycled only three of six kinds and never
  // caught #1727's orphan facets; this table is exhaustive by construction instead.
  const CARD_FOR_KIND: Record<TimelineCard["kind"], TimelineCard> = {
    "chat-message": chat("k-chat", TS),
    comment: comment("k-comment", TS),
    "change-set": changeSet("k-change", TS),
    "agent-working": {
      id: "k-agent",
      kind: "agent-working",
      runId: "k-agent",
      phase: { phase: "queued", position: 1 },
      activity: [],
      elapsedSecs: 0,
      timestamp: TS,
    },
    "document-birth": { id: "k-doc-birth", kind: "document-birth", path: "notes/new.md", size: 42, timestamp: TS },
    "untitled-adoption": {
      id: "k-adoption",
      kind: "untitled-adoption",
      adoptionId: "a1",
      displacedPath: "old.md",
      destination: "new.md",
      timestamp: TS,
    },
    "project-grounding": {
      id: "k-grounding",
      kind: "project-grounding",
      skills: [],
      workflows: [],
      timestamp: TS,
    },
  };

  /**
   * The facet each kind resolves to today — `undefined` for a kind no ratified facet claims.
   * `document-birth` and `project-grounding` are deliberately `undefined`: which facet (if any)
   * should claim them is a J#/Designer call the issue raises, not an Engineer's guess to bake in
   * here (issue #1727 left it to CJ and the Designer). This table pins the current,
   * honest state — two orphans — so a future facet assignment is a deliberate edit to this table,
   * not a silent behavior change nobody noticed.
   */
  const EXPECTED_FACET_ID: Record<TimelineCard["kind"], string | undefined> = {
    "chat-message": "chat",
    "agent-working": "chat",
    comment: "comments",
    "change-set": "changes",
    "document-birth": undefined,
    "untitled-adoption": undefined,
    "project-grounding": undefined,
  };

  // A loop over `EXPECTED_FACET_ID` would give every case's `it()` an interpolated (non-literal)
  // title, which `scripts/check-test-matrix.mjs` cannot resolve statically (it matches quoted
  // source text, not a runtime string) — so each kind gets its own literal-titled case below,
  // sharing this one assertion so the exhaustiveness guarantee still lives in `EXPECTED_FACET_ID`
  // itself, not in six independently-typed copies of it.
  function expectFacetResolution(kind: TimelineCard["kind"]) {
    const card = CARD_FOR_KIND[kind];
    const expectedFacetId = EXPECTED_FACET_ID[kind];
    expect(facetForCard(card)?.id).toBe(expectedFacetId);

    if (expectedFacetId) {
      expect(filterCardsByFacet([card], expectedFacetId)).toEqual([card]);
    } else {
      // No ratified facet claims it: every non-All facet excludes it (the affordance/filter
      // consequence #1727 measured), and only "All" still shows it.
      for (const facet of FACETS) {
        if (facet.id === ALL_FACET_ID) continue;
        expect(filterCardsByFacet([card], facet.id)).toEqual([]);
      }
    }
    expect(filterCardsByFacet([card], ALL_FACET_ID)).toEqual([card]);
  }

  it("chat-message resolves to chat", () => expectFacetResolution("chat-message"));
  it("agent-working resolves to chat", () => expectFacetResolution("agent-working"));
  it("comment resolves to comments", () => expectFacetResolution("comment"));
  it("change-set resolves to changes", () => expectFacetResolution("change-set"));
  it("document-birth resolves to no facet — reachable only under All", () => expectFacetResolution("document-birth"));
  it("untitled-adoption resolves to no facet — reachable only under All", () =>
    expectFacetResolution("untitled-adoption"));
  it("project-grounding resolves to no facet — reachable only under All", () =>
    expectFacetResolution("project-grounding"));

  it("covers every declared TimelineCard kind — no fixture silently left out of the sweep above", () => {
    // Guards the guard: if a kind were added to `CARD_FOR_KIND`/`EXPECTED_FACET_ID` (required by
    // their own `Record<TimelineCard["kind"], …>` typing) but its `it()` above were forgotten, the
    // six hard-coded cases would quietly stop being exhaustive. This closes that gap by walking the
    // same tables the `it()`s above hard-code against.
    for (const kind of Object.keys(EXPECTED_FACET_ID) as TimelineCard["kind"][]) {
      expectFacetResolution(kind);
    }
  });
});
