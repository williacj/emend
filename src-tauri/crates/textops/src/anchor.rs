// ABOUTME: Anchor — TD-4's shared anchor shape {offset, length, snapshot, context, base_revision}.
// ABOUTME: Exact offset mapping through edit-batch sequences (TD-6, D17, P2); overlap signals re-anchor.

//! The anchor model shared by comments, track-changes, and suggestions (TD-4/TD-6).
//!
//! Per TD-6 the raw file text is the canonical coordinate space: an anchor's
//! `offset`/`length` are a **byte** range into the exact document text named by its
//! `base_revision` (a content hash, [`Revision`]). `text_snapshot` is that exact
//! slice, captured at anchor-creation time; `context_before`/`context_after` are
//! bounded windows of the text immediately surrounding it. TD-4 is explicit that
//! this shape carries no line/col — offsets plus context are strictly better under
//! LF normalization.
//!
//! # Two paths, one property (test-plan P2 / D17)
//!
//! TD-6: "cross-revision interpretation = exact mapping via stored revision when
//! available, else D17 snapshot+context re-anchor." This module implements the
//! **exact-mapping** path only: [`Anchor::map_through`] walks an anchor forward
//! through a batch of edits using pure offset arithmetic — no text comparison. When
//! no edit in the batch touches the anchor's range, the new position is exact and
//! certain, and `base_revision` advances to name the resulting text. When an edit
//! *does* overlap the anchor's range, exact arithmetic cannot say where — or
//! whether — that text still exists; [`Mapped::Touched`] hands the problem to the
//! **fuzzy re-anchor** path ([`crate::reanchor::Anchor::fuzzy_reanchor`] —
//! snapshot+context matching, orphan-on-failure per D17/P2, algorithm and
//! parameters from SPIKE-4/P1-5b). `text_snapshot`/`context_before`/
//! `context_after` are captured here and carried through untouched exact hops
//! unchanged (they describe text that, by the exact-mapping guarantee, has not
//! moved or changed) so the fuzzy path always has them when it needs them.
//!
//! # Edit-batch contract
//!
//! `edits` passed to [`Anchor::map_through`] are a **batch measured against the
//! same base text** the anchor's current `offset`/`length` index into — the same
//! disjoint, same-snapshot contract [`crate::apply::apply_edits`] uses (e.g. one
//! diff between two saved revisions, `textops` P1-8). This is *not* a chronological
//! per-keystroke stream where each edit's range is relative to the previous edit's
//! result — tracking a multi-revision editing session is a fold: call
//! `map_through` once per revision transition, feeding each [`Mapped::Exact`]
//! anchor forward as the input to the next batch.
//!
//! # Boundary policy
//!
//! An edit that ends exactly at the anchor's start, or starts exactly at the
//! anchor's end, does **not** count as touching it — half-open ranges that merely
//! meet, not overlap (mirrors [`crate::apply::apply_edits`]'s "adjacent changes
//! meet cleanly", P4a). Concretely: text inserted immediately before an anchor
//! pushes it forward (the anchor does not absorb it — left gravity); text inserted
//! immediately after it leaves the anchor's range unchanged (right gravity, no
//! growth). Any edit whose range genuinely intersects `[offset, offset+length)` —
//! whole or partial, including a zero-length anchor a non-zero-length edit steps
//! over — is a touch.

use crate::apply::Edit;
use crate::document::Document;
use crate::revision::Revision;
use serde::{Deserialize, Serialize};

/// Bytes of surrounding text captured on each side of an anchor. SPIKE-4
/// (`docs/spikes/spike4-fuzzy-reanchor.md`) answered the provisional question this
/// left open: the byte budget stays 40 (LF-normalization friendly, unaffected by
/// word length), while `reanchor`'s token-level comparison reconciles it against
/// the spike's "8 word tokens" unit by tokenizing this captured window at compare
/// time. `pub(crate)` so `reanchor` can tell a capture-time doc-boundary truncation
/// (`context_before/after.len() < CONTEXT_WINDOW`) from a full window, load-bearing
/// for the orphan boundary rule (spike §7).
pub(crate) const CONTEXT_WINDOW: usize = 40;

