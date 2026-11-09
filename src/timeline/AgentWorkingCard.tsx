// ABOUTME: The agent-working card (P2a integration #345, J1 Phase A "Working" / ux-design §2 Agent
// ABOUTME: states) — queued/working status with Cancel/Stop, then each honest terminal state.
// ABOUTME: Completed runs collapse to one persisted grounding/outcome line; unsuccessful runs stay open.
import { errorDetail } from "../backend";
import { BatchAddressStatus } from "../comments/BatchAddressStatus";
import type { BatchAddressOutcome } from "../comments/types";
import { ChevronDown, ChevronRight, Pause, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefCallback } from "react";
import { summarizeRunActivity, type ActivityLine } from "./agentActivity";
import { isAgentWorkingCollapsedByDefault } from "./collapse";
import type { PermissionDecision, PermissionRequest, PermissionState } from "./permission";
import { TimelineCard } from "./TimelineCard";
import type { AgentWorkingCard as AgentWorkingCardData } from "./types";

export interface AgentWorkingCardProps {
  card: AgentWorkingCardData;
  /** This run's batch admission facts; panel state survives virtualized card unmounts. */
  batchAccounting?: { outcome: BatchAddressOutcome; batchNumber: number; conclusion?: "cancelled" };
  /** Called with the card's `runId` when [Stop] is pressed — `TimelinePanel` wires this to
   * `agentActivity.ts`'s `stopRun`. Omitted (or a no-op) leaves the button inert rather than
   * missing; every caller in this codebase passes it, but a bare render (e.g. a Storybook-style
   * smoke test) shouldn't have to. */
  onStop?: (runId: string) => void;
  /** Ephemeral J7 permission state for this project. The card renders it only when its run id
   * matches and the run is still live, so a late event cannot attach controls to another run. */
  permissionState?: PermissionState | null;
  /** Routes a decision to the backend-owned permission broker. */
  onPermissionDecision?: (
    runId: string,
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void> | void;
  /** Injectable millisecond clock for the waiting age. */
  now?: () => number;
  /** Reports effective collapse for TimelinePanel's virtualization estimate and whether the user
   * explicitly chose it. Mirrors the established comment/change-set collapse contract. */
  onCollapsedChange?: (collapsed: boolean, explicit: boolean) => void;
  /** A panel-owned explicit choice restored after a virtualized unmount/remount. */
  initialCollapsed?: boolean;
  /** A user-initiated Timeline-host navigation that should land on this exact request heading. */
  focusPermissionRequest?: { requestId: string; nonce: number };
  /** Acknowledges that the requested heading received focus, so the panel cannot replay the same
   * explicit navigation after later renders or a virtualized remount. */
  onFocusPermissionRequestConsumed?: (nonce: number) => void;
  /** A user-initiated project-status navigation that lands on this card's outer article. */
  focusCardRequest?: { nonce: number };
  submittedTurnLanding?: boolean;
  onFocusCardRequestConsumed?: (nonce: number) => void;
}

/** `m:ss` — matches ux-design.md's own "0:42"/"1:12" mock copy (minutes unpadded, seconds
 * zero-padded), never `HH:MM:SS`: a single agent turn is never expected to run for hours. */
function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Mirrors Rust `ActivityLine::label()` exactly (`"{verb} {detail}"`, or `"{verb}…"` with no
 * detail) — both sides render the identical `agent::activity` shape. */
function activityLineLabel(line: ActivityLine): string {
  return line.detail ? `${line.verb} ${line.detail}` : `${line.verb}…`;
}

/** The card's header line for every phase — ux-design.md renders `◔` only while genuinely running
 * (J1/J3) and `■` for every settled/report state (J3's stage-done card, J7's STOPPED card).
 *
 * The `"queued"` case is UXR-Q18's ratified §2 string (`⏳ queued behind an agent run · [Cancel]`,
 * ratified by CJ 2026-09-03, #2257) up to its `·` separator — `[Cancel]` is the already-wired
 * footer button below, a separate rendered element, so this string carries only the header half.
 * Conformed to that copy by CJ's 2026-09-06 ruling on #2298 (option A: "conform the code to the
 * ratified copy"), superseding the earlier name-free `"⏳ Queued"`. */
function headerLabel(phase: AgentWorkingCardData["phase"], elapsedSecs: number): string {
  switch (phase.phase) {
    case "queued":
      return "⏳ queued behind an agent run";
    case "cancelled":
      return "■ Cancelled before start";
    case "running":
      return `◔ Agent working… ${formatElapsed(elapsedSecs)}`;
    case "completed":
    case "recovered":
      return `■ Completed ${formatElapsed(elapsedSecs)}`;
    case "stopped":
      return phase.delivered ? "■ STOPPED — partial delivery" : "■ STOPPED — nothing applied";
    case "failed":
      // Same rendering as a Stop-triggered interruption (ux-design.md J7: "Same rendering for
      // crash/CLI-death").
      return `■ Agent stopped unexpectedly — ${phase.message}`;
  }
}

function completedSummary(card: AgentWorkingCardData): string {
  const summary = summarizeRunActivity(card.activity);
  const pieces = [
    summary.filesRead === null
      ? "files read unknown"
      : summary.filesRead === 0
        ? "no files read"
        : `${summary.filesRead} ${summary.filesRead === 1 ? "file" : "files"} read`,
  ];
  if (summary.changes === null) {
    pieces.push("changes unknown");
  } else if (summary.changes > 0) {
    pieces.push(`${summary.changes} ${summary.changes === 1 ? "change" : "changes"}`);
  }
  return pieces.join(" · ");
}

function waitingLabel(requestedAtMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - requestedAtMs) / 60_000);
  return `waiting ${minutes}m`;
}

