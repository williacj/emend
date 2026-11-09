// ABOUTME: Display-mode transforms — All/Simple/None/Original as pure projections of raw (FR-ED-4).
// ABOUTME: Read-only, whole-document (TD-11 corollary); never mutate raw (test-plan P1).

//! The four track-changes display modes (FR-ED-4, D13), each a pure projection of
//! the raw markdown — never a mutation. Per TD-2 (source-as-model) and the TD-11
//! corollary, display-mode projections are batch/whole-document reads: there is no
//! serializer between the model and the view, so switching modes can never drift
//! the underlying `raw` text (test-plan P1 "no drift under view operations").
//!
//! - **[`DisplayMode::All`]** — the raw markdown unchanged, CriticMarkup delimiters
//!   and all, exactly [`crate::Document::text`]. This is the editable, source-of-truth
//!   view.
//! - **[`DisplayMode::None`]** — every change accepted: the [`crate::coords::clean`]
//!   text (TD-6 `clean`; the P4a accept-all anchor).
//! - **[`DisplayMode::Simple`]** — textually identical to `None` (clean text). The v1
//!   app additionally drew margin bars beside lines that had a change; that is a
//!   decoration concern over the *rendered* editor, not a text projection, and lands
//!   with the display-mode UI (P2a-8) — this layer only projects text.
//! - **[`DisplayMode::Original`]** — every change rejected: [`crate::apply::reject_all`]
//!   (the P4a reject-all anchor), i.e. the text as it stood before any pending change.
//!
//! `Simple` and `None` are deliberately *not* collapsed into one variant: FR-ED-4
//! names four display modes, and callers (settings persistence, the future toolbar
//! control) need a stable four-way type even though two of them project identical
//! text today.

use crate::apply::reject_all;
use crate::coords::clean;

/// The four track-changes display modes (FR-ED-4, D13).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayMode {
    /// Raw markdown, CriticMarkup visible verbatim — the editable source view.
    All,
    /// Clean (accept-all) text, with per-line change indicators left to the
    /// rendering layer (P2a-8) — textually identical to [`DisplayMode::None`].
    Simple,
    /// Clean (accept-all) text: every change resolved, no markup visible.
    None,
    /// Original (reject-all) text: every change undone.
    Original,
}

/// Project `raw` into `mode`'s display text (FR-ED-4; test-plan P1 view operation).
///
/// A pure, read-only function of `raw` — a projection, never a mutation. Calling
/// this with any sequence of modes, in any order, never changes what a subsequent
/// call computes: `raw` itself is untouched (P1's "no drift under operations").
pub fn project(raw: &str, mode: DisplayMode) -> String {
    match mode {
        DisplayMode::All => raw.to_string(),
        DisplayMode::Simple | DisplayMode::None => clean(raw),
        DisplayMode::Original => reject_all(raw),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_mode_is_the_raw_text_unchanged() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(project(doc, DisplayMode::All), doc);
    }

    #[test]
    fn none_mode_is_the_clean_accept_all_text() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(
            project(doc, DisplayMode::None),
            "The quick fox jumps above it."
        );
    }

    #[test]
    fn simple_mode_matches_none_mode_textually() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(
            project(doc, DisplayMode::Simple),
            project(doc, DisplayMode::None)
        );
    }

    #[test]
    fn original_mode_is_the_reject_all_text() {
        let doc = "The {++quick ++}fox {--lazily --}jumps {~~over~>above~~} it.";
        assert_eq!(
            project(doc, DisplayMode::Original),
            "The fox lazily jumps over it."
        );
    }

    #[test]
    fn all_four_modes_over_a_markup_free_document_agree_with_raw() {
        let doc = "No markup here at all.";
        for mode in [
            DisplayMode::All,
            DisplayMode::Simple,
            DisplayMode::None,
            DisplayMode::Original,
        ] {
            assert_eq!(project(doc, mode), doc, "{mode:?} should be a no-op");
        }
    }

    #[test]
    fn none_and_original_diverge_when_a_change_is_pending() {
        let doc = "word{--deleted--}next";
        assert_eq!(project(doc, DisplayMode::None), "wordnext");
        assert_eq!(project(doc, DisplayMode::Original), "worddeletednext");
    }

    #[test]
    fn project_is_a_pure_function_called_twice() {
        let doc = "a {++b++} c {--d--} e {~~f~>g~~}";
        for mode in [
            DisplayMode::All,
            DisplayMode::Simple,
            DisplayMode::None,
            DisplayMode::Original,
        ] {
            assert_eq!(project(doc, mode), project(doc, mode));
        }
    }
}

