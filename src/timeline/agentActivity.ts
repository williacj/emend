// ABOUTME: The frontend half of the P2a integration (#345, #696) agent-activity pipe — this app's
// ABOUTME: first `listen()` counterpart to the backend's first `emit()` (see `commands::agent`'s
// ABOUTME: own docs), `stopRun` for Stop/Cancel, queue-aware `startRun` acknowledgements, and the
// ABOUTME: honest `Failed` status a single-thread caller renders when `start_run` rejects outright.
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { callBackend, errorDetail } from "../backend";
import { mintRunId } from "../comments/runId";
import type { CommentThread } from "../comments/types";
import { promptWithReferenceData, type TurnContext } from "./referenceData";
import type { AgentRunCardStatus } from "./types";

/** Mirrors Rust `commands::agent::ACTIVITY_EVENT` — the one channel `TauriActivityEmitter` pushes
 * every `RunStatus` update on. Change both together. */
export const ACTIVITY_EVENT = "agent://activity";

/** Mirrors Rust `agent::activity::ActivityLine` (plain `Serialize`, no rename — both field names
 * already carry their wire spelling verbatim). */
export interface ActivityLine {
  verb: string;
  detail?: string | null;
  /** Canonical project-relative identity for a file read; `detail` remains display text. */
  pathIdentity?: string | null;
}

/** Mirrors Rust `agent::run_queue::RunPhase` (`#[serde(tag = "phase", rename_all = "snake_case")]`
 * — an externally-impossible-to-mis-narrow discriminated union on the `phase` field, matching the
 * wire shape exactly rather than re-deriving it from a separate tag + payload pair). */
export type RunPhase =
  | { phase: "running" }
  /** `reply` is the agent's own answer for the turn (#1118) — the channel a chat question's prose
   * reaches the timeline on, rendered as an agent `chat-message` card (J2, Principle 5). `null`
   * (Rust `Option::None`) for a run that produced no prose, and — per CJ's ruling on #1118 — for
   * one that delivered tracked changes or comments, whose own change-set/comment card already
   * reports it. Only a clean completion carries one; the backend decides which
   * (`RunPhase::Completed`'s own docs), so the fold renders whatever arrives. */
  | { phase: "completed"; reply: string | null }
  | { phase: "recovered"; reply: string | null }
  | { phase: "stopped"; delivered: boolean }
  | { phase: "failed"; message: string };

/** Mirrors Rust `agent::run_queue::RunStatus` (`#[serde(rename_all = "camelCase")]`) — the one
 * payload shape both a `run_state` poll (the D23 driver's transport, `crates/test-driver`) and
 * this module's live push carry, so a GUI `listen()`er and a headless poller see the identical
 * picture. */
export interface RunStatus {
  id: string;
  phase: RunPhase;
  activity: ActivityLine[];
  elapsedSecs: number;
}

export interface RunQueueState {
  active: RunStatus | null;
  queued: { id: string; position: number }[];
  /** Current-project terminal ledger, ordered by completion. Polling replays it idempotently. */
  finished: RunStatus[];
  /** Newest projection of `finished`, retained by the shared wire shape. */
  lastFinished: RunStatus | null;
}

/** Non-mutating FR-X-11 close preflight against the backend-owned run queue. */
// @anchor:timeline-get-run-state
export async function getRunState(): Promise<RunQueueState> {
  return callBackend<RunQueueState>("run_state", {});
}

/**
 * Normalizes a `Reading` line's `detail` into a dedupe key, so a spelling variant of one
 * already-tracked document doesn't mint a second count (round-2 review finding, PR #1819) — the
 * same class `agent::state`'s `resolved_identity`/`relative_to_root`
 * (`src-tauri/src/agent/state.rs:281-297`) exists to close on the backend. New activity carries
 * that canonical identity separately; this string-only normalization remains for persisted
 * activity from before the field existed.
 */
