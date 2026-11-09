// ABOUTME: Structural markdown decorations (TD-13/TD-2/§3.3) — headings, emphasis, lists,
// ABOUTME: blockquotes as CM6 range decorations over a `@lezer/markdown` (GFM) parse, plus the
// ABOUTME: collapsed/expandable frontmatter projection and P2a-4 reveal-at-cursor polish. Every
// ABOUTME: view operation is effect/decorations only and never mutates the source document (P1).
import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Facet,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { isMac } from "./keymap";
import { headingHighlightStyle, markdownLanguage } from "./markdownLanguage";
import {
  decorationsEnabled,
  displayModeAllowsMarkupReveal,
  viewModeChanged,
} from "./viewMode";

/**
 * Hides markup characters (`#`, `**`, `-`/`1.`, `>`) via a `Decoration.mark` whose CSS collapses it
 * to zero width (rather than a `Decoration.replace`, which removes the text node outright) — the
 * same element persists across the hidden↔revealed toggle so `structuralTheme`'s `max-width`/
 * `opacity` transition actually has something to animate (SPIKE-3 residual: "reveal-pop reflow",
 * the entering/leaving-a-decorated-line jump). `aria-hidden` keeps the collapsed markup out of the
 * accessibility tree the way a true `replace` would have. `REVEALED` marks the identical range when
 * the cursor is on it, expanding it back to natural width. Cursor traversal atomicity over the
 * hidden span (arrow keys must not step through its interior) is a separate concern, handled by
 * `structuralDecorationsPlugin`'s `atomic` set / `EditorView.atomicRanges` below — CSS alone doesn't
 * affect it.
 */
const HIDDEN = Decoration.mark({ class: "cm-markupHidden", attributes: { "aria-hidden": "true" } });
const REVEALED = Decoration.mark({ class: "cm-markupRevealed" });
const EMPHASIS = Decoration.mark({ class: "cm-emphasis" });
const STRONG = Decoration.mark({ class: "cm-strong" });

/**
 * TD-26's app-global reveal preference. Display mode is an independent projection input: this
 * field records only what the user chose, while `displayModeAllowsMarkupReveal` decides whether
 * that choice is currently effective. Defaults off per #2389.
 */
export const setRevealAtCursorEnabled = StateEffect.define<boolean>();

/** Holds the current suppression state `buildStructural` (and everything built on it) reads. */
export const revealAtCursorEnabledField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRevealAtCursorEnabled)) value = effect.value;
    }
    return value;
  },
});

/**
 * YAML frontmatter's byte range, mirrored from `textops::critic`'s exclusion rule (only when the
 * very first line is exactly `---`, closed by a later line that is exactly `---` or `...`) so the
 * two parsers agree on where frontmatter starts and ends. Returns the offset just past the closing
 * delimiter's line, or `0` if the document has no frontmatter (§3.3: frontmatter is folded/opaque
 * and never decorated by this layer).
 *
 * Exported as the single home of that rule: `spellcheck.ts` suppresses the webview's native
 * spellchecker over exactly this range, and a second copy of the "where does frontmatter end"
 * predicate is precisely the drift risk CLAUDE.md's no-copy-paste rule exists to prevent.
 */
type FrontmatterRange =
  | { kind: "none"; end: 0 }
  | { kind: "unclosed"; end: 0 }
  | { kind: "closed"; end: number };

const NO_FRONTMATTER: FrontmatterRange = { kind: "none", end: 0 };
const UNCLOSED_FRONTMATTER: FrontmatterRange = { kind: "unclosed", end: 0 };

function detectFrontmatter(doc: EditorState["doc"]): FrontmatterRange {
  if (doc.lines < 1) return NO_FRONTMATTER;
  const first = doc.line(1);
  if (first.text !== "---") return NO_FRONTMATTER;
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text === "---" || line.text === "...") {
      return { kind: "closed", end: Math.min(line.to + 1, doc.length) };
    }
  }
  return UNCLOSED_FRONTMATTER;
}

export function frontmatterEnd(doc: EditorState["doc"]): number {
  return detectFrontmatter(doc).end;
}

