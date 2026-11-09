// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a-16 acceptance criteria (issue #160, FR-CHAT-1):
// ABOUTME: virtualized mounting and message-submit append; submit-scroll is P2b-1c/UXR-Q2.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCommentCard, type TimelineCard } from "./types";
import { TimelinePanel } from "./TimelinePanel";
import { mockRowHeights, sizeContainer } from "./virtualListTestUtils";
import { thread } from "../comments/threadFixture";

const ITEM_HEIGHT = 96;
const CONTAINER_HEIGHT = 600;

function manyChatCards(count: number): TimelineCard[] {
  // Rendering/ordering here is by array index, not by timestamp (P2a-17 owns chronological
  // persistence) — a single fixed timestamp is enough to satisfy the `ChatMessageCard` shape.
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    kind: "chat-message" as const,
    author: i % 2 === 0 ? "user" : "agent",
    body: `message ${i}`,
    timestamp: "2026-07-15T00:00:00.000Z",
  }));
}

describe("timeline/TimelinePanel", () => {
  it("mounts only the visible window (+ overscan) of a large card list not the full 5000", () => {
    const { container } = render(<TimelinePanel initialCards={manyChatCards(5000)} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 0 } });

    const mountedCards = container.querySelectorAll(".timeline-card");
    expect(mountedCards.length).toBeGreaterThan(0);
    expect(mountedCards.length).toBeLessThan(20);
    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.queryByText("message 4999")).toBeNull();
  });

  it("mounts the window near the scroll position after scrolling deep into a large list", () => {
    const { container } = render(<TimelinePanel initialCards={manyChatCards(5000)} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);

    // Scroll to roughly card 2500's position.
    fireEvent.scroll(list, { target: { scrollTop: 2500 * ITEM_HEIGHT } });

    expect(container.querySelectorAll(".timeline-card").length).toBeLessThan(20);
    expect(screen.getByText("message 2500")).toBeTruthy();
    expect(screen.queryByText("message 0")).toBeNull();
    expect(screen.queryByText("message 4999")).toBeNull();
  });

  it("positions rows by what its cards actually rendered rather than by the assumed item height (#1119)", () => {
    // The production composition edge of #1119: the panel's own `itemHeightFor` estimate is what
    // sizes an unmounted row, but a real card that renders taller than the estimate — a chat message
    // that wraps, a run card with several activity lines — must widen the offsets rather than
    // overflow a row box and paint over its neighbour. Rows that measure 3x the estimate fill the
    // same viewport with proportionally fewer of them.
    const cards = manyChatCards(200);
    const restore = mockRowHeights(Object.fromEntries(cards.map((card) => [card.id, 3 * ITEM_HEIGHT])));
    try {
      const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
      const list = sizeContainer(container, CONTAINER_HEIGHT);
      fireEvent.scroll(list, { target: { scrollTop: 0 } });

      // A 600px viewport fits ~6 estimated (96px) rows but only ~2 measured (288px) ones; overscan
      // adds 3 on each side to both. The measured window is strictly the smaller of the two.
      const mounted = container.querySelectorAll(".timeline-card").length;
      expect(mounted).toBeGreaterThan(0);
      expect(mounted).toBeLessThan(Math.ceil(CONTAINER_HEIGHT / ITEM_HEIGHT) + 1);

      // And the offsets that place them are the measured ones: scrolling to where the estimate would
      // have put card 10 lands past it, on a card the measured stream really has at that offset.
      fireEvent.scroll(list, { target: { scrollTop: 10 * ITEM_HEIGHT } });
      expect(screen.queryByText("message 10")).toBeNull();
      expect(screen.getByText("message 3")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("appends a user-message card to the stream on Send", () => {
    let idCounter = 0;
    render(<TimelinePanel createId={() => `test-id-${idCounter++}`} now={() => "2026-07-15T00:00:00.000Z"} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello from the user" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("hello from the user")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("appends a user-message card on Enter (without Shift) and clears the field", () => {
    render(<TimelinePanel />);
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: "submitted via enter" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: false });

    expect(screen.getByText("submitted via enter")).toBeTruthy();
    expect(field.value).toBe("");
  });

  it("does not submit on Shift+Enter (multi-line input)", () => {
    const { container } = render(<TimelinePanel />);
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: "line one" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });

    // The typed text stays in the field (not submitted) — no card was appended to the stream.
    expect(field.value).toBe("line one");
    expect(container.querySelectorAll(".timeline-card").length).toBe(0);
  });

  it("does not submit blank/whitespace-only input", () => {
    render(<TimelinePanel />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(document.querySelectorAll(".timeline-card").length).toBe(0);
  });

  it("renders a comment card through the same render-switch as a chat card (P2a-18)", () => {
    const commentCard: TimelineCard = {
      id: "comment-1",
      kind: "comment",
      root: "/project",
      path: "doc.md",
      timestamp: "2026-07-17T00:00:00.000Z",
      thread: thread("c1", { body: "please clarify this passage" }),
    };
    render(<TimelinePanel initialCards={[commentCard]} />);
    expect(screen.getByText("please clarify this passage")).toBeTruthy();
  });

  it("renders a change-set card through the same render-switch as a chat card (P2a-14)", () => {
    const changeSetCard: TimelineCard = {
      id: "cs-1",
      kind: "change-set",
      doc: "notes/outline.md",
      generation: null,
      changeSetId: "cs1",
      summary: "Tightened hook",
      timestamp: "2026-07-18T00:00:00.000Z",
      changes: [{ id: "1", kind: "insertion", section: "§1 Opening", newText: "We" }],
    };
    render(<TimelinePanel initialCards={[changeSetCard]} />);
    expect(screen.getByText("Tightened hook")).toBeTruthy();
  });

  it("renders the mic-button slot inert (no dictation wiring yet — FR-ED-5 is Phase 5)", () => {
    render(<TimelinePanel />);
    const mic = screen.getByRole("button", { name: /dictate/i });
    expect(mic).toBeDisabled();
  });

  it("sends a message carrying an incoming quote as a chat card with its quoted excerpt (P2b-7)", () => {
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
    render(<TimelinePanel incomingQuote={quote} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "see this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("see this")).toBeTruthy();
    expect(screen.getByText("“the quoted sentence”")).toBeTruthy();
    // The composer's own quote bar clears after send — only the sent card still shows the quote.
    expect(screen.queryByLabelText("Quoted selection")).toBeNull();
  });

  it("forwards a mounted chat card's quote click to onFocusQuote (P2b-7 follow-up #492)", () => {
    const anchor = {
      offset: 10,
      length: 20,
      text_snapshot: "the quoted sentence",
      context_before: "",
      context_after: "",
      base_revision: "blake3:abc",
    };
    const chatCard: TimelineCard = {
      id: "chat-1",
      kind: "chat-message",
      author: "user",
      body: "see this",
      timestamp: "2026-07-18T00:00:00.000Z",
      quote: { documentPath: "notes/outline.md", text: "the quoted sentence", anchor },
    };
    const onFocusQuote = vi.fn();
    render(<TimelinePanel initialCards={[chatCard]} onFocusQuote={onFocusQuote} />);

    fireEvent.click(screen.getByText("“the quoted sentence”"));

    expect(onFocusQuote).toHaveBeenCalledWith(anchor);
  });

  it("#2574 routes a withdrawn card's full anchor and document identity to the editor", () => {
    const anchor = { offset: 4, length: 5, text_snapshot: "world", context_before: "hello ", context_after: "", base_revision: "r0" };
    const retained = thread("c1", { anchor, withdrawn_at: 20, visible_when_withdrawn: true, published: true });
    const onFocusCommentAnchor = vi.fn();
    render(<TimelinePanel initialCards={[createCommentCard("/project", "notes/outline.md", retained)]}
      onFocusCommentAnchor={onFocusCommentAnchor} />);

    fireEvent.click(screen.getByRole("button", { name: "→ Go to passage" }));

    expect(onFocusCommentAnchor).toHaveBeenCalledWith("/project", "notes/outline.md", anchor);
  });

  it("#2574 routes an active UUID-owned comment by document ID", () => {
    const anchor = { offset: 4, length: 5, text_snapshot: "world", context_before: "hello ", context_after: "", base_revision: "r0" };
    const retained = thread("c1", { anchor, withdrawn_at: 20, visible_when_withdrawn: true, published: true });
    const card = { ...createCommentCard("/project", "untitled:1:b.md", retained), docId: "doc-1" };
    const onFocusPathlessCommentAnchor = vi.fn();
    render(<TimelinePanel initialCards={[card]} onFocusPathlessCommentAnchor={onFocusPathlessCommentAnchor} />);

    fireEvent.click(screen.getByRole("button", { name: "→ Go to passage" }));

    expect(onFocusPathlessCommentAnchor).toHaveBeenCalledWith("/project", "doc-1", anchor);
  });

  it("sends an ordinary message with no quote when nothing was attached", () => {
    render(<TimelinePanel />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "plain message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("plain message")).toBeTruthy();
    expect(screen.queryByText(/“/)).toBeNull();
  });

  it("scrolls a scrolled-up reader to their own card on submit (UXR-Q2 / P2b-1c)", () => {
    // Superseded regression: this test used to pin the *opposite* — that a submit-driven append
    // must never move a scrolled-up reader — citing Principle 2. UXR-Q2 (ux-design §4 "Scroll
    // motion", ratified 2026-07-20) clarifies that Principle 2's *auto-scrolls* verb binds motion
    // the user did not ask for; the user's own submit is a deliberate act and *does* scroll, to the
    // card it just created. The conflation was real — the append this test drove was always the
    // user's own submit path, never an agent/remote append; `TimelinePanel.agentActivity.test.tsx`'s
    // "does not force-scroll a scrolled-up reader when an activity push arrives" is what pins the
    // genuine Principle 2 case (a non-user-initiated append) that this test's name actually named.
    const { container } = render(<TimelinePanel initialCards={manyChatCards(200)} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);

    // Reader scrolls up to read history, away from the bottom of the stream.
    fireEvent.scroll(list, { target: { scrollTop: ITEM_HEIGHT * 10 } });
    expect(list.scrollTop).toBe(ITEM_HEIGHT * 10);

    // The reader submits their own message.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "new incoming card" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Carried to the new card — the last row (index 200) of the now-201-long stream.
    const maxScrollTop = 201 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    expect(list.scrollTop).toBe(maxScrollTop);
    expect(screen.getByText("new incoming card")).toBeTruthy();
  });

  it("reveals only the top of a just-sent card taller than the viewport, never a partial view of its end (#1324)", () => {
    // CJ's #1324 ruling: submit reveals the entire card when it fits the viewport, and just its top
    // — the natural reading start — when the card is itself taller than the viewport. The card just
    // sent has never been mounted at submit time, so `VirtualList` can only judge "does it fit" off
    // its estimate (`ITEM_HEIGHT`, 96) until it actually renders; `sentCardId`'s real height (mocked
    // below, well past `CONTAINER_HEIGHT`) only lands a commit later — the exact shape #1324 measured
    // "leaving ~208px of it below the fold" from.
    const sentCardId = "sent-card";
    const restoreHeights = mockRowHeights({ [sentCardId]: 900 });
    try {
      const { container } = render(
        <TimelinePanel
          initialCards={manyChatCards(20)}
          itemHeight={ITEM_HEIGHT}
          createId={() => sentCardId}
        />,
      );
      const list = sizeContainer(container, CONTAINER_HEIGHT);

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "a message that wraps far past its estimate" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      // The card's own top — 20 * 96 — is the only position that reveals where reading of an
      // oversized card should start; a bottom-anchored (or estimate-stranded) target would leave the
      // top scrolled past instead, exactly the defect this issue reports.
      expect(list.scrollTop).toBe(20 * ITEM_HEIGHT);
      expect(screen.getByText("a message that wraps far past its estimate")).toBeTruthy();
    } finally {
      restoreHeights();
    }
  });

  describe("change-set triage wiring (#410)", () => {
    const changeSetCard: TimelineCard = {
      id: "cs-1",
      kind: "change-set",
      doc: "notes/outline.md",
      generation: null,
      changeSetId: "cs1",
      summary: "Tightened hook",
      timestamp: "2026-07-18T00:00:00.000Z",
      changes: [{ id: "1", kind: "insertion", section: "§1 Opening", newText: "We" }],
    };

    it("supplies onChangeSetDecide as the card's onDecide — a click routes ids/decision through it", () => {
      const onChangeSetDecide = vi.fn().mockReturnValue(["1"]);
      render(<TimelinePanel initialCards={[changeSetCard]} onChangeSetDecide={onChangeSetDecide} />);

      fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

      expect(onChangeSetDecide).toHaveBeenCalledWith(["1"], "accept");
    });

    it("accumulates each decidedChangeIds batch and forwards the running set as the card's own reconciliation prop", () => {
      const { rerender } = render(<TimelinePanel initialCards={[changeSetCard]} />);
      expect(screen.getByText("1 change · 1 section")).toBeTruthy();

      // A fresh array each time (the "one-shot event" contract) — a same-reference re-render must
      // not be required for the merge to run.
      rerender(<TimelinePanel initialCards={[changeSetCard]} decidedChangeIds={["1"]} />);

      fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
      expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
    });

    it("a later render with an empty/omitted batch never un-decides an id already accumulated", () => {
      const { rerender } = render(
        <TimelinePanel initialCards={[changeSetCard]} decidedChangeIds={["1"]} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
      expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();

      rerender(<TimelinePanel initialCards={[changeSetCard]} decidedChangeIds={[]} />);

      expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
      expect(screen.getByText("↳ 1 change decided elsewhere")).toBeTruthy();
    });

    it("retains decided-elsewhere provenance across a virtualized unmount and remount", () => {
      const { container } = render(
        <TimelinePanel
          initialCards={[changeSetCard, ...manyChatCards(50)]}
          decidedChangeIds={["1"]}
          itemHeight={ITEM_HEIGHT}
        />,
      );
      const list = sizeContainer(container, ITEM_HEIGHT * 2);
      fireEvent.scroll(list, { target: { scrollTop: 0 } });

      fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
      expect(screen.getByText("↳ 1 change decided elsewhere")).toBeTruthy();

      fireEvent.scroll(list, { target: { scrollTop: ITEM_HEIGHT * 30 } });
      expect(screen.queryByText("Tightened hook")).toBeNull();

      fireEvent.scroll(list, { target: { scrollTop: 0 } });
      expect(screen.getByText("↳ 1 change decided elsewhere")).toBeTruthy();
    });

    it("retains acting-card reach across a virtualized unmount and remount", () => {
      const onChangeSetDecide = vi.fn().mockReturnValue(["1", "outside-1"]);
      const { container } = render(
        <TimelinePanel
          initialCards={[changeSetCard, ...manyChatCards(50)]}
          itemHeight={ITEM_HEIGHT}
          onChangeSetDecide={onChangeSetDecide}
        />,
      );
      const list = sizeContainer(container, ITEM_HEIGHT * 2);
      fireEvent.scroll(list, { target: { scrollTop: 0 } });

      fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
      fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
      expect(screen.getByText("↳ also decided 1 linked change outside this set")).toBeTruthy();

      fireEvent.scroll(list, { target: { scrollTop: ITEM_HEIGHT * 30 } });
      expect(screen.queryByText("Tightened hook")).toBeNull();

      fireEvent.scroll(list, { target: { scrollTop: 0 } });
      expect(screen.getByText("↳ also decided 1 linked change outside this set")).toBeTruthy();
    });

    it("withdraws reach on reversal and restores it when redo re-decides the reached id", () => {
      const onChangeSetDecide = vi.fn().mockReturnValue(["1", "outside-1"]);
      const { rerender } = render(
        <TimelinePanel initialCards={[changeSetCard]} onChangeSetDecide={onChangeSetDecide} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
      fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
      expect(screen.getByText("↳ also decided 1 linked change outside this set")).toBeTruthy();

      rerender(
        <TimelinePanel
          initialCards={[changeSetCard]}
          onChangeSetDecide={onChangeSetDecide}
          reversedChangeIds={["1", "outside-1"]}
        />,
      );
      expect(screen.queryByText(/linked change outside this set/)).toBeNull();

      rerender(
        <TimelinePanel
          initialCards={[changeSetCard]}
          onChangeSetDecide={onChangeSetDecide}
          decidedChangeIds={["1", "outside-1"]}
        />,
      );
      expect(screen.getByText("↳ also decided 1 linked change outside this set")).toBeTruthy();
      expect(screen.queryByText(/changes? decided elsewhere/)).toBeNull();
    });

    it("does not restore historical reach when another surface re-decides the same ids", () => {
      const onChangeSetDecide = vi.fn().mockReturnValue(["1", "outside-1"]);
      const otherCard: TimelineCard = {
        ...changeSetCard,
        id: "cs-2",
        changeSetId: "cs2",
        summary: "Reconsidered hook",
        changes: [
          {
            id: "outside-1",
            kind: "insertion",
            section: "§1 Opening",
            newText: "Again",
          },
        ],
      };
      const { rerender } = render(
        <TimelinePanel
          initialCards={[changeSetCard, otherCard]}
          onChangeSetDecide={onChangeSetDecide}
        />,
      );
      const actingCard = document.querySelector('[data-card-id="cs-1"]') as HTMLElement;

      fireEvent.click(within(actingCard).getByRole("button", { name: "Accept all" }));
      fireEvent.click(within(actingCard).getByRole("button", { name: /^Expand/ }));
      expect(
        within(actingCard).getByText("↳ also decided 1 linked change outside this set"),
      ).toBeTruthy();

      rerender(
        <TimelinePanel
          initialCards={[changeSetCard, otherCard]}
          onChangeSetDecide={onChangeSetDecide}
          reversedChangeIds={["1", "outside-1"]}
        />,
      );
      expect(screen.queryByText(/linked change outside this set/)).toBeNull();

      const otherActingCard = document.querySelector('[data-card-id="cs-2"]') as HTMLElement;
      fireEvent.click(within(otherActingCard).getByRole("button", { name: "Accept all" }));
      fireEvent.click(within(otherActingCard).getByRole("button", { name: /^Expand/ }));

      expect(within(actingCard).queryByText(/linked change outside this set/)).toBeNull();
      expect(within(actingCard).getByText("↳ 1 change decided elsewhere")).toBeTruthy();
      expect(
        within(otherActingCard).getByText("↳ also decided 1 linked change outside this set"),
      ).toBeTruthy();
      expect(within(otherActingCard).queryByText(/changes? decided elsewhere/)).toBeNull();
    });
  });
});

describe("timeline/TimelinePanel — an agent delivery raises its change-set card (#346)", () => {
  const changeSetCard = (id: string): TimelineCard => ({
    id,
    kind: "change-set",
    doc: "notes/outline.md",
    generation: null,
    changeSetId: `cs-${id}`,
    summary: "Tightened the opening.",
    changes: [
      { id: "0", kind: "insertion", section: "draft.md", newText: "brave ", note: "clarity" },
    ],
    timestamp: "2026-07-20T00:00:00.000Z",
  });

  it("appends the delivered card to the stream", () => {
    const { rerender } = render(<TimelinePanel initialCards={manyChatCards(2)} />);
    expect(screen.queryByText("Tightened the opening.")).toBeNull();

    rerender(
      <TimelinePanel initialCards={manyChatCards(2)} incomingCards={[changeSetCard("d1")]} />,
    );

    expect(screen.getByText("Tightened the opening.")).toBeTruthy();
  });

  it("appends each distinct card once no matter how often the owner re-renders", () => {
    const card = changeSetCard("d1");
    const { rerender } = render(<TimelinePanel incomingCards={[card]} />);
    rerender(<TimelinePanel incomingCards={[card]} />);
    rerender(<TimelinePanel incomingCards={[{ ...card }]} />);

    expect(screen.getAllByText("Tightened the opening.")).toHaveLength(1);
  });

  it("appends a second genuinely different delivery alongside the first", () => {
    const { rerender } = render(<TimelinePanel incomingCards={[changeSetCard("d1")]} />);
    rerender(<TimelinePanel incomingCards={[changeSetCard("d1"), changeSetCard("d2")]} />);

    expect(screen.getAllByText("Tightened the opening.")).toHaveLength(2);
  });

  // The regression this shape exists to guard against (review of PR #552 @ 9e456349, Important):
  // two cards landing together — as they would from two producers colliding in one batched render
  // — must both survive, not just the list's newest entry.
  it("appends every not-yet-seen card in one update — not just the most recent one", () => {
    render(<TimelinePanel incomingCards={[changeSetCard("d1"), changeSetCard("d2")]} />);

    expect(screen.getAllByText("Tightened the opening.")).toHaveLength(2);
  });

  it("does not force-scroll a scrolled-up reader when a delivery lands (Principle 2)", () => {
    // The delivery is the agent moving, not the user — the reader's viewport stays where they put
    // it. Same rule the submit path is pinned against, asserted for the agent-originated append.
    const { container, rerender } = render(
      <TimelinePanel initialCards={manyChatCards(200)} itemHeight={ITEM_HEIGHT} />,
    );
    const list = sizeContainer(container, CONTAINER_HEIGHT);
    fireEvent.scroll(list, { target: { scrollTop: 1000 } });

    rerender(
      <TimelinePanel
        initialCards={manyChatCards(200)}
        itemHeight={ITEM_HEIGHT}
        incomingCards={[changeSetCard("d1")]}
      />,
    );

    expect(list.scrollTop).toBe(1000);
  });
});
