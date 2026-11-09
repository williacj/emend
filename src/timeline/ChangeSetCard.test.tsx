// @vitest-environment jsdom
// ABOUTME: Component proof of the P2a-14 acceptance: summary/count header, per-section groups, and
// ABOUTME: the three triage entry points (1-by-1 / accept-all / per-section) each producing the
// ABOUTME: correct decision set — plus that this card claims no *document-level* triage shortcuts
// ABOUTME: (P2a-5 owns those); its only key handling is Escape dismissing an open overflow menu.
// ABOUTME: Also covers P2b-3b's grouped-by-comment batch variant (J4) of the same card.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangeSetCard } from "./ChangeSetCard";
import {
  createChangeSetCard,
  type ChangeSetChange,
  type ChangeSetCommentGroup,
  type ChangeSetDefense,
} from "./types";

const CHANGES: ChangeSetChange[] = [
  { id: "1", kind: "insertion", section: "§1 Opening", newText: "We", note: "tightened the hook" },
  { id: "2", kind: "deletion", section: "§1 Opening", oldText: "For most of us," },
  { id: "3", kind: "substitution", section: "§2 Body", oldText: "utilize", newText: "use" },
];

function card(changes: ChangeSetChange[] = CHANGES) {
  return createChangeSetCard("cs1", "Tightened hook; fixed a word choice.", changes, { id: "cs-1" });
}

