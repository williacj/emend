// ABOUTME: FR-CHAT-4/D30's `open_documents` envelope and FR-CHAT-3's quote envelope, asserted
// ABOUTME: through the composed prompt a run actually carries rather than through internal helpers.
import { describe, expect, it } from "vitest";
import type { QuotedExcerpt } from "./types";
import {
  activeDocumentOutboundDisclosure,
  activeDocumentContentSent,
  NO_OPEN_DOCUMENTS,
  promptWithReferenceData,
  type OpenDocument,
  type OpenDocumentsSnapshot,
} from "./referenceData";
import { parseReferenceData as parse } from "./referenceDataTestUtils";

const CURRENT_TEXT_STATEMENT =
  "The content shown for a document above is that document's current text; the file at its path is behind it.";
const PATHLESS_TEXT_STATEMENT =
  "The content shown for a document with a null path is that document's whole text; it exists nowhere on disk, so there is no file to read for it.";
const NOT_SUPPLIED_STATEMENT =
  "A document listed above with a null path and no content was not supplied here and cannot be read.";
/** (c), D31 — CJ's own confirmed phrasing (2026-09-02) over his first draft: never asserts a file
 * exists at `path` or what it holds, since the app makes no live disk comparison. Opens by naming
 * "The active document" — FR-CHAT-4 requires (c)/(c-pathless) to name their subject, since this
 * entry's shape is identical to a co-listed dirty background tab's and the payload alone does not
 * distinguish them. */
const OVER_BOUND_STATEMENT =
  "The active document's current text was too large to include and so was not supplied; the user's unsaved changes are not in the file at its path, which is the only route the agent has to this document.";
/** (c-pathless), D31 clause 5 — the bound is not waived for an untitled document. Also names "The
 * active document": its shape is identical to (b)'s and the two can co-occur (an over-bound active
 * untitled document beside a background untitled tab). */
const OVER_BOUND_PATHLESS_STATEMENT =
  "The active document's current text was too large to include; it exists nowhere on disk, so there is no file to read for it.";
/** (q), D32. */
const QUOTE_OVER_BOUND_STATEMENT =
  "The quoted selection was too large to include and so was not supplied; document_path is the only route the agent has to this text.";
/** (q-pathless), D32×D33 — also the statement a pathless over-bound quote carries alone, per D33's
 * "names both facts truthfully in one statement rather than two". */
const QUOTE_OVER_BOUND_PATHLESS_STATEMENT =
  "The quoted selection was too large to include and so was not supplied; the document exists nowhere on disk, so there is no route to this text at all.";

// Deliberately literal, not imported from `referenceData.ts`: these pin the ratified byte counts
// themselves (D31/D32), so a fixture built from the module's own constant could not catch that
// constant being wrong (a mistyped `256 * 1000`, say) — the one place in this file where reusing
// the production value would defeat the test's own purpose (simplify pass, #2312).
const CONTENT_BOUND_BYTES = 262_144; // 256 KiB, D31
const QUOTE_BOUND_BYTES = 1_048_576; // 1 MiB, D32

describe("#2539 J13 batch copy", () => {
  it("reports actual submit-time active-text carriage and withholding, never a clean claim", () => {
    expect(activeDocumentOutboundDisclosure({ active: { path: "notes/draft.md", dirty: false }, alsoOpen: [] })).toBeNull();
    expect(activeDocumentOutboundDisclosure({ active: { path: "notes/draft.md", dirty: true, content: "edited" }, alsoOpen: [] }))
      .toBe("carried draft.md as edited");
    expect(activeDocumentOutboundDisclosure({ active: { path: "notes/draft.md", dirty: true, content: "é".repeat(131_073) }, alsoOpen: [] }))
      .toBe("carried draft.md by name only — over Emend’s size limit");
  });
});

/**
 * A string whose UTF-8 encoding is exactly `bytes` long, built mostly from a two-byte character so
 * a `String.length`/UTF-16-code-unit or plain character-count measure disagrees with the true byte
 * count — the matrix's own requirement that "the boundary fixtures must include multi-byte text; an
 * all-ASCII fixture passes under every wrong measure." "é" is 2 UTF-8 bytes / 1 UTF-16 code unit; an
 * odd `bytes` gets one trailing ASCII byte to land exactly.
 */
