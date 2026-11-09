// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a integration (#345) acceptance criteria: the live
// ABOUTME: activity feed + elapsed time + wired [Stop], and each of the four honest terminal
// ABOUTME: states (J7) once a run resolves — no retry affordances (P3-3's job).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentWorkingCard } from "./AgentWorkingCard";
import { createAgentWorkingCard } from "./types";
import type { RunStatus } from "./agentActivity";
import type { PermissionState } from "./permission";

function statusWith(overrides: Partial<RunStatus>): RunStatus {
  return {
    id: "run-1",
    phase: { phase: "running" },
    activity: [],
    elapsedSecs: 0,
    ...overrides,
  };
}

describe("timeline/AgentWorkingCard", () => {
  it("#2539 shows the outbound line on a running batch owner's card", () => {
    const card = {
      ...createAgentWorkingCard(statusWith({})),
      outboundContext: "carried draft.md as edited",
    };
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText("↑ OUT")).toBeInTheDocument();
    expect(screen.getByText("carried draft.md as edited")).toBeInTheDocument();
  });

  it("#2539 retains outbound direction beneath the completed summary", () => {
    const card = {
      ...createAgentWorkingCard(statusWith({ phase: { phase: "completed", reply: null }, activity: [], elapsedSecs: 17 })),
      outboundContext: "carried draft.md by name only — over Emend’s size limit",
    };
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText("↓ IN")).toBeInTheDocument();
    expect(screen.getByText("↑ OUT")).toBeInTheDocument();
    expect(screen.getByText(card.outboundContext)).toBeInTheDocument();
    expect(screen.getByText(card.outboundContext).closest(".agent-working-card__collapsed")).toBeNull();
  });

  it("keeps partial batch accounting visible when a completed run collapses", () => {
    const card = createAgentWorkingCard(statusWith({
      phase: { phase: "completed", reply: null }, activity: [], elapsedSecs: 17,
    }));
    const { container } = render(<AgentWorkingCard card={card} batchAccounting={{
      batchNumber: 2,
      outcome: {
        run_id: "run-1", addressed: ["a"], skipped: [], untouched: ["b"],
        interrupted: "sidecar write failed", threads: [],
      },
    }} />);
    expect(screen.getByRole("button", { name: /Expand/ })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".batch-address-status")?.textContent)
      .toMatch(/Batch 2.*1 addressed.*1 untouched.*stopped early: sidecar write failed/);
    expect(container.querySelector(".batch-address-status")?.closest(".agent-working-card__collapsed"))
      .toBeNull();
  });
  const permissionState: PermissionState = {
    projectId: "project-a",
    runId: "run-1",
    revision: 4,
    requests: [
      {
        id: "permission-1",
        action: "Bash",
        detail: "python scripts/check.py drafts/sermon.md",
        why: "verify all citations before stage 2",
        requestedAtMs: Date.parse("2026-09-07T12:00:00.000Z"),
        allowExactCommand: true,
        allowScript: false,
      },
      {
        id: "permission-2",
        action: "Write",
        detail: "reports/check.txt",
        why: "save the check results",
        requestedAtMs: Date.parse("2026-09-07T12:01:00.000Z"),
        allowExactCommand: false,
        allowScript: true,
      },
    ],
  };

  it("renders the running activity feed's verbs and details — elapsed time and a Stop button", () => {
    const card = createAgentWorkingCard(
      statusWith({
        activity: [
          { verb: "Reading", detail: "claude.md" },
          { verb: "Reading", detail: "grammar/SKILL.md" },
          { verb: "Drafting" },
        ],
        elapsedSecs: 42,
      }),
    );
    render(<AgentWorkingCard card={card} />);

    expect(screen.getByText("Reading claude.md")).toBeTruthy();
    expect(screen.getByText("Reading grammar/SKILL.md")).toBeTruthy();
    expect(screen.getByText("Drafting…")).toBeTruthy();
    expect(screen.getByText(/0:42/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("keeps an unbroken activity token on one bounded line while exposing its full label", () => {
    const detail = "C:/Users/williacj/github/" + "very-long-project-segment/".repeat(8);
    const card = createAgentWorkingCard(
      statusWith({ activity: [{ verb: "Running", detail }] }),
    );
    const { container } = render(<AgentWorkingCard card={card} />);

    const label = container.querySelector(".agent-working-card__activity-label");
    expect(label).not.toBeNull();
    expect(label?.getAttribute("title")).toBe(`Running ${detail}`);
    expect(label?.textContent).toBe(`Running ${detail}`);
  });

  it("formats elapsed time as m:ss (minutes unpadded — seconds zero-padded)", () => {
    const card = createAgentWorkingCard(statusWith({ elapsedSecs: 72 }));
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText(/1:12/)).toBeTruthy();
  });

  it("calls onStop with the card's run id when Stop is clicked", () => {
    const onStop = vi.fn();
    const card = createAgentWorkingCard(statusWith({ id: "run-42" }));
    render(<AgentWorkingCard card={card} onStop={onStop} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("run-42");
  });

  it("stacks a matching run's requests in FIFO order, pauses its activity, and keeps Stop usable (J7 / mock 1d)", () => {
    const onStop = vi.fn();
    const card = createAgentWorkingCard(
      statusWith({ activity: [{ verb: "Reading", detail: "workflows/sermon.md" }] }),
    );
    const { container } = render(
      <AgentWorkingCard
        card={card}
        permissionState={permissionState}
        onStop={onStop}
        now={() => Date.parse("2026-09-07T12:04:45.000Z")}
      />,
    );

    expect(screen.getByText("waiting 4m")).toBeTruthy();
    expect(screen.getAllByText("WANTS TO RUN:")).toHaveLength(2);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("python scripts/check.py drafts/sermon.md")).toBeTruthy();
    expect(screen.getByText('why: “verify all citations before stage 2”')).toBeTruthy();
    expect(container.querySelector(".agent-working-card__activity li > span")?.textContent).toBe("✓");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("run-1");
  });

  it("keeps the waiting age live while an ignored request remains pending", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-09-07T12:04:45.000Z");
      const card = createAgentWorkingCard(statusWith({}));
      render(
        <AgentWorkingCard
          card={card}
          permissionState={{ ...permissionState, requests: permissionState.requests.slice(0, 1) }}
        />,
      );

      expect(screen.getByText("waiting 4m")).toBeTruthy();
      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByText("waiting 5m")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables decisions only for the first request and exposes only backend-authorized persistent scopes", () => {
    const onPermissionDecision = vi.fn();
    const card = createAgentWorkingCard(statusWith({}));
    const firstRender = render(
      <AgentWorkingCard
        card={card}
        permissionState={permissionState}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    const allowOnce = screen.getAllByRole("button", { name: "Allow once" });
    const alwaysAllow = screen.getAllByRole("button", { name: "Always allow" });
    expect(allowOnce[0]).toBeEnabled();
    expect(allowOnce[1]).toBeDisabled();
    expect(alwaysAllow[0]).toBeEnabled();
    expect(alwaysAllow[1]).toBeDisabled();

    fireEvent.click(alwaysAllow[0]);
    expect(screen.queryByRole("menuitem", { name: "Always allow this script" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Always allow this exact command" }));
    expect(onPermissionDecision).toHaveBeenCalledWith("run-1", "permission-1", {
      kind: "allow_exact_command",
    });
    expect(screen.queryByText("reports/check.txt")?.closest("section")?.querySelectorAll("button:enabled"))
      .toHaveLength(0);
    firstRender.unmount();

    render(
      <AgentWorkingCard
        card={card}
        permissionState={{ ...permissionState, requests: permissionState.requests.slice(1) }}
      />,
    );
    const scriptScope = screen.getByRole("button", { name: "Always allow" });
    fireEvent.click(scriptScope);
    expect(screen.getByRole("menuitem", { name: "Always allow this script" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: "Always allow this exact command" })).toBeNull();
  });

  it("routes allow-once and an inline trimmed denial reason without moving focus into the note", async () => {
    const onPermissionDecision = vi.fn().mockResolvedValue(undefined);
    const card = createAgentWorkingCard(statusWith({}));
    const { unmount } = render(
      <AgentWorkingCard
        card={card}
        permissionState={{ ...permissionState, requests: permissionState.requests.slice(0, 1) }}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onPermissionDecision).toHaveBeenCalledWith("run-1", "permission-1", { kind: "allow_once" });

    unmount();

    onPermissionDecision.mockClear();
    render(
      <AgentWorkingCard
        card={card}
        permissionState={{ ...permissionState, requests: permissionState.requests.slice(0, 1) }}
        onPermissionDecision={onPermissionDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny — tell it why…" }));
    const reason = screen.getByRole("textbox", { name: "Why are you denying this action?" });
    expect(reason).not.toHaveFocus();
    fireEvent.change(reason, { target: { value: "  Use the checked report instead.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send denial" }));

    expect(onPermissionDecision).toHaveBeenCalledWith("run-1", "permission-1", {
      kind: "deny",
      reason: "Use the checked report instead.",
    });
  });

  it("labels each permission section by a focusable heading and recovers focus across FIFO clearing", () => {
    const card = createAgentWorkingCard(statusWith({}));
    const view = render(
      <AgentWorkingCard card={card} permissionState={permissionState} />,
    );
    const firstHeading = screen.getByRole("heading", { name: "Permission request: Bash" });
    expect(firstHeading).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("region", { name: "Permission request: Bash" })).toContainElement(firstHeading);
    screen.getAllByRole("button", { name: "Always allow" })[0].focus();

    view.rerender(
      <AgentWorkingCard
        card={card}
        permissionState={{ ...permissionState, revision: 5, requests: permissionState.requests.slice(1) }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Permission request: Write" })).toHaveFocus();

    screen.getByRole("heading", { name: "Permission request: Write" }).focus();
    view.rerender(
      <AgentWorkingCard
        card={card}
        permissionState={{ ...permissionState, revision: 6, requests: [] }}
      />,
    );
    expect(screen.getByRole("heading", { name: /Agent working/ })).toHaveFocus();
  });

  it("keeps a synchronously completed run expanded when its clearing permission subtree owned focus", () => {
    const runningCard = createAgentWorkingCard(statusWith({}));
    const view = render(
      <AgentWorkingCard card={runningCard} permissionState={permissionState} />,
    );
    screen.getAllByRole("button", { name: "Deny — tell it why…" })[0].focus();

    view.rerender(
      <AgentWorkingCard
        card={createAgentWorkingCard(statusWith({ phase: { phase: "completed", reply: null } }))}
        permissionState={{ ...permissionState, revision: 5, requests: [] }}
      />,
    );

    expect(screen.getByRole("heading", { name: /Completed/ })).toHaveFocus();
    expect(screen.getByRole("heading", { name: /Completed/ }).closest("article")).not.toHaveClass(
      "timeline-card--collapsed",
    );
  });

  it("shows stale-script recovery guidance and keeps denial available after a rejected decision", async () => {
    const guidance = "This script could not be verified or changed while waiting. Deny this request and ask the agent to try again.";
    const onPermissionDecision = vi.fn().mockRejectedValue({ kind: "invalid_arguments", message: guidance });
    render(
      <AgentWorkingCard
        card={createAgentWorkingCard(statusWith({}))}
        permissionState={{ ...permissionState, requests: [{ ...permissionState.requests[0], allowScript: true }] }}
        onPermissionDecision={onPermissionDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Always allow this script" }));
    expect(await screen.findByRole("status")).toHaveTextContent(guidance);
    expect(screen.queryByText("Couldn’t send this decision. Try again.")).toBeNull();
    expect(screen.getByRole("button", { name: "Deny — tell it why…" })).toBeEnabled();
    expect(onPermissionDecision).toHaveBeenCalledWith("run-1", "permission-1", { kind: "allow_script" });
  });

  it("renders no permission controls for another run", () => {
    const runningCard = createAgentWorkingCard(statusWith({ id: "another-run" }));
    render(
      <AgentWorkingCard card={runningCard} permissionState={permissionState} />,
    );
    expect(screen.queryByText("WANTS TO RUN:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("renders no permission controls once the matching run is terminal", () => {
    const terminalCard = createAgentWorkingCard(
      statusWith({ phase: { phase: "completed", reply: null } }),
    );
    render(<AgentWorkingCard card={terminalCard} permissionState={permissionState} initialCollapsed={false} />);
    expect(screen.queryByText("WANTS TO RUN:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("renders a queued run from depth two without a stale ordinal and with a Cancel action (FR-AGENT-7)", () => {
    const onStop = vi.fn();
    const card = createAgentWorkingCard({
      id: "run-1",
      phase: { phase: "queued", position: 2 },
      activity: [],
      elapsedSecs: 0,
    });
    render(<AgentWorkingCard card={card} onStop={onStop} />);

    // Exact whole-text match (not a substring/regex) — UXR-Q18's ratified §2 header,
    // character-exact per CJ's 2026-09-06 ruling on #2298 (option A: "conform the code to the
    // ratified copy"). The full ratified string is `⏳ queued behind an agent run · [Cancel]`
    // (docs/ux-design.md); the ` · [Cancel]` half is the already-wired footer button below,
    // rendered as a separate element, so this header text carries only the string up to that
    // separator.
    expect(screen.getByText("⏳ queued behind an agent run")).toBeTruthy();
    expect(screen.queryByText(/position/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onStop).toHaveBeenCalledWith("run-1");
  });

  it("renders no Stop button once a run has resolved to any terminal phase", () => {
    const card = createAgentWorkingCard(statusWith({ phase: { phase: "completed", reply: null } }));
    render(<AgentWorkingCard card={card} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("renders a completed run honestly", () => {
    const card = createAgentWorkingCard(statusWith({ phase: { phase: "completed", reply: null } }));
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText(/Completed/)).toBeTruthy();
  });

  it("collapses a completed run to elapsed time, distinct files read, and distinct changes — expanding restores the full feed (#1725)", () => {
    const card = createAgentWorkingCard(
      statusWith({
        phase: { phase: "completed", reply: null },
        elapsedSecs: 17,
        activity: [
          { verb: "Reading", detail: "sermon.md" },
          { verb: "Reading", detail: "./sermon.md" },
          { verb: "Reading", detail: "notes/outline.md" },
          { verb: "Editing", detail: "sermon.md" },
          { verb: "Writing", detail: "notes/outline.md" },
          { verb: "Delivering", detail: "sermon.md" },
          { verb: "Drafting" },
        ],
      }),
    );
    render(<AgentWorkingCard card={card} />);

    const expand = screen.getByRole("button", {
      name: "Expand ■ Completed 0:17 · 2 files read · 2 changes",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    const disclosure = expand.querySelector(".agent-working-card__disclosure");
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Drafting…")).toBeNull();

    fireEvent.click(expand);
    expect(screen.getByText("Drafting…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
  });

  it("renders a visible leading disclosure icon without replacing the accessible Expand summary (#1725)", () => {
    const card = createAgentWorkingCard(
      statusWith({
        phase: { phase: "completed", reply: null },
        elapsedSecs: 9,
        activity: [{ verb: "Drafting" }],
      }),
    );
    render(<AgentWorkingCard card={card} />);

    const expand = screen.getByRole("button", {
      name: "Expand ■ Completed 0:09 · no files read",
    });
    const disclosure = expand.querySelector(".agent-working-card__disclosure");
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveAttribute("aria-hidden", "true");
  });

  it("says no files read only for a known zero and omits a known-zero change count (#1725)", () => {
    const card = createAgentWorkingCard(
      statusWith({
        phase: { phase: "completed", reply: null },
        elapsedSecs: 9,
        activity: [{ verb: "Drafting" }],
      }),
    );
    render(<AgentWorkingCard card={card} />);

    expect(
      screen.getByRole("button", { name: "Expand ■ Completed 0:09 · no files read" }),
    ).toBeTruthy();
    expect(screen.queryByText(/0 changes/)).toBeNull();
  });

  it("renders unknown rather than a false zero when a persisted counted activity lacks its path (#1725)", () => {
    const card = createAgentWorkingCard(
      statusWith({
        phase: { phase: "completed", reply: null },
        elapsedSecs: 11,
        activity: [
          { verb: "Reading" },
          { verb: "Editing" },
        ],
      }),
    );
    render(<AgentWorkingCard card={card} />);

    expect(
      screen.getByRole("button", {
        name: "Expand ■ Completed 0:11 · files read unknown · changes unknown",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/no files read/)).toBeNull();
  });

  it.each([
    ["running", { phase: "running" } as const],
    ["stopped", { phase: "stopped", delivered: false } as const],
    ["failed", { phase: "failed", message: "claude exited unexpectedly" } as const],
  ])("keeps a %s run expanded with no collapse affordance", (_label, phase) => {
    const card = createAgentWorkingCard(
      statusWith({ phase, activity: [{ verb: "Drafting" }] }),
    );
    render(<AgentWorkingCard card={card} />);

    expect(screen.getByText("Drafting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("keeps running, Stopped, and Failed cards expanded so live work and recovery context stay visible (#1725)", () => {
    const phases = [
      { phase: "running" } as const,
      { phase: "stopped", delivered: false } as const,
      { phase: "failed", message: "claude exited unexpectedly" } as const,
    ];
    for (const phase of phases) {
      const { unmount } = render(
        <AgentWorkingCard
          card={createAgentWorkingCard(
            statusWith({ phase, activity: [{ verb: "Drafting" }] }),
          )}
        />,
      );
      expect(screen.getByText("Drafting…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
      unmount();
    }
  });

  it("renders STOPPED — nothing applied for a stop with no delivery observed (ux-design.md J7)", () => {
    const card = createAgentWorkingCard(statusWith({ phase: { phase: "stopped", delivered: false } }));
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText(/STOPPED — nothing applied/)).toBeTruthy();
  });

  it("renders STOPPED — partial delivery for a stop after a propose_changes announcement (ux-design.md J7)", () => {
    const card = createAgentWorkingCard(statusWith({ phase: { phase: "stopped", delivered: true } }));
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText(/STOPPED — partial delivery/)).toBeTruthy();
  });

  it("renders unexpected CLI death honestly — carrying the failure message (ux-design.md J7)", () => {
    const card = createAgentWorkingCard(
      statusWith({ phase: { phase: "failed", message: "claude exited unexpectedly" } }),
    );
    render(<AgentWorkingCard card={card} />);
    expect(screen.getByText(/Agent stopped unexpectedly/)).toBeTruthy();
    expect(screen.getByText(/claude exited unexpectedly/)).toBeTruthy();
  });
});
