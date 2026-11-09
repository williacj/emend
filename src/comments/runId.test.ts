// ABOUTME: Pins `resolvedRunId`'s empty-acknowledgement fallback and portable fallback-id minting.
// ABOUTME: Covers the restart boundary where a session-scoped address-run counter collides (#1782).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvedRunId } from "./runId";

describe("comments/runId — resolvedRunId", () => {
  it("returns start_run's own id when it named a real run", () => {
    expect(resolvedRunId("run-abc-123")).toBe("run-abc-123");
  });

  it("falls back to a fresh client-minted id when start_run returned an empty acknowledgement", () => {
    const id = resolvedRunId("");
    expect(id).toBeTruthy();
    expect(id).not.toBe("");
  });
});

describe("comments/runId — fallback ids across an app restart (#1782)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("never repeats a fallback id a previous session already persisted", async () => {
    // Both sessions start from a pristine registry. Comparing a fresh launch against this test
    // file's statically imported instance would be the vacuous #1728 shape: earlier tests may
    // already have advanced that instance's counter beyond the freshly restarted one.
    vi.resetModules();
    const firstSessionId = (await import("./runId")).mintRunId();
    vi.resetModules();
    const secondSessionId = (await import("./runId")).mintRunId();

    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it("keeps that guarantee where the webview exposes no crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    vi.resetModules();
    const firstSessionId = (await import("./runId")).mintRunId();
    vi.resetModules();
    const secondSessionId = (await import("./runId")).mintRunId();

    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it("mints a uuid-shaped id on the ordinary webview path", async () => {
    vi.resetModules();

    expect((await import("./runId")).mintRunId()).toMatch(
      /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
