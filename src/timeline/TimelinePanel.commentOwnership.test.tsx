// @vitest-environment jsdom
// ABOUTME: Pins #411's fix directly: a mounted `CommentCard`'s own resolve/reopen/etc. reaches the
// ABOUTME: same `threads` state the header's `[Address all… ▾]` trigger reads and every sibling
// ABOUTME: `CommentCard` reads — in the same render pass, with no owner re-render required — and
// ABOUTME: that mutation is reported up through `onCommentThreadsChange` (the single-owner pair).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { thread } from "../comments/threadFixture";
import type { CommentThread } from "../comments/types";
import { createCommentCard } from "./types";
import { sizeContainer } from "./virtualListTestUtils";

const resolveCommentMock = vi.fn();
const replyToCommentMock = vi.fn();
const reopenCommentMock = vi.fn();
const reAnchorCommentMock = vi.fn();
const addressWithAIMock = vi.fn();
const decideLinkedChangesMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  reopenComment: (...args: unknown[]) => reopenCommentMock(...args),
  reAnchorComment: (...args: unknown[]) => reAnchorCommentMock(...args),
  addressWithAI: (...args: unknown[]) => addressWithAIMock(...args),
  decideLinkedChanges: (...args: unknown[]) => decideLinkedChangesMock(...args),
}));

const { TimelinePanel } = await import("./TimelinePanel");

