// ABOUTME: CriticMarkup parser — locates {++ins++}, {--del--}, {~~old~>new~~} in raw markdown.
// ABOUTME: Byte offsets (TD-6); excludes fenced/indented/inline code and YAML frontmatter.

//! CriticMarkup parsing over the raw markdown string (FR-ED-4, TD-6).
//!
//! The raw file text is the canonical coordinate space (TD-6): every offset a
//! `Markup` reports is a **byte** index into the exact string passed to [`parse`],
//! braces included. This is a deliberate departure from the v1 parser, which
//! indexed by UTF-16 code unit (JS string index) and silently split astral
//! characters (e.g. `🎉`, a surrogate pair) — byte offsets are what anchors and
//! accept/reject apply (P1-3) index into, so the parser measures in bytes.
//!
//! Only the three change markers Cowrite persists are recognised (functional-spec
//! §"CriticMarkup in the markdown"): insertion, deletion, substitution. CriticMarkup
//! comments (`{>> <<}`) and highlights (`{== ==}`) are intentionally **not** parsed —
//! Cowrite carries review commentary in the `.comments/` sidecar, not inline.
//!
//! Whitespace-only markup is first-class. The v1 parser discarded any marker whose
//! content trimmed to empty (`content.trim() === ""`), which is the root cause of the
//! "whitespace-leak" bug family: an inserted space `{++ ++}` was treated as if it did
//! not exist, so its literal braces leaked into the clean view. Here `{++ ++}` parses
//! as an insertion whose content is a single space. A *truly* empty marker (`{++++}`)
//! has no content and does not parse — that is the natural floor, not a special case.
//!
//! # Exclusion scope and known limitations
//!
//! Markup is not read out of **fenced code**, **inline code spans**, **YAML
//! frontmatter**, or **indented code blocks**. Block structure is modelled with just
//! enough CommonMark to be safe in both failure directions. Indent thresholds are
//! measured *relative to the open list container* — a stack of list-item content
//! indents — so both indented code (#75) and code **fences** (#187) inside a list
//! item are recognised at `container + ≤3` columns rather than by absolute column:
//! `1. step\n\n    a {++real++} change` stays a continuation **paragraph** whose
//! change is real, while a line four columns past the item's content indent is code.
//! Indented code never interrupts a paragraph, so lazy continuations keep their
//! markup no matter how indented. A fence opened inside an item is closed either by
//! its container-relative closing fence or, if none appears, by the item ending — a
//! non-blank line dedented below the item's content indent (CommonMark item
//! truncation) — so markup past that point is reprocessed and still parses instead of
//! being swallowed to end of document. Dropping a real change is the harmful
//! direction (see the #38 review saga); the deliberate simplifications below
//! therefore all err toward *parsing* markup:
//!
//! - Blockquotes are not modelled as containers: `>     {++x++}` parses rather than
//!   being excluded as code-in-quote.
//! - Setext underlines / thematic breaks are not block boundaries here; a paragraph
//!   simply continues, so no code block can open where one of those closed it.

use std::ops::Range;

/// The kind of a CriticMarkup change, carrying the byte ranges of its inner text
/// segments (indices into the raw document string passed to [`parse`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkupKind {
    /// `{++text++}` — text proposed for addition. `text` is the content between
    /// the delimiters (accepted → kept, rejected → removed).
    Insertion { text: Range<usize> },
    /// `{--text--}` — text proposed for removal. `text` is the content between
    /// the delimiters (accepted → removed, rejected → kept).
    Deletion { text: Range<usize> },
    /// `{~~old~>new~~}` — a replacement. `old` is kept on reject, `new` on accept.
    Substitution {
        old: Range<usize>,
        new: Range<usize>,
    },
}

/// One CriticMarkup change located in the raw document.
///
/// `full` is the byte range of the entire marker including its delimiters; slicing
/// the source string by `full` reproduces the marker verbatim. `kind` carries the
/// inner segment ranges, which always lie strictly inside `full`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Markup {
    /// Byte range of the whole marker, delimiters included.
    pub full: Range<usize>,
    /// The change kind and its inner text-segment byte ranges.
    pub kind: MarkupKind,
}

/// Parse every CriticMarkup change in `doc`, in document order.
///
/// Coordinates are byte offsets into `doc` (TD-6). Markers inside fenced code
/// blocks (list-aware, #187), indented code blocks (list-aware, #75), inline code
/// spans, and YAML frontmatter are excluded — literal braces there are content, not
/// markup. Malformed or unterminated markers (no closing delimiter, or empty
/// content) are left as literal text.
///
/// The returned changes never overlap and are sorted by `full.start`.
// @anchor:critic-markup-parse
pub fn parse(doc: &str) -> Vec<Markup> {
    let bytes = doc.as_bytes();
    let zones = exclusion_zones(bytes);

    let mut out = Vec::new();
    let mut i = 0usize;
    let mut zi = 0usize; // cursor into `zones` (sorted, disjoint)

    while i < bytes.len() {
        // Advance the zone cursor past zones that end at or before `i`.
        while zi < zones.len() && zones[zi].end <= i {
            zi += 1;
        }
        // If `i` sits inside an exclusion zone, jump to the zone's end.
        if zi < zones.len() && zones[zi].start <= i {
            i = zones[zi].end;
            continue;
        }

        if bytes[i] == b'{' {
            if let Some(markup) = match_marker(bytes, i) {
                i = markup.full.end;
                out.push(markup);
                continue;
            }
        }
        i += 1;
    }

    out
}

/// Try to match a marker whose opening `{` is at `open`. Returns `None` if the
/// three bytes at `open` are not a known opener, or the marker is unterminated /
/// empty (left as literal text).
fn match_marker(bytes: &[u8], open: usize) -> Option<Markup> {
    // Need at least `{XY` where XY selects the marker family.
    let a = *bytes.get(open + 1)?;
    let b = *bytes.get(open + 2)?;
    let content_start = open + 3;

    match (a, b) {
        (b'+', b'+') => {
            // {++text++} — content must be >= 1 byte (closer strictly after start).
            let close = find(bytes, b"++}", content_start)?;
            if close <= content_start {
                return None;
            }
            Some(Markup {
                full: open..close + 3,
                kind: MarkupKind::Insertion {
                    text: content_start..close,
                },
            })
        }
        (b'-', b'-') => {
            let close = find(bytes, b"--}", content_start)?;
            if close <= content_start {
                return None;
            }
            Some(Markup {
                full: open..close + 3,
                kind: MarkupKind::Deletion {
                    text: content_start..close,
                },
            })
        }
        (b'~', b'~') => {
            // {~~old~>new~~} — old >= 1 byte (separator strictly after start),
            // new >= 0 bytes (an empty replacement is a degenerate deletion but
            // still well-formed). First `~>` bounds old; first following `~~}`
            // closes — matching the v1 lazy semantics, first-closer-wins.
            let sep = find(bytes, b"~>", content_start)?;
            if sep <= content_start {
                return None;
            }
            let new_start = sep + 2;
            let close = find(bytes, b"~~}", new_start)?;
            Some(Markup {
                full: open..close + 3,
                kind: MarkupKind::Substitution {
                    old: content_start..sep,
                    new: new_start..close,
                },
            })
        }
        _ => None,
    }
}

