// ABOUTME: Delivery conversion — render an applied edit batch to CriticMarkup and TD-11 round-trip
// ABOUTME: validate it (whole-set), classifying each refusal as payload-reword vs existing-text hard-fail.

//! Converting a rebased edit batch into CriticMarkup, with TD-11's delivery-time
//! round-trip validation as a pure predicate.
//!
//! [`crate::rebase`] decides *which* proposal edits still apply against the live
//! document (TD-7); this module turns that applied subset into the CriticMarkup the
//! app writes into the source-of-truth markdown, and enforces **TD-11**: a change
//! that would not survive its own CriticMarkup round-trip is **refused, never
//! escaped** (CriticMarkup has no standard escape — escaping would break FR-X-8
//! portability and reintroduce a view↔file serializer, TD-2/P0).
//!
//! # What "round-trips" means (TD-11, whole-set)
//!
//! An edit renders to one marker: an insertion `{++new++}`, a deletion
//! `{--old--}`, or a substitution `{~~old~>new~~}`. Validation is over the **whole
//! rendered set and its whole accepted (clean) projection, not per-edit** — two
//! individually-clean adjacent insertions can jointly form a marker (`{--` then
//! `z--}` accept to `{--z--}`). The set is representable iff:
//!
//! 1. **No truncation/malformation.** [`crate::critic::parse`] recovers every
//!    intended marker exactly — same kind, same inner text. A payload (or existing
//!    text) that contains its own closer truncates the marker and leaks untracked
//!    text: `{++a++}b++}` parses as an insertion of `a` with `b++}` leftover.
//! 2. **Accept is delimiter-clean.** Accepting the whole set reveals no live markup
//!    the accepted projection didn't already carry: `{++ {--z--} ++}` accepts to a
//!    live `{--z--}`. Fenced/inline-code/frontmatter payloads pass — the parser
//!    excludes those zones, so a properly-fenced reveal-on-accept payload is clean.
//!
//! # Remedy depends on *where* the delimiter lives (TD-11)
//!
//! A refusal is classified so the delivery layer can route it (P2a-13):
//!
//! - [`Unrepresentable::Payload`] — the offending bytes are in an **insertion**, or
//!   a **substitution's `new`**: text the agent owns. Returned for the agent to
//!   reword (a distinct *unrepresentable-revise* reason riding TD-7's channel, not
//!   implying staleness).
//! - [`Unrepresentable::ExistingText`] — the offending bytes are in the **deleted
//!   text**, or a **substitution's `old`**: text the agent does not own and cannot
//!   reword (a bare `--}` has no single-marker representation at all). An honest
//!   hard-fail for that edit — never tracked, never delivered, never corrupting the
//!   doc (D21/FR-AGENT-2).
//!
//! This module is a pure `textops` predicate (TD-11: "Validation is a pure textops
//! predicate; policy lives in the delivery layer"). Group atomicity (P4b) and the
//! atomic write-hold are the delivery layer's job, over these verdicts.

use std::ops::Range;

use crate::apply::{accept_all, Edit};
use crate::critic::parse;

/// The CriticMarkup marker an edit renders to — mirrors `store::changes::ChangeType`
/// so the delivery layer can attribute each rendered change (TD-4) directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerKind {
    /// Empty range, non-empty replacement → `{++new++}`.
    Insertion,
    /// Non-empty range, empty replacement → `{--old--}`.
    Deletion,
    /// Non-empty range and replacement → `{~~old~>new~~}`.
    Substitution,
}

/// Why an edit cannot be delivered as CriticMarkup (TD-11) — fixes the remedy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unrepresentable {
    /// Offending delimiter bytes are in text the agent owns (insertion, or a
    /// substitution's `new`) — return to the agent to reword.
    Payload,
    /// Offending delimiter bytes are in existing document text (deletion, or a
    /// substitution's `old`) — an honest hard-fail the agent cannot reword.
    ExistingText,
}

/// One edit's delivery verdict (TD-11).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representability {
    /// The edit renders to CriticMarkup that round-trips; it will be delivered.
    Representable,
    /// The edit is refused for the given reason; it is never tracked or delivered.
    Refused(Unrepresentable),
}

