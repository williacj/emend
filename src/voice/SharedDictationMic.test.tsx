// @vitest-environment jsdom
// ABOUTME: Two live input surfaces share one backend-confirmed dictation state.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceStatus } from "../settings/voiceIpc";

const bridge = vi.hoisted(() => ({
  getVoiceStatus: vi.fn(),
  downloadVoiceModel: vi.fn(),
  startVoiceDictation: vi.fn(),
  stopVoiceDictation: vi.fn(),
  cancelVoiceDictation: vi.fn(),
  listenForBackendEvent: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../settings/voiceIpc", () => ({
  getVoiceStatus: bridge.getVoiceStatus,
  downloadVoiceModel: bridge.downloadVoiceModel,
  startVoiceDictation: bridge.startVoiceDictation,
  stopVoiceDictation: bridge.stopVoiceDictation,
  cancelVoiceDictation: bridge.cancelVoiceDictation,
  VOICE_DOWNLOAD_EVENT: "voice://download",
  VOICE_DICTATION_EVENT: "voice://dictation",
}));
vi.mock("../stores/driverEvents", () => ({ listenForBackendEvent: bridge.listenForBackendEvent }));

import { SharedDictationMic, VoiceSettingsOpenContext, invalidateVoiceStatus, publishVoiceStatus, refreshVoiceStatus, retireVoiceStartIntent, useVoicePresentation } from "./SharedDictationMic";

function ElapsedProbe() {
  const state = useVoicePresentation();
  return <output>{state.kind === "recording" ? state.elapsedSeconds : state.kind}</output>;
}

const ready: VoiceStatus = {
  enabled: true,
  selected_device_id: null,
  selected_device_name: null,
  devices: [{ id: "desk", name: "Desk", is_default: true }],
  device_issue: null,
  model: "ready",
  model_origin: "managed",
  external_model_path: null,
  download: { kind: "idle" },
  download_revision: 0,
  capture_active: false,
  inference_available: true,
  dictation: { kind: "idle" },
  dictation_generation: null,
};

