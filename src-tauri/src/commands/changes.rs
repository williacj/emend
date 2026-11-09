// ABOUTME: CriticMarkup parse-snapshot IPC (P2a-5, TD-11 corollary) — the single authoritative
// ABOUTME: parse the editor's interactive accept/reject redline layer seeds its snapshot from.

//! The one parse the interactive redline layer trusts (FR-ED-4, TD-11 corollary).
//!
//! `textops::critic::parse` is the authoritative CriticMarkup locator (it alone
//! knows the exclusion zones — code fences, inline code, frontmatter — so a literal
//! `{++` in a code block is never mistaken for a change). The editor cannot re-derive
//! that in TypeScript without duplicating 1500 lines and drifting from the engine
//! accept/reject actually runs against, so it asks the backend **once** — when a
//! document opens or an agent delivers — and holds the result as a snapshot whose
//! change identities are the durable TD-4 id where a record joins, otherwise an
//! honest snapshot-scoped synthetic. CodeMirror maps their geometry through edits.
//! That is exactly the TD-11 corollary's "single parse snapshot / stable change
//! identity, never re-parse-then-positional-index".
//!
//! The coordinate translation done here: `textops` indexes in **bytes** (TD-6), but
//! CodeMirror 6 and JS strings index in **UTF-16 code units**. A marker sitting past
//! an astral character (e.g. `🎉`) would land at a different offset in the two
//! spaces — the very v1 bug `critic.rs` was written to avoid — so every offset is
//! converted to UTF-16 units before it crosses the boundary. This command also joins
//! the parse to the document's attribution records; it never serializes text.

use std::collections::HashMap;
use std::ops::Range;
use std::path::Path;

use serde::{Deserialize, Serialize};
use textops::critic::{parse, Markup, MarkupKind};
use textops::{Revision, Utf16Offsets};
use uuid::Uuid;

use crate::store::changes::ChangeRecord;
use crate::store::service::SidecarStore;

use super::document::CommandError;
use super::path_confine::{confine, identity_relative};

/// A half-open offset range in **UTF-16 code units** (CodeMirror / JS-string
/// coordinates), converted from the byte offsets `textops` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Span {
    pub from: usize,
    pub to: usize,
}

/// The change's kind plus the UTF-16 spans of its inner text segments — enough for
/// the frontend to place redline decorations (underline the added side, strike the
/// removed side) and hide the delimiters (everything in `full` outside these spans),
/// without re-scanning the marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChangeKind {
    /// `{++text++}` — `text` is the added side (underlined; kept on accept).
    Insertion { text: Span },
    /// `{--text--}` — `text` is the removed side (struck; kept on reject).
    Deletion { text: Span },
    /// `{~~old~>new~~}` — `old` struck, `new` underlined.
    Substitution { old: Span, new: Span },
}

/// Names the document a parse is joined against (TD-16 ruling 3).
///
/// Supplied as a pair or not at all: `root` is the project root the record set is resolved under
/// (`.emend/docs.json` lives there — the join is unreachable without it) and `path` is the
/// document inside it, project-relative in the app's canonical spelling (the same string a tab
/// key and `DeliveryNotice.doc` carry). A buffer with no project — a scratch document, a
/// dev-mode parse — supplies neither, and every one of its markers is honestly unrecorded.
#[derive(Debug, Clone, Deserialize)]
pub struct DocRef {
    pub root: String,
    pub path: String,
}

