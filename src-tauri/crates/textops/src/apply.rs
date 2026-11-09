// ABOUTME: Accept/reject apply ops — resolve CriticMarkup changes to plain text edits (P4a/P4b, FR-ED-4).
// ABOUTME: Group-linked changes decide all-or-none (TD-2: accept/reject are small text edits at known ranges).

//! Applying accept/reject decisions to a document's CriticMarkup (FR-ED-4).
//!
//! A decision on a single change is exactly one text edit at a known byte range
//! (TD-2): its whole marker span (`Markup.full`) is replaced by the text the
//! decision keeps. The three markers resolve like this:
//!
//! | marker                | Accept          | Reject          |
//! |-----------------------|-----------------|-----------------|
//! | `{++text++}` insertion| `text`          | *(removed)*     |
//! | `{--text--}` deletion | *(removed)*     | `text`          |
//! | `{~~old~>new~~}` sub   | `new`           | `old`           |
//!
//! **Accept-all yields the clean text; reject-all yields the original text**
//! (test-plan P4a) — [`accept_all`] and [`reject_all`] are those two anchors.
//! An undecided change (`None`) is left verbatim, braces intact, so any *subset*
//! of decisions applies and the rest stay pending. Because each decision edits a
//! disjoint span, the batch [`apply`] is order-independent.
//!
//! # Incremental application and its one caveat
//!
//! Within P4a's domain — independent changes whose *resolved* text forms no new
//! markup — applying the same decisions one edit at a time (re-parsing between)
//! converges to the identical batch text (P4a subset-order convergence). That
//! qualifier is load-bearing. CriticMarkup has no escaping and the parser nests
//! first-closer-wins, so an insertion's literal content can itself contain a
//! complete marker: `{++ {--z--} ++}` is *one* insertion of ` {--z--} `, not an
//! insertion around a deletion. Accepting it reveals a `{--z--}` that a re-parse
//! then reads as a real deletion — so a consumer that re-parses and re-indexes its
//! remaining decisions *positionally* would land a later decision on the wrong
//! change and corrupt the document. The batch [`apply`] result is the correct one
//! (it resolves every decision against a single parse of the original). The interactive
//! editor accept/reject wiring (P2a-5) must do the same: resolve queued decisions
//! against one parse snapshot (as [`apply`] does), or key decisions to a stable change
//! identity; never re-parse-then-positional-index. Whole-document consumers — the
//! display-mode projections (P1-7) and the P1-11 delivery partition-apply — are batch
//! and safe by construction (TD-11 corollary).
//!
//! # Groups (P4b)
//!
//! Some changes are linked — a substitution rendered as a `{--old--}{++new++}`
//! pair, or an agent-delivered set that must land whole. A [`Grouping`] records
//! those links; deciding **any** member decides the whole group, all-or-none.
//! Atomicity lives entirely in how decisions are *formed* ([`Grouping::decide`]);
//! [`apply`] itself is group-oblivious — it consumes the finished decision vector.
//!
//! # Coordinate space
//!
//! Every range is a byte offset into the exact string passed in (TD-6), matching
//! [`crate::critic::parse`]. Decisions are indexed positionally against that
//! parse: `decisions[i]` decides `parse(doc)[i]`.

use crate::critic::{parse, Markup, MarkupKind};
use std::ops::Range;

/// Whether to keep a change's proposed effect ([`Accept`](Decision::Accept)) or
/// discard it ([`Reject`](Decision::Reject)).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Keep the change: insertion's text stays, deletion's text goes, substitution
    /// takes `new`.
    Accept,
    /// Discard the change: insertion's text goes, deletion's text stays,
    /// substitution takes `old`.
    Reject,
}

/// A single text edit: replace `range` (a byte range in the source document) with
/// `replacement`. One accept/reject of one change is exactly one `Edit`, which the
/// editor records as a single undo entry (finding M9, TD-2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    /// Byte range in the source document to replace — a change's whole marker span.
    pub range: Range<usize>,
    /// Text to put in its place (the kept side of the change; empty when the change
    /// removes text).
    pub replacement: String,
}