describe("timeline/ChangeSetCard", () => {
  it("renders the summary and total change/section counts and per-section groups with their own counts", () => {
    render(<ChangeSetCard card={card()} />);

    expect(screen.getByText("Tightened hook; fixed a word choice.")).toBeTruthy();
    expect(screen.getByText("3 changes · 2 sections")).toBeTruthy();
    expect(screen.getByText("§1 Opening").textContent).toBe("§1 Opening (2)");
    expect(screen.getByText("§2 Body").textContent).toBe("§2 Body (1)");
  });

  it("accept-all decides every pending change in the set as one atomic call", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "accept");
    // Every change is now decided — P2b-1b collapses the whole card to a single line by default;
    // expand it to see the card's own pending counts (an empty set) and entry points disabling
    // rather than staying clickable against nothing.
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review 1-by-1" })).toBeDisabled();
  });

  it("reject-all decides every pending change in the set as one atomic call", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "reject");
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ })); // fully decided — collapsed by default (P2b-1b)
    expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
  });

  it("per-section accept scopes the decision to only that section's changes", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept section" })[0]);

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2"], "accept");
    // Only §2 Body is left pending.
    expect(screen.getByText("1 change · 1 section")).toBeTruthy();
    expect(screen.queryByText(/§1 Opening/)).toBeNull();
    expect(screen.getByText("§2 Body")).toBeTruthy();
  });

  it("per-section reject scopes the decision to only that section's changes", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reject section" })[1]);

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["3"], "reject");
    expect(screen.getByText("2 changes · 1 section")).toBeTruthy();
  });

  it("the overflow menu's Accept all insertions decides only the insertion as one atomic call (P2b-2 J1-Q1)", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1"], "accept");
    // The deletion and substitution are still pending.
    expect(screen.getByText("2 changes · 2 sections")).toBeTruthy();
  });

  it("the overflow menu's Reject all deletions decides only the deletion", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Reject all deletions" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["2"], "reject");
  });

  it("a type filter never touches a substitution: no matching change disables that option", () => {
    // Only a substitution pending — neither the insertion nor the deletion filter has anything to
    // act on (the card's explicit choice, mirroring `editor/trackedChanges.ts`'s `ChangeTypeFilter`).
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card([CHANGES[2]])} onDecide={onDecide} />);

    expect(screen.getByRole("button", { name: "Accept all insertions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject all insertions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept all deletions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject all deletions" })).toBeDisabled();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("retires a group co-member the caller sweeps in and reports back — not just the ids passed", () => {
    // Simulates the live-editor caller: a type filter passes only id 1 (the insertion), but its
    // `decisionsTransaction` sweeps id 2 (a linked deletion, P4b) into the same decision and
    // reports the full [1, 2] back — the card's own pending bookkeeping must retire both, not just
    // the id it originally passed, or its counts lie (Important #2).
    const onDecide = vi.fn((ids: string[]) => [...ids, "2"]);
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));

    expect(onDecide).toHaveBeenCalledWith(["1"], "accept");
    // Only the substitution (id 3, §2 Body) is left pending — not "2 changes · 2 sections".
    expect(screen.getByText("1 change · 1 section")).toBeTruthy();
    expect(screen.queryByText(/§1 Opening/)).toBeNull();
  });

  it("does not replay a historical reversal when a re-decided card remounts", () => {
    const oneChangeCard = card([CHANGES[0]]);
    const reversedIds = ["1"];
    const redecidedIds = new Set(["1"]);
    const onDecide = vi.fn((ids: string[]) => ids);
    const view = render(<ChangeSetCard card={oneChangeCard} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    view.rerender(
      <ChangeSetCard
        card={oneChangeCard}
        onDecide={onDecide}
        externallyReversedIds={reversedIds}
      />,
    );
    expect(screen.getByText("1 change · 1 section")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    view.rerender(
      <ChangeSetCard
        card={oneChangeCard}
        onDecide={onDecide}
        externallyDecidedIds={redecidedIds}
        externallyReversedIds={reversedIds}
      />,
    );
    view.unmount();

    render(
      <ChangeSetCard
        card={oneChangeCard}
        onDecide={onDecide}
        externallyDecidedIds={redecidedIds}
        externallyReversedIds={reversedIds}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
  });

  it("every type-filtered option disables once the set has no pending changes", () => {
    render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ })); // fully decided — collapsed by default (P2b-1b)

    for (const label of [
      "Accept all insertions",
      "Reject all insertions",
      "Accept all deletions",
      "Reject all deletions",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  // The `⋯` menu is a pick-one surface; native `<details>` dismisses on none of these three by
  // itself, so each is the component's own behavior (the toolbar twin,
  // `editor/TrackChangesBulkMenu.tsx`, carries the identical set).
  describe("overflow menu dismissal", () => {
    function openOverflow() {
      const menu = document.querySelector("details.change-set-card__overflow") as HTMLDetailsElement;
      // jsdom doesn't implement summary activation, so drive the `toggle` event React listens for.
      menu.open = true;
      fireEvent(menu, new Event("toggle"));
      return menu;
    }

    it("the overflow menu closes when an option is picked", () => {
      render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);
      const menu = openOverflow();
      expect(menu.open).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));
      expect(menu.open).toBe(false);
    });

    it("the overflow menu closes on Escape", () => {
      render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);
      const menu = openOverflow();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(menu.open).toBe(false);
    });

    it("the overflow menu closes on a click outside it but not on a click inside", () => {
      render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);
      const menu = openOverflow();
      fireEvent.mouseDown(menu);
      expect(menu.open).toBe(true);
      fireEvent.mouseDown(document.body);
      expect(menu.open).toBe(false);
    });
  });

  it("Review 1-by-1 focuses the first pending change and shows its old→new + note and reports progress", () => {
    const onFocusChange = vi.fn();
    render(<ChangeSetCard card={card()} onFocusChange={onFocusChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));

    expect(onFocusChange).toHaveBeenCalledWith("1");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Added text").textContent).toBe("We");
    expect(screen.getByText("tightened the hook")).toBeTruthy();
  });

  it("Accept & next advances the pass and decides the current change and moves progress/focus forward", () => {
    const onDecide = vi.fn();
    const onFocusChange = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} onFocusChange={onFocusChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));

    expect(onDecide).toHaveBeenCalledWith(["1"], "accept");
    expect(onFocusChange).toHaveBeenCalledWith("2");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Removed text").textContent).toBe("For most of us,");
  });

  it("an explicitly refused 1-by-1 decision does not advance to the next change", () => {
    const onDecide = vi.fn(() => []);
    const onFocusChange = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} onFocusChange={onFocusChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));

    expect(onDecide).toHaveBeenCalledWith(["1"], "accept");
    expect(onFocusChange).toHaveBeenCalledTimes(1);
    expect(onFocusChange).toHaveBeenCalledWith("1");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Added text").textContent).toBe("We");
  });

  it("an explicitly refused final 1-by-1 decision does not close the pass", () => {
    const onDecide = vi.fn(() => []);
    render(<ChangeSetCard card={card([CHANGES[0]])} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));

    expect(onDecide).toHaveBeenCalledWith(["1"], "accept");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
  });

  it("the pass ends (popover closes) once every change has been decided one by one", () => {
    render(<ChangeSetCard card={card([CHANGES[0], CHANGES[1]])} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "✗ Reject" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    // Fully decided — collapsed to a single line by default (P2b-1b); expand to see the counts.
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
  });

  it("exiting mid-pass (Escape) leaves undecided changes pending and decided ones stand", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" })); // decides change 1, advances to 2
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); // exits before deciding 2 or 3

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDecide).toHaveBeenCalledTimes(1);
    // Changes 2 and 3 are still pending — partial triage stands (J1).
    expect(screen.getByText("2 changes · 2 sections")).toBeTruthy();
  });

  it("claims no document-level triage shortcuts — P2a-5 alone owns them", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    // No pass open, no popover mounted: a triage-shaped keystroke on the document must be a no-op
    // for this component (it isn't listening for one), not a duplicate accept/reject path.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    fireEvent.keyDown(document.body, { key: "Backspace", metaKey: true });

    expect(onDecide).not.toHaveBeenCalled();
  });

  describe("externallyDecidedIds — reconciling a decision taken outside this card (#410)", () => {
    it("retires an id decided elsewhere (e.g. directly in the live editor) even though this card's own onDecide was never called", () => {
      const onDecide = vi.fn();
      const { rerender } = render(
        <ChangeSetCard card={card()} onDecide={onDecide} externallyDecidedIds={new Set()} />,
      );
      expect(screen.getByText("3 changes · 2 sections")).toBeTruthy();

      // The editor decided id 2 on its own (a keyboard/toolbar accept, never this card's button) —
      // the caller reports it back via this prop, not via `onDecide`.
      rerender(
        <ChangeSetCard card={card()} onDecide={onDecide} externallyDecidedIds={new Set(["2"])} />,
      );

      expect(onDecide).not.toHaveBeenCalled();
      expect(screen.getByText("2 changes · 2 sections")).toBeTruthy();
      expect(screen.queryByText("§1 Opening (2)")).toBeNull();
      expect(screen.getByText("§1 Opening").textContent).toBe("§1 Opening (1)");
    });

    it("is superset-only: a prop update that drops a previously-reported id never un-decides it", () => {
      const { rerender } = render(
        <ChangeSetCard card={card()} externallyDecidedIds={new Set(["1", "2"])} />,
      );
      expect(screen.getByText("1 change · 1 section")).toBeTruthy();

      rerender(<ChangeSetCard card={card()} externallyDecidedIds={new Set()} />);

      expect(screen.getByText("1 change · 1 section")).toBeTruthy();
    });

    it("is a no-op when omitted — matching every existing caller with no editor seam to report through", () => {
      render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);
      expect(screen.getByText("3 changes · 2 sections")).toBeTruthy();
    });
  });
});

