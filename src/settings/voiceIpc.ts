// ABOUTME: Typed frontend mirror of Rust voice Settings commands and status events.
// ABOUTME: All values come from the backend's persisted preferences and live hardware/model checks.
import { callBackend } from "../backend";
import { listenForBackendEvent } from "../stores/driverEvents";

export interface VoiceInputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export type VoiceDeviceIssue =
  | "no_device"
  | "no_default_device"
  | "selected_unavailable"
  | "permission_denied"
  | "backend_unavailable";

export type VoiceDictationIssue = VoiceDeviceIssue | "model_missing" | "model_corrupt" | "invalid_audio" | "inference_failed";

export type VoiceModelState = "absent" | "missing" | "corrupt" | "ready";
export type VoiceModelOrigin = "managed" | "external";
export type VoiceDownloadIssue =
  | "transport" | "storage" | "registry" | "protocol" | "truncated" | "oversized" | "corrupt" | "cancelled";
export type VoiceDownloadPhase =
  | { kind: "idle" }
  | { kind: "progress"; downloaded: number; total: number }
  | { kind: "cancelling" }
  | { kind: "completed" }
  | { kind: "cancelled"; downloaded: number; total: number }
  | { kind: "failed"; reason: VoiceDownloadIssue };

/** Rust assigns this before publishing a phase; delivery may arrive out of order. */
export interface VoiceDownloadNotice {
  revision: number;
  phase: VoiceDownloadPhase;
}

export interface VoiceStatus {
  enabled: boolean;
  selected_device_id: string | null;
  /** Display-only fallback for a selected microphone that is no longer enumerated. */
  selected_device_name: string | null;
  devices: VoiceInputDevice[];
  device_issue: VoiceDeviceIssue | null;
  model: VoiceModelState;
  /** Null when no model is registered or its managed path cannot be classified safely. */
  model_origin: VoiceModelOrigin | null;
  /** Canonical recorded path for external models only; never a managed path. */
  external_model_path: string | null;
  download: VoiceDownloadPhase;
  download_revision: number;
  capture_active: boolean;
  /** Compiled local Whisper owner. An absent field from an older backend is unavailable. */
  inference_available?: boolean;
  /** Rust-owned dictation phase; added by the shared mic owner command seam. */
  dictation?:
    | { kind: "idle" }
    | { kind: "recording"; elapsed_seconds: number }
    | { kind: "transcribing" }
    | { kind: "error"; reason: VoiceDictationIssue };
  /** Accepted Rust owner session; null after Final/Failed/Cancelled. */
  dictation_generation: number | null;
}

/** Start's immutable accepted session, even if the current status already shows a successor. */
export interface VoiceStartReceipt extends VoiceStatus {
  accepted_generation: number;
}

/** All phases carry the accepted generation, including a live provisional Partial. */
export type VoiceDictationEvent =
  | { kind: "recording"; generation: number }
  | { kind: "partial"; generation: number; text: string }
  | { kind: "transcribing"; generation: number }
  | { kind: "final"; generation: number; text: string }
  | { kind: "failed"; generation: number; reason: VoiceDictationIssue }
  | { kind: "cancelled"; generation: number };

export const VOICE_DOWNLOAD_EVENT = "voice://download";
export const VOICE_DICTATION_EVENT = "voice://dictation";

export function listenVoiceDictationEvents(handler: (event: VoiceDictationEvent) => void): Promise<() => void> {
  return listenForBackendEvent(VOICE_DICTATION_EVENT, handler);
}

export function getVoiceStatus(): Promise<VoiceStatus> {
  return callBackend("get_voice_status", {});
}
export function setVoiceEnabled(enabled: boolean): Promise<VoiceStatus> {
  return callBackend("set_voice_enabled", { enabled });
}
export function selectVoiceInputDevice(deviceId: string | null): Promise<VoiceStatus> {
  return callBackend("select_voice_input_device", { deviceId });
}
export function downloadVoiceModel(): Promise<void> {
  return callBackend("download_voice_model", {});
}
export function cancelVoiceDownload(): Promise<void> {
  return callBackend("cancel_voice_download", {});
}
export function removeVoiceModel(): Promise<VoiceStatus> {
  return callBackend("remove_voice_model", {});
}
export function startVoiceDictation(): Promise<VoiceStartReceipt> {
  return callBackend("start_voice_dictation", {});
}
export function stopVoiceDictation(): Promise<VoiceStatus> {
  return callBackend("stop_voice_dictation", {});
}
export function cancelVoiceDictation(expectedGeneration: number): Promise<VoiceStatus> {
  return callBackend("cancel_voice_dictation", { expectedGeneration });
}