/// The text a single marker resolves to under `decision` — a borrow into `doc`
/// (always one of the marker's inner segments, or the empty string).
///
/// `pub(crate)` so [`crate::coords`] can build the "resolve every change one way"
/// edit list its `clean` (accept-all) coordinate transform needs, without
/// duplicating this match (TD-6; the P4a accept-all anchor and the P3 `clean`
/// space are the same resolution, named for two different audiences).
pub(crate) fn resolution<'a>(doc: &'a str, markup: &Markup, decision: Decision) -> &'a str {
    use Decision::{Accept, Reject};
    use MarkupKind::{Deletion, Insertion, Substitution};
    match (&markup.kind, decision) {
        (Insertion { text }, Accept) => &doc[text.clone()],
        (Insertion { .. }, Reject) => "",
        (Deletion { .. }, Accept) => "",
        (Deletion { text }, Reject) => &doc[text.clone()],
        (Substitution { new, .. }, Accept) => &doc[new.clone()],
        (Substitution { old, .. }, Reject) => &doc[old.clone()],
    }
}

/// The edits that enact `decisions` against `doc`'s CriticMarkup.
///
/// `decisions[i]` decides `parse(doc)[i]`; `None` (or a short slice) leaves that
/// change pending, so no edit is produced for it. The returned edits are disjoint
/// and in document order — feed them to [`apply_edits`], or hand a single-change
/// slice to the editor for one undoable accept/reject.
pub fn edits(doc: &str, decisions: &[Option<Decision>]) -> Vec<Edit> {
    parse(doc)
        .iter()
        .enumerate()
        .filter_map(|(i, markup)| {
            decisions.get(i).copied().flatten().map(|decision| Edit {
                range: markup.full.clone(),
                replacement: resolution(doc, markup, decision).to_string(),
            })
        })
        .collect()
}

/// Apply disjoint `edits` to `doc`, returning the resulting text.
///
/// Order-independent: edits are sorted by start before splicing, so the caller may
/// pass them in any order. Every `range` must be a valid char-boundary sub-range of
/// `doc` and no two may overlap — edits from [`edits`] always satisfy both; a caller
/// that violates either gets a panic (out-of-bounds / mid-codepoint slice, or the
/// overlap assertion), never a silently wrong splice.
pub fn apply_edits(doc: &str, edits: &[Edit]) -> String {
    let mut ordered: Vec<&Edit> = edits.iter().collect();
    ordered.sort_by_key(|e| e.range.start);

    let mut out = String::with_capacity(doc.len());
    let mut pos = 0usize;
    for e in ordered {
        assert!(
            e.range.start >= pos,
            "overlapping edits: {:?} starts before cursor {pos}",
            e.range
        );
        out.push_str(&doc[pos..e.range.start]);
        out.push_str(&e.replacement);
        pos = e.range.end;
    }
    out.push_str(&doc[pos..]);
    out
}

/// Apply `decisions` to `doc`'s CriticMarkup, returning the resulting text.
///
/// `decisions[i]` decides `parse(doc)[i]`; `None` leaves a change pending (its
/// markup stays literal). Equivalent to `apply_edits(doc, &edits(doc, decisions))`.
pub fn apply(doc: &str, decisions: &[Option<Decision>]) -> String {
    apply_edits(doc, &edits(doc, decisions))
}

/// Resolve every change in `doc` the same way, in a single parse.
fn apply_uniform(doc: &str, decision: Decision) -> String {
    let all_edits: Vec<Edit> = parse(doc)
        .iter()
        .map(|markup| Edit {
            range: markup.full.clone(),
            replacement: resolution(doc, markup, decision).to_string(),
        })
        .collect();
    apply_edits(doc, &all_edits)
}

/// The clean text: every change accepted (test-plan P4a accept-all anchor).
pub fn accept_all(doc: &str) -> String {
    apply_uniform(doc, Decision::Accept)
}

/// The original text: every change rejected (test-plan P4a reject-all anchor).
pub fn reject_all(doc: &str) -> String {
    apply_uniform(doc, Decision::Reject)
}

/// Which changes are linked and must be decided all-or-none (test-plan P4b).
///
/// Built over a document's changes (indexed as in [`parse`]): each supplied group
/// is a set of member indices decided together; every change not named in a group
/// is its own singleton. Groups must be disjoint. Deciding any member via
/// [`decide`](Grouping::decide) sets every co-member, so a group stays all-or-none
/// as long as every decision is formed through `decide`. The decision vector is a
/// plain slice, so atomicity is a routing discipline this type enforces at its own
/// entry point, not a type-level guarantee — a caller that writes a raw slot can
/// still split a group. (P1-11 delivery decisions must route through `Grouping`.)
pub struct Grouping {
    /// For each change index, every change decided together with it (itself
    /// included). Singletons hold a one-element list.
    members: Vec<Vec<usize>>,
}

