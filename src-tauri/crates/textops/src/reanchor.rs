// ABOUTME: Fuzzy re-anchor (D17, TD-6, P2) — the Mapped::Touched continuation of anchor.rs.
// ABOUTME: Snapshot+context matching with a deterministic orphan rule; algorithm per SPIKE-4/P1-5b.

//! Fuzzy re-anchor: locate an anchor in a new document when exact offset mapping
//! ([`crate::anchor::Anchor::map_through`] returning [`crate::anchor::Mapped::Touched`])
//! cannot, or when no edit list exists at all (TD-6's first-class cross-machine
//! case — two document snapshots, no edit history to replay).
//!
//! This is **Algorithm C** from `docs/spikes/spike4-fuzzy-reanchor.md` (SPIKE-4,
//! P1-5a), profiled over a harvested edit-pattern taxonomy and recommended GO for
//! P1-5b (#103): token-level, exact-first, then a context-blended fuzzy scan, with
//! **non-maximum suppression before the ambiguity test**. Per the spike's §8
//! caveat 5, the similarity metric itself need not match Python's `difflib`
//! bit-for-bit as long as it is deterministic; this port uses a token-sequence LCS
//! ratio (`2*|LCS(a,b)| / (|a|+|b|)`) — same shape (a normalized common-subsequence
//! ratio), Rust-native, no floating-point nondeterminism.
//!
//! # The deterministic orphan rule (D17/P2)
//!
//! [`Anchor::fuzzy_reanchor`] returns [`ReAnchor::Orphan`] — never a guess — iff
//! any of:
//! - **(a)** no candidate reaches [`SIMILARITY_THRESHOLD`] (no sufficiently-equal
//!   text exists);
//! - **(b)** the best distinct candidate does not beat the second distinct
//!   candidate by [`TIE_MARGIN`] (genuinely ambiguous places);
//! - **(c)** the snapshot is empty/degenerate, or longer than the whole document.
//!
//! Stage 1 (exact token-sequence hits) skips (a) — an exact match needs no
//! similarity gate — but is still subject to (b): multiple exact hits disambiguate
//! by context alone, orphaning on a tie exactly as stage 2 does.
//!
//! # The doc-edge boundary rule (spike §7 — the highest-priority fix)
//!
//! A context side is safe to compare only when **both** the stored anchor's side
//! and the candidate's live side have a full [`CONTEXT_TOKENS`]-token window — i.e.
//! neither hit a real document boundary. A boundary-truncated side is excluded from
//! the average entirely (neutral: it can never make a candidate look *more*
//! distinctive than a rival, only ever drop out and — if both sides are
//! unavailable — leave that candidate's context score at `0.0`, the safe,
//! confidence-lowering floor). Without this, a duplicated block sitting at the very
//! end of a document is not perfectly symmetric with its twin (nothing follows it),
//! and that boundary artifact — not real content difference — can squeak a
//! `duplicate_ambiguous` case past `tie_margin` and place it (spike-measured: 2/120).
//!
//! # What this module does not (yet) do
//!
//! Stage 2 scans every candidate start position — O(N·L) per anchor, fine for the
//! sizes involved but a documented residual (spike §8.3): a future pass can index
//! rare snapshot tokens to prefilter candidates. And per spike §8.1, the pattern
//! taxonomy this is tuned against is a *plausible structured model*, not a measured
//! distribution of real sessions (private, unreachable `biblical_writing` corpus) —
//! the test-plan's local-only zero-drift gate on that corpus remains the designated
//! place to validate real-session fidelity before P2 is called fully green.

use crate::anchor::{Anchor, CONTEXT_WINDOW};
use crate::document::Document;
use crate::revision::Revision;

/// Word tokens of context captured/compared on each side of an anchor (SPIKE-4
/// recommendation #4 — reconciles anchor.rs's provisional 40-byte window with the
/// unit that actually matched in the harness).
const CONTEXT_TOKENS: usize = 8;

/// Minimum snapshot similarity a stage-2 fuzzy candidate must reach to be
/// considered at all (SPIKE-4 recommendation #5 — middle of the measured flat
/// `[0.70, 0.80]` plateau).
const SIMILARITY_THRESHOLD: f64 = 0.75;