/// Index of the first occurrence of `needle` in `haystack` at or after `from`.
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

// ---------------------------------------------------------------------------
// Exclusion zones: fenced code, inline code, YAML frontmatter
// ---------------------------------------------------------------------------

/// Byte ranges the parser must not read markup out of: YAML frontmatter, fenced
/// code blocks (list-aware, #187), indented code blocks (list-aware, #75), and
/// inline code spans.
/// The returned ranges are sorted by start and disjoint: the scan is line-ordered,
/// each line lands in at most one zone kind, and inline spans are scanned only on
/// lines that are not code.
///
/// Exclusion is decided by a marker's **opening** position: a marker that opens
/// outside every zone is parsed even if its content happens to run into one. This
/// matches the v1 rule and keeps the scan single-pass; markers do not legitimately
/// straddle a code fence.
fn exclusion_zones(bytes: &[u8]) -> Vec<Range<usize>> {
    let lines = split_lines(bytes);
    let mut zones = Vec::new();
    let mut idx = 0usize;

    // YAML frontmatter: only when the very first line is exactly `---`, closed by
    // a later line that is exactly `---` or `...`. An unterminated opener is not
    // frontmatter (nothing is excluded).
    if let Some(first) = lines.first() {
        if line_content(bytes, first) == b"---" {
            for (k, ln) in lines.iter().enumerate().skip(1) {
                let content = line_content(bytes, ln);
                if content == b"---" || content == b"..." {
                    zones.push(0..ln.next);
                    idx = k + 1;
                    break;
                }
            }
        }
    }

    // Fenced code, indented code, and inline code, line by line. Indented-code
    // detection (#75) needs just enough block structure to be safe in both
    // directions: a stack of open list-item content indents (the CommonMark
    // 4-column threshold is measured *relative to the container*), and an
    // open-paragraph flag (indented code can never interrupt a paragraph, so
    // lazy/continuation lines keep their markup no matter how indented).
    let mut containers: Vec<usize> = Vec::new();
    let mut in_paragraph = false;
    let mut in_code = false;

    while idx < lines.len() {
        let ln = &lines[idx];
        let content = line_content(bytes, ln);
        let (cols, nsp) = measure_indent(content);

        // Blank line: closes any paragraph. List items and an open indented
        // code block survive blanks — the next non-blank line decides.
        if nsp == content.len() {
            in_paragraph = false;
            idx += 1;
            continue;
        }

        // An open indented code block continues while lines stay at or beyond
        // the container-relative threshold; a dedent closes it and the line
        // falls through to ordinary processing.
        if in_code {
            if cols >= container_indent(&containers) + 4 {
                zones.push(ln.start..ln.next);
                idx += 1;
                continue;
            }
            in_code = false;
        }

        // Lazy continuation: a paragraph absorbs any non-blank line that does
        // not start a block able to interrupt it — structure is unchanged.
        let interrupter = in_paragraph && interrupts_paragraph(bytes, ln, cols, nsp, &containers);
        if in_paragraph && !interrupter {
            inline_code_spans(bytes, ln.start, ln.content_end, &mut zones);
            idx += 1;
            continue;
        }
        in_paragraph = false;

        // Close list items this line has dedented out of, then measure the
        // indent relative to the innermost still-open item.
        while containers.last().is_some_and(|&ci| cols < ci) {
            containers.pop();
        }

        // Indented code block: >= 4 columns beyond the container's content
        // indent, on a line that is not interrupting a paragraph.
        if !interrupter && cols >= container_indent(&containers) + 4 {
            zones.push(ln.start..ln.next);
            in_code = true;
            idx += 1;
            continue;
        }

        if let Some((fence_char, fence_len)) =
            fence_opener(bytes, ln, container_indent(&containers))
        {
            // Consume the fenced region. Opener and closer are measured relative
            // to the open container (#187). An unclosed fence runs to end of doc,
            // *unless* the list item it sits in ends first: a non-blank line
            // dedented below the item's content indent truncates the item and the
            // fence with it (CommonMark item truncation), so markup after that
            // point is reprocessed and still parses rather than being swallowed.
            let threshold = container_indent(&containers);
            let mut end = bytes.len();
            let mut consumed = lines.len();
            for (k, close) in lines.iter().enumerate().skip(idx + 1) {
                let cc = line_content(bytes, close);
                let (ccols, cnsp) = measure_indent(cc);
                if cnsp == cc.len() {
                    continue; // blank lines stay inside the code block
                }
                if ccols < threshold {
                    // The containing item ended: close the fence before this line
                    // and let the main loop reprocess it (popping the container).
                    end = close.start;
                    consumed = k;
                    break;
                }
                if is_fence_closer(bytes, close, fence_char, fence_len, threshold) {
                    end = close.next;
                    consumed = k + 1;
                    break;
                }
            }
            zones.push(ln.start..end);
            idx = consumed;
            continue;
        }

        if let Some(mut item) = list_item(content, nsp, cols) {
            // Open the item — and any further items declared on the same line
            // (`- - x` nests) — so continuation thresholds stack correctly.
            loop {
                containers.push(item.content_indent);
                if item.code_start {
                    // Marker followed by >= 5 spaces: the item's first block is
                    // indented code starting on the marker line (CommonMark).
                    zones.push(ln.start + item.content_byte..ln.next);
                    in_code = true;
                    break;
                }
                if item.content_byte == content.len() {
                    break; // empty item — no paragraph opened
                }
                match list_item(content, item.content_byte, item.content_col) {
                    Some(inner) => item = inner,
                    None => {
                        in_paragraph = true;
                        inline_code_spans(bytes, ln.start, ln.content_end, &mut zones);
                        break;
                    }
                }
            }
            idx += 1;
            continue;
        }

        if atx_heading(content, nsp) {
            // A heading is a block boundary — code may open on the next line.
            inline_code_spans(bytes, ln.start, ln.content_end, &mut zones);
            idx += 1;
            continue;
        }

        in_paragraph = true;
        inline_code_spans(bytes, ln.start, ln.content_end, &mut zones);
        idx += 1;
    }

    zones
}

