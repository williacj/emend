// @vitest-environment jsdom
// ABOUTME: Decoration-snapshot tests per construct (TD-13/TD-2/P1) plus the invariant this whole
// ABOUTME: card turns on: structural decorations never issue a doc-mutating transaction. P2a-4 adds
// ABOUTME: mounted-EditorView coverage for the frontmatter fold, atomic cursor traversal, and
// ABOUTME: reveal suppression. #216 adds viewport scoping via structuralDecorationsPlugin (not a
// ABOUTME: StateField) rebuild/short-circuit behavior, exercised against a real mounted EditorView.
// ABOUTME: #478 forces that block's mount to a complete parse (`forceParsing`, matching the perf
// ABOUTME: suite's precedent) so its assertions never race CM6's 20ms initial-parse budget.
import { cursorCharLeft, cursorCharRight } from "@codemirror/commands";
import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownLanguage } from "./markdownLanguage";
import {
  buildAtomicMarkupRanges,
  buildStructuralDecorations,
  frontmatterEnd,
  frontmatterExpandedField,
  revealAtCursorEnabledField,
  setFrontmatterExpanded,
  setRevealAtCursorEnabled,
  structuralDecorationsPlugin,
  structuralMarkdownExtensions,
} from "./structuralDecorations";
import { setSourceView, viewModeExtensions, viewModeField } from "./viewMode";
import { rangeOf } from "./testRanges";

const APP_STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

/** A line every fixture ends with, off any construct under test — the neutral cursor parks here so
 * "hidden except on the active line" doesn't accidentally reveal the very thing a test is checking. */
const NEUTRAL_LINE = "\n\nElsewhere.\n";

/** Builds state with the cursor parked on `NEUTRAL_LINE` unless `cursor` overrides it. `viewModeField`
 * rides alongside (as `EditorShell` wires it) so this suite can also exercise the source-view gate. */
function stateFor(doc: string, cursor?: number, reveal = true): EditorState {
  const anchor = cursor ?? doc.indexOf("Elsewhere.");
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [...structuralMarkdownExtensions(), viewModeField],
  });
  return reveal
    ? state.update({ effects: setRevealAtCursorEnabled.of(true) }).state
    : state;
}

interface Snapshot {
  from: number;
  to: number;
  class: string;
}

/**
 * Wall time allowed for completing a parse this suite is about to *read*. The fixtures here parse in
 * well under a millisecond, so this is "finish the tree", not "wait a while" — but it is kept below
 * vitest's 5s `testTimeout` deliberately. A larger budget would let the test timeout fire first and
 * turn a genuinely stuck parse into a generic "test timed out", hiding the named error below.
 */
const PARSE_BUDGET_MS = 2_000;

/**
 * Completes the syntax tree before any assertion reads it.
 *
 * `EditorState.create` does NOT guarantee a complete tree: `@codemirror/language`'s
 * `LanguageState.init` parses under a 20 ms wall-clock budget (`Work.Apply`, measured with
 * `Date.now()`) and, if that expires, `takeTree()`s a *partial* tree — the remainder is finished
 * later by a background scheduler driven by `setTimeout`/`requestIdleCallback`, which a synchronous
 * test never pumps. Under the full parallel run (one vitest worker process per core, all
 * contending) 20 ms of wall clock is genuinely reachable while parsing even these tiny fixtures, so
 * a decoration assertion could read a truncated tree, find no node to decorate and fail — the
 * flake in issue #368.
 *
 * The completeness this buys is **reader-side and test-only**. It does NOT describe the production
 * layer: `structuralInputsChanged` rebuilds only on a doc edit, viewport move, active-line change or
 * reveal/view-mode effect, and CM6's `ParseWorker` publishes a finished tree with a bare
 * `Language.setState` effect (`@codemirror/language`, `ParseWorker.work`'s dispatch) that matches
 * none of those gates — so the mounted plugin does not currently rebuild on parse progress. Probed
 * against the real mounted plugin: a starved initial parse renders 0 decorations, still 0 after the
 * completed tree is published, and recovers to 1 only on the next real edit/scroll/cross-line caret
 * move. That is a pre-existing production defect, tracked as #391 — not something this test helper
 * papers over. It arrived with the decoration layer itself in #153 (PR #215), NOT with #216's
 * `StateField`→`ViewPlugin` migration: the merged #153 `StateField` already short-circuited on
 * `!tr.docChanged && activeLineNumber unchanged` (`5d4a9bf:src/editor/structuralDecorations.ts`),
 * which a bare `Language.setState` effect matches no better than today's gate does. #216 widened the
 * gate set (adding viewport/reveal/view-mode) but never made it see parse progress. Attribution
 * matters here: restoring pre-#216 behavior would not fix #391, it would only relocate it.
 *
 * Throwing (rather than asserting on whatever tree exists) keeps a genuinely incomplete parse a
 * loud, named failure instead of a mystery decoration mismatch — the same discipline
 * `tests/perf/structuralDecorationsViewport.perf.test.ts` already applies at mount with
 * `forceParsing` (that suite drives a mounted `EditorView`, this one bare `EditorState`s, hence the
 * different CM6 entry point).
 */