impl Grouping {
    /// Build a grouping over `change_count` changes. Each slice in `groups` links
    /// its member indices; unlisted changes are singletons.
    ///
    /// Panics if a member index is out of range or a change appears in two groups
    /// (groups must be disjoint) — both are caller bugs, not runtime conditions.
    pub fn new(change_count: usize, groups: &[&[usize]]) -> Grouping {
        let mut members: Vec<Vec<usize>> = (0..change_count).map(|i| vec![i]).collect();
        let mut assigned = vec![false; change_count];
        for group in groups {
            let mut list: Vec<usize> = group.to_vec();
            list.sort_unstable();
            list.dedup();
            for &c in &list {
                assert!(
                    c < change_count,
                    "group member {c} out of range 0..{change_count}"
                );
                assert!(!assigned[c], "change {c} appears in more than one group");
                assigned[c] = true;
            }
            for &c in &list {
                members[c] = list.clone();
            }
        }
        Grouping { members }
    }

    /// Every change decided together with `change` (itself included), in ascending
    /// order. A singleton returns a one-element slice.
    pub fn members(&self, change: usize) -> &[usize] {
        &self.members[change]
    }

    /// Set `decision` on `change` and every co-member of its group, enforcing
    /// all-or-none. `decisions` must have one slot per change.
    ///
    /// Panics if `change` is out of range or `decisions` is shorter than the
    /// change count — both are caller bugs, not runtime conditions.
    pub fn decide(&self, decisions: &mut [Option<Decision>], change: usize, decision: Decision) {
        for &c in &self.members[change] {
            decisions[c] = Some(decision);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- single-change resolution ------------------------------------------

    #[test]
    fn accept_insertion_keeps_the_inserted_text() {
        assert_eq!(
            apply("Hello {++big ++}world", &[Some(Decision::Accept)]),
            "Hello big world"
        );
    }

    #[test]
    fn reject_insertion_removes_it_entirely() {
        assert_eq!(
            apply("Hello {++big ++}world", &[Some(Decision::Reject)]),
            "Hello world"
        );
    }

    #[test]
    fn accept_deletion_removes_the_text() {
        assert_eq!(
            apply("Hello {--cruel --}world", &[Some(Decision::Accept)]),
            "Hello world"
        );
    }

    #[test]
    fn reject_deletion_keeps_the_text() {
        assert_eq!(
            apply("Hello {--cruel --}world", &[Some(Decision::Reject)]),
            "Hello cruel world"
        );
    }

    #[test]
    fn accept_substitution_takes_new() {
        assert_eq!(
            apply("Hello {~~old~>new~~} one", &[Some(Decision::Accept)]),
            "Hello new one"
        );
    }

    #[test]
    fn reject_substitution_takes_old() {
        assert_eq!(
            apply("Hello {~~old~>new~~} one", &[Some(Decision::Reject)]),
            "Hello old one"
        );
    }

    #[test]
    fn accepting_a_substitution_with_empty_new_deletes() {
        // Degenerate substitution `{~~x~>~~}` — the P1-2 heads-up: zero-length `new`.
        assert_eq!(apply("a{~~x~>~~}b", &[Some(Decision::Accept)]), "ab");
        assert_eq!(apply("a{~~x~>~~}b", &[Some(Decision::Reject)]), "axb");
    }

    #[test]
    fn whitespace_only_insertion_accept_keeps_the_space() {
        // Ties to the P1-2 whitespace-leak corpus: an inserted space is a real change.
        assert_eq!(
            apply("word{++ ++}next", &[Some(Decision::Accept)]),
            "word next"
        );
        assert_eq!(
            apply("word{++ ++}next", &[Some(Decision::Reject)]),
            "wordnext"
        );
    }

    // --- subsets, none, order ----------------------------------------------

    #[test]
    fn undecided_change_is_left_as_literal_markup() {
        let doc = "a {++b++} c {--d--} e";
        // Decide the first, leave the second pending.
        assert_eq!(
            apply(doc, &[Some(Decision::Accept), None]),
            "a b c {--d--} e"
        );
        // Empty decisions → whole document unchanged.
        assert_eq!(apply(doc, &[]), doc);
    }

    #[test]
    fn a_mixed_subset_decides_each_change_independently() {
        let doc = "{++A++} {--B--} {~~C~>D~~}";
        let decisions = [
            Some(Decision::Accept),
            Some(Decision::Reject),
            Some(Decision::Accept),
        ];
        // A accepted (kept), B rejected (kept), C→D accepted (D).
        assert_eq!(apply(doc, &decisions), "A B D");
    }

    #[test]
    fn accept_all_yields_the_clean_text() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(accept_all(doc), "The quick fox jumps above it.");
    }

    #[test]
    fn reject_all_yields_the_original_text() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(reject_all(doc), "The fox lazily jumps over it.");
    }

