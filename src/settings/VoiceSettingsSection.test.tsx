// @vitest-environment jsdom
// ABOUTME: Voice Settings tests use typed backend snapshots rather than optimistic local claims.
// ABOUTME: Covers selected-device loss, capture refusal, and model download recovery by keyboard.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceStatus } from "./voiceIpc";

const getVoiceStatus = vi.fn();
const setVoiceEnabled = vi.fn();
const selectVoiceInputDevice = vi.fn();
const downloadVoiceModel = vi.fn();
const cancelVoiceDownload = vi.fn();
const removeVoiceModel = vi.fn();
const listenForBackendEvent = vi.fn();
vi.mock("./voiceIpc", () => ({
  VOICE_DOWNLOAD_EVENT: "voice://download",
  VOICE_DICTATION_EVENT: "voice://dictation",
  getVoiceStatus: (...args: unknown[]) => getVoiceStatus(...args),
  setVoiceEnabled: (...args: unknown[]) => setVoiceEnabled(...args),
  selectVoiceInputDevice: (...args: unknown[]) => selectVoiceInputDevice(...args),
  downloadVoiceModel: (...args: unknown[]) => downloadVoiceModel(...args),
  cancelVoiceDownload: (...args: unknown[]) => cancelVoiceDownload(...args),
  removeVoiceModel: (...args: unknown[]) => removeVoiceModel(...args),
}));
vi.mock("../stores/driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEvent(...args),
}));

const { VoiceSettingsSection } = await import("./VoiceSettingsSection");
const { SharedDictationMic, invalidateVoiceStatus, publishVoiceStatus } = await import("../voice/SharedDictationMic");

const READY: VoiceStatus = {
  enabled: true,
  selected_device_id: "mic-a",
  selected_device_name: "Desk microphone",
  devices: [
    { id: "mic-a", name: "Desk microphone", is_default: true },
    { id: "mic-b", name: "USB microphone", is_default: false },
  ],
  device_issue: null,
  model: "ready",
  model_origin: "managed",
  external_model_path: null,
  download: { kind: "idle" },
  download_revision: 0,
  capture_active: false,
  dictation_generation: null,
};