function ensureParsed(state: EditorState): EditorState {
  if (!ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS)) {
    throw new Error(`syntax tree did not complete within ${PARSE_BUDGET_MS}ms`);
  }
  // `ensureSyntaxTree` advances the language field's parse *context*, but `syntaxTree()` — what the
  // decoration builders actually read — returns the tree that field last *published*, and it only
  // publishes on an applied transaction. An empty transaction publishes the now-complete tree.
  // (In the running app the publish happens the same way — the ParseWorker dispatches it — but the
  // mounted ViewPlugin does not currently rebuild in response; see the note on `ensureParsed`.)
  return state.update({}).state;
}

/** Flattens whatever `build` produces for a fully-parsed `state` (see `ensureParsed`). */
function collect(
  state: EditorState,
  build: (state: EditorState) => DecorationSet,
): Snapshot[] {
  const parsed = ensureParsed(state);
  const out: Snapshot[] = [];
  build(parsed).between(0, parsed.doc.length, (from, to, deco) => {
    out.push({ from, to, class: String((deco.spec as { class?: string }).class) });
  });
  return out;
}

/**
 * Runs `build` with CM6's own wall clock jumped past `LanguageState.init`'s 20 ms `Work.Apply`
 * deadline mid-parse — the same starvation a contended machine produces, injected through the clock
 * rather than through load or a sleep (test-plan §4). The clock is restored before `build` returns,
 * so whatever `build` produced is exactly what a genuinely-contended run would have produced too.
 * Shared by both the #368 (pure-`EditorState`) and #478 (mounted-`EditorView`) regression tests below
 * — same starvation, two different readers.
 */
function withStarvedParseClock<T>(build: () => T): T {
  const realNow = Date.now;
  let readings = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(
    // The first reading sets the deadline; every later one is already past it.
    () => (readings++ === 0 ? realNow() : realNow() + 60_000),
  );
  try {
    return build();
  } finally {
    clock.mockRestore();
  }
}

const snapshot = (state: EditorState): Snapshot[] => collect(state, buildStructuralDecorations);

const atomicRanges = (state: EditorState): Snapshot[] =>
  collect(state, buildAtomicMarkupRanges);

function hidden(s: Snapshot[], range: { from: number; to: number }): boolean {
  return s.some((d) => d.from === range.from && d.to === range.to && d.class === "cm-markupHidden");
}

describe("editor/structuralDecorations — headings (H1-H6)", () => {
  const doc = `# One\n\n## Two\n\n###### Six\n\nBody paragraph, untouched.${NEUTRAL_LINE}`;

  it("hides the ATX marker + trailing space for every level off the active line", () => {
    const s = snapshot(stateFor(doc));
    expect(hidden(s, rangeOf(doc, "# "))).toBe(true);
    expect(hidden(s, rangeOf(doc, "## "))).toBe(true);
    expect(hidden(s, rangeOf(doc, "###### "))).toBe(true);
  });

  it("never decorates plain body text", () => {
    const s = snapshot(stateFor(doc));
    const body = rangeOf(doc, "Body paragraph");
    expect(s.some((d) => d.from <= body.from && d.to >= body.to)).toBe(false);
  });
});

describe("editor/structuralDecorations — emphasis (bold/italic)", () => {
  const doc = `Some *italic* and **bold** text.${NEUTRAL_LINE}`;

  it("hides both single-star marks and styles the italic span", () => {
    const s = snapshot(stateFor(doc));
    const emph = rangeOf(doc, "*italic*");
    expect(s.some((d) => d.from === emph.from && d.to === emph.to && d.class === "cm-emphasis")).toBe(
      true,
    );
    expect(hidden(s, { from: emph.from, to: emph.from + 1 })).toBe(true);
    expect(hidden(s, { from: emph.to - 1, to: emph.to })).toBe(true);
  });

  it("hides both double-star marks and styles the bold span", () => {
    const s = snapshot(stateFor(doc));
    const strong = rangeOf(doc, "**bold**");
    expect(
      s.some((d) => d.from === strong.from && d.to === strong.to && d.class === "cm-strong"),
    ).toBe(true);
    expect(hidden(s, { from: strong.from, to: strong.from + 2 })).toBe(true);
    expect(hidden(s, { from: strong.to - 2, to: strong.to })).toBe(true);
  });
});

describe("editor/structuralDecorations — lists (ordered/unordered/nested)", () => {
  it("hides the bullet marker + trailing space at every nesting depth", () => {
    const doc = `- top\n  - mid\n    - deep${NEUTRAL_LINE}`;
    const s = snapshot(stateFor(doc));
    expect(hidden(s, rangeOf(doc, "- ", 0))).toBe(true);
    expect(hidden(s, rangeOf(doc, "- ", 1))).toBe(true);
    expect(hidden(s, rangeOf(doc, "- ", 2))).toBe(true);
    // Leading indentation (the literal spaces before each nested marker) is untouched —
    // nesting reads from preserved indent, not from any decoration this layer adds.
    expect(doc.slice(6, 8)).toBe("  ");
  });

  it("hides the ordinal marker + trailing space for an ordered list", () => {
    const doc = `1. first\n2. second${NEUTRAL_LINE}`;
    const s = snapshot(stateFor(doc));
    expect(hidden(s, rangeOf(doc, "1. "))).toBe(true);
    expect(hidden(s, rangeOf(doc, "2. "))).toBe(true);
  });
});