/**
 * Finds a newly-created closing delimiter near the changed text of a document that was previously
 * known to have an unclosed opener. Since no closing delimiter existed before the transaction, an
 * unchanged line cannot become one; inspecting the changed lines and their join boundaries keeps
 * ordinary body typing O(changed lines), even when malformed frontmatter extends to EOF.
 */
function closerIntroducedBy(tr: Transaction): FrontmatterRange {
  let earliestEnd: number | null = null;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const startLine = tr.newDoc.lineAt(Math.max(0, fromB - 1)).number;
    const endLine = tr.newDoc.lineAt(Math.min(tr.newDoc.length, toB + 1)).number;
    for (let number = Math.max(2, startLine); number <= endLine; number++) {
      const line = tr.newDoc.line(number);
      if (line.text !== "---" && line.text !== "...") continue;
      const end = Math.min(line.to + 1, tr.newDoc.length);
      if (earliestEnd === null || end < earliestEnd) earliestEnd = end;
    }
  });
  return earliestEnd === null ? UNCLOSED_FRONTMATTER : { kind: "closed", end: earliestEnd };
}

/** One initial scan, then incremental maintenance at the actual state-update load-bearing path. */
const frontmatterRangeField = StateField.define<FrontmatterRange>({
  create: (state) => detectFrontmatter(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (tr.newDoc.line(1).text !== "---") return NO_FRONTMATTER;

    if (value.kind === "unclosed") return closerIntroducedBy(tr);
    if (value.kind === "none") return detectFrontmatter(tr.newDoc);

    let touchesFrontmatter = false;
    tr.changes.iterChangedRanges((fromA) => {
      if (fromA < value.end) touchesFrontmatter = true;
    });
    return touchesFrontmatter ? detectFrontmatter(tr.newDoc) : value;
  },
});

/** Cached in the production extension bundle; falls back to the canonical rule for isolated users. */
export function frontmatterEndFromState(state: EditorState): number {
  return state.field(frontmatterRangeField, false)?.end ?? frontmatterEnd(state.doc);
}

export type StructuralEditorPlatform = "win" | "mac";

const structuralEditorPlatform = Facet.define<StructuralEditorPlatform, StructuralEditorPlatform>({
  combine: (values) => values[0] ?? (isMac ? "mac" : "win"),
});

/** Expand/collapse is view state only (TD-2/P1): the effect never carries a document change. */
export const setFrontmatterExpanded = StateEffect.define<boolean>();

/** Whether rich view currently shows the raw YAML block instead of its compact metadata row. */
export const frontmatterExpandedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFrontmatterExpanded)) value = effect.value;
    }
    return value;
  },
});

/** The one DOM affordance used in both fold states. Collapse may move selection, but never the doc. */
class FrontmatterFoldWidget extends WidgetType {
  constructor(
    readonly expanded: boolean,
    readonly platform: StructuralEditorPlatform,
  ) {
    super();
  }

  eq(other: FrontmatterFoldWidget): boolean {
    return other.expanded === this.expanded && other.platform === this.platform;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-frontmatterFold";
    button.dataset.platform = this.platform;
    button.setAttribute("aria-expanded", String(this.expanded));
    button.setAttribute(
      "aria-label",
      this.expanded ? "Collapse document metadata" : "Expand document metadata",
    );

    const disclosure = document.createElement("span");
    disclosure.className = "cm-frontmatterFold-disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    button.append(disclosure, document.createTextNode("Metadata"));

    // The button owns this pointer action; collapse below relocates a selection the fold would hide.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const expanding = !this.expanded;
      if (expanding) {
        view.dispatch({ effects: setFrontmatterExpanded.of(true) });
        return;
      }

      const end = frontmatterEndFromState(view.state);
      let selectionChanged = false;
      const ranges = view.state.selection.ranges.map((range) => {
        const hidden = range.empty
          ? range.head > 0 && range.head < end
          : range.from < end && range.to > 0;
        if (!hidden) return range;
        selectionChanged = true;
        return EditorSelection.cursor(end);
      });
      view.dispatch({
        effects: setFrontmatterExpanded.of(false),
        selection: selectionChanged
          ? EditorSelection.create(ranges, view.state.selection.mainIndex)
          : view.state.selection,
      });
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface FrontmatterFoldDecorationState {
  view: DecorationSet;
  atomic: DecorationSet;
}

/** Builds the rich-view projection from the shared `frontmatterEnd` range rule above. */
function computeFrontmatterFoldState(state: EditorState): FrontmatterFoldDecorationState {
  const end = frontmatterEndFromState(state);
  if (end === 0 || !decorationsEnabled(state)) {
    return { view: Decoration.none, atomic: Decoration.none };
  }

  const expanded = state.field(frontmatterExpandedField);
  const widget = new FrontmatterFoldWidget(expanded, state.facet(structuralEditorPlatform));
  if (expanded) {
    return {
      view: Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(0)]),
      atomic: Decoration.none,
    };
  }

