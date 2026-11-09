// @vitest-environment jsdom
// ABOUTME: Tests for the interactive redline model (P2a-5) — snapshot seeding, decoration sides,
// ABOUTME: group-atomic one-undo decisions, and the TD-11 corollary regression: interactive
// ABOUTME: decisions resolve against a stable change identity, never a re-parse-then-index.
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeAt,
  changeGeneration,
  changesOfType,
  decideByType,
  decideChange,
  decisionGroupClosure,
  decisionsTransaction,
  decisionTransaction,
  nextChange,
  prevChange,
  redlineDecorationsField,
  redlineExtensions,
  seedTrackedChanges,
  seedToLiveChanges,
  trackedChanges,
  type ParsedChange,
} from "./trackedChanges";
import { setDisplayMode, setSourceView, viewModeField } from "./viewMode";
import {
  revealAtCursorEnabledField,
  setRevealAtCursorEnabled,
} from "./structuralDecorations";
import { rangeOf } from "./testRanges";

// Fixture builders mirroring what `commands::changes::parse_changes` would report, so tests seed
// the field with exactly that snapshot shape without running the backend parser.
// Every builder reports an *unrecorded* change (TD-16 ruling 2's second population — a human-typed
// marker, which is what a bare fixture stands for); `recordedAs` below promotes one.
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
/** The same change as one that joined a TD-4 record: `group` is the record's own grouping, `null`
 * the backend positively asserting a singleton (TD-16 ruling 2). */
function recordedAs(change: ParsedChange, group: string | null = null): ParsedChange {
  return { ...change, recorded: true, group };
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

/** A headless state seeded with `changes`. Cursor parks at `cursor` (default 0). `viewModeField`
 * rides alongside (as `EditorShell` wires it) so this suite can also exercise source view/display
 * mode. */
function stateWith(
  doc: string,
  changes: ParsedChange[],
  seed = {},
  cursor = 0,
  reveal = true,
): EditorState {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [...redlineExtensions(), viewModeField, revealAtCursorEnabledField],
  });
  state = state.update({
    effects: [
      seedTrackedChanges.of({ changes, ...seed }),
      ...(reveal ? [setRevealAtCursorEnabled.of(true)] : []),
    ],
  }).state;
  return state;
}

/** A mounted view (jsdom) with undo history, seeded with `changes`. */
function viewWith(doc: string, changes: ParsedChange[], seed = {}): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), ...redlineExtensions(), viewModeField] }),
    parent: document.body,
  });
  view.dispatch({ effects: seedTrackedChanges.of({ changes, ...seed }) });
  views.push(view);
  return view;
}

interface Deco {
  from: number;
  to: number;
  class: string;
}
function decorations(state: EditorState): Deco[] {
  const out: Deco[] = [];
  state.field(redlineDecorationsField).view.between(0, state.doc.length, (from, to, d) => {
    out.push({ from, to, class: String((d.spec as { class?: string }).class) });
  });
  return out;
}
function hasDeco(state: EditorState, range: { from: number; to: number }, cls: string): boolean {
  return decorations(state).some((d) => d.from === range.from && d.to === range.to && d.class === cls);
}

