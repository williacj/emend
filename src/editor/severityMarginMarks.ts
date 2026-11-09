// ABOUTME: Severity margin marks (P2b-4b, ux-design §2's "colour + letter chip — never colour
// ABOUTME: alone", tech-design §3.3 "severity margin marks (`● H` — color + letter)") — a CM6
// ABOUTME: gutter beside a severity-tagged thread's anchored line, keyed off the exact same live
// ABOUTME: anchor `commentHighlights.ts` draws its highlight from. Read-only: reads state, emits
// ABOUTME: gutter markers, never issues a doc-mutating transaction (P1).
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { severityLetter } from "../comments/severity";
import { commentAnchors, severityOf } from "./commentHighlights";

/** The DOM attribute a mark carries its display letter in — the same hook `styles.css`'s
 * `.comment-thread-card__severity[data-severity=...]` rules key colour off, so the timeline chip
 * and this margin mark agree on one palette without a shared class name (a CM6 gutter marker and a
 * React chip have nothing else in common to share). */
const SEVERITY_ATTRIBUTE = "data-severity";

/**
 * One severity mark, `● {letter}` — the letter is the marker's actual text content (not just an
 * `aria-label`), so ux-design §2's "never colour alone" rule is met even with no stylesheet and no
 * screen reader: the letter reads on its own. `severity` is kept as the raw `CommentThread.severity`
 * string (not yet the display letter) so `eq` and tests can compare it directly; `severityLetter`
 * is applied once, at render, exactly where `comments/CommentThreadCard`'s `SeverityChip` applies it.
 */
class SeverityMarker extends GutterMarker {
  constructor(readonly severity: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof SeverityMarker && other.severity === this.severity;
  }

  toDOM(): Node {
    const letter = severityLetter(this.severity);
    const el = document.createElement("span");
    el.className = "cm-severityMark";
    el.setAttribute(SEVERITY_ATTRIBUTE, letter);
    el.setAttribute("aria-label", `severity: ${letter}`);
    el.textContent = `● ${letter}`;
    return el;
  }
}

/**
 * One `SeverityMarker` per line carrying a severity-tagged thread's live anchor, built from
 * `commentAnchors` — the exact field `commentHighlights.ts`'s highlight layer draws its decorations
 * from — rather than re-deriving anchor positions here. That is what makes "a mark can never point
 * at a different line than its highlight" (P2b-4b's acceptance criterion) true by construction, not
 * by convention: both layers walk the one live position CM6 has been mapping through edits, and this
 * function does no offset arithmetic of its own. A thread with no severity (`severityOf` returns
 * `null` or `undefined`) contributes no marker — D6: severity is review-finding provenance, not a
 * property every thread has, so an ordinary human comment stays unmarked. Document-level (no anchor)
 * and orphaned threads never reach here either, for the identical D17/P2 reason `commentAnchors`
 * itself already excludes them (nothing honest to draw / a stale offset would be a wrong position).
 *
 * At most one marker per line: `commentAnchors` is in document order, so two severity-tagged anchors
 * sharing a line collapse to the first — CM6 gutters render one marker per line by construction, and
 * there is no ranking rule (yet) for which of two co-located findings should win the slot.
 */
export function buildSeverityMarkers(state: EditorState): RangeSet<GutterMarker> {
  const marks: Range<GutterMarker>[] = [];
  let lastLineStart = -1;
  for (const anchor of commentAnchors(state)) {
    const severity = severityOf(state, anchor.threadId);
    // `severity == null` (loose) catches both `null` ("no severity" — D6) and `undefined` (the
    // field isn't installed) while letting an agent-supplied `severity: ""` through: `severity.ts`
    // deliberately keeps `""` "fully representable end-to-end" (it renders `● ?` in the timeline
    // chip and is selected by the Findings facet's `isFindingProvenance`), so a plain falsy check
    // here would strand that finding with a timeline chip but no margin mark.
    if (severity == null) continue;
    const line = state.doc.lineAt(anchor.from);
    if (line.from === lastLineStart) continue;
    lastLineStart = line.from;
    marks.push(new SeverityMarker(severity).range(line.from));
  }
  return RangeSet.of(marks, true);
}

