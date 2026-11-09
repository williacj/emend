// ABOUTME: Public surface of the `stores/` module (§3.1) — display-state-only frontend stores;
// ABOUTME: all authority lives in Rust. P2a-6 lands the `tabs` store first.
export {
  closeTab,
  dirtyTabsRequiringGuard,
  EMPTY_TABS,
  openTab,
  restoreFromSession,
  setActiveTab,
  setTabDirty,
  tabsRequiringCloseGuard,
  toSessionPayload,
  type TabRecord,
  type TabsState,
} from "./tabs";
export {
  closeWindow,
  coordinateAppQuit,
  installQuitGuard,
  type QuitParticipant,
  type QuitPreflight,
  type Unlisten,
  type WindowCloseOutcome,
} from "./appLifecycle";
export { isWorkshopMode } from "./workshopMode";
