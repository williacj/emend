// @vitest-environment jsdom
// ABOUTME: EditorShell behaviors that only exist on React's own scheduling around Missing state
// ABOUTME: commits — an entry-time dismissal (#1780) and an exit-time disk read (#1595).
//
// Why this is not in `EditorShell.test.tsx`: importing `@testing-library/react` turns on React's act
// environment for the whole file, and `act` flushes a commit and its passive effects together. The
// window under test is precisely the gap *between* those two, which production has (passive effects
// are scheduled on a task, so a promise continuation beats them) and `act` by construction does not.
// A cell written over there passes whether or not the guard exists, which is worse than no cell.
// Everything else about the write pause is covered in that file, in its idiom.
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useLayoutEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDocumentMock = vi.fn();
const saveDocumentMock = vi.fn();
const recreateCapabilityMock = vi.fn(async (path: string) => ({
  path,
  status: "confinement_unavailable" as const,
}));
vi.mock("./ipc", () => ({
  openDocument: (...args: unknown[]) => openDocumentMock(...args),
  saveDocument: (...args: unknown[]) => saveDocumentMock(...args),
  saveDocumentAs: vi.fn(),
  recreateMissingDocumentCapability: (path: string) => recreateCapabilityMock(path),
  recreateMissingDocument: vi.fn(),
  parseChanges: vi.fn(async () => []),
  captureAnchor: vi.fn(),
  resolveAnchor: vi.fn(),
}));
vi.mock("../comments/ipc", () => ({
  loadCommentThreads: vi.fn(),
  createComment: vi.fn(),
  replyToComment: vi.fn(),
  resolveComment: vi.fn(),
  reopenComment: vi.fn(),
  reAnchorComment: vi.fn(),
  addressWithAI: vi.fn(),
  decideLinkedChanges: vi.fn(),
}));

const { EditorShell } = await import("./EditorShell");

/** Every wait here is condition-based; only the budget is stated, never a sleep. */
const WAIT = { timeout: 5_000, interval: 10 } as const;

/** A promise this test settles by hand — the disk read, held open across the transition. */
function heldRead() {
  let settle!: (payload: { content: string; revision: string }) => void;
  const promise = new Promise<{ content: string; revision: string }>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Settles the held read from a layout effect, which React runs inside the commit — ahead of every
 * passive effect. That is what places the read's continuation in the window under test rather than
 * before or after it.
 */
function SettleDuringCommit({ settle }: { settle: () => void }) {
  useLayoutEffect(settle, [settle]);
  return null;
}

/** Emulates a fast author action after the Missing DOM commits but before its passive effect. */
function DismissMissingDuringCommit({ container }: { container: HTMLElement }) {
  useLayoutEffect(() => {
    const keepEditing = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Keep editing",
    );
    keepEditing?.click();
  }, [container]);
  return null;
}

/** A DOM witness that the root's passive-effect flush produced its follow-up commit. */
function PassiveEffectsCommitted() {
  const [committed, setCommitted] = useState(false);
  useEffect(() => setCommitted(true), []);
  return committed ? <span data-passive-effects-committed /> : null;
}

describe("editor/EditorShell — commit windows around Missing transitions (#1595, #1780)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    openDocumentMock.mockReset();
    saveDocumentMock.mockReset().mockResolvedValue("r2");
    recreateCapabilityMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("retires a read taken before the file vanished, even when it lands mid-transition", { timeout: 30_000 }, async () => {
    const preMissing = heldRead();
    const afterTransition = heldRead();
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });
    // The poller arms its next tick only once the previous read settles, so this one read stays
    // outstanding for the whole episode and no later read can retire it for free.
    openDocumentMock.mockReturnValueOnce(preMissing.promise);
    openDocumentMock.mockReturnValue(afterTransition.promise);

    const tree = (missing: boolean, settle?: () => void) => (
      <>
        <EditorShell
          root="/project"
          path="notes/a.md"
          autosaveIntervalMs={5}
          externalChangePollMs={1}
          missing={missing}
        />
        {settle ? <SettleDuringCommit settle={settle} /> : null}
      </>
    );

    root.render(tree(false));
    // Condition-based waits with explicit budgets: the poller's first tick arrives on real time
    // here, and this shell mounts through a settings read and a redline parse before it starts.
    await vi.waitFor(() => expect(openDocumentMock).toHaveBeenCalledTimes(2), WAIT);

    root.render(tree(true));
    // Wait for the Missing state to actually commit — the view is already mounted from the render
    // above, so waiting on it would prove nothing and the edit below would land in the wrong state.
    // The recovery banner is what only exists once this shell is missing.
    await vi.waitFor(
      () => expect(container.querySelector('[role="status"]')).toBeTruthy(),
      WAIT,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    view?.dispatch({ changes: { from: 0, insert: "typed while the file was gone\n" } });

    // Leaving Missing, with the pre-Missing read landing inside the commit itself: after
    // `missingRef` has been set to false by the render, before the leaving effect runs.
    root.render(tree(false, () => preMissing.settle({ content: "# Hi\n", revision: "r1" })));

    // Two reads follow the transition: the poller re-arms once the settled read releases it, and
    // the leaving effect issues its own. That second one is the observable proof, because the
    // leaving effect only runs it while the pause is up — a stale answer clearing the pause takes
    // the count no further than three, and takes the debounce cancel with it.
    await vi.waitFor(
      () => expect(openDocumentMock.mock.calls.length).toBeGreaterThanOrEqual(4),
      WAIT,
    );
    expect(saveDocumentMock).not.toHaveBeenCalled();
    afterTransition.settle({ content: "# Hi\n", revision: "r1" });
  });

  it("does not reopen Missing actions when Keep editing lands before the entry effect", async () => {
    openDocumentMock.mockResolvedValueOnce({ content: "# Hi\n", revision: "r1" });

    root.render(
      <>
        <EditorShell root="/project" path="notes/a.md" missing />
        <DismissMissingDuringCommit container={container} />
        <PassiveEffectsCommitted />
      </>,
    );

    await vi.waitFor(
      () => expect(container.querySelector("[data-passive-effects-committed]")).toBeTruthy(),
      WAIT,
    );
    expect(recreateCapabilityMock).toHaveBeenCalledWith("notes/a.md");
    expect(container.querySelector(".integrity-banner--missing")).toBeNull();
  });
});
