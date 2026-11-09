// ABOUTME: Renders UXR-Q7.2's platform-aware document save state and FR-ED-7 recovery readouts.
// ABOUTME: It also describes an overflowed readout without turning that non-action into a fake action.
import type {
  DocumentStatusBarOverflowEntry,
  DocumentStatusBarPlatform,
} from "./DocumentStatusBar";

export type DocumentSaveState =
  | { kind: "saved"; at: number }
  | { kind: "writes-paused" }
  | { kind: "reload-write-pending" }
  | { kind: "reload-write-failed" };

export type DocumentSaveStatusSurface = "status-bar" | "title-bar";

function saveStatusLabel(state: DocumentSaveState): string {
  if (state.kind === "writes-paused") return "Not saved — writes paused";
  if (state.kind !== "saved") return "Reloaded from disk · not saved yet";
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(state.at));
  return `Saved · ${time}`;
}

export function documentSaveStatusOverflowEntry(
  state: DocumentSaveState,
  platform: DocumentStatusBarPlatform,
): DocumentStatusBarOverflowEntry | null {
  if (state.kind === "saved" && platform === "mac") return null;
  return {
    id: "save-state",
    label: saveStatusLabel(state),
    disabled: true,
  };
}

export function DocumentSaveStatus({
  state,
  platform,
  surface = "status-bar",
}: {
  state: DocumentSaveState;
  platform: DocumentStatusBarPlatform;
  surface?: DocumentSaveStatusSurface;
}) {
  const visible =
    surface === "title-bar"
      ? platform === "mac" && state.kind === "saved"
      : platform === "win" || state.kind !== "saved";
  if (!visible) return null;
  return (
    <span
      className={`document-save-status document-save-status--${surface}${
        state.kind === "reload-write-failed" ? " document-save-status--failed" : ""
      }`}
    >
      {saveStatusLabel(state)}
    </span>
  );
}
