// ABOUTME: Voice Settings controls for enable, local model, and input device.
// ABOUTME: Reports only backend-confirmed state and keeps failures and recovery visible.
import { useEffect, useRef, useState } from "react";
import { errorDetail } from "../backend";
import { listenForBackendEvent } from "../stores/driverEvents";
import { invalidateVoiceStatus, publishVoiceStatus } from "../voice/SharedDictationMic";
import {
  cancelVoiceDownload,
  downloadVoiceModel,
  getVoiceStatus,
  removeVoiceModel,
  selectVoiceInputDevice,
  setVoiceEnabled,
  VOICE_DICTATION_EVENT,
  VOICE_DOWNLOAD_EVENT,
  type VoiceDownloadNotice,
  type VoiceDownloadIssue,
  type VoiceDownloadPhase,
  type VoiceStatus,
} from "./voiceIpc";

const DEVICE_ISSUES: Record<NonNullable<VoiceStatus["device_issue"]>, string> = {
  no_device: "No microphone is available.",
  no_default_device: "No default microphone is available. Choose an input device.",
  selected_unavailable: "Selected microphone is unavailable. Choose another input device.",
  permission_denied: "Microphone permission was denied. Check system permissions.",
  backend_unavailable: "Microphone access is unavailable in this build or on this system.",
};

const DOWNLOAD_FAILURES: Record<VoiceDownloadIssue, string> = {
  transport: "Model download failed: Emend couldn’t complete the download over the network.",
  storage: "Model download failed: Emend couldn’t save the model on this device.",
  registry: "Model download failed: Emend couldn’t finish setting up the model.",
  protocol: "Model download failed: The file received wasn’t the expected voice model.",
  truncated: "Model download failed: The file received wasn’t the expected voice model.",
  oversized: "Model download failed: The file received wasn’t the expected voice model.",
  corrupt: "Model download failed: The file received wasn’t the expected voice model.",
  cancelled: "Model download failed: Emend stopped the download.",
};

function downloadPercent(downloaded: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round(100 * downloaded / Math.max(1, total))));
}

function voiceErrorDetail(cause: unknown): string {
  if (cause && typeof cause === "object" && "kind" in cause && typeof cause.kind === "string") {
    const descriptions: Record<string, string> = {
      capture_active: "Stop recording before changing voice or input device.",
      device_unavailable: "The selected microphone is unavailable. Choose another input device.",
      no_device: "No microphone is available.",
      no_default_device: "No default microphone is available. Choose an input device.",
      permission_denied: "Microphone permission was denied. Check system permissions.",
      backend_unavailable: "Microphone access is unavailable.",
      settings_unavailable: "Settings could not be saved.",
      model_unavailable: "The local model could not be managed.",
      download_unavailable: "The local model download could not finish.",
    };
    return descriptions[cause.kind] ?? "Try again.";
  }
  return errorDetail(cause) || "Try again.";
}