/// One CriticMarkup change in the snapshot the interactive redline layer seeds from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePayload {
    /// This change's identity, opaque to every consumer (TD-16 rulings 1–2): the durable TD-4
    /// `chg-<uuid>` of the `ChangeRecord` this marker joined, or — when it joined none — an
    /// honest snapshot-scoped synthetic, `snap:<doc>:<generation>:<ordinal>`. Never parsed back
    /// into a number, compared numerically, or read for its prefix by a consumer: [`recorded`]
    /// (not the id's shape) is what says which population a change belongs to.
    ///
    /// The frontend keys interactive accept/reject decisions to this identity and maps its
    /// geometry through CodeMirror edits — never a re-parse-then-index (TD-11).
    ///
    /// [`recorded`]: Self::recorded
    pub id: String,
    /// Whether this marker joined a TD-4 `ChangeRecord` (TD-16 ruling 2). `true` — the backend
    /// vouches for this change: [`id`](Self::id) is durable and [`group`](Self::group) is its
    /// authoritative grouping. `false` — human-typed CriticMarkup, an imported or pre-Cowrite
    /// file, or a marker whose record no longer joins: identity is snapshot-scoped and grouping
    /// is the editor's to infer. The two populations are grouped by disjoint rules (ruling 4), so
    /// this flag is what keeps them from being mixed, not the id's spelling.
    pub recorded: bool,
    /// The group this change decides all-or-none with (P4b, `textops::apply::Grouping`) — the
    /// joined record's `group` (`grp-<uuid>`). `None` means *no backend group*: for a recorded
    /// change that is the backend positively asserting a singleton; for an unrecorded one it
    /// simply carries no record to assert anything (see [`recorded`](Self::recorded)).
    pub group: Option<String>,
    /// The whole marker span, delimiters included (the click / decision target).
    pub full: Span,
    /// The kind and its inner-segment spans.
    #[serde(flatten)]
    pub kind: ChangeKind,
}

/// Parse `content`'s CriticMarkup into the interactive snapshot (UTF-16 offsets), joined against
/// `doc`'s TD-4 attribution records so every change crosses the boundary under its durable
/// identity where one exists (TD-16 ruling 3).
///
/// Infallible — a document with no markup yields an empty vector — but returns
/// `Result` so it slots into the same thin `validate → call → return` command shape
/// (and the test-driver's dispatcher) as the fallible commands (§3.1).
#[tauri::command]
// @anchor:parse-changes-entry
pub fn parse_changes(
    doc: Option<DocRef>,
    content: String,
) -> Result<Vec<ChangePayload>, CommandError> {
    let doc_name = doc.as_ref().map(|value| value.path.as_str()).unwrap_or("");
    let records = doc.as_ref().map(records_for).unwrap_or_default();
    Ok(parse_changes_with_records(&content, doc_name, &records))
}

