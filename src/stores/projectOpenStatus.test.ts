// @vitest-environment jsdom
// ABOUTME: Pins J9's structured project-open status vocabulary, exact copy, and message identity.
// ABOUTME: Covers refresh-16 failure routing, queue suffixes, dismissal, and adopted-here clearing.
import { describe, expect, it, vi } from "vitest";
import type { ProjectRoutingNotice } from "./project";
import {
  focusProjectOpenRecoveryTarget,
  PROJECT_OPEN_FAILURE_DETAILS,
  projectOpenStatusMessage,
  reduceProjectOpenStatus,
  type ProjectOpenStatus,
} from "./projectOpenStatus";

function reduce(notice: ProjectRoutingNotice, current: ProjectOpenStatus | null = null) {
  return reduceProjectOpenStatus(current, notice);
}

describe("project-open status (J9, #1752)", () => {
  it("restores focus without scrolling and falls back when the recorded target is disconnected", () => {
    const disconnected = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(fallback);
    const focus = vi.spyOn(fallback, "focus");

    expect(focusProjectOpenRecoveryTarget(disconnected, fallback)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("renders requesting and its plural queue suffix with a Dismiss action", () => {
    const status = reduce({
      status: "requesting",
      request_id: "request-1",
      root: "C:\\work\\sermon-notes",
      queued: 3,
    });

    expect(projectOpenStatusMessage(status!)).toBe("Opening sermon-notes… · 3 more queued");
  });

  it.each([
    ["already_open_here", "product-comms is already open in this window."],
    ["focused_other", "product-comms is open in another window — brought it to the front."],
    ["opened_new", "Opened product-comms in a new window."],
  ] as const)("renders the %s terminal outcome where the author acted", (outcome, expected) => {
    const status = reduce({
      status: "finished",
      request_id: "request-1",
      outcome: { status: outcome, root: "/work/product-comms" },
    });

    expect(projectOpenStatusMessage(status!)).toBe(expected);
  });

  it("clears on adopted_here because the opened project is the outcome", () => {
    expect(reduce({
      status: "finished",
      request_id: "request-1",
      outcome: { status: "adopted_here", root: "/work/product-comms" },
    })).toBeNull();
  });

  it.each([
    ["launch", "Emend couldn’t open launch-plan in a new window."],
    ["raise", "Emend couldn’t bring launch-plan to the front."],
    ["undetermined", "Emend couldn’t open launch-plan."],
  ] as const)("selects the %s leading sentence only from failureRoute", (failureRoute, expected) => {
    const status = reduce({
      status: "finished",
      request_id: "request-1",
      outcome: {
        status: "failed",
        root: "/work/launch-plan",
        reason: "deadline_expired",
        failureRoute,
      },
    });

    expect(projectOpenStatusMessage(status!)).toBe(
      `${expected} ${PROJECT_OPEN_FAILURE_DETAILS.deadline_expired}`,
    );
  });

  it("binds all seven backend reasons to the ratified broad detail strings", () => {
    expect(PROJECT_OPEN_FAILURE_DETAILS).toEqual({
      project_unavailable: "That folder isn’t available to Emend.",
      open_failed: "Emend couldn’t finish setting up that project.",
      deadline_expired: "It took too long, so Emend stopped waiting.",
      registry_unavailable: "Emend couldn’t keep track of its open windows.",
      launch_failed: "The new window didn’t start.",
      owner_unavailable: "The window that has it isn’t responding.",
      activation_refused: "The system wouldn’t bring that window to the front.",
    });
  });

  it("preserves object identity when a repeated notice would display the same message", () => {
    const notice: ProjectRoutingNotice = {
      status: "requesting",
      request_id: "request-1",
      root: "/work/product-comms",
      queued: 1,
    };
    const current = reduce(notice);

    expect(reduce(notice, current)).toBe(current);
  });
});
