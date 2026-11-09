// @vitest-environment jsdom
// ABOUTME: Covers the editor-anchored comment popover (#259, J4, FR-CMT-2): create mode wires
// ABOUTME: `comments/CommentComposer` to `createComment` (anchored and document-level), view mode
// ABOUTME: wires `comments/CommentThreadCard`'s action set to `comments/ipc.ts` exactly as
// ABOUTME: `timeline/CommentCard` does, and Escape/close never trap the popover open (J1).
// ABOUTME: Address-with-AI also proves the #1721 `start_run` wiring — see `timeline/CommentCard.test.tsx`'s
// ABOUTME: identical coverage for the sibling surface.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "../comments/types";
import { linkedChange } from "../comments/threadFixture";
import { NO_OPEN_DOCUMENTS, type OpenDocumentsSnapshot } from "../timeline/referenceData";

const createCommentMock = vi.fn();
const replyToCommentMock = vi.fn();
const resolveCommentMock = vi.fn();
const reopenCommentMock = vi.fn();
const reAnchorCommentMock = vi.fn();
const reviseCommentMock = vi.fn();
const withdrawCommentMock = vi.fn();
const decideLinkedChangesMock = vi.fn();
vi.mock("../comments/ipc", () => ({
  createComment: (...args: unknown[]) => createCommentMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
  reopenComment: (...args: unknown[]) => reopenCommentMock(...args),
  reAnchorComment: (...args: unknown[]) => reAnchorCommentMock(...args),
  reviseComment: (...args: unknown[]) => reviseCommentMock(...args),
  withdrawComment: (...args: unknown[]) => withdrawCommentMock(...args),
  decideLinkedChanges: (...args: unknown[]) => decideLinkedChangesMock(...args),
}));

const startAddressRunMock = vi.fn();
vi.mock("../timeline/agentActivity", () => ({
  startAddressRun: (...args: unknown[]) => startAddressRunMock(...args),
}));

const { CommentPopover } = await import("./CommentPopover");

const THREAD: CommentThread = {
  id: "c1",
  author: "alice",
  last_activity_at: 0,
  anchor: {
    offset: 4,
    length: 5,
    text_snapshot: "world",
    context_before: "hello ",
    context_after: "",
    base_revision: "r0",
  },
  body: "please clarify",
  edited_at: null,
  withdrawn_at: null,
  published: false,
  visible_when_withdrawn: false,
  targeting_run_ids: [],
  resolved: false,
  orphaned: false,
  reopened: false,
  replies: [],
  severity: null,
  skill: null,
  workflow_run: null,
  pending_run: null,
    pending_runs: [],
  pending_run_started: false,
  pending_guidance: null,
  concluded_run: null,
  linked_changes: [],
};

function addressResult(threads: CommentThread[] = [{ ...THREAD, pending_run: "run-1", pending_run_started: true }]) {
  return { run: { id: "run-1", queuedPosition: null }, threads, progress: { addressed: ["c1"], skipped: [], untouched: [], interrupted: null } };
}

describe("editor/CommentPopover — create mode", () => {
  beforeEach(() => {
    createCommentMock.mockReset();
  });

  it("shows the composer with the selection preview when creating an anchored comment", () => {
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{
          kind: "create",
          selection: { offset: 0, length: 5, preview: "hello", content: "hello world" },
        }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Commenting on: “hello”")).toBeTruthy();
  });

  it("shows the document-level label when creating with no selection", () => {
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "create", selection: null }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Document-level comment")).toBeTruthy();
  });

  it("submitting an anchored comment calls createComment with the selection's live content and UTF-16 range and closes", async () => {
    createCommentMock.mockResolvedValueOnce([THREAD]);
    const onThreadsChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        author="alice"
        now={() => 100}
        target={{
          kind: "create",
          selection: { offset: 4, length: 5, preview: "world", content: "hello world" },
        }}
        onThreadsChanged={onThreadsChanged}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "nice word" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith(
      "/project",
      "a.md",
      "alice",
      "nice word",
      { content: "hello world", utf16Offset: 4, utf16Length: 5 },
      100,
    );
    await vi.waitFor(() => expect(onThreadsChanged).toHaveBeenCalledWith([THREAD]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submitting a document-level comment calls createComment with a null anchor", async () => {
    createCommentMock.mockResolvedValueOnce([THREAD]);
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        author="alice"
        now={() => 200}
        target={{ kind: "create", selection: null }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "a note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith("/project", "a.md", "alice", "a note", null, 200);
  });

  it("defaults the acting author to 'you' when none is given", () => {
    createCommentMock.mockResolvedValueOnce([THREAD]);
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        now={() => 0}
        target={{ kind: "create", selection: null }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "a note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(createCommentMock).toHaveBeenCalledWith("/project", "a.md", "you", "a note", null, 0);
  });

  it("Cancel calls onClose without creating anything", () => {
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "create", selection: null }}
        onThreadsChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createCommentMock).not.toHaveBeenCalled();
  });
});

