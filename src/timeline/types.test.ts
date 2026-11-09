// ABOUTME: Pins the chat-message and comment card factories' shapes — the one construction path
// ABOUTME: each card's own trigger (message input, comment surface) uses, so every card in the
// ABOUTME: stream is uniform.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunStatus } from "./agentActivity";
import type { CommentThread } from "../comments/types";
import { thread } from "../comments/threadFixture";
import {
  createAgentWorkingCard,
  createChangeSetCard,
  createChatMessageCard,
  createCommentCard,
  createDocumentBirthCard,
  createProjectGroundingCard,
  type ChangeSetChange,
} from "./types";

describe("timeline/types createChatMessageCard", () => {
  it("builds a chat-message card carrying the given author and body", () => {
    const card = createChatMessageCard("user", "hello there");

    expect(card.kind).toBe("chat-message");
    expect(card.author).toBe("user");
    expect(card.body).toBe("hello there");
  });

  it("generates a distinct id per call when none is given", () => {
    const first = createChatMessageCard("user", "one");
    const second = createChatMessageCard("user", "two");

    expect(first.id).not.toBe(second.id);
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createChatMessageCard("agent", "reply", {
      id: "fixed-id",
      timestamp: "2026-07-15T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-15T00:00:00.000Z");
  });

  it("omits quote for an ordinary message (P2b-7)", () => {
    const card = createChatMessageCard("user", "no quote here");

    expect(card.quote).toBeUndefined();
  });

  it("carries a quoted editor excerpt through when given (P2b-7)", () => {
    const quote = {
      documentPath: "notes/outline.md",
      text: "the quoted sentence",
      anchor: {
        offset: 10,
        length: 20,
        text_snapshot: "the quoted sentence",
        context_before: "",
        context_after: "",
        base_revision: "blake3:abc",
      },
    };

    const card = createChatMessageCard("user", "see this:", { quote });

    expect(card.quote).toBe(quote);
  });

  it("omits filesRead for an ordinary message (#1391)", () => {
    const card = createChatMessageCard("user", "no grounding here");

    expect(card.filesRead).toBeUndefined();
  });

  it("carries filesRead through when given — J2's [refs: N files read] chip (#1391)", () => {
    const card = createChatMessageCard("agent", "reply", { filesRead: 2 });

    expect(card.filesRead).toBe(2);
  });
});

const THREAD: CommentThread = thread("c1", { body: "please clarify" });

describe("timeline/types createCommentCard", () => {
  it("builds a comment card carrying its document root/path and thread", () => {
    const card = createCommentCard("/project", "doc.md", THREAD);

    expect(card.kind).toBe("comment");
    expect(card.root).toBe("/project");
    expect(card.path).toBe("doc.md");
    expect(card.thread).toBe(THREAD);
  });

  it("generates a distinct id per call when none is given", () => {
    const first = createCommentCard("/project", "doc.md", THREAD);
    const second = createCommentCard("/project", "doc.md", THREAD);

    expect(first.id).not.toBe(second.id);
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createCommentCard("/project", "doc.md", THREAD, {
      id: "fixed-id",
      timestamp: "2026-07-16T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-16T00:00:00.000Z");
  });
});

const CHANGES: ChangeSetChange[] = [
  { id: "1", kind: "insertion", section: "§1 Opening", newText: "We" },
  { id: "2", kind: "deletion", section: "§1 Opening", oldText: "For most of us," },
];

describe("timeline/types createChangeSetCard", () => {
  it("builds a change-set card carrying its change-set id and summary and changes", () => {
    const card = createChangeSetCard("cs1", "Tightened hook", CHANGES);

    expect(card.kind).toBe("change-set");
    expect(card.changeSetId).toBe("cs1");
    expect(card.summary).toBe("Tightened hook");
    expect(card.changes).toBe(CHANGES);
  });

  it("generates a distinct id per call when none is given", () => {
    const first = createChangeSetCard("cs1", "s", CHANGES);
    const second = createChangeSetCard("cs2", "s", CHANGES);

    expect(first.id).not.toBe(second.id);
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createChangeSetCard("cs1", "s", CHANGES, {
      id: "fixed-id",
      timestamp: "2026-07-18T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-18T00:00:00.000Z");
  });

  it("omitting commentGroups builds a section-grouped card with no comment-batch metadata (P2a-14's original shape)", () => {
    const card = createChangeSetCard("cs1", "s", CHANGES);

    expect(card.commentGroups).toBeUndefined();
    expect(card.defenses).toBeUndefined();
    expect(card.replyCount).toBeUndefined();
  });

  it("threads commentGroups/defenses/replyCount through for a grouped-by-comment (J4 batch) card", () => {
    const commentGroups = [{ commentId: "t1", label: "Eph 4:22 quote", severity: "H" as const }];
    const defenses = [{ commentId: "t3", label: '"daily" wording' }];

    const card = createChangeSetCard("cs1", "s", CHANGES, { commentGroups, defenses, replyCount: 5 });

    expect(card.commentGroups).toBe(commentGroups);
    expect(card.defenses).toBe(defenses);
    expect(card.replyCount).toBe(5);
  });
});

const RUNNING_STATUS: RunStatus = {
  id: "run-1",
  phase: { phase: "running" },
  activity: [{ verb: "Reading", detail: "claude.md" }],
  elapsedSecs: 42,
};

describe("timeline/types createAgentWorkingCard", () => {
  it("builds an agent-working card carrying the run status's phase — activity and elapsed time", () => {
    const card = createAgentWorkingCard(RUNNING_STATUS);

    expect(card.kind).toBe("agent-working");
    expect(card.runId).toBe("run-1");
    expect(card.phase).toEqual({ phase: "running" });
    expect(card.activity).toEqual([{ verb: "Reading", detail: "claude.md" }]);
    expect(card.elapsedSecs).toBe(42);
  });

  it("defaults the card id to the run id — so a second push for the same run never mints a second card", () => {
    const card = createAgentWorkingCard(RUNNING_STATUS);
    expect(card.id).toBe("run-1");
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createAgentWorkingCard(RUNNING_STATUS, {
      id: "fixed-id",
      timestamp: "2026-07-20T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-20T00:00:00.000Z");
  });
});

describe("timeline/types createDocumentBirthCard", () => {
  it("builds a document-birth card carrying the created path and its size (#420 J2 Phase B)", () => {
    const card = createDocumentBirthCard("drafts/outline.md", 128);

    expect(card.kind).toBe("document-birth");
    expect(card.path).toBe("drafts/outline.md");
    expect(card.size).toBe(128);
  });

  it("generates a distinct id per call when none is given", () => {
    const first = createDocumentBirthCard("drafts/a.md", 10);
    const second = createDocumentBirthCard("drafts/b.md", 20);

    expect(first.id).not.toBe(second.id);
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createDocumentBirthCard("drafts/outline.md", 128, {
      id: "fixed-id",
      timestamp: "2026-07-21T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-21T00:00:00.000Z");
  });
});

describe("timeline/types createProjectGroundingCard", () => {
  it("builds a project-grounding card carrying the discovered skills, workflows, and instruction file (P2b-8b, J8 Screen 2)", () => {
    const card = createProjectGroundingCard(
      [{ name: "grammar", description: "Fixes grammar." }],
      [{ name: "sermon-review" }],
      "CLAUDE.md",
    );

    expect(card.kind).toBe("project-grounding");
    expect(card.skills).toEqual([{ name: "grammar", description: "Fixes grammar." }]);
    expect(card.workflows).toEqual([{ name: "sermon-review" }]);
    expect(card.instructionFile).toBe("CLAUDE.md");
  });

  it("omits instructionFile (never a placeholder) when the project has none", () => {
    const card = createProjectGroundingCard([], [], undefined);

    expect(card.instructionFile).toBeUndefined();
  });

  it("generates a distinct id per call when none is given", () => {
    const first = createProjectGroundingCard([], [], undefined);
    const second = createProjectGroundingCard([], [], undefined);

    expect(first.id).not.toBe(second.id);
  });

  it("honors an explicit id and timestamp for deterministic tests/replay", () => {
    const card = createProjectGroundingCard([], [], undefined, {
      id: "fixed-id",
      timestamp: "2026-07-24T00:00:00.000Z",
    });

    expect(card.id).toBe("fixed-id");
    expect(card.timestamp).toBe("2026-07-24T00:00:00.000Z");
  });
});

/**
 * The id generator itself (#1728). Every assertion here crosses a **module-registry boundary** —
 * `vi.resetModules()` hands back a factory module whose module-scoped state has been zeroed, which
 * is exactly what a relaunched app hands the next session. That boundary is the whole test: ids
 * are persisted to the local transcript (D15) and rehydrated on the next launch, so a generator
 * that is unique only *within* one process writes the same identity onto different cards forever
 * (duplicate `VirtualList` React keys, #1727; the mis-read rehydrate accumulation, #1718). Minting
 * two ids inside one process and asserting they differ — which the per-factory tests above do —
 * passes with the colliding counter too, so it cannot represent this bug.
 */
describe("timeline/types card ids across an app restart (#1728)", () => {
  type TypesModule = typeof import("./types");

  /** One id from every factory that *generates* one — i.e. every card kind that can reach the
   * transcript carrying a minted id. (`createAgentWorkingCard` is excluded deliberately: its id is
   * the backend's `run-<uuid>`, already restart-unique, `agent/run_queue.rs`.) */
  function mintedIds(module: TypesModule): string[] {
    return [
      module.createChatMessageCard("user", "hello").id,
      module.createCommentCard("/project", "doc.md", thread("c1")).id,
      module.createChangeSetCard("cs-1", "Tightened the hook.", CHANGES).id,
      module.createDocumentBirthCard("drafts/outline.md", 128).id,
      module.createProjectGroundingCard([], [], undefined).id,
    ];
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("never repeats an id a previous session already persisted", async () => {
    // Both sessions start from a *pristine* registry: comparing a fresh launch against this test
    // file's already-advanced module instance would pass with the colliding counter too, purely
    // because the earlier tests here had advanced it.
    vi.resetModules();
    const firstSession = mintedIds(await import("./types"));
    vi.resetModules();
    const secondSession = mintedIds(await import("./types"));

    expect(secondSession.filter((id) => firstSession.includes(id))).toEqual([]);
  });

  it("keeps that guarantee where the webview exposes no crypto.randomUUID", async () => {
    // A webview served from a non-secure context exposes no `randomUUID` (platform-variants: the
    // frontend cannot assume one webview's capabilities on the other OS). The fallback still has
    // to separate sessions — being reachable in production is precisely what makes a *counter*
    // fallback the bug rather than a test convenience.
    vi.stubGlobal("crypto", {});
    vi.resetModules();
    const firstSession = mintedIds(await import("./types"));
    vi.resetModules();
    const secondSession = mintedIds(await import("./types"));

    expect(secondSession.filter((id) => firstSession.includes(id))).toEqual([]);
  });

  it("mints uuid-shaped ids on the production path, not the sequential counter", () => {
    // jsdom exposes `crypto.randomUUID` exactly as the Tauri webview does, so this is the branch
    // production takes — pinned by shape because a session-scoped `<prefix>-<n>` id is the defect.
    const card = createChatMessageCard("user", "hello");

    expect(card.id).toMatch(
      /^chat-message-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(card.id).not.toMatch(/^chat-message-\d+$/);
  });
});
