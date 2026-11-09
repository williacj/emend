// ABOUTME: One projection of Rust-owned voice availability and phase for every input surface.
import type { VoiceStatus } from "../settings/voiceIpc";
import type { DictationPresentation } from "./DictationMic";

export function voicePresentation(status: VoiceStatus | null): DictationPresentation {
  if (!status || !status.download) return { kind: "unavailable", reason: "owner" };
  // The one live owner remains visible and stoppable across unrelated Settings/model changes.
  if (status.dictation?.kind === "recording") {
    return { kind: "recording", elapsedSeconds: status.dictation.elapsed_seconds };
  }
  if (status.dictation?.kind === "transcribing") return { kind: "transcribing" };
  if (!status.inference_available) return { kind: "unavailable", reason: "build" };
  if (!status.enabled) return { kind: "unavailable", reason: "disabled" };
  if (status.download.kind === "cancelling") return { kind: "cancelling" };
  if (status.download.kind === "cancelled") return { kind: "download_cancelled" };
  if (status.download.kind === "progress") {
    const { downloaded, total } = status.download;
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor(downloaded * 100 / total))) : 0;
    return { kind: "downloading", percent };
  }
  if (status.download.kind === "failed") return { kind: "error", reason: "download_failed" };
  if (status.dictation?.kind === "error") return { kind: "error", reason: status.dictation.reason };
  if (status.capture_active) return { kind: "recording", elapsedSeconds: 0 };
  if (status.device_issue) return { kind: "error", reason: status.device_issue };
  if (status.model === "corrupt") return { kind: "error", reason: "model_corrupt" };
  if (status.model !== "ready") return { kind: "error", reason: "model_missing" };
  return { kind: "idle" };
}

export function voiceStatusEcho(state: DictationPresentation): { text: string; error?: boolean } | null {
  switch (state.kind) {
    case "downloading": return { text: `Downloading voice model · ${state.percent}%` };
    case "cancelling": return { text: "Cancelling voice model download…" };
    case "download_cancelled": return { text: "Voice model download cancelled · Resume available" };
    case "recording": {
      const minutes = Math.floor(state.elapsedSeconds / 60);
      const seconds = String(state.elapsedSeconds % 60).padStart(2, "0");
      return { text: `Recording · ${minutes}:${seconds}` };
    }
    case "transcribing": return { text: "Transcribing…" };
    case "error": return { text: {
      no_device: "No microphone found",
      no_default_device: "No default microphone is available",
      selected_unavailable: "Selected microphone is unavailable",
      permission_denied: "Microphone access is off",
      backend_unavailable: "Microphone access is unavailable",
      model_missing: "Voice model is missing",
      model_corrupt: "Voice model is corrupt",
      download_failed: "Voice model download failed",
      invalid_audio: "Recording could not be read",
      inference_failed: "Dictation failed",
    }[state.reason], error: true };
    default: return null;
  }
}