/// Content indent (in columns) of the innermost open list item; 0 at top level.
fn container_indent(containers: &[usize]) -> usize {
    containers.last().copied().unwrap_or(0)
}

/// Leading-whitespace measure of a line's content: `(columns, byte index of the
/// first non-whitespace byte)`, expanding tabs to 4-column stops (CommonMark).
/// A fully blank line reports its full byte length as the index.
fn measure_indent(content: &[u8]) -> (usize, usize) {
    let mut col = 0usize;
    for (i, &c) in content.iter().enumerate() {
        match c {
            b' ' => col += 1,
            b'\t' => col += 4 - col % 4,
            _ => return (col, i),
        }
    }
    (col, content.len())
}

/// A list-item marker parsed from a line, carrying what the indented-code rule
/// needs: the content indent continuation lines are measured against, where the
/// item's own first-line content starts, and the CommonMark special cases.
struct ListItem {
    /// Columns a continuation line must reach to stay inside this item.
    content_indent: usize,
    /// Byte offset (within the line's content) where item content starts; equal
    /// to the content length for an empty item.
    content_byte: usize,
    /// Column of that content start.
    content_col: usize,
    /// Marker followed by >= 5 spaces: the item starts with indented code.
    code_start: bool,
    /// Whether this marker may interrupt a paragraph (CommonMark: non-empty,
    /// and an ordered marker must start at 1).
    interrupts: bool,
}

/// Parse a list-item marker whose first byte is at `content[nsp..]`, `col`
/// columns in: `-`/`+`/`*`, or 1–9 digits followed by `.`/`)`, then whitespace
/// or end of line. Returns `None` when the line is not a list item.
fn list_item(content: &[u8], nsp: usize, col: usize) -> Option<ListItem> {
    let rest = &content[nsp..];
    let (marker_len, ordered_start) = match *rest.first()? {
        b'-' | b'+' | b'*' => (1, None),
        b'0'..=b'9' => {
            let digits = rest.iter().take_while(|c| c.is_ascii_digit()).count();
            if digits > 9 {
                return None;
            }
            if !matches!(rest.get(digits), Some(b'.') | Some(b')')) {
                return None;
            }
            let n: u64 = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
            (digits + 1, Some(n))
        }
        _ => return None,
    };
    if !matches!(rest.get(marker_len), None | Some(b' ') | Some(b'\t')) {
        return None;
    }

    // Measure the whitespace run after the marker (digits and punctuation are
    // single-column, so the marker ends at `col + marker_len`).
    let marker_end_col = col + marker_len;
    let mut content_col = marker_end_col;
    let mut content_byte = nsp + marker_len;
    while let Some(&c) = content.get(content_byte) {
        match c {
            b' ' => content_col += 1,
            b'\t' => content_col += 4 - content_col % 4,
            _ => break,
        }
        content_byte += 1;
    }

    let empty = content_byte == content.len();
    let spaces = content_col - marker_end_col;
    // CommonMark: 1–4 spaces after the marker set the content indent; an empty
    // item or one starting with indented code (>= 5 spaces) counts marker + 1.
    let (content_indent, code_start) = if !empty && spaces > 4 {
        (marker_end_col + 1, true)
    } else if empty {
        (marker_end_col + 1, false)
    } else {
        (content_col, false)
    };

    Some(ListItem {
        content_indent,
        content_byte,
        content_col,
        code_start,
        interrupts: !empty && ordered_start.is_none_or(|n| n == 1),
    })
}

/// Whether `content[nsp..]` is an ATX heading opener: 1–6 `#` then whitespace
/// or end of line.
fn atx_heading(content: &[u8], nsp: usize) -> bool {
    let rest = &content[nsp..];
    let hashes = rest.iter().take_while(|&&c| c == b'#').count();
    (1..=6).contains(&hashes) && matches!(rest.get(hashes), None | Some(b' ') | Some(b'\t'))
}

/// Whether a non-blank line can interrupt an open paragraph (CommonMark): a
/// fence, an ATX heading, or a list-item marker — the marker must be non-empty
/// and (if ordered) start at 1, except inside an open list, where any sibling
/// or deeper marker starts a new item. A line at or beyond the indented-code
/// threshold can never interrupt, since indented code cannot.
fn interrupts_paragraph(
    bytes: &[u8],
    ln: &Line,
    cols: usize,
    nsp: usize,
    containers: &[usize],
) -> bool {
    if cols >= container_indent(containers) + 4 {
        return false;
    }
    let content = line_content(bytes, ln);
    fence_opener(bytes, ln, container_indent(containers)).is_some()
        || atx_heading(content, nsp)
        || list_item(content, nsp, cols)
            .is_some_and(|item| item.interrupts || !containers.is_empty())
}

/// A line's byte span: `start..content_end` excludes the line terminator; `next`
/// is the start of the following line (or the buffer length at EOF).
struct Line {
    start: usize,
    content_end: usize,
    next: usize,
}

fn line_content<'a>(bytes: &'a [u8], line: &Line) -> &'a [u8] {
    &bytes[line.start..line.content_end]
}

/// Split into lines, recognising `\n` and `\r\n` terminators. A trailing newline
/// does not yield a spurious empty final line.
fn split_lines(bytes: &[u8]) -> Vec<Line> {
    let mut lines = Vec::new();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let mut j = i;
        while j < n && bytes[j] != b'\n' {
            j += 1;
        }
        let mut content_end = j;
        if content_end > i && bytes[content_end - 1] == b'\r' {
            content_end -= 1;
        }
        let next = if j < n { j + 1 } else { n };
        lines.push(Line {
            start: i,
            content_end,
            next,
        });
        if j >= n {
            break;
        }
        i = j + 1;
    }
    lines
}

/// If `line` opens a fenced code block, return its fence character and length.
/// Recognition is **container-relative** (#187): the fence indent must fall within
/// 3 columns of the open item's `container` content indent — CommonMark measures
/// the ≤3-space fence indent relative to the list container, not the absolute
/// column. A backtick fence's info string may not contain a backtick (CommonMark).
fn fence_opener(bytes: &[u8], line: &Line, container: usize) -> Option<(u8, usize)> {
    let content = line_content(bytes, line);
    let (cols, nsp) = measure_indent(content);
    if cols < container || cols > container + 3 {
        return None;
    }
    let rest = &content[nsp..];
    let fence_char = *rest.first()?;
    if fence_char != b'`' && fence_char != b'~' {
        return None;
    }
    let len = rest.iter().take_while(|&&c| c == fence_char).count();
    if len < 3 {
        return None;
    }
    let info = &rest[len..];
    if fence_char == b'`' && info.contains(&b'`') {
        return None;
    }
    Some((fence_char, len))
}

