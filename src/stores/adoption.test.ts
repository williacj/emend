// ABOUTME: Pins the frontend wire shape for the durable omission-aware adoption lifecycle.
// ABOUTME: Keeps command names/casing and transcript schema cleanup aligned with the Rust edge.

import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({
  callBackend: (...args: unknown[]) => callBackendMock(...args),
}));

const { cancelAdoption, commitAdoption, landAdoption, prepareAdoption, reconcileAdoptions } = await import("./adoption");

describe("stores/adoption", () => {
  beforeEach(() => callBackendMock.mockReset().mockResolvedValue(undefined));

  it("uses the Rust command field names for prepare, land, commit, and cancel", async () => {
    callBackendMock.mockResolvedValueOnce("canonical/new.md");
    await expect(
      prepareAdoption("/project", "a1", "old.md", "new.md", "doc-1", true, "body", "timestamp"),
    ).resolves.toBe("canonical/new.md");
    callBackendMock.mockResolvedValueOnce({
      revision: "blake3:body",
      destination: "canonical/new.md",
      pending: false,
    });
    await expect(landAdoption("/project", "a1", "body")).resolves.toEqual({
      revision: "blake3:body",
      destination: "canonical/new.md",
      pending: false,
    });
    await commitAdoption("/project", "a1", "blake3:body");
    await cancelAdoption("/project", "a1");

    expect(callBackendMock.mock.calls).toEqual([
      ["prepare_adoption", {
        root: "/project",
        adoptionId: "a1",
        displacedPath: "old.md",
        destination: "new.md",
        docId: "doc-1",
        recoveryContentOmitted: true,
        content: "body",
        timestamp: "timestamp",
      }],
      ["land_adoption", { root: "/project", adoptionId: "a1", content: "body" }],
      ["commit_adoption", { root: "/project", adoptionId: "a1", landedRevision: "blake3:body" }],
      ["cancel_adoption", { root: "/project", adoptionId: "a1" }],
    ]);
  });

  it("keeps persisted D15 fields while removing only the Rust schema envelope", async () => {
    callBackendMock.mockResolvedValue({
      published: [{
        schema_version: 1,
        id: "adoption-a1",
        kind: "untitled-adoption",
        timestamp: "timestamp",
        adoptionId: "a1",
        displacedPath: "old.md",
        destination: "new.md",
      }],
      pendingDestinations: ["pending.md"],
      collisions: [{ destination: "pending.md", docId: "scratch", existingDocId: "incumbent" }],
    });

    await expect(reconcileAdoptions("/project")).resolves.toEqual({
      published: [{
        id: "adoption-a1",
        kind: "untitled-adoption",
        timestamp: "timestamp",
        adoptionId: "a1",
        displacedPath: "old.md",
        destination: "new.md",
      }],
      pendingDestinations: ["pending.md"],
      collisions: [{ destination: "pending.md", docId: "scratch", existingDocId: "incumbent" }],
    });
    expect(callBackendMock).toHaveBeenCalledWith("reconcile_adoptions", { root: "/project" });
  });
});
