// @vitest-environment jsdom
// ABOUTME: End-to-end proof of P2b-1b's timeline collapse rules through `TimelinePanel` itself: a
// ABOUTME: resolved thread / fully-decided change-set renders collapsed to a single line by
// ABOUTME: default, expand/collapse toggles in place, the six thread states keep their distinct
// ABOUTME: visual signals when expanded, and collapse composes with virtualization — a collapsed
// ABOUTME: card's shorter row height is what the windowing math actually uses (docs/test-matrix.md
// ABOUTME: NI-timeline-correctness).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { thread } from "../comments/threadFixture";
import { TimelinePanel } from "./TimelinePanel";
import type { TimelineCard } from "./types";
import { sizeContainer } from "./virtualListTestUtils";

const COLLAPSED_HEIGHT = 32;

function commentCard(id: string, overrides: Parameters<typeof thread>[1] = {}): TimelineCard {
  return {
    id,
    kind: "comment",
    root: "/project",
    path: "doc.md",
    timestamp: "2026-07-20T00:00:00.000Z",
    thread: thread(id, overrides),
  };
}

function completedRunCard(id: string): TimelineCard {
  return {
    id,
    kind: "agent-working",
    runId: id,
    phase: { phase: "completed", reply: null },
    activity: [{ verb: "Reading", detail: "sermon.md" }],
    elapsedSecs: 17,
    timestamp: "2026-08-31T00:00:00.000Z",
  };
}

/**
 * Whether card `id` is currently rendered in its collapsed single-line shell. This used to read the
 * row wrapper's inline pixel height, back when `VirtualList` clamped every row to the height the
 * panel computed for it; a row is now sized by what its card actually rendered (#1119), so the
 * collapsed/expanded distinction is asserted where it is still a fact about the DOM — the shell the
 * card renders. The pixel half of the composition (a collapsed card's shorter height is what the
 * windowing math offsets by) is asserted by the last test in this file, and by `collapse.test.ts`'s
 * own `itemHeightFor` unit tests.
 */
function isCollapsed(id: string): boolean {
  const card = document.querySelector(`[data-card-id="${id}"]`);
  if (!card) throw new Error(`card ${id} is not mounted`);
  return card.classList.contains("timeline-card--collapsed");
}