export function VoiceSettingsSection() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<VoiceDownloadNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState<"download" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusRevision = useRef(0);
  const modelActionId = useRef(0);
  const modelAction = useRef<{ id: number; revision: number } | null>(null);
  const latestDownloadRevision = useRef(0);
  const lastDownloadPercent = useRef<number | null>(null);
  const mounted = useRef(true);

  const retireTerminalModelAction = (revision: number, current: VoiceDownloadPhase) => {
    if (modelAction.current && revision > modelAction.current.revision &&
        (current.kind === "cancelled" || current.kind === "failed" || current.kind === "completed")) {
      modelAction.current = null;
      setModelBusy(null);
    }
  };

  const refresh = async (clearError = true) => {
    const revision = ++statusRevision.current;
    setLoading(true);
    try {
      const current = await getVoiceStatus();
      if (!mounted.current || revision !== statusRevision.current) return;
      const phaseIsCurrent = current.download_revision >= latestDownloadRevision.current;
      latestDownloadRevision.current = Math.max(latestDownloadRevision.current, current.download_revision);
      setStatus(current);
      publishVoiceStatus(current);
      if (phaseIsCurrent) retireTerminalModelAction(current.download_revision, current.download);
      if (clearError) setError(null);
    } catch (cause) {
      if (!mounted.current || revision !== statusRevision.current) return;
      invalidateVoiceStatus();
      setError(`Voice settings are unavailable. ${errorDetail(cause) || "Try again."}`);
    } finally {
      if (mounted.current && revision === statusRevision.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void listenForBackendEvent<VoiceDownloadNotice>(VOICE_DOWNLOAD_EVENT, (event) => {
      if (!active || event.revision < latestDownloadRevision.current) return;
      latestDownloadRevision.current = event.revision;
      setPhase((current) => current && current.revision > event.revision ? current : event);
      retireTerminalModelAction(event.revision, event.phase);
    }).then((unlisten) => {
      if (!active) unlisten();
      else stop = unlisten;
    }).catch(() => {
      // A missing event channel does not make a command response trustworthy; refresh still does.
    });
    let stop: (() => void) | undefined;
    void listenForBackendEvent(VOICE_DICTATION_EVENT, () => {
      if (active) void refresh(false);
    }).then((unlisten) => {
      if (!active) unlisten();
      else stopDictation = unlisten;
    }).catch(() => {});
    let stopDictation: (() => void) | undefined;
    void refresh();
    return () => {
      active = false;
      mounted.current = false;
      statusRevision.current += 1;
      stop?.();
      stopDictation?.();
    };
  }, []);

  const commit = async (operation: () => Promise<VoiceStatus>) => {
    const revisionAtStart = statusRevision.current;
    setBusy(true);
    setError(null);
    try {
      const current = await operation();
      if (!mounted.current) return;
      if (statusRevision.current !== revisionAtStart) {
        // An owner event may have published a newer phase while the command was held. Read
        // after command completion so the final Settings choice and owner phase both agree.
        await refresh(false);
      } else {
        statusRevision.current += 1;
        setStatus(current);
        setLoading(false);
        publishVoiceStatus(current);
      }
    } catch (cause) {
      if (!mounted.current) return;
      setError(`Voice setting was not changed. ${voiceErrorDetail(cause)}`);
      await refresh(false);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const download = async () => {
    lastDownloadPercent.current = null;
    const action = { id: ++modelActionId.current,
      revision: Math.max(status?.download_revision ?? -1, phase?.revision ?? -1) };
    modelAction.current = action;
    setModelBusy("download");
    setError(null);
    try {
      await downloadVoiceModel();
    } catch (cause) {
      if (mounted.current && modelAction.current?.id === action.id)
        setError(`Model download failed. ${voiceErrorDetail(cause)}`);
    } finally {
      if (mounted.current && modelAction.current?.id === action.id) {
        await refresh(false);
        if (mounted.current && modelAction.current?.id === action.id) {
          modelAction.current = null;
          setModelBusy(null);
        }
      }
    }
  };

  const cancelDownload = async () => {
    const action = { id: ++modelActionId.current,
      revision: Math.max(status?.download_revision ?? -1, phase?.revision ?? -1) };
    modelAction.current = action;
    setModelBusy("cancel");
    setError(null);
    try {
      await cancelVoiceDownload();
      if (mounted.current && modelAction.current?.id === action.id) await refresh(false);
    } catch (cause) {
      if (mounted.current && modelAction.current?.id === action.id) {
        setError(`Model download was not cancelled. ${voiceErrorDetail(cause)}`);
        await refresh(false);
      }
    } finally {
      if (mounted.current && modelAction.current?.id === action.id) {
        modelAction.current = null;
        setModelBusy(null);
      }
    }
  };

  const currentPhase: VoiceDownloadPhase | undefined = phase && status &&
    phase.revision > status.download_revision ? phase.phase : status?.download;
  const downloading = currentPhase?.kind === "progress";
  const cancelling = currentPhase?.kind === "cancelling";
  const modelReady = status?.model === "ready" || Boolean(status && phase?.phase.kind === "completed" &&
    phase.revision > status.download_revision);
  const showReady = modelReady && !downloading && !cancelling;
  const externalModel = status?.model_origin === "external";
  const transcribing = status?.dictation?.kind === "transcribing";
  if (currentPhase?.kind === "progress" || currentPhase?.kind === "cancelled") {
    lastDownloadPercent.current = downloadPercent(currentPhase.downloaded, currentPhase.total);
  }
  const hasPartialBar = downloading || cancelling || currentPhase?.kind === "cancelled";
  const progressPercent = lastDownloadPercent.current ?? 0;
  const knownProgress = lastDownloadPercent.current !== null;
  const deviceRejected = status?.device_issue != null && status.device_issue !== "backend_unavailable";
  return (
    <section className="settings-dialog__voice" aria-labelledby="settings-voice-heading">
      <div className="voice-settings__heading-row">
        <h2 id="settings-voice-heading" tabIndex={-1}>Voice</h2>
        {status && <button type="button" disabled={loading || busy || modelBusy !== null} onClick={() => void refresh()}>
          Refresh voice status
        </button>}
      </div>
      {loading && !status && <p role="status">Loading voice settings…</p>}
      {error && <div role="alert">{error} <button type="button" onClick={() => void refresh()}>Try again</button></div>}
      {status && <>
        <div className="settings-dialog__row">
          <label className="settings-dialog__setting-label" htmlFor="settings-voice-enabled">Enable voice</label>
          <span className="voice-settings__switch-control" data-disabled={busy || modelBusy !== null || status.capture_active}>
            <input id="settings-voice-enabled" className="voice-settings__switch" type="checkbox" role="switch" checked={status.enabled}
              disabled={busy || modelBusy !== null || status.capture_active}
              onChange={(event) => void commit(() => setVoiceEnabled(event.currentTarget.checked))} />
            <span className="voice-settings__switch-state">{status.enabled ? "On" : "Off"}</span>
          </span>
        </div>
        {!status.enabled && <p className="voice-settings__off-note">Each mic shows as unavailable — Dictate — voice is off in Settings — until voice is on.</p>}
        <div className="settings-dialog__row voice-settings__device-row">
          <label className="settings-dialog__setting-label" htmlFor="settings-voice-input">Input device</label>
          <div className="voice-settings__device-control">
            <select id="settings-voice-input" value={status.selected_device_id ?? ""}
              aria-invalid={deviceRejected || undefined}
              aria-describedby={status.device_issue ? "settings-voice-device-issue" : undefined}
              disabled={busy || modelBusy !== null || status.capture_active}
              onChange={(event) => void commit(() => selectVoiceInputDevice(event.currentTarget.value || null))}>
              <option value="">System default</option>
              {status.selected_device_id && !status.devices.some((device) => device.id === status.selected_device_id) &&
                <option value={status.selected_device_id}>{status.selected_device_name
                  ? `Unavailable: ${status.selected_device_name}` : "Unavailable selected microphone"}</option>}
              {status.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (default)" : ""}</option>)}
            </select>
            {status.device_issue && <p id="settings-voice-device-issue" className={deviceRejected ? "voice-settings__device-issue voice-settings__device-issue--reject" : "voice-settings__device-issue"} role="status">
              {deviceRejected && <span aria-hidden="true">⊘ </span>}{DEVICE_ISSUES[status.device_issue]}
            </p>}
          </div>
        </div>
        {status.capture_active && <p role="status">Recording is active. Stop recording before changing voice or input device.</p>}
        {transcribing && <p role="status">Transcribing is active. Wait for dictation to finish before removing the local model.</p>}
        <div className="settings-dialog__row settings-dialog__model-row">
          <span className="settings-dialog__setting-label">Local model</span>
          <div className="settings-dialog__model-state">
            <span role={downloading || cancelling ? "status" : undefined}>{downloading ? `Downloading model: ${progressPercent}%`
              : cancelling ? "Cancelling model download…"
              : modelReady ? "Model ready"
              : status.model === "missing" ? "Model file missing"
              : status.model === "corrupt" ? "Model file corrupt"
              : "Model not downloaded"}</span>
            {hasPartialBar && <div className={`settings-dialog__model-progress${downloading ? "" : " settings-dialog__model-progress--held"}`}
              role="progressbar" aria-label="Model download progress" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={knownProgress ? progressPercent : undefined}>
              <span style={{ width: cancelling && !knownProgress ? "100%" : `${progressPercent}%` }} />
            </div>}
          </div>
          {!modelReady && !downloading && !cancelling && <button type="button" className="settings-dialog__model-action settings-dialog__model-action--primary"
            disabled={busy || modelBusy !== null} onClick={() => void download()}>
            {currentPhase?.kind === "failed" ? "Retry model download" : currentPhase?.kind === "cancelled" ? "Resume model download" : "Download model"}
          </button>}
          {downloading && <button type="button" className="settings-dialog__model-action" disabled={busy || modelBusy === "cancel"} onClick={() => void cancelDownload()}>Cancel download</button>}
          {cancelling && <button type="button" className="settings-dialog__model-action" disabled aria-busy="true">Cancelling…</button>}
          {showReady && <button type="button" className="settings-dialog__model-action" disabled={loading || busy || modelBusy !== null || status.capture_active || transcribing}
            onClick={() => void commit(removeVoiceModel)}>{externalModel ? "Stop using this file"
              : status.model_origin === "managed" ? "Remove local model" : "Stop using this model"}</button>}
        </div>
        {showReady && externalModel && <>
          <p className="settings-dialog__model-note">External file — Emend won’t delete it</p>
          {status.external_model_path && <p className="settings-dialog__model-path" title={status.external_model_path}>{status.external_model_path}</p>}
        </>}
        {showReady && status.model_origin === null &&
          <p className="settings-dialog__model-note">Emend can’t verify this model’s location.</p>}
        {currentPhase?.kind === "cancelled" && <p role="status" className="settings-dialog__model-message">Model download cancelled. The partial download can resume.</p>}
        {currentPhase?.kind === "failed" && <p role="alert" className="settings-dialog__model-message settings-dialog__model-error">{DOWNLOAD_FAILURES[currentPhase.reason]}</p>}
      </>}
    </section>
  );
}