/// Path-independent variant for an untitled document whose TD-4 identity has already been
/// checkpointed in the tab session (#1803).
#[tauri::command]
pub fn parse_changes_by_id(
    root: String,
    doc_id: String,
    content: String,
) -> Result<Vec<ChangePayload>, CommandError> {
    let id = Uuid::parse_str(&doc_id)
        .map_err(|_| CommandError::InvalidDocument("invalid untitled document id".into()))?;
    let canonical = crate::store::project_identity::require_canonical_root(Path::new(&root))
        .map_err(|error| CommandError::InvalidDocument(error.to_string()))?;
    let records = SidecarStore::new(canonical)
        .fold_changes(id)
        .map(|fold| fold.changes.into_values().collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(parse_changes_with_records(&content, &doc_id, &records))
}

fn parse_changes_with_records(
    content: &str,
    doc_name: &str,
    records: &[ChangeRecord],
) -> Vec<ChangePayload> {
    let markups = parse(content);

    // Convert every byte offset the parse reports to UTF-16 units in a single pass:
    // gather them, sort/dedup, walk the string once, then look each back up. O(n + m·log m)
    // rather than an O(n) `encode_utf16().count()` per offset.
    let mut byte_offsets: Vec<usize> = Vec::with_capacity(markups.len() * 4);
    for m in &markups {
        byte_offsets.push(m.full.start);
        byte_offsets.push(m.full.end);
        for seg in segments(&m.kind) {
            byte_offsets.push(seg.start);
            byte_offsets.push(seg.end);
        }
    }
    let convert = Utf16Offsets::new(content, byte_offsets);
    let span = |r: &Range<usize>| Span {
        from: convert.at(r.start),
        to: convert.at(r.end),
    };

    let identities = identities(doc_name, content, &markups, records);

    markups
        .iter()
        .zip(identities)
        .map(|(m, identity)| ChangePayload {
            id: identity.id,
            recorded: identity.recorded,
            group: identity.group,
            full: span(&m.full),
            kind: match &m.kind {
                MarkupKind::Insertion { text } => ChangeKind::Insertion { text: span(text) },
                MarkupKind::Deletion { text } => ChangeKind::Deletion { text: span(text) },
                MarkupKind::Substitution { old, new } => ChangeKind::Substitution {
                    old: span(old),
                    new: span(new),
                },
            },
        })
        .collect()
}

/// What one marker crosses the parse boundary as (TD-16 ruling 2) — the two populations the
/// join produces, in the shape [`ChangePayload`] carries them.
struct Identity {
    id: String,
    recorded: bool,
    group: Option<String>,
}

/// Resolve every marker's identity: the joined record's durable `chg-` id and group where the
/// join succeeds, an honest `snap:<doc>:<generation>:<ordinal>` synthetic where it does not.
///
/// `generation` is `Revision::of(content)` — the same token UXR-Q4 already compares — so a
/// synthetic is unique across documents *and* across parse generations, and is deliberately not
/// durable across a reseed: that is the truth about a marker no record vouches for. A marker that
/// begins unrecorded acquires its durable id at the first parse whose join succeeds (a doc path is
/// now supplied, a drifted snapshot now matches uniquely), which is safe because a reseed replaces
/// the whole live field at once.
fn identities(
    doc_name: &str,
    content: &str,
    markups: &[Markup],
    records: &[ChangeRecord],
) -> Vec<Identity> {
    // A document with no markup has nothing to identify — and so no reason to read its sidecar
    // at all, which is the common case for opening an ordinary file.
    if markups.is_empty() {
        return Vec::new();
    }
    let joined = join(content, markups, records);
    let generation = Revision::of(content);
    // No document named means nothing to scope the synthetic *to* beyond the content itself —
    // an empty segment, never an invented document name.
    joined
        .into_iter()
        .enumerate()
        .map(|(ordinal, matched)| match matched {
            Some(index) => {
                let record = &records[index];
                Identity {
                    id: record.id.clone(),
                    recorded: true,
                    group: record.group.clone(),
                }
            }
            None => Identity {
                // @anchor:snapshot-scoped-change-id
                id: format!("snap:{doc_name}:{}:{ordinal}", generation.as_str()),
                recorded: false,
                group: None,
            },
        })
        .collect()
}

/// `doc`'s TD-4 record set, through the existing `docs.json` → `fold_changes` path.
///
/// Every failure degrades to *no records* rather than failing the parse: an unconfinable path, a
/// document with no sidecar identity yet, an unreadable or corrupt changes file. The marker still
/// renders, but losing its durable identity also removes it from a `chg-`-keyed delivery card and
/// discards its authoritative group. The same degradation currently occurs when a CRLF disk anchor
/// is joined against CM6's LF-only reopen text (#447). Decision reporting must therefore preserve
/// an explicit empty result rather than claim that an unmatched card was decided. Losing the whole
/// redline layer, which is what a returned error would cost (`EditorShell` degrades a failed parse
/// to no decoration at all), remains a worse answer to the same question.
fn records_for(doc: &DocRef) -> Vec<ChangeRecord> {
    let root = Path::new(&doc.root);
    let Ok(confined) = confine(root, &doc.path) else {
        return Vec::new();
    };
    let Ok(key) = identity_relative(root, &confined) else {
        return Vec::new();
    };
    let store = SidecarStore::new(root);
    let Ok(Some(id)) = store.doc_id_for_path(&key) else {
        return Vec::new();
    };
    let Ok(fold) = store.fold_changes(id) else {
        return Vec::new();
    };
    fold.changes.into_values().collect()
}

/// Join `markups` to `records` marker-by-marker, returning the record index each marker matched
/// (`None` = unmatched, therefore unrecorded). Two conservative stages, and only two (TD-16
/// ruling 3):
///
/// 1. **Exact** — the record's anchor offset *and* its captured snapshot both name this marker.
///    The undrifted case: free, and total for a document nobody has edited since delivery.
/// 2. **Unique snapshot** — the record's snapshot occurs exactly once in the live text, and that
///    occurrence is exactly a marker's span (D17's exact-hit stage). This is what survives the
///    user typing elsewhere in the document.
///
/// Anything else is left unmatched. The join never fuzzy-guesses and never resolves a contest:
/// two records naming one marker, or one snapshot occurring twice, leaves the marker unrecorded.
/// That refusal removes ambiguous candidate selection as a mis-join mechanism. It does not make an
/// absolute claim across coordinate spaces: CRLF disk anchors currently fail to join against CM6's
/// LF-only reopen text and deliberately degrade to unrecorded until #447 reconciles those spaces.
// @anchor:change-record-exact-match-stage
fn join(content: &str, markups: &[Markup], records: &[ChangeRecord]) -> Vec<Option<usize>> {
    let mut matched: Vec<Option<usize>> = vec![None; markups.len()];
    let mut consumed = vec![false; records.len()];

    // Stage 1: exact. Records indexed by anchor offset so this stays linear in the common case.
    let mut by_offset: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        by_offset
            .entry(record.anchor.offset)
            .or_default()
            .push(index);
    }
    for (i, markup) in markups.iter().enumerate() {
        let text = &content[markup.full.clone()];
        let mut hits = by_offset
            .get(&markup.full.start)
            .into_iter()
            .flatten()
            .filter(|&&index| records[index].anchor.text_snapshot == text);
        let (Some(&index), None) = (hits.next(), hits.next()) else {
            continue;
        };
        matched[i] = Some(index);
        consumed[index] = true;
    }

    // Stage 2: unique snapshot. Claims are collected before any is honored, so a marker two
    // records both resolve to is dropped rather than awarded to whichever was seen first.
    let marker_at: HashMap<usize, usize> = markups
        .iter()
        .enumerate()
        .map(|(i, m)| (m.full.start, i))
        .collect();
    let mut claims: Vec<Claim> = vec![Claim::Free; markups.len()];
    for (index, record) in records.iter().enumerate() {
        if consumed[index] {
            continue;
        }
        let snapshot = record.anchor.text_snapshot.as_str();
        if snapshot.is_empty() {
            continue;
        }
        let mut occurrences = content.match_indices(snapshot);
        let (Some((at, _)), None) = (occurrences.next(), occurrences.next()) else {
            continue;
        };
        // The single occurrence must *be* a marker, span for span — a snapshot that merely sits
        // inside one, or straddles it, names no change.
        let Some(&i) = marker_at.get(&at) else {
            continue;
        };
        if markups[i].full.end != at + snapshot.len() || matched[i].is_some() {
            continue;
        }
        claims[i] = match claims[i] {
            Claim::Free => Claim::One(index),
            _ => Claim::Contested,
        };
    }
    // Only a settled single claim is honored — writing every element back here would erase the
    // matches stage 1 already made.
    for (i, claim) in claims.into_iter().enumerate() {
        if let Claim::One(index) = claim {
            matched[i] = Some(index);
        }
    }

    matched
}

