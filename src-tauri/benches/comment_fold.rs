// ABOUTME: test-plan §6 tracked benchmark (P2b-10b) — fold of a 10,000-event comment log
// ABOUTME: (`store::comments::fold`, TD-4/P5), built from realistic cross-author causal chains.

//! A `cargo bench` target, deliberately excluded from `cargo test` (`test = false` in
//! `Cargo.toml`) — test-plan §6: benchmarks are "tracked... not a PR/CI gate" (#364).
//! Run explicitly:
//!
//! ```text
//! cargo bench --bench comment_fold
//! ```
//!
//! # What this measures, and why it decides the §4 RISK question
//!
//! `store::comments::fold` (TD-4) is the real causal fold every sidecar read goes
//! through: cross-author events merged by `(timestamp, id)` — never arrival order —
//! with dangling `parent_id` references buffered until their parent applies (P5).
//! tech-design §4 records event-log compaction as explicitly *not planned*:
//! "append-only is the contract; measure first" — this benchmark is that measurement.
//! `derive` (the fold's core) re-sorts and re-walks the **entire observed history on
//! every call** by construction (the doc comment on `Fold`: this is what makes the
//! incremental-sync invariant hold trivially) — so its cost is the thing compaction
//! would exist to bound, and this benchmark's number is the answer to whether it
//! needs to.
//!
//! # Why this input, not 10k trivially-ordered appends
//!
//! `build_events` generates the same shape test-plan **P5**'s own generators and
//! `fold_tests`' `the_full_causal_chain_folds_correctly_across_authors_regardless_of_arrival_order`
//! exercise, scaled up and made adversarial: 2,000 independent five-event causal
//! chains (create → reply → resolve → reopen → re-anchor, TD-4's full lifecycle),
//! rotated across five distinct authors per chain (cross-author, not a single
//! writer), a fraction of chains carrying genuine clock skew (a reply timestamped
//! *before* its own thread's create — forcing `fold`'s buffer-until-parent path to
//! actually buffer and later flush, not just pass through), and the whole 10,000-event
//! set Fisher-Yates shuffled under a fixed seed (arrival order is never causal order,
//! matching however sync happens to deliver different authors' JSONL files). A batch
//! of 10k trivially-ordered single-author appends would let `apply_if_ready` resolve
//! every event on first sight and never exercise the `pending` buffer at all — the
//! exact "measures nothing" failure mode #364 calls out.

use std::time::Instant;

use cowrite_lib::store::comments::{fold, CommentEvent, EventKind, SCHEMA_VERSION};
use textops::{Anchor, Document};

/// test-plan §6: "Fold of 10k-event comment log: < 50ms." First capture of this
/// benchmark, so the budget doubles as the baseline (P2b-10a's `FR_X_4_TARGET_MS`
/// convention) — only a >2x gross regression hard-fails (§6's own anti-flake rule).
const FOLD_TARGET_MS: f64 = 50.0;
const GROSS_REGRESSION_MS: f64 = FOLD_TARGET_MS * 2.0;

const THREAD_COUNT: usize = 2_000;
const EVENTS_PER_THREAD: usize = 5; // create, reply, resolve, reopen, re-anchor
const TOTAL_EVENTS: usize = THREAD_COUNT * EVENTS_PER_THREAD;
const WARMUP_ITERATIONS: usize = 2;
const TIMED_ITERATIONS: usize = 15;

const AUTHORS: [&str; 5] = ["alice", "bob", "carol", "dave", "agent-reviewer"];

fn main() {
    let events = build_events();
    assert_eq!(
        events.len(),
        TOTAL_EVENTS,
        "generator must produce exactly the advertised event count"
    );

    for _ in 0..WARMUP_ITERATIONS {
        let _ = fold(events.clone());
    }

    let mut durations_ms = Vec::with_capacity(TIMED_ITERATIONS);
    for _ in 0..TIMED_ITERATIONS {
        let batch = events.clone(); // cloned outside the timed section — `fold` takes ownership
        let start = Instant::now();
        let state = fold(batch);
        durations_ms.push(start.elapsed().as_secs_f64() * 1000.0);

        // Sanity: every chain resolves to its own thread, none lost to a buffer that
        // never flushed and none merged into the wrong thread — a benchmark whose
        // fold silently drops causal chains measures nothing (test-plan §6).
        assert_eq!(
            state.threads.len(),
            THREAD_COUNT,
            "expected every generated causal chain to fold to its own thread"
        );
    }

    let median = percentile(&durations_ms, 50.0);
    let p95 = percentile(&durations_ms, 95.0);
    let max = durations_ms.iter().cloned().fold(f64::MIN, f64::max);
    println!(
        "[bench] comment_fold — {TOTAL_EVENTS}-event cross-author causal log ({THREAD_COUNT} chains, {TIMED_ITERATIONS} runs): \
         median {median:.2}ms, p95 {p95:.2}ms, max {max:.2}ms (target {FOLD_TARGET_MS:.0}ms, gross-regression {GROSS_REGRESSION_MS:.0}ms)"
    );

    comment_log_fold_stays_within_the_ten_k_event_budget(median);
}