function utf8StringOfByteLength(bytes: number): string {
  const pairs = Math.floor(bytes / 2);
  const remainder = bytes % 2;
  // "é" (é), one precomposed UTF-16 code unit / 2 UTF-8 bytes — written as an escape so no
  // editor/encoding round trip can silently decompose it into two code units.
  return "é".repeat(pairs) + "x".repeat(remainder);
}

const CLEAN: OpenDocument = { path: "notes/outline.md", dirty: false };
const DIRTY_BACKGROUND: OpenDocument = { path: "drafts/kenosis-daily.md", dirty: true };
const UNTITLED_BACKGROUND: OpenDocument = {
  path: null,
  label: "Untitled — recovered from notes/sermon-seed.md",
};

/** `content` rides the active slot alone — a background entry cannot structurally carry one, so
 * "a dirty background tab contributes identity and dirty state only" is a type here, not a rule a
 * test has to police. */
function snapshot(
  active: (OpenDocument & { content?: string }) | null,
  alsoOpen: OpenDocument[] = [],
): OpenDocumentsSnapshot {
  return { active, alsoOpen };
}

describe("timeline/referenceData — the open_documents envelope (FR-CHAT-4, D30)", () => {
  it("J13 collapsed cue follows the actual active envelope content", () => {
    const atBound = utf8StringOfByteLength(262_144);
    const overBound = utf8StringOfByteLength(262_145);
    const cases: OpenDocumentsSnapshot[] = [
      snapshot(null),
      snapshot({ path: "doc.md", dirty: false, content: "clean buffer" }, [DIRTY_BACKGROUND]),
      snapshot({ path: "doc.md", dirty: true, content: "" }),
      snapshot({ path: "doc.md", dirty: true, content: atBound }),
      snapshot({ path: "doc.md", dirty: true, content: overBound }),
      snapshot({ path: null, label: "Untitled", content: atBound }),
      snapshot({ path: null, label: "Untitled", content: overBound }),
    ];
    for (const openDocuments of cases) {
      const sent = parse(promptWithReferenceData("go", { openDocuments })).openDocuments?.active;
      expect(activeDocumentContentSent(openDocuments)).toBe(
        sent !== null && sent !== undefined && Object.prototype.hasOwnProperty.call(sent, "content"),
      );
    }
  });

  it("names the active document and every other open tab, leaving the user request untouched", () => {
    const composed = promptWithReferenceData("Summarize this message.", {
      openDocuments: snapshot({ path: "drafts/a-commandment.md", dirty: false, content: "body" }, [
        CLEAN,
      ]),
    });
    const { request, openDocuments } = parse(composed);

    expect(request).toBe("Summarize this message.");
    expect(openDocuments).toEqual({
      cowrite_context_version: 1,
      kind: "open_documents",
      active: { path: "drafts/a-commandment.md", unsaved: false },
      also_open: [{ path: "notes/outline.md", unsaved: false }],
    });
  });

  it("carries the exact submit-time buffer for a dirty active document, byte-for-byte", () => {
    const buffer = "# Heading\r\n\ttabbed\ttext with \"quotes\", `backticks` and a trailing space \n";
    const composed = promptWithReferenceData("tidy this", {
      openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: buffer }),
    });
    const { openDocuments, statements } = parse(composed);

    expect(openDocuments?.active).toEqual({
      path: "drafts/a.md",
      unsaved: true,
      content: buffer,
    });
    expect(statements).toEqual([CURRENT_TEXT_STATEMENT]);
  });

  it("omits content entirely — not null — for a clean active document, whatever the file on disk now says", () => {
    // FR-CHAT-4's first `unsaved` limb: a tab the user has not typed into whose file changed
    // underneath it is `unsaved: false`, because the flag is FR-ED-3's dirty state and never a live
    // comparison against disk. The agent reads the fresher file itself (D4).
    //
    // The buffer is deliberately supplied here even though the real producer declines to read it for
    // a clean document: what this pins is that the *requirement's* rule lives at this layer, so a
    // producer that over-supplies still cannot widen what a run carries.
    const composed = promptWithReferenceData("what changed?", {
      openDocuments: snapshot({ path: "drafts/a.md", dirty: false, content: "stale buffer" }),
    });
    const { openDocuments, statements } = parse(composed);

    // "Absent — not null" is the requirement's own wording, and the key check has to come *first*:
    // `toEqual` below would redden on an explicit `content: null` before this line ever ran, and a
    // negative assertion that can never be the one to fail proves nothing about itself (#1762).
    expect(Object.keys(openDocuments?.active ?? {})).not.toContain("content");
    expect(openDocuments?.active).toEqual({ path: "drafts/a.md", unsaved: false });
    expect(statements).toEqual([]);
  });

  it("reports an untitled active document as unsaved with its whole text, though its dirty flag is false", () => {
    // FR-CHAT-4's second `unsaved` limb (D12, FR-ED-8): a document with no file and no saved
    // baseline is unsaved by construction. Its `TabRecord.dirty` is `false` by ratified design, so
    // reading that flag would drop the only route to this document's text — which is why the entry
    // built for it below has no dirty field for anything here to read.
    const composed = promptWithReferenceData("proofread this", {
      openDocuments: snapshot({
        path: null,
        label: "Untitled — recovered from notes/sermon-seed.md",
        content: "scratch text",
      }),
    });
    const { openDocuments, statements } = parse(composed);

    expect(openDocuments?.active).toEqual({
      path: null,
      label: "Untitled — recovered from notes/sermon-seed.md",
      unsaved: true,
      content: "scratch text",
    });
    expect(statements).toEqual([PATHLESS_TEXT_STATEMENT]);
  });

  it("gives a dirty background tab identity and unsaved state but never its content", () => {
    const composed = promptWithReferenceData("summarize the open work", {
      openDocuments: snapshot({ path: "drafts/a.md", dirty: false, content: "active" }, [
        DIRTY_BACKGROUND,
      ]),
    });
    const { openDocuments, statements } = parse(composed);

    expect(openDocuments?.also_open).toEqual([
      { path: "drafts/kenosis-daily.md", unsaved: true },
    ]);
    expect(statements).toEqual([]);
  });

  it("lists a background untitled document by label alone and says its text was not supplied", () => {
    const composed = promptWithReferenceData("what am I working on?", {
      openDocuments: snapshot({ path: "drafts/a.md", dirty: false, content: "active" }, [
        UNTITLED_BACKGROUND,
      ]),
    });
    const { openDocuments, statements } = parse(composed);

    expect(openDocuments?.also_open).toEqual([
      {
        path: null,
        label: "Untitled — recovered from notes/sermon-seed.md",
        unsaved: true,
      },
    ]);
    expect(statements).toEqual([NOT_SUPPLIED_STATEMENT]);
  });

  it("sends the envelope with nothing open rather than leaving the agent to infer it from silence", () => {
    const { openDocuments, statements } = parse(
      promptWithReferenceData("what is this project about?", {
        openDocuments: NO_OPEN_DOCUMENTS,
      }),
    );

    expect(openDocuments).toEqual({
      cowrite_context_version: 1,
      kind: "open_documents",
      active: null,
      also_open: [],
    });
    expect(statements).toEqual([]);
  });

  it("emits exactly one of the two content statements for every entry that carries content", () => {
    for (const active of [
      { path: "drafts/a.md", dirty: true, content: "x" },
      { path: null, label: "Untitled — recovered from b.md", content: "x" },
    ]) {
      const { statements } = parse(
        promptWithReferenceData("go", { openDocuments: snapshot(active) }),
      );
      const contentStatements = statements.filter(
        (line) => line === CURRENT_TEXT_STATEMENT || line === PATHLESS_TEXT_STATEMENT,
      );
      expect(contentStatements).toHaveLength(1);
    }
  });

  it("emits no content statement at all when no entry carries content", () => {
    const { statements } = parse(
      promptWithReferenceData("go", {
        openDocuments: snapshot({ path: "drafts/a.md", dirty: false, content: "clean" }, [
          DIRTY_BACKGROUND,
        ]),
      }),
    );
    expect(statements).toEqual([]);
  });

  describe("content bound (D31)", () => {
    it("ships content whole at exactly the 256 KiB boundary", () => {
      const buffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES);
      const { openDocuments, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: buffer }),
        }),
      );
      expect(openDocuments?.active).toEqual({ path: "drafts/a.md", unsaved: true, content: buffer });
      expect(statements).toEqual([CURRENT_TEXT_STATEMENT]);
    });

    it("withholds content one byte over the 256 KiB boundary, and states (c) — never a silent truncation", () => {
      const buffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const { openDocuments, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: buffer }),
        }),
      );
      // "Absent — not null" first, for the same #1762 reason the clean-document test states above:
      // a negative assertion that `toEqual` would already have failed on proves nothing about itself.
      expect(Object.keys(openDocuments?.active ?? {})).not.toContain("content");
      expect(openDocuments?.active).toEqual({ path: "drafts/a.md", unsaved: true });
      expect(statements).toEqual([OVER_BOUND_STATEMENT]);
    });

    it("names the active document when a co-listed dirty background tab shares its exact content-less shape (D31, FR-CHAT-4)", () => {
      // The axis the deleted matrix cell demanded: `entryFor` gives an over-bound active entry and
      // an ordinary dirty background tab the identical wire shape (`path`, `unsaved: true`, no
      // `content`) — so a statement that named its subject "by shape" would be true of both, or of
      // neither. (c) must name the active document in its own text for the payload to determine
      // which listed entry it describes.
      const buffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const { openDocuments, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/big.md", dirty: true, content: buffer }, [
            DIRTY_BACKGROUND,
          ]),
        }),
      );
      expect(openDocuments?.active).toEqual({ path: "drafts/big.md", unsaved: true });
      expect(openDocuments?.also_open).toEqual([
        { path: "drafts/kenosis-daily.md", unsaved: true },
      ]);
      // Both listed entries share the identical shape; only the over-bound statement's own wording
      // ties it to the active one.
      expect(statements).toEqual([OVER_BOUND_STATEMENT]);
      expect(OVER_BOUND_STATEMENT).toMatch(/^The active document/);
    });

    it("an over-bound active untitled document carries no content and no path, and states (c-pathless) alone — the bound is not waived (D31 clause 5)", () => {
      const buffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const { openDocuments, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({
            path: null,
            label: "Untitled — recovered from notes/sermon-seed.md",
            content: buffer,
          }),
        }),
      );
      expect(Object.keys(openDocuments?.active ?? {})).not.toContain("content");
      expect(openDocuments?.active).toEqual({
        path: null,
        label: "Untitled — recovered from notes/sermon-seed.md",
        unsaved: true,
      });
      expect(statements).toEqual([OVER_BOUND_PATHLESS_STATEMENT]);
    });

    it("names the active document when a co-listed background untitled tab shares (c-pathless)'s shape with (b) (D31, FR-CHAT-4)", () => {
      // The pathless co-occurrence FR-CHAT-4 names by example: an over-bound active untitled
      // document beside a background untitled tab. (c-pathless)'s shape is identical to (b)'s and
      // the two entries here are both `path: null` with no `content` — a reader distinguishes them
      // only because (c-pathless) itself says "The active document" while (b) says nothing about
      // which document it names.
      const buffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const { openDocuments, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(
            { path: null, label: "Untitled — recovered from notes/quiet.md", content: buffer },
            [UNTITLED_BACKGROUND],
          ),
        }),
      );
      expect(openDocuments?.active).toEqual({
        path: null,
        label: "Untitled — recovered from notes/quiet.md",
        unsaved: true,
      });
      expect(openDocuments?.also_open).toEqual([
        {
          path: null,
          label: "Untitled — recovered from notes/sermon-seed.md",
          unsaved: true,
        },
      ]);
      expect(statements).toEqual(
        expect.arrayContaining([NOT_SUPPLIED_STATEMENT, OVER_BOUND_PATHLESS_STATEMENT]),
      );
      expect(statements).toHaveLength(2);
      expect(OVER_BOUND_PATHLESS_STATEMENT).toMatch(/^The active document/);
    });

    it("emits character-identical statements for a just-over-bound buffer and one many times larger — no statement names a size", () => {
      const justOver = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({
            path: "drafts/a.md",
            dirty: true,
            content: utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1),
          }),
        }),
      ).statements;
      const muchLarger = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({
            path: "drafts/a.md",
            dirty: true,
            content: utf8StringOfByteLength(CONTENT_BOUND_BYTES * 3),
          }),
        }),
      ).statements;
      expect(justOver).toEqual([OVER_BOUND_STATEMENT]);
      expect(muchLarger).toEqual([OVER_BOUND_STATEMENT]);
    });

    it("applies the bound per submission, not memoized on the tab — a document crossing back under the bound ships content again", () => {
      const over = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const under = utf8StringOfByteLength(CONTENT_BOUND_BYTES);
      const firstTurn = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: over }),
        }),
      );
      const secondTurn = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: under }),
        }),
      );
      expect(firstTurn.openDocuments?.active).not.toHaveProperty("content");
      expect(secondTurn.openDocuments?.active).toEqual({
        path: "drafts/a.md",
        unsaved: true,
        content: under,
      });
      expect(secondTurn.statements).toEqual([CURRENT_TEXT_STATEMENT]);
    });
  });
});

