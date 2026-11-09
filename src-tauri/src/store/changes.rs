// ABOUTME: Track-changes attribution store — TD-4's single-JSON-per-doc schema, records keyed by
// ABOUTME: change ID (author, type, timestamps, group, change-set, note), plus its deterministic fold.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};
use textops::Anchor;

/// Bumped whenever the on-wire record shape changes (TD-4: "every file carries
/// `schema_version`"). Matches `store::comments::SCHEMA_VERSION`'s role: reader-side
/// version handling is P1-13's schema-publishing job, not this module's.
pub const SCHEMA_VERSION: u32 = 1;

/// The `author` every agent-attributed change carries (TD-4). M2a scope: the provider
/// identity is not threaded to the attribution layer yet, so both delivery paths — the
/// `propose_changes` MCP tool (`agent::state`) and the detect-and-convert watchdog
/// (`agent::watchdog`) — attribute to this one generic agent author, kept here so the
/// two writers can never drift.
pub const AGENT_AUTHOR: &str = "agent";

/// Milliseconds since the Unix epoch — the `created_at`/`updated_at` stamp every
/// change record carries (TD-4's last-write-wins tie-break). Both agent-attributed
/// writers — the `propose_changes` MCP tool (`agent::state`) and the detect-and-convert
/// watchdog (`agent::watchdog`) — timestamp through this one function so the semantics
/// can never drift. A pre-1970 clock (impossible in practice) floors to 0 rather than
/// panicking.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Which CriticMarkup marker a change is (mirrors `textops::critic::MarkupKind`'s
/// discriminant). Deliberately carries no range/text: the marker itself, live in the
/// document, is the source of truth for *what* changed (TD-2) — this schema only
/// records *who* changed it and how it's grouped/noted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    Insertion,
    Deletion,
    Substitution,
}

impl From<textops::MarkerKind> for ChangeType {
    /// The attribution type for a rendered CriticMarkup marker (`textops::deliver`):
    /// every delivery/conversion that renders a marker attributes it under the
    /// matching `ChangeType`. Shared by `propose_changes` (`agent::state`) and the
    /// detect-and-convert watchdog (`agent::watchdog`) so the mapping lives once.
    fn from(kind: textops::MarkerKind) -> ChangeType {
        match kind {
            textops::MarkerKind::Insertion => ChangeType::Insertion,
            textops::MarkerKind::Deletion => ChangeType::Deletion,
            textops::MarkerKind::Substitution => ChangeType::Substitution,
        }
    }
}

/// One attribution record for a single pending change, keyed by `id` (TD-4:
/// "attribution keyed by change ID"; issue #46: author, type, timestamps, group,
/// change-set, note).
///
/// `.cowrite/changes/<doc-hash>.json` holds the *current* record set: track-changes
/// is single-writer by design (only the author decides changes, D19), so the writer
/// simply persists the latest record per id and last-write-wins is correct by
/// construction (TD-4) — there is no cross-author merge to arbitrate, unlike
/// `store::comments`'s multi-author causal fold. `fold` (below) still resolves a
/// batch of observed records deterministically, so re-deriving the current map from
/// however many `propose_changes`/amend calls contributed to it is stable regardless
/// of the order those calls are observed in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub schema_version: u32,
    pub id: String,
    pub kind: ChangeType,
    pub author: String,
    /// TD-4's shared anchor shape — where in the document this change lives, plus
    /// enough captured context to re-locate it if it drifts (D17).
    pub anchor: Anchor,
    /// Milliseconds since the Unix epoch this change was first proposed.
    pub created_at: i64,
    /// Milliseconds since the Unix epoch this record was last written — the
    /// single-writer last-write-wins tie-break `fold` sorts by (TD-4/D19).
    pub updated_at: i64,
    /// Links this change to every other change decided together with it (a
    /// substitution's delete+insert pair, or a wider agent-delivered set) — mirrors
    /// `textops::apply::Grouping`. `None` is a singleton change.
    pub group: Option<String>,
    /// The atomic delivery this change belongs to — `propose_changes`'s returned
    /// `change_set_id` (§3.2). Every change from one delivery shares a `change_set`.
    pub change_set: Option<String>,
    /// The edit's optional note (§3.2 `edits[{range, replacement, note?}]`).
    pub note: Option<String>,
}

