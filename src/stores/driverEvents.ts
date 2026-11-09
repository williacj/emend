// ABOUTME: Shared frontend subscription transport for native Tauri events and D23 driver events.
// ABOUTME: Multiplexes one cursor-backed long poll across every non-Tauri backend event consumer.
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { callBackend } from "../backend";

interface DriverEvent {
  cursor: number;
  event: string;
  payload: unknown;
}

interface DriverEventBatch {
  epoch: string;
  cursor: number;
  events: DriverEvent[];
}

interface StoredCursor {
  epoch?: string;
  cursor: number;
}

type Handler = (payload: unknown) => void;

const CURSOR_KEY = "cowrite.driverEvents.cursor.v1";
const WAIT_MS = 1_000;
const RETRY_MS = 50;

const subscribers = new Map<string, Set<Handler>>();
let buffered: DriverEvent[] = [];
let epoch: string | undefined;
let cursor = 0;
let cursorLoaded = false;
let running = false;
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Listens on the exact native Tauri channel in the shipped app. In D23 it registers synchronously
 * with the one shared event pump before the first request can settle, then returns the same async
 * unsubscribe shape as Tauri. A single ordered cursor is deliberately shared across channels:
 * independent drains could lose a sibling channel, while independent long polls would spend one
 * server waiter per React effect and race project-lifecycle fences.
 */
export function listenForBackendEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isTauri()) {
    return listen<T>(eventName, (event) => handler(event?.payload as T)).then(
      (unlisten) => () => unlisten(),
    );
  }
  const erased = handler as Handler;
  const handlers = subscribers.get(eventName) ?? new Set<Handler>();
  handlers.add(erased);
  subscribers.set(eventName, handlers);
  deliverBuffered(eventName);
  startPump();

  let subscribed = true;
  return Promise.resolve(() => {
    if (!subscribed) return;
    subscribed = false;
    const current = subscribers.get(eventName);
    current?.delete(erased);
    if (current?.size === 0) subscribers.delete(eventName);
    if (subscribers.size === 0) stopPump();
  });
}

function deliverBuffered(eventName: string): void {
  const handlers = subscribers.get(eventName);
  if (!handlers?.size) return;
  const remaining: DriverEvent[] = [];
  for (const event of buffered) {
    if (event.event === eventName) {
      deliverToHandlers(event, handlers);
    } else {
      remaining.push(event);
    }
  }
  buffered = remaining;
}

function deliverToHandlers(event: DriverEvent, handlers: Set<Handler>): void {
  for (const handler of handlers) {
    try {
      handler(event.payload);
    } catch (error) {
      // Match independent native listener callbacks: one consumer cannot end the shared D23 pump
      // or make the cursor skip its siblings. The event name diagnoses the channel without logging
      // a document-bearing payload.
      console.error(`Cowrite backend event handler failed for ${event.event}`, error);
    }
  }
}

function startPump(): void {
  if (running) return;
  if (!cursorLoaded) loadCursor();
  running = true;
  const activeGeneration = ++generation;
  void poll(activeGeneration);
}

function stopPump(): void {
  running = false;
  generation += 1;
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

async function poll(activeGeneration: number): Promise<void> {
  try {
    const batch = await callBackend<DriverEventBatch>("events", {
      cursor,
      epoch,
      waitMs: WAIT_MS,
    });
    if (!running || activeGeneration !== generation || subscribers.size === 0)
      return;

    if (epoch !== undefined && batch.epoch !== epoch) buffered = [];
    epoch = batch.epoch;
    for (const event of batch.events) {
      const handlers = subscribers.get(event.event);
      if (!handlers?.size) {
        buffered.push(event);
        continue;
      }
      deliverToHandlers(event, handlers);
    }
    // Advance/persist only after every event had a chance to reach every current subscriber.
    cursor = batch.cursor;
    storeCursor();
    void poll(activeGeneration);
  } catch {
    if (!running || activeGeneration !== generation || subscribers.size === 0)
      return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void poll(activeGeneration);
    }, RETRY_MS);
  }
}

function loadCursor(): void {
  cursorLoaded = true;
  try {
    const raw = sessionStorage.getItem(CURSOR_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as StoredCursor;
    if (Number.isSafeInteger(stored.cursor) && stored.cursor >= 0) {
      cursor = stored.cursor;
      epoch = typeof stored.epoch === "string" ? stored.epoch : undefined;
    }
  } catch {
    epoch = undefined;
    cursor = 0;
  }
}

function storeCursor(): void {
  try {
    sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ epoch, cursor }));
  } catch {
    // A denied/full browser store only permits replay on reload; it must not end the live stream.
  }
}

/** Test isolation for this module's intentionally app-lifetime singleton. */
export function resetDriverEventPumpForTests(): void {
  stopPump();
  subscribers.clear();
  buffered = [];
  epoch = undefined;
  cursor = 0;
  cursorLoaded = false;
}
