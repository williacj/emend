// ABOUTME: Webview-native spellcheck over CM6 content (FR-ED-3, D13, tech-design §3.1), suppressed
// ABOUTME: inside CriticMarkup delimiters and YAML frontmatter. Region sources are the canonical
// ABOUTME: ones — `textops::critic`'s parse via `trackedChangesField` and the shared frontmatter
// ABOUTME: rule — never a frontend regex. Pure projection: never mutates the document (TD-2/P1).
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { frontmatterEndFromState } from "./structuralDecorations";
import {
  type ChangeSpan,
  delimiterSpans,
  redlineChromeEffectsChanged,
  trackedChanges,
} from "./trackedChanges";

/**
 * The suppression primitive. There is no CM6-native "don't spellcheck this range" API — the
 * spellchecker is the *webview's*, running over the `contenteditable` DOM, so the only lever is the
 * standard HTML `spellcheck` attribute, and the only way to put it on a sub-range of the document
 * is a mark decoration (CM6 renders one as a `<span>` wrapping exactly that range, attributes and
 * all).
 *
 * The "on globally, off per range" shape below depends on one behaviour: that a webview honours
 * `spellcheck="false"` on an element *nested inside* a `spellcheck="true"` editing host, resolving
 * the attribute per-node rather than once at the editing host. **This is inferred from documented
 * semantics, not executed.** The HTML Living Standard defines `spellcheck` as inherited with the
 * nearest ancestor's explicit value winning, and Blink resolves it by walking up from the position
 * rather than off the editing host — but no test in this repo can execute it: the vitest suite is
 * jsdom, which ships no spellchecker, and spelling markers are painted by the compositor and are
 * not observable from JS or CDP, so Playwright cannot close the gap either. What *is* executed is
 * that CM6 emits the attribute on a real span (see the DOM test in `spellcheck.test.ts`).
 *
 * If this inference is wrong on some engine, the failure is silent and total: every suppression
 * span here is inert, the model-level tests stay green, and `authr:` gets squiggled anyway.
 * Confirming it needs a human eye on a real webview with a working spellchecker — deliberate
 * misspellings inside frontmatter and inside a `{++…++}` delimiter, then look. That was attempted
 * for #361 and could not be done: the dev machine has no spellchecker at all (Windows'
 * spellcheck COM class is unregistered and no Hunspell dictionary is present), so the negative
 * control did not squiggle either and no conclusion was available. See `docs/journal.md`.
 * When someone does confirm it, replace this with "observed on <platform/version>".
 */
const NO_SPELLCHECK = Decoration.mark({ attributes: { spellcheck: "false" } });

/**
 * Turns the webview's own spellchecker on over the editable content (§3.1: "spellcheck =
 * webview-native over CM6 content" — we deliberately do not vendor a dictionary or run any
 * word-level analysis ourselves; this layer only ever decides *ranges*). Set explicitly rather than
 * relying on the browser default so the behaviour is pinned regardless of host/webview defaults.
 */
const spellcheckContentAttributes = EditorView.contentAttributes.of({ spellcheck: "true" });

/**
 * Every span whose text must be excluded from the spellchecker.
 *
 * Two sources, both canonical — this module derives no geometry of its own:
 *   - **YAML frontmatter** via the shared `frontmatterEnd` rule (§3.3: frontmatter is an opaque
 *     block; its keys are identifiers, not prose, and flagging `authr:` as a misspelling is noise).
 *   - **CriticMarkup delimiters** via `delimiterSpans` over the live tracked-change set, which is
 *     `textops::critic`'s parse (TD-13, the coordinate authority) mapped forward through edits by
 *     stable identity. Suppression therefore *follows* edits for free: a region that moves takes
 *     its suppression with it, because the spans are re-read from the already-mapped live set
 *     rather than re-derived from the text.
 *
 * Deliberately *not* suppressed: the inner `underline`/`strike` segments of a change. An
 * insertion's inserted prose is real prose the user is about to accept into the document, so it is
 * exactly what should be checked; only the `{++`/`--}`/`~>` scaffolding around it is suppressed.
 * That boundary falls out of `delimiterSpans` being the complement of the inner segments.
 *
 * View-mode independent by design: this is not a visual decoration but an accessibility/quality
 * attribute on text that is present either way. In source view the raw markers are *more* visible
 * than usual, so suppressing them there matters more, not less.
 */
