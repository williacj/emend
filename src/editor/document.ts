// ABOUTME: Source-as-model CM6 document state (TD-2) — the file's raw text *is* the doc string.
// ABOUTME: No serializer sits between this and the file; decoration providers (P2a-3+) project on top.
import { EditorState, type Extension } from "@codemirror/state";

/**
 * CM6 always joins a doc's internal lines back together with a single, fixed separator on
 * serialization (`EditorState.lineSeparator`, default `"\n"`) — it has no per-line memory of which
 * exact bytes ("\n", "\r\n", or a lone "\r") originally separated that line, only a snapshot at
 * load time. A file split and later rejoined with a *different* literal separator than it was
 * split with loses that distinction (CRLF collapses to LF); split-then-join with the *same*
 * literal separator is always exact (a plain string identity: `s.split(sep).join(sep) === s`,
 * whatever `s` and `sep` are), which is what fixing the facet to the file's own dominant
 * separator, and reading it back out via `lineBreak` on save, buys us. Detection is a single
 * substring check — good enough for the overwhelming common case of a uniformly-CRLF file;
 * genuinely mixed line endings within one file round-trip exactly too (the identity above doesn't
 * care what's inside the lines), just without CM6's line model matching every real line boundary,
 * a cosmetic gap real normalization (P2a-7, FR-ED-2) closes deliberately, with a warning.
 */
function detectLineSeparator(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Whether saving `content` would change its bytes to normalize line endings — i.e. it contains any
 * carriage return (`\r\n` or a lone `\r`). This is the once-per-file signal that drives the FR-ED-2
 * "Line endings will be normalized to LF on save" banner trigger (ux-design integrity moments). The
 * predicate deliberately matches the backend transform exactly (`textops::normalize_line_endings`
 * changes a file iff it contains a `\r`), so the "Don't convert this file" opt-out is offered for
 * *every* file whose bytes the save would actually touch — not just CRLF ones. The normalization
 * itself happens backend-side on save (`save_document`); this is only the detection the editor
 * fires so the banner chrome (P2a-21) has something to hook.
 */
export function hasNonLfLineEndings(content: string): boolean {
  return content.includes("\r");
}

/**
 * Mirrors `textops::normalize_line_endings` exactly (`\r\n` → `\n`, a lone `\r` → `\n`, everything
 * else untouched) so the frontend can predict the exact bytes a normalizing save actually wrote —
 * without a second backend round trip. This is the fix for the false "external change" positive a
 * CRLF file otherwise trips on its own first autosave: `EditorShell`'s dirty/external-change
 * baseline (`savedContentRef`) must track what's really on disk, not the pre-normalization CM6 text,
 * or the very next poll reads back LF bytes that no longer match the CRLF baseline and reports a
 * phantom out-of-band edit (P2a-21 review finding). Idempotent, like the Rust transform it mirrors.
 */
export function normalizeContentLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

/**
 * Builds the CM6 `EditorState` for a document whose file content is `content`. Per TD-2 the
 * state's doc string is the raw markdown text verbatim — no reflow, no reformat, no re-encoding.
 * `extensions` lets callers (decoration providers, keymaps) layer projection on top without this
 * module knowing anything about markdown structure.
 */
export function createDocumentState(content: string, extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [EditorState.lineSeparator.of(detectLineSeparator(content)), ...extensions],
  });
}

/**
 * The exact text of `state`'s doc, byte-for-byte. Uses `state`'s own configured line separator
 * (see `detectLineSeparator`) rather than the bare `Text.toString()`, which always hardcodes
 * `"\n"` regardless of what the document was loaded with. This is CM6's own verbatim text
 * extraction, not a markdown serializer: there is no representation between "what CM6 holds" and
 * "what goes back to disk" (TD-2).
 */
export function serializeDocumentState(state: EditorState): string {
  return state.doc.sliceString(0, state.doc.length, state.lineBreak);
}

