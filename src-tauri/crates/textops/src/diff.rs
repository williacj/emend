// ABOUTME: Diff -> edit-list — old/new text diff into a minimal, context-anchored edit list (FR-REV-1).
// ABOUTME: Feeds TD-7 delivery rebasing: each edit's TD-6 anchor is the context snapshot P1-11 validates against.

//! Diffing whole-document text into a minimal edit list (FR-REV-1, TD-7).
//!
//! "Revise" (FR-REV-1) can be handed a pasted external draft: a whole replacement
//! text with no discrete edit structure of its own. To land it as tracked changes
//! (not a full-document replace-everything blob) the app diffs the currently open
//! text against the revision and turns the result into the same shape a
//! structured `propose_changes` call would carry — a list of disjoint edits.
//!
//! [`diff`] computes the **shortest edit script** (Myers, 1986) between `old` and
//! `new` over Unicode scalar values (`char`s — always byte-boundary-safe, unlike
//! an arbitrary byte split) and coalesces each contiguous run of changed
//! characters into one [`RevisionEdit`]: a byte range in `old` (TD-6's canonical
//! coordinate space) paired with its replacement text. Unchanged runs between
//! edits are not represented — they need no anchor because nothing touches them.
//!
//! # Context snapshots (TD-7)
//!
//! Each edit's range is captured as a full [`Anchor`] (`text_snapshot`,
//! `context_before`/`context_after`, `base_revision`) against `old`, not a bare
//! `{range, replacement}` pair. This is the P1-11 delivery-rebasing input: TD-7
//! validates each edit's context snapshot against the live document at delivery
//! time, applying the edits whose context still matches and returning the rest to
//! the agent as structured partial-stale. This module only produces that anchored
//! edit list; the rebase/apply/attribution machinery is P1-11's job.
//!
//! # Minimality
//!
//! The edit list is minimal in the Myers sense: it is a shortest edit script, so
//! two texts differing by one inserted character produce one small edit, not a
//! whole-document replacement — the point of diffing rather than always emitting
//! a single `{range: 0..old.len(), replacement: new}` edit (which would also
//! satisfy "applying the edit list reproduces the new text" but defeats the
//! purpose: a one-word revision would blow away every other pending change's
//! anchors and attribute the whole document to the agent).

use crate::anchor::Anchor;
use crate::apply::Edit;
use crate::document::Document;

/// One diffed edit: `anchor` is the TD-6/TD-7 context snapshot of the `old`-text
/// range being replaced; `replacement` is the text from `new` that replaces it.
///
/// `anchor.offset`/`anchor.length` is exactly the byte range in `old` this edit
/// touches (an empty range for a pure insertion); `anchor.text_snapshot` is that
/// range's exact text, `context_before`/`context_after` its surrounding bytes, and
/// `base_revision` names `old` itself — the shape [`crate::apply::apply_edits`]
/// and TD-7's rebase validation both consume.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionEdit {
    /// The context snapshot of the `old`-text range this edit replaces.
    pub anchor: Anchor,
    /// The `new`-text this range is replaced with (empty for a pure deletion).
    pub replacement: String,
}

impl RevisionEdit {
    /// This edit's plain [`Edit`] shape — `anchor.offset..anchor.offset+anchor.length`
    /// paired with `replacement` — for feeding [`crate::apply::apply_edits`] or a
    /// batch of `RevisionEdit`s through anything that only needs the range, not the
    /// full context snapshot (e.g. TD-7 rebasing's post-validation apply, P1-11).
    pub fn as_edit(&self) -> Edit {
        Edit {
            range: self.anchor.offset..self.anchor.offset + self.anchor.length,
            replacement: self.replacement.clone(),
        }
    }
}

/// Diff `old` into `new`, returning the minimal, context-anchored edit list.
///
/// Applying the returned edits' ranges/replacements to `old` (e.g. via
/// [`crate::apply::apply_edits`]) reproduces `new` exactly. Identical inputs
/// produce an empty list. Edits are disjoint and returned in document order (old
/// coordinates), so they satisfy `apply_edits`'s edit-batch contract directly.
pub fn diff(old: &str, new: &str) -> Vec<RevisionEdit> {
    let doc = Document::new(old);
    minimal_edits(old, new)
        .into_iter()
        .map(|edit| {
            let length = edit.range.end - edit.range.start;
            RevisionEdit {
                anchor: Anchor::new(&doc, edit.range.start, length),
                replacement: edit.replacement,
            }
        })
        .collect()
}

