// ABOUTME: Coordinate transforms raw↔clean↔displayed (TD-6) — clean/displayed as
// ABOUTME: pure functions of raw, plus raw↔clean position mapping (test-plan P3).

//! TD-6's three named coordinate spaces, and the position mapping between them
//! (test-plan P3): "`textops/` implements the deterministic transforms
//! raw↔clean↔displayed (clean = markup resolved per display mode; displayed =
//! what a reviewer saw, per J6 suggestion capture)."
//!
//! - **raw** — the exact file text on disk (TD-6 canonical space; [`crate::Document`]).
//! - **[`clean`]** — every change accepted: this is the P4a accept-all anchor
//!   ([`crate::apply::accept_all`]) under its TD-6 name. The general per-display-mode
//!   projection (All/Simple/None/Original, FR-ED-4) is P1-7's job; `clean` here is the
//!   one mode P1-6 needs to define the position mapping against.
//! - **[`displayed`]** — the pending-redline text a reviewer sees before any triage
//!   (J6: "reviews share raw in-flight state"; UX §J6 "suggestions capture the
//!   *displayed* text"): markup delimiters removed, but *both* sides of a change stay
//!   visible (unlike `clean`, which keeps only the accepted side) — a deletion's text
//!   remains, and a substitution shows `old` immediately followed by `new`.
//!
//! # Position mapping (P3): exact outside markup, a defined policy inside
//!
//! [`raw_to_clean`] and [`clean_to_raw`] map a byte offset between raw and clean
//! coordinates. `clean` is built by replacing each [`crate::critic::parse`] marker's
//! `full` span with its accepted resolution — a fixed, disjoint edit list — so the
//! mapping is exactly the forward/backward position transform through that list:
//!
//! - A raw offset that is not **strictly inside** any marker's `full` range (i.e. at
//!   or outside every marker's boundaries) maps **[`Position::Exact`]**: cumulative
//!   arithmetic over the edits fully before it, with no text comparison — the same
//!   boundary policy as [`crate::anchor::Anchor::map_through`] ("touching, not
//!   overlapping" — an edit that starts exactly where the next one ends does not
//!   make either endpoint ambiguous).
//! - A raw offset **strictly inside** a marker's `full` range has no single
//!   corresponding clean position in general (e.g. a byte inside a rejected
//!   deletion's text has no clean-side counterpart at all) — raw→clean is lossy, a
//!   projection and not a bijection (P3). The defined, tested policy: it maps
//!   **[`Position::Collapsed`]** to the clean offset where that marker's resolution
//!   *begins* — the same value [`raw_to_clean`] reports, exactly, for the marker's
//!   own start boundary.
//!
//! [`clean_to_raw`] is the mirror in the other direction, over the same edit list's
//! *clean*-side spans: a clean offset outside every marker's clean span maps exactly
//! back to raw; a clean offset strictly inside one (only possible when the kept
//! replacement is non-empty — an insertion or a substitution's `new`) collapses to
//! that marker's raw start. For a marker whose kept side is **empty** (a deletion,
//! or a degenerate empty-`new` substitution) the clean span is zero-width, so its
//! own start and end boundaries collapse *forward* to the identical clean point —
//! `clean_to_raw` can only recover one of them back, and (documented on
//! [`backward`]) picks the marker's raw **end**, because that is what makes a plain
//! -text run beginning right after a deletion — the case anchors actually care
//! about — round-trip correctly. **The round trip is exact for every raw position
//! that is not strictly inside a markup region, with one named exception:** the
//! raw *start* boundary of a marker whose kept side is empty does not survive
//! (its shared clean point recovers the marker's end instead) — an intrinsic
//! consequence of raw→clean being a projection, not a bijection (P3), not a defect.

use crate::apply::{self, apply_edits, Decision, Edit};
use crate::critic::{parse, Markup, MarkupKind};
use std::ops::Range;

/// The clean text: every CriticMarkup change accepted (TD-6 `clean`; the P4a
/// accept-all anchor under its coordinate-space name).
pub fn clean(raw: &str) -> String {
    apply::accept_all(raw)
}

