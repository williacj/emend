// ABOUTME: One backend-confirmed voice snapshot shared by editor, Timeline, and comment mics.
// ABOUTME: The Rust owner controls availability and phase; no UI action paints an optimistic recording.
import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { listenForBackendEvent } from "../stores/driverEvents";
import {
  getVoiceStatus,
  downloadVoiceModel,
  startVoiceDictation,
  stopVoiceDictation,
  cancelVoiceDictation,
  VOICE_DICTATION_EVENT,
  VOICE_DOWNLOAD_EVENT,
  type VoiceDictationEvent,
  type VoiceDownloadNotice,
  type VoiceStatus,
} from "../settings/voiceIpc";
import { DictationMic, isVoiceSettingsError, type DictationPresentation } from "./DictationMic";
import { voicePresentation } from "./voicePresentation";
import { isMac } from "../editor/keymap";

let snapshot: VoiceStatus | null = null;
let revision = 0;
let pendingRefresh: Promise<void> | null = null;
let refreshQueued = false;
let actionPending: { id: number; kind: "model" | "dictation"; downloadRevision: number } | null = null;
let nextActionId = 0;
let startIntentEpoch = 0;
type DictationOrigin = {
  onEvent: (event: VoiceDictationEvent) => void;
  handler?: (event: VoiceDictationEvent) => void;
  onStart?: () => void;
  onRetire?: () => void;
};
type DictationLease = { origin: DictationOrigin; generation: number };
type PendingStart = { origin: DictationOrigin; earlyEvents: VoiceDictationEvent[] };
let activeLease: DictationLease | null = null;
let pendingStart: PendingStart | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();
let stopEvents: (() => void)[] = [];
let dictationListenerPending: Promise<boolean> | null = null;
let dictationListenerInstalled = false;
let dictationListenerFailed = false;
let listenerEpoch = 0;

/** The immutable session-close payload freezes the editor surface without changing voice ownership. */
export const DictationFreezeContext = createContext(false);
export const VoiceSettingsOpenContext = createContext<((trigger: HTMLButtonElement) => void) | null>(null);

function ownerTransportAvailable() {
  // An isolated component tree has no native owner. D23 sets the explicit driver URL in Vite;
  // the shipped webview has Tauri internals before React mounts. Neither exists in unit-only DOMs.
  return typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || Boolean(import.meta.env.VITE_TEST_DRIVER_URL));
}