/// The deterministic reduction of observed `ChangeRecord`s to the current
/// per-change-id attribution state (test-plan-style fold, issue #46: "fold
/// deterministic").
///
/// Unlike `store::comments::Fold` — which resolves *causal* cross-author event
/// chains (create/reply/resolve linked by `parent_id`) — this fold has no threading
/// structure: each record is already the complete attribution for one change id, so
/// resolving a batch is a flat last-write-wins reduction. Records are ordered by
/// `(updated_at, id)` before folding (never observation/arrival order), so the
/// result is independent of how records were batched across `apply` calls or what
/// order they arrived in — the same determinism guarantee TD-4's single-writer
/// last-write-wins semantics requires, made explicit and testable here.
///
/// `Fold` re-derives `changes` from its *full* observed record history on every
/// `apply`, exactly as `store::comments::Fold` does — which is what makes
/// `fold(prefix)` then `apply(rest)` equal `fold(all)` hold by construction.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fold {
    records: Vec<ChangeRecord>,
    pub changes: BTreeMap<String, ChangeRecord>,
}

impl Fold {
    pub fn new() -> Fold {
        Fold::default()
    }

    /// Fold a batch of newly observed records into this state, on top of everything
    /// already observed. The order records arrive across `apply` calls (or within a
    /// single call) never affects the result.
    pub fn apply<I: IntoIterator<Item = ChangeRecord>>(&mut self, new_records: I) {
        self.records.extend(new_records);
        self.changes = derive(&self.records);
    }
}

/// One-shot fold of a full record set. Equivalent to `Fold::new()` then `apply`.
pub fn fold<I: IntoIterator<Item = ChangeRecord>>(records: I) -> Fold {
    let mut state = Fold::new();
    state.apply(records);
    state
}

/// Derive the current per-id attribution map from a full set of observed records,
/// deterministically. Multiple records for the same id resolve to the one with the
/// greatest `(updated_at, id)` — last-write-wins (TD-4/D19); `id` only breaks ties
/// between *different* ids sorting adjacently, since a genuine tie on the same id
/// (identical `updated_at`) cannot arise from a single writer.
fn derive(records: &[ChangeRecord]) -> BTreeMap<String, ChangeRecord> {
    let mut ordered: Vec<&ChangeRecord> = records.iter().collect();
    ordered.sort_by(|a, b| (a.updated_at, a.id.as_str()).cmp(&(b.updated_at, b.id.as_str())));

    let mut changes = BTreeMap::new();
    for record in ordered {
        changes.insert(record.id.clone(), record.clone());
    }
    changes
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    fn doc() -> textops::Document {
        textops::Document::new("The quick fox jumps.")
    }

    fn record(id: &str, updated_at: i64) -> ChangeRecord {
        ChangeRecord {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            kind: ChangeType::Insertion,
            author: "claude-code".to_string(),
            anchor: Anchor::new(&doc(), 4, 5),
            created_at: 100,
            updated_at,
            group: Some("g1".to_string()),
            change_set: Some("cs1".to_string()),
            note: Some("tightened the verb".to_string()),
        }
    }

    #[test]
    fn change_record_round_trips_through_json() {
        let rec = record("c1", 100);
        let json = serde_json::to_string(&rec).unwrap();
        let back: ChangeRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, rec);
    }

    #[test]
    fn change_record_round_trips_with_optional_fields_absent() {
        let mut rec = record("c1", 100);
        rec.group = None;
        rec.change_set = None;
        rec.note = None;
        let json = serde_json::to_string(&rec).unwrap();
        let back: ChangeRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, rec);
    }

    #[test]
    fn every_change_type_round_trips_through_json() {
        for kind in [
            ChangeType::Insertion,
            ChangeType::Deletion,
            ChangeType::Substitution,
        ] {
            let mut rec = record("c1", 100);
            rec.kind = kind;
            let json = serde_json::to_string(&rec).unwrap();
            let back: ChangeRecord = serde_json::from_str(&json).unwrap();
            assert_eq!(back.kind, kind);
        }
    }

    #[test]
    fn change_type_serializes_as_the_documented_snake_case_tag() {
        // The wire shape is part of the sidecar contract (TD-4/FR-X-8) — pin the
        // exact tag strings so a future refactor can't silently rename them.
        assert_eq!(
            serde_json::to_string(&ChangeType::Insertion).unwrap(),
            "\"insertion\""
        );
        assert_eq!(
            serde_json::to_string(&ChangeType::Deletion).unwrap(),
            "\"deletion\""
        );
        assert_eq!(
            serde_json::to_string(&ChangeType::Substitution).unwrap(),
            "\"substitution\""
        );
    }
}

#[cfg(test)]
mod conformance_tests {
    // Binds this module's wire shape to the *published* contract (FR-X-8, P1-13):
    // every `ChangeRecord` this module can produce must validate against
    // `docs/formats/sidecar/change-record.schema.json`.
    use super::*;
    use crate::store::schema::{is_valid, Schema};

