// ABOUTME: FR-ED-4's Display projection control for UXR-Q7.2's status-bar right cluster.
// ABOUTME: It preserves all four choices in both the visible select and measured overflow menu.
import type { EditorView } from "@codemirror/view";
import type { DocumentStatusBarOverflowEntry } from "./DocumentStatusBar";
import { type DisplayMode, setDisplayMode, viewModeField } from "./viewMode";

export interface DisplayModeControlProps {
  view: EditorView;
  version: number;
}

export const DISPLAY_MODES: readonly DisplayMode[] = ["All", "Simple", "None", "Original"];

/** Switches only the editor projection; TD-26 keeps the reveal preference independent. */
export function dispatchDisplayMode(view: EditorView, mode: DisplayMode): void {
  view.dispatch({
    effects: setDisplayMode.of(mode),
  });
}

/** Mirrors the select's complete radio-choice semantics when the status item is overflowed. */
export function displayModeOverflowEntries(
  view: EditorView,
  activeMode: DisplayMode,
): readonly [DocumentStatusBarOverflowEntry, ...DocumentStatusBarOverflowEntry[]] {
  const entry = (mode: DisplayMode): DocumentStatusBarOverflowEntry => ({
    id: mode.toLowerCase(),
    label: `Display: ${mode}`,
    checked: activeMode === mode,
    onSelect: () => dispatchDisplayMode(view, mode),
  });
  return [entry("All"), entry("Simple"), entry("None"), entry("Original")];
}

export function DisplayModeControl({ view, version }: DisplayModeControlProps) {
  void version;
  const { displayMode } = view.state.field(viewModeField);
  return (
    <label className="display-mode-control">
      Display:
      <select
        aria-label="Display mode"
        value={displayMode}
        onChange={(event) => dispatchDisplayMode(view, event.target.value as DisplayMode)}
      >
        {DISPLAY_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
    </label>
  );
}
