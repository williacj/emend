// @vitest-environment jsdom
// ABOUTME: Confirms the connected comment card wires reply/resolve/address-with-AI to the backend
// ABOUTME: IPC and refreshes its own thread state from the response — `TimelinePanel` itself never
// ABOUTME: touches comments. Address-with-AI also proves the #1721 `start_run` wiring: the id
// ABOUTME: `startRun` returns is the same id `addressWithAI` stamps onto the pending event.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "../comments/types";
import { linkedChange, thread } from "../comments/threadFixture";
import { NO_OPEN_DOCUMENTS, type OpenDocumentsSnapshot } from "./referenceData";
import { createCommentCard } from "./types";

const replyToCommentMock = vi.fn();
const resolveCommentMock = vi.fn();
const reopenCommentMock = vi.fn();
const reAnchorCommentMock = vi.fn();
const reviseCommentMock = vi.fn();
const withdrawCommentMock = vi.fn();
const decideLinkedChangesMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
  reopenComment: (...args: unknown[]) => reopenCommentMock(...args),
  reAnchorComment: (...args: unknown[]) => reAnchorCommentMock(...args),
  reviseComment: (...args: unknown[]) => reviseCommentMock(...args),
  withdrawComment: (...args: unknown[]) => withdrawCommentMock(...args),
  decideLinkedChanges: (...args: unknown[]) => decideLinkedChangesMock(...args),
}));

const startAddressRunMock = vi.fn();
vi.mock("./agentActivity", () => ({
  startAddressRun: (...args: unknown[]) => startAddressRunMock(...args),
}));

const { CommentCard } = await import("./CommentCard");

const THREAD: CommentThread = thread("c1", { body: "please clarify" });

function addressResult(threads: CommentThread[] = [{ ...THREAD, pending_run: "run-1", pending_run_started: true }]) {
  return { run: { id: "run-1", queuedPosition: null }, threads, progress: { addressed: ["c1"], skipped: [], untouched: [], interrupted: null } };
}

