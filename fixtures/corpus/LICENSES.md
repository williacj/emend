<!-- ABOUTME: Human-readable license summary for the fixture corpus. -->
<!-- ABOUTME: Machine-readable source of truth is manifest.json; this mirrors it for humans. -->

# Fixture corpus — licenses & provenance

Policy (test-plan **TP-Q3**): public domain / CC0 **preferred**, CC-BY and the
permissive code licenses (**MIT / Apache-2.0 / BSD-2-Clause**) **acceptable**,
**no NonCommercial (NC)**, **no ShareAlike (SA)**. The policy is enforced mechanically
by `license_policy_forbids_nc_and_sa` in the `fixtures` crate — a fixture with an
NC or SA license fails the test suite.

`manifest.json` is the machine-readable source of truth. This file mirrors it.

## `prose/` — long-form prose

Two provenances, both permissive. **Real public-domain sermons** from Project
Gutenberg give TP-Q3 the named authors it asks for (Edwards / Wesley / Spurgeon)
and match the target sermon workload directly. **Authored CC0 prose** sits
alongside them for register variety and to carry the large-document performance
fixture. Per test-plan §2 the corpus tests key on synthesized edit *patterns*,
not on any specific prose ("patterns travel; prose doesn't"); the real
`biblical_writing` zero-drift check remains a local-only release-gate step
(test-plan §8).

Each Gutenberg fixture is an **excerpt** with the PG header/footer, trademark
boilerplate, and editorial apparatus removed, a markdown H1 + YAML frontmatter
added, and line endings normalized CRLF→LF; the prose body is verbatim. All three
underlying works and their pre-1929 editions are **public domain in the US**.

| File | Work | License |
|------|------|---------|
| `prose/edwards-sinners-in-the-hands.md` | *Sinners in the Hands of an Angry God*, Jonathan Edwards (d. 1758) — PG #34632 | Public domain (US) |
| `prose/wesley-salvation-by-faith.md` | *Salvation by Faith*, John Wesley (d. 1791) — PG #59743 | Public domain (US) |
| `prose/spurgeon-gleanings.md` | *Gleanings Among the Sheaves*, C. H. Spurgeon (d. 1892) — PG #42657 | Public domain (US) |
| `prose/discourse-on-plain-speech.md` | *A Discourse on Plain Speech* (authored) | CC0 1.0 |
| `prose/meditation-on-attention.md` | *A Meditation on Attention* (authored) | CC0 1.0 |
| `prose/collected-discourses.md` | *Collected Discourses* — large-document performance fixture, authored addresses assembled for size (FR-X-4) | CC0 1.0 |

## `markdown/` — CommonMark / GFM feature coverage (authored, CC0)

**Original content** written for this corpus, released **CC0 1.0**. It covers
the CommonMark and GFM feature *taxonomy* for systematic coverage.

> **Why not the spec docs directly?** The CommonMark/GFM specification text is
> licensed **CC-BY-SA 4.0**, and ShareAlike is excluded by the policy above.
> Markdown *features* are not copyrightable — only the spec's specific prose is —
> so these fixtures demonstrate the same features with original content.

| File | Covers |
|------|--------|
| `markdown/commonmark-inline.md` | emphasis, code spans, links, images, autolinks, escapes, entities, hard breaks, raw inline HTML |
| `markdown/commonmark-blocks.md` | ATX/setext headings, blockquotes, ordered/unordered/nested lists, indented & fenced code, thematic breaks, HTML blocks |
| `markdown/gfm-extensions.md` | tables (with alignment), task lists, strikethrough, bare autolinks, footnotes |
| `markdown/frontmatter-yaml.md` | YAML front matter (structural; must round-trip byte-for-byte, TD-2) |

## `technical/` — technical docs

Authored CC0 docs plus one **real permissively-licensed** doc — the Rust Book's
data-types chapter, taken verbatim for genuine native markdown (alignment tables,
code fences, mdbook `{{#include}}` directives). Front matter, tables,
multi-language code fences, blockquotes, and nested lists (tables/code/frontmatter
variety per TP-Q3).

| File | Covers | License |
|------|--------|---------|
| `technical/api-reference.md` | front matter, alignment tables, bash/json/typescript fences, blockquotes, nested lists | CC0 1.0 |
| `technical/changelog.md` | nested lists, reference links, tight/loose list mixing | CC0 1.0 |
| `technical/rust-book-data-types.md` | *The Rust Programming Language* ch. 3.2 — real tables + code fences ([rust-lang/book](https://github.com/rust-lang/book/blob/main/src/ch03-02-data-types.md)) | MIT OR Apache-2.0 |

## `fidelity/` — byte-level edge cases (authored, CC0)

**Original content**, released **CC0 1.0**. Targets P1 round-trip fidelity —
these must survive save∘load byte-identical.

| File | Edge case |
|------|-----------|
| `fidelity/crlf.md` | CR+LF line endings throughout |
| `fidelity/bom.md` | leading UTF-8 byte-order mark (EF BB BF) |
| `fidelity/no-final-newline.md` | file ends without a trailing newline |
| `fidelity/mixed-line-endings.md` | LF and CRLF mixed in one file |
| `fidelity/unicode.md` | smart quotes, dashes, non-Latin scripts, combining marks, ZWJ emoji, significant trailing whitespace |
