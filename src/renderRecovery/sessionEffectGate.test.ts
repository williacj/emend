// ABOUTME: Pins TD-28's hidden-candidate quiescence at the existing tab-session IPC adapters.
// ABOUTME: Proves no durable save or D21 projection occurs until atomic candidate promotion.
import { describe, expect, it, vi } from "vitest";
import { createSessionEffectGate } from "./sessionEffectGate";

describe("render-recovery session effect gate", () => {
  it("suppresses hidden saves, buffers only the latest projection, and releases tentatively", async () => {
    const save = vi.fn().mockName("durable candidate save").mockResolvedValue({
      revision: "mutated",
      session: { tabs: [], activePath: null },
      outcomes: [],
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const gate = createSessionEffectGate("candidate");
    await gate.acquire("/project", () => Promise.resolve({}), end);

    const session = { tabs: [], activePath: null };
    const receipt = await gate.save(session, save);
    gate.publishOpenTabs(() => publish("first"));
    gate.publishOpenTabs(() => publish("latest"));

    expect(receipt.session).toEqual(session);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await gate.release();
    expect(end).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    await gate.end("/project", end);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight acquisition before releasing tentative authority", async () => {
    let finishAcquire: (() => void) | undefined;
    const acquisition = new Promise<void>((resolve) => { finishAcquire = resolve; });
    const end = vi.fn().mockResolvedValue(undefined);
    const gate = createSessionEffectGate("candidate");
    const begin = gate.acquire("/project", () => acquisition, end);

    let released = false;
    const release = gate.release().then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(end).not.toHaveBeenCalled();
    finishAcquire?.();
    await Promise.all([begin, release]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("promotion emits one buffered projection and later mutations use the ordinary lane", async () => {
    const save = vi.fn().mockResolvedValue({ revision: "2", session: { tabs: [], activePath: null }, outcomes: [] });
    const publish = vi.fn().mockResolvedValue(undefined);
    const gate = createSessionEffectGate("candidate");
    gate.publishOpenTabs(() => publish("latest"));

    await gate.promote();
    expect(publish).toHaveBeenCalledTimes(1);
    await gate.save({ tabs: [], activePath: null }, save);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("suppresses late writes and projections after an ordinary failed owner releases", async () => {
    const save = vi.fn();
    const publish = vi.fn();
    const gate = createSessionEffectGate("ordinary");
    await gate.release();

    await gate.save({ tabs: [], activePath: null }, save);
    await gate.publishOpenTabs(publish);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
