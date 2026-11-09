// ABOUTME: Autosave scheduling & sequencing (FR-ED-2) — a debounce over "the doc changed" that
// ABOUTME: fires one save after edits settle, plus a single-flight runner that serializes the
// ABOUTME: writes. Pure logic, no CM6/React, so both unit-test on a clock / controllable promise.

/**
 * The fallback/default autosave interval (FR-ED-2). P2a-9's persisted Settings store and the
 * General Settings surface normally choose the live interval; tests and fresh settings share this
 * value so an unavailable settings read still degrades to the same behavior.
 * A debounce: the save fires this many ms after the *last* edit, so a burst of keystrokes
 * coalesces into one write rather than one write per keystroke.
 */
export const DEFAULT_AUTOSAVE_INTERVAL_MS = 1000;

/** Arms/flushes/cancels a single pending debounced save. One per open document. */
export interface AutosaveScheduler {
  /** Called on each edit: (re)arm the timer so the save fires `intervalMs` after edits settle. */
  schedule(): void;
  /** If a save is pending, run it now and clear the timer; a no-op when nothing is pending. */
  flush(): void;
  /** Drop any pending save without running it (e.g. an explicit manual save just wrote). */
  cancel(): void;
}

/**
 * Debounces `save`: every `schedule()` restarts a single timer, and the save runs once the timer
 * elapses without another `schedule()`. `save` is invoked with no arguments — the caller closes it
 * over whatever "current document content" means for it (in the editor, the live CM6 state).
 */
export function createAutosaveScheduler(
  save: () => void,
  intervalMs: number = DEFAULT_AUTOSAVE_INTERVAL_MS,
): AutosaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        save();
      }, intervalMs);
    },
    flush() {
      if (timer !== null) {
        clear();
        save();
      }
    },
    cancel() {
      clear();
    },
  };
}

/**
 * Serializes async saves for one document so at most one write is ever in flight — honoring
 * `store::atomic::write`'s single-writer-per-path contract (FR-ED-2 durability). The three save
 * triggers can otherwise overlap for the same file: a manual save landing on top of an autosave, a
 * debounced save firing while the previous write is still on disk, or the unmount flush racing a
 * write in progress. Two concurrent `save_document` calls for one path would collide on the shared
 * atomic-write temp file (a spurious error at best, a torn source-of-truth file at worst).
 *
 * A request that arrives while a write is in flight is coalesced into a single *trailing* write
 * carrying the latest content (any superseded intermediate content is dropped), so the
 * last-issued content wins. `write` may resolve `false` when its final issuance check refuses the
 * request; a rejection is swallowed here only to keep the chain alive for later authorized work.
 *
 * The returned function's promise resolves — with `true` if the write that carried this call's
 * content succeeded, `false` if it failed or was refused — after this call either reaches its own
 * write, is coalesced into the trailing write that eventually carries it, or is cancelled before
 * publication. It never resolves from the older write already in flight when it was queued. This
 * is what lets a caller that needs a completion *and* success signal (P2a-6's
 * imperative `EditorShellHandle.save()`, driving the FR-ED-3 dirty-close guard — it must not close
 * a tab, discarding the edit, when the save it just asked for actually failed) share this same
 * single-flight serialization instead of racing it with a direct `write` call of its own. A
 * rejected `write` is swallowed here only to keep the chain alive so the trailing write still
 * runs — the caller learns of the failure via its `false` outcome, not via a rejected promise.
 * `cancelTrailing()` is the condition-based revocation boundary for work that has not reached
 * `write`: every queued waiter resolves `false`, and a later request starts from a fresh decision.
 */
export interface SaveRunner {
  (content: string): Promise<boolean>;
  /** Refuse the coalesced write that has not yet reached the publication callback. */
  cancelTrailing(): void;
}

export function createSaveRunner(
  write: (content: string) => Promise<void | boolean>,
): SaveRunner {
  let inFlight = false;
  let trailing: { content: string; waiters: ((success: boolean) => void)[] } | null = null;

  const run = (content: string, waiters: ((success: boolean) => void)[]) => {
    inFlight = true;
    Promise.resolve(write(content))
      .then(
        (outcome) => outcome !== false,
        () => false,
      )
      .then((success) => {
        inFlight = false;
        waiters.forEach((resolve) => resolve(success));
        if (trailing !== null) {
          const next = trailing;
          trailing = null;
          run(next.content, next.waiters);
        }
      });
  };

  const runner = ((content: string) =>
    new Promise<boolean>((resolve) => {
      if (inFlight) {
        if (trailing) {
          trailing.content = content;
          trailing.waiters.push(resolve);
        } else {
          trailing = { content, waiters: [resolve] };
        }
        return;
      }
      run(content, [resolve]);
    })) as SaveRunner;
  runner.cancelTrailing = () => {
    if (trailing === null) return;
    const cancelled = trailing;
    trailing = null;
    cancelled.waiters.forEach((resolve) => resolve(false));
  };
  return runner;
}
