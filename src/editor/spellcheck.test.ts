// @vitest-environment jsdom
// ABOUTME: Tests for webview-native spellcheck over CM6 content (FR-ED-3, D13, tech-design §3.1),
// ABOUTME: suppressed inside CriticMarkup delimiters and YAML frontmatter. Pins the ambiguous
// ABOUTME: boundary explicitly: a change's *content* stays spellchecked, only the markup
// ABOUTME: scaffolding is suppressed — and that suppression follows edits and is viewport-scoped.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpellcheckSuppression,
  spellcheckExtensions,
  spellcheckSuppressionPlugin,
} from "./spellcheck";
import { redlineExtensions, seedTrackedChanges, type ParsedChange } from "./trackedChanges";
import { viewModeField } from "./viewMode";
import { rangeOf } from "./testRanges";

// Fixture builders mirroring `commands::changes::parse_changes`'s snapshot shape (the canonical
// `textops::critic` coordinates, TD-13) — the same shape `trackedChanges.test.ts` seeds with, so
// this suite never re-derives change geometry from a frontend regex.
function ins(doc: string, id: string, inner: string, occ = 0): ParsedChange {
  const full = rangeOf(doc, `{++${inner}++}`, occ);
  return { id, recorded: false, group: null, full, kind: "insertion", text: { from: full.from + 3, to: full.to - 3 } };
}
function del(doc: string, id: string, inner: string, occ = 0): ParsedChange {
  const full = rangeOf(doc, `{--${inner}--}`, occ);
  return { id, recorded: false, group: null, full, kind: "deletion", text: { from: full.from + 3, to: full.to - 3 } };
}
function sub(doc: string, id: string, oldText: string, newText: string, occ = 0): ParsedChange {
  const full = rangeOf(doc, `{~~${oldText}~>${newText}~~}`, occ);
  return {
    id,
    recorded: false,
    group: null,
    full,
    kind: "substitution",
    old: { from: full.from + 3, to: full.from + 3 + oldText.length },
    new: { from: full.to - 3 - newText.length, to: full.to - 3 },
  };
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

/** A mounted view carrying the full editor extension stack this feature rides on (redline supplies
 * the live change set the suppression reads; `viewModeField` rides alongside as `EditorShell` wires
 * it), seeded with `changes`. Mounted rather than headless because the suppression layer is a
 * viewport-scoped `ViewPlugin` — `view.visibleRanges` doesn't exist on a bare `EditorState`. */
function viewWith(doc: string, changes: ParsedChange[] = []): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [...redlineExtensions(), ...spellcheckExtensions(), viewModeField],
    }),
    parent: document.body,
  });
  if (changes.length) view.dispatch({ effects: seedTrackedChanges.of({ changes }) });
  views.push(view);
  return view;
}

/** The suppressed offset spans the *pure* whole-document builder reports for `state` — the
 * correctness view, independent of what happens to be on screen. */
function suppressed(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  buildSpellcheckSuppression(state).between(0, state.doc.length, (from, to) => {
    out.push({ from, to });
  });
  return out;
}

/** The exact document text of every suppressed span — what a reader would see excluded from the
 * webview's spellchecker. */
function suppressedText(state: EditorState): string[] {
  return suppressed(state).map(({ from, to }) => state.doc.sliceString(from, to));
}

/** Whether `[from, to)` is fully inside some suppressed span. */
function isSuppressed(state: EditorState, span: { from: number; to: number }): boolean {
  return suppressed(state).some((s) => s.from <= span.from && s.to >= span.to);
}

describe("editor/spellcheck — spellcheck is on over ordinary prose (FR-ED-3, §3.1)", () => {
  it("marks the CM6 content editable as spellchecked so the webview's native checker runs over it", () => {
    const view = viewWith("Ordinary prose the checker should see.\n");

    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });

  it("renders the suppressed ranges as real spellcheck-false elements in the content DOM", () => {
    // The end-to-end mechanism check: a decoration set alone proves nothing about what the
    // *webview's* checker sees. What suppresses it is the rendered `spellcheck="false"` attribute
    // on the element wrapping exactly the markup scaffolding — assert the DOM, not just the model.
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);

    const excluded = [...view.contentDOM.querySelectorAll('[spellcheck="false"]')].map(
      (el) => el.textContent,
    );
    expect(excluded).toEqual(["{++", "++}"]);
  });

  it("suppresses nothing in a plain document with no markup and no frontmatter", () => {
    const view = viewWith("Just prose. Nothing to suppress here.\n");

    expect(suppressed(view.state)).toEqual([]);
  });

  it("does not vendor a dictionary — suppression is the only thing this layer decides", () => {
    // The mechanism §3.1 names is *webview-native*: this module never inspects a word, only ranges.
    const view = viewWith("Teh speling here is wrong but this layer never judges it.\n");

    expect(suppressed(view.state)).toEqual([]);
  });
});