/// The edit list that resolves `raw`'s markup to `clean` — one accept-resolution
/// per marker ([`apply::resolution`], the same match `apply::accept_all` uses),
/// in document order (disjoint, sorted, per [`crate::critic::parse`]).
fn clean_edits(raw: &str) -> Vec<Edit> {
    parse(raw)
        .iter()
        .map(|m| Edit {
            range: m.full.clone(),
            replacement: apply::resolution(raw, m, Decision::Accept).to_string(),
        })
        .collect()
}

/// The text a marker resolves to in the **displayed** space: both sides of a change
/// stay visible (delimiters stripped) — an insertion or deletion's text is shown as
/// itself, a substitution shows `old` then `new` (J6: pending redline, before triage).
fn displayed_resolution(doc: &str, markup: &Markup) -> String {
    match &markup.kind {
        MarkupKind::Insertion { text } | MarkupKind::Deletion { text } => {
            doc[text.clone()].to_string()
        }
        MarkupKind::Substitution { old, new } => {
            format!("{}{}", &doc[old.clone()], &doc[new.clone()])
        }
    }
}

/// The displayed text: the pending-redline rendering a reviewer sees (TD-6
/// `displayed`; J6 "what the reviewer saw" — both sides of every pending change
/// visible, delimiters removed).
pub fn displayed(raw: &str) -> String {
    let edits: Vec<Edit> = parse(raw)
        .iter()
        .map(|m| Edit {
            range: m.full.clone(),
            replacement: displayed_resolution(raw, m),
        })
        .collect();
    apply_edits(raw, &edits)
}

/// A byte offset mapped into another TD-6 coordinate space (test-plan P3).
///
/// `Exact` offsets round-trip: mapping back through the inverse function returns
/// the original offset unchanged. `Collapsed` offsets fall strictly inside a markup
/// region that has no single corresponding position in the other space — the
/// defined policy names the boundary at the *start* of that region's resolution,
/// not a bijection (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    /// A precise, round-trip-safe mapping.
    Exact(usize),
    /// A markup-interior position, collapsed to the resolution's start boundary.
    Collapsed(usize),
}

impl Position {
    /// The mapped byte offset, whichever policy produced it.
    pub fn offset(self) -> usize {
        match self {
            Position::Exact(o) | Position::Collapsed(o) => o,
        }
    }
}

/// One edit's source (raw) range paired with the range it occupies in the
/// resolved (target) text — computed once per edit list so forward and backward
/// mapping share the identical arithmetic.
struct Span {
    source: Range<usize>,
    target: Range<usize>,
}

/// Compute each edit's target-side span from its source range and replacement
/// length, threading the running length delta through in document order. `edits`
/// must be sorted by `range.start` and disjoint (as [`clean_edits`] / marker parse
/// output always is).
fn spans(edits: &[Edit]) -> Vec<Span> {
    let mut out = Vec::with_capacity(edits.len());
    let mut delta: isize = 0;
    for e in edits {
        let source_len = (e.range.end - e.range.start) as isize;
        let target_start = (e.range.start as isize + delta) as usize;
        let target_end = target_start + e.replacement.len();
        out.push(Span {
            source: e.range.clone(),
            target: target_start..target_end,
        });
        delta += e.replacement.len() as isize - source_len;
    }
    out
}

/// Map `offset` (in the `source` field of each span) forward into the `target`
/// space. See the module docs for the exact/collapsed policy.
fn forward(spans: &[Span], offset: usize) -> Position {
    let mut delta: isize = 0;
    for s in spans {
        if s.source.end <= offset {
            delta = s.target.end as isize - s.source.end as isize;
        } else if s.source.start >= offset {
            break;
        } else {
            return Position::Collapsed(s.target.start);
        }
    }
    Position::Exact((offset as isize + delta) as usize)
}

