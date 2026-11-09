// ABOUTME: Maintains the document status word count inside the sole CM6 state owner.
// ABOUTME: Edits inspect only their changed text and two-code-point word-boundary context.
import { StateField, type EditorState, type Text, type Transaction } from "@codemirror/state";

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const JOINER = /['’\-]/u;

export interface WordCountProjection {
  count: number;
  /** Test-visible evidence that an update's work is bounded by its changed regions. */
  inspectedCodeUnits: number;
}

interface Span {
  from: number;
  to: number;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function retreatCodePoints(doc: Text, position: number, count: number): number {
  let cursor = position;
  for (let remaining = count; remaining > 0 && cursor > 0; remaining -= 1) {
    cursor -= 1;
    const current = doc.sliceString(cursor, cursor + 1).charCodeAt(0);
    if (isLowSurrogate(current) && cursor > 0) {
      const previous = doc.sliceString(cursor - 1, cursor).charCodeAt(0);
      if (isHighSurrogate(previous)) cursor -= 1;
    }
  }
  return cursor;
}

function advanceCodePoints(doc: Text, position: number, count: number): number {
  let cursor = position;
  for (let remaining = count; remaining > 0 && cursor < doc.length; remaining -= 1) {
    const current = doc.sliceString(cursor, cursor + 1).charCodeAt(0);
    cursor += 1;
    if (isHighSurrogate(current) && cursor < doc.length) {
      const next = doc.sliceString(cursor, cursor + 1).charCodeAt(0);
      if (isLowSurrogate(next)) cursor += 1;
    }
  }
  return cursor;
}

function isWordStart(current: string, previous: string, previousPrevious: string): boolean {
  return (
    LETTER_OR_NUMBER.test(current) &&
    !LETTER_OR_NUMBER.test(previous) &&
    !(JOINER.test(previous) && LETTER_OR_NUMBER.test(previousPrevious))
  );
}

/** Canonical full count used for initial state and equivalence tests. */
export function wordCount(content: string): number {
  let count = 0;
  let previous = "";
  let previousPrevious = "";
  for (const current of content) {
    if (isWordStart(current, previous, previousPrevious)) count += 1;
    previousPrevious = previous;
    previous = current;
  }
  return count;
}

function mergeExpandedSpans(doc: Text, spans: readonly Span[]): Span[] {
  const expanded = spans
    .map(({ from, to }) => ({ from, to: advanceCodePoints(doc, to, 2) }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Span[] = [];
  for (const span of expanded) {
    const previous = merged[merged.length - 1];
    // `countStarts` also reads two code points before `from`. Merge on those complete inspection
    // windows, not only on the forward-expanded contribution spans, so adjacent changes never
    // inspect their shared boundary twice.
    if (previous && retreatCodePoints(doc, span.from, 2) <= previous.to) {
      previous.to = Math.max(previous.to, span.to);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function countStarts(doc: Text, span: Span): WordCountProjection {
  const contextFrom = retreatCodePoints(doc, span.from, 2);
  const content = doc.sliceString(contextFrom, span.to);
  let count = 0;
  let position = contextFrom;
  let previous = "";
  let previousPrevious = "";
  for (const current of content) {
    if (position >= span.from && isWordStart(current, previous, previousPrevious)) count += 1;
    previousPrevious = previous;
    previous = current;
    position += current.length;
  }
  return { count, inspectedCodeUnits: content.length };
}

function updateWordCount(
  previous: WordCountProjection,
  transaction: Transaction,
): WordCountProjection {
  if (!transaction.docChanged) return previous;

  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    oldSpans.push({ from: fromA, to: toA });
    newSpans.push({ from: fromB, to: toB });
  });

  let count = previous.count;
  let inspectedCodeUnits = 0;
  for (const span of mergeExpandedSpans(transaction.startState.doc, oldSpans)) {
    const projection = countStarts(transaction.startState.doc, span);
    count -= projection.count;
    inspectedCodeUnits += projection.inspectedCodeUnits;
  }
  for (const span of mergeExpandedSpans(transaction.newDoc, newSpans)) {
    const projection = countStarts(transaction.newDoc, span);
    count += projection.count;
    inspectedCodeUnits += projection.inspectedCodeUnits;
  }
  return { count, inspectedCodeUnits };
}

export const wordCountField = StateField.define<WordCountProjection>({
  create(state) {
    return { count: wordCount(state.doc.toString()), inspectedCodeUnits: state.doc.length };
  },
  update: updateWordCount,
});

export function wordCountState(state: EditorState): WordCountProjection {
  return state.field(wordCountField);
}