    fn doc() -> textops::Document {
        textops::Document::new("The quick fox jumps.")
    }

    fn record(kind: ChangeType) -> ChangeRecord {
        ChangeRecord {
            schema_version: SCHEMA_VERSION,
            id: "c1".to_string(),
            kind,
            author: "claude-code".to_string(),
            anchor: Anchor::new(&doc(), 4, 5),
            created_at: 100,
            updated_at: 200,
            group: Some("g1".to_string()),
            change_set: Some("cs1".to_string()),
            note: Some("tightened the verb".to_string()),
        }
    }

    fn valid(rec: &ChangeRecord) -> bool {
        is_valid(Schema::ChangeRecord, &serde_json::to_value(rec).unwrap())
    }

    #[test]
    fn every_change_type_conforms_to_the_published_schema() {
        for kind in [
            ChangeType::Insertion,
            ChangeType::Deletion,
            ChangeType::Substitution,
        ] {
            assert!(valid(&record(kind)));
        }
    }

    #[test]
    fn a_record_with_optional_fields_absent_conforms_to_the_published_schema() {
        let mut rec = record(ChangeType::Insertion);
        rec.group = None;
        rec.change_set = None;
        rec.note = None;
        assert!(valid(&rec));
    }

    #[test]
    fn a_record_missing_its_anchor_is_rejected() {
        let mut value = serde_json::to_value(record(ChangeType::Insertion)).unwrap();
        value.as_object_mut().unwrap().remove("anchor");
        assert!(!is_valid(Schema::ChangeRecord, &value));
    }

    #[test]
    fn a_record_with_an_unrecognized_kind_is_rejected() {
        let mut value = serde_json::to_value(record(ChangeType::Insertion)).unwrap();
        value["kind"] = serde_json::json!("rewrite");
        assert!(!is_valid(Schema::ChangeRecord, &value));
    }
}

#[cfg(test)]
mod fold_tests {
    use super::*;

    fn doc() -> textops::Document {
        textops::Document::new("The quick fox jumps.")
    }

    fn record(
        id: &str,
        kind: ChangeType,
        author: &str,
        created_at: i64,
        updated_at: i64,
    ) -> ChangeRecord {
        ChangeRecord {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            kind,
            author: author.to_string(),
            anchor: Anchor::new(&doc(), 4, 5),
            created_at,
            updated_at,
            group: None,
            change_set: None,
            note: None,
        }
    }

    #[test]
    fn a_single_record_appears_in_the_fold_under_its_id() {
        let state = fold([record("c1", ChangeType::Insertion, "alice", 0, 0)]);
        assert_eq!(state.changes.len(), 1);
        assert_eq!(state.changes["c1"].author, "alice");
    }

    #[test]
    fn distinct_ids_all_survive_the_fold() {
        let state = fold([
            record("c1", ChangeType::Insertion, "alice", 0, 0),
            record("c2", ChangeType::Deletion, "claude-code", 1, 1),
        ]);
        assert_eq!(state.changes.len(), 2);
        assert_eq!(state.changes["c1"].kind, ChangeType::Insertion);
        assert_eq!(state.changes["c2"].kind, ChangeType::Deletion);
    }

    #[test]
    fn a_later_update_wins_over_an_earlier_one_for_the_same_id() {
        // Same change id amended later (e.g. re-grouped or re-noted) — the record
        // with the greater `updated_at` wins, regardless of arrival order.
        let earlier = record("c1", ChangeType::Insertion, "alice", 0, 10);
        let mut later = record("c1", ChangeType::Insertion, "alice", 0, 20);
        later.note = Some("amended".to_string());

        let forward = fold([earlier.clone(), later.clone()]);
        let backward = fold([later.clone(), earlier.clone()]);

        assert_eq!(forward.changes["c1"].note.as_deref(), Some("amended"));
        assert_eq!(forward.changes, backward.changes);
    }

    #[test]
    fn identical_updated_at_across_different_ids_breaks_ties_deterministically_by_id() {
        // Not a same-id conflict (single-writer precludes that) — just pins that the
        // sort key is well-defined and order-stable when two different changes share
        // a millisecond, so the fold never depends on input order in that case.
        let forward = fold([
            record("c2", ChangeType::Deletion, "bob", 5, 5),
            record("c1", ChangeType::Insertion, "alice", 5, 5),
        ]);
        let backward = fold([
            record("c1", ChangeType::Insertion, "alice", 5, 5),
            record("c2", ChangeType::Deletion, "bob", 5, 5),
        ]);
        assert_eq!(forward.changes, backward.changes);
    }

