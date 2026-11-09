// ABOUTME: Pins TD-25's app-scoped status seam: rejection wording, priority, deduplication,
// ABOUTME: dismissal memory, request reset, reviewer redaction, and subscription lifecycle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAppStatusRequest,
  clearOwnedUserAppStatus,
  dismissAppStatus,
  getAppStatus,
  publishUnhandledRejection,
  setAppStatusAudience,
  setUserAppStatus,
  setOwnedUserAppStatus,
  subscribeAppStatus,
} from "./appStatus";

const AUTHOR_PREFIX =
  "Something inside Cowrite didn’t finish. If something doesn’t look right, this may be why.";

describe("app-scoped status seam (TD-25, #2102)", () => {
  beforeEach(() => {
    setAppStatusAudience("author");
    beginAppStatusRequest();
  });

  it("uses the exact author copy and only a readable verbatim reason", () => {
    const cases: [unknown, string][] = [
      [new Error("  disk vanished  "), `${AUTHOR_PREFIX}   disk vanished  `],
      ["  bridge disconnected  ", `${AUTHOR_PREFIX}   bridge disconnected  `],
      [{ message: "typed transport detail" }, `${AUTHOR_PREFIX} typed transport detail`],
      [{ kind: "opaque" }, AUTHOR_PREFIX],
      [null, AUTHOR_PREFIX],
    ];

    for (const [reason, message] of cases) {
      beginAppStatusRequest();
      publishUnhandledRejection(reason);
      expect(getAppStatus()).toMatchObject({ provenance: "unattributed", authorMessage: message });
    }
  });

  it("bails out by state identity for a repeat and replaces it for different words", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppStatus(listener);

    publishUnhandledRejection("first reason");
    const first = getAppStatus();
    publishUnhandledRejection("first reason");
    expect(getAppStatus()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    publishUnhandledRejection("second reason");
    expect(getAppStatus()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    publishUnhandledRejection("third reason");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never replaces or queues behind a user-request status", () => {
    setUserAppStatus("Opening review…");
    publishUnhandledRejection("lost while opening");
    expect(getAppStatus()).toMatchObject({
      provenance: "user",
      authorMessage: "Opening review…",
    });

    setUserAppStatus(null);
    expect(getAppStatus()).toBeNull();
    publishUnhandledRejection("lost while opening");
    expect(getAppStatus()).toMatchObject({
      provenance: "unattributed",
      authorMessage: `${AUTHOR_PREFIX} lost while opening`,
    });
  });

  it("clears an owned user status only while that exact publication still owns the slot", () => {
    const first = setOwnedUserAppStatus("Formatting is still loading.");
    expect(getAppStatus()).toBe(first);

    const second = setOwnedUserAppStatus("Formatting is still loading.");
    expect(getAppStatus()).toBe(second);
    expect(second).not.toBe(first);

    clearOwnedUserAppStatus(first);
    expect(getAppStatus()).toBe(second);
    clearOwnedUserAppStatus(second);
    expect(getAppStatus()).toBeNull();
  });

  it("keeps a dismissed string quiet until different words arrive or a new request starts", () => {
    publishUnhandledRejection("same reason");
    dismissAppStatus();
    publishUnhandledRejection("same reason");
    expect(getAppStatus()).toBeNull();

    publishUnhandledRejection("different reason");
    expect(getAppStatus()?.authorMessage).toBe(`${AUTHOR_PREFIX} different reason`);
    dismissAppStatus();
    beginAppStatusRequest();
    publishUnhandledRejection("different reason");
    expect(getAppStatus()?.authorMessage).toBe(`${AUTHOR_PREFIX} different reason`);
  });

  it("treats hidden reviewer details as the same displayed message after dismissal", () => {
    setAppStatusAudience("reviewer");
    publishUnhandledRejection("C:\\private\\first.md");
    expect(getAppStatus()?.reviewerMessage).toBe(AUTHOR_PREFIX);
    dismissAppStatus();

    publishUnhandledRejection("C:\\private\\second.md");
    expect(getAppStatus()).toBeNull();
  });
});