  const folded = Decoration.set([Decoration.replace({ widget, block: true }).range(0, end)]);
  return { view: folded, atomic: folded };
}

function frontmatterFoldInputsChanged(tr: Transaction): boolean {
  return (
    tr.docChanged ||
    viewModeChanged(tr) ||
    tr.effects.some((effect) => effect.is(setFrontmatterExpanded))
  );
}

/** A state-backed decoration source because CM6 requires block replacements to come directly from
 * state, never from a view plugin. The fold is document-wide and needs no viewport measurement. */
const frontmatterFoldDecorationsField = StateField.define<FrontmatterFoldDecorationState>({
  create: computeFrontmatterFoldState,
  update(value, tr) {
    return frontmatterFoldInputsChanged(tr) ? computeFrontmatterFoldState(tr.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.view),
});

/** A collapsed opaque block cannot receive text changes until the user expands it (TD-2 §3.4). */
const protectCollapsedFrontmatter = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true;
  if (!decorationsEnabled(tr.startState) || tr.startState.field(frontmatterExpandedField)) return true;
  if (
    !tr.isUserEvent("input") &&
    !tr.isUserEvent("delete") &&
    !tr.isUserEvent("undo") &&
    !tr.isUserEvent("redo")
  ) {
    return true;
  }

  const end = frontmatterEndFromState(tr.startState);
  if (end === 0) return true;

  let touchesInterior = false;
  tr.changes.iterChangedRanges((from, to) => {
    if (from === to) {
      if (from > 0 && from < end) touchesInterior = true;
      return;
    }
    if (from < end && to > 0) touchesInterior = true;
  });
  return !touchesInterior;
});

/** The line number the caret sits on — the one piece of selection state the active-line markup
 * reveal depends on, shared between `buildStructural` and `structuralInputsChanged`'s rebuild
 * short-circuit below so both read it the same way. */
function activeLineNumber(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number;
}

/** The two decoration sets one syntax-tree walk produces, kept as sibling arrays rather than two
 * separate walks (CLAUDE.md: no duplicated traversal logic) — `all` is everything the view renders;
 * `hidden` is the strict subset of `all` that is actually collapsed (the `HIDDEN`-class ranges),
 * which is exactly what `EditorView.atomicRanges` must treat as one cursor-motion unit (SPIKE-3
 * residual: arrow-key/click traversal must never land inside a hidden marker's interior). */
interface StructuralDecorationRanges {
  all: Range<Decoration>[];
  hidden: Range<Decoration>[];
}

/** A half-open offset range — the shape both `EditorView.viewport`/`.visibleRanges` and this
 * module's own scoping use, kept structural (no CM6 import needed) so `buildStructural` stays
 * callable from plain-`EditorState` tests that never construct a real view. */
interface OffsetRange {
  from: number;
  to: number;
}