describe("editor/spellcheck — suppressed inside CriticMarkup delimiters (TD-13 coordinates)", () => {
  it("suppresses an insertion's opening and closing delimiters", () => {
    const doc = "Before {++added words++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added words")]);

    expect(suppressedText(view.state)).toEqual(["{++", "++}"]);
  });

  it("suppresses a deletion's opening and closing delimiters", () => {
    const doc = "Before {--removed words--} after.\n";
    const view = viewWith(doc, [del(doc, "0", "removed words")]);

    expect(suppressedText(view.state)).toEqual(["{--", "--}"]);
  });

  it("suppresses a substitution's arrow separator alongside its braces", () => {
    const doc = "Before {~~old text~>new text~~} after.\n";
    const view = viewWith(doc, [sub(doc, "0", "old text", "new text")]);

    expect(suppressedText(view.state)).toEqual(["{~~", "~>", "~~}"]);
  });

  it("suppresses the delimiters of every change in a document holding several", () => {
    const doc = "One {++alpha++} two {--beta--} three.\n";
    const view = viewWith(doc, [ins(doc, "0", "alpha"), del(doc, "1", "beta")]);

    expect(suppressedText(view.state)).toEqual(["{++", "++}", "{--", "--}"]);
  });

  it("leaves the surrounding prose unsuppressed — only the scaffolding is excluded", () => {
    const doc = "Before {++added words++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added words")]);

    expect(isSuppressed(view.state, rangeOf(doc, "Before"))).toBe(false);
    expect(isSuppressed(view.state, rangeOf(doc, "after."))).toBe(false);
  });
});

describe("editor/spellcheck — a change's CONTENT is still spellchecked (the ambiguous boundary)", () => {
  // This is the case the card calls out explicitly: an insertion's inserted prose is real prose the
  // user will accept into the document, so it must keep getting checked. Only the markup
  // scaffolding around it is suppressed.
  it("keeps an insertion's inserted prose spellchecked — it is text the user will accept", () => {
    const doc = "Before {++added words++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added words")]);

    expect(isSuppressed(view.state, rangeOf(doc, "added words"))).toBe(false);
  });

  it("keeps a deletion's removed prose spellchecked — it is still document text until rejected", () => {
    const doc = "Before {--removed words--} after.\n";
    const view = viewWith(doc, [del(doc, "0", "removed words")]);

    expect(isSuppressed(view.state, rangeOf(doc, "removed words"))).toBe(false);
  });

  it("keeps both sides of a substitution spellchecked while suppressing the arrow between them", () => {
    const doc = "Before {~~old text~>new text~~} after.\n";
    const view = viewWith(doc, [sub(doc, "0", "old text", "new text")]);

    expect(isSuppressed(view.state, rangeOf(doc, "old text"))).toBe(false);
    expect(isSuppressed(view.state, rangeOf(doc, "new text"))).toBe(false);
    expect(isSuppressed(view.state, rangeOf(doc, "~>"))).toBe(true);
  });
});

