// ABOUTME: Public surface of app settings — IPC types, the live process snapshot, and General UI.
// ABOUTME: Consumers share one event-hydrated snapshot and persist only field-scoped patches.
export {
  getSettings,
  patchSettings,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
  type AutosaveSettings,
  type NotificationSettings,
} from "./ipc";
export {
  SETTINGS_CHANGED_EVENT,
  getSettingsStoreSnapshot,
  patchCurrentSettings,
  retrySettingsHydration,
  startSettingsStore,
  subscribeSettings,
  type SettingsStoreSnapshot,
} from "./store";
export { SettingsDialog, type SettingsDialogProps } from "./SettingsDialog";