/// The non-negotiable safety gate (SPIKE-4 §5.2): a candidate is placed only if it
/// beats the best *distinct* alternative by this margin. This, not the threshold,
/// is what makes orphaning-over-guessing safe.
const TIE_MARGIN: f64 = 0.10;

/// Blend weights for the stage-2 fuzzy score (SPIKE-4 recommendation #3): the
/// quoted text dominates; context only disambiguates.
const SNAPSHOT_WEIGHT: f64 = 0.7;
const CONTEXT_WEIGHT: f64 = 0.3;

/// The result of attempting to fuzzy re-anchor (D17, P2's re-anchor/orphan half).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReAnchor {
    /// A single, sufficiently-distinguishable location was found: a fresh anchor
    /// naming the new document's revision, recaptured (offset, length, snapshot,
    /// context) at that location — the placed text may differ slightly from the
    /// old `text_snapshot` (e.g. a typo fix) when placement came from the fuzzy
    /// stage rather than an exact hit.
    Anchored(Anchor),
    /// No candidate was distinguishable enough (D17): never guessed, never
    /// dropped. The original quote and its old context are preserved so the UI can
    /// still show what was commented on.
    Orphan(Orphan),
}

/// A comment/change whose anchor could not be re-located with confidence (D17).
/// Carries exactly what re-anchoring had to fall back on: the original quoted
/// text and its old surrounding context, with no claim on a live document
/// position — an orphan is inherently document-level, not revision-indexed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Orphan {
    pub text_snapshot: String,
    pub context_before: String,
    pub context_after: String,
}

impl Orphan {
    fn from_anchor(anchor: &Anchor) -> Orphan {
        Orphan {
            text_snapshot: anchor.text_snapshot.clone(),
            context_before: anchor.context_before.clone(),
            context_after: anchor.context_after.clone(),
        }
    }
}

impl Anchor {
    /// Fuzzy re-anchor this anchor against `new_text` — TD-6's snapshot+context
    /// path, used both as [`crate::anchor::Mapped::Touched`]'s continuation and as
    /// the cross-machine path when no edit list exists at all. `new_revision`
    /// names `new_text` (typically `Revision::of(new_text)`); the caller supplies
    /// it rather than this function recomputing it, mirroring
    /// [`Anchor::map_through`]'s contract.
    ///
    /// See the module docs for the algorithm (SPIKE-4 Algorithm C: exact-first,
    /// then a context-blended fuzzy scan with non-maximum suppression before the
    /// ambiguity test) and the deterministic orphan rule (D17/P2).
    pub fn fuzzy_reanchor(&self, new_text: &str, new_revision: Revision) -> ReAnchor {
        // Rule (c): a degenerate (empty/whitespace-only) snapshot has no equal
        // text to look for — there is nothing safe to place.
        let snapshot_ranges = tokenize(&self.text_snapshot);
        if snapshot_ranges.is_empty() {
            return ReAnchor::Orphan(Orphan::from_anchor(self));
        }
        let snapshot_tokens: Vec<&str> = snapshot_ranges
            .iter()
            .map(|&(s, e)| &self.text_snapshot[s..e])
            .collect();
        let win_len = snapshot_tokens.len();

        let doc_ranges = tokenize(new_text);
        let doc_tokens: Vec<&str> = doc_ranges.iter().map(|&(s, e)| &new_text[s..e]).collect();
        // Rule (c): the snapshot cannot possibly fit — nothing to compare it to.
        if win_len > doc_tokens.len() {
            return ReAnchor::Orphan(Orphan::from_anchor(self));
        }

        let anchor_before = context_side(&self.context_before, false);
        let anchor_after = context_side(&self.context_after, true);
        let last_start = doc_tokens.len() - win_len;

        // Stage 1: exact token-sequence search — the cheap, common-case, and also
        // the correct path for a moved-but-untouched paragraph.
        let exact_hits: Vec<usize> = (0..=last_start)
            .filter(|&start| doc_tokens[start..start + win_len] == snapshot_tokens[..])
            .collect();

        let target = PlacementTarget {
            new_text,
            doc_ranges: &doc_ranges,
            win_len,
            new_revision,
        };

        if !exact_hits.is_empty() {
            let scored: Vec<(usize, f64)> = exact_hits
                .into_iter()
                .map(|start| {
                    let score =
                        context_score(&anchor_before, &anchor_after, &doc_tokens, start, win_len);
                    (start, score)
                })
                .collect();
            let peaks = suppress_overlaps(scored, win_len);
            return decide(peaks, target, self, true);
        }

        // Stage 2: fuzzy scan — only when no exact hit exists (keeps the O(N·L)
        // scan off the common-case hot path, per SPIKE-4 recommendation #2).
        let scored: Vec<(usize, f64)> = (0..=last_start)
            .map(|start| {
                let window = &doc_tokens[start..start + win_len];
                let ctx = context_score(&anchor_before, &anchor_after, &doc_tokens, start, win_len);
                let score =
                    SNAPSHOT_WEIGHT * token_ratio(&snapshot_tokens, window) + CONTEXT_WEIGHT * ctx;
                (start, score)
            })
            .collect();
        let peaks = suppress_overlaps(scored, win_len);
        decide(peaks, target, self, false)
    }
}