describe("editor/trackedChanges — snapshot seeding", () => {
  it("splits each kind into its redline add/remove sides", () => {
    const doc = "a {++X++} {--Y--} {~~o~>n~~} z";
    const live = seedToLiveChanges({ changes: [ins(doc, "0", "X"), del(doc, "1", "Y"), sub(doc, "2", "o", "n")] });
    expect(live[0]).toMatchObject({ kind: "insertion", underline: rangeOf(doc, "X") });
    expect(live[0].strike).toBeUndefined();
    expect(live[1]).toMatchObject({ kind: "deletion", strike: rangeOf(doc, "Y") });
    expect(live[2]).toMatchObject({ kind: "substitution", strike: rangeOf(doc, "o"), underline: rangeOf(doc, "n") });
  });

  it("auto-groups an adjacent deletion→insertion pair as one substitution group", () => {
    const doc = "Name {--Tina--}{++CJ++} here";
    const live = seedToLiveChanges({ changes: [del(doc, "0", "Tina"), ins(doc, "1", "CJ")] });
    expect(live[0].groupId).toBe(live[1].groupId);
  });

  it("leaves non-adjacent changes as their own singleton groups", () => {
    const doc = "a {--x--} b {++y++} c";
    const live = seedToLiveChanges({ changes: [del(doc, "0", "x"), ins(doc, "1", "y")] });
    expect(live[0].groupId).not.toBe(live[1].groupId);
  });

  it("attaches agent notes by change id", () => {
    const doc = "a {++X++} b";
    const live = seedToLiveChanges({ changes: [ins(doc, "0", "X")], notes: { 0: "tightened phrasing" } });
    expect(live[0].note).toBe("tightened phrasing");
  });

  it("groups recorded changes by the record's own group", () => {
    // TD-16 ruling 4: a recorded change's grouping IS the backend's — never re-inferred here.
    const doc = "a {++X++} b {++Y++} c";
    const live = seedToLiveChanges({
      changes: [recordedAs(ins(doc, "chg-a", "X"), "grp-1"), recordedAs(ins(doc, "chg-b", "Y"), "grp-1")],
    });
    expect(live[0].groupId).toBe(live[1].groupId);
  });

  it("leaves a recorded singleton ungrouped even when it sits adjacent to another", () => {
    // `group: null` on a recorded change is the backend asserting a singleton — extending it by
    // adjacency would invent a group the backend deliberately did not record.
    const doc = "Name {--Tina--}{++CJ++} here";
    const live = seedToLiveChanges({
      changes: [recordedAs(del(doc, "chg-a", "Tina")), recordedAs(ins(doc, "chg-b", "CJ"))],
    });
    expect(live[0].groupId).not.toBe(live[1].groupId);
  });

  it("never groups an adjacent pair that straddles the recorded and unrecorded populations", () => {
    // The #566 case, and the reason grouping is a partition: extending a backend group with a
    // change the backend never recorded is the same defect as inventing one.
    const doc = "Name {--Tina--}{++CJ++} here";
    const live = seedToLiveChanges({
      changes: [recordedAs(del(doc, "chg-a", "Tina"), "grp-1"), ins(doc, "snap-b", "CJ")],
    });
    expect(live[0].groupId).not.toBe(live[1].groupId);
  });

  it("auto-groups an unrecorded adjacent pair while recorded changes keep their own grouping", () => {
    // Both rules apply at once, to disjoint populations — P4b keeps its full reach over
    // human-authored markers in a document that also carries agent-delivered ones.
    const doc = "a {--x--}{++y++} b {--p--}{++q--} c";
    const [humanDel, humanIns] = [del(doc, "snap-0", "x"), ins(doc, "snap-1", "y")];
    const live = seedToLiveChanges({
      changes: [humanDel, humanIns, recordedAs(del(doc, "chg-a", "p"), "grp-1")],
    });
    expect(live[0].groupId).toBe(live[1].groupId);
    expect(live[2].groupId).not.toBe(live[0].groupId);
  });
});

