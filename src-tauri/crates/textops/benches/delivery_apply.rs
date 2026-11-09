// ABOUTME: test-plan §6 tracked benchmark (P2b-10b) — a 200-edit `propose_changes`-shaped delivery
// ABOUTME: apply (textops::rebase + validate + render_representable, P1-11/P2a-13) as TD-7's write-hold.

//! A `cargo bench` target, deliberately excluded from `cargo test` (`test = false` in
//! `Cargo.toml`) — test-plan §6: "budgets run as benchmarks on a dedicated/consistent
//! runner with relative regression thresholds; only gross regressions (>2x baseline)
//! hard-fail," and are explicitly "not a PR/CI gate" (#364). Run explicitly:
//!
//! ```text
//! cargo bench -p textops --bench delivery_apply
//! ```
//!
//! # What this measures
//!
//! `state::McpContext::propose_changes` (`src-tauri/src/agent/state.rs`) is the real
//! `propose_changes` MCP tool handler; its atomic-apply core is exactly three
//! `textops` calls in sequence — `rebase` (TD-7: partition applied/rejected against
//! whatever the user did while the agent worked), `validate` (TD-11: refuse any edit
//! that would not survive its own CriticMarkup round-trip), `render_representable`
//! (splice the surviving subset into the delivered text) — bracketing the sidecar
//! attribution write and the atomic file rename that follow. TD-7 names this whole
//! window the editor's "sub-second write-hold... cover[ing] the atomic apply." This
//! benchmark measures the `textops`-side three-call core in isolation — the same
//! real code path `propose_changes` calls, over the same shape of input (a 200-edit
//! delivery, TD-1 §3.2's `edits[]`) — deliberately excluding the sidecar/file I/O
//! either side of it, which is `agent::state`'s concern, not `textops`'s (#364 scopes
//! the benchmark to "textops::deliver / rebase").
//!
//! # Why this fixture
//!
//! `authored-collected-discourses` (~240KB) is the corpus's own documented
//! "large-document performance fixture (FR-X-4, test-plan §6)" (`manifest.json`) —
//! real assembled prose, not a degenerate repeated-character string, so the diff/
//! anchor-mapping cost `rebase` pays is representative of an actual long document
//! rather than measuring nothing.

use std::time::Instant;

use textops::apply::apply_edits;
use textops::{
    rebase, render_representable, validate, Anchor, Document, Edit, Representability, RevisionEdit,
};

/// test-plan §6: "Delivery apply (200-edit change set) write-hold: < 250ms (TD-7's
/// 'sub-second')." This is also the baseline for the >2x gross-regression line below —
/// the first capture of this benchmark, so the budget itself doubles as baseline
/// (mirrors the frontend twin's `FR_X_4_TARGET_MS` convention, P2b-10a).
const WRITE_HOLD_TARGET_MS: f64 = 250.0;
const GROSS_REGRESSION_MS: f64 = WRITE_HOLD_TARGET_MS * 2.0;

const PROPOSAL_EDITS: usize = 200;
/// A handful of concurrent user edits landing elsewhere in the document while the
/// agent's proposal was in flight — the scenario TD-7 exists for (J1 live authoring
/// during multi-minute runs), not the degenerate no-concurrent-edits case.
const CONCURRENT_EDITS: usize = 6;
const WARMUP_ITERATIONS: usize = 3;
const TIMED_ITERATIONS: usize = 25;

fn main() {
    let fixture = fixtures::by_id("authored-collected-discourses")
        .expect("authored-collected-discourses is declared in the fixture corpus manifest");
    let base = fixture.read();

    let (proposal, concurrent) = build_batch(&base);
    let live = apply_edits(&base, &concurrent);

    for _ in 0..WARMUP_ITERATIONS {
        run_delivery(&base, &live, &proposal);
    }

    let mut durations_ms = Vec::with_capacity(TIMED_ITERATIONS);
    for _ in 0..TIMED_ITERATIONS {
        let start = Instant::now();
        let outcome = run_delivery(&base, &live, &proposal);
        durations_ms.push(start.elapsed().as_secs_f64() * 1000.0);

        // Sanity: this is a clean batch (delimiter-free replacements) against
        // concurrent edits chosen to miss every proposal range — every edit should
        // land. A benchmark over a batch that silently delivers nothing measures
        // nothing (test-plan §6's "realistic, not degenerate" concern).
        assert_eq!(
            outcome.delivered,
            proposal.len(),
            "expected every clean proposal edit to deliver — the benchmark batch is no longer clean"
        );
        assert_eq!(
            outcome.stale, 0,
            "expected no proposal edit to be staled by the disjoint concurrent edits"
        );
    }

    let median = percentile(&durations_ms, 50.0);
    let p95 = percentile(&durations_ms, 95.0);
    let max = durations_ms.iter().cloned().fold(f64::MIN, f64::max);
    println!(
        "[bench] delivery_apply write-hold — {PROPOSAL_EDITS}-edit propose_changes-shaped batch over a {}KB doc ({TIMED_ITERATIONS} runs): \
         median {median:.2}ms, p95 {p95:.2}ms, max {max:.2}ms (target {WRITE_HOLD_TARGET_MS:.0}ms, gross-regression {GROSS_REGRESSION_MS:.0}ms)",
        base.len() / 1000,
    );

    write_hold_apply_stays_within_the_td7_budget(median);
}

