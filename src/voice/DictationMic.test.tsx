// @vitest-environment jsdom
// ABOUTME: Dictation chip contract from the authoring shell's 3c voice-state table.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DictationMic, type DictationPresentation } from "./DictationMic";

function show(state: DictationPresentation) {
  const onActivate = vi.fn();
  const result = render(<DictationMic state={state} platform="win" onActivate={onActivate} />);
  return { ...result, onActivate };
}

describe("voice/DictationMic", () => {
  it("keeps a held hairline after download cancellation without announcing active progress", () => {
    const cancelled = show({ kind: "download_cancelled" });
    const button = screen.getByRole("button", { name: "Dictate — model download cancelled; resume" });
    expect(button.querySelector(".dictation-mic__progress > span")).toHaveStyle({ width: "100%" });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(cancelled.onActivate).toHaveBeenCalledOnce();
  });

  it("presents the ruled phases and errors with fixed geometry and truthful button semantics", () => {
    const idle = show({ kind: "idle" });
    const button = screen.getByRole("button", { name: "Dictate" });
    expect(button).toHaveStyle({ width: "28px", height: "26px" });
    fireEvent.click(button);
    expect(idle.onActivate).toHaveBeenCalledOnce();
    idle.unmount();

    const downloading = show({ kind: "downloading", percent: 42 });
    expect(screen.getByRole("button", { name: "Dictate — downloading voice model, 42%" }))
      .toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("progressbar", { name: "Voice model download" }))
      .toHaveAttribute("aria-valuenow", "42");
    fireEvent.click(screen.getByRole("button"));
    expect(downloading.onActivate).not.toHaveBeenCalled();
    downloading.unmount();

    const recording = show({ kind: "recording", elapsedSeconds: 7 });
    const stop = screen.getByRole("button", { name: "Stop dictation — recording" });
    expect(stop).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(stop);
    expect(recording.onActivate).toHaveBeenCalledOnce();
    recording.unmount();

    const transcribing = show({ kind: "transcribing" });
    expect(screen.getByRole("button", { name: "Dictation — transcribing" }))
      .toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button"));
    expect(transcribing.onActivate).not.toHaveBeenCalled();
    transcribing.unmount();

    for (const [reason, label] of [
      ["no_device", "Dictate — no microphone found"],
      ["no_default_device", "Dictate — no default microphone available"],
      ["selected_unavailable", "Dictate — selected microphone unavailable"],
      ["permission_denied", "Dictate — microphone permission denied"],
      ["backend_unavailable", "Dictate — microphone access unavailable"],
      ["model_missing", "Dictate — voice model missing"],
      ["invalid_audio", "Dictate — recording could not be read"],
      ["inference_failed", "Dictate — dictation failed"],
    ] as const) {
      const error = show({ kind: "error", reason });
      const retry = screen.getByRole("button", { name: label });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      expect(error.onActivate).toHaveBeenCalledOnce();
      error.unmount();
    }

    const unavailable = show({ kind: "unavailable" });
    expect(screen.getByRole("button", { name: "Dictate — unavailable in this build" })).toBeDisabled();
    unavailable.unmount();
  });
});