/** The live gutter: `markers` is re-read on every view update (CM6's own `SingleGutterView.update`
 * diffs the returned `RangeSet` by identity/`eq`, so an unchanged severity set repaints nothing) —
 * cost is bounded by the anchor count `buildSeverityMarkers` walks, never by document length, the
 * same FR-X-4 shape `commentAnchorsField` itself already guarantees this reads from.
 *
 * **The gutter column is unconditional.** `renderEmptyElements` defaults to `false`, so no per-line
 * `GutterElement` is built for a line with no marker — but that is a different thing from the
 * column: `SingleGutterView` builds its `dom` the moment the extension is installed, and
 * `.cm-severityGutter { width: 2.2em }` applies to it regardless. So once this bundle is wired into
 * `EditorShell`, every document reserves 2.2em of left margin whether or not it carries a single
 * finding. That reservation is **accepted here deliberately**, not overlooked: the alternative — a
 * column that appears when the first finding lands — shifts every line of text sideways under the
 * reader's eyes at a moment they did not ask for, which is exactly the unasked motion UX Principle 2
 * exists to forbid. A constant empty margin is the cheaper of the two costs.
 *
 * What is *not* settled here: whether 2.2em on a findings-free document is the right idle cost at
 * all (a narrower column, or one scoped to review-mode documents, would both keep the no-jitter
 * property). Making the column conditional needs mechanism this module does not have — a compartment
 * or facet-driven extension swap — so it belongs to the wiring card (#259), which should inherit
 * this note rather than re-discover the reserved column. `renders its gutter column even with no
 * severity-tagged threads` pins the current behaviour so a change to it is a visible test change. */
const severityMarginGutter = gutter({
  class: "cm-severityGutter",
  markers: (view) => buildSeverityMarkers(view.state),
});

/** CSS for the mark: `.cm-severityMark`'s colour is keyed off the identical `data-severity` letter
 * and the identical `--color-danger-fg`/`--color-warning-fg`/`--color-muted` tokens
 * `styles.css`'s `.comment-thread-card__severity` rules use (J3 Phase A: Critical/High red, Medium
 * amber, Low gray — Low and any unrecognized letter fall through to the base muted rule, unclaimed
 * for the identical reason documented there). CSS custom properties cross the stylesheet boundary
 * freely (they cascade from `:root` regardless of which sheet references them), so this
 * `baseTheme` — colocated with its own decoration module, matching `commentHighlightTheme`'s and
 * `structuralTheme`'s precedent — can share the app's palette tokens without duplicating their
 * values. Final colour feel is a CJ hands-on check like every other palette in this file; jsdom
 * applies no stylesheet, so this rule itself is inherently unexecutable in tests by nature (the
 * same caveat `NI-a11y-severity`'s notes already record for the timeline-dot half). */
const severityMarginTheme = EditorView.baseTheme({
  ".cm-severityGutter": {
    width: "2.2em",
  },
  ".cm-severityMark": {
    display: "inline-block",
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--color-muted)",
  },
  '.cm-severityMark[data-severity="C"], .cm-severityMark[data-severity="H"]': {
    color: "var(--color-danger-fg)",
  },
  '.cm-severityMark[data-severity="M"]': {
    color: "var(--color-warning-fg)",
  },
});

/**
 * The severity margin-mark extension bundle `editor/` wires into a document's state, alongside
 * `commentHighlightExtensions()` (whose `commentAnchorsField`/`severityByThreadField` this layer
 * reads — installing this bundle without that one leaves the gutter permanently empty, since
 * `commentAnchors`/`severityOf` both return their "field isn't installed" fallback).
 */
export function severityMarginMarks(): Extension[] {
  return [severityMarginGutter, severityMarginTheme];
}