/// The mirror of [`forward`]: map `offset` (in the `target` field of each span)
/// back into the `source` space.
///
/// # The zero-width-span tie, and why it resolves to the marker's raw *end*
///
/// A dropped edit (an accepted-away deletion, or a degenerate substitution with
/// an empty `new`) has an empty replacement, so its `target` span is zero-width:
/// a single clean point that is simultaneously its own start *and* end. `forward`
/// maps **both** of the corresponding raw boundaries — the marker's `full.start`
/// *and* `full.end` — to that identical clean point (an unavoidable convergence:
/// no clean byte survives to tell the two apart). `clean_to_raw` can only recover
/// one of them, so which one is a real policy choice, not an arithmetic detail:
/// checking `target.end <= offset` **before** `target.start >= offset` treats a
/// zero-width span sitting exactly at `offset` as "already fully passed", folding
/// its delta in and landing on the marker's raw **end**. This is chosen over the
/// marker's start deliberately: the far more common and more important case is a
/// plain-text run that begins immediately *after* a deletion (e.g. an anchor on
/// real surviving content right where deleted text used to be) — that run's own
/// start offset *is* the marker's raw end, and this ordering makes it round-trip.
/// The mirrored, rarer case (an anchor sitting exactly at a deletion's own raw
/// start) does not survive the round trip — an intrinsic, documented cost of a
/// projection that is not a bijection (P3), not a defect. For every non-zero-width
/// span the two conditions are mutually exclusive, so this ordering changes
/// nothing about their handling (only the tie is order-sensitive).
fn backward(spans: &[Span], offset: usize) -> Position {
    let mut delta: isize = 0;
    for s in spans {
        if s.target.end <= offset {
            delta = s.source.end as isize - s.target.end as isize;
        } else if s.target.start >= offset {
            break;
        } else {
            return Position::Collapsed(s.source.start);
        }
    }
    Position::Exact((offset as isize + delta) as usize)
}

/// Map a byte offset in `raw` to the corresponding offset in `clean(raw)`
/// (test-plan P3). Exact outside every markup region; inside one, collapses to
/// where that marker's resolution begins in `clean` (module docs).
///
/// Re-parses `raw` and rebuilds its edit list on every call — O(document size)
/// each time. Fine for the occasional anchor lookup; a caller mapping many
/// offsets against the same unchanged `raw` (e.g. remapping a whole document's
/// anchors at once) should parse once and reuse a batch path instead of calling
/// this in a loop — no such path exists yet (no caller needs it before P1-7).
pub fn raw_to_clean(raw: &str, raw_offset: usize) -> Position {
    forward(&spans(&clean_edits(raw)), raw_offset)
}

/// Map a byte offset in `clean(raw)` back to the corresponding offset in `raw`
/// (test-plan P3). Exact outside every markup region's clean span; inside one
/// (only possible when the kept side is non-empty), collapses to that marker's
/// raw start (module docs). Same per-call re-parse cost as [`raw_to_clean`].
pub fn clean_to_raw(raw: &str, clean_offset: usize) -> Position {
    backward(&spans(&clean_edits(raw)), clean_offset)
}

/// A precomputed byte-offset → UTF-16-code-unit lookup over one string.
///
/// The fourth coordinate translation TD-6 implies but does not name: `textops` indexes the raw file
/// text in **bytes**, while CodeMirror 6 and JS strings index in **UTF-16 code units**, so every
/// offset crossing the boundary to the frontend must be converted or a marker sitting past an astral
/// character (`🎉`) lands somewhere else entirely — the exact v1 bug `critic.rs` was written to
/// avoid. Lives here, with the rest of TD-6's coordinate transforms, because more than one command
/// now sends offsets across that boundary (`commands::changes`'s parse snapshot and `agent::state`'s
/// delivery notice), and both must agree.
///
/// Built over a known set of byte offsets and queried with [`at`](Self::at): one pass over the
/// string, then O(log n) per lookup, rather than an O(n) `encode_utf16().count()` per offset.
pub struct Utf16Offsets {
    /// Sorted, deduped byte offsets paired with their UTF-16 offset.
    entries: Vec<(usize, usize)>,
}