/// Everything needed to recapture a fresh [`Anchor`] once a winning candidate is
/// chosen — kept as one value rather than a scatter of parameters so `decide` and
/// `place` share a single, named "where would this land" concept.
struct PlacementTarget<'a> {
    new_text: &'a str,
    doc_ranges: &'a [(usize, usize)],
    win_len: usize,
    new_revision: Revision,
}

/// Applies the orphan rule to a list of already-NMS-suppressed, score-descending
/// peaks and either places the winner or orphans (D17/P2). `exact` skips the
/// similarity-threshold gate (rule a) — an exact hit needs no similarity test —
/// but not the tie-margin gate (rule b), which still applies to disambiguate
/// multiple exact hits.
fn decide(
    peaks: Vec<(usize, f64)>,
    target: PlacementTarget,
    anchor: &Anchor,
    exact: bool,
) -> ReAnchor {
    let Some(&(best_start, best_score)) = peaks.first() else {
        return ReAnchor::Orphan(Orphan::from_anchor(anchor));
    };
    if !exact && best_score < SIMILARITY_THRESHOLD {
        return ReAnchor::Orphan(Orphan::from_anchor(anchor));
    }
    if let Some(&(_, second_score)) = peaks.get(1) {
        if best_score - second_score < TIE_MARGIN {
            return ReAnchor::Orphan(Orphan::from_anchor(anchor));
        }
    }
    place(target, best_start)
}

/// Recaptures a fresh anchor at the winning token window — offset/length recovered
/// from the doc's token byte ranges, snapshot/context recaptured fresh (the placed
/// text may be the edited version, not the old `text_snapshot`, when this came from
/// the fuzzy stage).
fn place(target: PlacementTarget, start: usize) -> ReAnchor {
    let byte_start = target.doc_ranges[start].0;
    let byte_end = target.doc_ranges[start + target.win_len - 1].1;
    let doc = Document::new(target.new_text);
    let mut placed = Anchor::new(&doc, byte_start, byte_end - byte_start);
    placed.base_revision = target.new_revision;
    ReAnchor::Anchored(placed)
}

// --- tokenizing --------------------------------------------------------------

