// ABOUTME: Tests for the delivery subscription + card mapping (#346) — the frontend end of the J1
// ABOUTME: Phase B pipe: which backend event it listens to, and how one notice becomes a change-set
// ABOUTME: card whose changes are this delivery's own rather than every marker in the document.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedChange } from "../editor/trackedChanges";

const listenForBackendEventMock = vi.fn();
vi.mock("./driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEventMock(...args),
}));

const { DELIVERY_EVENT, changeSetCardFor, listenForDeliveries } = await import("./delivery");

/** A notice shaped exactly like the Rust `agent::delivery::DeliveryNotice` wire form. */
function notice(overrides: Partial<Record<string, unknown>> = {}) {
  const content = "hello {++brave ++}world\n";
  return {
    doc: "draft.md",
    changeSetId: "cs-1",
    revision: "rev-2",
    content,
    summary: "Tightened the opening.",
    changes: [
      {
        changeId: "chg-a",
        kind: "insertion" as const,
        note: "clarity",
        group: null,
      },
    ],
    stale: 0,
    unrepresentable: 0,
    ...overrides,
  };
}

/** The `parse_changes` snapshot for `content` — what the backend parse hands the frontend. A
 * delivered marker comes back *recorded*, under the same `chg-` id its attribution record (and so
 * the notice) carries: that shared identity is what the card joins on (TD-16 ruling 3). */
function ins(content: string, id: string, inner: string, recorded = true): ParsedChange {
  const from = content.indexOf(`{++${inner}++}`);
  const full = { from, to: from + inner.length + 6 };
  return { id, recorded, group: null, full, kind: "insertion", text: { from: full.from + 3, to: full.to - 3 } };
}

describe("stores/delivery — subscribing to backend deliveries", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
  });

  it("listens on the delivery event and hands the notice payload to the handler", async () => {
    let emit: ((payload: unknown) => void) | undefined;
    const unlisten = vi.fn();
    listenForBackendEventMock.mockImplementation((_name: string, cb: (payload: unknown) => void) => {
      emit = cb;
      return Promise.resolve(unlisten);
    });

    const handler = vi.fn();
    const stop = await listenForDeliveries(handler);

    expect(listenForBackendEventMock).toHaveBeenCalledWith(DELIVERY_EVENT, expect.any(Function));
    const n = notice();
    emit?.(n);
    expect(handler).toHaveBeenCalledWith(n);

    stop();
    expect(unlisten).toHaveBeenCalled();
  });

});

describe("stores/delivery — one notice becomes one change-set card", () => {
  it("carries the delivery's identity and summary onto the card", () => {
    const n = notice();
    const card = changeSetCardFor(n, [ins(n.content, "chg-a", "brave ")], { id: "c-1", timestamp: "T" });

    expect(card.kind).toBe("change-set");
    expect(card.changeSetId).toBe("cs-1");
    expect(card.summary).toBe("Tightened the opening.");
    expect(card.id).toBe("c-1");
    expect(card.timestamp).toBe("T");
  });

  it("renders each change with its parsed identity and kind and text and agent note", () => {
    const n = notice();
    const card = changeSetCardFor(n, [ins(n.content, "chg-a", "brave ")]);

    expect(card.changes).toHaveLength(1);
    expect(card.changes[0]).toMatchObject({
      id: "chg-a",
      kind: "insertion",
      newText: "brave ",
      note: "clarity",
    });
  });

  it("keys a card's changes to the durable attribution id the editor's own parse reports", () => {
    // TD-16: the card's ids ARE the sidecar's (`chg-…`), so deciding them against the live field
    // needs no positional correspondence — the same identity names the same change on both sides.
    const n = notice();
    const card = changeSetCardFor(n, [ins(n.content, "chg-a", "brave ")]);
    expect(card.changes.map((c) => c.id)).toEqual(n.changes.map((c) => c.changeId));
  });

  it("groups the whole delivery under one section named for the document", () => {
    // A `propose_changes` delivery carries no sectioning of its own (D5: per-section chunking is
    // a later delivery concern) — so the card must not invent one.
    const n = notice();
    const card = changeSetCardFor(n, [ins(n.content, "chg-a", "brave ")]);
    expect(new Set(card.changes.map((c) => c.section))).toEqual(new Set(["draft.md"]));
  });

  it("includes only this delivery's changes when the document also carries earlier markers", () => {
    // The document accumulates markers across deliveries; the parse sees all of them. A card
    // listing an earlier delivery's changes would let [Accept all] sweep up changes the user
    // never saw in this card — selecting by this delivery's own ids is what prevents that.
    const content = "{++old++} hello {++new++} world\n";
    const parsed = [ins(content, "chg-a", "old"), ins(content, "chg-b", "new")];
    const n = notice({
      content,
      changes: [{ changeId: "chg-b", kind: "insertion" as const, note: null, group: null }],
    });

    const card = changeSetCardFor(n, parsed);

    expect(card.changes.map((c) => c.id)).toEqual(["chg-b"]);
    expect(card.changes[0].newText).toBe("new");
  });

  it("renders a deletion's removed side and a substitution's two sides", () => {
    const content = "a {--gone--} b {~~old~>new~~}\n";
    const del = content.indexOf("{--");
    const sub = content.indexOf("{~~");
    const parsed: ParsedChange[] = [
      {
        id: "chg-d",
        recorded: true,
        group: null,
        full: { from: del, to: del + 12 },
        kind: "deletion",
        text: { from: del + 3, to: del + 7 },
      },
      {
        id: "chg-s",
        recorded: true,
        group: null,
        full: { from: sub, to: sub + 14 },
        kind: "substitution",
        old: { from: sub + 3, to: sub + 6 },
        new: { from: sub + 8, to: sub + 11 },
      },
    ];
    const n = notice({
      content,
      changes: [
        { changeId: "chg-d", kind: "deletion" as const, note: null, group: null },
        { changeId: "chg-s", kind: "substitution" as const, note: null, group: null },
      ],
    });

    const card = changeSetCardFor(n, parsed);

    expect(card.changes[0]).toMatchObject({ kind: "deletion", oldText: "gone" });
    expect(card.changes[1]).toMatchObject({ kind: "substitution", oldText: "old", newText: "new" });
  });

  it("drops a delivered change the parse does not report rather than inventing geometry", () => {
    // The parse reports a delivered marker under its record id only where the join succeeded; a
    // change it does not report has no geometry here. Failing soft (fewer changes on the card)
    // beats fabricating a span that triage would then act on.
    const n = notice({
      changes: [{ changeId: "chg-x", kind: "insertion" as const, note: null, group: null }],
    });
    expect(changeSetCardFor(n, [ins(n.content, "chg-a", "brave ")]).changes).toHaveLength(0);
  });

  it("drops a delivered change whose marker the parse reports as unrecorded", () => {
    // An unrecorded marker carries a snapshot-scoped id, never the notice's `chg-…` — so a
    // document whose records did not join contributes nothing to this card instead of matching
    // some other change by position.
    const n = notice();
    const unrecorded = ins(n.content, "snap:draft.md:blake3:x:0", "brave ", false);
    expect(changeSetCardFor(n, [unrecorded]).changes).toHaveLength(0);
  });
});
