// ABOUTME: Delivery rebasing (TD-7/P1-11) — validate a proposed edit batch against whatever the
// ABOUTME: user did while the agent worked; partition applied/rejected (P4b groups all-or-none), atomic apply.

//! Delivery rebasing: the app rebases at delivery time, the agent never does (**TD-7**).
//!
//! An agent's `propose_changes` delivery is a batch of [`RevisionEdit`]s computed against
//! a document as it stood at some `base_revision` — but J1 promises live authoring during
//! multi-minute runs, so by the time the delivery lands the user may have kept typing.
//! [`rebase`] is TD-7's app-side machinery: it validates each proposed edit's context
//! snapshot against the live document, applies the edits that still hold, and returns the
//! rest to the caller as a **partial-stale** partition (test-plan **P6**) for the agent to
//! revise — never a blanket reject-on-stale, which would starve a long run forever.
//!
//! # Context validation, without tracking an edit log
//!
//! "Still matches its context" (TD-7) is operationalized here by reusing two already-proven
//! primitives rather than inventing a third notion of staleness:
//!
//! 1. **What changed concurrently** is *not* threaded through as a parameter the caller must
//!    track — it is recovered by diffing `base` against `live` (**P1-8**, [`crate::diff`]),
//!    which is exactly the disjoint, context-anchored edit-batch shape [`Anchor::map_through`]
//!    already consumes (test-plan **P2**). The caller only ever needs the two texts it already
//!    has (the document as the agent read it, and the document open right now).
//! 2. **Per-edit validation** is exact-mapping through that recovered batch: an edit whose
//!    anchor maps [`Mapped::Exact`] has *provably* untouched text (P2's guarantee) and applies,
//!    rebased to its live-document position; one that maps [`Mapped::Touched`] is genuinely
//!    conflicted and is rejected — never fuzzy-relocated. Silently moving an agent's edit to
//!    "probably the same place" would violate D21/FR-AGENT-6 (only validated, exact changes
//!    land in a protected document); fuzzy re-anchor (D17, P1-5) is deliberately not invoked
//!    here, matching [`crate::anchor`]'s own note that P1-11's partition is whole-document/safe
//!    by construction (TD-11 corollary), not a re-anchor consumer.
//!
//! # Groups (P4b)
//!
//! Some proposal edits are linked (an agent-delivered set that must land whole, TD-7/P4b:
//! "one context-stale edit stales its whole group"). Decisions route through
//! [`crate::apply::Grouping`] exactly as `apply.rs` requires ("P1-11 delivery decisions must
//! route through `Grouping`") — reusing [`Decision::Accept`]/[`Decision::Reject`] to mean "this
//! proposal edit lands" / "this proposal edit is stale", so `Grouping::decide` cascades a single
//! touched member's rejection to every co-member.
//!
//! # Atomicity
//!
//! [`rebase`] is one pure function call: it returns the fully-spliced `text` alongside the
//! partition, so there is no state a caller can observe between "some accepted edits landed"
//! and "all of them did" (FR-AGENT-6 — "the applied subset is itself one complete, attributed
//! change set", TD-7). The editor-side sub-second write-hold that makes this atomic from the
//! user's perspective is P2a-13's job; this module only guarantees the *text* is computed in
//! one shot, never incrementally.

use crate::anchor::Mapped;
use crate::apply::{apply_edits, Decision, Edit, Grouping};
use crate::diff::{diff, RevisionEdit};
use crate::revision::Revision;

/// One proposal edit that survived rebasing: its index into the original `proposal` slice,
/// and its edit translated into `live`-document coordinates — the shape downstream attribution
/// (P1-10) and CriticMarkup delivery (P2a-13) splice against the live text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    /// Index into the `proposal` slice passed to [`rebase`].
    pub proposal_index: usize,
    /// The edit, rebased into `live`-document byte coordinates.
    pub edit: Edit,
}