// P2b-1b: fully-decided collapse — the boundary is "every change decided", not "any decision".
describe("timeline/ChangeSetCard — collapse-by-default (P2b-1b)", () => {
  it("a freshly delivered card (nothing decided) never renders a collapse control and stays expanded", () => {
    render(<ChangeSetCard card={card()} />);
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
    expect(screen.getByText("3 changes · 2 sections")).toBeTruthy();
  });

  it("one still-pending change keeps the card expanded — the boundary is fully decided, not any decision", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept section" })[0]); // decides 2 of 3

    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.getByText("1 change · 1 section")).toBeTruthy();
  });

  it("collapses to a single line once every change is decided, and expand/collapse toggles in place", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    // Collapsed: the summary still shows, but the footer's entry points do not render at all.
    expect(screen.getByText("Tightened hook; fixed a word choice.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(screen.getByText("0 changes · 0 sections")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
  });

  it("reports its own collapsed state to the caller — the seam collapse composes with virtualization through (P2b-1b)", () => {
    const onCollapsedChange = vi.fn();
    render(<ChangeSetCard card={card()} onDecide={vi.fn()} onCollapsedChange={onCollapsedChange} />);
    // Second argument: whether that value is the user's *explicit* choice or merely what the
    // data-driven default produces. Deciding every change collapses the card by *rule*, not by
    // choice — so it reports `explicit: false` and stays eligible to follow the rule again after a
    // remount (review finding PR #481).
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false, false);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true, false);

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false, true);
  });

  it("initialCollapsed seeds the collapse override on mount — the round-trip fix for a card that unmounts and remounts (review finding PR #481)", () => {
    // A freshly-delivered card's own default is expanded; `initialCollapsed={true}` pins the
    // opposite — exactly what `TimelinePanel` passes back down from its `pinnedCollapsedIds` map after a
    // card the user explicitly collapsed scrolls out of the virtualized window and back in.
    render(<ChangeSetCard card={card()} initialCollapsed={true} />);
    expect(screen.getByRole("button", { name: /^Expand/ })).toBeTruthy();
    expect(screen.queryByText("3 changes · 2 sections")).toBeNull();
  });

  it("the collapsed row's accessible name includes the summary and status not just 'Expand' — an aria-label would erase them from assistive tech (review finding PR #481)", () => {
    render(<ChangeSetCard card={card()} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    const button = screen.getByRole("button", { name: /^Expand/ });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button).toHaveAccessibleName(/Tightened hook/);
    expect(button).toHaveAccessibleName(/3 changes decided/);
  });

  it("a batch (grouped-by-comment) card collapses the same way once every change is decided", () => {
    render(<ChangeSetCard card={batchCard()} onDecide={vi.fn()} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]); // decides t1's group only (2 of 3)
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]); // decides t2's group — 3 of 3
    expect(screen.getByRole("button", { name: /^Expand/ })).toBeTruthy();
  });
});

