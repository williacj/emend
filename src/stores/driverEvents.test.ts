// ABOUTME: Contract tests for the shared native/D23 backend-event subscription pump.
// ABOUTME: Pin ordered replay, one long poll, cursor persistence, buffering, restart, and teardown.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
const listenMock = vi.fn();
const isTauriMock = vi.fn(() => false);

vi.mock("../backend", () => ({
  callBackend: (...args: unknown[]) => callBackendMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => isTauriMock() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const stored = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  clear: () => stored.clear(),
});

const { listenForBackendEvent, resetDriverEventPumpForTests } =
  await import("./driverEvents");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("listenForBackendEvent", () => {
  beforeEach(() => {
    resetDriverEventPumpForTests();
    sessionStorage.clear();
    callBackendMock.mockReset();
    listenMock.mockReset();
    isTauriMock.mockReturnValue(false);
  });

  it("keeps Tauri on its native listener and forwards the exact payload", async () => {
    isTauriMock.mockReturnValue(true);
    const unlisten = vi.fn();
    let emit: ((event: { payload: { id: string } }) => void) | undefined;
    listenMock.mockImplementation((_name, handler) => {
      emit = handler;
      return Promise.resolve(unlisten);
    });
    const handler = vi.fn();

    const stop = await listenForBackendEvent("event/a", handler);
    emit?.({ payload: { id: "native" } });

    expect(handler).toHaveBeenCalledWith({ id: "native" });
    expect(callBackendMock).not.toHaveBeenCalled();
    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it("uses one shared ordered D23 poll and buffers a channel until its listener registers", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    callBackendMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const a = vi.fn();
    const stopA = await listenForBackendEvent<{ id: string }>("event/a", a);
    expect(callBackendMock).toHaveBeenCalledTimes(1);

    first.resolve({
      epoch: "process-1",
      cursor: 2,
      events: [
        { cursor: 1, event: "event/b", payload: { id: "buffered" } },
        { cursor: 2, event: "event/a", payload: { id: "live" } },
      ],
    });
    await vi.waitFor(() => expect(a).toHaveBeenCalledWith({ id: "live" }));
    const b = vi.fn();
    const stopB = await listenForBackendEvent<{ id: string }>("event/b", b);

    expect(b).toHaveBeenCalledWith({ id: "buffered" });
    expect(callBackendMock).toHaveBeenNthCalledWith(2, "events", {
      cursor: 2,
      epoch: "process-1",
      waitMs: 1_000,
    });
    expect(callBackendMock).toHaveBeenCalledTimes(2);
    stopA();
    stopB();
    second.resolve({ epoch: "process-1", cursor: 2, events: [] });
  });

  it("isolates a throwing subscriber so sibling handlers and later events still receive the batch", async () => {
    const first = deferred<unknown>();
    callBackendMock.mockReturnValueOnce(first.promise);
    callBackendMock.mockImplementation(() => new Promise(() => {}));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const throws = vi.fn(() => {
      throw new Error("one consumer failed");
    });
    const sibling = vi.fn();
    const later = vi.fn();
    const stopThrowing = await listenForBackendEvent("event/a", throws);
    const stopSibling = await listenForBackendEvent("event/a", sibling);
    const stopLater = await listenForBackendEvent("event/b", later);

    first.resolve({
      epoch: "process-1",
      cursor: 2,
      events: [
        { cursor: 1, event: "event/a", payload: "first" },
        { cursor: 2, event: "event/b", payload: "second" },
      ],
    });

    await vi.waitFor(() => expect(later).toHaveBeenCalledWith("second"));
    expect(sibling).toHaveBeenCalledWith("first");
    expect(error).toHaveBeenCalledWith(
      "Cowrite backend event handler failed for event/a",
      expect.any(Error),
    );
    expect(sessionStorage.getItem("cowrite.driverEvents.cursor.v1")).toBe(
      JSON.stringify({ epoch: "process-1", cursor: 2 }),
    );
    stopThrowing();
    stopSibling();
    stopLater();
    error.mockRestore();
  });

  it("persists the shared cursor across a reload and accepts a restarted driver's lower cursor", async () => {
    sessionStorage.setItem(
      "cowrite.driverEvents.cursor.v1",
      JSON.stringify({ epoch: "old-process", cursor: 99 }),
    );
    callBackendMock.mockResolvedValueOnce({
      epoch: "new-process",
      cursor: 1,
      events: [{ cursor: 1, event: "event/a", payload: "replayed" }],
    });
    callBackendMock.mockImplementation(() => new Promise(() => {}));
    const handler = vi.fn();

    const stop = await listenForBackendEvent("event/a", handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("replayed"));

    expect(callBackendMock).toHaveBeenNthCalledWith(1, "events", {
      cursor: 99,
      epoch: "old-process",
      waitMs: 1_000,
    });
    expect(sessionStorage.getItem("cowrite.driverEvents.cursor.v1")).toBe(
      JSON.stringify({ epoch: "new-process", cursor: 1 }),
    );
    stop();
  });

  it("fences an unmatched buffered event when the project epoch changes", async () => {
    callBackendMock
      .mockResolvedValueOnce({
        epoch: "project-a",
        cursor: 1,
        events: [{ cursor: 1, event: "event/b", payload: "must not cross" }],
      })
      .mockResolvedValueOnce({ epoch: "project-b", cursor: 1, events: [] })
      .mockImplementation(() => new Promise(() => {}));
    const stopA = await listenForBackendEvent("event/a", vi.fn());
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(3));
    const b = vi.fn();

    const stopB = await listenForBackendEvent("event/b", b);

    expect(b).not.toHaveBeenCalled();
    stopA();
    stopB();
  });

  it("ignores an in-flight reply after the last unsubscribe and starts no replacement poll", async () => {
    const pending = deferred<unknown>();
    callBackendMock.mockReturnValueOnce(pending.promise);
    const handler = vi.fn();
    const stop = await listenForBackendEvent("event/a", handler);
    stop();

    pending.resolve({
      epoch: "process-1",
      cursor: 1,
      events: [{ cursor: 1, event: "event/a", payload: "late" }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(callBackendMock).toHaveBeenCalledTimes(1);
  });
});