function suppressedSpans(state: EditorState): ChangeSpan[] {
  const spans: ChangeSpan[] = [];
  const fmEnd = frontmatterEndFromState(state);
  if (fmEnd > 0) spans.push({ from: 0, to: fmEnd });
  for (const change of trackedChanges(state)) spans.push(...delimiterSpans(change));
  return spans;
}

/**
 * The suppression decorations for `state`, optionally scoped to `ranges` (the live layer passes
 * `view.visibleRanges` — the #216 viewport-scoped provider pattern). Defaults to the whole
 * document, which is what makes the pure-`EditorState` correctness tests meaningful without DOM
 * measurement.
 *
 * Scoping bounds the *output*, not the work: `suppressedSpans` walks every tracked change and then
 * clips, so a rebuild is O(total changes), unlike `structuralDecorations`, which genuinely skips
 * offscreen work via `tree.iterate`'s from/to subtree pruning. The per-change cost is two
 * comparisons and change sets are bounded in practice, so this is stated for accuracy rather than
 * as a known problem — if change counts ever grow large, sorting spans and binary-searching to the
 * first visible one is the fix.
 *
 * Each span is clipped to the scope it overlaps: a frontmatter block or a change straddling the
 * viewport edge still suppresses its visible part, and an empty result after clipping is dropped
 * (CM6 rejects a zero-length mark).
 */
export function buildSpellcheckSuppression(
  state: EditorState,
  ranges?: readonly ChangeSpan[],
): DecorationSet {
  const scopes: readonly ChangeSpan[] =
    ranges && ranges.length > 0 ? ranges : [{ from: 0, to: state.doc.length }];
  const decorations: Range<Decoration>[] = [];
  for (const span of suppressedSpans(state)) {
    for (const scope of scopes) {
      const from = Math.max(span.from, scope.from);
      const to = Math.min(span.to, scope.to);
      if (to > from) decorations.push(NO_SPELLCHECK.range(from, to));
    }
  }
  // `Decoration.set`'s own `sort` flag does the ordering CM6 requires — no hand-rolled sort pass
  // here (the same thing `structuralDecorations`'s builders rely on).
  return Decoration.set(decorations, true);
}

/**
 * Whether `update` could have changed what `buildSpellcheckSuppression` returns: a doc edit (moves
 * both region kinds), a viewport move (scroll/resize — this is a viewport-scoped provider), or a
 * seed/drop of tracked changes (a fresh backend parse or an accept/reject).
 *
 * Notably *absent*, unlike the structural layer's equivalent: the active line. Suppression does not
 * depend on reveal-at-cursor — a delimiter is excluded from the spellchecker whether it is
 * currently collapsed or revealed — so the common caret-move keystroke path skips the rebuild
 * entirely. This layer therefore costs nothing beyond the decoration work already being done.
 */
function suppressionInputsChanged(update: ViewUpdate): boolean {
  if (update.docChanged || update.viewportChanged) return true;
  return update.transactions.some((tr) => redlineChromeEffectsChanged(tr));
}

/**
 * The live suppression layer: a `ViewPlugin` (not a `StateField`) so it can read
 * `view.visibleRanges` and scope the build to what is rendered — the #216 pattern
 * `structuralDecorations.ts` established, for the same reason (a `StateField` only ever sees
 * `EditorState`, which has no notion of what is on screen, forcing an O(doc) pass per rebuild).
 */
class SpellcheckSuppressionPluginValue {
  suppressed: DecorationSet;

  constructor(view: EditorView) {
    this.suppressed = buildSpellcheckSuppression(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate) {
    if (!suppressionInputsChanged(update)) return;
    this.suppressed = buildSpellcheckSuppression(update.state, update.view.visibleRanges);
  }
}

export const spellcheckSuppressionPlugin = ViewPlugin.fromClass(SpellcheckSuppressionPluginValue, {
  decorations: (plugin) => plugin.suppressed,
});

/**
 * The spellcheck extension bundle `editor/` wires into a document's state (FR-ED-3): the webview's
 * native checker turned on over the whole content, minus the CriticMarkup-delimiter and
 * frontmatter ranges the suppression plugin excludes.
 *
 * Installed *alongside* `redlineExtensions()`, whose `trackedChangesField` supplies the change
 * geometry. Extension order is not load-bearing — CM6 resolves state fields across the whole
 * configuration regardless of where each extension sits — and it degrades gracefully if that field
 * is absent entirely (`trackedChanges` returns `[]`), suppressing frontmatter only, so a bare
 * editor state without the redline layer still works.
 */
export function spellcheckExtensions(): Extension[] {
  return [spellcheckContentAttributes, spellcheckSuppressionPlugin];
}