/// One rendered tracked change: which input edit it came from, its kind, and the
/// byte span of its marker in [`Rendered::text`] — enough to attribute it (TD-4)
/// without re-parsing and disambiguating from any pre-existing markup in `live`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedMarker {
    /// Index into the `edits` slice passed to [`render`].
    pub edit_index: usize,
    /// The marker kind delivered.
    pub kind: MarkerKind,
    /// Byte range of the whole marker (delimiters included) in [`Rendered::text`].
    pub span: Range<usize>,
}

/// The result of rendering an edit batch to CriticMarkup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    /// `live` with every edit's marker spliced in — the delivered document text.
    pub text: String,
    /// One entry per edit that produced a marker (a no-op edit produces none),
    /// in document (byte) order.
    pub markers: Vec<RenderedMarker>,
}

/// The marker kind an edit renders to; `None` for a no-op (empty range and empty
/// replacement — nothing to track).
pub fn marker_kind(edit: &Edit) -> Option<MarkerKind> {
    let old_empty = edit.range.start == edit.range.end;
    let new_empty = edit.replacement.is_empty();
    match (old_empty, new_empty) {
        (true, true) => None,
        (true, false) => Some(MarkerKind::Insertion),
        (false, true) => Some(MarkerKind::Deletion),
        (false, false) => Some(MarkerKind::Substitution),
    }
}

/// The CriticMarkup marker text one edit renders to against `live`; `None` for a
/// no-op edit.
fn marker_text(live: &str, edit: &Edit) -> Option<String> {
    let old = &live[edit.range.clone()];
    let new = &edit.replacement;
    marker_kind(edit).map(|kind| match kind {
        MarkerKind::Insertion => format!("{{++{new}++}}"),
        MarkerKind::Deletion => format!("{{--{old}--}}"),
        MarkerKind::Substitution => format!("{{~~{old}~>{new}~~}}"),
    })
}

/// Render `edits` into `live` as CriticMarkup, returning the delivered text and each
/// marker's span (document order).
///
/// `edits` must be disjoint and each a valid char-boundary sub-range of `live` (the
/// contract [`apply_edits`] enforces); rebase's applied subset satisfies both. Order
/// of the input slice is free — `markers` is returned in document order, each
/// carrying its originating `edit_index`.
pub fn render(live: &str, edits: &[Edit]) -> Rendered {
    // Pair each non-no-op edit with its rendered marker, then splice in document
    // order tracking the cumulative byte shift so each marker's output span is exact
    // (no re-parse, so pre-existing markup in `live` can never be mistaken for ours).
    let mut rendered: Vec<(usize, MarkerKind, String, Range<usize>)> = edits
        .iter()
        .enumerate()
        .filter_map(|(i, edit)| {
            let kind = marker_kind(edit)?;
            let text = marker_text(live, edit)?;
            Some((i, kind, text, edit.range.clone()))
        })
        .collect();
    rendered.sort_by_key(|(_, _, _, range)| range.start);

    let mut text = String::with_capacity(live.len());
    let mut markers = Vec::with_capacity(rendered.len());
    let mut pos = 0usize;
    for (edit_index, kind, marker, range) in rendered {
        assert!(
            range.start >= pos,
            "overlapping edits in render: {range:?} starts before cursor {pos}"
        );
        text.push_str(&live[pos..range.start]);
        let start = text.len();
        text.push_str(&marker);
        markers.push(RenderedMarker {
            edit_index,
            kind,
            span: start..text.len(),
        });
        pos = range.end;
    }
    text.push_str(&live[pos..]);

    Rendered { text, markers }
}

/// The accepted (clean) text of an edit — what accepting its marker keeps: an
/// insertion/substitution's `new`, or empty for a deletion.
fn accepted_text(edit: &Edit, kind: MarkerKind) -> &str {
    match kind {
        MarkerKind::Insertion | MarkerKind::Substitution => &edit.replacement,
        MarkerKind::Deletion => "",
    }
}