describe("editor/trackedChanges — redline decorations", () => {
  // A neutral trailing line the caret parks on, so "hidden off the active line" isn't defeated by
  // every change sharing the caret's line (reveal-at-cursor is per-line).
  const doc = "a {++X++} {--Y--} {~~o~>n~~} z\n\nElsewhere.";
  const changes = (d: string) => [ins(d, "0", "X"), del(d, "1", "Y"), sub(d, "2", "o", "n")];
  const neutral = doc.indexOf("Elsewhere.");

  it("underlines an insertion's added text and strikes a deletion's removed text", () => {
    const state = stateWith(doc, changes(doc), {}, neutral);
    expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "Y"), "cm-redlineDelete")).toBe(true);
  });

  it("strikes a substitution's old side and underlines its new side", () => {
    const state = stateWith(doc, changes(doc), {}, neutral);
    expect(hasDeco(state, rangeOf(doc, "o"), "cm-redlineDelete")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "n"), "cm-redlineInsert")).toBe(true);
  });

  it("hides the CriticMarkup delimiters off the active line", () => {
    const state = stateWith(doc, changes(doc), {}, neutral);
    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupHidden")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "++}"), "cm-markupHidden")).toBe(true);
    // The substitution's inner `~>` is a delimiter too and must hide.
    expect(hasDeco(state, rangeOf(doc, "~>"), "cm-markupHidden")).toBe(true);
  });

  it("reveals the delimiters of the change on the caret's line (reveal-at-cursor)", () => {
    const state = stateWith(doc, changes(doc)).update({ selection: { anchor: rangeOf(doc, "X").from } }).state;
    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupRevealed")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupHidden")).toBe(false);
  });

  it("updates decorations when only the reveal preference changes (#2389)", () => {
    let state = stateWith(doc, changes(doc), {}, rangeOf(doc, "X").from, false);
    expect(state.field(revealAtCursorEnabledField)).toBe(false);
    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupHidden")).toBe(true);

    state = state.update({ effects: setRevealAtCursorEnabled.of(true) }).state;

    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupRevealed")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "{++"), "cm-markupHidden")).toBe(false);
  });
});

describe("editor/trackedChanges — locating & navigating changes", () => {
  const doc = "a {++X++} b {--Y--} c";
  const state = () => stateWith(doc, [ins(doc, "0", "X"), del(doc, "1", "Y")]);

  it("finds the change under a position, and none in the gaps", () => {
    expect(changeAt(state(), rangeOf(doc, "X").from)?.id).toBe("0");
    expect(changeAt(state(), 0)).toBeUndefined();
  });

  it("walks to the next / previous change and wraps around", () => {
    const s = state();
    expect(nextChange(s, 0)?.id).toBe("0");
    expect(nextChange(s, rangeOf(doc, "{++").from)?.id).toBe("1");
    expect(nextChange(s, doc.length)?.id).toBe("0"); // wrap
    expect(prevChange(s, doc.length)?.id).toBe("1");
    expect(prevChange(s, 0)?.id).toBe("1"); // wrap
  });
});

describe("editor/trackedChanges — one decision, one undoable edit", () => {
  it("accept keeps the inserted text; reject removes it", () => {
    const doc = "Hello {++big ++}world";
    const accept = viewWith(doc, [ins(doc, "0", "big ")]);
    decideChange(accept, "0", "accept");
    expect(accept.state.doc.toString()).toBe("Hello big world");

    const reject = viewWith(doc, [ins(doc, "0", "big ")]);
    decideChange(reject, "0", "reject");
    expect(reject.state.doc.toString()).toBe("Hello world");
  });

  it("accept removes a deletion; reject keeps it; substitution takes new/old", () => {
    const dDoc = "Hello {--cruel --}world";
    const dv = viewWith(dDoc, [del(dDoc, "0", "cruel ")]);
    decideChange(dv, "0", "accept");
    expect(dv.state.doc.toString()).toBe("Hello world");

    const sDoc = "Hello {~~old~>new~~} one";
    const sv = viewWith(sDoc, [sub(sDoc, "0", "old", "new")]);
    decideChange(sv, "0", "accept");
    expect(sv.state.doc.toString()).toBe("Hello new one");
    const sv2 = viewWith(sDoc, [sub(sDoc, "0", "old", "new")]);
    decideChange(sv2, "0", "reject");
    expect(sv2.state.doc.toString()).toBe("Hello old one");
  });

  it("is a single history entry — one Ctrl+Z reverses exactly one decision", () => {
    const doc = "Hello {++world++}!";
    const view = viewWith(doc, [ins(doc, "0", "world")]);
    decideChange(view, "0", "accept");
    expect(view.state.doc.toString()).toBe("Hello world!");
    undo(view);
    expect(view.state.doc.toString()).toBe(doc); // markup back, exactly one step
    redo(view);
    expect(view.state.doc.toString()).toBe("Hello world!");
  });

  it("drops the decided change from the live set so its redline disappears", () => {
    const doc = "a {++X++} b {--Y--} c";
    const view = viewWith(doc, [ins(doc, "0", "X"), del(doc, "1", "Y")]);
    decideChange(view, "0", "accept");
    expect(trackedChanges(view.state).map((c) => c.id)).toEqual(["1"]);
  });

  it("undo restores both the text AND the sidecar attribution state — never desynced (finding M9)", () => {
    const doc = "Hello {++world++}!";
    const view = viewWith(doc, [ins(doc, "0", "world")]);
    decideChange(view, "0", "accept");
    expect(trackedChanges(view.state)).toHaveLength(0);

    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    // The change is back in the live set, not just the markup text — a click can decide it again.
    expect(trackedChanges(view.state).map((c) => c.id)).toEqual(["0"]);

    // And redo removes it again, in lockstep with the text.
    redo(view);
    expect(view.state.doc.toString()).toBe("Hello world!");
    expect(trackedChanges(view.state)).toHaveLength(0);
  });
});

