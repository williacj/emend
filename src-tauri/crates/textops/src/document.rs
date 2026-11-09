// ABOUTME: Document — the canonical model: raw markdown text as it exists on disk (TD-6).
// ABOUTME: Source-as-model (TD-2); no serializer sits between this and the file.

use crate::revision::Revision;

/// The canonical document model: the raw markdown text as it exists on disk.
///
/// Per TD-6 the raw file text is the canonical coordinate space — every offset,
/// anchor, and change indexes into these exact bytes. Per TD-2 (source-as-model)
/// there is no serializer between this model and the file: a `Document` holds the
/// bytes verbatim, never a re-rendered or normalized form.
#[derive(Clone, PartialEq, Eq)]
pub struct Document {
    text: String,
}

impl Document {
    /// Wrap raw markdown text as a document. The bytes are held verbatim —
    /// nothing is trimmed, normalized, or re-encoded (round-trip fidelity, P1).
    pub fn new(text: impl Into<String>) -> Document {
        Document { text: text.into() }
    }

    /// The raw text, byte-identical to what was passed to `new`.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// This document's content-hash revision (TD-6 `base_revision`).
    pub fn revision(&self) -> Revision {
        Revision::of(&self.text)
    }

    /// Byte length of the raw text.
    pub fn len(&self) -> usize {
        self.text.len()
    }

    /// Whether the document is the empty string.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

impl std::fmt::Debug for Document {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identify by revision rather than dumping the whole (potentially large)
        // body into logs and test output.
        f.debug_struct("Document")
            .field("revision", &self.revision())
            .field("len", &self.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn empty_document_is_empty_and_zero_length() {
        let doc = Document::new("");
        assert!(doc.is_empty());
        assert_eq!(doc.len(), 0);
    }

    #[test]
    fn len_is_byte_length_not_char_count() {
        // "é" is two UTF-8 bytes — len() is bytes, matching offset space (TD-6).
        let doc = Document::new("é");
        assert_eq!(doc.len(), 2);
        assert!(!doc.is_empty());
    }

    proptest! {
        // save∘load ≡ identity, base case (test-plan P1): the model holds the raw
        // text verbatim — BOM, CR/LF, and trailing-newline variations survive.
        #[test]
        fn document_holds_raw_text_verbatim(text in "(?s).*") {
            let doc = Document::new(text.clone());
            prop_assert_eq!(doc.text(), &text);
        }

        // The two revision APIs agree: a document's revision is the revision of its
        // text — no hidden normalization between them.
        #[test]
        fn document_revision_matches_revision_of_its_text(text in "(?s).*") {
            prop_assert_eq!(Document::new(text.clone()).revision(), Revision::of(&text));
        }
    }
}