/// Whether one edit, rendered on its own, round-trips (TD-11's per-edit half):
/// its marker parses back to exactly the intended change, and accepting it reveals
/// no live markup. Isolation catches truncation and reveal-on-accept for that edit;
/// the whole-set pass in [`validate`] catches adjacency between separate edits.
fn round_trips_alone(live: &str, edit: &Edit) -> bool {
    let Some(marker) = marker_text(live, edit) else {
        return true; // a no-op renders nothing
    };
    let Some(kind) = marker_kind(edit) else {
        return true;
    };

    // Truncation/malformation: the marker must parse to exactly one markup spanning
    // the whole marker, with inner text equal to what we put in.
    let parsed = parse(&marker);
    let intended_inner = inner_segments(live, edit, kind);
    let clean = parsed.len() == 1
        && parsed[0].full == (0..marker.len())
        && marker_inner(&marker, &parsed[0]) == intended_inner;
    if !clean {
        return false;
    }

    // Reveal-on-accept: accepting the marker must not surface live markup (a
    // properly fenced payload passes — the parser excludes code/frontmatter zones).
    parse(&accept_all(&marker)).is_empty()
}

/// The inner text segment(s) of an edit as they should appear in its marker.
fn inner_segments(live: &str, edit: &Edit, kind: MarkerKind) -> Vec<String> {
    let old = live[edit.range.clone()].to_string();
    let new = edit.replacement.clone();
    match kind {
        MarkerKind::Insertion => vec![new],
        MarkerKind::Deletion => vec![old],
        MarkerKind::Substitution => vec![old, new],
    }
}

/// The [`MarkerKind`] a parsed [`crate::critic::Markup`] corresponds to — the bridge
/// for comparing a recovered marker against the kind [`render`] delivered.
fn recovered_kind(m: &crate::critic::Markup) -> MarkerKind {
    use crate::critic::MarkupKind::{Deletion, Insertion, Substitution};
    match m.kind {
        Insertion { .. } => MarkerKind::Insertion,
        Deletion { .. } => MarkerKind::Deletion,
        Substitution { .. } => MarkerKind::Substitution,
    }
}

/// The inner text segment(s) the parser actually recovered from `marker`.
fn marker_inner(marker: &str, m: &crate::critic::Markup) -> Vec<String> {
    use crate::critic::MarkupKind::{Deletion, Insertion, Substitution};
    match &m.kind {
        Insertion { text } | Deletion { text } => vec![marker[text.clone()].to_string()],
        Substitution { old, new } => {
            vec![
                marker[old.clone()].to_string(),
                marker[new.clone()].to_string(),
            ]
        }
    }
}

/// Classify a refused edit by where the offending delimiter lives (TD-11): in the
/// existing (deleted / `old`) text the agent cannot reword, or in the agent-owned
/// payload it can.
fn attribute(live: &str, edit: &Edit, kind: MarkerKind) -> Unrepresentable {
    let old = &live[edit.range.clone()];
    match kind {
        // Only the payload (`new`) can break an insertion.
        MarkerKind::Insertion => Unrepresentable::Payload,
        // Only the existing text (`old`) can break a deletion (`--}` inside it).
        MarkerKind::Deletion => Unrepresentable::ExistingText,
        // A substitution `{~~old~>new~~}` breaks on the existing side only when `old`
        // carries a `~>` — the separator search takes the first one, truncating
        // `old` early (bytes the agent can't reword). A `~~}` inside `old` is inert
        // (the closer is only sought after the real `~>`), so it is not a fault.
        // Otherwise the collision is in `new` (a `~~}` closer, or reveal-on-accept):
        // agent-owned payload.
        MarkerKind::Substitution => {
            if old.contains("~>") {
                Unrepresentable::ExistingText
            } else {
                Unrepresentable::Payload
            }
        }
    }
}