interface PermissionRequestBlockProps {
  request: PermissionRequest;
  runId: string;
  first: boolean;
  onDecision?: AgentWorkingCardProps["onPermissionDecision"];
  headingRef: RefCallback<HTMLHeadingElement>;
}

function PermissionRequestBlock({
  request,
  runId,
  first,
  onDecision,
  headingRef,
}: PermissionRequestBlockProps) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [denialOpen, setDenialOpen] = useState(false);
  const [denialReason, setDenialReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const persistentScopeAvailable = request.allowExactCommand || request.allowScript;
  const disabled = !first || submitting;
  const headingId = useId();

  const decide = (decision: PermissionDecision) => {
    if (disabled || !onDecision) return;
    setSubmitting(true);
    setFailure(null);
    void Promise.resolve(onDecision(runId, request.id, decision)).catch((error: unknown) => {
      setSubmitting(false);
      setFailure(errorDetail(error) || "Couldn’t send this decision. Try again.");
    });
  };

  const submitDenial = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = denialReason.trim();
    if (!reason) return;
    decide({ kind: "deny", reason });
  };

  return (
    <section
      className="agent-working-card__permission"
      aria-labelledby={headingId}
      data-permission-order={first ? "first" : "queued"}
      data-permission-request-id={request.id}
    >
      <h3
        ref={headingRef}
        id={headingId}
        className="agent-working-card__permission-heading"
        tabIndex={-1}
        aria-label={`Permission request: ${request.action}`}
      >
        <TriangleAlert size="1em" aria-hidden="true" /> <span>WANTS TO RUN:</span>
      </h3>
      <p className="agent-working-card__permission-action">{request.action}</p>
      <code className="agent-working-card__permission-detail">{request.detail}</code>
      {request.why && <p className="agent-working-card__permission-why">why: “{request.why}”</p>}

      {!denialOpen ? (
        <div className="agent-working-card__permission-actions">
          <button type="button" disabled={disabled} onClick={() => decide({ kind: "allow_once" })}>
            Allow once
          </button>
          <span className="agent-working-card__permission-scope">
            <button
              type="button"
              aria-label="Always allow"
              aria-expanded={scopeOpen}
              disabled={disabled || !persistentScopeAvailable}
              onClick={() => setScopeOpen((open) => !open)}
            >
              Always allow <ChevronDown size="1em" aria-hidden="true" />
            </button>
            {scopeOpen && first && !submitting && (
              <span className="agent-working-card__permission-menu" role="menu">
                {request.allowExactCommand && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => decide({ kind: "allow_exact_command" })}
                  >
                    Always allow this exact command
                  </button>
                )}
                {request.allowScript && (
                  <button type="button" role="menuitem" onClick={() => decide({ kind: "allow_script" })}>
                    Always allow this script
                  </button>
                )}
              </span>
            )}
          </span>
          <button type="button" disabled={disabled} onClick={() => setDenialOpen(true)}>
            Deny — tell it why…
          </button>
        </div>
      ) : (
        <form className="agent-working-card__denial" onSubmit={submitDenial}>
          <label>
            <span>Why are you denying this action?</span>
            <textarea
              value={denialReason}
              disabled={disabled}
              onChange={(event) => setDenialReason(event.target.value)}
              rows={2}
            />
          </label>
          <span className="agent-working-card__denial-actions">
            <button type="submit" disabled={disabled || denialReason.trim().length === 0}>
              Send denial
            </button>
            <button type="button" disabled={disabled} onClick={() => setDenialOpen(false)}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {failure && <p className="agent-working-card__permission-error" role="status">{failure}</p>}
    </section>
  );
}

