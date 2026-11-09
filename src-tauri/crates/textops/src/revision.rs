// ABOUTME: Revision — a content-addressed token naming an exact document text (TD-6 base_revision).
// ABOUTME: Algorithm-prefixed ("blake3:<hex>"), stable across machines, persisted in sidecar event logs.

use serde::{Deserialize, Serialize};

/// The hashing algorithm backing revision tokens. Prefixed into every token so a
/// future migration to a different algorithm can coexist with old tokens without
/// re-parsing ambiguity (D-log: chosen 2026-07-10, CJ — blake3).
const ALGORITHM: &str = "blake3";

/// A content-addressed token naming an exact raw document text (TD-6 `base_revision`).
///
/// The raw file text is the canonical coordinate space (TD-6); a `Revision` pins the
/// exact bytes an anchor was measured against. The token is `"<algorithm>:<hex>"` and
/// is stable across machines and process runs — it is persisted in sidecar event logs
/// and compared as a value, so its wire form is load-bearing.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(String);

impl Revision {
    /// Compute the revision of raw markdown text.
    ///
    /// Deterministic: identical text always yields an identical token, on any
    /// machine or run (this is the property the whole anchor system leans on).
    pub fn of(text: &str) -> Revision {
        let hash = blake3::hash(text.as_bytes());
        Revision(format!("{ALGORITHM}:{}", hash.to_hex()))
    }

    /// Reconstruct a revision from a token read back from persistence (e.g. a
    /// `base_revision` field in a sidecar event log). The token is trusted input —
    /// this does not re-hash or validate it; it is compared as an opaque value.
    pub fn from_token(token: impl Into<String>) -> Revision {
        Revision(token.into())
    }

    /// The token string, e.g. `"blake3:9f8e…"`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // The empty string's blake3 digest — a golden value pinning the on-disk token
    // format. If the algorithm or encoding ever changes, this breaks first, before
    // any persisted base_revision silently stops matching.
    const EMPTY_TOKEN: &str =
        "blake3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

    #[test]
    fn revision_of_empty_string_is_the_golden_token() {
        assert_eq!(Revision::of("").as_str(), EMPTY_TOKEN);
    }

    #[test]
    fn revision_token_is_algorithm_prefixed() {
        assert!(Revision::of("# Hi\n").as_str().starts_with("blake3:"));
    }

    #[test]
    fn revision_serializes_as_the_bare_token_string() {
        let rev = Revision::of("hello");
        let json = serde_json::to_string(&rev).unwrap();
        // Transparent — the wire form is the token string itself (mcp-tool-call
        // schema: `revision` is a plain string), not a wrapping object.
        assert_eq!(json, format!("\"{}\"", rev.as_str()));

        let back: Revision = serde_json::from_str(&json).unwrap();
        assert_eq!(back, rev);
    }

    #[test]
    fn revision_reconstructed_from_a_persisted_token_compares_equal() {
        // The base_revision comparison path: a token read back from a sidecar log
        // must equal a freshly computed one over the same text.
        let fresh = Revision::of("some markdown");
        let stored = Revision::from_token(fresh.as_str().to_owned());
        assert_eq!(stored, fresh);
    }

    proptest! {
        // The P1-1 acceptance property: identical text yields an identical revision.
        #[test]
        fn identical_text_yields_identical_revision(text in "(?s).*") {
            prop_assert_eq!(Revision::of(&text), Revision::of(&text));
        }

        // Teeth for the above: the revision actually depends on content — distinct
        // text yields a distinct revision (blake3 collision resistance; proptest
        // will not stumble onto a real collision).
        #[test]
        fn distinct_text_yields_distinct_revision(a in "(?s).*", b in "(?s).*") {
            prop_assume!(a != b);
            prop_assert_ne!(Revision::of(&a), Revision::of(&b));
        }
    }
}