/// Splits `text` into word tokens — maximal runs of non-whitespace characters —
/// returning each token's byte range. Whitespace *content* (space vs. newline,
/// single vs. run) never affects the token sequence, which is exactly what makes
/// reflow/rewrap free (SPIKE-4 pattern 6, `local_reflow`).
fn tokenize(text: &str) -> Vec<(usize, usize)> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some(s) = start.take() {
                tokens.push((s, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        tokens.push((s, text.len()));
    }
    tokens
}

// --- similarity ----------------------------------------------------------------

/// Token-sequence similarity ratio, `2*|LCS(a,b)| / (|a|+|b|)` — 1.0 for
/// identical sequences, 0.0 for completely disjoint ones, degrading smoothly as
/// individual tokens are replaced (typo/word-swap) or the sequence is
/// re-punctuated (sentence-split). Deterministic (P2 forbids a nondeterministic
/// orphan decision) — see module docs on metric choice.
fn token_ratio(a: &[&str], b: &[&str]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    (2.0 * lcs_len(a, b) as f64) / ((a.len() + b.len()) as f64)
}

/// Length of the longest common subsequence of `a` and `b` (standard O(|a|·|b|)
/// DP, rolling two rows — snapshot/context windows are small so this is cheap
/// per candidate; see module docs on the O(N·L) full-scan residual).
fn lcs_len(a: &[&str], b: &[&str]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut curr = vec![0usize; b.len() + 1];
    for &token_a in a {
        for (j, &token_b) in b.iter().enumerate() {
            curr[j + 1] = if token_a == token_b {
                prev[j] + 1
            } else {
                prev[j + 1].max(curr[j])
            };
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

// --- context (the doc-edge boundary rule, spike §7) ---------------------------

/// A side (before or after) of an anchor's *stored* context, tokenized and
/// truncated to at most [`CONTEXT_TOKENS`], with whether it hit a real document
/// boundary at capture time (`raw.len() < CONTEXT_WINDOW` — anchor.rs only
/// clamps short of the full byte budget when there was truly nothing more).
struct ContextSide<'a> {
    tokens: Vec<&'a str>,
    truncated: bool,
}

/// Builds a stored context side for comparison. `take_from_start` selects which
/// end of the tokenized string sits adjacent to the anchor: `context_before`'s
/// closest tokens are its *last* few (`take_from_start = false`); `context_after`'s
/// closest tokens are its *first* few (`take_from_start = true`).
fn context_side(raw: &str, take_from_start: bool) -> ContextSide<'_> {
    let ranges = tokenize(raw);
    let truncated = raw.len() < CONTEXT_WINDOW;
    let all: Vec<&str> = ranges.iter().map(|&(s, e)| &raw[s..e]).collect();
    let n = all.len().min(CONTEXT_TOKENS);
    let tokens = if take_from_start {
        all[..n].to_vec()
    } else {
        all[all.len() - n..].to_vec()
    };
    ContextSide { tokens, truncated }
}

/// The live tokens immediately before `start` in `doc_tokens`, and whether fewer
/// than [`CONTEXT_TOKENS`] were available (the candidate itself sits within one
/// context-window of the document's start). Borrows `doc_tokens` rather than
/// allocating — this runs once per scored candidate, i.e. on stage 2's O(N·L)
/// hot path.
fn live_before_tokens<'a>(doc_tokens: &'a [&str], start: usize) -> (&'a [&'a str], bool) {
    let truncated = start < CONTEXT_TOKENS;
    let n = start.min(CONTEXT_TOKENS);
    (&doc_tokens[start - n..start], truncated)
}

/// The live tokens immediately after `end` in `doc_tokens`, and whether fewer
/// than [`CONTEXT_TOKENS`] were available (the candidate sits within one
/// context-window of the document's end). Borrows rather than allocates, as
/// [`live_before_tokens`] does.
fn live_after_tokens<'a>(doc_tokens: &'a [&str], end: usize) -> (&'a [&'a str], bool) {
    let available = doc_tokens.len() - end;
    let truncated = available < CONTEXT_TOKENS;
    let n = available.min(CONTEXT_TOKENS);
    (&doc_tokens[end..end + n], truncated)
}

/// The disambiguating context score for a candidate window `[start, start+win_len)`
/// in `doc_tokens`: the average similarity of whichever side(s) have a full,
/// untruncated window on **both** the stored anchor and the live candidate (spike
/// §7's boundary rule) — `0.0` (the safe, confidence-lowering floor) if neither
/// side qualifies.
fn context_score(
    anchor_before: &ContextSide,
    anchor_after: &ContextSide,
    doc_tokens: &[&str],
    start: usize,
    win_len: usize,
) -> f64 {
    let (before_tokens, before_truncated) = live_before_tokens(doc_tokens, start);
    let (after_tokens, after_truncated) = live_after_tokens(doc_tokens, start + win_len);

    let mut sides = Vec::with_capacity(2);
    if !anchor_before.truncated && !before_truncated {
        sides.push(token_ratio(&anchor_before.tokens, before_tokens));
    }
    if !anchor_after.truncated && !after_truncated {
        sides.push(token_ratio(&anchor_after.tokens, after_tokens));
    }
    if sides.is_empty() {
        0.0
    } else {
        sides.iter().sum::<f64>() / sides.len() as f64
    }
}