describe("editor/trackedChanges — group atomicity from every entry point", () => {
  const doc = "Name {--Tina--}{++CJ++} here";
  it("deciding either member of a substitution pair decides the whole group, all-or-none", () => {
    for (const memberId of ["0", "1"]) {
      const view = viewWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
      decideChange(view, memberId, "accept");
      expect(view.state.doc.toString()).toBe("Name CJ here");
      expect(trackedChanges(view.state)).toHaveLength(0);
    }
  });

  it("a group decision is still one undo entry", () => {
    const view = viewWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
    decideChange(view, "0", "reject");
    expect(view.state.doc.toString()).toBe("Name Tina here");
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("undo-accept-inside-group: undoing a group decision restores every member to the live set — not just the text", () => {
    const view = viewWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
    decideChange(view, "0", "accept");
    expect(trackedChanges(view.state)).toHaveLength(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    expect(trackedChanges(view.state).map((c) => c.id).sort()).toEqual(["0", "1"]);
  });
});

describe("editor/trackedChanges — an edit inside a pending change wins (J1)", () => {
  it("accepting keeps the user's edited text, not the stale snapshot text", () => {
    const doc = "Hello {++big ++}world";
    const view = viewWith(doc, [ins(doc, "0", "big ")]);
    // User types "very " inside the pending insertion, right after "big ".
    const at = rangeOf(doc, "big ").to;
    view.dispatch({ changes: { from: at, insert: "very " } });
    decideChange(view, "0", "accept");
    expect(view.state.doc.toString()).toBe("Hello big very world");
  });
});

describe("editor/trackedChanges — TD-11 corollary: stable identity, never re-parse-then-index", () => {
  it("decides several interactive changes in one session with no misattribution from shifting positions", () => {
    const doc = "A {++insert1++} B {--del2--} C {~~old3~>new3~~} D";
    const view = viewWith(doc, [ins(doc, "0", "insert1"), del(doc, "1", "del2"), sub(doc, "2", "old3", "new3")]);

    // Accepting change 0 shrinks the doc, shifting where 1 and 2 now live. A consumer that
    // re-parsed and re-indexed would now find only two changes and misroute "change 2".
    decideChange(view, "0", "accept");
    expect(view.state.doc.toString()).toBe("A insert1 B {--del2--} C {~~old3~>new3~~} D");

    // Deciding by *identity* still lands change 2 (the substitution) correctly.
    decideChange(view, "2", "reject");
    expect(view.state.doc.toString()).toBe("A insert1 B {--del2--} C old3 D");

    decideChange(view, "1", "accept");
    expect(view.state.doc.toString()).toBe("A insert1 B  C old3 D");
    expect(trackedChanges(view.state)).toHaveLength(0);
  });

  it("a marker revealed by accepting a change is NOT resurrected as a new change", () => {
    // CriticMarkup does not escape: `{++ {--z--} ++}` is ONE insertion of literal ` {--z--} `
    // (first-closer-wins), not an insertion around a deletion — matching the backend parse. A
    // consumer that re-parsed after accepting would see the revealed `{--z--}` as a real deletion
    // and could misattribute a later decision; this field never re-parses, so nothing resurfaces.
    const doc = "{++ {--z--} ++}{--keep--}";
    const nested: ParsedChange = {
      id: "0",
      recorded: false,
      group: null,
      full: rangeOf(doc, "{++ {--z--} ++}"),
      kind: "insertion",
      text: { from: 3, to: doc.indexOf("++}") },
    };
    const view = viewWith(doc, [nested, del(doc, "1", "keep")]);

    decideChange(view, "0", "accept");
    expect(view.state.doc.toString()).toBe(" {--z--} {--keep--}");
    // Only the still-pending `{--keep--}` remains a change; the revealed `{--z--}` is inert text.
    expect(trackedChanges(view.state).map((c) => c.id)).toEqual(["1"]);

    decideChange(view, "1", "reject");
    expect(view.state.doc.toString()).toBe(" {--z--} keep");
  });
});

describe("editor/trackedChanges — keyboard triage (platform-aware Mod)", () => {
  const doc = "Hello {++world++}!";
  // Whether CodeMirror resolves `Mod` to Cmd (macOS) or Ctrl (Windows/Linux) is a platform fact
  // (`navigator`); we set whichever modifier the running environment treats as `Mod`, so the same
  // binding is exercised on either platform (FR-X-1). e2e `NI-keymap-platform` covers the OS matrix.
  const isMac = /Mac/.test(navigator.platform);

  /** Run a key through CodeMirror's own scope-handler resolver — the exact path a real keydown
   * takes to reach the keymap, including `Mod` platform resolution. */
  function press(view: EditorView, key: string): boolean {
    const event = new KeyboardEvent("keydown", {
      key,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    return runScopeHandlers(view, event, "editor");
  }

  it("Mod-Enter accepts the change under the caret", () => {
    const view = viewWith(doc, [ins(doc, "0", "world")]);
    view.dispatch({ selection: { anchor: rangeOf(doc, "{++").from } });
    expect(press(view, "Enter")).toBe(true); // handled
    expect(view.state.doc.toString()).toBe("Hello world!");
  });

  it("Mod-Backspace rejects the change under the caret", () => {
    const view = viewWith(doc, [ins(doc, "0", "world")]);
    view.dispatch({ selection: { anchor: rangeOf(doc, "{++").from } });
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("Hello !");
  });

  it("leaves the caret alone (unhandled) when it is on no change", () => {
    const view = viewWith(doc, [ins(doc, "0", "world")]);
    view.dispatch({ selection: { anchor: 0 } });
    expect(press(view, "Enter")).toBe(false); // falls through to the default binding
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("editor/trackedChanges — decisionTransaction on a missing id", () => {
  it("returns null (no throw) for an id that isn't live", () => {
    const doc = "a {++X++} b";
    const state = stateWith(doc, [ins(doc, "0", "X")]);
    expect(decisionTransaction(state, "99", "accept")).toBeNull();
  });
});

describe("editor/trackedChanges — changeGeneration (UXR-Q4 correspondence token)", () => {
  const doc = "a {++X++} b";

  it("is null before any generation is seeded", () => {
    const state = stateWith(doc, [ins(doc, "0", "X")]);
    expect(changeGeneration(state)).toBeNull();
  });

  it("reads back the generation a seed carried", () => {
    const state = stateWith(doc, [ins(doc, "0", "X")], { generation: "rev-2" });
    expect(changeGeneration(state)).toBe("rev-2");
  });

  it("survives a decision unchanged — the surviving ids stay decidable against the same parse", () => {
    const doc2 = "a {++X++} {++Y++} b";
    let state = stateWith(doc2, [ins(doc2, "0", "X"), ins(doc2, "1", "Y")], { generation: "rev-2" });
    // Decide one change; the field drops it but never re-parses, so the generation must not move.
    const spec = decisionTransaction(state, "0", "accept");
    state = state.update(spec!).state;
    expect(trackedChanges(state).map((c) => c.id)).toEqual(["1"]);
    expect(changeGeneration(state)).toBe("rev-2");
  });

  it("moves to the new generation on a reseed and resets to null for a seed carrying none", () => {
    let state = stateWith(doc, [ins(doc, "0", "X")], { generation: "rev-2" });
    // A fresh parse (e.g. a manual reload) with no revision resets the token — a card built against
    // the old parse then no longer corresponds and fails triage closed.
    state = state.update({ effects: seedTrackedChanges.of({ changes: [ins(doc, "0", "X")] }) }).state;
    expect(changeGeneration(state)).toBeNull();
  });
});

describe("editor/trackedChanges — source view suppresses redline entirely (P2a-8, §3.3)", () => {
  const doc = "a {++X++} {--Y--} z";

  it("shows no decorations at all — raw CriticMarkup verbatim", () => {
    let state = stateWith(doc, [ins(doc, "0", "X"), del(doc, "1", "Y")]);
    state = state.update({ effects: setSourceView.of(true) }).state;
    expect(decorations(state)).toEqual([]);
  });

  it("restores the normal redline once source view is switched back off", () => {
    let state = stateWith(doc, [ins(doc, "0", "X"), del(doc, "1", "Y")]);
    state = state.update({ effects: setSourceView.of(true) }).state;
    state = state.update({ effects: setSourceView.of(false) }).state;
    expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(true);
  });

  it("never mutates the document while toggling on and off", () => {
    let state = stateWith(doc, [ins(doc, "0", "X"), del(doc, "1", "Y")]);
    const before = state.doc.toString();
    state = state.update({ effects: setSourceView.of(true) }).state;
    state = state.update({ effects: setSourceView.of(false) }).state;
    expect(state.doc.toString()).toBe(before);
  });
});

describe("editor/trackedChanges — display-mode resolution (P2a-8, FR-ED-4)", () => {
  // A neutral trailing line so "delimiters force-hidden" isn't defeated by the caret's own line.
  const doc = "a {++X++} {--Y--} {~~o~>n~~} z\n\nElsewhere.";
  const neutral = doc.indexOf("Elsewhere.");
  const changes = (d: string) => [ins(d, "0", "X"), del(d, "1", "Y"), sub(d, "2", "o", "n")];

  it("All (default) keeps today's both-sides-colored rendering", () => {
    const state = stateWith(doc, changes(doc), {}, neutral);
    expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "Y"), "cm-redlineDelete")).toBe(true);
  });

  it.each(["Simple", "None"] as const)(
    "%s hides the struck side and renders the underlined side as plain text (clean accept-all reading)",
    (mode) => {
      let state = stateWith(doc, changes(doc), {}, neutral);
      state = state.update({ effects: setDisplayMode.of(mode) }).state;

      expect(hasDeco(state, rangeOf(doc, "Y"), "cm-markupHidden")).toBe(true);
      expect(hasDeco(state, rangeOf(doc, "Y"), "cm-redlineDelete")).toBe(false);
      expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(false);
      expect(hasDeco(state, rangeOf(doc, "o"), "cm-markupHidden")).toBe(true);
      expect(hasDeco(state, rangeOf(doc, "n"), "cm-redlineInsert")).toBe(false);
      // Delimiters stay hidden even on the change's own line — a clean reading has no braces to reveal.
      const onLine = state.update({ selection: { anchor: rangeOf(doc, "X").from } }).state;
      expect(hasDeco(onLine, rangeOf(doc, "{++"), "cm-markupRevealed")).toBe(false);
    },
  );

  it("Original hides the underlined side and renders the struck side as plain text (reject-all reading)", () => {
    let state = stateWith(doc, changes(doc), {}, neutral);
    state = state.update({ effects: setDisplayMode.of("Original") }).state;

    expect(hasDeco(state, rangeOf(doc, "X"), "cm-markupHidden")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(false);
    expect(hasDeco(state, rangeOf(doc, "Y"), "cm-redlineDelete")).toBe(false);
    expect(hasDeco(state, rangeOf(doc, "n"), "cm-markupHidden")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "o"), "cm-redlineDelete")).toBe(false);
  });

  it("switching back to All restores the normal rendering", () => {
    let state = stateWith(doc, changes(doc), {}, neutral);
    state = state.update({ effects: setDisplayMode.of("None") }).state;
    state = state.update({ effects: setDisplayMode.of("All") }).state;
    expect(hasDeco(state, rangeOf(doc, "X"), "cm-redlineInsert")).toBe(true);
    expect(hasDeco(state, rangeOf(doc, "Y"), "cm-redlineDelete")).toBe(true);
  });

  it("never mutates the document across a mode sequence", () => {
    let state = stateWith(doc, changes(doc), {}, neutral);
    const before = state.doc.toString();
    for (const mode of ["Simple", "None", "Original", "All"] as const) {
      state = state.update({ effects: setDisplayMode.of(mode) }).state;
      expect(state.doc.toString()).toBe(before);
    }
  });
});

describe("editor/trackedChanges — decisionsTransaction: multi-id one-shot decisions", () => {
  it("accepts a multi-id batch as one call — the third (untargeted) change stays pending", () => {
    const doc = "A {++i1++} B {--d2--} C {~~o3~>n3~~} D";
    const state = stateWith(doc, [ins(doc, "0", "i1"), del(doc, "1", "d2"), sub(doc, "2", "o3", "n3")]);
    const spec = decisionsTransaction(state, ["0", "2"], "accept");
    if (!spec) throw new Error("expected a transaction");
    const after = state.update(spec).state;
    expect(after.doc.toString()).toBe("A i1 B {--d2--} C n3 D");
    expect(trackedChanges(after).map((c) => c.id)).toEqual(["1"]);
  });

  it("returns null when none of the ids is live", () => {
    const doc = "a {++X++} b";
    const state = stateWith(doc, [ins(doc, "0", "X")]);
    expect(decisionsTransaction(state, ["99", "100"], "accept")).toBeNull();
  });

  it("duplicate ids and ids already covered by another id's group collapse naturally", () => {
    const doc = "Name {--Tina--}{++CJ++} here";
    const view = viewWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
    const spec = decisionsTransaction(view.state, ["0", "0", "1"], "accept");
    if (!spec) throw new Error("expected a transaction");
    view.dispatch(spec);
    expect(view.state.doc.toString()).toBe("Name CJ here");
    expect(trackedChanges(view.state)).toHaveLength(0);
  });
});

describe("editor/trackedChanges — decisionGroupClosure: the sweep decisionsTransaction would decide, without dispatching (#410)", () => {
  it("returns the passed id plus any group co-member", () => {
    const doc = "Name {--Tina--}{++CJ++} here";
    const state = stateWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
    expect(decisionGroupClosure(state, ["0"]).sort()).toEqual(["0", "1"]);
  });

  it("never dispatches — the live set is unchanged after the call", () => {
    const doc = "Name {--Tina--}{++CJ++} here";
    const state = stateWith(doc, [del(doc, "0", "Tina"), ins(doc, "1", "CJ")]);
    decisionGroupClosure(state, ["0"]);
    expect(trackedChanges(state).map((c) => c.id)).toEqual(["0", "1"]);
    expect(state.doc.toString()).toBe(doc);
  });

  it("returns an empty array when none of the ids is live", () => {
    const doc = "a {++X++} b";
    const state = stateWith(doc, [ins(doc, "0", "X")]);
    expect(decisionGroupClosure(state, ["99"])).toEqual([]);
  });

  it("duplicate ids collapse naturally — matching decisionsTransaction's own sweep", () => {
    const doc = "A {++i1++} B {--d2--} C";
    const state = stateWith(doc, [ins(doc, "0", "i1"), del(doc, "1", "d2")]);
    expect(decisionGroupClosure(state, ["0", "0"]).sort()).toEqual(["0"]);
  });
});

describe("editor/trackedChanges — decideByType: type-filtered bulk ops (P2b-2, J1-Q1)", () => {
  // J1 names only "insertions"/"deletions" (ux-design §4 Phase C); a substitution is neither, so
  // this card's explicit, recorded choice is that a type filter never matches a substitution's own
  // change — the carve-out `ChangeTypeFilter`'s module docs record and this module alone owns.
  const doc = "A {++i1++} B {--d2--} C {~~o3~>n3~~} D";
  const changes = () => [ins(doc, "0", "i1"), del(doc, "1", "d2"), sub(doc, "2", "o3", "n3")];

  it("changesOfType returns only live changes whose own kind matches — never a substitution", () => {
    const state = stateWith(doc, changes());
    expect(changesOfType(state, "insertion").map((c) => c.id)).toEqual(["0"]);
    expect(changesOfType(state, "deletion").map((c) => c.id)).toEqual(["1"]);
  });

  it("accept all insertions decides only the insertion in one transaction — the rest stays pending", () => {
    const view = viewWith(doc, changes());
    const decided = decideByType(view, "insertion", "accept");
    expect(decided).toBe(true);
    expect(view.state.doc.toString()).toBe("A i1 B {--d2--} C {~~o3~>n3~~} D");
    expect(trackedChanges(view.state).map((c) => c.id).sort()).toEqual(["1", "2"]);
  });

  it("reject all deletions keeps the deleted text and leaves insertions/substitutions pending", () => {
    const view = viewWith(doc, changes());
    decideByType(view, "deletion", "reject");
    expect(view.state.doc.toString()).toBe("A {++i1++} B d2 C {~~o3~>n3~~} D");
    expect(trackedChanges(view.state).map((c) => c.id).sort()).toEqual(["0", "2"]);
  });

  it("never touches a substitution: a document with only a substitution is a no-op for either filter", () => {
    const subOnly = "{~~o~>n~~}";
    for (const filter of ["insertion", "deletion"] as const) {
      const view = viewWith(subOnly, [sub(subOnly, "0", "o", "n")]);
      expect(decideByType(view, filter, "accept")).toBe(false);
      expect(view.state.doc.toString()).toBe(subOnly);
    }
  });

  it("routes a partially-matching group through decisionsTransaction so the whole group resolves together (P4b)", () => {
    // The canonical auto-grouped substitution-pair shape: filtering "accept all insertions" matches
    // only the insertion half directly, but the linked deletion is swept in too.
    const pairDoc = "Name {--Tina--}{++CJ++} here";
    const view = viewWith(pairDoc, [del(pairDoc, "0", "Tina"), ins(pairDoc, "1", "CJ")]);
    decideByType(view, "insertion", "accept");
    expect(view.state.doc.toString()).toBe("Name CJ here");
    expect(trackedChanges(view.state)).toHaveLength(0);
  });

  it("is a no-op (returns false — no dispatch) when nothing matches the filter", () => {
    const noInsertions = "A {--d2--} B {~~o3~>n3~~} C";
    const view = viewWith(noInsertions, [del(noInsertions, "0", "d2"), sub(noInsertions, "1", "o3", "n3")]);
    expect(decideByType(view, "insertion", "accept")).toBe(false);
    expect(view.state.doc.toString()).toBe(noInsertions);
    expect(trackedChanges(view.state)).toHaveLength(2);
  });

  it("decides a many-change bulk in one undo entry — FR-AGENT-6 honesty: no partial-applied intermediate state", () => {
    const twoInserts = "A {++i1++} B {++i2++} C";
    const view = viewWith(twoInserts, [ins(twoInserts, "0", "i1"), ins(twoInserts, "1", "i2")]);
    decideByType(view, "insertion", "accept");
    expect(view.state.doc.toString()).toBe("A i1 B i2 C");
    expect(trackedChanges(view.state)).toHaveLength(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(twoInserts);
    expect(trackedChanges(view.state).map((c) => c.id).sort()).toEqual(["0", "1"]);
  });

  it("never re-parses: decides correctly even though an earlier decision in the same session shifted offsets (TD-11 corollary)", () => {
    const view = viewWith(doc, changes());
    // Accept the substitution first, shrinking the doc and shifting where the insertion/deletion
    // markers now live — a consumer that re-parsed-then-indexed here would misattribute.
    decideChange(view, "2", "accept");
    decideByType(view, "insertion", "accept");
    expect(view.state.doc.toString()).toBe("A i1 B {--d2--} C n3 D");
  });
});