    #[test]
    fn accept_all_of_a_clean_document_is_a_no_op() {
        let doc = "No markup here at all.";
        assert_eq!(accept_all(doc), doc);
        assert_eq!(reject_all(doc), doc);
    }

    // --- edits: the interactive/undo unit ----------------------------------

    #[test]
    fn one_decision_is_one_edit_at_the_marker_span() {
        // Each accept/reject is a single edit → a single undo entry (finding M9).
        let doc = "Hello {++world++}!";
        let es = edits(doc, &[Some(Decision::Accept)]);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0].range, 6..17);
        assert_eq!(&doc[es[0].range.clone()], "{++world++}");
        assert_eq!(es[0].replacement, "world");
    }

    #[test]
    fn apply_edits_is_order_independent() {
        let doc = "{++A++} {--B--} {~~C~>D~~}";
        let mut es = edits(doc, &[Some(Decision::Accept); 3]);
        let forward = apply_edits(doc, &es);
        es.reverse();
        let reversed = apply_edits(doc, &es);
        assert_eq!(forward, reversed);
        assert_eq!(forward, "A  D"); // B deleted, leaving the two surrounding spaces
    }

    #[test]
    fn adjacent_changes_both_decided_meet_cleanly() {
        // The regression-corpus shape: deletion then whitespace insertion, adjacent.
        let doc = "My Name is {--Tina--}{++CJ++} Williams.";
        assert_eq!(accept_all(doc), "My Name is CJ Williams.");
        assert_eq!(reject_all(doc), "My Name is Tina Williams.");
    }

    #[test]
    fn resolving_a_change_may_reveal_marker_shaped_literal_text() {
        // CriticMarkup does not escape: first-closer-wins parses `{++ {--z--} ++}`
        // as ONE insertion whose literal content is ` {--z--} ` (not a nested
        // deletion). Batch apply resolves against a single parse, so accepting it
        // splices that content verbatim — the revealed `{--z--}` is plain text in
        // this result, correct and non-idempotent. This pins the batch contract the
        // module doc's "incremental caveat" warns consumers not to re-parse-index.
        let doc = "{++ {--z--} ++}{--keep--}";
        assert_eq!(parse(doc).len(), 2); // [ins(" {--z--} "), del("keep")]
        assert_eq!(
            apply(doc, &[Some(Decision::Accept), Some(Decision::Reject)]),
            " {--z--} keep"
        );
        assert_eq!(accept_all(doc), " {--z--} ");
    }

    #[test]
    fn resolving_a_change_may_reindent_a_later_marker_into_code() {
        // Same family, one level up: since #75 line-start whitespace is structure.
        // Rejecting the substitution keeps its four-space `old` side at the start
        // of the line, so on re-parse the rest of the line sits in an indented
        // code block and the pending insertion is literal text now — an
        // interactive step sequence diverges here from the batch apply, which
        // resolves both against a single parse of the original document.
        let doc = "{~~    ~>x~~}{++A++}";
        assert_eq!(parse(doc).len(), 2);
        let stepped = apply(doc, &[Some(Decision::Reject), None]);
        assert_eq!(stepped, "    {++A++}");
        assert!(parse(&stepped).is_empty()); // the insertion is now inside code
        assert_eq!(
            apply(doc, &[Some(Decision::Reject), Some(Decision::Accept)]),
            "    A"
        );
    }

    // --- grouping ----------------------------------------------------------

    #[test]
    fn singleton_grouping_touches_only_the_named_change() {
        let g = Grouping::new(3, &[]);
        let mut d = vec![None; 3];
        g.decide(&mut d, 1, Decision::Accept);
        assert_eq!(d, vec![None, Some(Decision::Accept), None]);
        assert_eq!(g.members(1), &[1]);
    }

    #[test]
    fn deciding_any_member_decides_the_whole_group() {
        // A substitution rendered as a delete+insert pair — one logical change.
        let doc = "My Name is {--Tina--}{++CJ++} Williams.";
        let g = Grouping::new(2, &[&[0, 1]]);

        let mut via_first = vec![None; 2];
        g.decide(&mut via_first, 0, Decision::Accept);
        let mut via_second = vec![None; 2];
        g.decide(&mut via_second, 1, Decision::Accept);

        // Deciding either member yields the identical, fully-decided group.
        assert_eq!(via_first, vec![Some(Decision::Accept); 2]);
        assert_eq!(via_first, via_second);
        assert_eq!(apply(doc, &via_first), "My Name is CJ Williams.");
    }

    #[test]
    fn a_group_is_all_or_none_never_split() {
        let doc = "x {--a--}{++b++} y {--c--}{++d++} z";
        // Two independent substitution pairs.
        let g = Grouping::new(4, &[&[0, 1], &[2, 3]]);
        let mut d = vec![None; 4];
        // Decide only the first pair (reject), touching one member.
        g.decide(&mut d, 1, Decision::Reject);
        // First pair fully rejected (a kept, b dropped); second pair still literal.
        assert_eq!(apply(doc, &d), "x a y {--c--}{++d++} z");
        assert_eq!(g.members(0), &[0, 1]);
        assert_eq!(g.members(2), &[2, 3]);
    }

    #[test]
    #[should_panic(expected = "more than one group")]
    fn overlapping_groups_are_rejected() {
        Grouping::new(3, &[&[0, 1], &[1, 2]]);
    }

    #[test]
    #[should_panic(expected = "out of range")]
    fn out_of_range_group_member_is_rejected() {
        Grouping::new(2, &[&[0, 5]]);
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use crate::critic::parse;
    use proptest::prelude::*;

    /// A generated document atom. Marker content is drawn from a charset that
    /// cannot form a marker, fence, or frontmatter delimiter, so resolving a change
    /// never conjures or destroys *other* markup — which is exactly the P4a domain
    /// ("non-overlapping, non-group-linked changes") and lets us assert the clean /
    /// original text exactly.
    #[derive(Clone, Debug)]
    enum Atom {
        Text(String),
        Ins(String),
        Del(String),
        Sub(String, String),
    }

    impl Atom {
        fn accepted(&self) -> String {
            match self {
                Atom::Text(s) => s.clone(),
                Atom::Ins(c) => c.clone(),
                Atom::Del(_) => String::new(),
                Atom::Sub(_, n) => n.clone(),
            }
        }
        fn rejected(&self) -> String {
            match self {
                Atom::Text(s) => s.clone(),
                Atom::Ins(_) => String::new(),
                Atom::Del(c) => c.clone(),
                Atom::Sub(o, _) => o.clone(),
            }
        }
        fn is_marker(&self) -> bool {
            !matches!(self, Atom::Text(_))
        }
    }

    // Delimiter-free content (>= 1 char) — includes spaces so whitespace-only
    // markup is generated as a first-class change.
    fn content() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ._]{1,8}"
    }
    // Plain text between markers: no `{`, `-`, `~`, or backtick. A non-empty
    // atom starts with a letter so a generated document (one line) can never
    // open an indented code block or a list item starting with one (#75).
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

    /// Atom sequences whose rendered document starts with a letter-leading text
    /// atom. Marker content may be all spaces (whitespace-only markup is
    /// first-class), and since #75 line-start whitespace is *structure*: resolving
    /// a doc-leading `{~~    ~>x~~}` to its spaces would re-classify everything
    /// after it as indented code on the next re-parse, hiding later markers —
    /// convergence then genuinely depends on decision order (pinned by
    /// `resolving_a_change_may_reindent_a_later_marker_into_code`). The guard
    /// keeps these properties on the P4a domain — structure-stable documents —
    /// exactly as the charset already does for fences and frontmatter. Markers at
    /// offset 0 stay covered by the unit tests and critic's parse property.
    fn atoms(size: std::ops::Range<usize>) -> impl Strategy<Value = Vec<Atom>> {
        (
            "[a-zA-Z][a-zA-Z0-9 .]{0,9}",
            prop::collection::vec(atom(), size),
        )
            .prop_map(|(guard, mut rest)| {
                rest.insert(0, Atom::Text(guard));
                rest
            })
    }

    fn render(atoms: &[Atom]) -> String {
        let mut doc = String::new();
        for a in atoms {
            match a {
                Atom::Text(s) => doc.push_str(s),
                Atom::Ins(c) => {
                    doc.push_str("{++");
                    doc.push_str(c);
                    doc.push_str("++}");
                }
                Atom::Del(c) => {
                    doc.push_str("{--");
                    doc.push_str(c);
                    doc.push_str("--}");
                }
                Atom::Sub(o, n) => {
                    doc.push_str("{~~");
                    doc.push_str(o);
                    doc.push_str("~>");
                    doc.push_str(n);
                    doc.push_str("~~}");
                }
            }
        }
        doc
    }

    /// Apply `decisions` one edit at a time, re-parsing after every step — the way
    /// the editor applies accept/reject interactively. `order` is a permutation of
    /// the decided indices. Since generated content forms no new markup, the count
    /// and order of remaining markers stays a faithful map back to the originals.
    fn apply_incrementally(doc: &str, decisions: &[Option<Decision>], order: &[usize]) -> String {
        let n = parse(doc).len();
        let mut cur = doc.to_string();
        let mut live: Vec<usize> = (0..n).collect(); // original index of each current marker
        for &oi in order {
            let pos = live
                .iter()
                .position(|&x| x == oi)
                .expect("index still live");
            let mut step = vec![None; live.len()];
            step[pos] = decisions[oi];
            cur = apply(&cur, &step);
            live.remove(pos);
        }
        cur
    }

    proptest! {
        // P4a accept-all ≡ clean text.
        #[test]
        fn prop_accept_all_is_the_clean_text(atoms in atoms(0..12)) {
            let doc = render(&atoms);
            let clean: String = atoms.iter().map(Atom::accepted).collect();
            prop_assert_eq!(accept_all(&doc), clean);
        }

        // P4a reject-all ≡ original text.
        #[test]
        fn prop_reject_all_is_the_original_text(atoms in atoms(0..12)) {
            let doc = render(&atoms);
            let original: String = atoms.iter().map(Atom::rejected).collect();
            prop_assert_eq!(reject_all(&doc), original);
        }

        // Applying no decisions leaves the document byte-identical.
        #[test]
        fn prop_no_decisions_is_identity(atoms in atoms(0..12)) {
            let doc = render(&atoms);
            prop_assert_eq!(apply(&doc, &[]), doc.clone());
            let none = vec![None; parse(&doc).len()];
            prop_assert_eq!(apply(&doc, &none), doc);
        }

        // P4a subset-order convergence: an arbitrary subset of decisions, applied
        // one edit at a time in an arbitrary order (re-parsing each step), reaches
        // the same text as the batch apply — independent of order.
        #[test]
        fn prop_subset_order_convergence(
            atoms in atoms(0..12),
            seed in any::<u64>(),
        ) {
            let doc = render(&atoms);
            let n = atoms.iter().filter(|a| a.is_marker()).count();
            prop_assume!(n == parse(&doc).len());

            // Deterministic pseudo-random decision subset + order from `seed`.
            let mut rng = seed;
            let mut next = || { rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1); rng >> 33 };

            let mut decisions = vec![None; n];
            let mut order = Vec::new();
            for (i, slot) in decisions.iter_mut().enumerate() {
                match next() % 3 {
                    0 => { *slot = Some(Decision::Accept); order.push(i); }
                    1 => { *slot = Some(Decision::Reject); order.push(i); }
                    _ => {} // leave pending
                }
            }
            // Shuffle `order` (Fisher–Yates with the same PRNG).
            for i in (1..order.len()).rev() {
                let j = (next() as usize) % (i + 1);
                order.swap(i, j);
            }

            let batch = apply(&doc, &decisions);
            let incremental = apply_incrementally(&doc, &decisions, &order);
            prop_assert_eq!(batch, incremental);
        }

        // P4b: deciding any member of a group produces the identical decision vector
        // (all-or-none), so the resulting text is the same whichever member is used.
        #[test]
        fn prop_group_atomicity(
            atoms in atoms(1..12),
            decide_accept in any::<bool>(),
        ) {
            let doc = render(&atoms);
            let n = parse(&doc).len();
            prop_assume!(n >= 2);

            // Group the first two changes; the rest stay singletons.
            let g = Grouping::new(n, &[&[0, 1]]);
            let decision = if decide_accept { Decision::Accept } else { Decision::Reject };

            let mut via_first = vec![None; n];
            g.decide(&mut via_first, 0, decision);
            let mut via_second = vec![None; n];
            g.decide(&mut via_second, 1, decision);

            // Same decisions, both members set, no other change touched.
            prop_assert_eq!(&via_first, &via_second);
            prop_assert_eq!(via_first[0], Some(decision));
            prop_assert_eq!(via_first[1], Some(decision));
            for slot in via_first.iter().skip(2) {
                prop_assert_eq!(*slot, None);
            }
            prop_assert_eq!(apply(&doc, &via_first), apply(&doc, &via_second));
        }
    }
}