/// Whether `line` closes a fence of `fence_char` opened at length `open_len`,
/// measured relative to the `container` content indent (#187): the closer's indent
/// must be within 3 columns of the container, then at least `open_len` of the fence
/// char, then only spaces. A "```" indented ≥4 columns past the container is code
/// content, not a closer.
fn is_fence_closer(
    bytes: &[u8],
    line: &Line,
    fence_char: u8,
    open_len: usize,
    container: usize,
) -> bool {
    let content = line_content(bytes, line);
    let (cols, nsp) = measure_indent(content);
    if cols < container || cols > container + 3 {
        return false;
    }
    let rest = &content[nsp..];
    let len = rest.iter().take_while(|&&c| c == fence_char).count();
    if len < open_len {
        return false;
    }
    rest[len..].iter().all(|&c| c == b' ')
}

/// Find inline code spans within a single line's content range and push them as
/// exclusion zones. A run of N backticks opens a span; the next run of *exactly*
/// N backticks closes it (CommonMark). An unclosed run is literal (no zone).
/// Restricting to one line keeps the scan from swallowing block structure — inline
/// code with literal CriticMarkup braces is single-line in practice.
fn inline_code_spans(bytes: &[u8], start: usize, end: usize, zones: &mut Vec<Range<usize>>) {
    let mut i = start;
    while i < end {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let open_len = backtick_run(bytes, i, end);
        let after_open = i + open_len;
        let mut j = after_open;
        let mut closed = false;
        while j < end {
            if bytes[j] == b'`' {
                let run = backtick_run(bytes, j, end);
                if run == open_len {
                    zones.push(i..j + run);
                    i = j + run;
                    closed = true;
                    break;
                }
                j += run;
            } else {
                j += 1;
            }
        }
        if !closed {
            i = after_open;
        }
    }
}