describe("voice/SharedDictationMic", () => {
  beforeEach(() => {
    invalidateVoiceStatus();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    bridge.startVoiceDictation.mockClear();
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.listenForBackendEvent.mockReset().mockResolvedValue(() => {});
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("#2635 opens Voice Settings without starting capture for device and permission errors", async () => {
    const open = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset();
    bridge.downloadVoiceModel.mockReset();
    render(<VoiceSettingsOpenContext.Provider value={open}><SharedDictationMic /></VoiceSettingsOpenContext.Provider>);
    for (const [reason, label] of [
      ["no_device", "Dictate — no microphone found"],
      ["no_default_device", "Dictate — no default microphone available"],
      ["selected_unavailable", "Dictate — selected microphone unavailable"],
      ["permission_denied", "Dictate — microphone permission denied"],
    ] as const) {
      act(() => publishVoiceStatus({ ...ready, device_issue: reason }));
      const mic = screen.getByRole("button", { name: label });
      expect(mic).toHaveAttribute("aria-description", "Opens Voice Settings");
      fireEvent.click(mic);
      expect(open).toHaveBeenLastCalledWith(mic);
    }
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(4);
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    expect(bridge.downloadVoiceModel).not.toHaveBeenCalled();
    bridge.startVoiceDictation.mockResolvedValue(ready);
    act(() => publishVoiceStatus({ ...ready, device_issue: "backend_unavailable" }));
    const backendRetry = screen.getByRole("button", { name: "Dictate — microphone access unavailable" });
    expect(backendRetry).not.toHaveAttribute("aria-description");
    fireEvent.click(backendRetry);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledTimes(4);
  });
  it("#2550 delivers a final only to the composer that started this session", async () => {
    const chat = vi.fn();
    const comment = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.listenForBackendEvent.mockClear();
    render(<><SharedDictationMic onDictationEvent={chat} /><SharedDictationMic onDictationEvent={comment} /></>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(2));
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));

    fireEvent.click(screen.getAllByRole("button", { name: "Dictate" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Stop dictation — recording" })).toHaveLength(2));
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "spoken draft" }));

    expect(chat).toHaveBeenCalledExactlyOnceWith({ kind: "final", generation: 7, text: "spoken draft" });
    expect(comment).not.toHaveBeenCalled();
  });

  it("#2550 buffers early events and leases only the acknowledged Start generation", async () => {
    const chat = vi.fn();
    const comment = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    let resolveStart!: (receipt: VoiceStatus & { accepted_generation: number }) => void;
    bridge.startVoiceDictation.mockReset().mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    bridge.listenForBackendEvent.mockClear();
    render(<><SharedDictationMic onDictationEvent={chat} /><SharedDictationMic onDictationEvent={comment} /></>);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));

    fireEvent.click(screen.getAllByRole("button", { name: "Dictate" })[0]);
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => {
      onEvent({ kind: "partial", generation: 41, text: "old speech" });
      onEvent({ kind: "partial", generation: 42, text: "accepted speech" });
    });
    expect(chat).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();

    await act(async () => resolveStart({
      ...ready, accepted_generation: 42, dictation_generation: 43,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    }));
    expect(chat).toHaveBeenCalledExactlyOnceWith({ kind: "partial", generation: 42, text: "accepted speech" });
    expect(comment).not.toHaveBeenCalled();
    act(() => onEvent({ kind: "final", generation: 41, text: "old final" }));
    expect(chat).toHaveBeenCalledTimes(1);
    act(() => onEvent({ kind: "final", generation: 42, text: "accepted final" }));
    expect(chat).toHaveBeenLastCalledWith({ kind: "final", generation: 42, text: "accepted final" });
  });

  it("#2550 keeps an early Final after many partials before the Start receipt", async () => {
    const chat = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    let resolveStart!: (receipt: VoiceStatus & { accepted_generation: number }) => void;
    bridge.startVoiceDictation.mockReset().mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    bridge.listenForBackendEvent.mockClear();
    render(<SharedDictationMic onDictationEvent={chat} />);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => {
      for (let index = 0; index < 70; index++) {
        onEvent({ kind: "partial", generation: 42, text: `part ${index}` });
      }
      onEvent({ kind: "final", generation: 42, text: "finished" });
    });
    expect(chat).not.toHaveBeenCalled();
    await act(async () => resolveStart({
      ...ready, accepted_generation: 42, dictation_generation: null,
      capture_active: false, dictation: { kind: "idle" },
    }));
    expect(chat).toHaveBeenLastCalledWith({ kind: "final", generation: 42, text: "finished" });
  });

  it("#2550 rejected Start retires its captured target", async () => {
    const onStart = vi.fn();
    const onRetire = vi.fn();
    const onEvent = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockRejectedValue(new Error("permission denied"));
    bridge.listenForBackendEvent.mockReset().mockResolvedValue(() => {});
    render(<SharedDictationMic onDictationStart={onStart} onDictationRetire={onRetire} onDictationEvent={onEvent} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    expect(onStart).toHaveBeenCalledOnce();
    await waitFor(() => expect(onRetire).toHaveBeenCalledOnce());
    const deliver = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => deliver({ kind: "final", generation: 7, text: "unowned" }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("#2550 waits for dictation listener before Start", async () => {
    const received = vi.fn();
    const onStart = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    let admitListener!: (stop: () => void) => void;
    bridge.listenForBackendEvent.mockReset().mockImplementation((name: string) =>
      name === "voice://dictation"
        ? new Promise<() => void>((resolve) => { admitListener = resolve; })
        : Promise.resolve(() => {}));
    render(<SharedDictationMic onDictationStart={onStart} onDictationEvent={received} />);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    const button = document.querySelector<HTMLButtonElement>(".dictation-mic")!;
    if (!button.disabled) fireEvent.click(button);
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    await act(async () => admitListener(() => {}));
    if (button.disabled) await waitFor(() => expect(button).toBeEnabled());
    if (!bridge.startVoiceDictation.mock.calls.length) fireEvent.click(button);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    expect(onStart).toHaveBeenCalledOnce();
    const deliver = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => deliver({ kind: "partial", generation: 7, text: "owned" }));
    expect(received).toHaveBeenCalledExactlyOnceWith({ kind: "partial", generation: 7, text: "owned" });
  });

  it("#2550 waits for dictation listener before Start after a rejected registration", async () => {
    const onStart = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    let attempts = 0;
    bridge.listenForBackendEvent.mockReset().mockImplementation((name: string) => {
      if (name !== "voice://dictation") return Promise.resolve(() => {});
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("native listener unavailable")) : Promise.resolve(() => {});
    });
    render(<SharedDictationMic onDictationStart={onStart} />);
    const retry = await screen.findByRole("button", { name: "Dictate — event connection unavailable; retry" });
    expect(retry).toBeEnabled();
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(retry);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("#2550 conditional Cancel retires its accepted generation despite successor status", async () => {
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    act(() => publishVoiceStatus({
      ...ready, dictation_generation: 8, capture_active: true,
      dictation: { kind: "recording", elapsed_seconds: 0 },
    }));
    act(() => retireVoiceStartIntent());
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("#2550 retires an unmounted origin before a parent layout Final", async () => {
    const received = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    let deliverFinal: (() => void) | null = null;
    function Harness({ show }: { show: boolean }) {
      useLayoutEffect(() => { if (!show) deliverFinal?.(); }, [show]);
      return show ? <SharedDictationMic onDictationEvent={received} /> : null;
    }
    const mounted = render(<Harness show />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    deliverFinal = () => onEvent({ kind: "final", generation: 7, text: "stale" });
    mounted.rerender(<Harness show={false} />);
    expect(received).not.toHaveBeenCalled();
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("#2550 refreshes owner status after a no-event conditional Cancel", async () => {
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const readsBeforeRetirement = bridge.getVoiceStatus.mock.calls.length;
    await act(async () => {
      retireVoiceStartIntent();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
    expect(bridge.getVoiceStatus.mock.calls.length).toBeGreaterThan(readsBeforeRetirement);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("#2550 retired pending Start conditionally cancels only its accepted generation", async () => {
    const chat = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    let resolveStart!: (receipt: VoiceStatus & { accepted_generation: number }) => void;
    bridge.startVoiceDictation.mockReset().mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.listenForBackendEvent.mockClear();
    render(<SharedDictationMic onDictationEvent={chat} />);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    act(() => retireVoiceStartIntent());

    await act(async () => resolveStart({
      ...ready, accepted_generation: 41, dictation_generation: 42,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    }));
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 41, text: "retired speech" }));
    expect(chat).not.toHaveBeenCalled();
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(41);
  });

  it("#2550 retires the transcript destination on tab change before a late final", async () => {
    const chat = vi.fn();
    const comment = vi.fn();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 8, dictation_generation: 8,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.listenForBackendEvent.mockClear();
    render(<><SharedDictationMic onDictationEvent={chat} /><SharedDictationMic onDictationEvent={comment} /></>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(2));
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(screen.getAllByRole("button", { name: "Dictate" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Stop dictation — recording" })).toHaveLength(2));

    act(() => retireVoiceStartIntent());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 8, text: "late speech" }));

    expect(chat).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(8);
  });
  it("publishes only Rust-confirmed state to every mounted control", async () => {
    bridge.getVoiceStatus.mockResolvedValue({ ...ready, inference_available: false });
    let resolveStart!: (value: VoiceStatus) => void;
    bridge.startVoiceDictation.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    render(<><SharedDictationMic platform="win" /><SharedDictationMic platform="mac" /></>);
    await waitFor(() => expect(bridge.getVoiceStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dictate — unavailable in this build" })).toHaveLength(2));
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();

    act(() => publishVoiceStatus({ ...ready, model: "absent", download: { kind: "progress", downloaded: 42, total: 100 } }));
    expect(screen.getAllByRole("button", { name: "Dictate — downloading voice model, 42%" })).toHaveLength(2);

    act(() => publishVoiceStatus(ready));
    fireEvent.click(screen.getAllByRole("button", { name: "Dictate" })[0]);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(2);
    await act(async () => resolveStart({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 } }));
    expect(screen.getAllByRole("button", { name: "Stop dictation — recording" })).toHaveLength(2);
  });

  it("disables a formerly ready mic when the Rust owner becomes unreachable", async () => {
    bridge.getVoiceStatus.mockResolvedValue(ready);
    act(() => publishVoiceStatus(ready));
    render(<SharedDictationMic />);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
    await act(async () => { await refreshVoiceStatus(); });
    bridge.getVoiceStatus.mockRejectedValue(new Error("owner unavailable"));
    await act(async () => { await refreshVoiceStatus(); });
    expect(screen.getByRole("button", { name: "Dictate — voice status unavailable" })).toBeDisabled();
  });

  it("ignores an older status read after Settings publishes a newer confirmed choice", async () => {
    let resolveRead!: (value: VoiceStatus) => void;
    bridge.getVoiceStatus.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    act(() => publishVoiceStatus(ready));
    render(<SharedDictationMic />);
    await waitFor(() => expect(bridge.getVoiceStatus).toHaveBeenCalled());
    act(() => publishVoiceStatus({ ...ready, enabled: false }));
    expect(screen.getByRole("button", { name: "Dictate — voice is off in Settings" })).toBeDisabled();
    await act(async () => resolveRead(ready));
    expect(screen.getByRole("button", { name: "Dictate — voice is off in Settings" })).toBeDisabled();
  });

  it("refreshes after an event that arrives during a held owner read", async () => {
    let resolveHeld!: (value: VoiceStatus) => void;
    bridge.getVoiceStatus.mockReset()
      .mockImplementationOnce(() => new Promise<VoiceStatus>((resolve) => { resolveHeld = resolve; }))
      .mockResolvedValueOnce({ ...ready, capture_active: false, dictation: { kind: "transcribing" } });
    bridge.listenForBackendEvent.mockClear();
    act(() => publishVoiceStatus({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 3 } }));
    render(<SharedDictationMic />);
    await waitFor(() => expect(bridge.getVoiceStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    const onDictationEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onDictationEvent());
    await act(async () => resolveHeld({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 3 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictation — transcribing" })).toBeDisabled());
    expect(bridge.getVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps every mic on the newest cancelling notice", async () => {
    const progress: VoiceStatus = {
      ...ready, model: "absent", download_revision: 1,
      download: { kind: "progress", downloaded: 25, total: 100 },
    };
    let releaseOldRead!: (status: VoiceStatus) => void;
    bridge.getVoiceStatus.mockReset()
      .mockImplementationOnce(() => new Promise<VoiceStatus>((resolve) => { releaseOldRead = resolve; }))
      .mockResolvedValue({ ...progress, download_revision: 2, download: { kind: "cancelling" } });
    bridge.listenForBackendEvent.mockClear();
    act(() => publishVoiceStatus(progress));
    render(<><SharedDictationMic platform="win" /><SharedDictationMic platform="mac" /></>);
    await waitFor(() => expect(bridge.getVoiceStatus).toHaveBeenCalledTimes(1));
    const onDownload = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];

    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    const cancelling = screen.getAllByRole("button", { name: "Dictate — cancelling voice model download" });
    expect(cancelling).toHaveLength(2);
    for (const mic of cancelling) {
      expect(mic).toBeDisabled();
      expect(mic).toHaveAttribute("aria-busy", "true");
    }
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await act(async () => releaseOldRead(progress));
    expect(screen.getAllByRole("button", { name: "Dictate — cancelling voice model download" })).toHaveLength(2);

    act(() => onDownload({ revision: 1, phase: { kind: "progress", downloaded: 25, total: 100 } }));
    expect(screen.getAllByRole("button", { name: "Dictate — cancelling voice model download" })).toHaveLength(2);
    act(() => onDownload({ revision: 3, phase: { kind: "cancelled", downloaded: 25, total: 100 } }));
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    const resume = screen.getAllByRole("button", { name: "Dictate — model download cancelled; resume" });
    expect(resume).toHaveLength(2);
    expect(resume[0]).toBeEnabled();
  });

  it("does not replace a newer owner event with a delayed stop response", async () => {
    const recording: VoiceStatus = { ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 2 } };
    bridge.getVoiceStatus.mockReset().mockResolvedValue(recording);
    bridge.listenForBackendEvent.mockClear();
    let resolveStop!: (value: VoiceStatus) => void;
    bridge.stopVoiceDictation.mockReturnValue(new Promise<VoiceStatus>((resolve) => { resolveStop = resolve; }));
    render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));

    fireEvent.click(screen.getByRole("button", { name: "Stop dictation — recording" }));
    await waitFor(() => expect(bridge.stopVoiceDictation).toHaveBeenCalled());
    bridge.getVoiceStatus.mockResolvedValue(ready);
    const onDictationEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onDictationEvent());
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    await act(async () => resolveStop({ ...ready, dictation: { kind: "transcribing" } }));
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("first press downloads then starts only while the intent is current", async () => {
    const absent: VoiceStatus = { ...ready, model: "absent" };
    bridge.startVoiceDictation.mockClear();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(absent);
    let resolveDownload!: () => void;
    bridge.downloadVoiceModel.mockReturnValue(new Promise<void>((resolve) => { resolveDownload = resolve; }));
    bridge.startVoiceDictation.mockResolvedValue({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 } });
    render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate — voice model missing" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Dictate — voice model missing" }));
    await waitFor(() => expect(bridge.downloadVoiceModel).toHaveBeenCalledOnce());
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    act(() => publishVoiceStatus({ ...absent, download: { kind: "progress", downloaded: 42, total: 100 } }));
    expect(screen.getByRole("button", { name: "Dictate — downloading voice model, 42%" })).toBeDisabled();

    bridge.getVoiceStatus.mockResolvedValue(ready);
    await act(async () => resolveDownload());
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
  });

  it("resumes after terminal cancellation before the old download promise settles", async () => {
    const absent: VoiceStatus = { ...ready, model: "absent" };
    let ownerStatus = absent;
    bridge.getVoiceStatus.mockReset().mockImplementation(() => Promise.resolve(ownerStatus));
    bridge.listenForBackendEvent.mockClear();
    let releaseOld!: () => void;
    let releaseResume!: () => void;
    bridge.downloadVoiceModel.mockReset()
      .mockReturnValueOnce(new Promise<void>((resolve) => { releaseOld = resolve; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { releaseResume = resolve; }));
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, download_revision: 2, download: { kind: "completed" },
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    act(() => publishVoiceStatus(absent));
    render(<SharedDictationMic />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate — voice model missing" }));
    await waitFor(() => expect(bridge.downloadVoiceModel).toHaveBeenCalledTimes(1));
    const onDownload = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];
    ownerStatus = { ...absent, download_revision: 1, download: { kind: "cancelled", downloaded: 25, total: 100 } };
    // A status read can win the race; the equal-revision terminal event arrives afterward.
    act(() => publishVoiceStatus(ownerStatus));
    act(() => onDownload({ revision: 1, phase: ownerStatus.download }));
    fireEvent.click(await screen.findByRole("button", { name: "Dictate — model download cancelled; resume" }));
    await waitFor(() => expect(bridge.downloadVoiceModel).toHaveBeenCalledTimes(2));
    await act(async () => releaseOld());
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dictate — model download cancelled; resume" }));
    expect(bridge.downloadVoiceModel).toHaveBeenCalledTimes(2);

    ownerStatus = { ...ready, download_revision: 2, download: { kind: "completed" } };
    await act(async () => releaseResume());
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
  });

  it("retires a first-press start after cancellation or tab switch", async () => {
    const absent: VoiceStatus = { ...ready, model: "absent" };
    bridge.startVoiceDictation.mockClear();
    bridge.getVoiceStatus.mockReset().mockResolvedValue(absent);
    let resolveCancelled!: () => void;
    bridge.downloadVoiceModel.mockReturnValueOnce(new Promise<void>((resolve) => { resolveCancelled = resolve; }));
    const first = render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate — voice model missing" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate — voice model missing" }));
    bridge.getVoiceStatus.mockResolvedValue({ ...absent, download: { kind: "cancelled", downloaded: 12, total: 100 } });
    await act(async () => resolveCancelled());
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop dictation — recording" })).not.toBeInTheDocument();
    first.unmount();

    bridge.getVoiceStatus.mockResolvedValue(absent);
    let resolveSwitched!: () => void;
    bridge.downloadVoiceModel.mockReturnValueOnce(new Promise<void>((resolve) => { resolveSwitched = resolve; }));
    render(<SharedDictationMic />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate — voice model missing" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate — voice model missing" }));
    act(() => retireVoiceStartIntent());
    bridge.getVoiceStatus.mockResolvedValue(ready);
    await act(async () => resolveSwitched());
    expect(bridge.startVoiceDictation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop dictation — recording" })).not.toBeInTheDocument();
  });

  it("refreshes elapsed recording time from one owner read", async () => {
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    render(<><SharedDictationMic /><SharedDictationMic /><ElapsedProbe /></>);
    await waitFor(() => expect(bridge.getVoiceStatus).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      bridge.getVoiceStatus.mockClear().mockResolvedValue({
        ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 1 },
      });
      act(() => publishVoiceStatus({
        ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
      }));
      expect(screen.getByRole("status")).toHaveTextContent("0");
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(bridge.getVoiceStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent("1");
      act(() => publishVoiceStatus(ready));
      bridge.getVoiceStatus.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(bridge.getVoiceStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a terminal owner error without claiming recording before Rust confirms", async () => {
    for (const reason of ["invalid_audio", "inference_failed"] as const) {
      const failed: VoiceStatus = { ...ready, dictation: { kind: "error", reason } };
      bridge.getVoiceStatus.mockReset().mockResolvedValue(failed);
      bridge.startVoiceDictation.mockReset();
      let resolveStart!: (value: VoiceStatus) => void;
      bridge.startVoiceDictation.mockReturnValue(new Promise<VoiceStatus>((resolve) => { resolveStart = resolve; }));
      const mounted = render(<SharedDictationMic />);
      const button = await screen.findByRole("button", { name: reason === "invalid_audio" ? "Dictate — recording could not be read" : "Dictate — dictation failed" });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
      expect(button).toBeInTheDocument();
      await act(async () => resolveStart({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 } }));
      expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled();
      mounted.unmount();
    }
  });
});
