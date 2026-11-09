// ABOUTME: FR-ED-2 autosave-scheduling tests — the debounce fires once per settled edit-burst,
// ABOUTME: coalesces rapid edits, and flush/cancel behave. Fake timers, no sleeps (test-plan §7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosaveScheduler, createSaveRunner } from "./autosave";

/** A `write` whose promises resolve/reject only when the test says so — controls in-flight timing. */
function controllableWrite() {
  const calls: string[] = [];
  const settlers: Array<{ resolve: () => void; reject: (e?: unknown) => void }> = [];
  const write = (content: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push(content);
      settlers.push({ resolve, reject });
    });
  return {
    write,
    calls,
    settleNext: () => settlers.shift()?.resolve(),
    rejectNext: () => settlers.shift()?.reject(new Error("write failed")),
  };
}

describe("editor/autosave — scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once after the interval elapses following an edit", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.schedule();
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of edits into a single save", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.schedule();
    vi.advanceTimersByTime(400);
    scheduler.schedule();
    vi.advanceTimersByTime(400);
    scheduler.schedule();
    // Only 800ms of the debounce window has elapsed since the last edit.
    vi.advanceTimersByTime(999);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a pending save so it never fires", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(5000);

    expect(save).not.toHaveBeenCalled();
  });

  it("flush runs a pending save immediately and clears the timer", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.schedule();
    scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // The timer was cleared, so letting it "elapse" does not save a second time.
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending does not save", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.flush();

    expect(save).not.toHaveBeenCalled();
  });

  it("re-arms for the next edit after a save has fired", () => {
    const save = vi.fn();
    const scheduler = createAutosaveScheduler(save, 1000);

    scheduler.schedule();
    vi.advanceTimersByTime(1000);
    scheduler.schedule();
    vi.advanceTimersByTime(1000);

    expect(save).toHaveBeenCalledTimes(2);
  });
});

// Real timers here (condition-based `vi.waitFor`, not fake): the runner sequences real promises.
describe("editor/autosave — save runner (single-flight)", () => {
  it("writes immediately when nothing is in flight", () => {
    const { write, calls } = controllableWrite();
    const run = createSaveRunner(write);

    run("a");

    expect(calls).toEqual(["a"]);
  });

  it("coalesces overlapping requests into one trailing write with the latest content", async () => {
    const { write, calls, settleNext } = controllableWrite();
    const run = createSaveRunner(write);

    run("a");
    run("b");
    run("c");
    // Only the first write has started; "b" is superseded by "c" while it waits.
    expect(calls).toEqual(["a"]);

    settleNext();
    await vi.waitFor(() => expect(calls).toEqual(["a", "c"]));
  });

  it("does not start a trailing write when none was queued", async () => {
    const { write, calls, settleNext } = controllableWrite();
    const run = createSaveRunner(write);

    run("a");
    settleNext();
    // Drain the resolution microtasks (a 0ms macrotask fires only after the queue empties) so the
    // in-flight write has fully settled with nothing queued — not a timed wait.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["a"]);

    run("b"); // idle again → the next request starts immediately, not as a trailing write
    expect(calls).toEqual(["a", "b"]);
  });

  it("still runs the trailing write after a failed write", async () => {
    const { write, calls, rejectNext } = controllableWrite();
    const run = createSaveRunner(write);

    run("a");
    run("b");
    rejectNext();

    await vi.waitFor(() => expect(calls).toEqual(["a", "b"]));
  });

  it("cancels a queued trailing write and resolves its waiters false before publication (#1599)", async () => {
    const { write, calls, settleNext } = controllableWrite();
    const run = createSaveRunner(write);
    run("a");
    const trailingOutcome = run("b");

    run.cancelTrailing();
    await expect(trailingOutcome).resolves.toBe(false);
    settleNext();

    await vi.waitFor(() => expect(calls).toEqual(["a"]));
  });

  it("resolves the caller's promise once its own write settles (nothing else in flight)", async () => {
    const { write, settleNext } = controllableWrite();
    const run = createSaveRunner(write);

    let done = false;
    run("a").then(() => {
      done = true;
    });
    expect(done).toBe(false);

    settleNext();
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it("resolves the caller's promise with the write's success or failure outcome", async () => {
    const { write, settleNext, rejectNext } = controllableWrite();
    const run = createSaveRunner(write);

    let firstOutcome: boolean | undefined;
    run("a").then((outcome) => {
      firstOutcome = outcome;
    });
    settleNext();
    await vi.waitFor(() => expect(firstOutcome).toBe(true));

    let secondOutcome: boolean | undefined;
    run("b").then((outcome) => {
      secondOutcome = outcome;
    });
    rejectNext();
    await vi.waitFor(() => expect(secondOutcome).toBe(false));
  });

  it("a coalesced trailing request resolves when the trailing write settles rather than the earlier in-flight one", async () => {
    const { write, calls, settleNext } = controllableWrite();
    const run = createSaveRunner(write);

    let aDone = false;
    let bDone = false;
    let cDone = false;
    run("a").then(() => {
      aDone = true;
    });
    run("b").then(() => {
      bDone = true;
    });
    run("c").then(() => {
      cDone = true;
    });

    // "a" is in flight; "b" and "c" are coalesced into one pending trailing write ("c" wins).
    settleNext();
    await vi.waitFor(() => expect(calls).toEqual(["a", "c"]));
    // "a"'s own write just settled — its caller resolves. "b"/"c" have not: the trailing write
    // carrying "c" (which subsumes "b") has only just started, not yet settled.
    expect(aDone).toBe(true);
    expect(bDone).toBe(false);
    expect(cDone).toBe(false);

    settleNext();
    await vi.waitFor(() => expect(bDone).toBe(true));
    expect(cDone).toBe(true);
  });
});