/**
 * Walks `state`'s `@lezer/markdown` parse (TD-13) once and collects both decoration sets above — a
 * pure function of the document string and its parse: it only ever *reads* `state`, never dispatches
 * a transaction, so it cannot drift the doc (P1). Frontmatter (per the byte range above) is never
 * descended into or decorated (§3.3 carried rule). Heading classes ride the separate
 * `syntaxHighlighting(headingHighlightStyle)` extension (SPIKE-3 production note); `structuralTheme`
 * below styles those classes only in rich view. This walk hides heading markers and handles
 * emphasis/list/blockquote markup and styling.
 *
 * `ranges` scopes the syntax-tree walk to the given offset spans (TD-13/SPIKE-3: the live decoration
 * layer passes `view.visibleRanges` so build cost is bounded by what's on screen, not by document
 * size). Defaults to the whole document — every caller that only has an `EditorState` (no mounted
 * `EditorView`, e.g. `buildStructuralDecorations`/`buildAtomicMarkupRanges` and the state-level tests
 * built on them) keeps walking the full tree, which is exactly what makes those pure-`EditorState`
 * correctness checks meaningful without needing DOM measurement to pick a viewport. `tree.iterate`'s
 * own `{from, to}` skips only subtrees that don't overlap a scope; an ancestor node straddling a
 * scope boundary (e.g. a blockquote opened above the viewport) still gets its `enter`/`leave` called,
 * so `blockquoteDepth` stays correct per scope.
 */
function buildStructural(state: EditorState, ranges?: readonly OffsetRange[]): StructuralDecorationRanges {
  // Source view (P2a-8, §3.3 "Source view = decorations off"): raw markdown shown verbatim, no
  // marker hiding/reveal, no emphasis/strong styling, no blockquote lines — a pure early return, the
  // doc itself is never touched.
  if (!decorationsEnabled(state)) return { all: [], hidden: [] };
  const { doc } = state;
  const tree = syntaxTree(state);
  const fmEnd = frontmatterEndFromState(state);
  const activeLine = activeLineNumber(state);
  const revealEnabled =
    state.field(revealAtCursorEnabledField) && displayModeAllowsMarkupReveal(state);
  const scopes: readonly OffsetRange[] = ranges && ranges.length > 0 ? ranges : [{ from: 0, to: doc.length }];
  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const blockquoteLineDepth = new Map<number, number>();

  // Reveal is per-line (§3.3 Typora convention) and gated by the suppression hook above — when
  // suppressed, nothing is ever "active" and every construct stays hidden regardless of the cursor.
  const isActiveAt = (pos: number): boolean => revealEnabled && doc.lineAt(pos).number === activeLine;

  // Marks a markup node — the whole run, marker plus (for headings/lists/blockquotes) the single
  // space separating it from the content (Typora convention: "## " disappears as a unit, not just
  // the "##"; emphasis marks like `*`/`**` sit directly against their text, so they take none) — as
  // either revealed (cursor on it) or hidden. Both cases decorate the *same* range with a `mark` (not
  // an add/remove of a `replace` widget) so the hidden↔revealed toggle is a class change on a
  // persisting element — what lets `structuralTheme`'s CSS transition actually animate instead of
  // popping (SPIKE-3's "reveal-pop reflow" residual).
  const hideMark = (node: SyntaxNode, { trailingSpace = false } = {}) => {
    let end = node.to;
    if (trailingSpace) {
      const line = doc.lineAt(node.from);
      const rest = doc.sliceString(node.to, line.to);
      end += rest.length - rest.trimStart().length;
    }
    if (isActiveAt(node.from)) {
      all.push(REVEALED.range(node.from, end));
      return;
    }
    const range = HIDDEN.range(node.from, end);
    all.push(range);
    hidden.push(range);
  };

  for (const { from, to } of scopes) {
    let blockquoteDepth = 0;
    tree.iterate({
      from,
      to,
      enter(node) {
        // Frontmatter is opaque: skip the subtree entirely, no decoration ever originates from it.
        if (node.to <= fmEnd) return false;

        switch (node.name) {
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6": {
            const mark = node.node.getChild("HeaderMark");
            if (mark) hideMark(mark, { trailingSpace: true });
            return;
          }
          case "Emphasis":
            all.push(EMPHASIS.range(node.from, node.to));
            return;
          case "StrongEmphasis":
            all.push(STRONG.range(node.from, node.to));
            return;
          case "EmphasisMark":
            hideMark(node.node);
            return;
          case "ListMark":
            hideMark(node.node, { trailingSpace: true });
            return;
          case "Blockquote":
            blockquoteDepth++;
            return;
          case "QuoteMark": {
            const mark = node.node;
            hideMark(mark, { trailingSpace: true });
            const line = doc.lineAt(mark.from);
            const depth = Math.max(blockquoteLineDepth.get(line.from) ?? 0, blockquoteDepth);
            blockquoteLineDepth.set(line.from, depth);
            return;
          }
          default:
            return;
        }
      },
      leave(node) {
        if (node.name === "Blockquote") blockquoteDepth--;
      },
    });
  }

  for (const [lineFrom, depth] of blockquoteLineDepth) {
    all.push(
      Decoration.line({ class: "cm-blockquoteLine", attributes: { "data-depth": String(depth) } }).range(
        lineFrom,
      ),
    );
  }

  return { all, hidden };
}