describe("editor/CommentPopover — view mode", () => {
  it("#2574 forwards a reachable passage route with the full anchor", () => {
    const onFocusAnchor = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice"
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()}
      onFocusAnchor={onFocusAnchor} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "“world”" }));

    expect(onFocusAnchor).toHaveBeenCalledWith(THREAD.anchor);
  });

  it("refreshes an open same-ID thread and closes when that thread is withdrawn", () => {
    const onClose = vi.fn();
    const { rerender } = render(<CommentPopover root="/project" path="a.md" author="alice"
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()} onClose={onClose} />);
    const revised = { ...THREAD, body: "new body", replies: [{ id: "r1", parent_id: THREAD.id, author: "bob", body: "late", defense: false, published: false, edited_at: null, withdrawn_at: null }] };
    rerender(<CommentPopover root="/project" path="a.md" author="alice"
      target={{ kind: "view", thread: revised }} onThreadsChanged={vi.fn()} onClose={onClose} />);
    expect(screen.getByText("new body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    rerender(<CommentPopover root="/project" path="a.md" author="alice"
      target={{ kind: "view", thread: { ...revised, withdrawn_at: 5, visible_when_withdrawn: true } }} onThreadsChanged={vi.fn()} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape cancels inline Delete while keeping the containing popover open", () => {
    const onClose = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice"
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Escape" });
    expect(screen.queryByText("Delete this comment?")).toBeNull();
    expect(screen.getByText("please clarify")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

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

  it("J10 correction wiring revises own body and closes after private withdrawal", async () => {
    reviseCommentMock.mockResolvedValueOnce([{ ...THREAD, body: "revised" }]);
    withdrawCommentMock.mockResolvedValueOnce([]);
    const onClose = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 500}
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment body" }), { target: { value: "revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reviseCommentMock).toHaveBeenCalledWith("/project", { kind: "path", path: "a.md" }, "c1", "revised", 500, undefined));
    expect(await screen.findByText("revised")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(withdrawCommentMock).toHaveBeenCalledWith("/project", { kind: "path", path: "a.md" }, "c1", 500, undefined));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("renders the given thread via CommentThreadCard", () => {
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("please clarify")).toBeTruthy();
  });

  it("Resolve calls resolveComment and re-renders the returned thread — reporting the full list up", async () => {
    const resolved: CommentThread = { ...THREAD, resolved: true };
    resolveCommentMock.mockResolvedValueOnce([resolved]);
    const onThreadsChanged = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        author="alice"
        now={() => 100}
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={onThreadsChanged}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(resolveCommentMock).toHaveBeenCalledWith("/project", "a.md", "c1", "alice", 100);
    expect(await screen.findByText("Resolved")).toBeTruthy();
    expect(onThreadsChanged).toHaveBeenCalledWith([resolved]);
  });

  it("Reply calls replyToComment with the typed body and both flags false", async () => {
    replyToCommentMock.mockResolvedValueOnce([
      { ...THREAD, replies: [{ id: "r1", parent_id: "c1", author: "alice", body: "on it", defense: false, published: false, edited_at: null, withdrawn_at: null }] },
    ]);
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        author="alice"
        now={() => 200}
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reply to alice's comment"), { target: { value: "on it" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(replyToCommentMock).toHaveBeenCalledWith("/project", "a.md", "c1", "alice", "on it", false, false, 200);
    expect(await screen.findByText("on it")).toBeTruthy();
  });

  it("submits one atomic Address request and renders the returned thread", async () => {
    const onAddressRunStarted = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 300}
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()} onClose={vi.fn()} onAddressRunStarted={onAddressRunStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "a.md", ["c1"], "alice", 300, expect.any(String), false, null,
      { openDocuments: NO_OPEN_DOCUMENTS },
    ));
    expect(await screen.findByText("Addressing with AI — you can edit or delete this comment once the run finishes.")).toBeTruthy();
    expect(onAddressRunStarted).toHaveBeenCalledWith("/project", { id: "run-1", queuedPosition: null });
  });

  it("reads the live open-document set when submitting the atomic Address request", async () => {
    let open: OpenDocumentsSnapshot = NO_OPEN_DOCUMENTS;
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 300}
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()} openDocuments={() => open} onClose={vi.fn()} />);
    open = { active: { path: "a.md", dirty: true, content: "live buffer" }, alsoOpen: [] };
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "a.md", ["c1"], "alice", 300, expect.any(String), false, null,
      { openDocuments: open },
    ));
  });

  it("J13 popover link uses the submitted D31 snapshot across delayed admission", async () => {
    let release!: (result: ReturnType<typeof addressResult>) => void;
    startAddressRunMock.mockReturnValueOnce(new Promise<ReturnType<typeof addressResult>>((resolve) => { release = resolve; }));
    const submitted: OpenDocumentsSnapshot = {
      active: { path: "a.md", dirty: true, content: "unsaved at submit" }, alsoOpen: [],
    };
    let current = submitted;
    const openDocuments = vi.fn(() => current);
    const onCommentRunLink = vi.fn();
    render(<CommentPopover root="/project" path="a.md" now={() => 300} target={{ kind: "view", thread: THREAD }}
      onThreadsChanged={vi.fn()} onClose={vi.fn()} openDocuments={openDocuments}
      onCommentRunLink={onCommentRunLink} />);

    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "a.md", ["c1"], "you", 300, expect.any(String), false, null,
      { openDocuments: submitted },
    ));
    current = { active: { path: "a.md", dirty: false }, alsoOpen: [] };
    release(addressResult([THREAD]));
    await waitFor(() => expect(onCommentRunLink).toHaveBeenCalledWith(
      "/project", { kind: "path", path: "a.md" }, "c1", { runId: "run-1", sentText: true },
    ));
    expect(openDocuments).toHaveBeenCalledTimes(1);
  });

  it("J13 popover link stays absent for a run-less admission", async () => {
    startAddressRunMock.mockResolvedValueOnce({ ...addressResult([THREAD]), run: null });
    const onCommentRunLink = vi.fn();
    render(<CommentPopover root="/project" path="a.md" target={{ kind: "view", thread: THREAD }}
      onThreadsChanged={vi.fn()} onClose={vi.fn()} onCommentRunLink={onCommentRunLink} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Address with AI" })).toBeEnabled());
    expect(onCommentRunLink).not.toHaveBeenCalled();
  });

  it("re-delegates with guidance through one atomic Address request", async () => {
    const reopened: CommentThread = { ...THREAD, reopened: true };
    startAddressRunMock.mockResolvedValueOnce(addressResult([{ ...reopened, pending_run: "run-1", pending_run_started: true }]));
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 400}
      target={{ kind: "view", thread: reopened }} onThreadsChanged={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again — add guidance…" }));
    fireEvent.change(screen.getByLabelText("Guidance for re-delegation"), { target: { value: "use ESV wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(startAddressRunMock).toHaveBeenCalledWith(
      "/project", "a.md", ["c1"], "alice", 400, expect.stringContaining("use ESV wording"),
      false, "use ESV wording", { openDocuments: NO_OPEN_DOCUMENTS },
    ));
  });

  it("keeps Address available and reports rejected admission to its owner", async () => {
    const rejection = { kind: "InvalidArguments", message: "target escapes the project root" };
    startAddressRunMock.mockRejectedValueOnce(rejection);
    const onAddressRunFailed = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 300}
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()}
      onAddressRunFailed={onAddressRunFailed} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    await waitFor(() => expect(onAddressRunFailed).toHaveBeenCalledWith("/project", rejection));
    expect(screen.getByRole("button", { name: "Address with AI" })).toBeTruthy();
    expect(onAddressRunFailed).toHaveBeenCalledTimes(1);
  });

  it("reports no failure after successful atomic admission", async () => {
    const onAddressRunFailed = vi.fn();
    render(<CommentPopover root="/project" path="a.md" author="alice" now={() => 300}
      target={{ kind: "view", thread: THREAD }} onThreadsChanged={vi.fn()}
      onAddressRunFailed={onAddressRunFailed} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Address with AI" }));
    expect(await screen.findByText("Addressing with AI — you can edit or delete this comment once the run finishes.")).toBeTruthy();
    expect(onAddressRunFailed).not.toHaveBeenCalled();
  });

  it("Reopen re-anchors and decides linked changes exactly like timeline/CommentCard's identical wiring", async () => {
    const withLinks: CommentThread = {
      ...THREAD,
      linked_changes: [linkedChange("chg-1")],
    };
    decideLinkedChangesMock.mockResolvedValueOnce([{ ...withLinks, resolved: true }]);
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        author="alice"
        now={() => 400}
        target={{ kind: "view", thread: withLinks }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(decideLinkedChangesMock).toHaveBeenCalledWith(
      "/project",
      "a.md",
      "c1",
      "alice",
      400,
      ["chg-1"],
      "accept",
    );
    expect(await screen.findByText("Resolved")).toBeTruthy();
  });

  it("switching to a different thread target resets the displayed thread", () => {
    const other: CommentThread = { ...THREAD, id: "c2", body: "a second thread" };
    const { rerender } = render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("please clarify")).toBeTruthy();

    rerender(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: other }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("a second thread")).toBeTruthy();
    expect(screen.queryByText("please clarify")).toBeNull();
  });
});

