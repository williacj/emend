// ABOUTME: Pins the renderer tab-session lane's ordering, receipt propagation, and release behavior.
// ABOUTME: Uses a controllable backend double so concurrency assertions never depend on sleeps.

import { describe, expect, it, vi } from "vitest";
import {
  createPersistentWriterId,
  createSessionPersistence,
  type SessionPayload,
  type TabSessionBackend,
  type TabSessionReceipt,
} from "./sessionPersistence";

const empty: SessionPayload = { tabs: [], activePath: null };

function receipt(revision: string, session = empty): TabSessionReceipt {
  return { revision, session, outcomes: [] };
}

function backend(): TabSessionBackend {
  return {
    begin: vi.fn().mockResolvedValue({
      canonicalRoot: "/project",
      attachmentId: "attachment-a",
      revision: "r0",
      session: empty,
    }),
    save: vi.fn(),
    prove: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("session persistence", () => {
  it("reuses one window-scoped writer id across reload without sharing another window", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const createUuid = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const first = createPersistentWriterId(storage, createUuid, "main");

    expect(first("/project-a")).toBe("tab-session:main:first");
    expect(first("/project-b")).toBe("tab-session:main:first");

    const afterReload = createPersistentWriterId(storage, vi.fn(() => "unused"), "main");
    expect(afterReload("/project-a")).toBe("tab-session:main:first");
    expect(afterReload("/project-b")).toBe("tab-session:main:first");

    const secondWindow = createPersistentWriterId(storage, createUuid, "secondary");
    expect(secondWindow("/project-a")).toBe("tab-session:secondary:second");
  });

  it("serializes saves and supplies each acknowledged revision to the next write", async () => {
    const api = backend();
    let finishFirst!: (value: TabSessionReceipt) => void;
    vi.mocked(api.save)
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(receipt("r2"));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");
    await persistence.begin("/project");

    const first = persistence.save("/project", empty);
    const second = persistence.save("/project", empty);
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenLastCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r0",
      empty,
      "background",
    );

    finishFirst(receipt("r1"));
    await first;
    await second;
    expect(api.save).toHaveBeenLastCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r1",
      empty,
      "background",
    );
  });

  it("a failed save does not poison retry and does not invent a new revision", async () => {
    const api = backend();
    vi.mocked(api.save)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(receipt("r1"));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");
    await persistence.begin("/project");

    await expect(persistence.save("/project", empty)).rejects.toThrow("offline");
    await persistence.save("/project", empty, "require_untitled_lossless");

    expect(api.save).toHaveBeenLastCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r0",
      empty,
      "require_untitled_lossless",
    );
  });

  it("serializes an authoritative no-write proof in the same lane without advancing revision", async () => {
    const api = backend();
    vi.mocked(api.prove).mockResolvedValue(receipt("r0"));
    vi.mocked(api.save).mockResolvedValue(receipt("r1"));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");
    await persistence.begin("/project");

    await expect(persistence.prove("/project", empty)).resolves.toEqual(receipt("r0"));
    await persistence.save("/project", empty, "require_untitled_lossless");

    expect(api.prove).toHaveBeenCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r0",
      empty,
    );
    expect(api.save).toHaveBeenCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r0",
      empty,
      "require_untitled_lossless",
    );
  });

  it("release waits for the queued write and refuses new writes once closing starts", async () => {
    const api = backend();
    let finish!: (value: TabSessionReceipt) => void;
    vi.mocked(api.save).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");
    await persistence.begin("/project");
    const saving = persistence.save("/project", empty);

    const ending = persistence.end("/project");
    await expect(persistence.save("/project", empty)).rejects.toThrow("not open");
    expect(api.end).not.toHaveBeenCalled();

    finish(receipt("r1"));
    await saving;
    await ending;
    expect(api.end).toHaveBeenCalledWith("/project", "writer-a", "attachment-a");
  });

  it("does not install a local lane when backend acquisition is refused", async () => {
    const api = backend();
    vi.mocked(api.begin).mockRejectedValueOnce({ kind: "WriterBusy", message: "owned" });
    const persistence = createSessionPersistence(api, () => "writer-b", () => "attachment-b");

    await expect(persistence.begin("/project")).rejects.toEqual({
      kind: "WriterBusy",
      message: "owned",
    });
    await expect(persistence.save("/project", empty)).rejects.toThrow("not open");
  });

  it("keeps a canonical alias attached when the old raw spelling releases late", async () => {
    const api = backend();
    vi.mocked(api.begin).mockResolvedValue({
      revision: "r0",
      session: empty,
      canonicalRoot: "/project",
      attachmentId: "attachment-a",
    } as never);
    vi.mocked(api.save).mockResolvedValue(receipt("r1"));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");

    await persistence.begin("/project/.");
    await persistence.begin("/project");
    await persistence.end("/project/.");
    await expect(persistence.save("/project", empty)).resolves.toEqual(receipt("r1"));

    expect(api.end).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledWith(
      "/project",
      "writer-a",
      "attachment-a",
      "r0",
      empty,
      "background",
    );
  });

  it("waits for a closing raw lane before reacquiring its authoritative snapshot", async () => {
    const api = backend();
    const latest: SessionPayload = {
      tabs: [{ path: "latest.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "latest.md",
    };
    vi.mocked(api.begin)
      .mockResolvedValueOnce({
        canonicalRoot: "/project",
        attachmentId: "attachment-a",
        revision: "r0",
        session: empty,
      })
      .mockResolvedValueOnce({
        canonicalRoot: "/project",
        attachmentId: "attachment-a",
        revision: "r0",
        session: empty,
      })
      .mockResolvedValueOnce({
        canonicalRoot: "/project",
        attachmentId: "attachment-a",
        revision: "r1",
        session: latest,
      });
    let finishSave!: (value: TabSessionReceipt) => void;
    vi.mocked(api.save).mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
    const persistence = createSessionPersistence(api, () => "writer-a", () => "attachment-a");
    await persistence.begin("/project");
    const saving = persistence.save("/project", empty);
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    const ending = persistence.end("/project");
    const reopening = persistence.begin("/project");
    await vi.waitFor(() => expect(api.begin).toHaveBeenCalledTimes(2));
    expect(api.end).not.toHaveBeenCalled();

    finishSave(receipt("r1"));
    await saving;
    await ending;
    await expect(reopening).resolves.toEqual(latest);
    expect(api.begin).toHaveBeenCalledTimes(3);
    expect(api.end).toHaveBeenCalledTimes(1);
  });
});