/// test-plan §6's own anti-flake policy: only a >2x-baseline gross regression fails —
/// never a tight wall-clock assertion on a shared/variable-hardware runner.
fn write_hold_apply_stays_within_the_td7_budget(median_ms: f64) {
    assert!(
        median_ms < GROSS_REGRESSION_MS,
        "median write-hold {median_ms:.2}ms exceeds the test-plan §6 gross-regression line \
         ({GROSS_REGRESSION_MS:.0}ms, 2x the {WRITE_HOLD_TARGET_MS:.0}ms TD-7 budget) — investigate before accepting a new baseline"
    );
}

struct DeliveryOutcome {
    delivered: usize,
    stale: usize,
}

/// The exact three-call `textops` sequence `state::McpContext::propose_changes` runs
/// between reading the live document and writing the delivered text — see this
/// file's module docs for why the sidecar/file I/O on either side is out of scope.
fn run_delivery(base: &str, live: &str, proposal: &[RevisionEdit]) -> DeliveryOutcome {
    let group_refs: Vec<&[usize]> = Vec::new(); // ungrouped — matches most real deliveries
    let rebased = rebase(base, live, proposal, &group_refs);

    let applied_edits: Vec<Edit> = rebased.applied.iter().map(|a| a.edit.clone()).collect();
    let verdicts = validate(live, &applied_edits);
    let keep: Vec<bool> = verdicts
        .iter()
        .map(|v| *v == Representability::Representable)
        .collect();
    let delivered = keep.iter().filter(|&&k| k).count();

    let rendered = render_representable(live, &applied_edits, &keep);
    std::hint::black_box(&rendered);

    DeliveryOutcome {
        delivered,
        stale: rebased.rejected.len(),
    }
}

/// 200 disjoint, delimiter-free "copyedit" proposal edits (a case-flip per targeted
/// word — always representable, matching the common clean-delivery case TD-7's
/// budget targets) plus `CONCURRENT_EDITS` disjoint edits elsewhere in the document,
/// spread across `base` by sampling its word spans at two interleaved, non-colliding
/// strides so neither set can ever pick the same word.
fn build_batch(base: &str) -> (Vec<RevisionEdit>, Vec<Edit>) {
    let spans = word_spans(base);
    let needed = PROPOSAL_EDITS + CONCURRENT_EDITS;
    assert!(
        spans.len() >= needed * 4,
        "fixture has too few words ({}) to sample {needed} disjoint, well-spaced edits",
        spans.len()
    );
    let stride = spans.len() / needed;

    let base_doc = Document::new(base.to_string());
    let proposal: Vec<RevisionEdit> = (0..PROPOSAL_EDITS)
        .map(|i| {
            let (start, end) = spans[i * stride];
            let word = &base[start..end];
            RevisionEdit {
                anchor: Anchor::new(&base_doc, start, end - start),
                replacement: copyedit(word),
            }
        })
        .collect();

    let concurrent: Vec<Edit> = (0..CONCURRENT_EDITS)
        .map(|i| {
            // Offset into the second half of each proposal-sized stride, so no
            // concurrent-edit span ever coincides with a proposal-edit span.
            let (start, end) = spans[PROPOSAL_EDITS * stride + i * stride + stride / 2];
            Edit {
                range: start..end,
                replacement: "revised".to_string(),
            }
        })
        .collect();

    (proposal, concurrent)
}

/// A minimal, always-clean "correction": flip the first letter's case (a realistic,
/// delimiter-free copyedit shape) — falls back to appending a plain-ASCII suffix for
/// the rare word with no cased first letter, so every generated edit is guaranteed
/// non-empty and non-identical to the original.
fn copyedit(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_lowercase() => c.to_uppercase().collect::<String>() + chars.as_str(),
        Some(c) if c.is_uppercase() => c.to_lowercase().collect::<String>() + chars.as_str(),
        _ => format!("{word}revised"),
    }
}

/// Byte spans of every maximal alphanumeric run in `text` — a dependency-free word
/// tokenizer (no external crate needed for a benchmark fixture), char-boundary-safe
/// via `char_indices`.
fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in text.char_indices() {
        match (ch.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                spans.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, text.len()));
    }
    spans
}

/// The `p`th percentile (0..=100) of `samples`, nearest-rank.
fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("durations are never NaN"));
    let idx = ((p / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