/** The decorations the view renders: hidden/revealed markup marks, emphasis/strong styling, and
 * blockquote line decorations, walked over the whole document. See `buildStructural` for the shared
 * (optionally range-scoped) tree walk `structuralDecorationsPlugin` uses for its viewport-scoped
 * build. */
export function buildStructuralDecorations(state: EditorState): DecorationSet {
  return Decoration.set(buildStructural(state).all, true);
}

/**
 * The strict subset of `buildStructuralDecorations`'s output that is actually hidden — the exact
 * ranges `EditorView.atomicRanges` must treat as a single cursor-motion unit (SPIKE-3 residual:
 * arrow-key/click-based cursor movement across a hidden marker must be atomic; a hidden range's
 * *interior* positions must never be a landing spot). Ranges revealed by the active-line cursor are
 * ordinary visible text at that point and are deliberately excluded — there is nothing to skip over.
 */
export function buildAtomicMarkupRanges(state: EditorState): DecorationSet {
  return Decoration.set(buildStructural(state).hidden, true);
}

/** Whether `tr` could have changed the suppression hook's value — the one thing besides doc/active-
 * line/viewport changes that `buildStructural`'s output depends on, so `structuralDecorationsPlugin`'s
 * rebuild short-circuit below must also rebuild when it fires (a facet-only reconfigure carries no
 * doc change and may not move the caret). */
function revealSuppressionChanged(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(setRevealAtCursorEnabled));
}

/** `structuralDecorationsPlugin`'s value: the view-rendered set alongside the atomic-traversal subset
 * (SPIKE-3 residual) — computed together from one `buildStructural` walk so a transaction that needs
 * to rebuild one rebuilds both in the same viewport-scoped pass rather than walking the tree twice. */
interface StructuralDecorationState {
  /** Everything the view renders: hidden/revealed markup marks, emphasis/strong styling, blockquote
   * lines. Fed to `EditorView.decorations` via the plugin's `decorations` option. */
  view: DecorationSet;
  /** The exact hidden-marker ranges `EditorView.atomicRanges` (wired below) must treat as a single
   * cursor-motion unit — arrow-key/click-based movement across one must never land inside it. */
  atomic: DecorationSet;
}

/** Builds `StructuralDecorationState` scoped to `ranges` (defaults to the whole doc — see
 * `buildStructural`) from one shared tree walk. */
function computeStructuralDecorationState(
  state: EditorState,
  ranges?: readonly OffsetRange[],
): StructuralDecorationState {
  const { all, hidden } = buildStructural(state, ranges);
  return { view: Decoration.set(all, true), atomic: Decoration.set(hidden, true) };
}

/**
 * Whether `update` could have changed `buildStructural`'s output for `structuralDecorationsPlugin`:
 * a doc edit, a viewport move (scroll/resize — TD-13/SPIKE-3, the reason this is a `ViewPlugin` and
 * not the `StateField` #153 shipped), the active line changing, the reveal-suppression/view-mode
 * effects firing, or the syntax tree itself advancing (#391). A transaction that does none of these
 * — e.g. a same-line selection nudge with the viewport unchanged — leaves the previous decoration
 * sets in place, so the common keystroke/cursor path skips the rebuild exactly as the prior
 * `StateField.update` short-circuit did.
 *
 * The `syntaxTree` check (#391) is what makes a completed background parse visible: CM6's
 * `ParseWorker` (`@codemirror/language`) publishes a finished tree via a bare `Language.setState`
 * effect that trips none of the other gates — no doc change, no viewport move, no active-line move,
 * none of this module's own effects. Without it, a document whose initial parse was truncated by
 * `LanguageState.init`'s 20ms wall-clock budget (`Work.Apply`) stayed rendered as raw markup forever,
 * recovering only on the next unrelated edit/scroll/cross-line caret move. `syntaxTree()` returns
 * the tree the language field last *published*, so comparing it identity-wise across a transaction
 * is cheap (a field read, not a re-parse) and only actually differs when that field republishes —
 * rare on the keystroke path, so this does not defeat the SPIKE-3/TD-13 short-circuit that path
 * relies on (measured keystroke p95 <6.2ms) — see `tests/perf/structuralDecorationsViewport.perf.test.ts`.
 */