// P2b-3b: J4 batch — one change-set card grouped by comment rather than by section, with defenses
// (FR-CMT-4) listed distinctly so they aren't lost in the accept sweep. Same component, same
// triage machinery — only the grouping data (`commentGroups`/`defenses`) differs from P2a-14's
// section-grouped shape above.
const COMMENT_GROUPS: ChangeSetCommentGroup[] = [
  { commentId: "t1", label: "Eph 4:22 quote", severity: "H" },
  { commentId: "t2", label: "kenosis definition", severity: "M" },
];
const DEFENSES: ChangeSetDefense[] = [{ commentId: "t3", label: '"daily" wording' }];
const COMMENT_CHANGES: ChangeSetChange[] = [
  { id: "1", kind: "substitution", section: "§2 Body", commentId: "t1", oldText: "NKJV", newText: "ESV" },
  { id: "2", kind: "insertion", section: "§2 Body", commentId: "t1", newText: "(ESV)" },
  { id: "3", kind: "substitution", section: "§3 Application", commentId: "t2", oldText: "emptying", newText: "self-emptying" },
];

function batchCard(changes: ChangeSetChange[] = COMMENT_CHANGES) {
  return createChangeSetCard("cs-batch", "Addressed 3 comments.", changes, {
    id: "cs-batch-1",
    commentGroups: COMMENT_GROUPS,
    defenses: DEFENSES,
    replyCount: 5,
  });
}

