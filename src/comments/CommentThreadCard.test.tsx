// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a-18/P2a-19/UXR-Q10 acceptance criteria: state-driven
// ABOUTME: rendering for each of the seven ux-design.md §2 thread states, reply/resolve/reopen, the
// ABOUTME: orphan card's [Re-anchor] flow, and address-with-AI's working/pending/accept/reject/
// ABOUTME: re-delegate/defense flow.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentThreadCard } from "./CommentThreadCard";
import type { CommentThread, ThreadState } from "./types";
import { linkedChange, thread as baseThread } from "./threadFixture";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return baseThread("c1", { body: "please clarify this passage", ...overrides });
}

/** The shipped rule body for a single-class element, so a layout contract jsdom cannot observe
    (it applies no stylesheet) can still be pinned against the real `src/styles.css`. */
function shippedRuleFor(element: Element): string {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
  const rule = new RegExp(`\\.${element.className.trim()}\\s*\\{([^}]*)\\}`).exec(css);
  return rule ? rule[1] : "";
}

const noop = {
  onReply: vi.fn(),
  onResolve: vi.fn(),
  onReopen: vi.fn(),
};

describe("4e collapsed run link", () => {
  it("keeps the passage route separate and shows one run link with the sent-text cue", () => {
    const onShowRun = vi.fn();
    const onFocusAnchor = vi.fn();
    const anchor = { offset: 4, length: 5, text_snapshot: "Hello", context_before: "", context_after: "", base_revision: "r1" };
    render(<CommentThreadCard thread={thread({ anchor })} {...noop} onFocusAnchor={onFocusAnchor}
      runLink={{ runId: "run-7", sentText: true, onShowRun }} />);
    fireEvent.click(screen.getByRole("button", { name: "“Hello”" }));
    expect(onFocusAnchor).toHaveBeenCalledWith(anchor);
    expect(onShowRun).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Show the run" })).toHaveLength(1);
    expect(screen.getByText("Unsaved text sent with this run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the run" }));
    expect(onShowRun).toHaveBeenCalledExactlyOnceWith("run-7");
    expect(onFocusAnchor).toHaveBeenCalledTimes(1);
  });

  it("keeps the run link without a false sent-text claim for a clean or withheld turn", () => {
    render(<CommentThreadCard thread={thread({ anchor: null })} {...noop}
      runLink={{ runId: "run-8", sentText: false, onShowRun: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Show the run" })).toBeTruthy();
    expect(screen.queryByText("Unsaved text sent with this run")).toBeNull();
  });
});

describe("comments/CommentThreadCard — state-driven rendering (ux-design.md §2)", () => {
  it("activates the column card by pointer or keyboard without treating nested actions as navigation (#2537)", () => {
    const onActivate = vi.fn();
    const onResolve = vi.fn();
    render(<CommentThreadCard thread={thread()} {...noop} onResolve={onResolve} onActivate={onActivate}
      activationLabel="Select comment thread 2 of 3" selected />);
    const card = document.querySelector<HTMLElement>('[data-card-id="c1"]')!;
    expect(card.getAttribute("aria-current")).toBe("true");
    expect(card.getAttribute("aria-label")).toBe("Select comment thread 2 of 3");
    fireEvent.click(screen.getByText("please clarify this passage"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("renders Open for an unresolved, unorphaned thread", () => {
    render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(screen.getByText("Open")).toBeTruthy();
    const marker = document.querySelector('[data-thread-state="open"]');
    expect(marker).toBeTruthy();
  });

  it("renders a resolved thread collapsed to a single line by default (P2b-1b) — expand on click reveals the rest", () => {
    render(<CommentThreadCard thread={thread({ resolved: true })} {...noop} />);
    // Collapsed: the state label and body still show on the one line, but the full card's own
    // controls (Reopen, the replies disclosure) do not render at all.
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(document.querySelector(".comment-thread-card__replies")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));

    // Expanded: the full card returns; a zero-reply thread has no reply-disclosure row.
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(document.querySelector(".comment-thread-card__replies")).toBeNull();
    // Resolved state offers Reopen, not Resolve.
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("collapsing a manually-expanded resolved thread returns it to a single line", () => {
    render(<CommentThreadCard thread={thread({ resolved: true })} {...noop} />);
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.getByText("Resolved")).toBeTruthy();
  });

  it("a non-resolved thread state never renders a collapse control — only Resolved carries the collapse rule", () => {
    render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("reports its own collapsed state to the caller — the seam collapse composes with virtualization through (P2b-1b)", () => {
    const onCollapsedChange = vi.fn();
    render(
      <CommentThreadCard thread={thread({ resolved: true })} {...noop} onCollapsedChange={onCollapsedChange} />,
    );
    // Second argument: whether that value is the user's *explicit* choice or merely the value the
    // data-driven default happens to produce. The caller needs both — the effective value to size
    // the row, the explicitness to know whether it may pin it back on remount (review finding
    // PR #481: conflating them turned every default into a pin after one scroll cycle).
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true, false);

    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false, true);

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true, true);
  });

  it("initialCollapsed seeds the collapse override on mount — the round-trip fix for a card that unmounts and remounts (review finding PR #481)", () => {
    // A resolved thread's own default is collapsed; `initialCollapsed={false}` pins the opposite —
    // exactly what `TimelinePanel` passes back down from its `pinnedCollapsedIds` map after a card the
    // user explicitly expanded scrolls out of the virtualized window and back in.
    render(<CommentThreadCard thread={thread({ resolved: true })} {...noop} initialCollapsed={false} />);
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
  });

  it("the collapsed row's accessible name includes the row content not just 'Expand' — an aria-label would erase it from assistive tech (review finding PR #481)", () => {
    render(
      <CommentThreadCard
        thread={thread({ resolved: true, author: "priya", body: "tighten the opening paragraph" })}
        {...noop}
      />,
    );
    const button = screen.getByRole("button", { name: /^Expand/ });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button).toHaveAccessibleName(/priya/);
    expect(button).toHaveAccessibleName(/Resolved/);
    expect(button).toHaveAccessibleName(/tighten the opening paragraph/);
  });

  it("the collapsed row still carries its severity chip — a resolved finding thread keeps its severity signal even collapsed", () => {
    render(<CommentThreadCard thread={thread({ resolved: true, severity: "H" })} {...noop} />);
    const chip = document.querySelector(".comment-thread-card__severity");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("H");
  });

  it("renders Orphaned with the warning chip and the preserved original quote", () => {
    const orphan = thread({
      orphaned: true,
      anchor: {
        offset: 0,
        length: 5,
        text_snapshot: "Hello",
        context_before: "",
        context_after: " world",
        base_revision: "blake3:old",
      },
    });
    render(<CommentThreadCard thread={orphan} {...noop} />);
    expect(screen.getByText("Orphaned")).toBeTruthy();
    expect(screen.getByText("original text changed")).toBeTruthy();
    expect(screen.getByText("Hello", { selector: "q" })).toBeTruthy();
  });

  // Every ux-design.md §2 state is also fully renderable via the `state` override — proving the
  // renderer itself supports the full seven-way set regardless of whether `deriveThreadState` can
  // reach it from today's backend data (only Suggestion, per that function's doc comment, cannot).
  it.each<[ThreadState, string]>([
    ["working", "Working"],
    ["addressed-pending", "Addressed — pending"],
    ["reopened", "Reopened"],
    ["suggestion", "Suggestion"],
  ])("renders %s via the state override", (state, label) => {
    render(<CommentThreadCard thread={thread()} state={state} {...noop} />);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("a reopened thread carries the 'reopened' badge (state label + badge, distinct from plain Open)", () => {
    render(<CommentThreadCard thread={thread()} state="reopened" {...noop} />);
    expect(screen.getAllByText("Reopened")).toHaveLength(2);
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("a suggestion thread renders a disabled Apply placeholder (D19 diff payload is a follow-up)", () => {
    render(<CommentThreadCard thread={thread()} state="suggestion" {...noop} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});

describe("comments/CommentThreadCard — J10 author correction", () => {
  it("offers inline Edit only for the author, keeps Save inert for an empty body, and saves the revised body", () => {
    const onRevise = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CommentThreadCard thread={thread()} author="bob" {...noop} onRevise={onRevise} />,
    );
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();

    rerender(<CommentThreadCard thread={thread()} author="alice" {...noop} onRevise={onRevise} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    const editor = screen.getByRole("textbox", { name: "Edit comment body" });
    expect(screen.getByText("Editing")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(editor, { target: { value: "corrected body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRevise).toHaveBeenCalledWith("c1", "corrected body");
  });
});

describe("comments/CommentThreadCard — J10 child-first Delete", () => {
  it("keeps correction inert while any overlapping Address remains pending", () => {
    const overlap = thread({ pending_run: null, pending_runs: [
      { run_id: "run-1", address_event_id: "a1", started: true, guidance: null, corrected: false },
      { run_id: "run-2", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    const { rerender } = render(<CommentThreadCard thread={overlap} author="alice" {...noop} onRevise={vi.fn()} terminalRunIds={[]} />);
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeDisabled();
    expect(screen.getByText(/Addressing with AI/)).toBeTruthy();
    rerender(<CommentThreadCard thread={overlap} author="alice" {...noop} onRevise={vi.fn()} terminalRunIds={["run-1"]} />);
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeDisabled();
    rerender(<CommentThreadCard thread={overlap} author="alice" {...noop} onRevise={vi.fn()} terminalRunIds={["run-1", "run-2"]} />);
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeEnabled();
  });
  it("shows the named permission wait for a started run within an overlap", () => {
    const overlap = thread({ pending_run: null, pending_runs: [
      { run_id: "run-active", address_event_id: "a1", started: true, guidance: null, corrected: false },
      { run_id: "run-queued", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    render(<CommentThreadCard thread={overlap} {...noop} permissionRunId="run-active" />);
    expect(screen.getByText("Waiting on permission")).toBeTruthy();
  });
  it("shows surviving guidance when an overlapping queued run turns terminal", () => {
    const overlap = thread({ pending_run: null, pending_guidance: null, pending_runs: [
      { run_id: "run-guided", address_event_id: "a1", started: true, guidance: "use ESV wording", corrected: false },
      { run_id: "run-queued", address_event_id: "a2", started: false, guidance: null, corrected: false },
    ] });
    render(<CommentThreadCard thread={overlap} {...noop} terminalRunIds={["run-queued"]} />);
    expect(screen.getByText("You added: “use ESV wording”")).toBeTruthy();
  });
  it("uses terminal queue state before conclusion clears the stale pending marker", () => {
    const pending = thread({ pending_run: "run-1", pending_run_started: true, targeting_run_ids: ["run-1"] });
    const { rerender } = render(<CommentThreadCard thread={pending} {...noop} liveRunIds={["run-1"]} terminalRunIds={[]} />);
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    rerender(<CommentThreadCard thread={pending} {...noop} liveRunIds={[]} terminalRunIds={["run-1"]} />);
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
    expect(screen.queryByText(/In an agent run/)).toBeNull();

    rerender(<CommentThreadCard thread={{ ...pending, resolved: true }} {...noop} liveRunIds={[]} terminalRunIds={["run-1"]} />);
    expect(screen.getByRole("button", { name: /^Expand/ })).toBeTruthy();
  });

  it("keeps both Resolve controls inert while linked changes are undecided", () => {
    const onResolve = vi.fn();
    render(<CommentThreadCard thread={thread({ linked_changes: [linkedChange("pending")] })} author="alice" {...noop} onResolve={onResolve} onWithdraw={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Resolve — 1 linked change still to decide/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Mark as resolved" })).toBeDisabled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("shows a typed resolve refusal when the backend sees a newly linked undecided change", async () => {
    const onResolve = vi.fn().mockRejectedValue({ kind: "ClosureRefused", message: "Decide linked changes first." });
    render(<CommentThreadCard thread={thread()} {...noop} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Decide linked changes first."));
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
  });

  it("keeps a resolved partially delivered thread expanded with run acknowledgment until terminal", () => {
    const partial = thread({ resolved: true, pending_run: null, targeting_run_ids: ["run-1"] });
    const { rerender } = render(<CommentThreadCard thread={partial} {...noop} liveRunIds={["run-1"]} terminalRunIds={[]} />);
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.getByText(/In an agent run — it already has this comment as written/)).toBeTruthy();
    rerender(<CommentThreadCard thread={partial} {...noop} liveRunIds={[]} terminalRunIds={["run-1"]} />);
    expect(screen.getByRole("button", { name: /^Expand/ })).toBeTruthy();
  });
  it("holds Delete after delivery clears pending_run while the targeting run remains live", () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    const held = thread({ pending_run: null, targeting_run_ids: ["run-1"] });
    const { rerender } = render(<CommentThreadCard thread={held} author="alice" {...noop} onWithdraw={onWithdraw} liveRunIds={["run-1"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    expect(screen.getByText("In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.")).toBeTruthy();
    rerender(<CommentThreadCard thread={held} author="alice" {...noop} onWithdraw={onWithdraw} liveRunIds={[]} />);
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeEnabled();
  });

  it("explains a run-held correction once while Resolve remains available", () => {
    const held = thread({ pending_run: "run-1", pending_run_started: true, targeting_run_ids: ["run-1"] });
    render(<CommentThreadCard thread={held} author="alice" {...noop} onRevise={vi.fn()} onWithdraw={vi.fn()} liveRunIds={["run-1"]} />);
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
    const reason = "Addressing with AI — you can edit or delete this comment once the run finishes.";
    expect(screen.getByText(reason)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(document.querySelector(".comment-thread-card__menu-reason")).toBeNull();
  });

  it("releases correction when a formerly pending run is terminal in the live queue", () => {
    render(<CommentThreadCard thread={thread({ pending_run: "run-1", targeting_run_ids: ["run-1"] })} author="alice" {...noop} onRevise={vi.fn()} liveRunIds={[]} terminalRunIds={["run-1"]} />);
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeEnabled();
  });

  it("keeps Delete comment inert with a visible reason while a live reply remains", () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    render(
      <CommentThreadCard
        thread={thread({ replies: [
          { id: "r1", parent_id: "c1", author: "bob", body: "reply", defense: false, published: false, edited_at: null, withdrawn_at: null },
        ] })}
        author="alice"
        {...noop}
        onWithdraw={onWithdraw}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Delete replies first.")).toBeTruthy();
    expect(screen.queryByText("Delete this comment?")).toBeNull();
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("replaces confirmation after a backend child-first refusal", async () => {
    const onWithdraw = vi.fn().mockRejectedValue({ kind: "CorrectionRefused", message: "Delete replies first." });
    render(<CommentThreadCard thread={thread()} author="alice" {...noop} onWithdraw={onWithdraw} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    expect(screen.getByText(/This comment hasn't been shared/)).toBeTruthy();
    expect(screen.getByText(/This can't be undone/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Delete replies first."));
    expect(onWithdraw).toHaveBeenCalledWith("c1");
    expect(screen.queryByText("Delete this comment?")).toBeNull();
    expect(screen.getByText("Not deleted")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment actions" }));
  });

  it("Escape in inline Delete restores the untouched comment", () => {
    const onWithdraw = vi.fn();
    render(<CommentThreadCard thread={thread()} author="alice" {...noop} onWithdraw={onWithdraw} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Escape" });
    expect(screen.queryByText("Delete this comment?")).toBeNull();
    expect(screen.getByText("please clarify this passage")).toBeTruthy();
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("uses 5d confirmation copy and actions for private and published roots", () => {
    const { rerender } = render(<CommentThreadCard thread={thread()} author="alice" {...noop} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.getByText("Deleting")).toBeTruthy();
    expect(screen.getByText("This comment hasn't been shared and no one else has replied, so it will disappear from the document.")).toBeTruthy();
    expect(screen.getByText("Esc cancels")).toBeTruthy();
    const actions = document.querySelector(".comment-thread-card__correction-actions")!;
    expect(within(actions as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["Delete", "Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<CommentThreadCard thread={thread({ published: true })} author="alice" {...noop} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.getByText("Others may already have seen this comment. The thread will keep a note that you deleted it.")).toBeTruthy();
    expect(screen.getByText("Emend keeps the original text in this document's history. Deleting removes it from view, not from the record. This can't be undone.")).toBeTruthy();
  });

  it("hides ordinary reply and Address controls during root Delete confirmation", () => {
    const onReply = vi.fn();
    const onAddressWithAI = vi.fn();
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    render(<CommentThreadCard thread={thread({
      published: true,
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "private words", defense: false, published: true, edited_at: null, withdrawn_at: 5 }],
    })} author="alice" {...noop} onReply={onReply} onAddressWithAI={onAddressWithAI} onWithdraw={onWithdraw} />);

    const reply = screen.getByRole("textbox", { name: "Reply to alice's comment" });
    fireEvent.change(reply, { target: { value: "draft reply" } });
    expect(screen.getByRole("button", { name: "Address with AI" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    expect(screen.getByText("Deleting")).toBeTruthy();
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    expect(screen.getByText(/Others may already have seen this comment/)).toBeTruthy();
    expect(screen.getByText(/Emend keeps the original text in this document's history/)).toBeTruthy();
    expect(screen.getByText(/bob deleted a reply/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Reply to alice's comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
    expect(onAddressWithAI).not.toHaveBeenCalled();
    expect(onWithdraw).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("please clarify this passage")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply to alice's comment" })).toHaveValue("draft reply");
    expect(screen.getByRole("button", { name: "Address with AI" })).toBeTruthy();
  });

  it("hides failed-run retry during root Delete confirmation", () => {
    const onAddressWithAI = vi.fn();
    render(<CommentThreadCard thread={thread({ concluded_run: { run_id: "failed-1", outcome: "failed" } })}
      author="alice" {...noop} onAddressWithAI={onAddressWithAI} onWithdraw={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(onAddressWithAI).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("hides armed reopened guidance during root Delete confirmation", () => {
    const onReDelegate = vi.fn();
    render(<CommentThreadCard thread={thread({ reopened: true })} author="alice" {...noop}
      onReDelegate={onReDelegate} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Guidance for re-delegation" }), {
      target: { value: "keep my draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Guidance for re-delegation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(within(document.querySelector(".comment-thread-card__correction-actions") as HTMLElement)
      .getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Guidance for re-delegation" })).toHaveValue("keep my draft");
    expect(onReDelegate).not.toHaveBeenCalled();

    fireEvent.click(within(document.querySelector(".comment-thread-card__redelegate-form") as HTMLElement)
      .getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.queryByRole("button", { name: "Try again — add guidance…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Try again — add guidance…" })).toBeTruthy();
  });

  it("links an undecided-change Delete refusal to the first undecided change", () => {
    const onFocusChange = vi.fn();
    render(<CommentThreadCard thread={thread({ linked_changes: [linkedChange("done", { decision: "accept" }), linkedChange("pending")] })} author="alice" {...noop} onWithdraw={vi.fn()} onFocusChange={onFocusChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go to changes" }));
    expect(onFocusChange).toHaveBeenCalledWith("pending");
  });

  it("places linked-change refusal at card level for Resolve and Delete", () => {
    const onFocusChange = vi.fn();
    render(<CommentThreadCard thread={thread({ linked_changes: [linkedChange("first"), linkedChange("second")] })} author="alice" {...noop} onWithdraw={vi.fn()} onFocusChange={onFocusChange} />);
    const reason = "2 linked changes still to decide. Accept them and this thread resolves; reject them and it reopens, and you can dismiss it then.";
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resolve.*linked changes/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go to changes" }));
    expect(onFocusChange).toHaveBeenCalledWith("first");
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Mark as resolved" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  it("keeps the descendant Delete reason beside the item when linked changes also block closure", () => {
    render(<CommentThreadCard thread={thread({
      linked_changes: [linkedChange("pending")],
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "live reply", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    })} author="alice" {...noop} onWithdraw={vi.fn()} onFocusChange={vi.fn()} />);
    expect(screen.getByText(/1 linked change still to decide/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Mark as resolved" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    expect(screen.getByText("Delete replies first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to changes" })).toBeTruthy();
  });

  it("replaces confirmation after a late reply and restores focus to comment actions", async () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<CommentThreadCard thread={thread()} author="alice" {...noop} onWithdraw={onWithdraw} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    const lateReply = { id: "r1", parent_id: "c1", author: "bob", body: "late reply", defense: false, published: false, edited_at: null, withdrawn_at: null };
    rerender(<CommentThreadCard thread={thread({ replies: [lateReply] })} author="alice" {...noop} onWithdraw={onWithdraw} />);
    await waitFor(() => expect(screen.queryByText("Delete this comment?")).toBeNull());
    expect(screen.getByText("Not deleted")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("Delete replies first.");
    expect(screen.getByText("late reply")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment actions" }));
    expect(onWithdraw).not.toHaveBeenCalled();

    rerender(<CommentThreadCard thread={thread({ replies: [{ ...lateReply, withdrawn_at: 3 }] })} author="alice" {...noop} onWithdraw={onWithdraw} />);
    await waitFor(() => expect(screen.queryByText("Not deleted")).toBeNull());
    expect(screen.queryByText("Delete replies first.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeEnabled();
  });
});

describe("comments/CommentThreadCard — J10 reply correction", () => {
  it("names reply deletion separately from root deletion", () => {
    const reply = { id: "r1", parent_id: "c1", author: "alice", body: "my reply", defense: false, published: false, edited_at: null, withdrawn_at: null };
    render(<CommentThreadCard thread={thread({ replies: [reply] })} author="alice" {...noop} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reply actions" }));
    expect(screen.getByRole("button", { name: "Delete reply" })).toBeTruthy();
  });
  it("names private versus already-seen provenance in eligible reply confirmations", () => {
    const privateReply = { id: "r1", parent_id: "c1", author: "alice", body: "my reply", defense: false, published: false, edited_at: null, withdrawn_at: null };
    const { rerender } = render(<CommentThreadCard thread={thread({ replies: [privateReply] })} author="alice" {...noop} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));
    expect(screen.getByText(/It hasn't been shared and no one else has replied to it/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Escape" });
    rerender(<CommentThreadCard thread={thread({ replies: [{ ...privateReply, published: true }] })} author="alice" {...noop} onWithdraw={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));
    expect(screen.getByText(/Others may already have seen it/)).toBeTruthy();
  });
  it("shows an authored reply's Edit action and a withdrawn reply's bodyless provenance", () => {
    const replies = [
      { id: "r1", parent_id: "c1", author: "alice", body: "my reply", defense: false, published: false, edited_at: null, withdrawn_at: null },
      { id: "r2", parent_id: "c1", author: "bob", body: "private words", defense: false, published: false, edited_at: null, withdrawn_at: 5 },
    ];
    render(<CommentThreadCard thread={thread({ replies })} author="alice" {...noop} onRevise={vi.fn()} onWithdraw={vi.fn()} />);
    const mine = screen.getByText("my reply").closest("li")!;
    expect(within(mine).getByRole("button", { name: "Edit reply" })).toBeTruthy();
    expect(screen.queryByText("private words")).toBeNull();
    expect(screen.getByText(/bob deleted a reply ·/)).toBeTruthy();
  });

  it("refuses a reply's Delete while its withdrawn child contains a live grandchild", () => {
    const replies = [
      { id: "r1", parent_id: "c1", author: "alice", body: "parent reply", defense: false, published: false, edited_at: null, withdrawn_at: null },
      { id: "r2", parent_id: "r1", author: "alice", body: "old middle", defense: false, published: false, edited_at: null, withdrawn_at: 5 },
      { id: "r3", parent_id: "r2", author: "bob", body: "live grandchild", defense: false, published: false, edited_at: null, withdrawn_at: null },
    ];
    render(<CommentThreadCard thread={thread({ replies })} author="alice" {...noop} onWithdraw={vi.fn()} />);
    const parent = screen.getByText("parent reply").closest("li")!;
    fireEvent.click(within(parent).getByRole("button", { name: "Reply actions" }));
    expect(within(parent).getByRole("button", { name: "Delete reply" }).hasAttribute("disabled")).toBe(true);
    expect(within(parent).getByText("Delete replies first.")).toBeTruthy();
    expect(screen.getByText("live grandchild")).toBeTruthy();
  });
});

describe("comments/CommentThreadCard — J10 withdrawn root", () => {
  it("#2574 keeps a retained placeholder with a passage route and late live reply", () => {
    const privateRoot = thread({ withdrawn_at: 10, body: "secret", visible_when_withdrawn: false });
    const onFocusAnchor = vi.fn();
    const { rerender } = render(<CommentThreadCard thread={privateRoot} author="alice" {...noop} onFocusAnchor={onFocusAnchor} />);
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();

    const retained = thread({
      withdrawn_at: 10,
      visible_when_withdrawn: true,
      body: "secret",
      anchor: { offset: 2, length: 4, text_snapshot: "text", context_before: "", context_after: "", base_revision: "r1" },
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "late reply", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    });
    rerender(<CommentThreadCard thread={retained} author="alice" {...noop} onFocusAnchor={onFocusAnchor} />);
    expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent?.startsWith("alice deleted a comment ·") === true)).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.getByText("late reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    const route = screen.getByRole("button", { name: "→ Go to passage" });
    expect(route).toHaveAttribute("type", "button");
    expect(route.tabIndex).toBeGreaterThanOrEqual(0);
    fireEvent.click(route);
    expect(onFocusAnchor).toHaveBeenCalledWith(retained.anchor);
  });
});

describe("comments/CommentThreadCard — J10 edited provenance", () => {
  it("marks only an already-seen edited root with its revision age", () => {
    const edited = thread({ edited_at: 60_000 });
    const { rerender } = render(<CommentThreadCard thread={edited} now={() => 120_000} {...noop} />);
    expect(screen.queryByText(/edited 1m ago/)).toBeNull();
    rerender(<CommentThreadCard thread={{ ...edited, published: true }} now={() => 120_000} {...noop} />);
    expect(screen.getByText("edited 1m ago")).toBeTruthy();
  });
});

describe("comments/CommentThreadCard — reply/resolve/reopen actions", () => {
  it("C4 author and action row keeps the existing Resolve in the header beside an initials avatar", () => {
    const onResolve = vi.fn();
    render(<CommentThreadCard thread={thread({ author: "alice" })} {...noop} onResolve={onResolve} />);
    const header = document.querySelector('.timeline-card[data-card-kind="comment"] > header')!;
    expect(header.querySelector('.comment-thread-card__avatar')).toHaveTextContent("A");
    const resolve = within(header as HTMLElement).getByRole("button", { name: "Resolve" });
    fireEvent.click(resolve);
    expect(onResolve).toHaveBeenCalledOnce();
    expect(document.querySelector('.timeline-card__body button[aria-label="Resolve"]')).toBeNull();
  });

  it("C4 author and action row gives a reply its own small initials avatar", () => {
    render(<CommentThreadCard thread={thread({
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "one reply", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    })} {...noop} />);
    expect(document.querySelector('.comment-thread-card__reply-avatar')).toHaveTextContent("B");
  });

  it("C4 reply presentation omits a collapse row at zero and one reply", () => {
    const { rerender } = render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(document.querySelector(".comment-thread-card__replies")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Reply to alice's comment" })).toHaveAttribute(
      "placeholder",
      "Reply…",
    );

    rerender(<CommentThreadCard thread={thread({
      replies: [{ id: "r1", parent_id: "c1", author: "bob", body: "the only reply", defense: false, published: false, edited_at: null, withdrawn_at: null }],
    })} {...noop} />);
    expect(screen.getByText("the only reply")).toBeVisible();
    expect(document.querySelector(".comment-thread-card__replies")).toBeNull();
  });

  it("C4 reply presentation keeps the newest of three visible while older replies expand in causal order", () => {
    render(<CommentThreadCard thread={thread({
      replies: [
        { id: "r1", parent_id: "c1", author: "bob", body: "first", defense: false, published: false, edited_at: null, withdrawn_at: null },
        { id: "r2", parent_id: "c1", author: "alice", body: "second", defense: false, published: false, edited_at: null, withdrawn_at: null },
        { id: "r3", parent_id: "c1", author: "bob", body: "newest", defense: false, published: false, edited_at: null, withdrawn_at: null },
      ],
    })} {...noop} />);
    const details = document.querySelector(".comment-thread-card__replies") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(screen.getByText("newest").closest(".comment-thread-card__reply")).not.toBeNull();
    expect(details).not.toContainElement(screen.getByText("newest"));
    expect(details).toContainElement(screen.getByText("first"));
    expect(details).toContainElement(screen.getByText("second"));
    fireEvent.click(screen.getByText("2 more replies"));
    expect(details.open).toBe(true);
    expect([...document.querySelectorAll(".comment-thread-card__reply p")].map((p) => p.textContent)).toEqual([
      "first", "second", "newest",
    ]);
  });

  it("C4 reply presentation keeps resolved threads readable without a reply composer", () => {
    render(<CommentThreadCard thread={thread({ resolved: true })} initialCollapsed={false} {...noop} />);
    expect(screen.getByText("please clarify this passage")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Reply to alice's comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeVisible();
  });

  it("submits a reply and clears the field", () => {
    const onReply = vi.fn();
    render(<CommentThreadCard thread={thread()} onReply={onReply} onResolve={vi.fn()} onReopen={vi.fn()} />);

    const field = screen.getByLabelText("Reply to alice's comment");
    fireEvent.change(field, { target: { value: "on it" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(onReply).toHaveBeenCalledWith("on it", false);
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit a blank reply", () => {
    const onReply = vi.fn();
    render(<CommentThreadCard thread={thread()} onReply={onReply} onResolve={vi.fn()} onReopen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).not.toHaveBeenCalled();
  });

  it("renders replies in the order the fold already provides (causal order)", () => {
    const withReplies = thread({
      replies: [
        { id: "r1", parent_id: "c1", author: "bob", body: "first reply", defense: false, published: false, edited_at: null, withdrawn_at: null },
        { id: "r2", parent_id: "c1", author: "alice", body: "second reply", defense: false, published: false, edited_at: null, withdrawn_at: null },
      ],
    });
    render(<CommentThreadCard thread={withReplies} {...noop} />);
    const bodies = Array.from(document.querySelectorAll(".comment-thread-card__reply p")).map(
      (el) => el.textContent,
    );
    expect(bodies).toEqual(["first reply", "second reply"]);
  });

  it("flags a defense reply distinctly", () => {
    const withDefense = thread({
      replies: [
        { id: "r1", parent_id: "c1", author: "agent", body: "the text is correct as written", defense: true, published: false, edited_at: null, withdrawn_at: null },
      ],
    });
    render(<CommentThreadCard thread={withDefense} {...noop} />);
    expect(screen.getByText("Defense")).toBeTruthy();
  });

  it("Resolve on an open thread calls onResolve", () => {
    const onResolve = vi.fn();
    render(<CommentThreadCard thread={thread()} onReply={vi.fn()} onResolve={onResolve} onReopen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("Reopen on a resolved thread calls onReopen", () => {
    const onReopen = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ resolved: true })}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={onReopen}
      />,
    );
    // A resolved thread renders collapsed by default (P2b-1b) — expand to reach Reopen.
    fireEvent.click(screen.getByRole("button", { name: /^Expand/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});

describe("comments/CommentThreadCard — orphan → [Re-anchor] flow (J4)", () => {
  const orphan = thread({
    orphaned: true,
    anchor: {
      offset: 0,
      length: 5,
      text_snapshot: "Hello",
      context_before: "",
      context_after: " world",
      base_revision: "blake3:old",
    },
  });

  it("clicking [Re-anchor] arms the confirm flow with Confirm disabled until a selection exists", () => {
    render(<CommentThreadCard thread={orphan} {...noop} onReAnchor={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Re-anchor" }));

    expect(screen.getByText("Select the new home text in the document…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("confirming with a pending selection calls the (stubbed) onReAnchor with its content/offset/length", () => {
    const onReAnchor = vi.fn();
    render(
      <CommentThreadCard
        thread={orphan}
        {...noop}
        onReAnchor={onReAnchor}
        pendingSelection={{ content: "a totally new home", offset: 2, length: 7, preview: "totally" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-anchor" }));
    expect(screen.getByText('New home: “totally”')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onReAnchor).toHaveBeenCalledWith("a totally new home", 2, 7);
  });

  it("Cancel disarms the confirm flow without calling onReAnchor", () => {
    const onReAnchor = vi.fn();
    render(
      <CommentThreadCard
        thread={orphan}
        {...noop}
        onReAnchor={onReAnchor}
        pendingSelection={{ content: "a totally new home", offset: 2, length: 7, preview: "totally" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-anchor" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Re-anchor" })).toBeTruthy();
    expect(onReAnchor).not.toHaveBeenCalled();
  });

  it("the original quote is retained on the card regardless of outcome", () => {
    render(<CommentThreadCard thread={orphan} {...noop} onReAnchor={vi.fn()} />);
    expect(screen.getByText("Hello", { selector: "q" })).toBeTruthy();
  });

  it("a non-orphaned thread never renders [Re-anchor]", () => {
    render(<CommentThreadCard thread={thread()} {...noop} onReAnchor={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Re-anchor" })).toBeNull();
  });
});

describe("comments/CommentThreadCard — [Address with AI] (FR-CMT-2, J4)", () => {
  it("an open thread's [Address with AI] calls onAddressWithAI", () => {
    const onAddressWithAI = vi.fn();
    render(<CommentThreadCard thread={thread()} {...noop} onAddressWithAI={onAddressWithAI} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    expect(onAddressWithAI).toHaveBeenCalledTimes(1);
  });

  it("a resolved thread never renders [Address with AI]", () => {
    render(<CommentThreadCard thread={thread({ resolved: true })} {...noop} />);
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
  });

  // #1122: `deriveThreadState` used to fold an in-flight run into the same "Addressed — pending"
  // presentation as a delivered proposal — a thread mid-run claimed a proposal existed and offered
  // no route to it. Working (UXR-Q10) is its own state with its own words, never that claim.
  it("a thread with a pending run and no earlier delivery renders Working, not Addressed — pending, and offers no [Address with AI] (#1122)", () => {
    render(<CommentThreadCard thread={thread({ pending_run: "run-1", pending_run_started: true })} {...noop} />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(
      screen.getByText("Addressing with AI — you can edit or delete this comment once the run finishes."),
    ).toBeTruthy();
    expect(screen.queryByText("Addressed — pending review.")).toBeNull();
    expect(screen.queryByText("Addressed — pending")).toBeNull();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
  });

  // Issue #1778, ux-design.md §2 "Batch … Working means started, not targeted" (UXR-Q10/#1122): a
  // batch's own per-thread dispatch sets `pending_run` on every eligible target the moment it
  // fires, but this build has no per-thread signal to say any one of them has actually started —
  // so a merely-targeted thread renders as Open (never Working), and — because a live or queued
  // run already has this comment as written — offers no [Address with AI] of its own either
  // (double-dispatching a run this thread already has).
  //
  // Both halves of §2's ladder: the withdrawal, and the rung line that must replace it in the same
  // breath ("so the request surface is never silent"). #1778 shipped only the first and recorded
  // the second as a tracked gap; #2228 closed it, so the assertion this test used to decline is
  // here — the rung's full coverage is in the ladder describe block near the end of this file.
  it("a thread merely targeted by a batch (pending_run set, not started) renders Open, offers no [Address with AI], and says so in its place", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false })}
        {...noop}
      />,
    );
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
    expect(
      screen.queryByText("Addressing with AI — you can edit or delete this comment once the run finishes."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
    expect(
      screen.getByText(
        "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.",
      ),
    ).toBeTruthy();
  });

  it("an orphaned thread merely targeted (not started) still offers no [Re-anchor]-then-address route back in", () => {
    render(
      <CommentThreadCard
        thread={thread({
          orphaned: true,
          pending_run: "batch-1",
          pending_run_started: false,
          anchor: {
            offset: 0,
            length: 5,
            text_snapshot: "Hello",
            context_before: "",
            context_after: " world",
            base_revision: "blake3:old",
          },
        })}
        {...noop}
        onReAnchor={vi.fn()}
      />,
    );
    expect(screen.getByText("Orphaned")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
  });

  it("a reopened thread already targeted by a live run (not yet started) offers no [Try again — add guidance…] — one run per thread at a time", () => {
    render(
      <CommentThreadCard
        thread={thread({
          reopened: true,
          pending_run: "batch-1",
          pending_run_started: false,
          linked_changes: [linkedChange("chg-1", { decision: "reject" })],
        })}
        {...noop}
      />,
    );
    expect(document.querySelector('[data-thread-state="reopened"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again — add guidance…" })).toBeNull();
  });

  it("a pending run's guidance note is shown while Working", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "run-2", pending_run_started: true, pending_guidance: "use ESV wording" })}
        {...noop}
      />,
    );
    expect(screen.getByText("You added: “use ESV wording”")).toBeTruthy();
  });

  it("a re-delegated thread with a run in flight still shows its earlier delivery's undecided linked changes, attributed to that delivery, and still reads Working (#1122, #1380)", () => {
    render(
      <CommentThreadCard
        thread={thread({
          pending_run: "run-3",
          pending_run_started: true,
          linked_changes: [linkedChange("chg-1", { run_id: "run-2" })],
        })}
        now={() => 0}
        {...noop}
      />,
    );
    expect(screen.getByText("Working")).toBeTruthy();
    // #1380: attributed to its own delivery ("run-2"), never a bare unattributed count — the new
    // run in flight ("run-3") is a different run and must not be conflated with it.
    expect(screen.getByText("↳ 1 change from Agent · just now")).toBeTruthy();
    expect(screen.queryByText("1 linked change")).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "↳ 1 change from Agent · just now" })).getByRole("button", {
        name: "Go to →",
      }),
    ).toBeTruthy();
  });

  // #1380 (ux-design.md §2 line 38): "no proposal of its own: no agent summary, no linked-change
  // count, no [Go to →], no accept/reject for this run" — the negative half of the row above.
  // Nothing about the block below is unattributed to the run currently in flight.
  it("Working never claims the earlier delivery's linked-change count or [Go to →] as belonging to the run in flight (#1380)", () => {
    render(
      <CommentThreadCard
        thread={thread({
          pending_run: "run-3",
          pending_run_started: true,
          linked_changes: [linkedChange("chg-1", { run_id: "run-2" })],
        })}
        now={() => 0}
        {...noop}
      />,
    );
    // The delivered-change block and J10's card-level refusal can both name the changes; the
    // working-run acknowledgment itself still claims no delivery of its own.
    expect(document.querySelector(".comment-thread-card__status")?.textContent).not.toMatch(/change/);
    expect(document.querySelector(".comment-thread-card__linked-refusal")?.textContent).toMatch(/1 linked change still to decide/);
    expect(screen.getAllByRole("button", { name: "Go to →" })).toHaveLength(1);
  });

  // ux-design.md §2 "Manual resolve during a run is acknowledged, not swallowed": Working outranks
  // Resolved in the presentation order, so without this the resolve would be a silent no-op
  // (FR-X-5 forbids). Review finding, PR #1378 round 1.
  it("a thread resolved before/during a run still reads Working, but states the resolve in place rather than swallowing it (#1122 review round)", () => {
    render(<CommentThreadCard thread={thread({ pending_run: "run-4", pending_run_started: true, resolved: true })} {...noop} />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(
      screen.getByText("✓ Resolved — the agent is still working; anything it delivers will bring this thread back."),
    ).toBeTruthy();
  });

  it("a Working thread that was never resolved shows no resolved-acknowledgment note", () => {
    render(<CommentThreadCard thread={thread({ pending_run: "run-5", pending_run_started: true })} {...noop} />);
    expect(screen.queryByText(/anything it delivers will bring this thread back/)).toBeNull();
  });

  // Review finding, PR #1378 round 2: the block is a flex row so the ◔ sits beside the text, but
  // a guidance note and a resolve acknowledgment give it up to three text children — which laid
  // out as side-by-side columns, not the status *line* `5a.5` draws. jsdom applies no stylesheet,
  // so the DOM alone cannot see it: this reads the shipped rule for whichever element parents the
  // text, which is the layout contract the row direction depends on.
  it("stacks the Working block's text into one column rather than side-by-side columns (docs/design/specs/comments.md 5a.5)", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "run-7", pending_run_started: true, pending_guidance: "use ESV wording", resolved: true })}
        {...noop}
      />,
    );
    const status = screen.getByText(
      "Addressing with AI — you can edit or delete this comment once the run finishes.",
    );
    const textContainer = status.parentElement!;
    expect(screen.getByText("You added: “use ESV wording”").parentElement).toBe(textContainer);
    expect(screen.getByText(/anything it delivers will bring this thread back/).parentElement).toBe(
      textContainer,
    );
    expect(shippedRuleFor(textContainer)).toMatch(/flex-direction:\s*column/);
  });

  it("a thread resolved during a run offers [Reopen], never a no-op [Resolve] (#1122 review round)", () => {
    const onReopen = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "run-6", pending_run_started: true, resolved: true })}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={onReopen}
      />,
    );
    // Working is in neither collapse set (ux-design.md §2), so the footer is reachable directly —
    // no [Expand] needed even though the thread is resolved.
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });
});

// issue #1381, ux-design.md §2's exit table: a run that ended without delivering — stopped,
// failed, or reconciled as failed at load time — leaves a persistent note on the thread.
describe("comments/CommentThreadCard — address-run exit note (issue #1381, ux-design.md §2)", () => {
  it("a stopped run reads the stopped note, with no [Try again] button", () => {
    render(
      <CommentThreadCard
        thread={thread({ concluded_run: { run_id: "run-1", outcome: "stopped" } })}
        {...noop}
      />,
    );
    expect(screen.getByText("Address run stopped — nothing proposed for this comment.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a failed run reads the failed note and offers [Try again] on an otherwise-open thread", () => {
    const onAddressWithAI = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ concluded_run: { run_id: "run-1", outcome: "failed" } })}
        {...noop}
        onAddressWithAI={onAddressWithAI}
      />,
    );
    expect(screen.getByText(/Address run failed — nothing proposed for this comment\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAddressWithAI).toHaveBeenCalledTimes(1);
  });

  // A reopened thread already carries its own [Try again — add guidance…] affordance further down
  // the card — a bare [Try again] here would be a second, redundant route into the same run.
  it("a failed run on a reopened thread does not duplicate [Try again] beside [Try again — add guidance…]", () => {
    render(
      <CommentThreadCard
        thread={thread({
          concluded_run: { run_id: "run-1", outcome: "failed" },
          reopened: true,
          linked_changes: [linkedChange("chg-1", { decision: "reject" })],
        })}
        {...noop}
      />,
    );
    expect(screen.getByText(/Address run failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again — add guidance…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a resolved thread with a failed-run note offers no [Try again] at all (nothing to re-address)", () => {
    render(
      <CommentThreadCard
        thread={thread({ concluded_run: { run_id: "run-1", outcome: "failed" }, resolved: true })}
        {...noop}
        // P2b-1b collapses a resolved thread by default — a display layer over the state rendering
        // this test exercises, not a replacement for it (the card's own docs); expanded here so the
        // note is actually on the page to assert against.
        initialCollapsed={false}
      />,
    );
    expect(screen.getByText(/Address run failed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("no note renders when nothing has concluded that way", () => {
    render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(screen.queryByText(/Address run (stopped|failed)/)).toBeNull();
  });
});

describe("comments/CommentThreadCard — linked-change accept/reject (FR-CMT-3/7)", () => {
  it("keeps J4's unattributed linked-change count for an ordinary single-delivery addressed-pending thread (#1380 ruling)", () => {
    const onFocusChange = vi.fn();
    const withLinks = thread({
      linked_changes: [linkedChange("chg-1"), linkedChange("chg-2")],
    });
    render(<CommentThreadCard thread={withLinks} now={() => 0} {...noop} onFocusChange={onFocusChange} />);
    expect(screen.getByText("↳ 2 linked changes")).toBeTruthy();
    expect(screen.queryByText(/from Agent/)).toBeNull();
    expect(screen.queryByRole("group", { name: /from Agent/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to →" }));
    expect(onFocusChange).toHaveBeenCalledWith("chg-1");
  });

  it("[Accept both] decides every undecided linked change id as accept", () => {
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({
      linked_changes: [linkedChange("chg-1"), linkedChange("chg-2")],
    });
    render(<CommentThreadCard thread={withLinks} {...noop} onDecideLinkedChanges={onDecideLinkedChanges} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept both" }));
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-1", "chg-2"], "accept");
  });

  it("a single undecided linked change (the address-with-AI single headline case) reads [Accept] not [Accept both]", () => {
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({ linked_changes: [linkedChange("chg-1")] });
    render(<CommentThreadCard thread={withLinks} {...noop} onDecideLinkedChanges={onDecideLinkedChanges} />);
    expect(screen.queryByRole("button", { name: "Accept both" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-1"], "accept");
  });

  it("more than two undecided linked changes reads [Accept all]", () => {
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({
      linked_changes: [linkedChange("chg-1"), linkedChange("chg-2"), linkedChange("chg-3")],
    });
    render(<CommentThreadCard thread={withLinks} {...noop} onDecideLinkedChanges={onDecideLinkedChanges} />);
    expect(screen.queryByRole("button", { name: "Accept both" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-1", "chg-2", "chg-3"], "accept");
  });

  it("[Reject] decides every undecided linked change id as reject", () => {
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({ linked_changes: [linkedChange("chg-1")] });
    render(<CommentThreadCard thread={withLinks} {...noop} onDecideLinkedChanges={onDecideLinkedChanges} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-1"], "reject");
  });

  it("already-decided changes are excluded from a further [Accept]/[Reject] call", () => {
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({
      linked_changes: [linkedChange("chg-1", { decision: "reject" }), linkedChange("chg-2")],
    });
    render(<CommentThreadCard thread={withLinks} {...noop} onDecideLinkedChanges={onDecideLinkedChanges} />);
    // Only one linked change remains undecided, so the button reads the singular [Accept].
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-2"], "accept");
  });

  it("no [Accept both]/[Reject] once every linked change is already decided", () => {
    const withLinks = thread({
      linked_changes: [linkedChange("chg-1", { decision: "accept" }), linkedChange("chg-2", { decision: "reject" })],
    });
    render(<CommentThreadCard thread={withLinks} {...noop} />);
    expect(screen.queryByRole("button", { name: "Accept both" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    // The go-to affordance still stands regardless of decision state.
    expect(screen.getByRole("button", { name: "Go to →" })).toBeTruthy();
  });
});

describe("comments/CommentThreadCard — grouped by delivery (#1380, ux-design.md §2, FR-CMT-7)", () => {
  it("two deliveries with undecided changes render as separately-attributed accessible groups with scoped controls", () => {
    const onFocusChange = vi.fn();
    const onDecideLinkedChanges = vi.fn();
    const withLinks = thread({
      linked_changes: [
        linkedChange("chg-1", { delivery_id: "d1", run_id: "run-1", delivered_at: 0 }),
        linkedChange("chg-2", { delivery_id: "d2", run_id: "run-2", delivered_at: 5 * 60_000 }),
      ],
    });
    render(
      <CommentThreadCard
        thread={withLinks}
        now={() => 5 * 60_000}
        {...noop}
        onFocusChange={onFocusChange}
        onDecideLinkedChanges={onDecideLinkedChanges}
      />,
    );

    // Each group names its own delivery — never pooled into "2 linked changes".
    expect(screen.getByText("↳ 1 change from Agent · 5m ago")).toBeTruthy();
    expect(screen.getByText("↳ 1 change from Agent · just now")).toBeTruthy();
    // Never pooled into one unattributed "2 changes" — each delivery stays a group of one.
    expect(screen.queryByText(/2 change/)).toBeNull();

    const olderGroup = screen.getByRole("group", { name: "↳ 1 change from Agent · 5m ago" });
    const newerGroup = screen.getByRole("group", { name: "↳ 1 change from Agent · just now" });
    expect(olderGroup).not.toBe(newerGroup);
    expect(within(olderGroup).getByRole("button", { name: "Go to →" })).toBeTruthy();
    expect(within(newerGroup).getByRole("button", { name: "Go to →" })).toBeTruthy();

    const goToButtons = screen.getAllByRole("button", { name: "Go to →" });
    expect(goToButtons).toHaveLength(2);
    fireEvent.click(goToButtons[0]);
    expect(onFocusChange).toHaveBeenCalledWith("chg-1");
    fireEvent.click(goToButtons[1]);
    expect(onFocusChange).toHaveBeenCalledWith("chg-2");

    // Both groups are still single-change, so both read the singular [Accept] — one per group.
    const acceptButtons = screen.getAllByRole("button", { name: "Accept" });
    expect(acceptButtons).toHaveLength(2);
    fireEvent.click(acceptButtons[1]);
    // Deciding group 2's [Accept] must never reach into group 1's still-undecided id.
    expect(onDecideLinkedChanges).toHaveBeenCalledWith(["chg-2"], "accept");
    expect(onDecideLinkedChanges).not.toHaveBeenCalledWith(["chg-1"], "accept");
  });

  it("two historical deliveries fall back to J4's one unattributed block when only one delivery remains undecided", () => {
    const withLinks = thread({
      linked_changes: [
        linkedChange("chg-1", { delivery_id: "d1", decision: "accept" }),
        linkedChange("chg-2", { delivery_id: "d2", decision: null }),
      ],
    });
    render(<CommentThreadCard thread={withLinks} {...noop} />);
    expect(screen.getByText("↳ 2 linked changes")).toBeTruthy();
    expect(screen.queryByText(/from Agent/)).toBeNull();
    expect(screen.queryByRole("group", { name: /from Agent/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Go to →" })).toHaveLength(1);
  });
});

describe("comments/CommentThreadCard — [Try again — add guidance…] re-delegation (J4)", () => {
  it("a reopened thread offers the guidance retry instead of a plain [Address with AI]", () => {
    render(<CommentThreadCard thread={thread({ reopened: true })} {...noop} />);
    expect(screen.getByRole("button", { name: "Try again — add guidance…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
  });

  it("submitting the guidance input calls onReDelegate with the trimmed note and closes the form", () => {
    const onReDelegate = vi.fn();
    render(<CommentThreadCard thread={thread({ reopened: true })} {...noop} onReDelegate={onReDelegate} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    const field = screen.getByLabelText("Guidance for re-delegation");
    fireEvent.change(field, { target: { value: "  use ESV wording  " } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onReDelegate).toHaveBeenCalledWith("use ESV wording");
    expect(screen.queryByLabelText("Guidance for re-delegation")).toBeNull();
  });

  it("does not re-delegate on a blank guidance note", () => {
    const onReDelegate = vi.fn();
    render(<CommentThreadCard thread={thread({ reopened: true })} {...noop} onReDelegate={onReDelegate} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReDelegate).not.toHaveBeenCalled();
  });

  it("Cancel disarms the guidance form without calling onReDelegate", () => {
    const onReDelegate = vi.fn();
    render(<CommentThreadCard thread={thread({ reopened: true })} {...noop} onReDelegate={onReDelegate} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Try again — add guidance…" })).toBeTruthy();
    expect(onReDelegate).not.toHaveBeenCalled();
  });
});

describe("comments/CommentThreadCard — finding rendering (FR-REVIEW-2/D6, P2b-5b)", () => {
  it("a severity-tagged thread renders a severity chip carrying both colour and letter", () => {
    render(<CommentThreadCard thread={thread({ severity: "high" })} {...noop} />);
    const chip = screen.getByLabelText("severity: H");
    expect(chip.textContent).toContain("H");
    expect(chip.getAttribute("data-severity")).toBe("H");
  });

  it("a thread with no severity renders no severity chip", () => {
    render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(screen.queryByLabelText(/severity:/)).toBeNull();
  });

  // Review-gate finding on #443: severity is an unvalidated Option<String> on the wire, so an
  // empty string is reachable (distinct from null, which renders no chip at all). It must still
  // carry a non-blank letter — never a bare, unlabelled dot — or the chip satisfies "never colour
  // alone" by accident (no colour or letter) instead of on purpose.
  it("an empty-string severity still renders a chip with a non-blank letter", () => {
    render(<CommentThreadCard thread={thread({ severity: "" })} {...noop} />);
    const chip = screen.getByLabelText("severity: ?");
    expect(chip.textContent?.trim()).not.toBe("●");
    expect(chip.getAttribute("data-severity")).toBe("?");
  });

  // Review finding on PR #613 (#537): the same unvalidated Option<String> can carry an
  // Object.prototype key. When the ratified-spelling table inherited from Object.prototype, this
  // render threw ("Objects are not valid as a React child") and unmounted the tree — so the chip's
  // letter is asserted here at the consumer, not only at severityLetter.
  it("an Object.prototype-keyed severity renders its fallback letter rather than crashing the card", () => {
    render(<CommentThreadCard thread={thread({ severity: "constructor" })} {...noop} />);
    const chip = screen.getByLabelText("severity: C");
    expect(chip.getAttribute("data-severity")).toBe("C");
  });

  it("a thread with a source skill renders the skill name", () => {
    render(<CommentThreadCard thread={thread({ skill: "biblical-accuracy" })} {...noop} />);
    expect(screen.getByText("biblical-accuracy")).toBeTruthy();
  });

  it("a thread with no skill renders no skill label", () => {
    render(<CommentThreadCard thread={thread()} {...noop} />);
    expect(screen.queryByLabelText(/^skill:/)).toBeNull();
  });

  it("renders the finding's body as its recommendation — same as an ordinary comment", () => {
    render(
      <CommentThreadCard
        thread={thread({ severity: "high", skill: "biblical-accuracy", body: "Cite Eph 4:22 correctly" })}
        {...noop}
      />,
    );
    expect(screen.getByText("Cite Eph 4:22 correctly")).toBeTruthy();
  });

  it("it is the same CommentThreadCard rendering path as a plain human comment — no separate finding card", () => {
    // The Open-state test above already proves a plain comment renders through this component;
    // this only pins that a finding-provenance thread renders through the *identical* component
    // with no alternate branch/props shape required.
    render(<CommentThreadCard thread={thread({ severity: "low", skill: "style" })} {...noop} />);
    expect(screen.getByText("Open")).toBeTruthy();
  });
});

describe("comments/CommentThreadCard — deep-link to passage (UX Principle 6, J3 Phase C)", () => {
  const anchoredFinding = thread({
    severity: "high",
    skill: "biblical-accuracy",
    anchor: {
      offset: 12,
      length: 8,
      text_snapshot: "kenosis",
      context_before: "the ",
      context_after: " passage",
      base_revision: "blake3:abc",
    },
  });

  it("clicking the anchored quote carries its full anchor for live passage resolution", () => {
    const onFocusAnchor = vi.fn();
    render(<CommentThreadCard thread={anchoredFinding} {...noop} onFocusAnchor={onFocusAnchor} />);
    fireEvent.click(screen.getByRole("button", { name: /kenosis/ }));
    expect(onFocusAnchor).toHaveBeenCalledWith(anchoredFinding.anchor);
  });

  it("omitting onFocusAnchor still renders the clickable quote, just inert", () => {
    render(<CommentThreadCard thread={anchoredFinding} {...noop} />);
    expect(screen.getByRole("button", { name: /kenosis/ })).toBeTruthy();
  });

  it("a document-level thread (no anchor) has nothing to jump to — no clickable quote", () => {
    const onFocusAnchor = vi.fn();
    render(<CommentThreadCard thread={thread()} {...noop} onFocusAnchor={onFocusAnchor} />);
    expect(screen.queryByRole("button", { name: /kenosis/ })).toBeNull();
    expect(screen.getByText("Document-level")).toBeTruthy();
  });
});

describe("comments/CommentThreadCard — reply-only defense (FR-CMT-4/D20)", () => {
  it("a defense reply is labeled 'defended — no change proposed'", () => {
    const withDefense = thread({
      replies: [
        { id: "r1", parent_id: "c1", author: "agent", body: "the wording is already correct", defense: true, published: false, edited_at: null, withdrawn_at: null },
      ],
    });
    render(<CommentThreadCard thread={withDefense} {...noop} />);
    expect(screen.getByText("defended — no change proposed")).toBeTruthy();
  });

  it("a published defense (external thread) carries the publish chip; an unpublished one doesn't", () => {
    const published = thread({
      replies: [{ id: "r1", parent_id: "c1", author: "agent", body: "correct as written", defense: true, published: true, edited_at: null, withdrawn_at: null }],
    });
    render(<CommentThreadCard thread={published} {...noop} />);
    expect(screen.getByText("published to reviewer")).toBeTruthy();
  });

  it("an unpublished defense never shows the publish chip", () => {
    const unpublished = thread({
      replies: [{ id: "r1", parent_id: "c1", author: "agent", body: "correct as written", defense: true, published: false, edited_at: null, withdrawn_at: null }],
    });
    render(<CommentThreadCard thread={unpublished} {...noop} />);
    expect(screen.queryByText("published to reviewer")).toBeNull();
  });
});

// Issue #2228, ux-design.md §2's acknowledgment ladder (UXR-Q10/#1122, reworded name-free by
// UXR-Q17 — CJ, 2026-09-02). #1778/PR #2184 shipped the ladder's *withdrawing* half: a merely
// targeted thread stops claiming Working and stops offering [Address with AI]. §2 also requires
// the withdrawn affordance to be **replaced** by the rung's own line — "so the request surface is
// never silent" — and that half is what these cover, on the one card-level status slot
// `docs/design/specs/comments.md` `5a.5` already draws.
const RUNG_1 =
  "⏳ Queued behind an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";
const RUNG_1_WORDS = RUNG_1.slice(2);
const RUNG_2 =
  "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";
const RUNG_3 = "Addressing with AI — you can edit or delete this comment once the run finishes.";

describe("comments/CommentThreadCard — acknowledgment ladder rungs 1-2 (issue #2228, ux-design.md §2)", () => {
  const ANCHOR = {
    offset: 0,
    length: 5,
    text_snapshot: "Hello",
    context_before: "",
    context_after: " world",
    base_revision: "blake3:old",
  };

  /** Rung 2 renders, and neither of the other two rungs does. The axis these share is the thread's
   * **own recomputed state**: §2 leaves a rung-1/2 thread's state "unchanged", so the rung has to
   * render over whatever the thread would otherwise present as — and #1778's conformance test held
   * that axis fixed at `open`, which is how the silence reached `main` for the whole ordinary batch
   * path. Each case is a spelled-out `it` rather than an `it.each` row because
   * `scripts/check-test-matrix.mjs` resolves a matrix row against static source text: an
   * interpolated or `%s` title has none to match, so FR traceability could not name it. */
  function expectRung2Over(overrides: Partial<CommentThread>) {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false, ...overrides })}
        {...noop}
      />,
    );
    expect(screen.getByText(RUNG_2)).toBeTruthy();
    expect(screen.queryByText(RUNG_3)).toBeNull();
    expect(screen.queryByText(RUNG_1_WORDS)).toBeNull();
  }

  it("a thread targeted by a live run is never silent over its unchanged open state", () => {
    expectRung2Over({});
  });

  it("a thread targeted by a live run is never silent over its unchanged reopened state", () => {
    expectRung2Over({ reopened: true, linked_changes: [linkedChange("chg-1", { decision: "reject" })] });
  });

  it("a thread targeted by a live run is never silent over its unchanged addressed-pending state", () => {
    expectRung2Over({ linked_changes: [linkedChange("chg-2")] });
  });

  it("a thread targeted by a live run is never silent over its unchanged orphaned state", () => {
    expectRung2Over({ orphaned: true, anchor: ANCHOR });
  });

  it("a thread targeted by a live run is never silent over its unchanged resolved state", () => {
    expectRung2Over({ resolved: true });
  });

  it("renders rung 1, not rung 2, when the run holding this comment is one the queue names", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "queued-1", pending_run_started: false })}
        queuedRunIds={["queued-1"]}
        {...noop}
      />,
    );
    expect(screen.getByText(RUNG_1_WORDS)).toBeTruthy();
    expect(screen.queryByText(RUNG_2)).toBeNull();
  });

  // The near-match the discriminator must reject: a queue with runs in it, none of them this
  // thread's. Rung 1 is claimed on **positive** queue membership only, so an unknown or unrelated
  // queue lands on rung 2 — §2's "a rung is never traded down" makes the lower rung the honest
  // failure direction, never a "queued behind" claim about a run that may already be working.
  it("a queue naming other runs does not make this thread's live run read as queued", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "live-1", pending_run_started: false })}
        queuedRunIds={["queued-9", "queued-10"]}
        {...noop}
      />,
    );
    // The titled claim first: it is the discriminating one, so a mutation that breaks the
    // discrimination must redden *this* line rather than be shadowed by the rung-2 check below it.
    expect(screen.queryByText(RUNG_1_WORDS)).toBeNull();
    expect(screen.getByText(RUNG_2)).toBeTruthy();
  });

  it("a thread with no run at all shows no rung — the ladder acknowledges a request, not the absence of one", () => {
    render(<CommentThreadCard thread={thread()} queuedRunIds={["queued-1"]} {...noop} />);
    expect(screen.queryByText(RUNG_1_WORDS)).toBeNull();
    expect(screen.queryByText(RUNG_2)).toBeNull();
    expect(document.querySelector("[data-ladder-rung]")).toBeNull();
  });

  it("rung 3 (Working) still renders its own ratified line and neither lower rung", () => {
    render(
      <CommentThreadCard thread={thread({ pending_run: "run-1", pending_run_started: true })} {...noop} />,
    );
    expect(screen.getByText(RUNG_3)).toBeTruthy();
    expect(screen.queryByText(RUNG_1_WORDS)).toBeNull();
    expect(screen.queryByText(RUNG_2)).toBeNull();
  });

  it("a permission-waiting address run says so on the thread without duplicating decision controls (J7)", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "run-waiting", pending_run_started: true })}
        permissionRunId="run-waiting"
        {...noop}
      />,
    );

    expect(screen.queryByText("WANTS TO RUN:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(document.querySelector(".comment-thread-card__status-icon svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Waiting on permission")).toBeTruthy();
  });

  // ux-design.md §2: "The active-run status is not governed by state precedence" — the card keeps
  // this status line "regardless of which name it displays", and the exit table names the case:
  // an anchor lost mid-run reads *Orphaned* "and keeps the active-run status line". Reading the
  // block off `resolvedState` dropped it, because `orphaned` outranks `working` there. The axis
  // is the *displayed state name*, which is the axis a rung must be blind to; the rung-2 sweep
  // above varies the same axis one rung down.
  it("a thread that orphans mid-run keeps rung 3's line under the Orphaned name it displays", () => {
    render(
      <CommentThreadCard
        thread={thread({ orphaned: true, anchor: ANCHOR, pending_run: "run-1", pending_run_started: true })}
        {...noop}
      />,
    );
    expect(screen.getByText("Orphaned")).toBeTruthy();
    expect(screen.getByText(RUNG_3)).toBeTruthy();
    expect(screen.queryByText(RUNG_2)).toBeNull();
  });

  it("every rung shares the one status slot 5a.5 draws, rather than growing a second block", () => {
    const { unmount } = render(
      <CommentThreadCard thread={thread({ pending_run: "run-1", pending_run_started: true })} {...noop} />,
    );
    const workingBox = screen.getByText(RUNG_3).parentElement!.parentElement!;
    const workingRule = shippedRuleFor(workingBox);
    unmount();

    render(
      <CommentThreadCard thread={thread({ pending_run: "batch-1", pending_run_started: false })} {...noop} />,
    );
    const rungBox = screen.getByText(RUNG_2).parentElement!.parentElement!;
    expect(workingRule).toMatch(/padding:\s*8px 10px/);
    expect(workingRule).toMatch(/border-radius:\s*6px/);
    expect(shippedRuleFor(rungBox)).toBe(workingRule);
  });

  it("rung 2 carries no glyph at all, because it claims no activity", () => {
    render(
      <CommentThreadCard thread={thread({ pending_run: "batch-1", pending_run_started: false })} {...noop} />,
    );
    const rung = document.querySelector('[data-ladder-rung="targeted"]')!;
    expect(rung.textContent).not.toContain("◔");
    expect(rung.textContent).not.toContain("⏳");
  });

  it("rung 1 carries the hourglass §2's copy gives it, decorative beside words that already say it", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "queued-1", pending_run_started: false })}
        queuedRunIds={["queued-1"]}
        {...noop}
      />,
    );
    const glyph = document.querySelector('[data-ladder-rung="queued"] [aria-hidden="true"]')!;
    expect(glyph.textContent).toBe("⏳");
    expect(document.querySelector('[data-ladder-rung="queued"]')!.textContent).not.toContain("◔");
  });

  // ux-design.md §2, the trap it flags explicitly: correction and closure carry the same phrase in
  // FR-CMT-10/FR-CMT-21 and bind oppositely, and "an implementer who reads one rule off the other
  // gets it backwards in both places". Closure changes no text, so it binds at no rung.
  it("closure stays live at rung 2 — FR-CMT-21(b), refused at no rung of the ladder", () => {
    const onResolve = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false })}
        onReply={vi.fn()}
        onResolve={onResolve}
        onReopen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("closure stays live at rung 1 too — the rung a queued run puts the thread on", () => {
    const onResolve = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "queued-1", pending_run_started: false })}
        queuedRunIds={["queued-1"]}
        onReply={vi.fn()}
        onResolve={onResolve}
        onReopen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("a closure taken before the run reached this thread is reversible at the rung, never a no-op [Resolve]", () => {
    const onReopen = vi.fn();
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false, resolved: true })}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={onReopen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  /** Every control the card offers at a rung, in DOM order. Stated positively — "only these may
   * appear" — rather than as a denylist of the two names §2 happens to spell (`✎`, `Delete`): a
   * denylist passes on the instance and ships the class, since it would not catch a correction
   * affordance introduced under any other label. The axis is **every button the card renders**;
   * the surface is held fixed here and varied in `editor/CommentPopover.test.tsx`. */
  function controlsAtRung(overrides: Partial<CommentThread>): string[] {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false, ...overrides })}
        {...noop}
      />,
    );
    return screen
      .getAllByRole("button")
      .map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/g, " ").trim());
  }

  it("offers no correction affordance at a rung — a document-level thread's whole control set is closure and reply", () => {
    expect(controlsAtRung({})).toEqual(["Resolve", "Reply"]);
  });

  it("offers no correction affordance at a rung — an anchored thread adds only its deep-link", () => {
    // The anchor deep-link is UX Principle 6 navigation, not correction: it moves the caret, never
    // the comment's text — which is the one-word test §2 gives for telling the two classes apart.
    expect(controlsAtRung({ anchor: ANCHOR })).toEqual(["Resolve", "Reply", "“Hello”"]);
  });

  // §2's collapse rule, verbatim: "A thread with a live run is in none of those sets." A resolve
  // taken while a run holds the comment must not collapse the card underneath its own live
  // acknowledgment — "the ladder never withdraws a live acknowledgment".
  it("a resolve taken while a run holds this comment does not collapse the card over its rung", () => {
    render(
      <CommentThreadCard
        thread={thread({ pending_run: "batch-1", pending_run_started: false, resolved: true })}
        {...noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.getByText(RUNG_2)).toBeTruthy();
  });

  it("a resolved thread with no run in flight still collapses by default (P2b-1b unchanged)", () => {
    render(<CommentThreadCard thread={thread({ resolved: true })} {...noop} />);
    expect(screen.getByRole("button", { name: /^Expand/ })).toBeTruthy();
  });
});
