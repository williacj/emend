// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2b-1a acceptance criteria (issue #347): the facet bar
// ABOUTME: renders the five ratified facets, selecting one filters the stream (All restores it),
// ABOUTME: and clicking a facet jumps to the most recent card of that kind — a no-op, never a
// ABOUTME: throw, when the stream holds none — all still windowed by the P2a-16 virtualizer. Also
// ABOUTME: pins the PR #392 facet-jump clamp fix and the P2b-1c/UXR-Q2 submit/affordance lifecycle
// ABOUTME: that superseded PR #392's original facet-restore-on-submit behavior.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelineCard } from "./types";
import { thread } from "../comments/threadFixture";
import { TimelinePanel } from "./TimelinePanel";
import { sizeContainer } from "./virtualListTestUtils";

const ITEM_HEIGHT = 96;
const CONTAINER_HEIGHT = 600;

/** A mixed-kind stream in chronological order — every third card cycles chat-message / comment /
 * change-set, so each facet has multiple, distinguishable matches spread across the stream. */
function mixedFacetCards(count: number): TimelineCard[] {
  return Array.from({ length: count }, (_, i) => {
    const timestamp = new Date(2026, 6, 1, 0, i).toISOString();
    const cycle = i % 3;
    if (cycle === 0) {
      return { id: `chat-${i}`, kind: "chat-message", author: "user", body: `chat ${i}`, timestamp } satisfies TimelineCard;
    }
    if (cycle === 1) {
      return {
        id: `comment-${i}`,
        kind: "comment",
        root: "/project",
        path: "doc.md",
        timestamp,
        thread: thread(`thread-${i}`, { body: `comment ${i}` }),
      } satisfies TimelineCard;
    }
    return {
      id: `change-${i}`,
      kind: "change-set",
      doc: `notes/change-${i}.md`,
      generation: null,
      changeSetId: `cs-${i}`,
      summary: `changes ${i}`,
      timestamp,
      changes: [],
    } satisfies TimelineCard;
  });
}