/// Length of the backtick run starting at `i`, bounded by `end`.
fn backtick_run(bytes: &[u8], i: usize, end: usize) -> usize {
    let mut n = 0usize;
    while i + n < end && bytes[i + n] == b'`' {
        n += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (tag, full-marker text, segment 1, segment 2) — a readable projection of a
    /// parsed `Markup` used by assertions. Slicing here also proves every reported
    /// range is a valid char boundary (a bad range would panic the slice).
    fn describe(doc: &str, m: &Markup) -> (&'static str, String, String, String) {
        let full = doc[m.full.clone()].to_string();
        match &m.kind {
            MarkupKind::Insertion { text } => {
                ("ins", full, doc[text.clone()].to_string(), String::new())
            }
            MarkupKind::Deletion { text } => {
                ("del", full, doc[text.clone()].to_string(), String::new())
            }
            MarkupKind::Substitution { old, new } => (
                "sub",
                full,
                doc[old.clone()].to_string(),
                doc[new.clone()].to_string(),
            ),
        }
    }

    fn described(doc: &str) -> Vec<(&'static str, String, String, String)> {
        parse(doc).iter().map(|m| describe(doc, m)).collect()
    }

    // --- basic parsing -----------------------------------------------------

    #[test]
    fn parses_a_simple_insertion() {
        let doc = "Hello {++world++}!";
        let ms = parse(doc);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].full, 6..17);
        assert_eq!(&doc[ms[0].full.clone()], "{++world++}");
        assert_eq!(
            describe(doc, &ms[0]),
            ("ins", "{++world++}".into(), "world".into(), "".into())
        );
    }

    #[test]
    fn parses_a_simple_deletion() {
        let doc = "Hello {--world--}!";
        assert_eq!(
            described(doc),
            vec![("del", "{--world--}".into(), "world".into(), "".into())]
        );
    }

    #[test]
    fn parses_a_substitution() {
        let doc = "Hello {~~old~>new~~}!";
        let ms = parse(doc);
        assert_eq!(&doc[ms[0].full.clone()], "{~~old~>new~~}");
        assert_eq!(
            described(doc),
            vec![("sub", "{~~old~>new~~}".into(), "old".into(), "new".into())]
        );
    }

    #[test]
    fn parses_multiple_changes_in_document_order() {
        let doc = "A {++B++} C {--D--} E {~~F~>G~~} H";
        assert_eq!(
            described(doc),
            vec![
                ("ins", "{++B++}".into(), "B".into(), "".into()),
                ("del", "{--D--}".into(), "D".into(), "".into()),
                ("sub", "{~~F~>G~~}".into(), "F".into(), "G".into()),
            ]
        );
    }

    #[test]
    fn full_range_slices_to_the_whole_marker() {
        // Delimiters are part of the span (accept/reject replaces `full`).
        for doc in [
            "Hello {++world++}!",
            "Hello {--world--}!",
            "Hello {~~old~>new~~}!",
        ] {
            let m = &parse(doc)[0];
            let s = &doc[m.full.clone()];
            assert!(s.starts_with('{') && s.ends_with('}'), "{s:?}");
        }
    }

    // --- adjacency ---------------------------------------------------------

    #[test]
    fn adjacent_markers_meet_at_an_exact_boundary() {
        let doc = "{++first++}{++second++}";
        let ms = parse(doc);
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].full.end, ms[1].full.start); // no gap, no overlap
        assert_eq!(described(doc)[1].1, "{++second++}");
    }

    #[test]
    fn adjacent_deletion_then_insertion() {
        let doc = "{--old--}{++new++}";
        assert_eq!(
            described(doc),
            vec![
                ("del", "{--old--}".into(), "old".into(), "".into()),
                ("ins", "{++new++}".into(), "new".into(), "".into()),
            ]
        );
    }

    // --- exclusion: fenced code -------------------------------------------

    #[test]
    fn skips_markup_inside_a_fenced_code_block() {
        assert!(parse("```\n{++inside code++}\n```").is_empty());
    }

    #[test]
    fn skips_markup_inside_a_fence_with_language_tag() {
        assert!(parse("```javascript\n{++inside++}\n```").is_empty());
    }

    #[test]
    fn parses_around_a_fence_but_not_inside() {
        let doc = "{++before++}\n\n```\n{++inside++}\n```\n\n{++after++}";
        let got = described(doc);
        assert_eq!(
            got.iter().map(|d| d.2.clone()).collect::<Vec<_>>(),
            vec!["before", "after"]
        );
    }

    #[test]
    fn tilde_fences_are_excluded_too() {
        assert!(parse("~~~\n{--x--}\n~~~").is_empty());
    }

    #[test]
    fn unclosed_fence_excludes_to_end_of_document() {
        // CommonMark: an unclosed fence runs to EOF — nothing after it is markup.
        assert!(parse("```\n{++never closed++}").is_empty());
    }

    #[test]
    fn crlf_fences_are_recognised() {
        assert!(parse("```\r\n{++inside++}\r\n```\r\n").is_empty());
    }

    // --- exclusion: inline code -------------------------------------------

    #[test]
    fn skips_markup_inside_inline_code() {
        assert!(parse("Use `{++syntax++}` for insertions.").is_empty());
    }

    #[test]
    fn parses_around_inline_code_but_not_inside() {
        let doc = "{++before++} `{++inside++}` {++after++}";
        let got = described(doc);
        assert_eq!(
            got.iter().map(|d| d.2.clone()).collect::<Vec<_>>(),
            vec!["before", "after"]
        );
    }

    #[test]
    fn double_backtick_inline_code_span_is_excluded() {
        // A run of N backticks closes only on a run of exactly N (CommonMark) —
        // the single backtick inside does not close the span.
        assert!(parse("``{++has ` tick++}``").is_empty());
    }

    // --- exclusion: frontmatter -------------------------------------------

    #[test]
    fn skips_markup_inside_yaml_frontmatter() {
        assert!(parse("---\ntitle: {++test++}\n---\n\nBody text").is_empty());
    }

    #[test]
    fn parses_markup_after_frontmatter() {
        let doc = "---\ntitle: test\n---\n\n{++Body text++}";
        assert_eq!(
            described(doc),
            vec![(
                "ins",
                "{++Body text++}".into(),
                "Body text".into(),
                "".into()
            )]
        );
    }

    #[test]
    fn dotdotdot_closes_frontmatter() {
        let doc = "---\ntitle: {++x++}\n...\n{++after++}";
        // The `...` closes the block; the marker inside stays excluded, the one
        // after is parsed.
        assert_eq!(
            described(doc),
            vec![("ins", "{++after++}".into(), "after".into(), "".into())]
        );
    }

    #[test]
    fn mid_document_dashes_are_not_frontmatter() {
        let doc = "Some text\n\n---\n\n{++more text++}";
        assert_eq!(
            described(doc),
            vec![(
                "ins",
                "{++more text++}".into(),
                "more text".into(),
                "".into()
            )]
        );
    }

    #[test]
    fn unterminated_frontmatter_is_not_excluded() {
        // No closing delimiter → not frontmatter; the marker is ordinary body.
        let doc = "---\n{++x++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++x++}".into(), "x".into(), "".into())]
        );
    }

    // --- exclusion: indented code blocks (list-aware, #75) ------------------
    // CommonMark measures the 4-column code threshold relative to the list
    // container, and indented code can never interrupt a paragraph. Both halves
    // matter: the first excludes literal markup in real code, the second keeps
    // markup in continuation/lazy paragraphs parsing (dropping a real change is
    // the harmful direction — see the #38 review saga).

    #[test]
    fn skips_markup_inside_a_top_level_indented_code_block() {
        assert!(parse("A paragraph.\n\n    {++inside code++}\n").is_empty());
    }

    #[test]
    fn indented_code_at_document_start_is_excluded() {
        assert!(parse("    {++code++}\n\nBody.").is_empty());
    }

    #[test]
    fn tab_indented_code_is_excluded() {
        // A tab advances to the next 4-column stop — one tab reaches the threshold.
        assert!(parse("Para.\n\n\t{++x++}").is_empty());
    }

    #[test]
    fn markup_in_a_list_item_continuation_paragraph_parses() {
        // The exact case that reverted the first cut in #38: content indent is 3
        // ("1. "), so 4 columns is a *paragraph* in the item, not code.
        let doc = "1. step\n\n    a {++real++} change";
        assert_eq!(
            described(doc),
            vec![("ins", "{++real++}".into(), "real".into(), "".into())]
        );
    }

    #[test]
    fn indented_code_inside_a_list_item_is_excluded_relative_to_the_item() {
        // Content indent 2 ("- ") + 4 → 6 columns opens code within the item.
        assert!(parse("- item\n\n      {++code++}").is_empty());
    }

    #[test]
    fn nested_list_continuation_paragraph_still_parses() {
        // "1. " (3) then "- " → inner content indent 5; 5 columns is a paragraph.
        let doc = "1. a\n   - b\n\n     {++para++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++para++}".into(), "para".into(), "".into())]
        );
    }

    #[test]
    fn nested_list_indented_code_is_excluded() {
        // Inner content indent 5 + 4 → 9 columns is code in the inner item.
        assert!(parse("1. a\n   - b\n\n         {++code++}").is_empty());
    }

    #[test]
    fn lazy_paragraph_continuation_is_never_code() {
        // No blank line — indented code cannot interrupt a paragraph.
        let doc = "text\n    {++lazy++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++lazy++}".into(), "lazy".into(), "".into())]
        );
    }

    #[test]
    fn four_columns_after_a_blank_in_a_list_is_a_paragraph_not_code() {
        // Content indent 2, so 4 columns is only 2 beyond the container.
        let doc = "- item\n\n    {++x++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++x++}".into(), "x".into(), "".into())]
        );
    }

    #[test]
    fn code_block_continues_across_blank_lines() {
        assert!(parse("p\n\n    {++a++}\n\n    {++b++}").is_empty());
    }

    #[test]
    fn dedenting_out_of_the_code_block_restores_markup() {
        let doc = "p\n\n    code\n\n{++real++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++real++}".into(), "real".into(), "".into())]
        );
    }

    #[test]
    fn list_item_starting_with_indented_code_on_the_marker_line() {
        // Five or more spaces after the marker: the item's first block is
        // indented code beginning on the marker line itself (CommonMark).
        assert!(parse("-     {++code++}").is_empty());
    }

    #[test]
    fn marker_followed_by_up_to_four_spaces_is_item_content() {
        let doc = "-    {++x++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++x++}".into(), "x".into(), "".into())]
        );
    }

    #[test]
    fn indented_code_after_a_heading_is_excluded() {
        // A heading is a block boundary — code may open right after it.
        assert!(parse("# Title\n\n    {++x++}").is_empty());
        assert!(parse("# Title\n    {++y++}").is_empty());
    }

    #[test]
    fn a_lone_dash_cannot_interrupt_a_paragraph_into_a_list() {
        // Empty list items don't interrupt a paragraph (CommonMark), so all
        // three lines are one paragraph and the markup is real.
        let doc = "text\n-\n      {++x++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++x++}".into(), "x".into(), "".into())]
        );
    }

    #[test]
    fn ordered_marker_not_starting_at_one_does_not_interrupt() {
        // "2. note" cannot interrupt a paragraph — everything stays one
        // paragraph, so the indented line is a lazy continuation.
        let doc = "text\n2. note\n    {++x++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++x++}".into(), "x".into(), "".into())]
        );
    }

    #[test]
    fn sibling_list_items_keep_their_own_thresholds() {
        // The second item's content indent is also 2; 6 columns after the blank
        // is code inside it.
        assert!(parse("- a\n- b\n\n      {++code++}").is_empty());
    }

    #[test]
    fn dedent_out_of_the_list_restores_the_top_level_threshold() {
        // "plain" at column 0 closes the list; 4 columns is then top-level code.
        assert!(parse("- a\n\nplain\n\n    {++code++}").is_empty());
    }

    #[test]
    fn crlf_indented_code_is_excluded() {
        assert!(parse("p\r\n\r\n    {++x++}\r\n").is_empty());
    }

    // --- exclusion: list-aware code fences (#187) ---------------------------
    // A code fence opened inside a list item is indented past the item's content
    // indent, so an absolute ≤3-space rule (pre-#187) never recognised it and the
    // literal markup inside leaked. Opener *and* closer are now measured relative
    // to the container, and an unclosed in-item fence is bounded by the item
    // ending (dedent) rather than swallowing the rest of the document. Both
    // directions are covered: excluded inside real code, parsed everywhere else.

    #[test]
    fn fence_inside_a_list_item_excludes_markup() {
        // The issue #187 example: a fence at absolute column 4 = container(2) + 2.
        let doc = "- item\n\n    ```\n    {++literal example++}\n    ```\n";
        assert!(parse(doc).is_empty());
    }

    #[test]
    fn markup_parses_after_a_closed_in_item_fence() {
        // The container-relative closer terminates the fence; the change that
        // follows (still inside the item) is real.
        let doc = "- item\n\n    ```\n    {++code++}\n    ```\n\n    a {++real++} b";
        assert_eq!(
            described(doc),
            vec![("ins", "{++real++}".into(), "real".into(), "".into())]
        );
    }

    #[test]
    fn unclosed_in_item_fence_is_truncated_by_a_dedent() {
        // No closing fence; the item ends at the top-level line, closing the fence
        // with it (CommonMark item truncation). The change after must still parse —
        // silently swallowing it to EOF is the harmful direction (#38 ruling).
        let doc = "- item\n\n    ```\n    unclosed code\n\ntop {++real++} change";
        assert_eq!(
            described(doc),
            vec![("ins", "{++real++}".into(), "real".into(), "".into())]
        );
    }

    #[test]
    fn nested_list_fence_is_container_relative() {
        // "1. " (3) then "- " → inner content indent 5; a fence at column 5 opens
        // relative to the inner item, so markup inside it is excluded.
        assert!(parse("1. a\n   - b\n\n     ```\n     {++x++}\n     ```").is_empty());
    }

    #[test]
    fn fence_interrupts_an_indented_list_item_paragraph() {
        // Doubly nested: inner content indent 4, so the fence at column 4 sits ≥4
        // absolute columns in — the pre-#187 absolute rule would miss it and leak.
        // A fence interrupts the item's paragraph (no blank line needed).
        let doc = "- - text\n    ```\n    {++x++}\n    ```";
        assert!(parse(doc).is_empty());
    }

    #[test]
    fn over_indented_closing_fence_is_code_not_a_closer() {
        // A "```" indented 4 columns past the container is code content, not a
        // closer; the fence stays open until the genuine closer, so both the
        // over-indented line and the earlier line are excluded.
        let doc = "- item\n\n    ```\n        ```\n    {++still code++}\n    ```\n";
        assert!(parse(doc).is_empty());
    }

    #[test]
    fn dedent_to_a_sibling_item_ends_an_unclosed_fence() {
        // An unclosed fence in the first item is truncated when the sibling marker
        // (column 0) starts a new item; markup in the sibling parses.
        let doc = "- a\n\n    ```\n    code\n- b {++real++}";
        assert_eq!(
            described(doc),
            vec![("ins", "{++real++}".into(), "real".into(), "".into())]
        );
    }

    #[test]
    fn top_level_fence_is_unchanged_by_container_relative_measure() {
        // Container indent 0: the relative rule collapses to the absolute one, so
        // an unclosed top-level fence still runs to EOF (regression guard).
        assert!(parse("```\n{++never closed++}\n\nmore {++text++}").is_empty());
    }

    // --- GFM strikethrough disambiguation ---------------------------------

    #[test]
    fn gfm_strikethrough_is_not_a_substitution() {
        // No `~>` and no braces — a substitution requires `{~~ ... ~> ... ~~}`.
        assert!(parse("This is ~~strikethrough~~ text.").is_empty());
    }

    // --- malformed / unterminated -----------------------------------------

    #[test]
    fn unclosed_markers_are_literal_text() {
        for doc in [
            "Hello {++no closing",
            "Hello {--no closing",
            "Hello {~~old~>new",
        ] {
            assert!(parse(doc).is_empty(), "{doc:?}");
        }
    }

    #[test]
    fn truly_empty_markers_do_not_parse() {
        // No content between the delimiters — nothing to add or remove.
        for doc in ["Hello {++++} world", "Hello {----} world"] {
            assert!(parse(doc).is_empty(), "{doc:?}");
        }
    }

    #[test]
    fn substitution_needs_an_arrow() {
        // `{~~x~~}` has no `~>`, so it is not a substitution.
        assert!(parse("{~~x~~}").is_empty());
    }

    // --- multiline & unicode content --------------------------------------

    #[test]
    fn content_may_span_multiple_lines() {
        let doc = "{++line one\nline two++}";
        assert_eq!(
            described(doc),
            vec![("ins", doc.into(), "line one\nline two".into(), "".into())]
        );
    }

    #[test]
    fn nested_markers_resolve_first_closer_wins() {
        // The outer `{++` closes at the first `++}`; the inner `{++inner` is literal
        // content, and ` text++}` is leftover ordinary text. This is the defined
        // (non-nesting) CriticMarkup behaviour — generators treat it as first-class.
        let doc = "{++outer {++inner++} text++}";
        let ms = parse(doc);
        assert_eq!(ms.len(), 1);
        assert_eq!(&doc[ms[0].full.clone()], "{++outer {++inner++}");
        assert_eq!(describe(doc, &ms[0]).2, "outer {++inner");
    }

    // --- ranges are disjoint and ordered ----------------------------------

    #[test]
    fn ranges_are_disjoint_and_sorted() {
        let doc = "{++a++} x {--b--} y {~~c~>d~~}";
        let ms = parse(doc);
        for w in ms.windows(2) {
            assert!(w[0].full.end <= w[1].full.start);
        }
    }
}