/// How many unconsumed records resolved to one marker in the join's second stage. `Contested` is
/// terminal — a marker two records both name stays unrecorded, never awarded to either.
#[derive(Clone, Copy)]
enum Claim {
    Free,
    One(usize),
    Contested,
}

/// The inner text-segment byte ranges of a change kind (one for ins/del, two for sub).
fn segments(kind: &MarkupKind) -> Vec<Range<usize>> {
    match kind {
        MarkupKind::Insertion { text } | MarkupKind::Deletion { text } => vec![text.clone()],
        MarkupKind::Substitution { old, new } => vec![old.clone(), new.clone()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changes(content: &str) -> Vec<ChangePayload> {
        parse_changes(None, content.to_string()).unwrap()
    }

    #[test]
    fn a_clean_document_has_no_changes() {
        assert!(changes("no markup here").is_empty());
    }

    #[test]
    fn insertion_reports_full_span_and_inner_text() {
        // "Hi {++there++}!" — full covers the whole marker, text just the inner run.
        let c = changes("Hi {++there++}!");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].full, Span { from: 3, to: 14 });
        assert_eq!(
            c[0].kind,
            ChangeKind::Insertion {
                text: Span { from: 6, to: 11 }
            }
        );
    }

    #[test]
    fn deletion_reports_the_removed_run() {
        let c = changes("a {--gone--} b");
        assert_eq!(
            c[0].kind,
            ChangeKind::Deletion {
                text: Span { from: 5, to: 9 }
            }
        );
    }

    #[test]
    fn substitution_reports_old_and_new_spans() {
        // "{~~old~>new~~}" — old at 3..6, new at 8..11 (the `~>` sits between).
        let c = changes("{~~old~>new~~}");
        assert_eq!(
            c[0].kind,
            ChangeKind::Substitution {
                old: Span { from: 3, to: 6 },
                new: Span { from: 8, to: 11 },
            }
        );
    }

    #[test]
    fn changes_are_reported_in_document_order() {
        let c = changes("{++a++} {--b--} {~~c~>d~~}");
        assert_eq!(c.len(), 3);
        assert!(c[0].full.from < c[1].full.from && c[1].full.from < c[2].full.from);
    }

    #[test]
    fn offsets_are_utf16_units_not_bytes() {
        // "🎉" is 4 bytes but 2 UTF-16 code units — the marker after it must report UTF-16
        // offsets so CodeMirror (which indexes in UTF-16) places the decoration correctly.
        let c = changes("🎉{++x++}");
        // "🎉" = 2 UTF-16 units, so the marker starts at 2, its inner "x" at 5..6.
        assert_eq!(c[0].full, Span { from: 2, to: 9 });
        assert_eq!(
            c[0].kind,
            ChangeKind::Insertion {
                text: Span { from: 5, to: 6 }
            }
        );
    }

    #[test]
    fn markup_inside_code_is_not_a_change() {
        // The whole reason the frontend must not re-parse in TS: exclusion zones.
        let c = changes("`{++x++}`");
        assert!(c.is_empty());
    }
}