describe("timeline/TimelinePanel — facet bar (P2b-1a, issue #347)", () => {
  it("renders the five ratified facets: All / Chat / Comments / Changes / Findings", () => {
    render(<TimelinePanel />);
    for (const label of ["All", "Chat", "Comments", "Changes", "Findings"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("selecting a facet filters the stream to cards of that kind; All restores the full stream", () => {
    const cards = mixedFacetCards(9);
    render(<TimelinePanel initialCards={cards} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByText("chat 0")).toBeTruthy();
    expect(screen.queryByText("comment 1")).toBeNull();
    expect(screen.queryByText("changes 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("chat 0")).toBeTruthy();
    expect(screen.getByText("comment 1")).toBeTruthy();
    expect(screen.getByText("changes 2")).toBeTruthy();
  });

  it("Findings renders its own empty message, not a silent blank panel, when no card carries finding provenance", () => {
    // `mixedFacetCards` builds every comment card through `threadFixture.ts`'s plain defaults
    // (severity/skill both null, D6's "ordinary human comment") — none of them is a finding.
    const cards = mixedFacetCards(9);
    render(<TimelinePanel initialCards={cards} />);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "Findings" }))).not.toThrow();
    expect(document.querySelectorAll(".timeline-card").length).toBe(0);
    // Issue #1727: an empty facet used to render `text=""` — indistinguishable from a broken
    // panel. It must say its own emptiness (Principle 7, matching `ProjectRail`'s "No files yet").
    expect(screen.getByText("No findings yet")).toBeTruthy();
  });

  describe("empty-facet messages (issue #1727 — a filtered-to-nothing facet says so, never a blank panel)", () => {
    const mixed = mixedFacetCards(9); // chat-message, comment, change-set — no findings
    // Chat-only stream: Comments and Changes both genuinely hold none of their kind here.
    const chatOnly: TimelineCard[] = Array.from({ length: 3 }, (_, i) => ({
      id: `chat-only-${i}`,
      kind: "chat-message",
      author: "user",
      body: `chat only ${i}`,
      timestamp: new Date(2026, 6, 1, 0, i).toISOString(),
    }));

    it("Comments shows its own empty message when the stream holds no comment card", () => {
      render(<TimelinePanel initialCards={chatOnly} />);
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
      expect(document.querySelectorAll(".timeline-card").length).toBe(0);
      expect(screen.getByText("No comments yet")).toBeTruthy();
    });

    it("Changes shows its own empty message when the stream holds no change-set card", () => {
      render(<TimelinePanel initialCards={chatOnly} />);
      fireEvent.click(screen.getByRole("button", { name: "Changes" }));
      expect(document.querySelectorAll(".timeline-card").length).toBe(0);
      expect(screen.getByText("No changes yet")).toBeTruthy();
    });

    it("a non-empty facet shows no empty message", () => {
      render(<TimelinePanel initialCards={mixed} />);
      fireEvent.click(screen.getByRole("button", { name: "Chat" }));
      expect(screen.queryByText("No chat yet")).toBeNull();
    });

    it("Chat shows its own empty message when the stream holds no chat/agent-working card", () => {
      const commentOnly: TimelineCard[] = [
        {
          id: "comment-only",
          kind: "comment",
          root: "/project",
          path: "doc.md",
          timestamp: "2026-07-01T00:00:00.000Z",
          thread: thread("comment-only", { body: "not chat" }),
        },
      ];
      render(<TimelinePanel initialCards={commentOnly} />);
      fireEvent.click(screen.getByRole("button", { name: "Chat" }));
      expect(screen.getByText("No chat yet")).toBeTruthy();
    });

    it("All shows its own empty message when the stream is entirely empty", () => {
      render(<TimelinePanel />);
      expect(screen.getByText("No activity yet")).toBeTruthy();
    });

    it("All shows no empty message once any card exists", () => {
      render(<TimelinePanel initialCards={mixed} />);
      expect(screen.queryByText("No activity yet")).toBeNull();
    });
  });

  it("Findings selects a comment card whose thread carries review provenance (severity/skill — P2b-5b)", () => {
    const cards: TimelineCard[] = [
      ...mixedFacetCards(3),
      {
        id: "finding-1",
        kind: "comment",
        root: "/project",
        path: "doc.md",
        timestamp: new Date(2026, 6, 1, 1, 0).toISOString(),
        thread: thread("finding-thread", { severity: "high", skill: "biblical-accuracy", body: "Cite it correctly" }),
      },
    ];
    render(<TimelinePanel initialCards={cards} />);

    fireEvent.click(screen.getByRole("button", { name: "Findings" }));

    expect(screen.getByText("Cite it correctly")).toBeTruthy();
    expect(document.querySelectorAll(".timeline-card").length).toBe(1);
  });

  it("facet-jump scrolls to the most recent card of the selected kind — still windowed not all mounted", () => {
    const cards = mixedFacetCards(300); // 100 comment cards spread through the stream
    const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
    sizeContainer(container, CONTAINER_HEIGHT);

    fireEvent.click(screen.getByRole("button", { name: "Comments" }));

    // Most recent comment is "comment 298" (the last i % 3 === 1 index below 300).
    expect(screen.getByText("comment 298")).toBeTruthy();
    // An early comment is filtered out of view by the jump (outside the mounted window).
    expect(screen.queryByText("comment 1")).toBeNull();
    // Filtering composes with virtualization — a filtered, jumped-to stream still mounts only a
    // small window, never every matching card (P2a-16's shape, extended per the issue).
    expect(container.querySelectorAll(".timeline-card").length).toBeLessThan(20);
  });

  it("a filtered 5k-card stream still mounts only a small window — not every facet match", () => {
    const cards = mixedFacetCards(5000);
    const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
    sizeContainer(container, CONTAINER_HEIGHT);

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));

    expect(container.querySelectorAll(".timeline-card").length).toBeLessThan(20);
    expect(screen.getByText("changes 4997")).toBeTruthy();
  });

  it("facet-jump clamps the scroll target to the container's max scroll — never past the end of content", () => {
    // 100 comment cards spread through 300 — the last (index 99, unclamped target 99*96=9504px)
    // exceeds this filtered stream's total content height (100*96=9600px) minus the container's
    // height (600px): a real browser clamps `scrollTop` assignment to that 9000px max, but jsdom
    // does not, so an unclamped target would go undetected here yet still desync state vs. DOM in
    // production (review finding, PR #392).
    const cards = mixedFacetCards(300);
    const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);

    fireEvent.click(screen.getByRole("button", { name: "Comments" }));

    const maxScrollTop = 100 * ITEM_HEIGHT - CONTAINER_HEIGHT; // 9000
    expect(list.scrollTop).toBe(maxScrollTop);
    expect(list.scrollTop).toBeLessThan(99 * ITEM_HEIGHT); // the unclamped target would have been 9504
    // Still lands on the right card — clamping the scroll position doesn't drop the jump target
    // from the mounted window.
    expect(screen.getByText("comment 298")).toBeTruthy();
  });

  it("submitting a message while Chat is active does not change the facet — and scrolls to the new card (P2b-1c / UXR-Q2)", () => {
    // Supersedes the retired PR #392 "restores All" behavior: UXR-Q2 (ux-design §4 "Scroll motion",
    // ratified 2026-07-20) drops facet-restore-on-submit outright. The submitted card is always
    // `"chat-message"`, so Chat is the one non-All facet under which it's visible without any
    // change of filter.
    const cards = mixedFacetCards(9);
    const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
    sizeContainer(container, CONTAINER_HEIGHT);

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByText("comment 1")).toBeNull(); // sanity: Chat really does filter out comments

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello under chat facet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("hello under chat facet")).toBeTruthy();
    // The facet never moved off Chat — no facet-restore.
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    // The still-excluded kinds stay excluded — this isn't "All" wearing a different label.
    expect(screen.queryByText("comment 1")).toBeNull();
  });

  it("submitting under All scrolls to the new card without disturbing the (already all-inclusive) facet", () => {
    const cards = mixedFacetCards(200);
    const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
    const list = sizeContainer(container, CONTAINER_HEIGHT);

    // Reader has scrolled up into history — a submit is still their own deliberate act.
    fireEvent.scroll(list, { target: { scrollTop: ITEM_HEIGHT * 5 } });

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello under all" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("hello under all")).toBeTruthy();
    const maxScrollTop = 201 * ITEM_HEIGHT - CONTAINER_HEIGHT;
    expect(list.scrollTop).toBe(maxScrollTop);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  describe("the `N new in <Facet> →` affordance (P2b-1c, UXR-Q2)", () => {
    it("renders when a submitted card falls outside the active filter — naming the card's own facet and a count of 1", () => {
      const cards = mixedFacetCards(9);
      render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);

      fireEvent.click(screen.getByRole("button", { name: "Changes" }));
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello under changes facet" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      // The card is a chat-message — filtered out by Changes, so it's not rendered in the stream...
      expect(screen.queryByText("hello under changes facet")).toBeNull();
      // ...but the affordance surfaces it rather than silently dropping it (FR-X-5).
      expect(screen.getByRole("button", { name: "1 new in Chat →" })).toBeTruthy();
      // The active filter itself never moved — this is the whole point of dropping facet-restore.
      expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    });

    it("counts up while more excluded cards land — without minting a second affordance", () => {
      const cards = mixedFacetCards(9);
      render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);

      fireEvent.click(screen.getByRole("button", { name: "Changes" }));
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "first" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(screen.getByRole("button", { name: "1 new in Chat →" })).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(screen.getByRole("button", { name: "2 new in Chat →" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "1 new in Chat →" })).toBeNull();
    });

    it("does not render when nothing has been submitted — or when a submit lands inside the active filter", () => {
      const cards = mixedFacetCards(9);
      render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
      expect(screen.queryByRole("button", { name: /new in/ })).toBeNull();

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "under all — always visible" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(screen.queryByRole("button", { name: /new in/ })).toBeNull();
    });

    it("dismissed by clicking it — switches to the named facet and scrolls to the most recent card via facet-jump", () => {
      const cards = mixedFacetCards(9);
      const { container } = render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);
      sizeContainer(container, CONTAINER_HEIGHT);

      fireEvent.click(screen.getByRole("button", { name: "Changes" }));
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello under changes facet" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      fireEvent.click(screen.getByRole("button", { name: "1 new in Chat →" }));

      expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("hello under changes facet")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /new in/ })).toBeNull();
    });

    it("dismissed by any facet change — not only by clicking the affordance itself", () => {
      const cards = mixedFacetCards(9);
      render(<TimelinePanel initialCards={cards} itemHeight={ITEM_HEIGHT} />);

      fireEvent.click(screen.getByRole("button", { name: "Changes" }));
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello under changes facet" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(screen.getByRole("button", { name: "1 new in Chat →" })).toBeTruthy();

      // The reader switches facets directly through the facet bar, not through the affordance.
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));

      expect(screen.queryByRole("button", { name: /new in/ })).toBeNull();
    });
  });
});