function structuralInputsChanged(update: ViewUpdate): boolean {
  if (update.docChanged || update.viewportChanged) return true;
  if (activeLineNumber(update.startState) !== activeLineNumber(update.state)) return true;
  if (syntaxTree(update.startState) !== syntaxTree(update.state)) return true;
  return update.transactions.some((tr) => revealSuppressionChanged(tr) || viewModeChanged(tr));
}

/**
 * The live decoration layer: a `ViewPlugin`, not a `StateField` (migrated from #153's `StateField` —
 * TD-13/SPIKE-3, #216). A `StateField` only ever sees `EditorState`, which has no notion of "what's
 * currently on screen", so #153's version had to walk the *entire* syntax tree on every rebuild —
 * O(doc) on the keystroke path regardless of document size, inheriting none of SPIKE-3's
 * viewport-scoped guarantee (measured keystroke p95 <6.2ms). A `ViewPlugin` is constructed with (and
 * `update`d alongside) the live `EditorView`, so it can read `view.visibleRanges` and hand
 * `buildStructural` only the on-screen offset spans — rebuild cost is now bounded by what's rendered,
 * not by document length. `structuralInputsChanged` gates the rebuild exactly as the old
 * `StateField.update` short-circuit did, plus the new `viewportChanged` trigger a scroll/resize needs.
 */
class StructuralDecorationsPluginValue {
  view: DecorationSet;
  atomic: DecorationSet;

  constructor(editorView: EditorView) {
    const state = computeStructuralDecorationState(editorView.state, editorView.visibleRanges);
    this.view = state.view;
    this.atomic = state.atomic;
  }

  update(update: ViewUpdate) {
    if (!structuralInputsChanged(update)) return;
    const state = computeStructuralDecorationState(update.state, update.view.visibleRanges);
    this.view = state.view;
    this.atomic = state.atomic;
  }
}

export const structuralDecorationsPlugin = ViewPlugin.fromClass(StructuralDecorationsPluginValue, {
  decorations: (plugin) => plugin.view,
});

/** CSS for structural projection classes — rich-view heading typography, italic/bold text, a
 * quote-style left border whose indent grows with nesting depth, and the hidden↔revealed markup
 * transition (SPIKE-3 "reveal-pop reflow" residual). Heading selectors follow view-mode state from
 * the editor root, so Markdown/source view inherits body typography while keeping every source byte
 * visible. Final reveal-transition feel remains the CJ hands-on check SPIKE-3 flags as a residual
 * headless tests cannot close. */
