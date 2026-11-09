// ABOUTME: Projects Rust voice truth into one shared dictation chip state.
import { describe, expect, it } from "vitest";
import type { VoiceStatus } from "../settings/voiceIpc";
import { voicePresentation, voiceStatusEcho } from "./voicePresentation";

const ready: VoiceStatus = {
  enabled: true,
  selected_device_id: null,
  selected_device_name: null,
  devices: [{ id: "mic-a", name: "Desk microphone", is_default: true }],
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

describe("voice/voicePresentation", () => {
  it("#2627 unavailable voice overrides model recovery", () => {
    for (const unavailable of [
      { inference_available: false, enabled: true, reason: "build" },
      { inference_available: true, enabled: false, reason: "disabled" },
    ] as const) {
      for (const download of [
        { kind: "cancelled", downloaded: 20, total: 100 } as const,
        { kind: "failed", reason: "transport" } as const,
      ]) {
        expect(voicePresentation({ ...ready, ...unavailable, download, model: "absent" }))
          .toEqual({ kind: "unavailable", reason: unavailable.reason });
      }
    }
  });

  it("never offers an enabled mic without inference and prioritizes the owner phases", () => {
    expect(voicePresentation({ ...ready, inference_available: false })).toEqual({ kind: "unavailable", reason: "build" });
    expect(voicePresentation({ ...ready, model: "absent" })).toEqual({
      kind: "error", reason: "model_missing",
    });
    expect(voicePresentation({ ...ready, download: { kind: "progress", downloaded: 42, total: 100 }, model: "absent" }))
      .toEqual({ kind: "downloading", percent: 42 });
    expect(voicePresentation({ ...ready, device_issue: "permission_denied" }))
      .toEqual({ kind: "error", reason: "permission_denied" });
    expect(voicePresentation({ ...ready, device_issue: "no_device" }))
      .toEqual({ kind: "error", reason: "no_device" });
    expect(voicePresentation({ ...ready, dictation: { kind: "recording", elapsed_seconds: 7 } }))
      .toEqual({ kind: "recording", elapsedSeconds: 7 });
    expect(voicePresentation({ ...ready, dictation: { kind: "transcribing" } }))
      .toEqual({ kind: "transcribing" });
    expect(voicePresentation(ready)).toEqual({ kind: "idle" });
  });

  it("keeps missing default, selected-unavailable, and backend failures distinct from no device", () => {
    for (const [issue, reason, copy] of [
      ["no_default_device", "no_default_device", "No default microphone is available"],
      ["selected_unavailable", "selected_unavailable", "Selected microphone is unavailable"],
      ["backend_unavailable", "backend_unavailable", "Microphone access is unavailable"],
    ] as const) {
      const state = voicePresentation({ ...ready, device_issue: issue });
      expect(state).toEqual({ kind: "error", reason });
      expect(voiceStatusEcho(state)).toEqual({ text: copy, error: true });
    }
  });

  it("active owner phase outranks stale model operations", () => {
    expect(voicePresentation({
      ...ready, download: { kind: "failed", reason: "transport" },
      dictation: { kind: "recording", elapsed_seconds: 12 }, capture_active: true,
    })).toEqual({ kind: "recording", elapsedSeconds: 12 });
    expect(voicePresentation({
      ...ready, enabled: false, dictation: { kind: "transcribing" },
    })).toEqual({ kind: "transcribing" });
    for (const download of [{ kind: "cancelling" } as const,
      { kind: "cancelled", downloaded: 20, total: 100 } as const]) {
      expect(voicePresentation({ ...ready, download, capture_active: true,
        dictation: { kind: "recording", elapsed_seconds: 8 } }))
        .toEqual({ kind: "recording", elapsedSeconds: 8 });
      expect(voicePresentation({ ...ready, download,
        dictation: { kind: "transcribing" } })).toEqual({ kind: "transcribing" });
    }
  });
});