/// The shortest edit script between `old` and `new`, coalesced into disjoint
/// `Edit`s at byte ranges in `old`. Diffing is char-granular (Unicode scalar
/// values), so every produced range lands on a char boundary.
fn minimal_edits(old: &str, new: &str) -> Vec<Edit> {
    if old == new {
        return Vec::new();
    }

    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();

    // Byte offset of each char index in `old`, so a char-index range maps
    // straight to a byte range (always on a char boundary, since these come from
    // char_indices). `new`'s replacement text is built straight from `b`'s chars,
    // so it needs no equivalent byte-offset table.
    let a_byte = byte_offsets(old);

    let trace = myers_trace(&a, &b);
    let moves = backtrack(&a, &b, &trace);

    let mut edits = Vec::new();
    let mut i = 0;
    while i < moves.len() {
        let (px, py, x, y) = moves[i];
        if is_diagonal(px, py, x, y) {
            i += 1;
            continue;
        }
        // Start of a contiguous non-equal run: consume every following move
        // until the next diagonal (equal) move or the end of the script.
        let (start_x, start_y) = (px, py);
        let (mut end_x, mut end_y) = (x, y);
        i += 1;
        while i < moves.len() {
            let (px2, py2, x2, y2) = moves[i];
            if is_diagonal(px2, py2, x2, y2) {
                break;
            }
            end_x = x2;
            end_y = y2;
            i += 1;
        }

        let old_range = a_byte[start_x as usize]..a_byte[end_x as usize];
        let replacement: String = b[start_y as usize..end_y as usize].iter().collect();
        edits.push(Edit {
            range: old_range,
            replacement,
        });
    }
    edits
}

fn is_diagonal(px: isize, py: isize, x: isize, y: isize) -> bool {
    x - px == 1 && y - py == 1
}

/// Byte offset of every char boundary in `s`, plus a trailing `s.len()` — so a
/// char-index range `[i, j)` maps to the byte range `offsets[i]..offsets[j]`.
fn byte_offsets(s: &str) -> Vec<usize> {
    let mut offsets: Vec<usize> = s.char_indices().map(|(i, _)| i).collect();
    offsets.push(s.len());
    offsets
}

/// Myers' O(ND) shortest-edit-script trace (Eugene Myers, "An O(ND) Difference
/// Algorithm and Its Variations", 1986): `trace[d]` is the furthest-reaching `x`
/// on every diagonal `k` after exploring `d` edits, captured *before* diagonal
/// `d`'s own moves are applied (so [`backtrack`] can recover, for each `d`, the
/// single non-diagonal move that entered it). Returns as soon as the script
/// reaches `(a.len(), b.len())`.
///
/// `D` (the edit distance) drives both time and the retained trace's space —
/// cheap for the common revision case (most of the document is unchanged, so `D`
/// is small relative to document length) and quadratic in the worst case
/// (`old`/`new` share almost nothing). Full-document-scale performance is a
/// benchmark-suite concern (test-plan §6, P2b-10), not this unit's.
fn myers_trace(a: &[char], b: &[char]) -> Vec<Vec<isize>> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let max = n + m;
    // Diagonals range over [-(max+1), max+1] (the outer probes at d==max read
    // one diagonal past d, hence the +1 headroom); offset re-bases that range
    // onto a dense non-negative array index.
    let offset = max + 1;
    let width = (2 * offset + 1) as usize;
    let idx = |k: isize| (k + offset) as usize;

    let mut v = vec![0isize; width];
    let mut trace = Vec::with_capacity((max + 1) as usize);

    for d in 0..=max {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[idx(k - 1)] < v[idx(k + 1)]) {
                v[idx(k + 1)] // came from a vertical move (insertion)
            } else {
                v[idx(k - 1)] + 1 // came from a horizontal move (deletion)
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx(k)] = x;
            if x >= n && y >= m {
                return trace;
            }
            k += 2;
        }
    }
    trace
}

