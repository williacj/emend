// ABOUTME: Owns one process-global, live Settings snapshot hydrated after event subscription.
// ABOUTME: Publishes field-scoped patch results immediately and ignores stale reads/event echoes.
import { listenForBackendEvent } from "../stores/driverEvents";
import {
  DEFAULT_SETTINGS,
  getSettings,
  patchSettings,
  type Settings,
  type SettingsPatch,
} from "./ipc";

export const SETTINGS_CHANGED_EVENT = "settings://changed";

export interface SettingsStoreSnapshot {
  settings: Settings;
  status: "loading" | "ready" | "error";
  error: unknown | null;
}

const listeners = new Set<() => void>();
let snapshot: SettingsStoreSnapshot = {
  settings: DEFAULT_SETTINGS,
  status: "loading",
  error: null,
};
let settingsRevision = 0;
let hydrationRequest = 0;
let lifecycle = 0;
let unlisten: (() => void) | null = null;
let startPromise: Promise<void> | null = null;

function settingsEqual(left: Settings, right: Settings): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.autosave.enabled === right.autosave.enabled &&
    left.autosave.interval_ms === right.autosave.interval_ms &&
    left.notifications.completion === right.notifications.completion &&
    left.provider_default === right.provider_default &&
    left.reveal_markup_at_cursor === right.reveal_markup_at_cursor &&
    left.voice.enabled === right.voice.enabled &&
    left.voice.input_device_id === right.voice.input_device_id &&
    left.voice.input_device_name === right.voice.input_device_name
  );
}

function publish(next: SettingsStoreSnapshot): void {
  if (
    snapshot.status === next.status &&
    snapshot.error === next.error &&
    settingsEqual(snapshot.settings, next.settings)
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function publishSettings(settings: Settings): void {
  settingsRevision += 1;
  publish({ settings, status: "ready", error: null });
}

async function hydrate(activeLifecycle: number): Promise<void> {
  const request = ++hydrationRequest;
  const revision = settingsRevision;
  try {
    const settings = await getSettings();
    if (
      activeLifecycle !== lifecycle ||
      request !== hydrationRequest ||
      revision !== settingsRevision
    ) {
      return;
    }
    publishSettings(settings);
  } catch (error) {
    if (
      activeLifecycle !== lifecycle ||
      request !== hydrationRequest ||
      revision !== settingsRevision
    ) {
      return;
    }
    publish({ settings: snapshot.settings, status: "error", error });
  }
}

/** Starts the app-lifetime listener before issuing the initial `get_settings` hydration. */
export function startSettingsStore(): Promise<void> {
  if (startPromise) return startPromise;
  const activeLifecycle = lifecycle;
  const starting = (async () => {
    try {
      const stop = await listenForBackendEvent<Settings>(
        SETTINGS_CHANGED_EVENT,
        publishSettings,
      );
      if (activeLifecycle !== lifecycle) {
        stop();
        return;
      }
      unlisten = stop;
      await hydrate(activeLifecycle);
    } catch (error) {
      if (activeLifecycle !== lifecycle) return;
      publish({ settings: snapshot.settings, status: "error", error });
    }
  })();
  startPromise = starting;
  void starting.finally(() => {
    if (startPromise === starting && !unlisten) startPromise = null;
  });
  return starting;
}

/** Repeats hydration without disturbing the already-registered event listener. */
export async function retrySettingsHydration(): Promise<void> {
  if (!unlisten) {
    await startSettingsStore();
    return;
  }
  publish({ settings: snapshot.settings, status: "loading", error: null });
  await hydrate(lifecycle);
}

/** Applies one field-scoped patch and immediately publishes its complete committed result. */
export async function patchCurrentSettings(
  patch: SettingsPatch,
): Promise<Settings> {
  const revision = settingsRevision;
  const settings = await patchSettings(patch);
  if (revision === settingsRevision) publishSettings(settings);
  return settings;
}

export function getSettingsStoreSnapshot(): SettingsStoreSnapshot {
  return snapshot;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test isolation for this module's intentionally app-lifetime singleton. */
export function resetSettingsStoreForTests(): void {
  lifecycle += 1;
  hydrationRequest += 1;
  unlisten?.();
  unlisten = null;
  startPromise = null;
  settingsRevision = 0;
  snapshot = { settings: DEFAULT_SETTINGS, status: "loading", error: null };
  listeners.clear();
}
