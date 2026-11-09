// ABOUTME: Confirms the transcript IPC bridge stays thin (§3.1) — it shapes exactly the
// ABOUTME: `callBackend` calls `commands::transcript` expects, nothing else (transport routing
// ABOUTME: itself, incl. the D23 headless test driver fallback, is `backend.test.ts`'s own coverage).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineCard } from "./types";
import { thread } from "../comments/threadFixture";
import { createCommentCard } from "./types";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({ callBackend: (...args: unknown[]) => callBackendMock(...args) }));

const { appendTranscriptEvent, loadTranscript } = await import("./ipc");

const CARD: TimelineCard = {
  id: "card-1",
  kind: "chat-message",
  author: "user",
  body: "hello",
  timestamp: "2026-07-16T00:00:00.000Z",
};

describe("timeline/ipc", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  it("appendTranscriptEvent invokes append_transcript_event with the card wrapped in schema_version", async () => {
    callBackendMock.mockResolvedValueOnce(undefined);

    await appendTranscriptEvent("/project", CARD);

    expect(callBackendMock).toHaveBeenCalledWith("append_transcript_event", {
      root: "/project",
      event: { schema_version: 1, ...CARD },
    });
  });

  it("loadTranscript invokes load_transcript and strips schema_version off each event", async () => {
    callBackendMock.mockResolvedValueOnce([{ schema_version: 1, ...CARD }]);

    const cards = await loadTranscript("/project");

    expect(callBackendMock).toHaveBeenCalledWith("load_transcript", { root: "/project" });
    expect(cards).toEqual([CARD]);
  });

  it("loadTranscript returns events in the order the backend returned them (append order)", async () => {
    const second: TimelineCard = { ...CARD, id: "card-2", body: "second" };
    callBackendMock.mockResolvedValueOnce([
      { schema_version: 1, ...CARD },
      { schema_version: 1, ...second },
    ]);

    const cards = await loadTranscript("/project");

    expect(cards).toEqual([CARD, second]);
  });

  it("rehydrates a pre-J10 comment card with live correction defaults", async () => {
    const card = createCommentCard("/project", "draft.md", thread("c1", {
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "reply", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    }));
    const legacyThread = { ...card.thread } as Record<string, unknown>;
    for (const key of ["edited_at", "withdrawn_at", "published", "visible_when_withdrawn", "targeting_run_ids"]) delete legacyThread[key];
    legacyThread.replies = [{ id: "r1", author: "bob", body: "reply", defense: false }];
    callBackendMock.mockResolvedValueOnce([{ ...card, schema_version: 1, thread: legacyThread }]);

    const [loaded] = await loadTranscript("/project");
    expect(loaded).toMatchObject({
      kind: "comment",
      thread: {
        withdrawn_at: null,
        edited_at: null,
        published: false,
        visible_when_withdrawn: false,
        targeting_run_ids: [],
        replies: [{ parent_id: "c1", edited_at: null, withdrawn_at: null, published: false }],
      },
    });
  });
});