describe("editor/structuralDecorations — blockquotes (incl. nesting)", () => {
  it("hides the quote marker and depth-tags the line deeper for nested quotes", () => {
    const doc = `> level one\n> > level two${NEUTRAL_LINE}`;
    const s = snapshot(stateFor(doc));
    expect(hidden(s, rangeOf(doc, "> ", 0))).toBe(true);
    expect(hidden(s, rangeOf(doc, "> ", 1))).toBe(true);
    expect(hidden(s, rangeOf(doc, "> ", 2))).toBe(true);

    const line1 = s.find((d) => d.from === 0 && d.class === "cm-blockquoteLine");
    const line2 = s.find((d) => d.from === doc.indexOf("\n") + 1 && d.class === "cm-blockquoteLine");
    expect(line1).toBeDefined();
    expect(line2).toBeDefined();
  });
});

describe("editor/structuralDecorations — frontmatter stays folded/opaque", () => {
  const doc = `---\ntitle: Test\n# not a heading\n---\n\n# Real Heading${NEUTRAL_LINE}`;

  it("never decorates markup-shaped text inside the frontmatter block", () => {
    const s = snapshot(stateFor(doc));
    const fake = rangeOf(doc, "# not a heading");
    expect(s.some((d) => d.from >= 0 && d.from < fake.to)).toBe(false);
  });

  it("still decorates a real heading that follows the frontmatter", () => {
    const s = snapshot(stateFor(doc));
    // Second "# " occurrence is the real heading's marker (the first is inside frontmatter).
    expect(hidden(s, rangeOf(doc, "# ", 1))).toBe(true);
  });
});

describe("editor/structuralDecorations — mounted frontmatter fold (TD-2/P1, #1019)", () => {
  const mounted: EditorView[] = [];
  let appStyles: HTMLStyleElement | null = null;
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
    appStyles?.remove();
    appStyles = null;
  });

  function mount(doc: string, platform?: "win" | "mac"): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [...viewModeExtensions(), ...structuralMarkdownExtensions(platform)],
      }),
      parent: document.createElement("div"),
    });
    view.dispatch({ effects: setRevealAtCursorEnabled.of(true) });
    mounted.push(view);
    return view;
  }

  function foldButton(view: EditorView): HTMLButtonElement | null {
    return view.dom.querySelector<HTMLButtonElement>(".cm-frontmatterFold");
  }

  function expectCollapsed(doc: string): void {
    const view = mount(doc);
    expect(foldButton(view)).toHaveTextContent("Metadata");
    expect(foldButton(view)).toHaveAttribute("aria-expanded", "false");
    expect(view.dom.querySelectorAll(".cm-frontmatterFold")).toHaveLength(1);
    expect(view.contentDOM).not.toHaveTextContent("title: Test");
    expect(view.contentDOM).toHaveTextContent("Body.");
  }

  it("renders frontmatter closed by --- as one collapsed metadata affordance", () => {
    expectCollapsed("---\ntitle: Test\nauthor: CJ\n---\n\nBody.");
  });

  it("renders frontmatter closed by ... as one collapsed metadata affordance", () => {
    expectCollapsed("---\ntitle: Test\nauthor: CJ\n...\n\nBody.");
  });

  it("expands to verbatim YAML on click and collapses again without changing the document", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);

    foldButton(view)?.click();

    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.field(frontmatterExpandedField)).toBe(true);
    expect(foldButton(view)).toHaveAttribute("aria-expanded", "true");
    expect(view.contentDOM).toHaveTextContent("title: Test");
    expect(view.state.doc.toString()).toBe(doc);

    foldButton(view)?.click();

    expect(view.state.field(frontmatterExpandedField)).toBe(false);
    expect(view.contentDOM).not.toHaveTextContent("title: Test");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("moves a YAML selection to the fold boundary when collapsing hides it", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);
    const end = frontmatterEnd(view.state.doc);

    foldButton(view)?.click();
    view.dispatch({ selection: { anchor: doc.indexOf("Test") } });
    foldButton(view)?.click();

    expect(view.state.field(frontmatterExpandedField)).toBe(false);
    expect(view.state.selection.main.head).toBe(end);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("binds the metadata control to the selected platform variant", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const win = mount(doc, "win");
    const mac = mount(doc, "mac");

    expect(foldButton(win)).toHaveAttribute("data-platform", "win");
    expect(foldButton(mac)).toHaveAttribute("data-platform", "mac");
  });

  it("uses the warm binding tokens and recorded Windows/macOS control geometry", () => {
    appStyles = document.createElement("style");
    appStyles.textContent = APP_STYLESHEET;
    document.head.append(appStyles);
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const win = getComputedStyle(foldButton(mount(doc, "win"))!);
    const mac = getComputedStyle(foldButton(mount(doc, "mac"))!);

    // jsdom preserves custom-property references in computed values, so pin both halves: the CM6
    // theme consumes the semantic binding and the shipped app stylesheet gives it the hi-fi value.
    expect(win.backgroundColor).toBe("var(--color-frontmatter-fold-bg)");
    expect(win.color).toBe("var(--color-frontmatter-fold-fg)");
    expect(APP_STYLESHEET).toContain("--color-frontmatter-fold-bg: #faf8f3");
    expect(APP_STYLESHEET).toContain("--color-frontmatter-fold-fg: #6b665c");
    expect(win.fontFamily).toContain("IBM Plex Sans");
    expect(win.fontSize).toBe("12px");
    expect(document.head.textContent).toContain("var(--color-frontmatter-fold-win-border)");
    expect(APP_STYLESHEET).toContain("--color-frontmatter-fold-win-border: #d5d0c4");
    expect(win.borderRadius).toBe("6px");

    expect(mac.borderStyle).toBe("none");
    expect(mac.borderRadius).toBe("7px");
    expect(document.head.textContent).toContain("var(--color-frontmatter-fold-mac-border)");
    expect(APP_STYLESHEET).toContain("--color-frontmatter-fold-mac-border: #dcd7cc");
  });

  it("renders no affordance when the document has no frontmatter", () => {
    const view = mount("# Heading\n\nBody.");

    expect(foldButton(view)).toBeNull();
  });

  it("suppresses the fold entirely in source view and restores it on return to rich view", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);

    view.dispatch({ effects: setSourceView.of(true) });

    expect(foldButton(view)).toBeNull();
    expect(view.contentDOM).toHaveTextContent("title: Test");

    view.dispatch({ effects: setSourceView.of(false) });

    expect(foldButton(view)).toHaveAttribute("aria-expanded", "false");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("treats the collapsed block as one atomic cursor-traversal unit", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);
    const end = frontmatterEnd(view.state.doc);

    cursorCharRight(view);

    expect(view.state.selection.main.head).toBe(end);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("rejects an edit inside collapsed frontmatter and permits it after expansion", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);
    const insertAt = doc.indexOf("Test");

    view.dispatch({ changes: { from: insertAt, insert: "Draft " }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe(doc);

    view.dispatch({ effects: setFrontmatterExpanded.of(true) });
    view.dispatch({ changes: { from: insertAt, insert: "Draft " }, userEvent: "input.type" });

    expect(view.state.doc.toString()).toBe(doc.slice(0, insertAt) + "Draft " + doc.slice(insertAt));
  });

  it("allows an untagged authoritative full-document replacement while collapsed", () => {
    const doc = "---\ntitle: Local\n---\n\nBody.";
    const replacement = "---\ntitle: Disk\n---\n\nReloaded.";
    const view = mount(doc);

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement } });

    expect(view.state.doc.toString()).toBe(replacement);
    expect(foldButton(view)).toHaveAttribute("aria-expanded", "false");
  });

  it("discovers a closing fence introduced into previously unclosed frontmatter", () => {
    const doc = "---\ntitle: Test";
    const view = mount(doc);
    expect(foldButton(view)).toBeNull();

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n---\n\nBody." },
      userEvent: "input.type",
    });

    expect(foldButton(view)).toHaveAttribute("aria-expanded", "false");
    expect(view.contentDOM).toHaveTextContent("Body.");
  });

  it("removes the fold when a programmatic edit removes the closing fence", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);
    const closing = doc.indexOf("---", 3);

    view.dispatch({ changes: { from: closing, to: closing + 3, insert: "not closed" } });

    expect(foldButton(view)).toBeNull();
    expect(view.contentDOM).toHaveTextContent("title: Test");
  });

  it("an arbitrary fold/unfold/source sequence is effects-only and byte-identical", () => {
    const doc = "---\ntitle: Test\n---\n\nBody.";
    const view = mount(doc);
    const effects = [
      setFrontmatterExpanded.of(true),
      setSourceView.of(true),
      setFrontmatterExpanded.of(false),
      setSourceView.of(false),
      setFrontmatterExpanded.of(true),
      setFrontmatterExpanded.of(false),
    ];

    for (const effect of effects) {
      view.dispatch({ effects: effect });
      expect(view.state.doc.toString()).toBe(doc);
    }
  });
});