describe("editor/CommentPopover — dismissal (J1: no mode required)", () => {
  it("the close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses itself on open so Escape is reachable without anything else in the dialog autofocusing (PR #495 review Important #3)", () => {
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    // The dialog itself, not any control inside it, holds focus once mounted — nothing here
    // autofocuses (neither `CommentComposer` nor `CommentThreadCard` does), so without this the
    // popover unmounting the trigger/highlight the user just clicked would drop focus to `<body>`.
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("Escape dismisses from the real post-open focus state not just when fired directly on the dialog node", () => {
    const onClose = vi.fn();
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    // Dispatches the keydown at whatever currently holds focus (`document.activeElement`), the way
    // a real keystroke would, rather than targeting the dialog node directly by test id/role — the
    // gap this pins is exactly "the handler runs when told to, but a real Escape keystroke never
    // reaches it" (PR #495 review, Important #3).
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Issue #2228, ux-design.md §2's acknowledgment ladder: the rule binds "on whichever surface it
// appears", and §2 names this one explicitly — "the comment popover shows the rung exactly as the
// timeline card does". The rung's own derivation and copy are covered once in
// `comments/CommentThreadCard.test.tsx`; what these pin is that this surface is not the silent
// one, which is the half a per-component test cannot see.
describe("editor/CommentPopover — acknowledgment ladder (issue #2228, ux-design.md §2)", () => {
  const RUNG_2 =
    "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";

  it("states the rung in place of the [Address with AI] it withdraws, rather than falling silent", () => {
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{
          kind: "view",
          thread: { ...THREAD, pending_run: "batch-1", pending_run_started: false },
        }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(RUNG_2)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Address with AI" })).toBeNull();
  });

  it("keeps closure live on this surface too — FR-CMT-21(b) binds at no rung", async () => {
    resolveCommentMock.mockResolvedValue([]);
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{
          kind: "view",
          thread: { ...THREAD, pending_run: "batch-1", pending_run_started: false },
        }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(resolveCommentMock).toHaveBeenCalledTimes(1));
  });

  it("shows no rung on a thread no run holds", () => {
    render(
      <CommentPopover
        root="/project"
        path="a.md"
        target={{ kind: "view", thread: THREAD }}
        onThreadsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(RUNG_2)).toBeNull();
    expect(screen.getByRole("button", { name: "Address with AI" })).toBeTruthy();
  });
});
