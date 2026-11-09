// @vitest-environment jsdom
// ABOUTME: Pins #1120's fix directly: `createCommentCard` (types.ts) had no production caller, so
// ABOUTME: a created or loaded comment thread never became a card and the Comments/Findings facets
// ABOUTME: stayed empty forever. This panel is the single owner of `commentThreads` (#411) and is
// ABOUTME: therefore the one place a thread can be folded into the stream it also renders.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { linkedChange, thread } from "../comments/threadFixture";
import { TimelinePanel, foldCommentThreads } from "./TimelinePanel";
import { createAgentWorkingCard, createCommentCard } from "./types";

describe("timeline/TimelinePanel — comment-thread materialization (#1120)", () => {
  it("discloses a partially delivered but still targeted thread in the batch chooser", () => {
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[
      thread("a", { targeting_run_ids: ["run-1"], pending_run: null }),
      thread("b"),
    ]} initialCards={[createAgentWorkingCard({ id: "run-1", phase: { phase: "running" }, activity: [], elapsedSecs: 0 })]} />);

    fireEvent.click(screen.getByRole("button", { name: /Address all/ }));
    expect(screen.getByText(/2 open comments · 1 already in an agent run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Address 1 comment" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Address with AI" })).toHaveLength(1);
  });
  it("J10 private withdrawal removes a card omitted from the same document's fold", () => {
    const card = createCommentCard("/project", "doc.md", thread("a"));
    expect(foldCommentThreads([card], [], "/project", { kind: "path", path: "doc.md" }, { mint: true })).toEqual([]);
    expect(foldCommentThreads([card], [], "/project", { kind: "path", path: "other.md" }, { mint: true })).toEqual([card]);
  });
  it("builds a comment card for a thread the commentThreads prop carries, with no owner-built card required", () => {
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />);

    const card = document.querySelector('[data-card-kind="comment"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-card-id")).toBe("a");
    expect(screen.getByText("finding a")).toBeTruthy();
  });

  it("materializes an ID-owned untitled thread without batch, agent, or linked-decision controls", () => {
    const linked = thread("a", {
      linked_changes: [{
        change_id: "chg-1",
        decision: null,
        delivery_id: "delivery-1",
        run_id: null,
        delivered_at: 1,
      }],
    });
    render(
      <TimelinePanel
        root="/project"
        commentOwner={{ kind: "id", docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3", label: "Untitled" }}
        commentThreads={[linked]}
      />,
    );

    expect(screen.getByText("finding a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Address with AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Address all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("routes a pathless timeline comment's linked change through its document ID", () => {
    const focus = vi.fn().mockReturnValue(true);
    render(<TimelinePanel root="/project"
      commentOwner={{ kind: "id", docId: "doc-1", label: "Untitled" }}
      commentThreads={[thread("a", { author: "you", linked_changes: [linkedChange("chg-1")] })]}
      onFocusPathlessCommentChange={focus} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to changes" }));
    expect(focus).toHaveBeenCalledWith("/project", "doc-1", "chg-1");
  });

  it("is visible under both All and Comments — the facet this defect left permanently empty", () => {
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />);

    expect(screen.getByText("finding a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByText("finding a")).toBeTruthy();
  });

  it("routes a thread carrying review provenance to the Findings facet — falls out of the same materialization", () => {
    const finding = thread("f1", { severity: "high", skill: "biblical-accuracy", body: "Cite it correctly" });
    render(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[finding]} />);

    fireEvent.click(screen.getByRole("button", { name: "Findings" }));
    expect(screen.getByText("Cite it correctly")).toBeTruthy();
  });

  it("does not duplicate a card when an identical-content commentThreads array re-seeds with a new identity", () => {
    const { rerender } = render(
      <TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />,
    );
    expect(document.querySelectorAll('[data-card-kind="comment"]')).toHaveLength(1);

    // A fresh array instance, same thread content — exactly what the owner's own re-seed
    // effect (`if (commentThreads) setThreads(commentThreads)`) hands this materialization
    // every time `App` re-renders with the document's already-loaded threads.
    rerender(<TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />);

    expect(document.querySelectorAll('[data-card-kind="comment"]')).toHaveLength(1);
  });

  it("adds a card for a newly-arrived thread without re-minting the one already materialized", () => {
    const { rerender } = render(
      <TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />,
    );

    rerender(
      <TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a"), thread("b")]} />,
    );

    const cards = document.querySelectorAll('[data-card-kind="comment"]');
    expect(cards).toHaveLength(2);
    expect(screen.getByText("finding a")).toBeTruthy();
    expect(screen.getByText("finding b")).toBeTruthy();
  });

  it("keeps a single card for a thread across a content-only mutation reaching it through the same prop", () => {
    const { rerender } = render(
      <TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />,
    );
    expect(screen.getByText("Open")).toBeTruthy();

    rerender(
      <TimelinePanel
        root="/project"
        commentPath="doc.md"
        commentThreads={[thread("a", { resolved: true })]}
      />,
    );

    expect(document.querySelectorAll('[data-card-kind="comment"]')).toHaveLength(1);
    expect(screen.getByText("Resolved")).toBeTruthy();
  });

  it("never materializes without both root and commentPath — the same degrade every comment prop already follows", () => {
    render(<TimelinePanel commentThreads={[thread("a")]} />);

    expect(document.querySelector('[data-card-kind="comment"]')).toBeNull();
  });

  // Round-2 review finding 1 (PR #1329): the fold used to leave an already-materialized card's
  // `.thread` snapshot untouched forever, trusting the shared `threads` prop to carry live state.
  // That holds only while the thread is still in `threads` — `App` clears `commentThreads` to `[]`
  // synchronously on every active-document change (`App.tsx`'s #498 round-1 fix), which re-seeds
  // this panel's own `threads` to `[]` too, so `CommentCard`'s `findSelf(threads, id) ?? card.thread`
  // fallback lands on the stale snapshot from materialization time. The fold must refresh a card's
  // `.thread` on every pass that still carries it — matching `foldRunStatus`'s identical
  // update-or-append shape one screen up — so the last-known state survives `threads` emptying out.
  it("keeps a materialized card's last-known state once the shared threads array stops carrying it (#1120 round 2, finding 1)", () => {
    const { rerender } = render(
      <TimelinePanel root="/project" commentPath="doc.md" commentThreads={[thread("a")]} />,
    );
    expect(screen.getByText("Open")).toBeTruthy();

    // The thread resolves while still covered by `threads` (a sibling card's own mutation, a batch
    // run, or this card's own — any of the three sources `threads`' own re-seed effect documents).
    rerender(
      <TimelinePanel
        root="/project"
        commentPath="doc.md"
        commentThreads={[thread("a", { resolved: true })]}
      />,
    );
    expect(screen.getByText("Resolved")).toBeTruthy();

    // The active document changes — the owner clears `commentThreads` to `[]` synchronously, before
    // any new document's threads have loaded (App.tsx's own #498 round-1 clearing effect).
    rerender(<TimelinePanel root="/project" commentPath="other.md" commentThreads={[]} />);

    // The card must still show the resolved state it last had while covered, not regress to the
    // "Open" snapshot `createCommentCard` built it with.
    expect(document.querySelectorAll('[data-card-kind="comment"]')).toHaveLength(1);
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });
});
