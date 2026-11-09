// ABOUTME: P1 (save∘load ≡ identity) at the CM6 layer — the first frontend assertion of the
// ABOUTME: no-drift property outside `textops` itself (docs/test-matrix.md).
import { describe, expect, it } from "vitest";
import {
  createDocumentState,
  editorOffsetText,
  hasNonLfLineEndings,
  normalizeContentLineEndings,
  projectDiskRangeToBufferPositions,
  serializeDocumentState,
} from "./document";

const FIXTURE_WITH_FRONTMATTER = `---
title: A Test Document
tags: [alpha, beta]
---

# Heading

Some *emphasis* and a {++tracked insertion++}.

Trailing line with no final newline`;

describe("editor/document", () => {
  it("load then save reproduces the file text byte-for-byte including frontmatter", () => {
    const state = createDocumentState(FIXTURE_WITH_FRONTMATTER);
    expect(serializeDocumentState(state)).toBe(FIXTURE_WITH_FRONTMATTER);
  });

  it("preserves a trailing newline rather than trimming it", () => {
    const withTrailingNewline = `${FIXTURE_WITH_FRONTMATTER}\n`;
    const state = createDocumentState(withTrailingNewline);
    expect(serializeDocumentState(state)).toBe(withTrailingNewline);
  });

  it("preserves CRLF line endings verbatim", () => {
    const crlf = "line one\r\nline two\r\n";
    const state = createDocumentState(crlf);
    expect(serializeDocumentState(state)).toBe(crlf);
  });

  it("round-trips the empty document", () => {
    const state = createDocumentState("");
    expect(serializeDocumentState(state)).toBe("");
  });

  it("detects CRLF line endings to trigger the normalization banner", () => {
    expect(hasNonLfLineEndings("line one\r\nline two\r\n")).toBe(true);
  });

  it("detects a lone CR that normalization would also change", () => {
    expect(hasNonLfLineEndings("classic\rmac\rline\rendings")).toBe(true);
  });

  it("reports no carriage returns for an LF-only document", () => {
    expect(hasNonLfLineEndings("---\ntitle: Test\n---\n\n# Body\n")).toBe(false);
    expect(hasNonLfLineEndings("")).toBe(false);
  });

  it("normalizeContentLineEndings mirrors the backend transform: CRLF and lone CR both collapse to LF", () => {
    expect(normalizeContentLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeContentLineEndings("a\rb\rc")).toBe("a\nb\nc");
    expect(normalizeContentLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("normalizeContentLineEndings is a no-op (and idempotent) for an already-LF document", () => {
    const lf = "---\ntitle: Test\n---\n\n# Body\n";
    expect(normalizeContentLineEndings(lf)).toBe(lf);
    expect(normalizeContentLineEndings(normalizeContentLineEndings(lf))).toBe(lf);
  });
});

// The second coordinate axis (#447), independent of the byte↔UTF-16 one `Utf16Map` handles:
// CM6 positions vs the serialized (disk-shaped) string. Every one of these pins the same
// invariant from a different angle — an offset produced against `editorOffsetText` indexes
// exactly what the same offset means to CM6.
describe("editor/document — editorOffsetText (CM6 position space, #447)", () => {
  it("is identical to the serialized text for an LF document", () => {
    const state = createDocumentState(FIXTURE_WITH_FRONTMATTER);
    expect(editorOffsetText(state)).toBe(serializeDocumentState(state));
  });

  it("collapses each CRLF to the single position CM6 counts it as", () => {
    const state = createDocumentState("line one\r\nline two\r\nHELLO there");
    expect(editorOffsetText(state)).toBe("line one\nline two\nHELLO there");
  });

  it("has exactly one UTF-16 unit per CM6 position unlike the serialized text", () => {
    const crlf = "line one\r\nline two\r\nHELLO there";
    const state = createDocumentState(crlf);
    expect(editorOffsetText(state)).toHaveLength(state.doc.length);
    // The divergence this helper exists to close: the serialized (disk) text is longer by one unit
    // per line break, so a CM6 offset indexes the wrong characters in it.
    expect(serializeDocumentState(state)).toHaveLength(state.doc.length + 2);
  });

  it("indexes the same characters a CM6 offset does on a CRLF document", () => {
    const state = createDocumentState("line one\r\nline two\r\nHELLO there");
    // The offset comes from CM6's own line API — an oracle independent of the function under test
    // (deriving it by indexing `doc.toString()` would just be asking `editorOffsetText` about itself).
    const cm6Offset = state.doc.line(3).from;
    expect(editorOffsetText(state).slice(cm6Offset, cm6Offset + 5)).toBe("HELLO");
    // Against the serialized text the very same offset lands two units early — mid-line-break.
    expect(serializeDocumentState(state).slice(cm6Offset, cm6Offset + 5)).not.toBe("HELLO");
  });

  it("keeps a lone CR as the one position CM6 counts it as inside a CRLF document's line", () => {
    // `lineSeparator` is fixed to "\r\n", so a lone CR is an ordinary in-line character to CM6 —
    // one position, one UTF-16 unit, and it must survive verbatim rather than being normalized.
    const state = createDocumentState("a\r\nb\rc\r\nd");
    const positionText = editorOffsetText(state);
    expect(positionText).toBe("a\nb\rc\nd");
    expect(positionText).toHaveLength(state.doc.length);
  });

  it("round-trips the empty document in position space", () => {
    expect(editorOffsetText(createDocumentState(""))).toBe("");
  });
});

// #1326/#1799: project backend-resolved raw-disk ranges into CM6's one-position-per-break model.
describe("editor/document — projectDiskRangeToBufferPositions (#1799)", () => {
  it("leaves an LF document's range unchanged", () => {
    const state = createDocumentState("hello\nworld\n");
    expect(projectDiskRangeToBufferPositions(state, "hello\nworld\n", 6, 5)).toEqual({
      offset: 6,
      length: 5,
    });
  });

  it("subtracts one position per preceding CRLF from both ends of a disk range", () => {
    const crlf = "hello world\r\nsecond line\r\n";
    const state = createDocumentState(crlf);
    expect(projectDiskRangeToBufferPositions(state, crlf, 13, 6)).toEqual({
      offset: 12,
      length: 6,
    });
  });

  it("shrinks a range that crosses CRLF separators by the units CM6 collapses", () => {
    const crlf = "one\r\ntwo\r\nthree";
    const state = createDocumentState(crlf);
    expect(projectDiskRangeToBufferPositions(state, crlf, 0, crlf.length)).toEqual({
      offset: 0,
      length: state.doc.length,
    });
  });

  it("keeps LF-space offsets unchanged when a normalizing save wrote the CRLF buffer's position text", () => {
    const state = createDocumentState("hello world\r\nsecond line\r\n");
    expect(projectDiskRangeToBufferPositions(state, "hello world\nsecond line\n", 12, 6)).toEqual({
      offset: 12,
      length: 6,
    });
  });

  it("refuses disk text that the current buffer does not serialize to", () => {
    const state = createDocumentState("hello\rworld\nsecond\n");
    expect(projectDiskRangeToBufferPositions(state, "hello\nworld\nsecond\n", 6, 5)).toBeNull();
  });

  it("refuses a boundary inside a two-unit CRLF separator rather than clamping it", () => {
    const crlf = "hello\r\nworld";
    const state = createDocumentState(crlf);
    expect(projectDiskRangeToBufferPositions(state, crlf, 6, 1)).toBeNull();
  });

  it("projects the empty range in an empty document", () => {
    expect(projectDiskRangeToBufferPositions(createDocumentState(""), "", 0, 0)).toEqual({
      offset: 0,
      length: 0,
    });
  });
});