describe("timeline/ipc — pre-TD-16 transcript cards (ruling 5)", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  /** A change-set card as the D15 transcript persisted it before TD-16: numeric change ids, the
   * parse ordinals of their day. The store is append-only, so these are on disk forever. */
  const legacyCard = {
    schema_version: 1,
    id: "card-legacy",
    kind: "change-set",
    doc: "draft.md",
    generation: "blake3:abc",
    changeSetId: "cs-1",
    summary: "Tightened the hook.",
    changes: [
      { id: 7, kind: "insertion", section: "draft.md", newText: "there" },
      { id: 8, kind: "deletion", section: "draft.md", oldText: "gone" },
    ],
    timestamp: "2026-07-16T00:00:00.000Z",
  };

  it("coerces a legacy numeric change id to a non-colliding legacy: string", async () => {
    callBackendMock.mockResolvedValueOnce([legacyCard]);

    const [card] = await loadTranscript("/project");

    expect(card).toMatchObject({ kind: "change-set", id: "card-legacy" });
    const changes = (card as { changes: { id: string }[] }).changes;
    expect(changes.map((c) => c.id)).toEqual(["legacy:7", "legacy:8"]);
    // Every other field of the card survives intact — the card still renders.
    expect(changes[0]).toMatchObject({ kind: "insertion", newText: "there" });
  });

  it("gives a legacy card an id that can never collide with a live one so its triage fails closed", async () => {
    callBackendMock.mockResolvedValueOnce([legacyCard]);

    const [card] = await loadTranscript("/project");

    // A live id is `chg-<uuid>` or `snap:<doc>:<generation>:<ordinal>` (TD-16 rulings 2–3); neither
    // can ever spell `legacy:…`, so `decisionGroupClosure` finds no match and the card reads as an
    // honest UXR-Q4 mismatch rather than reporting a decide the editor never made.
    for (const change of (card as { changes: { id: string }[] }).changes) {
      expect(change.id.startsWith("legacy:")).toBe(true);
      expect(change.id.startsWith("chg-")).toBe(false);
      expect(change.id.startsWith("snap:")).toBe(false);
    }
  });

  it("leaves an already-string change id untouched", async () => {
    callBackendMock.mockResolvedValueOnce([
      { ...legacyCard, changes: [{ id: "chg-abc", kind: "insertion", section: "draft.md" }] },
    ]);

    const [card] = await loadTranscript("/project");

    expect((card as { changes: { id: string }[] }).changes[0].id).toBe("chg-abc");
  });

  it("leaves a card of any other kind alone", async () => {
    callBackendMock.mockResolvedValueOnce([{ schema_version: 1, ...CARD }]);

    const cards = await loadTranscript("/project");

    expect(cards).toEqual([CARD]);
  });
});

/**
 * The transcript is append-only (D15) and machine-local, so every id a session minted before #1728
 * is on disk forever. Repairing them as they load is the same read-time disposition
 * `tolerateLegacyChangeIds` already takes for pre-TD-16 change ids, and for the same reason:
 * nothing is written back, and the transcript is machine-local scaffolding rather than a
 * `.cowrite/` portability contract, so no schema moves for it.
 *
 * `chat-message` (not `project-grounding`) is this suite's fixture kind. CJ's own store's eight
 * repeated `project-grounding-1` events were the empirically observed instance of this defect, but
 * `project-grounding` cards are now excluded from rehydration entirely (#1718, the describe block
 * below) — a repeated id on a card kind that still rehydrates is the general case this mechanism
 * still has to cover.
 */
describe("timeline/ipc — transcript ids minted before #1728", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  /** One session's chat-message event, as the pre-#1728 counter wrote it: same id every launch. */
  const repeated = (timestamp: string, id = "chat-message-1") => ({
    schema_version: 1,
    id,
    kind: "chat-message",
    author: "agent",
    body: `hi (${timestamp})`,
    timestamp,
  });

  it("rekeys a repeated id so a rehydrated history has no duplicate keys", async () => {
    callBackendMock.mockResolvedValueOnce([
      repeated("2026-07-26T04:33:05.631Z"),
      repeated("2026-07-27T23:06:26.455Z"),
      repeated("2026-07-28T01:02:03.000Z"),
    ]);

    const cards = await loadTranscript("/project");

    expect(new Set(cards.map((card) => card.id)).size).toBe(3);
    // Append order and every other field survive: these are three real sessions, not one.
    expect(cards.map((card) => card.timestamp)).toEqual([
      "2026-07-26T04:33:05.631Z",
      "2026-07-27T23:06:26.455Z",
      "2026-07-28T01:02:03.000Z",
    ]);
    expect(cards[0].id).toBe("chat-message-1");
  });

  it("leaves a history whose ids are merely similar exactly as persisted", async () => {
    // Distinct ids that share a prefix are not duplicates — only an exact repeat is the defect.
    callBackendMock.mockResolvedValueOnce([
      repeated("2026-07-26T04:33:05.631Z", "chat-message-1"),
      repeated("2026-07-27T23:06:26.455Z", "chat-message-11"),
      repeated("2026-07-28T01:02:03.000Z", "chat-message-1 "),
    ]);

    const cards = await loadTranscript("/project");

    expect(cards.map((card) => card.id)).toEqual(["chat-message-1", "chat-message-11", "chat-message-1 "]);
  });

  it("never spends an id another event in the same history persisted under its own name", async () => {
    // A repair must not take an id off the card that actually holds it — the third event here owns
    // `…-1#2` on disk, so the repaired second event skips past it rather than displacing it.
    callBackendMock.mockResolvedValueOnce([
      repeated("2026-07-26T04:33:05.631Z", "chat-message-1"),
      repeated("2026-07-27T23:06:26.455Z", "chat-message-1"),
      repeated("2026-07-28T01:02:03.000Z", "chat-message-1#2"),
      repeated("2026-07-29T01:02:03.000Z", "chat-message-1"),
    ]);

    const cards = await loadTranscript("/project");

    expect(cards.map((card) => card.id)).toEqual([
      "chat-message-1",
      "chat-message-1#3",
      "chat-message-1#2",
      "chat-message-1#4",
    ]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(4);
  });
});

