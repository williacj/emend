// ABOUTME: Fixture generator for the structural-decorations perf benchmark (test-plan §6, SPIKE-3
// ABOUTME: basis) — a large markdown document mixing prose filler with structural regions.
const PROSE_LINE = "The quick brown fox jumps over the lazy dog while the editor renders every visible line.";

export interface LargeMarkdownDocOptions {
  /** Approximate total document size in UTF-16 code units. Defaults to SPIKE-3's ~1MB basis. */
  targetBytes?: number;
  /** Approximate number of structural regions (headings/emphasis/lists/blockquotes), evenly spaced
   * through the document. Defaults to SPIKE-3's ~500-region basis. */
  regionCount?: number;
}

/** One structural region per index, cycling through the four construct kinds
 * `structuralDecorations.ts` decorates — headings, emphasis, nested lists, blockquotes. */
const CONSTRUCTS: ((i: number) => string)[] = [
  (i) => `## Section ${i}`,
  (i) => `Some *italic* and **bold** text in paragraph ${i}.`,
  (i) => `- list item ${i}\n  - nested item ${i}`,
  (i) => `> a blockquote in region ${i}`,
];

/**
 * Builds a markdown document of roughly `targetBytes` with roughly `regionCount` structural
 * regions spaced through plain-prose filler — the SPIKE-3 basis test-plan §6 sizes its "open +
 * render" and "keystroke latency" perf budgets against (~1MB doc, ~500 markup regions).
 */
export function buildLargeMarkdownDoc({
  targetBytes = 1_000_000,
  regionCount = 500,
}: LargeMarkdownDocOptions = {}): string {
  const bytesPerRegion = Math.max(1, Math.floor(targetBytes / regionCount));
  const lines: string[] = [];
  let bytesSoFar = 0;

  for (let region = 0; region < regionCount; region++) {
    const construct = CONSTRUCTS[region % CONSTRUCTS.length](region);
    lines.push(construct);
    bytesSoFar += construct.length + 1;

    const regionEnd = (region + 1) * bytesPerRegion;
    while (bytesSoFar < regionEnd) {
      lines.push(PROSE_LINE);
      bytesSoFar += PROSE_LINE.length + 1;
    }
  }

  return lines.join("\n");
}
