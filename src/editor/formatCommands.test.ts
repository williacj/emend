// @vitest-environment jsdom
// ABOUTME: Tests J14's Bold and Italic source commands over semantic Markdown targets.
// ABOUTME: Pins atomic refusals, one-step history, and CriticMarkup-safe live geometry.
import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { markdownLanguage } from "./markdownLanguage";
import {
  formatControlStates,
  formatCommandExtensions,
  toggleBold,
  toggleBulletedList,
  toggleHeading1,
  toggleItalic,
} from "./formatCommands";
import {
  changeGeneration,
  decisionTransaction,
  redlineExtensions,
  seedTrackedChanges,
  trackedChanges,
  type ParsedChange,
} from "./trackedChanges";
import { setDisplayMode, setSourceView, viewModeExtensions } from "./viewMode";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

const isBoldActive = (state: EditorState): boolean =>
  formatControlStates(state).bold === "active";
const isItalicActive = (state: EditorState): boolean =>
  formatControlStates(state).italic === "active";
const isHeading1Active = (state: EditorState): boolean =>
  formatControlStates(state).heading1 === "active";
const isBulletedListActive = (state: EditorState): boolean =>
  formatControlStates(state).bulletedList === "active";

function viewWith(
  doc: string,
  selection: { anchor: number; head?: number },
  changes: ParsedChange[] = [],
  extensions: Extension = [],
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        history(),
        markdownLanguage.extension,
        ...formatCommandExtensions(),
        ...redlineExtensions(),
        ...viewModeExtensions(),
        extensions,
      ],
    }),
    parent: document.body,
  });
  if (changes.length > 0) {
    view.dispatch({
      effects: seedTrackedChanges.of({
        changes,
        generation: "rev-1",
        notes: Object.fromEntries(changes.map((change) => [change.id, `note-${change.id}`])),
      }),
    });
  }
  views.push(view);
  return view;
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.doc.sliceString(from, to);
}

function selectedTexts(view: EditorView): string[] {
  return view.state.selection.ranges.map((range) =>
    view.state.doc.sliceString(range.from, range.to),
  );
}

function coldStateWithSuffix(
  suffix: string,
  selectionInSuffix: { anchor: number; head?: number },
  targetBytes = 1_000_000,
): EditorState {
  const prefix = "plain prose\n\n".repeat(Math.ceil(targetBytes / 13));
  return EditorState.create({
    doc: prefix + suffix,
    selection: {
      anchor: prefix.length + selectionInSuffix.anchor,
      head: prefix.length + (selectionInSuffix.head ?? selectionInSuffix.anchor),
    },
    extensions: [markdownLanguage.extension, ...formatCommandExtensions()],
  });
}

function insertion(
  doc: string,
  id = "insert",
): Extract<ParsedChange, { kind: "insertion" }> {
  const from = doc.indexOf("{++");
  const to = doc.indexOf("++}", from) + 3;
  return {
    id,
    recorded: true,
    group: "grp-format",
    kind: "insertion",
    full: { from, to },
    text: { from: from + 3, to: to - 3 },
  };
}

function deletion(
  doc: string,
  id = "delete",
): Extract<ParsedChange, { kind: "deletion" }> {
  const from = doc.indexOf("{--");
  const to = doc.indexOf("--}", from) + 3;
  return {
    id,
    recorded: true,
    group: "grp-format",
    kind: "deletion",
    full: { from, to },
    text: { from: from + 3, to: to - 3 },
  };
}

function substitution(
  doc: string,
  id = "substitute",
): Extract<ParsedChange, { kind: "substitution" }> {
  const from = doc.indexOf("{~~");
  const separator = doc.indexOf("~>", from);
  const to = doc.indexOf("~~}", separator) + 3;
  return {
    id,
    recorded: true,
    group: "grp-format",
    kind: "substitution",
    full: { from, to },
    old: { from: from + 3, to: separator },
    new: { from: separator + 2, to: to - 3 },
  };
}