/**
 * The grounding card is session-scoped state — "what grounding the agent has right now" — not
 * conversation history (#1718): `App`'s own `[project]`-keyed effect already raises a fresh one on
 * every open (J8 Screen 2's literal "one-time" acceptance), so a persisted copy rehydrating on top
 * would both duplicate that card and misreport a stale skill/workflow count, since the counts this
 * card names can change between opens. Every `project-grounding` event a store already holds
 * (including the eight-copy accumulation CJ's own transcript showed) is therefore dropped on read,
 * not merely deduplicated — a deliberate narrowing of the D15 "agent-originated card is part of the
 * conversation history a reopened project rehydrates" precedent `TimelinePanel`'s own persisting
 * write side documents (see that file's `incomingCards` effect).
 */
describe("timeline/ipc — a persisted project-grounding event never rehydrates (#1718)", () => {
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  const grounding = (id: string, timestamp: string) => ({
    schema_version: 1,
    id,
    kind: "project-grounding",
    skills: [],
    workflows: [],
    timestamp,
  });

  it("drops a lone persisted project-grounding event entirely", async () => {
    callBackendMock.mockResolvedValueOnce([grounding("project-grounding-1", "2026-07-26T04:33:05.631Z")]);

    const cards = await loadTranscript("/project");

    expect(cards).toEqual([]);
  });

  it("drops every persisted project-grounding event while keeping every other card in append order", async () => {
    callBackendMock.mockResolvedValueOnce([
      grounding("project-grounding-1", "2026-07-26T04:33:05.631Z"),
      { schema_version: 1, ...CARD },
      grounding("project-grounding-2", "2026-07-27T23:06:26.455Z"),
      grounding("project-grounding-3", "2026-07-28T01:02:03.000Z"),
    ]);

    const cards = await loadTranscript("/project");

    expect(cards).toEqual([CARD]);
  });
});

describe("timeline/ipc — a callBackend rejection is not swallowed", () => {
  // §7b Corollary B: this seam is routed, not exempted — every existing production caller
  // (`TimelinePanel`'s own `.catch(() => {})` on append, `.catch(() => {})` on the rehydrate
  // effect) already decides its own degrade; the bridge itself must not decide it silently, which
  // is what the old `if (!isTauri())` branch this replaces used to do.
  beforeEach(() => {
    callBackendMock.mockReset();
  });

  it("appendTranscriptEvent propagates a callBackend rejection", async () => {
    const failure = new Error("driver unreachable");
    callBackendMock.mockRejectedValueOnce(failure);

    await expect(appendTranscriptEvent("/project", CARD)).rejects.toThrow(failure);
  });

  it("loadTranscript propagates a callBackend rejection", async () => {
    const failure = new Error("driver unreachable");
    callBackendMock.mockRejectedValueOnce(failure);

    await expect(loadTranscript("/project")).rejects.toThrow(failure);
  });
});