/// The byte span each edit's accepted payload occupies in the accepted (clean)
/// projection of `edits` — used to detect adjacency reveals across separate edits.
/// Returns the accepted text plus, per edit that contributes payload bytes, its span.
fn accepted_projection(
    live: &str,
    edits: &[(usize, &Edit)],
) -> (String, Vec<(usize, Range<usize>)>) {
    let mut rendered: Vec<(usize, MarkerKind, Range<usize>)> = edits
        .iter()
        .filter_map(|(i, edit)| marker_kind(edit).map(|k| (*i, k, edit.range.clone())))
        .collect();
    rendered.sort_by_key(|(_, _, range)| range.start);

    let mut text = String::with_capacity(live.len());
    let mut spans = Vec::new();
    let mut pos = 0usize;
    for (i, kind, range) in rendered {
        text.push_str(&live[pos..range.start]);
        let start = text.len();
        // Reconstruct the edit to read its accepted text.
        let edit = edits
            .iter()
            .find(|(j, _)| *j == i)
            .map(|(_, e)| *e)
            .unwrap();
        text.push_str(accepted_text(edit, kind));
        if text.len() > start {
            spans.push((i, start..text.len()));
        }
        pos = range.end;
    }
    text.push_str(&live[pos..]);
    (text, spans)
}

/// Validate a rebased applied batch for CriticMarkup delivery (TD-11), returning one
/// verdict per edit in input order.
///
/// A verdict of [`Representability::Representable`] means the edit will be delivered
/// as a tracked change; [`Representability::Refused`] carries its
/// [`Unrepresentable`] reason. The check is whole-set: an edit that is clean on its
/// own may still be refused if, together with an adjacent edit, its accepted payload
/// would form live markup (both are attributed [`Unrepresentable::Payload`] — the
/// bytes are agent-owned and rewordable). Group atomicity (P4b) is the delivery
/// layer's concern, applied over these verdicts.
pub fn validate(live: &str, edits: &[Edit]) -> Vec<Representability> {
    // Per-edit isolation: truncation + reveal-on-accept, with attribution.
    let mut verdicts: Vec<Representability> = edits
        .iter()
        .map(|edit| match marker_kind(edit) {
            None => Representability::Representable, // no-op — nothing to refuse
            Some(kind) => {
                if round_trips_alone(live, edit) {
                    Representability::Representable
                } else {
                    Representability::Refused(attribute(live, edit, kind))
                }
            }
        })
        .collect();

    // Whole-set fixpoint: two whole-document faults the per-edit isolation pass cannot
    // see, refused together to a joint fixpoint. Refusing is monotonic (a survivor is
    // only ever demoted), so each round either refuses at least one edit or the set is
    // stable. Over-refusal is safe (the agent rewords / the edit is honestly dropped);
    // corrupt delivery is not (TD-11).
    loop {
        let mut refused_any = false;

        // (a) Reveal-on-accept adjacency: among edits still representable, an accepted
        // payload that forms live markup with a neighbour refuses the payload-bearing
        // participants (both agent-owned, so [`Unrepresentable::Payload`] — rewordable).
        let live_edits: Vec<(usize, &Edit)> = edits
            .iter()
            .enumerate()
            .filter(|(i, _)| verdicts[*i] == Representability::Representable)
            .filter(|(_, e)| marker_kind(e).is_some())
            .collect();
        let (accepted, payload_spans) = accepted_projection(live, &live_edits);
        let revealed = parse(&accepted);
        for (i, span) in &payload_spans {
            let hit = revealed
                .iter()
                .any(|m| m.full.start < span.end && span.start < m.full.end);
            if hit {
                verdicts[*i] = Representability::Refused(Unrepresentable::Payload);
                refused_any = true;
            }
        }

        // (b) Whole-document round-trip: a marker that is well-formed in isolation and
        // free of adjacency reveals can still fail to survive once spliced into `live` —
        // the surrounding document structure can swallow it. The dominant case is `live`
        // indentation: a marker delivered onto a line whose content sits >= 4 columns in
        // is a CommonMark indented code block, an exclusion zone `parse` reads no markup
        // from (#75), so the tracked change would silently vanish. Refuse any surviving
        // marker `parse` does not recover at its exact span and kind. That defeat is in
        // existing document structure the agent does not own and cannot reword — an
        // honest hard-fail ([`Unrepresentable::ExistingText`]), never a silent drop.
        let keep: Vec<bool> = verdicts
            .iter()
            .map(|v| *v == Representability::Representable)
            .collect();
        let out = render_representable(live, edits, &keep);
        let parsed = parse(&out.text);
        for m in &out.markers {
            let recovered = parsed
                .iter()
                .any(|p| p.full == m.span && recovered_kind(p) == m.kind);
            if !recovered {
                verdicts[m.edit_index] = Representability::Refused(Unrepresentable::ExistingText);
                refused_any = true;
            }
        }

        if !refused_any {
            break;
        }
    }

    verdicts
}