/// The outcome of rebasing one delivery (test-plan **P6**).
///
/// `applied` and `rejected` exactly partition `0..proposal.len()` — every index appears in
/// exactly one of them. `text` is `live` with every applied edit spliced in, computed in one
/// atomic step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rebased {
    /// The live document text with every applied edit spliced in.
    pub text: String,
    /// The proposal edits whose context still matched, applied — in `proposal` order.
    pub applied: Vec<Applied>,
    /// Indices into `proposal` of the edits rejected as stale (context no longer matches),
    /// including any edit rejected only because a group co-member was stale (P4b).
    pub rejected: Vec<usize>,
}

/// Rebase `proposal` — a delivery of [`RevisionEdit`]s computed against `base` — onto `live`,
/// the document as it stands now.
///
/// `groups` links proposal indices that must be decided all-or-none (P4b), exactly like
/// [`Grouping::new`]'s `groups` parameter; an index not named in any group is its own
/// singleton. Every edit in `proposal` must be anchored against `base` (i.e.
/// `edit.anchor.base_revision == Revision::of(base)`) — panics otherwise (caller bug: a
/// delivery rebased against the wrong base document, not a runtime condition this function
/// can recover from).
pub fn rebase(base: &str, live: &str, proposal: &[RevisionEdit], groups: &[&[usize]]) -> Rebased {
    let base_revision = Revision::of(base);
    for (i, p) in proposal.iter().enumerate() {
        assert_eq!(
            p.anchor.base_revision, base_revision,
            "proposal edit {i} is anchored against a different base_revision than `base`"
        );
    }

    let live_revision = Revision::of(live);
    let concurrent: Vec<Edit> = diff(base, live).iter().map(RevisionEdit::as_edit).collect();

    let grouping = Grouping::new(proposal.len(), groups);
    let mut decisions: Vec<Option<Decision>> = vec![Some(Decision::Accept); proposal.len()];
    let mut mapped: Vec<Option<Edit>> = vec![None; proposal.len()];

    for (i, p) in proposal.iter().enumerate() {
        match p.anchor.map_through(&concurrent, live_revision.clone()) {
            Mapped::Exact(anchor) => {
                mapped[i] = Some(Edit {
                    range: anchor.offset..anchor.offset + anchor.length,
                    replacement: p.replacement.clone(),
                });
            }
            Mapped::Touched => grouping.decide(&mut decisions, i, Decision::Reject),
        }
    }

    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let mut edits_to_apply = Vec::new();
    for (i, decision) in decisions.into_iter().enumerate() {
        match decision {
            Some(Decision::Accept) => {
                let edit = mapped[i]
                    .take()
                    .expect("an Accept decision always has an exact-mapped edit");
                edits_to_apply.push(edit.clone());
                applied.push(Applied {
                    proposal_index: i,
                    edit,
                });
            }
            Some(Decision::Reject) => rejected.push(i),
            None => unreachable!("rebase decides every proposal index"),
        }
    }

    let text = apply_edits(live, &edits_to_apply);
    Rebased {
        text,
        applied,
        rejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::Anchor;
    use crate::document::Document;

    // Shared by `properties` too (`pub(super)`) — a single definition, no copy-paste.
    pub(super) fn revedit(
        base: &str,
        offset: usize,
        length: usize,
        replacement: &str,
    ) -> RevisionEdit {
        let doc = Document::new(base);
        RevisionEdit {
            anchor: Anchor::new(&doc, offset, length),
            replacement: replacement.to_string(),
        }
    }

    // --- no concurrent edits: everything applies as-is ------------------------

    #[test]
    fn no_concurrent_edits_applies_every_proposal_edit() {
        let base = "The quick brown fox jumps.";
        let live = base;
        let p = revedit(base, 4, 5, "slow"); // "quick" -> "slow"

        let rebased = rebase(base, live, &[p], &[]);

        assert_eq!(rebased.rejected, Vec::<usize>::new());
        assert_eq!(rebased.applied.len(), 1);
        assert_eq!(rebased.applied[0].proposal_index, 0);
        assert_eq!(rebased.text, "The slow brown fox jumps.");
    }

    #[test]
    fn empty_proposal_leaves_the_live_text_untouched() {
        let base = "hello world";
        let live = "hello brave world";
        let rebased = rebase(base, live, &[], &[]);
        assert_eq!(rebased.text, live);
        assert!(rebased.applied.is_empty());
        assert!(rebased.rejected.is_empty());
    }

    // --- untouched proposal edit still applies despite a concurrent shift -----

    #[test]
    fn a_concurrent_edit_elsewhere_shifts_but_does_not_reject_the_proposal_edit() {
        let base = "Hello world";
        let p = revedit(base, 6, 5, "earth"); // "world" -> "earth"
                                              // Concurrent user edit inserts text before the proposal edit's range.
        let live = apply_edits(
            base,
            &[Edit {
                range: 0..0,
                replacement: "Say: ".into(),
            }],
        );

        let rebased = rebase(base, &live, &[p], &[]);

        assert_eq!(rebased.rejected, Vec::<usize>::new());
        assert_eq!(rebased.applied.len(), 1);
        assert_eq!(rebased.text, "Say: Hello earth");
    }

    // --- a genuinely conflicting concurrent edit rejects the proposal edit ----

    #[test]
    fn a_concurrent_edit_overlapping_the_proposal_range_rejects_it() {
        let base = "Hello world";
        let p = revedit(base, 6, 5, "earth"); // targets "world"
                                              // Concurrent user edit rewrites "world" itself.
        let live = apply_edits(
            base,
            &[Edit {
                range: 6..11,
                replacement: "universe".into(),
            }],
        );

        let rebased = rebase(base, &live, &[p], &[]);

        assert_eq!(rebased.applied, Vec::new());
        assert_eq!(rebased.rejected, vec![0]);
        assert_eq!(rebased.text, live); // nothing from the stale proposal lands
    }

    // --- partial-stale partition: independent edits decide independently -----

    #[test]
    fn concurrent_edit_touching_one_proposal_leaves_the_other_applied() {
        let base = "AAAA middle CCCC";
        let p0 = revedit(base, 0, 4, "aaaa"); // targets "AAAA"
        let p1 = revedit(base, 12, 4, "cccc"); // targets "CCCC"
                                               // Concurrent edit touches inside AAAA only, with a nonzero length delta so the
                                               // rebased position of p1 genuinely differs from its original offset.
        let live = apply_edits(
            base,
            &[Edit {
                range: 1..3,
                replacement: "XXXXX".into(),
            }],
        );

        let rebased = rebase(base, &live, &[p0, p1], &[]);

        assert_eq!(rebased.rejected, vec![0]);
        assert_eq!(
            rebased
                .applied
                .iter()
                .map(|a| a.proposal_index)
                .collect::<Vec<_>>(),
            vec![1]
        );
        // p1 still lands correctly at its shifted position; nothing else changes.
        let expected = live.replacen("CCCC", "cccc", 1);
        assert_eq!(rebased.text, expected);
    }

    // --- P4b: group atomicity carries through the TD-7 partial apply ---------

    #[test]
    fn grouped_edits_are_rejected_together_when_only_one_member_is_stale() {
        let base = "AAAA middle CCCC";
        let p0 = revedit(base, 0, 4, "aaaa");
        let p1 = revedit(base, 12, 4, "cccc");
        // Touches only p0's range.
        let live = apply_edits(
            base,
            &[Edit {
                range: 1..3,
                replacement: "Z".into(),
            }],
        );

        let rebased = rebase(base, &live, &[p0, p1], &[&[0, 1]]);

        assert_eq!(rebased.applied, Vec::new());
        assert_eq!(rebased.rejected, vec![0, 1]);
        assert_eq!(rebased.text, live); // neither half of the linked group lands
    }

    #[test]
    fn grouped_edits_both_apply_when_neither_member_is_touched() {
        let base = "AAAA middle CCCC";
        let p0 = revedit(base, 0, 4, "aaaa");
        let p1 = revedit(base, 12, 4, "cccc");
        // Concurrent edit touches neither AAAA nor CCCC.
        let live = apply_edits(
            base,
            &[Edit {
                range: 5..11,
                replacement: "MID".into(),
            }],
        );

        let rebased = rebase(base, &live, &[p0, p1], &[&[0, 1]]);

        assert_eq!(rebased.rejected, Vec::<usize>::new());
        assert_eq!(
            rebased
                .applied
                .iter()
                .map(|a| a.proposal_index)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(rebased.text, "aaaa MID cccc");
    }

    #[test]
    #[should_panic(expected = "different base_revision")]
    fn a_proposal_edit_anchored_against_a_different_base_panics() {
        let base = "hello world";
        let other = "goodbye world";
        let p = revedit(other, 0, 7, "farewell");
        rebase(base, base, &[p], &[]);
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    // `rebase` recovers "what changed concurrently" by diffing `base` against `live`
    // (Myers shortest-edit-script) rather than being handed an edit batch directly —
    // so unlike anchor.rs's equivalent generators (which hand `map_through` the exact
    // edit batch and so can use arbitrary/overlapping content), every role here draws
    // from a **disjoint alphabet** (one fixed character, run-length only), everywhere
    // it can appear in `base`/`live`. A repeated or shared character between two roles
    // lets Myers legitimately choose a *different*, equally-minimal alignment than the
    // one this test assumes (e.g. two adjacent identical runs — which one "moved" is
    // genuinely ambiguous) — a real property of text-diff-based rebasing, not a bug,
    // but one that would make these generators assert something false. Proposal
    // *replacement* text is exempt: it never lands in `base`/`live`, only in the
    // resulting `text` after rebase decides to apply it, so it can't introduce
    // alignment ambiguity and stays free-form.
    fn run(ch: char) -> impl Strategy<Value = String> {
        (0usize..6).prop_map(move |n| std::iter::repeat_n(ch, n).collect())
    }

    fn run_at_least_one(ch: char) -> impl Strategy<Value = String> {
        (1usize..6).prop_map(move |n| std::iter::repeat_n(ch, n).collect())
    }

    fn replacement() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ]{0,10}"
    }

    use super::tests::revedit;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // P6, untouched half: a proposal edit over segment C survives whatever concurrent
        // edits do to segments A/B/D/E (never C) — mirrors anchor.rs's P2 exact-mapping
        // property one level up, through the full rebase partition + atomic apply.
        #[test]
        fn prop_untouched_proposal_edit_always_applies(
            a in run('1'), b in run('2'), c in run_at_least_one('3'), d in run('4'), e in run('5'),
            c_replacement in replacement(),
            replace_a in prop::option::of(run('A')),
            replace_b in prop::option::of(run('B')),
            replace_d in prop::option::of(run('D')),
            replace_e in prop::option::of(run('E')),
        ) {
            let base = format!("{a}{b}{c}{d}{e}");
            let c_start = a.len() + b.len();
            let c_end = c_start + c.len();

            let p = revedit(&base, c_start, c.len(), &c_replacement);

            let mut concurrent = Vec::new();
            if let Some(r) = &replace_a {
                concurrent.push(Edit { range: 0..a.len(), replacement: r.clone() });
            }
            if let Some(r) = &replace_b {
                concurrent.push(Edit { range: a.len()..a.len() + b.len(), replacement: r.clone() });
            }
            let d_start = c_end;
            if let Some(r) = &replace_d {
                concurrent.push(Edit { range: d_start..d_start + d.len(), replacement: r.clone() });
            }
            if let Some(r) = &replace_e {
                let e_start = d_start + d.len();
                concurrent.push(Edit { range: e_start..e_start + e.len(), replacement: r.clone() });
            }

            let live = apply_edits(&base, &concurrent);
            let rebased = rebase(&base, &live, &[p], &[]);

            prop_assert_eq!(&rebased.rejected, &Vec::<usize>::new());
            prop_assert_eq!(rebased.applied.len(), 1);

            // Independent cross-check: `c`'s run is the only place its character
            // appears anywhere in the document (every other role's alphabet is
            // disjoint), so it survives verbatim in `live` at exactly one position —
            // rebase must have applied the proposal edit right there, whatever the
            // concurrent edits shifted around it.
            let c_in_live = live.find(&c).expect("c's unique run must survive verbatim in live");
            let expected = format!(
                "{}{}{}",
                &live[..c_in_live],
                c_replacement,
                &live[c_in_live + c.len()..]
            );
            prop_assert_eq!(&rebased.text, &expected);
        }

        // P6, touched half: any concurrent edit overlapping the proposal edit's range
        // always rejects it and applies nothing, whatever else surrounds it.
        #[test]
        fn prop_touched_proposal_edit_is_always_rejected(
            a in run('1'), c in run_at_least_one('3'), d in run('4'),
            overlap_start_in_c in 0usize..6,
            overlap_len in 1usize..4,
            proposal_replacement in replacement(),
        ) {
            let base = format!("{a}{c}{d}");
            let c_start = a.len();
            let c_end = c_start + c.len();
            prop_assume!(c_end > c_start);

            let p = revedit(&base, c_start, c.len(), &proposal_replacement);

            let start = c_start + (overlap_start_in_c % c.len());
            let end = (start + overlap_len).min(base.len()).max(start + 1);
            prop_assume!(base.is_char_boundary(start) && base.is_char_boundary(end));
            // A fixed character disjoint from every segment role — guarantees a genuine,
            // unambiguous textual change wherever it lands.
            let concurrent_replacement: String = "X".repeat(end - start + 2);
            let concurrent = [Edit { range: start..end, replacement: concurrent_replacement }];
            let live = apply_edits(&base, &concurrent);

            let rebased = rebase(&base, &live, &[p], &[]);
            prop_assert_eq!(rebased.applied, Vec::new());
            prop_assert_eq!(rebased.rejected, vec![0]);
            prop_assert_eq!(&rebased.text, &live);
        }

        // P6 + P4b: two independently-touchable proposal edits, optionally grouped —
        // applied/rejected always exhaustively partitions {0, 1}; when grouped, any one
        // touched member rejects both (all-or-none); when ungrouped, each decides alone.
        #[test]
        fn prop_group_atomicity_carries_through_rebase(
            a in run('1'), c in run_at_least_one('3'), mid in run('5'),
            f in run_at_least_one('7'), g in run('9'),
            touch_c in any::<bool>(),
            touch_f in any::<bool>(),
            grouped in any::<bool>(),
            rep_c in replacement(), rep_f in replacement(),
        ) {
            let base = format!("{a}{c}{mid}{f}{g}");
            let c_start = a.len();
            let c_end = c_start + c.len();
            let f_start = c_end + mid.len();
            let f_end = f_start + f.len();
            prop_assume!(c_end > c_start && f_end > f_start);

            let p0 = revedit(&base, c_start, c.len(), &rep_c);
            let p1 = revedit(&base, f_start, f.len(), &rep_f);

            let mut concurrent = Vec::new();
            if touch_c {
                concurrent.push(Edit { range: c_start..c_start + 1, replacement: "Z".into() });
            }
            if touch_f {
                concurrent.push(Edit { range: f_start..f_start + 1, replacement: "Z".into() });
            }
            let live = apply_edits(&base, &concurrent);

            let groups: &[&[usize]] = if grouped { &[&[0, 1]] } else { &[] };
            let rebased = rebase(&base, &live, &[p0, p1], groups);

            let mut all: Vec<usize> = rebased.applied.iter().map(|a| a.proposal_index).collect();
            all.extend(rebased.rejected.iter().copied());
            all.sort_unstable();
            prop_assert_eq!(all, vec![0, 1]);

            let any_touched = touch_c || touch_f;
            if grouped && any_touched {
                prop_assert_eq!(rebased.applied.len(), 0);
                prop_assert_eq!(rebased.rejected.len(), 2);
            }
            if !any_touched {
                prop_assert_eq!(rebased.applied.len(), 2);
                prop_assert_eq!(rebased.rejected.len(), 0);
            }
            if !grouped {
                prop_assert_eq!(touch_c, rebased.rejected.contains(&0));
                prop_assert_eq!(touch_f, rebased.rejected.contains(&1));
            }
        }
    }
}