function normalizedActivityPathKey(detail: string): string {
  return detail
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

/**
 * The grounding count J2's agent-reply chip renders (`[refs: N files read]`, issue #1391) — how
 * many *distinct* files this run's activity feed reports having read. Counts paths, not lines:
 * rereading the same file several times over one turn still read one file (CJ's ruling on #1391,
 * 2026-08-20 — "an agent that reads one file four times read one file"), and rereading it under a
 * merely differently-spelled path still read one file. Restricted to the
 * `"Reading"` verb, the one both `agent::activity`'s `Read` tool-use lines and its
 * `get_document_state` MCP lines map to (that module's own docs) — every other verb (`Writing`,
 * `Editing`, `Drafting`, …) reports work that isn't a *read*. A line with no `detail` yet (an
 * in-progress line before its tool input carried a path) names nothing to count.
 */
export function distinctFilesRead(activity: ActivityLine[]): number {
  const paths = new Set<string>();
  for (const line of activity) {
    const path = activityPath(line);
    if (line.verb === "Reading" && path) paths.add(normalizedActivityPathKey(path));
  }
  return paths.size;
}

function activityPath(line: ActivityLine): string | null | undefined {
  return line.pathIdentity ?? line.detail;
}

export interface RunActivitySummary {
  /** `null` means at least one read was observed without a persisted path, so the exact count is
   * unknown. Zero is reserved for a complete, read-free activity list. */
  filesRead: number | null;
  /** Distinct paths touched by Write/Edit/MultiEdit/propose_changes activity. `null` has the same
   * incomplete-path meaning as `filesRead`; zero means no such activity was observed. */
  changes: number | null;
}

const CHANGE_VERBS = new Set(["Writing", "Editing", "Delivering"]);

function distinctActivityTargets(
  activity: ActivityLine[],
  matches: (line: ActivityLine) => boolean,
): number | null {
  const paths = new Set<string>();
  let missingPath = false;
  for (const line of activity) {
    if (!matches(line)) continue;
    const path = activityPath(line);
    if (path) {
      paths.add(normalizedActivityPathKey(path));
    } else {
      missingPath = true;
    }
  }
  return missingPath ? null : paths.size;
}

/**
 * The completed-run collapsed line's persisted grounding/outcome summary (#1725). Both counts use
 * distinct normalized paths rather than activity-line counts: rereading or editing one document
 * repeatedly still names one file. A counted verb whose path is absent makes that metric unknown,
 * never zero — Principle 7 / FR-X-5 forbid presenting absence of evidence as evidence of absence.
 */
export function summarizeRunActivity(activity: ActivityLine[]): RunActivitySummary {
  return {
    filesRead: distinctActivityTargets(activity, (line) => line.verb === "Reading"),
    changes: distinctActivityTargets(activity, (line) => CHANGE_VERBS.has(line.verb)),
  };
}

/** Mirrors Rust `agent::run_queue::StartRunResult` — the command's synchronous acknowledgement.
 * `queuedPosition` is non-null exactly when another run was active at submission time. */
export interface StartRunResult {
  id: string;
  queuedPosition: number | null;
}

/** One atomic Address admission: the thread reservation and run queue acceptance share the
 * backend's comment write lane (FR-CMT-10). `progress` is J4's batch accounting, including the
 * single-thread case. */
export interface StartAddressRunResult {
  run: StartRunResult | null;
  threads: CommentThread[];
  progress: {
    addressed: string[];
    skipped: string[];
    untouched: string[];
    interrupted: string | null;
  };
}

/** Mirrors Rust `commands::agent::CommandError` (`#[serde(tag = "kind", content = "message")]`) —
 * the one way `start_run` can reject outright (a blank prompt). A spawn/queue failure is
 * deliberately *not* one of these (that command's own doc): it surfaces as the started run's own
 * `Failed` phase through the `agent://activity` push instead, which the existing `foldRunStatus`/
 * `AgentWorkingCard` path already renders honestly — this type only names the input-validation
 * rejection a caller must still not swallow silently (FR-X-5). */
export interface CommandError {
  kind: "InvalidArguments" | "ToolFailed";
  message: string;
}

/**
 * Starts (or, per FR-AGENT-7, queues behind an already-active run) a headless agent turn against
 * `root` with `prompt` — the frontend's one call into `commands::agent::start_run` (P2a integration
 * #696, the fourth and final orphaned seam of #344; the composer was its first caller, and #1721
 * added the single-thread and batch address paths). Returns the new run's id plus
 * the queue position captured atomically when the backend accepted it, allowing the timeline to
 * acknowledge a queued request before its eventual activity update. The shared transport uses
 * Tauri IPC in the desktop app and the D23 headless driver's `/start_run` route in dev mode.
 *
 * `context` is what the turn carries besides the user's own words — FR-CHAT-4's ambient
 * `open_documents` envelope, and FR-CHAT-3's `quoted_selection` when the composer attached one.
 * It is composed onto the prompt **here**, at the one seam every submitting surface already passes
 * through, rather than at each call site: FR-CHAT-4 binds *every* agent run the app submits, and
 * #1724's defect was precisely that the app computed the active document's identity at all four
 * call sites and spent it only on `operationTargets`. Required rather than optional for the same
 * reason — a fifth surface cannot compile without saying what its turn knows (`NO_OPEN_DOCUMENTS`
 * is the explicit "nothing open" answer, never the silent default).
 *
 * The envelope is therefore captured at *submit*, the same boundary as the D21 operation target
 * beside it — never at dequeue, so a queued run (FR-AGENT-7) still names what the user was looking
 * at when they pressed Send.
 */
// @anchor:timeline-start-run
export async function startRun(
  root: string,
  prompt: string,
  operationTargets: string[],
  context: TurnContext,
): Promise<StartRunResult> {
  const result = await callBackend<StartRunResult>("start_run", {
    root,
    prompt: promptWithReferenceData(prompt, context),
    operationTargets,
  });
  wakeActivityPolls();
  return result;
}

/** Submits a comment-targeted run through the backend's atomic Address admission. The same
 * submit-time context used by chat is composed before the request crosses the IPC boundary. */
export async function startAddressRun(
  root: string,
  path: string,
  threadIds: string[],
  author: string,
  timestamp: number,
  prompt: string,
  batch: boolean,
  guidance: string | null,
  context: TurnContext,
  includeHeldThreadIds: string[] = [],
): Promise<StartAddressRunResult> {
  const result = await callBackend<StartAddressRunResult>("start_address_run", {
    root,
    path,
    threadIds,
    author,
    timestamp,
    prompt,
    // The backend builds a batch prompt from only the threads whose Address records actually
    // landed. Keep FR-CHAT-4's submit-time block separate so a partial batch cannot send the
    // agent instructions for an untouched comment.
    referenceData: promptWithReferenceData("", context),
    batch,
    guidance,
    includeHeldThreadIds,
  });
  if (result.run) wakeActivityPolls();
  return result;
}

/**
 * Builds an honest `Failed` `RunStatus` for a [`startRun`] call that rejected outright — today only
 * `CommandError::InvalidArguments`, never a spawn/queue failure (that surfaces as the started run's
 * own `Failed` phase through the normal `agent://activity` push, which the timeline's `foldRunStatus`
 * already handles), so this never runs the risk of double-rendering a failure the backend also
 * pushed. `commands::agent::start_run_on` raises it for two causes: a blank prompt, which no frontend
 * caller actually sends, and a target that fails `confine` (`commands/commands/path_confine.rs`) —
 * whose `root.canonicalize()` fails once the project root has been moved, deleted or unmounted under
 * the app, so it is reachable from any caller.
 *
 * Lives beside `startRun` rather than in one of its callers because every caller of it owes the user
 * the same answer (FR-X-5 "never silently no-ops", UX Principle 7) in the same words:
 * `timeline/TimelinePanel` folds this into an `AgentWorkingCard` for its own composer and for a
 * mounted `CommentCard`'s `[Address with AI]`, and `App` raises the identical card for the
 * editor-anchored `CommentPopover`'s copy of that action (#1777). One builder, one rendering — never
 * a second, bespoke error surface per call site. J4's *batch* path is deliberately not among them: a
 * run targeting many threads reports through `comments/types.ts`'s `unrunBatch` and the header's
 * `BatchAddressStatus`, which names every target the unstarted run leaves untouched.
 *
 * A rejected call never returns a run id of its own, so a fresh client-minted one names this one-off
 * failure card. Nothing on the comment side is stamped alongside it: no run started, so no thread was
 * ever shown as Working, and ux-design.md §2's exit table owes an exit note only "where the user was
 * shown work in progress" — the thread keeps its live `[Address with AI]` and only this card carries
 * the reason.
 */
export function failedRunStatus(error: unknown): RunStatus {
  // `errorDetail` is the app's one reader of a rejected call's message (#2230) — it already covers
  // the rejected `CommandError` (`{ kind, message }`), the plain `Error` and the bare string this
  // used to re-derive. `String(error)` stays this surface's own no-detail wording, passed
  // explicitly: what a `Failed` run card says when the rejection carried no message is
  // `ux-design.md` §4's Status region to change, not a consolidation's.
  const message = errorDetail(error, String(error));
  return { id: mintRunId(), phase: { phase: "failed", message }, activity: [], elapsedSecs: 0 };
}

/**
 * Subscribes to agent activity and returns an unsubscribe function. Tauri receives the live
 * `agent://activity` push; D23 polls the headless driver's `/run_state` projection because its HTTP
 * transport has no push channel.
 */
const POLL_INTERVAL_MS = 50;
const activityPollWakers = new Set<() => void>();

function wakeActivityPolls(): void {
  // Let the submitter consume `start_run`'s acknowledgement first. Address-with-AI persists the
  // returned run id immediately after that promise resolves; an instantly failed run must not be
  // observed before the thread has recorded which run it belongs to (#1812).
  for (const wake of activityPollWakers) setTimeout(wake, POLL_INTERVAL_MS);
}

function queuedStatus(id: string, position: number): AgentRunCardStatus {
  return { id, phase: { phase: "queued", position }, activity: [], elapsedSecs: 0 };
}

function runIsLive(state: RunQueueState): boolean {
  return state.queued.length > 0 || state.active?.phase.phase === "running";
}

export async function listenToAgentActivity(
  onStatus: (status: AgentRunCardStatus) => void,
): Promise<() => void> {
  if (isTauri()) {
    return listen<RunStatus>(ACTIVITY_EVENT, (event) => onStatus(event.payload));
  }

  let stopped = false;
  let polling = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delivered = new Map<string, string>();

  const forwardChanged = (status: AgentRunCardStatus) => {
    const fingerprint = JSON.stringify(status);
    if (delivered.get(status.id) === fingerprint) return;
    delivered.set(status.id, fingerprint);
    onStatus(status);
  };

  const poll = async () => {
    polling = true;
    wakePending = false;
    let keepPolling = false;
    try {
      const state = await getRunState();
      // Auto-advance replaces `active` in the same lock acquisition. Replay the cumulative terminal
      // ledger first so two completions between polls cannot collapse to the newest one. The
      // fingerprint map makes old entries free to replay on every poll.
      for (const status of state.finished ?? []) forwardChanged(status);
      // The newest projection is folded too; the fingerprint map makes it an idempotent no-op
      // after the ledger entry and tolerates a native binary/frontend hot-reload boundary.
      if (state.lastFinished) forwardChanged(state.lastFinished);
      if (state.active) forwardChanged(state.active);
      for (const queued of state.queued) {
        forwardChanged(queuedStatus(queued.id, queued.position));
      }
      keepPolling = runIsLive(state);
    } catch {
      // An absent or shutting-down driver has no trustworthy state to project. A later UI
      // start/stop request wakes a fresh polling episode.
    } finally {
      polling = false;
      if (stopped) return;
      if (wakePending) {
        void poll();
      } else if (keepPolling) {
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, POLL_INTERVAL_MS);
      }
    }
  };

  const wake = () => {
    if (stopped) return;
    if (polling) {
      wakePending = true;
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    void poll();
  };

  activityPollWakers.add(wake);
  wake();
  return () => {
    stopped = true;
    activityPollWakers.delete(wake);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Mirrors Rust `agent::run_queue::StopOutcome` (`#[serde(rename_all = "snake_case")]`). */
export type StopOutcome = "stopped" | "cancelled" | "not_found";

/**
 * Stops `runId` (FR-X-3 cancellable) — kills it if it's the active run (its phase resolves to
 * `Stopped` shortly after, observed through the next activity update, not this call's return value)
 * or cancels it outright if it's still queued. Both Tauri and D23 route through the shared backend
 * transport.
 */
// @anchor:test-plan-stop-run
export async function stopRun(runId: string): Promise<StopOutcome> {
  const outcome = await callBackend<StopOutcome>("stop_run", { runId });
  wakeActivityPolls();
  return outcome;
}