describe("timeline/referenceData — composing with FR-CHAT-3's quoted selection", () => {
  const QUOTE: QuotedExcerpt = {
    documentPath: "drafts/quoted.md",
    text: 'a line with "quotes"\nand a newline',
    anchor: { text_snapshot: "a line", prefix: "p", suffix: "s" } as unknown as QuotedExcerpt["anchor"],
  };

  it("carries both envelopes, the ambient open-document one first and the quote last", () => {
    const composed = promptWithReferenceData("explain this", {
      openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: "buffer" }),
      quote: QUOTE,
    });
    const { lines, openDocuments, quote } = parse(composed);

    expect(openDocuments).toBeDefined();
    expect(quote).toEqual({
      cowrite_context_version: 1,
      kind: "quoted_selection",
      document_path: "drafts/quoted.md",
      quoted_text: QUOTE.text,
      anchor: QUOTE.anchor,
    });
    const openIndex = lines.findIndex((line) => line.includes('"open_documents"'));
    const quoteIndex = lines.findIndex((line) => line.includes('"quoted_selection"'));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(quoteIndex).toBeGreaterThan(openIndex);
    // The quote stays the more specific referent, last in the block and after the statements that
    // describe the ambient envelope.
    expect(quoteIndex).toBe(lines.length - 1);
  });

  it("never suppresses or rewrites a quote whose document is not among the open tabs", () => {
    const { quote } = parse(
      promptWithReferenceData("explain this", {
        openDocuments: snapshot(CLEAN),
        quote: QUOTE,
      }),
    );
    expect(quote?.document_path).toBe("drafts/quoted.md");
  });

  it("carries no quoted_selection envelope for an unquoted message — FR-CHAT-3 as amended by D30", () => {
    const { quote, openDocuments } = parse(
      promptWithReferenceData("just a message", { openDocuments: snapshot(CLEAN) }),
    );
    expect(quote).toBeUndefined();
    expect(openDocuments).toBeDefined();
  });

  describe("quote bound (D32) and its pathless form (D33)", () => {
    const PATHLESS_QUOTE: QuotedExcerpt = {
      documentPath: null,
      label: "Untitled — recovered from notes/sermon-seed.md",
      text: "a pathless line",
      anchor: {
        text_snapshot: "a pathless line",
        prefix: "p",
        suffix: "s",
      } as unknown as QuotedExcerpt["anchor"],
    };

    it("ships quoted_text whole at exactly the 1 MiB boundary", () => {
      const text = utf8StringOfByteLength(QUOTE_BOUND_BYTES);
      const { quote, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: { ...QUOTE, text },
        }),
      );
      expect(quote).toEqual({
        cowrite_context_version: 1,
        kind: "quoted_selection",
        document_path: QUOTE.documentPath,
        quoted_text: text,
        anchor: QUOTE.anchor,
      });
      expect(statements).toEqual([]);
    });

    it("withholds quoted_text one byte over the 1 MiB boundary, and states (q) — never a silent truncation", () => {
      const text = utf8StringOfByteLength(QUOTE_BOUND_BYTES + 1);
      const { quote, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: { ...QUOTE, text },
        }),
      );
      // "Absent, not null, not an empty string" — checked before the shape assertion for the same
      // #1762 reason the content-bound tests above state.
      expect(Object.keys(quote ?? {})).not.toContain("quoted_text");
      expect(quote).toEqual({
        cowrite_context_version: 1,
        kind: "quoted_selection",
        document_path: QUOTE.documentPath,
        anchor: QUOTE.anchor,
      });
      expect(statements).toEqual([QUOTE_OVER_BOUND_STATEMENT]);
    });

    it("an over-bound pathless quote carries label and document_path: null, no quoted_text, and states (q-pathless) alone (D32×D33)", () => {
      const text = utf8StringOfByteLength(QUOTE_BOUND_BYTES + 1);
      const { quote, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: { ...PATHLESS_QUOTE, text },
        }),
      );
      expect(Object.keys(quote ?? {})).not.toContain("quoted_text");
      expect(quote).toEqual({
        cowrite_context_version: 1,
        kind: "quoted_selection",
        document_path: null,
        label: PATHLESS_QUOTE.label,
        anchor: PATHLESS_QUOTE.anchor,
      });
      expect(statements).toEqual([QUOTE_OVER_BOUND_PATHLESS_STATEMENT]);
    });

    it("an under-bound pathless quote still ships quoted_text whole, with no statement", () => {
      const { quote, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: PATHLESS_QUOTE,
        }),
      );
      expect(quote).toEqual({
        cowrite_context_version: 1,
        kind: "quoted_selection",
        document_path: null,
        label: PATHLESS_QUOTE.label,
        quoted_text: PATHLESS_QUOTE.text,
        anchor: PATHLESS_QUOTE.anchor,
      });
      expect(statements).toEqual([]);
    });

    it("emits character-identical statements for a just-over-bound quote and one many times larger — no statement names a size", () => {
      const justOver = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: { ...QUOTE, text: utf8StringOfByteLength(QUOTE_BOUND_BYTES + 1) },
        }),
      ).statements;
      const muchLarger = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot(CLEAN),
          quote: { ...QUOTE, text: utf8StringOfByteLength(QUOTE_BOUND_BYTES * 2) },
        }),
      ).statements;
      expect(justOver).toEqual([QUOTE_OVER_BOUND_STATEMENT]);
      expect(muchLarger).toEqual([QUOTE_OVER_BOUND_STATEMENT]);
    });

    it("bounds content and the quote independently — an over-bound quote does not withhold an under-bound active buffer, or vice versa", () => {
      const overBoundBuffer = utf8StringOfByteLength(CONTENT_BOUND_BYTES + 1);
      const overBoundQuoteText = utf8StringOfByteLength(QUOTE_BOUND_BYTES + 1);
      const { openDocuments, quote, statements } = parse(
        promptWithReferenceData("go", {
          openDocuments: snapshot({ path: "drafts/a.md", dirty: true, content: overBoundBuffer }),
          quote: { ...QUOTE, text: overBoundQuoteText },
        }),
      );
      expect(openDocuments?.active).toEqual({ path: "drafts/a.md", unsaved: true });
      expect(Object.keys(quote ?? {})).not.toContain("quoted_text");
      expect(statements).toEqual(
        expect.arrayContaining([OVER_BOUND_STATEMENT, QUOTE_OVER_BOUND_STATEMENT]),
      );
      expect(statements).toHaveLength(2);
    });
  });
});