impl Utf16Offsets {
    /// Precompute the UTF-16 offset for each byte offset in `byte_offsets` (in any order, duplicates
    /// fine). Every offset must be a char boundary of `doc`, or end-of-string.
    pub fn new(doc: &str, mut byte_offsets: Vec<usize>) -> Utf16Offsets {
        byte_offsets.sort_unstable();
        byte_offsets.dedup();
        let mut entries = Vec::with_capacity(byte_offsets.len());
        let mut cursor = byte_offsets.iter().copied().peekable();
        let mut utf16 = 0usize;
        // Walk char boundaries in order, recording the UTF-16 count at each requested byte.
        for (byte, ch) in doc.char_indices() {
            while cursor.peek().is_some_and(|&b| b == byte) {
                entries.push((byte, utf16));
                cursor.next();
            }
            utf16 += ch.len_utf16();
        }
        // Any remaining requested offsets are at end-of-string (doc.len()).
        for byte in cursor {
            debug_assert!(
                byte == doc.len(),
                "byte offset {byte} is not a char boundary"
            );
            entries.push((byte, utf16));
        }
        Utf16Offsets { entries }
    }

    /// The UTF-16 offset for `byte`, which must be one of the offsets this map was built over.
    pub fn at(&self, byte: usize) -> usize {
        let idx = self
            .entries
            .binary_search_by_key(&byte, |&(b, _)| b)
            .expect("offset was registered at construction");
        self.entries[idx].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- clean / displayed: pure functions of raw --------------------------

    #[test]
    fn clean_is_the_accept_all_text() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(clean(doc), "The quick fox jumps above it.");
    }

    #[test]
    fn clean_of_a_document_with_no_markup_is_identity() {
        let doc = "No markup here at all.";
        assert_eq!(clean(doc), doc);
    }

    #[test]
    fn clean_is_a_pure_function_of_raw() {
        let doc = "a {++b++} c {--d--} e {~~f~>g~~}";
        assert_eq!(clean(doc), clean(doc));
    }

    #[test]
    fn displayed_shows_both_sides_of_a_substitution() {
        // Pending redline: both `old` and `new` are visible, delimiters stripped.
        assert_eq!(displayed("Hello {~~old~>new~~}!"), "Hello oldnew!");
    }

    #[test]
    fn displayed_shows_an_insertions_text() {
        assert_eq!(displayed("Hello {++big ++}world"), "Hello big world");
    }

    #[test]
    fn displayed_shows_a_deletions_text_too() {
        // Unlike `clean`, a pending deletion is still visible in the redline.
        assert_eq!(displayed("Hello {--cruel --}world"), "Hello cruel world");
    }

    #[test]
    fn displayed_of_a_document_with_no_markup_is_identity() {
        let doc = "No markup here at all.";
        assert_eq!(displayed(doc), doc);
    }

    #[test]
    fn displayed_is_a_pure_function_of_raw() {
        let doc = "x {--a--}{++b++} y {~~c~>d~~}";
        assert_eq!(displayed(doc), displayed(doc));
    }

    #[test]
    fn displayed_differs_from_clean_when_a_deletion_is_pending() {
        let doc = "word{--deleted--}next";
        assert_eq!(clean(doc), "wordnext");
        assert_eq!(displayed(doc), "worddeletednext");
    }

    // --- raw_to_clean: exact outside markup ---------------------------------

    #[test]
    fn plain_text_offsets_map_exactly_with_no_markup_in_the_document() {
        let doc = "hello world";
        for offset in 0..=doc.len() {
            assert_eq!(raw_to_clean(doc, offset), Position::Exact(offset));
        }
    }

    #[test]
    fn offset_before_any_markup_is_unchanged() {
        let doc = "abc{++X++}def";
        assert_eq!(raw_to_clean(doc, 0), Position::Exact(0));
        assert_eq!(raw_to_clean(doc, 3), Position::Exact(3)); // marker's own start boundary
    }

    #[test]
    fn offset_after_an_insertion_shifts_by_the_delimiters_removed() {
        // "abc{++X++}def" -> clean "abcXdef"; the marker consumed 7 raw bytes
        // ({++X++}) to produce 1 clean byte (X), delta = 1 - 7 = -6.
        let doc = "abc{++X++}def";
        assert_eq!(clean(doc), "abcXdef");
        assert_eq!(raw_to_clean(doc, 11), Position::Exact(5)); // raw 'e' -> clean 'e'
        assert_eq!(raw_to_clean(doc, 13), Position::Exact(7)); // end of document
    }