describe("timeline/TimelinePanel — single owner for comment-thread state (#411)", () => {
  beforeEach(() => {
    resolveCommentMock.mockReset();
    replyToCommentMock.mockReset();
    reopenCommentMock.mockReset();
    reAnchorCommentMock.mockReset();
    addressWithAIMock.mockReset();
    decideLinkedChangesMock.mockReset();
  });

  // The named defect (#350 round-3 review): `CommentCard` used to seed `useState(card.thread)`
  // once and mutate only its own copy, so the header's `[Address all… ▾]` (">1 open comment")
  // kept counting a thread the user had just resolved from its own card.
  it("resolving a thread from its mounted CommentCard updates the header's open-comment count in the same render — no owner re-render needed", async () => {
    const threads: CommentThread[] = [thread("a"), thread("b")];
    const cards = threads.map((t) => createCommentCard("/project", "doc.md", t, { id: `card-${t.id}` }));
    resolveCommentMock.mockResolvedValueOnce([{ ...threads[0], resolved: true }, threads[1]]);

    render(<TimelinePanel initialCards={cards} commentThreads={threads} commentPath="doc.md" root="/project" />);

    expect(screen.getByRole("button", { name: /Address all/ })).toBeTruthy();

    const cardA = document.querySelector('[data-card-id="a"]') as HTMLElement;
    fireEvent.click(within(cardA).getByRole("button", { name: "Resolve" }));

    await screen.findByText("Resolved");
    // Only one thread is still open — J4's ">1 open comment" condition for the trigger lapses,
    // exactly like a batch run's own transitions already did before this card (see the sibling
    // `TimelinePanel.batchAddress.test.tsx` suite) — now true for a *single*-thread mutation too.
    expect(screen.queryByRole("button", { name: /Address all/ })).toBeNull();
  });

  it("resolving a thread from its mounted CommentCard is reflected on a sibling CommentCard for the same thread — one shared state not a copy per card", async () => {
    const threads: CommentThread[] = [thread("a"), thread("b")];
    const cards = threads.map((t) => createCommentCard("/project", "doc.md", t, { id: `card-${t.id}` }));
    resolveCommentMock.mockResolvedValueOnce([{ ...threads[0], resolved: true }, threads[1]]);

    render(<TimelinePanel initialCards={cards} commentThreads={threads} commentPath="doc.md" root="/project" />);

    const cardA = document.querySelector('[data-card-id="a"]') as HTMLElement;
    fireEvent.click(within(cardA).getByRole("button", { name: "Resolve" }));

    await screen.findByText("Resolved");
    // The card for thread "b" never mutated, but shares the same underlying `threads` state; this
    // assertion would pass trivially either way (it never touched "a"'s own data), so the actual
    // proof is the header assertion above and the `onCommentThreadsChange` assertion below — this
    // one just pins that "b" is undisturbed.
    const cardB = document.querySelector('[data-card-id="b"]') as HTMLElement;
    expect(within(cardB).getByText("Open")).toBeTruthy();
  });

  it("reports the resolved thread list up through onCommentThreadsChange — the single owner's write path", async () => {
    const threads: CommentThread[] = [thread("a"), thread("b")];
    const cards = threads.map((t) => createCommentCard("/project", "doc.md", t, { id: `card-${t.id}` }));
    const resolved: CommentThread[] = [{ ...threads[0], resolved: true }, threads[1]];
    resolveCommentMock.mockResolvedValueOnce(resolved);
    const onCommentThreadsChange = vi.fn();

    render(
      <TimelinePanel
        initialCards={cards}
        commentThreads={threads}
        commentPath="doc.md"
        root="/project"
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );

    const cardA = document.querySelector('[data-card-id="a"]') as HTMLElement;
    fireEvent.click(within(cardA).getByRole("button", { name: "Resolve" }));

    await screen.findByText("Resolved");
    expect(onCommentThreadsChange).toHaveBeenCalledWith(resolved);
  });

  // The `useState(card.thread)`-seeds-once trap (#411's own framing): a later `commentThreads` prop
  // change from the owner must still reach every already-mounted card, not just a freshly mounted
  // one — pinned directly against a rerender rather than a card's own mutation.
  it("a later commentThreads prop change reaches an already-mounted CommentCard's rendered state", () => {
    const original = thread("a", { resolved: false });
    const card = createCommentCard("/project", "doc.md", original, { id: "card-a" });

    const { rerender } = render(
      <TimelinePanel initialCards={[card]} commentThreads={[original]} commentPath="doc.md" root="/project" />,
    );
    expect(screen.getByText("Open")).toBeTruthy();

    const resolved = { ...original, resolved: true };
    rerender(
      <TimelinePanel initialCards={[card]} commentThreads={[resolved]} commentPath="doc.md" root="/project" />,
    );

    expect(screen.getByText("Resolved")).toBeTruthy();
  });

  // Round-2 review finding 2 (PR #1329): every mounted comment card used to get the shared
  // `threads`/`onCommentThreadsChange` write path regardless of its own `card.path`, so a card left
  // over from a document that is no longer active stayed wired into the *current* document's owner
  // pair. Acting on it (Resolve/Reply/etc.) still calls the backend against the stale card's own
  // `root`/`path` (correct — this is document A's own thread), but the response used to flow back
  // through `onCommentThreadsChange` into the *active* document's shared state, corrupting the
  // header's open-comment count and the live editor's comment set for document B with document A's
  // data — the exact pairing #498 round 1 fixed, reachable again by this new route.
  it("does not wire the shared write path to a comment card whose document is no longer active (#1120 round 2, finding 2)", async () => {
    const original = thread("a");
    const cardA = createCommentCard("/project", "a.md", original, { id: "card-a" });
    resolveCommentMock.mockResolvedValueOnce([{ ...original, resolved: true }]);
    const onCommentThreadsChange = vi.fn();

    const { rerender } = render(
      <TimelinePanel
        initialCards={[cardA]}
        commentThreads={[original]}
        commentPath="a.md"
        root="/project"
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );

    // The active document switches to b.md — the owner clears `commentThreads` to `[]` (App.tsx's
    // own #498 round-1 clearing effect) before b.md's own threads have loaded. Document A's card
    // (never pruned from `cards` — a documented, separate Minor) is still mounted.
    rerender(
      <TimelinePanel
        initialCards={[cardA]}
        commentThreads={[]}
        commentPath="b.md"
        root="/project"
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );

    const cardEl = document.querySelector('[data-card-id="a"]') as HTMLElement;
    fireEvent.click(within(cardEl).getByRole("button", { name: "Resolve" }));

    await screen.findByText("Resolved");
    // The backend call still targets document A's own root/path — this is a legitimate mutation of
    // A's own thread, just no longer through the shared pair.
    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "a.md", "a", "you", expect.anything());
    // It must never reach the active document's (b.md's) shared write path.
    expect(onCommentThreadsChange).not.toHaveBeenCalled();
  });

  // Round-3 review finding (PR #1329): keeping the *active* document's owner pair off a non-active
  // card is right, but the first shape of that gate handed such a card no owner at all, so its own
  // mutation landed in `CommentCard`'s component-local `useState` copy and nothing in the panel
  // recorded it. This stream is virtualized — a row outside the window is genuinely unmounted
  // (`VirtualList` renders `items.slice(startIndex, endIndex)`) — so scrolling the card away and
  // back reseeded it from the panel's untouched `cards[].thread` snapshot and rendered a resolved
  // thread as "Open", with a live `[Resolve]`/`[Address with AI]` on it: a confidently-wrong
  // position (P2/D17) on state that is already resolved on disk. A non-active card's state must be
  // panel-owned too — just folded into `cards` for *its own* document instead of broadcast to the
  // active document's owner.
  it("keeps a non-active document's card state across the remount virtualization causes (#1120 round 3)", async () => {
    const original = thread("a");
    // One card for the no-longer-active a.md ahead of enough filler rows that scrolling to the end
    // pushes it out of the window (the same 300px-container shape `TimelinePanel.collapse.test.tsx`
    // uses to prove a row genuinely unmounts).
    const cards = [
      createCommentCard("/project", "a.md", original, { id: "card-a" }),
      ...Array.from({ length: 60 }, (_, i) =>
        createCommentCard("/project", "a.md", thread(`filler-${i}`), { id: `card-filler-${i}` }),
      ),
    ];
    // The backend hands back a.md's *whole* thread list, which here includes one thread that was
    // never materialized into the stream — a non-active document's write refreshes what is already
    // there and must not mint the rest of that document's comments into the timeline.
    resolveCommentMock.mockResolvedValueOnce([{ ...original, resolved: true }, thread("unseen")]);
    const onCommentThreadsChange = vi.fn();

    // b.md is the active document; a.md's cards are still in the stream (`cards` is never pruned).
    const { container } = render(
      <TimelinePanel
        initialCards={cards}
        commentThreads={[]}
        commentPath="b.md"
        root="/project"
        onCommentThreadsChange={onCommentThreadsChange}
      />,
    );
    sizeContainer(container, 300);

    fireEvent.click(
      within(document.querySelector('[data-card-id="a"]') as HTMLElement).getByRole("button", { name: "Resolve" }),
    );
    await screen.findByText("Resolved");

    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    // Scrolled to the stream's end: the resolved card is far outside the window (unmounted), and a
    // card minted from the response's other thread would be rendering right here.
    fireEvent.scroll(list, { target: { scrollTop: 100_000 } });
    expect(document.querySelector('[data-card-id="a"]')).toBeNull();
    expect(document.querySelector('[data-card-id="unseen"]')).toBeNull();

    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    const remounted = within(document.querySelector('[data-card-id="a"]') as HTMLElement);
    expect(remounted.getByText("Resolved")).toBeTruthy();
    expect(remounted.queryByText("Open")).toBeNull();
    // Still never through the active document's shared write path (finding 2 stays fixed).
    expect(onCommentThreadsChange).not.toHaveBeenCalled();
  });
});
