// @vitest-environment jsdom
// ABOUTME: Tracks all four J14 control-state reads on dense 1 MiB Markdown documents.
// ABOUTME: Guards J14's published-tree and pending paths against FR-X-4 frame-budget regressions.
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  formatCommandExtensions,
  formatControlStates,
} from "../../src/editor/formatCommands";
import { markdownLanguage } from "../../src/editor/markdownLanguage";
import { buildLargeMarkdownDoc } from "./fixtures/largeMarkdownDoc";
import { percentile } from "./percentile";

const ACTIVE_READER_TARGET_MS = 6.2;
const ACTIVE_READER_GROSS_REGRESSION_MS = ACTIVE_READER_TARGET_MS * 2;
const COMBINED_TASK_TARGET_MS = 100;
const FORCE_PARSE_TIMEOUT_MS = 20_000;

function denseDocWithTarget(): { doc: string; from: number; to: number } {
  const suffix = "\n***active***";
  const prefix = buildLargeMarkdownDoc({
    targetBytes: 1_000_000 - suffix.length,
    regionCount: 20_000,
  });
  const doc = prefix + suffix;
  return { doc, from: prefix.length + 4, to: prefix.length + 10 };
}

function stateWith(
  doc: string,
  from: number,
  to: number,
  extensions: Extension[],
): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [markdownLanguage.extension, ...extensions],
  });
}

describe("editor/formatCommands — control-state performance (FR-X-4, J14)", () => {
  it("keeps published control-state reads target-scoped in a fully parsed dense 1 MiB tree", () => {
    const { doc, from, to } = denseDocWithTarget();
    const view = new EditorView({
      state: stateWith(doc, from, to, formatCommandExtensions()),
      parent: document.createElement("div"),
    });

    try {
      expect(forceParsing(view, doc.length, FORCE_PARSE_TIMEOUT_MS)).toBe(true);
      expect(syntaxTree(view.state).length).toBe(doc.length);
      const reads: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const startedAt = performance.now();
        expect(formatControlStates(view.state)).toEqual({
          bold: "active",
          italic: "active",
          heading1: "inactive",
          bulletedList: "inactive",
        });
        reads.push(performance.now() - startedAt);
      }

      console.log(
        `[perf] fully parsed dense 1 MiB control reads — p95 ` +
          `${percentile(reads, 95).toFixed(2)}ms, worst ${Math.max(...reads).toFixed(2)}ms ` +
          `(gross-regression line ${ACTIVE_READER_GROSS_REGRESSION_MS}ms)`,
      );
      expect(percentile(reads, 95)).toBeLessThan(ACTIVE_READER_GROSS_REGRESSION_MS);
      expect(Math.max(...reads)).toBeLessThan(COMBINED_TASK_TARGET_MS);
    } finally {
      view.destroy();
    }
  });

  it("adds no document-sized mount or update work and returns pending promptly on a cold dense 1 MiB target", () => {
    const { doc, from, to } = denseDocWithTarget();
    const baselineMounts: number[] = [];
    const formatMounts: number[] = [];
    const updates: number[] = [];
    const reads: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      let startedAt = performance.now();
      stateWith(doc, from, to, []);
      baselineMounts.push(performance.now() - startedAt);

      startedAt = performance.now();
      const initial = stateWith(doc, from, to, formatCommandExtensions());
      formatMounts.push(performance.now() - startedAt);

      startedAt = performance.now();
      const state = initial.update({ changes: { from: initial.doc.length, insert: "x" } }).state;
      updates.push(performance.now() - startedAt);

      startedAt = performance.now();
      expect(formatControlStates(state)).toEqual({
        bold: "pending",
        italic: "pending",
        heading1: "pending",
        bulletedList: "pending",
      });
      reads.push(performance.now() - startedAt);
    }

    const baselineP95 = percentile(baselineMounts, 95);
    const formatP95 = percentile(formatMounts, 95);
    console.log(
      `[perf] cold dense 1 MiB format seam — baseline mount p95 ${baselineP95.toFixed(2)}ms, ` +
        `format mount p95 ${formatP95.toFixed(2)}ms, update p95 ` +
        `${percentile(updates, 95).toFixed(2)}ms, pending read p95 ` +
        `${percentile(reads, 95).toFixed(2)}ms`,
    );
    expect(formatP95).toBeLessThan(COMBINED_TASK_TARGET_MS);
    expect(formatP95).toBeLessThan(baselineP95 + ACTIVE_READER_GROSS_REGRESSION_MS);
    expect(percentile(updates, 95)).toBeLessThan(ACTIVE_READER_GROSS_REGRESSION_MS);
    expect(percentile(reads, 95)).toBeLessThan(ACTIVE_READER_GROSS_REGRESSION_MS);
    expect(Math.max(...reads)).toBeLessThan(COMBINED_TASK_TARGET_MS);
  });
});