    #[test]
    fn offset_after_a_deletion_collapses_the_removed_span() {
        let doc = "abc{--X--}def";
        assert_eq!(clean(doc), "abcdef");
        assert_eq!(raw_to_clean(doc, 3), Position::Exact(3)); // marker start
        assert_eq!(raw_to_clean(doc, 10), Position::Exact(3)); // marker end: nothing survives
        assert_eq!(raw_to_clean(doc, 13), Position::Exact(6)); // end of document
    }

    #[test]
    fn offsets_after_multiple_markers_accumulate_delta() {
        let doc = "{++A++}-{--B--}-{~~C~>DD~~}";
        assert_eq!(clean(doc), "A--DD");
        let end = doc.len();
        assert_eq!(raw_to_clean(doc, end), Position::Exact("A--DD".len()));
    }

    // --- raw_to_clean: the defined policy inside markup ---------------------

    #[test]
    fn offset_strictly_inside_an_insertion_collapses_to_the_markers_clean_start() {
        let doc = "abc{++hello++}def";
        let start = raw_to_clean(doc, 3); // marker's own start boundary: Exact
        assert_eq!(start, Position::Exact(3));
        for inside in 4..doc.find("++}").unwrap() {
            assert_eq!(
                raw_to_clean(doc, inside),
                Position::Collapsed(start.offset()),
                "offset {inside} should collapse to the marker's clean start"
            );
        }
    }

    #[test]
    fn offset_strictly_inside_a_deletion_collapses_to_the_markers_clean_start() {
        let doc = "abc{--hello--}def";
        let start = raw_to_clean(doc, 3);
        assert_eq!(start, Position::Exact(3));
        for inside in 4..doc.find("--}").unwrap() {
            assert_eq!(
                raw_to_clean(doc, inside),
                Position::Collapsed(start.offset())
            );
        }
    }

    #[test]
    fn offset_strictly_inside_a_substitution_collapses_to_the_markers_clean_start() {
        let doc = "abc{~~old~>new~~}def";
        let start = raw_to_clean(doc, 3);
        assert_eq!(start, Position::Exact(3));
        // Inside `old`, inside the `~>` separator, and inside `new` all collapse alike.
        for inside in [5usize, 8, 12] {
            assert_eq!(
                raw_to_clean(doc, inside),
                Position::Collapsed(start.offset())
            );
        }
    }

    #[test]
    fn offset_at_a_markers_end_boundary_is_exact_not_collapsed() {
        let doc = "abc{++hello++}def";
        let end = "abc{++hello++}".len();
        assert!(matches!(raw_to_clean(doc, end), Position::Exact(_)));
    }

    // --- clean_to_raw: exact outside markup, mirrors raw_to_clean -----------

    #[test]
    fn clean_offsets_map_exactly_with_no_markup_in_the_document() {
        let doc = "hello world";
        for offset in 0..=doc.len() {
            assert_eq!(clean_to_raw(doc, offset), Position::Exact(offset));
        }
    }

    /// A marker's kept ("clean-side") byte length: non-zero for an insertion or a
    /// substitution with non-empty `new`, zero for a deletion (or an empty-`new`
    /// substitution) — the mirror of [`accepted`], sized rather than sliced.
    fn kept_len(m: &Markup) -> usize {
        match &m.kind {
            MarkupKind::Insertion { text } => text.end - text.start,
            MarkupKind::Deletion { .. } => 0,
            MarkupKind::Substitution { new, .. } => new.end - new.start,
        }
    }

    #[test]
    fn clean_to_raw_reverses_raw_to_clean_at_every_markers_recoverable_boundary() {
        // A marker with a non-empty kept side has two distinct clean boundaries,
        // both recoverable; its start is the one to check. A marker with an empty
        // kept side (deletion) collapses both its boundaries to one clean point —
        // only its *end* is recoverable (module docs on `backward`).
        let doc = "abc{++X++}def{--Y--}ghi{~~Z~>ZZ~~}jkl";
        for m in parse(doc) {
            let recoverable = if kept_len(&m) == 0 {
                m.full.end
            } else {
                m.full.start
            };
            let mapped = raw_to_clean(doc, recoverable);
            assert_eq!(mapped, Position::Exact(mapped.offset()));
            assert_eq!(
                clean_to_raw(doc, mapped.offset()),
                Position::Exact(recoverable)
            );
        }
    }