/**
 * The document text in **CM6 position space** — the one string whose UTF-16 indices are the same
 * numbers CM6 calls positions. Use this, never `serializeDocumentState`, whenever a string crosses a
 * boundary *paired with offsets* that either side will interpret as CM6 positions: the `parse_changes`
 * round trip seeding the redline layer (its returned offsets become decoration positions and the
 * ranges accept/reject replaces) and `capture_anchor`'s quote anchors.
 *
 * There are two independent coordinate axes in this codebase. The backend already handles the first
 * (byte ↔ UTF-16, `textops::Utf16Map`). This is the second: CM6 counts every line break as exactly
 * **one** position, whatever its literal bytes, whereas `serializeDocumentState` rejoins lines with
 * the document's real `lineBreak` — two UTF-16 units on a CRLF file. Pairing a CM6 offset with that
 * string drifts by one unit per preceding line break, so a redline decorates the wrong span and an
 * accept/reject edits the wrong range of a CRLF document — silent corruption of the source of truth
 * (TD-2, P1), not a cosmetic slip.
 *
 * `Text.toString()` is exactly that string by construction: CM6 joins its internal lines with a bare
 * `"\n"` (one unit per break, matching its own position model) and anything the document's
 * `lineSeparator` did *not* split on — a lone CR, or an LF inside a CRLF document — stays verbatim
 * inside its line, one unit either way. So this is a *coordinate* projection, never a normalization:
 * it is not what goes to disk (that is `serializeDocumentState`, byte-for-byte, TD-2) and no caller
 * should save it.
 */
export function editorOffsetText(state: EditorState): string {
  return state.doc.toString();
}

export interface DocumentRange {
  offset: number;
  length: number;
}

export type DiskRangeProjector = (offset: number, length: number) => DocumentRange | null;

/**
 * Builds a projector from UTF-16 ranges resolved against `diskText` into `state`'s CM6 position
 * space. A projector exists when `diskText` is either already the buffer's CM6-position text (the
 * LF bytes a normalizing save wrote) or the buffer's exact serialization (the raw bytes a
 * non-normalizing load/save kept). A dirty/session-restored buffer matches neither and still
 * refuses the stale position claim (P2). For the raw form, each configured line separator occupies
 * `state.lineBreak.length` UTF-16 units on disk but one CM6 position, so both range boundaries are
 * translated through the document's real line map.
 *
 * A boundary inside a multi-unit separator (between `\r` and `\n`) has no CM6 equivalent and is
 * refused. Real resolved comment anchors cannot acquire that shape because their quoted text begins
 * and ends at CM6-representable character boundaries; keeping the refusal makes malformed external
 * sidecar data fail closed rather than silently clamp (D17/FR-CMT-6).
 */
export function createDiskRangeProjector(
  state: EditorState,
  diskText: string,
): DiskRangeProjector | null {
  const validRange = (offset: number, length: number) =>
    Number.isInteger(offset) &&
    Number.isInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= diskText.length;

  if (editorOffsetText(state) === diskText) {
    return (offset, length) => (validRange(offset, length) ? { offset, length } : null);
  }
  if (serializeDocumentState(state) !== diskText) return null;

  // Build the raw and CM6 start/end coordinates once per thread-list seed. A document may have
  // hundreds of anchored threads (FR-X-4); reserializing or walking every preceding line once per
  // anchor would turn this infrequent seed into an avoidable document-size × thread-count path.
  const lines: Array<{ diskFrom: number; diskTo: number; bufferFrom: number }> = [];
  let diskFrom = 0;
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    lines.push({ diskFrom, diskTo: diskFrom + line.length, bufferFrom: line.from });
    diskFrom += line.length + (number < state.doc.lines ? state.lineBreak.length : 0);
  }

  const projectBoundary = (diskOffset: number): number | null => {
    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const line = lines[middle];
      if (diskOffset < line.diskFrom) {
        high = middle - 1;
      } else if (middle + 1 < lines.length && diskOffset >= lines[middle + 1].diskFrom) {
        low = middle + 1;
      } else {
        return diskOffset <= line.diskTo
          ? line.bufferFrom + (diskOffset - line.diskFrom)
          : null;
      }
    }
    return null;
  };

  return (offset, length) => {
    if (!validRange(offset, length)) return null;
    const from = projectBoundary(offset);
    const to = projectBoundary(offset + length);
    return from === null || to === null ? null : { offset: from, length: to - from };
  };
}

export function projectDiskRangeToBufferPositions(
  state: EditorState,
  diskText: string,
  offset: number,
  length: number,
): DocumentRange | null {
  return createDiskRangeProjector(state, diskText)?.(offset, length) ?? null;
}
