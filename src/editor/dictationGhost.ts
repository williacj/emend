// ABOUTME: Provisional dictation text is a mapped CM6 widget, never source or undo history.
// ABOUTME: The accepted session owns one fixed insertion anchor even when the caret moves.
import { isolateHistory } from "@codemirror/commands";
import { EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

interface Ghost {
  generation: number;
  from: number;
  to: number;
  text: string;
}

interface Target { from: number; to: number }

interface GhostState {
  ghost: Ghost | null;
  pendingTarget: Target | null;
  pendingTargetInvalidated: boolean;
  invalidationRevision: number;
  highestAcceptedGeneration: number | null;
}

const captureTarget = StateEffect.define<Target>();
const retireTarget = StateEffect.define<void>();
const beginGhost = StateEffect.define<Pick<Ghost, "generation" | "from" | "to">>();
const showPartial = StateEffect.define<Pick<Ghost, "generation" | "text">>();
const clearGhost = StateEffect.define<number>();
const retireThrough = StateEffect.define<number>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }

  eq(other: GhostWidget): boolean { return other.text === this.text; }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-dictation-ghost";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

export const dictationGhostField = StateField.define<GhostState>({
  create: () => ({ ghost: null, pendingTarget: null, pendingTargetInvalidated: false,
    invalidationRevision: 0, highestAcceptedGeneration: null }),
  update(previous, transaction) {
    let ghost = previous.ghost;
    let pendingTarget = previous.pendingTarget;
    let pendingTargetInvalidated = previous.pendingTargetInvalidated;
    let invalidationRevision = previous.invalidationRevision;
    // The matched Final intentionally replaces its own target and clears the ghost in this
    // transaction. Only another edit invalidates the original selection.
    if (transaction.docChanged && !transaction.isUserEvent("input.dictation")) {
      if (ghost) {
        const mapped = mapTarget(ghost, transaction);
        if (overlapsTarget(ghost, transaction) || mapped.from > mapped.to) {
          ghost = null;
          invalidationRevision += 1;
        } else ghost = { ...ghost, ...mapped };
      }
      if (pendingTarget) {
        const mapped = mapTarget(pendingTarget, transaction);
        if (overlapsTarget(pendingTarget, transaction) || mapped.from > mapped.to) {
          pendingTarget = null;
          pendingTargetInvalidated = true;
          invalidationRevision += 1;
        } else pendingTarget = mapped;
      }
    }
    let highestAcceptedGeneration = previous.highestAcceptedGeneration;
    for (const effect of transaction.effects) {
      if (effect.is(captureTarget)) {
        pendingTarget = effect.value;
        pendingTargetInvalidated = false;
      }
      if (effect.is(retireTarget)) {
        pendingTarget = null;
        pendingTargetInvalidated = false;
        ghost = null;
      }
      if (effect.is(beginGhost) &&
        (highestAcceptedGeneration === null || effect.value.generation > highestAcceptedGeneration)) {
        highestAcceptedGeneration = effect.value.generation;
        ghost = { ...effect.value, text: "" };
        pendingTarget = null;
        pendingTargetInvalidated = false;
      }
      if (effect.is(retireThrough) &&
        (highestAcceptedGeneration === null || effect.value > highestAcceptedGeneration)) {
        highestAcceptedGeneration = effect.value;
        ghost = null;
        pendingTarget = null;
        pendingTargetInvalidated = false;
      }
      if (effect.is(showPartial) && ghost?.generation === effect.value.generation) {
        ghost = { ...ghost, text: effect.value.text };
      }
      if (effect.is(clearGhost) && ghost?.generation === effect.value) ghost = null;
    }
    return ghost === previous.ghost && pendingTarget === previous.pendingTarget &&
      pendingTargetInvalidated === previous.pendingTargetInvalidated &&
      invalidationRevision === previous.invalidationRevision &&
      highestAcceptedGeneration === previous.highestAcceptedGeneration
      ? previous
      : { ghost, pendingTarget, pendingTargetInvalidated, invalidationRevision, highestAcceptedGeneration };
  },
  provide: (field) => EditorView.decorations.from(field, ({ ghost }) => {
    if (!ghost) return Decoration.none;
    const decorations = [];
    if (ghost.from < ghost.to) {
      decorations.push(Decoration.mark({ class: "cm-dictation-held-range" }).range(ghost.from, ghost.to));
    }
    if (ghost.text) {
      decorations.push(Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.to));
    }
    return decorations.length ? Decoration.set(decorations, true) : Decoration.none;
  }),
});

function mapTarget(target: Target, transaction: Transaction): Target {
  if (target.from === target.to) {
    const anchor = transaction.changes.mapPos(target.from, 1);
    return { from: anchor, to: anchor };
  }
  return {
    from: transaction.changes.mapPos(target.from, 1),
    to: transaction.changes.mapPos(target.to, -1),
  };
}

function overlapsTarget(target: Target, transaction: Transaction): boolean {
  if (target.from === target.to) return false;
  let overlaps = false;
  transaction.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA) overlaps ||= fromA > target.from && fromA < target.to;
    else overlaps ||= fromA < target.to && toA > target.from;
  });
  return overlaps;
}

export function editorDictationTargetInvalidated(before: EditorState, after: EditorState): boolean {
  return before.field(dictationGhostField).invalidationRevision !==
    after.field(dictationGhostField).invalidationRevision;
}

export function captureEditorDictationTarget(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({ effects: captureTarget.of({ from, to }) });
  return true;
}

export function retireEditorDictationTarget(view: EditorView): void {
  view.dispatch({ effects: retireTarget.of() });
}

export function beginEditorDictation(view: EditorView, generation: number): boolean {
  const { ghost, pendingTarget, pendingTargetInvalidated, highestAcceptedGeneration } = view.state.field(dictationGhostField);
  if (ghost?.generation === generation) return true;
  if (highestAcceptedGeneration !== null && generation <= highestAcceptedGeneration) return false;
  if (view.state.readOnly || pendingTargetInvalidated) {
    view.dispatch({ effects: retireThrough.of(generation) });
    return false;
  }
  const target = pendingTarget ?? view.state.selection.main;
  view.dispatch({ effects: beginGhost.of({ generation, from: target.from, to: target.to }) });
  return true;
}

export function showEditorDictationPartial(view: EditorView, generation: number, text: string): boolean {
  if (view.state.field(dictationGhostField).ghost?.generation !== generation) return false;
  view.dispatch({ effects: showPartial.of({ generation, text }) });
  return true;
}

export function clearEditorDictation(view: EditorView, generation: number): boolean {
  if (view.state.field(dictationGhostField).ghost?.generation !== generation) return false;
  view.dispatch({ effects: clearGhost.of(generation) });
  return true;
}

export function commitEditorDictationFinal(view: EditorView, generation: number, text: string): boolean {
  const ghost = view.state.field(dictationGhostField).ghost;
  if (ghost?.generation !== generation || view.state.readOnly) return false;
  if (!text) return clearEditorDictation(view, generation);
  view.dispatch({
    changes: { from: ghost.from, to: ghost.to, insert: text },
    effects: clearGhost.of(generation),
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.dictation")],
  });
  return true;
}