    #[test]
    fn clean_offset_strictly_inside_an_insertions_kept_text_collapses_to_raw_start() {
        // "abc{++hello++}def" -> clean "abchellodef"; clean offsets 3..8 are the
        // kept "hello" (marker's clean span), strictly inside it collapse to raw
        // start 3.
        let doc = "abc{++hello++}def";
        assert_eq!(clean(doc), "abchellodef");
        for inside in 4..8 {
            assert_eq!(clean_to_raw(doc, inside), Position::Collapsed(3));
        }
    }

    #[test]
    fn clean_offset_at_a_deletions_single_collapsed_point_recovers_the_markers_raw_end() {
        // A deletion's clean span is zero-width (nothing survives) — its single
        // point is a genuine boundary on both sides, not a "strictly inside" one,
        // but the two raw boundaries (3 and 13) collapsed onto it are not both
        // recoverable. The policy favors the marker's end (13) — the offset where
        // "def" resumes — over its start (module docs on `backward`).
        let doc = "abc{--gone--}def";
        assert_eq!(clean(doc), "abcdef");
        assert_eq!(raw_to_clean(doc, 3), Position::Exact(3)); // marker start collapses forward...
        assert_eq!(raw_to_clean(doc, 13), Position::Exact(3)); // ...to the same point as marker end
        assert_eq!(clean_to_raw(doc, 3), Position::Exact(13)); // ...and recovers the end, not the start
    }

    #[test]
    fn clean_to_raw_recovers_the_rightmost_raw_offset_across_adjacent_zero_width_markers() {
        // Two markers back to back, the second a deletion: the insertion's own end
        // boundary (7) and the deletion's end boundary (14) are *distinct* raw
        // offsets that both collapse forward to the same clean point (the
        // deletion contributes nothing) — clean_to_raw can only recover one, and
        // it is the rightmost (module docs on `backward`: each zero-width span
        // encountered advances the greedy scan past it).
        let doc = "{++ ++}{--A--}";
        assert_eq!(clean(doc), " ");
        assert_eq!(raw_to_clean(doc, 7), Position::Exact(1));
        assert_eq!(raw_to_clean(doc, 14), Position::Exact(1));
        assert_eq!(clean_to_raw(doc, 1), Position::Exact(14));
    }

    #[test]
    fn plain_text_immediately_after_a_deletion_round_trips_exactly() {
        // The case the tie-break is chosen for: an offset on real surviving text
        // right after a deletion (not the deletion's own vanished start) must
        // round-trip, since that is what an anchor on that text depends on (P3).
        let doc = "{--gone--}kept";
        let after_deletion = "{--gone--}".len();
        assert_eq!(clean(doc), "kept");
        let mapped = raw_to_clean(doc, after_deletion);
        assert_eq!(mapped, Position::Exact(0));
        assert_eq!(clean_to_raw(doc, 0), Position::Exact(after_deletion));
    }

    // --- displayed/clean differ; both are pure; unicode safety --------------