// --- non-maximum suppression ---------------------------------------------------

/// Collapses overlapping candidates (start positions within one `win_len` of an
/// already-accepted, higher-scoring peak) to their local best, so the subsequent
/// ambiguity test compares genuinely different locations rather than the same
/// match shifted by a token (SPIKE-4 §5.2 — "mandatory, and its absence is a
/// silent catastrophe": without this, a real fuzzy match's runner-up is itself,
/// shifted, which force-orphans almost everything). Returns peaks sorted by
/// descending score.
fn suppress_overlaps(mut candidates: Vec<(usize, f64)>, win_len: usize) -> Vec<(usize, f64)> {
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).expect("similarity scores are finite"));
    let mut peaks: Vec<(usize, f64)> = Vec::new();
    for (start, score) in candidates {
        let overlaps_accepted = peaks.iter().any(|&(peak_start, _)| {
            let diff = start.abs_diff(peak_start);
            diff < win_len
        });
        if !overlaps_accepted {
            peaks.push((start, score));
        }
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- pure helpers ----------------------------------------------------------

    #[test]
    fn tokenize_splits_on_whitespace_runs_ignoring_their_shape() {
        let ranges = tokenize("one\n\n  two   three");
        let words: Vec<&str> = ranges
            .iter()
            .map(|&(s, e)| &"one\n\n  two   three"[s..e])
            .collect();
        assert_eq!(words, vec!["one", "two", "three"]);
    }

    #[test]
    fn tokenize_of_empty_or_whitespace_only_text_is_empty() {
        assert_eq!(tokenize(""), Vec::<(usize, usize)>::new());
        assert_eq!(tokenize("   \n\t "), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn token_ratio_of_identical_sequences_is_one() {
        let a = ["alpha", "beta", "gamma"];
        assert_eq!(token_ratio(&a, &a), 1.0);
    }

    #[test]
    fn token_ratio_of_completely_disjoint_sequences_is_zero() {
        let a = ["alpha", "beta"];
        let b = ["gamma", "delta"];
        assert_eq!(token_ratio(&a, &b), 0.0);
    }

    #[test]
    fn token_ratio_of_two_empty_sequences_is_one() {
        let empty: [&str; 0] = [];
        assert_eq!(token_ratio(&empty, &empty), 1.0);
    }

    #[test]
    fn token_ratio_degrades_smoothly_for_a_single_token_substitution() {
        let a = ["one", "two", "three", "four", "five"];
        let b = ["one", "two", "three", "four", "FIVE"];
        // LCS = 4 of 5; ratio = 2*4/10 = 0.8.
        assert!((token_ratio(&a, &b) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn suppress_overlaps_keeps_the_higher_scoring_of_two_overlapping_windows() {
        let peaks = suppress_overlaps(vec![(0, 0.5), (2, 0.9)], 5);
        assert_eq!(peaks, vec![(2, 0.9)]);
    }

    #[test]
    fn suppress_overlaps_keeps_both_of_two_genuinely_distinct_windows() {
        let peaks = suppress_overlaps(vec![(0, 0.5), (10, 0.9)], 5);
        assert_eq!(peaks, vec![(10, 0.9), (0, 0.5)]);
    }

    // --- fuzzy_reanchor: fixtures ------------------------------------------------
    //
    // `BEFORE_CTX`/`AFTER_CTX` are each exactly `CONTEXT_WINDOW` (40) bytes so an
    // anchor captured with them immediately adjacent has a full, untruncated
    // context on both sides (no capture-time doc-boundary ambiguity) and each
    // tokenizes to exactly `CONTEXT_TOKENS` (8) words — a clean fixture for
    // reasoning precisely about the context-similarity math.

    const BEFORE_CTX: &str = "aaaa bbbb cccc dddd eeee ffff gggg hhhh "; // 40 bytes, 8 tokens
    const AFTER_CTX: &str = " iiii jjjj kkkk llll mmmm nnnn oooo pppp"; // 40 bytes, 8 tokens

    fn capture(target: &str) -> (Anchor, String) {
        let text = format!("{BEFORE_CTX}{target}{AFTER_CTX}");
        let doc = Document::new(text.clone());
        let offset = BEFORE_CTX.len();
        let anchor = Anchor::new(&doc, offset, target.len());
        assert_eq!(anchor.text_snapshot, target, "fixture sanity");
        assert_eq!(
            anchor.context_before.len(),
            CONTEXT_WINDOW,
            "fixture sanity"
        );
        assert_eq!(anchor.context_after.len(), CONTEXT_WINDOW, "fixture sanity");
        (anchor, text)
    }

    // --- stage 1: exact, single hit ---------------------------------------------

    #[test]
    fn a_single_exact_hit_relocates_even_when_its_context_is_wholly_different() {
        // move_paragraph (SPIKE-4 pattern 10): text intact, everything around it
        // is new — a single exact hit places unconditionally, no context needed.
        let (anchor, _old_text) = capture("the quick brown fox jumps over the lazy dog");
        let new_text = format!(
            "NOTHING_LIKE_THE_OLD_NEIGHBOURHOOD_AT_ALL {} MORE_UNRELATED_FILLER_TEXT_HERE",
            anchor.text_snapshot
        );
        let new_revision = Revision::of(&new_text);
        match anchor.fuzzy_reanchor(&new_text, new_revision.clone()) {
            ReAnchor::Anchored(placed) => {
                assert_eq!(placed.text_snapshot, anchor.text_snapshot);
                assert_eq!(placed.base_revision, new_revision);
                assert_eq!(
                    &new_text[placed.offset..placed.offset + placed.length],
                    anchor.text_snapshot
                );
            }
            ReAnchor::Orphan(_) => panic!("a unique exact hit must always place"),
        }
    }

    // --- stage 1: multiple exact hits, distinguishable via context --------------

    #[test]
    fn two_exact_hits_with_only_one_matching_context_places_the_matching_one() {
        // duplicate_distinct_ctx (SPIKE-4 pattern 11): the snapshot repeats, but
        // only the original's neighbourhood is intact — context must win the tie.
        let (anchor, _old_text) = capture("shared phrase copied elsewhere");
        let target = &anchor.text_snapshot;
        let unrelated_before = "0000 1111 2222 3333 4444 5555 6666 7777"; // 8 distinct tokens, no overlap
        let unrelated_after = "8888 9999 0001 0002 0003 0004 0005 0006";
        let new_text = format!(
            "{unrelated_before} {target} {unrelated_after} SEPARATOR_WORDS_KEEPING_THE_TWO_OCCURRENCES_FAR_APART_FROM_EACH_OTHER_SO_THEY_NEVER_OVERLAP_AT_ALL {BEFORE_CTX}{target}{AFTER_CTX}"
        );
        let new_revision = Revision::of(&new_text);
        match anchor.fuzzy_reanchor(&new_text, new_revision.clone()) {
            ReAnchor::Anchored(placed) => {
                let recovered = &new_text[placed.offset..placed.offset + placed.length];
                assert_eq!(recovered, target);
                // It placed at the *second* occurrence (the one with matching context),
                // not the first.
                assert!(new_text[..placed.offset].contains(BEFORE_CTX.trim()));
            }
            ReAnchor::Orphan(_) => panic!("context should have disambiguated this pair"),
        }
    }

    // --- stage 1: multiple exact hits, genuinely ambiguous ----------------------

    #[test]
    fn two_exact_hits_with_identical_context_orphan_rather_than_guess() {
        // duplicate_ambiguous (SPIKE-4 pattern 12), interior copies: snapshot AND
        // context repeat identically — truly indistinguishable, must not guess.
        let (anchor, _old_text) = capture("duplicated block of text");
        let target = &anchor.text_snapshot;
        let gap = "gap0 gap1 gap2 gap3 gap4 gap5 gap6 gap7 gap8 gap9";
        let new_text =
            format!("{BEFORE_CTX}{target}{AFTER_CTX} {gap} {BEFORE_CTX}{target}{AFTER_CTX}");
        let new_revision = Revision::of(&new_text);
        match anchor.fuzzy_reanchor(&new_text, new_revision) {
            ReAnchor::Orphan(orphan) => assert_eq!(orphan.text_snapshot, *target),
            ReAnchor::Anchored(_) => {
                panic!("two indistinguishable copies must orphan, never guess")
            }
        }
    }

    #[test]
    fn a_duplicate_at_the_document_edge_still_orphans_not_a_boundary_artifact_win() {
        // The spike §7 regression: one copy's trailing context is cut short by
        // the document's true end (nothing follows), not by any real content
        // difference. That truncation must not count as evidence the edge copy is
        // "worse" than the interior one — both must still orphan.
        let (anchor, _old_text) = capture("edge duplicate case text");
        let target = &anchor.text_snapshot;
        // Second occurrence sits at the literal end of the document: no trailing
        // context at all follows it.
        let new_text = format!("{BEFORE_CTX}{target}{AFTER_CTX} gap0 gap1 gap2 gap3 gap4 gap5 gap6 gap7 gap8 {BEFORE_CTX}{target}");
        let new_revision = Revision::of(&new_text);
        match anchor.fuzzy_reanchor(&new_text, new_revision) {
            ReAnchor::Orphan(orphan) => assert_eq!(orphan.text_snapshot, *target),
            ReAnchor::Anchored(_) => {
                panic!("a doc-edge duplicate must not win on a truncation artifact (spike §7)")
            }
        }
    }

    // --- stage 2: fuzzy, above threshold ----------------------------------------

    #[test]
    fn a_single_token_typo_is_recovered_via_the_fuzzy_stage_with_the_corrected_text() {
        // typo_in_snapshot (SPIKE-4 pattern 4): one token edited, no exact hit
        // anywhere; the fuzzy stage should place it with the *live* (corrected)
        // text, not the stale old snapshot.
        let (anchor, _old_text) = capture("one two three four five six seven eight nine ten");
        let corrected = "one two three four fyve six seven eight nine ten";
        let new_text = format!(
            "UNRELATED_FILLER_PARAGRAPH_WITH_NO_SHARED_WORDS_AT_ALL_JUST_NOISE {BEFORE_CTX}{corrected}{AFTER_CTX} MORE_UNRELATED_FILLER_WORDS_THAT_SHARE_NOTHING_WITH_THE_SNAPSHOT_EITHER"
        );
        let new_revision = Revision::of(&new_text);
        match anchor.fuzzy_reanchor(&new_text, new_revision.clone()) {
            ReAnchor::Anchored(placed) => {
                assert_eq!(placed.text_snapshot, corrected);
                assert_eq!(placed.base_revision, new_revision);
            }
            ReAnchor::Orphan(_) => panic!("a one-token typo should clear the fuzzy threshold"),
        }
    }

    // --- orphan rule (a): rewrite/delete — no equal text exists -----------------

    #[test]
    fn a_completely_rewritten_snapshot_orphans_never_misplaced() {
        // rewrite_snapshot / delete_snapshot (SPIKE-4 patterns 8/9): the quoted
        // text is simply gone — no candidate should ever clear the threshold.
        let (anchor, _old_text) = capture("the original sentence that gets rewritten entirely");
        let new_text =
            "A totally different paragraph replaces it, sharing no words with the original quote at all.";
        let new_revision = Revision::of(new_text);
        match anchor.fuzzy_reanchor(new_text, new_revision) {
            ReAnchor::Orphan(orphan) => assert_eq!(orphan.text_snapshot, anchor.text_snapshot),
            ReAnchor::Anchored(_) => panic!("rewritten-away text must never be misplaced"),
        }
    }

    // --- orphan rule (c): degenerate snapshot -----------------------------------

    #[test]
    fn an_empty_snapshot_always_orphans_regardless_of_the_new_document() {
        let doc = Document::new("hello world");
        let anchor = Anchor::new(&doc, 5, 0); // a zero-length point anchor
        assert_eq!(anchor.text_snapshot, "");
        let new_text = "hello there, a whole new world";
        match anchor.fuzzy_reanchor(new_text, Revision::of(new_text)) {
            ReAnchor::Orphan(orphan) => assert_eq!(orphan.text_snapshot, ""),
            ReAnchor::Anchored(_) => panic!("a degenerate snapshot can never be safely placed"),
        }
    }

    #[test]
    fn a_snapshot_longer_than_the_whole_new_document_orphans() {
        let (anchor, _old_text) = capture("this snapshot has quite a few words in it indeed");
        let new_text = "just three words";
        match anchor.fuzzy_reanchor(new_text, Revision::of(new_text)) {
            ReAnchor::Orphan(_) => {}
            ReAnchor::Anchored(_) => panic!("the snapshot cannot possibly fit"),
        }
    }

    // --- properties --------------------------------------------------------------

    use proptest::prelude::*;

    fn distinct_words(prefix: &'static str, n: usize) -> String {
        (0..n)
            .map(|i| format!("{prefix}{i}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        // A uniquely-occurring span, moved behind arbitrary filler that shares no
        // tokens with it, is always found and placed at its exact new position —
        // never orphaned, never misplaced (P2's re-anchor half, safety direction).
        #[test]
        fn prop_a_uniquely_relocated_span_is_always_found_and_placed_exactly(
            snapshot_len in 3usize..8,
            filler_len in 0usize..15,
        ) {
            let snapshot = distinct_words("snap", snapshot_len);
            let before = distinct_words("before", 8);
            let after = distinct_words("after", 8);
            let filler = distinct_words("filler", filler_len);

            let old_text = format!("{before} {snapshot} {after}");
            let old_doc = Document::new(old_text.clone());
            let offset = before.len() + 1;
            let anchor = Anchor::new(&old_doc, offset, snapshot.len());
            prop_assert_eq!(&anchor.text_snapshot, &snapshot);

            let new_text = format!("{filler} {before} {snapshot} {after}");
            let new_revision = Revision::of(&new_text);
            match anchor.fuzzy_reanchor(&new_text, new_revision.clone()) {
                ReAnchor::Anchored(placed) => {
                    prop_assert_eq!(&placed.text_snapshot, &snapshot);
                    prop_assert_eq!(placed.base_revision, new_revision);
                    prop_assert_eq!(
                        &new_text[placed.offset..placed.offset + placed.length],
                        snapshot.as_str()
                    );
                }
                ReAnchor::Orphan(_) => prop_assert!(false, "a unique relocated span must always be found"),
            }
        }

        // Two interior, context-identical copies of the same span are always
        // orphaned — never arbitrarily assigned to one of the two indistinguishable
        // locations (P2's "never a wrong silent position" half).
        #[test]
        fn prop_two_interior_context_identical_duplicates_always_orphan(
            snapshot_len in 3usize..8,
            gap_len in 5usize..15,
        ) {
            let snapshot = distinct_words("dup", snapshot_len);
            let before = distinct_words("ctxb", 8);
            let after = distinct_words("ctxa", 8);
            let gap = distinct_words("gap", gap_len);

            let old_text = format!("{before} {snapshot} {after}");
            let old_doc = Document::new(old_text.clone());
            let offset = before.len() + 1;
            let anchor = Anchor::new(&old_doc, offset, snapshot.len());

            let new_text =
                format!("{before} {snapshot} {after} {gap} {before} {snapshot} {after}");
            let new_revision = Revision::of(&new_text);
            match anchor.fuzzy_reanchor(&new_text, new_revision) {
                ReAnchor::Orphan(orphan) => prop_assert_eq!(orphan.text_snapshot, snapshot),
                ReAnchor::Anchored(_) => prop_assert!(false, "context-identical duplicates must never be guessed"),
            }
        }

        // Robustness floor: arbitrary anchor content against arbitrary new text
        // never panics, whatever garbage either side contains.
        #[test]
        fn prop_fuzzy_reanchor_never_panics_on_arbitrary_input(
            snapshot in "(?s).{0,30}",
            context_before in "(?s).{0,30}",
            context_after in "(?s).{0,30}",
            new_text in "(?s).{0,60}",
        ) {
            let anchor = Anchor {
                offset: 0,
                length: snapshot.len(),
                text_snapshot: snapshot,
                context_before,
                context_after,
                base_revision: Revision::of("whatever"),
            };
            let _ = anchor.fuzzy_reanchor(&new_text, Revision::of(&new_text));
        }
    }
}