describe("settings/VoiceSettingsSection", () => {
  beforeEach(() => {
    invalidateVoiceStatus();
    getVoiceStatus.mockReset().mockResolvedValue(READY);
    setVoiceEnabled.mockReset();
    selectVoiceInputDevice.mockReset();
    downloadVoiceModel.mockReset();
    cancelVoiceDownload.mockReset();
    removeVoiceModel.mockReset();
    listenForBackendEvent.mockReset().mockResolvedValue(vi.fn());
  });

  it("shows the backend's selected mic, preserves a missing selection, and permits an explicit replacement", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY,
      selected_device_id: "unplugged-mic",
      device_issue: "selected_unavailable",
    });
    selectVoiceInputDevice.mockResolvedValueOnce({ ...READY, selected_device_id: "mic-b" });
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    expect(input).toHaveValue("unplugged-mic");
    expect(screen.getByRole("status")).toHaveTextContent("Selected microphone is unavailable");
    fireEvent.change(input, { target: { value: "mic-b" } });
    await waitFor(() => expect(selectVoiceInputDevice).toHaveBeenCalledWith("mic-b"));
    await waitFor(() => expect(input).toHaveValue("mic-b"));
  });

  it("shows the remembered microphone name for a disconnected selection", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY, selected_device_id: "opaque-device-47", selected_device_name: "Travel USB microphone",
      devices: [], device_issue: "selected_unavailable",
    });
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    expect(input).toHaveValue("opaque-device-47");
    expect(screen.getByRole("option", { name: "Unavailable: Travel USB microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /opaque-device-47/ })).toBeNull();
  });

  it("uses a generic remembered microphone name fallback for migrated legacy settings", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY, selected_device_id: "opaque-device-47", selected_device_name: null,
      devices: [], device_issue: "selected_unavailable",
    });
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("combobox", { name: "Input device" })).toHaveValue("opaque-device-47");
    expect(screen.getByRole("option", { name: "Unavailable selected microphone" })).toBeInTheDocument();
  });

  it("refreshes hardware availability after the selected microphone reconnects", async () => {
    getVoiceStatus
      .mockResolvedValueOnce({ ...READY, selected_device_id: "mic-b", devices: [READY.devices[0]], device_issue: "selected_unavailable" })
      .mockResolvedValueOnce(READY);
    render(<VoiceSettingsSection />);
    expect(await screen.findByText(/Selected microphone is unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh voice status" }));
    await waitFor(() => expect(getVoiceStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Selected microphone is unavailable/)).not.toBeInTheDocument());
  });

  it("does not claim a mic change or disabling succeeded during active capture", async () => {
    getVoiceStatus.mockResolvedValueOnce({ ...READY, capture_active: true });
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    expect(input).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Enable voice" })).toBeDisabled();
    expect(selectVoiceInputDevice).not.toHaveBeenCalled();
    expect(setVoiceEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Recording is active");
  });

  it("reports a raced active-capture refusal and retains the committed input", async () => {
    selectVoiceInputDevice.mockRejectedValueOnce({ kind: "capture_active" });
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    fireEvent.change(input, { target: { value: "mic-b" } });
    await waitFor(() => expect(selectVoiceInputDevice).toHaveBeenCalledWith("mic-b"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop recording before changing");
    expect(input).toHaveValue("mic-a");
  });

  it("disabling voice preserves the backend's selected input for later use", async () => {
    setVoiceEnabled.mockResolvedValueOnce({ ...READY, enabled: false });
    render(<VoiceSettingsSection />);
    const enabled = await screen.findByRole("switch", { name: "Enable voice" });
    fireEvent.click(enabled);
    await waitFor(() => expect(setVoiceEnabled).toHaveBeenCalledWith(false));
    await waitFor(() => expect(enabled).not.toBeChecked());
    expect(screen.getByRole("combobox", { name: "Input device" })).toHaveValue("mic-a");
    expect(selectVoiceInputDevice).not.toHaveBeenCalled();
  });

  it("shows backend-confirmed switch state and the voice-off explanation without hiding device or model", async () => {
    getVoiceStatus.mockResolvedValueOnce({ ...READY, enabled: false });
    let confirmEnable!: (status: VoiceStatus) => void;
    setVoiceEnabled.mockReturnValueOnce(new Promise<VoiceStatus>((resolve) => { confirmEnable = resolve; }));
    render(<VoiceSettingsSection />);
    const voice = await screen.findByRole("switch", { name: "Enable voice" });
    expect(voice).not.toBeChecked();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText(/Each mic shows as unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Input device" })).toBeEnabled();
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    fireEvent.click(voice);
    await waitFor(() => expect(setVoiceEnabled).toHaveBeenCalledWith(true));
    expect(voice).not.toBeChecked();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(voice).toBeDisabled();
    confirmEnable(READY);
    await waitFor(() => expect(voice).toBeChecked());
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.queryByText(/Each mic shows as unavailable/)).not.toBeInTheDocument();
  });

  it("associates all four named device issues with the rejected selector", async () => {
    const cases = [
      ["no_device", "No microphone is available."],
      ["no_default_device", "No default microphone is available. Choose an input device."],
      ["selected_unavailable", "Selected microphone is unavailable. Choose another input device."],
      ["permission_denied", "Microphone permission was denied. Check system permissions."],
    ] as const;
    for (const [issue] of cases) getVoiceStatus.mockResolvedValueOnce({ ...READY, device_issue: issue });
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    for (const [index, [, message]] of cases.entries()) {
      const status = await screen.findByText(message);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute("aria-describedby", status.id);
      expect(status).toHaveAttribute("role", "status");
      if (index < cases.length - 1) fireEvent.click(screen.getByRole("button", { name: "Refresh voice status" }));
    }
  });

  it("keeps Voice and Refresh in one heading row", async () => {
    render(<VoiceSettingsSection />);
    const heading = await screen.findByRole("heading", { name: "Voice" });
    expect(heading.parentElement).toHaveClass("voice-settings__heading-row");
    expect(heading.parentElement).toContainElement(screen.getByRole("button", { name: "Refresh voice status" }));
  });

  it("updates an already-mounted mic after disabling voice is confirmed by Rust", async () => {
    const inferenceReady = { ...READY, inference_available: true };
    getVoiceStatus.mockResolvedValue(inferenceReady);
    setVoiceEnabled.mockResolvedValueOnce({ ...inferenceReady, enabled: false });
    render(<><VoiceSettingsSection /><SharedDictationMic /></>);
    expect(await screen.findByRole("button", { name: "Dictate" })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Enable voice" }));
    await waitFor(() => expect(setVoiceEnabled).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Dictate — voice is off in Settings" })).toBeDisabled();
  });

  it("shows a failed model download and allows keyboard retry with verified backend status", async () => {
    getVoiceStatus
      .mockResolvedValueOnce({ ...READY, model: "absent", download: { kind: "failed", reason: "transport" } })
      .mockResolvedValueOnce({ ...READY, model: "ready", download: { kind: "completed" } });
    downloadVoiceModel.mockResolvedValueOnce(undefined);
    render(<VoiceSettingsSection />);
    const retry = await screen.findByRole("button", { name: "Retry model download" });
    expect(screen.getByRole("alert")).toHaveTextContent("Model download failed");
    retry.focus();
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.click(retry);
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Model ready")).toBeInTheDocument());
  });

  it("#2647 maps typed download failures to approved plain-language copy", async () => {
    const cases = [
      ["transport", "Model download failed: Emend couldn’t complete the download over the network."],
      ["storage", "Model download failed: Emend couldn’t save the model on this device."],
      ["registry", "Model download failed: Emend couldn’t finish setting up the model."],
      ["protocol", "Model download failed: The file received wasn’t the expected voice model."],
      ["truncated", "Model download failed: The file received wasn’t the expected voice model."],
      ["oversized", "Model download failed: The file received wasn’t the expected voice model."],
      ["corrupt", "Model download failed: The file received wasn’t the expected voice model."],
    ] as const;
    for (const [reason, message] of cases) {
      getVoiceStatus.mockResolvedValueOnce({ ...READY, model: "absent", download: { kind: "failed", reason } });
      const mounted = render(<VoiceSettingsSection />);
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Retry model download" })).toBeEnabled();
      mounted.unmount();
    }
  });

  it("shows a cancelled partial download as resumable", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY,
      model: "absent",
      download: { kind: "cancelled", downloaded: 20, total: 100 },
    });
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Resume model download" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Model download cancelled");
  });

  it("#2647 keeps one model action and held progress through cancellation", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY, model: "absent", download_revision: 1,
      download: { kind: "progress", downloaded: 42, total: 100 },
    });
    render(<VoiceSettingsSection />);
    const cancel = await screen.findByRole("button", { name: "Cancel download" });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("progressbar", { name: "Model download progress" })).toHaveAttribute("aria-valuenow", "42");
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];

    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    const cancelling = screen.getByRole("button", { name: "Cancelling…" });
    expect(cancelling).toBeDisabled();
    expect(cancelling).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("progressbar", { name: "Model download progress" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.queryByRole("button", { name: "Cancel download" })).not.toBeInTheDocument();

    act(() => onDownload({ revision: 3, phase: { kind: "cancelled", downloaded: 42, total: 100 } }));
    expect(screen.getByRole("button", { name: "Resume model download" })).toBeEnabled();
    expect(screen.getByRole("progressbar", { name: "Model download progress" })).toHaveAttribute("aria-valuenow", "42");
    act(() => onDownload({ revision: 2, phase: { kind: "progress", downloaded: 60, total: 100 } }));
    expect(screen.getByRole("button", { name: "Resume model download" })).toBeEnabled();
  });

  it("#2647 does not invent partial percent after reopening Cancelling", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY, model: "absent", download_revision: 2, download: { kind: "cancelling" },
    });
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
    const bar = screen.getByRole("progressbar", { name: "Model download progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar.firstElementChild).toHaveStyle({ width: "100%" });
  });

  it("#2647 keeps one action during a ready status race", async () => {
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Remove local model" })).toBeEnabled();
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];
    act(() => onDownload({ revision: 1, phase: { kind: "progress", downloaded: 42, total: 100 } }));
    expect(screen.getByRole("status")).toHaveTextContent("Downloading model: 42%");
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeEnabled();
    expect(screen.getAllByRole("button").filter((button) => button.classList.contains("settings-dialog__model-action"))).toHaveLength(1);
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getAllByRole("button").filter((button) => button.classList.contains("settings-dialog__model-action"))).toHaveLength(1);
  });

  it("keeps Cancel visible after reopening Settings during an active backend download", async () => {
    getVoiceStatus.mockResolvedValue({
      ...READY,
      model: "absent",
      download: { kind: "progress", downloaded: 25, total: 100 },
    });
    cancelVoiceDownload.mockResolvedValue(undefined);
    const first = render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Cancel download" })).toBeEnabled();
    first.unmount();

    render(<VoiceSettingsSection />);
    const cancel = await screen.findByRole("button", { name: "Cancel download" });
    expect(screen.queryByRole("button", { name: "Download model" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading model: 25%");
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelVoiceDownload).toHaveBeenCalledTimes(1));
    expect(downloadVoiceModel).not.toHaveBeenCalled();
  });

  it("keeps Cancelling above older download notices and reads", async () => {
    const progress = {
      ...READY, model: "absent" as const, download_revision: 1,
      download: { kind: "progress" as const, downloaded: 25, total: 100 },
    };
    let releaseOldRead!: (status: VoiceStatus) => void;
    getVoiceStatus.mockResolvedValueOnce(progress)
      .mockImplementationOnce(() => new Promise<VoiceStatus>((resolve) => { releaseOldRead = resolve; }));
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Cancel download" })).toBeEnabled();
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];

    fireEvent.click(screen.getByRole("button", { name: "Refresh voice status" }));
    await waitFor(() => expect(getVoiceStatus).toHaveBeenCalledTimes(2));
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling model download");
    expect(screen.queryByRole("button", { name: "Cancel download" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download model" })).not.toBeInTheDocument();

    act(() => onDownload({ revision: 1, phase: { kind: "progress", downloaded: 25, total: 100 } }));
    await act(async () => releaseOldRead(progress));
    act(() => onDownload({ revision: 1, phase: { kind: "failed", reason: "transport" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling model download");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => onDownload({ revision: 3, phase: { kind: "cancelled", downloaded: 25, total: 100 } }));
    expect(screen.getByRole("button", { name: "Resume model download" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Model download cancelled");
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    expect(screen.getByRole("button", { name: "Resume model download" })).toBeEnabled();
  });

  it("keeps accepted cancellation across Settings remount", async () => {
    const progress: VoiceStatus = {
      ...READY, model: "absent", download_revision: 1,
      download: { kind: "progress", downloaded: 25, total: 100 },
    };
    const cancelling: VoiceStatus = {
      ...progress, download_revision: 2, download: { kind: "cancelling" },
    };
    getVoiceStatus.mockResolvedValueOnce(progress).mockResolvedValue(cancelling);
    cancelVoiceDownload.mockResolvedValue(undefined);
    const first = render(<VoiceSettingsSection />);
    const cancel = await screen.findByRole("button", { name: "Cancel download" });
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelVoiceDownload).toHaveBeenCalledOnce());
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling model download");
    expect(screen.queryByRole("button", { name: "Cancel download" })).not.toBeInTheDocument();
    first.unmount();

    render(<VoiceSettingsSection />);
    expect(await screen.findByText("Cancelling model download…")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Download model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel download" })).not.toBeInTheDocument();
    expect(cancelVoiceDownload).toHaveBeenCalledOnce();
    const onReopenedDownload = listenForBackendEvent.mock.calls.filter(([name]) => name === "voice://download").slice(-1)[0][1];
    act(() => onReopenedDownload({ revision: 3, phase: { kind: "cancelled", downloaded: 25, total: 100 } }));
    const resume = screen.getByRole("button", { name: "Resume model download" });
    expect(resume).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("The partial download can resume");
    downloadVoiceModel.mockReturnValue(new Promise<void>(() => {}));
    resume.focus();
    fireEvent.keyDown(resume, { key: "Enter" });
    fireEvent.click(resume);
    expect(downloadVoiceModel).toHaveBeenCalledOnce();
  });

  it("offers Cancel during a held download and Resume after terminal notice while old IPC is held", async () => {
    const absent: VoiceStatus = { ...READY, model: "absent" };
    getVoiceStatus.mockResolvedValue(absent);
    let releaseOldDownload!: () => void;
    let releaseResume!: () => void;
    let releaseCancel!: () => void;
    downloadVoiceModel
      .mockReturnValueOnce(new Promise<void>((resolve) => { releaseOldDownload = resolve; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { releaseResume = resolve; }));
    cancelVoiceDownload.mockReturnValue(new Promise<void>((resolve) => { releaseCancel = resolve; }));
    render(<VoiceSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Download model" }));
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledTimes(1));
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];
    act(() => onDownload({ revision: 1, phase: { kind: "progress", downloaded: 25, total: 100 } }));
    const cancel = screen.getByRole("button", { name: "Cancel download" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelVoiceDownload).toHaveBeenCalledOnce());
    act(() => onDownload({ revision: 2, phase: { kind: "cancelling" } }));
    act(() => onDownload({ revision: 3, phase: { kind: "cancelled", downloaded: 25, total: 100 } }));
    const resume = screen.getByRole("button", { name: "Resume model download" });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledTimes(2));
    act(() => onDownload({ revision: 4, phase: { kind: "progress", downloaded: 26, total: 100 } }));
    await act(async () => { releaseOldDownload(); releaseCancel(); });
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeEnabled();
    expect(downloadVoiceModel).toHaveBeenCalledTimes(2);
    getVoiceStatus.mockResolvedValue({ ...READY, download_revision: 5, download: { kind: "completed" } });
    act(() => onDownload({ revision: 5, phase: { kind: "completed" } }));
    await act(async () => releaseResume());
    await waitFor(() => expect(screen.getByText("Model ready")).toBeInTheDocument());
  });

  it("shows a verified Completed notice as ready across a held older status read", async () => {
    const absent: VoiceStatus = { ...READY, model: "absent" };
    let releaseRead!: (status: VoiceStatus) => void;
    let releaseDownload!: () => void;
    getVoiceStatus.mockResolvedValueOnce(absent)
      .mockImplementationOnce(() => new Promise<VoiceStatus>((resolve) => { releaseRead = resolve; }));
    downloadVoiceModel.mockReturnValue(new Promise<void>((resolve) => { releaseDownload = resolve; }));
    render(<VoiceSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh voice status" }));
    await waitFor(() => expect(getVoiceStatus).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Download model" }));
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledOnce());
    const onDownload = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://download")![1];
    act(() => onDownload({ revision: 1, phase: { kind: "completed" } }));
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    expect(screen.queryByText("Model not downloaded")).not.toBeInTheDocument();
    await act(async () => releaseRead(absent));
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    await act(async () => releaseDownload());
  });

  it("#2640 verified model state outranks completed download for every recorded origin", async () => {
    for (const model of ["missing", "corrupt"] as const) {
      for (const origin of ["managed", "external"] as const) {
        getVoiceStatus.mockResolvedValueOnce({
          ...READY,
          model,
          model_origin: origin,
          external_model_path: origin === "external" ? "/Users/writer/Models/voice.bin" : null,
          download: { kind: "completed" },
          download_revision: 5,
        });
        const mounted = render(<VoiceSettingsSection />);
        expect(await screen.findByText(`Model file ${model}`)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Download model" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: /Remove local model|Stop using this file/ })).not.toBeInTheDocument();
        expect(screen.queryByText("External file — Emend won’t delete it")).not.toBeInTheDocument();
        mounted.unmount();
      }
    }
  });

  it("reports a refused download Cancel without claiming cancellation", async () => {
    const progress: VoiceStatus = {
      ...READY, model: "absent", download_revision: 1,
      download: { kind: "progress", downloaded: 25, total: 100 },
    };
    getVoiceStatus.mockResolvedValue(progress);
    cancelVoiceDownload.mockRejectedValue({ kind: "download_unavailable" });
    render(<VoiceSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model download was not cancelled");
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading model: 25%");
    expect(getVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("removes an installed model only after backend confirms absent", async () => {
    removeVoiceModel.mockResolvedValueOnce({ ...READY, model: "absent" });
    render(<VoiceSettingsSection />);
    const remove = await screen.findByRole("button", { name: "Remove local model" });
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    fireEvent.click(remove);
    await waitFor(() => expect(removeVoiceModel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Model not downloaded")).toBeInTheDocument());
  });

  it("#2640 external model is forgotten without claiming its file was deleted", async () => {
    const external = {
      ...READY,
      model_origin: "external" as const,
      external_model_path: "/Users/writer/Models/voice.bin",
    };
    getVoiceStatus.mockResolvedValueOnce(external);
    let confirmForget!: (status: VoiceStatus) => void;
    removeVoiceModel.mockReturnValueOnce(new Promise<VoiceStatus>((resolve) => { confirmForget = resolve; }));
    render(<VoiceSettingsSection />);

    expect(await screen.findByText("Model ready")).toBeInTheDocument();
    expect(screen.getByText("/Users/writer/Models/voice.bin")).toBeInTheDocument();
    expect(screen.getByText("External file — Emend won’t delete it")).toBeInTheDocument();
    const forget = screen.getByRole("button", { name: "Stop using this file" });
    fireEvent.click(forget);
    await waitFor(() => expect(removeVoiceModel).toHaveBeenCalledOnce());
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    await act(async () => confirmForget({ ...READY, model: "absent", model_origin: null, external_model_path: null }));
    expect(await screen.findByText("Model not downloaded")).toBeInTheDocument();
    expect(screen.queryByText("/Users/writer/Models/voice.bin")).not.toBeInTheDocument();
  });

  it("#2647 labels external and unknown models without deleting claims", async () => {
    const external: VoiceStatus = { ...READY, model_origin: "external", external_model_path: "/Users/writer/Models/voice.bin" };
    getVoiceStatus.mockResolvedValueOnce(external);
    let confirmForget!: (status: VoiceStatus) => void;
    removeVoiceModel.mockReturnValueOnce(new Promise<VoiceStatus>((resolve) => { confirmForget = resolve; }));
    const first = render(<VoiceSettingsSection />);
    const stop = await screen.findByRole("button", { name: "Stop using this file" });
    expect(screen.getByText("Model ready")).toBeInTheDocument();
    expect(screen.getByText("External file — Emend won’t delete it")).toBeInTheDocument();
    expect(screen.getByText("/Users/writer/Models/voice.bin")).toHaveAttribute("title", "/Users/writer/Models/voice.bin");
    fireEvent.click(stop);
    await waitFor(() => expect(removeVoiceModel).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Stop using this file" })).toBeDisabled();
    expect(screen.getByText("/Users/writer/Models/voice.bin")).toBeInTheDocument();
    await act(async () => confirmForget({ ...READY, model: "absent", model_origin: null, external_model_path: null }));
    expect(screen.queryByText("/Users/writer/Models/voice.bin")).not.toBeInTheDocument();
    first.unmount();

    getVoiceStatus.mockResolvedValueOnce({ ...READY, model_origin: null, external_model_path: null });
    render(<VoiceSettingsSection />);
    expect(await screen.findByRole("button", { name: "Stop using this model" })).toBeEnabled();
    expect(screen.queryByText(/Emend will delete|External file/)).not.toBeInTheDocument();
  });

  it("holds model removal during transcription with accurate status", async () => {
    getVoiceStatus.mockResolvedValueOnce({
      ...READY, capture_active: false, dictation: { kind: "transcribing" },
    });
    render(<VoiceSettingsSection />);
    const remove = await screen.findByRole("button", { name: "Remove local model" });
    expect(remove).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active");
    expect(screen.queryByText(/Stop recording before changing/)).not.toBeInTheDocument();
    fireEvent.click(remove);
    expect(removeVoiceModel).not.toHaveBeenCalled();
  });

  it("tracks owner transcription phases while Settings remains open", async () => {
    render(<VoiceSettingsSection />);
    const remove = await screen.findByRole("button", { name: "Remove local model" });
    expect(remove).toBeEnabled();
    await waitFor(() => expect(listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    const onDictation = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    getVoiceStatus.mockResolvedValueOnce({ ...READY, dictation: { kind: "transcribing" } });
    onDictation();
    await waitFor(() => expect(remove).toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active");
    getVoiceStatus.mockResolvedValueOnce({ ...READY, dictation: { kind: "idle" } });
    onDictation();
    await waitFor(() => expect(remove).toBeEnabled());
    expect(screen.queryByText(/Transcribing is active/)).not.toBeInTheDocument();
  });

  it("ignores an older recording read after a transcribing event", async () => {
    render(<VoiceSettingsSection />);
    const remove = await screen.findByRole("button", { name: "Remove local model" });
    await waitFor(() => expect(listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    const onDictation = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    let releaseOld!: (status: VoiceStatus) => void;
    getVoiceStatus.mockImplementationOnce(() => new Promise<VoiceStatus>((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce({ ...READY, dictation: { kind: "transcribing" } });
    act(() => { onDictation(); onDictation(); });
    await waitFor(() => expect(remove).toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active");
    await act(async () => releaseOld({ ...READY, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 1 } }));
    expect(remove).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active");
  });

  it("does not publish a delayed Settings response over newer transcription", async () => {
    let releaseChoice!: (status: VoiceStatus) => void;
    selectVoiceInputDevice.mockReturnValue(new Promise<VoiceStatus>((resolve) => { releaseChoice = resolve; }));
    render(<VoiceSettingsSection />);
    const input = await screen.findByRole("combobox", { name: "Input device" });
    await waitFor(() => expect(listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    const onDictation = listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    fireEvent.change(input, { target: { value: "mic-b" } });
    await waitFor(() => expect(selectVoiceInputDevice).toHaveBeenCalledWith("mic-b"));
    const transcribing: VoiceStatus = { ...READY, selected_device_id: "mic-b", dictation: { kind: "transcribing" } };
    getVoiceStatus.mockResolvedValue(transcribing);
    act(() => onDictation());
    const remove = screen.getByRole("button", { name: "Remove local model" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active"));
    await act(async () => releaseChoice({ ...READY, selected_device_id: "mic-b", dictation: { kind: "idle" } }));
    await waitFor(() => expect(input).toHaveValue("mic-b"));
    expect(remove).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing is active");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retired Settings read cannot change a mic after dialog unmount", async () => {
    const micReady: VoiceStatus = { ...READY, inference_available: true, dictation: { kind: "idle" } };
    let releaseRead!: (status: VoiceStatus) => void;
    getVoiceStatus.mockReturnValueOnce(new Promise<VoiceStatus>((resolve) => { releaseRead = resolve; }));
    act(() => publishVoiceStatus(micReady));
    render(<SharedDictationMic />);
    const dialog = render(<VoiceSettingsSection />);
    await waitFor(() => expect(getVoiceStatus).toHaveBeenCalled());
    dialog.unmount();
    act(() => publishVoiceStatus({ ...micReady, enabled: false }));
    expect(screen.getByRole("button", { name: "Dictate — voice is off in Settings" })).toBeDisabled();
    await act(async () => releaseRead(micReady));
    expect(screen.getByRole("button", { name: "Dictate — voice is off in Settings" })).toBeDisabled();
  });
});