describe("editor/structuralDecorations — assertions never ride CM6's initial-parse budget (#368)", () => {
  const doc = `---\ntitle: Test\n# not a heading\n---\n\n# Real Heading${NEUTRAL_LINE}`;

  /**
   * Builds a state whose initial parse was cut short, the way a contended machine cuts it short —
   * see `withStarvedParseClock`. Without `ensureParsed` this produces exactly the #368 failure — a
   * real heading that carries no `cm-markupHidden` decoration because its node was never parsed.
   */
  function stateWithTruncatedParse(text: string): EditorState {
    return withStarvedParseClock(() => stateFor(text));
  }

  it("still decorates the real heading when the 20ms initial-parse budget expired", () => {
    expect(hidden(snapshot(stateWithTruncatedParse(doc)), rangeOf(doc, "# ", 1))).toBe(true);
  });

  it("still reports the heading marker as atomic when the initial-parse budget expired", () => {
    const heading = rangeOf(doc, "# ", 1);
    const atomic = atomicRanges(stateWithTruncatedParse(doc));
    expect(atomic.some((d) => d.from === heading.from && d.to === heading.to)).toBe(true);
  });
});

describe("editor/structuralDecorations — minimal active-line reveal", () => {
  const doc = `# Heading${NEUTRAL_LINE}`;

  it("defaults to hidden markup even on the active line (#2389)", () => {
    const state = stateFor(doc, 2, false);
    expect(state.field(revealAtCursorEnabledField)).toBe(false);
    expect(hidden(snapshot(state), rangeOf(doc, "# "))).toBe(true);
  });

  it("reveals (does not hide) markup on the active line", () => {
    const s = snapshot(stateFor(doc, 2)); // cursor inside the heading line
    expect(hidden(s, rangeOf(doc, "# "))).toBe(false);
  });

  it("hides markup once the cursor leaves the line", () => {
    const s = snapshot(stateFor(doc)); // default: parked on the neutral line
    expect(hidden(s, rangeOf(doc, "# "))).toBe(true);
  });
});