/// Walk [`myers_trace`]'s output backward from `(a.len(), b.len())` to `(0, 0)`,
/// yielding every single-character move `(prev_x, prev_y, x, y)` in forward
/// (document) order. A diagonal move (`x-prev_x==1 && y-prev_y==1`) is a kept
/// (equal) character; `y` unchanged is a deletion of `a[prev_x]`; `x` unchanged is
/// an insertion of `b[prev_y]`.
fn backtrack(a: &[char], b: &[char], trace: &[Vec<isize>]) -> Vec<(isize, isize, isize, isize)> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let max = n + m;
    let offset = max + 1;
    let idx = |k: isize| (k + offset) as usize;

    let mut x = n;
    let mut y = m;
    let mut moves = Vec::new();

    for d in (0..trace.len() as isize).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && v[idx(k - 1)] < v[idx(k + 1)]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = v[idx(prev_k)];
        let prev_y = prev_x - prev_k;

        while x > prev_x && y > prev_y {
            moves.push((x - 1, y - 1, x, y));
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            moves.push((prev_x, prev_y, x, y));
        }
        x = prev_x;
        y = prev_y;
    }

    moves.reverse();
    moves
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(doc: &str, e: &RevisionEdit) -> (String, String) {
        let raw = doc[e.anchor.offset..e.anchor.offset + e.anchor.length].to_string();
        (raw, e.replacement.clone())
    }

    // --- reproduction --------------------------------------------------------

    #[test]
    fn identical_texts_produce_no_edits() {
        assert_eq!(diff("hello world", "hello world"), vec![]);
    }

    #[test]
    fn empty_to_empty_produces_no_edits() {
        assert_eq!(diff("", ""), vec![]);
    }

    #[test]
    fn pure_insertion_at_the_end() {
        let edits = diff("hello", "hello world");
        assert_eq!(edits.len(), 1);
        assert_eq!(edit("hello", &edits[0]), ("".into(), " world".into()));
        assert_eq!(edits[0].anchor.offset, 5);
        assert_eq!(edits[0].anchor.length, 0);
    }

    #[test]
    fn pure_insertion_at_the_start() {
        let edits = diff("world", "hello world");
        assert_eq!(edits.len(), 1);
        assert_eq!(edit("world", &edits[0]), ("".into(), "hello ".into()));
        assert_eq!(edits[0].anchor.offset, 0);
    }

    #[test]
    fn pure_deletion() {
        let edits = diff("hello world", "hello");
        assert_eq!(edits.len(), 1);
        assert_eq!(edit("hello world", &edits[0]), (" world".into(), "".into()));
    }

    #[test]
    fn a_single_word_substitution_in_the_middle_is_one_small_edit() {
        // Minimality: this must not become a whole-document replace. "jumps" and
        // "leaps" share a common suffix ("ps"), so the truly shortest edit script
        // touches only "jum" -> "lea" and leaves "ps" (and everything else) alone
        // — smaller than replacing the whole word, which is exactly the point.
        let old = "The quick brown fox jumps over the lazy dog.";
        let new = "The quick brown fox leaps over the lazy dog.";
        let edits = diff(old, new);
        assert_eq!(edits.len(), 1);
        assert_eq!(edit(old, &edits[0]), ("jum".into(), "lea".into()));
    }

    #[test]
    fn two_separate_edits_stay_separate_and_ordered() {
        let old = "alpha beta gamma delta";
        let new = "ALPHA beta GAMMA delta";
        let edits = diff(old, new);
        assert_eq!(edits.len(), 2);
        assert_eq!(edit(old, &edits[0]), ("alpha".into(), "ALPHA".into()));
        assert_eq!(edit(old, &edits[1]), ("gamma".into(), "GAMMA".into()));
        assert!(edits[0].anchor.offset < edits[1].anchor.offset);
    }

    #[test]
    fn total_replacement_of_unrelated_text() {
        let edits = diff("abc", "xyz");
        let plain: Vec<Edit> = edits.iter().map(RevisionEdit::as_edit).collect();
        let reconstructed = crate::apply::apply_edits("abc", &plain);
        assert_eq!(reconstructed, "xyz");
    }

    #[test]
    fn multibyte_unicode_is_not_split_mid_codepoint() {
        let old = "café résumé";
        let new = "café resume";
        let edits = diff(old, new);
        assert!(!edits.is_empty());
        for e in &edits {
            assert!(old.is_char_boundary(e.anchor.offset));
            assert!(old.is_char_boundary(e.anchor.offset + e.anchor.length));
        }
        let plain: Vec<Edit> = edits.iter().map(RevisionEdit::as_edit).collect();
        let reconstructed = crate::apply::apply_edits(old, &plain);
        assert_eq!(reconstructed, new);
    }

    // --- anchors are valid context snapshots (TD-6/TD-7) ----------------------

    #[test]
    fn each_edits_anchor_names_the_old_texts_revision() {
        let old = "The quick brown fox.";
        let new = "The slow brown fox.";
        let edits = diff(old, new);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].anchor.base_revision, crate::Revision::of(old));
    }

    #[test]
    fn each_edits_anchor_snapshot_matches_the_replaced_old_text() {
        let old = "one two three four";
        let new = "one TWO three FOUR";
        for e in diff(old, new) {
            let slice = &old[e.anchor.offset..e.anchor.offset + e.anchor.length];
            assert_eq!(slice, e.anchor.text_snapshot);
        }
    }

    #[test]
    fn each_edits_anchor_captures_surrounding_context() {
        // Digits chosen with disjoint character sets on each side so the
        // shortest edit script is unambiguous: exactly one edit, not several
        // interleaved with kept characters.
        let old = "before 12345 after";
        let new = "before 67890 after";
        let edits = diff(old, new);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].anchor.context_before, "before ");
        assert_eq!(edits[0].anchor.context_after, " after");
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    /// Feed `old`/`new` through [`diff`], convert to plain [`Edit`]s, and apply
    /// them to `old`.
    fn reconstruct(old: &str, new: &str) -> (Vec<RevisionEdit>, String) {
        let edits = diff(old, new);
        let plain: Vec<Edit> = edits.iter().map(RevisionEdit::as_edit).collect();
        let text = crate::apply::apply_edits(old, &plain);
        (edits, text)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // Issue #44 acceptance, half 1: applying the edit list reproduces `new`,
        // for arbitrary old/new text (including empty, unicode, control chars).
        #[test]
        fn prop_applying_the_edit_list_reproduces_new_text(old in "(?s).{0,80}", new in "(?s).{0,80}") {
            let (_, reconstructed) = reconstruct(&old, &new);
            prop_assert_eq!(reconstructed, new);
        }

        // Issue #44 acceptance, half 2: every edit carries a valid anchor — its
        // range is a real, char-boundary-safe span of `old` (guaranteed by
        // Anchor::new not panicking), its snapshot matches that span exactly, and
        // its base_revision names `old`.
        #[test]
        fn prop_every_edit_carries_a_valid_anchor(old in "(?s).{0,80}", new in "(?s).{0,80}") {
            let edits = diff(&old, &new);
            let expected_revision = crate::Revision::of(&old);
            for e in &edits {
                let a = &e.anchor;
                prop_assert!(a.offset + a.length <= old.len());
                prop_assert_eq!(&old[a.offset..a.offset + a.length], a.text_snapshot.as_str());
                prop_assert_eq!(&a.base_revision, &expected_revision);
            }
        }

        // The edit list is disjoint and in ascending document order — the batch
        // apply_edits contract diff's own reconstruction property above already
        // exercises, but pinned explicitly since it is what makes the list a
        // valid TD-7 edit batch (matches anchor::map_through's edit-batch contract).
        #[test]
        fn prop_edits_are_disjoint_and_ordered(old in "(?s).{0,80}", new in "(?s).{0,80}") {
            let edits = diff(&old, &new);
            for w in edits.windows(2) {
                let end0 = w[0].anchor.offset + w[0].anchor.length;
                prop_assert!(end0 <= w[1].anchor.offset);
            }
        }

        // Identity: diffing a text against itself always yields no edits.
        #[test]
        fn prop_identical_text_yields_no_edits(text in "(?s).{0,80}") {
            prop_assert_eq!(diff(&text, &text), vec![]);
        }

        // Reflexivity of reconstruction from the other direction: diffing `new`
        // against `old` and applying to `new` reproduces `old` — the algorithm is
        // symmetric under swap, not directional.
        #[test]
        fn prop_diff_is_reversible(old in "(?s).{0,80}", new in "(?s).{0,80}") {
            let (_, reconstructed) = reconstruct(&new, &old);
            prop_assert_eq!(reconstructed, old);
        }
    }
}
