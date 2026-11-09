// ABOUTME: Wires a live CodeMirror view's tracked-change set to the redline toolbar + accept/reject
// ABOUTME: popover (P2a-5) and the type-filtered bulk-ops dropdown (P2b-2): clicking any redline or
// ABOUTME: stepping ◀ n/N ▶ opens the popover, and every entry point (buttons + Cmd/Ctrl keyboard
// ABOUTME: triage + the bulk dropdown) routes through the one group-atomic decision path.
import { type CSSProperties, type MutableRefObject, useCallback, useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { RedlinePopover, type RedlinePopoverChange } from "./RedlinePopover";
import { RedlineToolbar } from "./RedlineToolbar";
import { TrackChangesBulkMenu } from "./TrackChangesBulkMenu";
import {
  changeAt,
  decideChange,
  nextChange,
  prevChange,
  trackedChanges,
  type Decision,
  type LiveChange,
} from "./trackedChanges";

export interface RedlineReviewProps {
  /** The mounted editor view; `null` until it loads. */
  view: EditorView | null;
  /** Bumped by the editor on every view update, so this re-reads `view.state` (the live change set,
   * the caret) after each edit/decision. */
  version: number;
  /**
   * The editor sets this to the popover-opener; its CriticMarkup mousedown handler calls it with the
   * clicked document offset. A ref (not a prop callback) because the editor's CodeMirror event
   * handler is installed once at mount, before this component's handlers exist.
   */
  clickBridge: MutableRefObject<((pos: number) => void) | null>;
  /** Places the live controls in the document toolbar's context-group slot. */
  embedded?: boolean;
}

/** The popover's old→new text, read from the *current* document at the change's mapped sides (so an
 * edit inside a pending change shows through — J1 "your edit wins"). */
function popoverChange(view: EditorView, change: LiveChange): RedlinePopoverChange {
  const slice = (span?: { from: number; to: number }) =>
    span ? view.state.doc.sliceString(span.from, span.to) : "";
  return {
    kind: change.kind,
    oldText: slice(change.strike),
    newText: slice(change.underline),
    note: change.note,
  };
}

export function RedlineReview({ view, version, clickBridge, embedded = false }: RedlineReviewProps) {
  // The focused change (drives the toolbar's n/N and Accept/Reject and the popover); `popoverOpen`
  // is tracked apart so toolbar Accept/Reject can act without a popover ever showing.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  // `version` is read so a view update re-runs render; the change set/caret are read fresh below.
  void version;
  const changes = view ? trackedChanges(view.state) : [];

  const focusDocumentAt = useCallback(
    (position: number) => {
      if (!view) return;
      view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) } });
      view.focus();
    },
    [view],
  );

  // Focus a change: move the caret to its start (so keyboard triage targets it too) and remember it.
  const focus = useCallback(
    (id: string | null, openPopover: boolean) => {
      setCurrentId(id);
      setPopoverOpen(openPopover && id !== null);
      if (view && id !== null) {
        const c = trackedChanges(view.state).find((x) => x.id === id);
        if (c) view.dispatch({ selection: { anchor: c.full.from } });
      }
    },
    [view],
  );

  // Clicking a redline span in the document opens its popover — "no mode required" (J1).
  useEffect(() => {
    clickBridge.current = (pos) => {
      const c = view ? changeAt(view.state, pos) : undefined;
      focus(c ? c.id : null, c !== undefined);
    };
    return () => {
      clickBridge.current = null;
    };
  }, [view, focus, clickBridge]);

  if (!view || changes.length === 0) {
    if (embedded) return null;
    return (
      <RedlineToolbar count={0} position={0} onAccept={noop} onReject={noop} onPrev={noop} onNext={noop}>
        <TrackChangesBulkMenu view={view} version={version} />
      </RedlineToolbar>
    );
  }

  // The effective current change: the focused one, or the first pending when nothing is focused yet.
  const current = changes.find((c) => c.id === currentId) ?? changes[0];
  const position = changes.findIndex((c) => c.id === current.id) + 1;

  const decide = (id: string, decision: Decision) => {
    const caret = view.state.selection.main.head;
    const decidedAt = current.full.from;
    decideChange(view, id, decision, (mapping) => {
      // Advance to the next still-pending change near where we were, so triage flows without
      // re-aiming.
      const next = nextChange(view.state, caret - 1);
      focus(next ? next.id : null, popoverOpen && next !== undefined);
      // A final embedded-toolbar decision removes its focused button, so return to the decided
      // source position mapped through every group-atomic replacement. Popover decisions keep the
      // prior editor-focus behavior while changes remain — CM6's `Mod-s` keymap only fires while
      // the editor's own DOM has focus (P2a-5, #239).
      if (embedded && trackedChanges(view.state).length === 0) {
        focusDocumentAt(mapping.mapPos(decidedAt, -1));
      } else if (popoverOpen) view.focus();
    });
  };

  const step = (dir: "prev" | "next") => {
    const from = view.state.selection.main.head;
    const target = dir === "next" ? nextChange(view.state, from) : prevChange(view.state, from);
    if (target) focus(target.id, true);
  };

  const style: CSSProperties | undefined = coordsStyle(view, current.full.from);

  return (
    <>
      <RedlineToolbar
        embedded={embedded}
        count={changes.length}
        position={position}
        onAccept={() => decide(current.id, "accept")}
        onReject={() => decide(current.id, "reject")}
        onPrev={() => step("prev")}
        onNext={() => step("next")}
      >
        <TrackChangesBulkMenu
          view={view}
          version={version}
          onFinalDecision={
            embedded
              ? (mapping) => focusDocumentAt(mapping.mapPos(current.full.from, -1))
              : undefined
          }
        />
      </RedlineToolbar>
      {popoverOpen && (
        <RedlinePopover
          change={popoverChange(view, current)}
          style={style}
          onAccept={() => decide(current.id, "accept")}
          onReject={() => decide(current.id, "reject")}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </>
  );
}

function noop() {}

/** Absolute positioning next to a document offset, or `undefined` when the view has no layout yet
 * (headless tests / before first paint) — the popover still renders, just unpositioned. */
function coordsStyle(view: EditorView, pos: number): CSSProperties | undefined {
  let coords: { bottom: number; left: number } | null = null;
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    // No layout available (jsdom has no real geometry) — fall back to an unpositioned popover.
    return undefined;
  }
  if (!coords) return undefined;
  return { position: "absolute", top: coords.bottom, left: coords.left };
}