// ---------------------------------------------------------------------------
// P1: no drift under view operations (mode toggles).
//
// A display mode is a read: computing it must never change what `raw` is. These
// properties pin that at two levels — the pure projection function itself, and
// (using P1-1's `Document`/`Revision`) a simulated editor session that toggles
// through an arbitrary sequence of modes and checks the underlying document never
// moved, closing the P1-7 acceptance criterion ("P1 no-drift-under-operations
// property covers mode toggles").
// ---------------------------------------------------------------------------
#[cfg(test)]
mod properties {
    use super::*;
    use crate::apply::{accept_all, reject_all as reject_all_oracle};
    use crate::document::Document;
    use proptest::prelude::*;

    fn mode_strategy() -> impl Strategy<Value = DisplayMode> {
        prop_oneof![
            Just(DisplayMode::All),
            Just(DisplayMode::Simple),
            Just(DisplayMode::None),
            Just(DisplayMode::Original),
        ]
    }

    proptest! {
        // `project` is deterministic: the same (raw, mode) always yields the same text.
        #[test]
        fn prop_project_is_a_pure_function_of_raw(raw in "(?s).{0,200}", mode in mode_strategy()) {
            prop_assert_eq!(project(&raw, mode), project(&raw, mode));
        }

        // `All` is always exactly `raw`, byte-identical — the trivial but load-bearing
        // case P1's "save∘load ≡ identity" reduces to at the display layer.
        #[test]
        fn prop_all_mode_never_alters_raw(raw in "(?s).{0,200}") {
            prop_assert_eq!(project(&raw, DisplayMode::All), raw);
        }

        // `Simple` and `None` project identical text for any raw document (module docs:
        // the margin-bar distinction is a decoration concern, not a text one).
        #[test]
        fn prop_simple_and_none_always_agree(raw in "(?s).{0,200}") {
            prop_assert_eq!(project(&raw, DisplayMode::Simple), project(&raw, DisplayMode::None));
        }

        // Cross-check against the independent P4a anchors, not a re-derivation of the
        // same match: `None` is exactly accept_all, `Original` is exactly reject_all.
        #[test]
        fn prop_none_and_original_match_the_p4a_anchors(raw in "(?s).{0,200}") {
            prop_assert_eq!(project(&raw, DisplayMode::None), accept_all(&raw));
            prop_assert_eq!(project(&raw, DisplayMode::Original), reject_all_oracle(&raw));
        }

        // The P1-7 acceptance criterion, literally: build a `Document` (P1-1), toggle
        // through an arbitrary sequence of display modes (each a read via `project`),
        // and confirm the document's text and content-hash revision never moved.
        #[test]
        fn prop_mode_toggles_never_drift_the_underlying_document(
            raw in "(?s).{0,300}",
            modes in prop::collection::vec(mode_strategy(), 0..20),
        ) {
            let doc = Document::new(raw.clone());
            let revision_before = doc.revision();

            for mode in &modes {
                let _shown = project(doc.text(), *mode); // a view operation: read-only
            }

            prop_assert_eq!(doc.text(), raw.as_str());
            prop_assert_eq!(doc.revision(), revision_before);
        }
    }
}