describe("timeline/TimelinePanel — collapse composition (P2b-1b, NI-timeline-correctness)", () => {
  it("a resolved thread renders collapsed to a single line by default; an open thread stays expanded", () => {
    render(
      <TimelinePanel
        initialCards={[commentCard("open", { resolved: false }), commentCard("resolved", { resolved: true })]}
      />,
    );

    expect(isCollapsed("open")).toBe(false);
    expect(isCollapsed("resolved")).toBe(true);
  });

  it("clicking the collapsed row expands it in place; clicking Collapse returns it — never persisted, purely view state", () => {
    render(<TimelinePanel initialCards={[commentCard("resolved", { resolved: true })]} />);

    expect(isCollapsed("resolved")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(isCollapsed("resolved")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(isCollapsed("resolved")).toBe(true);
  });

  it("a completed run uses the same panel-owned collapse and virtualization seam (#1725)", () => {
    render(<TimelinePanel initialCards={[completedRunCard("run-completed")]} />);

    expect(isCollapsed("run-completed")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(isCollapsed("run-completed")).toBe(false);
    expect(screen.getByText("Reading sermon.md")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(isCollapsed("run-completed")).toBe(true);
  });

  it("expanding a resolved thread still shows its full six-state rendering — collapse is a layer over it, not a replacement", () => {
    render(<TimelinePanel initialCards={[commentCard("resolved", { resolved: true })]} />);

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));

    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("a change-set card whose changes are all decided collapses; one still-pending change keeps it expanded", () => {
    const decided: TimelineCard = {
      id: "cs-decided",
      kind: "change-set",
      doc: "notes/outline.md",
      generation: null,
      changeSetId: "cs1",
      summary: "Tightened hook",
      timestamp: "2026-07-20T00:00:00.000Z",
      changes: [{ id: "1", kind: "insertion", section: "§1", newText: "We" }],
    };
    const pending: TimelineCard = {
      id: "cs-pending",
      kind: "change-set",
      doc: "notes/outline.md",
      generation: null,
      changeSetId: "cs2",
      summary: "Fixed a word choice",
      timestamp: "2026-07-20T00:00:01.000Z",
      changes: [
        { id: "2", kind: "insertion", section: "§1", newText: "one" },
        { id: "3", kind: "deletion", section: "§2", oldText: "two" },
      ],
    };
    render(<TimelinePanel initialCards={[decided, pending]} />);

    // Both start expanded (nothing decided yet).
    expect(isCollapsed("cs-decided")).toBe(false);
    expect(isCollapsed("cs-pending")).toBe(false);

    // Decide the single-change card fully — it collapses.
    fireEvent.click(within(document.querySelector('[data-card-id="cs-decided"]') as HTMLElement).getByRole("button", { name: "Accept all" }));
    expect(isCollapsed("cs-decided")).toBe(true);

    // Decide only one of the two-change card's changes — one still-pending change keeps it expanded.
    fireEvent.click(
      within(document.querySelector('[data-card-id="cs-pending"]') as HTMLElement).getAllByRole("button", {
        name: "Accept section",
      })[0],
    );
    expect(isCollapsed("cs-pending")).toBe(false);
  });

  it("an explicit expand survives a card leaving and re-entering the virtualized window — a pinned choice not lost on remount (review finding PR #481)", () => {
    // 1 resolved thread ahead of 60 open ones, in a short (300px) container — enough that scrolling
    // to the end unmounts row 0 (outside the visible band + overscan) and scrolling back remounts it
    // fresh, the exact scenario the review's scratch probe executed.
    const cards: TimelineCard[] = [
      commentCard("resolved", { resolved: true }),
      ...Array.from({ length: 60 }, (_, i) => commentCard(`open-${i}`, { resolved: false })),
    ];
    const { container } = render(<TimelinePanel initialCards={cards} />);
    sizeContainer(container, 300);

    expect(isCollapsed("resolved")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(isCollapsed("resolved")).toBe(false);

    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 3000 } });
    expect(document.querySelector('[data-card-id="resolved"]')).toBeNull(); // unmounted

    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    expect(isCollapsed("resolved")).toBe(false); // remounted still expanded, not snapped back
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("a card that merely scrolled out of and back into the window still follows its collapse-by-default rule — being observed expanded is not a user's choice (review finding PR #481)", () => {
    // The complement of the test above: there, the user clicked before the card unmounted, so the
    // recorded value *was* their choice. Here they never clicked. Seeding the card's override from
    // the panel's record of its merely-*effective* value would pin "expanded" behind their back and
    // the collapse-by-default rule would never fire again — this card's headline criterion, lost
    // after one scroll cycle.
    const changeSet: TimelineCard = {
      id: "cs",
      kind: "change-set",
      doc: "notes/outline.md",
      generation: null,
      changeSetId: "cs1",
      summary: "Tightened hook",
      timestamp: "2026-07-20T00:00:00.000Z",
      changes: [{ id: "1", kind: "insertion", section: "§1", newText: "We" }],
    };
    const cards: TimelineCard[] = [
      changeSet,
      ...Array.from({ length: 60 }, (_, i) => commentCard(`open-${i}`, { resolved: false })),
    ];
    const { container } = render(<TimelinePanel initialCards={cards} />);
    sizeContainer(container, 300);

    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 3000 } });
    expect(document.querySelector('[data-card-id="cs"]')).toBeNull(); // unmounted, never clicked
    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    expect(isCollapsed("cs")).toBe(false); // back, still expanded (nothing decided yet)

    // Deciding the last pending change must still collapse it — the default rule, not a stale pin.
    fireEvent.click(
      within(document.querySelector('[data-card-id="cs"]') as HTMLElement).getByRole("button", {
        name: "Accept all",
      }),
    );
    expect(isCollapsed("cs")).toBe(true);
  });

  it("collapse composes with virtualization: a collapsed card's own (shorter) height is what the windowing math sizes it by, not a uniform assumption", () => {
    // 50 resolved (collapsed, 32px) threads ahead of 20 open (expanded, 96px) ones. A uniform
    // 96px assumption would place row 50's top offset at 50*96=4800; its real offset is 50*32=1600.
    const cards: TimelineCard[] = [
      ...Array.from({ length: 50 }, (_, i) => commentCard(`resolved-${i}`, { resolved: true })),
      ...Array.from({ length: 20 }, (_, i) => commentCard(`open-${i}`, { resolved: false })),
    ];
    const { container } = render(<TimelinePanel initialCards={cards} />);
    sizeContainer(container, 300);

    // Scroll exactly past every collapsed row — the first expanded card should now be at/near the
    // top of the mounted window, proving the windowing math used each row's own height.
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 50 * COLLAPSED_HEIGHT } });

    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-card-id="open-0"]')).toBeTruthy();
  });
});
