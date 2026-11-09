// ABOUTME: Textops — pure Rust functions for markdown operations.
// ABOUTME: Coordinate transforms, CriticMarkup parse/apply, diffs, anchors, property-tested per test-plan P1–P6.

pub mod anchor;
pub mod apply;
pub mod coords;
pub mod critic;
pub mod deliver;
pub mod diff;
pub mod display;
pub mod document;
pub mod normalize;
pub mod reanchor;
pub mod rebase;
pub mod revision;

pub use anchor::{Anchor, Mapped};
pub use apply::{accept_all, apply, reject_all, Decision, Edit, Grouping};
pub use coords::{clean, clean_to_raw, displayed, raw_to_clean, Position, Utf16Offsets};
pub use critic::{parse, Markup, MarkupKind};
pub use deliver::{
    marker_kind, render, render_representable, validate, MarkerKind, Rendered, RenderedMarker,
    Representability, Unrepresentable,
};
pub use diff::{diff, RevisionEdit};
pub use display::{project, DisplayMode};
pub use document::Document;
pub use normalize::normalize_line_endings;
pub use reanchor::{Orphan, ReAnchor};
pub use rebase::{rebase, Applied, Rebased};
pub use revision::Revision;

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    proptest! {
        // Trivial harness property (test-plan §2): the P1 base case in miniature —
        // a no-op over an arbitrary string is byte-identical. Proves proptest is
        // wired and running in CI (matrix row NI-proptest-harness).
        //
        // `(?s).*` is `.*` with dot-matches-newline, so the generator reaches the
        // \r/\n and final-newline inputs that P1's real fidelity guarantee cares
        // about — plain `.*` would silently exclude exactly those cases.
        #[test]
        fn prop_noop_is_byte_identity(input in "(?s).*") {
            prop_assert_eq!(input.clone(), input);
        }
    }
}
