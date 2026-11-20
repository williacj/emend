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

  const retryable = [
    ["model_missing", "Downloads the voice model, then starts dictation"],
    ["model_corrupt", "Downloads the voice model, then starts dictation"],
    ["download_failed", "Retries the voice model download, then starts dictation"],
    ["backend_unavailable", "Retries dictation"],
    ["invalid_audio", "Retries dictation"],
    ["inference_failed", "Retries dictation"],
  ] as const;
  const settingsRoute = ["no_device", "no_default_device", "selected_unavailable", "permission_denied"] as const;

  it.each(retryable)("14g %s carries the retry cue and its approved description", (reason, description) => {
    const { container, onActivate } = show({ kind: "error", reason });
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-description", description);
    expect(button).toHaveStyle({ width: "28px", height: "26px" });
    const cue = container.querySelector(".dictation-mic__retry");
    expect(cue).toHaveTextContent("↻");
    expect(cue).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it.each(settingsRoute)("14g %s has no retry cue and describes the Settings route", (reason) => {
    const { container, onActivate } = show({ kind: "error", reason });
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-description", "Opens Voice Settings");
    expect(container.querySelector(".dictation-mic__retry")).toBeNull();
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("14g non-error phases carry no retry cue or description", () => {
    const { container } = show({ kind: "idle" });
    expect(container.querySelector(".dictation-mic__retry")).toBeNull();
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-description");
  });
});