const structuralTheme = EditorView.baseTheme({
  '&:not([data-cowrite-source-view="true"]) .cm-heading1': {
    fontSize: "1.8em",
    fontWeight: "bold",
  },
  '&:not([data-cowrite-source-view="true"]) .cm-heading2': {
    fontSize: "1.5em",
    fontWeight: "bold",
  },
  '&:not([data-cowrite-source-view="true"]) .cm-heading3': {
    fontSize: "1.3em",
    fontWeight: "bold",
  },
  '&:not([data-cowrite-source-view="true"]) .cm-heading4': {
    fontSize: "1.15em",
    fontWeight: "bold",
  },
  '&:not([data-cowrite-source-view="true"]) .cm-heading5': {
    fontSize: "1.05em",
    fontWeight: "bold",
  },
  '&:not([data-cowrite-source-view="true"]) .cm-heading6': {
    fontSize: "1em",
    fontWeight: "bold",
  },
  ".cm-frontmatterFold": {
    appearance: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    margin: "2px 0 8px",
    padding: "4px 9px",
    backgroundColor: "var(--color-frontmatter-fold-bg)",
    color: "var(--color-frontmatter-fold-fg)",
    font: '500 12px/1.4 "IBM Plex Sans", sans-serif',
    cursor: "pointer",
  },
  '.cm-frontmatterFold[data-platform="win"]': {
    border: "1px solid var(--color-frontmatter-fold-win-border)",
    borderRadius: "6px",
    boxShadow: "none",
  },
  '.cm-frontmatterFold[data-platform="mac"]': {
    border: "none",
    borderRadius: "7px",
    boxShadow: "0 0 0 1px var(--color-frontmatter-fold-mac-border)",
  },
  ".cm-frontmatterFold:hover": { color: "var(--color-frontmatter-fold-hover-fg)" },
  ".cm-frontmatterFold:focus-visible": {
    outline: "2px solid var(--color-frontmatter-fold-accent)",
    outlineOffset: "2px",
  },
  ".cm-frontmatterFold-disclosure": {
    width: "0",
    height: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid currentColor",
    transition: "transform 100ms ease-out",
  },
  '.cm-frontmatterFold[aria-expanded="true"] .cm-frontmatterFold-disclosure': {
    transform: "rotate(90deg)",
  },
  ".cm-emphasis": { fontStyle: "italic" },
  ".cm-strong": { fontWeight: "bold" },
  ".cm-markupHidden, .cm-markupRevealed": {
    display: "inline-block",
    overflow: "hidden",
    verticalAlign: "top",
    transition: "max-width 120ms ease-out, opacity 100ms ease-out",
  },
  ".cm-markupHidden": { maxWidth: "0px", opacity: "0", whiteSpace: "pre" },
  ".cm-markupRevealed": { maxWidth: "12ch", opacity: "1" },
  ".cm-blockquoteLine": {
    borderLeft: "3px solid #a0a0a0",
    paddingLeft: "0.6em",
    color: "#666",
  },
  '.cm-blockquoteLine[data-depth="2"]': { paddingLeft: "1.2em" },
  '.cm-blockquoteLine[data-depth="3"]': { paddingLeft: "1.8em" },
});

/**
 * The exact frontmatter state/filter/decoration sub-bundle. Kept composable so its malformed-file
 * state-update cost can be benchmarked independently of Lezer's own unclosed-block parse cost.
 */
export function frontmatterFoldExtensions(
  platform: StructuralEditorPlatform = isMac ? "mac" : "win",
): Extension[] {
  return [
    frontmatterRangeField,
    structuralEditorPlatform.of(platform),
    frontmatterExpandedField,
    protectCollapsedFrontmatter,
    frontmatterFoldDecorationsField,
    EditorView.atomicRanges.of((view) => view.state.field(frontmatterFoldDecorationsField).atomic),
  ];
}

/**
 * The full structural-markdown extension bundle `editor/` wires into a document's `EditorState`:
 * the `@lezer/markdown` (GFM) language (so `syntaxTree`/`syntaxHighlighting` have something to read),
 * the heading `HighlightStyle`, this module's marker-hiding/emphasis/list/blockquote decorations
 * (the viewport-scoped `structuralDecorationsPlugin`), the reveal-suppression hook's field, the
 * atomic-hidden-marker `EditorView.atomicRanges` wiring (P2a-4/SPIKE-3), and the CSS they rely on.
 * `view.plugin()` can return `undefined` for a state momentarily without a mounted view (e.g. between
 * `EditorState.create` and the first `new EditorView`); `atomicRanges` falls back to `Decoration.none`
 * for that instant rather than throwing.
 */
export function structuralMarkdownExtensions(
  platform: StructuralEditorPlatform = isMac ? "mac" : "win",
): Extension[] {
  return [
    markdownLanguage.extension,
    syntaxHighlighting(headingHighlightStyle),
    revealAtCursorEnabledField,
    ...frontmatterFoldExtensions(platform),
    structuralDecorationsPlugin,
    EditorView.atomicRanges.of((view) => view.plugin(structuralDecorationsPlugin)?.atomic ?? Decoration.none),
    structuralTheme,
  ];
}
