// ABOUTME: External on-disk change detection (P2a-21, FR-ED-7) — pure comparison + an injectable-
// ABOUTME: interval poller, mirroring autosave.ts's shape so both unit-test on a fake clock with no
// ABOUTME: sleeps (test-plan §7). EditorShell wires this to the non-modal integrity banner. `check`
// ABOUTME: owns reporting its own expected failures (FR-X-5); a rejection reaching the poller is a
// ABOUTME: defect, deliberately left unhandled here rather than swallowed (#1701).

/**
 * The stubbed default poll interval (parallels `DEFAULT_AUTOSAVE_INTERVAL_MS`): how often an open
 * tab re-reads its file off disk to notice an out-of-band change (a git op, an external editor, or
 * an agent write that slipped protection — FR-ED-7). Deliberately coarse: this is a background
 * safety net, not a live watch, so it never competes with the keystroke/autosave path.
 */
export const DEFAULT_EXTERNAL_CHANGE_POLL_MS = 5000;

/**
 * `true` when `diskContent` no longer matches what this editor last knew to be on disk
 * (`knownContent` — the content this tab most recently loaded or saved). A pure string compare:
 * the caller decides what "known" means (baseline tracking already lives in `EditorShell`).
 */
export function isExternallyChanged(diskContent: string, knownContent: string): boolean {
  return diskContent !== knownContent;
}

/** Starts/stops a recurring `check`. */
export interface ExternalChangePoller {
  start(): void;
  stop(): void;
}

/**
 * Polls `check` every `intervalMs` while started. `check` is async (it round-trips to the backend);
 * the next tick is armed only after the previous check settles, so a slow or overlapping check can
 * never pile up concurrent reads of the same file. `stop()` is safe to call at any time, including
 * from inside `check` itself (a component unmounting mid-check) — the next tick is only armed if
 * still running when the in-flight check resolves.
 *
 * `check` owns reporting its own expected failures — a rejection that reaches this poller is a
 * defect in `check`, not an expected outcome this poller has any way to interpret, so it is
 * deliberately left unhandled: the `.finally()` below rearms the next tick, but nothing here calls
 * `.catch()` on `check()`'s own promise, so a rejection still propagates as an unhandled rejection.
 * That is intentional and load-bearing, not an oversight — it is the only channel that reddens a
 * *test* run when `check` regresses into swallowing its own failures (#1690, #1701). Do not add a
 * `.catch()` here; it would trade a visible failure for an invisible one.
 */
export function createExternalChangePoller(
  check: () => Promise<void>,
  intervalMs: number = DEFAULT_EXTERNAL_CHANGE_POLL_MS,
): ExternalChangePoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = () => {
    timer = null;
    void check().finally(() => {
      if (running) timer = setTimeout(tick, intervalMs);
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(tick, intervalMs);
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