/// test-plan §6's own anti-flake policy: only a >2x-baseline gross regression fails —
/// never a tight wall-clock assertion on a shared/variable-hardware runner.
fn comment_log_fold_stays_within_the_ten_k_event_budget(median_ms: f64) {
    assert!(
        median_ms < GROSS_REGRESSION_MS,
        "median fold time {median_ms:.2}ms exceeds the test-plan §6 gross-regression line \
         ({GROSS_REGRESSION_MS:.0}ms, 2x the {FOLD_TARGET_MS:.0}ms budget) — investigate before accepting a new baseline"
    );
}

/// `THREAD_COUNT` independent create→reply→resolve→reopen→re-anchor chains
/// (`EVENTS_PER_THREAD` events each), cross-author, a fraction carrying deliberate
/// clock skew, all `TOTAL_EVENTS` shuffled under a fixed seed before returning —
/// see the module docs for why each element of this shape is load-bearing.
fn build_events() -> Vec<CommentEvent> {
    // A fixed base document long enough that every generated anchor offset stays
    // in bounds — content is irrelevant, only length matters here.
    let base = "the quick brown fox jumps over the lazy dog, a sentence repeated ".repeat(8);
    let doc = Document::new(base.clone());
    let anchor_len = 3usize;

    let mut events = Vec::with_capacity(TOTAL_EVENTS);
    for t in 0..THREAD_COUNT {
        let author = |role: usize| AUTHORS[(t + role) % AUTHORS.len()];
        let base_ts = (t as i64) * 10;
        // Every 7th chain: the reply's clock ran behind the thread's own create,
        // so sorting by (timestamp, id) alone would visit it first — only
        // buffer-until-parent lands it correctly (mirrors
        // `a_child_whose_timestamp_precedes_its_parents_due_to_clock_skew_still_applies`).
        let skewed = t % 7 == 0;
        let reply_ts = if skewed { base_ts - 3 } else { base_ts + 1 };
        // Every 5th chain: resolve and reopen land at the exact same millisecond —
        // exercises the (timestamp, id) tie-break, not input order.
        let tied = t % 5 == 0;
        let resolve_ts = base_ts + 2;
        let reopen_ts = if tied { resolve_ts } else { base_ts + 3 };
        let anchor_offset = (t * 7) % (base.len() - anchor_len);

        let create_id = format!("c{t}");
        let reply_id = format!("r{t}");
        let resolve_id = format!("s{t}");
        let reopen_id = format!("o{t}");
        let reanchor_id = format!("a{t}");

        events.push(CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: create_id.clone(),
            parent_id: None,
            author: author(0).to_string(),
            timestamp: base_ts,
            kind: EventKind::Create {
                anchor: Some(Anchor::new(&doc, anchor_offset, anchor_len)),
                body: format!("finding #{t}"),
                severity: Some("medium".to_string()),
                skill: None,
                workflow_run: None,
            },
        });
        events.push(CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: reply_id,
            parent_id: Some(create_id.clone()),
            author: author(1).to_string(),
            timestamp: reply_ts,
            kind: EventKind::Reply {
                body: "on it".to_string(),
                defense: false,
                published: false,
                run_id: None,
            },
        });
        events.push(CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: resolve_id,
            parent_id: Some(create_id.clone()),
            author: author(2).to_string(),
            timestamp: resolve_ts,
            kind: EventKind::Resolve,
        });
        events.push(CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: reopen_id,
            parent_id: Some(create_id.clone()),
            author: author(3).to_string(),
            timestamp: reopen_ts,
            kind: EventKind::Reopen,
        });
        events.push(CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: reanchor_id,
            parent_id: Some(create_id),
            author: author(4).to_string(),
            timestamp: base_ts + 4,
            kind: EventKind::ReAnchor {
                anchor: Anchor::new(
                    &doc,
                    (anchor_offset + 5) % (base.len() - anchor_len),
                    anchor_len,
                ),
            },
        });
    }

    shuffle(&mut events, 0x5EED_C0DE);
    events
}

/// Deterministic Fisher-Yates shuffle keyed on `seed` — no external RNG dependency
/// (mirrors `store::comments::fold_properties`'s own shuffle trick), so the
/// "arrival order ≠ causal order" adversarial interleaving is reproducible.
fn shuffle<T>(items: &mut [T], seed: u64) {
    let len = items.len();
    for i in (1..len).rev() {
        let j = ((seed as usize).wrapping_add(i.wrapping_mul(2_654_435_761))) % (i + 1);
        items.swap(i, j);
    }
}

/// The `p`th percentile (0..=100) of `samples`, nearest-rank.
fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("durations are never NaN"));
    let idx = ((p / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