describe("timeline/ChangeSetCard grouped by comment (J4 batch, P2b-3b)", () => {
  it("renders J4's header counts (comments addressed / changes / replies / defenses) and one group per comment with its severity chip and change count", () => {
    render(<ChangeSetCard card={batchCard()} />);

    expect(screen.getByText("ADDRESSED 3 COMMENTS · Agent")).toBeTruthy();
    expect(screen.getByText("3 changes · 5 replies · 1 defense")).toBeTruthy();
    expect(screen.getByText("Eph 4:22 quote (2)")).toBeTruthy();
    expect(screen.getByText("kenosis definition (1)")).toBeTruthy();
    // Accessibility rule (ux-design.md §2): severity is never colour alone — colour + letter chip.
    const highChip = screen.getByLabelText("severity: H");
    expect(highChip.textContent).toContain("H");
    expect(screen.getByLabelText("severity: M").textContent).toContain("M");
  });

  it("lists a defense distinctly (⚑) and excludes it from Accept all — the defended thread's group carries no accept/reject controls", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={batchCard()} onDecide={onDecide} />);

    expect(screen.getByText('defended: "daily" wording')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    // Every change decided, but the defense is never an id Accept all could have covered.
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "accept");
    // Fully decided — collapsed to a single line by default (P2b-1b); expand to see the rest.
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    // The defended thread stays listed and undecided — Accept all cannot touch it, by construction.
    expect(screen.getByText('defended: "daily" wording')).toBeTruthy();
  });

  it("deciding one comment's group scopes the decision to only that comment's changes — not the whole batch", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={batchCard()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2"], "accept");
    // The other comment's group and the defense are untouched.
    expect(screen.queryByText("Eph 4:22 quote (2)")).toBeNull();
    expect(screen.getByText("kenosis definition (1)")).toBeTruthy();
    expect(screen.getByText('defended: "daily" wording')).toBeTruthy();
  });

  it("rejecting one comment's group scopes the decision to only that comment's changes", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={batchCard()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]);

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["3"], "reject");
    expect(screen.getByText("Eph 4:22 quote (2)")).toBeTruthy();
    expect(screen.queryByText(/kenosis definition/)).toBeNull();
  });

  it("Review 1-by-1 drives the identical RedlinePopover/changeSetReview machine over a grouped-by-comment card", () => {
    const onFocusChange = vi.fn();
    render(<ChangeSetCard card={batchCard()} onFocusChange={onFocusChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));

    expect(onFocusChange).toHaveBeenCalledWith("1");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Added text").textContent).toBe("ESV");
  });

  it("a change whose commentId names no declared group is never swept by Accept all/Reject all — but is still reachable via Review 1-by-1", () => {
    const onDecide = vi.fn();
    const orphan: ChangeSetChange = {
      id: "4",
      kind: "insertion",
      section: "§4 Closing",
      commentId: "t-unknown",
      newText: "Amen.",
    };
    render(<ChangeSetCard card={batchCard([...COMMENT_CHANGES, orphan])} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    // Only the changes actually listed under a `▸` group are swept — the orphaned change 4 is
    // left pending, matching that it was never rendered under any group to sweep from.
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "accept");

    // It's still reachable: Review 1-by-1 walks every pending change regardless of grouping.
    fireEvent.click(screen.getByRole("button", { name: "Review 1-by-1" }));
    expect(screen.getByLabelText("Added text").textContent).toBe("Amen.");
  });

  it("a type-filtered bulk op (P2b-2) honors the same ungrouped-change exclusion as Accept all", () => {
    // The type filter narrows the *sweep* set, not `pending` — so the orphaned insertion stays out
    // of every bulk op, not merely the untyped ones. A bulk op the user can't see acting on a
    // change must not decide it (P2b-3b's rule, applied to P2b-2's entry points).
    const onDecide = vi.fn();
    const orphan: ChangeSetChange = {
      id: "4",
      kind: "insertion",
      section: "§4 Closing",
      commentId: "t-unknown",
      newText: "Amen.",
    };
    render(<ChangeSetCard card={batchCard([...COMMENT_CHANGES, orphan])} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all insertions" }));

    // Change 2 is the only insertion listed under a declared group; the orphan (also an insertion)
    // is excluded.
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(["2"], "accept");
  });

  it("the header/counts line stays fixed at the delivery total after a group is decided — unlike a section-grouped card's pending-tracking counts", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={batchCard()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);

    expect(onDecide).toHaveBeenCalledTimes(1);
    // Both the header total and the counts line are unchanged by deciding one group.
    expect(screen.getByText("ADDRESSED 3 COMMENTS · Agent")).toBeTruthy();
    expect(screen.getByText("3 changes · 5 replies · 1 defense")).toBeTruthy();
  });

  it("a group with no severity renders its label and count with no chip at all", () => {
    const noSeverityGroups: ChangeSetCommentGroup[] = [{ commentId: "t9", label: "typo fix" }];
    const noSeverityChanges: ChangeSetChange[] = [
      { id: "9", kind: "substitution", section: "§1 Opening", commentId: "t9", oldText: "teh", newText: "the" },
    ];
    const card = createChangeSetCard("cs-no-sev", "Fixed a typo.", noSeverityChanges, {
      id: "cs-no-sev-1",
      commentGroups: noSeverityGroups,
    });

    render(<ChangeSetCard card={card} />);

    expect(screen.getByText("typo fix (1)")).toBeTruthy();
    expect(screen.queryByLabelText(/severity:/)).toBeNull();
  });

  // Review finding (#537): `commentGroupsOf` used to drop every group with no *pending* changes,
  // which — since a batch-address card's groups never carry a change today (P2a-15 unwired) —
  // meant the card rendered zero comment groups despite naming which comments the run addressed.
  it("a change-less group (no change tied back to this comment yet — J4 Batch before P2a-15) stays listed with a (0) count and no Accept/Reject controls", () => {
    const groups: ChangeSetCommentGroup[] = [
      { commentId: "t1", label: "brave", severity: "H" },
      { commentId: "t2", label: "cheerful" },
    ];
    const emptyCard = createChangeSetCard("cs-batch-empty", "Addressed 2 comments.", [], {
      id: "cs-batch-empty-1",
      commentGroups: groups,
      defenses: [],
      replyCount: 0,
    });

    render(<ChangeSetCard card={emptyCard} />);

    expect(screen.getByText("ADDRESSED 2 COMMENTS · Agent")).toBeTruthy();
    expect(screen.getByText("brave (0)")).toBeTruthy();
    expect(screen.getByText("cheerful (0)")).toBeTruthy();
    expect(screen.getByLabelText("severity: H")).toBeTruthy();
    // Nothing to sweep — no Accept/Reject anywhere on this card, not even disabled ones.
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("a group that had changes and has since had every one decided still disappears — only a group that never had one stays", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={batchCard()} onDecide={onDecide} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]); // t1's group: 2 of 3
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]); // t2's group — 3 of 3, now fully decided
    // Fully decided — collapsed to a single line by default (P2b-1b); expand to see the group list.
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));

    // Both groups had real changes and are now fully decided — gone, not lingering at (0).
    expect(screen.queryByText(/Eph 4:22 quote/)).toBeNull();
    expect(screen.queryByText(/kenosis definition/)).toBeNull();
  });

  it("suppresses the mismatch banner on a change-less card — 'open it to review them' has nothing to point at (review finding #537)", () => {
    const emptyCard = createChangeSetCard("cs-batch-empty", "Addressed 1 comment.", [], {
      id: "cs-batch-empty-2",
      commentGroups: [{ commentId: "t1", label: "brave" }],
    });

    render(
      <ChangeSetCard card={emptyCard} triageTarget={{ doc: "notes/outline.md", generation: "rev-2" }} />,
    );

    // The card's own `doc`/`generation` fail closed to `""`/`null` (J4 Batch, no live parse yet), so
    // this mismatches every triageTarget — but with no changes to review, the banner must stay gone.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/open it to review/)).toBeNull();
  });
});

