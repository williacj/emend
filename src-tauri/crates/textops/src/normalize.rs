// ABOUTME: Line-ending normalization (FR-ED-2) — the single deliberate exception to the byte-for-byte
// ABOUTME: fidelity rule (TD-2 / P1): collapse CRLF and lone CR to LF, everything else verbatim.

use std::borrow::Cow;

/// Normalizes every line ending in `text` to a single LF (`\n`): `\r\n` → `\n` and a lone `\r` → `\n`.
///
/// This is the *only* transform the app is allowed to apply to a document's bytes on save
/// (FR-ED-2) — round-trip fidelity is otherwise structural (TD-2, P1: `save∘load ≡ identity`). It
/// is deliberately conservative: it touches carriage returns and nothing else, so frontmatter,
/// trailing newlines, and body text all survive untouched save for their line terminators.
///
/// Returns a borrow when `text` already contains no `\r` — the overwhelming common case (a
/// native-LF file autosaved once a second), so the hot path allocates nothing.
pub fn normalize_line_endings(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }

    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // A `\r` (whether it precedes a `\n` or stands alone) becomes one `\n`; a following
            // `\n` is consumed so `\r\n` collapses to a single terminator rather than doubling it.
            '\r' => {
                out.push('\n');
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            _ => out.push(c),
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn crlf_becomes_lf() {
        assert_eq!(normalize_line_endings("a\r\nb\r\n"), "a\nb\n");
    }

    #[test]
    fn lone_cr_becomes_lf() {
        assert_eq!(normalize_line_endings("a\rb\rc"), "a\nb\nc");
    }

    #[test]
    fn mixed_endings_all_become_lf() {
        assert_eq!(normalize_line_endings("a\r\nb\rc\nd"), "a\nb\nc\nd");
    }

    #[test]
    fn already_lf_is_returned_borrowed_and_unchanged() {
        let input = "---\ntitle: Test\n---\n\n# Body\n";
        let out = normalize_line_endings(input);
        assert!(matches!(out, Cow::Borrowed(_)));
        assert_eq!(out, input);
    }

    #[test]
    fn frontmatter_and_trailing_newline_survive_except_the_terminators() {
        let crlf = "---\r\ntitle: Test\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n";
        let lf = "---\ntitle: Test\ntags: [a, b]\n---\n\n# Body\n";
        assert_eq!(normalize_line_endings(crlf), lf);
    }

    #[test]
    fn empty_string_is_unchanged() {
        assert_eq!(normalize_line_endings(""), "");
    }

    proptest! {
        // No carriage return survives normalization, whatever the input.
        #[test]
        fn prop_output_has_no_carriage_return(input in "(?s).*") {
            prop_assert!(!normalize_line_endings(&input).contains('\r'));
        }

        // Idempotent: normalizing an already-normalized string is a no-op (and borrows).
        #[test]
        fn prop_is_idempotent(input in "(?s).*") {
            let once = normalize_line_endings(&input).into_owned();
            prop_assert_eq!(&once, &normalize_line_endings(&once).into_owned());
        }

        // A string with no `\r` is returned byte-for-byte (the fidelity guarantee for LF files).
        #[test]
        fn prop_cr_free_input_is_verbatim(input in "[^\r]*") {
            let normalized = normalize_line_endings(&input);
            prop_assert_eq!(normalized.as_ref(), input.as_str());
        }
    }
}