describe("editor/structuralDecorations — active-line reveal on caret move", () => {
  const doc = `# One\n\n## Two${NEUTRAL_LINE}`;

  it("a cross-line caret move updates which line reveals its markup", () => {
    let state = stateFor(doc, doc.indexOf("One")); // cursor on "# One"'s line
    expect(hidden(snapshot(state), rangeOf(doc, "# "))).toBe(false);
    expect(hidden(snapshot(state), rangeOf(doc, "## "))).toBe(true);

    const tr = state.update({ selection: { anchor: doc.indexOf("Two") } }); // move to "## Two"'s line
    state = tr.state;
    const s = snapshot(state);
    expect(hidden(s, rangeOf(doc, "# "))).toBe(true);
    expect(hidden(s, rangeOf(doc, "## "))).toBe(false);
  });
});

describe("editor/structuralDecorations — never mutates the document (TD-2/P1)", () => {
  const fixture = `---\ntitle: X\n---\n\n# Heading\n\n- a\n  - b\n\n> quoted\n\nSome *em* and **strong** text.${NEUTRAL_LINE}`;

  it("building decorations repeatedly never changes doc.toString()", () => {
    const state = stateFor(fixture);
    const before = state.doc.toString();
    buildStructuralDecorations(state);
    buildStructuralDecorations(state);
    expect(state.doc.toString()).toBe(before);
  });

  it("a real edit dispatched through the full extension bundle changes only what the edit specifies", () => {
    let state = stateFor(fixture);
    const steps: Array<{ from: number; to: number; insert: string }> = [
      { from: 0, to: 0, insert: "" },
      { from: state.doc.length, to: state.doc.length, insert: "\n\nAppended.\n" },
    ];
    let expected = fixture;
    for (const change of steps) {
      const tr = state.update({ changes: change });
      state = tr.state;
      expected = expected.slice(0, change.from) + change.insert + expected.slice(change.to);
      expect(state.doc.toString()).toBe(expected);
      // Decorations rebuild on every transaction (StateField.update) — confirm that alone
      // never perturbs the text a second time.
      expect(state.doc.toString()).toBe(expected);
    }
  });

  it("deleting a hidden heading marker character is nothing more than a plain one-character edit", () => {
    let state = stateFor(fixture);
    const hashPos = fixture.indexOf("# Heading");
    const tr = state.update({ changes: { from: hashPos, to: hashPos + 1, insert: "" } });
    state = tr.state;
    expect(state.doc.toString()).toBe(fixture.slice(0, hashPos) + fixture.slice(hashPos + 1));
  });
});

describe("editor/structuralDecorations — buildAtomicMarkupRanges (SPIKE-3 residual, P2a-4)", () => {
  it("contains exactly the hidden-marker ranges — never emphasis/strong spans or blockquote lines", () => {
    const doc = `# Heading\n\nSome *italic* text.${NEUTRAL_LINE}`;
    const atomic = atomicRanges(stateFor(doc));

    expect(atomic.every((d) => d.class === "cm-markupHidden")).toBe(true);
    const heading = rangeOf(doc, "# ");
    expect(atomic.some((d) => d.from === heading.from && d.to === heading.to)).toBe(true);

    // The whole *italic* span is styled (cm-emphasis), not hidden — only its `*` marks are; the
    // atomic set must never include the emphasis span itself (that would make the visible word
    // "italic" itself an atomic unit, breaking ordinary cursor motion through real text).
    const emph = rangeOf(doc, "*italic*");
    expect(atomic.some((d) => d.from === emph.from && d.to === emph.to)).toBe(false);
  });

  it("excludes markup that reveal-at-cursor has made visible on the active line", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const active = stateFor(doc, 2); // cursor inside the heading line — marker is revealed, not hidden
    expect(atomicRanges(active)).toHaveLength(0);
  });

  it("honors the reveal-suppression hook: a suppressed line's marker is atomic again", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const suppressed = stateFor(doc, 2).update({ effects: setRevealAtCursorEnabled.of(false) }).state;
    expect(atomicRanges(suppressed)).toHaveLength(1);
  });
});

describe("editor/structuralDecorations — reveal-at-cursor suppression hook (the P2a-8 display-mode toggle will drive this)", () => {
  const doc = `# Heading${NEUTRAL_LINE}`;

  it("markup stays hidden on what would otherwise be the active line once reveal is suppressed", () => {
    const active = stateFor(doc, 2); // sanity: normally revealed on this line
    expect(hidden(snapshot(active), rangeOf(doc, "# "))).toBe(false);

    const suppressed = active.update({ effects: setRevealAtCursorEnabled.of(false) }).state;
    expect(hidden(snapshot(suppressed), rangeOf(doc, "# "))).toBe(true);
  });

  it("re-enabling reveal restores the active-line reveal", () => {
    let state = stateFor(doc, 2).update({ effects: setRevealAtCursorEnabled.of(false) }).state;
    expect(hidden(snapshot(state), rangeOf(doc, "# "))).toBe(true);

    state = state.update({ effects: setRevealAtCursorEnabled.of(true) }).state;
    expect(hidden(snapshot(state), rangeOf(doc, "# "))).toBe(false);
  });

  it("never mutates the document", () => {
    const state = stateFor(doc, 2);
    const tr = state.update({ effects: setRevealAtCursorEnabled.of(false) });
    expect(tr.state.doc.toString()).toBe(doc);
  });
});