// UXR-Q4 (ux-design §5 + J1 Phase B/C): a change-set card's ids are ordinals from one parse.
// `triageTarget` tells the card which document/parse the live tracked-change field currently holds;
// the card must fail its own triage closed — disabled controls, naming its document, and never a
// call to `onDecide` — whenever its own `doc`/`generation` don't both match. These prove the card
// half of the three reachable mismatch paths the round-4 review named (the App wiring proving they
// are *reachable* through the real editor lives in `App.test.tsx`).
describe("timeline/ChangeSetCard — triage fails closed on a document/parse mismatch (UXR-Q4)", () => {
  /** A section-grouped card carrying its delivered document and parse generation. */
  function gatedCard(doc = "notes/outline.md", generation: string | null = "rev-2") {
    return createChangeSetCard("cs1", "Tightened the opening.", CHANGES, { id: "cs-1", doc, generation });
  }

  it("with no triageTarget prop the card is ungated — it decides exactly as before (legacy callers/tests)", () => {
    const onDecide = vi.fn();
    render(<ChangeSetCard card={gatedCard()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "accept");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a matching document AND generation leaves the card enabled and decides normally", () => {
    const onDecide = vi.fn();
    render(
      <ChangeSetCard
        card={gatedCard("notes/outline.md", "rev-2")}
        onDecide={onDecide}
        triageTarget={{ doc: "notes/outline.md", generation: "rev-2" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Accept all" })).not.toBeDisabled();
    expect(screen.queryByText(/open it to review/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(onDecide).toHaveBeenCalledWith(["1", "2", "3"], "accept");
  });

  it("path 1 — a card whose document is not the active tab's is disabled and names its document", () => {
    const onDecide = vi.fn();
    render(
      <ChangeSetCard
        card={gatedCard("notes/outline.md", "rev-2")}
        onDecide={onDecide}
        // A different document is active — its parse generation is irrelevant; the document alone
        // is a mismatch (a card's ids only mean anything against its own document's field).
        triageTarget={{ doc: "notes/other.md", generation: "rev-2" }}
      />,
    );

    // A *different* document: "open it" is the action that resolves this one, and it stays.
    expect(screen.getByText(/These changes apply to notes\/outline\.md — open it to review them/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review 1-by-1" })).toBeDisabled();

    // Even forced, the disabled control decides nothing — no wrong-document decide reaches the seam.
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("a mismatched card suppresses a reach note it cannot verify (UXR-Q5)", () => {
    render(
      <ChangeSetCard
        card={gatedCard("notes/outline.md", "rev-2")}
        externallyDecidedIds={new Set(["1"])}
        reachedChangeCount={2}
        decidedElsewhereCount={2}
        triageTarget={{ doc: "notes/other.md", generation: "rev-2" }}
      />,
    );

    expect(screen.getByText("3 changes · 2 sections")).toBeTruthy();
    expect(screen.queryByText(/linked changes outside this set/)).toBeNull();
    expect(screen.queryByText(/changes decided elsewhere/)).toBeNull();
  });

  it("path 2 — with no active tab at all (null target) the card is disabled and names its document", () => {
    const onDecide = vi.fn();
    render(
      <ChangeSetCard card={gatedCard("notes/other.md", "rev-x")} onDecide={onDecide} triageTarget={null} />,
    );

    expect(screen.getByText(/These changes apply to notes\/other\.md/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("path 3 — same document but a stale parse generation (a suppressed dirty-tab delivery) fails closed", () => {
    const onDecide = vi.fn();
    render(
      <ChangeSetCard
        card={gatedCard("notes/outline.md", "rev-2")}
        onDecide={onDecide}
        // Same document, but the live field never took this delivery (UXR-Q3 dirty suppression), so
        // its generation is the pre-delivery one — a mismatch inside one document.
        triageTarget={{ doc: "notes/outline.md", generation: "rev-1" }}
      />,
    );

    // The copy must name the action that can actually resolve *this* state. The document is already
    // open and on screen, so "open it" instructs the impossible (#346 round-5 review); the delivery
    // is on disk, and the FR-ED-7 banner's Reload is what takes it.
    expect(screen.getByText(/reload the file to review them/)).toBeInTheDocument();
    expect(screen.queryByText(/open it to review them/)).toBeNull();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeDisabled();

    // Per-section is gated too — no entry point can slip through.
    fireEvent.click(screen.getByText("§1 Opening"));
    const acceptSection = screen.getAllByRole("button", { name: "Accept section" });
    expect(acceptSection.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    acceptSection.forEach((button) => fireEvent.click(button));
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("timeline/ChangeSetCard — decision reach accounting (UXR-Q5)", () => {
  it("renders a plural reach outcome as a status line", () => {
    render(
      <ChangeSetCard
        card={createChangeSetCard("cs1", "Tightened the opening.", CHANGES)}
        reachedChangeCount={2}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "↳ also decided 2 linked changes outside this set",
    );
  });

  it("renders decided-elsewhere provenance as a persistent non-interactive status line", () => {
    render(
      <ChangeSetCard
        card={createChangeSetCard("cs1", "Tightened the opening.", CHANGES)}
        decidedElsewhereCount={2}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("↳ 2 changes decided elsewhere");
    expect(status.closest(".timeline-card__body")).not.toBeNull();
    expect(status.closest("a, button")).toBeNull();
  });
});
