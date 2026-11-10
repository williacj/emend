// ABOUTME: Source-view toggle + display-mode state (P2a-8, FR-ED-1/FR-ED-4, TD-2/§3.3) — a pure
// ABOUTME: decoration-suppression flag the structural/redline decoration layers read; dispatched as
// ABOUTME: state effects only, so a mode toggle can never be a doc-mutating transaction (P1).
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * The four track-changes display modes (FR-ED-4, D13) — mirrors `textops::display::DisplayMode`
 * (`src-tauri/crates/textops/src/display.rs`). `Simple` and `Original`/`None` project to the exact
 * same *visible* redline resolution this card renders (see `redlineResolution` below); the
 * distinction the rust layer documents (a future margin-bar decoration for `Simple`) is out of this
 * card's scope.
 */
export type DisplayMode = "All" | "Simple" | "None" | "Original";

export interface ViewModeState {
  /** Source view: decorations off entirely (§3.3) — raw markdown *and* CriticMarkup delimiters
   * shown verbatim, still editable. Independent of `displayMode`. */
  sourceView: boolean;
  /** The active display-mode projection (FR-ED-4). */
  displayMode: DisplayMode;
}

const DEFAULT_VIEW_MODE: ViewModeState = { sourceView: false, displayMode: "All" };

/** Toggle source view on/off. */
export const setSourceView = StateEffect.define<boolean>();
/** Switch the active display mode. */
export const setDisplayMode = StateEffect.define<DisplayMode>();

/** The live view-mode state — a `StateField` (not component state) so the decoration `StateField`s
 * in `structuralDecorations.ts`/`trackedChanges.ts` can read it directly during their own `update`,
 * the same pattern `revealAtCursorEnabledField` already established. */
export const viewModeField = StateField.define<ViewModeState>({
  create: () => DEFAULT_VIEW_MODE,
  update(value, tr) {
    let { sourceView, displayMode } = value;
    for (const effect of tr.effects) {
      if (effect.is(setSourceView)) sourceView = effect.value;
      if (effect.is(setDisplayMode)) displayMode = effect.value;
    }
    if (sourceView === value.sourceView && displayMode === value.displayMode) return value;
    return { sourceView, displayMode };
  },
});

/** Whether `tr` could have changed `viewModeField`'s value — what the decoration `StateField`s'
 * short-circuit checks need alongside their own doc/line-change conditions (a facet/effect-only
 * transaction carries no doc change and may not move the caret). */
export function viewModeChanged(tr: { effects: readonly StateEffect<unknown>[] }): boolean {
  return tr.effects.some((effect) => effect.is(setSourceView) || effect.is(setDisplayMode));
}

/** `viewModeField`'s value, defaulting when the field isn't installed — the one place that reads it
 * with a fallback, so `decorationsEnabled`/`redlineResolution` below (and any future reader) can't
 * drift from each other on what "not installed" means. */
function currentViewMode(state: EditorState): ViewModeState {
  return state.field(viewModeField, false) ?? DEFAULT_VIEW_MODE;
}

/** Whether decorations (structural markdown *and* redline) should render at all — off entirely in
 * source view (§3.3 "Source view = decorations off"); `false` (not installed) reads as enabled, so
 * headless `EditorState`s built without `viewModeExtensions()` keep their prior default behavior. */
export function decorationsEnabled(state: EditorState): boolean {
  return !currentViewMode(state).sourceView;
}

/** Whether TD-26's independent reveal preference may affect the current rich-text projection. */
export function displayModeAllowsMarkupReveal(state: EditorState): boolean {
  const mode = currentViewMode(state);
  return !mode.sourceView && mode.displayMode === "All";
}

/**
 * How a pending change's redline currently resolves for display (`textops::display::project`
 * semantics, read layer only — never a text mutation): `"normal"` renders both sides (All);
 * `"accept"` renders as if every change had been accepted — the removed side hidden entirely, the
 * added side shown as plain text (Simple/None, FR-ED-4's "clean accept-all text"); `"reject"` is the
 * mirror image — the added side hidden, the removed side shown as plain text (Original, "reject-all
 * text"). Defaults to `"normal"` when `viewModeField` isn't installed.
 */
export function redlineResolution(state: EditorState): "normal" | "accept" | "reject" {
  const mode = currentViewMode(state).displayMode;
  if (mode === "Original") return "reject";
  if (mode === "Simple" || mode === "None") return "accept";
  return "normal";
}

function isReadOnlyMode(mode: DisplayMode): boolean {
  return mode === "None" || mode === "Original";
}

/**
 * None/Original are read-only projections (§3.3, "matches the read-only-projection design") — both
 * the state-level `readOnly` facet (blocks command-driven edits) and the DOM-level `editable` facet
 * (blocks native typing/IME) derive straight from `viewModeField`, so entering/leaving a read-only
 * mode is a plain facet recompute, never a transaction that touches `doc`.
 */
const displayModeReadOnly: Extension = [
  EditorState.readOnly.from(viewModeField, (value) => isReadOnlyMode(value.displayMode)),
  EditorView.editable.from(viewModeField, (value) => !isReadOnlyMode(value.displayMode)),
];

/** A live root attribute lets projection CSS follow the same source-view state as decoration code. */
const sourceViewEditorAttributes = EditorView.editorAttributes.from(viewModeField, (value) => ({
  "data-emend-source-view": String(value.sourceView),
}));

/** The full view-mode extension bundle `editor/` wires into a document's `EditorState`. */
export function viewModeExtensions(): Extension[] {
  return [viewModeField, displayModeReadOnly, sourceViewEditorAttributes];
}
