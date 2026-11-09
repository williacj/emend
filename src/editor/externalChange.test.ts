// ABOUTME: FR-ED-7 external-change-detection tests — pure comparison plus the poller's fake-clock
// ABOUTME: scheduling (no sleeps, test-plan §7): no pile-up while a check is in flight, stop()
// ABOUTME: is safe mid-check, and start()/stop() are idempotent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExternalChangePoller, isExternallyChanged } from "./externalChange";

describe("editor/externalChange — isExternallyChanged", () => {
  it("is false when the disk content matches what this editor knows", () => {
    expect(isExternallyChanged("same", "same")).toBe(false);
  });

  it("is true when the disk content diverges from what this editor knows", () => {
    expect(isExternallyChanged("changed on disk", "known")).toBe(true);
  });
});

/** A `check` whose promises resolve only when the test says so — controls in-flight timing. */
function controllableCheck() {
  const calls: number[] = [];
  const settlers: Array<() => void> = [];
  const check = () =>
    new Promise<void>((resolve) => {
      calls.push(calls.length);
      settlers.push(resolve);
    });
  return { check, calls, settleNext: () => settlers.shift()?.() };
}

describe("editor/externalChange — poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not check before the interval elapses", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    createExternalChangePoller(check, 5000).start();

    vi.advanceTimersByTime(4999);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks once the interval elapses — and again after each further interval", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    createExternalChangePoller(check, 1000).start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels a pending check", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const poller = createExternalChangePoller(check, 1000);
    poller.start();
    poller.stop();

    vi.advanceTimersByTime(5000);
    expect(check).not.toHaveBeenCalled();
  });

  it("never overlaps checks — the next tick is armed only after the previous check settles", async () => {
    const { check, calls, settleNext } = controllableCheck();
    createExternalChangePoller(check, 1000).start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([0]); // one check in flight

    // A full interval passes while the first check is still pending — no second check starts.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([0]);

    settleNext();
    await vi.waitFor(() => expect(calls).toEqual([0])); // settling alone doesn't start the next tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([0, 1]);
  });

  it("stop() called while a check is in flight suppresses the tick it would otherwise arm", async () => {
    const { check, calls, settleNext } = controllableCheck();
    const poller = createExternalChangePoller(check, 1000);
    poller.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([0]);

    poller.stop();
    settleNext();
    await vi.waitFor(() => expect(calls).toEqual([0]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([0]); // never re-armed
  });

  it("start() is idempotent — calling it again while already running does not double-schedule", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const poller = createExternalChangePoller(check, 1000);
    poller.start();
    poller.start();

    vi.advanceTimersByTime(1000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