function setSnapshot(status: VoiceStatus | null) {
  if (status && snapshot && status.download_revision < snapshot.download_revision) {
    // A status read may have started before a newer Rust download event was delivered.
    status = {
      ...status,
      model: snapshot.model,
      download: snapshot.download,
      download_revision: snapshot.download_revision,
    };
  }
  if (status && actionPending?.kind === "model" &&
      status.download_revision > actionPending.downloadRevision &&
      (status.download.kind === "cancelled" || status.download.kind === "failed")) {
    // A terminal status can arrive before its equal-revision event while the old IPC is held.
    startIntentEpoch += 1;
    actionPending = null;
  }
  snapshot = status;
  revision += 1;
  const recording = status?.dictation?.kind === "recording";
  if (recording && subscribers.size > 0 && !elapsedTimer) {
    elapsedTimer = setInterval(() => { void refreshVoiceStatus(); }, 1000);
  } else if (!recording && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  for (const subscriber of subscribers) subscriber();
}

function setDictationListenerFailed(failed: boolean) {
  if (dictationListenerFailed === failed) return;
  dictationListenerFailed = failed;
  for (const subscriber of subscribers) subscriber();
}

function ensureDictationListener(): Promise<boolean> {
  if (dictationListenerInstalled) return Promise.resolve(true);
  if (dictationListenerPending) return dictationListenerPending;
  const epoch = listenerEpoch;
  const pending = Promise.resolve().then(() => listenForBackendEvent(VOICE_DICTATION_EVENT, (event: VoiceDictationEvent) => {
    receiveDictationEvent(event);
    void refreshVoiceStatus();
  })).then((stop) => {
    if (epoch !== listenerEpoch || subscribers.size === 0) {
      stop();
      return false;
    }
    dictationListenerInstalled = true;
    stopEvents.push(() => { dictationListenerInstalled = false; stop(); });
    setDictationListenerFailed(false);
    return true;
  }).catch(() => {
    if (epoch === listenerEpoch && subscribers.size > 0) setDictationListenerFailed(true);
    return false;
  }).finally(() => {
    if (dictationListenerPending === pending) dictationListenerPending = null;
  });
  dictationListenerPending = pending;
  return pending;
}

export function publishVoiceStatus(status: VoiceStatus) { setSnapshot(status); }
export function invalidateVoiceStatus() { setSnapshot(null); }
function publishVoiceDownloadNotice(notice: VoiceDownloadNotice) {
  if (!snapshot || notice.revision <= snapshot.download_revision) return;
  setSnapshot({
    ...snapshot,
    model: notice.phase.kind === "completed" ? "ready" : snapshot.model,
    download: notice.phase,
    download_revision: notice.revision,
  });
}
function cancelRetiredGeneration(generation: number) {
  // A no-active conditional Cancel emits no event; read the owner again even in that case.
  void cancelVoiceDictation(generation).then(
    () => refreshVoiceStatus(),
    () => refreshVoiceStatus(),
  );
}
/** A tab change retires both an accepted first press and its transcript destination. */
export function retireVoiceStartIntent() {
  startIntentEpoch += 1;
  const retired = activeLease;
  const pending = pendingStart;
  activeLease = null;
  pendingStart = null;
  (retired?.origin ?? pending?.origin)?.onRetire?.();
  if (retired) {
    // The owner compares this immutable token; a stale shared status cannot authorize cancellation.
    cancelRetiredGeneration(retired.generation);
  }
}

/** A form action retires its own capture without disturbing speech started elsewhere. */
export function retireVoiceDictationOrigin(handler: (event: VoiceDictationEvent) => void) {
  if (activeLease?.origin.handler === handler || pendingStart?.origin.handler === handler) retireVoiceStartIntent();
}

function receiveDictationEvent(event: VoiceDictationEvent) {
  if (typeof event?.generation !== "number") return;
  if (activeLease?.generation === event.generation) {
    activeLease.origin.onEvent(event);
    if (event.kind === "final" || event.kind === "failed" || event.kind === "cancelled") activeLease = null;
  } else if (pendingStart) {
    // Tauri may deliver Recording or Partial before the Start command returns its receipt.
    // Keep only the latest Partial per generation and preserve terminal events at the cap.
    if (event.kind === "partial") {
      const previous = pendingStart.earlyEvents.findIndex((buffered) =>
        buffered.kind === "partial" && buffered.generation === event.generation);
      if (previous >= 0) pendingStart.earlyEvents.splice(previous, 1);
    }
    if (pendingStart.earlyEvents.length >= 64) {
      const oldestPartial = pendingStart.earlyEvents.findIndex((buffered) => buffered.kind === "partial");
      pendingStart.earlyEvents.splice(oldestPartial >= 0 ? oldestPartial : 0, 1);
    }
    pendingStart.earlyEvents.push(event);
  }
}

export function refreshVoiceStatus(): Promise<void> {
  if (pendingRefresh) {
    // An event can describe a phase newer than the request already in flight. Read again
    // after that request settles rather than treating the old response as the event's answer.
    refreshQueued = true;
    return pendingRefresh;
  }
  const startedAt = revision;
  pendingRefresh = getVoiceStatus().then((status) => {
    if (revision === startedAt) publishVoiceStatus(status);
  }).catch(() => {
    // A formerly ready snapshot cannot keep advertising a working mic after the owner disappears.
    if (revision === startedAt) setSnapshot(null);
  }).finally(() => {
    pendingRefresh = null;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshVoiceStatus();
    }
  });
  return pendingRefresh;
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  if (snapshot?.dictation?.kind === "recording" && !elapsedTimer) {
    elapsedTimer = setInterval(() => { void refreshVoiceStatus(); }, 1000);
  }
  if (subscribers.size === 1 && ownerTransportAvailable()) {
    const refresh = () => { void refreshVoiceStatus(); };
    window.addEventListener("focus", refresh);
    stopEvents.push(() => window.removeEventListener("focus", refresh));
    void ensureDictationListener();
    void listenForBackendEvent<VoiceDownloadNotice>(VOICE_DOWNLOAD_EVENT, (notice) => {
      publishVoiceDownloadNotice(notice);
      refresh();
    }).then((stop) => {
      if (subscribers.size === 0) stop();
      else stopEvents.push(stop);
    }).catch(() => {});
    void refreshVoiceStatus();
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      listenerEpoch += 1;
      dictationListenerPending = null;
      dictationListenerFailed = false;
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      for (const stop of stopEvents.splice(0)) stop();
    }
  };
}

function getSnapshot() { return snapshot; }
function getDictationListenerFailed() { return dictationListenerFailed; }

export function useVoicePresentation(): DictationPresentation {
  const frozen = useContext(DictationFreezeContext);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const listenerFailed = useSyncExternalStore(subscribe, getDictationListenerFailed, getDictationListenerFailed);
  if (frozen) return { kind: "frozen" };
  const state = voicePresentation(status);
  return listenerFailed && state.kind !== "unavailable"
    ? { kind: "unavailable", reason: "events" }
    : state;
}