/// The TD-16 document-aware join (rulings 2–4): which identity a marker crosses the boundary
/// under, and — just as load-bearing — which markers deliberately get *no* durable identity.
#[cfg(test)]
mod join_tests {
    use super::*;
    use crate::store::changes::{ChangeRecord, ChangeType, SCHEMA_VERSION};
    use crate::store::service::SidecarStore;
    use std::fs;
    use tempfile::TempDir;
    use textops::{Anchor, Document};

    const DOC: &str = "draft.md";

    /// A project holding `content` at `draft.md`, plus the [`DocRef`] naming it.
    fn project(content: &str) -> (TempDir, DocRef) {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(DOC), content).unwrap();
        let doc = DocRef {
            root: dir.path().to_string_lossy().into_owned(),
            path: DOC.to_string(),
        };
        (dir, doc)
    }

    /// A TD-4 record anchored at `[offset, offset+len)` of `anchored_in` — the text the delivery
    /// that minted it produced, which is not necessarily the text now being parsed (that gap is
    /// exactly what the unique-snapshot stage exists for).
    fn record(id: &str, anchored_in: &str, offset: usize, len: usize) -> ChangeRecord {
        ChangeRecord {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            kind: ChangeType::Insertion,
            author: "agent".to_string(),
            anchor: Anchor::new(&Document::new(anchored_in.to_string()), offset, len),
            created_at: 1,
            updated_at: 1,
            group: None,
            change_set: Some("cs-1".to_string()),
            note: None,
        }
    }

    /// A record anchored over the whole marker at `marker` in `anchored_in` — the undrifted shape
    /// `propose_changes` writes (`Anchor::new(&new_doc, marker.span.start, marker.span.len())`).
    fn record_for(id: &str, anchored_in: &str, marker: &str) -> ChangeRecord {
        let offset = anchored_in.find(marker).expect("marker not in text");
        record(id, anchored_in, offset, marker.len())
    }

    fn store(doc: &DocRef, records: &[ChangeRecord]) {
        let store = SidecarStore::new(&doc.root);
        let id = store.get_or_mint_for_path(&doc.path).unwrap();
        store.append_change_records(id, records).unwrap();
    }

    fn parse_doc(doc: DocRef, content: &str) -> Vec<ChangePayload> {
        parse_changes(Some(doc), content.to_string()).unwrap()
    }

    fn snapshot_id(content: &str, doc: &str, ordinal: usize) -> String {
        format!(
            "snap:{doc}:{}:{ordinal}",
            textops::Revision::of(content).as_str()
        )
    }

    #[test]
    fn an_undrifted_marker_takes_its_records_durable_id() {
        // The free, total case (ruling 3, exact stage): the document still reads exactly as it did
        // when the delivery landed, so anchor offset AND snapshot both agree.
        let content = "Hi {++there++}!";
        let (_dir, doc) = project(content);
        store(&doc, &[record_for("chg-abc", content, "{++there++}")]);

        let c = parse_doc(doc, content);
        assert_eq!(c[0].id, "chg-abc");
        assert!(c[0].recorded);
    }

    #[test]
    fn a_drifted_marker_joins_on_its_unique_snapshot() {
        // The user typed above the marker, so the recorded offset is stale — but the marker text
        // occurs exactly once in the live document, at a marker span (D17's exact-hit stage).
        let delivered = "{++there++}!";
        let live = "Hi again {++there++}!";
        let (_dir, doc) = project(live);
        store(&doc, &[record_for("chg-abc", delivered, "{++there++}")]);

        let c = parse_doc(doc, live);
        assert_eq!(c[0].id, "chg-abc");
        assert!(c[0].recorded);
    }

    #[test]
    fn a_crlf_multiline_record_parsed_in_cm6_lf_space_degrades_to_unrecorded() {
        // Delivery anchors and snapshots are captured from the disk bytes, while a reopened CM6
        // buffer supplies LF-only text. The exact offset is one byte earlier per preceding CRLF,
        // and a multiline snapshot still contains CRLF, so neither conservative join stage can
        // recover it. Pin this honest degradation until #447 reconciles the coordinate spaces.
        let delivered = "Heading\r\n{++two\r\nlines++}\r\n";
        let reopened = "Heading\n{++two\nlines++}\n";
        let (_dir, doc) = project(reopened);
        let mut grouped = record_for("chg-abc", delivered, "{++two\r\nlines++}");
        grouped.group = Some("grp-1".to_string());
        store(&doc, &[grouped]);

        let c = parse_doc(doc, reopened);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].id, snapshot_id(reopened, DOC, 0));
        assert!(!c[0].recorded);
        assert!(c[0].group.is_none());
    }

    #[test]
    fn a_marker_with_no_record_is_snapshot_scoped_and_unrecorded() {
        // Human-typed CriticMarkup (or an imported file): no record joins, and the honest answer
        // is a synthetic scoped to this document and this parse generation — never a durable id.
        let content = "Hi {++there++}!";
        let (_dir, doc) = project(content);

        let c = parse_doc(doc, content);
        assert_eq!(c[0].id, snapshot_id(content, DOC, 0));
        assert!(!c[0].recorded);
        assert!(c[0].group.is_none());
    }

    #[test]
    fn a_parse_with_no_document_named_is_wholly_unrecorded() {
        // No project, no record set to join against — every marker is honestly unrecorded rather
        // than the join silently guessing at some other document's records.
        let content = "Hi {++there++}!";
        let c = parse_changes(None, content.to_string()).unwrap();
        assert_eq!(c[0].id, snapshot_id(content, "", 0));
        assert!(!c[0].recorded);
    }

    #[test]
    fn a_pathless_parse_joins_records_by_checkpointed_uuid() {
        let dir = TempDir::new().unwrap();
        let content = "Hi {++there++}!";
        let store = SidecarStore::new(dir.path());
        let id = store.mint_doc_id();
        store
            .append_change_records(id, &[record_for("chg-untitled", content, "{++there++}")])
            .unwrap();

        let parsed = parse_changes_by_id(
            dir.path().to_string_lossy().into_owned(),
            id.to_string(),
            content.into(),
        )
        .unwrap();

        assert_eq!(parsed[0].id, "chg-untitled");
        assert!(parsed[0].recorded);
        assert!(!dir.path().join(".emend/docs.json").exists());
    }

    #[test]
    fn an_ambiguous_snapshot_never_joins() {
        // The record's snapshot occurs twice in the live text: which marker it names is unknowable,
        // so BOTH stay unrecorded. A mis-join is what this refusal makes structurally impossible.
        let live = "{++x++} and {++x++}";
        let (_dir, doc) = project(live);
        // Anchored at an offset that matches neither live marker, so only the snapshot stage is
        // reachable — and it is ambiguous.
        store(
            &doc,
            &[record("chg-abc", "pad {++x++}", 4, "{++x++}".len())],
        );

        let c = parse_doc(doc, live);
        assert!(c.iter().all(|c| !c.recorded));
        assert_eq!(c[0].id, snapshot_id(live, DOC, 0));
        assert_eq!(c[1].id, snapshot_id(live, DOC, 1));
    }

    #[test]
    fn two_records_claiming_one_marker_leave_it_unrecorded() {
        // Two records carrying the same snapshot both resolve to the one live marker. Picking
        // either would be a coin flip on which change the user is deciding.
        let live = "Hi {++there++}!";
        let (_dir, doc) = project(live);
        let padded = "pad {++there++}";
        store(
            &doc,
            &[
                record_for("chg-abc", padded, "{++there++}"),
                record_for("chg-def", padded, "{++there++}"),
            ],
        );

        let c = parse_doc(doc, live);
        assert!(!c[0].recorded);
        assert_eq!(c[0].id, snapshot_id(live, DOC, 0));
    }

    #[test]
    fn a_record_whose_snapshot_is_gone_joins_nothing() {
        // The user rejected/edited that change away: the record no longer describes any live
        // marker, and the marker that IS live was never recorded.
        let live = "Hi {++there++}!";
        let (_dir, doc) = project(live);
        store(
            &doc,
            &[record_for("chg-abc", "{++vanished++}", "{++vanished++}")],
        );

        let c = parse_doc(doc, live);
        assert_eq!(c.len(), 1);
        assert!(!c[0].recorded);
    }

    #[test]
    fn a_recorded_marker_carries_its_records_group_and_a_singleton_carries_none() {
        // Ruling 2: grouping for a recorded change IS the record's group — `None` is the backend
        // positively asserting a singleton, not an absence the editor may fill in.
        let content = "{--old--}{++new++} {++solo++}";
        let (_dir, doc) = project(content);
        let mut grouped = record_for("chg-del", content, "{--old--}");
        grouped.group = Some("grp-1".to_string());
        let mut grouped_ins = record_for("chg-ins", content, "{++new++}");
        grouped_ins.group = Some("grp-1".to_string());
        store(
            &doc,
            &[
                grouped,
                grouped_ins,
                record_for("chg-solo", content, "{++solo++}"),
            ],
        );

        let c = parse_doc(doc, content);
        assert_eq!(c[0].group.as_deref(), Some("grp-1"));
        assert_eq!(c[1].group.as_deref(), Some("grp-1"));
        assert!(c[2].recorded);
        assert!(c[2].group.is_none());
    }

    #[test]
    fn recorded_and_unrecorded_markers_coexist_in_one_document() {
        // The #566 shape: an agent delivery and a human-typed marker in the same document. Each is
        // reported in its own population — the join never widens to cover the human's marker.
        let content = "Hi {++there++} and {--mine--}";
        let (_dir, doc) = project(content);
        store(&doc, &[record_for("chg-abc", content, "{++there++}")]);

        let c = parse_doc(doc, content);
        assert_eq!(c[0].id, "chg-abc");
        assert!(c[0].recorded);
        assert!(!c[1].recorded);
        assert_eq!(c[1].id, snapshot_id(content, DOC, 1));
    }

    #[test]
    fn a_snapshot_identity_is_stable_within_a_generation_and_moves_across_them() {
        // Not durable across a reseed — which is the truth about an unrecorded marker (ruling 2),
        // and safe because a reseed replaces the whole live field.
        let content = "Hi {++there++}!";
        let (_dir, doc) = project(content);
        let again = parse_doc(doc.clone(), content);
        assert_eq!(parse_doc(doc.clone(), content)[0].id, again[0].id);

        let edited = "Hi again {++there++}!";
        assert_ne!(parse_doc(doc, edited)[0].id, again[0].id);
    }

    #[test]
    fn a_corrupt_sidecar_degrades_to_unrecorded_never_a_failed_parse() {
        // The redline layer must still seed: losing durable identity is the documented worst case
        // (ruling 3), losing the whole decoration layer is not.
        let content = "Hi {++there++}!";
        let (dir, doc) = project(content);
        store(&doc, &[record_for("chg-abc", content, "{++there++}")]);
        let store = SidecarStore::new(dir.path());
        let id = store.doc_id_for_path(DOC).unwrap().unwrap();
        fs::write(
            dir.path().join(".emend/changes").join(format!("{id}.json")),
            "{ not json",
        )
        .unwrap();

        let c = parse_doc(doc, content);
        assert_eq!(c.len(), 1);
        assert!(!c[0].recorded);
    }
}