    #[test]
    fn folding_a_prefix_then_the_rest_matches_folding_everything_at_once() {
        let all = vec![
            record("c1", ChangeType::Insertion, "alice", 0, 0),
            record("c2", ChangeType::Deletion, "claude-code", 1, 1),
            record("c1", ChangeType::Insertion, "alice", 0, 5), // amends c1
        ];

        let mut incremental = Fold::new();
        incremental.apply(all[..2].to_vec());
        incremental.apply(all[2..].to_vec());

        let direct = fold(all);
        assert_eq!(incremental.changes, direct.changes);
    }

    #[test]
    fn empty_input_folds_to_an_empty_map() {
        let state = fold(Vec::<ChangeRecord>::new());
        assert!(state.changes.is_empty());
    }
}

#[cfg(test)]
mod fold_properties {
    use super::*;
    use proptest::prelude::*;

    /// A generated record's shape: which of a small fixed set of change ids it
    /// belongs to, and a *globally unique* `updated_at` (assigned by `to_records`
    /// from each element's position) — so records can collide on id (exercising
    /// last-write-wins) but never on `(id, updated_at)` together, which is the one
    /// case a single writer can't produce (see `derive`'s doc comment).
    fn raw_record() -> impl Strategy<Value = (usize, ChangeType, usize)> {
        (
            0usize..4, // id index — small range forces id collisions
            prop_oneof![
                Just(ChangeType::Insertion),
                Just(ChangeType::Deletion),
                Just(ChangeType::Substitution),
            ],
            0usize..3, // author index
        )
    }

    fn to_records(raw: Vec<(usize, ChangeType, usize)>) -> Vec<ChangeRecord> {
        let doc = textops::Document::new("The quick fox jumps.");
        raw.into_iter()
            .enumerate()
            .map(|(idx, (id_idx, kind, author_idx))| ChangeRecord {
                schema_version: SCHEMA_VERSION,
                id: format!("c{id_idx}"),
                kind,
                author: format!("author{author_idx}"),
                anchor: Anchor::new(&doc, 0, 3),
                created_at: 0,
                updated_at: idx as i64, // unique per record — see raw_record's doc comment
                group: None,
                change_set: None,
                note: None,
            })
            .collect()
    }

    proptest! {
        // fold never panics on arbitrary (including heavily id-colliding) input.
        #[test]
        fn prop_fold_never_panics_on_arbitrary_records(raw in prop::collection::vec(raw_record(), 0..16)) {
            let records = to_records(raw);
            let _ = fold(records);
        }

        // Determinism: a fixed multiset of records folds to the same result
        // regardless of arrival order.
        #[test]
        fn prop_fold_is_independent_of_input_order(
            raw in prop::collection::vec(raw_record(), 0..16),
            seed in 0u64..10_000,
        ) {
            let records = to_records(raw);
            let original = fold(records.clone()).changes;

            let mut shuffled = records.clone();
            let len = shuffled.len();
            if len > 1 {
                for i in (1..len).rev() {
                    let j = ((seed as usize).wrapping_add(i * 2654435761)) % (i + 1);
                    shuffled.swap(i, j);
                }
            }
            let reordered = fold(shuffled).changes;
            prop_assert_eq!(original, reordered);
        }

        // Incremental-sync invariant: folding a prefix, then continuing with the
        // rest, always equals folding everything in one shot, at any split point.
        #[test]
        fn prop_incremental_fold_matches_one_shot_fold(
            raw in prop::collection::vec(raw_record(), 0..16),
            split_seed in 0usize..17,
        ) {
            let records = to_records(raw);
            let split = if records.is_empty() { 0 } else { split_seed % (records.len() + 1) };
            let (prefix, rest) = records.split_at(split);

            let mut incremental = Fold::new();
            incremental.apply(prefix.to_vec());
            incremental.apply(rest.to_vec());

            let direct = fold(records.clone());
            prop_assert_eq!(incremental.changes, direct.changes);
        }

        // Last-write-wins: for every id present, the winning record is the one with
        // the greatest `updated_at` among all records sharing that id — never any
        // other.
        #[test]
        fn prop_winner_per_id_has_the_maximum_updated_at(raw in prop::collection::vec(raw_record(), 1..16)) {
            let records = to_records(raw);
            let state = fold(records.clone());
            for (id, winner) in &state.changes {
                let max_updated_at = records
                    .iter()
                    .filter(|r| &r.id == id)
                    .map(|r| r.updated_at)
                    .max()
                    .unwrap();
                prop_assert_eq!(winner.updated_at, max_updated_at);
            }
        }
    }
}