describe("editor/formatCommands — semantic inline toggles (J14, #2412)", () => {
  it("wraps selected authored text in canonical Bold markers and keeps the markers unselected", () => {
    const view = viewWith("one two three", { anchor: 4, head: 7 });

    expect(toggleBold(view)).toEqual({ status: "applied" });

    expect(view.state.doc.toString()).toBe("one **two** three");
    expect(selectedText(view)).toBe("two");
    expect(formatControlStates(view.state).bold).toBe("active");
  });

  it("wraps selected authored text in canonical Italic markers", () => {
    const view = viewWith("one two three", { anchor: 4, head: 7 });

    expect(toggleItalic(view)).toEqual({ status: "applied" });

    expect(view.state.doc.toString()).toBe("one *two* three");
    expect(selectedText(view)).toBe("two");
    expect(formatControlStates(view.state).italic).toBe("active");
  });

  it.each([
    ["**two**", toggleBold],
    ["__two__", toggleBold],
    ["*two*", toggleItalic],
    ["_two_", toggleItalic],
  ] as const)("removes the actual delimiters from %s", (doc, command) => {
    const markerWidth = doc.length === 7 ? 2 : 1;
    const view = viewWith(doc, { anchor: markerWidth, head: doc.length - markerWidth });

    expect(command(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("two");
    expect(selectedText(view)).toBe("two");
  });

  it("toggles Bold and Italic independently through nested emphasis", () => {
    const view = viewWith("***both***", { anchor: 3, head: 7 });
    expect(isBoldActive(view.state)).toBe(true);
    expect(isItalicActive(view.state)).toBe(true);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("*both*");
    expect(isItalicActive(view.state)).toBe(true);
  });

  it("removes the chosen format only from a selected part of an active run", () => {
    const view = viewWith("**one two three**", { anchor: 6, head: 9 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("**one** two **three**");
    expect(selectedText(view)).toBe("two");
    expect(isBoldActive(view.state)).toBe(false);
  });

  it("uses an underscore run's actual delimiters when removing only part of it", () => {
    const view = viewWith("__one two three__", { anchor: 6, head: 9 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("__one__ two __three__");
    expect(selectedText(view)).toBe("two");
    expect(isBoldActive(view.state)).toBe(false);
  });

  it("normalizes a mixed target to one semantic Bold run", () => {
    const view = viewWith("**one** two", { anchor: 2, head: 11 });

    expect(isBoldActive(view.state)).toBe(false);
    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("**one two**");
    expect(selectedText(view)).toBe("one two");
    expect(isBoldActive(view.state)).toBe(true);
  });

  it("formats eligible prose paragraphs separately across a blank line and toggles them off", () => {
    const view = viewWith("one\n\ntwo", { anchor: 0, head: 8 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("**one**\n\n**two**");
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(selectedTexts(view)).toEqual(["one", "two"]);
    expect(isBoldActive(view.state)).toBe(true);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("one\n\ntwo");
    expect(selectedTexts(view)).toEqual(["one", "two"]);
    expect(isBoldActive(view.state)).toBe(false);
  });

  it("uses semantic content boundaries for a collapsed target at an existing run's edges", () => {
    const outerStart = viewWith("**word**", { anchor: 0 });
    const outerEnd = viewWith("**word**", { anchor: 8 });
    const innerStart = viewWith("**word**", { anchor: 2 });
    const innerEnd = viewWith("**word**", { anchor: 6 });

    expect(isBoldActive(outerStart.state)).toBe(false);
    expect(isBoldActive(outerEnd.state)).toBe(false);
    expect(isBoldActive(innerStart.state)).toBe(true);
    expect(isBoldActive(innerEnd.state)).toBe(true);
    expect(toggleBold(outerStart)).toEqual({ status: "applied" });
    expect(toggleBold(outerEnd)).toEqual({ status: "applied" });
    expect(outerStart.state.doc.toString()).not.toBe("**word**");
    expect(outerEnd.state.doc.toString()).not.toBe("**word**");
  });

  it("reports pending for an uncovered target and pending commands preserve source, selection, and focus", () => {
    const state = coldStateWithSuffix("***active***", { anchor: 3, head: 9 });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    view.contentDOM.focus();
    const selection = view.state.selection;

    expect(syntaxTreeAvailable(view.state, view.state.selection.main.to)).toBe(false);
    expect(formatControlStates(view.state)).toEqual({
      bold: "pending",
      italic: "pending",
      heading1: "pending",
      bulletedList: "pending",
    });
    expect(toggleBold(view)).toEqual({ status: "pending" });
    expect(toggleItalic(view)).toEqual({ status: "pending" });
    expect(view.state.doc.toString()).toBe(state.doc.toString());
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
    expect(syntaxTreeAvailable(view.state, view.state.selection.main.to)).toBe(false);
  });

  it("resolves the same target to exact active state after parse publication without moving selection", () => {
    const state = coldStateWithSuffix("***active***", { anchor: 3, head: 9 });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    const selection = view.state.selection;

    expect(formatControlStates(view.state)).toEqual({
      bold: "pending",
      italic: "pending",
      heading1: "pending",
      bulletedList: "pending",
    });
    expect(forceParsing(view, view.state.doc.length, 20_000)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(formatControlStates(view.state)).toEqual({
      bold: "active",
      italic: "active",
      heading1: "inactive",
      bulletedList: "inactive",
    });
  });

  it("resolves cold code exclusions to inactive only after authoritative publication", () => {
    const cases = [
      ["fenced code", "```md\n***active***\n```", 9],
      ["distant blockquoted fence", `> \`\`\`md\n${"> code body\n".repeat(2_000)}> ***active***\n> \`\`\``, 8 + "> code body\n".repeat(2_000).length + 5],
      ["indented code", "    ***active***", 7],
      ["inline code", "`***active***`", 4],
    ] as const;

    for (const [label, suffix, activeFrom] of cases) {
      const state = coldStateWithSuffix(suffix, { anchor: activeFrom, head: activeFrom + 6 });
      const view = new EditorView({ state, parent: document.body });
      views.push(view);
      const selection = view.state.selection;

      expect(formatControlStates(view.state), label).toEqual({
        bold: "pending",
        italic: "pending",
        heading1: "pending",
        bulletedList: "pending",
      });
      expect(forceParsing(view, view.state.doc.length, 20_000), label).toBe(true);
      expect(view.state.selection.eq(selection), label).toBe(true);
      expect(formatControlStates(view.state), label).toEqual({
        bold: "inactive",
        italic: "inactive",
        heading1: "inactive",
        bulletedList: "inactive",
      });
    }
  });

  it("reports frontmatter inactive when its eager block parse already covers the target", () => {
    const prefix = `---\n${"key: value\n".repeat(90_000)}`;
    const state = EditorState.create({
      doc: `${prefix}***active***\n---\nbody`,
      selection: { anchor: prefix.length + 3, head: prefix.length + 9 },
      extensions: [markdownLanguage.extension, ...formatCommandExtensions()],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    const selection = view.state.selection;

    expect(syntaxTreeAvailable(view.state, view.state.selection.main.to)).toBe(true);
    expect(formatControlStates(view.state)).toEqual({
      bold: "inactive",
      italic: "inactive",
      heading1: "inactive",
      bulletedList: "inactive",
    });
    expect(forceParsing(view, view.state.doc.length, 20_000)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(formatControlStates(view.state)).toEqual({
      bold: "inactive",
      italic: "inactive",
      heading1: "inactive",
      bulletedList: "inactive",
    });
  });

  it("normalizes leading and trailing whitespace outside valid CommonMark markers", () => {
    const view = viewWith("a one b", { anchor: 1, head: 6 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("a **one** b");
    expect(selectedText(view)).toBe("one");
    expect(isBoldActive(view.state)).toBe(true);
  });

  it("normalizes tabs outside valid CommonMark markers", () => {
    const view = viewWith("a\tone\tb", { anchor: 1, head: 6 });

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("a\t*one*\tb");
    expect(selectedText(view)).toBe("one");
    expect(isItalicActive(view.state)).toBe(true);
  });

  it("refuses an all-whitespace target instead of reporting an applied no-op", () => {
    const view = viewWith("one   two", { anchor: 3, head: 6 });
    const selection = view.state.selection;
    view.contentDOM.focus();

    expect(toggleItalic(view)).toEqual({ status: "unchanged" });
    expect(view.state.doc.toString()).toBe("one   two");
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("formats eligible GFM table cells atomically and retains marker-free logical ranges", () => {
    const doc = "| one | two |\n| --- | --- |";
    const view = viewWith(doc, { anchor: 2, head: 11 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("| **one** | **two** |\n| --- | --- |");
    expect(selectedTexts(view)).toEqual(["one", "two"]);
    expect(isBoldActive(view.state)).toBe(true);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe(doc);
    expect(selectedTexts(view)).toEqual(["one", "two"]);
  });

  it("formats GFM task content without consuming its task marker", () => {
    const view = viewWith("- [ ] one", { anchor: 2, head: 9 });

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("- [ ] *one*");
    expect(selectedText(view)).toBe("one");
  });

  it("removes the containing semantic run from a collapsed target", () => {
    const view = viewWith("before **bold run** after", { anchor: 12 });

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("before bold run after");
    expect(view.state.selection.main.head).toBe(10);
  });

  it("inserts balanced empty pairs and leaves the caret between them", () => {
    const bold = viewWith("word", { anchor: 2 });
    const italic = viewWith("word", { anchor: 2 });

    expect(toggleBold(bold)).toEqual({ status: "applied" });
    expect(bold.state.doc.toString()).toBe("wo****rd");
    expect(bold.state.selection.main.head).toBe(4);

    expect(toggleItalic(italic)).toEqual({ status: "applied" });
    expect(italic.state.doc.toString()).toBe("wo**rd");
    expect(italic.state.selection.main.head).toBe(3);
  });

  it("inserts an empty pair into an empty document", () => {
    const view = viewWith("", { anchor: 0 });

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("**");
    expect(view.state.selection.main.head).toBe(1);
  });

  it("removes a pending empty pair on the second invocation", () => {
    const view = viewWith("word", { anchor: 2 });
    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(isBoldActive(view.state)).toBe(true);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("word");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("produces identical source edits in Rich text and Markdown projections", () => {
    const rich = viewWith("one two", { anchor: 4, head: 7 });
    const markdown = viewWith("one two", { anchor: 4, head: 7 });
    markdown.dispatch({ effects: setSourceView.of(true) });

    expect(toggleItalic(rich)).toEqual({ status: "applied" });
    expect(toggleItalic(markdown)).toEqual({ status: "applied" });
    expect(markdown.state.doc.toString()).toBe(rich.state.doc.toString());
    expect(markdown.state.selection.main.eq(rich.state.selection.main)).toBe(true);
  });

  it("uses one history entry and restores exact bytes and selection through undo and redo", () => {
    const view = viewWith("one two", { anchor: 4, head: 7 });
    expect(toggleBold(view)).toEqual({ status: "applied" });

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("one two");
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });

    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("one **two**");
    expect(selectedText(view)).toBe("two");
    expect(undo(view)).toBe(true);
    expect(undo(view)).toBe(false);
  });

  it("isolates formatting from adjacent typing on both sides of its history event", () => {
    const after = viewWith("word", { anchor: 2 });
    expect(toggleBold(after)).toEqual({ status: "applied" });
    after.dispatch({ changes: { from: 4, insert: "x" }, userEvent: "input.type" });
    expect(undo(after)).toBe(true);
    expect(after.state.doc.toString()).toBe("wo****rd");
    expect(undo(after)).toBe(true);
    expect(after.state.doc.toString()).toBe("word");

    const before = viewWith("word", { anchor: 2 });
    before.dispatch({ changes: { from: 2, insert: "x" }, userEvent: "input.type" });
    before.dispatch({ selection: { anchor: 3 } });
    expect(toggleItalic(before)).toEqual({ status: "applied" });
    expect(undo(before)).toBe(true);
    expect(before.state.doc.toString()).toBe("woxrd");
    expect(undo(before)).toBe(true);
    expect(before.state.doc.toString()).toBe("word");
  });

  it("preserves a backward selection's anchor and head through the source edit", () => {
    const view = viewWith("one two", { anchor: 7, head: 4 });

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("one *two*");
    expect(view.state.selection.main).toMatchObject({ anchor: 8, head: 5 });
    expect(selectedText(view)).toBe("two");
  });
});

describe("editor/formatCommands — fail-closed applicability", () => {
  function expectReasonedRefusal(
    doc: string,
    from: number,
    to: number,
    command: typeof toggleBold,
    reason: string,
  ): void {
    const view = viewWith(doc, { anchor: from, head: to });
    const beforeSelection = view.state.selection;
    view.contentDOM.focus();

    expect(command(view)).toEqual({ status: "unavailable", reason });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(beforeSelection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
  }

  it("returns the exact Bold reason for YAML frontmatter", () => {
    expectReasonedRefusal(
      "---\ntitle: Draft\n---\nBody",
      4,
      9,
      toggleBold,
      "Bold isn't available for this selection because it includes YAML frontmatter.",
    );
  });

  it("returns the exact Italic reason for fenced code", () => {
    expectReasonedRefusal(
      "```ts\nconst value = 1;\n```",
      6,
      21,
      toggleItalic,
      "Italic isn't available for this selection because it includes code.",
    );
  });

  it("returns the exact Bold reason for indented code", () => {
    expectReasonedRefusal(
      "    const value = 1;",
      4,
      19,
      toggleBold,
      "Bold isn't available for this selection because it includes code.",
    );
  });

  it("returns the exact Bold reason for inline code", () => {
    expectReasonedRefusal(
      "before `code` after",
      8,
      12,
      toggleBold,
      "Bold isn't available for this selection because it includes code.",
    );
  });

  it("returns the exact Italic reason for inline code", () => {
    expectReasonedRefusal(
      "before `code` after",
      8,
      12,
      toggleItalic,
      "Italic isn't available for this selection because it includes code.",
    );
  });

  it("chooses YAML before later code for a mixed excluded selection", () => {
    const doc = "---\ntitle: Draft\n---\nBody `code`";
    const view = viewWith(doc, { anchor: 4, head: doc.indexOf("code") + 4 });

    expect(toggleBold(view)).toEqual({
      status: "unavailable",
      reason: "Bold isn't available for this selection because it includes YAML frontmatter.",
    });
  });

  it("chooses earlier code over a later non-reason Critic conflict", () => {
    const doc = "`code` then {++new++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: 1, head: change.text.to }, [change]);

    expect(toggleItalic(view)).toEqual({
      status: "unavailable",
      reason: "Italic isn't available for this selection because it includes code.",
    });
  });

  it("refuses a read-only editor state", () => {
    const view = viewWith("plain", { anchor: 0, head: 5 });
    view.dispatch({ effects: setDisplayMode.of("Original") });
    const selection = view.state.selection;
    view.contentDOM.focus();

    expect(toggleItalic(view)).toEqual({ status: "unchanged" });
    expect(view.state.doc.toString()).toBe("plain");
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("keeps a read-only code target reason-free and unchanged", () => {
    const doc = "before `code` after";
    const view = viewWith(doc, { anchor: 8, head: 12 });
    view.dispatch({ effects: setDisplayMode.of("Original") });
    const selection = view.state.selection;
    view.contentDOM.focus();

    expect(toggleBold(view)).toEqual({ status: "unchanged" });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("refuses a selection crossing CriticMarkup scaffolding atomically", () => {
    const doc = "before {++new++} after";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: 4, head: change.text.to }, [change]);
    const selection = view.state.selection;
    view.contentDOM.focus();

    expect(toggleBold(view)).toEqual({ status: "unchanged" });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
    expect(trackedChanges(view.state)[0]).toMatchObject({
      id: "insert",
      groupId: "insert",
      kind: "insertion",
      full: change.full,
      underline: change.text,
      note: "note-insert",
    });
  });
});

describe("editor/formatCommands — semantic block toggles (J14, #2413)", () => {
  it("round-trips a single-line paragraph through canonical ATX H1 and preserves trailing whitespace", () => {
    const view = viewWith("title  ", { anchor: 0, head: 5 });

    expect(toggleHeading1(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("# title  ");
    expect(selectedText(view)).toBe("title");
    expect(isHeading1Active(view.state)).toBe(true);

    expect(toggleHeading1(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("title  ");
    expect(selectedText(view)).toBe("title");
  });

  it("round-trips a multiline soft-line paragraph through one Setext H1 in LF and CRLF", () => {
    for (const lineBreak of ["\n", "\r\n"]) {
      const doc = `title starts${lineBreak}and continues`;
      const logicalLength = "title starts\nand continues".length;
      const view = viewWith(
        doc,
        { anchor: 0, head: logicalLength },
        [],
        EditorState.lineSeparator.of(lineBreak),
      );

      expect(toggleHeading1(view)).toEqual({ status: "applied" });
      expect(view.state.sliceDoc()).toBe(`${doc}${lineBreak}===`);
      expect(view.state.selection.ranges).toHaveLength(1);
      expect(isHeading1Active(view.state)).toBe(true);

      expect(toggleHeading1(view)).toEqual({ status: "applied" });
      expect(view.state.sliceDoc()).toBe(doc);
    }
  });

  it("normalizes ATX H2-H6 and Setext H2 without consuming authored trailing whitespace", () => {
    for (const mark of ["##", "###", "####", "#####", "######"]) {
      const doc = `${mark}  title ${mark}   `;
      const atx = viewWith(doc, { anchor: mark.length + 2, head: mark.length + 7 });
      expect(toggleHeading1(atx)).toEqual({ status: "applied" });
      expect(atx.state.doc.toString()).toBe("# title   ");
    }

    const setext = viewWith("title  \n---   ", { anchor: 0, head: 5 });
    expect(toggleHeading1(setext)).toEqual({ status: "applied" });
    expect(setext.state.doc.toString()).toBe("title  \n===   ");
  });

  it("removes Setext H1 without merging a following block and preserves a final newline", () => {
    const followed = viewWith("title\n===\nnext", { anchor: 0, head: 5 });
    expect(toggleHeading1(followed)).toEqual({ status: "applied" });
    expect(followed.state.doc.toString()).toBe("title\n\nnext");

    const finalNewline = viewWith("title\n===\n", { anchor: 0, head: 5 });
    expect(toggleHeading1(finalNewline)).toEqual({ status: "applied" });
    expect(finalNewline.state.doc.toString()).toBe("title\n");
  });

  it("preserves blockquote and list containers when applying a multiline Setext H1", () => {
    const quoted = viewWith("> title\n> continues", { anchor: 2, head: 19 });
    expect(toggleHeading1(quoted)).toEqual({ status: "applied" });
    expect(quoted.state.doc.toString()).toBe("> title\n> continues\n> ===");
    expect(selectedTexts(quoted)).toEqual(["title", "continues"]);
    expect(quoted.state.selection.mainIndex).toBe(1);
    expect(undo(quoted)).toBe(true);
    expect(quoted.state.selection.main).toMatchObject({ anchor: 2, head: 19 });
    expect(redo(quoted)).toBe(true);
    expect(selectedTexts(quoted)).toEqual(["title", "continues"]);
    expect(undo(quoted)).toBe(true);
    expect(undo(quoted)).toBe(false);

    const listed = viewWith("- title\n  continues", { anchor: 2, head: 19 });
    expect(toggleHeading1(listed)).toEqual({ status: "applied" });
    expect(listed.state.doc.toString()).toBe("- title\n  continues\n  ===");
  });

  it("keeps heading/list nesting and indentation bytes on both block commands", () => {
    const headingInList = viewWith("- title", { anchor: 2, head: 7 });
    expect(toggleHeading1(headingInList)).toEqual({ status: "applied" });
    expect(headingInList.state.doc.toString()).toBe("- # title");

    const listInQuote = viewWith("> first\n> continues", { anchor: 2, head: 19 });
    expect(toggleBulletedList(listInQuote)).toEqual({ status: "applied" });
    expect(listInQuote.state.doc.toString()).toBe("> - first\n>   continues");

    const indented = viewWith("  title", { anchor: 2, head: 7 });
    expect(toggleHeading1(indented)).toEqual({ status: "applied" });
    expect(indented.state.doc.toString()).toBe("  # title");
  });

  it("creates one canonical bullet item from a multiline paragraph and keeps continuation indentation out of the logical selection", () => {
    const view = viewWith("first\ncontinues", { anchor: 0, head: 15 });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("- first\n  continues");
    expect(selectedTexts(view)).toEqual(["first", "continues"]);
    expect(isBulletedListActive(view.state)).toBe(true);
  });

  it("normalizes plus, star, and ordered markers while preserving continuation meaning", () => {
    const doc = "+ one\n\n* two\n\n10. three\n    continued";
    const view = viewWith(doc, { anchor: 0, head: doc.length });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("- one\n\n- two\n\n- three\n  continued");
    expect(isBulletedListActive(view.state)).toBe(true);
  });

  it("treats a task as active and preserves its literal marker through list off and on", () => {
    for (const marker of ["[ ]", "[x]"]) {
      const view = viewWith(`- ${marker} ship`, { anchor: 6, head: 10 });
      expect(isBulletedListActive(view.state)).toBe(true);

      expect(toggleBulletedList(view)).toEqual({ status: "applied" });
      expect(view.state.doc.toString()).toBe(`${marker} ship`);
      expect(selectedText(view)).toBe("ship");

      expect(toggleBulletedList(view)).toEqual({ status: "applied" });
      expect(view.state.doc.toString()).toBe(`- ${marker} ship`);
    }
  });

  it("uses the configured CRLF separator when de-listing adjacent blocks", () => {
    const view = viewWith(
      "- one\r\n- two",
      { anchor: 0, head: "- one\n- two".length },
      [],
      EditorState.lineSeparator.of("\r\n"),
    );
    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.sliceDoc()).toBe("one\r\n\r\ntwo");
  });

  it("preserves heading structure and separates adjacent semantic blocks when de-listing", () => {
    const heading = viewWith("# title", { anchor: 2, head: 7 });
    expect(toggleBulletedList(heading)).toEqual({ status: "applied" });
    expect(heading.state.doc.toString()).toBe("- # title");

    const items = viewWith("- one\n- two", { anchor: 0, head: 11 });
    expect(toggleBulletedList(items)).toEqual({ status: "applied" });
    expect(items.state.doc.toString()).toBe("one\n\ntwo");
  });

  it("keeps parent and child blocks distinct when de-listing a whole nested list", () => {
    const doc = "- outer\n  - inner\n    continuation";
    const view = viewWith(doc, { anchor: 0, head: doc.length });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("outer\n\ninner\ncontinuation");
    expect(selectedTexts(view)).toEqual(["outer", "inner", "continuation"]);

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: doc.length });
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("outer\n\ninner\ncontinuation");
  });

  it("keeps a child-only de-list inside its parent container as a separate block", () => {
    const doc = "- outer\n  - inner\n    continuation";
    const from = doc.indexOf("inner");
    const view = viewWith(doc, { anchor: from, head: from + "inner".length });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("- outer\n\n  inner\n  continuation");
    expect(selectedText(view)).toBe("inner");

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main).toMatchObject({ anchor: from, head: from + 5 });
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- outer\n\n  inner\n  continuation");
    expect(selectedText(view)).toBe("inner");
  });

  it("keeps nested tasks and selected sibling items distinct without changing their parent", () => {
    const taskDoc = "- outer\n  - [x] inner\n- peer";
    const taskFrom = taskDoc.indexOf("inner");
    const task = viewWith(taskDoc, { anchor: taskFrom, head: taskFrom + 5 });
    expect(toggleBulletedList(task)).toEqual({ status: "applied" });
    expect(task.state.doc.toString()).toBe("- outer\n\n  [x] inner\n- peer");
    expect(selectedText(task)).toBe("inner");

    const siblingsDoc = "- outer\n  - one\n  - two";
    const siblings = viewWith(siblingsDoc, {
      anchor: siblingsDoc.indexOf("- one"),
      head: siblingsDoc.length,
    });
    expect(toggleBulletedList(siblings)).toEqual({ status: "applied" });
    expect(siblings.state.doc.toString()).toBe("- outer\n\n  one\n\n  two");
    expect(siblings.state.doc.toString().startsWith("- outer")).toBe(true);
  });

  it("keeps quoted sibling items as distinct quoted blocks when de-listing", () => {
    const doc = "> - one\n> - two";
    const view = viewWith(doc, { anchor: 0, head: doc.length });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("> one\n> \n> two");
    expect(selectedTexts(view)).toEqual(["one", "two"]);

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: doc.length });
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("> one\n> \n> two");
  });

  it("keeps quoted multiline authored text free of container syntax in both directions", () => {
    const doc = "> - one\n>   continued";
    const one = doc.indexOf("one");
    const forward = viewWith(doc, { anchor: one, head: doc.length });

    expect(toggleBulletedList(forward)).toEqual({ status: "applied" });
    expect(forward.state.doc.toString()).toBe("> one\n> continued");
    expect(selectedTexts(forward)).toEqual(["one", "continued"]);
    expect(forward.state.selection.mainIndex).toBe(1);
    expect(forward.state.selection.main.anchor).toBeLessThan(forward.state.selection.main.head);
    expect(undo(forward)).toBe(true);
    expect(forward.state.doc.toString()).toBe(doc);
    expect(forward.state.selection.main).toMatchObject({ anchor: one, head: doc.length });
    expect(redo(forward)).toBe(true);
    expect(forward.state.doc.toString()).toBe("> one\n> continued");
    expect(selectedTexts(forward)).toEqual(["one", "continued"]);
    expect(forward.state.selection.mainIndex).toBe(1);

    const backward = viewWith(doc, { anchor: doc.length, head: one });
    expect(toggleBulletedList(backward)).toEqual({ status: "applied" });
    expect(selectedTexts(backward)).toEqual(["one", "continued"]);
    expect(backward.state.selection.mainIndex).toBe(0);
    expect(backward.state.selection.ranges.every((range) => range.anchor > range.head)).toBe(true);
  });

  it("maps nested quoted child tails and disjoint siblings to authored text only", () => {
    const nestedDoc = "> - outer\n>   - one\n>     tail\n>   - two";
    const one = nestedDoc.indexOf("one");
    const nested = viewWith(nestedDoc, { anchor: one, head: nestedDoc.length });

    expect(toggleBulletedList(nested)).toEqual({ status: "applied" });
    expect(nested.state.doc.toString()).toBe("> - outer\n> \n>   one\n>   tail\n> \n>   two");
    expect(selectedTexts(nested)).toEqual(["one", "tail", "two"]);
    expect(nested.state.selection.mainIndex).toBe(2);

    const siblingsDoc = "> - one\n> - two";
    const siblings = new EditorView({
      state: EditorState.create({
        doc: siblingsDoc,
        selection: EditorSelection.create([
          EditorSelection.range(siblingsDoc.indexOf("one"), siblingsDoc.indexOf("one") + 3),
          EditorSelection.range(siblingsDoc.indexOf("two"), siblingsDoc.length),
        ], 1),
        extensions: [
          markdownLanguage.extension,
          ...formatCommandExtensions(),
          ...redlineExtensions(),
          ...viewModeExtensions(),
        ],
      }),
      parent: document.body,
    });
    views.push(siblings);
    expect(toggleBulletedList(siblings)).toEqual({ status: "applied" });
    expect(siblings.state.doc.toString()).toBe("> one\n> \n> two");
    expect(selectedTexts(siblings)).toEqual(["one", "two"]);
    expect(siblings.state.selection.mainIndex).toBe(1);
  });

  it("records split authored ranges in one view update and one undo step", () => {
    const updates: ViewUpdate[] = [];
    const doc = "> - one\n>   continued";
    const view = viewWith(
      doc,
      { anchor: doc.indexOf("one"), head: doc.length },
      [],
      EditorView.updateListener.of((update) => updates.push(update)),
    );

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(updates).toHaveLength(1);
    expect(updates[0].transactions.filter((transaction) => transaction.docChanged)).toHaveLength(1);
    expect(updates[0].transactions).toHaveLength(2);
    expect(updates[0].transactions[1].docChanged).toBe(false);
    expect(updates[0].transactions[1].effects).toEqual([]);
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(false);
  });

  it("uses semantic target boundaries for collapsed, line-edge, prefix-only, and blank targets", () => {
    const caret = viewWith("paragraph", { anchor: 4 });
    expect(toggleHeading1(caret)).toEqual({ status: "applied" });
    expect(caret.state.doc.toString()).toBe("# paragraph");

    const nextLine = viewWith("one\n\ntwo", { anchor: 0, head: 5 });
    expect(toggleHeading1(nextLine)).toEqual({ status: "applied" });
    expect(nextLine.state.doc.toString()).toBe("# one\n\ntwo");

    const prefix = viewWith("- item", { anchor: 0, head: 2 });
    expect(toggleBulletedList(prefix)).toEqual({ status: "applied" });
    expect(prefix.state.doc.toString()).toBe("item");

    const blank = viewWith("one\n\ntwo", { anchor: 4 });
    const blankSelection = blank.state.selection;
    expect(toggleBulletedList(blank)).toEqual({ status: "unchanged" });
    expect(blank.state.doc.toString()).toBe("one\n\ntwo");
    expect(blank.state.selection.eq(blankSelection)).toBe(true);
  });

  it("reports exact block exclusions in document order but allows inline code and inline HTML", () => {
    const table = "| one | two |\n| --- | --- |";
    const tableView = viewWith(table, { anchor: 2, head: 11 });
    expect(toggleHeading1(tableView)).toEqual({
      status: "unavailable",
      reason: "Heading 1 isn't available for this selection because it includes a table.",
    });

    const html = "<div>\nraw\n</div>";
    const htmlView = viewWith(html, { anchor: 0, head: html.length });
    expect(toggleBulletedList(htmlView)).toEqual({
      status: "unavailable",
      reason: "Bulleted list isn't available for this selection because it includes HTML.",
    });

    const mixed = "---\ntitle: Draft\n---\n\n| one |\n| --- |";
    const mixedView = viewWith(mixed, { anchor: 4, head: mixed.length });
    expect(toggleHeading1(mixedView)).toEqual({
      status: "unavailable",
      reason: "Heading 1 isn't available for this selection because it includes YAML frontmatter.",
    });

    const inlineDoc = "before `code` <i>inside</i>";
    const inline = viewWith(inlineDoc, { anchor: 0, head: inlineDoc.length });
    expect(toggleHeading1(inline)).toEqual({ status: "applied" });
    expect(inline.state.doc.toString()).toBe("# before `code` <i>inside</i>");
  });

  it("returns all four exact control states and keeps cold block commands pending", () => {
    const state = coldStateWithSuffix("# ***active***", { anchor: 5, head: 11 });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    const selection = view.state.selection;

    expect(formatControlStates(view.state)).toEqual({
      bold: "pending",
      italic: "pending",
      heading1: "pending",
      bulletedList: "pending",
    });
    expect(toggleHeading1(view)).toEqual({ status: "pending" });
    expect(toggleBulletedList(view)).toEqual({ status: "pending" });
    expect(view.state.selection.eq(selection)).toBe(true);

    expect(forceParsing(view, view.state.doc.length, 20_000)).toBe(true);
    expect(formatControlStates(view.state)).toEqual({
      bold: "active",
      italic: "active",
      heading1: "active",
      bulletedList: "inactive",
    });
  });

  it("normalizes nested ordered and bullet items without flattening their continuation meaning", () => {
    const doc = "10. outer\n    + inner\n      continued";
    const view = viewWith(doc, { anchor: 0, head: doc.length });

    expect(toggleBulletedList(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("- outer\n  - inner\n    continued");
    expect(isBulletedListActive(view.state)).toBe(true);
  });

  it("applies mixed block targets without re-editing active ones and removes all-active targets", () => {
    const headings = viewWith("# one\n\ntwo", { anchor: 0, head: 10 });
    expect(toggleHeading1(headings)).toEqual({ status: "applied" });
    expect(headings.state.doc.toString()).toBe("# one\n\n# two");
    expect(toggleHeading1(headings)).toEqual({ status: "applied" });
    expect(headings.state.doc.toString()).toBe("one\n\ntwo");

    const bullets = viewWith("- one\n\ntwo", { anchor: 0, head: 10 });
    expect(toggleBulletedList(bullets)).toEqual({ status: "applied" });
    expect(bullets.state.doc.toString()).toBe("- one\n\n- two");
    expect(toggleBulletedList(bullets)).toEqual({ status: "applied" });
    expect(bullets.state.doc.toString()).toBe("one\n\ntwo");
  });

  it("returns exact code reasons for both block controls over fenced and indented code", () => {
    for (const [control, command] of [
      ["Heading 1", toggleHeading1],
      ["Bulleted list", toggleBulletedList],
    ] as const) {
      for (const doc of ["```md\ncode\n```", "    code"]) {
        const view = viewWith(doc, { anchor: doc.indexOf("code"), head: doc.indexOf("code") + 4 });
        expect(command(view)).toEqual({
          status: "unavailable",
          reason: `${control} isn't available for this selection because it includes code.`,
        });
      }
    }
  });

  it("chooses the first block exclusion across code, table, and HTML", () => {
    const codeThenTable = "```\ncode\n```\n\n| one |\n| --- |";
    expect(toggleHeading1(viewWith(codeThenTable, { anchor: 0, head: codeThenTable.length }))).toEqual({
      status: "unavailable",
      reason: "Heading 1 isn't available for this selection because it includes code.",
    });

    const tableThenHtml = "| one |\n| --- |\n\n<div>raw</div>";
    expect(toggleBulletedList(viewWith(tableThenHtml, { anchor: 0, head: tableThenHtml.length }))).toEqual({
      status: "unavailable",
      reason: "Bulleted list isn't available for this selection because it includes a table.",
    });
  });

  it("deduplicates one semantic block across disjoint selections while preserving both ranges", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "one two",
        selection: EditorSelection.create([
          EditorSelection.range(0, 3),
          EditorSelection.range(4, 7),
        ], 1),
        extensions: [
          markdownLanguage.extension,
          ...formatCommandExtensions(),
          ...redlineExtensions(),
          ...viewModeExtensions(),
        ],
      }),
      parent: document.body,
    });
    views.push(view);

    expect(toggleHeading1(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("# one two");
    expect(selectedTexts(view)).toEqual(["one", "two"]);
    expect(view.state.selection.mainIndex).toBe(1);
  });

  it("uses one isolated history entry with projection parity, undo/redo, and native main-range mapping", () => {
    const rich = viewWith("one\n\ntwo", { anchor: 0, head: 8 });
    const markdown = viewWith("one\n\ntwo", { anchor: 0, head: 8 });
    markdown.dispatch({ effects: setSourceView.of(true) });
    expect(toggleHeading1(rich)).toEqual({ status: "applied" });
    expect(toggleHeading1(markdown)).toEqual({ status: "applied" });
    expect(markdown.state.doc.toString()).toBe(rich.state.doc.toString());
    expect(undo(rich)).toBe(true);
    expect(rich.state.doc.toString()).toBe("one\n\ntwo");
    expect(redo(rich)).toBe(true);

    const multi = new EditorView({
      state: EditorState.create({
        doc: "one\n\ntwo",
        selection: EditorSelection.create([
          EditorSelection.range(3, 0),
          EditorSelection.range(8, 5),
        ], 0),
        extensions: [
          history(),
          markdownLanguage.extension,
          ...formatCommandExtensions(),
          ...redlineExtensions(),
          ...viewModeExtensions(),
        ],
      }),
      parent: document.body,
    });
    views.push(multi);
    expect(toggleBulletedList(multi)).toEqual({ status: "applied" });
    expect(multi.state.doc.toString()).toBe("- one\n\n- two");
    expect(selectedTexts(multi)).toEqual(["one", "two"]);
    expect(multi.state.selection.mainIndex).toBe(0);
    expect(multi.state.selection.main).toMatchObject({ anchor: 5, head: 2 });
  });

  it("keeps block no-ops reason-free for read-only and CriticMarkup targets", () => {
    const readOnly = viewWith("```\ncode\n```", { anchor: 4, head: 8 });
    readOnly.dispatch({ effects: setDisplayMode.of("Original") });
    expect(toggleHeading1(readOnly)).toEqual({ status: "unchanged" });

    const doc = "before {++new++} after";
    const change = insertion(doc);
    const critic = viewWith(doc, { anchor: 0, head: doc.length }, [change]);
    const selection = critic.state.selection;
    expect(toggleBulletedList(critic)).toEqual({ status: "unchanged" });
    expect(critic.state.doc.toString()).toBe(doc);
    expect(critic.state.selection.eq(selection)).toBe(true);
  });

  it("maps a structural prefix outside an insertion through undo/redo and Reject", () => {
    const doc = "{++title++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: change.text.from, head: change.text.to }, [change]);

    expect(toggleHeading1(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("# {++title++}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 2, to: 13 },
      underline: { from: 5, to: 10 },
    });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    view.dispatch(decisionTransaction(view.state, "insert", "reject")!);
    expect(view.state.doc.toString()).toBe("# ");
  });
});

describe("editor/formatCommands — CriticMarkup geometry (TD-16)", () => {
  it("keeps a pair at an insertion's outer start external through Reject and undo/redo", () => {
    const doc = "{++new++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: change.full.from }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("****{++new++}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 4, to: 13 },
      underline: { from: 7, to: 10 },
    });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(trackedChanges(view.state)[0]).toMatchObject({ full: change.full, underline: change.text });
    expect(redo(view)).toBe(true);
    expect(trackedChanges(view.state)[0].full).toEqual({ from: 4, to: 13 });

    view.dispatch(decisionTransaction(view.state, "insert", "reject")!);
    expect(view.state.doc.toString()).toBe("****");
  });

  it("keeps a pair at an insertion's inner end authored through Accept and undo/redo", () => {
    const doc = "{++new++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: change.text.to }, [change]);

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{++new**++}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 0, to: 11 },
      underline: { from: 3, to: 8 },
    });
    expect(undo(view)).toBe(true);
    expect(trackedChanges(view.state)[0]).toMatchObject({ full: change.full, underline: change.text });
    expect(redo(view)).toBe(true);
    expect(trackedChanges(view.state)[0].underline).toEqual({ from: 3, to: 8 });

    view.dispatch(decisionTransaction(view.state, "insert", "accept")!);
    expect(view.state.doc.toString()).toBe("new**");
  });

  it("keeps a pair at a deletion's outer end external through Accept", () => {
    const doc = "{--old--}";
    const change = deletion(doc);
    const view = viewWith(doc, { anchor: change.full.to }, [change]);

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{--old--}**");
    expect(trackedChanges(view.state)[0].full).toEqual(change.full);
    view.dispatch(decisionTransaction(view.state, "delete", "accept")!);
    expect(view.state.doc.toString()).toBe("**");
  });

  it("keeps a pair at a deletion's inner start authored through Reject", () => {
    const doc = "{--old--}";
    const change = deletion(doc);
    const view = viewWith(doc, { anchor: change.text.from }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{--****old--}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 0, to: 13 },
      strike: { from: 3, to: 10 },
    });
    view.dispatch(decisionTransaction(view.state, "delete", "reject")!);
    expect(view.state.doc.toString()).toBe("****old");
  });

  it("keeps Bold authored inside an insertion under Accept and maps it through undo/redo", () => {
    const doc = "{++new++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: change.text.from, head: change.text.to }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{++**new**++}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      id: "insert",
      groupId: "insert",
      note: "note-insert",
      full: { from: 0, to: 13 },
      underline: { from: 3, to: 10 },
    });
    expect(changeGeneration(view.state)).toBe("rev-1");

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(trackedChanges(view.state)[0]).toMatchObject({
      id: "insert",
      groupId: "insert",
      kind: "insertion",
      full: change.full,
      underline: change.text,
      note: "note-insert",
    });
    expect(changeGeneration(view.state)).toBe("rev-1");
    expect(redo(view)).toBe(true);
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 0, to: 13 },
      underline: { from: 3, to: 10 },
    });
    expect(changeGeneration(view.state)).toBe("rev-1");

    const accept = decisionTransaction(view.state, "insert", "accept");
    expect(accept).not.toBeNull();
    view.dispatch(accept!);
    expect(view.state.doc.toString()).toBe("**new**");
  });

  it("removes Bold from an insertion's authored side without consuming Critic delimiters", () => {
    const doc = "{++**new**++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: 5, head: 8 }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{++new++}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 0, to: 9 },
      underline: { from: 3, to: 6 },
    });
    view.dispatch(decisionTransaction(view.state, "insert", "accept")!);
    expect(view.state.doc.toString()).toBe("new");
  });

  it("keeps Italic authored inside a deletion under Reject", () => {
    const doc = "{--old--}";
    const change = deletion(doc);
    const view = viewWith(doc, { anchor: change.text.from, head: change.text.to }, [change]);

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{--*old*--}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      full: { from: 0, to: 11 },
      strike: { from: 3, to: 8 },
    });

    view.dispatch(decisionTransaction(view.state, "delete", "reject")!);
    expect(view.state.doc.toString()).toBe("*old*");
  });

  it("maps both authored sides of a substitution without changing identity metadata", () => {
    const doc = "{~~old~>new~~}";
    const change = substitution(doc);
    const view = viewWith(doc, { anchor: change.new.from, head: change.new.to }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{~~old~>**new**~~}");
    expect(trackedChanges(view.state)[0]).toMatchObject({
      id: "substitute",
      groupId: "substitute",
      kind: "substitution",
      note: "note-substitute",
      full: { from: 0, to: 18 },
      strike: { from: 3, to: 6 },
      underline: { from: 8, to: 15 },
    });
  });

  it("keeps a closing format marker before an insertion outside its full span", () => {
    const doc = "word{++new++}";
    const change = insertion(doc);
    const view = viewWith(doc, { anchor: 0, head: 4 }, [change]);

    expect(toggleBold(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("**word**{++new++}");
    expect(trackedChanges(view.state)[0].full).toEqual({ from: 8, to: 17 });
    view.dispatch(decisionTransaction(view.state, "insert", "reject")!);
    expect(view.state.doc.toString()).toBe("**word**");
  });

  it("keeps an opening format marker after a deletion outside its full span", () => {
    const doc = "{--old--}word";
    const change = deletion(doc);
    const view = viewWith(doc, { anchor: change.full.to, head: doc.length }, [change]);

    expect(toggleItalic(view)).toEqual({ status: "applied" });
    expect(view.state.doc.toString()).toBe("{--old--}*word*");
    expect(trackedChanges(view.state)[0].full).toEqual({ from: 0, to: 9 });
    view.dispatch(decisionTransaction(view.state, "delete", "accept")!);
    expect(view.state.doc.toString()).toBe("*word*");
  });
});