async function activate(state: DictationPresentation, origin: DictationOrigin) {
  if (actionPending) return;
  const ownerState = state.kind === "unavailable" && state.reason === "events"
    ? voicePresentation(snapshot) : state;
  const needsModel = ownerState.kind === "download_cancelled" ||
    (ownerState.kind === "error" && ["model_missing", "model_corrupt", "download_failed"].includes(ownerState.reason));
  if (ownerState.kind !== "idle" && ownerState.kind !== "recording" && ownerState.kind !== "error" &&
      ownerState.kind !== "download_cancelled") return;
  const actionId = ++nextActionId;
  actionPending = { id: actionId, kind: needsModel ? "model" : "dictation",
    downloadRevision: snapshot?.download_revision ?? -1 };
  const intent = needsModel ? ++startIntentEpoch : startIntentEpoch;
  const pending = ownerState.kind === "recording" ? null : { origin, earlyEvents: [] } satisfies PendingStart;
  if (pending) pendingStart = pending;
  try {
    // Tauri listener admission is async. Never capture a target or start Rust before events can
    // reach the accepted generation; a failed registration leaves the owner untouched and retries.
    if (!await ensureDictationListener() || intent !== startIntentEpoch) return;
    if (needsModel) {
      await downloadVoiceModel();
      if (intent !== startIntentEpoch) return;
      const readStartedAt = revision;
      const status = await getVoiceStatus();
      if (intent !== startIntentEpoch) return;
      if (revision === readStartedAt) publishVoiceStatus(status);
      // Cancellation and failure both retire this accepted intent. The Rust owner still checks
      // all prerequisites at start, including verified bytes and the currently selected device.
      if (!status.inference_available || !status.enabled || status.model !== "ready" ||
          status.device_issue || status.capture_active || status.dictation?.kind === "transcribing") return;
    }
    const startedAt = revision;
    let response: VoiceStatus;
    let acceptedGeneration: number | null = null;
    if (ownerState.kind === "recording") response = await stopVoiceDictation();
    else {
      origin.onStart?.();
      const receipt = await startVoiceDictation();
      response = receipt;
      acceptedGeneration = receipt.accepted_generation;
    }
    if (acceptedGeneration !== null && intent !== startIntentEpoch) {
      cancelRetiredGeneration(acceptedGeneration);
      return;
    }
    if (pending && pendingStart === pending && acceptedGeneration !== null) {
      pendingStart = null;
      activeLease = { origin, generation: acceptedGeneration };
      for (const event of pending.earlyEvents) receiveDictationEvent(event);
    }
    // A later owner event may already have published a terminal phase, or its status read may
    // still be in flight. In either case the command's older response cannot overwrite it.
    if (revision === startedAt && !pendingRefresh) publishVoiceStatus(response);
    else void refreshVoiceStatus();
  } catch {
    if (pending && pendingStart === pending) {
      pendingStart = null;
      origin.onRetire?.();
    }
    if (actionPending?.id === actionId) await refreshVoiceStatus();
  } finally {
    if (pendingStart === pending) pendingStart = null;
    if (actionPending?.id === actionId) actionPending = null;
  }
}

export function SharedDictationMic({
  platform = isMac ? "mac" : "win",
  onDictationEvent,
  onDictationStart,
  onDictationRetire,
  disabledForReadOnly = false,
}: { platform?: "win" | "mac"; onDictationEvent?: (event: VoiceDictationEvent) => void; onDictationStart?: () => void; onDictationRetire?: () => void; disabledForReadOnly?: boolean }) {
  const state = useVoicePresentation();
  const openVoiceSettings = useContext(VoiceSettingsOpenContext);
  const handler = useRef(onDictationEvent);
  handler.current = onDictationEvent;
  const origin = useRef<DictationOrigin>({ onEvent: (event: VoiceDictationEvent) => handler.current?.(event) });
  origin.current.handler = onDictationEvent;
  origin.current.onStart = onDictationStart;
  origin.current.onRetire = onDictationRetire;
  useLayoutEffect(() => () => {
    if (activeLease?.origin === origin.current || pendingStart?.origin === origin.current) {
      retireVoiceStartIntent();
    }
  }, []);
  return <DictationMic
    state={disabledForReadOnly && state.kind !== "frozen"
      ? { kind: "unavailable", reason: "read_only" }
      : state}
    platform={platform}
    onActivate={(event) => {
      if (isVoiceSettingsError(state)) {
        openVoiceSettings?.(event.currentTarget);
        return;
      }
      void activate(state, origin.current);
    }}
  />;
}
