// ABOUTME: Pins the CM6-owned incremental word-count projection used by the document status bar.
// ABOUTME: Large-document edits inspect changed context only, never the whole mounted document.
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { wordCount, wordCountField, wordCountState } from "./wordCount";

describe("editor/wordCount (#2119, NFR-5)", () => {
  it("preserves the status bar's prose-word grammar", () => {
    expect(wordCount("# Grace\n\nwell-being, don't stop — 42 times.")).toBe(6);
    expect(wordCount("one--two leading- 'three' end-")).toBe(5);
    expect(wordCount(" \n\t ")).toBe(0);
    expect(wordCount("alpha\u00a0beta\u2003gamma\nδelta １２")).toBe(5);
    expect(wordCount("éclair l’amour co-operate 👩🏽‍💻next")).toBe(4);
  });

  it("stays equivalent to the full canonical count across deterministic randomized edits", () => {
    const alphabet = ["a", "Z", "7", " ", "\n", "\u00a0", "-", "'", "’", "é", "δ", "👩"];
    let seed = 0x2119;
    const random = (limit: number) => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return limit === 0 ? 0 : seed % limit;
    };
    let state = EditorState.create({
      doc: "alpha—beta don’t co-operate\u00a0１２",
      extensions: [wordCountField],
    });

    for (let edit = 0; edit < 250; edit += 1) {
      const from = random(state.doc.length + 1);
      const to = from + random(Math.min(5, state.doc.length - from) + 1);
      const insert = Array.from({ length: random(5) }, () => alphabet[random(alphabet.length)]).join("");
      state = state.update({ changes: { from, to, insert } }).state;
      expect(wordCountState(state).count, `edit ${edit}`).toBe(wordCount(state.doc.toString()));
    }
  });

  it("merges adjacent multi-range boundary windows without double-counting", () => {
    const initial = EditorState.create({
      doc: "zero one two three four five",
      extensions: [wordCountField],
    });
    const next = initial.update({
      changes: [
        { from: 5, to: 6, insert: "O" },
        { from: 9, to: 10, insert: "N" },
        { from: 13, to: 14, insert: "E" },
      ],
    }).state;
    const projection = wordCountState(next);

    expect(projection.count).toBe(wordCount(next.doc.toString()));
    expect(
      projection.inspectedCodeUnits,
      "overlapping two-code-point windows must be merged before inspection",
    ).toBeLessThanOrEqual(26);
  });

  it("updates a five-megabyte document from one bounded local inspection window", () => {
    const content = "a".repeat(5_000_000);
    const initial = EditorState.create({ doc: content, extensions: [wordCountField] });
    const next = initial.update({
      changes: { from: 2_500_000, to: 2_500_001, insert: "b" },
    }).state;
    const projection = wordCountState(next);

    expect(projection.count).toBe(1);
    expect(
      projection.inspectedCodeUnits,
      "a one-code-unit edit must not inspect the five-megabyte document",
    ).toBeLessThanOrEqual(16);
  });
});
