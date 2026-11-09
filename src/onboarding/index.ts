// ABOUTME: Public surface of the `onboarding/` module (P2a-22, J8/FR-X-7) — the welcome screen,
// ABOUTME: the zero-provider status chip for an opened project, and the backend IPC bridge.
export { WelcomeScreen } from "./WelcomeScreen";
export { EditorOnlyStatusChip, EditorOnlyStatusChipView } from "./EditorOnlyStatusChip";
export { useProviderStatuses } from "./useProviderStatuses";
export { detectProviders, pickProjectFolder } from "./ipc";
export type { ProviderId, ProviderStatus, ProviderStatusEntry, ProviderStatuses } from "./types";