describe("editor/structuralDecorations — atomic cursor traversal over hidden markers (SPIKE-3 residual, P2a-4)", () => {
  // CM6 schedules a `requestAnimationFrame` layout-measure pass on mount; jsdom's polyfilled RAF
  // fires it on a real timer, after the `it()` that mounted the view has already returned, and
  // jsdom's `Range` there doesn't implement `getClientRects` — an unrelated jsdom/CM6 measurement
  // gap, not something this card's decorations trigger. `destroy()` cancels the pending callback,
  // so every mounted view here is tracked and torn down between tests.
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  /**
   * Mounts a real `EditorView` (jsdom) — needed because atomicRanges only takes effect through
   * CM6's own cursor-motion commands (`view.moveByChar`, which `cursorCharLeft`/`cursorCharRight`
   * call), not through a bare `EditorState.update({selection})`.
   *
   * Reveal is suppressed on every mount here (`setRevealAtCursorEnabled.of(false)`) — under the
   * normal per-cursor reveal, a marker's own line is *always* revealed the instant the caret is
   * anywhere on it (line-granularity, §3.3), so a caret already resident on that line can never
   * observe it hidden and a left/right single-character step can never straddle more than one
   * position of a *different*, not-yet-visited line. Suppressing reveal is what makes a marker on
   * the caret's own line stay genuinely hidden — the exact condition (also a real product state:
   * P2a-8's "No Markup" display mode) `atomicRanges` exists to keep navigable one hop at a time
   * rather than one keypress per invisible character.
   */
  function mountSuppressed(doc: string, anchor: number): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor }, extensions: structuralMarkdownExtensions() }),
      parent: document.createElement("div"),
    });
    mounted.push(view);
    view.dispatch({ effects: setRevealAtCursorEnabled.of(false) });
    return view;
  }

  it("arrowing right across a hidden heading marker jumps over it as a single unit", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = mountSuppressed(doc, 0); // caret right before the hidden "# "

    cursorCharRight(view);

    // "# " (marker + trailing space) is 2 characters, both hidden and atomic — one right-arrow
    // must land past both, never at offset 1 (inside the marker).
    expect(view.state.selection.main.head).toBe(2);
  });

  it("arrowing left back across the same hidden marker jumps over it as a single unit", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = mountSuppressed(doc, 2); // caret right after the hidden "# "

    cursorCharLeft(view);

    expect(view.state.selection.main.head).toBe(0);
  });

  it("arrowing across a hidden list marker is likewise atomic", () => {
    const doc = `- top item${NEUTRAL_LINE}`;
    const view = mountSuppressed(doc, 0); // caret before the hidden "- "

    cursorCharRight(view);

    expect(view.state.selection.main.head).toBe(2);
  });

  it("without atomicRanges wired the same movement would land inside the hidden marker (baseline)", () => {
    // Confirms the atomic behavior above is this card's addition, not something CM6 does by
    // default for a `Decoration.mark`-hidden range — the same decoration bundle minus the
    // `EditorView.atomicRanges` extension.
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [markdownLanguage.extension, revealAtCursorEnabledField, structuralDecorationsPlugin],
      }),
      parent: document.createElement("div"),
    });
    mounted.push(view);
    view.dispatch({ effects: setRevealAtCursorEnabled.of(false) });

    cursorCharRight(view);

    expect(view.state.selection.main.head).toBe(1);
  });

  it("moving within an active (revealed) line is ordinary single-character motion not atomic", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("Heading") }, // caret already on the heading line: revealed
        extensions: structuralMarkdownExtensions(),
      }),
      parent: document.createElement("div"),
    });
    mounted.push(view);

    cursorCharRight(view);

    expect(view.state.selection.main.head).toBe(doc.indexOf("Heading") + 1);
  });

  it("a traversal sequence across multiple hidden markers never mutates the document", () => {
    const doc = `- item${NEUTRAL_LINE}`;
    const view = mountSuppressed(doc, 0);

    cursorCharRight(view);
    cursorCharLeft(view);
    cursorCharRight(view);
    cursorCharLeft(view);

    expect(view.state.selection.main.head).toBe(0); // right then left round-trips exactly
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("editor/structuralDecorations — source view (P2a-8, §3.3 'decorations off')", () => {
  const doc = `# Heading\n\nSome *italic* text.${NEUTRAL_LINE}`;

  it("suppresses every decoration once source view is on even on the active line", () => {
    const state = stateFor(doc, 2).update({ effects: setSourceView.of(true) }).state; // cursor on the heading line
    expect(snapshot(state)).toEqual([]);
  });

  it("restores decorations when source view is switched back off", () => {
    let state = stateFor(doc);
    state = state.update({ effects: setSourceView.of(true) }).state;
    state = state.update({ effects: setSourceView.of(false) }).state;
    expect(hidden(snapshot(state), rangeOf(doc, "# "))).toBe(true);
  });

  it("never mutates the document while toggling on and off", () => {
    let state = stateFor(doc);
    const before = state.doc.toString();
    state = state.update({ effects: setSourceView.of(true) }).state;
    state = state.update({ effects: setSourceView.of(false) }).state;
    expect(state.doc.toString()).toBe(before);
  });
});

describe("editor/structuralDecorations — viewport-scoped ViewPlugin (TD-13/SPIKE-3, #216)", () => {
  // `structuralDecorationsPlugin` (unlike #153's `StateField`) can only be exercised through a real
  // mounted `EditorView` — `view.visibleRanges` doesn't exist on a bare `EditorState`. Every view
  // mounted here is tracked and torn down between tests (matches the atomic-traversal block above).
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy();
  });

  /** Wall time `forceParsing` (below) is allowed to drive Lezer's parser to completion at mount —
   * these fixtures are a few KB and parse in well under a millisecond given any CPU time at all, so
   * this is "finish the tree", not "wait a while" (same discipline as `PARSE_BUDGET_MS` above). */
  const MOUNT_PARSE_BUDGET_MS = 2_000;

  function mount(doc: string, anchor: number): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [...structuralMarkdownExtensions(), viewModeField],
      }),
      parent: document.createElement("div"),
    });
    view.dispatch({ effects: setRevealAtCursorEnabled.of(true) });
    // Drives Lezer's parser to completion before returning (#478 — root cause, not the viewport-
    // recompute race first suspected). Without this, `syntaxTree(state)` stays whatever CM6's
    // *synchronous* initial-parse budget covered (`LanguageState.init`'s 20ms `Work.Apply` wall
    // clock, `@codemirror/language`) — genuinely reachable for even a small fixture under full-suite
    // parallel load (the same #368/#391 class of race) — and the rest only completes via a
    // background scheduler this synchronous test never pumps. A test then reads whatever partial
    // tree resulted regardless of what viewport/decoration rebuild logic ran on top of it, so a node
    // deep in the fixture (e.g. "Far Heading") can come up undecorated. This mirrors
    // `tests/perf/structuralDecorationsViewport.perf.test.ts`'s own `mount`, which already forces
    // full parsing for the same reason (PR #287) — this block just hadn't picked up that idiom yet.
    if (!forceParsing(view, doc.length, MOUNT_PARSE_BUDGET_MS) || syntaxTree(view.state).length < doc.length) {
      view.destroy();
      throw new Error(
        `forceParsing did not reach the end of a ${doc.length}-char fixture within ${MOUNT_PARSE_BUDGET_MS}ms`,
      );
    }
    mounted.push(view);
    return view;
  }

  function pluginDecorations(view: EditorView) {
    const value = view.plugin(structuralDecorationsPlugin);
    if (!value) throw new Error("structuralDecorationsPlugin not installed");
    return value;
  }

  /** Whether `set` (a raw `DecorationSet`, as `pluginDecorations` returns — not run through
   * `snapshot`'s `buildStructuralDecorations`/full-doc pure-function path) has any decoration
   * touching `[from, to)`. */
  function decoratesRange(set: DecorationSet, from: number, to: number): boolean {
    let found = false;
    set.between(from, to, () => {
      found = true;
    });
    return found;
  }

  it("a same-line selection change does not rebuild the decoration set", () => {
    const doc = `# One\n\n## Two${NEUTRAL_LINE}`;
    const view = mount(doc, 0); // caret inside "# One"'s line
    const before = pluginDecorations(view).view;

    view.dispatch({ selection: { anchor: 1, head: 3 } }); // still on the same line

    expect(pluginDecorations(view).view).toBe(before); // same DecorationSet instance — rebuild skipped
  });

  it("a cross-line caret move rebuilds the decoration set and reveals the newly-active line", () => {
    const doc = `# One\n\n## Two${NEUTRAL_LINE}`;
    const view = mount(doc, doc.indexOf("One"));
    const before = pluginDecorations(view).view;

    view.dispatch({ selection: { anchor: doc.indexOf("Two") } }); // move to "## Two"'s line

    expect(pluginDecorations(view).view).not.toBe(before);
    expect(hidden(snapshot(view.state), rangeOf(doc, "# "))).toBe(true);
    expect(hidden(snapshot(view.state), rangeOf(doc, "## "))).toBe(false);
  });

  it("toggling reveal-suppression rebuilds the decoration set with no doc or line change", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = mount(doc, 2); // caret on the heading line
    const before = pluginDecorations(view).view;

    view.dispatch({ effects: setRevealAtCursorEnabled.of(false) });

    expect(pluginDecorations(view).view).not.toBe(before);
  });

  it("switching source view rebuilds the decoration set with no doc or line change", () => {
    const doc = `# Heading${NEUTRAL_LINE}`;
    const view = mount(doc, 0);
    const before = pluginDecorations(view).view;

    view.dispatch({ effects: setSourceView.of(true) });

    expect(pluginDecorations(view).view).not.toBe(before);
    expect(pluginDecorations(view).view.size).toBe(0); // source view: decorations off entirely
  });

  /**
   * A document with a heading near the top (inside any reasonable initial viewport) and one well
   * below it (outside). `mount`'s `forceParsing` call (#478) guarantees the *whole* tree is complete
   * before any assertion below reads it, regardless of fixture size or how much of CM6's 20ms
   * synchronous initial-parse budget (`LanguageState.init`, `@codemirror/language`) actually ran —
   * so a `farDecorated` failure is never ambiguous (this card's viewport scoping vs. Lezer's own
   * parse timing). A small fixture is still used here to keep the forced parse itself effectively
   * instantaneous, not because size alone was ever a reliable guard against the parse-budget race
   * (it wasn't — that was #478's flake).
   *
   * `midHeadingLine` (#391's regression test only — every other caller omits it, unaffected) plants a
   * third "Target Heading" at the given filler line. Empirically (probed directly against
   * `syntaxTree(view.state)` under `withStarvedParseClock`), a starved single parse step completes
   * only the first ~49 chars — enough to finish "Near Heading" itself but not enough to reach past
   * the long single-paragraph run that follows it — so a heading placed anywhere in that run is
   * reliably left unparsed, unlike a lone/early heading, which the same single step finishes
   * regardless of the clock. That is what makes #391's sanity check meaningful.
   */
  function fixtureWithFarHeading({ midHeadingLine }: { midHeadingLine?: number } = {}): string {
    const filler = Array.from({ length: 150 }, (_, i) => `paragraph line ${i}`);
    filler[2] = "# Near Heading";
    if (midHeadingLine !== undefined) filler[midHeadingLine] = "# Target Heading";
    filler[120] = "# Far Heading";
    return filler.join("\n");
  }

  it("scopes the build to the visible viewport: content far below the initial viewport is not yet decorated", () => {
    // Only the near heading is walked/decorated by the mount-time build — this is the guarantee
    // TD-13/SPIKE-3 calls for and #153's `StateField` did not have (it walked the whole tree
    // regardless of what was on screen).
    const doc = fixtureWithFarHeading();
    const view = mount(doc, 0);

    expect(view.viewport.to).toBeLessThan(doc.indexOf("Far Heading")); // sanity: Far is genuinely offscreen

    const decorated = pluginDecorations(view).view;
    const nearRange = rangeOf(doc, "# ", 0);
    expect(decoratesRange(decorated, nearRange.from, nearRange.to)).toBe(true);

    const farPos = doc.indexOf("# Far Heading");
    expect(decoratesRange(decorated, farPos, farPos + 2)).toBe(false); // outside the viewport — never walked
  });

  it("scrolling the far heading into view rebuilds and decorates it", () => {
    const doc = fixtureWithFarHeading();
    const view = mount(doc, 0);
    const farPos = doc.indexOf("# Far Heading");
    const before = pluginDecorations(view).view;

    view.dispatch({ effects: EditorView.scrollIntoView(farPos) });

    expect(pluginDecorations(view).view).not.toBe(before);
    expect(decoratesRange(pluginDecorations(view).view, farPos, farPos + 2)).toBe(true);
  });

  it("still decorates the far heading when mount's initial parse budget would otherwise expire (#478)", () => {
    // Reproduces #478's flake deterministically: `withStarvedParseClock` (the #368 helper above)
    // makes CM6's `LanguageState.init` see every `Date.now()` reading past its 20ms `Work.Apply`
    // deadline, so without `forceParsing` in `mount` it stops after parsing 0 nodes and the far
    // heading never decorates — even though the viewport plugin *does* rebuild on the scroll
    // (`viewportChanged` fires regardless of parse completeness); the rebuild just walks an empty
    // tree. `forceParsing`'s own synchronous chunking is what has to recover the tree here, exactly
    // as it must under genuine full-suite contention.
    const doc = fixtureWithFarHeading();
    const view = withStarvedParseClock(() => mount(doc, 0));
    const farPos = doc.indexOf("# Far Heading");

    view.dispatch({ effects: EditorView.scrollIntoView(farPos) });

    expect(decoratesRange(pluginDecorations(view).view, farPos, farPos + 2)).toBe(true);
  });

  it("never mutates the document across a viewport-driven rebuild", () => {
    const doc = fixtureWithFarHeading();
    const view = mount(doc, 0);
    const before = view.state.doc.toString();

    view.dispatch({ effects: EditorView.scrollIntoView(doc.indexOf("# Far Heading")) });

    expect(view.state.doc.toString()).toBe(before);
  });

  it("rebuilds once a starved initial parse's tree completes with no intervening edit/scroll/caret move (#391)", () => {
    // #391: a truncated initial parse (a large doc, a slow/contended machine, a cold start) left
    // raw markup on screen forever, because CM6's `ParseWorker` publishes the completed background
    // tree via a bare `Language.setState` effect (@codemirror/language) — a transaction that
    // changes no doc, no viewport, no active line, and carries none of this module's own effects,
    // so `structuralInputsChanged` short-circuited the rebuild away. Recovery only ever happened on
    // the *next* real edit, scroll, or cross-line caret move — never on the parse finishing itself.
    const doc = fixtureWithFarHeading({ midHeadingLine: 10 });
    const target = rangeOf(doc, "# ", 1); // "Near" is occurrence 0, "Target" is occurrence 1

    // Mounted directly (not via `mount()`, which forces the parse to completion) so the initial
    // decoration build sees the genuinely-starved tree #478's `withStarvedParseClock` produces.
    const view = withStarvedParseClock(
      () =>
        new EditorView({
          state: EditorState.create({
            doc,
            selection: { anchor: 0 },
            extensions: [...structuralMarkdownExtensions(), viewModeField],
          }),
          parent: document.createElement("div"),
        }),
    );
    mounted.push(view);

    // Sanity: the target heading is genuinely within the initial viewport and genuinely unparsed —
    // the same evidence #391 was filed against — otherwise the assertion below proves nothing.
    expect(view.viewport.to).toBeGreaterThan(target.to);
    expect(decoratesRange(pluginDecorations(view).view, target.from, target.to)).toBe(false);

    // Completes the background parse and publishes it through the same kind of transaction CM6's
    // own `ParseWorker.work` dispatches when it takes the finished tree — `forceParsing` reaches
    // for `view.dispatch({})` internally, an empty transaction, exactly when the completed tree
    // differs from what the state field already holds (`@codemirror/language`'s own implementation).
    // No scroll, edit, or caret move happens here — recovery must come from the parse completing.
    expect(forceParsing(view, doc.length, MOUNT_PARSE_BUDGET_MS)).toBe(true);

    expect(decoratesRange(pluginDecorations(view).view, target.from, target.to)).toBe(true);
  });
});