// ---------------------------------------------------------------------------
// Regression corpus: v1 bug history (cursor-restore, whitespace-leak).
//
// The v1 track-changes engine mapped between the raw markdown and a TipTap tree;
// TD-2 (source-as-model) removes that mapping, so these bugs are prevented by
// construction. This corpus pins the *parse contract* the fix depends on: markup
// boundaries are byte-exact, and whitespace-only markup is a real change, not a
// discarded no-op. If any of these regress, the old bugs have a path back.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod regression_corpus {
    use super::*;

    fn one(doc: &str) -> Markup {
        let ms = parse(doc);
        assert_eq!(
            ms.len(),
            1,
            "expected exactly one markup in {doc:?}, got {ms:?}"
        );
        ms.into_iter().next().unwrap()
    }

    // -- whitespace-leak ----------------------------------------------------
    // v1 discarded any marker whose content trimmed to empty
    // (`if (content.trim() === "") continue;`), so an inserted/deleted space was
    // treated as non-existent — and its literal `{++ ++}` braces leaked into the
    // clean view (repro: src/__tests__/tc-accept-edit-repro.test.ts on legacy/v1).
    // The parse contract that closes it: whitespace-only content is first-class.

    #[test]
    fn whitespace_only_insertion_is_a_real_change() {
        let m = one("word{++ ++}next");
        assert_eq!(m.full, 4..11);
        assert_eq!(&"word{++ ++}next"[m.full.clone()], "{++ ++}");
        match m.kind {
            MarkupKind::Insertion { text } => assert_eq!(&"word{++ ++}next"[text], " "),
            other => panic!("expected insertion, got {other:?}"),
        }
    }

    #[test]
    fn whitespace_only_deletion_is_a_real_change() {
        let doc = "a{-- --}b";
        match one(doc).kind {
            MarkupKind::Deletion { text } => assert_eq!(&doc[text], " "),
            other => panic!("expected deletion, got {other:?}"),
        }
    }

    #[test]
    fn multi_space_and_tab_insertion_preserved_exactly() {
        let doc = "x{++  \t ++}y"; // two spaces, tab, space
        match one(doc).kind {
            MarkupKind::Insertion { text } => assert_eq!(&doc[text], "  \t "),
            other => panic!("expected insertion, got {other:?}"),
        }
    }

    #[test]
    fn substitution_with_whitespace_only_sides_is_first_class() {
        // Substituting a run of spaces for a single space — v1's trim check
        // dropped this entirely (both sides trim empty).
        let doc = "a{~~   ~> ~~}b";
        match one(doc).kind {
            MarkupKind::Substitution { old, new } => {
                assert_eq!(&doc[old], "   ");
                assert_eq!(&doc[new], " ");
            }
            other => panic!("expected substitution, got {other:?}"),
        }
    }

    #[test]
    fn accept_edit_repro_shape_parses_the_inserted_space() {
        // The concrete v1 repro produced markup of the shape `{--Tina--}{++ ++}CJ`
        // after an accept-then-edit; v1 dropped the `{++ ++}` and the braces leaked
        // as visible text. Here both the deletion and the whitespace insertion parse.
        let doc = "My Name is {--Tina--}{++ ++}CJ Williams.";
        assert_eq!(
            parse(doc)
                .iter()
                .map(|m| describe_kind(doc, m))
                .collect::<Vec<_>>(),
            vec![
                ("del".to_string(), "Tina".to_string()),
                ("ins".to_string(), " ".to_string())
            ]
        );
    }

    fn describe_kind(doc: &str, m: &Markup) -> (String, String) {
        match &m.kind {
            MarkupKind::Insertion { text } => ("ins".into(), doc[text.clone()].into()),
            MarkupKind::Deletion { text } => ("del".into(), doc[text.clone()].into()),
            MarkupKind::Substitution { old, .. } => ("sub".into(), doc[old.clone()].into()),
        }
    }

    // -- cursor-restore -----------------------------------------------------
    // v1 restored the cursor with offsets computed in the tree/mapping layer and
    // in UTF-16 code units (JS string indices), so astral characters and adjacent
    // markers put the cursor in the wrong place. The v2 parse contract: offsets
    // are *bytes* into the raw string, exact to the delimiter.

    #[test]
    fn offsets_are_bytes_not_utf16_units_across_astral_chars() {
        // "🎉" is 4 UTF-8 bytes (and a UTF-16 surrogate pair — v1 would report 2).
        let doc = "🎉{--x--}";
        let m = one(doc);
        assert_eq!(m.full.start, 4, "marker must start after the 4-byte emoji");
        assert_eq!(&doc[m.full.clone()], "{--x--}");
    }

    #[test]
    fn multibyte_content_reports_byte_exact_inner_range() {
        let doc = "{~~日本語~>新~~}";
        match one(doc).kind {
            MarkupKind::Substitution { old, new } => {
                assert_eq!(&doc[old], "日本語");
                assert_eq!(&doc[new], "新");
            }
            other => panic!("expected substitution, got {other:?}"),
        }
    }

    #[test]
    fn adjacent_markers_have_touching_byte_boundaries() {
        // Cursor math after accepting the first change indexes the second by its
        // exact start; an off-by-one here is the cursor-restore bug's signature.
        let doc = "start{--old--}{++new++}end";
        let ms = parse(doc);
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].full, 5..14);
        assert_eq!(ms[1].full, 14..23);
        assert_eq!(ms[0].full.end, ms[1].full.start);
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    // A generated document atom. Text is drawn from a charset that cannot form a
    // marker, fence, backtick span, or frontmatter delimiter, so the only markup
    // in a generated doc is the markup we place — letting us assert exact recovery
    // while still exercising adjacency and whitespace-only content (P4a generators).
    #[derive(Clone, Debug)]
    enum Atom {
        Text(String),
        Ins(String),
        Del(String),
        Sub(String, String),
    }

    // Marker content: >= 1 char, no delimiter bytes (`+ - ~ > { }` / backtick),
    // but includes spaces so whitespace-only content is generated as first-class.
    fn content() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ._]{1,8}"
    }

    // Plain text between markers: no `{`, no `-` (frontmatter), no backtick/`~`.
    // A non-empty atom starts with a letter so a generated document (one line)
    // can never open an indented code block (leading columns) or a list item
    // whose first block is indented code (`1.` + five spaces) — see #75.
    fn plain() -> impl Strategy<Value = String> {
        "([a-zA-Z][a-zA-Z0-9 .]{0,9})?"
    }

    fn atom() -> impl Strategy<Value = Atom> {
        prop_oneof![
            plain().prop_map(Atom::Text),
            content().prop_map(Atom::Ins),
            content().prop_map(Atom::Del),
            (content(), content()).prop_map(|(o, n)| Atom::Sub(o, n)),
        ]
    }

    /// Render a list of atoms into a document plus the exact `Markup` list the
    /// parser must return (byte-precise ranges, in order).
    fn render(atoms: &[Atom]) -> (String, Vec<Markup>) {
        let mut doc = String::new();
        let mut expected = Vec::new();
        for a in atoms {
            match a {
                Atom::Text(s) => doc.push_str(s),
                Atom::Ins(c) => {
                    let start = doc.len();
                    doc.push_str("{++");
                    let cs = doc.len();
                    doc.push_str(c);
                    let ce = doc.len();
                    doc.push_str("++}");
                    expected.push(Markup {
                        full: start..doc.len(),
                        kind: MarkupKind::Insertion { text: cs..ce },
                    });
                }
                Atom::Del(c) => {
                    let start = doc.len();
                    doc.push_str("{--");
                    let cs = doc.len();
                    doc.push_str(c);
                    let ce = doc.len();
                    doc.push_str("--}");
                    expected.push(Markup {
                        full: start..doc.len(),
                        kind: MarkupKind::Deletion { text: cs..ce },
                    });
                }
                Atom::Sub(o, n) => {
                    let start = doc.len();
                    doc.push_str("{~~");
                    let os = doc.len();
                    doc.push_str(o);
                    let oe = doc.len();
                    doc.push_str("~>");
                    let ns = doc.len();
                    doc.push_str(n);
                    let ne = doc.len();
                    doc.push_str("~~}");
                    expected.push(Markup {
                        full: start..doc.len(),
                        kind: MarkupKind::Substitution {
                            old: os..oe,
                            new: ns..ne,
                        },
                    });
                }
            }
        }
        (doc, expected)
    }

    /// A single well-formed marker string (for exclusion-zone embedding).
    fn marker() -> impl Strategy<Value = String> {
        prop_oneof![
            content().prop_map(|c| format!("{{++{c}++}}")),
            content().prop_map(|c| format!("{{--{c}--}}")),
            (content(), content()).prop_map(|(o, n)| format!("{{~~{o}~>{n}~~}}")),
        ]
    }

    proptest! {
        // P4a parse contract: the parser recovers exactly the markup placed —
        // right count, kinds, byte ranges, and order — with nested-free, adjacent,
        // and whitespace-only content all first-class.
        #[test]
        fn prop_parse_recovers_placed_markup(atoms in prop::collection::vec(atom(), 0..12)) {
            let (doc, expected) = render(&atoms);
            prop_assert_eq!(parse(&doc), expected);
        }

        // Robustness over arbitrary (unicode, control-char, brace-and-backtick)
        // input: the parser never panics, and every reported range is in-bounds,
        // on a char boundary, disjoint, ordered, and slices to a `{`…`}` marker
        // whose inner segments lie strictly inside `full`.
        #[test]
        fn prop_wellformed_on_arbitrary_input(doc in "(?s).{0,220}") {
            let ms = parse(&doc);
            let mut prev_end = 0usize;
            for m in &ms {
                prop_assert!(m.full.start >= prev_end, "overlap/disorder in {ms:?}");
                prop_assert!(m.full.end <= doc.len());
                prop_assert!(doc.is_char_boundary(m.full.start));
                prop_assert!(doc.is_char_boundary(m.full.end));
                let s = &doc[m.full.clone()];
                prop_assert!(s.starts_with('{') && s.ends_with('}'), "{s:?}");
                let inner = match &m.kind {
                    MarkupKind::Insertion { text } | MarkupKind::Deletion { text } => vec![text.clone()],
                    MarkupKind::Substitution { old, new } => vec![old.clone(), new.clone()],
                };
                for r in inner {
                    prop_assert!(m.full.start < r.start && r.end < m.full.end);
                    prop_assert!(doc.is_char_boundary(r.start) && doc.is_char_boundary(r.end));
                }
                prev_end = m.full.end;
            }
        }

        // Adversarial soup: raw delimiter fragments interleaved with text. Same
        // well-formedness guarantees must hold (nested/overlapping openers included).
        #[test]
        fn prop_wellformed_on_delimiter_soup(
            frags in prop::collection::vec(
                prop_oneof![
                    Just("{++"), Just("++}"), Just("{--"), Just("--}"),
                    Just("{~~"), Just("~>"), Just("~~}"), Just("`"),
                    Just("---\n"), Just("a"), Just(" "), Just("}"),
                ].prop_map(str::to_string),
                0..40,
            ),
        ) {
            let doc: String = frags.concat();
            let ms = parse(&doc);
            let mut prev_end = 0usize;
            for m in &ms {
                prop_assert!(m.full.start >= prev_end);
                prop_assert!(m.full.end <= doc.len());
                let s = &doc[m.full.clone()];
                prop_assert!(s.starts_with('{') && s.ends_with('}'), "not a marker: {s:?}");
                prev_end = m.full.end;
            }
        }

        // Exclusion zones hide markup; the identical marker outside is parsed.
        #[test]
        fn prop_marker_excluded_in_zone_but_parsed_outside(m in marker()) {
            prop_assert!(parse(&format!("```\n{m}\n```")).is_empty(), "fenced");
            prop_assert!(parse(&format!("~~~\n{m}\n~~~")).is_empty(), "tilde fence");
            prop_assert!(parse(&format!("`{m}`")).is_empty(), "inline code");
            prop_assert!(parse(&format!("---\n{m}\n---\nbody")).is_empty(), "frontmatter");
            prop_assert!(parse(&format!("para\n\n    {m}")).is_empty(), "indented code");
            prop_assert!(
                parse(&format!("- item\n\n      {m}")).is_empty(),
                "indented code in a list item"
            );
            prop_assert!(
                parse(&format!("- item\n\n    ```\n    {m}\n    ```")).is_empty(),
                "container-relative fence in a list item (#187)"
            );

            let outside = format!("before {m} after");
            prop_assert_eq!(parse(&outside).len(), 1, "outside a zone the marker parses");

            // The two directions #75 must not confuse: a list-item continuation
            // paragraph at 4 columns, and a lazy paragraph continuation — both
            // are real markup, never code.
            let continuation = format!("1. step\n\n    a {m} b");
            prop_assert_eq!(parse(&continuation).len(), 1, "list continuation paragraph");
            let lazy = format!("text\n    {m}");
            prop_assert_eq!(parse(&lazy).len(), 1, "lazy continuation");

            // #187 benign direction: an unclosed fence in a list item is bounded
            // by the item ending, so a marker on a dedented line still parses
            // instead of being swallowed to end of document.
            let truncated = format!("- item\n\n    ```\n    code\n{m} after");
            prop_assert_eq!(parse(&truncated).len(), 1, "in-item fence truncated by dedent");
        }
    }
}