describe("timeline/CommentCard", () => {
  beforeEach(() => {
    replyToCommentMock.mockReset();
    resolveCommentMock.mockReset();
    reopenCommentMock.mockReset();
    reAnchorCommentMock.mockReset();
    reviseCommentMock.mockReset();
    withdrawCommentMock.mockReset();
    decideLinkedChangesMock.mockReset();
    startAddressRunMock.mockReset().mockResolvedValue(addressResult());
  });

  it("J10 correction wiring revises own body and removes a private withdrawn card", async () => {
    reviseCommentMock.mockResolvedValueOnce([{ ...THREAD, body: "revised" }]);
    withdrawCommentMock.mockResolvedValueOnce([]);
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    render(<CommentCard card={card} author="alice" now={() => 500} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment body" }), { target: { value: "revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reviseCommentMock).toHaveBeenCalledWith("/project", { kind: "path", path: "doc.md" }, "c1", "revised", 500, undefined));
    expect(await screen.findByText("revised")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(withdrawCommentMock).toHaveBeenCalledWith("/project", { kind: "path", path: "doc.md" }, "c1", 500, undefined));
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
  });

  it("Resolve calls resolveComment with the card's root/path/thread id and re-renders the returned thread", async () => {
    const resolved: CommentThread = { ...THREAD, resolved: true };
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    const card = createCommentCard("/project", "doc.md", THREAD, {
      id: "card-1",
      timestamp: "2026-07-17T00:00:00.000Z",
    });

    render(<CommentCard card={card} author="alice" now={() => 100} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "doc.md", "c1", "alice", 100);
    expect(await screen.findByText("Resolved")).toBeTruthy();
  });

  it("Reply calls replyToComment with the typed body and both flags false", async () => {
    replyToCommentMock.mockResolvedValueOnce([
      {
        ...THREAD,
        replies: [{ id: "r1", parent_id: "c1", author: "alice", body: "on it", defense: false, published: false, edited_at: null, withdrawn_at: null }],
      },
    ]);
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });

    render(<CommentCard card={card} author="alice" now={() => 200} />);
    fireEvent.change(screen.getByLabelText("Reply to alice's comment"), { target: { value: "on it" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(replyToCommentMock).toHaveBeenCalledWith(
      "/project",
      "doc.md",
      "c1",
      "alice",
      "on it",
      false,
      false,
      200,
    );
    expect(await screen.findByText("on it")).toBeTruthy();
  });

  it("defaults the acting author to 'you' when none is given", () => {
    resolveCommentMock.mockResolvedValueOnce([THREAD]);
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });

    render(<CommentCard card={card} now={() => 0} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "doc.md", "c1", "you", 0);
  });

  // FR-CMT-10: one backend command admits the Address event and the queued run together.
  it("Address with AI submits one atomic request and renders its returned thread", async () => {
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    const onAddressRunStarted = vi.fn();
    render(<CommentCard card={card} author="alice" now={() => 300} onAddressRunStarted={onAddressRunStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "doc.md", ["c1"], "alice", 300, expect.any(String), false, null,
      { openDocuments: NO_OPEN_DOCUMENTS },
    ));
    expect(await screen.findByText("Addressing with AI — you can edit or delete this comment once the run finishes.")).toBeTruthy();
    expect(onAddressRunStarted).toHaveBeenCalledWith("/project", { id: "run-1", queuedPosition: null });
  });

  it("holds correction during atomic Address admission before a run ID exists", async () => {
    let admit!: (result: ReturnType<typeof addressResult>) => void;
    startAddressRunMock.mockReturnValueOnce(new Promise((resolve) => { admit = resolve; }));
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    render(<CommentCard card={card} author="alice" />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeDisabled();
    admit(addressResult());
    expect(await screen.findByText("Addressing with AI — you can edit or delete this comment once the run finishes.")).toBeTruthy();
  });

  it("reads the live open-document set when submitting the atomic Address request", async () => {
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    let open: OpenDocumentsSnapshot = NO_OPEN_DOCUMENTS;
    render(<CommentCard card={card} author="alice" now={() => 300} openDocuments={() => open} />);
    open = { active: { path: "doc.md", dirty: true, content: "live buffer" }, alsoOpen: [] };
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "doc.md", ["c1"], "alice", 300, expect.any(String), false, null,
      { openDocuments: open },
    ));
  });

  it("4e accepted comment run link uses the single submit snapshot even when the buffer changes before admission", async () => {
    let admit!: (result: ReturnType<typeof addressResult>) => void;
    startAddressRunMock.mockReturnValueOnce(new Promise((resolve) => { admit = resolve; }));
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    const onRunLink = vi.fn();
    const submitted: OpenDocumentsSnapshot = {
      active: { path: "doc.md", dirty: true, content: "unsaved at submit" }, alsoOpen: [],
    };
    let open = submitted;
    const openDocuments = vi.fn(() => open);
    render(<CommentCard card={card} openDocuments={openDocuments} onRunLink={onRunLink} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    open = { active: { path: "doc.md", dirty: false }, alsoOpen: [] };
    expect(onRunLink).not.toHaveBeenCalled();
    admit(addressResult());
    await waitFor(() => expect(onRunLink).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", sentText: true }));
    expect(openDocuments).toHaveBeenCalledTimes(1);
    expect(startAddressRunMock.mock.calls[0][8]).toEqual({ openDocuments: submitted });
  });

  it("4e accepted comment run link is absent when no run was admitted", async () => {
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    const onRunLink = vi.fn();
    startAddressRunMock.mockResolvedValueOnce({ ...addressResult(), run: null, threads: [THREAD] });
    render(<CommentCard card={card} onRunLink={onRunLink} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledTimes(1));
    expect(onRunLink).not.toHaveBeenCalled();
  });

  it("re-delegates with guidance in the single atomic request and prompt", async () => {
    const reopened = { ...THREAD, reopened: true };
    startAddressRunMock.mockResolvedValueOnce(addressResult([{ ...reopened, pending_run: "run-1", pending_run_started: true }]));
    const card = createCommentCard("/project", "doc.md", reopened, { id: "card-1" });
    render(<CommentCard card={card} author="alice" now={() => 400} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    fireEvent.change(screen.getByLabelText("Guidance for re-delegation"), { target: { value: "use ESV wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "doc.md", ["c1"], "alice", 400, expect.stringContaining("use ESV wording"),
      false, "use ESV wording", { openDocuments: NO_OPEN_DOCUMENTS },
    ));
  });

  it("keeps Address available and reports a rejected admission to its owner", async () => {
    const rejection = { kind: "InvalidArguments", message: "target escapes the project root" };
    startAddressRunMock.mockRejectedValueOnce(rejection);
    const onAddressRunFailed = vi.fn();
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    render(<CommentCard card={card} author="alice" now={() => 300} onAddressRunFailed={onAddressRunFailed} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(onAddressRunFailed).toHaveBeenCalledWith("/project", rejection));
    expect(screen.getByRole("button", { name: "Address with AI" })).toBeTruthy();
    expect(onAddressRunFailed).toHaveBeenCalledTimes(1);
  });

  it("reports no failure after a successful atomic admission", async () => {
    const onAddressRunFailed = vi.fn();
    const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });
    render(<CommentCard card={card} author="alice" now={() => 300} onAddressRunFailed={onAddressRunFailed} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    expect(await screen.findByText("Addressing with AI — you can edit or delete this comment once the run finishes.")).toBeTruthy();
    expect(onAddressRunFailed).not.toHaveBeenCalled();
  });

  it("[Accept both] calls decideLinkedChanges with every undecided linked id and 'accept'", async () => {
    const withLinks = {
      ...THREAD,
      linked_changes: [linkedChange("chg-1"), linkedChange("chg-2")],
    };
    decideLinkedChangesMock.mockResolvedValueOnce([{ ...withLinks, resolved: true }]);
    const card = createCommentCard("/project", "doc.md", withLinks, { id: "card-1" });

    render(<CommentCard card={card} author="alice" now={() => 500} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept both" }));

    expect(decideLinkedChangesMock).toHaveBeenCalledWith(
      "/project",
      "doc.md",
      "c1",
      "alice",
      500,
      ["chg-1", "chg-2"],
      "accept",
    );
    expect(await screen.findByText("Resolved")).toBeTruthy();
  });

  // #411: given the owner's shared array (+ a way to write back), this card must never keep its
  // own copy — that is exactly the `useState(card.thread)`-seeds-once trap the issue names.
  describe("single-owner mode (#411 — threads + onThreadsChange supplied together)", () => {
    it("renders the thread found in the shared threads array by id — not card.thread", () => {
      const resolvedElsewhere: CommentThread = { ...THREAD, resolved: true };
      const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });

      render(
        <CommentCard
          card={card}
          threads={[resolvedElsewhere]}
          onThreadsChange={() => {}}
          author="alice"
          now={() => 0}
        />,
      );

      // `card.thread` (seeded at card-creation time) says open; the shared array — updated since,
      // by something else entirely — says resolved. The shared array wins.
      expect(screen.getByText("Resolved")).toBeTruthy();
    });

    it("reports a mutation's result up through onThreadsChange instead of keeping its own copy", async () => {
      const resolved: CommentThread = { ...THREAD, resolved: true };
      resolveCommentMock.mockResolvedValueOnce([resolved]);
      const onThreadsChange = vi.fn();
      const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });

      render(
        <CommentCard card={card} threads={[THREAD]} onThreadsChange={onThreadsChange} author="alice" now={() => 0} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

      await vi.waitFor(() => expect(onThreadsChange).toHaveBeenCalledWith([resolved]));
    });

    it("falls back to card.thread when the shared array doesn't (yet) carry this card's thread id", () => {
      const card = createCommentCard("/project", "doc.md", THREAD, { id: "card-1" });

      render(<CommentCard card={card} threads={[]} onThreadsChange={() => {}} author="alice" now={() => 0} />);

      expect(screen.getByText("please clarify")).toBeTruthy();
    });

    // FR-CMT-3/FR-CMT-7: the single-owner path is `applyUpdated`, shared by every mutation this
    // card dispatches — not special-cased to Resolve. Pinned here against the linked-changes
    // decision path (deciding a linked change resolves/reopens the thread, FR-CMT-3) so both FRs
    // this card touches are actually exercised in owned mode, not just asserted by extrapolation.
    it("reports a decideLinkedChanges mutation result up through onThreadsChange too (FR-CMT-3/FR-CMT-7)", async () => {
      const withLinks: CommentThread = {
        ...THREAD,
        linked_changes: [linkedChange("chg-1")],
      };
      const resolved: CommentThread = { ...withLinks, resolved: true };
      decideLinkedChangesMock.mockResolvedValueOnce([resolved]);
      const onThreadsChange = vi.fn();
      const card = createCommentCard("/project", "doc.md", withLinks, { id: "card-1" });

      render(
        <CommentCard
          card={card}
          threads={[withLinks]}
          onThreadsChange={onThreadsChange}
          author="alice"
          now={() => 0}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));

      await vi.waitFor(() => expect(onThreadsChange).toHaveBeenCalledWith([resolved]));
    });
  });

  it("passes onFocusAnchor straight through to the underlying CommentThreadCard (P2b-5b deep-link)", () => {
    const onFocusAnchor = vi.fn();
    const anchored: CommentThread = {
      ...THREAD,
      severity: "high",
      skill: "biblical-accuracy",
      anchor: {
        offset: 3,
        length: 4,
        text_snapshot: "kenosis",
        context_before: "",
        context_after: "",
        base_revision: "blake3:abc",
      },
    };
    const card = createCommentCard("/project", "doc.md", anchored, { id: "card-1" });

    render(<CommentCard card={card} author="alice" now={() => 0} onFocusAnchor={onFocusAnchor} />);
    fireEvent.click(screen.getByRole("button", { name: /kenosis/ }));

    expect(onFocusAnchor).toHaveBeenCalledWith(anchored.anchor);
  });
});
