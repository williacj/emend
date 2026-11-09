// ABOUTME: The frontend markdown *structural* parser (TD-13) — a `@lezer/markdown` (GFM) grammar
// ABOUTME: wrapped as a CM6 `Language`, plus stable heading classes for the gated rich projection.
import { defineLanguageFacet, HighlightStyle, Language, languageDataProp } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { GFM, parser } from "@lezer/markdown";

/**
 * Structural markdown parsing (headings, emphasis, lists, blockquotes — the rest of CommonMark/GFM)
 * is a render-only concern per **TD-13**: it never crosses MCP, never mutates the source-of-truth
 * string (TD-2/P1), so it lives here in the frontend `editor/` module rather than in Rust
 * `textops/`, which stays the canonical-coordinate authority (TD-6) for CriticMarkup, anchors, and
 * diffs. `textops::critic` remains the source of truth for any CriticMarkup redline layered on top
 * of these decorations — this parser never touches CriticMarkup syntax.
 *
 * `@lezer/markdown`'s `MarkdownParser` is a plain `Parser`, not the `LRParser` `LRLanguage.define`
 * expects (it wraps an inner LR parser for block/inline mixing) — so this wires the base `Language`
 * class directly, the same seam `@codemirror/lang-markdown` itself builds on, attaching a language
 * data facet to the parser's top node via `languageDataProp`.
 */
const markdownLanguageData = defineLanguageFacet();
const markdownParser = parser.configure([
  GFM,
  { props: [languageDataProp.add((type) => (type.isTop ? markdownLanguageData : undefined))] },
]);
export const markdownLanguage = new Language(markdownLanguageData, markdownParser, [], "markdown");

/**
 * Stable heading classes via CM6's `HighlightStyle`/`syntaxHighlighting` mechanism, per SPIKE-3's
 * production note: line decorations for heading size cost CM6 an extra layout-measure pass per its
 * own docs, so the sanctioned alternative — tag-based highlighting over the syntax tree — is used.
 * `structuralTheme` owns their rich-view typography and gates it from Markdown/source view.
 */
export const headingHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-heading1" },
  { tag: tags.heading2, class: "cm-heading2" },
  { tag: tags.heading3, class: "cm-heading3" },
  { tag: tags.heading4, class: "cm-heading4" },
  { tag: tags.heading5, class: "cm-heading5" },
  { tag: tags.heading6, class: "cm-heading6" },
]);