/// The delivered document text for the representable subset of `edits`, plus the
/// rendered markers — a convenience over [`render`] once [`validate`] has selected
/// which edits survive. `keep[i]` decides whether edit `i` is delivered.
pub fn render_representable(live: &str, edits: &[Edit], keep: &[bool]) -> Rendered {
    let kept: Vec<Edit> = edits
        .iter()
        .zip(keep)
        .filter(|(_, &k)| k)
        .map(|(e, _)| e.clone())
        .collect();
    // Preserve original indices in the returned markers by rendering the kept subset
    // and remapping edit_index back onto the caller's index space.
    let index_map: Vec<usize> = keep
        .iter()
        .enumerate()
        .filter_map(|(i, &k)| k.then_some(i))
        .collect();
    let mut out = render(live, &kept);
    for marker in &mut out.markers {
        marker.edit_index = index_map[marker.edit_index];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ins(offset: usize, replacement: &str) -> Edit {
        Edit {
            range: offset..offset,
            replacement: replacement.to_string(),
        }
    }
    fn del(range: Range<usize>) -> Edit {
        Edit {
            range,
            replacement: String::new(),
        }
    }
    fn sub(range: Range<usize>, replacement: &str) -> Edit {
        Edit {
            range,
            replacement: replacement.to_string(),
        }
    }

    fn verdicts(live: &str, edits: &[Edit]) -> Vec<Representability> {
        validate(live, edits)
    }

    // --- marker rendering ---------------------------------------------------

    #[test]
    fn renders_an_insertion_deletion_and_substitution() {
        let live = "The quick brown fox.";
        // insertion before "quick", delete "brown ", substitute "fox" -> "cat"
        let edits = [ins(4, "very "), del(10..16), sub(16..19, "cat")];
        let out = render(live, &edits);
        assert_eq!(out.text, "The {++very ++}quick {--brown --}{~~fox~>cat~~}.");
        // Markers come back in document order, each tagged with its source edit.
        let kinds: Vec<(usize, MarkerKind)> =
            out.markers.iter().map(|m| (m.edit_index, m.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                (0, MarkerKind::Insertion),
                (1, MarkerKind::Deletion),
                (2, MarkerKind::Substitution),
            ]
        );
        // Each span slices to exactly its marker.
        for m in &out.markers {
            let s = &out.text[m.span.clone()];
            assert!(s.starts_with('{') && s.ends_with('}'), "{s:?}");
        }
    }

    #[test]
    fn a_noop_edit_renders_nothing() {
        let live = "hello";
        let out = render(live, &[ins(2, "")]); // empty range, empty replacement
        assert_eq!(out.text, "hello");
        assert!(out.markers.is_empty());
        assert_eq!(marker_kind(&ins(2, "")), None);
    }

    #[test]
    fn rendered_markers_parse_back_to_the_delivered_changes() {
        let live = "one two three";
        let edits = [ins(0, "zero "), sub(4..7, "TWO")];
        let out = render(live, &edits);
        // The whole set round-trips: parse recovers markers exactly at our spans.
        let parsed = parse(&out.text);
        let spans: Vec<Range<usize>> = parsed.iter().map(|m| m.full.clone()).collect();
        for m in &out.markers {
            assert!(spans.contains(&m.span), "marker {:?} not recovered", m.span);
        }
    }

    // --- clean sets ---------------------------------------------------------

    #[test]
    fn a_clean_batch_is_all_representable() {
        let live = "The quick brown fox.";
        let edits = [ins(4, "very "), del(10..16), sub(16..19, "cat")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Representable; 3]
        );
    }

    #[test]
    fn an_empty_batch_validates_to_nothing() {
        assert_eq!(verdicts("anything", &[]), Vec::new());
    }

    // --- payload collisions (reword) ----------------------------------------

    #[test]
    fn an_insertion_carrying_its_own_closer_is_a_payload_refusal() {
        // "a++}b" truncates {++a++}b++} → parses as an insertion of "a".
        let live = "xy";
        let edits = [ins(1, "a++}b")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Refused(Unrepresentable::Payload)]
        );
    }

    #[test]
    fn an_insertion_that_reveals_markup_on_accept_is_a_payload_refusal() {
        // {++ {--z--} ++} accepts to a live {--z--}.
        let live = "xy";
        let edits = [ins(1, " {--z--} ")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Refused(Unrepresentable::Payload)]
        );
    }

    #[test]
    fn a_substitution_new_side_collision_is_a_payload_refusal() {
        let live = "keep OLD tail";
        let edits = [sub(5..8, "n~~}ew")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Refused(Unrepresentable::Payload)]
        );
    }

    // --- existing-text collisions (hard-fail) -------------------------------

    #[test]
    fn deleting_text_that_contains_a_closer_is_an_existing_text_refusal() {
        // The deleted span itself contains "--}": {--a--}b--} truncates.
        let live = "start a--}b end";
        let edits = [del(6..10)]; // "a--}"
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Refused(Unrepresentable::ExistingText)]
        );
    }

    #[test]
    fn a_substitution_old_side_collision_is_an_existing_text_refusal() {
        // The replaced (old) text carries "~>", which splits the marker's separator
        // early — bytes in existing text the agent cannot reword.
        let live = "a~>b";
        let edits = [sub(0..4, "clean")]; // old = "a~>b"
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Refused(Unrepresentable::ExistingText)]
        );
    }

    #[test]
    fn a_substitution_whose_old_holds_an_inert_tilde_closer_still_delivers() {
        // "~~}" inside `old` is harmless: the closer is only sought after the real
        // "~>", so {~~a~~}b~>clean~~} round-trips to exactly old="a~~}b", new="clean".
        let live = "a~~}b";
        let edits = [sub(0..5, "clean")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Representable]
        );
    }

    // --- whole-set adjacency ------------------------------------------------

    #[test]
    fn two_adjacent_insertions_that_jointly_form_a_marker_are_both_refused() {
        // "{--" then "z--}" are each clean alone but accept to a live {--z--}.
        let live = "AB";
        let edits = [ins(1, "{--"), ins(1, "z--}")];
        // Both individually round-trip, so only the whole-set pass catches this.
        assert!(round_trips_alone(live, &edits[0]));
        assert!(round_trips_alone(live, &edits[1]));
        assert_eq!(
            verdicts(live, &edits),
            vec![
                Representability::Refused(Unrepresentable::Payload),
                Representability::Refused(Unrepresentable::Payload),
            ]
        );
    }

    #[test]
    fn a_clean_edit_beside_a_refused_one_stays_representable() {
        let live = "one two three";
        // edit 0 clean insertion; edit 1 payload-dirty far away.
        let edits = [ins(0, "zero "), ins(8, "bad++}")];
        assert_eq!(
            verdicts(live, &edits),
            vec![
                Representability::Representable,
                Representability::Refused(Unrepresentable::Payload),
            ]
        );
    }

    // --- whole-document exclusion zone (issue #250) -------------------------

    #[test]
    fn a_marker_swallowed_by_an_indented_code_line_is_refused() {
        // `live` starts with 4 spaces, so any marker delivered onto that line is a
        // CommonMark indented code block — an exclusion zone `parse` reads no markup
        // from. The marker round-trips fine in isolation, so only the whole-document
        // pass catches that the delivered change would silently vanish (issue #250,
        // proptest-minimised: prop_delivered_subset_is_never_corrupt).
        let live = "    aAaaA0a";
        let edit = ins(4, "hello");
        // Round-trips alone (no leading indent in isolation) — the trap is contextual.
        assert!(round_trips_alone(live, &edit));
        assert_eq!(
            verdicts(live, &[edit]),
            vec![Representability::Refused(Unrepresentable::ExistingText)]
        );
    }

    #[test]
    fn indented_code_refusal_is_never_a_corrupt_delivery() {
        // The exact proptest-minimised batch: three delimiter-fragment insertions into
        // a 4-space-indented live. Edits 0 and 1 accept to a live {-- --} (payload
        // reveal); edit 2 survives that pass but is swallowed by the indented-code
        // line. Whatever `validate` keeps, `parse` must recover every kept marker.
        let live = "    aAaaA0a";
        let edits = [ins(0, "{--"), ins(1, "--}"), ins(4, "{--")];
        let v = verdicts(live, &edits);
        assert_eq!(
            v,
            vec![
                Representability::Refused(Unrepresentable::Payload),
                Representability::Refused(Unrepresentable::Payload),
                Representability::Refused(Unrepresentable::ExistingText),
            ]
        );
        // The TD-11 invariant on the delivered subset: no kept marker is truncated away.
        let keep: Vec<bool> = v
            .iter()
            .map(|r| *r == Representability::Representable)
            .collect();
        let out = render_representable(live, &edits, &keep);
        let parsed = parse(&out.text);
        for m in &out.markers {
            assert!(
                parsed.iter().any(|p| p.full == m.span),
                "kept marker {:?} truncated away",
                m.span
            );
        }
    }

    // --- reveal-on-accept fenced payload passes -----------------------------

    #[test]
    fn a_reveal_on_accept_payload_that_is_fenced_passes() {
        // The revealed marker is inside a code fence on accept, so the parser
        // excludes it — TD-11's fenced-payload carve-out.
        let live = "x\n";
        let edits = [ins(2, "```\n{--z--}\n```\n")];
        assert_eq!(
            verdicts(live, &edits),
            vec![Representability::Representable]
        );
    }

    // --- render_representable keeps indices ---------------------------------

    #[test]
    fn render_representable_delivers_only_kept_edits_with_original_indices() {
        let live = "one two three";
        let edits = [ins(0, "zero "), ins(8, "bad++}"), sub(4..7, "TWO")];
        let keep = [true, false, true];
        let out = render_representable(live, &edits, &keep);
        assert_eq!(out.text, "{++zero ++}one {~~two~>TWO~~} three");
        let indices: Vec<usize> = out.markers.iter().map(|m| m.edit_index).collect();
        assert_eq!(indices, vec![0, 2]); // original index space, edit 1 dropped
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use crate::apply::{apply_edits, reject_all};
    use proptest::prelude::*;

    /// A generated edit over a live document of `len` bytes: a disjoint range and a
    /// replacement. `kind_sel`/`skip`/`span` fold (via [`disjoint_edits`]) into a
    /// left-to-right, non-overlapping batch — the shape [`render`]/[`validate`] and
    /// rebase's applied subset guarantee.
    #[derive(Clone, Debug)]
    struct EditSpec {
        skip: usize,
        span: usize,
        replacement: String,
    }

    /// Fold `specs` into disjoint, ordered edits over a `len`-byte plain-ASCII live
    /// document, stopping when the cursor would run past the end.
    fn disjoint_edits(len: usize, specs: &[EditSpec]) -> Vec<Edit> {
        let mut edits = Vec::new();
        let mut cursor = 0usize;
        for s in specs {
            let start = cursor + s.skip;
            if start > len {
                break;
            }
            let end = (start + s.span).min(len);
            edits.push(Edit {
                range: start..end,
                replacement: s.replacement.clone(),
            });
            cursor = end;
        }
        edits
    }

    /// Delimiter-free replacement text — a batch drawn from this can never form
    /// markup, so it must always deliver whole.
    fn clean_replacement() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 ]{0,6}"
    }

    /// Replacement text drawn from a charset rich in CriticMarkup delimiter
    /// fragments, so payloads routinely collide.
    fn dirty_replacement() -> impl Strategy<Value = String> {
        prop::collection::vec(
            prop_oneof![
                Just("{++"),
                Just("++}"),
                Just("{--"),
                Just("--}"),
                Just("{~~"),
                Just("~>"),
                Just("~~}"),
                Just("a"),
                Just(" "),
            ],
            0..5,
        )
        .prop_map(|frags| frags.concat())
    }

    fn spec(replacement: impl Strategy<Value = String>) -> impl Strategy<Value = EditSpec> {
        (0usize..4, 0usize..4, replacement).prop_map(|(skip, span, replacement)| EditSpec {
            skip,
            span,
            replacement,
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // Clean domain (P6 happy path, TD-11 base case): a batch whose live text and
        // replacements carry no delimiters always delivers whole, and the delivered
        // CriticMarkup round-trips exactly — accept ≡ apply the edits as plain text,
        // reject ≡ the original live, and every marker is recovered by the parser.
        //
        // `live` is drawn empty-or-non-space-leading on purpose: this property isolates
        // the *delimiter*-cleanliness guarantee, and the only exclusion zone reachable
        // from the `[a-zA-Z0-9 ]` charset is a CommonMark indented code block from >= 4
        // leading spaces (no backticks/`---`/newlines to open the others, #75). A marker
        // delivered onto such a line is correctly refused (issue #250) — a structural
        // fault unrelated to delimiters — so it is scoped out here and asserted instead
        // by `prop_delivered_subset_is_never_corrupt` (full `live`, safety-only) and the
        // `a_marker_swallowed_by_an_indented_code_line_is_refused` unit test. With no
        // leading indentation the delivered line's indent is always 0 (markers begin
        // with `{`), so the whole batch genuinely round-trips.
        #[test]
        fn prop_clean_batch_always_delivers_and_round_trips(
            live in "([a-zA-Z0-9][a-zA-Z0-9 ]{0,23})?",
            specs in prop::collection::vec(spec(clean_replacement()), 0..5),
        ) {
            let edits = disjoint_edits(live.len(), &specs);
            let verdicts = validate(&live, &edits);
            // Nothing delimiter-shaped anywhere → every non-no-op edit is representable.
            prop_assert!(verdicts.iter().all(|v| *v == Representability::Representable));

            let keep = vec![true; edits.len()];
            let out = render_representable(&live, &edits, &keep);
            prop_assert_eq!(accept_all(&out.text), apply_edits(&live, &edits));
            prop_assert_eq!(reject_all(&out.text), live.clone());

            let parsed = parse(&out.text);
            let spans: Vec<Range<usize>> = parsed.iter().map(|m| m.full.clone()).collect();
            for m in &out.markers {
                prop_assert!(spans.contains(&m.span), "marker {:?} not recovered", m.span);
            }
        }

        // Safety invariant (TD-11, the whole point): whatever `validate` decides to
        // deliver, the delivered document is never corrupt — every kept marker is
        // recovered by the parser exactly (no truncation), and accepting the delivery
        // reveals no markup over a kept payload (no reveal). Holds for arbitrary
        // delimiter-soup replacements. Also: the predicate never panics.
        #[test]
        fn prop_delivered_subset_is_never_corrupt(
            live in "[a-zA-Z0-9 ]{0,20}",
            specs in prop::collection::vec(spec(dirty_replacement()), 0..5),
        ) {
            let edits = disjoint_edits(live.len(), &specs);
            let verdicts = validate(&live, &edits);
            let keep: Vec<bool> = verdicts
                .iter()
                .map(|v| *v == Representability::Representable)
                .collect();

            let out = render_representable(&live, &edits, &keep);

            // No truncation: each kept marker is recovered at its exact span, with the
            // kind we delivered.
            let parsed = parse(&out.text);
            for m in &out.markers {
                let hit = parsed.iter().find(|p| p.full == m.span);
                prop_assert!(hit.is_some(), "kept marker {:?} truncated away", m.span);
                prop_assert_eq!(recovered_kind(hit.unwrap()), m.kind);
            }

            // No reveal: accepting the delivered set introduces no markup over a kept
            // insertion/substitution payload. Recompute each accepted payload's span in
            // the accepted projection and assert no parsed marker overlaps it.
            let kept: Vec<(usize, &Edit)> = edits
                .iter()
                .enumerate()
                .filter(|(i, _)| keep[*i])
                .filter(|(_, e)| marker_kind(e).is_some())
                .collect();
            let (accepted, payload_spans) = accepted_projection(&live, &kept);
            let revealed = parse(&accepted);
            for (_, span) in &payload_spans {
                let overlap = revealed
                    .iter()
                    .any(|m| m.full.start < span.end && span.start < m.full.end);
                prop_assert!(!overlap, "payload {:?} revealed markup on accept", span);
            }
        }
    }
}