describe("editor/spellcheck — suppressed inside YAML frontmatter (§3.3 opaque block)", () => {
  const doc = "---\ntitel: Draft\nauthr: CJ\n---\n\nOrdinary prose here.\n";

  it("suppresses the whole frontmatter block so its keys are never flagged as misspellings", () => {
    const view = viewWith(doc);

    expect(isSuppressed(view.state, rangeOf(doc, "titel"))).toBe(true);
    expect(isSuppressed(view.state, rangeOf(doc, "authr"))).toBe(true);
  });

  it("still spellchecks the prose body below the closing frontmatter delimiter", () => {
    const view = viewWith(doc);

    expect(isSuppressed(view.state, rangeOf(doc, "Ordinary prose here."))).toBe(false);
  });

  it("treats a document whose first line is not a fence as having no frontmatter", () => {
    // Mirrors `textops::critic`'s exclusion rule exactly: only a *first* line of exactly `---`
    // opens frontmatter — a horizontal rule further down does not.
    const view = viewWith("Prose first.\n\n---\nnot: frontmatter\n---\n");

    expect(suppressed(view.state)).toEqual([]);
  });

  it("suppresses a frontmatter block closed by the alternate ... delimiter", () => {
    const alt = "---\ntitel: Draft\n...\n\nProse.\n";
    const view = viewWith(alt);

    expect(isSuppressed(view.state, rangeOf(alt, "titel"))).toBe(true);
    expect(isSuppressed(view.state, rangeOf(alt, "Prose."))).toBe(false);
  });

  it("suppresses frontmatter and CriticMarkup delimiters together in one document", () => {
    const both = "---\ntitel: Draft\n---\n\nBody {++added++} text.\n";
    const view = viewWith(both, [ins(both, "0", "added")]);

    expect(isSuppressed(view.state, rangeOf(both, "titel"))).toBe(true);
    expect(isSuppressed(view.state, rangeOf(both, "{++"))).toBe(true);
    expect(isSuppressed(view.state, rangeOf(both, "added"))).toBe(false);
  });
});

describe("editor/spellcheck — suppression follows edits (a moved region takes it with it)", () => {
  it("shifts a change's suppressed delimiters when text is inserted before it", () => {
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);
    const opener = rangeOf(doc, "{++");

    view.dispatch({ changes: { from: 0, insert: "New. " } });

    expect(suppressedText(view.state)).toEqual(["{++", "++}"]);
    expect(suppressed(view.state)[0].from).toBe(opener.from + "New. ".length);
  });

  it("keeps suppressing the delimiters after the user edits inside the pending change", () => {
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);

    view.dispatch({ changes: { from: doc.indexOf("added") + "added".length, insert: " more" } });

    expect(suppressedText(view.state)).toEqual(["{++", "++}"]);
    expect(isSuppressed(view.state, rangeOf(view.state.doc.toString(), "added more"))).toBe(false);
  });

  it("shifts frontmatter suppression when a line is added inside the block", () => {
    const doc = "---\ntitel: Draft\n---\n\nProse.\n";
    const view = viewWith(doc);

    view.dispatch({ changes: { from: doc.indexOf("---\n\nProse"), insert: "authr: CJ\n" } });

    const text = view.state.doc.toString();
    expect(isSuppressed(view.state, rangeOf(text, "authr"))).toBe(true);
    expect(isSuppressed(view.state, rangeOf(text, "Prose."))).toBe(false);
  });
});

describe("editor/spellcheck — viewport-scoped provider (reuses the #216 pattern)", () => {
  function pluginValue(view: EditorView) {
    const value = view.plugin(spellcheckSuppressionPlugin);
    if (!value) throw new Error("spellcheckSuppressionPlugin not installed");
    return value;
  }

  it("does not rebuild the suppression set on a cursor move that changes nothing it reads", () => {
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);
    const before = pluginValue(view).suppressed;

    view.dispatch({ selection: { anchor: 2 } });

    expect(pluginValue(view).suppressed).toBe(before); // same instance — rebuild skipped
  });

  it("rebuilds the suppression set when a document edit moves the regions", () => {
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);
    const before = pluginValue(view).suppressed;

    view.dispatch({ changes: { from: 0, insert: "New. " } });

    expect(pluginValue(view).suppressed).not.toBe(before);
  });

  it("rebuilds the suppression set when a fresh parse seeds new changes", () => {
    const doc = "Before {++added++} after.\n";
    const view = viewWith(doc);
    const before = pluginValue(view).suppressed;

    view.dispatch({ effects: seedTrackedChanges.of({ changes: [ins(doc, "0", "added")] }) });

    expect(pluginValue(view).suppressed).not.toBe(before);
  });
});

describe("editor/spellcheck — never mutates the document (TD-2/P1)", () => {
  it("leaves the document byte-identical through mount seeding and suppression rebuilds", () => {
    const doc = "---\ntitel: Draft\n---\n\nBody {++added++} text.\n";
    const view = viewWith(doc, [ins(doc, "0", "added")]);

    view.dispatch({ selection: { anchor: 1 } });

    expect(view.state.doc.toString()).toBe(doc);
  });
});
