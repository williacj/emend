// ABOUTME: Shared fixed-size dictation control for the editor, Timeline, and comment inputs.
// ABOUTME: Its visible phase is supplied by the Rust voice owner; an unavailable owner is inert.
import type { VoiceDeviceIssue } from "../settings/voiceIpc";
import type { MouseEvent } from "react";

export type DictationPresentation =
  | { kind: "idle" }
  | { kind: "downloading"; percent: number }
  | { kind: "cancelling" }
  | { kind: "download_cancelled" }
  | { kind: "recording"; elapsedSeconds: number }
  | { kind: "transcribing" }
  | { kind: "error"; reason: VoiceDeviceIssue | "model_missing" | "model_corrupt" | "download_failed" | "invalid_audio" | "inference_failed" }
  | { kind: "unavailable"; reason?: "build" | "disabled" | "owner" | "events" | "read_only" }
  | { kind: "frozen" };

export interface DictationMicProps {
  state: DictationPresentation;
  platform?: "win" | "mac";
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function isVoiceSettingsError(state: DictationPresentation): boolean {
  return state.kind === "error" && [
    "no_device", "no_default_device", "selected_unavailable", "permission_denied",
  ].includes(state.reason);
}

function label(state: DictationPresentation): string {
  switch (state.kind) {
    case "idle": return "Dictate";
    case "downloading": return `Dictate — downloading voice model, ${state.percent}%`;
    case "cancelling": return "Dictate — cancelling voice model download";
    case "download_cancelled": return "Dictate — model download cancelled; resume";
    case "recording": return "Stop dictation — recording";
    case "transcribing": return "Dictation — transcribing";
    case "error":
      return `Dictate — ${{
        no_device: "no microphone found",
        no_default_device: "no default microphone available",
        selected_unavailable: "selected microphone unavailable",
        permission_denied: "microphone permission denied",
        backend_unavailable: "microphone access unavailable",
        model_missing: "voice model missing",
        model_corrupt: "voice model is corrupt",
        download_failed: "voice model download failed",
        invalid_audio: "recording could not be read",
        inference_failed: "dictation failed",
      }[state.reason]}`;
    case "unavailable": return {
      build: "Dictate — unavailable in this build",
      disabled: "Dictate — voice is off in Settings",
      owner: "Dictate — voice status unavailable",
      events: "Dictate — event connection unavailable; retry",
      read_only: "Dictate — unavailable in this display mode",
    }[state.reason ?? "build"];
    case "frozen": return "Dictate — unavailable while saving";
  }
}

export function DictationMic({ state, platform = "win", onActivate }: DictationMicProps) {
  const actionable = state.kind === "idle" || state.kind === "recording" || state.kind === "error" ||
    state.kind === "download_cancelled" || (state.kind === "unavailable" && state.reason === "events");
  return (
    <button
      type="button"
      className={`dictation-mic dictation-mic--${state.kind}`}
      data-platform={platform}
      aria-label={label(state)}
      aria-description={isVoiceSettingsError(state) ? "Opens Voice Settings" : undefined}
      aria-pressed={state.kind === "recording" ? true : undefined}
      aria-busy={state.kind === "downloading" || state.kind === "cancelling" || state.kind === "transcribing" ? true : undefined}
      disabled={!actionable}
      onClick={onActivate}
      style={{ width: 28, height: 26 }}
    >
      {state.kind === "transcribing" || state.kind === "cancelling" ? (
        <span className="dictation-mic__dots" aria-hidden="true"><i /><i /><i /></span>
      ) : (
        <svg className="dictation-mic__glyph" width="12" height="15" viewBox="0 0 12 15" fill="none" aria-hidden="true">
          <rect x="3.5" y="1" width="5" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1.5 6.5a4.5 4.5 0 0 0 9 0M6 11v2.5M3.5 13.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          {state.kind === "error" && <path d="M1 14 11 1" stroke="currentColor" strokeWidth="1.5" />}
        </svg>
      )}
      {(state.kind === "downloading" || state.kind === "download_cancelled") && (
        <span className="dictation-mic__progress"
          role={state.kind === "downloading" ? "progressbar" : undefined}
          aria-label={state.kind === "downloading" ? "Voice model download" : undefined}
          aria-hidden={state.kind === "download_cancelled" ? true : undefined}
          aria-valuemin={state.kind === "downloading" ? 0 : undefined}
          aria-valuemax={state.kind === "downloading" ? 100 : undefined}
          aria-valuenow={state.kind === "downloading" ? state.percent : undefined}>
          <span style={{ width: state.kind === "downloading" ? `${state.percent}%` : "100%" }} />
        </span>
      )}
    </button>
  );
}