/// TD-4's shared anchor shape: a byte range into a named revision of a document,
/// plus enough captured text to re-locate it if exact mapping ever fails.
///
/// `Serialize`/`Deserialize` are load-bearing, not incidental: TD-4 embeds this
/// exact shape in the comment and track-changes sidecar JSON (`store::comments`,
/// P1-9/P1-10) — it is the wire shape, so field names/order changes here are
/// sidecar-format changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    /// Byte offset into the text named by `base_revision`.
    pub offset: usize,
    /// Byte length of the anchored span (zero for a point anchor, e.g. a cursor).
    pub length: usize,
    /// The exact text at `[offset, offset+length)` when this anchor was captured.
    pub text_snapshot: String,
    /// Up to [`CONTEXT_WINDOW`] bytes immediately before `offset`, char-boundary
    /// clamped to the start of the document.
    pub context_before: String,
    /// Up to [`CONTEXT_WINDOW`] bytes immediately after the anchored span,
    /// char-boundary clamped to the end of the document.
    pub context_after: String,
    /// The content-hash revision (TD-6) of the document text this anchor's
    /// `offset`/`length` index into.
    pub base_revision: Revision,
}

/// The outcome of mapping an anchor through an edit batch via exact offset
/// arithmetic (test-plan P2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mapped {
    /// No edit in the batch touched the anchor's range: its offset shifted by the
    /// net length delta of edits strictly before it, length/snapshot/context are
    /// unchanged, and `base_revision` names the batch's resulting text.
    Exact(Anchor),
    /// An edit in the batch overlapped the anchor's range. Exact offset arithmetic
    /// cannot say where the anchored text went (or whether it still exists) — only
    /// snapshot+context fuzzy re-anchor (D17, P1-5a/P1-5b) can resolve this, ending
    /// in either a re-anchored position or an orphan.
    Touched,
}