export function AgentWorkingCard({
  card,
  batchAccounting,
  onStop,
  permissionState,
  onPermissionDecision,
  now = Date.now,
  onCollapsedChange,
  initialCollapsed,
  focusPermissionRequest,
  onFocusPermissionRequestConsumed,
  focusCardRequest,
  submittedTurnLanding = false,
  onFocusCardRequestConsumed,
}: AgentWorkingCardProps) {
  const running = card.phase.phase === "running";
  const queued = card.phase.phase === "queued";
  const permissionRequests =
    running && permissionState?.runId === card.runId ? permissionState.requests : [];
  const waiting = permissionRequests.length > 0;
  const [, setClockTick] = useState(0);
  const defaultCollapsed = isAgentWorkingCollapsedByDefault(card);
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(initialCollapsed ?? null);
  const collapsed = collapsedOverride ?? defaultCollapsed;
  const toggleCollapse = () => setCollapsedOverride(!collapsed);
  const statusHeadingRef = useRef<HTMLSpanElement | null>(null);
  const permissionContainerRef = useRef<HTMLDivElement | null>(null);
  const permissionHeadingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const focusedRequestBeforeChange = useRef<string | null>(null);
  const pendingStatusFocus = useRef(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const consumedCardFocusNonce = useRef<number | null>(null);
  const permissionRequestIds = permissionRequests.map(({ id }) => id);
  const permissionRequestIdsKey = permissionRequestIds.join("\u0000");

  useEffect(() => {
    onCollapsedChange?.(collapsed, collapsedOverride !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onCollapsedChange identity shouldn't retrigger
  }, [collapsed, collapsedOverride]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // A decision can remove the focused control together with its entire permission subtree. The
  // container's focus-capture handler records which block owns focus before React removes it; after
  // the new FIFO commits, move only when that exact block disappeared. Additions and revisions that
  // retain the id remain inert.
  useLayoutEffect(() => {
    const previouslyFocused = focusedRequestBeforeChange.current;
    if (!previouslyFocused || permissionRequestIds.includes(previouslyFocused)) return;
    focusedRequestBeforeChange.current = null;
    const nextHeading = permissionHeadingRefs.current.get(permissionRequestIds[0]);
    if (nextHeading) nextHeading.focus({ preventScroll: true });
    else {
      // A run can complete in the same backend turn that clears its final request. Keep that card
      // expanded so the required status-heading fallback exists instead of collapsing focus away.
      pendingStatusFocus.current = true;
      setCollapsedOverride(false);
      statusHeadingRef.current?.focus({ preventScroll: true });
    }
    // IDs, not revision/object identity: a callback revision that retains the FIFO is silent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionRequestIdsKey]);

  useLayoutEffect(() => {
    if (!pendingStatusFocus.current || !statusHeadingRef.current) return;
    pendingStatusFocus.current = false;
    statusHeadingRef.current.focus({ preventScroll: true });
  });

  useLayoutEffect(() => {
    if (!focusPermissionRequest) return;
    const heading = permissionHeadingRefs.current.get(focusPermissionRequest.requestId);
    if (!heading) return;
    heading.focus({ preventScroll: true });
    onFocusPermissionRequestConsumed?.(focusPermissionRequest.nonce);
  }, [focusPermissionRequest, onFocusPermissionRequestConsumed]);

  useLayoutEffect(() => {
    if (!focusCardRequest || consumedCardFocusNonce.current === focusCardRequest.nonce) return;
    const target = cardRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) return;
    consumedCardFocusNonce.current = focusCardRequest.nonce;
    onFocusCardRequestConsumed?.(focusCardRequest.nonce);
  }, [focusCardRequest, onFocusCardRequestConsumed, collapsed]);

  const waitingNow = now();

  if (collapsed) {
    return (
      <TimelineCard id={card.id} kind={card.kind} compact focusTargetRef={cardRef}
        submittedTurnLanding={submittedTurnLanding}>
        <button
          type="button"
          className="agent-working-card__collapsed"
          aria-expanded={false}
          onClick={toggleCollapse}
        >
          <span className="sr-only">Expand</span>
          {" "}
          <ChevronRight className="agent-working-card__disclosure" aria-hidden="true" />
          <span className="agent-working-card__collapsed-header">
            {headerLabel(card.phase, card.elapsedSecs)}
          </span>
          {" "}
          <span className="agent-working-card__collapsed-summary">· {card.outboundContext && <span className="agent-working-card__inbound-marker">↓ IN </span>}{completedSummary(card)}</span>
        </button>
        {card.outboundContext && <p className="agent-working-card__outbound"><span className="agent-working-card__outbound-marker">↑ OUT</span>{card.outboundContext}</p>}
        {batchAccounting && <BatchAddressStatus {...batchAccounting} />}
      </TimelineCard>
    );
  }

  return (
    <TimelineCard
      submittedTurnLanding={submittedTurnLanding}
      id={card.id}
      kind={card.kind}
      focusTargetRef={cardRef}
      header={
        <span className="agent-working-card__expanded-header">
          <span
            ref={statusHeadingRef}
            className="agent-working-card__header"
            data-phase={card.phase.phase}
            role="heading"
            aria-level={3}
            tabIndex={-1}
          >
            {waiting ? "◔ Agent working…" : headerLabel(card.phase, card.elapsedSecs)}
          </span>
          {waiting && (
            <span className="agent-working-card__waiting">
              <Pause size="1em" aria-hidden="true" /> {waitingLabel(permissionRequests[0].requestedAtMs, waitingNow)}
            </span>
          )}
          {defaultCollapsed && (
            <button
              type="button"
              className="agent-working-card__collapse-toggle"
              aria-expanded={true}
              aria-label="Collapse"
              onClick={toggleCollapse}
            >
              Collapse
            </button>
          )}
        </span>
      }
      footer={
        running || queued ? (
          <button type="button" className="agent-working-card__action" onClick={() => onStop?.(card.runId)}>
            {queued ? "Cancel" : "Stop"}
          </button>
        ) : undefined
      }
    >
      <ul className="agent-working-card__activity">
        {card.activity.map((line, index) => {
          // The last line is "in progress" only while the run is still running — every earlier
          // line, and every line at all once the run has settled, is done (✓).
          const inProgress = running && !waiting && index === card.activity.length - 1;
          const label = activityLineLabel(line);
          return (
            <li key={index}>
              <span aria-hidden="true">{inProgress ? "◔" : "✓"}</span>
              <span className="agent-working-card__activity-label" title={label}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
      {batchAccounting && <BatchAddressStatus {...batchAccounting} />}
      {card.outboundContext && <p className="agent-working-card__outbound"><span className="agent-working-card__outbound-marker">↑ OUT</span>{card.outboundContext}</p>}
      <div
        ref={permissionContainerRef}
        className="agent-working-card__permissions"
        onFocusCapture={(event) => {
          focusedRequestBeforeChange.current =
            event.target.closest<HTMLElement>("[data-permission-request-id]")?.dataset.permissionRequestId ?? null;
        }}
        onBlurCapture={(event) => {
          // A deliberate move outside clears the remembered subtree. When React removes the focused
          // block, `relatedTarget` is absent and the committed FIFO still needs the remembered id.
          if (
            event.relatedTarget instanceof Node &&
            !permissionContainerRef.current?.contains(event.relatedTarget)
          ) {
            focusedRequestBeforeChange.current = null;
          }
        }}
      >
        {permissionRequests.map((request, index) => (
          <PermissionRequestBlock
            key={request.id}
            request={request}
            runId={card.runId}
            first={index === 0}
            onDecision={onPermissionDecision}
            headingRef={(node) => {
              if (node) permissionHeadingRefs.current.set(request.id, node);
              else permissionHeadingRefs.current.delete(request.id);
            }}
          />
        ))}
      </div>
    </TimelineCard>
  );
}