    #[test]
    fn position_mapping_never_slices_mid_codepoint() {
        // Multi-byte content on both sides of a marker; every offset in range
        // must be usable (no panic) and land on a byte offset.
        let doc = "é{++日本語++}è";
        for offset in 0..=doc.len() {
            if doc.is_char_boundary(offset) {
                let _ = raw_to_clean(doc, offset);
            }
        }
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    // A generated document atom, mirroring the P4a/apply.rs generators: content
    // that cannot itself form a marker, fence, or frontmatter delimiter, so the
    // only markup present is the markup placed.
    #[derive(Clone, Debug)]
    enum Atom {
        Text(String),
        Ins(String),
        Del(String),
        Sub(String, String),
    }

    fn content() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ._]{1,8}"
    }
    // Starts with a letter so a generated document (one line) can never open
    // an indented code block or a list item starting with one (#75).
    fn plain() -> impl Strategy<Value = String> {
        "[a-zA-Z][a-zA-Z0-9 .]{0,9}"
    }

    fn atom() -> impl Strategy<Value = Atom> {
        prop_oneof![
            plain().prop_map(Atom::Text),
            content().prop_map(Atom::Ins),
            content().prop_map(Atom::Del),
            (content(), content()).prop_map(|(o, n)| Atom::Sub(o, n)),
        ]
    }

    /// A marker's `full` range paired with whether its kept ("clean") side is
    /// empty — true only for `Del` in this generator, since `content()` never
    /// generates an empty-`new` substitution.
    type MarkerRange = (Range<usize>, bool);

    /// Render atoms into a raw document, recording each `Text` atom's exact byte
    /// range (a plain-text offset in any of those ranges is "outside markup" by
    /// construction) and each marker atom's range/kept-side pair. A zero-kept-side
    /// marker's own *start* boundary does not round-trip (module docs on
    /// `backward`); every other marker boundary, and every plain-text offset, does.
    fn render(atoms: &[Atom]) -> (String, Vec<Range<usize>>, Vec<MarkerRange>) {
        let mut doc = String::new();
        let mut plain_ranges = Vec::new();
        let mut marker_ranges = Vec::new();
        for a in atoms {
            let start = doc.len();
            match a {
                Atom::Text(s) => {
                    doc.push_str(s);
                    plain_ranges.push(start..doc.len());
                }
                Atom::Ins(c) => {
                    doc.push_str("{++");
                    doc.push_str(c);
                    doc.push_str("++}");
                    marker_ranges.push((start..doc.len(), false));
                }
                Atom::Del(c) => {
                    doc.push_str("{--");
                    doc.push_str(c);
                    doc.push_str("--}");
                    marker_ranges.push((start..doc.len(), true));
                }
                Atom::Sub(o, n) => {
                    doc.push_str("{~~");
                    doc.push_str(o);
                    doc.push_str("~>");
                    doc.push_str(n);
                    doc.push_str("~~}");
                    marker_ranges.push((start..doc.len(), false));
                }
            }
        }
        (doc, plain_ranges, marker_ranges)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // clean/displayed are pure functions of raw (P3): calling twice over the
        // same text yields byte-identical results.
        #[test]
        fn prop_clean_is_a_pure_function_of_raw(atoms in prop::collection::vec(atom(), 0..12)) {
            let (doc, _, _) = render(&atoms);
            prop_assert_eq!(clean(&doc), clean(&doc));
        }

        #[test]
        fn prop_displayed_is_a_pure_function_of_raw(atoms in prop::collection::vec(atom(), 0..12)) {
            let (doc, _, _) = render(&atoms);
            prop_assert_eq!(displayed(&doc), displayed(&doc));
        }

        // P3: a raw offset outside every markup region round-trips exactly through
        // raw_to_clean then clean_to_raw.
        #[test]
        fn prop_plain_text_offsets_round_trip_exactly(
            atoms in prop::collection::vec(atom(), 0..12),
        ) {
            let (doc, plain_ranges, _) = render(&atoms);
            for r in &plain_ranges {
                for offset in r.clone() {
                    let mapped = raw_to_clean(&doc, offset);
                    prop_assert!(matches!(mapped, Position::Exact(_)), "expected Exact at {offset}");
                    let back = clean_to_raw(&doc, mapped.offset());
                    prop_assert_eq!(back, Position::Exact(offset));
                }
            }
        }

        // P3: every marker's own start/end boundary is Exact (touching, not
        // overlapping — same convention as anchor::map_through). When several
        // raw offsets share the same forward image (a chain of adjacent
        // zero-kept-side markers can make more than two collide, not just one
        // marker's own start/end — the concrete regression test names a two-marker
        // case), clean_to_raw recovers the *rightmost* of them — a brute-force,
        // independently-computed check, not a re-derivation of the same formula.
        #[test]
        fn prop_clean_to_raw_recovers_the_rightmost_raw_preimage(
            atoms in prop::collection::vec(atom(), 0..12),
        ) {
            let (doc, _, marker_ranges) = render(&atoms);
            let boundaries: Vec<usize> = marker_ranges
                .iter()
                .flat_map(|(r, _)| [r.start, r.end])
                .collect();
            for &boundary in &boundaries {
                let image = raw_to_clean(&doc, boundary);
                prop_assert!(matches!(image, Position::Exact(_)));
                let rightmost = (0..=doc.len())
                    .filter(|&o| doc.is_char_boundary(o))
                    .filter(|&o| raw_to_clean(&doc, o) == image)
                    .max()
                    .expect("boundary itself always matches");
                prop_assert_eq!(clean_to_raw(&doc, image.offset()), Position::Exact(rightmost));
            }
        }

        // P3: a raw offset strictly inside a marker collapses to the same clean
        // offset as the marker's own start boundary (the defined, tested policy).
        #[test]
        fn prop_offsets_strictly_inside_a_marker_collapse_to_its_clean_start(
            atoms in prop::collection::vec(atom(), 0..12),
        ) {
            let (doc, _, marker_ranges) = render(&atoms);
            for (r, _) in &marker_ranges {
                if r.end - r.start <= 1 {
                    continue; // no strictly-interior byte offset to exercise
                }
                let start_mapped = raw_to_clean(&doc, r.start);
                for inside in (r.start + 1)..r.end {
                    if !doc.is_char_boundary(inside) {
                        continue;
                    }
                    prop_assert_eq!(
                        raw_to_clean(&doc, inside),
                        Position::Collapsed(start_mapped.offset())
                    );
                }
            }
        }

        // clean(doc).len() always equals raw_to_clean(doc, doc.len())'s offset —
        // mapping the end of the document lands exactly at the end of `clean`
        // (cross-checks the Span arithmetic against the independently computed
        // clean text — real teeth, not a tautology).
        #[test]
        fn prop_end_of_document_maps_to_end_of_clean(
            atoms in prop::collection::vec(atom(), 0..12),
        ) {
            let (doc, _, _) = render(&atoms);
            let mapped = raw_to_clean(&doc, doc.len());
            prop_assert_eq!(mapped, Position::Exact(clean(&doc).len()));
        }
    }

    // --- Utf16Offsets: the byte → UTF-16 translation every frontend-bound offset crosses ----

    #[test]
    fn utf16_offsets_are_identity_for_ascii() {
        let map = Utf16Offsets::new("hello", vec![0, 3, 5]);
        assert_eq!(map.at(0), 0);
        assert_eq!(map.at(3), 3);
        assert_eq!(map.at(5), 5);
    }

    #[test]
    fn utf16_offsets_count_an_astral_char_as_two_units_not_four_bytes() {
        // "🎉" is 4 bytes but 2 UTF-16 code units — the whole reason this translation exists.
        let doc = "🎉x";
        let map = Utf16Offsets::new(doc, vec![0, 4, 5]);
        assert_eq!(map.at(0), 0);
        assert_eq!(map.at(4), 2);
        assert_eq!(map.at(5), 3);
    }

    #[test]
    fn utf16_offsets_count_a_two_byte_char_as_one_unit() {
        // "é" is 2 bytes, 1 UTF-16 unit — bytes and units diverge below the astral plane too.
        let map = Utf16Offsets::new("é!", vec![0, 2, 3]);
        assert_eq!(map.at(2), 1);
        assert_eq!(map.at(3), 2);
    }

    #[test]
    fn utf16_offsets_accepts_unsorted_and_duplicated_requests() {
        let map = Utf16Offsets::new("🎉ab", vec![5, 0, 5, 4]);
        assert_eq!(map.at(0), 0);
        assert_eq!(map.at(4), 2);
        assert_eq!(map.at(5), 3);
    }

    #[test]
    fn utf16_offsets_handles_end_of_string_and_an_empty_document() {
        assert_eq!(Utf16Offsets::new("", vec![0]).at(0), 0);
        assert_eq!(Utf16Offsets::new("ab", vec![2]).at(2), 2);
    }
}