/// The nearest byte index `<= index` that is a char boundary in `text` (never below
/// `floor`). Used to clamp a context window so it never slices mid-codepoint.
fn floor_char_boundary(text: &str, index: usize, floor: usize) -> usize {
    let mut i = index.min(text.len());
    while i > floor && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// The nearest byte index `>= index` that is a char boundary in `text` (never above
/// `ceil`).
fn ceil_char_boundary(text: &str, index: usize, ceil: usize) -> usize {
    let mut i = index.min(ceil);
    while i < ceil && !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

impl Anchor {
    /// Capture a new anchor at `[offset, offset+length)` in `doc`.
    ///
    /// Records the exact text at that range, bounded context on either side, and
    /// `doc`'s revision as `base_revision`. Panics if the range is out of bounds or
    /// not on char boundaries — a caller bug (matches [`crate::apply::apply_edits`]'s
    /// panic-on-invalid-range contract; there is no silently-wrong anchor).
    pub fn new(doc: &Document, offset: usize, length: usize) -> Anchor {
        let text = doc.text();
        let end = offset + length;
        let before_start = floor_char_boundary(text, offset.saturating_sub(CONTEXT_WINDOW), 0);
        let after_end = ceil_char_boundary(text, end.saturating_add(CONTEXT_WINDOW), text.len());
        Anchor {
            offset,
            length,
            text_snapshot: text[offset..end].to_string(),
            context_before: text[before_start..offset].to_string(),
            context_after: text[end..after_end].to_string(),
            base_revision: doc.revision(),
        }
    }

    /// Map this anchor through a batch of edits, advancing `base_revision` to
    /// `new_revision` on success.
    ///
    /// See the module docs for the edit-batch contract (disjoint, measured against
    /// this anchor's current base text) and boundary policy (touching, not
    /// overlapping, doesn't count). `new_revision` is the caller's responsibility —
    /// typically `Revision::of`/`Document::revision` on the text that results from
    /// applying `edits` to this anchor's base text.
    pub fn map_through(&self, edits: &[Edit], new_revision: Revision) -> Mapped {
        let start = self.offset;
        let end = self.offset + self.length;
        let mut delta: isize = 0;
        for edit in edits {
            if edit.range.end <= start {
                // Entirely before the anchor: its length delta shifts the anchor.
                let removed = (edit.range.end - edit.range.start) as isize;
                let inserted = edit.replacement.len() as isize;
                delta += inserted - removed;
            } else if edit.range.start >= end {
                // Entirely after the anchor: no effect on its offset.
            } else {
                // Genuinely overlaps [start, end) — exact mapping cannot say where
                // the anchored text went.
                return Mapped::Touched;
            }
        }
        let new_offset = (start as isize + delta) as usize;
        Mapped::Exact(Anchor {
            offset: new_offset,
            length: self.length,
            text_snapshot: self.text_snapshot.clone(),
            context_before: self.context_before.clone(),
            context_after: self.context_after.clone(),
            base_revision: new_revision,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(range: std::ops::Range<usize>, replacement: &str) -> Edit {
        Edit {
            range,
            replacement: replacement.to_string(),
        }
    }

    // --- construction --------------------------------------------------------

    #[test]
    fn new_captures_the_exact_span_and_the_documents_revision() {
        let doc = Document::new("The quick brown fox jumps.");
        let a = Anchor::new(&doc, 4, 5); // "quick"
        assert_eq!(a.offset, 4);
        assert_eq!(a.length, 5);
        assert_eq!(a.text_snapshot, "quick");
        assert_eq!(a.base_revision, doc.revision());
    }

    #[test]
    fn new_captures_context_before_and_after() {
        let doc = Document::new("abc[TARGET]xyz");
        let a = Anchor::new(&doc, 3, 8); // "[TARGET]"
        assert_eq!(a.context_before, "abc");
        assert_eq!(a.context_after, "xyz");
    }

    #[test]
    fn new_clamps_context_to_the_context_window() {
        let text = format!("{}TARGET{}", "b".repeat(100), "a".repeat(100));
        let doc = Document::new(text);
        let a = Anchor::new(&doc, 100, 6);
        assert_eq!(a.context_before.len(), CONTEXT_WINDOW);
        assert_eq!(a.context_after.len(), CONTEXT_WINDOW);
        assert!(a.context_before.chars().all(|c| c == 'b'));
        assert!(a.context_after.chars().all(|c| c == 'a'));
    }

    #[test]
    fn new_clamps_context_at_document_boundaries() {
        let doc = Document::new("hi[TARGET]bye");
        let a = Anchor::new(&doc, 2, 8);
        assert_eq!(a.context_before, "hi");
        assert_eq!(a.context_after, "bye");
    }

    #[test]
    fn new_never_slices_mid_codepoint_in_context() {
        // Multi-byte chars right at the context window's natural cut point.
        let text = format!("{}TARGET{}", "é".repeat(50), "é".repeat(50));
        let doc = Document::new(text.clone());
        let target = text.find("TARGET").unwrap();
        // Should not panic (would, on a mid-codepoint slice), and should stay valid UTF-8.
        let a = Anchor::new(&doc, target, "TARGET".len());
        assert!(a.context_before.len() <= CONTEXT_WINDOW);
        assert!(a.context_after.len() <= CONTEXT_WINDOW);
    }

    #[test]
    fn anchor_round_trips_through_json() {
        // Wire-format check (TD-4): comment/track-changes sidecars embed this shape
        // verbatim in JSON, so serialize/deserialize must be lossless.
        let doc = Document::new("The quick brown fox jumps.");
        let a = Anchor::new(&doc, 4, 5);
        let json = serde_json::to_string(&a).unwrap();
        let back: Anchor = serde_json::from_str(&json).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn zero_length_anchor_captures_an_empty_snapshot() {
        let doc = Document::new("hello world");
        let a = Anchor::new(&doc, 5, 0);
        assert_eq!(a.text_snapshot, "");
        assert_eq!(a.context_before, "hello");
        assert_eq!(a.context_after, " world");
    }

    // --- exact mapping: untouched ---------------------------------------------

    #[test]
    fn no_edits_leaves_the_anchor_in_place_but_advances_revision() {
        let doc = Document::new("Hello world");
        let a = Anchor::new(&doc, 6, 5); // "world"
        let new_rev = Revision::of("Hello world");
        match a.map_through(&[], new_rev.clone()) {
            Mapped::Exact(mapped) => {
                assert_eq!(mapped.offset, 6);
                assert_eq!(mapped.length, 5);
                assert_eq!(mapped.base_revision, new_rev);
            }
            Mapped::Touched => panic!("expected Exact"),
        }
    }

    #[test]
    fn insertion_before_the_anchor_shifts_it_forward() {
        let doc = Document::new("Hello world");
        let a = Anchor::new(&doc, 6, 5); // "world"
        let edits = [edit(0..0, "Say: ")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "Say: Hello world");
        match a.map_through(&edits, Revision::of(&new_text)) {
            Mapped::Exact(mapped) => {
                assert_eq!(mapped.offset, 11);
                assert_eq!(mapped.length, 5);
                assert_eq!(
                    &new_text[mapped.offset..mapped.offset + mapped.length],
                    "world"
                );
            }
            Mapped::Touched => panic!("expected Exact"),
        }
    }

    #[test]
    fn deletion_before_the_anchor_shifts_it_backward() {
        let doc = Document::new("Hello world");
        let a = Anchor::new(&doc, 6, 5); // "world"
        let edits = [edit(0..6, "")]; // delete "Hello "
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "world");
        match a.map_through(&edits, Revision::of(&new_text)) {
            Mapped::Exact(mapped) => {
                assert_eq!(mapped.offset, 0);
                assert_eq!(mapped.length, 5);
            }
            Mapped::Touched => panic!("expected Exact"),
        }
    }

    #[test]
    fn edit_after_the_anchor_does_not_move_it() {
        let doc = Document::new("Hello world");
        let a = Anchor::new(&doc, 0, 5); // "Hello"
        let edits = [edit(6..11, "there")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "Hello there");
        match a.map_through(&edits, Revision::of(&new_text)) {
            Mapped::Exact(mapped) => {
                assert_eq!(mapped.offset, 0);
                assert_eq!(mapped.length, 5);
            }
            Mapped::Touched => panic!("expected Exact"),
        }
    }

    #[test]
    fn insertion_exactly_at_the_anchor_start_pushes_it_forward_not_absorbed() {
        let doc = Document::new("[TARGET]");
        let a = Anchor::new(&doc, 0, 8);
        let edits = [edit(0..0, "pre-")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "pre-[TARGET]");
        let Mapped::Exact(mapped) = a.map_through(&edits, Revision::of(&new_text)) else {
            panic!("touching, not overlapping — expected Exact");
        };
        assert_eq!(mapped.offset, 4);
        assert_eq!(mapped.length, 8);
        assert_eq!(&new_text[4..12], "[TARGET]");
    }

    #[test]
    fn insertion_exactly_at_the_anchor_end_does_not_grow_it() {
        let doc = Document::new("[TARGET]");
        let a = Anchor::new(&doc, 0, 8);
        let edits = [edit(8..8, "-post")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "[TARGET]-post");
        let Mapped::Exact(mapped) = a.map_through(&edits, Revision::of(&new_text)) else {
            panic!("touching, not overlapping — expected Exact");
        };
        assert_eq!(mapped.offset, 0);
        assert_eq!(mapped.length, 8);
    }

    #[test]
    fn multiple_disjoint_edits_before_the_anchor_sum_their_deltas() {
        let doc = Document::new("aaXbbYcc[TARGET]");
        let a = Anchor::new(&doc, 8, 8);
        // Replace "aa" (2->0) and "bb" (2->4): net delta = -2 + 2 = 0.
        let edits = [edit(0..2, ""), edit(3..5, "BBBB")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "XBBBBYcc[TARGET]");
        let Mapped::Exact(mapped) = a.map_through(&edits, Revision::of(&new_text)) else {
            panic!("expected Exact");
        };
        assert_eq!(mapped.offset, 8);
        assert_eq!(
            &new_text[mapped.offset..mapped.offset + mapped.length],
            "[TARGET]"
        );
    }

    // --- touched: exact mapping cannot resolve --------------------------------

    #[test]
    fn edit_fully_containing_the_anchor_is_touched() {
        let doc = Document::new("x[TARGET]y");
        let a = Anchor::new(&doc, 1, 8);
        let edits = [edit(0..10, "gone")];
        assert_eq!(a.map_through(&edits, Revision::of("gone")), Mapped::Touched);
    }

    #[test]
    fn edit_nested_inside_the_anchor_is_touched() {
        let doc = Document::new("[TARGET]");
        let a = Anchor::new(&doc, 0, 8);
        let edits = [edit(2..4, "XX")]; // touches inside "TARGET"
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(
            a.map_through(&edits, Revision::of(&new_text)),
            Mapped::Touched
        );
    }

    #[test]
    fn edit_overlapping_the_anchors_leading_edge_is_touched() {
        let doc = Document::new("ab[TARGET]");
        let a = Anchor::new(&doc, 2, 8);
        let edits = [edit(0..3, "z")]; // ends inside the anchor
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(
            a.map_through(&edits, Revision::of(&new_text)),
            Mapped::Touched
        );
    }

    #[test]
    fn edit_overlapping_the_anchors_trailing_edge_is_touched() {
        let doc = Document::new("[TARGET]cd");
        let a = Anchor::new(&doc, 0, 8);
        let edits = [edit(6..10, "z")]; // starts inside the anchor
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(
            a.map_through(&edits, Revision::of(&new_text)),
            Mapped::Touched
        );
    }

    #[test]
    fn zero_length_anchor_is_touched_when_an_edit_straddles_it() {
        let doc = Document::new("abcd");
        let a = Anchor::new(&doc, 2, 0); // point between 'b' and 'c'
        let edits = [edit(1..3, "Z")]; // spans across the point
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(
            a.map_through(&edits, Revision::of(&new_text)),
            Mapped::Touched
        );
    }

    #[test]
    fn zero_length_anchor_is_exact_when_insertion_lands_exactly_on_it() {
        let doc = Document::new("abcd");
        let a = Anchor::new(&doc, 2, 0);
        let edits = [edit(2..2, "Z")];
        let new_text = crate::apply::apply_edits(doc.text(), &edits);
        assert_eq!(new_text, "abZcd");
        let Mapped::Exact(mapped) = a.map_through(&edits, Revision::of(&new_text)) else {
            panic!("expected Exact (left gravity: insertion pushes the point forward)");
        };
        assert_eq!(mapped.offset, 3);
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    /// A document plus a disjoint edit batch, all measured against it, generated so
    /// none of the edits touch a chosen anchor range — exercises the P2
    /// exact-mapping property under random edit sequences (issue #40 acceptance).
    ///
    /// Strategy: build the document out of five ASCII segments; the anchor always
    /// covers segment `C` (the middle one); edits are drawn from replacing segments
    /// `A`/`B`/`D`/`E` with arbitrary text — never `C` — so by construction no edit
    /// can overlap the anchor, whatever lengths are generated.
    fn segment() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9]{0,6}"
    }

    fn replacement() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ]{0,10}"
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // P2 exact-mapping, untouched: whatever the surrounding edits do, the
        // anchor's mapped range in the resulting text is still exactly its
        // original text_snapshot, and base_revision names that resulting text.
        #[test]
        fn prop_exact_mapping_survives_arbitrary_untouched_edit_batches(
            a in segment(), b in segment(), c in segment(), d in segment(), e in segment(),
            replace_a in prop::option::of(replacement()),
            replace_b in prop::option::of(replacement()),
            replace_d in prop::option::of(replacement()),
            replace_e in prop::option::of(replacement()),
        ) {
            let doc_text = format!("{a}{b}{c}{d}{e}");
            let doc = Document::new(doc_text.clone());

            let c_start = a.len() + b.len();
            let c_end = c_start + c.len();
            let anchor = Anchor::new(&doc, c_start, c.len());
            prop_assert_eq!(&anchor.text_snapshot, &c);

            let mut edits = Vec::new();
            if let Some(r) = &replace_a {
                edits.push(Edit { range: 0..a.len(), replacement: r.clone() });
            }
            if let Some(r) = &replace_b {
                edits.push(Edit { range: a.len()..a.len() + b.len(), replacement: r.clone() });
            }
            if let Some(r) = &replace_d {
                edits.push(Edit { range: c_end..c_end + d.len(), replacement: r.clone() });
            }
            if let Some(r) = &replace_e {
                let d_end = c_end + d.len();
                edits.push(Edit { range: d_end..d_end + e.len(), replacement: r.clone() });
            }

            let new_text = crate::apply::apply_edits(&doc_text, &edits);
            let new_revision = Revision::of(&new_text);

            match anchor.map_through(&edits, new_revision.clone()) {
                Mapped::Exact(mapped) => {
                    prop_assert_eq!(mapped.length, c.len());
                    prop_assert_eq!(mapped.base_revision, new_revision);
                    prop_assert!(mapped.offset + mapped.length <= new_text.len());
                    prop_assert_eq!(&new_text[mapped.offset..mapped.offset + mapped.length], &c);
                    // Snapshot/context are carried through unchanged (module contract).
                    prop_assert_eq!(&mapped.text_snapshot, &anchor.text_snapshot);
                    prop_assert_eq!(&mapped.context_before, &anchor.context_before);
                    prop_assert_eq!(&mapped.context_after, &anchor.context_after);
                }
                Mapped::Touched => prop_assert!(false, "no edit should have touched the anchor's segment"),
            }
        }

        // The touched side of P2: an edit that overlaps the anchor's range is
        // always reported as Touched, regardless of what else is in the batch.
        #[test]
        fn prop_any_overlapping_edit_in_the_batch_is_touched(
            a in segment(), c in "[a-zA-Z0-9]{1,6}", d in segment(),
            overlap_start_in_c in 0usize..6,
            overlap_len in 1usize..4,
            replacement in replacement(),
        ) {
            let doc_text = format!("{a}{c}{d}");
            let doc = Document::new(doc_text.clone());
            let c_start = a.len();
            let c_end = c_start + c.len();
            prop_assume!(c_end > c_start);
            let anchor = Anchor::new(&doc, c_start, c.len());

            // An edit range that starts inside [c_start, c_end) — guaranteed overlap.
            let start = c_start + (overlap_start_in_c % c.len());
            let end = (start + overlap_len).min(doc_text.len()).max(start + 1);
            let overlapping = Edit { range: start..end, replacement };

            // Char-boundary safety: skip generated cases that would land mid-codepoint
            // (content here is ASCII so this never trips, kept as a documented guard).
            prop_assume!(doc_text.is_char_boundary(start) && doc_text.is_char_boundary(end));

            prop_assert_eq!(anchor.map_through(&[overlapping], Revision::of("irrelevant")), Mapped::Touched);
        }
    }
}
